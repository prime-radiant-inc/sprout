import { parse } from "yaml";
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
	const endIdx = content.indexOf("\n---\n", fmStart);
	const endIdxR = content.indexOf("\r\n---\r\n", fmStart);
	const actualEnd = endIdx !== -1 ? endIdx : endIdxR;
	if (actualEnd === -1) {
		throw new Error(`Invalid agent markdown at ${source}: missing closing frontmatter delimiter`);
	}

	const frontmatterStr = content.slice(fmStart, actualEnd);
	const bodyStart = content.indexOf("\n", actualEnd + 1) + 1;
	const body = content.slice(bodyStart).trim();

	const raw = parse(frontmatterStr);

	for (const field of ["name", "description", "model"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid agent markdown at ${source}: missing or invalid '${field}'`);
		}
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
		capabilities: [...tools, ...agents],
		constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
		tags: raw.tags ?? [],
		version: raw.version ?? 1,
	};
	if (raw.thinking !== undefined) {
		spec.thinking = raw.thinking;
	}
	return spec;
}
