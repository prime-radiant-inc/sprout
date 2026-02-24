import { Box, Text, useInput } from "ink";
import { useState } from "react";
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
	const [history] = useState<string[]>(() => (initialHistory ? [...initialHistory] : []));
	const [historyCursor, setHistoryCursor] = useState(-1);

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			if (isRunning) {
				onInterrupt?.();
			} else {
				onExit?.();
			}
			return;
		}

		if (key.meta && key.return) {
			setValue((prev) => `${prev}\n`);
			return;
		}

		if (key.return) {
			const trimmed = value.trim();
			if (!trimmed) return;

			const slash = parseSlashCommand(trimmed);
			if (slash) {
				onSlashCommand(slash);
			} else if (isRunning && onSteer) {
				onSteer(trimmed);
			} else {
				onSubmit(trimmed);
				history.push(trimmed);
			}
			setValue("");
			setHistoryCursor(-1);
			return;
		}

		if (key.backspace || key.delete) {
			setValue((prev) => prev.slice(0, -1));
			return;
		}

		if (key.upArrow) {
			if (history.length === 0) return;
			const newCursor = historyCursor === -1 ? history.length - 1 : Math.max(0, historyCursor - 1);
			setHistoryCursor(newCursor);
			setValue(history[newCursor]!);
			return;
		}

		if (key.downArrow) {
			if (historyCursor === -1) return;
			const newCursor = historyCursor + 1;
			if (newCursor >= history.length) {
				setHistoryCursor(-1);
				setValue("");
			} else {
				setHistoryCursor(newCursor);
				setValue(history[newCursor]!);
			}
			return;
		}

		// Regular character input
		if (input && !key.ctrl && !key.meta) {
			setValue((prev) => prev + input);
		}
	});

	const prompt = isRunning ? "..." : ">";

	return (
		<Box>
			<Text>
				{prompt} {value}
			</Text>
		</Box>
	);
}
