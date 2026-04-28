import { describe, expect, test } from "bun:test";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import type { AgentSpawner, SpawnAgentOptions } from "../../src/bus/spawner.ts";
import type { AgentAddress, ResultMessage } from "../../src/bus/types.ts";
import { ObserverDispatcher } from "../../src/host/observer-dispatcher.ts";
import type { EventKind, SessionEvent } from "../../src/kernel/types.ts";
import { addr } from "../helpers/agent-address.ts";
import { waitFor } from "../helpers/wait-for.ts";

function resolverSettings() {
	return createResolverSettings(
		[{ id: "anthropic", enabled: true }],
		{},
		{},
		{
			"observer.metacognitive": {
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
			},
		},
	);
}

function planEnd(index: number, overrides: Partial<SessionEvent> = {}): SessionEvent {
	return {
		kind: "plan_end",
		agent_id: "root",
		depth: 0,
		timestamp: index,
		data: {
			turn: index,
			finish_reason: "stop",
			text: `root plan ${index}`,
		},
		...overrides,
	};
}

class FakeSpawner {
	spawnCalls: SpawnAgentOptions[] = [];
	messages: Array<{
		handleId: string;
		message: string;
		caller: AgentAddress;
		blocking: boolean;
	}> = [];
	spawnPromise: Promise<string | ResultMessage> | undefined;

	async spawnAgent(opts: SpawnAgentOptions): Promise<string | ResultMessage> {
		this.spawnCalls.push(opts);
		if (this.spawnPromise) return this.spawnPromise;
		return opts.handleId ?? "observer-metacognitive";
	}

	async messageAgent(
		handleId: string,
		message: string,
		caller: AgentAddress,
		blocking: boolean,
	): Promise<ResultMessage | undefined> {
		this.messages.push({ handleId, message, caller, blocking });
		return undefined;
	}
}

function makeDispatcher(
	spawner: FakeSpawner,
	options: { configured?: boolean; sessionId?: string } = {},
) {
	const emitted: Array<{
		kind: EventKind;
		agentId: string;
		depth: number;
		data: Record<string, unknown>;
	}> = [];
	const dispatcher = new ObserverDispatcher({
		sessionId: options.sessionId ?? "session-1",
		spawner: spawner as unknown as AgentSpawner,
		genomePath: "/tmp/genome",
		workDir: "/tmp/work",
		projectDataDir: "/tmp/project",
		rootDir: "/tmp/root",
		getResolverSettings: () => (options.configured === false ? undefined : resolverSettings()),
		emitEvent: (kind, agentId, depth, data) => emitted.push({ kind, agentId, depth, data }),
	});
	return { dispatcher, emitted };
}

describe("ObserverDispatcher", () => {
	test("starts the metacognitive observer after the root plan_end trigger", async () => {
		const spawner = new FakeSpawner();
		const { dispatcher, emitted } = makeDispatcher(spawner);

		dispatcher.handleEvent(planEnd(1));
		dispatcher.handleEvent(planEnd(2));
		expect(spawner.spawnCalls).toHaveLength(0);

		dispatcher.handleEvent(planEnd(3));
		await waitFor(() => spawner.spawnCalls.length === 1);

		expect(spawner.spawnCalls[0]).toMatchObject({
			agentName: "metacognitive",
			handleId: "observer-metacognitive",
			agentId: "observer-metacognitive",
			shared: true,
			blocking: false,
			surfacedMemoryBlock: "",
		});
		expect(spawner.spawnCalls[0]!.goal).toContain("<sprout:observer-frame>");
		expect(spawner.spawnCalls[0]!.goal).toContain("root plan 3");
		expect(emitted).toContainEqual({
			kind: "act_start",
			agentId: "root",
			depth: 0,
			data: {
				agent_name: "metacognitive",
				child_id: "observer-metacognitive",
				handle_id: "observer-metacognitive",
				description: "observes root turns",
				observer: true,
			},
		});
	});

	test("does not fall back when the observer model purpose is unconfigured", async () => {
		const spawner = new FakeSpawner();
		const { dispatcher, emitted } = makeDispatcher(spawner, { configured: false });

		dispatcher.handleEvent(planEnd(1));
		dispatcher.handleEvent(planEnd(2));
		dispatcher.handleEvent(planEnd(3));
		await waitFor(() => emitted.some((event) => event.kind === "warning"));

		expect(spawner.spawnCalls).toHaveLength(0);
		expect(emitted.find((event) => event.kind === "warning")?.data.message).toContain(
			"observer.metacognitive",
		);
	});

	test("sends later frames to the shared observer handle without redelivering prior events", async () => {
		const spawner = new FakeSpawner();
		const { dispatcher } = makeDispatcher(spawner);

		dispatcher.handleEvent(planEnd(1));
		dispatcher.handleEvent(planEnd(2));
		dispatcher.handleEvent(planEnd(3));
		await waitFor(() => spawner.spawnCalls.length === 1);

		dispatcher.handleEvent(planEnd(4));
		dispatcher.handleEvent(planEnd(5));
		dispatcher.handleEvent(planEnd(6));
		await waitFor(() => spawner.messages.length === 1);

		expect(spawner.messages[0]).toMatchObject({
			handleId: "observer-metacognitive",
			caller: addr("root", 0),
			blocking: false,
		});
		expect(spawner.messages[0]!.message).toContain("root plan 6");
		expect(spawner.messages[0]!.message).not.toContain("root plan 1");
	});

	test("coalesces triggers while observer delivery is busy", async () => {
		const spawner = new FakeSpawner();
		let resolveSpawn: (value: string) => void = () => {};
		spawner.spawnPromise = new Promise((resolve) => {
			resolveSpawn = resolve;
		});
		const { dispatcher } = makeDispatcher(spawner);

		dispatcher.handleEvent(planEnd(1));
		dispatcher.handleEvent(planEnd(2));
		dispatcher.handleEvent(planEnd(3));
		await waitFor(() => spawner.spawnCalls.length === 1);

		dispatcher.handleEvent(planEnd(4));
		dispatcher.handleEvent(planEnd(5));
		dispatcher.handleEvent(planEnd(6));
		expect(spawner.messages).toHaveLength(0);

		resolveSpawn("observer-metacognitive");
		await waitFor(() => spawner.messages.length === 1);
		expect(spawner.messages[0]!.message).toContain("root plan 6");
	});

	test("reset drops pending events and restarts the trigger count", async () => {
		const spawner = new FakeSpawner();
		const { dispatcher } = makeDispatcher(spawner);

		dispatcher.handleEvent(planEnd(1));
		dispatcher.handleEvent(planEnd(2));
		dispatcher.reset("session-2");
		dispatcher.handleEvent(planEnd(3));
		dispatcher.handleEvent(planEnd(4));
		expect(spawner.spawnCalls).toHaveLength(0);

		dispatcher.handleEvent(planEnd(5));
		await waitFor(() => spawner.spawnCalls.length === 1);
		expect(spawner.spawnCalls[0]!.goal).toContain("Session: session-2");
		expect(spawner.spawnCalls[0]!.goal).not.toContain("root plan 1");
	});
});
