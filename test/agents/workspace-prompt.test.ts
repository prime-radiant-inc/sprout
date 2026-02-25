import { describe, expect, test } from "bun:test";
import {
	renderWorkspaceFiles,
	renderWorkspaceTools,
	renderWorkspaceEncouragement,
} from "../../src/agents/plan.ts";
import type { AgentFileInfo, AgentToolDefinition } from "../../src/genome/genome.ts";

describe("workspace prompt sections", () => {
	describe("renderWorkspaceFiles", () => {
		test("returns empty string for no files", () => {
			expect(renderWorkspaceFiles([], "/path/to/files")).toBe("");
		});

		test("renders files with name and size", () => {
			const files: AgentFileInfo[] = [
				{ name: "style-guide.md", size: 2300, path: "/genome/agents/editor/files/style-guide.md" },
				{ name: "config.yaml", size: 456, path: "/genome/agents/editor/files/config.yaml" },
			];
			const result = renderWorkspaceFiles(files, "/genome/agents/editor/files");

			expect(result).toContain("<agent_files>");
			expect(result).toContain("style-guide.md");
			expect(result).toContain("2.2KB");
			expect(result).toContain("config.yaml");
			expect(result).toContain("456B");
			expect(result).toContain("/genome/agents/editor/files");
			expect(result).toContain("</agent_files>");
		});
	});

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
				},
				{
					name: "format",
					description: "Format code with prettier",
					interpreter: "bash",
					scriptPath: "/genome/agents/editor/tools/format",
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

	describe("renderWorkspaceEncouragement", () => {
		test("returns encouragement text", () => {
			const result = renderWorkspaceEncouragement();
			expect(result).toContain("save_tool");
			expect(result).toContain("persist");
		});
	});
});
