// Buffer editing utilities — pure functions for cursor math and text editing.
// Used by InputArea for navigation and editing operations.

export type Edit = { text: string; cursor: number };

/** Returns the 0-indexed line number the cursor is on. */
export function cursorLine(text: string, cursorIndex: number): number {
	let line = 0;
	for (let i = 0; i < cursorIndex; i++) {
		if (text[i] === "\n") line++;
	}
	return line;
}

/** Returns the number of lines in the text. */
export function lineCount(text: string): number {
	if (text === "") return 1;
	let count = 1;
	for (const ch of text) {
		if (ch === "\n") count++;
	}
	return count;
}

/** Returns true if the cursor is on the first line. */
export function isOnFirstLine(text: string, cursorIndex: number): boolean {
	return cursorLine(text, cursorIndex) === 0;
}

/** Returns true if the cursor is on the last line. */
export function isOnLastLine(text: string, cursorIndex: number): boolean {
	return cursorLine(text, cursorIndex) === lineCount(text) - 1;
}

/** Returns the index of the start of the line the cursor is on. */
export function lineStart(text: string, cursorIndex: number): number {
	// Scan backward from cursor to find the preceding newline (or start of text).
	let i = cursorIndex - 1;
	while (i >= 0 && text[i] !== "\n") i--;
	return i + 1;
}

/** Returns the index of the end of the line the cursor is on (before \n or at text end). */
export function lineEnd(text: string, cursorIndex: number): number {
	let i = cursorIndex;
	while (i < text.length && text[i] !== "\n") i++;
	return i;
}

/** Moves cursor up one line, preserving column offset. Clamps to shorter lines.
 *  Returns same index if already on the first line. */
export function moveCursorUp(text: string, cursorIndex: number): number {
	if (isOnFirstLine(text, cursorIndex)) return cursorIndex;
	const col = cursorIndex - lineStart(text, cursorIndex);
	// Find the line above: go to start of current line, step back over the \n,
	// then find the start of that line.
	const prevLineEnd = lineStart(text, cursorIndex) - 1; // the \n
	const prevLineStart = lineStart(text, prevLineEnd);
	const prevLineLength = prevLineEnd - prevLineStart;
	return prevLineStart + Math.min(col, prevLineLength);
}

/** Moves cursor down one line, preserving column offset. Clamps to shorter lines.
 *  Returns same index if already on the last line. */
export function moveCursorDown(text: string, cursorIndex: number): number {
	if (isOnLastLine(text, cursorIndex)) return cursorIndex;
	const col = cursorIndex - lineStart(text, cursorIndex);
	// Find the line below: go to end of current line (the \n), step past it.
	const currentEnd = lineEnd(text, cursorIndex); // index of \n
	const nextLineStart = currentEnd + 1;
	const nextLineEnd = lineEnd(text, nextLineStart);
	const nextLineLength = nextLineEnd - nextLineStart;
	return nextLineStart + Math.min(col, nextLineLength);
}

/** Inserts text at cursor position. */
export function insertAt(text: string, cursorIndex: number, input: string): Edit {
	return {
		text: text.slice(0, cursorIndex) + input + text.slice(cursorIndex),
		cursor: cursorIndex + input.length,
	};
}

/** Deletes one character before cursor. No-op at position 0. */
export function deleteBackward(text: string, cursorIndex: number): Edit {
	if (cursorIndex === 0) return { text, cursor: 0 };
	return {
		text: text.slice(0, cursorIndex - 1) + text.slice(cursorIndex),
		cursor: cursorIndex - 1,
	};
}

/** Kills from cursor to end of line. If cursor is at line end, kills the \n to join lines. */
export function killToLineEnd(text: string, cursorIndex: number): Edit {
	const end = lineEnd(text, cursorIndex);
	if (cursorIndex === end) {
		// Cursor is at line end; if there's a \n, kill it to join with next line.
		if (cursorIndex < text.length && text[cursorIndex] === "\n") {
			return {
				text: text.slice(0, cursorIndex) + text.slice(cursorIndex + 1),
				cursor: cursorIndex,
			};
		}
		// At end of text, nothing to kill.
		return { text, cursor: cursorIndex };
	}
	return {
		text: text.slice(0, cursorIndex) + text.slice(end),
		cursor: cursorIndex,
	};
}

/** Kills from start of current line to cursor. */
export function killToLineStart(text: string, cursorIndex: number): Edit {
	const start = lineStart(text, cursorIndex);
	if (cursorIndex === start) return { text, cursor: cursorIndex };
	return {
		text: text.slice(0, start) + text.slice(cursorIndex),
		cursor: start,
	};
}

/** Kills one word backward: skip spaces, then skip non-spaces. Stops at newlines. */
export function killWordBackward(text: string, cursorIndex: number): Edit {
	if (cursorIndex === 0) return { text, cursor: 0 };
	let i = cursorIndex;
	// Skip spaces backward (stop at newlines)
	while (i > 0 && text[i - 1] === " ") i--;
	// Skip non-spaces backward (stop at spaces and newlines)
	while (i > 0 && text[i - 1] !== " " && text[i - 1] !== "\n") i--;
	return {
		text: text.slice(0, i) + text.slice(cursorIndex),
		cursor: i,
	};
}
