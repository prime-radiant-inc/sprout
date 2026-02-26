import { Box, Text, useInput } from "ink";

export interface AutocompleteProps {
	items: string[];
	selectedIndex: number;
	visible: boolean;
	maxItems?: number;
	isActive?: boolean;
	onSelect?: (item: string) => void;
	onCancel?: () => void;
	onNavigate?: (direction: "up" | "down") => void;
}

export function Autocomplete({
	items,
	selectedIndex,
	visible,
	maxItems = 5,
	isActive = true,
	onSelect,
	onCancel,
	onNavigate,
}: AutocompleteProps) {
	useInput(
		(_input, key) => {
			if (key.escape) {
				onCancel?.();
				return;
			}
			if (key.return || key.tab) {
				const item = items[selectedIndex];
				if (item) onSelect?.(item);
				return;
			}
			if (key.upArrow) {
				onNavigate?.("up");
				return;
			}
			if (key.downArrow) {
				onNavigate?.("down");
				return;
			}
		},
		{ isActive: visible && isActive },
	);

	if (!visible || items.length === 0) return null;

	const startIndex = Math.max(0, Math.min(selectedIndex, items.length - maxItems));
	const endIndex = Math.min(items.length, startIndex + maxItems);
	const visibleItems = items.slice(startIndex, endIndex);

	return (
		<Box flexDirection="column">
			{visibleItems.map((item, i) => {
				const actual = startIndex + i;
				const selected = actual === selectedIndex;
				return (
					<Text key={`${actual}-${item}`} color={selected ? "cyan" : "gray"}>
						{selected ? "> " : "  "}
						{item}
					</Text>
				);
			})}
		</Box>
	);
}
