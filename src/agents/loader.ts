import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../kernel/types.ts";
import { parseAgentMarkdown } from "./markdown-loader.ts";

/** Parse an AgentSpec from raw YAML content. The source label is used in error messages. */
export function parseAgentSpec(content: string, source: string): AgentSpec {
	const raw = parse(content);

	for (const field of ["name", "description", "system_prompt", "model"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid agent spec at ${source}: missing or invalid '${field}'`);
		}
	}

	const capabilities: string[] = raw.capabilities ?? [];
	const spec: AgentSpec = {
		name: raw.name,
		description: raw.description,
		system_prompt: raw.system_prompt,
		model: raw.model,
		capabilities,
		tools: capabilities.filter((c: string) => !c.includes("/")),
		agents: capabilities.filter((c: string) => c.includes("/")),
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

export interface AgentTreeEntry {
	spec: AgentSpec;
	path: string;
	children: string[];
	diskPath: string;
}

/**
 * Recursively scan an agent root directory, building a map of agent paths to specs.
 * Directory structure: root/agents/<name>.md, root/agents/<name>/agents/<child>.md, etc.
 */
export async function scanAgentTree(rootDir: string): Promise<Map<string, AgentTreeEntry>> {
	const tree = new Map<string, AgentTreeEntry>();
	await scanLevel(join(rootDir, "agents"), "", tree);
	return tree;
}

async function scanLevel(
	dir: string,
	pathPrefix: string,
	tree: Map<string, AgentTreeEntry>,
): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const mdFiles = entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name)
		.sort();
	const childNames: string[] = [];
	const handledDirs = new Set<string>();

	for (const file of mdFiles) {
		const name = file.replace(/\.md$/, "");
		const agentPath = pathPrefix ? `${pathPrefix}/${name}` : name;
		const diskPath = join(dir, file);
		const content = await readFile(diskPath, "utf-8");
		const spec = parseAgentMarkdown(content, diskPath);

		// Recurse into <name>/agents/ for children
		const childDir = join(dir, name, "agents");
		const children = await scanLevel(childDir, agentPath, tree);

		tree.set(agentPath, { spec, path: agentPath, children, diskPath });
		childNames.push(name);
		handledDirs.add(name);
	}

	// Handle namespace directories without a spec file (e.g., utility/)
	const dirs = entries.filter((e) => e.isDirectory() && !handledDirs.has(e.name));
	for (const d of dirs) {
		const childDir = join(dir, d.name, "agents");
		await scanLevel(childDir, pathPrefix ? `${pathPrefix}/${d.name}` : d.name, tree);
	}

	return childNames;
}
