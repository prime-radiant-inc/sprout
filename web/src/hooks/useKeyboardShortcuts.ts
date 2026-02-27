export interface ShortcutActions {
	toggleSidebar: () => void;
	clearFilter: () => void;
	focusInput: () => void;
}

/** Pure function: process a keyboard event and call the appropriate action. Returns true if handled. */
export function handleKeyboardShortcut(event: KeyboardEvent, actions: ShortcutActions): boolean {
	// Ctrl+/ or Cmd+/ toggles sidebar
	if (event.key === "/" && (event.ctrlKey || event.metaKey)) {
		actions.toggleSidebar();
		return true;
	}

	// Escape clears agent filter
	if (event.key === "Escape") {
		actions.clearFilter();
		return true;
	}

	// / focuses input (when not already in an input/textarea)
	if (event.key === "/" && !event.ctrlKey && !event.metaKey) {
		const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
		if (tag === "input" || tag === "textarea" || tag === "select") {
			return false;
		}
		actions.focusInput();
		return true;
	}

	return false;
}

