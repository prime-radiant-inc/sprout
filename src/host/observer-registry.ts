import type { ResolverSettings } from "../agents/model-resolver.ts";
import {
	buildObserverFrame,
	type ObserverAttachmentConfig,
	renderObserverFrame,
} from "../agents/observers.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import type { CallerIdentity } from "../bus/types.ts";
import type { EventKind, SessionEvent } from "../kernel/types.ts";

export const METACOGNITIVE_OBSERVER: ObserverAttachmentConfig = {
	agentName: "metacognitive",
	target: "root",
	events: ["plan_end", "warning", "error", "primitive_end", "act_end", "compaction", "interrupted"],
	trigger: { every: 3, event: "plan_end" },
	maxEvents: 24,
	maxChars: 6000,
	handleId: "observer-metacognitive",
	agentId: "observer-metacognitive",
	modelPurpose: "observer.metacognitive",
	description: "observes root turns",
};

const ROOT_CALLER: CallerIdentity = { agent_name: "root", depth: 0 };
const PRECONFIGURE_EVENT_LIMIT = 64;

interface ObserverSubscriptionState {
	config: ObserverAttachmentConfig;
	includeKinds: Set<EventKind>;
	pendingEvents: SessionEvent[];
	childEventsByAgentId: Map<string, SessionEvent[]>;
	triggerCount: number;
	observerStarted: boolean;
	deliveryInFlight: boolean;
	flushRequested: boolean;
	queuedDeliveries: Array<{ events: SessionEvent[] }>;
	warningEmitted: boolean;
}

export interface ObserverRegistryOptions {
	sessionId: string;
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
			if (subscription.config.target === "caller_delegates" && event.depth > 0) {
				const childEvents = subscription.childEventsByAgentId.get(event.agent_id) ?? [];
				childEvents.push(event);
				subscription.childEventsByAgentId.set(event.agent_id, childEvents);
			}
			this.trimPendingEvents(subscription);

