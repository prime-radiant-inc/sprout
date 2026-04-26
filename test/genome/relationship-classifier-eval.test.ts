import { describe, expect, test } from "bun:test";
import { loadRelationshipClassificationPrompt } from "../../src/genome/prompts.ts";
import {
	classifyMemoryRelationship,
	normalizeRelationshipClassificationPayload,
	renderRelationshipClassificationUserPrompt,
} from "../../src/genome/relationship-classifier.ts";
import type { Memory, RelationshipType } from "../../src/kernel/types.ts";
import { Client } from "../../src/llm/client.ts";

type ClassifierRelationshipType = Exclude<RelationshipType, "extraction_ref">;

interface RelationshipFixtureRow {
	id: string;
	source: string;
	target: string;
	relationship_type: ClassifierRelationshipType;
	reason: string;
	recorded_output?: string | Record<string, unknown>;
}

const FIXTURE_URL = new URL("../fixtures/memory/relationship-pairs.jsonl", import.meta.url);

const CLASSIFIER_RELATIONSHIP_TYPES = [
	"corroborates",
	"conflicts",
	"supersedes",
	"refines",
	"precedes",
	"contextualizes",
	"exemplifies",
	"null",
] as const satisfies readonly ClassifierRelationshipType[];

const MINIMUM_COUNTS: Record<ClassifierRelationshipType, number> = {
	conflicts: 5,
	supersedes: 5,
	corroborates: 5,
	refines: 5,
	precedes: 5,
	contextualizes: 5,
	exemplifies: 5,
	null: 10,
};

const liveEvalTest = process.env.SPROUT_LIVE_RELATIONSHIP_EVAL === "1" ? test : test.skip;

describe("relationship classifier eval fixture", () => {
	test("contains exactly 50 labeled examples and keeps extraction_ref system-generated", async () => {
		const rows = await loadRelationshipFixtureRows();
		const ids = new Set(rows.map((row) => row.id));
		const counts = countRelationshipTypes(rows);

		expect(rows).toHaveLength(50);
		expect(ids.size).toBe(rows.length);
		expect(
			(CLASSIFIER_RELATIONSHIP_TYPES as readonly RelationshipType[]).includes("extraction_ref"),
		).toBe(false);
		for (const type of CLASSIFIER_RELATIONSHIP_TYPES) {
			expect(counts[type]).toBeGreaterThanOrEqual(MINIMUM_COUNTS[type]);
		}
	});

	test("renders each labeled pair into the classifier prompt", async () => {
		const rows = await loadRelationshipFixtureRows();
		for (const [index, row] of rows.entries()) {
			const source = fixtureMemory(`${row.id}:source`, row.source, index);
			const target = fixtureMemory(`${row.id}:target`, row.target, index);
			const prompt = renderRelationshipClassificationUserPrompt(source, target, {
				source_id: source.id,
				target_id: target.id,
				axes: ["tfidf"],
				score: 1,
				extraction_bond: row.reason,
			});

			expect(prompt).toContain("NEW MEMORY");
			expect(prompt).toContain("EXISTING MEMORY");
			expect(prompt).toContain(row.source);
			expect(prompt).toContain(row.target);
			expect(prompt).toContain(row.reason);
			expect(relationshipTypesLine(prompt)).not.toContain("extraction_ref");
		}
	});

	test("normalizes recorded classifier outputs when fixture rows include them", async () => {
		const rows = await loadRelationshipFixtureRows();
		const rowsWithRecordedOutputs = rows.filter((row) => row.recorded_output !== undefined);

		if (rowsWithRecordedOutputs.length === 0) {
			expect(rowsWithRecordedOutputs).toHaveLength(0);
			return;
		}

		for (const row of rowsWithRecordedOutputs) {
			const payload =
				typeof row.recorded_output === "string"
					? row.recorded_output
					: JSON.stringify(row.recorded_output);
			const result = normalizeRelationshipClassificationPayload(
				payload,
				`${row.id}:source`,
				`${row.id}:target`,
			);

			expect(result.relationship_type).toBe(row.relationship_type);
			expect(result.reasoning.length).toBeGreaterThan(0);
		}
	});

	liveEvalTest(
		"live classifier agrees with the fixture labels at 80 percent or better",
		async () => {
			const rows = await loadRelationshipFixtureRows();
			const client = Client.fromEnv();
			const { provider, model } = await selectLiveModel(client);
			const prompt = await loadRelationshipClassificationPrompt(process.cwd(), "root");
			let correct = 0;
			const mismatches: string[] = [];

			for (const [index, row] of rows.entries()) {
				const result = await classifyMemoryRelationship({
					source: fixtureMemory(`${row.id}:source`, row.source, index),
					target: fixtureMemory(`${row.id}:target`, row.target, index),
					prompt,
					client,
					provider,
					model,
				});

				if (result.relationship_type === row.relationship_type) {
					correct += 1;
				} else {
					mismatches.push(
						`${row.id}: expected ${row.relationship_type}, got ${result.relationship_type}`,
					);
				}
			}

			const agreement = correct / rows.length;
			if (agreement < 0.8) {
				throw new Error(
					`Relationship classifier agreement ${agreement.toFixed(3)} was below 0.800. ` +
						`First mismatches: ${mismatches.slice(0, 10).join("; ")}`,
				);
			}
			expect(agreement).toBeGreaterThanOrEqual(0.8);
		},
	);
});

