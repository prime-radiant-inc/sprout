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
		).toEqual({ additive: true });
	});

	test("requires explicit confirmation for destructive memory mutations", () => {
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "archive memory mem_alpha00 because it is stale",
			}),
		).toEqual({ additive: true });
		expect(
			deriveTrustedMemoryWriteAuthorization({
				agentName: "archivist",
				userInstruction: "I confirm: archive memory mem_alpha00 because it is stale",
			}),
		).toEqual({ destructive: true });
	});
});
