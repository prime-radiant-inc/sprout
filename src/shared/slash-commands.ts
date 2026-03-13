import { parseSessionSelectionRequest, type SessionSelectionRequest } from "./session-selection.ts";

export type SlashCommand =
	| { kind: "help" }
	| { kind: "quit" }
	| { kind: "settings" }
	| { kind: "switch_model"; selection: SessionSelectionRequest | undefined }
	| { kind: "invalid"; raw: string; message: string }
	| { kind: "compact" }
	| { kind: "clear" }
	| { kind: "status" }
	| { kind: "collapse_tools" }
	| { kind: "terminal_setup" }
	| { kind: "web" }
	| { kind: "web_stop" }
	| { kind: "unknown"; raw: string };

export function parseSlashCommand(input: string): SlashCommand | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return null;

	const parts = trimmed.split(/\s+/);
	const cmd = parts[0]!;
	const arg = parts[1];

	switch (cmd) {
		case "/help":
			return { kind: "help" };
		case "/quit":
			return { kind: "quit" };
		case "/settings":
			return { kind: "settings" };
		case "/model":
			if (!arg) {
				return { kind: "switch_model", selection: undefined };
			}
			try {
				return {
					kind: "switch_model",
					selection: parseSessionSelectionRequest(arg),
				};
			} catch (error) {
				return {
					kind: "invalid",
					raw: trimmed,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		case "/compact":
			return { kind: "compact" };
		case "/clear":
			return { kind: "clear" };
		case "/status":
			return { kind: "status" };
		case "/collapse-tools":
			return { kind: "collapse_tools" };
		case "/terminal-setup":
			return { kind: "terminal_setup" };
		case "/web":
			if (arg === "stop") return { kind: "web_stop" };
			return { kind: "web" };
		default:
			return { kind: "unknown", raw: trimmed };
	}
}
