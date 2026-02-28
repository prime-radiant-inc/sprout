/** Unicode icons for known tool types. */
const TOOL_ICONS: Record<string, string> = {
	exec: "\u{1F4BB}", // terminal
	bash: "\u{1F4BB}", // terminal
	read_file: "\u{1F4C4}", // file
	write_file: "\u{270F}", // pencil
	edit_file: "\u{270F}", // pencil
	grep: "\u{1F50D}", // search
	glob: "\u{1F4C1}", // folder
};

/** Get icon for a tool, or null if no specific icon exists. */
export function getToolIcon(toolName: string): string | null {
	return TOOL_ICONS[toolName] ?? null;
}
