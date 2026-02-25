import { describe, expect, test } from "bun:test";
import {
	cursorLine,
	deleteBackward,
	insertAt,
	isOnFirstLine,
	isOnLastLine,
	killToLineEnd,
	killToLineStart,
	killWordBackward,
	lineCount,
	lineEnd,
	lineStart,
	moveCursorDown,
	moveCursorUp,
} from "../../src/tui/buffer.ts";

describe("cursor detection", () => {
	describe("cursorLine", () => {
		test("returns 0 for empty string", () => {
			expect(cursorLine("", 0)).toBe(0);
		});

		test("returns 0 when cursor is on first line", () => {
			expect(cursorLine("hello", 3)).toBe(0);
		});

		test("returns 1 when cursor is at start of second line", () => {
			expect(cursorLine("abc\ndef\nghi", 4)).toBe(1);
		});

		test("returns 2 when cursor is on third line", () => {
			expect(cursorLine("abc\ndef\nghi", 8)).toBe(2);
		});

		test("returns line index when cursor is right after newline", () => {
			expect(cursorLine("a\nb", 2)).toBe(1);
		});

		test("returns last line when cursor is at end of text", () => {
			expect(cursorLine("abc\ndef", 7)).toBe(1);
		});

		test("cursor on the newline itself belongs to the line before it", () => {
			// index 3 is the \n in "abc\ndef"
			expect(cursorLine("abc\ndef", 3)).toBe(0);
		});
	});

	describe("lineCount", () => {
		test("empty string has 1 line", () => {
			expect(lineCount("")).toBe(1);
		});

		test("single line with no newline", () => {
			expect(lineCount("hello")).toBe(1);
		});

		test("multiple lines", () => {
			expect(lineCount("a\nb\nc")).toBe(3);
		});

		test("trailing newline adds an extra line", () => {
			expect(lineCount("a\n")).toBe(2);
		});

		test("multiple trailing newlines", () => {
			expect(lineCount("a\n\n")).toBe(3);
		});
	});

	describe("isOnFirstLine", () => {
		test("true for empty string", () => {
			expect(isOnFirstLine("", 0)).toBe(true);
		});

		test("true when cursor is within first line", () => {
			expect(isOnFirstLine("abc\ndef", 2)).toBe(true);
		});

		test("true when cursor is at the newline ending first line", () => {
			expect(isOnFirstLine("abc\ndef", 3)).toBe(true);
		});

		test("false when cursor is on second line", () => {
			expect(isOnFirstLine("abc\ndef", 4)).toBe(false);
		});
	});

	describe("isOnLastLine", () => {
		test("true for empty string", () => {
			expect(isOnLastLine("", 0)).toBe(true);
		});

		test("true when cursor is on the only line", () => {
			expect(isOnLastLine("hello", 3)).toBe(true);
		});

		test("true when cursor is on the last line of multiline text", () => {
			expect(isOnLastLine("abc\ndef", 5)).toBe(true);
		});

		test("false when cursor is on the first line of multiline text", () => {
			expect(isOnLastLine("abc\ndef", 2)).toBe(false);
		});

		test("true for trailing newline with cursor after it", () => {
			// "abc\n" has 2 lines; cursor at index 4 is on line 1 (last line)
			expect(isOnLastLine("abc\n", 4)).toBe(true);
		});

		test("false for trailing newline with cursor before it", () => {
			expect(isOnLastLine("abc\n", 2)).toBe(false);
		});
	});
});

