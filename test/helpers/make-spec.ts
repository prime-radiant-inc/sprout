import type { AgentSpec } from "../../src/kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";

export function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: overrides.name ?? "test-agent",
		description: overrides.description ?? "A test agent",
		system_prompt: overrides.system_prompt ?? "You are a test agent.",
		model: overrides.model ?? "fast",
		capabilities: overrides.capabilities ?? ["read_file"],
		constraints: overrides.constraints ?? { ...DEFAULT_CONSTRAINTS },
		tags: overrides.tags ?? ["test"],
		version: overrides.version ?? 1,
	};
}
