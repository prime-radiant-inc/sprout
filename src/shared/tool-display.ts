const TOOL_DISPLAY_NAMES: Record<string, string> = {
	read_file: "Read",
	write_file: "Write",
	edit_file: "Edit",
	apply_patch: "Patch",
	exec: "Run",
	grep: "Search",
	glob: "Find",
	fetch: "Fetch",
	save_tool: "Save Tool",
	save_file: "Save File",
	save_agent: "Save Agent",
	delegate: "Delegate",
	wait_agent: "Wait",
	message_agent: "Message",
};

const ACRONYMS = new Set([
	"api",
	"cli",
	"cpu",
	"csv",
	"html",
	"http",
	"https",
	"id",
	"io",
	"ios",
	"json",
	"llm",
	"pdf",
	"sql",
	"ssh",
	"ts",
	"tsx",
	"tui",
	"ui",
	"url",
	"xml",
	"yaml",
	"yml",
]);

function basename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	if (!trimmed) return path;
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] ?? path;
}

function humanizeWord(word: string): string {
	if (!word) return word;
	const lower = word.toLowerCase();
	if (ACRONYMS.has(lower)) return lower.toUpperCase();
	if (/^\d+$/.test(word)) return word;
	return `${lower[0]!.toUpperCase()}${lower.slice(1)}`;
}

function humanizeToolName(name: string): string {
	return name
		.split(/[-_]+/)
		.filter((part) => part.length > 0)
		.map(humanizeWord)
		.join(" ");
}

function formatPathRange(path: string, offset: unknown, limit: unknown): string {
	const fileName = basename(path);
	const offsetLabel = typeof offset === "number" ? String(offset) : "";
	const limitLabel = typeof limit === "number" ? `+${limit}` : "";
	if (!offsetLabel && !limitLabel) return fileName;
	return `${fileName}:${offsetLabel}${limitLabel}`;
}

function shortArgValue(value: unknown): string | null {
	if (typeof value === "string") {
		return value.length <= 40 ? value : null;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value) || (value && typeof value === "object")) {
		const text = JSON.stringify(value);
		return text.length <= 40 ? text : null;
	}
	return null;
}

export function getToolDisplayName(name: string, explicitDisplayName?: string): string {
	if (explicitDisplayName && explicitDisplayName.trim().length > 0) {
		return explicitDisplayName.trim();
	}
	return TOOL_DISPLAY_NAMES[name] ?? humanizeToolName(name);
}

export function getToolPathDetail(args: Record<string, unknown> | undefined): string | null {
	const path = args?.path;
	if (typeof path !== "string") return null;
	return path === basename(path) ? null : path;
}

export function formatToolKeyArg(name: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";

	switch (name) {
		case "exec": {
			const command = args.command;
			return typeof command === "string" ? `\`${command}\`` : "";
		}

		case "read_file": {
			const path = args.path;
			if (typeof path !== "string") return "";
			return formatPathRange(path, args.offset, args.limit);
		}

		case "write_file":
		case "edit_file": {
			const path = args.path;
			return typeof path === "string" ? basename(path) : "";
		}

		case "grep": {
			const pattern = args.pattern;
			if (typeof pattern !== "string") return "";
			const path = args.path;
			return typeof path === "string" ? `\`${pattern}\` ${path}` : `\`${pattern}\``;
		}

		case "glob": {
			const pattern = args.pattern;
			return typeof pattern === "string" ? `\`${pattern}\`` : "";
		}

		case "fetch": {
			const url = args.url;
			return typeof url === "string" ? url : "";
		}

		case "save_tool":
		case "save_file": {
			const toolName = args.name;
			return typeof toolName === "string" ? toolName : "";
		}
	}

	if (typeof args.path === "string") {
		return basename(args.path);
	}
	if (typeof args.name === "string") {
		return args.name;
	}
	if (typeof args.agent_name === "string") {
		return args.agent_name;
	}
	if (typeof args.handle === "string") {
		return args.handle;
	}

	for (const [key, value] of Object.entries(args)) {
		const text = shortArgValue(value);
		if (!text) continue;
		return key === "args" ? text : `${key}=${text}`;
	}

	return "";
}
