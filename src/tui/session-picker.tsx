import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { SessionListEntry } from "../host/session-metadata.ts";
import { useWindowSize } from "./use-window-size.ts";

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

/** Format an ISO timestamp as a compact, human-readable datestamp. */
function formatUpdatedAt(isoString: string): string {
	const date = new Date(isoString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays === 1) return "yesterday";
	if (diffDays < 7) return `${diffDays}d ago`;

	const month = date.toLocaleDateString("en-US", { month: "short" });
	const day = date.getDate();
	const year = date.getFullYear();
	if (year === now.getFullYear()) return `${month} ${day}`;
	return `${month} ${day}, ${year}`;
}

export interface SessionPickerProps {
	sessions: SessionListEntry[];
	onSelect: (sessionId: string) => void;
	onCancel: () => void;
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
	const [cursor, setCursor] = useState(0);
	const { rows: terminalRows } = useWindowSize();

	// Cap the session list at 2/3 of the terminal height so scrolling is meaningful.
	// Each session takes exactly 3 rows (2 bold prompt lines + 1 dim agent line).
	// Using wrap="truncate" on every Text ensures rows never wrap, keeping the count exact.
	const maxContainerRows = Math.max(9, Math.floor((terminalRows * 2) / 3));
	const visibleCount = Math.max(3, Math.floor((maxContainerRows - 1) / 3));
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
				const color = selected ? "cyan" : undefined;

				const promptLines = s.firstPrompt ? summarize(s.firstPrompt, 2) : [];
				const promptLine1 = promptLines[0] ?? "";
				const promptLine2 = promptLines[1] ?? "";
				const agentLine = s.lastMessage ? collapse(s.lastMessage, 3) : "";
				const turnsLabel = `${s.turns} ${s.turns === 1 ? "turn" : "turns"}`;
				const dateLabel = formatUpdatedAt(s.updatedAt);

				return (
					<Box key={s.sessionId} flexDirection="column">
						{/* Line 1: first line of user prompt (bold) + date + turn count right-justified */}
						<Box flexDirection="row">
							<Box flexGrow={1}>
								<Text bold wrap="truncate" color={color}>
									{marker}
									{promptLine1 || "(new session)"}
								</Text>
							</Box>
							<Text bold color={selected ? "cyan" : "gray"}>
								{" "}
								{dateLabel} · {turnsLabel}
							</Text>
						</Box>
						{/* Line 2: second line of user prompt (bold), may be empty */}
						<Text bold wrap="truncate" color={color}>
							{"  "}
							{promptLine2}
						</Text>
						{/* Line 3: agent's final message, dim */}
						<Text wrap="truncate" color={selected ? "cyan" : "gray"} dimColor={!selected}>
							{"  "}
							{agentLine}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}
