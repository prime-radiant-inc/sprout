/**
 * Value-read primitives over the sap store (sap spec §1). These are the
 * above-the-LLM-line readers: everything they return passes through
 * `redactSensitiveTranscriptContent` (spec §1 Redaction), and store errors
 * become `{ success: false }` results rather than throws. Binding is Phase 3
 * (capture) — there is deliberately no bind primitive here.
 */

import type { StoreAccess } from "../store/store-access.ts";
import type { Primitive } from "./primitives.ts";
import { redactSensitiveTranscriptContent } from "./redaction.ts";
import type { PrimitiveResult } from "./types.ts";

/** value_get budget — read_file parity (spec §1 defaults). */
export const VALUE_GET_CHAR_BUDGET = 50_000;

const REF_DESCRIPTION = "Value ref: a value name in your scope, or a value ulid";

export function buildValuePrimitives(store: StoreAccess): Primitive[] {
	return [
		valuePeekPrimitive(store),
		valueGrepPrimitive(store),
		valueSlicePrimitive(store),
		valueGetPrimitive(store),
	];
}

/** Redact-and-succeed; the redaction pass is the invariant, not a courtesy. */
function ok(output: string): PrimitiveResult {
	return { output: redactSensitiveTranscriptContent(output), success: true };
}

function fail(error: unknown): PrimitiveResult {
	return {
		output: "",
		success: false,
		error: error instanceof Error ? error.message : String(error),
	};
}

function valuePeekPrimitive(store: StoreAccess): Primitive {
	return {
		name: "value_peek",
		description:
			"Preview a stored value: type, size, line count, and a head/tail excerpt. " +
			"Cheap for any size — use this before reading a value. Refs are value names or ulids.",
		parameters: {
			type: "object",
			properties: {
				ref: { type: "string", description: REF_DESCRIPTION },
			},
			required: ["ref"],
		},
		async execute(args) {
			try {
				return ok(await store.peek(args.ref as string));
			} catch (err) {
				return fail(err);
			}
		},
	};
}

function valueGrepPrimitive(store: StoreAccess): Primitive {
	return {
		name: "value_grep",
		description:
			"Search a stored value's lines with a regex; returns matches as <line>:<text>. " +
			"Runs in the store, so it works on values of any size. Refs are value names or ulids.",
		parameters: {
			type: "object",
			properties: {
				ref: { type: "string", description: REF_DESCRIPTION },
				pattern: { type: "string", description: "Regex applied per line" },
				max_results: { type: "integer", description: "Max matches to return" },
			},
			required: ["ref", "pattern"],
		},
		async execute(args) {
			try {
				const matches = await store.grep(args.ref as string, args.pattern as string, {
					maxResults: args.max_results as number | undefined,
				});
				return ok(matches.map((m) => `${m.line}:${m.text}`).join("\n"));
			} catch (err) {
				return fail(err);
			}
		},
	};
}

function valueSlicePrimitive(store: StoreAccess): Primitive {
	return {
		name: "value_slice",
		description:
			"Read a 1-based line range of a stored text/json value. " +
			"Use for large values where value_get is over budget. Refs are value names or ulids.",
		parameters: {
			type: "object",
			properties: {
				ref: { type: "string", description: REF_DESCRIPTION },
				start_line: { type: "integer", description: "1-based first line" },
				line_count: { type: "integer", description: "Number of lines to read" },
			},
			required: ["ref", "start_line", "line_count"],
		},
		async execute(args) {
			try {
				return ok(
					await store.slice(args.ref as string, {
						startLine: args.start_line as number,
						lineCount: args.line_count as number,
					}),
				);
			} catch (err) {
				return fail(err);
			}
		},
	};
}

function valueGetPrimitive(store: StoreAccess): Primitive {
	return {
		name: "value_get",
		description:
			`Read a stored value's full content (up to ${VALUE_GET_CHAR_BUDGET} chars). ` +
			"Over-budget values error — use value_slice or value_grep instead. " +
			"Refs are value names or ulids.",
		parameters: {
			type: "object",
			properties: {
				ref: { type: "string", description: REF_DESCRIPTION },
			},
			required: ["ref"],
		},
		async execute(args) {
			try {
				const bytes = await store.get(args.ref as string, { maxBytes: VALUE_GET_CHAR_BUDGET });
				return ok(new TextDecoder().decode(bytes));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes("exceeds read budget")) {
					return {
						output: "",
						success: false,
						error:
							`Value is over the ${VALUE_GET_CHAR_BUDGET}-char value_get budget (${message}). ` +
							"Use value_slice to read a line range or value_grep to search it instead.",
					};
				}
				return fail(err);
			}
		},
	};
}
