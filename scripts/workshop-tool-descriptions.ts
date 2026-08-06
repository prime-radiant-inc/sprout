#!/usr/bin/env bun
/**
 * Workshop the data-plane tool descriptions with REAL sessions:
 *
 *   1. RUN: live sessions (data plane ON) on probe tasks, per model —
 *      small (haiku) and big (sonnet) — persisting the exact tools array each
 *      session carried, the full final transcript, and the verdict.
 *   2. INTERROGATE: replay each session to the SAME model and ask it, with
 *      its own transcript in front of it, what in the tool descriptions
 *      steered it, confused it, or was dead weight — and to rewrite the one
 *      description that most needs it.
 *
 * Outputs land in --out (default ./workshop-results) as JSON + markdown for
 * human synthesis. This script changes nothing; it produces evidence.
 *
 * Usage:
 *   bun run scripts/workshop-tool-descriptions.ts [--out DIR] [--models small,big] [--tasks id,id]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import { defaultGenomePathFromEnv } from "../src/host/cli-parse.ts";
import { resolveStartupCwd, startBusInfrastructure } from "../src/host/cli-shared.ts";
import { resolveRuntimeRootDir } from "../src/host/embedded-root.ts";
import { createEvalSnapshot, type EvalTask } from "../src/learn/eval-harness.ts";
import { LiveTaskExecutor } from "../src/learn/live-task-executor.ts";
import { tortureTasks } from "../src/learn/torture-tasks.ts";
import { installSproutSelfInvocationEnv } from "../src/util/self-command.ts";

const MODELS: Record<string, string> = {
	small: "claude-haiku-4-5-20251001",
	big: "claude-sonnet-5",
};
const DEFAULT_TASKS = ["torture-secret-relay", "torture-huge-log", "torture-edit-chain"];

function log(line = ""): void {
	process.stdout.write(`${line}\n`);
}

interface PayloadShape {
	system?: unknown;
	messages?: unknown[];
	tools?: unknown[];
}

/** Compact, human/model-readable rendering of a provider-payload transcript. */
function renderTranscript(payload: PayloadShape): string {
	const lines: string[] = [];
	const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s);
	for (const raw of payload.messages ?? []) {
		const msg = raw as { role?: string; content?: unknown };
		const role = msg.role ?? "?";
		for (const part of Array.isArray(msg.content) ? msg.content : []) {
			const p = part as {
				kind?: string;
				text?: string;
				tool_call?: { name?: string; arguments?: unknown };
				tool_result?: { content?: unknown; is_error?: boolean };
			};
			if (p.kind === "text") lines.push(`[${role}] ${clip(String(p.text ?? ""), 400)}`);
			else if (p.kind === "tool_call")
				lines.push(
					`[${role} TOOL_CALL ${String(p.tool_call?.name)}] ${clip(
						JSON.stringify(p.tool_call?.arguments ?? {}),
						350,
					)}`,
				);
			else if (p.kind === "tool_result")
				lines.push(
					`[tool_result${p.tool_result?.is_error ? " ERROR" : ""}] ${clip(
						JSON.stringify(p.tool_result?.content ?? ""),
						250,
					)}`,
				);
			else lines.push(`[${role} ${String(p.kind)}]`);
		}
	}
	return lines.join("\n");
}

