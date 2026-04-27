import { type ResolverSettings, resolveMemoryModel } from "../agents/model-resolver.ts";
import type { Memory, RelationshipType } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import { Msg, messageText, type ProviderModel } from "../llm/types.ts";
import type { Genome } from "./genome.ts";
import {
	discoverLinkCandidates,
	type LinkCandidate,
	type LinkDiscoveryOptions,
	persistMemoryLinks,
} from "./linking.ts";

export interface RelationshipClassificationRequest {
	source: Memory;
	target: Memory;
	candidate?: LinkCandidate;
	prompt: string;
	client: Client;
	model: string;
	provider: string;
	maxTokens?: number;
}

export interface RelationshipClassificationResult {
	source_id: string;
	target_id: string;
	relationship_type: RelationshipType;
	reasoning: string;
	extraction_bond?: string;
}

export interface RelationshipClassificationSettingsRequest
	extends Omit<RelationshipClassificationRequest, "model" | "provider"> {
	resolverSettings: ResolverSettings;
	modelsByProvider: Map<string, ProviderModel[]>;
}

export interface ClassifyAndPersistMemoryLinksSettingsRequest {
	genome: Genome;
	prompt: string;
	client: Client;
	resolverSettings: ResolverSettings;
	modelsByProvider: Map<string, ProviderModel[]>;
	discovery?: LinkDiscoveryOptions;
	maxTokens?: number;
	now?: number;
	source?: string;
}

export interface ClassifyAndPersistMemoryLinksResult {
	candidates: LinkCandidate[];
	relationships: RelationshipClassificationResult[];
	added: number;
}

const CLASSIFIER_RELATIONSHIP_TYPES = new Set<RelationshipType>([
	"corroborates",
	"conflicts",
	"supersedes",
	"refines",
	"precedes",
	"contextualizes",
	"exemplifies",
	"null",
]);

export async function classifyMemoryRelationship(
	request: RelationshipClassificationRequest,
): Promise<RelationshipClassificationResult> {
	const response = await request.client.complete({
		model: request.model,
		provider: request.provider,
		messages: [
			Msg.system(request.prompt),
			Msg.user(
				renderRelationshipClassificationUserPrompt(
					request.source,
					request.target,
					request.candidate,
				),
			),
		],
		temperature: 0,
		max_tokens: request.maxTokens ?? 500,
		metadata: { purpose: "memory.relationship" },
	});

	return normalizeRelationshipClassificationPayload(
		messageText(response.message),
		request.source.id,
		request.target.id,
		request.candidate?.extraction_bond,
	);
}

export async function classifyMemoryRelationshipWithSettings(
	request: RelationshipClassificationSettingsRequest,
): Promise<RelationshipClassificationResult> {
	const model = resolveMemoryModel(
		"relationship",
		request.resolverSettings,
		request.modelsByProvider,
	);
	return classifyMemoryRelationship({ ...request, model: model.model, provider: model.provider });
}

export async function classifyMemoryRelationships(
	requests: readonly RelationshipClassificationRequest[],
): Promise<RelationshipClassificationResult[]> {
	const results: RelationshipClassificationResult[] = [];
	for (const request of requests) {
		results.push(await classifyMemoryRelationship(request));
	}
	return results;
}

export async function classifyAndPersistMemoryLinksWithSettings(
	request: ClassifyAndPersistMemoryLinksSettingsRequest,
): Promise<ClassifyAndPersistMemoryLinksResult> {
	const memories = request.genome.memories.all();
	const memoriesById = new Map(memories.map((memory) => [memory.id, memory]));
	const candidates = discoverLinkCandidates(memories, request.discovery);
	const relationships: RelationshipClassificationResult[] = [];

	for (const candidate of candidates) {
		const source = memoriesById.get(candidate.source_id);
		const target = memoriesById.get(candidate.target_id);
		if (!source || !target) {
			throw new Error(
				`Cannot classify missing memories: ${candidate.source_id} -> ${candidate.target_id}`,
			);
		}
		relationships.push(
			await classifyMemoryRelationshipWithSettings({
				source,
				target,
				candidate,
				prompt: request.prompt,
				client: request.client,
				resolverSettings: request.resolverSettings,
				modelsByProvider: request.modelsByProvider,
				maxTokens: request.maxTokens,
			}),
		);
	}

	const added = await persistMemoryLinks(request.genome, relationships, {
		source: request.source ?? "memory-relationship-classifier",
		...(request.now !== undefined ? { now: request.now } : {}),
	});
	return { candidates, relationships, added };
}

export function renderRelationshipClassificationUserPrompt(
	source: Memory,
	target: Memory,
	candidate?: LinkCandidate,
): string {
	return `Classify the relationship between these two memories. Output ONLY a raw JSON object -- no markdown, no code fences, no explanation outside the JSON.

NEW MEMORY:
Text: "${escapeForPrompt(source.content)}"
Temporal: ${temporalLabel(source)}
Importance: ${importance(source).toFixed(3)}

EXISTING MEMORY:
Text: "${escapeForPrompt(target.content)}"
Temporal: ${temporalLabel(target)}
Importance: ${importance(target).toFixed(3)}

Extraction context: "${escapeForPrompt(candidate?.extraction_bond ?? "")}"
Candidate axes: ${(candidate?.axes ?? []).join(", ") || "unknown"}

Would knowing one of these memories change how you'd act on the other? If yes, pick exactly one relationship type. If no meaningful connection, use "null".

Relationship types: corroborates, conflicts, supersedes, refines, precedes, contextualizes, exemplifies, null

{"relationship_type": "<exactly one type from above>", "reasoning": "<one sentence>"}`;
}

export function normalizeRelationshipClassificationPayload(
	text: string,
	sourceId: string,
	targetId: string,
	extractionBond?: string,
): RelationshipClassificationResult {
	const parsed = parseClassifierJson(text);
	if (!isRecord(parsed)) {
		throw new Error("Relationship classifier returned non-object JSON");
	}
	const rawType = parsed.relationship_type;
	if (typeof rawType !== "string") {
		throw new Error("Relationship classifier response missing relationship_type");
	}
	const relationshipType = rawType.toLowerCase() as RelationshipType;
	if (!CLASSIFIER_RELATIONSHIP_TYPES.has(relationshipType)) {
		throw new Error(`Invalid relationship_type '${rawType}'`);
	}
	const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";
	if (!reasoning) {
		throw new Error("Relationship classifier response missing reasoning");
	}
	return {
		source_id: sourceId,
		target_id: targetId,
		relationship_type: relationshipType,
		reasoning,
		...(extractionBond ? { extraction_bond: extractionBond } : {}),
	};
}

function parseClassifierJson(text: string): unknown {
	const stripped = stripCodeFence(text.trim());
	try {
		return JSON.parse(stripped);
	} catch {
		return JSON.parse(repairJson(stripped));
	}
}

function stripCodeFence(text: string): string {
	const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	return match?.[1]?.trim() ?? text;
}

function repairJson(text: string): string {
	return text
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/,\s*([}\]])/g, "$1");
}

function temporalLabel(memory: Memory): string {
	if (memory.happens_at) return new Date(memory.happens_at).toISOString();
	return new Date(memory.created).toISOString();
}

function importance(memory: Memory): number {
	return memory.effective_importance ?? memory.importance_score ?? memory.confidence;
}

function escapeForPrompt(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
