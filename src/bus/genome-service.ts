import type { Genome } from "../genome/genome.ts";
import { DEFAULT_CONSTRAINTS } from "../kernel/types.ts";
import type { LearnMutation } from "../learn/learn-process.ts";
import type { BusClient } from "./client.ts";
import { genomeEvents, genomeMutations } from "./topics.ts";

/** Tool primitives that form the kernel's interface -- cannot be shadowed by Learn. */
const KERNEL_PRIMITIVE_NAMES = new Set([
	"read_file",
	"write_file",
	"edit_file",
	"apply_patch",
	"exec",
	"grep",
	"glob",
	"fetch",
]);

/** Core loop phases and the learn process itself -- reserved by the kernel. */
const KERNEL_RESERVED_NAMES = new Set([
	"learn",
	"kernel",
	"perceive",
	"recall",
	"plan",
	"act",
	"verify",
]);

function validateAgentName(name: string): void {
	if (KERNEL_PRIMITIVE_NAMES.has(name)) {
		throw new Error(
			`Cannot create agent '${name}': name is a kernel primitive and cannot be shadowed`,
		);
	}
	if (KERNEL_RESERVED_NAMES.has(name)) {
		throw new Error(`Cannot create agent '${name}': name is reserved by the kernel`);
	}
}

/** A request to mutate the genome, published on the mutations topic. */
export interface MutationRequest {
	kind: "mutation_request";
	mutation: LearnMutation;
	request_id: string;
}

/** A confirmation event published after processing a mutation request. */
export interface MutationConfirmation {
	kind: "mutation_confirmed";
	request_id: string;
	mutation_type: string;
	success: boolean;
	error?: string;
}

export interface GenomeMutationServiceOptions {
	bus: BusClient;
	genome: Genome;
	sessionId: string;
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
	private readonly queue: MutationRequest[] = [];
	private processing = false;
	private started = false;

	constructor(options: GenomeMutationServiceOptions) {
		this.bus = options.bus;
		this.genome = options.genome;
		this.sessionId = options.sessionId;
	}

	/** Start subscribing to the mutations topic. */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		await this.bus.subscribe(genomeMutations(this.sessionId), (payload) => {
			try {
				const msg = JSON.parse(payload) as MutationRequest;
				if (msg.kind !== "mutation_request") return;
				this.queue.push(msg);
				this.processQueue();
			} catch {
				// Ignore malformed messages
			}
		});
	}

	/** Stop processing: unsubscribe and drain the queue. */
	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;

		await this.bus.unsubscribe(genomeMutations(this.sessionId));

		// Drain remaining items with a safety timeout
		const deadline = Date.now() + 5_000;
		while ((this.queue.length > 0 || this.processing) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
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

	private async applyMutation(req: MutationRequest): Promise<void> {
		const { mutation, request_id } = req;

		try {
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
					validateAgentName(mutation.name);
					await this.genome.addAgent({
						name: mutation.name,
						description: mutation.description,
						system_prompt: mutation.system_prompt,
						model: mutation.model,
						capabilities: mutation.capabilities,
						constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false },
						tags: mutation.tags,
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
				mutation_type: mutation.type,
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async publishConfirmation(confirmation: MutationConfirmation): Promise<void> {
		await this.bus.publish(genomeEvents(this.sessionId), JSON.stringify(confirmation));
	}
}
