import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../kernel/types.ts";
import { parseAgentMarkdown } from "./markdown-loader.ts";

/** Parse an AgentSpec from raw YAML content. The source label is used in error messages. */
function parseAgentSpec(content: string, source: string): AgentSpec {
	const raw = parse(content);

	for (const field of ["name", "description", "system_prompt", "model"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid agent spec at ${source}: missing or invalid '${field}'`);
		}
	}

	const capabilities: string[] = raw.capabilities ?? [];
	// Use explicit tools/agents fields when present; fall back to "/" heuristic for legacy YAML
	const tools: string[] = raw.tools ?? capabilities.filter((c: string) => !c.includes("/"));
	const agents: string[] = raw.agents ?? capabilities.filter((c: string) => c.includes("/"));
	const spec: AgentSpec = {
		name: raw.name,
		description: raw.description,
		system_prompt: raw.system_prompt,
		model: raw.model,
		capabilities,
		tools,
		agents,
		constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
		tags: raw.tags ?? [],
		version: raw.version ?? 1,
	};
	if (raw.thinking !== undefined) {
		spec.thinking = raw.thinking;
	}
	return spec;
}

export async function loadRootAgents(dir: string): Promise<AgentSpec[]> {
	const { specs } = await readRootDir(dir);
	return specs;
}

/** Read agent specs from a root directory, supporting both flat YAML and tree Markdown layouts. */
export async function readRootDir(
	dir: string,
): Promise<{ specs: AgentSpec[]; rawContentByName: Map<string, string> }> {
	const files = await readdir(dir);
	const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();

	// If there are YAML files, use the flat loader (legacy YAML layout)
	if (yamlFiles.length > 0) {
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

	// Otherwise, use the tree scanner (new root/ Markdown layout)
	const specs: AgentSpec[] = [];
	const rawContentByName = new Map<string, string>();

	// Load root.md if present
	const rootPath = join(dir, "root.md");
	try {
		const content = await readFile(rootPath, "utf-8");
		const spec = parseAgentMarkdown(content, rootPath);
		specs.push(spec);
		rawContentByName.set(spec.name, content);
	} catch {
		// No root.md — fine
	}

	// Scan the agent tree (rawContent is populated by scanAgentTree)
	const tree = await scanAgentTree(dir);
	for (const entry of tree.values()) {
		specs.push(entry.spec);
		if (entry.rawContent !== undefined) {
			rawContentByName.set(entry.spec.name, entry.rawContent);
		}
	}

	return { specs, rawContentByName };
}

/** Look up a tree entry by spec name (linear scan). Returns undefined if not found. */
export function findTreeEntryByName(
	tree: Map<string, AgentTreeEntry>,
	name: string,
): AgentTreeEntry | undefined {
	for (const entry of tree.values()) {
		if (entry.spec.name === name) return entry;
	}
	return undefined;
}

/**
 * Resolve the tools directory for an agent from a pre-scanned tree.
 * Falls back to the flat layout (rootDir/agentName/tools/) if the agent is not in the tree.
 */
export function resolveRootToolsDir(
	tree: Map<string, AgentTreeEntry>,
	rootDir: string,
	agentName: string,
): string {
	const entry = findTreeEntryByName(tree, agentName);
	if (entry) {
		return join(entry.diskPath.replace(/\.md$/, ""), "tools");
	}
	return join(rootDir, agentName, "tools");
}

/**
 * Find the tools directory for an agent by scanning the root directory tree.
 * Convenience wrapper that scans the tree first, then resolves.
 */
export async function findRootToolsDir(rootDir: string, agentName: string): Promise<string> {
	const tree = await scanAgentTree(rootDir);
	return resolveRootToolsDir(tree, rootDir, agentName);
}

export interface Preambles {
	global: string;
	orchestrator: string;
	worker: string;
}

export async function loadPreambles(rootDir: string): Promise<Preambles> {
	const dir = join(rootDir, "preambles");
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
	/** Raw file content, available when the entry was loaded by scanAgentTree. */
	rawContent?: string;
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

		tree.set(agentPath, { spec, path: agentPath, children, diskPath, rawContent: content });
		childNames.push(name);
		handledDirs.add(name);
	}

	// Handle namespace directories without a spec file (e.g., utility/)
	const dirs = entries.filter((e) => e.isDirectory() && !handledDirs.has(e.name));
	for (const d of dirs) {
		const nsPrefix = pathPrefix ? `${pathPrefix}/${d.name}` : d.name;
		const nsDir = join(dir, d.name);

		// Scan for .md sibling files directly in the namespace directory
		await scanLevel(nsDir, nsPrefix, tree);

		// Also recurse into <namespace>/agents/ for conventionally nested children
		await scanLevel(join(nsDir, "agents"), nsPrefix, tree);
	}

	return childNames;
}
