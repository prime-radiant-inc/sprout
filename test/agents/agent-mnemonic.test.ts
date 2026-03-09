import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Agent } from "@/agents/agent.ts";
import { AgentEventEmitter } from "@/agents/events.ts";
import { LocalExecutionEnvironment } from "@/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "@/kernel/primitives.ts";
import type { Client } from "@/llm/client.ts";
import type { Message, Response } from "@/llm/types.ts";
import { ContentKind } from "@/llm/types.ts";
import { leafSpec, rootSpec } from "./fixtures.ts";

describe("Agent mnemonic names", () => {
	test("act_start and act_end events include mnemonic_name from delegation", async () => {
		// Mock LLM responses in sequence:
		// 1. Root agent plans → delegates to leaf
		// 2. Mnemonic name generation → returns "Curie"
		// 3. Child agent completes → returns result
		// 4. Root agent completes → returns final answer
		const delegateMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-1",
						name: "delegate",
						arguments: JSON.stringify({
							agent_name: "leaf",
							goal: "do something",
							description: "test delegation",
						}),
					},
				},
			],
		};
		const mnemonicMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Curie" }],
		};
		const childDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done with task." }],
		};
		const rootDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "All complete." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				let msg: Message;
				if (callCount === 1) msg = delegateMsg;
				else if (callCount === 2) msg = mnemonicMsg;
				else if (callCount === 3) msg = childDoneMsg;
				else msg = rootDoneMsg;
				return {
					id: `mock-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: {
						reason: callCount === 1 ? "tool_calls" : "stop",
					},
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
			events,
		});

		await agent.run("delegate something");

		const collected = events.collected();

		// Find act_start at depth 0 (parent delegating to child)
		const actStart = collected.find((e) => e.kind === "act_start" && e.depth === 0);
		expect(actStart).toBeDefined();
		expect(actStart!.data.mnemonic_name).toBe("Curie");
		expect(actStart!.data.agent_name).toBe("leaf");

		// Find act_end at depth 0 for successful delegation
		const actEnd = collected.find(
			(e) => e.kind === "act_end" && e.depth === 0 && e.data.success === true,
		);
		expect(actEnd).toBeDefined();
		expect(actEnd!.data.mnemonic_name).toBe("Curie");
	});

	test("usedMnemonicNames accumulates across delegations", async () => {
		// Mock LLM responses: two sequential delegations
		// 1. Root plans → delegate to leaf (first time)
		// 2. Mnemonic → "Tesla"
		// 3. Child completes
		// 4. Root plans → delegate to leaf (second time)
		// 5. Mnemonic → "Lovelace"
		// 6. Child completes
		// 7. Root completes
		const makeDelegateMsg = (callId: string): Message => ({
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: callId,
						name: "delegate",
						arguments: JSON.stringify({
							agent_name: "leaf",
							goal: "do task",
						}),
					},
				},
			],
		});
		const makeTextMsg = (text: string): Message => ({
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text }],
		});

		let callCount = 0;
		const capturedRequests: any[] = [];
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (request: any): Promise<Response> => {
				callCount++;
				capturedRequests.push(request);
				let msg: Message;
				if (callCount === 1) msg = makeDelegateMsg("call-1");
				else if (callCount === 2) msg = makeTextMsg("Tesla");
				else if (callCount === 3) msg = makeTextMsg("Child done 1.");
				else if (callCount === 4) msg = makeDelegateMsg("call-2");
				else if (callCount === 5) msg = makeTextMsg("Lovelace");
				else if (callCount === 6) msg = makeTextMsg("Child done 2.");
				else msg = makeTextMsg("All complete.");
				return {
					id: `mock-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: {
						reason: callCount === 1 || callCount === 4 ? "tool_calls" : "stop",
					},
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
			events,
		});

		await agent.run("delegate twice");

		const collected = events.collected();
		const actStarts = collected.filter((e) => e.kind === "act_start" && e.depth === 0);

		expect(actStarts.length).toBe(2);
		expect(actStarts[0]!.data.mnemonic_name).toBe("Tesla");
		expect(actStarts[1]!.data.mnemonic_name).toBe("Lovelace");

		// Verify the second mnemonic generation call received "Tesla" in the used names context
		// The mnemonic generation calls are calls 2 and 5
		const secondMnemonicRequest = capturedRequests[4]; // 0-indexed call 5
		const systemMsg = secondMnemonicRequest?.messages?.[0];
		if (systemMsg?.content) {
			const systemText =
				typeof systemMsg.content === "string"
					? systemMsg.content
					: Array.isArray(systemMsg.content)
						? systemMsg.content.map((c: any) => c.text ?? "").join("")
						: "";
			expect(systemText).toContain("Tesla");
		}
	});

	test("mnemonic generation failure does not block delegation", async () => {
		// Mock: mnemonic call throws, but delegation should still succeed
		const delegateMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-1",
						name: "delegate",
						arguments: JSON.stringify({
							agent_name: "leaf",
							goal: "do something",
						}),
					},
				},
			],
		};
		const childDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done." }],
		};
		const rootDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "All done." }],
		};

		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				// callCount 2 = mnemonic generation, callCount 3 = retry (maxRetries: 1)
				if (callCount === 2 || callCount === 3) throw new Error("LLM failure for mnemonic");
				let msg: Message;
				if (callCount === 1) msg = delegateMsg;
				else if (callCount === 4) msg = childDoneMsg;
				else msg = rootDoneMsg;
				return {
					id: `mock-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: {
						reason: callCount === 1 ? "tool_calls" : "stop",
					},
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
			events,
		});

		const result = await agent.run("delegate something");

		// Delegation should succeed despite mnemonic failure
		expect(result.success).toBe(true);

		const collected = events.collected();
		const actStart = collected.find((e) => e.kind === "act_start" && e.depth === 0);
		expect(actStart).toBeDefined();
		// mnemonic_name should be absent (null → not spread into event)
		expect(actStart!.data.mnemonic_name).toBeUndefined();
	});

	test("usedMnemonicNames option is accepted and used", async () => {
		const priorNames = new Set(["Curie", "Tesla"]);

		const delegateMsg: Message = {
			role: "assistant",
			content: [
				{
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: "call-1",
						name: "delegate",
						arguments: JSON.stringify({
							agent_name: "leaf",
							goal: "do something",
						}),
					},
				},
			],
		};
		const mnemonicMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Lovelace" }],
		};
		const childDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "Done." }],
		};
		const rootDoneMsg: Message = {
			role: "assistant",
			content: [{ kind: ContentKind.TEXT, text: "All done." }],
		};

		let callCount = 0;
		const capturedRequests: any[] = [];
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (request: any): Promise<Response> => {
				callCount++;
				capturedRequests.push(request);
				let msg: Message;
				if (callCount === 1) msg = delegateMsg;
				else if (callCount === 2) msg = mnemonicMsg;
				else if (callCount === 3) msg = childDoneMsg;
				else msg = rootDoneMsg;
				return {
					id: `mock-${callCount}`,
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: msg,
					finish_reason: {
						reason: callCount === 1 ? "tool_calls" : "stop",
					},
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
			events,
			usedMnemonicNames: priorNames,
		});

		await agent.run("delegate something");

		// The mnemonic generation call (call 2) should have received prior names
		const mnemonicRequest = capturedRequests[1];
		const systemMsg = mnemonicRequest?.messages?.[0];
		if (systemMsg?.content) {
			const systemText =
				typeof systemMsg.content === "string"
					? systemMsg.content
					: Array.isArray(systemMsg.content)
						? systemMsg.content.map((c: any) => c.text ?? "").join("")
						: "";
			expect(systemText).toContain("Curie");
			expect(systemText).toContain("Tesla");
		}

		// Verify the new name was added to the set
		expect(priorNames.has("Lovelace")).toBe(true);
	});
});