describe("line-based cursor movement", () => {
	describe("lineStart", () => {
		test("returns 0 for empty string", () => {
			expect(lineStart("", 0)).toBe(0);
		});

		test("returns 0 when cursor is on first line", () => {
			expect(lineStart("hello", 3)).toBe(0);
		});

		test("returns index after newline for second line", () => {
			expect(lineStart("abc\ndef", 5)).toBe(4);
		});

		test("returns index after second newline for third line", () => {
			expect(lineStart("abc\ndef\nghi", 9)).toBe(8);
		});

		test("returns start of line when cursor is at line start", () => {
			expect(lineStart("abc\ndef", 4)).toBe(4);
		});
	});

	describe("lineEnd", () => {
		test("returns 0 for empty string", () => {
			expect(lineEnd("", 0)).toBe(0);
		});

		test("returns index before newline for first line", () => {
			expect(lineEnd("abc\ndef", 1)).toBe(3);
		});

		test("returns text length for last line", () => {
			expect(lineEnd("abc\ndef", 5)).toBe(7);
		});

		test("returns end of single line", () => {
			expect(lineEnd("hello", 2)).toBe(5);
		});

		test("returns index before newline when cursor is at line start", () => {
			expect(lineEnd("abc\ndef\nghi", 4)).toBe(7);
		});
	});

	describe("moveCursorUp", () => {
		test("returns same index when on first line", () => {
			expect(moveCursorUp("hello", 3)).toBe(3);
		});

		test("returns same index when on first line of empty text", () => {
			expect(moveCursorUp("", 0)).toBe(0);
		});

		test("moves up preserving column", () => {
			// "abc\ndef" cursor at index 5 (col 1 of line 1) → col 1 of line 0
			expect(moveCursorUp("abc\ndef", 5)).toBe(1);
		});

		test("clamps to shorter line above", () => {
			// "ab\ndefgh" cursor at index 7 (col 4 of line 1) → clamp to end of "ab" (index 2)
			expect(moveCursorUp("ab\ndefgh", 7)).toBe(2);
		});

		test("moves from third line to second line", () => {
			// "abc\ndef\nghi" cursor at index 9 (col 1 of line 2) → col 1 of line 1 (index 5)
			expect(moveCursorUp("abc\ndef\nghi", 9)).toBe(5);
		});

		test("moves from start of line to start of line above", () => {
			expect(moveCursorUp("abc\ndef", 4)).toBe(0);
		});
	});

	describe("moveCursorDown", () => {
		test("returns same index when on last line", () => {
			expect(moveCursorDown("hello", 3)).toBe(3);
		});

		test("returns same index for empty text", () => {
			expect(moveCursorDown("", 0)).toBe(0);
		});

		test("moves down preserving column", () => {
			// "abc\ndef" cursor at index 1 (col 1 of line 0) → col 1 of line 1 (index 5)
			expect(moveCursorDown("abc\ndef", 1)).toBe(5);
		});

		test("clamps to shorter line below", () => {
			// "abcde\nfg" cursor at index 4 (col 4 of line 0) → clamp to end of "fg" (index 8)
			expect(moveCursorDown("abcde\nfg", 4)).toBe(8);
		});

		test("moves from first line to second of three", () => {
			// "abc\ndef\nghi" cursor at index 2 (col 2 of line 0) → col 2 of line 1 (index 6)
			expect(moveCursorDown("abc\ndef\nghi", 2)).toBe(6);
		});

		test("moves from start of line to start of line below", () => {
			expect(moveCursorDown("abc\ndef", 0)).toBe(4);
		});
	});
});

