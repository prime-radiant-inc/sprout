import {
	createResolverSettings,
	type ResolvedModel,
	type ResolverSettings,
	resolveModel,
} from "../agents/model-resolver.ts";
import { filterDuplicateDrafts } from "../genome/dedup.ts";
import { extractMemoryDrafts, memoryFromDraft } from "../genome/extraction.ts";
import type { Genome } from "../genome/genome.ts";
import { EVENT_CAP } from "../kernel/constants.ts";
import {
	DEFAULT_CONSTRAINTS,
	type LearnSignal,
	type SessionEvent,
	validateAgentName,
} from "../kernel/types.ts";
import { learnSignalExtractionMessages } from "../learn/extraction-evidence.ts";
import { Client } from "../llm/client.ts";
import type { ProviderModel } from "../llm/types.ts";
import type { BusClient } from "./client.ts";
import { type LearnRequest, parseLearnRequest, resolveLearnMutation } from "./learn-contract.ts";
import { genomeEvents, genomeMutations, sessionEvents } from "./topics.ts";
import { parseBusMessage } from "./types.ts";

const DEFAULT_SIGNAL_EVIDENCE_WAIT_MS = 30_000;

/** A confirmation event published after processing a mutation request. */
export interface MutationConfirmation {
	kind: "mutation_confirmed";
	request_id: string;
	mutation_type: string;
	success: boolean;
	extracted_count?: number;
	error?: string;
}

export interface GenomeMutationServiceOptions {
	bus: BusClient;
	genome: Genome;
	sessionId: string;
	client?: Client;
	clientFactory?: () => Client;
	modelsByProvider?: Map<string, ProviderModel[]>;
	resolverSettings?: ResolverSettings;
	/** Max time to wait for queue drain during stop(). Default: 5000ms. */
	stopDrainTimeoutMs?: number;
	/** Poll interval while waiting for queue drain during stop(). Default: 10ms. */
	stopDrainPollMs?: number;
	/** Max time to wait for terminal evidence after a signal. Default: 30s. */
	signalEvidenceWaitMs?: number;
}

/**
 * Bus-connected service that serializes genome mutations.
 *
 * Subscribes to the mutations topic, processes incoming MutationRequest
 * messages one at a time (serial queue), and publishes confirmations.
 */
export class GenomeMutationService {
	private readonly bus: BusClient;
	private readonly genome: Genome;
	private readonly sessionId: string;
	private client: Client | undefined;
	private readonly clientFactory: () => Client;
	private readonly modelsByProvider: Map<string, ProviderModel[]> | undefined;
	private readonly resolverSettings: ResolverSettings | undefined;
	private readonly stopDrainTimeoutMs: number;
	private readonly stopDrainPollMs: number;
	private readonly signalEvidenceWaitMs: number;
	private readonly queue: LearnRequest[] = [];
	private readonly events: SessionEvent[] = [];
	private resolvedModel: ResolvedModel | undefined;
	private processing = false;
	private started = false;

	constructor(options: GenomeMutationServiceOptions) {
		this.bus = options.bus;
		this.genome = options.genome;
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.clientFactory = options.clientFactory ?? (() => Client.fromEnv());
		this.modelsByProvider = options.modelsByProvider;
		this.resolverSettings = options.resolverSettings;
		this.stopDrainTimeoutMs = options.stopDrainTimeoutMs ?? 5_000;
		this.stopDrainPollMs = options.stopDrainPollMs ?? 10;
		this.signalEvidenceWaitMs = options.signalEvidenceWaitMs ?? DEFAULT_SIGNAL_EVIDENCE_WAIT_MS;
	}

