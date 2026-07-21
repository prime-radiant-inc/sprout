/**
 * Workspace and genome-backed primitives: the save_* builders plus the
 * memory tools, selected per registry mode (evalMode keeps writes out).
 */
import { parse as parseYaml } from "yaml";
import type { Genome } from "../genome/genome.ts";
import { buildReadMemoryPrimitives, buildWriteMemoryPrimitives } from "../genome/memory-tools.ts";
import type { MemoryWriteAuthorization } from "../genome/memory-write-authorization.ts";
import { getToolDisplayName } from "../shared/tool-display.ts";
import type { Primitive } from "./primitives.ts";
import {
	type AgentSpec,
	normalizeAgentConstraints,
	normalizeAgentOutputConfig,
	normalizeAgentPromptCacheConfig,
	normalizeAgentSamplingConfig,
	normalizeAgentTaskPayloadConfig,
	normalizeAgentThinkingConfig,
	validateAgentName,
} from "./types.ts";

export interface GenomeContext {
	genome: Genome;
	agentName: string;
	sessionId: string;
	writeAuthorization?: MemoryWriteAuthorization;
}

/** The genome-backed primitive set for one registry: eval mode is read-only. */
export function buildGenomePrimitives(ctx: GenomeContext, evalMode: boolean): Primitive[] {
	return evalMode ? buildReadMemoryPrimitives(ctx) : buildWorkspacePrimitives(ctx);
}

function buildWorkspacePrimitives(ctx: GenomeContext): Primitive[] {
	return [
		saveToolPrimitive(ctx),
		saveFilePrimitive(ctx),
		saveAgentPrimitive(ctx),
		...buildReadMemoryPrimitives(ctx),
		...(ctx.agentName === "archivist" ? buildWriteMemoryPrimitives(ctx) : []),
	];
}

// ---------------------------------------------------------------------------
// save_tool (workspace)
// ---------------------------------------------------------------------------

function saveToolPrimitive(ctx: GenomeContext): Primitive {
	return {
		name: "save_tool",
		displayName: getToolDisplayName("save_tool"),
		description:
			"Save an executable script to your workspace. The tool persists across sessions and becomes part of your capabilities.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Tool name (used as filename, e.g. 'run-tests')" },
				description: { type: "string", description: "What this tool does" },
				script: { type: "string", description: "The script content (bash, python, node, etc.)" },
				interpreter: {
					type: "string",
					description: "Script interpreter (e.g. 'bash', 'python3', 'node'). Default: 'bash'",
				},
			},
			required: ["name", "description", "script"],
		},
		async execute(args) {
			const name = args.name as string;
			const description = args.description as string;
			const script = args.script as string | undefined;
			const interpreter = args.interpreter as string | undefined;

			if (!name || !description) {
				return {
					output: "",
					success: false,
					error: "Missing required parameters: name, description",
				};
			}
			if (!script) {
				return { output: "", success: false, error: "Missing required parameter: script" };
			}

			try {
				await ctx.genome.saveAgentTool(ctx.agentName, {
					name,
					description,
					script,
					interpreter,
				});
				return {
					output: `Saved tool '${name}' to workspace. It will be available in future sessions.`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// save_file (workspace)
// ---------------------------------------------------------------------------

function saveFilePrimitive(ctx: GenomeContext): Primitive {
	return {
		name: "save_file",
		displayName: getToolDisplayName("save_file"),
		description:
			"Save a reference file to your workspace. Files persist across sessions and can be read with read_file.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Filename (e.g. 'style-guide.md')" },
				content: { type: "string", description: "File content" },
			},
			required: ["name", "content"],
		},
		async execute(args) {
			const name = args.name as string;
			const content = args.content as string | undefined;

			if (!name) {
				return { output: "", success: false, error: "Missing required parameter: name" };
			}
			if (content === undefined || content === null) {
				return { output: "", success: false, error: "Missing required parameter: content" };
			}

			try {
				await ctx.genome.saveAgentFile(ctx.agentName, { name, content: content as string });
				return {
					output: `Saved file '${name}' to workspace.`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

function saveAgentPrimitive(ctx: GenomeContext): Primitive {
	return {
		name: "save_agent",
		displayName: getToolDisplayName("save_agent"),
		description:
			"Save a new agent definition to the genome. The agent becomes available for delegation immediately and persists across sessions.",
		parameters: {
			type: "object",
			properties: {
				spec: {
					type: "string",
					description:
						"Complete agent definition as YAML. Must include: name, description, model, system_prompt. Optional: tools, agents, constraints, sampling, output, task_payload, tags, version.",
				},
			},
			required: ["spec"],
		},
		async execute(args) {
			const spec = args.spec as string;
			if (!spec) {
				return { output: "", success: false, error: "Missing required parameter: spec" };
			}

			try {
				const raw = parseYaml(spec);

				for (const field of ["name", "description", "system_prompt", "model"]) {
					if (!raw[field] || typeof raw[field] !== "string") {
						return {
							output: "",
							success: false,
							error: `Invalid agent spec: missing or invalid '${field}'`,
						};
					}
				}

				validateAgentName(raw.name as string);

				if (raw.capabilities !== undefined) {
					return {
						output: "",
						success: false,
						error:
							"Invalid agent spec: 'capabilities' was removed; use explicit 'tools' and 'agents' fields",
					};
				}
				if (raw.requires_tool_use !== undefined) {
					return {
						output: "",
						success: false,
						error:
							"Invalid agent spec: 'requires_tool_use' belongs under 'constraints.requires_tool_use'",
					};
				}

				const tools: string[] = raw.tools ?? [];
				const agents: string[] = raw.agents ?? [];
				const source = `save_agent spec for '${raw.name as string}'`;
				const agentSpec: AgentSpec = {
					name: raw.name as string,
					description: raw.description as string,
					system_prompt: raw.system_prompt as string,
					model: raw.model as string,
					tools,
					agents,
					constraints: normalizeAgentConstraints(raw.constraints, source),
					tags: (raw.tags as string[]) ?? [],
					version: (raw.version as number) ?? 1,
				};
				if (raw.thinking !== undefined) {
					agentSpec.thinking = normalizeAgentThinkingConfig(raw.thinking, source);
				}
				if (raw.sampling !== undefined) {
					agentSpec.sampling = normalizeAgentSamplingConfig(raw.sampling, source);
				}
				if (raw.output !== undefined) {
					agentSpec.output = normalizeAgentOutputConfig(raw.output, source);
				}
				if (raw.task_payload !== undefined) {
					agentSpec.task_payload = normalizeAgentTaskPayloadConfig(raw.task_payload, source);
				}
				if (raw.prompt_cache !== undefined) {
					agentSpec.prompt_cache = normalizeAgentPromptCacheConfig(raw.prompt_cache, source);
				}

				await ctx.genome.addAgent(agentSpec);
				return {
					output: `Agent '${agentSpec.name}' saved and registered. It is available for delegation immediately.`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}
