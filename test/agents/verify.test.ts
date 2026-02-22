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

	test("timeout signal when timed_out is true", () => {
		const actResult: ActResult = {
			agent_name: "slow-agent",
			goal: "do something",
			output: "timed out",
			success: false,
			stumbles: 0,
			turns: 50,
			timed_out: true,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.stumbled).toBe(true);
		expect(result.learnSignal).toBeDefined();
		expect(result.learnSignal!.kind).toBe("timeout");
	});

	test("failure without timed_out still generates 'failure' signal", () => {
		const actResult: ActResult = {
			agent_name: "broken-agent",
			goal: "do something",
			output: "failed",
			success: false,
			stumbles: 0,
			turns: 10,
			timed_out: false,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.learnSignal!.kind).toBe("failure");
	});

	test("inefficiency signal when success but many turns", () => {
		const actResult: ActResult = {
			agent_name: "verbose-agent",
			goal: "read a file",
			output: "done",
			success: true,
			stumbles: 0,
			turns: 15,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.stumbled).toBe(true);
		expect(result.learnSignal).toBeDefined();
		expect(result.learnSignal!.kind).toBe("inefficiency");
	});

	test("no inefficiency signal for reasonable turn count", () => {
		const actResult: ActResult = {
			agent_name: "efficient-agent",
			goal: "read a file",
			output: "done",
			success: true,
			stumbles: 0,
			turns: 5,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.stumbled).toBe(false);
		expect(result.learnSignal).toBeUndefined();
	});

	test("error signal takes priority over inefficiency when stumbles present", () => {
		const actResult: ActResult = {
			agent_name: "stumbling-agent",
			goal: "do work",
			output: "done eventually",
			success: true,
			stumbles: 2,
			turns: 15,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.stumbled).toBe(true);
		expect(result.learnSignal!.kind).toBe("error");
	});
});

describe("verifyPrimitiveResult", () => {
	test("success returns no stumble and no signal", () => {
		const result = verifyPrimitiveResult({ output: "ok", success: true }, "exec", "run ls");
		expect(result.stumbled).toBe(false);
		expect(result.learnSignal).toBeUndefined();
	});

	test("failure returns stumble", () => {
		const result = verifyPrimitiveResult(
			{ output: "", success: false, error: "File not found" },
			"read_file",
			"read config",
		);
		expect(result.stumbled).toBe(true);
	});

	test("primitive failure generates learn signal with session", () => {
		const result = verifyPrimitiveResult(
			{ output: "", success: false, error: "Permission denied" },
			"write_file",
			"save config",
			"session-1",
		);
		expect(result.stumbled).toBe(true);
		expect(result.learnSignal).toBeDefined();
		expect(result.learnSignal!.kind).toBe("error");
		expect(result.learnSignal!.agent_name).toBe("write_file");
		expect(result.learnSignal!.goal).toBe("save config");
		expect(result.learnSignal!.session_id).toBe("session-1");
	});

	test("primitive failure without session returns no signal", () => {
		const result = verifyPrimitiveResult(
			{ output: "", success: false, error: "Permission denied" },
			"write_file",
			"save config",
		);
		expect(result.stumbled).toBe(true);
		expect(result.learnSignal).toBeUndefined();
	});

	test("primitive success returns no signal even with session", () => {
		const result = verifyPrimitiveResult(
			{ output: "ok", success: true },
			"read_file",
			"read config",
			"session-1",
		);
		expect(result.stumbled).toBe(false);
		expect(result.learnSignal).toBeUndefined();
	});
});