	/** Start subscribing to the mutations topic. */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		await this.bus.subscribe(genomeMutations(this.sessionId), (payload) => {
			const msg = parseLearnRequest(payload);
			if (!msg) return;
			this.queue.push(msg);
			this.processQueue();
		});
		await this.bus.subscribe(sessionEvents(this.sessionId), (payload) => {
			this.recordSessionEvent(payload);
		});
	}

	/** Stop processing: unsubscribe and drain the queue. */
	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;

		await this.bus.unsubscribe(genomeMutations(this.sessionId));
		await this.bus.unsubscribe(sessionEvents(this.sessionId));

		// Drain remaining items with a safety timeout
		const deadline = Date.now() + this.stopDrainTimeoutMs;
		while ((this.queue.length > 0 || this.processing) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, this.stopDrainPollMs));
		}
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		while (this.queue.length > 0) {
			const req = this.queue.shift()!;
			await this.applyMutation(req);
		}

		this.processing = false;
	}

	private async applyMutation(req: LearnRequest): Promise<void> {
		const request_id = req.request_id;
		const mutation = resolveLearnMutation(req);

		try {
			if (!mutation) {
				await this.applySignalRequest(req);
				return;
			}

			const now = Date.now();
			const random = Math.random().toString(36).slice(2, 8);

			switch (mutation.type) {
				case "create_memory": {
					await this.genome.addMemory({
						id: `learn-${now}-${random}`,
						content: mutation.content,
						tags: mutation.tags,
						source: "learn",
						created: now,
						last_used: now,
						use_count: 0,
						confidence: 0.8,
					});
					break;
				}
				case "update_agent": {
					const existing = this.genome.getAgent(mutation.agent_name);
					if (!existing) {
						throw new Error(`Cannot update agent '${mutation.agent_name}': not found`);
					}
					await this.genome.updateAgent({
						...existing,
						system_prompt: mutation.system_prompt,
					});
					break;
				}
				case "create_agent": {
					if (typeof mutation.name !== "string" || !mutation.name) {
						throw new Error("create_agent: missing or invalid 'name'");
					}
					if (typeof mutation.description !== "string" || !mutation.description) {
						throw new Error("create_agent: missing or invalid 'description'");
					}
					if (typeof mutation.system_prompt !== "string" || !mutation.system_prompt) {
						throw new Error("create_agent: missing or invalid 'system_prompt'");
					}
					if (typeof mutation.model !== "string" || !mutation.model) {
						throw new Error("create_agent: missing or invalid 'model'");
					}
					validateAgentName(mutation.name);
					const tools: string[] = Array.isArray(mutation.tools) ? mutation.tools : [];
					const agents: string[] = Array.isArray(mutation.agents) ? mutation.agents : [];
					await this.genome.addAgent({
						name: mutation.name,
						description: mutation.description,
						system_prompt: mutation.system_prompt,
						model: mutation.model,
						tools,
						agents,
						constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false },
						tags: Array.isArray(mutation.tags) ? mutation.tags : [],
						version: 1,
					});
					break;
				}
				case "create_routing_rule": {
					await this.genome.addRoutingRule({
						id: `learn-rule-${now}-${random}`,
						condition: mutation.condition,
						preference: mutation.preference,
						strength: mutation.strength,
						source: "learn",
					});
					break;
				}
			}

			await this.publishConfirmation({
				kind: "mutation_confirmed",
				request_id,
				mutation_type: mutation.type,
				success: true,
			});
		} catch (err) {
			await this.publishConfirmation({
				kind: "mutation_confirmed",
				request_id,
				mutation_type: mutation?.type ?? "learn_signal",
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async applySignalRequest(req: LearnRequest): Promise<void> {
		if (req.payload.kind !== "signal") {
			throw new Error("Expected signal learn request");
		}
		const request_id = req.request_id;
		try {
			await this.waitForTerminalSignalEvidence(req.payload.signal);
			const messages = learnSignalExtractionMessages({
				signal: req.payload.signal,
				events: this.events,
			});
			if (messages.length === 0) {
				throw new Error("No event-window evidence available for learn signal");
			}

			const model = await this.resolveModel();
			const drafts = await extractMemoryDrafts({
				client: this.getClient(),
				model: model.model,
				provider: model.provider,
				prompts: await this.genome.loadMemoryExtractionPrompts(),
				messages,
			});
			const filtered =
				drafts.length === 0
					? []
					: await filterDuplicateDrafts(drafts, this.genome.memories.all(), {
							embeddingProvider: await this.genome.memoryEmbeddingProvider(),
						});
			const now = Date.now();
			const random = Math.random().toString(36).slice(2, 8);
			const memories = filtered.map((draft, index) =>
				memoryFromDraft(draft, {
					id: `learn-${now}-${random}-${index}`,
					source: "learn:extraction",
					now,
					confidence: 0.8,
				}),
			);
			if (memories.length > 0) {
				await this.genome.addMemories(memories, `genome: extract ${memories.length} bus memories`);
			}
			await this.publishConfirmation({
				kind: "mutation_confirmed",
				request_id,
				mutation_type: "create_memory",
				success: true,
				extracted_count: memories.length,
			});
		} catch (err) {
			await this.publishConfirmation({
				kind: "mutation_confirmed",
				request_id,
				mutation_type: "learn_signal",
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private recordSessionEvent(payload: string): void {
		try {
			const msg = parseBusMessage(payload);
			if (msg.kind !== "event") return;
			this.events.push(msg.event);
			if (this.events.length > EVENT_CAP * 2) {
				this.events.splice(0, this.events.length - EVENT_CAP);
			}
		} catch {
			return;
		}
	}

	private getClient(): Client {
		if (!this.client) this.client = this.clientFactory();
		return this.client;
	}

	private async resolveModel(): Promise<ResolvedModel> {
		if (this.resolvedModel) return this.resolvedModel;
		const client = this.getClient();
		const modelMap = this.modelsByProvider ?? (await client.listModelsByProvider());
		for (const providerId of client.providers()) {
			if (!modelMap.has(providerId)) {
				modelMap.set(providerId, []);
			}
		}
		const resolverSettings =
			this.resolverSettings ??
			createResolverSettings(
				[...modelMap.keys()].map((providerId) => ({
					id: providerId,
					enabled: true,
				})),
				defaultModelTiers(client.providers(), modelMap),
			);
		this.resolvedModel = resolveModel("best", resolverSettings, modelMap);
		return this.resolvedModel;
	}

	private async waitForTerminalSignalEvidence(signal: LearnSignal): Promise<void> {
		if (this.signalEvidenceWaitMs <= 0 || this.hasSufficientSignalEvidence(signal)) return;
		const deadline = Date.now() + this.signalEvidenceWaitMs;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
			if (this.hasSufficientSignalEvidence(signal)) return;
		}
	}

	private hasSufficientSignalEvidence(signal: LearnSignal): boolean {
		const windowStart = signal.timestamp - 5 * 60 * 1000;
		return this.events.some(
			(event) =>
				event.timestamp >= windowStart &&
				((event.kind === "session_end" &&
					stringValue(event.data.session_id) === signal.session_id &&
					event.timestamp >= signal.timestamp) ||
					(event.kind === "act_end" &&
						event.timestamp >= signal.timestamp &&
						stringValue(event.data.agent_name) === signal.agent_name) ||
					(event.kind === "primitive_end" &&
						event.timestamp <= signal.timestamp &&
						stringValue(event.data.name) === signal.agent_name)),
		);
	}

	private async publishConfirmation(confirmation: MutationConfirmation): Promise<void> {
		await this.bus.publish(genomeEvents(this.sessionId), JSON.stringify(confirmation));
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function defaultModelTiers(
	providerIds: readonly string[],
	modelsByProvider: Map<string, ProviderModel[]>,
): ResolverSettings["defaults"] {
	const providerId =
		providerIds.find((id) => (modelsByProvider.get(id)?.length ?? 0) > 0) ??
		[...modelsByProvider.entries()].find(([, models]) => models.length > 0)?.[0];
	const modelId = providerId ? modelsByProvider.get(providerId)?.[0]?.id : undefined;
	if (!providerId || !modelId) return {};
	return {
		best: { providerId, modelId },
		balanced: { providerId, modelId },
		fast: { providerId, modelId },
	};
}
