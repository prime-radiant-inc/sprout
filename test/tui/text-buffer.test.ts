import { describe, expect, test } from "bun:test";
import type { TextBufferState } from "../../src/tui/text-buffer.ts";
import {
	createBufferState,
	deleteChar,
	getText,
	insertText,
	isOnFirstLine,
	isOnLastLine,
	killLine,
	killLineBackward,
	killWordBackward,
	moveCursor,
	setText,
} from "../../src/tui/text-buffer.ts";

describe("createBufferState", () => {
	test("creates empty buffer with no arguments", () => {
		const s = createBufferState();
		expect(s.lines).toEqual([""]);
		expect(s.cursorLine).toBe(0);
		expect(s.cursorColumn).toBe(0);
		expect(s.preferredColumn).toBe(0);
	});

	test("creates empty buffer with empty string", () => {
		const s = createBufferState("");
		expect(s.lines).toEqual([""]);
		expect(s.cursorLine).toBe(0);
		expect(s.cursorColumn).toBe(0);
	});

	test("creates buffer with single line", () => {
		const s = createBufferState("hello");
		expect(s.lines).toEqual(["hello"]);
		expect(s.cursorLine).toBe(0);
		expect(s.cursorColumn).toBe(0);
	});

	test("creates buffer with multiple lines", () => {
		const s = createBufferState("hello\nworld");
		expect(s.lines).toEqual(["hello", "world"]);
		expect(s.cursorLine).toBe(0);
		expect(s.cursorColumn).toBe(0);
	});

	test("creates buffer with trailing newline", () => {
		const s = createBufferState("hello\n");
		expect(s.lines).toEqual(["hello", ""]);
	});

	test("creates buffer with multiple consecutive newlines", () => {
		const s = createBufferState("a\n\n\nb");
		expect(s.lines).toEqual(["a", "", "", "b"]);
	});
});

describe("getText", () => {
	test("returns empty string for empty buffer", () => {
		expect(getText(createBufferState())).toBe("");
	});

	test("returns single line text", () => {
		expect(getText(createBufferState("hello"))).toBe("hello");
	});

	test("joins multiple lines with newlines", () => {
		expect(getText(createBufferState("hello\nworld"))).toBe("hello\nworld");
	});

	test("preserves empty lines", () => {
		expect(getText(createBufferState("a\n\nb"))).toBe("a\n\nb");
	});
});

