import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, renderEvent } from "../../src/host/cli.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";

const defaultGenomePath = join(homedir(), ".local/share/sprout-genome");

function makeEvent(kind: SessionEvent["kind"], data: Record<string, unknown> = {}): SessionEvent {
	return {
		kind,
		timestamp: Date.now(),
		agent_id: "root",
		depth: 0,
		data,
	};
}

describe("parseArgs", () => {
	test("goal string → run command with default genome path", () => {
		const result = parseArgs(["Fix the bug"]);
		expect(result).toEqual({
			kind: "run",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome list → genome-list command", () => {
		const result = parseArgs(["--genome", "list"]);
		expect(result).toEqual({
			kind: "genome-list",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome log → genome-log command", () => {
		const result = parseArgs(["--genome", "log"]);
		expect(result).toEqual({
			kind: "genome-log",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome rollback <commit> → genome-rollback command", () => {
		const result = parseArgs(["--genome", "rollback", "abc123"]);
		expect(result).toEqual({
			kind: "genome-rollback",
			genomePath: defaultGenomePath,
			commit: "abc123",
		});
	});

	test("--genome-path with goal → run with custom path", () => {
		const result = parseArgs(["--genome-path", "/custom/path", "Fix bug"]);
		expect(result).toEqual({
			kind: "run",
			goal: "Fix bug",
			genomePath: "/custom/path",
		});
	});

	test("no args → help", () => {
		const result = parseArgs([]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--help → help", () => {
		const result = parseArgs(["--help"]);
		expect(result).toEqual({ kind: "help" });
	});
});

describe("renderEvent", () => {
	test("session_start → 'Starting session...'", () => {
		const result = renderEvent(makeEvent("session_start"));
		expect(result).toBe("Starting session...");
	});

	test("act_start → formatted delegation message", () => {
		const result = renderEvent(
			makeEvent("act_start", { agent_name: "code-editor", goal: "fix the typo" }),
		);
		expect(result).toBe("\u2192 Delegating to code-editor: fix the typo");
	});

	test("act_end → formatted completion message", () => {
		const result = renderEvent(makeEvent("act_end", { agent_name: "code-editor", success: true }));
		expect(result).toBe("\u2190 code-editor: done");
	});

	test("act_end failure → formatted failure message", () => {
		const result = renderEvent(makeEvent("act_end", { agent_name: "code-editor", success: false }));
		expect(result).toBe("\u2190 code-editor: failed");
	});

	test("session_end → formatted summary", () => {
		const result = renderEvent(makeEvent("session_end", { turns: 5, stumbles: 2 }));
		expect(result).toBe("Session complete. 5 turns, 2 stumbles.");
	});

	test("perceive → null (skipped)", () => {
		const result = renderEvent(makeEvent("perceive"));
		expect(result).toBeNull();
	});

	test("recall → null (skipped)", () => {
		const result = renderEvent(makeEvent("recall"));
		expect(result).toBeNull();
	});

	test("plan_start → 'Thinking...'", () => {
		const result = renderEvent(makeEvent("plan_start"));
		expect(result).toBe("Thinking...");
	});

	test("plan_delta → null (skipped)", () => {
		const result = renderEvent(makeEvent("plan_delta"));
		expect(result).toBeNull();
	});

	test("plan_end → null (skipped)", () => {
		const result = renderEvent(makeEvent("plan_end"));
		expect(result).toBeNull();
	});

	test("primitive_start → formatted running message", () => {
		const result = renderEvent(makeEvent("primitive_start", { name: "exec" }));
		expect(result).toBe("  Running exec...");
	});

	test("primitive_end → formatted done message", () => {
		const result = renderEvent(makeEvent("primitive_end", { name: "exec", success: true }));
		expect(result).toBe("  exec: done");
	});

	test("primitive_end failure → formatted failed message", () => {
		const result = renderEvent(makeEvent("primitive_end", { name: "exec", success: false }));
		expect(result).toBe("  exec: failed");
	});

	test("verify → null (skipped)", () => {
		const result = renderEvent(makeEvent("verify"));
		expect(result).toBeNull();
	});

	test("learn_signal → null (skipped)", () => {
		const result = renderEvent(makeEvent("learn_signal"));
		expect(result).toBeNull();
	});

	test("learn_start → 'Learning from stumble...'", () => {
		const result = renderEvent(makeEvent("learn_start"));
		expect(result).toBe("Learning from stumble...");
	});

	test("learn_mutation → formatted mutation message", () => {
		const result = renderEvent(makeEvent("learn_mutation", { mutation_type: "add_memory" }));
		expect(result).toBe("  Genome updated: add_memory");
	});

	test("learn_end → null (skipped)", () => {
		const result = renderEvent(makeEvent("learn_end"));
		expect(result).toBeNull();
	});

	test("warning → formatted warning", () => {
		const result = renderEvent(makeEvent("warning", { message: "rate limit approaching" }));
		expect(result).toBe("\u26a0 rate limit approaching");
	});

	test("error → formatted error", () => {
		const result = renderEvent(makeEvent("error", { error: "connection refused" }));
		expect(result).toBe("\u2717 connection refused");
	});

	test("steering → null (skipped)", () => {
		const result = renderEvent(makeEvent("steering"));
		expect(result).toBeNull();
	});
});
