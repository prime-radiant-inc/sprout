import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../kernel/types.ts";

export async function loadAgentSpec(path: string): Promise<AgentSpec> {
	const content = await readFile(path, "utf-8");
	const raw = parse(content);

	for (const field of ["name", "description", "system_prompt", "model"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid agent spec at ${path}: missing or invalid '${field}'`);
		}
	}

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
	const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
	return Promise.all(yamlFiles.map((f) => loadAgentSpec(join(dir, f))));
}

export interface Preambles {
	global: string;
	orchestrator: string;
	worker: string;
}

export async function loadPreambles(bootstrapDir: string): Promise<Preambles> {
	const dir = join(bootstrapDir, "preambles");
	const read = (name: string) => readFile(join(dir, name), "utf-8").catch(() => "");
	const [global, orchestrator, worker] = await Promise.all([
		read("global.md"),
		read("orchestrator.md"),
		read("worker.md"),
	]);
	return { global, orchestrator, worker };
}
