import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../kernel/types.ts";

export async function loadAgentSpec(path: string): Promise<AgentSpec> {
	const content = await readFile(path, "utf-8");
	const raw = parse(content);
	return {
		name: raw.name,
		description: raw.description,
		system_prompt: raw.system_prompt,
		model: raw.model,
		capabilities: raw.capabilities ?? [],
		constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
		tags: raw.tags ?? [],
		version: raw.version ?? 1,
	};
}

export async function loadBootstrapAgents(dir: string): Promise<AgentSpec[]> {
	const files = await readdir(dir);
	const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
	return Promise.all(yamlFiles.map((f) => loadAgentSpec(join(dir, f))));
}
