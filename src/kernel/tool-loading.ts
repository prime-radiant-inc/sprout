import { readFile } from "node:fs/promises";
import type { AgentToolDefinition } from "../genome/genome.ts";
import type { ExecutionEnvironment } from "./execution-env.ts";
import type { Primitive } from "./primitives.ts";

/** Extract the script body from a tool file, stripping the YAML frontmatter. */
function extractScriptBody(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const endIdx = content.indexOf("\n---\n", 4);
	if (endIdx === -1) return content;
	return content.slice(endIdx + 5); // skip past "\n---\n"
}

/**
 * Build Primitive instances from loaded agent tool definitions.
 * Each tool becomes a primitive that executes its script using the specified interpreter.
 */
export function buildAgentToolPrimitives(tools: AgentToolDefinition[]): Primitive[] {
	return tools.map((tool) => ({
		name: tool.name,
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

			try {
				// Read the tool file and strip YAML frontmatter
				const fileContent = await readFile(tool.scriptPath, "utf-8");
				const script = extractScriptBody(fileContent);

				// Execute via: echo script | interpreter - args
				// Using a heredoc approach for reliable passing
				const escapedScript = script.replace(/'/g, "'\\''");
				const command = toolArgs
					? `echo '${escapedScript}' | ${tool.interpreter} /dev/stdin ${toolArgs}`
					: `echo '${escapedScript}' | ${tool.interpreter} /dev/stdin`;

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