describe("text editing", () => {
	describe("insertAt", () => {
		test("inserts character at cursor", () => {
			expect(insertAt("hllo", 1, "e")).toEqual({ text: "hello", cursor: 2 });
		});

		test("inserts at start of text", () => {
			expect(insertAt("ello", 0, "h")).toEqual({ text: "hello", cursor: 1 });
		});

		test("inserts at end of text", () => {
			expect(insertAt("hell", 4, "o")).toEqual({ text: "hello", cursor: 5 });
		});

		test("inserts multiple characters", () => {
			expect(insertAt("hd", 1, "ello worl")).toEqual({
				text: "hello world",
				cursor: 10,
			});
		});

		test("inserts into empty string", () => {
			expect(insertAt("", 0, "hi")).toEqual({ text: "hi", cursor: 2 });
		});

		test("inserts newline", () => {
			expect(insertAt("ab", 1, "\n")).toEqual({ text: "a\nb", cursor: 2 });
		});
	});

	describe("deleteBackward", () => {
		test("deletes character before cursor", () => {
			expect(deleteBackward("hello", 3)).toEqual({ text: "helo", cursor: 2 });
		});

		test("no-op at position 0", () => {
			expect(deleteBackward("hello", 0)).toEqual({ text: "hello", cursor: 0 });
		});

		test("deletes at end of text", () => {
			expect(deleteBackward("hello", 5)).toEqual({ text: "hell", cursor: 4 });
		});

		test("deletes newline to join lines", () => {
			expect(deleteBackward("abc\ndef", 4)).toEqual({
				text: "abcdef",
				cursor: 3,
			});
		});

		test("no-op on empty string", () => {
			expect(deleteBackward("", 0)).toEqual({ text: "", cursor: 0 });
		});
	});

	describe("killToLineEnd", () => {
		test("kills from cursor to end of line", () => {
			expect(killToLineEnd("hello", 2)).toEqual({ text: "he", cursor: 2 });
		});

		test("kills newline when cursor is at end of line", () => {
			expect(killToLineEnd("abc\ndef", 3)).toEqual({
				text: "abcdef",
				cursor: 3,
			});
		});

		test("kills from cursor to newline in multiline text", () => {
			expect(killToLineEnd("abc\ndef", 1)).toEqual({
				text: "a\ndef",
				cursor: 1,
			});
		});

		test("no-op at end of single-line text", () => {
			expect(killToLineEnd("hello", 5)).toEqual({ text: "hello", cursor: 5 });
		});

		test("kills entire line content from start", () => {
			expect(killToLineEnd("hello", 0)).toEqual({ text: "", cursor: 0 });
		});

		test("kills on empty string", () => {
			expect(killToLineEnd("", 0)).toEqual({ text: "", cursor: 0 });
		});
	});

	describe("killToLineStart", () => {
		test("kills from start of line to cursor", () => {
			expect(killToLineStart("hello", 3)).toEqual({ text: "lo", cursor: 0 });
		});

		test("no-op when cursor is at start of line", () => {
			expect(killToLineStart("hello", 0)).toEqual({
				text: "hello",
				cursor: 0,
			});
		});

		test("kills on second line", () => {
			expect(killToLineStart("abc\ndef", 6)).toEqual({
				text: "abc\nf",
				cursor: 4,
			});
		});

		test("kills entire line from end", () => {
			expect(killToLineStart("hello", 5)).toEqual({ text: "", cursor: 0 });
		});

		test("no-op at start of second line", () => {
			expect(killToLineStart("abc\ndef", 4)).toEqual({
				text: "abc\ndef",
				cursor: 4,
			});
		});
	});

	describe("killWordBackward", () => {
		test("kills one word backward", () => {
			expect(killWordBackward("hello world", 11)).toEqual({
				text: "hello ",
				cursor: 6,
			});
		});

		test("kills entire word when no spaces before it", () => {
			expect(killWordBackward("hello", 5)).toEqual({ text: "", cursor: 0 });
		});

		test("skips spaces then kills word", () => {
			expect(killWordBackward("hello   world", 8)).toEqual({
				text: "world",
				cursor: 0,
			});
		});

		test("no-op at position 0", () => {
			expect(killWordBackward("hello", 0)).toEqual({
				text: "hello",
				cursor: 0,
			});
		});

		test("kills word in the middle", () => {
			// "one two| three" — kills "two", leaves space before it
			expect(killWordBackward("one two three", 7)).toEqual({
				text: "one  three",
				cursor: 4,
			});
		});

		test("handles single character word", () => {
			expect(killWordBackward("a b", 1)).toEqual({ text: " b", cursor: 0 });
		});

		test("no-op on empty string", () => {
			expect(killWordBackward("", 0)).toEqual({ text: "", cursor: 0 });
		});

		test("stops at newline boundary", () => {
			// Cursor right after newline — nothing to kill on this line yet
			expect(killWordBackward("hello\nworld", 6)).toEqual({
				text: "hello\nworld",
				cursor: 6,
			});
		});

		test("kills word on second line without crossing newline", () => {
			expect(killWordBackward("hello\nfoo bar", 13)).toEqual({
				text: "hello\nfoo ",
				cursor: 10,
			});
		});
	});
});
