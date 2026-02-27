import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogEntry, NullLogger, SessionLogger } from "../../src/host/logger.ts";

async function readLogEntries(path: string): Promise<LogEntry[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("SessionLogger", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	test("writes log entries as JSON-L to disk", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "test" });

		logger.info("system", "hello world", { key: "value" });
		await logger.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.level).toBe("info");
		expect(entries[0]!.category).toBe("system");
		expect(entries[0]!.message).toBe("hello world");
		expect(entries[0]!.component).toBe("test");
		expect(entries[0]!.data).toEqual({ key: "value" });
		expect(entries[0]!.timestamp).toBeGreaterThan(0);
	});

	test("child logger inherits and merges parent context", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const parent = new SessionLogger({
			logPath,
			component: "parent",
			sessionId: "sess-1",
		});
		const child = parent.child({ component: "child", agentId: "agent-1", depth: 2 });

		child.info("agent", "child log");
		await parent.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.component).toBe("child");
		expect(entries[0]!.sessionId).toBe("sess-1");
		expect(entries[0]!.agentId).toBe("agent-1");
		expect(entries[0]!.depth).toBe(2);
	});

	test("writes all log levels to disk", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "test" });

		logger.debug("llm", "debug msg");
		logger.info("llm", "info msg");
		logger.warn("llm", "warn msg");
		logger.error("llm", "error msg");
		await logger.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(4);
		expect(entries.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
	});

	test("creates log directory lazily", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "nested", "deep", "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "test" });

		logger.info("system", "first write");
		await logger.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);
	});

	test("never throws on write failure", async () => {
		const logger = new SessionLogger({
			logPath: "/dev/null/impossible/path/log.jsonl",
			component: "test",
		});

		// Should not throw
		logger.error("system", "this will fail to write");
		await logger.flush();
	});

	test("forwards info+ entries to bus when configured", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
		const fakeBus = {
			emitEvent(kind: string, _agentId: string, _depth: number, data: Record<string, unknown>) {
				emitted.push({ kind, data });
			},
		};

		const logger = new SessionLogger({
			logPath,
			component: "test",
			bus: fakeBus as any,
		});

		logger.debug("llm", "should not forward");
		logger.info("llm", "should forward");
		logger.warn("llm", "should also forward");
		await logger.flush();

		expect(emitted).toHaveLength(2);
		expect(emitted[0]!.kind).toBe("log");
		expect((emitted[0]!.data as any).level).toBe("info");
		expect((emitted[1]!.data as any).level).toBe("warn");
	});
});

describe("NullLogger", () => {
	test("NullLogger methods are no-ops", async () => {
		const logger = new NullLogger();
		logger.debug("system", "noop");
		logger.info("system", "noop");
		logger.warn("system", "noop");
		logger.error("system", "noop");
		const child = logger.child({ component: "x" });
		expect(child).toBe(logger);
		await logger.flush();
	});
});