describe("setText", () => {
	test("replaces all content", () => {
		const s = setText(createBufferState("old"), "new text");
		expect(s.lines).toEqual(["new text"]);
		expect(s.cursorColumn).toBe(0);
		expect(s.preferredColumn).toBe(0);
	});

	test("splits on newlines", () => {
		const s = setText(createBufferState(), "line 1\nline 2\nline 3");
		expect(s.lines).toEqual(["line 1", "line 2", "line 3"]);
	});

	test("clamps cursorLine to new content bounds", () => {
		const initial: TextBufferState = {
			lines: ["a", "b", "c", "d"],
			cursorLine: 3,
			cursorColumn: 0,
			preferredColumn: 0,
		};
		const s = setText(initial, "only one");
		expect(s.cursorLine).toBe(0);
	});

	test("preserves cursorLine when within new content bounds", () => {
		const initial: TextBufferState = {
			lines: ["a", "b", "c"],
			cursorLine: 1,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = setText(initial, "x\ny\nz");
		expect(s.cursorLine).toBe(1);
		expect(s.cursorColumn).toBe(0);
	});
});

describe("insertText", () => {
	test("inserts character at cursor position", () => {
		const initial: TextBufferState = {
			lines: ["hllo"],
			cursorLine: 0,
			cursorColumn: 1,
			preferredColumn: 1,
		};
		const s = insertText(initial, "e");
		expect(s.lines).toEqual(["hello"]);
		expect(s.cursorColumn).toBe(2);
		expect(s.preferredColumn).toBe(2);
	});

	test("inserts at beginning of line", () => {
		const s = insertText(createBufferState("ello"), "h");
		expect(s.lines).toEqual(["hello"]);
		expect(s.cursorColumn).toBe(1);
	});

	test("inserts at end of line", () => {
		const initial: TextBufferState = {
			lines: ["hell"],
			cursorLine: 0,
			cursorColumn: 4,
			preferredColumn: 4,
		};
		const s = insertText(initial, "o");
		expect(s.lines).toEqual(["hello"]);
		expect(s.cursorColumn).toBe(5);
	});

	test("inserts multiple characters", () => {
		const initial: TextBufferState = {
			lines: ["hd"],
			cursorLine: 0,
			cursorColumn: 1,
			preferredColumn: 1,
		};
		const s = insertText(initial, "ello worl");
		expect(s.lines).toEqual(["hello world"]);
		expect(s.cursorColumn).toBe(10);
	});

	test("inserts into empty buffer", () => {
		const s = insertText(createBufferState(), "hello");
		expect(s.lines).toEqual(["hello"]);
		expect(s.cursorColumn).toBe(5);
	});

	test("inserts newline, splitting line", () => {
		const initial: TextBufferState = {
			lines: ["Hello World"],
			cursorLine: 0,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = insertText(initial, "\n");
		expect(s.lines).toEqual(["Hello", " World"]);
		expect(s.cursorLine).toBe(1);
		expect(s.cursorColumn).toBe(0);
	});

	test("inserts newline at beginning of line", () => {
		const s = insertText(createBufferState("hello"), "\n");
		expect(s.lines).toEqual(["", "hello"]);
		expect(s.cursorLine).toBe(1);
		expect(s.cursorColumn).toBe(0);
	});

	test("inserts newline at end of line", () => {
		const initial: TextBufferState = {
			lines: ["hello"],
			cursorLine: 0,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = insertText(initial, "\n");
		expect(s.lines).toEqual(["hello", ""]);
		expect(s.cursorLine).toBe(1);
		expect(s.cursorColumn).toBe(0);
	});

	test("handles multi-line paste", () => {
		const s = insertText(createBufferState(), "Line 1\nLine 2\nLine 3");
		expect(s.lines).toEqual(["Line 1", "Line 2", "Line 3"]);
		expect(s.cursorLine).toBe(2);
		expect(s.cursorColumn).toBe(6);
	});

	test("handles multi-line paste in middle of existing text", () => {
		const initial: TextBufferState = {
			lines: ["Hello World"],
			cursorLine: 0,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = insertText(initial, "\nfoo\nbar");
		expect(s.lines).toEqual(["Hello", "foo", "bar World"]);
		expect(s.cursorLine).toBe(2);
		expect(s.cursorColumn).toBe(3);
	});

	test("handles multiple consecutive newlines", () => {
		const s = insertText(createBufferState(), "Line 1\n\n\nLine 4");
		expect(s.lines).toEqual(["Line 1", "", "", "Line 4"]);
		expect(s.cursorLine).toBe(3);
		expect(s.cursorColumn).toBe(6);
	});

	test("inserts on second line", () => {
		const initial: TextBufferState = {
			lines: ["first", "second"],
			cursorLine: 1,
			cursorColumn: 3,
			preferredColumn: 3,
		};
		const s = insertText(initial, "X");
		expect(s.lines).toEqual(["first", "secXond"]);
		expect(s.cursorLine).toBe(1);
		expect(s.cursorColumn).toBe(4);
	});
});

describe("deleteChar", () => {
	describe("backward", () => {
		test("deletes character before cursor", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 3,
				preferredColumn: 3,
			};
			const s = deleteChar(initial, "backward");
			expect(s.lines).toEqual(["helo"]);
			expect(s.cursorColumn).toBe(2);
		});

		test("no-op at beginning of first line", () => {
			const initial = createBufferState("hello");
			const s = deleteChar(initial, "backward");
			expect(s).toBe(initial); // same reference, no change
		});

		test("merges with previous line at line beginning", () => {
			const initial: TextBufferState = {
				lines: ["Line 1", "Line 2"],
				cursorLine: 1,
				cursorColumn: 0,
				preferredColumn: 0,
			};
			const s = deleteChar(initial, "backward");
			expect(s.lines).toEqual(["Line 1Line 2"]);
			expect(s.cursorLine).toBe(0);
			expect(s.cursorColumn).toBe(6);
			expect(s.preferredColumn).toBe(6);
		});

		test("deletes last character on a line", () => {
			const initial: TextBufferState = {
				lines: ["a"],
				cursorLine: 0,
				cursorColumn: 1,
				preferredColumn: 1,
			};
			const s = deleteChar(initial, "backward");
			expect(s.lines).toEqual([""]);
			expect(s.cursorColumn).toBe(0);
		});
	});

	describe("forward", () => {
		test("deletes character at cursor position", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 2,
				preferredColumn: 2,
			};
			const s = deleteChar(initial, "forward");
			expect(s.lines).toEqual(["helo"]);
			expect(s.cursorColumn).toBe(2); // cursor stays
		});

		test("no-op at end of last line", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 5,
				preferredColumn: 5,
			};
			const s = deleteChar(initial, "forward");
			expect(s).toBe(initial);
		});

		test("merges with next line at line end", () => {
			const initial: TextBufferState = {
				lines: ["Line 1", "Line 2"],
				cursorLine: 0,
				cursorColumn: 6,
				preferredColumn: 6,
			};
			const s = deleteChar(initial, "forward");
			expect(s.lines).toEqual(["Line 1Line 2"]);
			expect(s.cursorLine).toBe(0);
			expect(s.cursorColumn).toBe(6); // cursor stays
		});

		test("deletes character at start of line", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 0,
				preferredColumn: 0,
			};
			const s = deleteChar(initial, "forward");
			expect(s.lines).toEqual(["ello"]);
			expect(s.cursorColumn).toBe(0);
		});
	});
});

