import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBootstrapAgents } from "../agents/loader.ts";
import { Genome, serializeAgentSpec } from "./genome.ts";

export interface EvolvedAgent {
	name: string;
	genomeVersion: number;
	bootstrapVersion: number;
	genomePrompt: string;
	bootstrapPrompt: string;
}

export interface GenomeOnlyAgent {
	name: string;
	description: string;
	version: number;
}

export interface ExportResult {
	evolved: EvolvedAgent[];
	genomeOnly: GenomeOnlyAgent[];
}

export async function exportLearnings(
	genomePath: string,
	bootstrapDir: string,
): Promise<ExportResult> {
	const genome = new Genome(genomePath);
	await genome.loadFromDisk();

	const bootstrapSpecs = await loadBootstrapAgents(bootstrapDir);
	const bootstrapByName = new Map(bootstrapSpecs.map((s) => [s.name, s]));

	const evolved: EvolvedAgent[] = [];
	const genomeOnly: GenomeOnlyAgent[] = [];

	for (const agent of genome.allAgents()) {
		const bootstrap = bootstrapByName.get(agent.name);

		if (!bootstrap) {
			genomeOnly.push({
				name: agent.name,
				description: agent.description,
				version: agent.version,
			});
			continue;
		}

		if (agent.version > bootstrap.version) {
			evolved.push({
				name: agent.name,
				genomeVersion: agent.version,
				bootstrapVersion: bootstrap.version,
				genomePrompt: agent.system_prompt,
				bootstrapPrompt: bootstrap.system_prompt,
			});
		}
	}

	return { evolved, genomeOnly };
}

/**
 * Write evolved and genome-only agent specs as YAML to a staging directory.
 * Creates the directory if it doesn't exist.
 */
export async function stageLearnings(
	genomePath: string,
	result: ExportResult,
	stagingDir: string,
): Promise<string[]> {
	const genome = new Genome(genomePath);
	await genome.loadFromDisk();

	await mkdir(stagingDir, { recursive: true });

	const written: string[] = [];

	for (const evolved of result.evolved) {
		const agent = genome.getAgent(evolved.name);
		if (!agent) continue;
		const filePath = join(stagingDir, `${agent.name}.yaml`);
		await writeFile(filePath, serializeAgentSpec(agent), "utf-8");
		written.push(filePath);
	}

	for (const learned of result.genomeOnly) {
		const agent = genome.getAgent(learned.name);
		if (!agent) continue;
		const filePath = join(stagingDir, `${agent.name}.yaml`);
		await writeFile(filePath, serializeAgentSpec(agent), "utf-8");
		written.push(filePath);
	}

	return written;
}
