import styles from "./KeyboardHelp.module.css";

interface KeyboardHelpProps {
	onClose: () => void;
}

const SHORTCUTS = [
	{ keys: "Enter", description: "Send message" },
	{ keys: "Shift+Enter", description: "New line" },
	{ keys: "/", description: "Focus input / commands" },
	{ keys: "Ctrl+/", description: "Toggle sidebar" },
	{ keys: "Escape", description: "Close panels" },
	{ keys: "?", description: "Show this help" },
];

export function KeyboardHelp({ onClose }: KeyboardHelpProps) {
	return (
		<div className={styles.overlay} onClick={onClose} data-testid="keyboard-help">
			<div className={styles.modal} onClick={(e) => e.stopPropagation()}>
				<div className={styles.header}>
					<h2 className={styles.title}>Keyboard Shortcuts</h2>
					<button type="button" className={styles.close} onClick={onClose}>
						{"\u2715"}
					</button>
				</div>
				<div className={styles.list}>
					{SHORTCUTS.map(({ keys, description }) => (
						<div key={keys} className={styles.row}>
							<kbd className={styles.key}>{keys}</kbd>
							<span className={styles.description}>{description}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