describe("moveCursor", () => {
	describe("left", () => {
		test("moves left within line", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 3,
				preferredColumn: 3,
			};
			const s = moveCursor(initial, "left");
			expect(s.cursorColumn).toBe(2);
			expect(s.preferredColumn).toBe(2);
		});

		test("wraps to end of previous line", () => {
			const initial: TextBufferState = {
				lines: ["Line 1", "Line 2"],
				cursorLine: 1,
				cursorColumn: 0,
				preferredColumn: 0,
			};
			const s = moveCursor(initial, "left");
			expect(s.cursorLine).toBe(0);
			expect(s.cursorColumn).toBe(6);
			expect(s.preferredColumn).toBe(6);
		});

		test("no-op at start of first line", () => {
			const initial = createBufferState("hello");
			const s = moveCursor(initial, "left");
			expect(s).toBe(initial);
		});
	});

	describe("right", () => {
		test("moves right within line", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 2,
				preferredColumn: 2,
			};
			const s = moveCursor(initial, "right");
			expect(s.cursorColumn).toBe(3);
			expect(s.preferredColumn).toBe(3);
		});

		test("wraps to start of next line", () => {
			const initial: TextBufferState = {
				lines: ["Line 1", "Line 2"],
				cursorLine: 0,
				cursorColumn: 6,
				preferredColumn: 6,
			};
			const s = moveCursor(initial, "right");
			expect(s.cursorLine).toBe(1);
			expect(s.cursorColumn).toBe(0);
			expect(s.preferredColumn).toBe(0);
		});

		test("no-op at end of last line", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 5,
				preferredColumn: 5,
			};
			const s = moveCursor(initial, "right");
			expect(s).toBe(initial);
		});
	});

	describe("up", () => {
		test("moves up preserving column", () => {
			const initial: TextBufferState = {
				lines: ["Line 1", "Line 2"],
				cursorLine: 1,
				cursorColumn: 3,
				preferredColumn: 3,
			};
			const s = moveCursor(initial, "up");
			expect(s.cursorLine).toBe(0);
			expect(s.cursorColumn).toBe(3);
			expect(s.preferredColumn).toBe(3); // preserved
		});

		test("clamps column to shorter line above", () => {
			const initial: TextBufferState = {
				lines: ["ab", "defgh"],
				cursorLine: 1,
				cursorColumn: 4,
				preferredColumn: 4,
			};
			const s = moveCursor(initial, "up");
			expect(s.cursorLine).toBe(0);
			expect(s.cursorColumn).toBe(2); // clamped to "ab".length
			expect(s.preferredColumn).toBe(4); // preserved
		});

		test("no-op on first line", () => {
			const initial = createBufferState("hello");
			const s = moveCursor(initial, "up");
			expect(s).toBe(initial);
		});

		test("uses preferredColumn, not current cursorColumn", () => {
			// Scenario: start on col 10, move up to shorter line (col clamped to 3),
			// then move down — should return to col 10, not 3.
			const initial: TextBufferState = {
				lines: ["long line here", "abc", "another long line"],
				cursorLine: 2,
				cursorColumn: 10,
				preferredColumn: 10,
			};
			// Move up to "abc" (length 3)
			const s1 = moveCursor(initial, "up");
			expect(s1.cursorLine).toBe(1);
			expect(s1.cursorColumn).toBe(3);
			expect(s1.preferredColumn).toBe(10);

			// Move up again to "long line here" (length 14)
			const s2 = moveCursor(s1, "up");
			expect(s2.cursorLine).toBe(0);
			expect(s2.cursorColumn).toBe(10);
			expect(s2.preferredColumn).toBe(10);
		});
	});

	describe("down", () => {
		test("moves down preserving column", () => {
			const initial: TextBufferState = {
				lines: ["Line 1", "Line 2"],
				cursorLine: 0,
				cursorColumn: 3,
				preferredColumn: 3,
			};
			const s = moveCursor(initial, "down");
			expect(s.cursorLine).toBe(1);
			expect(s.cursorColumn).toBe(3);
			expect(s.preferredColumn).toBe(3);
		});

		test("clamps column to shorter line below", () => {
			const initial: TextBufferState = {
				lines: ["Long line here", "Short"],
				cursorLine: 0,
				cursorColumn: 10,
				preferredColumn: 10,
			};
			const s = moveCursor(initial, "down");
			expect(s.cursorLine).toBe(1);
			expect(s.cursorColumn).toBe(5); // clamped to "Short".length
			expect(s.preferredColumn).toBe(10); // preserved
		});

		test("no-op on last line", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 3,
				preferredColumn: 3,
			};
			const s = moveCursor(initial, "down");
			expect(s).toBe(initial);
		});

		test("uses preferredColumn across multiple lines", () => {
			const initial: TextBufferState = {
				lines: ["long line here", "abc", "another long line"],
				cursorLine: 0,
				cursorColumn: 10,
				preferredColumn: 10,
			};
			// Move down to "abc" (clamped to 3)
			const s1 = moveCursor(initial, "down");
			expect(s1.cursorLine).toBe(1);
			expect(s1.cursorColumn).toBe(3);
			expect(s1.preferredColumn).toBe(10);

			// Move down again to "another long line" (restored to 10)
			const s2 = moveCursor(s1, "down");
			expect(s2.cursorLine).toBe(2);
			expect(s2.cursorColumn).toBe(10);
			expect(s2.preferredColumn).toBe(10);
		});
	});

	describe("home", () => {
		test("moves to beginning of line", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 3,
				preferredColumn: 3,
			};
			const s = moveCursor(initial, "home");
			expect(s.cursorColumn).toBe(0);
			expect(s.preferredColumn).toBe(0);
		});

		test("no-op when already at start", () => {
			const initial = createBufferState("hello");
			const s = moveCursor(initial, "home");
			// cursorColumn is already 0, so state may or may not be same ref
			expect(s.cursorColumn).toBe(0);
			expect(s.preferredColumn).toBe(0);
		});
	});

	describe("end", () => {
		test("moves to end of line", () => {
			const initial: TextBufferState = {
				lines: ["hello"],
				cursorLine: 0,
				cursorColumn: 2,
				preferredColumn: 2,
			};
			const s = moveCursor(initial, "end");
			expect(s.cursorColumn).toBe(5);
			expect(s.preferredColumn).toBe(5);
		});

		test("works on second line", () => {
			const initial: TextBufferState = {
				lines: ["first", "second"],
				cursorLine: 1,
				cursorColumn: 0,
				preferredColumn: 0,
			};
			const s = moveCursor(initial, "end");
			expect(s.cursorColumn).toBe(6);
			expect(s.preferredColumn).toBe(6);
		});
	});
});

