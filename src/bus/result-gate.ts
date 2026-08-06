/**
 * The delegation result gate (capture-all spec v10): a child's over-budget
 * result binds in FULL as a store value and the result message carries a
 * budget-inclusive preview + canonical marker. Two flavors share it:
 *
 * - subprocess (agent-process): binds under the child's own authenticated
 *   connection AND publishes — the parent's visibility path;
 * - featherweight (spawner): binds via the spawner's parent-scoped access and
 *   does NOT publish — the value is already in the parent's scope, and
 *   publishing would push it to the grandparent.
 *
 * Bind+publish is all-or-nothing: any failure degrades to the redacted
 * fallback — never a marker naming a value the reader cannot see.
 */
import { redactSensitiveTranscriptContent } from "../kernel/redaction.ts";
import { captureMarker, resolvePreviewBudgets } from "../kernel/truncation.ts";
import type { StoreAccess } from "../store/store-access.ts";

const RESULT_FALLBACK_TRUNCATION_CHARS = 30_000;

/**
 * Reserved headroom for the marker inside the budget-inclusive preview: a
 * 64-char value name plus the marker frame stays well under this, so head +
 * marker together always fit the delegate budget.
 */
const MARKER_RESERVE_CHARS = 160;

/** Delegate budget resolved once per process (capture-all spec v10). */
const DELEGATE_BUDGET = resolvePreviewBudgets(process.env).delegate;

/**
 * Auto-bind name for a run's overflowed result: a slug from the goal's first
 * few words, suffixed `_result` (sap spec §1 Naming #2 — deterministic, no LLM).
 */
export function resultValueName(goal: string): string {
	const slug = goal
		.toLowerCase()
		.split(/\s+/)
		.slice(0, 4)
		.map((word) => word.replace(/[^a-z0-9_]/g, ""))
		.filter((word) => word.length > 0)
		.join("_");
	// A slug that is empty or not a valid name head falls back rather than
	// producing a bind the store would reject.
	if (slug.length === 0 || !/^[a-z_]/.test(slug)) return "agent_result";
	const suffix = "_result";
	return `${slug.slice(0, 64 - suffix.length)}${suffix}`;
}

export async function prepareResultOutput(
	store: StoreAccess | undefined,
	handleId: string,
	goal: string,
	output: string,
	options: { publish: boolean },
): Promise<string> {
	// Redact FIRST: redaction can lengthen text, so slicing before it could
	// push a budget-inclusive preview back over budget at the parent.
	const redacted = redactSensitiveTranscriptContent(output);
	if (store === undefined || redacted.length <= DELEGATE_BUDGET) return redacted;
	try {
		const metadata = await store.bind({
			name: resultValueName(goal),
			content: output,
			type: "text",
			provenance: { agentHandleId: handleId, origin: { kind: "delegation" } },
			explicit: false,
		});
		if (options.publish) await store.publish(metadata.ulid);
		// Budget-INCLUSIVE: the whole message fits the delegate budget, so the
		// parent-side render clamp can never re-cut a live gated result.
		const head = redacted.slice(0, DELEGATE_BUDGET - MARKER_RESERVE_CHARS);
		const marker = captureMarker(
			`${redacted.length - head.length} chars`,
			` — full content: ⟦${metadata.name}⟧`,
		);
		return `${head}\n${marker}`;
	} catch {
		if (redacted.length <= RESULT_FALLBACK_TRUNCATION_CHARS) return redacted;
		return (
			`${redacted.slice(0, RESULT_FALLBACK_TRUNCATION_CHARS)}\n` +
			`[... output truncated at ${RESULT_FALLBACK_TRUNCATION_CHARS} chars]`
		);
	}
}
