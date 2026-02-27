import {
	type KeyboardEvent,
	type ChangeEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { parseSlashCommand, type SlashCommand } from "../../../src/tui/slash-commands.ts";
import styles from "./InputArea.module.css";

export interface InputAreaProps {
	isRunning: boolean;
	onSubmit: (text: string) => void;
	onSlashCommand: (cmd: SlashCommand) => void;
	onSteer: (text: string) => void;
	onInterrupt?: () => void;
	/** Optional external ref for focusing the textarea from outside. */
	textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

const HISTORY_KEY = "sprout-input-history";
const MAX_HISTORY = 100;

function loadHistory(): string[] {
	try {
		const raw = localStorage.getItem(HISTORY_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveHistory(history: string[]): void {
	try {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
	} catch {
		// localStorage may be full or unavailable; ignore.
	}
}

/** Input area with auto-resize, history navigation, slash commands, and steering mode. */
export function InputArea({
	isRunning,
	onSubmit,
	onSlashCommand,
	onSteer,
	onInterrupt,
	textareaRef: externalRef,
}: InputAreaProps) {
	const [value, setValue] = useState("");
	const [historyIndex, setHistoryIndex] = useState(-1);
	const [draft, setDraft] = useState("");
	const internalRef = useRef<HTMLTextAreaElement>(null);
	const textareaRef = externalRef ?? internalRef;
	const historyRef = useRef<string[]>(loadHistory());

	// Auto-resize textarea to content, max 10 lines
	const autoResize = useCallback(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		// 10 lines x ~23px (15px font x 1.5 line-height)
		const maxHeight = 10 * 23;
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	}, [textareaRef]);

	useEffect(() => {
		autoResize();
	}, [value, autoResize]);

	const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
		setValue(e.target.value);
		// Reset history browsing when user types
		if (historyIndex !== -1) {
			setHistoryIndex(-1);
		}
	};

	const submitValue = useCallback(() => {
		const trimmed = value.trim();
		if (!trimmed) return;

		// Check for slash commands
		const slashCmd = parseSlashCommand(trimmed);
		if (slashCmd) {
			onSlashCommand(slashCmd);
			setValue("");
			return;
		}

		// Steering vs. goal submission
		if (isRunning) {
			onSteer(trimmed);
		} else {
			onSubmit(trimmed);
		}

		// Update history
		const history = historyRef.current;
		// Don't duplicate the last entry
		if (history[history.length - 1] !== trimmed) {
			history.push(trimmed);
		}
		saveHistory(history);
		historyRef.current = history;

		setValue("");
		setHistoryIndex(-1);
		setDraft("");
	}, [value, isRunning, onSubmit, onSlashCommand, onSteer]);

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter submits, Shift+Enter inserts newline
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submitValue();
			return;
		}

		// Up/Down for history navigation (only when cursor is at start/end)
		const el = textareaRef.current;
		if (!el) return;

		if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0) {
			e.preventDefault();
			const history = historyRef.current;
			if (history.length === 0) return;

			if (historyIndex === -1) {
				// Save current input as draft
				setDraft(value);
				const newIndex = history.length - 1;
				setHistoryIndex(newIndex);
				setValue(history[newIndex]!);
			} else if (historyIndex > 0) {
				const newIndex = historyIndex - 1;
				setHistoryIndex(newIndex);
				setValue(history[newIndex]!);
			}
			return;
		}

		if (e.key === "ArrowDown" && el.selectionStart === el.value.length) {
			e.preventDefault();
			const history = historyRef.current;

			if (historyIndex === -1) return;

			if (historyIndex < history.length - 1) {
				const newIndex = historyIndex + 1;
				setHistoryIndex(newIndex);
				setValue(history[newIndex]!);
			} else {
				// Back to draft
				setHistoryIndex(-1);
				setValue(draft);
			}
		}
	};

	const handleSubmitClick = () => {
		if (isRunning && !value.trim() && onInterrupt) {
			onInterrupt();
		} else {
			submitValue();
		}
		textareaRef.current?.focus();
	};

	const placeholder = isRunning
		? "Steer the agent..."
		: "What should I work on?";

	return (
		<div className={styles.inputArea} data-running={String(isRunning)}>
			<textarea
				ref={textareaRef}
				className={styles.textarea}
				value={value}
				onChange={handleChange}
				onKeyDown={handleKeyDown}
				placeholder={placeholder}
				rows={1}
				autoFocus
			/>
			<button
				className={isRunning ? styles.stopBtn : styles.sendBtn}
				onClick={handleSubmitClick}
				type="button"
			>
				{isRunning ? "Stop" : "Send"}
			</button>
		</div>
	);
}
