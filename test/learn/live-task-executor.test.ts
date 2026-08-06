import { describe, expect, test } from "bun:test";
import { resolveEvalDataDir } from "../../src/learn/live-task-executor.ts";

describe("resolveEvalDataDir (eval-mode isolation)", () => {
	const liveProjectDataDir = "/home/user/.local/share/sprout/projects/live";

	test("routes writes to the isolated work dir, never the live project data dir", () => {
		const workDir = "/tmp/sprout-eval-work-abc";
		const snapshotGenomePath = "/tmp/sprout-eval-snapshot-xyz";
		const dataDir = resolveEvalDataDir(workDir, snapshotGenomePath);
		expect(dataDir).toBe(workDir);
		expect(dataDir).not.toBe(liveProjectDataDir);
	});

	test("falls back to the throwaway snapshot dir when no work dir is given — still never the live dir", () => {
		const snapshotGenomePath = "/tmp/sprout-eval-snapshot-xyz";
		const dataDir = resolveEvalDataDir(undefined, snapshotGenomePath);
		expect(dataDir).toBe(snapshotGenomePath);
		expect(dataDir).not.toBe(liveProjectDataDir);
	});
});
