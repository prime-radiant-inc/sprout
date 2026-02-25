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

/** Collapse summarized lines into a single string joined by " · ". */
function collapse(text: string, maxLines: number): string {
	return summarize(text, maxLines).join(" · ");
}

export interface SessionPickerProps {
	sessions: SessionListEntry[];
	onSelect: (sessionId: string) => void;
	onCancel: () => void;
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
	const [cursor, setCursor] = useState(0);

	// Show a viewport sized to the terminal, keeping the cursor roughly centered.
	const terminalRows = process.stdout.rows ?? 24;
	const visibleCount = Math.max(3, Math.floor((terminalRows - 3) / 2));
	const windowStart = Math.max(
		0,
		Math.min(cursor - Math.floor(visibleCount / 2), sessions.length - visibleCount),
	);
	const visibleSessions = sessions.slice(
		windowStart,
		Math.min(sessions.length, windowStart + visibleCount),
	);

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
			{visibleSessions.map((s, i) => {
				const globalIndex = windowStart + i;
				const selected = globalIndex === cursor;
				const marker = selected ? "> " : "  ";
				const header = `${s.sessionId} | ${s.agentSpec} | ${s.status} | ${s.turns} turns | ${s.model} | ${s.updatedAt}`;

				const parts: string[] = [];
				if (s.firstPrompt) {
					const line = collapse(s.firstPrompt, 1);
					if (line) parts.push(line);
				}
				if (s.lastMessage) {
					const line = collapse(s.lastMessage, 3);
					if (line) parts.push(line);
				}
				const details = parts.join(" · ");

				return (
					<Box key={s.sessionId} flexDirection="column">
						<Text color={selected ? "cyan" : undefined}>
							{marker}
							{header}
						</Text>
						{details && (
							<Text color={selected ? "cyan" : "gray"}>{"    "}{details}</Text>
						)}
					</Box>
				);
			})}
		</Box>
	);
}
