#!/usr/bin/env bun
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { bootstrapSessionRuntime } from "../src/host/cli-bootstrap.ts";
import { startBusInfrastructure } from "../src/host/cli-shared.ts";
import type { EventBus } from "../src/host/event-bus.ts";
import type { SessionRunResult } from "../src/host/session-controller.ts";
import type { SessionSelectionContext } from "../src/host/session-selection.ts";
import type { SessionEvent } from "../src/kernel/types.ts";
import { installSproutSelfInvocationEnv } from "../src/util/self-command.ts";
import { ulid } from "../src/util/ulid.ts";

type ScenarioName =
	| "caller-alias-root"
	| "caller-alias-non-root"
	| "multi-observer-smoke"
	| "nonblocking-negative";

interface Scenario {
	name: ScenarioName;
	goal: string;
	buildRoot(rootDir: string): Promise<void>;
	assert(input: AssertionInput): Assertion[];
}

interface AssertionInput {
	result: SessionRunResult;
	events: SessionEvent[];
	caseDir: string;
}

interface Assertion {
	name: string;
	pass: boolean;
	detail?: string;
}

interface ScenarioSummary {
	scenario: ScenarioName;
	pass: boolean;
	caseDir: string;
	sessionId: string;
	rootDir: string;
	genomePath: string;
	projectDataDir: string;
	result?: SessionRunResult;
	assertions: Assertion[];
	eventCounts: Record<string, number>;
	events: SessionEvent[];
	error?: string;
}

const ROOT_MARKER = "ROOT_OBSERVER_MARKER";
const MULTI_META_MARKER = "MULTI_OBSERVER_META_MARKER";
const MULTI_PM_MARKER = "MULTI_OBSERVER_PM_MARKER";
const NONROOT_MARKER = "NONROOT_OBSERVER_MARKER";
const NONBLOCKING_MARKER = "NONBLOCKING_OBSERVER_MARKER";

