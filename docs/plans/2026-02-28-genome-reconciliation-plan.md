# Genome Reconciliation Implementation Plan

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable bidirectional sync between bootstrap and runtime genome, and teach the quartermaster about development mode.

**Architecture:** A bootstrap manifest tracks content hashes per agent to detect changes on either side. The sync algorithm uses a 4-way comparison (bootstrap changed? genome evolved?) to decide skip/update/conflict. Development mode detection injects postscripts into the quartermaster when sprout runs inside its own source tree.

**Tech Stack:** TypeScript on Bun, bun:test, YAML (yaml package), node:crypto for hashing, git for genome versioning.

---

### Task 1: Bootstrap Manifest — Types and Load/Save

**Files:**
- Create: `src/genome/bootstrap-manifest.ts`
- Test: `test/genome/bootstrap-manifest.test.ts`

**Step 1: Write the failing test**

Create `test/genome/bootstrap-manifest.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	type BootstrapManifest,
	loadManifest,
	saveManifest,
} from "../../src/genome/bootstrap-manifest.ts";

describe("BootstrapManifest", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-manifest-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("loadManifest returns empty manifest when file does not exist", async () => {
		const manifest = await loadManifest(join(tempDir, "nope", "manifest.json"));
		expect(manifest.agents).toEqual({});
	});

	test("saveManifest + loadManifest round-trips", async () => {
		const path = join(tempDir, "manifest.json");
		const manifest: BootstrapManifest = {
			synced_at: "2026-02-28T00:00:00.000Z",
			agents: {
				root: { hash: "sha256:abc123", version: 1 },
				reader: { hash: "sha256:def456", version: 2 },
			},
		};

		await saveManifest(path, manifest);
		const loaded = await loadManifest(path);

		expect(loaded.synced_at).toBe("2026-02-28T00:00:00.000Z");
		expect(loaded.agents.root).toEqual({ hash: "sha256:abc123", version: 1 });
		expect(loaded.agents.reader).toEqual({ hash: "sha256:def456", version: 2 });
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/genome/bootstrap-manifest.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/genome/bootstrap-manifest.ts`:

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BootstrapManifestEntry {
	/** Content hash of the bootstrap YAML at last sync */
	hash: string;
	/** Version of the genome agent at time of sync */
	version: number;
}

export interface BootstrapManifest {
	synced_at: string;
	agents: Record<string, BootstrapManifestEntry>;
}

const EMPTY_MANIFEST: BootstrapManifest = { synced_at: "", agents: {} };

/** Load the bootstrap manifest from disk. Returns empty manifest if file missing. */
export async function loadManifest(path: string): Promise<BootstrapManifest> {
	try {
		const raw = await readFile(path, "utf-8");
		return JSON.parse(raw) as BootstrapManifest;
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...EMPTY_MANIFEST, agents: {} };
		}
		throw err;
	}
}

/** Save the bootstrap manifest to disk, creating parent directories if needed. */
export async function saveManifest(path: string, manifest: BootstrapManifest): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(manifest, null, 2));
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/genome/bootstrap-manifest.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add src/genome/bootstrap-manifest.ts test/genome/bootstrap-manifest.test.ts
git commit -m "feat(genome): add bootstrap manifest types and load/save"
```

---

### Task 2: Bootstrap Manifest — Content Hashing

**Files:**
- Modify: `src/genome/bootstrap-manifest.ts`
- Modify: `test/genome/bootstrap-manifest.test.ts`

**Step 1: Write the failing test**

Add to `test/genome/bootstrap-manifest.test.ts`:

```typescript
import { hashFileContent } from "../../src/genome/bootstrap-manifest.ts";

// ... inside the describe block:

test("hashFileContent produces consistent sha256 hash", async () => {
	const content = "name: test-agent\ndescription: A test\n";
	const hash1 = hashFileContent(content);
	const hash2 = hashFileContent(content);

	expect(hash1).toBe(hash2);
	expect(hash1).toMatch(/^sha256:[a-f0-9]{64}$/);
});

