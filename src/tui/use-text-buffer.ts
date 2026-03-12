import { useRef, useState } from "react";
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
	const initialState = useRef<TextBufferState>(createBufferState(initialText));
	const [state, setState] = useState<TextBufferState>(initialState.current);
	const stateRef = useRef<TextBufferState>(state);

	const apply = (update: (state: TextBufferState) => TextBufferState) => {
		const next = update(stateRef.current);
		stateRef.current = next;
		setState(next);
	};

	const ops = {
		insertText: (text: string) => apply((current) => insertText(current, text)),
		deleteChar: (dir: "forward" | "backward") => apply((current) => deleteChar(current, dir)),
		moveCursor: (dir: "left" | "right" | "up" | "down" | "home" | "end") =>
			apply((current) => moveCursor(current, dir)),
		setText: (text: string) => apply((current) => setText(current, text)),
		getText: () => getText(stateRef.current),
		setCursorPosition: (line: number, column: number) =>
			apply((current) => ({
				...current,
				cursorLine: Math.max(0, Math.min(line, current.lines.length - 1)),
				cursorColumn: Math.max(0, column),
				preferredColumn: Math.max(0, column),
			})),
		killLine: () => apply((current) => killLine(current)),
		killLineBackward: () => apply((current) => killLineBackward(current)),
		killWordBackward: () => apply((current) => killWordBackward(current)),
		isOnFirstLine: () => isOnFirstLine(stateRef.current),
		isOnLastLine: () => isOnLastLine(stateRef.current),
		reset: () => {
			const next = createBufferState("");
			stateRef.current = next;
			setState(next);
		},
	};

	return [state, ops] as const;
}
