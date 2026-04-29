import type { ResolverSettings } from "../agents/model-resolver.ts";
import {
	buildObserverFrame,
	type ObserverAttachmentConfig,
	renderObserverFrame,
} from "../agents/observers.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import { type AgentAddress, rootAgentAddress } from "../bus/types.ts";
import type { EventKind, SessionEvent } from "../kernel/types.ts";

export const METACOGNITIVE_OBSERVER: ObserverAttachmentConfig = {
	agentName: "metacognitive",
	target: "root",
	events: [
		"perceive",
		"steering",
		"plan_end",
		"warning",
		"error",
		"primitive_end",
		"act_end",
		"compaction",
		"interrupted",
	],
	trigger: { every: 3, event: "plan_end" },
	maxEvents: 24,
	maxChars: 6000,
	handleId: "observer-metacognitive",
	agentId: "observer-metacognitive",
	description: "observes root turns",
};

const PRECONFIGURE_EVENT_LIMIT = 64;

interface ObserverSubscriptionState {
	config: ObserverAttachmentConfig;
	includeKinds: Set<EventKind>;
	pendingEvents: SessionEvent[];
	triggerCount: number;
	observerStarted: boolean;
	observerCompleted: boolean;
	deliveryInFlight: boolean;
	flushRequested: boolean;
	completionRequested: boolean;
}

export interface ObserverRegistryOptions {
	sessionId: string;
	rootAgentName: string;
	spawner: AgentSpawner;
	genomePath: string;
	workDir: string;
	projectDataDir?: string;
	rootDir?: string;
	evalMode?: boolean;
	config?: ObserverAttachmentConfig;
	configs?: ObserverAttachmentConfig[];
	getResolverSettings?: () => ResolverSettings | undefined;
	emitEvent: (
		kind: EventKind,
		agentId: string,
		depth: number,
		data: Record<string, unknown>,
	) => void;
}

export class ObserverRegistry {
	private sessionId: string;
	private readonly spawner: AgentSpawner;
	private readonly genomePath: string;
	private readonly workDir: string;
	private readonly projectDataDir?: string;
	private readonly rootDir?: string;
	private readonly evalMode?: boolean;
	private readonly rootCaller: AgentAddress;
	private subscriptions: ObserverSubscriptionState[];
	private readonly getResolverSettings?: () => ResolverSettings | undefined;
	private readonly emitEvent: ObserverRegistryOptions["emitEvent"];
	private preconfigureEvents: SessionEvent[] = [];
	private startedHandles = new Set<string>();
	private generation = 0;

	constructor(options: ObserverRegistryOptions) {
		this.sessionId = options.sessionId;
		this.spawner = options.spawner;
		this.genomePath = options.genomePath;
		this.workDir = options.workDir;
		this.projectDataDir = options.projectDataDir;
		this.rootDir = options.rootDir;
		this.evalMode = options.evalMode;
		this.rootCaller = rootAgentAddress(options.rootAgentName);
		const configs = options.configs ?? (options.config ? [options.config] : []);
		this.subscriptions = configs.map(createSubscriptionState);
		this.getResolverSettings = options.getResolverSettings;
		this.emitEvent = options.emitEvent;
	}

	configure(configs: ObserverAttachmentConfig[]): void {
		this.subscriptions = configs.map(createSubscriptionState);
		if (this.subscriptions.length === 0) return;
		const bufferedEvents = this.preconfigureEvents;
		this.preconfigureEvents = [];
		for (const event of bufferedEvents) {
			this.handleEvent(event);
		}
	}

	handleEvent(event: SessionEvent): void {
		if (isObserverTelemetryEvent(event)) return;
		if (this.subscriptions.length === 0) {
			this.preconfigureEvents.push(event);
			if (this.preconfigureEvents.length > PRECONFIGURE_EVENT_LIMIT) {
				this.preconfigureEvents = this.preconfigureEvents.slice(-PRECONFIGURE_EVENT_LIMIT);
			}
			return;
		}
		for (const subscription of this.subscriptions) {
			if (!subscription.includeKinds.has(event.kind)) continue;
			subscription.pendingEvents.push(event);
			this.trimPendingEvents(subscription);

			if (!this.shouldTrigger(subscription, event)) continue;
			subscription.triggerCount++;
			if (subscription.triggerCount % subscription.config.trigger.every !== 0) continue;
			void this.flush(subscription);
		}
		if (event.kind === "session_end" && event.depth === 0) {
			for (const subscription of this.subscriptions) {
				subscription.completionRequested = true;
				this.completeObserverIfReady(subscription, { success: true });
			}
		}
	}

	reset(sessionId: string): void {
		this.sessionId = sessionId;
		for (const subscription of this.subscriptions) {
			subscription.pendingEvents = [];
			subscription.triggerCount = 0;
			subscription.observerStarted = false;
			subscription.observerCompleted = false;
			subscription.deliveryInFlight = false;
			subscription.flushRequested = false;
			subscription.completionRequested = false;
		}
		this.startedHandles.clear();
		this.generation++;
		this.preconfigureEvents = [];
	}

	private shouldTrigger(subscription: ObserverSubscriptionState, event: SessionEvent): boolean {
		if (event.kind !== subscription.config.trigger.event) return false;
		if (subscription.config.target === "root" && event.depth !== 0) return false;
		return true;
	}

