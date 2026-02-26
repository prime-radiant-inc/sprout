import { Box, Text } from "ink";

interface TextRendererProps {
	lines: string[];
	cursorLine: number;
	cursorColumn: number;
	isFocused: boolean;
	placeholder?: string;
}

export function TextRenderer({
	lines,
	cursorLine,
	cursorColumn,
	isFocused,
	placeholder = "Type your message...",
}: TextRendererProps) {
	const safeLines = lines.length === 0 ? [""] : lines;
	const safeCursorLine = Math.max(0, Math.min(cursorLine, safeLines.length - 1));
	const currentLine = safeLines[safeCursorLine] ?? "";
	const safeCursorColumn = Math.max(0, Math.min(cursorColumn, currentLine.length));

	if (!isFocused && safeLines.length === 1 && safeLines[0] === "") {
		return <Text dimColor>{placeholder}</Text>;
	}

	return (
		<Box flexDirection="column">
			{safeLines.map((line, i) => {
				const isCurrentLine = i === safeCursorLine;
				if (isCurrentLine && isFocused) {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional, no stable IDs
						<Box key={i} flexDirection="row">
							<Text>{line.slice(0, safeCursorColumn)}</Text>
							<Text inverse>{line.slice(safeCursorColumn, safeCursorColumn + 1) || " "}</Text>
							<Text>{line.slice(safeCursorColumn + 1)}</Text>
						</Box>
					);
				}
				if (line.length === 0) {
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional, no stable IDs
					return <Text key={i}> </Text>;
				}
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional, no stable IDs
				return <Text key={i}>{line}</Text>;
			})}
		</Box>
	);
}
