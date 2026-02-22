import { describe, expect, test } from "bun:test";
import { verifyActResult, verifyPrimitiveResult } from "../../src/agents/verify.ts";
import type { ActResult } from "../../src/kernel/types.ts";

describe("verifyActResult", () => {
	test("success with no stumbles returns clean result", () => {
		const actResult: ActResult = {
			agent_name: "code-editor",
			goal: "create file",
			output: "Done",
			success: true,
			stumbles: 0,
			turns: 3,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.success).toBe(true);
		expect(result.verify.stumbled).toBe(false);
		expect(result.verify.output).toBe("Done");
		expect(result.learnSignal).toBeUndefined();
	});

	test("failure generates learn signal with kind 'failure'", () => {
		const actResult: ActResult = {
			agent_name: "code-editor",
			goal: "fix bug",
			output: "Could not fix",
			success: false,
			stumbles: 0,
			turns: 10,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.success).toBe(false);
		expect(result.verify.stumbled).toBe(true);
		expect(result.learnSignal).toBeDefined();
		expect(result.learnSignal!.kind).toBe("failure");
		expect(result.learnSignal!.agent_name).toBe("code-editor");
		expect(result.learnSignal!.goal).toBe("fix bug");
		expect(result.learnSignal!.session_id).toBe("session-1");
		expect(result.learnSignal!.details).toBe(actResult);
	});

	test("success with stumbles generates learn signal with kind 'error'", () => {
		const actResult: ActResult = {
			agent_name: "command-runner",
			goal: "run tests",
			output: "Tests pass",
			success: true,
			stumbles: 3,
			turns: 8,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.success).toBe(true);
		expect(result.verify.stumbled).toBe(true);
		expect(result.learnSignal).toBeDefined();
		expect(result.learnSignal!.kind).toBe("error");
	});
});

describe("verifyPrimitiveResult", () => {
	test("success returns no stumble", () => {
		const result = verifyPrimitiveResult({ output: "ok", success: true }, "exec", "run ls");
		expect(result.stumbled).toBe(false);
	});

	test("failure returns stumble", () => {
		const result = verifyPrimitiveResult(
			{ output: "", success: false, error: "File not found" },
			"read_file",
			"read config",
		);
		expect(result.stumbled).toBe(true);
	});
});
