import { describe, expect, test } from "bun:test";
import type { MnemonicContext } from "@/agents/mnemonic.ts";
import { generateMnemonicName } from "@/agents/mnemonic.ts";
import { Msg } from "@/llm/types.ts";

function makeMockClient(response: string) {
	return {
		complete: async (_req: any) => ({
			id: "test",
			model: "test",
			provider: "test",
			message: Msg.assistant(response),
			finish_reason: "stop" as const,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				total_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	} as any;
}

const baseContext: MnemonicContext = {
	agentName: "researcher",
	goal: "Find information about quantum computing",
	usedNames: [],
};

describe("generateMnemonicName", () => {
	test("returns the name from a clean LLM response", async () => {
		const client = makeMockClient("Turing");
		const name = await generateMnemonicName(client, "test-model", "test-provider", baseContext);
		expect(name).toBe("Turing");
	});

	test("includes used names in the system prompt", async () => {
		let capturedReq: any;
		const client = {
			complete: async (req: any) => {
				capturedReq = req;
				return {
					id: "test",
					model: "test",
					provider: "test",
					message: Msg.assistant("Feynman"),
					finish_reason: "stop" as const,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				};
			},
		} as any;

		const context: MnemonicContext = {
			...baseContext,
			usedNames: ["Turing", "Curie"],
		};

		await generateMnemonicName(client, "test-model", "test-provider", context);

		const systemContent = capturedReq.messages[0].content[0].text;
		expect(systemContent).toContain("Turing");
		expect(systemContent).toContain("Curie");
		expect(systemContent).toContain("Do NOT use any of these already-taken names");
	});

	test("appends -2 suffix when name collides with usedNames", async () => {
		const client = makeMockClient("Turing");
		const context: MnemonicContext = {
			...baseContext,
			usedNames: ["Turing"],
		};

		const name = await generateMnemonicName(client, "test-model", "test-provider", context);
		expect(name).toBe("Turing-2");
	});

	test("increments suffix when multiple collisions exist", async () => {
		const client = makeMockClient("Turing");
		const context: MnemonicContext = {
			...baseContext,
			usedNames: ["Turing", "Turing-2", "Turing-3"],
		};

		const name = await generateMnemonicName(client, "test-model", "test-provider", context);
		expect(name).toBe("Turing-4");
	});

	test("returns null when client.complete throws", async () => {
		const client = {
			complete: async () => {
				throw new Error("LLM unavailable");
			},
		} as any;

		const name = await generateMnemonicName(client, "test-model", "test-provider", baseContext);
		expect(name).toBeNull();
	});

	test("skips mnemonic generation for replay-mode VCR clients", async () => {
		let callCount = 0;
		const client = {
			__sproutVcrMode: "replay",
			complete: async () => {
				callCount++;
				return {
					id: "test",
					model: "test",
					provider: "test",
					message: Msg.assistant("Turing"),
					finish_reason: "stop" as const,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				};
			},
		} as any;

		const name = await generateMnemonicName(client, "test-model", "test-provider", baseContext);
		expect(name).toBeNull();
		expect(callCount).toBe(0);
	});

	test("extracts first word from multi-word response", async () => {
		const client = makeMockClient("Ada Lovelace");
		const name = await generateMnemonicName(client, "test-model", "test-provider", baseContext);
		expect(name).toBe("Ada");
	});

	test("returns null for empty/whitespace response", async () => {
		const client = makeMockClient("   ");
		const name = await generateMnemonicName(client, "test-model", "test-provider", baseContext);
		expect(name).toBeNull();
	});

	test("strips punctuation from response", async () => {
		const client = makeMockClient("Turing.");
		const name = await generateMnemonicName(client, "test-model", "test-provider", baseContext);
		expect(name).toBe("Turing");
	});

	test("includes description in user prompt when provided", async () => {
		let capturedReq: any;
		const client = {
			complete: async (req: any) => {
				capturedReq = req;
				return {
					id: "test",
					model: "test",
					provider: "test",
					message: Msg.assistant("Gutenberg"),
					finish_reason: "stop" as const,
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				};
			},
		} as any;

		const context: MnemonicContext = {
			...baseContext,
			description: "Formats and prints documents",
		};

		await generateMnemonicName(client, "test-model", "test-provider", context);

		const userContent = capturedReq.messages[1].content[0].text;
		expect(userContent).toContain("Formats and prints documents");
	});
});
