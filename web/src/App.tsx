import { useCallback, useEffect, useRef, useState } from "react";
import type { SlashCommand } from "../../src/tui/slash-commands.ts";
import styles from "./App.module.css";
import { AgentTree } from "./components/AgentTree.tsx";
import { Breadcrumb } from "./components/Breadcrumb.tsx";
import { ConversationView } from "./components/ConversationView.tsx";
import { InputArea } from "./components/InputArea.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { shortModelName } from "./components/format.ts";
import { useAgentTree } from "./hooks/useAgentTree.ts";
import { useEvents } from "./hooks/useEvents.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";

const WS_URL = `ws://${window.location.host}`;

export function App() {
	const { connected, lastMessage, send } = useWebSocket(WS_URL);
	const { events, status, sendCommand } = useEvents(lastMessage, send);
	const { tree, selectedAgent, setSelectedAgent } = useAgentTree(events);

	const [sidebarOpen, setSidebarOpen] = useState(true);

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
			// Ctrl+/ toggles sidebar
			if (e.ctrlKey && e.key === "/") {
				e.preventDefault();
				setSidebarOpen((prev) => !prev);
			}
			// Escape clears agent filter
			if (e.key === "Escape") {
				setSelectedAgent(null);
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [setSelectedAgent]);

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

	const isRunning = status.status === "running";
	const sessionIdShort = status.sessionId
		? status.sessionId.slice(0, 8)
		: "";

	return (
		<div className={styles.layout}>
			<header className={styles.header}>
				<span className={styles.logo}>[sprout]</span>
				<span className={styles.headerRight}>
					{status.model && (
						<span className={styles.model}>
							{shortModelName(status.model)}
						</span>
					)}
					{sessionIdShort && (
						<span className={styles.sessionId}>
							{sessionIdShort}
						</span>
					)}
				</span>
			</header>

			<div className={styles.body}>
				{sidebarOpen && (
					<aside className={styles.sidebar}>
						<AgentTree
							tree={tree}
							selectedAgent={selectedAgent}
							onSelectAgent={setSelectedAgent}
							onToggle={toggleSidebar}
						/>
					</aside>
				)}

				<div className={styles.main}>
					<Breadcrumb tree={tree} selectedAgent={selectedAgent} />
					<div
						ref={conversationRef}
						className={styles.conversation}
						onScroll={handleScroll}
					>
						<ConversationView
							events={events}
							agentFilter={selectedAgent}
						/>
					</div>
					{userScrolledUp && (
						<button
							type="button"
							className={styles.jumpToBottom}
							onClick={jumpToBottom}
						>
							Jump to bottom
						</button>
					)}
				</div>
			</div>

			<footer className={styles.footer}>
				<StatusBar status={status} connected={connected} />
				<InputArea
					isRunning={isRunning}
					onSubmit={handleSubmit}
					onSlashCommand={handleSlashCommand}
					onSteer={handleSteer}
					sendCommand={sendCommand}
				/>
			</footer>
		</div>
	);
}
