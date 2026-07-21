/**
 * Capture: explicit `bind:`/`publish:` on read_file, exec, grep, and fetch
 * (sap spec §2). The wrapper stores SOURCE BYTES, never renderings — raw file
 * slices, raw stdout/stderr, structured grep matches as JSON, raw fetch bodies
 * — by running the underlying operation ONCE through the environment's
 * structured surface and rendering with the same shared renderers the plain
 * primitives use. Purely additive: without a `bind:` arg the wrapped primitive
 * delegates to the plain one unchanged.
 */

import type { StoreAccess } from "../store/store-access.ts";
import { type ValueType, validateValueName } from "../store/value.ts";
import type { ExecutionEnvironment } from "./execution-env.ts";
import type { Primitive } from "./primitives.ts";
import type { PrimitiveResult } from "./types.ts";

/** The primitives whose calls can capture their source content. */
export const CAPTURE_PRIMITIVE_NAMES = ["read_file", "exec", "grep", "fetch", "glob"] as const;

const NO_RESERVED_NAMES: ReadonlySet<string> = new Set();
const ARGS_SUMMARY_MAX = 100;

const CAPTURE_PARAMETERS = {
	bind: {
		type: "string",
		description:
			"Capture this call's raw source content into the value store under this name " +
			"(readable as ⟦name⟧). Stores source bytes, never the rendered output.",
	},
	publish: {
		type: "boolean",
		description: "With bind: also mark the bound value for your caller's result manifest.",
	},
};

/** What one capture wants stored: a named body with its value type. */
interface CaptureItem {
	name: string;
	content: string;
	type: ValueType;
}

function toolError(error: string): PrimitiveResult {
	return { output: "", success: false, error };
}

function firstLine(text: string): string {
	const newline = text.indexOf("\n");
	return newline === -1 ? text : text.slice(0, newline);
}

/**
 * Wrap a capture-capable primitive with bind/publish handling over the given
 * store. The Agent applies this to read_file/exec/grep/fetch when it has
 * caller-scoped store access.
 */
export function withCapture(prim: Primitive, store: StoreAccess): Primitive {
	return {
		...prim,
		parameters: {
			...prim.parameters,
			properties: {
				...(prim.parameters.properties as Record<string, unknown>),
				...CAPTURE_PARAMETERS,
			},
		},
		async execute(args, env, signal) {
			const { bind, publish, ...rest } = args;
			if (bind === undefined) {
				// Loud, not silent: publish without bind names nothing to publish.
				if (publish === true) {
					return toolError(`publish: true requires bind: on ${prim.name}`);
				}
				return prim.execute(rest, env, signal);
			}
			if (typeof bind !== "string") {
				return toolError("bind must be a string value name");
			}
			const nameCheck = validateValueName(bind, NO_RESERVED_NAMES);
			if (!nameCheck.ok) {
				return toolError(`invalid bind name "${bind}": ${nameCheck.reason}`);
			}
			if (publish !== undefined && typeof publish !== "boolean") {
				return toolError("publish must be a boolean");
			}
			const captured = await runWithCapture(prim, rest, env, signal);
			if (captured.result.success === false && captured.items.length === 0) {
				return captured.result;
			}
			return bindCaptures(store, prim.name, bind, captured, publish === true, rest);
		},
	};
}

/** A capture-capable call's single execution: rendered result + source items. */
interface CapturedCall {
	result: PrimitiveResult;
	/** Item names are suffixes on the bind name ("" = the bind name itself). */
	items: CaptureItem[];
}

/**
 * Run the underlying primitive exactly once. The plain primitives populate
 * `captureSource` with the RAW source content (raw file slice, raw
 * stdout/stderr, structured grep matches as JSON, raw fetch body) alongside
 * their rendering — the items to store derive from that, so captured bytes and
 * rendered output can never diverge.
 */
async function runWithCapture(
	prim: Primitive,
	args: Record<string, unknown>,
	env: ExecutionEnvironment,
	signal?: AbortSignal,
): Promise<CapturedCall> {
	const result = await prim.execute(args, env, signal);
	const source = result.captureSource;
	if (source !== undefined) {
		return {
			result,
			items: [
				{ name: "", content: source.content, type: source.type },
				...(source.stderr !== undefined && source.stderr !== ""
					? [{ name: "_stderr", content: source.stderr, type: "text" as ValueType }]
					: []),
			],
		};
	}
	if (result.success === false) {
		// The operation itself failed: nothing to capture, the error stands.
		return { result, items: [] };
	}
	if ((CAPTURE_PRIMITIVE_NAMES as readonly string[]).includes(prim.name)) {
		// Environment lacks the raw surface: say honestly that nothing was
		// captured rather than storing a rendering.
		return {
			result: {
				...result,
				output: appendTrailer(result.output, [
					`[bind failed: execution environment does not support raw capture for ${prim.name}]`,
				]),
			},
			items: [],
		};
	}
	// Not capture-capable: run plain, capture nothing.
	return { result, items: [] };
}

/** Bind the captured items, publish if asked, and append the trailer lines. */
async function bindCaptures(
	store: StoreAccess,
	primitiveName: string,
	bindName: string,
	captured: CapturedCall,
	publish: boolean,
	args: Record<string, unknown>,
): Promise<PrimitiveResult> {
	const trailer: string[] = [];
	const boundValues: Array<{ name: string; ulid: string; size: number }> = [];
	for (const item of captured.items) {
		const name = `${bindName}${item.name}`;
		try {
			const metadata = await store.bind({
				name,
				content: item.content,
				type: item.type,
				provenance: {
					// The channel forces this to the connection's verified identity;
					// a direct-scope holder is the scope's owner.
					agentHandleId: "",
					origin: {
						kind: "primitive",
						name: primitiveName,
						argsSummary: summarizeArgs(primitiveName, args),
					},
				},
				explicit: true,
			});
			trailer.push(`bound: ⟦${metadata.name}⟧ (${firstLine(metadata.preview)})`);
			boundValues.push({ name: metadata.name, ulid: metadata.ulid, size: metadata.size });
			if (publish) {
				try {
					await store.publish(metadata.name);
				} catch (err) {
					trailer.push(`[publish failed: ${err instanceof Error ? err.message : String(err)}]`);
				}
			}
		} catch (err) {
			// A failed bind must not fail the tool call — the rendered result
			// stands, with an honest trailer naming no nonexistent value.
			trailer.push(`[bind failed: ${err instanceof Error ? err.message : String(err)}]`);
		}
	}
	return {
		...captured.result,
		output: appendTrailer(captured.result.output, trailer),
		...(boundValues.length > 0 ? { boundValues } : {}),
	};
}

function appendTrailer(output: string, lines: string[]): string {
	if (lines.length === 0) return output;
	return output.length === 0 ? lines.join("\n") : `${output}\n${lines.join("\n")}`;
}

/** Short provenance summary of what the call addressed. */
function summarizeArgs(primitiveName: string, args: Record<string, unknown>): string {
	const key =
		primitiveName === "read_file"
			? "path"
			: primitiveName === "exec"
				? "command"
				: primitiveName === "grep" || primitiveName === "glob"
					? "pattern"
					: "url";
	return String(args[key] ?? "").slice(0, ARGS_SUMMARY_MAX);
}
