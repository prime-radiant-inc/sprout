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
	events: ["plan_end", "warning", "error", "primitive_end", "act_end", "compaction", "interrupted"],
	trigger: { every: 3, event: "plan_end" },
	maxEvents: 24,
	maxChars: 6000,
};

const OBSERVER_HANDLE_ID = "observer-metacognitive";
const OBSERVER_AGENT_ID = "observer-metacognitive";
const ROOT_CALLER: CallerIdentity = { agent_name: "root", depth: 0 };

export interface ObserverRegistryOptions {
	sessionId: string;
	spawner: AgentSpawner;
	genomePath: string;
	workDir: string;
	projectDataDir?: string;
	rootDir?: string;
	evalMode?: boolean;
	config?: ObserverAttachmentConfig;
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
	private readonly config: ObserverAttachmentConfig;
	private readonly getResolverSettings?: () => ResolverSettings | undefined;
	private readonly emitEvent: ObserverRegistryOptions["emitEvent"];
	private readonly includeKinds: Set<EventKind>;
	private pendingEvents: SessionEvent[] = [];
	private rootTriggerCount = 0;
	private observerStarted = false;
	private deliveryInFlight = false;
	private flushRequested = false;
	private warningEmitted = false;
	private generation = 0;

	constructor(options: ObserverRegistryOptions) {
		this.sessionId = options.sessionId;
		this.spawner = options.spawner;
		this.genomePath = options.genomePath;
		this.workDir = options.workDir;
		this.projectDataDir = options.projectDataDir;
		this.rootDir = options.rootDir;
		this.evalMode = options.evalMode;
		this.config = options.config ?? METACOGNITIVE_OBSERVER;
		this.getResolverSettings = options.getResolverSettings;
		this.emitEvent = options.emitEvent;
		this.includeKinds = new Set(this.config.events);
	}

	handleEvent(event: SessionEvent): void {
		if (!this.includeKinds.has(event.kind)) return;
		this.pendingEvents.push(event);
		this.trimPendingEvents();

		if (event.kind !== this.config.trigger.event || event.depth !== 0) return;
		this.rootTriggerCount++;
		if (this.rootTriggerCount % this.config.trigger.every !== 0) return;
		void this.flush();
	}

	reset(sessionId: string): void {
		this.sessionId = sessionId;
		this.pendingEvents = [];
		this.rootTriggerCount = 0;
		this.observerStarted = false;
		this.deliveryInFlight = false;
		this.flushRequested = false;
		this.warningEmitted = false;
		this.generation++;
	}

	private async flush(): Promise<void> {
		if (this.deliveryInFlight) {
			this.flushRequested = true;
			return;
		}
		if (this.pendingEvents.length === 0) return;

		const resolverSettings = this.getResolverSettings?.();
		if (!resolverSettings?.agentModels["observer.metacognitive"]) {
			this.emitMissingModelWarning();
			return;
		}

		const generation = this.generation;
		const events = this.pendingEvents;
		this.pendingEvents = [];
		this.deliveryInFlight = true;
		try {
			const frame = buildObserverFrame({
				sessionId: this.sessionId,
				events,
				includeKinds: this.config.events,
				maxEvents: this.config.maxEvents,
				maxChars: this.config.maxChars,
			});
			if (frame.events.length === 0) return;

			const message = renderObserverFrame(frame);
			await this.deliverFrame(message, resolverSettings);
		} catch (error) {
			if (this.generation === generation) {
				this.pendingEvents = [...events, ...this.pendingEvents];
				this.trimPendingEvents();
				this.emitEvent("warning", "session", 0, {
					message: `Metacognitive observer delivery failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				});
			}
		} finally {
			if (this.generation === generation) {
				this.deliveryInFlight = false;
				if (this.flushRequested) {
					this.flushRequested = false;
					void this.flush();
				}
			}
		}
	}

	private async deliverFrame(message: string, resolverSettings: ResolverSettings): Promise<void> {
		if (!this.observerStarted) {
			this.emitObserverStart();
			const result = await this.spawner.spawnAgent({
				agentName: this.config.agentName,
				goal: message,
				genomePath: this.genomePath,
				workDir: this.workDir,
				projectDataDir: this.projectDataDir,
				rootDir: this.rootDir,
				caller: ROOT_CALLER,
				shared: true,
				blocking: false,
				handleId: OBSERVER_HANDLE_ID,
				agentId: OBSERVER_AGENT_ID,
				evalMode: this.evalMode,
				resolverSettings,
				surfacedMemoryBlock: "",
			});
			if (typeof result !== "string") {
				throw new Error("Metacognitive observer did not return a handle id");
			}
			this.observerStarted = true;
			return;
		}

		await this.spawner.messageAgent(OBSERVER_HANDLE_ID, message, ROOT_CALLER, false);
	}

	private emitObserverStart(): void {
		this.emitEvent("act_start", "root", 0, {
			agent_name: this.config.agentName,
			child_id: OBSERVER_AGENT_ID,
			handle_id: OBSERVER_HANDLE_ID,
			description: "observes root turns",
			observer: true,
		});
	}

	private emitMissingModelWarning(): void {
		if (this.warningEmitted) return;
		this.warningEmitted = true;
		this.emitEvent("warning", "session", 0, {
			message:
				"Metacognitive observer is not running because agent model 'observer.metacognitive' is not configured.",
		});
	}

	private trimPendingEvents(): void {
		const maxPendingEvents = this.config.maxEvents * 4;
		if (this.pendingEvents.length <= maxPendingEvents) return;
		this.pendingEvents = this.pendingEvents.slice(-maxPendingEvents);
	}
}
