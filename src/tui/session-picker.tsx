import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { SessionListEntry } from "../host/session-metadata.ts";

/** Strip markdown formatting and return up to maxLines non-empty lines. */
function summarize(text: string, maxLines: number): string[] {
	const stripped = text
		// Remove code fences (``` ... ```) and their contents
		.replace(/```[\s\S]*?```/g, "")
		// Remove heading markers (## Title → Title)
		.replace(/^#{1,6}\s+/gm, "")
		// Remove bold (** and __), must come before italic
		.replace(/\*{2,3}([^*]*)\*{2,3}/g, "$1")
		.replace(/_{2,3}([^_]*)_{2,3}/g, "$1")
		// Remove italic (* and _)
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		// Remove inline code
		.replace(/`([^`]+)`/g, "$1")
		// Remove list markers
		.replace(/^[-*+]\s+/gm, "")
		.replace(/^\d+\.\s+/gm, "");

	return stripped
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.slice(0, maxLines);
}

export interface SessionPickerProps {
	sessions: SessionListEntry[];
	onSelect: (sessionId: string) => void;
	onCancel: () => void;
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
	const [cursor, setCursor] = useState(0);

	useInput((_input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}

		if (key.return && sessions.length > 0) {
			onSelect(sessions[cursor]!.sessionId);
			return;
		}

		if (key.downArrow) {
			setCursor((prev) => Math.min(prev + 1, sessions.length - 1));
			return;
		}

		if (key.upArrow) {
			setCursor((prev) => Math.max(prev - 1, 0));
		}
	});

	if (sessions.length === 0) {
		return <Text>No sessions found.</Text>;
	}

	return (
		<Box flexDirection="column">
			<Text bold>Sessions (Enter to resume, Esc to cancel):</Text>
			{sessions.map((s, i) => {
				const selected = i === cursor;
				const marker = selected ? "> " : "  ";
				const header = `${s.sessionId} | ${s.agentSpec} | ${s.status} | ${s.turns} turns | ${s.model} | ${s.updatedAt}`;
				return (
					<Box key={s.sessionId} flexDirection="column">
						<Text color={selected ? "cyan" : undefined}>
							{marker}
							{header}
						</Text>
						{s.firstPrompt && (
							<Text color={selected ? "cyan" : undefined}>
								{"    "}
								{s.firstPrompt.split("\n")[0]}
							</Text>
						)}
						{s.lastMessage &&
							summarize(s.lastMessage, 3).map((line, idx) => (
								<Text key={line} color={selected ? "cyan" : "gray"}>
									{idx === 0 ? "    ← " : "      "}
									{line}
								</Text>
							))}
					</Box>
				);
			})}
		</Box>
	);
}
