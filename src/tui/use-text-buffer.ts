import { useState } from "react";
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
	type TextBufferState,
} from "./text-buffer.ts";

export type { TextBufferState };

export function useTextBuffer(initialText = "") {
	const [state, setState] = useState<TextBufferState>(() => createBufferState(initialText));

	const ops = {
		insertText: (text: string) => setState((s) => insertText(s, text)),
		deleteChar: (dir: "forward" | "backward") => setState((s) => deleteChar(s, dir)),
		moveCursor: (dir: "left" | "right" | "up" | "down" | "home" | "end") =>
			setState((s) => moveCursor(s, dir)),
		setText: (text: string) => setState((s) => setText(s, text)),
		getText: () => getText(state),
		setCursorPosition: (line: number, column: number) =>
			setState((s) => ({
				...s,
				cursorLine: Math.max(0, Math.min(line, s.lines.length - 1)),
				cursorColumn: Math.max(0, column),
				preferredColumn: Math.max(0, column),
			})),
		killLine: () => setState((s) => killLine(s)),
		killLineBackward: () => setState((s) => killLineBackward(s)),
		killWordBackward: () => setState((s) => killWordBackward(s)),
		isOnFirstLine: () => isOnFirstLine(state),
		isOnLastLine: () => isOnLastLine(state),
		reset: () => setState(createBufferState("")),
	};

	return [state, ops] as const;
}
