import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLogger, type LogEntry } from "../../src/host/logger.ts";
import { loggingMiddleware } from "../../src/llm/logging-middleware.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { ContentKind } from "../../src/llm/types.ts";

async function readLogEntries(path: string): Promise<LogEntry[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function makeRequest(overrides: Partial<Request> = {}): Request {
	return {
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		messages: [
			{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hello" }] },
		],
		tools: [
			{ name: "read_file", description: "Read a file", parameters: {} },
			{ name: "exec", description: "Execute command", parameters: {} },
		],
		...overrides,
	};
}

function makeResponse(overrides: Partial<Response> = {}): Response {
	return {
		id: "msg_123",
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		message: { role: "assistant", content: [{ kind: ContentKind.TEXT, text: "hi" }] },
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
		...overrides,
	};
}

describe("loggingMiddleware", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	test("logs provider, model, latency, and token counts", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mw-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "llm-client" });
		const mw = loggingMiddleware(logger);

		const response = makeResponse();
		const next = async (_req: Request) => response;

		const result = await mw(makeRequest(), next);
		await logger.flush();

		expect(result).toBe(response);

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);

		const entry = entries[0]!;
		expect(entry.level).toBe("info");
		expect(entry.category).toBe("llm");
		expect(entry.message).toBe("LLM call completed");
		expect(entry.data!.provider).toBe("anthropic");
		expect(entry.data!.model).toBe("claude-sonnet-4-6");
		expect(entry.data!.inputTokens).toBe(100);
		expect(entry.data!.outputTokens).toBe(50);
		expect(entry.data!.finishReason).toBe("stop");
		expect(entry.data!.messageCount).toBe(1);
		expect(entry.data!.toolCount).toBe(2);
		expect(typeof entry.data!.latencyMs).toBe("number");
	});

	test("logs error when adapter throws", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mw-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "llm-client" });
		const mw = loggingMiddleware(logger);

		const next = async (_req: Request): Promise<Response> => {
			throw new Error("API rate limit");
		};

		await expect(mw(makeRequest(), next)).rejects.toThrow("API rate limit");
		await logger.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);

		const entry = entries[0]!;
		expect(entry.level).toBe("error");
		expect(entry.category).toBe("llm");
		expect(entry.message).toBe("LLM call failed");
		expect(entry.data!.error).toBe("API rate limit");
		expect(typeof entry.data!.latencyMs).toBe("number");
	});
});
