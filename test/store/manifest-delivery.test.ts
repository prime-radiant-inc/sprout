import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store/cas";
import { type JournalRecord, SessionJournal } from "../../src/store/journal";
import { SapStore } from "../../src/store/store";
import type { ValueProvenance } from "../../src/store/value";

const ROOT = "root";
const CHILD = "child_handle";
const PARENT = "parent_handle";

const prov = (agentHandleId: string): ValueProvenance => ({
	agentHandleId,
	origin: { kind: "cell" },
});

describe("manifest delivery (deliverManifest)", () => {
	let dir: string;
	let journal: SessionJournal;
	let cas: ContentStore;
	let store: SapStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sap-manifest-"));
		journal = new SessionJournal(join(dir, "journal.jsonl"));
		cas = new ContentStore(join(dir, "cas"));
		store = new SapStore({ journal, cas, rootScopeId: ROOT });
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await store.createScope({ scopeId: PARENT, ownerHandleId: PARENT, parentScopeId: ROOT });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function bindAndPublish(name: string, content: string): Promise<string> {
		const meta = await store.bind({
			scopeId: CHILD,
			name,
			content,
			type: "text",
			provenance: prov(CHILD),
			explicit: true,
		});
		await store.publish(CHILD, meta.ulid);
		return meta.ulid;
	}

	it("delivers the delta as aliases and advances the cursor", async () => {
		const implUlid = await bindAndPublish("impl", "the impl body");
		const notesUlid = await bindAndPublish("impl_notes", "the notes");

		const delta = await store.deliverManifest({
			publisherHandle: CHILD,
			recipientScopeId: PARENT,
		});
		expect(delta.throughSeq).toBe(2);
		expect(delta.delivered.map((d) => ({ name: d.name, ulid: d.ulid }))).toEqual([
			{ name: "impl", ulid: implUlid },
			{ name: "impl_notes", ulid: notesUlid },
		]);
		expect(delta.delivered[0]!.size).toBe(13);
		expect(delta.delivered[0]!.preview).toContain("text · 13 bytes");

		// Aliases resolve in the recipient's scope.
		expect(new TextDecoder().decode(await store.get(PARENT, "impl", { maxBytes: 100 }))).toBe(
			"the impl body",
		);
		expect(await store.names(PARENT)).toEqual(["impl", "impl_notes"]);

		// Journal: two grants plus the cursor record, contiguous, in one batch.
		const records = await journal.replay();
		const tail = records.slice(-3);
		expect(tail.map((r) => r.kind)).toEqual(["grant", "grant", "manifest_delivery"]);
		expect(tail[0]).toEqual({
			kind: "grant",
			granter: CHILD,
			recipient: PARENT,
			name: "impl",
			ulid: implUlid,
		});
		expect(tail[2]).toEqual({
			kind: "manifest_delivery",
			handle: CHILD,
			recipient: PARENT,
			throughPublishSeq: 2,
		});
	});

	it("is idempotent: an empty delta delivers nothing and journals nothing", async () => {
		await bindAndPublish("impl", "body");
		await store.deliverManifest({ publisherHandle: CHILD, recipientScopeId: PARENT });
		const before = (await journal.replay()).length;

		const delta = await store.deliverManifest({
			publisherHandle: CHILD,
			recipientScopeId: PARENT,
		});
		expect(delta).toEqual({ delivered: [], throughSeq: 1 });
		expect((await journal.replay()).length).toBe(before);
	});

	it("an unknown publisher yields an empty delta at cursor 0", async () => {
		const delta = await store.deliverManifest({
			publisherHandle: "never_published",
			recipientScopeId: PARENT,
		});
		expect(delta).toEqual({ delivered: [], throughSeq: 0 });
	});

	it("same-publisher republish is a version update: the alias moves, no suffix", async () => {
		await bindAndPublish("impl", "v1");
		await store.deliverManifest({ publisherHandle: CHILD, recipientScopeId: PARENT });

		// Child rebinds and republishes the same name (explicit self-rebind).
		const v2Ulid = await bindAndPublish("impl", "v2");
		const delta = await store.deliverManifest({
			publisherHandle: CHILD,
			recipientScopeId: PARENT,
		});
		expect(delta.delivered).toHaveLength(1);
		expect(delta.delivered[0]!.name).toBe("impl");
		expect(delta.delivered[0]!.ulid).toBe(v2Ulid);
		expect(await store.names(PARENT)).toEqual(["impl"]);
		expect(new TextDecoder().decode(await store.get(PARENT, "impl", { maxBytes: 100 }))).toBe("v2");
	});

	it("a collision with any other origin takes a numeric suffix", async () => {
		// The recipient explicitly bound "report" itself.
		await store.bind({
			scopeId: PARENT,
			name: "report",
			content: "mine",
			type: "text",
			provenance: prov(PARENT),
			explicit: true,
		});
		await bindAndPublish("report", "theirs");

		const delta = await store.deliverManifest({
			publisherHandle: CHILD,
			recipientScopeId: PARENT,
		});
		expect(delta.delivered[0]!.name).toBe("report_2");
		expect(new TextDecoder().decode(await store.get(PARENT, "report", { maxBytes: 100 }))).toBe(
			"mine",
		);
		expect(new TextDecoder().decode(await store.get(PARENT, "report_2", { maxBytes: 100 }))).toBe(
			"theirs",
		);
	});

	it("a manifest name from a DIFFERENT publisher collides and suffixes", async () => {
		const OTHER = "other_handle";
		await store.createScope({ scopeId: OTHER, ownerHandleId: OTHER, parentScopeId: ROOT });
		await bindAndPublish("impl", "child impl");
		await store.deliverManifest({ publisherHandle: CHILD, recipientScopeId: PARENT });

		const meta = await store.bind({
			scopeId: OTHER,
			name: "impl",
			content: "other impl",
			type: "text",
			provenance: prov(OTHER),
			explicit: true,
		});
		await store.publish(OTHER, meta.ulid);
		const delta = await store.deliverManifest({
			publisherHandle: OTHER,
			recipientScopeId: PARENT,
		});
		expect(delta.delivered[0]!.name).toBe("impl_2");
	});

	it("manifest aliases do not count against the recipient's value cap", async () => {
		const capped = new SapStore({
			journal: new SessionJournal(join(dir, "capped.jsonl")),
			cas,
			rootScopeId: ROOT,
			options: { perScopeValueCap: 1 },
		});
		await capped.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await capped.createScope({ scopeId: PARENT, ownerHandleId: PARENT, parentScopeId: ROOT });
		const meta = await capped.bind({
			scopeId: CHILD,
			name: "impl",
			content: "x",
			type: "text",
			provenance: prov(CHILD),
			explicit: true,
		});
		await capped.publish(CHILD, meta.ulid);
		// Recipient is at its cap already.
		await capped.bind({
			scopeId: PARENT,
			name: "own",
			content: "y",
			type: "text",
			provenance: prov(PARENT),
			explicit: true,
		});
		const delta = await capped.deliverManifest({
			publisherHandle: CHILD,
			recipientScopeId: PARENT,
		});
		expect(delta.delivered).toHaveLength(1);
		// A real bind still fails: the cap tracks real binds only.
		await expect(
			capped.bind({
				scopeId: PARENT,
				name: "more",
				content: "z",
				type: "text",
				provenance: prov(PARENT),
				explicit: true,
			}),
		).rejects.toThrow(/store full/);
	});

	it("resume rebuilds cursors and aliases; a post-resume delta continues from the cursor", async () => {
		await bindAndPublish("impl", "v1");
		await store.deliverManifest({ publisherHandle: CHILD, recipientScopeId: PARENT });
		const notesUlid = await bindAndPublish("notes", "post-cursor");

		const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT });
		// Aliases replayed into the recipient's name table.
		expect(await resumed.names(PARENT)).toEqual(["impl"]);
		expect(new TextDecoder().decode(await resumed.get(PARENT, "impl", { maxBytes: 100 }))).toBe(
			"v1",
		);
		// The delta picks up only what came after the delivered cursor.
		const delta = await resumed.deliverManifest({
			publisherHandle: CHILD,
			recipientScopeId: PARENT,
		});
		expect(delta.delivered.map((d) => ({ name: d.name, ulid: d.ulid }))).toEqual([
			{ name: "notes", ulid: notesUlid },
		]);
		expect(delta.throughSeq).toBe(2);
	});

	it("resume preserves version-update semantics for replayed manifest aliases", async () => {
		await bindAndPublish("impl", "v1");
		await store.deliverManifest({ publisherHandle: CHILD, recipientScopeId: PARENT });
		const v2Ulid = await bindAndPublish("impl", "v2");

		const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT });
		const delta = await resumed.deliverManifest({
			publisherHandle: CHILD,
			recipientScopeId: PARENT,
		});
		// Same publisher: the alias moves, no suffix — manifest origin survived resume.
		expect(delta.delivered[0]!.name).toBe("impl");
		expect(delta.delivered[0]!.ulid).toBe(v2Ulid);
		expect(await resumed.names(PARENT)).toEqual(["impl"]);
	});

	it("delivery to two recipients keeps independent cursors", async () => {
		const OTHER = "other_recipient";
		await store.createScope({ scopeId: OTHER, ownerHandleId: OTHER, parentScopeId: ROOT });
		await bindAndPublish("impl", "v1");
		await store.deliverManifest({ publisherHandle: CHILD, recipientScopeId: PARENT });
		const delta = await store.deliverManifest({
			publisherHandle: CHILD,
			recipientScopeId: OTHER,
		});
		expect(delta.delivered).toHaveLength(1);
		expect(await store.names(OTHER)).toEqual(["impl"]);
	});

	it("the grants and cursor land as one contiguous multi-append batch", async () => {
		await bindAndPublish("a", "1");
		await bindAndPublish("b", "2");
		await store.deliverManifest({ publisherHandle: CHILD, recipientScopeId: PARENT });
		const records: JournalRecord[] = await journal.replay();
		const firstGrant = records.findIndex((r) => r.kind === "grant");
		expect(firstGrant).toBeGreaterThan(-1);
		expect(records[firstGrant + 1]?.kind).toBe("grant");
		expect(records[firstGrant + 2]?.kind).toBe("manifest_delivery");
	});
});
