import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store/cas";
import { SessionJournal } from "../../src/store/journal";
import { SapStore } from "../../src/store/store";
import type { ValueProvenance } from "../../src/store/value";

const ROOT = "root";
const PARENT = "parent_handle";
const CHILD = "child_handle";

const prov = (agentHandleId: string): ValueProvenance => ({
	agentHandleId,
	origin: { kind: "cell" },
});

describe("env grants (registerEnvGrant / claimEnvGrant)", () => {
	let dir: string;
	let journal: SessionJournal;
	let cas: ContentStore;
	let store: SapStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sap-env-grants-"));
		journal = new SessionJournal(join(dir, "journal.jsonl"));
		cas = new ContentStore(join(dir, "cas"));
		store = new SapStore({ journal, cas, rootScopeId: ROOT });
		await store.createScope({ scopeId: PARENT, ownerHandleId: PARENT, parentScopeId: ROOT });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function bindParent(name: string, content = "the schema body"): Promise<string> {
		const meta = await store.bind({
			scopeId: PARENT,
			name,
			content,
			type: "text",
			provenance: prov(PARENT),
			explicit: true,
		});
		return meta.ulid;
	}

	it("registers a grant (by name), journals env_grant, and claims into the recipient scope", async () => {
		const ulid = await bindParent("schema");
		const granted = await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		expect(granted.ulid).toBe(ulid);

		// The env_grant record is journaled with sender/recipient/alias/ulid.
		expect(await journal.replay()).toContainEqual({
			kind: "env_grant",
			sender: PARENT,
			recipient: CHILD,
			alias: "api_schema",
			ulid,
		});

		// The recipient scope is created later (at first channel use).
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		const claimed = await store.claimEnvGrant({
			recipientScopeId: CHILD,
			alias: "api_schema",
			ulid,
		});
		expect(claimed.name).toBe("api_schema");
		expect(claimed.ulid).toBe(ulid);

		// Bound as an alias: readable by name in the child scope, journaled as a grant.
		expect(new TextDecoder().decode(await store.get(CHILD, "api_schema", { maxBytes: 100 }))).toBe(
			"the schema body",
		);
		expect(await journal.replay()).toContainEqual({
			kind: "grant",
			granter: PARENT,
			recipient: CHILD,
			name: "api_schema",
			ulid,
			via: "env",
		});
	});

	it("registers a grant by ulid ref too", async () => {
		const ulid = await bindParent("schema");
		const granted = await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "schema",
			ref: ulid,
		});
		expect(granted.ulid).toBe(ulid);
	});

	it("rejects a grant of a value from another scope (foreign ulid)", async () => {
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		const meta = await store.bind({
			scopeId: CHILD,
			name: "child_secret",
			content: "x",
			type: "text",
			provenance: prov(CHILD),
			explicit: true,
		});
		await expect(
			store.registerEnvGrant({
				senderScopeId: PARENT,
				recipientHandle: "other",
				alias: "stolen",
				ref: meta.ulid,
			}),
		).rejects.toThrow(/cannot grant a value from another scope/);
	});

	it("rejects an invalid alias at registration", async () => {
		await bindParent("schema");
		await expect(
			store.registerEnvGrant({
				senderScopeId: PARENT,
				recipientHandle: CHILD,
				alias: "Not Valid!",
				ref: "schema",
			}),
		).rejects.toThrow(/invalid value name/);
	});

	it("fails loudly at registration when the alias is already bound in an existing recipient scope", async () => {
		await bindParent("schema");
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await store.bind({
			scopeId: CHILD,
			name: "api_schema",
			content: "already here",
			type: "text",
			provenance: prov(CHILD),
			explicit: true,
		});
		await expect(
			store.registerEnvGrant({
				senderScopeId: PARENT,
				recipientHandle: CHILD,
				alias: "api_schema",
				ref: "schema",
			}),
		).rejects.toThrow(/alias already bound in the recipient's scope/);
	});

	it("rejects a claim with no matching pending grant (forged env)", async () => {
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await expect(
			store.claimEnvGrant({
				recipientScopeId: CHILD,
				alias: "api_schema",
				ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			}),
		).rejects.toThrow(/no matching env grant/);
	});

	it("rejects a claim whose ulid does not match the pending grant", async () => {
		const ulid = await bindParent("schema");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await expect(
			store.claimEnvGrant({
				recipientScopeId: CHILD,
				alias: "api_schema",
				// Flip the last char so the forged ulid ALWAYS differs.
				ulid: `${ulid.slice(0, -1)}${ulid.endsWith("X") ? "Y" : "X"}`,
			}),
		).rejects.toThrow(/no matching env grant/);
	});

	it("fails a claim loudly when the alias collided before claim", async () => {
		const ulid = await bindParent("schema");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await store.bind({
			scopeId: CHILD,
			name: "api_schema",
			content: "raced in",
			type: "text",
			provenance: prov(CHILD),
			explicit: true,
		});
		await expect(
			store.claimEnvGrant({ recipientScopeId: CHILD, alias: "api_schema", ulid }),
		).rejects.toThrow(/alias collided before claim/);
	});

	it("consumes the pending grant on claim — a second claim finds nothing", async () => {
		const ulid = await bindParent("schema");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await store.claimEnvGrant({ recipientScopeId: CHILD, alias: "api_schema", ulid });
		await expect(
			store.claimEnvGrant({ recipientScopeId: CHILD, alias: "api_schema", ulid }),
		).rejects.toThrow(/no matching env grant/);
	});

	it("env aliases do not count against the per-scope value cap", async () => {
		const capped = new SapStore({
			journal,
			cas,
			rootScopeId: ROOT,
			options: { perScopeValueCap: 1 },
		});
		await capped.createScope({ scopeId: PARENT, ownerHandleId: PARENT, parentScopeId: ROOT });
		await capped.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		const meta = await capped.bind({
			scopeId: PARENT,
			name: "schema",
			content: "s",
			type: "text",
			provenance: prov(PARENT),
			explicit: true,
		});
		// The child is at its cap with one bind of its own.
		await capped.bind({
			scopeId: CHILD,
			name: "own_value",
			content: "o",
			type: "text",
			provenance: prov(CHILD),
			explicit: true,
		});
		await capped.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		// The claim still lands: aliases are not value creations.
		const claimed = await capped.claimEnvGrant({
			recipientScopeId: CHILD,
			alias: "api_schema",
			ulid: meta.ulid,
		});
		expect(claimed.name).toBe("api_schema");
	});

	it("rejects a pending overwrite with a different value for the same alias", async () => {
		const ulid = await bindParent("schema");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		await bindParent("schema_v2", "a different body");
		await expect(
			store.registerEnvGrant({
				senderScopeId: PARENT,
				recipientHandle: CHILD,
				alias: "api_schema",
				ref: "schema_v2",
			}),
		).rejects.toThrow(/already pending with a different value/);
		// The original grant is untouched and still claims.
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		const claimed = await store.claimEnvGrant({
			recipientScopeId: CHILD,
			alias: "api_schema",
			ulid,
		});
		expect(claimed.ulid).toBe(ulid);
	});

	it("re-registering the same value under the same alias is idempotent-ok", async () => {
		const ulid = await bindParent("schema");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		const again = await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		expect(again.ulid).toBe(ulid);
		// Still exactly one pending: the claim consumes it once.
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await store.claimEnvGrant({ recipientScopeId: CHILD, alias: "api_schema", ulid });
		await expect(
			store.claimEnvGrant({ recipientScopeId: CHILD, alias: "api_schema", ulid }),
		).rejects.toThrow(/no matching env grant/);
	});

	it("resume keeps a manifest alias manifest-origin even when an env grant for the same value and name is pending", async () => {
		// The sender both env-grants "impl" AND publishes it to the same
		// recipient: the manifest delivery lands first, the claim collides
		// loudly, and the pending env grant survives — live and resumed alike.
		const ulid = await bindParent("impl");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "impl",
			ref: "impl",
		});
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await store.publish(PARENT, ulid);
		const delta = await store.deliverManifest({
			publisherHandle: PARENT,
			recipientScopeId: CHILD,
		});
		expect(delta.delivered.map((d) => d.name)).toEqual(["impl"]);
		// Live: the claim collides loudly and leaves the pending in place.
		await expect(
			store.claimEnvGrant({ recipientScopeId: CHILD, alias: "impl", ulid }),
		).rejects.toThrow(/alias collided before claim/);

		const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT });
		// Manifest-origin alias: a same-publisher republish version-updates in
		// place — no suffix, the alias moves to the new version.
		const v2 = await resumed.bind({
			scopeId: PARENT,
			name: "impl",
			content: "impl v2",
			type: "text",
			provenance: prov(PARENT),
			explicit: true,
		});
		await resumed.publish(PARENT, v2.ulid);
		const resumedDelta = await resumed.deliverManifest({
			publisherHandle: PARENT,
			recipientScopeId: CHILD,
		});
		expect(resumedDelta.delivered.map((d) => d.name)).toEqual(["impl"]);
		// The pending env grant is STILL pending: the claim finds it and
		// collides — it was never misread as already claimed.
		await expect(
			resumed.claimEnvGrant({ recipientScopeId: CHILD, alias: "impl", ulid }),
		).rejects.toThrow(/alias collided before claim/);
	});

	it("resume rebuilds pending grants: an unclaimed grant is claimable after restart", async () => {
		const ulid = await bindParent("schema");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});

		const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT });
		await resumed.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		const claimed = await resumed.claimEnvGrant({
			recipientScopeId: CHILD,
			alias: "api_schema",
			ulid,
		});
		expect(claimed.ulid).toBe(ulid);
	});

	it("resume subtracts claimed pendings and replays the claimed alias into the recipient scope", async () => {
		const ulid = await bindParent("schema");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await store.claimEnvGrant({ recipientScopeId: CHILD, alias: "api_schema", ulid });

		const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT });
		// The claimed alias is bound in the recipient scope after replay.
		expect(
			new TextDecoder().decode(await resumed.get(CHILD, "api_schema", { maxBytes: 100 })),
		).toBe("the schema body");
		// The pending was consumed: no second claim.
		await expect(
			resumed.claimEnvGrant({ recipientScopeId: CHILD, alias: "api_schema", ulid }),
		).rejects.toThrow(/no matching env grant/);
	});

	it("a replayed env-claim alias is explicit: a later explicit bind by another origin collides", async () => {
		const ulid = await bindParent("schema");
		await store.registerEnvGrant({
			senderScopeId: PARENT,
			recipientHandle: CHILD,
			alias: "api_schema",
			ref: "schema",
		});
		await store.createScope({ scopeId: CHILD, ownerHandleId: CHILD, parentScopeId: ROOT });
		await store.claimEnvGrant({ recipientScopeId: CHILD, alias: "api_schema", ulid });

		const resumed = await SapStore.resume({ journal, cas, rootScopeId: ROOT });
		await expect(
			resumed.bind({
				scopeId: CHILD,
				name: "api_schema",
				content: "mine now",
				type: "text",
				provenance: prov(CHILD),
				explicit: true,
			}),
		).rejects.toThrow(/name collision/);
	});
});