const SCENARIOS: Scenario[] = [
	{
		name: "caller-alias-root",
		goal: "Live observer validation. Follow your system instructions exactly and report root observer delivery.",
		buildRoot: (rootDir) =>
			writeRootFixture(rootDir, {
				rootPrompt: rootWaitPrompt({
					markers: [ROOT_MARKER],
					successOutput: "ROOT_ALIAS_ROOT_CONTEXT_RENDERED",
					missingOutput: "ROOT_ALIAS_ROOT_CONTEXT_MISSING",
				}),
				rootTools: ["root-wait"],
				rootAgents: [],
				rootObservers: [rootObserverYaml("metacognitive", ["plan_end"], 1)],
				observerMarkers: { metacognitive: ROOT_MARKER },
			}),
		assert: ({ result, events }) => {
			const rootMessage = findAgentMessage(events, ROOT_MARKER, {
				toHandleId: "root",
				fromRole: "observer",
			});
			return [
				assertion("root-owned observer sent marker to root", Boolean(rootMessage)),
				assertion(
					"root saw observer message in prompt context",
					result.output.includes("ROOT_ALIAS_ROOT_CONTEXT_RENDERED"),
					result.output,
				),
			];
		},
	},
	{
		name: "caller-alias-non-root",
		goal: "Delegate to owner exactly as instructed by your system prompt.",
		buildRoot: (rootDir) =>
			writeRootFixture(rootDir, {
				rootPrompt:
					"You are the root live-validation agent.\n\nDelegate exactly once to `owner` with blocking true and description `owner probe`. After it returns, final-answer with the owner output.",
				rootTools: [],
				rootAgents: ["owner"],
				rootObservers: [],
				owner: {
					prompt:
						'You are the owner live-validation agent.\n\n1. First delegate exactly once to `probe-worker` with blocking true and description `probe worker`.\n2. After that delegate returns, call `owner-wait` exactly once with args `{"ms":10000}`.\n3. After `owner-wait` returns, inspect `<sprout:agent-messages>`.\n4. If it contains `NONROOT_OBSERVER_MARKER`, final-answer exactly `OWNER_CONTEXT_RENDERED`.\n5. Otherwise final-answer exactly `OWNER_CONTEXT_MISSING`.\n\nDo not call `owner-wait` before the delegate returns.',
					tools: ["owner-wait"],
					agents: ["probe-worker"],
					delegateObservers: [delegateObserverYaml("delegate-observer")],
				},
				probeWorker: true,
				observerMarkers: { "delegate-observer": NONROOT_MARKER },
			}),
		assert: ({ result, events }) => {
			const ownerMessage = findAgentMessage(events, NONROOT_MARKER, {
				fromRole: "observer",
				toAgentName: "owner",
			});
			const rootMessage = findAgentMessage(events, NONROOT_MARKER, { toHandleId: "root" });
			return [
				assertion("delegate observer sent marker to non-root owner", Boolean(ownerMessage)),
				assertion("delegate observer marker was not delivered to root", !rootMessage),
				assertion(
					"owner saw observer message in prompt context",
					result.output.includes("OWNER_CONTEXT_RENDERED") ||
						affirmsMarkerObservation(result.output, NONROOT_MARKER, "OWNER_CONTEXT_MISSING"),
					result.output,
				),
			];
		},
	},
	{
		name: "multi-observer-smoke",
		goal: "Live multi-observer validation. Follow your system instructions exactly and report observer context.",
		buildRoot: (rootDir) =>
			writeRootFixture(rootDir, {
				rootPrompt: rootWaitPrompt({
					markers: [MULTI_META_MARKER, MULTI_PM_MARKER],
					successOutput: "MULTI_OBSERVER_CONTEXT_RENDERED",
					missingOutput: "MULTI_OBSERVER_CONTEXT_MISSING",
				}),
				rootTools: ["root-wait"],
				rootAgents: [],
				rootObservers: [
					rootObserverYaml("metacognitive", ["plan_end"], 1),
					rootObserverYaml("pm-observer", ["plan_end"], 1),
				],
				observerMarkers: {
					metacognitive: MULTI_META_MARKER,
					"pm-observer": MULTI_PM_MARKER,
				},
			}),
		assert: ({ result, events }) => {
			const observerStarts = events.filter(
				(event) => event.kind === "act_start" && event.data.observer === true,
			);
			const metaMessage = findAgentMessage(events, MULTI_META_MARKER, {
				toHandleId: "root",
				fromRole: "observer",
			});
			const pmMessage = findAgentMessage(events, MULTI_PM_MARKER, {
				toHandleId: "root",
				fromRole: "observer",
			});
			return [
				assertion("two root observer handles started", observerStarts.length >= 2),
				assertion("metacognitive observer emitted role-tagged message", Boolean(metaMessage)),
				assertion("pm observer emitted role-tagged message", Boolean(pmMessage)),
				assertion(
					"root saw both observer messages in prompt context",
					result.output.includes("MULTI_OBSERVER_CONTEXT_RENDERED"),
					result.output,
				),
			];
		},
	},
	{
		name: "nonblocking-negative",
		goal: "Start the nonblocking delegate exactly as instructed by your system prompt.",
		buildRoot: (rootDir) =>
			writeRootFixture(rootDir, {
				rootPrompt:
					'You are the root nonblocking-observer negative-control agent.\n\n1. First delegate exactly once to `probe-worker` with blocking false and description `background probe`.\n2. After the delegate call returns a handle, call `root-wait` exactly once with args `{"ms":6000}`.\n3. After `root-wait` returns, final-answer exactly `NONBLOCKING_STARTED`.\n\nDo not wait on the handle. Do not call `message_agent`.',
				rootTools: ["root-wait"],
				rootAgents: ["probe-worker"],
				rootObservers: [],
				rootDelegateObservers: [delegateObserverYaml("delegate-observer")],
				probeWorker: true,
				observerMarkers: { "delegate-observer": NONBLOCKING_MARKER },
			}),
		assert: ({ result, events }) => {
			const observerStart = events.find(
				(event) =>
					event.kind === "act_start" &&
					event.data.observer === true &&
					event.data.observed_target === "delegate",
			);
			const observerMessage = findAgentMessage(events, NONBLOCKING_MARKER, {
				fromRole: "observer",
			});
			return [
				assertion("nonblocking delegate did not start delegate observer", !observerStart),
				assertion("nonblocking delegate did not receive observer marker", !observerMessage),
				assertion(
					"root completed the nonblocking negative control",
					result.output.includes("NONBLOCKING_STARTED"),
					result.output,
				),
			];
		},
	},
];

