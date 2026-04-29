import type { ResolverSettings } from "../agents/model-resolver.ts";
import { resolveMemoryModel } from "../agents/model-resolver.ts";
import type { Memory } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import type { ProviderModel } from "../llm/types.ts";
import type {
	AddExtractedMemoriesWithRelationshipsResult,
	Genome,
} from "./genome.ts";
import type { LinkDiscoveryOptions } from "./linking.ts";
import type { MemorySegment } from "./segments.ts";
import { classifyMemoryRelationship } from "./relationship-classifier.ts";

export interface IncorporateExtractedMemoriesInput {
	genome: Genome;
	segment?: MemorySegment;
	memories: Memory[];
	explicitReferenceIds?: readonly string[];
	client: Client;
	resolverSettings?: ResolverSettings;
	modelsByProvider?: Map<string, ProviderModel[]>;
	prompt?: string;
	discovery?: LinkDiscoveryOptions;
	commitMessage?: string;
	now?: number;
	maxTokens?: number;
}

export async function incorporateExtractedMemories(
	input: IncorporateExtractedMemoriesInput,
): Promise<AddExtractedMemoriesWithRelationshipsResult> {
	let prompt: string | undefined = input.prompt;
	let relationshipModel: { provider: string; model: string } | undefined;

	return input.genome.addExtractedMemoriesWithRelationships({
		...(input.segment ? { segment: input.segment } : {}),
		memories: input.memories,
		...(input.explicitReferenceIds ? { explicitReferenceIds: input.explicitReferenceIds } : {}),
		...(input.discovery ? { discovery: input.discovery } : {}),
		...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
		classifyRelationships: async ({ candidates, memoriesById }) => {
			if (!input.resolverSettings || !input.modelsByProvider) {
				throw new Error(
					"Memory relationship model settings are required when relationship candidates exist",
				);
			}
			relationshipModel ??= resolveMemoryModel(
				"relationship",
				input.resolverSettings,
				input.modelsByProvider,
			);
			prompt ??= await input.genome.loadRelationshipClassificationPrompt();
			const relationships = [];
			for (const candidate of candidates) {
				const source = memoriesById.get(candidate.source_id);
				const target = memoriesById.get(candidate.target_id);
				if (!source || !target) {
					throw new Error(
						`Cannot classify missing memories: ${candidate.source_id} -> ${candidate.target_id}`,
					);
				}
				relationships.push(
					await classifyMemoryRelationship({
						source,
						target,
						candidate,
						prompt,
						client: input.client,
						model: relationshipModel.model,
						provider: relationshipModel.provider,
						maxTokens: input.maxTokens,
					}),
				);
			}
			return relationships;
		},
	});
}
