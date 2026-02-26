import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { readClipboard } from "./clipboard.ts";
import type { SlashCommand } from "./slash-commands.ts";
import { parseSlashCommand } from "./slash-commands.ts";
import { getText } from "./text-buffer.ts";
import { TextRenderer } from "./text-renderer.tsx";
import { useTextBuffer } from "./use-text-buffer.ts";

export interface InputAreaProps {
	onSubmit: (text: string) => void;
	onSlashCommand: (cmd: SlashCommand) => void;
	isRunning: boolean;
	initialHistory?: string[];
	onInterrupt?: () => void;
	onIdleCtrlC?: () => void;
	onExit?: () => void;
	onSteer?: (text: string) => void;
	onCancelExit?: () => void;
	/** True when the SIGINT path (cli.ts) has set exit-pending, so any keystroke should cancel it. */
	exitPending?: boolean;
}

export function InputArea({
	onSubmit,
	onSlashCommand,
	isRunning,
	initialHistory,
	onInterrupt,
	onIdleCtrlC,
	onExit,
	onSteer,
	onCancelExit,
	exitPending,
}: InputAreaProps) {
	const [bufferState, bufferOps] = useTextBuffer();
	const [history] = useState<string[]>(() => (initialHistory ? [...initialHistory] : []));
	const [historyCursor, setHistoryCursor] = useState(-1);
	const pendingInterrupt = useRef(false);
	const pendingInterruptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const exitPendingRef = useRef(exitPending ?? false);

	useEffect(() => {
		exitPendingRef.current = exitPending ?? false;
	}, [exitPending]);

	useEffect(() => {
		if (!isRunning) pendingInterrupt.current = false;
	}, [isRunning]);

	useInput((input, key) => {
		// Ctrl-C: two-stage exit. First press interrupts (if running) or warns
		// (if idle). Second press exits.
		if (key.ctrl && input === "c") {
			if (pendingInterrupt.current) {
				if (pendingInterruptTimer.current) {
					clearTimeout(pendingInterruptTimer.current);
					pendingInterruptTimer.current = null;
				}
				onExit?.();
			} else {
				pendingInterrupt.current = true;
				if (isRunning) {
					onInterrupt?.();
					// pendingInterrupt resets when isRunning → false via useEffect
				} else {
					onIdleCtrlC?.();
					// Reset after 5s so it must be pressed again in rapid succession
					pendingInterruptTimer.current = setTimeout(() => {
						pendingInterrupt.current = false;
						pendingInterruptTimer.current = null;
						onCancelExit?.();
					}, 5000);
				}
			}
			return;
		}

		// Any non-Ctrl+C key cancels a pending exit (from either stdin or SIGINT path)
		if (pendingInterrupt.current || exitPendingRef.current) {
			pendingInterrupt.current = false;
			if (pendingInterruptTimer.current) {
				clearTimeout(pendingInterruptTimer.current);
				pendingInterruptTimer.current = null;
			}
			onCancelExit?.();
		}

		// Alt-Enter: insert newline
		if (key.meta && key.return) {
			bufferOps.insertText("\n");
			return;
		}

		// Enter: submit
		if (key.return) {
			const trimmed = getText(bufferState).trim();
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
			bufferOps.reset();
			setHistoryCursor(-1);
			return;
		}

		// Clipboard paste
		if (key.ctrl && input === "v") {
			readClipboard().then((text) => {
				if (text) bufferOps.insertText(text);
			});
			return;
		}

		// Emacs keybindings
		if (key.ctrl && input === "a") {
			bufferOps.moveCursor("home");
			return;
		}
		if (key.ctrl && input === "e") {
			bufferOps.moveCursor("end");
			return;
		}
		if (key.ctrl && input === "f") {
			bufferOps.moveCursor("right");
			return;
		}
		if (key.ctrl && input === "b") {
			bufferOps.moveCursor("left");
			return;
		}
		if (key.ctrl && input === "k") {
			bufferOps.killLine();
			return;
		}
		if (key.ctrl && input === "u") {
			bufferOps.killLineBackward();
			return;
		}
		if (key.ctrl && input === "w") {
			bufferOps.killWordBackward();
			return;
		}

		// Backspace: delete before cursor
		if (key.backspace || key.delete) {
			bufferOps.deleteChar("backward");
			return;
		}

		// Arrow keys
		if (key.leftArrow) {
			bufferOps.moveCursor("left");
			return;
		}
		if (key.rightArrow) {
			bufferOps.moveCursor("right");
			return;
		}

		// Up arrow: history if on first line, else move cursor up
		if (key.upArrow) {
			if (bufferOps.isOnFirstLine()) {
				if (history.length === 0) return;
				const newCursor =
					historyCursor === -1 ? history.length - 1 : Math.max(0, historyCursor - 1);
				setHistoryCursor(newCursor);
				const entry = history[newCursor]!;
				bufferOps.setText(entry);
				const lines = entry.split("\n");
				const lastLine = lines[lines.length - 1] ?? "";
				bufferOps.setCursorPosition(lines.length - 1, lastLine.length);
			} else {
				bufferOps.moveCursor("up");
			}
			return;
		}

		// Down arrow: history if on last line, else move cursor down
		if (key.downArrow) {
			if (bufferOps.isOnLastLine()) {
				if (historyCursor === -1) return;
				const newCursor = historyCursor + 1;
				if (newCursor >= history.length) {
					setHistoryCursor(-1);
					bufferOps.reset();
				} else {
					setHistoryCursor(newCursor);
					const entry = history[newCursor]!;
					bufferOps.setText(entry);
					const lines = entry.split("\n");
					const lastLine = lines[lines.length - 1] ?? "";
					bufferOps.setCursorPosition(lines.length - 1, lastLine.length);
				}
			} else {
				bufferOps.moveCursor("down");
			}
			return;
		}

		// Tab: reserved for future autocomplete
		if (key.tab) return;

		// Regular character input
		if (input && !key.ctrl && !key.meta) {
			bufferOps.insertText(input);
		}
	});

	const prompt = isRunning ? "..." : ">";

	return (
		<Box>
			<Text>{prompt} </Text>
			<Box flexGrow={1}>
				<TextRenderer
					lines={bufferState.lines}
					cursorLine={bufferState.cursorLine}
					cursorColumn={bufferState.cursorColumn}
					isFocused={!isRunning}
				/>
			</Box>
		</Box>
	);
}
