export type SlashCommand =
	| { kind: "help" }
	| { kind: "quit" }
	| { kind: "switch_model"; model: string | undefined }
	| { kind: "compact" }
	| { kind: "clear" }
	| { kind: "status" }
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
		case "/model":
			return { kind: "switch_model", model: arg };
		case "/compact":
			return { kind: "compact" };
		case "/clear":
			return { kind: "clear" };
		case "/status":
			return { kind: "status" };
		default:
			return { kind: "unknown", raw: trimmed };
	}
}
