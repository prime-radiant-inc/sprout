import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
	deleteBackward,
	insertAt,
	isOnFirstLine,
	isOnLastLine,
	killToLineEnd,
	killToLineStart,
	killWordBackward,
	lineEnd,
	lineStart,
	moveCursorDown,
	moveCursorUp,
} from "./buffer.ts";
import type { SlashCommand } from "./slash-commands.ts";
import { parseSlashCommand } from "./slash-commands.ts";

export interface InputAreaProps {
	onSubmit: (text: string) => void;
	onSlashCommand: (cmd: SlashCommand) => void;
	isRunning: boolean;
	initialHistory?: string[];
	onInterrupt?: () => void;
	onExit?: () => void;
	onSteer?: (text: string) => void;
}

export function InputArea({
	onSubmit,
	onSlashCommand,
	isRunning,
	initialHistory,
	onInterrupt,
	onExit,
	onSteer,
}: InputAreaProps) {
	const [value, setValue] = useState("");
	const [cursorIndex, setCursorIndex] = useState(0);
	const [history] = useState<string[]>(() => (initialHistory ? [...initialHistory] : []));
	const [historyCursor, setHistoryCursor] = useState(-1);
	const pendingInterrupt = useRef(false);

	useEffect(() => {
		if (!isRunning) pendingInterrupt.current = false;
	}, [isRunning]);

	useInput((input, key) => {
		// Ctrl-C: interrupt / exit
		if (key.ctrl && input === "c") {
			if (isRunning) {
				if (pendingInterrupt.current) {
					onExit?.();
				} else {
					pendingInterrupt.current = true;
					onInterrupt?.();
				}
			} else {
				onExit?.();
			}
			return;
		}

		// Alt-Enter: insert newline
		if (key.meta && key.return) {
			const edit = insertAt(value, cursorIndex, "\n");
			setValue(edit.text);
			setCursorIndex(edit.cursor);
			return;
		}

		// Enter: submit
		if (key.return) {
			const trimmed = value.trim();
			if (!trimmed) return;

			const slash = parseSlashCommand(trimmed);
			if (slash) {
				onSlashCommand(slash);
			} else if (isRunning && onSteer) {
				history.push(trimmed);
				onSteer(trimmed);
			} else {
				onSubmit(trimmed);
				history.push(trimmed);
			}
			setValue("");
			setCursorIndex(0);
			setHistoryCursor(-1);
			return;
		}

		// Emacs keybindings
		if (key.ctrl && input === "a") {
			setCursorIndex(lineStart(value, cursorIndex));
			return;
		}
		if (key.ctrl && input === "e") {
			setCursorIndex(lineEnd(value, cursorIndex));
			return;
		}
		if (key.ctrl && input === "f") {
			setCursorIndex(Math.min(value.length, cursorIndex + 1));
			return;
		}
		if (key.ctrl && input === "b") {
			setCursorIndex(Math.max(0, cursorIndex - 1));
			return;
		}
		if (key.ctrl && input === "k") {
			const edit = killToLineEnd(value, cursorIndex);
			setValue(edit.text);
			setCursorIndex(edit.cursor);
			return;
		}
		if (key.ctrl && input === "u") {
			const edit = killToLineStart(value, cursorIndex);
			setValue(edit.text);
			setCursorIndex(edit.cursor);
			return;
		}
		if (key.ctrl && input === "w") {
			const edit = killWordBackward(value, cursorIndex);
			setValue(edit.text);
			setCursorIndex(edit.cursor);
			return;
		}

		// Backspace: delete before cursor
		if (key.backspace || key.delete) {
			const edit = deleteBackward(value, cursorIndex);
			setValue(edit.text);
			setCursorIndex(edit.cursor);
			return;
		}

		// Arrow keys
		if (key.leftArrow) {
			setCursorIndex(Math.max(0, cursorIndex - 1));
			return;
		}
		if (key.rightArrow) {
			setCursorIndex(Math.min(value.length, cursorIndex + 1));
			return;
		}

		// Up arrow: history if on first line, else move cursor up
		if (key.upArrow) {
			if (isOnFirstLine(value, cursorIndex)) {
				if (history.length === 0) return;
				const newCursor =
					historyCursor === -1 ? history.length - 1 : Math.max(0, historyCursor - 1);
				setHistoryCursor(newCursor);
				const entry = history[newCursor]!;
				setValue(entry);
				setCursorIndex(entry.length);
			} else {
				setCursorIndex(moveCursorUp(value, cursorIndex));
			}
			return;
		}

		// Down arrow: history if on last line, else move cursor down
		if (key.downArrow) {
			if (isOnLastLine(value, cursorIndex)) {
				if (historyCursor === -1) return;
				const newCursor = historyCursor + 1;
				if (newCursor >= history.length) {
					setHistoryCursor(-1);
					setValue("");
					setCursorIndex(0);
				} else {
					setHistoryCursor(newCursor);
					const entry = history[newCursor]!;
					setValue(entry);
					setCursorIndex(entry.length);
				}
			} else {
				setCursorIndex(moveCursorDown(value, cursorIndex));
			}
			return;
		}

		// Regular character input (exclude tab -- used for tool collapse toggle)
		if (input && !key.ctrl && !key.meta && !key.tab) {
			const edit = insertAt(value, cursorIndex, input);
			setValue(edit.text);
			setCursorIndex(edit.cursor);
		}
	});

	const prompt = isRunning ? "..." : ">";

	const showCursor = !isRunning;
	const before = value.slice(0, cursorIndex);
	const cursorChar = cursorIndex < value.length ? value[cursorIndex]! : " ";
	const after = value.slice(cursorIndex + 1);

	return (
		<Box>
			<Text>{prompt} </Text>
			<Box flexGrow={1}>
				<Text>
					{before}
					{showCursor ? <Text inverse>{cursorChar}</Text> : null}
					{showCursor ? after : value.slice(cursorIndex)}
				</Text>
			</Box>
		</Box>
	);
}