async function main(): Promise<void> {
	const opts = parseArgs(Bun.argv.slice(2));
	loadDotenv({ quiet: true });
	if (!opts.live && process.env.SPROUT_RUN_LIVE_OBSERVER_TESTS !== "1") {
		console.log(
			"live observer validation skipped; pass --live or set SPROUT_RUN_LIVE_OBSERVER_TESTS=1",
		);
		return;
	}

	installSproutSelfInvocationEnv({
		argv: [process.argv[0] ?? "bun", join(import.meta.dir, "../src/host/cli.ts")],
	});
	const scenarios = selectScenarios(opts.scenario);
	let failures = 0;

	for (const scenario of scenarios) {
		const summary = await runScenario(scenario);
		const summaryPath = join(summary.caseDir, "summary.json");
		await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
		if (summary.pass) {
			console.log(`PASS ${scenario.name} ${summaryPath}`);
		} else {
			failures++;
			console.log(`FAIL ${scenario.name} ${summaryPath}`);
			for (const assertionResult of summary.assertions) {
				if (!assertionResult.pass) {
					console.log(`  - ${assertionResult.name}: ${assertionResult.detail ?? "failed"}`);
				}
			}
			if (summary.error) {
				console.log(`  - error: ${summary.error}`);
			}
		}
	}

	if (failures > 0) {
		process.exitCode = 1;
	}
}

async function runScenario(scenario: Scenario): Promise<ScenarioSummary> {
	const caseDir = await mkdtemp(join(tmpdir(), `sprout-live-observer-${scenario.name}-`));
	const rootDir = join(caseDir, "root");
	const genomePath = join(caseDir, "genome");
	const projectDataDir = join(caseDir, "project-data");
	const sessionId = ulid();
	await mkdir(projectDataDir, { recursive: true });
	await scenario.buildRoot(rootDir);

	const baseSummary = {
		scenario: scenario.name,
		caseDir,
		sessionId,
		rootDir,
		genomePath,
		projectDataDir,
	};

	const infra = await startBusInfrastructure({ genomePath, rootDir, sessionId });
	let runtimeBus: EventBus | undefined;
	try {
		const runtime = await bootstrapSessionRuntime({
			genomePath,
			projectDataDir,
			rootDir,
			sessionId,
			infra,
			evalMode: true,
			nonInteractive: true,
		});
		runtimeBus = runtime.bus as EventBus;
		assertRequiredModelsConfigured(runtime.settingsControlPlane);

		const controller = runtime.controller as {
			runGoal(goal: string): Promise<SessionRunResult>;
		};
		const result = await controller.runGoal(scenario.goal);
		await sleep(1_000);
		const events = runtimeBus.collected();
		const assertions = scenario.assert({ result, events, caseDir });
		return {
			...baseSummary,
			pass: assertions.every((entry) => entry.pass),
			result,
			assertions,
			eventCounts: countEvents(events),
			events,
		};
	} catch (error) {
		const events = runtimeBus?.collected() ?? [];
		return {
			...baseSummary,
			pass: false,
			assertions: [],
			eventCounts: countEvents(events),
			events,
			error: error instanceof Error ? (error.stack ?? error.message) : String(error),
		};
	} finally {
		await infra.cleanup();
	}
}

function parseArgs(args: string[]): { live: boolean; scenario?: ScenarioName } {
	let scenario: ScenarioName | undefined;
	let live = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--live") {
			live = true;
			continue;
		}
		if (arg === "--scenario") {
			scenario = requireScenarioName(args[index + 1], "--scenario requires a scenario name");
			index++;
			continue;
		}
		if (arg.startsWith("--scenario=")) {
			scenario = requireScenarioName(arg.slice("--scenario=".length), "invalid scenario name");
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { live, scenario };
}

function requireScenarioName(raw: string | undefined, message: string): ScenarioName {
	if (!raw || !SCENARIOS.some((scenario) => scenario.name === raw)) {
		throw new Error(`${message}. Known scenarios: ${SCENARIOS.map((s) => s.name).join(", ")}`);
	}
	return raw as ScenarioName;
}

function selectScenarios(name: ScenarioName | undefined): Scenario[] {
	if (!name) return SCENARIOS;
	return SCENARIOS.filter((scenario) => scenario.name === name);
}

