import { describe, expect, test } from "bun:test";
import { renderWorkspaceTools } from "../../src/agents/plan.ts";
import type { AgentToolDefinition } from "../../src/genome/genome.ts";

describe("workspace prompt sections", () => {
	describe("renderWorkspaceTools", () => {
		test("returns empty string for no tools", () => {
			expect(renderWorkspaceTools([])).toBe("");
		});

		test("renders tools with name and description", () => {
			const tools: AgentToolDefinition[] = [
				{
					name: "lint-fix",
					description: "Run linter and auto-fix",
					interpreter: "bash",
					scriptPath: "/genome/agents/editor/tools/lint-fix",
					provenance: "genome",
				},
				{
					name: "format",
					description: "Format code with prettier",
					interpreter: "bash",
					scriptPath: "/genome/agents/editor/tools/format",
					provenance: "genome",
				},
			];
			const result = renderWorkspaceTools(tools);

			expect(result).toContain("<agent_tools>");
			expect(result).toContain("lint-fix");
			expect(result).toContain("Run linter and auto-fix");
			expect(result).toContain("format");
			expect(result).toContain("Format code with prettier");
			expect(result).toContain("</agent_tools>");
		});
	});
});
