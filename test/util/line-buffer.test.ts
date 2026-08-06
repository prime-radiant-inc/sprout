import { describe, expect, test } from "bun:test";
import { LineBuffer } from "../../src/util/line-buffer.ts";

describe("LineBuffer", () => {
	test("splits complete lines and buffers the partial tail", () => {
		const buffer = new LineBuffer();
		expect(buffer.push("a\nb\nc")).toEqual(["a", "b"]);
		expect(buffer.pendingLength).toBe(1);
		expect(buffer.push("d\n")).toEqual(["cd"]);
		expect(buffer.pendingLength).toBe(0);
	});

	test("reassembles a line split across many chunks", () => {
		const buffer = new LineBuffer();
		expect(buffer.push("hel")).toEqual([]);
		expect(buffer.push("lo wor")).toEqual([]);
		expect(buffer.push("ld\n")).toEqual(["hello world"]);
	});

	test("returns empty lines for consecutive newlines", () => {
		const buffer = new LineBuffer();
		expect(buffer.push("a\n\n\nb\n")).toEqual(["a", "", "", "b"]);
	});

	test("decodes a multi-byte utf8 sequence split across byte chunks", () => {
		const bytes = new TextEncoder().encode("héllo\n");
		const buffer = new LineBuffer();
		expect(buffer.push(bytes.slice(0, 2))).toEqual([]); // splits é mid-sequence
		expect(buffer.push(bytes.slice(2))).toEqual(["héllo"]);
	});

	test("mixes string and byte chunks in one stream", () => {
		const buffer = new LineBuffer();
		expect(buffer.push("a")).toEqual([]);
		expect(buffer.push(new TextEncoder().encode("b\nc"))).toEqual(["ab"]);
		expect(buffer.takePending()).toBe("c");
	});

	test("takePending returns the unterminated tail and empties the buffer", () => {
		const buffer = new LineBuffer();
		buffer.push("tail without newline");
		expect(buffer.takePending()).toBe("tail without newline");
		expect(buffer.takePending()).toBe("");
		expect(buffer.pendingLength).toBe(0);
	});

	test("discardPending drops only the buffered partial line", () => {
		const buffer = new LineBuffer();
		expect(buffer.push("kept\npartial")).toEqual(["kept"]);
		buffer.discardPending();
		expect(buffer.pendingLength).toBe(0);
		expect(buffer.push("fresh\n")).toEqual(["fresh"]);
	});
});
