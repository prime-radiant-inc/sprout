import { useCallback, useEffect, useRef, useState } from "react";
import { WEB_HISTORY_PAGE_SIZE } from "@kernel/constants.ts";
import type { BrowserCommand } from "@kernel/protocol.ts";
import type { SessionModelSelection, SettingsSnapshot } from "@kernel/types.ts";
import { KeyboardHelp } from "./components/KeyboardHelp.tsx";
import type { SessionSelectionRequest } from "@shared/session-selection.ts";
import type { SlashCommand } from "@shared/slash-commands.ts";
import styles from "./App.module.css";
import { ConversationView } from "./components/ConversationView.tsx";
import { InputArea } from "./components/InputArea.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { ThreadPanel } from "./components/ThreadPanel.tsx";
import { ProviderSettingsPanel } from "./components/settings/ProviderSettingsPanel.tsx";
import { useAgentStats } from "./hooks/useAgentStats.ts";
import { useAgentTree } from "./hooks/useAgentTree.ts";
import { useEvents } from "./hooks/useEvents.ts";
import { useFaviconStatus } from "./hooks/useFaviconStatus.ts";
import { handleKeyboardShortcut } from "./hooks/useKeyboardShortcuts.ts";
import { useResizable } from "./hooks/useResizable.ts";
import { useWebSocket } from "./hooks/useWebSocket.ts";
import { useTaskList } from "./hooks/useTaskList.ts";

import { buildWsUrl } from "./hooks/buildWsUrl.ts";

const WS_URL =
	typeof window === "undefined"
		? ""
		: buildWsUrl(
				window.location.protocol,
				window.location.host,
				import.meta.env.VITE_WS_URL,
				window.location.search,
			);

interface EventHistoryPage {
	events: import("@kernel/types.ts").SessionEvent[];
	hasMore: boolean;
	nextBefore: number;
	total: number;
}

export function normalizeWebSessionSelection(
	selection: SessionSelectionRequest,
	settings: SettingsSnapshot | null,
): SessionSelectionRequest {
	if (selection.kind !== "unqualified_model" || !settings) {
		return selection;
	}

	const enabledProviderIds = new Set(
		settings.settings.providers
			.filter((provider) => provider.enabled)
			.map((provider) => provider.id),
	);
	let matchedProviderId: string | undefined;

	for (const entry of settings.catalog) {
		if (!enabledProviderIds.has(entry.providerId)) continue;
		if (!entry.models.some((model) => model.id === selection.modelId)) continue;
		if (matchedProviderId && matchedProviderId !== entry.providerId) {
			return selection;
		}
		matchedProviderId = entry.providerId;
	}

	if (!matchedProviderId) {
		return selection;
	}

	return {
		kind: "model",
		model: {
			providerId: matchedProviderId,
			modelId: selection.modelId,
		},
	};
}

export function createSwitchModelCommand(
	selection: SessionSelectionRequest | SessionModelSelection,
): BrowserCommand {
	return {
		kind: "switch_model",
		data: { selection },
	};
}

export function createCommandFromSlashCommand(
	cmd: SlashCommand,
	settings: SettingsSnapshot | null,
): BrowserCommand | null {
	switch (cmd.kind) {
		case "quit":
			return { kind: "quit", data: {} };
		case "compact":
			return { kind: "compact", data: {} };
		case "clear":
			return { kind: "clear", data: {} };
		case "switch_model":
			return cmd.selection
				? createSwitchModelCommand(normalizeWebSessionSelection(cmd.selection, settings))
				: null;
		case "status":
		case "help":
		default:
			return null;
	}
}

