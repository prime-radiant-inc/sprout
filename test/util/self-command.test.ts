import { describe, expect, test } from "bun:test";
import {
	buildInternalSproutCommand,
	installSproutSelfInvocationEnv,
} from "../../src/util/self-command.ts";

describe("installSproutSelfInvocationEnv", () => {
	test("records the source cli entrypoint for source-mode runs", () => {
		const env: NodeJS.ProcessEnv = {};

		installSproutSelfInvocationEnv({
			env,
			execPath: "/opt/homebrew/bin/bun",
			argv: ["/opt/homebrew/bin/bun", "/repo/src/host/cli.ts", "--prompt", "hi"],
		});

		expect(env.SPROUT_SELF_EXECUTABLE).toBe("/opt/homebrew/bin/bun");
		expect(env.SPROUT_SELF_ENTRYPOINT).toBe("/repo/src/host/cli.ts");
		expect(buildInternalSproutCommand("agent-process", env)).toEqual([
			"/opt/homebrew/bin/bun",
			"/repo/src/host/cli.ts",
			"--internal-agent-process",
		]);
	});

	test("omits a cli entrypoint for compiled binaries", () => {
		const env: NodeJS.ProcessEnv = {};

		installSproutSelfInvocationEnv({
			env,
			execPath: "/usr/local/bin/sprout",
			argv: ["/usr/local/bin/sprout", "--prompt", "hi"],
		});

		expect(env.SPROUT_SELF_EXECUTABLE).toBe("/usr/local/bin/sprout");
		expect(env.SPROUT_SELF_ENTRYPOINT).toBeUndefined();
		expect(buildInternalSproutCommand("agent-process", env)).toEqual([
			"/usr/local/bin/sprout",
			"--internal-agent-process",
		]);
	});

	test("ignores Bun's internal bunfs pseudo-entrypoint for compiled binaries", () => {
		const env: NodeJS.ProcessEnv = {};

		installSproutSelfInvocationEnv({
			env,
			execPath: "/tmp/sprout",
			argv: ["bun", "/$bunfs/root/sprout", "--prompt", "hi"],
		});

		expect(env.SPROUT_SELF_EXECUTABLE).toBe("/tmp/sprout");
		expect(env.SPROUT_SELF_ENTRYPOINT).toBeUndefined();
		expect(buildInternalSproutCommand("agent-process", env)).toEqual([
			"/tmp/sprout",
			"--internal-agent-process",
		]);
	});
});

describe("buildInternalSproutCommand", () => {
	test("throws when the current sprout invocation is unavailable", () => {
		expect(() => buildInternalSproutCommand("task-cli", {})).toThrow(
			"SPROUT_SELF_EXECUTABLE is not set",
		);
	});
});
