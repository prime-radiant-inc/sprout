import type { AgentSpec } from "../../src/kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";

export function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: "test-agent",
		description: "A test agent",
		system_prompt: "You are a test agent.",
		model: "fast",
		tools: ["read_file"],
		agents: [],
		constraints: { ...DEFAULT_CONSTRAINTS },
		tags: ["test"],
		version: 1,
		...overrides,
	};
}