	private async flush(subscription: ObserverSubscriptionState): Promise<void> {
		if (subscription.deliveryInFlight) {
			subscription.flushRequested = true;
			return;
		}
		if (subscription.pendingEvents.length === 0) return;

		const resolverSettings = this.getResolverSettings?.();

		const generation = this.generation;
		const events = subscription.pendingEvents;
		subscription.pendingEvents = [];
		subscription.deliveryInFlight = true;
		let deliveryFailed = false;
		try {
			const frame = buildObserverFrame({
				sessionId: this.sessionId,
				events,
				includeKinds: subscription.config.events,
				maxEvents: subscription.config.maxEvents,
				maxChars: subscription.config.maxChars,
			});
			if (frame.events.length === 0) return;

			const message = renderObserverFrame(frame);
			await this.deliverFrame(subscription, message, resolverSettings);
		} catch (error) {
			if (this.generation === generation) {
				deliveryFailed = true;
				subscription.pendingEvents = [...events, ...subscription.pendingEvents];
				this.trimPendingEvents(subscription);
				this.emitEvent("warning", "session", 0, {
					message: `Observer '${subscription.config.agentName}' delivery failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
			}
		} finally {
			if (this.generation === generation) {
				subscription.deliveryInFlight = false;
				if (!deliveryFailed && subscription.flushRequested) {
					subscription.flushRequested = false;
					void this.flush(subscription);
				} else if (subscription.completionRequested) {
					this.completeObserverIfReady(subscription, { success: !deliveryFailed });
				}
			}
		}
	}

	private async deliverFrame(
		subscription: ObserverSubscriptionState,
		message: string,
		resolverSettings: ResolverSettings | undefined,
	): Promise<void> {
		const handleId = this.observerHandleId(subscription.config);
		if (!this.startedHandles.has(handleId)) {
			this.emitObserverStart(subscription);
			this.startedHandles.add(handleId);
			subscription.observerStarted = true;
		}

		await this.spawner.deliverObserverFrame({
			agentName: subscription.config.agentName,
			message,
			genomePath: this.genomePath,
			workDir: this.workDir,
			projectDataDir: this.projectDataDir,
			rootDir: this.rootDir,
			caller: this.rootCaller,
			handleId,
			agentId: this.observerAgentId(subscription.config),
			evalMode: this.evalMode,
			resolverSettings,
			surfacedMemoryBlock: "",
		});
	}

	private emitObserverStart(subscription: ObserverSubscriptionState): void {
		this.emitEvent("act_start", "root", 0, {
			agent_name: subscription.config.agentName,
			child_id: this.observerAgentId(subscription.config),
			handle_id: this.observerHandleId(subscription.config),
			description: subscription.config.description ?? `observes ${subscription.config.target}`,
			owner_handle_id: this.rootCaller.handleId,
			owner_agent_id: this.rootCaller.agentId,
			observed_target: subscription.config.target,
			observer: true,
		});
	}

	private completeObserverIfReady(
		subscription: ObserverSubscriptionState,
		result: { success: boolean; error?: string },
	): void {
		if (!subscription.observerStarted || subscription.observerCompleted) return;
		if (subscription.deliveryInFlight) return;
		subscription.observerCompleted = true;
		this.emitEvent("act_end", "root", 0, {
			agent_name: subscription.config.agentName,
			child_id: this.observerAgentId(subscription.config),
			handle_id: this.observerHandleId(subscription.config),
			description: subscription.config.description ?? `observes ${subscription.config.target}`,
			owner_handle_id: this.rootCaller.handleId,
			owner_agent_id: this.rootCaller.agentId,
			observed_target: subscription.config.target,
			observer: true,
			success: result.success,
			timed_out: false,
			output: "",
			...(result.error ? { error: result.error } : {}),
		});
	}

	private trimPendingEvents(subscription: ObserverSubscriptionState): void {
		const maxPendingEvents = subscription.config.maxEvents * 4;
		if (subscription.pendingEvents.length > maxPendingEvents) {
			subscription.pendingEvents = subscription.pendingEvents.slice(-maxPendingEvents);
		}
	}

	private observerHandleId(config: ObserverAttachmentConfig): string {
		return config.handleId ?? `observer-${config.agentName}`;
	}

	private observerAgentId(config: ObserverAttachmentConfig): string {
		return config.agentId ?? this.observerHandleId(config);
	}
}

function createSubscriptionState(config: ObserverAttachmentConfig): ObserverSubscriptionState {
	return {
		config,
		includeKinds: new Set(config.events),
		pendingEvents: [],
		triggerCount: 0,
		observerStarted: false,
		observerCompleted: false,
		deliveryInFlight: false,
		flushRequested: false,
		completionRequested: false,
	};
}

function isObserverTelemetryEvent(event: SessionEvent): boolean {
	const data = event.data;
	if (data.observer === true) return true;
	if (event.agent_id.startsWith("observer-")) return true;
	if (event.kind === "agent_message") {
		return isObserverAddress(data.from) || isObserverAddress(data.to);
	}
	return false;
}

function isObserverAddress(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (value as { role?: unknown }).role === "observer";
}
