import { describe, expect, it } from "bun:test";
import { renderCellApiTypes } from "../../src/kernel/cell-api-types";

describe("renderCellApiTypes", () => {
	it("declares every ambient value method with its worker signature", () => {
		const block = renderCellApiTypes([]);
		expect(block).toContain(
			"declare function bind(name: string, value: unknown): Promise<BoundValue>;",
		);
		expect(block).toContain("declare function publish(name: string): Promise<void>;");
		expect(block).toContain("declare function peek(name: string): Promise<string>;");
		expect(block).toContain("declare function get(name: string): Promise<string>;");
		expect(block).toContain("declare function parse(name: string): Promise<unknown>;");
		expect(block).toContain(
			"declare function slice(name: string, start: number, end: number): Promise<string>;",
		);
		expect(block).toContain(
			"declare function lines(name: string, from: number, to: number): Promise<string>;",
		);
		expect(block).toContain(
			"declare function grep(name: string, pattern: string, opts?: { maxResults?: number }): Promise<GrepResult>;",
		);
		expect(block).toContain("declare function size(name: string): Promise<number>;");
		expect(block).toContain("console");
	});

	it("declares spawn/handle with the outcome envelope shape", () => {
		const block = renderCellApiTypes([{ name: "leaf", description: "a leaf" }]);
		expect(block).toContain(
			"declare function spawn(agent: SpawnableAgent, goal: string, opts?: SpawnOptions): Promise<SpawnResult>;",
		);
		expect(block).toContain("declare function handle(id: string): Handle;");
		// Signature fidelity: the spawn contract's completed envelope.
		expect(block).toContain(
			"interface SpawnResult { ok: boolean; summary: string; bindings: BoundValue[]; handle: Handle }",
		);
		expect(block).toContain(
			"interface SpawnOptions { env?: Record<string, string>; hints?: string[]; blocking?: boolean; shared?: boolean; model?: string }",
		);
		expect(block).toContain("wait(): Promise<SpawnResult>;");
		expect(block).toContain(
			"message(text: string, opts?: { env?: Record<string, string>; blocking?: boolean }): Promise<SpawnResult>;",
		);
	});

	it("renders the SpawnableAgent union from the allowlist, one literal per agent with its description", () => {
		const block = renderCellApiTypes([
			{ name: "leaf", description: "does leaf work" },
			{ name: "engineer", description: "writes code" },
		]);
		expect(block).toContain("type SpawnableAgent =");
		expect(block).toContain('| "leaf"');
		expect(block).toContain('| "engineer"');
		expect(block).toContain("/** does leaf work */");
		expect(block).toContain("/** writes code */");
		// Honest: never lists an agent the caller can't spawn.
		expect(block).not.toContain('"reviewer"');
	});

	it("collapses multi-line agent descriptions into a single doc comment", () => {
		const block = renderCellApiTypes([{ name: "leaf", description: "line one\nline two" }]);
		expect(block).toContain("/** line one line two */");
		expect(block).not.toContain("line one\nline two");
	});

	it("renders an empty allowlist as a never union while keeping spawn declared", () => {
		const block = renderCellApiTypes([]);
		expect(block).toContain("type SpawnableAgent = never;");
		expect(block).toContain("declare function spawn(");
	});
});
