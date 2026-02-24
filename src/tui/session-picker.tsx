import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { SessionMetadataSnapshot } from "../host/session-metadata.ts";

export interface SessionPickerProps {
	sessions: SessionMetadataSnapshot[];
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
				const label = `${s.sessionId.slice(0, 8)}... | ${s.agentSpec} | ${s.status} | ${s.turns} turns | ${s.model} | ${s.updatedAt}`;
				return (
					<Text key={s.sessionId} color={selected ? "cyan" : undefined}>
						{marker}
						{label}
					</Text>
				);
			})}
		</Box>
	);
}
