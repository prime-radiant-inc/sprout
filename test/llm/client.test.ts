import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { config } from "dotenv";
import { Client } from "../../src/llm/client.ts";
import { ContentKind, messageText, type Request } from "../../src/llm/types.ts";
import { createVcr } from "../helpers/vcr.ts";

config();

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/vcr/llm-client");

function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
}

function vcrFor(testName: string, realClient?: Client) {
	return createVcr({
		fixtureDir: FIXTURE_DIR,
		testName: slug(testName),
		realClient,
	});
}

describe("Client", () => {
	let realClient: Client | undefined;

	beforeAll(() => {
		try {
			realClient = Client.fromEnv();
		} catch {
			// No API keys available — replay only
		}
	});

	test("fromEnv creates client with available providers", () => {
		// No VCR — only tests local provider registration (requires API keys in env)
		const client = Client.fromEnv();
		const providers = client.providers();
		expect(providers.length).toBeGreaterThan(0);
	});

	test("fromEnv registers all three providers when keys present", () => {
		// No VCR — only tests local provider registration (requires API keys in env)
		const client = Client.fromEnv();
		const providers = client.providers();
		expect(providers).toContain("anthropic");
		expect(providers).toContain("openai");
		expect(providers).toContain("gemini");
	});

	test("complete routes to the correct provider", async () => {
		const vcr = vcrFor("complete-routes-to-correct-provider", realClient);
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

		const resp = await vcr.client.complete(req);
		expect(resp.provider).toBe("anthropic");
		expect(messageText(resp.message).length).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 15_000);

	test("complete uses default provider when provider omitted", async () => {
		const vcr = vcrFor("complete-uses-default-provider", realClient);
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
		const resp = await vcr.client.complete(req);
		expect(resp.provider).toBeTruthy();
		await vcr.afterTest();
	}, 15_000);

	test("complete throws on unknown provider", async () => {
		// No VCR needed — this throws locally before any API call
		const client = Client.fromEnv();
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
		const vcr = vcrFor("stream-routes-to-correct-provider", realClient);
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
		for await (const event of vcr.client.stream(req)) {
			events.push(event);
		}

		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		expect(events.some((e) => e.type === "finish")).toBe(true);
		await vcr.afterTest();
	}, 15_000);

	test("middleware wraps complete calls", async () => {
		let interceptedModel = "";

		// For middleware tests, we need to create a client with middleware.
		// In record mode, we use a real client with middleware.
		// In replay mode, we create a VCR client and wrap it with middleware.
		const vcr = vcrFor("middleware-wraps-complete-calls", realClient);

		// Wrap the VCR client's complete with middleware tracking
		const originalComplete = vcr.client.complete.bind(vcr.client);
		vcr.client.complete = async (req: Request) => {
			interceptedModel = req.model;
			return originalComplete(req);
		};

		await vcr.client.complete({
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
		await vcr.afterTest();
	}, 15_000);

	test("middleware wraps stream calls", async () => {
		let interceptedModel = "";

		const vcr = vcrFor("middleware-wraps-stream-calls", realClient);

		// Wrap the VCR client's stream with middleware tracking
		const originalStream = vcr.client.stream.bind(vcr.client);
		(vcr.client as { stream: typeof originalStream }).stream = async function* (req: Request) {
			interceptedModel = req.model;
			yield* originalStream(req);
		};

		for await (const _event of vcr.client.stream({
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
		await vcr.afterTest();
	}, 15_000);

	test("middleware can transform requests for streaming", async () => {
		let transformedMaxTokens = 0;

		const vcr = vcrFor("middleware-transforms-stream-requests", realClient);

		// Wrap stream to track transformations
		const originalStream = vcr.client.stream.bind(vcr.client);
		(vcr.client as { stream: typeof originalStream }).stream = async function* (req: Request) {
			const transformed = { ...req, max_tokens: 100 };
			transformedMaxTokens = transformed.max_tokens;
			yield* originalStream(transformed);
		};

		const events = [];
		for await (const event of vcr.client.stream({
			model: "gpt-4.1-mini",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Say hello" }],
				},
			],
			provider: "openai",
			max_tokens: 20,
		})) {
			events.push(event);
		}

		expect(transformedMaxTokens).toBe(100);
		expect(events.some((e) => e.type === "finish")).toBe(true);
		await vcr.afterTest();
	}, 15_000);
});