describe("killLine", () => {
	test("kills from cursor to end of line", () => {
		const initial: TextBufferState = {
			lines: ["Hello World"],
			cursorLine: 0,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = killLine(initial);
		expect(s.lines).toEqual(["Hello"]);
		expect(s.cursorColumn).toBe(5);
	});

	test("kills entire line from beginning", () => {
		const s = killLine(createBufferState("hello"));
		expect(s.lines).toEqual([""]);
		expect(s.cursorColumn).toBe(0);
	});

	test("no-op when cursor is at end of line", () => {
		const initial: TextBufferState = {
			lines: ["hello"],
			cursorLine: 0,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = killLine(initial);
		expect(s).toBe(initial);
	});

	test("no-op on empty line", () => {
		const initial = createBufferState("");
		const s = killLine(initial);
		expect(s).toBe(initial);
	});

	test("kills on second line of multiline buffer", () => {
		const initial: TextBufferState = {
			lines: ["first", "hello world"],
			cursorLine: 1,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = killLine(initial);
		expect(s.lines).toEqual(["first", "hello"]);
		expect(s.cursorLine).toBe(1);
		expect(s.cursorColumn).toBe(5);
	});
});

describe("killLineBackward", () => {
	test("kills from beginning of line to cursor", () => {
		const initial: TextBufferState = {
			lines: ["Hello World"],
			cursorLine: 0,
			cursorColumn: 6,
			preferredColumn: 6,
		};
		const s = killLineBackward(initial);
		expect(s.lines).toEqual(["World"]);
		expect(s.cursorColumn).toBe(0);
		expect(s.preferredColumn).toBe(0);
	});

	test("no-op when cursor is at beginning of line", () => {
		const initial = createBufferState("hello");
		const s = killLineBackward(initial);
		expect(s).toBe(initial);
	});

	test("kills entire line when cursor is at end", () => {
		const initial: TextBufferState = {
			lines: ["hello"],
			cursorLine: 0,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = killLineBackward(initial);
		expect(s.lines).toEqual([""]);
		expect(s.cursorColumn).toBe(0);
	});

	test("no-op on empty line", () => {
		const initial = createBufferState("");
		const s = killLineBackward(initial);
		expect(s).toBe(initial);
	});

	test("kills on second line of multiline buffer", () => {
		const initial: TextBufferState = {
			lines: ["first", "hello world"],
			cursorLine: 1,
			cursorColumn: 6,
			preferredColumn: 6,
		};
		const s = killLineBackward(initial);
		expect(s.lines).toEqual(["first", "world"]);
		expect(s.cursorLine).toBe(1);
		expect(s.cursorColumn).toBe(0);
	});
});

describe("killWordBackward", () => {
	test("kills one word backward", () => {
		const initial: TextBufferState = {
			lines: ["hello world"],
			cursorLine: 0,
			cursorColumn: 11,
			preferredColumn: 11,
		};
		const s = killWordBackward(initial);
		expect(s.lines).toEqual(["hello "]);
		expect(s.cursorColumn).toBe(6);
	});

	test("kills entire word when no spaces before it", () => {
		const initial: TextBufferState = {
			lines: ["hello"],
			cursorLine: 0,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const s = killWordBackward(initial);
		expect(s.lines).toEqual([""]);
		expect(s.cursorColumn).toBe(0);
	});

	test("skips spaces then kills word", () => {
		const initial: TextBufferState = {
			lines: ["hello   world"],
			cursorLine: 0,
			cursorColumn: 8,
			preferredColumn: 8,
		};
		const s = killWordBackward(initial);
		expect(s.lines).toEqual(["world"]);
		expect(s.cursorColumn).toBe(0);
	});

	test("no-op at beginning of line", () => {
		const initial: TextBufferState = {
			lines: ["hello"],
			cursorLine: 0,
			cursorColumn: 0,
			preferredColumn: 0,
		};
		const s = killWordBackward(initial);
		expect(s).toBe(initial);
	});

	test("kills word in the middle of a line", () => {
		const initial: TextBufferState = {
			lines: ["one two three"],
			cursorLine: 0,
			cursorColumn: 7,
			preferredColumn: 7,
		};
		const s = killWordBackward(initial);
		expect(s.lines).toEqual(["one  three"]);
		expect(s.cursorColumn).toBe(4);
	});

	test("handles single character word", () => {
		const initial: TextBufferState = {
			lines: ["a b"],
			cursorLine: 0,
			cursorColumn: 1,
			preferredColumn: 1,
		};
		const s = killWordBackward(initial);
		expect(s.lines).toEqual([" b"]);
		expect(s.cursorColumn).toBe(0);
	});

	test("no-op on empty buffer", () => {
		const initial = createBufferState("");
		const s = killWordBackward(initial);
		expect(s).toBe(initial);
	});

	test("stops at beginning of line (does not cross to previous line)", () => {
		const initial: TextBufferState = {
			lines: ["hello", "world"],
			cursorLine: 1,
			cursorColumn: 0,
			preferredColumn: 0,
		};
		const s = killWordBackward(initial);
		expect(s).toBe(initial);
	});

	test("kills word on second line without crossing newline", () => {
		const initial: TextBufferState = {
			lines: ["hello", "foo bar"],
			cursorLine: 1,
			cursorColumn: 7,
			preferredColumn: 7,
		};
		const s = killWordBackward(initial);
		expect(s.lines).toEqual(["hello", "foo "]);
		expect(s.cursorColumn).toBe(4);
	});

	test("kills spaces only when only spaces before cursor", () => {
		const initial: TextBufferState = {
			lines: ["   word"],
			cursorLine: 0,
			cursorColumn: 3,
			preferredColumn: 3,
		};
		const s = killWordBackward(initial);
		expect(s.lines).toEqual(["word"]);
		expect(s.cursorColumn).toBe(0);
	});
});

describe("isOnFirstLine", () => {
	test("true for empty buffer", () => {
		expect(isOnFirstLine(createBufferState())).toBe(true);
	});

	test("true when on first line", () => {
		const s: TextBufferState = {
			lines: ["first", "second"],
			cursorLine: 0,
			cursorColumn: 3,
			preferredColumn: 3,
		};
		expect(isOnFirstLine(s)).toBe(true);
	});

	test("false when on second line", () => {
		const s: TextBufferState = {
			lines: ["first", "second"],
			cursorLine: 1,
			cursorColumn: 0,
			preferredColumn: 0,
		};
		expect(isOnFirstLine(s)).toBe(false);
	});

	test("true for single-line buffer", () => {
		expect(isOnFirstLine(createBufferState("hello"))).toBe(true);
	});
});

describe("isOnLastLine", () => {
	test("true for empty buffer", () => {
		expect(isOnLastLine(createBufferState())).toBe(true);
	});

	test("true when on last line", () => {
		const s: TextBufferState = {
			lines: ["first", "second"],
			cursorLine: 1,
			cursorColumn: 3,
			preferredColumn: 3,
		};
		expect(isOnLastLine(s)).toBe(true);
	});

	test("false when on first line of multiline", () => {
		const s: TextBufferState = {
			lines: ["first", "second"],
			cursorLine: 0,
			cursorColumn: 3,
			preferredColumn: 3,
		};
		expect(isOnLastLine(s)).toBe(false);
	});

	test("true for single-line buffer", () => {
		expect(isOnLastLine(createBufferState("hello"))).toBe(true);
	});
});

describe("purity", () => {
	test("insertText does not mutate original state", () => {
		const original = createBufferState("hello");
		const originalLines = [...original.lines];
		insertText(original, " world");
		expect(original.lines).toEqual(originalLines);
		expect(original.cursorColumn).toBe(0);
	});

	test("deleteChar does not mutate original state", () => {
		const original: TextBufferState = {
			lines: ["hello"],
			cursorLine: 0,
			cursorColumn: 3,
			preferredColumn: 3,
		};
		const originalLines = [...original.lines];
		deleteChar(original, "backward");
		expect(original.lines).toEqual(originalLines);
		expect(original.cursorColumn).toBe(3);
	});

	test("moveCursor does not mutate original state", () => {
		const original: TextBufferState = {
			lines: ["hello"],
			cursorLine: 0,
			cursorColumn: 3,
			preferredColumn: 3,
		};
		moveCursor(original, "left");
		expect(original.cursorColumn).toBe(3);
	});

	test("killLine does not mutate original state", () => {
		const original: TextBufferState = {
			lines: ["hello world"],
			cursorLine: 0,
			cursorColumn: 5,
			preferredColumn: 5,
		};
		const originalLines = [...original.lines];
		killLine(original);
		expect(original.lines).toEqual(originalLines);
	});

	test("killWordBackward does not mutate original state", () => {
		const original: TextBufferState = {
			lines: ["hello world"],
			cursorLine: 0,
			cursorColumn: 11,
			preferredColumn: 11,
		};
		const originalLines = [...original.lines];
		killWordBackward(original);
		expect(original.lines).toEqual(originalLines);
	});
});
