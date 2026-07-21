import { describe, expect, test } from "bun:test";
import { secretBearingDelegationError } from "../../src/agents/delegation-guard.ts";

/**
 * The delegation secret guard (workshop lever 2): goal/hint/message text that
 * carries a pattern-detectable credential is rejected BEFORE dispatch with a
 * corrective error steering to env grants / ⟦ref⟧ passing. This cannot un-emit
 * what the model already wrote (that is the descriptions' job); it keeps the
 * secret out of the child and teaches the right path.
 */
describe("secretBearingDelegationError", () => {
	test("keyed credential in goal text is rejected with corrective guidance", () => {
		const err = secretBearingDelegationError(
			"Write deploy-out.conf with host=prod.internal and api_credential=SAP-EVAL-SECRET-1a2b3c4d5e6f7788 retries=4",
		);
		expect(err).toBeDefined();
		expect(err).toContain("env");
		expect(err).toContain("credential");
	});

	test("bearer token is rejected", () => {
		const err = secretBearingDelegationError(
			"Call the API with Bearer abcdefghij0123456789abcdefghij and summarize",
		);
		expect(err).toBeDefined();
	});

	test("clean goals pass", () => {
		expect(secretBearingDelegationError("Sum the integers in shard-2.txt")).toBeUndefined();
		expect(
			secretBearingDelegationError("Update the config host to prod.internal and report done"),
		).toBeUndefined();
	});

	test("mentioning the WORD token/secret without a value passes", () => {
		expect(
			secretBearingDelegationError("Rotate the api token in the config file and report done"),
		).toBeUndefined();
	});
});

import { tmpdir } from "node:os";
import { Agent, type AgentOptions } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";
import { withDefaultResolverContext } from "./fixtures.ts";

describe("delegation secret guard wiring", () => {
	test("a delegate call with a credential-bearing goal is rejected before dispatch", async () => {
		const requests: Request[] = [];
		let turn = 0;
		const client = {
			providers: () => ["anthropic"],
			complete: async (request: Request): Promise<Response> => {
				requests.push(request);
				turn++;
				const message =
					turn === 1
						? {
								role: "assistant" as const,
								content: [
									{
										kind: "tool_call" as const,
										tool_call: {
											id: "call-1",
											name: "delegate",
											arguments: {
												agent_name: "helper",
												goal: "Write the config including api_credential=SAP-EVAL-SECRET-deadbeef12345678",
												description: "write config",
											},
										},
									},
								],
							}
						: Msg.assistant("DONE");
				return {
					id: `mock-${turn}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message,
					finish_reason: { reason: turn === 1 ? ("tool_calls" as const) : ("stop" as const) },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const spec: AgentSpec = {
			name: "guard-test",
			description: "test",
			system_prompt: "You are a test agent.",
			model: "best",
			tools: [],
			agents: ["helper"],
			constraints: { max_turns: 5, timeout_ms: 30000, can_spawn: true, can_learn: false },
			tags: [],
			version: 1,
		};
		const helperSpec: AgentSpec = {
			...spec,
			name: "helper",
			agents: [],
			constraints: { ...spec.constraints, can_spawn: false },
		};
		const env = new LocalExecutionEnvironment(tmpdir());
		const agent = new Agent(
			withDefaultResolverContext({
				spec,
				env,
				client,
				primitiveRegistry: createPrimitiveRegistry(env),
				availableAgents: [helperSpec],
				depth: 0,
				events: new AgentEventEmitter(),
			} satisfies AgentOptions),
		);
		await agent.run("do the task");

		// The second request carries the tool result: the guard's rejection, and
		// the child was never dispatched (no spawner exists to dispatch with,
		// and resolution errors would read differently).
		const second = requests[1];
		expect(second).toBeDefined();
		const rendered = JSON.stringify(second!.messages);
		expect(rendered).toContain("Rejected");
		expect(rendered).toContain("env {alias");
	});
});