async function loadRelationshipFixtureRows(): Promise<RelationshipFixtureRow[]> {
	const text = await Bun.file(FIXTURE_URL).text();
	return text
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line, index) => parseRelationshipFixtureRow(line, index + 1));
}

function parseRelationshipFixtureRow(line: string, lineNumber: number): RelationshipFixtureRow {
	const parsed: unknown = JSON.parse(line);
	if (!isRecord(parsed)) {
		throw new Error(`Relationship fixture line ${lineNumber} must be an object`);
	}

	const id = readRequiredString(parsed, "id", lineNumber);
	const source = readRequiredString(parsed, "source", lineNumber);
	const target = readRequiredString(parsed, "target", lineNumber);
	const reason = readRequiredString(parsed, "reason", lineNumber);
	const rawRelationshipType = readRequiredString(parsed, "relationship_type", lineNumber);
	if (!isClassifierRelationshipType(rawRelationshipType)) {
		throw new Error(
			`Relationship fixture line ${lineNumber} has unsupported type '${rawRelationshipType}'`,
		);
	}

	const recordedOutput = parsed.recorded_output;
	if (
		recordedOutput !== undefined &&
		typeof recordedOutput !== "string" &&
		!isRecord(recordedOutput)
	) {
		throw new Error(`Relationship fixture line ${lineNumber} has invalid recorded_output`);
	}

	return {
		id,
		source,
		target,
		relationship_type: rawRelationshipType,
		reason,
		...(recordedOutput !== undefined ? { recorded_output: recordedOutput } : {}),
	};
}

function countRelationshipTypes(
	rows: readonly RelationshipFixtureRow[],
): Record<ClassifierRelationshipType, number> {
	const counts = Object.fromEntries(
		CLASSIFIER_RELATIONSHIP_TYPES.map((type) => [type, 0]),
	) as Record<ClassifierRelationshipType, number>;
	for (const row of rows) {
		counts[row.relationship_type] += 1;
	}
	return counts;
}

function fixtureMemory(id: string, content: string, index: number): Memory {
	const created = Date.UTC(2026, 3, 26, 12, 0, index);
	return {
		id,
		content,
		tags: ["relationship-fixture"],
		source: "test:relationship-fixture",
		created,
		last_used: created,
		use_count: 0,
		confidence: 0.8,
	};
}

function relationshipTypesLine(prompt: string): string {
	const line = prompt.split("\n").find((entry) => entry.startsWith("Relationship types:"));
	if (!line) throw new Error("Relationship classifier prompt missing relationship type list");
	return line;
}

async function selectLiveModel(client: Client): Promise<{ provider: string; model: string }> {
	const requestedProvider = process.env.SPROUT_RELATIONSHIP_EVAL_PROVIDER?.trim();
	const requestedModel = process.env.SPROUT_RELATIONSHIP_EVAL_MODEL?.trim();
	const modelsByProvider = await client.listModelsByProvider();

	if (requestedProvider) {
		const model = requestedModel || modelsByProvider.get(requestedProvider)?.[0]?.id;
		if (!model) {
			throw new Error(
				`No model available for requested provider '${requestedProvider}'. ` +
					"Set SPROUT_RELATIONSHIP_EVAL_MODEL.",
			);
		}
		return { provider: requestedProvider, model };
	}

	for (const provider of client.providers()) {
		const model = requestedModel || modelsByProvider.get(provider)?.[0]?.id;
		if (model) return { provider, model };
	}

	throw new Error(
		"No LLM provider/model available for live relationship eval. " +
			"Set an API key or SPROUT_RELATIONSHIP_EVAL_PROVIDER and SPROUT_RELATIONSHIP_EVAL_MODEL.",
	);
}

function readRequiredString(
	record: Record<string, unknown>,
	key: string,
	lineNumber: number,
): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Relationship fixture line ${lineNumber} missing string '${key}'`);
	}
	return value;
}

function isClassifierRelationshipType(value: string): value is ClassifierRelationshipType {
	return (CLASSIFIER_RELATIONSHIP_TYPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