async function writeRootFixture(
	rootDir: string,
	options: {
		rootPrompt: string;
		rootTools: string[];
		rootAgents: string[];
		rootObservers: string[];
		rootDelegateObservers?: string[];
		owner?: {
			prompt: string;
			tools: string[];
			agents: string[];
			delegateObservers: string[];
		};
		probeWorker?: boolean;
		observerMarkers: Record<string, string>;
	},
): Promise<void> {
	await mkdir(join(rootDir, "agents"), { recursive: true });
	await writeAgentMarkdown(join(rootDir, "root.md"), {
		name: "root",
		description: "Live observer validation root",
		model: "fast",
		tools: options.rootTools,
		agents: options.rootAgents,
		constraints: { maxTurns: 8, canSpawn: options.rootAgents.length > 0, timeoutMs: 180_000 },
		observers: options.rootObservers,
		observeDelegates: options.rootDelegateObservers ?? [],
		prompt: options.rootPrompt,
	});

	if (options.rootTools.includes("root-wait")) {
		await writeWaitTool(join(rootDir, "root", "tools", "root-wait"), "root-wait");
	}
	if (options.owner) {
		await writeAgentMarkdown(join(rootDir, "agents", "owner.md"), {
			name: "owner",
			description: "Owns a delegated probe",
			model: "fast",
			tools: options.owner.tools,
			agents: options.owner.agents,
			constraints: { maxTurns: 8, canSpawn: true, timeoutMs: 180_000 },
			observeDelegates: options.owner.delegateObservers,
			prompt: options.owner.prompt,
		});
		if (options.owner.tools.includes("owner-wait")) {
			await writeWaitTool(join(rootDir, "agents", "owner", "tools", "owner-wait"), "owner-wait");
		}
	}
	if (options.probeWorker) {
		await writeProbeWorker(rootDir);
	}
	for (const [agentName, marker] of Object.entries(options.observerMarkers)) {
		await writeObserverAgent(rootDir, agentName, marker);
	}
}

async function writeAgentMarkdown(
	path: string,
	options: {
		name: string;
		description: string;
		model: string;
		tools: string[];
		agents: string[];
		constraints: { maxTurns: number; canSpawn: boolean; timeoutMs: number };
		observers?: string[];
		observeDelegates?: string[];
		prompt: string;
	},
): Promise<void> {
	const observers =
		options.observers && options.observers.length > 0
			? `observers:\n${options.observers.join("")}`
			: "";
	const observeDelegates =
		options.observeDelegates && options.observeDelegates.length > 0
			? `observe_delegates:\n${options.observeDelegates.join("")}`
			: "";
	const content = `---
name: ${options.name}
description: "${options.description}"
model: ${options.model}
tools:${yamlList(options.tools)}
agents:${yamlList(options.agents)}
constraints:
  max_turns: ${options.constraints.maxTurns}
  can_spawn: ${options.constraints.canSpawn}
  can_learn: false
  timeout_ms: ${options.constraints.timeoutMs}
subcortical_recall:
  enabled: false
${observers}${observeDelegates}tags: [live-observer-validation]
version: 1
---
${options.prompt}
`;
	await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	await writeFile(path, content);
}

async function writeObserverAgent(
	rootDir: string,
	agentName: string,
	marker: string,
): Promise<void> {
	await writeAgentMarkdown(join(rootDir, "agents", `${agentName}.md`), {
		name: agentName,
		description: `Observer that emits ${marker}`,
		model: "observer.metacognitive",
		tools: ["message_agent"],
		agents: [],
		constraints: { maxTurns: 4, canSpawn: false, timeoutMs: 180_000 },
		prompt: `You are a live-validation observer.

When the current goal contains either <sprout:observer-frame> or <sprout:delegate-observer-frame>:
1. Call message_agent exactly once with handle "caller", blocking false, and message "${marker}".
2. After the tool result, final-answer exactly "MESSAGE_SENT".

Never delegate. Never message a raw handle. Never use blocking true.`,
	});
}

async function writeProbeWorker(rootDir: string): Promise<void> {
	await writeAgentMarkdown(join(rootDir, "agents", "probe-worker.md"), {
		name: "probe-worker",
		description: "Deterministic probe worker",
		model: "fast",
		tools: ["emit-probe-result"],
		agents: [],
		constraints: { maxTurns: 4, canSpawn: false, timeoutMs: 120_000 },
		prompt: `You are a deterministic probe worker.

Call emit-probe-result exactly once with args "{}". After the tool returns, final-answer exactly "PROBE_WORKER_DONE".`,
	});
	await writeFileTool(
		join(rootDir, "agents", "probe-worker", "tools", "emit-probe-result"),
		"emit-probe-result",
		"Return a deterministic probe marker",
		`export default async function() {
  return { output: "PROBE_WORKER_DONE", success: true };
}
`,
	);
}

