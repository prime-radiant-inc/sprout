import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../kernel/types.ts";

/** Parse an AgentSpec from raw YAML content. The source label is used in error messages. */
export function parseAgentSpec(content: string, source: string): AgentSpec {
	const raw = parse(content);

	for (const field of ["name", "description", "system_prompt", "model"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid agent spec at ${source}: missing or invalid '${field}'`);
		}
	}

	const spec: AgentSpec = {
		name: raw.name,
		description: raw.description,
		system_prompt: raw.system_prompt,
		model: raw.model,
		capabilities: raw.capabilities ?? [],
		constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
		tags: raw.tags ?? [],
		version: raw.version ?? 1,
	};
	if (raw.thinking !== undefined) {
		spec.thinking = raw.thinking;
	}
	return spec;
}

export async function loadAgentSpec(path: string): Promise<AgentSpec> {
	const content = await readFile(path, "utf-8");
	return parseAgentSpec(content, path);
}

export async function loadBootstrapAgents(dir: string): Promise<AgentSpec[]> {
	const { specs } = await readBootstrapDir(dir);
	return specs;
}

/** Read all YAML files in a bootstrap directory once, returning parsed specs and raw content. */
export async function readBootstrapDir(
	dir: string,
): Promise<{ specs: AgentSpec[]; rawContentByName: Map<string, string> }> {
	const files = await readdir(dir);
	const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
	const specs: AgentSpec[] = [];
	const rawContentByName = new Map<string, string>();
	for (const f of yamlFiles) {
		const path = join(dir, f);
		const content = await readFile(path, "utf-8");
		const spec = parseAgentSpec(content, path);
		specs.push(spec);
		rawContentByName.set(spec.name, content);
	}
	return { specs, rawContentByName };
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
