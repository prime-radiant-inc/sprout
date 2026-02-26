// Pure functions for 2D text buffer with lines-array model and cursor positioning.
// Foundation for multiline text editing — all functions return new state, never mutate.

export interface TextBufferState {
	lines: string[];
	cursorLine: number;
	cursorColumn: number;
	preferredColumn: number;
}

/** Create a new buffer state, splitting text on newlines. Cursor starts at 0,0. */
export function createBufferState(text = ""): TextBufferState {
	return {
		lines: text.split("\n"),
		cursorLine: 0,
		cursorColumn: 0,
		preferredColumn: 0,
	};
}

/** Return the buffer content as a single string with newlines. */
export function getText(state: TextBufferState): string {
	return state.lines.join("\n");
}

/** Replace all content. Cursor column resets to 0; cursorLine is clamped to new bounds. */
export function setText(state: TextBufferState, text: string): TextBufferState {
	const newLines = text.split("\n");
	return {
		lines: newLines,
		cursorLine: Math.min(newLines.length - 1, state.cursorLine),
		cursorColumn: 0,
		preferredColumn: 0,
	};
}

/** Insert text at the cursor position. Handles newlines and multi-line paste. */
export function insertText(state: TextBufferState, text: string): TextBufferState {
	const { lines, cursorLine, cursorColumn } = state;
	const currentLine = lines[cursorLine] || "";
	const beforeCursor = currentLine.slice(0, cursorColumn);
	const afterCursor = currentLine.slice(cursorColumn);

	if (text.includes("\n")) {
		const parts = text.split("\n");
		const newLines = [...lines];

		// First part appends to text before cursor on current line
		newLines[cursorLine] = beforeCursor + (parts[0] ?? "");

		// Middle parts become new lines
		for (let i = 1; i < parts.length - 1; i++) {
			newLines.splice(cursorLine + i, 0, parts[i] ?? "");
		}

		// Last part gets the afterCursor text appended
		const lastPart = parts[parts.length - 1] ?? "";
		newLines.splice(cursorLine + parts.length - 1, 0, lastPart + afterCursor);

		return {
			lines: newLines,
			cursorLine: cursorLine + parts.length - 1,
			cursorColumn: lastPart.length,
			preferredColumn: lastPart.length,
		};
	}

	// No newlines — simple insertion within current line
	const newLines = [...lines];
	newLines[cursorLine] = beforeCursor + text + afterCursor;
	const newColumn = cursorColumn + text.length;

	return {
		lines: newLines,
		cursorLine,
		cursorColumn: newColumn,
		preferredColumn: newColumn,
	};
}

/** Delete one character forward or backward. Merges lines at boundaries. */
export function deleteChar(
	state: TextBufferState,
	direction: "forward" | "backward",
): TextBufferState {
	const { lines, cursorLine, cursorColumn } = state;
	const currentLine = lines[cursorLine] || "";

	if (direction === "backward") {
		if (cursorColumn > 0) {
			// Delete within line
			const newLine = currentLine.slice(0, cursorColumn - 1) + currentLine.slice(cursorColumn);
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorColumn: cursorColumn - 1,
				preferredColumn: cursorColumn - 1,
			};
		}
		if (cursorLine > 0) {
			// Merge with previous line
			const prevLine = lines[cursorLine - 1] ?? "";
			const newLines = [...lines];
			newLines[cursorLine - 1] = prevLine + currentLine;
			newLines.splice(cursorLine, 1);
			return {
				lines: newLines,
				cursorLine: cursorLine - 1,
				cursorColumn: prevLine.length,
				preferredColumn: prevLine.length,
			};
		}
		return state;
	}

	// direction === "forward"
	if (cursorColumn < currentLine.length) {
		const newLine = currentLine.slice(0, cursorColumn) + currentLine.slice(cursorColumn + 1);
		const newLines = [...lines];
		newLines[cursorLine] = newLine;
		return {
			lines: newLines,
			cursorLine,
			cursorColumn,
			preferredColumn: cursorColumn,
		};
	}
	if (cursorLine < lines.length - 1) {
		// Merge with next line
		const nextLine = lines[cursorLine + 1] ?? "";
		const newLines = [...lines];
		newLines[cursorLine] = currentLine + nextLine;
		newLines.splice(cursorLine + 1, 1);
		return {
			lines: newLines,
			cursorLine,
			cursorColumn,
			preferredColumn: cursorColumn,
		};
	}
	return state;
}