			if (!this.shouldTrigger(subscription, event)) continue;
			subscription.triggerCount++;
			if (subscription.triggerCount % subscription.config.trigger.every !== 0) continue;
			void this.flush(subscription, event);
		}
	}

	reset(sessionId: string): void {
		this.sessionId = sessionId;
		for (const subscription of this.subscriptions) {
			subscription.pendingEvents = [];
			subscription.childEventsByAgentId.clear();
			subscription.triggerCount = 0;
			subscription.observerStarted = false;
			subscription.deliveryInFlight = false;
			subscription.flushRequested = false;
			subscription.queuedDeliveries = [];
			subscription.warningEmitted = false;
		}
		this.startedHandles.clear();
		this.generation++;
		this.preconfigureEvents = [];
	}

	private shouldTrigger(subscription: ObserverSubscriptionState, event: SessionEvent): boolean {
		if (event.kind !== subscription.config.trigger.event) return false;
		if (subscription.config.target === "root" && event.depth !== 0) return false;
		if (subscription.config.target === "caller_delegates") {
			return this.isObservedDelegateFinal(subscription.config, event);
		}
		return true;
	}

	private async flush(
		subscription: ObserverSubscriptionState,
		triggerEvent?: SessionEvent,
		preselectedEvents?: SessionEvent[],
	): Promise<void> {
		if (subscription.deliveryInFlight) {
			if (triggerEvent) {
				const delivery = this.takeEventsForDelivery(subscription, triggerEvent);
				subscription.pendingEvents = delivery.retainedEvents;
				subscription.queuedDeliveries.push({ events: delivery.events });
				return;
			}
			subscription.flushRequested = true;
			return;
		}
		if (!preselectedEvents && subscription.pendingEvents.length === 0) return;

		const resolverSettings = this.getResolverSettings?.();
		if (
			subscription.config.modelPurpose &&
			!resolverSettings?.agentModels[subscription.config.modelPurpose]
		) {
			this.emitMissingModelWarning(subscription);
			return;
		}

		const generation = this.generation;
		let events = preselectedEvents;
		if (!events) {
			const delivery = this.takeEventsForDelivery(subscription, triggerEvent);
			events = delivery.events;
			subscription.pendingEvents = delivery.retainedEvents;
		}
		subscription.deliveryInFlight = true;
		try {
			const frame = buildObserverFrame({
				sessionId: this.sessionId,
				events,
				includeKinds: subscription.config.events,
				maxEvents: subscription.config.maxEvents,
				maxChars: subscription.config.maxChars,
				commentPolicy: subscription.config.comments,
			});
			if (frame.events.length === 0) return;

			const message = renderObserverFrame(frame, subscription.config.comments);
			await this.deliverFrame(subscription, message, resolverSettings);
		} catch (error) {
			if (this.generation === generation) {
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
				const queuedDelivery = subscription.queuedDeliveries.shift();
				if (queuedDelivery) {
					void this.flush(subscription, undefined, queuedDelivery.events);
				} else if (subscription.flushRequested) {
					subscription.flushRequested = false;
					void this.flush(subscription);
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
			const result = await this.spawner.spawnAgent({
				agentName: subscription.config.agentName,
				goal: message,
				genomePath: this.genomePath,
				workDir: this.workDir,
				projectDataDir: this.projectDataDir,
				rootDir: this.rootDir,
				caller: ROOT_CALLER,
				shared: true,
				blocking: false,
				handleId,
				agentId: this.observerAgentId(subscription.config),
				evalMode: this.evalMode,
				resolverSettings,
				surfacedMemoryBlock: "",
			});
			if (typeof result !== "string") {
				throw new Error(`Observer '${subscription.config.agentName}' did not return a handle id`);
			}
			this.startedHandles.add(handleId);
			subscription.observerStarted = true;
			return;
		}

		subscription.observerStarted = true;
		await this.spawner.messageAgent(handleId, message, ROOT_CALLER, false);
	}

	private emitObserverStart(subscription: ObserverSubscriptionState): void {
		this.emitEvent("act_start", "root", 0, {
			agent_name: subscription.config.agentName,
			child_id: this.observerAgentId(subscription.config),
			handle_id: this.observerHandleId(subscription.config),
			description: subscription.config.description ?? `observes ${subscription.config.target}`,
			observer: true,
		});
	}

	private emitMissingModelWarning(subscription: ObserverSubscriptionState): void {
		if (subscription.warningEmitted) return;
		subscription.warningEmitted = true;
		this.emitEvent("warning", "session", 0, {
			message: `Observer '${subscription.config.agentName}' is not running because agent model '${subscription.config.modelPurpose}' is not configured.`,
		});
	}

	private trimPendingEvents(subscription: ObserverSubscriptionState): void {
		const maxPendingEvents = subscription.config.maxEvents * 4;
		if (subscription.pendingEvents.length > maxPendingEvents) {
			subscription.pendingEvents = subscription.pendingEvents.slice(-maxPendingEvents);
		}
		if (subscription.config.target !== "caller_delegates") return;
		for (const [agentId, events] of subscription.childEventsByAgentId) {
			if (events.length > maxPendingEvents) {
				subscription.childEventsByAgentId.set(agentId, events.slice(-maxPendingEvents));
			}
		}
	}

	private observerHandleId(config: ObserverAttachmentConfig): string {
		return config.handleId ?? `observer-${config.agentName}`;
	}

	private observerAgentId(config: ObserverAttachmentConfig): string {
		return config.agentId ?? this.observerHandleId(config);
	}

	private takeEventsForDelivery(
		subscription: ObserverSubscriptionState,
		triggerEvent: SessionEvent | undefined,
	): { events: SessionEvent[]; retainedEvents: SessionEvent[] } {
		if (subscription.config.target !== "caller_delegates" || !triggerEvent) {
			return { events: subscription.pendingEvents, retainedEvents: [] };
		}
		const childId = stringData(triggerEvent, "child_id");
		const events: SessionEvent[] = [];
		if (childId) {
			events.push(...(subscription.childEventsByAgentId.get(childId) ?? []));
			subscription.childEventsByAgentId.delete(childId);
		}
		if (!events.includes(triggerEvent)) {
			events.push(triggerEvent);
		}
		const delivered = new Set(events);
		const retainedEvents = subscription.pendingEvents.filter((event) => !delivered.has(event));
		return { events, retainedEvents };
	}

	private isObservedDelegateFinal(
		config: ObserverAttachmentConfig,
		event: SessionEvent,
	): boolean {
		if (event.kind !== "act_end") return false;
		if (event.data.observer === true) return false;
		const agentName = stringData(event, "agent_name");
		if (agentName === "wait_agent" || agentName === "message_agent") return false;
		if (config.callerAgentId && event.agent_id !== config.callerAgentId) return false;
		if (config.callerDepth !== undefined && event.depth !== config.callerDepth) return false;
		if (event.data.continued_in_background === true) return false;
		if (typeof event.data.handle_id === "string" && typeof event.data.turns !== "number") {
			return false;
		}
		return typeof event.data.child_id === "string";
	}
}

function stringData(event: SessionEvent, key: string): string | undefined {
	const value = event.data[key];
	return typeof value === "string" ? value : undefined;
}

function createSubscriptionState(config: ObserverAttachmentConfig): ObserverSubscriptionState {
	return {
		config,
		includeKinds: new Set(config.events),
		pendingEvents: [],
		childEventsByAgentId: new Map(),
		triggerCount: 0,
		observerStarted: false,
		deliveryInFlight: false,
		flushRequested: false,
		queuedDeliveries: [],
		warningEmitted: false,
	};
}
