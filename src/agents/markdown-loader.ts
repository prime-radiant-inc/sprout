import { parse, stringify } from "yaml";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../kernel/types.ts";

/**
 * Parse an agent spec from a YAML-fronted Markdown file.
 * Frontmatter provides structured fields; the markdown body becomes system_prompt.
 */
export function parseAgentMarkdown(content: string, source: string): AgentSpec {
	const crlf = content.startsWith("---\r\n");
	const lf = content.startsWith("---\n");
	if (!lf && !crlf) {
		throw new Error(`Invalid agent markdown at ${source}: missing frontmatter delimiter`);
	}

	const fmStart = crlf ? 5 : 4;
	const endDelimiter = crlf ? "\r\n---\r\n" : "\n---\n";
	const actualEnd = content.indexOf(endDelimiter, fmStart);
	if (actualEnd === -1) {
		throw new Error(`Invalid agent markdown at ${source}: missing closing frontmatter delimiter`);
	}

	const frontmatterStr = content.slice(fmStart, actualEnd);
	const bodyStart = actualEnd + endDelimiter.length;
	const body = content.slice(bodyStart).trim();

	const raw = parse(frontmatterStr);

	for (const field of ["name", "description", "model"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid agent markdown at ${source}: missing or invalid '${field}'`);
		}
	}

	if (raw.tools != null && !Array.isArray(raw.tools)) {
		throw new Error(`Invalid agent markdown at ${source}: 'tools' must be an array`);
	}
	if (raw.agents != null && !Array.isArray(raw.agents)) {
		throw new Error(`Invalid agent markdown at ${source}: 'agents' must be an array`);
	}
	const tools: string[] = raw.tools ?? [];
	const agents: string[] = raw.agents ?? [];

	const spec: AgentSpec = {
		name: raw.name,
		description: raw.description,
		system_prompt: body,
		model: raw.model,
		tools,
		agents,
		constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
		tags: raw.tags ?? [],
		version: raw.version ?? 1,
	};
	if (raw.thinking !== undefined) {
		spec.thinking = raw.thinking;
	}

	const extra: Record<string, unknown> = {};
	for (const key of Object.keys(raw)) {
		if (!KNOWN_FIELDS.has(key)) {
			extra[key] = raw[key];
		}
	}
	if (Object.keys(extra).length > 0) {
		spec._extra = extra;
	}

	return spec;
}

const KNOWN_FIELDS = new Set([
	"name",
	"description",
	"model",
	"tools",
	"agents",
	"constraints",
	"tags",
	"version",
	"thinking",
	"system_prompt",
]);

/**
 * Serialize an AgentSpec to YAML-fronted Markdown.
 * Known fields go into frontmatter; system_prompt becomes the markdown body.
 * Unknown fields stored in _extra are merged into frontmatter to survive round-trips.
 */
export function serializeAgentMarkdown(spec: AgentSpec): string {
	const fm: Record<string, unknown> = {
		name: spec.name,
		description: spec.description,
		model: spec.model,
		tools: spec.tools,
		agents: spec.agents,
		constraints: spec.constraints,
		tags: spec.tags,
		version: spec.version,
	};
	if (spec.thinking !== undefined) {
		fm.thinking = spec.thinking;
	}
	if (spec._extra) {
		for (const [key, value] of Object.entries(spec._extra)) {
			if (!KNOWN_FIELDS.has(key)) {
				fm[key] = value;
			}
		}
	}
	const yamlStr = stringify(fm);
	return `---\n${yamlStr}---\n${spec.system_prompt}\n`;
}
