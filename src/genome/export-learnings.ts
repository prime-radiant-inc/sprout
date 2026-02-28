import { access, mkdir, writeFile } from "node:fs/promises";
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
	/** Pre-serialized YAML for each agent to export, keyed by name. */
	agentYaml: Map<string, string>;
}

export async function exportLearnings(
	genomePath: string,
	bootstrapDir: string,
): Promise<ExportResult> {
	try {
		await access(join(genomePath, "agents"));
	} catch {
		throw new Error(`Genome does not exist at ${genomePath} (no agents/ directory)`);
	}

	const genome = new Genome(genomePath);
	await genome.loadFromDisk();

	const bootstrapSpecs = await loadBootstrapAgents(bootstrapDir);
	const bootstrapByName = new Map(bootstrapSpecs.map((s) => [s.name, s]));

	const evolved: EvolvedAgent[] = [];
	const genomeOnly: GenomeOnlyAgent[] = [];
	const agentYaml = new Map<string, string>();

	for (const agent of genome.allAgents()) {
		const bootstrap = bootstrapByName.get(agent.name);

		if (!bootstrap) {
			genomeOnly.push({
				name: agent.name,
				description: agent.description,
				version: agent.version,
			});
			agentYaml.set(agent.name, serializeAgentSpec(agent));
			continue;
		}

		// Only export improvements (genome evolved beyond bootstrap).
		// Lower versions (e.g. after rollback) are not learnings to propagate.
		if (agent.version > bootstrap.version) {
			evolved.push({
				name: agent.name,
				genomeVersion: agent.version,
				bootstrapVersion: bootstrap.version,
				genomePrompt: agent.system_prompt,
				bootstrapPrompt: bootstrap.system_prompt,
			});
			agentYaml.set(agent.name, serializeAgentSpec(agent));
		}
	}

	return { evolved, genomeOnly, agentYaml };
}

/**
 * Write evolved and genome-only agent specs as YAML to a staging directory.
 * Creates the directory if it doesn't exist.
 */
export async function stageLearnings(result: ExportResult, stagingDir: string): Promise<string[]> {
	await mkdir(stagingDir, { recursive: true });

	const written: string[] = [];

	for (const name of result.agentYaml.keys()) {
		const filePath = join(stagingDir, `${name}.yaml`);
		await writeFile(filePath, result.agentYaml.get(name)!, "utf-8");
		written.push(filePath);
	}

	return written;
}
