import { readFile, rm, writeFile } from "node:fs/promises";
import type { AgentToolDefinition, Genome } from "../genome/genome.ts";
import { getToolDisplayName } from "../shared/tool-display.ts";
import type { ExecutionEnvironment } from "./execution-env.ts";
import type { Primitive } from "./primitives.ts";
import type { ToolContext, ToolResult } from "./tool-context.ts";

/** Context required to execute sprout-internal tools. */
export interface InternalToolContext {
	genome: Genome;
	env: ExecutionEnvironment;
	agentName: string;
}

/** Extract the script body from a tool file, stripping the YAML frontmatter. */
function extractScriptBody(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const endIdx = content.indexOf("\n---\n", 4);
	if (endIdx === -1) return content;
	return content.slice(endIdx + 5); // skip past "\n---\n"
}

/** Parse a JSON string into a record, returning an empty object on failure. */
function parseJsonArgs(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/** Extract the error line number from a stack trace referencing tempPath. */
export function extractLineFromStack(err: unknown, tempPath: string): number | null {
	const stack = err instanceof Error ? err.stack : String(err);
	if (!stack) return null;
	const escaped = tempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = stack.match(new RegExp(`${escaped}:(\\d+)`));
	return match?.[1] != null ? parseInt(match[1], 10) : null;
}

/** Show source lines around a target line number, with a > marker on the target. */
export function getSourceContext(lines: string[], lineNum: number, contextSize = 2): string {
	const start = Math.max(0, lineNum - 1 - contextSize);
	const end = Math.min(lines.length, lineNum + contextSize);
	return lines
		.slice(start, end)
		.map((line, i) => {
			const num = start + i + 1;
			const marker = num === lineNum ? ">" : " ";
			return `${marker} ${String(num).padStart(4)} | ${line}`;
		})
		.join("\n");
}

/** Format an import-time error with tool name, message, and optional source context. */
export function formatImportError(
	toolName: string,
	err: unknown,
	scriptLines: string[],
	tempPath: string,
): string {
	const message = err instanceof Error ? err.message : String(err);
	const line = extractLineFromStack(err, tempPath);
	const parts = [`Tool '${toolName}' failed to load: ${message}`];
	if (line !== null) {
		parts.push("", getSourceContext(scriptLines, line));
	}
	return parts.join("\n");
}

/** Format a runtime error with tool name and stack trace cleaned of temp paths. */
export function formatRuntimeError(
	toolName: string,
	err: unknown,
	tempPath: string,
	originalPath: string,
): string {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;
	const parts = [`Tool '${toolName}' threw an error: ${message}`];
	if (stack) {
		const cleaned = stack.replaceAll(tempPath, originalPath);
		parts.push("", cleaned);
	}
	return parts.join("\n");
}

/** Execute a sprout-internal tool by dynamically importing its script. */
async function executeInternalTool(
	tool: AgentToolDefinition,
	toolCtx: ToolContext,
): Promise<{ output: string; success: boolean; error?: string }> {
	const fileContent = await readFile(tool.scriptPath, "utf-8");
	const script = extractScriptBody(fileContent);
	const scriptLines = script.split("\n");

	// Write to a temp .ts file for dynamic import (random suffix avoids collisions)
	const tempPath = `${tool.scriptPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.ts`;
	await writeFile(tempPath, script);
	try {
		// Phase 1: Import the module
		let mod: Record<string, unknown>;
		try {
			mod = await import(tempPath);
		} catch (importErr) {
			return {
				output: "",
				success: false,
				error: formatImportError(tool.name, importErr, scriptLines, tempPath),
			};
		}

		// Phase 2: Check for default export
		if (typeof mod.default !== "function") {
			return {
				output: "",
				success: false,
				error: `Tool '${tool.name}' does not export a default function`,
			};
		}

		// Phase 3: Execute the tool
		try {
			const result: ToolResult = await mod.default(toolCtx);
			return {
				output: result?.output ?? "",
				success: result?.success ?? false,
				error: result?.error,
			};
		} catch (runtimeErr) {
			return {
				output: "",
				success: false,
				error: formatRuntimeError(tool.name, runtimeErr, tempPath, tool.scriptPath),
			};
		}
	} finally {
		await rm(tempPath).catch(() => {});
	}
}

/**
 * Build Primitive instances from loaded agent tool definitions.
 * Each tool becomes a primitive that executes its script using the specified interpreter.
 *
 * For `sprout-internal` tools, an InternalToolContext is required so the tool module
 * can access the genome, execution environment, and agent name.
 */
export function buildAgentToolPrimitives(
	tools: AgentToolDefinition[],
	ctx?: InternalToolContext,
): Primitive[] {
	return tools.map((tool) => ({
		name: tool.name,
		displayName: getToolDisplayName(tool.name, tool.displayName),
		description: tool.description,
		parameters: {
			type: "object",
			properties: {
				args: {
					type: "string",
					description: "Arguments to pass to the tool",
				},
			},
		},
		async execute(args: Record<string, unknown>, env: ExecutionEnvironment) {
			const toolArgs = (args.args as string) ?? "";

			if (tool.interpreter === "sprout-internal") {
				if (!ctx) {
					return {
						output: "",
						success: false,
						error: "sprout-internal tools require an InternalToolContext",
					};
				}

				const toolCtx: ToolContext = {
					agentName: ctx.agentName,
					args: parseJsonArgs(toolArgs),
					genome: ctx.genome,
					env: ctx.env,
				};

				try {
					return await executeInternalTool(tool, toolCtx);
				} catch (err) {
					return { output: "", success: false, error: String(err) };
				}
			}

			try {
				// Read the tool file and strip YAML frontmatter
				const fileContent = await readFile(tool.scriptPath, "utf-8");
				const script = extractScriptBody(fileContent);

				// Execute via: echo script | SPROUT_TOOL_DIR=<dir> interpreter /dev/stdin args
				// SPROUT_TOOL_DIR lets scripts find sibling files (since BASH_SOURCE/$0 = /dev/stdin)
				const escapedScript = script.replace(/'/g, "'\\''");
				const toolDir = tool.scriptPath.replace(/\/[^/]+$/, "");
				const envPrefix = `SPROUT_TOOL_DIR='${toolDir}'`;
				const command = toolArgs
					? `echo '${escapedScript}' | ${envPrefix} ${tool.interpreter} /dev/stdin ${toolArgs}`
					: `echo '${escapedScript}' | ${envPrefix} ${tool.interpreter} /dev/stdin`;

				const result = await env.exec_command(command, { timeout_ms: 30_000 });
				const output = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ""]
					.filter(Boolean)
					.join("\n");

				return {
					output,
					success: result.exit_code === 0 && !result.timed_out,
					error:
						result.exit_code !== 0
							? `Tool exited with code ${result.exit_code}`
							: result.timed_out
								? "Tool timed out"
								: undefined,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	}));
}
