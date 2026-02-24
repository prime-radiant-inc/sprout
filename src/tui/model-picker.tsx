import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface ModelPickerProps {
	models: string[];
	onSelect: (model: string) => void;
	onCancel: () => void;
}

export function ModelPicker({ models, onSelect, onCancel }: ModelPickerProps) {
	const [cursor, setCursor] = useState(0);

	useInput((_input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}

		if (key.return && models.length > 0) {
			onSelect(models[cursor]!);
			return;
		}

		if (key.downArrow) {
			setCursor((prev) => Math.min(prev + 1, models.length - 1));
			return;
		}

		if (key.upArrow) {
			setCursor((prev) => Math.max(prev - 1, 0));
		}
	});

	if (models.length === 0) {
		return <Text>No models available.</Text>;
	}

	return (
		<Box flexDirection="column">
			<Text bold>Select model (Enter to confirm, Esc to cancel):</Text>
			{models.map((m, i) => {
				const selected = i === cursor;
				return (
					<Text key={m} color={selected ? "cyan" : undefined}>
						{selected ? "> " : "  "}
						{m}
					</Text>
				);
			})}
		</Box>
	);
}