export function App() {
	const { connected, authError, send, onMessage } = useWebSocket(WS_URL);
	const {
		events,
		status,
		settings,
		lastSettingsResult,
		sendCommand,
		prependHistory,
	} = useEvents(onMessage, send);
	const { tree } = useAgentTree(events);
	const agentStats = useAgentStats(events);
	const { tasks } = useTaskList(events);

	const [panelStack, setPanelStack] = useState<string[]>([]);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
	const [showSettings, setShowSettings] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const { width: sidebarWidth, onMouseDown: onSidebarDragStart } = useResizable({
		storageKey: "sprout-sidebar-width",
		defaultWidth: 260,
		minWidth: 200,
		maxWidth: 400,
	});

	// Update favicon based on session status
	useFaviconStatus(status.status);

	// Auto-scroll: track whether user has scrolled up
	const conversationRef = useRef<HTMLDivElement>(null);
	const [userScrolledUp, setUserScrolledUp] = useState(false);
	const [historyLoading, setHistoryLoading] = useState(false);
	const historyLoadingRef = useRef(false);
	const historyHasMoreRef = useRef(true);
	const historyBeforeRef = useRef<number | null>(null);
	const historyRequestedBeforeRef = useRef<number | null>(null);
	const searchRef = useRef(window.location.search);

	useEffect(() => {
		setHistoryLoading(false);
		historyLoadingRef.current = false;
		historyHasMoreRef.current = true;
		historyBeforeRef.current = null;
		historyRequestedBeforeRef.current = null;
	}, [status.sessionId]);

	const loadOlderEvents = useCallback(async () => {
		if (historyLoadingRef.current || !historyHasMoreRef.current || events.length === 0) return;
		const el = conversationRef.current;
		const prevHeight = el?.scrollHeight ?? 0;
		const prevTop = el?.scrollTop ?? 0;
		const before = historyBeforeRef.current ?? events.length;
		if (historyRequestedBeforeRef.current === before) return;
		const params = new URLSearchParams({
			before: String(before),
			limit: String(WEB_HISTORY_PAGE_SIZE),
		});
		const token = new URLSearchParams(searchRef.current).get("token");
		if (token) params.set("token", token);

		historyLoadingRef.current = true;
		historyRequestedBeforeRef.current = before;
		setHistoryLoading(true);
		try {
			const resp = await fetch(`/api/events?${params.toString()}`, { cache: "no-store" });
			if (!resp.ok) {
				historyRequestedBeforeRef.current = null;
				return;
			}
			const page = (await resp.json()) as EventHistoryPage;
			prependHistory(page.events);
			historyHasMoreRef.current = page.hasMore;
			historyBeforeRef.current = page.nextBefore;
			historyRequestedBeforeRef.current = page.nextBefore;
			requestAnimationFrame(() => {
				const node = conversationRef.current;
				if (!node) return;
				const newHeight = node.scrollHeight;
				node.scrollTop = prevTop + (newHeight - prevHeight);
			});
		} finally {
			historyLoadingRef.current = false;
			setHistoryLoading(false);
		}
	}, [events.length, prependHistory]);

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
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
		setUserScrolledUp(!atBottom);
		if (el.scrollTop < 150 && !atBottom) {
			void loadOlderEvents();
		}
	}, [loadOlderEvents]);

	const jumpToBottom = useCallback(() => {
		const el = conversationRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
		setUserScrolledUp(false);
	}, []);

	// Panel stack management
	const openPanel = useCallback((agentId: string) => {
		setPanelStack((prev) => {
			// If already in stack, close everything above it
			const idx = prev.indexOf(agentId);
			if (idx >= 0) return prev.slice(0, idx + 1);
			return [...prev, agentId];
		});
	}, []);

	const closePanel = useCallback((agentId: string) => {
		setPanelStack((prev) => {
			const idx = prev.indexOf(agentId);
			if (idx >= 0) return prev.slice(0, idx);
			return prev;
		});
	}, []);

	// Sidebar calls onSelectAgent(null) for "All agents" — clear panels.
	// Root agent click also clears (opening a panel for root is redundant).
	const handleSidebarSelect = useCallback((agentId: string | null) => {
		if (agentId === null || agentId === tree.agentId) {
			setPanelStack([]);
		} else {
			openPanel(agentId);
		}
	}, [openPanel, tree.agentId]);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const handled = handleKeyboardShortcut(e, {
				toggleSidebar: () => setSidebarOpen((prev) => !prev),
				clearFilter: () => {
					setShowSettings(false);
					setPanelStack([]);
				},
				focusInput: () => inputRef.current?.focus(),
				showHelp: () => setShowKeyboardHelp(true),
			});
			if (handled) e.preventDefault();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, []);

	// Theme: localStorage override or OS preference
	const [themeOverride, setThemeOverride] = useState<"light" | "dark" | null>(() => {
		const stored = localStorage.getItem("sprout-theme");
		return stored === "light" || stored === "dark" ? stored : null;
	});

	const toggleTheme = useCallback(() => {
		setThemeOverride((prev) => {
			const current = prev ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
			const next = current === "dark" ? "light" : "dark";
			localStorage.setItem("sprout-theme", next);
			return next;
		});
	}, []);

	useEffect(() => {
		if (themeOverride) {
			document.documentElement.setAttribute("data-theme", themeOverride);
			return;
		}
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const update = (e: MediaQueryListEvent | MediaQueryList) => {
			document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
		};
		update(mq);
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	}, [themeOverride]);

	const currentTheme = themeOverride ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

	const toggleSidebar = useCallback(() => {
		setSidebarOpen((prev) => !prev);
	}, []);

	// Slash command handler
	const handleSlashCommand = useCallback(
		(cmd: SlashCommand) => {
			const command = createCommandFromSlashCommand(cmd, settings);
			if (command) {
				sendCommand(command);
			}
		},
		[sendCommand, settings],
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

	// Model switch
	const handleSwitchModel = useCallback(
		(selection: SessionModelSelection) => {
			sendCommand(createSwitchModelCommand(selection));
		},
		[sendCommand],
	);

	const isRunning = status.status === "running";

	return (
		<div className={styles.app} data-region="app">
			<StatusBar
				status={status}
				settings={settings}
				connected={connected}
				connectionError={authError}
				onInterrupt={handleInterrupt}
				onSwitchModel={handleSwitchModel}
				onOpenSettings={() => setShowSettings(true)}
				onToggleTheme={toggleTheme}
				theme={currentTheme}
			/>

			<div
				className={styles.body}
				data-region="body"
				data-sidebar-open={String(sidebarOpen)}
			>
				{sidebarOpen && (
					<aside
						className={styles.sidebar}
						data-region="sidebar"
						style={{ width: sidebarWidth }}
					>
						<Sidebar
							status={status}
							tree={tree}
							selectedAgent={panelStack[panelStack.length - 1] ?? null}
							onSelectAgent={handleSidebarSelect}
							onToggle={toggleSidebar}
							events={events}
							agentStats={agentStats}
							tasks={tasks}
						/>
						<div className={styles.dragHandle} onMouseDown={onSidebarDragStart} />
					</aside>
				)}

				<div className={styles.mainColumn} data-region="main">
					<main
						ref={conversationRef}
						className={styles.conversation}
						data-region="conversation"
						onScroll={handleScroll}
					>
						{historyLoading && <div>Loading older events...</div>}
						<ConversationView
							events={events}
							tree={tree}
							onSelectAgent={openPanel}
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
					<InputArea
						isRunning={isRunning}
						onSubmit={handleSubmit}
						onSlashCommand={handleSlashCommand}
						onSteer={handleSteer}
						onInterrupt={handleInterrupt}
						textareaRef={inputRef}
					/>
				</div>
				{panelStack.length > 0 && (
					<div className={styles.panelContainer} data-region="panels">
						{panelStack.map((agentId) => (
							<ThreadPanel
								key={agentId}
								agentId={agentId}
								tree={tree}
								events={events}
								agentStats={agentStats}
								onClose={() => closePanel(agentId)}
								onSelectAgent={openPanel}
							/>
						))}
					</div>
				)}
			</div>

			{showKeyboardHelp && (
				<KeyboardHelp onClose={() => setShowKeyboardHelp(false)} />
			)}
			{showSettings && (
				<ProviderSettingsPanel
					settings={settings}
					lastResult={lastSettingsResult}
					onCommand={sendCommand}
					onClose={() => setShowSettings(false)}
				/>
			)}
		</div>
	);
}
