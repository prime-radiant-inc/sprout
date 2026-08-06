/**
 * Delegation result rendering (capture-all spec v10): the parent-side seam
 * every child-result render passes through, plus the manifest-delta fetch
 * that feeds it.
 */
import { redactSensitiveTranscriptContent } from "../kernel/redaction.ts";
import { captureMarker, resolvePreviewBudgets, truncateToolOutput } from "../kernel/truncation.ts";
import type { StoreAccess } from "../store/store-access.ts";
import { computePreview } from "../store/value.ts";

/** Retries for an infrastructure-tagged manifest fetch before degrading. */
const MANIFEST_FETCH_RETRIES = 2;
const MANIFEST_RETRY_BACKOFF_MS = 250;

/** Delegate render budget resolved once per process (capture-all spec v10). */
const DELEGATE_RENDER_BUDGET = resolvePreviewBudgets(process.env).delegate;
/** Marker headroom inside the clamp (64-char names fit comfortably). */
const DELEGATE_MARKER_RESERVE = 160;

export interface DeliveredManifest {
	lines: string;
	rewrites: Map<string, string>;
	values: Array<{ name: string; ulid: string; size: number; preview: string }>;
}

/**
 * Fetch the child's delivered-manifest delta and render its announcement
 * lines. `manifestRenames` is the caller's per-child accumulated rename map:
 * later summaries from the same child still use its own names, so earlier
 * deliveries' renames keep rewriting even when the current delta renames
 * nothing.
 */
export async function fetchManifestLines(
	store: StoreAccess | undefined,
	manifestRenames: Map<string, Map<string, string>>,
	childHandleId: string,
): Promise<DeliveredManifest> {
	if (!store) return { lines: "", rewrites: new Map(), values: [] };
	const rewrites = manifestRenames.get(childHandleId) ?? new Map<string, string>();
	manifestRenames.set(childHandleId, rewrites);
	let attempt = 0;
	for (;;) {
		try {
			const delta = await store.manifestDelta(childHandleId);
			const values = delta.delivered.map(({ name, ulid, size, preview }) => ({
				name,
				ulid,
				size,
				preview,
			}));
			if (delta.delivered.length === 0) return { lines: "", rewrites, values };
			const lines = delta.delivered.map(
				(value) => `published: ⟦${value.name}⟧ (${value.preview.split("\n", 1)[0]})`,
			);
			// The alias map (child's name → bound-as): when a manifest name
			// suffixed, the child's ⟦sourceName⟧ references in its delivered
			// summary text rewrite to the bound-as name, and the rename is
			// announced so the recipient can resolve in-content references
			// the rewrite cannot reach (spec §3 stated residual). Only the
			// CURRENT delta's renames announce; accumulated ones just rewrite.
			for (const value of delta.delivered) {
				if (value.name !== value.sourceName) {
					rewrites.set(value.sourceName, value.name);
					lines.push(`renamed on delivery: ⟦${value.sourceName}⟧ → ⟦${value.name}⟧`);
				}
			}
			return { lines: `\n${lines.join("\n")}`, rewrites, values };
		} catch (err) {
			const infrastructure = (err as { infrastructure?: boolean }).infrastructure === true;
			if (infrastructure && attempt < MANIFEST_FETCH_RETRIES) {
				attempt++;
				await new Promise((resolve) => setTimeout(resolve, MANIFEST_RETRY_BACKOFF_MS));
				continue;
			}
			const reason = err instanceof Error ? err.message : String(err);
			return { lines: `\n[manifest unavailable: ${reason}]`, rewrites, values: [] };
		}
	}
}

/**
 * The ONE parent-side seam every child-result render passes through
 * (capture-all spec v10): redacts unconditionally, and implements the
 * recovery clamp — clamp iff `recovered` AND the manifest delta delivered
 * the result value (content-identity: size AND the bind-time preview
 * recomputed from the raw output — the durable log and the child's bind
 * store the same string, and previews are deterministic, so identical
 * bytes reproduce the stored preview exactly) AND the redacted output
 * exceeds the delegate budget. Fail-closed: no match, no clamp — the
 * generic backstop renders instead. Live results never carry `recovered`,
 * so they can never reach the clamp. The marker is appended AFTER name
 * rewriting so a delivered alias cannot collide with a rewrite key.
 */
export function renderDelegationResult(
	output: string,
	label: string,
	manifest: {
		lines: string;
		rewrites: Map<string, string>;
		values: Array<{ name: string; size: number; preview: string }>;
	},
	recovered: boolean,
): string {
	const redacted = redactSensitiveTranscriptContent(output);
	const outputBytes = recovered ? Buffer.byteLength(output, "utf8") : 0;
	const expectedPreview = recovered
		? redactSensitiveTranscriptContent(computePreview(output, "text"))
		: "";
	const resultValue = recovered
		? manifest.values.find((v) => v.size === outputBytes && v.preview === expectedPreview)
		: undefined;
	if (resultValue !== undefined && redacted.length > DELEGATE_RENDER_BUDGET) {
		const head = redacted.slice(0, DELEGATE_RENDER_BUDGET - DELEGATE_MARKER_RESERVE);
		const marker = captureMarker(
			`${redacted.length - head.length} chars`,
			` — full content: ⟦${resultValue.name}⟧`,
		);
		return `${rewriteManifestNames(head, manifest.rewrites)}\n${marker}${manifest.lines}`;
	}
	return (
		rewriteManifestNames(truncateToolOutput(redacted, label), manifest.rewrites) + manifest.lines
	);
}

/**
 * Rewrite the child's `⟦sourceName⟧` references in its delivered summary
 * text to the bound-as names. Exact-token: the closing bracket makes each
 * `⟦name⟧` a distinct literal, so prefix names (⟦log⟧ vs ⟦log_2⟧) cannot
 * cross-match. Single-pass so one rewrite's output never feeds another
 * (log→log_2 alongside log_2→log_2_2 in the same delta).
 */
function rewriteManifestNames(summary: string, rewrites: Map<string, string>): string {
	if (rewrites.size === 0) return summary;
	const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		[...rewrites.keys()].map((sourceName) => escapeLiteral(`⟦${sourceName}⟧`)).join("|"),
		"g",
	);
	return summary.replace(pattern, (token) => `⟦${rewrites.get(token.slice(1, -1))!}⟧`);
}
