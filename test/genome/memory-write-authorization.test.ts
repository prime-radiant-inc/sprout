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
			allowedOperations: ["annotate"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "ask the archivist to annotate relevant memories with this context",
			}),
		).toBeUndefined();
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
			allowedOperations: ["archive"],
		});
		for (const userInstruction of [
			"archive memory mem_alpha00 because it is not approved",
			"archive memory mem_alpha00 unless approved",
			"do not go ahead and archive memory mem_alpha00",
			"I confirm only if memory mem_alpha00 is stale: archive it",
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
			allowedOperations: ["supersede"],
		});
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "I confirm: archive the stale memory",
			}),
		).toBeUndefined();
	});
});
