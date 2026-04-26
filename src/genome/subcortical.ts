import type { EntityLinkEntry } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import { Msg, messageText } from "../llm/types.ts";

export interface SubcorticalEntityHint {
	name: string;
	type?: EntityLinkEntry["type"];
}

export interface SubcorticalRecallExpansion {
	expanded_query: string;
	entities: SubcorticalEntityHint[];
	pinned_memory_ids: string[];
	reasoning?: string;
}

export interface SubcorticalPrepassRequest {
	query: string;
	prompt: string;
	client: Client;
	model: string;
	provider: string;
	additionalContext?: string;
	maxTokens?: number;
}

export async function runSubcorticalPrepass(
	request: SubcorticalPrepassRequest,
): Promise<SubcorticalRecallExpansion> {
	const response = await request.client.complete({
		model: request.model,
		provider: request.provider,
		messages: [
			Msg.system(request.prompt),
			Msg.user(renderSubcorticalRecallUserPrompt(request.query, request.additionalContext)),
		],
		temperature: 0,
		max_tokens: request.maxTokens ?? 350,
	});
	return normalizeSubcorticalRecallPayload(messageText(response.message));
}

export function renderSubcorticalRecallUserPrompt(
	query: string,
	additionalContext?: string,
): string {
	return `<user_goal>
${query}
</user_goal>

<additional_context>
${additionalContext?.trim() ?? ""}
</additional_context>

Expand the goal for memory recall. Return only JSON.`;
}

export function normalizeSubcorticalRecallPayload(text: string): SubcorticalRecallExpansion {
	const parsed = parseJsonObject(text);
	const expandedQuery =
		typeof parsed.expanded_query === "string" ? parsed.expanded_query.trim() : "";
	if (!expandedQuery) throw new Error("Subcortical recall payload missing expanded_query");
	const entities = Array.isArray(parsed.entities)
		? parsed.entities
				.filter(isRecord)
				.map((entity) => ({
					name: typeof entity.name === "string" ? entity.name.trim() : "",
					...(isEntityType(entity.type) ? { type: entity.type } : {}),
				}))
				.filter((entity) => entity.name)
		: [];
	const pinnedMemoryIds = Array.isArray(parsed.pinned_memory_ids)
		? parsed.pinned_memory_ids.filter(
				(id): id is string => typeof id === "string" && id.trim().length > 0,
			)
		: [];
	const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : undefined;
	return {
		expanded_query: expandedQuery,
		entities,
		pinned_memory_ids: [...new Set(pinnedMemoryIds.map((id) => id.trim()))],
		...(reasoning ? { reasoning } : {}),
	};
}

export function expandedRecallQuery(query: string, expansion: SubcorticalRecallExpansion): string {
	const entityText = expansion.entities
		.map((entity) => (entity.type ? `${entity.type}:${entity.name}` : entity.name))
		.join("\n");
	return [query, expansion.expanded_query, entityText].filter((part) => part.trim()).join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
	const stripped = stripCodeFence(text.trim());
	const parsed = JSON.parse(repairJson(stripped));
	if (!isRecord(parsed)) throw new Error("Expected subcortical recall JSON object");
	return parsed;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntityType(value: unknown): value is EntityLinkEntry["type"] {
	return (
		value === "PROJECT" ||
		value === "LIBRARY" ||
		value === "FILE_PATH" ||
		value === "COMMAND" ||
		value === "ERROR_TYPE" ||
		value === "TECHNOLOGY" ||
		value === "PERSON"
	);
}