/** Move cursor in the given direction. Up/down use preferredColumn for column memory. */
export function moveCursor(
	state: TextBufferState,
	direction: "left" | "right" | "up" | "down" | "home" | "end",
): TextBufferState {
	const { lines, cursorLine, cursorColumn } = state;
	const currentLine = lines[cursorLine] || "";

	switch (direction) {
		case "left": {
			if (cursorColumn > 0) {
				const newCol = cursorColumn - 1;
				return {
					...state,
					cursorColumn: newCol,
					preferredColumn: newCol,
				};
			}
			if (cursorLine > 0) {
				const newCol = (lines[cursorLine - 1] ?? "").length;
				return {
					...state,
					cursorLine: cursorLine - 1,
					cursorColumn: newCol,
					preferredColumn: newCol,
				};
			}
			return state;
		}
		case "right": {
			if (cursorColumn < currentLine.length) {
				const newCol = cursorColumn + 1;
				return {
					...state,
					cursorColumn: newCol,
					preferredColumn: newCol,
				};
			}
			if (cursorLine < lines.length - 1) {
				return {
					...state,
					cursorLine: cursorLine + 1,
					cursorColumn: 0,
					preferredColumn: 0,
				};
			}
			return state;
		}
		case "up": {
			if (cursorLine > 0) {
				const targetCol = Math.min(state.preferredColumn, (lines[cursorLine - 1] ?? "").length);
				return {
					...state,
					cursorLine: cursorLine - 1,
					cursorColumn: targetCol,
					// preferredColumn is intentionally NOT changed
				};
			}
			return state;
		}
		case "down": {
			if (cursorLine < lines.length - 1) {
				const targetCol = Math.min(state.preferredColumn, (lines[cursorLine + 1] ?? "").length);
				return {
					...state,
					cursorLine: cursorLine + 1,
					cursorColumn: targetCol,
					// preferredColumn is intentionally NOT changed
				};
			}
			return state;
		}
		case "home":
			return { ...state, cursorColumn: 0, preferredColumn: 0 };
		case "end":
			return {
				...state,
				cursorColumn: currentLine.length,
				preferredColumn: currentLine.length,
			};
	}
}

/** Delete from cursor to end of current line (Ctrl+K). No-op if cursor is already at EOL. */
export function killLine(state: TextBufferState): TextBufferState {
	const { lines, cursorLine, cursorColumn } = state;
	const currentLine = lines[cursorLine] || "";

	if (cursorColumn >= currentLine.length) {
		return state;
	}

	const newLines = [...lines];
	newLines[cursorLine] = currentLine.slice(0, cursorColumn);
	return {
		...state,
		lines: newLines,
		preferredColumn: cursorColumn,
	};
}

/** Delete from start of current line to cursor (Ctrl+U). No-op if cursor is at SOL. */
export function killLineBackward(state: TextBufferState): TextBufferState {
	const { lines, cursorLine, cursorColumn } = state;
	const currentLine = lines[cursorLine] || "";

	if (cursorColumn === 0) {
		return state;
	}

	const newLines = [...lines];
	newLines[cursorLine] = currentLine.slice(cursorColumn);
	return {
		...state,
		lines: newLines,
		cursorColumn: 0,
		preferredColumn: 0,
	};
}

/** Kill one word backward: skip spaces, then skip non-spaces. Stops at line boundary (Ctrl+W). */
export function killWordBackward(state: TextBufferState): TextBufferState {
	const { lines, cursorLine, cursorColumn } = state;

	if (cursorColumn === 0) {
		return state;
	}

	const line = lines[cursorLine] || "";
	let i = cursorColumn;

	// Skip spaces backward
	while (i > 0 && line[i - 1] === " ") i--;
	// Skip non-spaces backward (stop at spaces)
	while (i > 0 && line[i - 1] !== " ") i--;

	const newLine = line.slice(0, i) + line.slice(cursorColumn);
	const newLines = [...lines];
	newLines[cursorLine] = newLine;

	return {
		...state,
		lines: newLines,
		cursorColumn: i,
		preferredColumn: i,
	};
}

/** Returns true if the cursor is on the first line. */
export function isOnFirstLine(state: TextBufferState): boolean {
	return state.cursorLine === 0;
}

/** Returns true if the cursor is on the last line. */
export function isOnLastLine(state: TextBufferState): boolean {
	return state.cursorLine === state.lines.length - 1;
}
