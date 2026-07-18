import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JournalRecord, parseJournalRecord, SessionJournal } from "../../src/store/journal.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "journal-test-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const bindInline: JournalRecord = {
	kind: "bind",
	ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	name: "failing_tests",
	scope: "scope-1",
	type: "text",
	size: 12,
	provenance: { agentHandleId: "h-child", origin: { kind: "cell" } },
	preview: "text 12B: hello world!",
	explicit: true,
	createdAt: 1_752_800_000_000,
	body: { inline: "hello world!" },
};

const bindCas: JournalRecord = {
	kind: "bind",
	ulid: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
	name: "big_log",
	scope: "scope-1",
	type: "bytes",
	size: 200_000_000,
	provenance: {
		agentHandleId: "h-root",
		origin: { kind: "primitive", name: "exec", argsSummary: "bun test" },
	},
	preview: "bytes 200MB",
	explicit: false,
	createdAt: 1_752_800_000_001,
	body: { cas: "a".repeat(64) },
};

const scopeRec: JournalRecord = {
	kind: "scope",
	scopeId: "scope-2",
	ownerHandleId: "h-child",
	parentScopeId: "scope-1",
};

const publishRec: JournalRecord = {
	kind: "publish",
	handle: "h-child",
	ulids: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
	seq: 3,
};

const deliveryRec: JournalRecord = {
	kind: "manifest_delivery",
	handle: "h-child",
	recipient: "h-root",
	throughPublishSeq: 3,
};

const grantRec: JournalRecord = {
	kind: "grant",
	granter: "h-root",
	recipient: "h-child",
	name: "schema",
	ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
};

const cellRec: JournalRecord = {
	kind: "cell",
	handle: "h-child",
	code: "bind('x', peek('y'))",
	bindings: [{ name: "x", ulid: "01ARZ3NDEKTSV4RRFFQ69G5FB1" }],
	computeTimeMs: 42,
};

const cellErrorRec: JournalRecord = {
	kind: "cell",
	handle: "h-child",
	code: "throw new Error('boom')",
	bindings: [],
	error: "boom",
	computeTimeMs: 5,
};

const allKinds: JournalRecord[] = [
	bindInline,
	bindCas,
	scopeRec,
	publishRec,
	deliveryRec,
	grantRec,
	cellRec,
	cellErrorRec,
];

describe("SessionJournal append/replay", () => {
	test("roundtrips every record kind", async () => {
		const journal = new SessionJournal(join(dir, "session.jsonl"));
		for (const rec of allKinds) {
			await journal.append(rec);
		}
		expect(await journal.replay()).toEqual(allKinds);
	});

	test("creates parent directories on first append", async () => {
		const journal = new SessionJournal(join(dir, "a", "b", "session.jsonl"));
		await journal.append(scopeRec);
		expect(await journal.replay()).toEqual([scopeRec]);
	});

	test("multi-record append lands contiguously in order", async () => {
		const journal = new SessionJournal(join(dir, "session.jsonl"));
		await journal.append([deliveryRec, bindInline, bindCas]);
		await journal.append(publishRec);
		expect(await journal.replay()).toEqual([deliveryRec, bindInline, bindCas, publishRec]);
	});

	test("missing file replays to empty array", async () => {
		const journal = new SessionJournal(join(dir, "nope.jsonl"));
		expect(await journal.replay()).toEqual([]);
	});

	test("trailing partial line is skipped silently", async () => {
		const path = join(dir, "session.jsonl");
		const journal = new SessionJournal(path);
		await journal.append([scopeRec, publishRec]);
		// Simulate a crash mid-append: a truncated JSON fragment with no newline.
		await appendFile(path, '{"kind":"bind","ulid":"01ARZ');
		expect(await journal.replay()).toEqual([scopeRec, publishRec]);
	});

	test("malformed middle line followed by valid lines throws with line number", async () => {
		const path = join(dir, "session.jsonl");
		const journal = new SessionJournal(path);
		await journal.append(scopeRec);
		await appendFile(path, "not json at all\n");
		await appendFile(path, `${JSON.stringify(publishRec)}\n`);
		await expect(journal.replay()).rejects.toThrow(/line 2/);
	});

	test("well-formed JSON that is not a journal record throws with line number", async () => {
		const path = join(dir, "session.jsonl");
		const journal = new SessionJournal(path);
		await journal.append(scopeRec);
		await appendFile(path, '{"kind":"mystery"}\n');
		await appendFile(path, `${JSON.stringify(publishRec)}\n`);
		await expect(journal.replay()).rejects.toThrow(/line 2/);
	});

	test("appends across two instances on the same path accumulate", async () => {
		const path = join(dir, "session.jsonl");
		await new SessionJournal(path).append(scopeRec);
		await new SessionJournal(path).append(publishRec);
		expect(await new SessionJournal(path).replay()).toEqual([scopeRec, publishRec]);
	});
});

describe("parseJournalRecord", () => {
	test("accepts every record kind", () => {
		for (const rec of allKinds) {
			expect(parseJournalRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
		}
	});

	test("rejects non-objects and unknown kinds", () => {
		expect(() => parseJournalRecord(null)).toThrow();
		expect(() => parseJournalRecord("bind")).toThrow();
		expect(() => parseJournalRecord({ kind: "mystery" })).toThrow();
		expect(() => parseJournalRecord({})).toThrow();
	});

	test("rejects a bind body with both inline and cas", () => {
		expect(() =>
			parseJournalRecord({ ...bindInline, body: { inline: "x", cas: "a".repeat(64) } }),
		).toThrow(/body/);
	});

	test("rejects a bind body with neither inline nor cas", () => {
		expect(() => parseJournalRecord({ ...bindInline, body: {} })).toThrow(/body/);
	});

	test("rejects an inline body at or over the 64 KB inline threshold", () => {
		expect(() => parseJournalRecord({ ...bindInline, size: 65536 })).toThrow(/inline/);
	});

	test("rejects a cas ref that is not a hex sha256", () => {
		expect(() => parseJournalRecord({ ...bindCas, body: { cas: "xyz" } })).toThrow(/cas/);
	});

	test("rejects field type mismatches with field-named errors", () => {
		expect(() => parseJournalRecord({ ...bindInline, size: "12" })).toThrow(/size/);
		expect(() => parseJournalRecord({ ...publishRec, ulids: "x" })).toThrow(/ulids/);
		expect(() => parseJournalRecord({ ...publishRec, ulids: [1] })).toThrow(/ulids/);
		expect(() => parseJournalRecord({ ...deliveryRec, throughPublishSeq: null })).toThrow(
			/throughPublishSeq/,
		);
		expect(() => parseJournalRecord({ ...cellRec, bindings: [{ name: "x" }] })).toThrow(/bindings/);
		expect(() => parseJournalRecord({ ...scopeRec, parentScopeId: 7 })).toThrow(/parentScopeId/);
		expect(() => parseJournalRecord({ ...grantRec, name: 7 })).toThrow(/name/);
	});
});
