import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store/cas";
import { SessionJournal } from "../../src/store/journal";
import { SapStore, type SapStoreOptions } from "../../src/store/store";
import type { ValueProvenance } from "../../src/store/value";

const ROOT_SCOPE = "scope_root";

const prov = (agentHandleId = "agent_a"): ValueProvenance => ({
	agentHandleId,
	origin: { kind: "cell" },
});

describe("SapStore", () => {
	let dir: string;
	let journal: SessionJournal;
	let cas: ContentStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sap-store-"));
		journal = new SessionJournal(join(dir, "journal.jsonl"));
		cas = new ContentStore(join(dir, "cas"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function makeStore(options: Partial<SapStoreOptions> = {}): SapStore {
		return new SapStore({ journal, cas, rootScopeId: ROOT_SCOPE, options });
	}

	describe("bind and read roundtrip", () => {
		it("roundtrips a text value", async () => {
			const store = makeStore();
			const meta = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "notes",
				content: "hello\nworld",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			expect(meta.name).toBe("notes");
			expect(meta.scopeId).toBe(ROOT_SCOPE);
			expect(meta.type).toBe("text");
			expect(meta.size).toBe(11);
			expect(meta.createdAt).toBeGreaterThan(0);
			expect(meta.preview).toContain("text · 11 bytes");
			const bytes = await store.get(ROOT_SCOPE, "notes", { maxBytes: 1024 });
			expect(new TextDecoder().decode(bytes)).toBe("hello\nworld");
			// Also readable by ulid.
			const byUlid = await store.get(ROOT_SCOPE, meta.ulid, { maxBytes: 1024 });
			expect(byUlid).toEqual(bytes);
		});

		it("roundtrips a json value", async () => {
			const store = makeStore();
			const meta = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "config",
				content: '{"a":1,"b":2}',
				type: "json",
				provenance: prov(),
				explicit: true,
			});
			expect(meta.preview).toContain("json");
			expect(meta.preview).toContain("a, b");
			const bytes = await store.get(ROOT_SCOPE, "config", { maxBytes: 1024 });
			expect(new TextDecoder().decode(bytes)).toBe('{"a":1,"b":2}');
		});

		it("roundtrips a bytes value", async () => {
			const store = makeStore();
			const body = new Uint8Array([0, 1, 2, 255, 254]);
			const meta = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "blob",
				content: body,
				type: "bytes",
				provenance: prov(),
				explicit: true,
			});
			expect(meta.preview).toContain("bytes · 5 bytes");
			expect(await store.get(ROOT_SCOPE, "blob", { maxBytes: 1024 })).toEqual(body);
		});

		it("metadata() returns the full metadata by name and by ulid", async () => {
			const store = makeStore();
			const meta = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "m",
				content: "x",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			expect(await store.metadata(ROOT_SCOPE, "m")).toEqual(meta);
			expect(await store.metadata(ROOT_SCOPE, meta.ulid)).toEqual(meta);
		});

		it("throws for an unknown ref and an unknown scope", async () => {
			const store = makeStore();
			await expect(store.get(ROOT_SCOPE, "nope", { maxBytes: 10 })).rejects.toThrow(
				/unknown value/,
			);
			await expect(store.get("scope_missing", "nope", { maxBytes: 10 })).rejects.toThrow(
				/unknown scope/,
			);
		});
	});

	describe("peek", () => {
		it("returns the bind-time preview verbatim, never recomputed", async () => {
			const store = makeStore();
			const meta = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "p",
				content: "peek me\nsecond line",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			expect(await store.peek(ROOT_SCOPE, "p")).toBe(meta.preview);
			expect(await store.peek(ROOT_SCOPE, meta.ulid)).toBe(meta.preview);
		});
	});

	describe("naming and collisions", () => {
		it("rejects invalid names", async () => {
			const store = makeStore();
			for (const name of ["", "1abc", "Has-Caps", "a".repeat(65)]) {
				await expect(
					store.bind({
						scopeId: ROOT_SCOPE,
						name,
						content: "x",
						type: "text",
						provenance: prov(),
						explicit: true,
					}),
				).rejects.toThrow(/name/);
			}
		});

		it("rejects reserved names", async () => {
			const store = makeStore({ reservedNames: new Set(["programs"]) });
			await expect(
				store.bind({
					scopeId: ROOT_SCOPE,
					name: "programs",
					content: "x",
					type: "text",
					provenance: prov(),
					explicit: true,
				}),
			).rejects.toThrow(/reserved/);
		});

		it("same-agent explicit rebind creates a new version; old ulid stays readable", async () => {
			const store = makeStore();
			const v1 = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "x",
				content: "one",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			const v2 = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "x",
				content: "two",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			expect(v2.ulid).not.toBe(v1.ulid);
			const current = await store.get(ROOT_SCOPE, "x", { maxBytes: 100 });
			expect(new TextDecoder().decode(current)).toBe("two");
			const old = await store.get(ROOT_SCOPE, v1.ulid, { maxBytes: 100 });
			expect(new TextDecoder().decode(old)).toBe("one");
		});

		it("explicit bind colliding with another agent's explicit bind throws", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "shared",
				content: "a",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			await expect(
				store.bind({
					scopeId: ROOT_SCOPE,
					name: "shared",
					content: "b",
					type: "text",
					provenance: prov("agent_b"),
					explicit: true,
				}),
			).rejects.toThrow(/collide|collision/i);
		});

		it("explicit bind colliding with an auto-bind throws, even for the same agent", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "auto",
				content: "a",
				type: "text",
				provenance: prov("agent_a"),
				explicit: false,
			});
			await expect(
				store.bind({
					scopeId: ROOT_SCOPE,
					name: "auto",
					content: "b",
					type: "text",
					provenance: prov("agent_a"),
					explicit: true,
				}),
			).rejects.toThrow(/collide|collision/i);
		});

		it("auto-bind collisions take deterministic numeric suffixes _2, _3", async () => {
			const store = makeStore();
			const first = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "out",
				content: "1",
				type: "text",
				provenance: prov(),
				explicit: false,
			});
			const second = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "out",
				content: "2",
				type: "text",
				provenance: prov(),
				explicit: false,
			});
			const third = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "out",
				content: "3",
				type: "text",
				provenance: prov(),
				explicit: false,
			});
			expect(first.name).toBe("out");
			expect(second.name).toBe("out_2");
			expect(third.name).toBe("out_3");
		});

		it("auto-bind suffixing truncates the base to respect the 64-char limit", async () => {
			const store = makeStore();
			const long = "a".repeat(64);
			const first = await store.bind({
				scopeId: ROOT_SCOPE,
				name: long,
				content: "1",
				type: "text",
				provenance: prov(),
				explicit: false,
			});
			const second = await store.bind({
				scopeId: ROOT_SCOPE,
				name: long,
				content: "2",
				type: "text",
				provenance: prov(),
				explicit: false,
			});
			expect(first.name).toBe(long);
			expect(second.name.length).toBe(64);
			expect(second.name).toBe(`${"a".repeat(62)}_2`);
		});

		it("names are per-scope: the same name binds independently in two scopes", async () => {
			const store = makeStore();
			await store.createScope({
				scopeId: "scope_child",
				ownerHandleId: "agent_b",
				parentScopeId: ROOT_SCOPE,
			});
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "x",
				content: "root",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			await store.bind({
				scopeId: "scope_child",
				name: "x",
				content: "child",
				type: "text",
				provenance: prov("agent_b"),
				explicit: true,
			});
			const rootVal = await store.get(ROOT_SCOPE, "x", { maxBytes: 100 });
			const childVal = await store.get("scope_child", "x", { maxBytes: 100 });
			expect(new TextDecoder().decode(rootVal)).toBe("root");
			expect(new TextDecoder().decode(childVal)).toBe("child");
		});
	});

	describe("limits and quotas", () => {
		it("rejects a value over maxValueBytes", async () => {
			const store = makeStore({ maxValueBytes: 8 });
			await expect(
				store.bind({
					scopeId: ROOT_SCOPE,
					name: "big",
					content: "123456789",
					type: "text",
					provenance: prov(),
					explicit: true,
				}),
			).rejects.toThrow(/max value size/);
		});

		it("enforces the per-scope value cap", async () => {
			const store = makeStore({ perScopeValueCap: 2 });
			for (let i = 0; i < 2; i++) {
				await store.bind({
					scopeId: ROOT_SCOPE,
					name: `v_${i}`,
					content: "x",
					type: "text",
					provenance: prov(),
					explicit: true,
				});
			}
			await expect(
				store.bind({
					scopeId: ROOT_SCOPE,
					name: "v_over",
					content: "x",
					type: "text",
					provenance: prov(),
					explicit: true,
				}),
			).rejects.toThrow(/^store full:/);
		});

		it("throws 'store full:' at the disk quota and keeps serving reads", async () => {
			const store = makeStore({ diskQuotaBytes: 600 });
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "a",
				content: "x".repeat(200),
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			await expect(
				store.bind({
					scopeId: ROOT_SCOPE,
					name: "b",
					content: "y".repeat(500),
					type: "text",
					provenance: prov(),
					explicit: true,
				}),
			).rejects.toThrow(/^store full:/);
			// The session keeps running: existing values remain readable.
			const bytes = await store.get(ROOT_SCOPE, "a", { maxBytes: 1024 });
			expect(bytes.length).toBe(200);
		});
	});

	describe("get budget", () => {
		it("throws when the value exceeds maxBytes instead of truncating", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "v",
				content: "0123456789",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			await expect(store.get(ROOT_SCOPE, "v", { maxBytes: 5 })).rejects.toThrow(
				/exceeds read budget/,
			);
			expect((await store.get(ROOT_SCOPE, "v", { maxBytes: 10 })).length).toBe(10);
		});
	});

	describe("slice", () => {
		it("returns the requested 1-based line range", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "lines",
				content: "one\ntwo\nthree\nfour\n",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			expect(await store.slice(ROOT_SCOPE, "lines", { startLine: 2, lineCount: 2 })).toBe(
				"two\nthree",
			);
			expect(await store.slice(ROOT_SCOPE, "lines", { startLine: 1, lineCount: 10 })).toBe(
				"one\ntwo\nthree\nfour",
			);
		});

		it("clamps a start past EOF to empty", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "lines",
				content: "one\ntwo",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			expect(await store.slice(ROOT_SCOPE, "lines", { startLine: 5, lineCount: 3 })).toBe("");
		});

		it("throws 'slice budget exceeded' when the result is over the byte budget", async () => {
			const store = makeStore({ sliceBudgetBytes: 16 });
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "wide",
				content: "0123456789\nabcdefghij\nklmnopqrst",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			await expect(store.slice(ROOT_SCOPE, "wide", { startLine: 1, lineCount: 3 })).rejects.toThrow(
				/slice budget exceeded.*16/,
			);
			// A per-call maxBytes overrides the option default.
			await expect(
				store.slice(ROOT_SCOPE, "wide", { startLine: 1, lineCount: 3, maxBytes: 1024 }),
			).resolves.toBe("0123456789\nabcdefghij\nklmnopqrst");
		});

		it("rejects bytes values", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "blob",
				content: new Uint8Array([1, 2, 3]),
				type: "bytes",
				provenance: prov(),
				explicit: true,
			});
			await expect(store.slice(ROOT_SCOPE, "blob", { startLine: 1, lineCount: 1 })).rejects.toThrow(
				/bytes/,
			);
		});
	});

	describe("grep", () => {
		it("returns matching lines with 1-based line numbers", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "log",
				content: "ok start\nerror: boom\nok mid\nerror: bang\nok end",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const result = await store.grep(ROOT_SCOPE, "log", "^error:");
			expect(result.matches).toEqual([
				{ line: 2, text: "error: boom" },
				{ line: 4, text: "error: bang" },
			]);
			expect(result.truncated).toBe(false);
		});

		it("stops at maxResults", async () => {
			const store = makeStore();
			const content = Array.from({ length: 20 }, (_, i) => `hit ${i}`).join("\n");
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "many",
				content,
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const { matches } = await store.grep(ROOT_SCOPE, "many", "hit", { maxResults: 3 });
			expect(matches.length).toBe(3);
			expect(matches[0]).toEqual({ line: 1, text: "hit 0" });
		});

		it("throws 'grep aborted' for a pre-aborted signal", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "v",
				content: "a\nb",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const controller = new AbortController();
			controller.abort();
			await expect(store.grep(ROOT_SCOPE, "v", "a", { signal: controller.signal })).rejects.toThrow(
				/grep aborted/,
			);
		});

		it("aborts between chunks when the signal fires from a timer mid-grep", async () => {
			// Tiny chunk size forces many chunks; the abort fires from a
			// setTimeout, so only a real macrotask yield between chunks can
			// observe it — a microtask yield would never let the timer run.
			const store = makeStore({ grepChunkBytes: 16 });
			const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "big",
				content,
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 0);
			const pending = store.grep(ROOT_SCOPE, "big", "line", { signal: controller.signal });
			await expect(pending).rejects.toThrow(/grep aborted/);
		});

		it("fails cleanly with 'grep budget exceeded' when the deadline passes between chunks", async () => {
			// Many chunks (tiny grepChunkBytes) with a zero budget: the very
			// first between-chunk deadline check must fire.
			const store = makeStore({ grepChunkBytes: 16 });
			const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "slow",
				content,
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			await expect(store.grep(ROOT_SCOPE, "slow", "nomatch", { deadlineMs: 0 })).rejects.toThrow(
				/^grep budget exceeded/,
			);
		});

		it("caps matched output at grepOutputBudgetBytes and sets truncated", async () => {
			const store = makeStore({ grepOutputBudgetBytes: 32 });
			const content = Array.from({ length: 20 }, (_, i) => `match line ${i}`).join("\n");
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "wide",
				content,
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const result = await store.grep(ROOT_SCOPE, "wide", "match");
			expect(result.truncated).toBe(true);
			expect(result.matches.length).toBeGreaterThan(0);
			expect(result.matches.length).toBeLessThan(20);
		});

		it("matches within a single line larger than the chunk cap", async () => {
			// Fragment matching is per cap-sized fragment: place the needle
			// wholly inside the second fragment (cap 16, needle at offset 16).
			const store = makeStore({ grepChunkBytes: 16 });
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "longline",
				content: `${"x".repeat(16)}needle${"y".repeat(30)}`,
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const { matches } = await store.grep(ROOT_SCOPE, "longline", "needle");
			expect(matches.length).toBe(1);
			expect(matches[0]?.line).toBe(1);
			expect(matches[0]?.text).toContain("needle");
		});

		it("throws a clear error for an invalid pattern", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "v",
				content: "x",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			await expect(store.grep(ROOT_SCOPE, "v", "([unclosed")).rejects.toThrow(
				/invalid grep pattern/,
			);
		});
	});

	describe("CRLF line handling", () => {
		it("slice and grep address CRLF lines like LF lines", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "crlf",
				content: "one\r\ntwo\r\nthree\r\n",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			expect(await store.slice(ROOT_SCOPE, "crlf", { startLine: 2, lineCount: 2 })).toBe(
				"two\nthree",
			);
			// `$` anchors see the clean line, not a trailing \r.
			const { matches } = await store.grep(ROOT_SCOPE, "crlf", "^two$");
			expect(matches).toEqual([{ line: 2, text: "two" }]);
		});
	});

	describe("inline journal encoding", () => {
		it("roundtrips invalid-utf8 bytes typed 'text' through resume via CAS", async () => {
			const store = makeStore();
			// 0xff 0xfe is not valid utf8; a lossy inline decode would corrupt it.
			const body = new Uint8Array([104, 105, 0xff, 0xfe, 104, 111]);
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "weird",
				content: body,
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const records = (await journal.replay()).filter((r) => r.kind === "bind");
			expect(records[0]?.kind === "bind" && "cas" in records[0].body).toBe(true);
			const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			expect(await resumed.get(ROOT_SCOPE, "weird", { maxBytes: 100 })).toEqual(body);
		});

		it("clamps a large inlineLimitBytes to the journal's hard ceiling", async () => {
			// 1 MB configured inline limit with a 100 KB body: journaling it
			// inline would make replay reject the record and brick resume.
			const store = makeStore({ inlineLimitBytes: 1024 * 1024 });
			const body = "x".repeat(100 * 1024);
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "biginline",
				content: body,
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const records = (await journal.replay()).filter((r) => r.kind === "bind");
			expect(records[0]?.kind === "bind" && "cas" in records[0].body).toBe(true);
			const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			const bytes = await resumed.get(ROOT_SCOPE, "biginline", { maxBytes: 1024 * 1024 });
			expect(new TextDecoder().decode(bytes)).toBe(body);
		});
	});

	describe("concurrency", () => {
		it("10 concurrent binds against a cap of 5 admit exactly 5", async () => {
			const store = makeStore({ perScopeValueCap: 5 });
			const results = await Promise.allSettled(
				Array.from({ length: 10 }, (_, i) =>
					store.bind({
						scopeId: ROOT_SCOPE,
						name: `c_${i}`,
						content: `${i}`,
						type: "text",
						provenance: prov(),
						explicit: true,
					}),
				),
			);
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r) => r.status === "rejected");
			expect(fulfilled.length).toBe(5);
			expect(rejected.length).toBe(5);
			for (const r of rejected) {
				expect((r as PromiseRejectedResult).reason.message).toMatch(/^store full:/);
			}
		});

		it("concurrent reads of one value do not corrupt LRU accounting", async () => {
			const store = makeStore({ memoryBudgetBytes: 200 });
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "shared",
				content: "s".repeat(80),
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			// Many concurrent loads of the same body must not drift hotBytes.
			await Promise.all(
				Array.from({ length: 20 }, () => store.get(ROOT_SCOPE, "shared", { maxBytes: 1024 })),
			);
			// An eviction-heavy insert still works and stays readable — if
			// hotBytes had drifted upward, eviction of an empty LRU would wedge.
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "evictor",
				content: "e".repeat(150),
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const bytes = await store.get(ROOT_SCOPE, "evictor", { maxBytes: 1024 });
			expect(bytes.length).toBe(150);
		});
	});

	describe("memory LRU", () => {
		it("evicts under memory pressure but reads still succeed via CAS reload", async () => {
			const store = makeStore({ memoryBudgetBytes: 150 });
			for (let i = 0; i < 5; i++) {
				await store.bind({
					scopeId: ROOT_SCOPE,
					name: `v_${i}`,
					content: `${i}`.repeat(60),
					type: "text",
					provenance: prov(),
					explicit: true,
				});
			}
			// All five stay readable even though at most two fit in memory.
			for (let i = 0; i < 5; i++) {
				const bytes = await store.get(ROOT_SCOPE, `v_${i}`, { maxBytes: 1024 });
				expect(new TextDecoder().decode(bytes)).toBe(`${i}`.repeat(60));
			}
		});

		it("does not cache a body larger than the whole budget, but serves it from CAS", async () => {
			const store = makeStore({ memoryBudgetBytes: 10 });
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "huge",
				content: "z".repeat(100),
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			const bytes = await store.get(ROOT_SCOPE, "huge", { maxBytes: 1024 });
			expect(bytes.length).toBe(100);
		});
	});

	describe("resume", () => {
		it("rebuilds scopes, name tables, and versions, and serves reads", async () => {
			const store = makeStore();
			await store.createScope({
				scopeId: "scope_child",
				ownerHandleId: "agent_b",
				parentScopeId: ROOT_SCOPE,
			});
			const v1 = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "x",
				content: "one",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "x",
				content: "two",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			// A large body that goes to CAS (over the inline limit).
			const big = "b".repeat(70 * 1024);
			await store.bind({
				scopeId: "scope_child",
				name: "big",
				content: big,
				type: "text",
				provenance: prov("agent_b"),
				explicit: true,
			});

			const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			// Later bind of the same name wins.
			const current = await resumed.get(ROOT_SCOPE, "x", { maxBytes: 100 });
			expect(new TextDecoder().decode(current)).toBe("two");
			// The old version stays readable by ulid.
			const old = await resumed.get(ROOT_SCOPE, v1.ulid, { maxBytes: 100 });
			expect(new TextDecoder().decode(old)).toBe("one");
			// Scope and its CAS-backed value survive.
			const bigBytes = await resumed.get("scope_child", "big", { maxBytes: 1024 * 1024 });
			expect(new TextDecoder().decode(bigBytes)).toBe(big);
			// Preview survives verbatim.
			expect(await resumed.peek(ROOT_SCOPE, "x")).toContain("text · 3 bytes");
		});

		it("roundtrips a bytes value through resume (base64 inline body)", async () => {
			const store = makeStore();
			const body = new Uint8Array([7, 8, 9, 250]);
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "blob",
				content: body,
				type: "bytes",
				provenance: prov(),
				explicit: true,
			});
			const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			expect(await resumed.get(ROOT_SCOPE, "blob", { maxBytes: 100 })).toEqual(body);
		});

		it("resume preserves the explicit flag: an auto-bound name stays auto-origin", async () => {
			// The journal records the flag, so after resume an explicit bind on a
			// name that was AUTO-bound (even by the same agent) still fails loudly
			// — auto-bind names are a different origin per spec §1 Naming #3.
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "exec_output",
				content: "captured",
				type: "text",
				provenance: prov("agent_a"),
				explicit: false,
			});
			const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			await expect(
				resumed.bind({
					scopeId: ROOT_SCOPE,
					name: "exec_output",
					content: "mine now",
					type: "text",
					provenance: prov("agent_a"),
					explicit: true,
				}),
			).rejects.toThrow(/collision/i);
		});

		it("resume preserves createdAt from the journal", async () => {
			const store = makeStore();
			const bound = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "stamped",
				content: "x",
				type: "text",
				provenance: prov(),
				explicit: true,
			});
			expect(bound.createdAt).toBeGreaterThan(0);
			const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			expect((await resumed.metadata(ROOT_SCOPE, "stamped")).createdAt).toBe(bound.createdAt!);
		});

		it("restores collision behavior: cross-origin explicit bind still throws after resume", async () => {
			const store = makeStore();
			await store.bind({
				scopeId: ROOT_SCOPE,
				name: "shared",
				content: "a",
				type: "text",
				provenance: prov("agent_a"),
				explicit: true,
			});
			const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			await expect(
				resumed.bind({
					scopeId: ROOT_SCOPE,
					name: "shared",
					content: "b",
					type: "text",
					provenance: prov("agent_b"),
					explicit: true,
				}),
			).rejects.toThrow(/collide|collision/i);
		});
	});

	describe("bind ulid idempotency", () => {
		// Client-minted ulids make binds re-issuable across a store-worker
		// restart: a duplicate ulid returns the existing metadata, no new record.
		it("uses a caller-supplied ulid as the value's identity", async () => {
			const store = makeStore();
			const meta = await store.bind({
				scopeId: ROOT_SCOPE,
				name: "x",
				content: "abc",
				type: "text",
				provenance: prov(),
				explicit: true,
				ulid: "01HZZZZZZZZZZZZZZZZZZZZZZ1",
			});
			expect(meta.ulid).toBe("01HZZZZZZZZZZZZZZZZZZZZZZ1");
		});

		it("dedups a re-issued bind: same metadata, single journal record", async () => {
			const store = makeStore();
			const args = {
				scopeId: ROOT_SCOPE,
				name: "x",
				content: "abc",
				type: "text" as const,
				provenance: prov(),
				explicit: true,
				ulid: "01HZZZZZZZZZZZZZZZZZZZZZZ2",
			};
			const first = await store.bind(args);
			const second = await store.bind(args);
			expect(second).toEqual(first);
			const binds = (await journal.replay()).filter((r) => r.kind === "bind");
			expect(binds).toHaveLength(1);
		});

		it("dedups across resume: a restarted store recognizes the ulid", async () => {
			const store = makeStore();
			const args = {
				scopeId: ROOT_SCOPE,
				name: "x",
				content: "abc",
				type: "text" as const,
				provenance: prov(),
				explicit: true,
				ulid: "01HZZZZZZZZZZZZZZZZZZZZZZ3",
			};
			const first = await store.bind(args);
			const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT_SCOPE });
			const second = await resumed.bind(args);
			expect(second).toEqual(first);
			const binds = (await journal.replay()).filter((r) => r.kind === "bind");
			expect(binds).toHaveLength(1);
		});
	});
});
