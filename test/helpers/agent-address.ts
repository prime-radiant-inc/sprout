import type { AgentAddress } from "../../src/bus/types.ts";

export function addr(
	agentName: string,
	depth: number,
	role?: "observer",
	handleId = agentName,
	agentId = handleId,
): AgentAddress {
	return {
		agentName,
		depth,
		handleId,
		agentId,
		...(role ? { role } : {}),
	};
}
