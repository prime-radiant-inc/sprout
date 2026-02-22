import { beforeAll, describe, expect, test } from "bun:test";
import { config } from "dotenv";
import { Client } from "../../src/llm/client.ts";
import { ContentKind, messageText, type Request } from "../../src/llm/types.ts";

config();

describe("Client", () => {
	let client: Client;

	beforeAll(() => {
		client = Client.fromEnv();
	});

	test("fromEnv creates client with available providers", () => {
		const providers = client.providers();
		// At least one should be available since we have keys
		expect(providers.length).toBeGreaterThan(0);
	});

	test("fromEnv registers all three providers when keys present", () => {
		const providers = client.providers();
		expect(providers).toContain("anthropic");
		expect(providers).toContain("openai");
		expect(providers).toContain("gemini");
	});

	test("complete routes to the correct provider", async () => {
		const req: Request = {
			model: "claude-haiku-4-5-20251001",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Say hi in 3 words." }],
				},
			],
			provider: "anthropic",
			max_tokens: 50,
		};

		const resp = await client.complete(req);
		expect(resp.provider).toBe("anthropic");
		expect(messageText(resp.message).length).toBeGreaterThan(0);
	}, 15_000);

	test("complete uses default provider when provider omitted", async () => {
		const req: Request = {
			model: "claude-haiku-4-5-20251001",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Say hi." }],
				},
			],
			max_tokens: 50,
		};

		// Default provider should be the first registered
		const resp = await client.complete(req);
		expect(resp.provider).toBeTruthy();
	}, 15_000);

	test("complete throws on unknown provider", async () => {
		const req: Request = {
			model: "some-model",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Hi" }],
				},
			],
			provider: "nonexistent",
		};

		expect(client.complete(req)).rejects.toThrow();
	});

	test("stream routes to the correct provider", async () => {
		const req: Request = {
			model: "gpt-4.1-mini",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Count to 3." }],
				},
			],
			provider: "openai",
			max_tokens: 50,
		};

		const events = [];
		for await (const event of client.stream(req)) {
			events.push(event);
		}

		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		expect(events.some((e) => e.type === "finish")).toBe(true);
	}, 15_000);

	test("middleware wraps complete calls", async () => {
		let interceptedModel = "";

		const clientWithMiddleware = Client.fromEnv({
			middleware: [
				async (req, next) => {
					interceptedModel = req.model;
					return next(req);
				},
			],
		});

		await clientWithMiddleware.complete({
			model: "claude-haiku-4-5-20251001",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Hi" }],
				},
			],
			provider: "anthropic",
			max_tokens: 20,
		});

		expect(interceptedModel).toBe("claude-haiku-4-5-20251001");
	}, 15_000);

	test("middleware wraps stream calls", async () => {
		let interceptedModel = "";

		const clientWithMiddleware = Client.fromEnv({
			middleware: [
				async (req, next) => {
					interceptedModel = req.model;
					return next(req);
				},
			],
		});

		for await (const _event of clientWithMiddleware.stream({
			model: "gpt-4.1-mini",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Hi" }],
				},
			],
			provider: "openai",
			max_tokens: 20,
		})) {
			// consume events
		}

		expect(interceptedModel).toBe("gpt-4.1-mini");
	}, 15_000);

	test("middleware can transform requests for streaming", async () => {
		let transformedMaxTokens = 0;

		const clientWithMiddleware = Client.fromEnv({
			middleware: [
				async (req, next) => {
					// Transform: increase max_tokens
					const transformed = { ...req, max_tokens: 100 };
					transformedMaxTokens = transformed.max_tokens;
					return next(transformed);
				},
			],
		});

		const events = [];
		for await (const event of clientWithMiddleware.stream({
			model: "gpt-4.1-mini",
			messages: [
				{
					role: "user",
					content: [
						{ kind: ContentKind.TEXT, text: "Say hello" },
					],
				},
			],
			provider: "openai",
			max_tokens: 20,
		})) {
			events.push(event);
		}

		expect(transformedMaxTokens).toBe(100);
		expect(events.some((e) => e.type === "finish")).toBe(true);
	}, 15_000);
});