async function anthropicChat(model: string, system: string, user: string): Promise<string> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model,
			max_tokens: 4096,
			system,
			messages: [{ role: "user", content: user }],
		}),
	});
	if (!res.ok) throw new Error(`interrogation call failed: ${res.status} ${await res.text()}`);
	const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
	return body.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function interrogationPrompt(
	task: EvalTask,
	verdictLine: string,
	toolsJson: string,
	transcript: string,
): string {
	return [
		`You just performed the tool-use session below. Task goal:\n${task.goal}`,
		`Outcome: ${verdictLine}`,
		`These were your tools (exact schemas you saw):\n${toolsJson}`,
		`Session transcript (compacted):\n${transcript}`,
		`Answer these, concretely and honestly:`,
		`1. Walk through WHY you chose the specific tools/paths you chose, step by step.`,
		`2. What in the tool DESCRIPTIONS was unclear, misleading, or irrelevant to your choices?`,
		`3. If the intended best path was: capture file content with bind:, then splice it with a ⟦ref⟧ so raw content never enters the conversation — what exact wording in which description would have made you take that path (or made you take it more confidently)?`,
		`4. Which parts of the descriptions did you never need? Quote the parts you would DELETE to save tokens without hurting your decisions.`,
		`5. Rewrite the ONE description most in need of it, in full, as you wish it had read.`,
	].join("\n\n");
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const outDir = argv.includes("--out")
		? String(argv[argv.indexOf("--out") + 1])
		: join(process.cwd(), "workshop-results");
	const modelFilter = argv.includes("--models")
		? String(argv[argv.indexOf("--models") + 1]).split(",")
		: Object.keys(MODELS);
	const taskFilter = argv.includes("--tasks")
		? String(argv[argv.indexOf("--tasks") + 1]).split(",")
		: DEFAULT_TASKS;

	const envCwd = await resolveStartupCwd(undefined);
	loadDotenv({ path: join(envCwd, ".env"), quiet: true });
	const xdg = await mkdtemp(join(tmpdir(), "workshop-xdg-"));
	process.env.XDG_CONFIG_HOME = xdg;
	process.env.SPROUT_SECRET_BACKEND = "memory";
	installSproutSelfInvocationEnv({
		argv: [process.argv[0] ?? "bun", join(import.meta.dir, "../src/host/cli.ts")],
	});
	const rootDir = await resolveRuntimeRootDir({
		sourceRootDir: join(import.meta.dir, "../root"),
	});
	const snapshot = await createEvalSnapshot(defaultGenomePathFromEnv(), "workshop");
	await mkdir(outDir, { recursive: true });

	const tasks = tortureTasks.filter((t) => taskFilter.includes(t.id));
	try {
		for (const modelLabel of modelFilter) {
			const modelId = MODELS[modelLabel];
			if (!modelId) throw new Error(`unknown model label: ${modelLabel}`);
			const pin = `anthropic:${modelId}`;
			process.env.SPROUT_DEFAULT_FAST_MODEL = pin;
			process.env.SPROUT_DEFAULT_BALANCED_MODEL = pin;
			process.env.SPROUT_DEFAULT_BEST_MODEL = pin;

			for (const task of tasks) {
				const wd = await mkdtemp(join(tmpdir(), `workshop-${modelLabel}-`));
				const executor = new LiveTaskExecutor({
					rootDir,
					workDir: wd,
					startBusInfrastructure,
					selectionRequest: { kind: "tier", tier: "fast" },
				});
				const context = task.setup ? await task.setup({ workDir: wd }) : undefined;
				log(`RUN ${modelLabel} × ${task.id} …`);
				const outcome = await executor.run(task, snapshot);
				const verdict = task.verify(outcome, context);
				const verdictLine = `${verdict.passed ? "PASS" : "FAIL"}${verdict.detail ? ` — ${verdict.detail}` : ""}`;
				log(`  ${verdictLine} (${outcome.providerPayloads.length} payloads)`);

				// The first payload can be a tool-less prepass (recall/subcortical);
				// take tools from the last payload that HAS them, and the transcript
				// from the longest conversation.
				const parsedAll = outcome.providerPayloads.map((p) => JSON.parse(p) as PayloadShape);
				const parsedLast =
					parsedAll
						.filter((p) => (p.messages?.length ?? 0) > 0)
						.sort((a, b) => (a.messages?.length ?? 0) - (b.messages?.length ?? 0))
						.at(-1) ?? {};
				const withTools = parsedAll.filter((p) => (p.tools?.length ?? 0) > 0).at(-1);
				const toolsJson = JSON.stringify(withTools?.tools ?? [], null, 1);
				const transcript = renderTranscript(parsedLast);

				const base = join(outDir, `${modelLabel}--${task.id}`);
				await writeFile(
					`${base}.session.json`,
					JSON.stringify(
						{
							model: modelId,
							task: task.id,
							verdict: verdictLine,
							payloadCount: outcome.providerPayloads.length,
							payloadBytes: outcome.providerPayloads.reduce((s, p) => s + p.length, 0),
							tools: withTools?.tools ?? [],
							transcript,
						},
						null,
						1,
					),
				);

				log(`  interrogating ${modelLabel} …`);
				const answers = await anthropicChat(
					modelId,
					"You are reviewing a tool-use session you performed, to improve the TOOL DESCRIPTIONS for future sessions. Be blunt and specific; quote exact description text when you critique it.",
					interrogationPrompt(task, verdictLine, toolsJson, transcript),
				);
				await writeFile(`${base}.interrogation.md`, `# ${modelLabel} × ${task.id} — ${verdictLine}\n\n${answers}\n`);
				await rm(wd, { recursive: true, force: true }).catch(() => {});
			}
		}
	} finally {
		await snapshot.cleanup();
		await rm(xdg, { recursive: true, force: true }).catch(() => {});
	}
	log(`\nDone. Evidence in ${outDir}`);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
