/**
 * Pure value model for the sap store (sap spec §1: Value model, Previews,
 * Naming). No I/O, no timers, no host/bus imports — the store worker and host
 * layers build on these types and functions in later phases.
 */

export type ValueType = "text" | "json" | "bytes";

/**
 * How a value came to exist: a cell bind, a delegation result, or a primitive
 * capture (with the primitive's name and a short args summary).
 */
export type ValueOrigin =
	| { kind: "cell" }
	| { kind: "delegation" }
	| { kind: "primitive"; name: string; argsSummary?: string };

/** Producing agent plus origin — recorded at bind, never inferred later. */
export interface ValueProvenance {
	/** Handle ID of the agent that produced the value. */
	agentHandleId: string;
	origin: ValueOrigin;
}

/**
 * Metadata for one bound value (sap spec §1 Value model). Values are immutable
 * once bound; global identity is the ULID, the name is per-scope.
 */
export interface ValueMetadata {
	ulid: string;
	name: string;
	scopeId: string;
	type: ValueType;
	/** Content size in bytes. */
	size: number;
	provenance: ValueProvenance;
	/** Deterministic preview, computed once at bind, stable forever. */
	preview: string;
	/** Bind timestamp (ms since epoch). */
	createdAt: number;
}

export type ValidateNameResult = { ok: true } | { ok: false; reason: string };

const NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
export const NAME_MAX_LENGTH = 64;

/**
 * Validate a value name (sap spec §1 Naming #4). Names are validated data,
 * never code: charset [a-z0-9_], max 64 chars, no leading digit, non-empty,
 * reserved names (ambient API, `programs`, kernel primitives) rejected.
 */
export function validateValueName(
	name: string,
	reservedNames: ReadonlySet<string>,
): ValidateNameResult {
	if (name.length === 0) {
		return { ok: false, reason: "name must not be empty" };
	}
	if (name.length > NAME_MAX_LENGTH) {
		return { ok: false, reason: `name must be at most ${NAME_MAX_LENGTH} characters` };
	}
	if (!NAME_PATTERN.test(name)) {
		return {
			ok: false,
			reason: "name must use only [a-z0-9_] and must not start with a digit",
		};
	}
	if (reservedNames.has(name)) {
		return { ok: false, reason: `"${name}" is a reserved name` };
	}
	return { ok: true };
}

export interface PreviewOptions {
	/** Target preview length in characters (default 300). */
	charBudget?: number;
	/**
	 * Max byte size of a JSON value that gets parsed for its top-level shape
	 * (default 10 MB). Larger JSON falls back to head/tail, noted "unparsed".
	 */
	jsonParseBudgetBytes?: number;
}

const DEFAULT_CHAR_BUDGET = 300;
const DEFAULT_JSON_PARSE_BUDGET_BYTES = 10 * 1024 * 1024;
/** Hex bytes shown for a bytes value's head. */
const BYTES_HEX_HEAD = 16;
/** Separator between the head and tail halves of a truncated excerpt. */
const ELLIPSIS = "\n…\n";

/**
 * Compute a value's deterministic preview (sap spec §1 Previews): type, size,
 * line count, and a head/tail excerpt bounded by the char budget. JSON under
 * the parse budget also gets its top-level shape; over-budget or invalid JSON
 * is noted "unparsed" — the size check happens *before* any parse, so binding
 * a 200 MB JSON value never costs a 200 MB parse. Bytes values get a short
 * hex head instead of a text excerpt.
 */
export function computePreview(
	content: Uint8Array | string,
	type: ValueType,
	options: PreviewOptions = {},
): string {
	const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET;
	const size = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;

	if (type === "bytes") {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		const hexHead = Buffer.from(bytes.subarray(0, BYTES_HEX_HEAD)).toString("hex");
		const header = `bytes · ${size} bytes`;
		return hexHead.length > 0 ? `${header} · hex head ${hexHead}` : header;
	}

	const text = typeof content === "string" ? content : new TextDecoder().decode(content);
	const lineCount = countLines(text);
	const lineWord = lineCount === 1 ? "line" : "lines";

	let header: string;
	let shape: string | undefined;
	if (type === "json") {
		// Size check BEFORE parsing — never parse over-budget JSON.
		const parseBudget = options.jsonParseBudgetBytes ?? DEFAULT_JSON_PARSE_BUDGET_BYTES;
		shape = size <= parseBudget ? describeJsonShape(text) : undefined;
		header =
			shape === undefined
				? `json (unparsed) · ${size} bytes · ${lineCount} ${lineWord}`
				: `json · ${size} bytes · ${lineCount} ${lineWord}`;
	} else {
		header = `text · ${size} bytes · ${lineCount} ${lineWord}`;
	}

	const parts = [header];
	if (shape !== undefined) {
		parts.push(truncateTo(shape, Math.max(0, charBudget - header.length - 1)));
	}
	const used = parts.join("\n").length;
	const excerpt = excerptHeadTail(text, Math.max(0, charBudget - used - 1));
	if (excerpt.length > 0) parts.push(excerpt);
	return parts.join("\n");
}

/** Count lines treating \n, \r\n, and \r as single line breaks; "" is 0 lines. */
function countLines(text: string): number {
	if (text.length === 0) return 0;
	let breaks = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 10) breaks++;
		else if (ch === 13) {
			breaks++;
			if (text.charCodeAt(i + 1) === 10) i++;
		}
	}
	// Content after the final break (or with no breaks at all) is a line.
	return text.endsWith("\n") || text.endsWith("\r") ? breaks : breaks + 1;
}

/**
 * Describe parsed JSON's top-level shape: object keys or array length.
 * Returns undefined when the text is not valid JSON.
 */
function describeJsonShape(text: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (Array.isArray(parsed)) return `array of ${parsed.length} items`;
	if (parsed !== null && typeof parsed === "object") {
		const keys = Object.keys(parsed);
		return `object with ${keys.length} keys: ${keys.join(", ")}`;
	}
	return `${parsed === null ? "null" : typeof parsed} value`;
}

/**
 * Excerpt up to `budget` chars of text: the whole thing when it fits,
 * otherwise the head and tail halves joined by an ellipsis line.
 */
function excerptHeadTail(text: string, budget: number): string {
	if (budget <= 0) return "";
	if (text.length <= budget) return text;
	if (budget <= ELLIPSIS.length + 2) return truncateTo(text, budget);
	const half = Math.floor((budget - ELLIPSIS.length) / 2);
	return text.slice(0, half) + ELLIPSIS + text.slice(text.length - half);
}

/** Hard-truncate to `budget` chars with a trailing ellipsis when cut. */
function truncateTo(text: string, budget: number): string {
	if (text.length <= budget) return text;
	if (budget <= 1) return budget === 1 ? "…" : "";
	return `${text.slice(0, budget - 1)}…`;
}
