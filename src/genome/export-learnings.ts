import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRootAgents } from "../agents/loader.ts";
import { serializeAgentMarkdown } from "../agents/markdown-loader.ts";
import { Genome } from "./genome.ts";

export interface EvolvedAgent {
	name: string;
	genomeVersion: number;
	rootVersion: number;
	genomePrompt: string;
	rootPrompt: string;
}

export interface GenomeOnlyAgent {
	name: string;
	description: string;
	version: number;
}

export interface ExportResult {
	evolved: EvolvedAgent[];
	genomeOnly: GenomeOnlyAgent[];
	/** Pre-serialized markdown for each agent to export, keyed by name. */
	agentContent: Map<string, string>;
}

export async function exportLearnings(genomePath: string, rootDir: string): Promise<ExportResult> {
	try {
		await access(join(genomePath, "agents"));
	} catch {
		throw new Error(`Genome does not exist at ${genomePath} (no agents/ directory)`);
	}

	const genome = new Genome(genomePath);
	await genome.loadFromDisk();

	const rootSpecs = await loadRootAgents(rootDir);
	const rootByName = new Map(rootSpecs.map((s) => [s.name, s]));

	const evolved: EvolvedAgent[] = [];
	const genomeOnly: GenomeOnlyAgent[] = [];
	const agentContent = new Map<string, string>();

	for (const agent of genome.allAgents()) {
		const rootSpec = rootByName.get(agent.name);

		if (!rootSpec) {
			genomeOnly.push({
				name: agent.name,
				description: agent.description,
				version: agent.version,
			});
			agentContent.set(agent.name, serializeAgentMarkdown(agent));
			continue;
		}

		// Only export improvements (genome evolved beyond root).
		// Lower versions (e.g. after rollback) are not learnings to propagate.
		if (agent.version > rootSpec.version) {
			evolved.push({
				name: agent.name,
				genomeVersion: agent.version,
				rootVersion: rootSpec.version,
				genomePrompt: agent.system_prompt,
				rootPrompt: rootSpec.system_prompt,
			});
			agentContent.set(agent.name, serializeAgentMarkdown(agent));
		}
	}

	return { evolved, genomeOnly, agentContent };
}

/**
 * Write evolved and genome-only agent specs as markdown to a staging directory.
 * Creates the directory if it doesn't exist.
 */
export async function stageLearnings(result: ExportResult, stagingDir: string): Promise<string[]> {
	await mkdir(stagingDir, { recursive: true });

	const written: string[] = [];

	for (const name of result.agentContent.keys()) {
		const filePath = join(stagingDir, `${name}.md`);
		await writeFile(filePath, result.agentContent.get(name)!, "utf-8");
		written.push(filePath);
	}

	return written;
}
