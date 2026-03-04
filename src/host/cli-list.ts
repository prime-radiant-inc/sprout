import { loadSessionSummaries, type SessionListEntry } from "./session-metadata.ts";

interface ListModeDeps {
	loadSessionSummaries: typeof loadSessionSummaries;
	presentSessionPicker: (sessions: SessionListEntry[]) => Promise<string | null>;
	onNoSessions: () => void;
}

/** Render the TUI session picker and return the selected session id (or null on cancel). */
export async function presentSessionPicker(
	sessions: SessionListEntry[],
): Promise<string | null> {
	const { render } = await import("ink");
	const React = await import("react");
	const { SessionPicker } = await import("../tui/session-picker.tsx");

	// Enter alternate screen so the picker does not pollute scrollback.
	process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
	try {
		return await new Promise<string | null>((resolve) => {
			const { unmount } = render(
				React.createElement(SessionPicker, {
					sessions,
					onSelect: (id: string) => {
						unmount();
						resolve(id);
					},
					onCancel: () => {
						unmount();
						resolve(null);
					},
				}),
				{ kittyKeyboard: { mode: "enabled" as const } },
			);
		});
	} finally {
		// Exit alternate screen, restoring previous terminal content.
		process.stdout.write("\x1b[?1049l");
	}
}

/**
 * List sessions, show the picker, and resume the selected session.
 * If there are no sessions, emits a no-sessions message callback and returns.
 */
export async function runListMode(
	opts: {
		sessionsDir: string;
		logsDir: string;
		onResume: (sessionId: string) => Promise<void>;
	},
	deps: Partial<ListModeDeps> = {},
): Promise<void> {
	const d: ListModeDeps = {
		loadSessionSummaries: deps.loadSessionSummaries ?? loadSessionSummaries,
		presentSessionPicker: deps.presentSessionPicker ?? presentSessionPicker,
		onNoSessions: deps.onNoSessions ?? (() => console.log("No sessions found.")),
	};

	const sessions = await d.loadSessionSummaries(opts.sessionsDir, opts.logsDir);
	if (sessions.length === 0) {
		d.onNoSessions();
		return;
	}

	const selectedId = await d.presentSessionPicker(sessions);
	if (selectedId) {
		await opts.onResume(selectedId);
	}
}
