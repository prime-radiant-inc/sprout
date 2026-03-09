import { describe, expect, test } from "bun:test";
import { extractUsedMnemonicNames } from "@/host/cli-resume.ts";
import type { SessionEvent } from "@/kernel/types.ts";

describe("extractUsedMnemonicNames", () => {
	test("returns empty set when no events", () => {
		const result = extractUsedMnemonicNames([]);
		expect(result).toBeInstanceOf(Set);
		expect(result.size).toBe(0);
	});

	test("extracts mnemonic_name from act_start events", () => {
		const events: SessionEvent[] = [
			{
				kind: "act_start",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: { agent_name: "reader", goal: "read file", child_id: "abc", mnemonic_name: "Curie" },
			},
			{
				kind: "act_start",
				timestamp: 2000,
				agent_id: "root",
				depth: 0,
				data: { agent_name: "editor", goal: "edit file", child_id: "def", mnemonic_name: "Turing" },
			},
		];
		const result = extractUsedMnemonicNames(events);
		expect(result.size).toBe(2);
		expect(result.has("Curie")).toBe(true);
		expect(result.has("Turing")).toBe(true);
	});

	test("ignores act_start events without mnemonic_name", () => {
		const events: SessionEvent[] = [
			{
				kind: "act_start",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: { agent_name: "reader", goal: "read file", child_id: "abc" },
			},
			{
				kind: "act_start",
				timestamp: 2000,
				agent_id: "root",
				depth: 0,
				data: { agent_name: "editor", goal: "edit file", child_id: "def", mnemonic_name: "Turing" },
			},
		];
		const result = extractUsedMnemonicNames(events);
		expect(result.size).toBe(1);
		expect(result.has("Turing")).toBe(true);
	});

	test("ignores non-act_start events", () => {
		const events: SessionEvent[] = [
			{
				kind: "act_start",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: { agent_name: "reader", goal: "read", child_id: "abc", mnemonic_name: "Curie" },
			},
			{
				kind: "act_end",
				timestamp: 2000,
				agent_id: "root",
				depth: 0,
				data: { agent_name: "reader", success: true, child_id: "abc", mnemonic_name: "Curie" },
			},
			{
				kind: "primitive_start",
				timestamp: 3000,
				agent_id: "root",
				depth: 0,
				data: { name: "read_file" },
			},
		];
		const result = extractUsedMnemonicNames(events);
		expect(result.size).toBe(1);
		expect(result.has("Curie")).toBe(true);
	});

	test("deduplicates mnemonic names", () => {
		const events: SessionEvent[] = [
			{
				kind: "act_start",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: { agent_name: "reader", goal: "read", child_id: "abc", mnemonic_name: "Curie" },
			},
			{
				kind: "act_start",
				timestamp: 2000,
				agent_id: "child1",
				depth: 1,
				data: { agent_name: "reader", goal: "read", child_id: "def", mnemonic_name: "Curie" },
			},
		];
		const result = extractUsedMnemonicNames(events);
		expect(result.size).toBe(1);
		expect(result.has("Curie")).toBe(true);
	});

	test("collects names from events at different depths", () => {
		const events: SessionEvent[] = [
			{
				kind: "act_start",
				timestamp: 1000,
				agent_id: "root",
				depth: 0,
				data: { agent_name: "reader", goal: "read", child_id: "abc", mnemonic_name: "Curie" },
			},
			{
				kind: "act_start",
				timestamp: 2000,
				agent_id: "child1",
				depth: 1,
				data: { agent_name: "editor", goal: "edit", child_id: "def", mnemonic_name: "Turing" },
			},
			{
				kind: "act_start",
				timestamp: 3000,
				agent_id: "child2",
				depth: 2,
				data: { agent_name: "runner", goal: "run", child_id: "ghi", mnemonic_name: "Lovelace" },
			},
		];
		const result = extractUsedMnemonicNames(events);
		expect(result.size).toBe(3);
		expect(result.has("Curie")).toBe(true);
		expect(result.has("Turing")).toBe(true);
		expect(result.has("Lovelace")).toBe(true);
	});
});
