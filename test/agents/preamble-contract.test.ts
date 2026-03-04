import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DELEGATE_TOOL_NAME } from "../../src/agents/plan.ts";

describe("preamble contract", () => {
	test("orchestrator preamble references the runtime delegate tool name", async () => {
		const path = join(import.meta.dir, "../../root/preambles/orchestrator.md");
		const preamble = await readFile(path, "utf-8");

		expect(preamble).toContain(`${DELEGATE_TOOL_NAME} tool`);
		expect(preamble).not.toContain("delegate_task");
	});
});