async function writeWaitTool(path: string, name: string): Promise<void> {
	await writeFileTool(
		path,
		name,
		"Wait briefly so observer messages can arrive",
		`export default async function(ctx) {
  const ms = Number(ctx.args.ms ?? 6000);
  await new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? ms : 6000));
  return { output: "${name.toUpperCase().replaceAll("-", "_")}_DONE", success: true };
}
`,
	);
}

async function writeFileTool(
	path: string,
	name: string,
	description: string,
	script: string,
): Promise<void> {
	const content = `---
name: ${name}
description: "${description}"
interpreter: sprout-internal
---
${script}`;
	await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	await writeFile(path, content);
	await chmod(path, 0o755);
}

function rootWaitPrompt(options: {
	markers: string[];
	successOutput: string;
	missingOutput: string;
}): string {
	const markerText = options.markers.map((marker) => `\`${marker}\``).join(" and ");
	return `You are a root live-validation agent.

1. First call root-wait exactly once with args \`{"ms":10000}\`.
2. After root-wait returns, inspect <sprout:agent-messages>.
3. If it contains ${markerText}, final-answer exactly "${options.successOutput}".
4. Otherwise final-answer exactly "${options.missingOutput}".

Do not call any other tool.`;
}

function rootObserverYaml(agentName: string, events: string[], every: number): string {
	return `  - agent: ${agentName}
    target: root
    events: [${events.join(", ")}]
    trigger:
      every: ${every}
      event: ${events[0]}
    delivery:
      max_events: 12
      max_chars: 4000
`;
}

function delegateObserverYaml(agentName: string): string {
	return `  - agent: ${agentName}
    trigger: on_delegate_final
    events: [act_start, plan_end, act_end]
    delivery:
      max_events: 16
      max_chars: 5000
`;
}

function yamlList(values: string[]): string {
	if (values.length === 0) return " []";
	return `\n${values.map((value) => `  - ${value}`).join("\n")}`;
}

function assertRequiredModelsConfigured(settingsControlPlane: unknown): void {
	const context = (
		settingsControlPlane as { getSelectionContext?: () => SessionSelectionContext }
	).getSelectionContext?.();
	if (!context) {
		throw new Error("Runtime settings control plane does not expose model selection context");
	}
	if (!context.settings.defaults.fast) {
		throw new Error("Live observer validation requires a configured global fast model");
	}
	if (!context.settings.agentModels["observer.metacognitive"]) {
		throw new Error(
			"Live observer validation requires a configured observer.metacognitive agent model",
		);
	}
}

function findAgentMessage(
	events: SessionEvent[],
	marker: string,
	filter: { fromRole?: string; toHandleId?: string; toAgentName?: string } = {},
): SessionEvent | undefined {
	return events.find((event) => {
		if (event.kind !== "agent_message") return false;
		if (!String(event.data.textPreview ?? "").includes(marker)) return false;
		const from = event.data.from;
		const to = event.data.to;
		if (filter.fromRole && (!isRecord(from) || from.role !== filter.fromRole)) return false;
		if (filter.toHandleId && (!isRecord(to) || to.handleId !== filter.toHandleId)) return false;
		if (filter.toAgentName && (!isRecord(to) || to.agentName !== filter.toAgentName)) {
			return false;
		}
		return true;
	});
}

function assertion(name: string, pass: boolean, detail?: string): Assertion {
	return {
		name,
		pass,
		...(detail ? { detail } : {}),
	};
}

function affirmsMarkerObservation(output: string, marker: string, missingToken: string): boolean {
	const lower = output.toLowerCase();
	return (
		output.includes(marker) &&
		!output.includes(missingToken) &&
		!lower.includes("unable to detect") &&
		!lower.includes("not present") &&
		!lower.includes("does not contain")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countEvents(events: SessionEvent[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const event of events) {
		counts[event.kind] = (counts[event.kind] ?? 0) + 1;
	}
	return counts;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
