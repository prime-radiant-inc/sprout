import { useCallback, useEffect, useRef, useState } from "react";
import type { SlashCommand } from "../../src/tui/slash-commands.ts";
import styles from "./App.module.css";
import { Breadcrumb } from "./components/Breadcrumb.tsx";
import { ConversationView } from "./components/ConversationView.tsx";
import { InputArea } from "./components/InputArea.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { useAgentTree } from "./hooks/useAgentTree.ts";
import { useEvents } from "./hooks/useEvents.ts";
import { useFaviconStatus } from "./hooks/useFaviconStatus.ts";
import { handleKeyboardShortcut } from "./hooks/useKeyboardShortcuts.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";

import { buildWsUrl } from "./hooks/buildWsUrl.ts";

const WS_URL = buildWsUrl(
	window.location.protocol,
	window.location.host,
	import.meta.env.VITE_WS_URL,
);

export function App() {
	const { connected, send, onMessage } = useWebSocket(WS_URL);
	const { events, status, sendCommand } = useEvents(onMessage, send);
	const { tree, selectedAgent, setSelectedAgent } = useAgentTree(events);

	const [sidebarOpen, setSidebarOpen] = useState(true);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// Update favicon based on session status
	useFaviconStatus(status.status);

	// Auto-scroll: track whether user has scrolled up
	const conversationRef = useRef<HTMLDivElement>(null);
	const [userScrolledUp, setUserScrolledUp] = useState(false);

	// Scroll to bottom when events change (unless user scrolled up)
	useEffect(() => {
		if (userScrolledUp) return;
		const el = conversationRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [events, userScrolledUp]);

	// Detect when user scrolls away from bottom
	const handleScroll = useCallback(() => {
		const el = conversationRef.current;
		if (!el) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		setUserScrolledUp(!atBottom);
	}, []);

	const jumpToBottom = useCallback(() => {
		const el = conversationRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
		setUserScrolledUp(false);
	}, []);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const handled = handleKeyboardShortcut(e, {
				toggleSidebar: () => setSidebarOpen((prev) => !prev),
				clearFilter: () => setSelectedAgent(null),
				focusInput: () => inputRef.current?.focus(),
			});
			if (handled) e.preventDefault();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [setSelectedAgent]);

	// Theme detection: follow OS dark/light preference
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const update = (e: MediaQueryListEvent | MediaQueryList) => {
			document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
		};
		update(mq);
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	}, []);

	const toggleSidebar = useCallback(() => {
		setSidebarOpen((prev) => !prev);
	}, []);

	// Slash command handler
	const handleSlashCommand = useCallback(
		(cmd: SlashCommand) => {
			switch (cmd.kind) {
				case "quit":
					sendCommand({ kind: "quit", data: {} });
					break;
				case "compact":
					sendCommand({ kind: "compact", data: {} });
					break;
				case "clear":
					sendCommand({ kind: "clear", data: {} });
					break;
				case "switch_model":
					sendCommand({
						kind: "switch_model",
						data: { model: cmd.model ?? "" },
					});
					break;
				case "status":
					// Status is already visible in the UI; no-op for web
					break;
				case "help":
					// Could show a help overlay in the future; no-op for now
					break;
				default:
					// Unknown or web-specific commands — ignore in web UI
					break;
			}
		},
		[sendCommand],
	);

	// Submit goal
	const handleSubmit = useCallback(
		(text: string) => {
			sendCommand({ kind: "submit_goal", data: { goal: text } });
		},
		[sendCommand],
	);

	// Steer
	const handleSteer = useCallback(
		(text: string) => {
			sendCommand({ kind: "steer", data: { text } });
		},
		[sendCommand],
	);

	// Interrupt
	const handleInterrupt = useCallback(() => {
		sendCommand({ kind: "interrupt", data: {} });
	}, [sendCommand]);

	const isRunning = status.status === "running";

	return (
		<div className={styles.app} data-region="app">
			<StatusBar
				status={status}
				connected={connected}
				onInterrupt={handleInterrupt}
			/>

			<div
				className={styles.body}
				data-region="body"
				data-sidebar-open={String(sidebarOpen)}
			>
				{sidebarOpen && (
					<aside className={styles.sidebar} data-region="sidebar">
						<Sidebar
							status={status}
							tree={tree}
							selectedAgent={selectedAgent}
							onSelectAgent={setSelectedAgent}
							onToggle={toggleSidebar}
							events={events}
						/>
					</aside>
				)}

				<main
					ref={conversationRef}
					className={styles.conversation}
					data-region="conversation"
					onScroll={handleScroll}
				>
					<Breadcrumb tree={tree} selectedAgent={selectedAgent} onSelectAgent={setSelectedAgent} />
					<ConversationView
						events={events}
						agentFilter={selectedAgent}
						tree={tree}
						onSelectAgent={setSelectedAgent}
					/>
					{userScrolledUp && (
						<button
							type="button"
							className={styles.jumpToBottom}
							onClick={jumpToBottom}
						>
							Jump to bottom
						</button>
					)}
				</main>
			</div>

			<InputArea
				isRunning={isRunning}
				onSubmit={handleSubmit}
				onSlashCommand={handleSlashCommand}
				onSteer={handleSteer}
				onInterrupt={handleInterrupt}
				textareaRef={inputRef}
			/>
		</div>
	);
}