test("hashFileContent produces different hashes for different content", async () => {
	const hash1 = hashFileContent("name: alpha\n");
	const hash2 = hashFileContent("name: beta\n");

	expect(hash1).not.toBe(hash2);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/genome/bootstrap-manifest.test.ts`
Expected: FAIL — hashFileContent not exported

**Step 3: Write minimal implementation**

Add to `src/genome/bootstrap-manifest.ts`:

```typescript
import { createHash } from "node:crypto";

/** Compute a sha256 content hash for a bootstrap YAML file's contents. */
export function hashFileContent(content: string): string {
	const hash = createHash("sha256").update(content).digest("hex");
	return `sha256:${hash}`;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/genome/bootstrap-manifest.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/genome/bootstrap-manifest.ts test/genome/bootstrap-manifest.test.ts
git commit -m "feat(genome): add content hashing for bootstrap manifest"
```

---

### Task 3: Bootstrap Manifest — Build Manifest from Directory

**Files:**
- Modify: `src/genome/bootstrap-manifest.ts`
- Modify: `test/genome/bootstrap-manifest.test.ts`

**Step 1: Write the failing test**

Add to `test/genome/bootstrap-manifest.test.ts`:

```typescript
import { buildManifestFromBootstrap } from "../../src/genome/bootstrap-manifest.ts";

// ... inside the describe block:

test("buildManifestFromBootstrap creates manifest from bootstrap dir", async () => {
	// Create a mini bootstrap directory
	const bootstrapDir = join(tempDir, "mini-bootstrap");
	const { mkdir, writeFile } = await import("node:fs/promises");
	await mkdir(bootstrapDir, { recursive: true });

	await writeFile(join(bootstrapDir, "alpha.yaml"), "name: alpha\nversion: 1\n");
	await writeFile(join(bootstrapDir, "beta.yaml"), "name: beta\nversion: 3\n");
	await writeFile(join(bootstrapDir, "not-yaml.txt"), "ignore me");

	const manifest = await buildManifestFromBootstrap(bootstrapDir);

	expect(Object.keys(manifest.agents)).toHaveLength(2);
	expect(manifest.agents.alpha).toBeDefined();
	expect(manifest.agents.alpha!.version).toBe(1);
	expect(manifest.agents.alpha!.hash).toMatch(/^sha256:/);
	expect(manifest.agents.beta).toBeDefined();
	expect(manifest.agents.beta!.version).toBe(3);
	expect(manifest.synced_at).toBeTruthy();
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/genome/bootstrap-manifest.test.ts`
Expected: FAIL — buildManifestFromBootstrap not exported

**Step 3: Write minimal implementation**

Add to `src/genome/bootstrap-manifest.ts`:

```typescript
import { readFile as readFileAsync, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Build a manifest by scanning a bootstrap directory for YAML agent specs.
 * Records the content hash and version of each agent file.
 */
export async function buildManifestFromBootstrap(bootstrapDir: string): Promise<BootstrapManifest> {
	const entries = await readdir(bootstrapDir);
	const yamlFiles = entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

	const agents: Record<string, BootstrapManifestEntry> = {};

	for (const file of yamlFiles) {
		const content = await readFileAsync(join(bootstrapDir, file), "utf-8");
		const parsed = parse(content);
		const name = parsed?.name;
		if (!name) continue;

		agents[name] = {
			hash: hashFileContent(content),
			version: parsed.version ?? 1,
		};
	}

	return {
		synced_at: new Date().toISOString(),
		agents,
	};
}
```

Note: you'll need to move the `readFile` import alias or use a different name since there are now two sources. Use `readFileAsync` for the newly added import from `node:fs/promises` (the existing `readFile` import may need to be unified — the file already imports `readFile` from `node:fs/promises` at the top, so just use it directly and don't re-import).

**Step 4: Run test to verify it passes**

Run: `bun test test/genome/bootstrap-manifest.test.ts`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/genome/bootstrap-manifest.ts test/genome/bootstrap-manifest.test.ts
git commit -m "feat(genome): build manifest from bootstrap directory"
```

---

### Task 4: Enhanced `syncBootstrap()` — Manifest-Aware Sync

This is the core logic. Replace the add-only sync with a 4-way comparison.

**Files:**
- Modify: `src/genome/genome.ts`
- Modify: `test/genome/genome.test.ts`

**Step 1: Write the failing tests**

Add a new `describe("syncBootstrap (manifest-aware)")` block in `test/genome/genome.test.ts`:

```typescript
import { loadManifest } from "../../src/genome/bootstrap-manifest.ts";

// Inside the top-level describe("Genome"):

describe("syncBootstrap (manifest-aware)", () => {
	test("adds new bootstrap agents and records manifest", async () => {
		const root = join(tempDir, "sync-manifest-add");
		const genome = new Genome(root);
		await genome.init();

		// Create a small bootstrap dir with 2 agents
		const bootstrapDir = join(tempDir, "sync-bootstrap-add");
		await mkdir(bootstrapDir, { recursive: true });
		await writeFile(
			join(bootstrapDir, "alpha.yaml"),
			serializeAgentSpec(makeSpec({ name: "alpha" })),
		);
		await writeFile(
			join(bootstrapDir, "beta.yaml"),
			serializeAgentSpec(makeSpec({ name: "beta" })),
		);

		const result = await genome.syncBootstrap(bootstrapDir);

		expect(result.added).toContain("alpha");
		expect(result.added).toContain("beta");
		expect(genome.getAgent("alpha")).toBeDefined();
		expect(genome.getAgent("beta")).toBeDefined();

		// Manifest should be saved
		const manifest = await loadManifest(join(root, "bootstrap-manifest.json"));
		expect(manifest.agents.alpha).toBeDefined();
		expect(manifest.agents.beta).toBeDefined();
	});

	test("skips agents unchanged in both bootstrap and genome", async () => {
		const root = join(tempDir, "sync-manifest-skip");
		const genome = new Genome(root);
		await genome.init();

		const bootstrapDir = join(tempDir, "sync-bootstrap-skip");
		await mkdir(bootstrapDir, { recursive: true });
		const agentYaml = serializeAgentSpec(makeSpec({ name: "stable" }));
		await writeFile(join(bootstrapDir, "stable.yaml"), agentYaml);

		// First sync — adds agent
		await genome.syncBootstrap(bootstrapDir);
		expect(genome.getAgent("stable")!.version).toBe(1);

		// Second sync — no changes on either side
		const result = await genome.syncBootstrap(bootstrapDir);
		expect(result.added).toHaveLength(0);
		expect(result.updated).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	test("updates genome agent when bootstrap changed but genome did not evolve", async () => {
		const root = join(tempDir, "sync-manifest-update");
		const genome = new Genome(root);
		await genome.init();

		const bootstrapDir = join(tempDir, "sync-bootstrap-update");
		await mkdir(bootstrapDir, { recursive: true });
		await writeFile(
			join(bootstrapDir, "updatable.yaml"),
			serializeAgentSpec(makeSpec({ name: "updatable", system_prompt: "v1 prompt" })),
		);

		// First sync
		await genome.syncBootstrap(bootstrapDir);
		expect(genome.getAgent("updatable")!.system_prompt).toBe("v1 prompt");

		// Update bootstrap file (simulate developer improving bootstrap)
		await writeFile(
			join(bootstrapDir, "updatable.yaml"),
			serializeAgentSpec(makeSpec({ name: "updatable", system_prompt: "v2 improved prompt" })),
		);

		// Second sync — bootstrap changed, genome untouched
		const result = await genome.syncBootstrap(bootstrapDir);
		expect(result.updated).toContain("updatable");
		expect(genome.getAgent("updatable")!.system_prompt).toBe("v2 improved prompt");
	});

	test("detects conflict when both bootstrap and genome evolved", async () => {
		const root = join(tempDir, "sync-manifest-conflict");
		const genome = new Genome(root);
		await genome.init();

		const bootstrapDir = join(tempDir, "sync-bootstrap-conflict");
		await mkdir(bootstrapDir, { recursive: true });
		await writeFile(
			join(bootstrapDir, "contested.yaml"),
			serializeAgentSpec(makeSpec({ name: "contested", system_prompt: "original" })),
		);

		// First sync
		await genome.syncBootstrap(bootstrapDir);

		// Evolve the genome agent (simulating learn process)
		await genome.updateAgent(makeSpec({ name: "contested", system_prompt: "genome-evolved" }));

		// Also update bootstrap
		await writeFile(
			join(bootstrapDir, "contested.yaml"),
			serializeAgentSpec(makeSpec({ name: "contested", system_prompt: "bootstrap-improved" })),
		);

		// Sync should detect conflict, keep genome version
		const result = await genome.syncBootstrap(bootstrapDir);
		expect(result.conflicts).toContain("contested");
		expect(genome.getAgent("contested")!.system_prompt).toBe("genome-evolved");
	});

	test("preserves genome evolution when bootstrap unchanged", async () => {
		const root = join(tempDir, "sync-manifest-preserve");
		const genome = new Genome(root);
		await genome.init();

		const bootstrapDir = join(tempDir, "sync-bootstrap-preserve");
		await mkdir(bootstrapDir, { recursive: true });
		await writeFile(
			join(bootstrapDir, "learner.yaml"),
			serializeAgentSpec(makeSpec({ name: "learner", system_prompt: "base" })),
		);

		// First sync
		await genome.syncBootstrap(bootstrapDir);

		// Evolve the genome agent
		await genome.updateAgent(makeSpec({ name: "learner", system_prompt: "learned" }));

		// Sync again — bootstrap hasn't changed, genome evolved → skip
		const result = await genome.syncBootstrap(bootstrapDir);
		expect(result.updated).not.toContain("learner");
		expect(genome.getAgent("learner")!.system_prompt).toBe("learned");
	});
});
```

Note: You'll need to export `serializeAgentSpec` from `src/genome/genome.ts` (it's currently private). Add `export` before `function serializeAgentSpec`. Also import `writeFile` and `mkdir` from `node:fs/promises` in the test if not already imported.

**Step 2: Run tests to verify they fail**

Run: `bun test test/genome/genome.test.ts`
Expected: FAIL — syncBootstrap returns string[] not the new result type

**Step 3: Write the implementation**

Modify `src/genome/genome.ts`:

1. Add imports at the top:

```typescript
import {
	type BootstrapManifest,
	buildManifestFromBootstrap,
	hashFileContent,
	loadManifest,
	saveManifest,
} from "./bootstrap-manifest.ts";
```

2. Add a new return type:

```typescript
export interface SyncBootstrapResult {
	added: string[];
	updated: string[];
	conflicts: string[];
}
```

3. Replace `syncBootstrap()` method (lines 312-336):

```typescript
/**
 * Sync bootstrap agents into an existing genome using manifest-based tracking.
 * - New agents: added to genome
 * - Bootstrap changed, genome unchanged: genome updated from bootstrap
 * - Bootstrap changed, genome also evolved: conflict logged, genome preserved
 * - Bootstrap unchanged: skipped (regardless of genome state)
 */
async syncBootstrap(bootstrapDir: string): Promise<SyncBootstrapResult> {
	const manifestPath = join(this.rootPath, "bootstrap-manifest.json");
	const oldManifest = await loadManifest(manifestPath);
	const currentManifest = await buildManifestFromBootstrap(bootstrapDir);
	const specs = await loadBootstrapAgents(bootstrapDir);

	const added: string[] = [];
	const updated: string[] = [];
	const conflicts: string[] = [];

	for (const spec of specs) {
		const oldEntry = oldManifest.agents[spec.name];
		const currentEntry = currentManifest.agents[spec.name];
		const genomeAgent = this.agents.get(spec.name);

		if (!genomeAgent) {
			// New agent — add it
			const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
			await writeFile(yamlPath, serializeAgentSpec(spec));
			this.agents.set(spec.name, spec);
			added.push(spec.name);
			continue;
		}

		if (!oldEntry) {
			// Agent exists in genome but has no manifest entry (pre-manifest genome).
			// Don't touch it — treat as if genome evolved.
			continue;
		}

		const bootstrapChanged = currentEntry && oldEntry.hash !== currentEntry.hash;
		const genomeEvolved = genomeAgent.version !== oldEntry.version;

		if (!bootstrapChanged) {
			// Bootstrap unchanged — skip regardless of genome state
			continue;
		}

		if (genomeEvolved) {
			// Both changed — conflict, preserve genome
			conflicts.push(spec.name);
			continue;
		}

		// Bootstrap changed, genome unchanged — update genome from bootstrap
		const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
		await writeFile(yamlPath, serializeAgentSpec(spec));
		this.agents.set(spec.name, spec);
		updated.push(spec.name);
	}

	if (added.length > 0 || updated.length > 0) {
		await git(this.rootPath, "add", ".");
		const parts: string[] = [];
		if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
		if (updated.length > 0) parts.push(`updated: ${updated.join(", ")}`);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: sync bootstrap agents (${parts.join("; ")})`,
		);
	}

	// Save updated manifest with current bootstrap state
	await saveManifest(manifestPath, currentManifest);

	return { added, updated, conflicts };
}
```

4. Export `serializeAgentSpec` — change line 533 from `function serializeAgentSpec` to `export function serializeAgentSpec`.

**Step 4: Update the factory.ts caller**

Modify `src/agents/factory.ts` lines 69-72 to handle the new return type:

```typescript
const result = await genome.syncBootstrap(options.bootstrapDir);
if (result.added.length > 0) {
	console.error(`Synced new bootstrap agents: ${result.added.join(", ")}`);
}
if (result.updated.length > 0) {
	console.error(`Updated bootstrap agents: ${result.updated.join(", ")}`);
}
if (result.conflicts.length > 0) {
	console.error(
		`Bootstrap sync conflicts (genome preserved): ${result.conflicts.join(", ")}`,
	);
}
```

**Step 5: Update existing test expectations**

The existing `initFromBootstrap` test at line 340 references `genome.agentCount()` — this may need adjustment if the bootstrap agent count changes. The existing syncBootstrap test may not exist, but verify the factory test still passes by running:

Run: `bun test test/genome/genome.test.ts test/agents/factory.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/genome/genome.ts src/agents/factory.ts test/genome/genome.test.ts
git commit -m "feat(genome): manifest-aware bidirectional bootstrap sync"
```

---

### Task 5: Root Agent Capability Merge on Sync

When new bootstrap agents are synced, the root agent's capability list must be updated to include them. Otherwise the root can't delegate to agents it doesn't know about.

**Files:**
- Modify: `src/genome/genome.ts`
- Modify: `test/genome/genome.test.ts`

**Step 1: Write the failing test**

Add to the `describe("syncBootstrap (manifest-aware)")` block:

```typescript
test("merges new capabilities into root agent when bootstrap root references them", async () => {
	const root = join(tempDir, "sync-root-caps");
	const genome = new Genome(root);
	await genome.init();

	const bootstrapDir = join(tempDir, "sync-bootstrap-caps");
	await mkdir(bootstrapDir, { recursive: true });

	// Create root with limited capabilities
	await writeFile(
		join(bootstrapDir, "root.yaml"),
		serializeAgentSpec(
			makeSpec({ name: "root", capabilities: ["reader", "editor", "debugger"] }),
		),
	);
	// Create the agents it references
	await writeFile(
		join(bootstrapDir, "reader.yaml"),
		serializeAgentSpec(makeSpec({ name: "reader" })),
	);
	await writeFile(
		join(bootstrapDir, "editor.yaml"),
		serializeAgentSpec(makeSpec({ name: "editor" })),
	);
	await writeFile(
		join(bootstrapDir, "debugger.yaml"),
		serializeAgentSpec(makeSpec({ name: "debugger" })),
	);

	// First sync — genome root gets reader, editor, debugger capabilities
	await genome.syncBootstrap(bootstrapDir);
	expect(genome.getAgent("root")!.capabilities).toEqual(["reader", "editor", "debugger"]);

	// Now update bootstrap root to add a new capability
	await writeFile(
		join(bootstrapDir, "root.yaml"),
		serializeAgentSpec(
			makeSpec({
				name: "root",
				capabilities: ["reader", "editor", "debugger", "verifier"],
			}),
		),
	);
	await writeFile(
		join(bootstrapDir, "verifier.yaml"),
		serializeAgentSpec(makeSpec({ name: "verifier" })),
	);

	// Second sync — root hasn't been evolved by learn, so bootstrap update applies.
	// Plus verifier is a new agent. Root's capabilities should include verifier.
	const result = await genome.syncBootstrap(bootstrapDir);
	expect(result.added).toContain("verifier");
	const rootCaps = genome.getAgent("root")!.capabilities;
	expect(rootCaps).toContain("verifier");
	expect(rootCaps).toContain("reader");
	expect(rootCaps).toContain("editor");
	expect(rootCaps).toContain("debugger");
});

test("merges bootstrap capabilities into evolved root without removing genome-only caps", async () => {
	const root = join(tempDir, "sync-root-caps-merge");
	const genome = new Genome(root);
	await genome.init();

	const bootstrapDir = join(tempDir, "sync-bootstrap-caps-merge");
	await mkdir(bootstrapDir, { recursive: true });

	await writeFile(
		join(bootstrapDir, "root.yaml"),
		serializeAgentSpec(
			makeSpec({ name: "root", capabilities: ["reader"] }),
		),
	);
	await writeFile(
		join(bootstrapDir, "reader.yaml"),
		serializeAgentSpec(makeSpec({ name: "reader" })),
	);

	// First sync
	await genome.syncBootstrap(bootstrapDir);

	// Genome root evolves — learn adds a capability the bootstrap doesn't have
	const genomeRoot = genome.getAgent("root")!;
	await genome.updateAgent({
		...genomeRoot,
		capabilities: ["reader", "custom-agent"],
		system_prompt: "evolved prompt",
	});

	// Bootstrap adds a new capability
	await writeFile(
		join(bootstrapDir, "root.yaml"),
		serializeAgentSpec(
			makeSpec({ name: "root", capabilities: ["reader", "debugger"] }),
		),
	);
	await writeFile(
		join(bootstrapDir, "debugger.yaml"),
		serializeAgentSpec(makeSpec({ name: "debugger" })),
	);

	// Sync — root has a conflict (both evolved), but new capabilities should merge
	const result = await genome.syncBootstrap(bootstrapDir);
	const rootCaps = genome.getAgent("root")!.capabilities;
	// Should keep genome's evolved prompt
	expect(genome.getAgent("root")!.system_prompt).toBe("evolved prompt");
	// Should have all capabilities from both sides
	expect(rootCaps).toContain("reader");
	expect(rootCaps).toContain("custom-agent");
	expect(rootCaps).toContain("debugger");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/genome/genome.test.ts`
Expected: FAIL — capability merge not implemented

**Step 3: Implement capability merge**

Add a private method to `Genome` and call it at the end of `syncBootstrap()`, before saving the manifest:

```typescript
/**
 * Merge bootstrap root capabilities into genome root.
 * Adds any capabilities from bootstrap root that the genome root doesn't have,
 * but never removes capabilities the genome root already has.
 */
private async mergeRootCapabilities(bootstrapSpecs: AgentSpec[]): Promise<boolean> {
	const bootstrapRoot = bootstrapSpecs.find((s) => s.name === "root");
	const genomeRoot = this.agents.get("root");
	if (!bootstrapRoot || !genomeRoot) return false;

	const existing = new Set(genomeRoot.capabilities);
	const toAdd = bootstrapRoot.capabilities.filter((c) => !existing.has(c));

	if (toAdd.length === 0) return false;

	const merged = [...genomeRoot.capabilities, ...toAdd];
	const updated = { ...genomeRoot, capabilities: merged };
	const yamlPath = join(this.rootPath, "agents", "root.yaml");
	await writeFile(yamlPath, serializeAgentSpec(updated));
	this.agents.set("root", updated);
	return true;
}
```

Call it in `syncBootstrap()` right before saving the manifest:

```typescript
// Merge bootstrap root's capabilities into genome root
const capsMerged = await this.mergeRootCapabilities(specs);
if (capsMerged) {
	// Stage the root.yaml change if not already staged
	if (added.length === 0 && updated.length === 0) {
		await git(this.rootPath, "add", ".");
		await git(this.rootPath, "commit", "-m", "genome: merge bootstrap capabilities into root");
	}
}
```

Note: if there's already a commit being made (added/updated non-empty), the root.yaml change gets included in that commit since `git add .` is used. Only make a separate commit when root cap merge is the only change.

**Step 4: Run test to verify it passes**

Run: `bun test test/genome/genome.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/genome/genome.ts test/genome/genome.test.ts
git commit -m "feat(genome): merge bootstrap capabilities into root on sync"
```

---

### Task 6: Export Learnings CLI Command

**Files:**
- Modify: `src/host/cli.ts` (add `genome-export` subcommand to `CliCommand` and `parseArgs` and `runCli`)
- Create: `src/genome/export-learnings.ts`
- Modify: `test/host/cli.test.ts` (parseArgs tests for `--genome export`)
- Create: `test/genome/export-learnings.test.ts`

**Step 1: Write the failing parseArgs test**

Add to `test/host/cli.test.ts` in the `parseArgs` describe block:

```typescript
test("--genome export returns genome-export command", () => {
	const result = parseArgs(["--genome", "export"]);
	expect(result).toEqual({
		kind: "genome-export",
		genomePath: defaultGenomePath,
	});
});

test("--genome-path /custom --genome export uses custom genome path", () => {
	const result = parseArgs(["--genome-path", "/custom", "--genome", "export"]);
	expect(result).toEqual({
		kind: "genome-export",
		genomePath: "/custom",
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/host/cli.test.ts`
Expected: FAIL — genome-export not a valid CliCommand kind

**Step 3: Add the CliCommand variant and parseArgs handling**

In `src/host/cli.ts`:

Add to `CliCommand` union (around line 101):
```typescript
| { kind: "genome-export"; genomePath: string }
```

Add to the `--genome` pre-scan block (after the `rollback` case, around line 177):
```typescript
if (sub === "export") return { kind: "genome-export", genomePath };
```

**Step 4: Run parseArgs test to verify it passes**

Run: `bun test test/host/cli.test.ts`
Expected: PASS

**Step 5: Write the export-learnings module test**

Create `test/genome/export-learnings.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Genome, serializeAgentSpec } from "../../src/genome/genome.ts";
import { exportLearnings, type ExportResult } from "../../src/genome/export-learnings.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: overrides.name ?? "test-agent",
		description: overrides.description ?? "A test agent",
		system_prompt: overrides.system_prompt ?? "You are a test agent.",
		model: overrides.model ?? "fast",
		capabilities: overrides.capabilities ?? ["read_file"],
		constraints: overrides.constraints ?? { ...DEFAULT_CONSTRAINTS },
		tags: overrides.tags ?? ["test"],
		version: overrides.version ?? 1,
	};
}

describe("exportLearnings", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-export-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("identifies agents that evolved beyond their bootstrap version", async () => {
		const genomeDir = join(tempDir, "export-genome");
		const bootstrapDir = join(tempDir, "export-bootstrap");
		await mkdir(bootstrapDir, { recursive: true });

		// Set up bootstrap with v1 agent
		await writeFile(
			join(bootstrapDir, "reader.yaml"),
			serializeAgentSpec(makeSpec({ name: "reader", system_prompt: "basic reader" })),
		);

		// Set up genome, init from bootstrap, then evolve
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);

		// Evolve reader via updateAgent (bumps version)
		await genome.updateAgent(
			makeSpec({ name: "reader", system_prompt: "improved reader with batching" }),
		);

		const result = await exportLearnings(genomeDir, bootstrapDir);

		expect(result.evolved).toHaveLength(1);
		expect(result.evolved[0]!.name).toBe("reader");
		expect(result.evolved[0]!.genomeVersion).toBe(2);
		expect(result.evolved[0]!.bootstrapVersion).toBe(1);
	});

	test("identifies agents that exist only in genome (learned agents)", async () => {
		const genomeDir = join(tempDir, "export-learned");
		const bootstrapDir = join(tempDir, "export-learned-boot");
		await mkdir(bootstrapDir, { recursive: true });

		await writeFile(
			join(bootstrapDir, "root.yaml"),
			serializeAgentSpec(makeSpec({ name: "root" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);

		// Add a genome-only agent (simulating learn process)
		await genome.addAgent(makeSpec({ name: "specialist", description: "learned specialist" }));

		const result = await exportLearnings(genomeDir, bootstrapDir);

		expect(result.genomeOnly).toHaveLength(1);
		expect(result.genomeOnly[0]!.name).toBe("specialist");
	});

	test("does not report agents that are still at bootstrap version", async () => {
		const genomeDir = join(tempDir, "export-unchanged");
		const bootstrapDir = join(tempDir, "export-unchanged-boot");
		await mkdir(bootstrapDir, { recursive: true });

		await writeFile(
			join(bootstrapDir, "stable.yaml"),
			serializeAgentSpec(makeSpec({ name: "stable" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);

		const result = await exportLearnings(genomeDir, bootstrapDir);

		expect(result.evolved).toHaveLength(0);
		expect(result.genomeOnly).toHaveLength(0);
	});
});
```

**Step 6: Run test to verify it fails**

Run: `bun test test/genome/export-learnings.test.ts`
Expected: FAIL — module not found

**Step 7: Write the implementation**

Create `src/genome/export-learnings.ts`:

```typescript
import { Genome } from "./genome.ts";
import { loadBootstrapAgents } from "../agents/loader.ts";

export interface EvolvedAgent {
	name: string;
	genomeVersion: number;
	bootstrapVersion: number;
	genomePrompt: string;
	bootstrapPrompt: string;
}

export interface GenomeOnlyAgent {
	name: string;
	description: string;
	version: number;
}

export interface ExportResult {
	/** Agents that exist in both but have evolved in the genome */
	evolved: EvolvedAgent[];
	/** Agents that exist only in the genome (created by learn process) */
	genomeOnly: GenomeOnlyAgent[];
}

/**
 * Compare genome agents against bootstrap agents.
 * Returns agents that have evolved or were created by the learn process.
 */
export async function exportLearnings(
	genomePath: string,
	bootstrapDir: string,
): Promise<ExportResult> {
	const genome = new Genome(genomePath);
	await genome.loadFromDisk();

	const bootstrapSpecs = await loadBootstrapAgents(bootstrapDir);
	const bootstrapByName = new Map(bootstrapSpecs.map((s) => [s.name, s]));

	const evolved: EvolvedAgent[] = [];
	const genomeOnly: GenomeOnlyAgent[] = [];

	for (const agent of genome.allAgents()) {
		const bootstrap = bootstrapByName.get(agent.name);

		if (!bootstrap) {
			genomeOnly.push({
				name: agent.name,
				description: agent.description,
				version: agent.version,
			});
			continue;
		}

		if (agent.version > bootstrap.version) {
			evolved.push({
				name: agent.name,
				genomeVersion: agent.version,
				bootstrapVersion: bootstrap.version,
				genomePrompt: agent.system_prompt,
				bootstrapPrompt: bootstrap.system_prompt,
			});
		}
	}

	return { evolved, genomeOnly };
}
```

**Step 8: Run test to verify it passes**

Run: `bun test test/genome/export-learnings.test.ts`
Expected: PASS (3 tests)

**Step 9: Wire up the CLI handler**

Add to `runCli()` in `src/host/cli.ts` (after the `genome-rollback` block, around line 619):

```typescript
if (command.kind === "genome-export") {
	const { exportLearnings } = await import("../genome/export-learnings.ts");
	const bootstrapDir = join(import.meta.dir, "../../bootstrap");
	const result = await exportLearnings(command.genomePath, bootstrapDir);

	if (result.evolved.length === 0 && result.genomeOnly.length === 0) {
		console.log("No learnings to export. Genome matches bootstrap.");
		return;
	}

	if (result.evolved.length > 0) {
		console.log("\nEvolved agents (genome improved beyond bootstrap):");
		for (const agent of result.evolved) {
			console.log(`  ${agent.name}: v${agent.bootstrapVersion} → v${agent.genomeVersion}`);
		}
	}

	if (result.genomeOnly.length > 0) {
		console.log("\nGenome-only agents (created by learn process):");
		for (const agent of result.genomeOnly) {
			console.log(`  ${agent.name} (v${agent.version}) — ${agent.description}`);
		}
	}

	console.log(
		"\nTo review diffs, compare files in:",
	);
	console.log(`  Genome:    ${command.genomePath}/agents/`);
	console.log(`  Bootstrap: ${bootstrapDir}/`);
	return;
}
```

**Step 10: Run all tests**

Run: `bun test test/host/cli.test.ts test/genome/export-learnings.test.ts`
Expected: PASS

**Step 11: Commit**

```bash
git add src/genome/export-learnings.ts test/genome/export-learnings.test.ts src/host/cli.ts test/host/cli.test.ts
git commit -m "feat(cli): add --genome export command to surface learned improvements"
```

---

### Task 7: Development Mode Detection

**Files:**
- Create: `src/genome/dev-mode.ts`
- Create: `test/genome/dev-mode.test.ts`

**Step 1: Write the failing test**

Create `test/genome/dev-mode.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDevMode } from "../../src/genome/dev-mode.ts";

describe("isDevMode", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-devmode-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("returns true when workDir contains bootstrap/ and src/genome/", async () => {
		const workDir = join(tempDir, "sprout-src");
		await mkdir(join(workDir, "bootstrap"), { recursive: true });
		await mkdir(join(workDir, "src/genome"), { recursive: true });

		expect(isDevMode(workDir)).toBe(true);
	});

	test("returns false when workDir is a normal project", async () => {
		const workDir = join(tempDir, "normal-project");
		await mkdir(join(workDir, "src"), { recursive: true });

		expect(isDevMode(workDir)).toBe(false);
	});

	test("returns false when only bootstrap/ exists", async () => {
		const workDir = join(tempDir, "partial");
		await mkdir(join(workDir, "bootstrap"), { recursive: true });

		expect(isDevMode(workDir)).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/genome/dev-mode.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/genome/dev-mode.ts`:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Detect whether sprout is running inside its own source tree.
 * True when the working directory contains both bootstrap/ and src/genome/.
 */
export function isDevMode(workDir: string): boolean {
	return (
		existsSync(join(workDir, "bootstrap")) && existsSync(join(workDir, "src", "genome"))
	);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/genome/dev-mode.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/genome/dev-mode.ts test/genome/dev-mode.test.ts
git commit -m "feat(genome): add development mode detection"
```

---

### Task 8: Inject Development Mode Postscript

**Files:**
- Modify: `src/agents/factory.ts`
- Modify: `test/agents/factory.test.ts`

**Step 1: Write the failing test**

Add to `test/agents/factory.test.ts`:

```typescript
import { isDevMode } from "../../src/genome/dev-mode.ts";

test("injects dev-mode postscript for quartermaster when workDir is sprout source", async () => {
	const genomePath = join(tempDir, "dev-mode-test");
	const bootstrapDir = join(import.meta.dir, "../../bootstrap");

	// Use the actual sprout source dir as workDir — it will detect dev mode
	const sproutRoot = join(import.meta.dir, "../..");
	expect(isDevMode(sproutRoot)).toBe(true);

	const result = await createAgent({
		genomePath,
		bootstrapDir,
		workDir: sproutRoot,
	});

	// Check that the quartermaster postscript was injected
	const qmPostscript = await result.genome.loadAgentPostscript("quartermaster");
	expect(qmPostscript).toContain("Development Mode");
	expect(qmPostscript).toContain("bootstrap");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/factory.test.ts`
Expected: FAIL — no dev mode postscript injected

**Step 3: Implement the injection**

Modify `src/agents/factory.ts`:

Add import:
```typescript
import { isDevMode } from "../genome/dev-mode.ts";
```

After the `syncBootstrap` / `initFromBootstrap` block (around line 79), add:

```typescript
// Inject development mode postscript if running inside sprout's source tree
if (options.workDir && isDevMode(options.workDir)) {
	const existingPostscript = await genome.loadAgentPostscript("quartermaster");
	if (!existingPostscript.includes("Development Mode")) {
		const devPostscript = `## Development Mode

You are running inside sprout's own source tree. Changes you make affect
two distinct targets:

1. **Runtime genome** (\`save_agent\` tool) — changes take effect immediately
   for this sprout instance. Use for experimentation and runtime adaptation.

2. **Bootstrap source** (files in \`bootstrap/\`) — changes here become the
   default for all new sprout genomes. Use when an improvement should ship
   as part of the product.

When the fabricator creates or modifies an agent:
- Default to runtime genome (save_agent) for new experimental agents
- When an improvement is proven (evaluated as helpful), suggest promoting
  it to bootstrap via a file write to bootstrap/{agent-name}.yaml
- Always note which target was used in your response

The \`--genome export\` command can also harvest runtime improvements into
bootstrap for human review.`;
		await genome.savePostscript("agents/quartermaster.md", devPostscript);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/agents/factory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/factory.ts test/agents/factory.test.ts
git commit -m "feat(genome): inject dev-mode postscript into quartermaster"
```

---

### Task 9: Update Quartermaster and Fabricator Bootstrap Specs

**Files:**
- Modify: `bootstrap/qm-fabricator.yaml`
- Modify: `bootstrap/quartermaster.yaml`

No TDD for this task — these are static YAML config changes.

**Step 1: Update qm-fabricator.yaml**

Add `write_file` to capabilities (so it can write to bootstrap/ in dev mode):

```yaml
capabilities:
  - read_file
  - write_file
  - save_agent
  - glob
```

Add to the system prompt, after the "After creating an agent" section:

```
## Development mode

When a development-mode postscript is active (your orchestrator will tell you),
you have two targets for new or updated agents:

- **save_agent**: Writes to the runtime genome. Use this by default.
- **write_file to bootstrap/{name}.yaml**: Writes to the bootstrap source code.
  Use this when an agent is proven and should ship as part of the product.

When writing to bootstrap, match the exact YAML format of existing bootstrap
files. Read a few examples first if you haven't already.
```

**Step 2: Update quartermaster.yaml**

Add to the system prompt, after the "Key principles" section:

```
## Development mode

When running inside sprout's source tree, you'll receive a development-mode
postscript. In this mode, improvements you orchestrate can target either the
runtime genome (default) or the bootstrap source code (for product changes).

Use `--genome export` to review what the learn process has improved. Consider
promoting proven improvements to bootstrap.
```

**Step 3: Run all tests to verify nothing broke**

Run: `bun test`
Expected: PASS (the bootstrap agent count may need updating in tests that hardcode it)

**Step 4: Commit**

```bash
git add bootstrap/qm-fabricator.yaml bootstrap/quartermaster.yaml
git commit -m "feat(bootstrap): add dev-mode awareness to quartermaster and fabricator"
```

---

### Task 10: Fix Bootstrap Agent Count in Tests

The number of bootstrap agents may have changed. Update any hardcoded counts.

**Step 1: Count current bootstrap agents**

Run: `ls bootstrap/*.yaml | wc -l`

**Step 2: Find and update hardcoded counts**

Search for the old count in test files:

Run: `grep -rn 'agentCount.*19\|toHaveLength.*19\|toBe.*19' test/`

Update all matches to the current count.

**Step 3: Run full test suite**

Run: `bun test`
Expected: PASS

**Step 4: Commit**

```bash
git add -u test/
git commit -m "fix(test): update bootstrap agent count expectations"
```

---

### Task 11: Full Integration Verification

**Step 1: Run the complete test suite**

Run: `bun test`
Expected: All tests pass

**Step 2: Run typecheck**

Run: `tsc --noEmit`
Expected: No type errors

**Step 3: Run biome**

Run: `bunx biome check src/ test/`
Expected: No errors

**Step 4: Test the export-learnings command manually**

Run: `bun src/host/cli.ts --genome export`
Expected: Lists evolved agents (reader v4, command-runner v7, editor v6, etc.) and genome-only agents

**Step 5: Final commit if any fixes needed**

```bash
git add -u
git commit -m "fix: integration test fixes for genome reconciliation"
```
