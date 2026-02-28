import { loadBootstrapAgents } from "../agents/loader.ts";
import { Genome } from "./genome.ts";

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
