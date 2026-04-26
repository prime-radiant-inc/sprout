import { describe, expect, test } from "bun:test";
import { deriveTrustedMemoryWriteAuthorization } from "../../src/genome/memory-write-authorization.ts";

describe("memory write authorization derivation", () => {
	test("does not authorize non-archivist agents", () => {
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "engineer",
				userInstruction: "annotate memory mem_alpha00 with this context",
			}),
		).toBeUndefined();
	});

	test("does not authorize read-only memory requests", () => {
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "search memories for prior SQLite decisions",
			}),
		).toBeUndefined();
		for (const userInstruction of [
			"What annotation exists on memory mem_alpha00?",
			"Does mem_alpha00 conflict with mem_beta00?",
			"How does mem_alpha00 refine memory mem_beta00?",
			"Explain whether memory mem_alpha00 contextualizes memory mem_beta00",
			"How does mem_alpha00 relate to mem_beta00?",
			"Can you explain how to annotate memory mem_alpha00?",
			"Show me how to link memory mem_alpha00 to memory mem_beta00",
			"What happens if I archive memory mem_alpha00?",
			"Whether to mark mem_alpha00 as conflicting with mem_beta00",
		]) {
			expect(
				deriveTrustedMemoryWriteAuthorization({
					agentName: "archivist",
					userInstruction,
				}),
			).toBeUndefined();
		}
	});

	test("authorizes additive memory mutations from explicit user instructions", () => {
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "annotate memory mem_alpha00 with the current SQLite decision",
			}),
		).toEqual({
			additive: true,
			allowedMemoryIds: ["mem_alpha00"],
			allowedMemoryIdsByOperation: { annotate: ["mem_alpha00"] },
			allowedOperations: ["annotate"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "ask the archivist to annotate relevant memories with this context",
			}),
		).toBeUndefined();
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "link memory mem_alpha00 to memory mem_beta00 as related",
			}),
		).toEqual({
			additive: true,
			allowedMemoryIds: ["mem_alpha00", "mem_beta00"],
			allowedMemoryIdsByOperation: { link: ["mem_alpha00", "mem_beta00"] },
			allowedOperations: ["link"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "mark mem_alpha00 as conflicting with mem_beta00",
			}),
		).toEqual({
			additive: true,
			allowedMemoryIds: ["mem_alpha00", "mem_beta00"],
			allowedMemoryIdsByOperation: { link: ["mem_alpha00", "mem_beta00"] },
			allowedOperations: ["link"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "please relate mem_alpha00 to mem_beta00",
			}),
		).toEqual({
			additive: true,
			allowedMemoryIds: ["mem_alpha00", "mem_beta00"],
			allowedMemoryIdsByOperation: { link: ["mem_alpha00", "mem_beta00"] },
			allowedOperations: ["link"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "add annotation to memory mem_alpha00 with the current decision",
			}),
		).toEqual({
			additive: true,
			allowedMemoryIds: ["mem_alpha00"],
			allowedMemoryIdsByOperation: { annotate: ["mem_alpha00"] },
			allowedOperations: ["annotate"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "can you annotate memory mem_alpha00 with the current decision",
			}),
		).toEqual({
			additive: true,
			allowedMemoryIds: ["mem_alpha00"],
			allowedMemoryIdsByOperation: { annotate: ["mem_alpha00"] },
			allowedOperations: ["annotate"],
		});
	});

	test("rejects negated additive memory mutation instructions", () => {
		for (const userInstruction of [
			"do not annotate memory mem_alpha00",
			"never link memory mem_alpha00 to memory mem_beta00",
			"without refining memory mem_alpha00, just search it",
		]) {
			expect(
				deriveTrustedMemoryWriteAuthorization({
					agentName: "archivist",
					userInstruction,
				}),
			).toBeUndefined();
		}
	});

	test("requires explicit confirmation for destructive memory mutations", () => {
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "archive memory mem_alpha00 because it is stale",
			}),
		).toBeUndefined();
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "I confirm: archive memory mem_alpha00 because it is stale",
			}),
		).toEqual({
			destructive: true,
			allowedMemoryIds: ["mem_alpha00"],
			allowedMemoryIdsByOperation: { archive: ["mem_alpha00"] },
			allowedOperations: ["archive"],
		});
		for (const userInstruction of [
			"archive memory mem_alpha00 because it is not approved",
			"archive memory mem_alpha00 unless approved",
			"do not go ahead and archive memory mem_alpha00",
			"I confirm: do not archive memory mem_alpha00",
			"I confirm: never consolidate memory mem_alpha00 with memory mem_beta00",
			"I confirm only if memory mem_alpha00 is stale: archive it",
			"I confirm: archive memory mem_alpha00 if it is stale",
			"I confirm: archive memory mem_alpha00 because it is stale if the project is active",
			"I confirm: supersede mem_old000 with memory mem_new000 provided that it is duplicate",
			"I confirm: merge memory mem_alpha00 with memory mem_beta00 until reviewed",
		]) {
			expect(
				deriveTrustedMemoryWriteAuthorization({
					agentName: "archivist",
					userInstruction,
				}),
			).toBeUndefined();
		}
	});

	test("scopes destructive authorization to referenced memory ids and operations", () => {
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "I confirm: supersede mem_old000 with memory mem_new000",
			}),
		).toEqual({
			destructive: true,
			allowedMemoryIds: ["mem_old000", "mem_new000"],
			allowedMemoryIdsByOperation: { supersede: ["mem_old000", "mem_new000"] },
			allowedOperations: ["supersede"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction:
					"I confirm: archive memory mem_alpha00 and link memory mem_beta00 to mem_gamma00",
			}),
		).toEqual({
			destructive: true,
			allowedMemoryIds: ["mem_alpha00", "mem_beta00", "mem_gamma00"],
			allowedMemoryIdsByOperation: {
				archive: ["mem_alpha00"],
				link: ["mem_beta00", "mem_gamma00"],
			},
			allowedOperations: ["link", "archive"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "I confirm: archive the stale memory",
			}),
		).toBeUndefined();
	});
});
