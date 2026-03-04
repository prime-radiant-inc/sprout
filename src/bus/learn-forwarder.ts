import type { LearnSignal } from "../kernel/types.ts";
import type { LearnSink } from "../learn/learn-process.ts";
import { ulid } from "../util/ulid.ts";
import type { BusClient } from "./client.ts";
import { createSignalLearnRequest } from "./learn-contract.ts";
import { genomeMutations } from "./topics.ts";

/**
 * Lightweight LearnSink that publishes learn signals to the bus.
 * Used by bus-spawned agents instead of the full LearnProcess.
 * A future consumer on the host side will pick these up for processing.
 */
export class BusLearnForwarder implements LearnSink {
	private readonly bus: BusClient;
	private readonly topic: string;

	constructor(bus: BusClient, sessionId: string) {
		this.bus = bus;
		this.topic = genomeMutations(sessionId);
	}

	push(signal: LearnSignal): void {
		if (!this.bus.connected) return;
		const request = createSignalLearnRequest(signal, ulid());
		this.bus.publish(this.topic, JSON.stringify(request));
	}

	recordAction(_agentName: string): void {
		// No-op: action tracking is handled by the host-side LearnProcess
	}

	startBackground(): void {
		// No-op: no background processing needed for forwarding
	}

	async stopBackground(): Promise<void> {
		// No-op: nothing to drain
	}
}
