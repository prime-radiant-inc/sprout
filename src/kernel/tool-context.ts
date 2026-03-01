import type { Genome } from "../genome/genome.ts";
import type { ExecutionEnvironment } from "./execution-env.ts";

export interface ToolContext {
	agentName: string;
	args: Record<string, unknown>;
	genome: Genome;
	env: ExecutionEnvironment;
}

export interface ToolResult {
	output: string;
	success: boolean;
	error?: string;
}
