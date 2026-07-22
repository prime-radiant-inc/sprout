/**
 * Shared value-content codec: how a value body becomes a string — for the
 * journal's inline bind records and the store worker's wire protocol — and
 * back. Bytes cross as base64; text/json as utf8 passthrough.
 */

import type { ValueType } from "./value.ts";

/** String form of value content: utf8 passthrough or base64 for bytes. */
export type WireEncoding = "utf8" | "base64";

/** The encoding a value type crosses with: base64 for bytes, utf8 otherwise. */
export function encodingFor(type: ValueType): WireEncoding {
	return type === "bytes" ? "base64" : "utf8";
}

export function encodeContent(bytes: Uint8Array, encoding: WireEncoding): string {
	return encoding === "base64"
		? Buffer.from(bytes).toString("base64")
		: new TextDecoder().decode(bytes);
}

export function decodeContent(content: string, encoding: WireEncoding): Uint8Array {
	return encoding === "base64"
		? new Uint8Array(Buffer.from(content, "base64"))
		: new TextEncoder().encode(content);
}
