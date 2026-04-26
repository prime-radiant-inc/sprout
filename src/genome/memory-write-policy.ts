import type { Memory } from "../kernel/types.ts";

export type MemoryWriteOperation = "annotate" | "archive" | "link" | "consolidate";

export interface MemoryWriteAuthorizationInput {
	operation: MemoryWriteOperation;
	explicitInstruction?: boolean;
	confirmed?: boolean;
	memory?: Memory;
}

export interface MemoryWriteAuthorization {
	allowed: boolean;
	reason?: string;
}

export function authorizeMemoryWrite(
	input: MemoryWriteAuthorizationInput,
): MemoryWriteAuthorization {
	if (!input.explicitInstruction) {
		return { allowed: false, reason: "memory write requires an explicit caller instruction" };
	}
	const destructive = input.operation === "archive" || input.operation === "consolidate";
	if (destructive && isProtectedManualMemory(input.memory) && !input.confirmed) {
		return {
			allowed: false,
			reason: "user-authored/manual memories require explicit confirmation",
		};
	}
	if (destructive && !input.confirmed) {
		return {
			allowed: false,
			reason: `${input.operation} requires explicit user confirmation`,
		};
	}
	return { allowed: true };
}

function isProtectedManualMemory(memory: Memory | undefined): boolean {
	if (!memory) return false;
	return (
		memory.source === "manual" ||
		memory.source === "user" ||
		memory.source === "user:manual" ||
		memory.source.startsWith("manual:")
	);
}
