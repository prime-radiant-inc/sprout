# Genome Format Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the legacy `.yaml` genome format. The genome uses the same YAML-fronted Markdown (`.md`) format as the root directory — one parser, one serializer, one format.

**Architecture:** Add `serializeAgentMarkdown` to `markdown-loader.ts` (inverse of `parseAgentMarkdown`). Migrate all genome write paths to emit `.md` instead of `.yaml`. Delete `parseAgentSpec`, `serializeAgentSpec`, and all `.yaml`-related read/write code. Preserve unknown frontmatter fields through round-trips via an `_extra` bag on `AgentSpec`.

**Tech Stack:** TypeScript, Bun, `yaml` package (parse/stringify)

---

### Task 1: Add `serializeAgentMarkdown` with round-trip preservation

**Context:** `parseAgentMarkdown` in `src/agents/markdown-loader.ts` reads `.md` files but there is no inverse serializer. The genome needs to write `.md` files. Unknown frontmatter fields must survive parse→serialize round-trips (stored in `AgentSpec._extra`).

**Files:**
- Modify: `src/kernel/types.ts` — add `_extra?: Record<string, unknown>` to `AgentSpec`
- Modify: `src/agents/markdown-loader.ts` — collect unknown frontmatter into `_extra`, add `serializeAgentMarkdown`
- Create: `test/agents/markdown-serializer.test.ts`

**Step 1: Write failing tests for `serializeAgentMarkdown`**

Write tests covering:
1. Basic round-trip: `parseAgentMarkdown(serializeAgentMarkdown(spec))` equals original spec
2. System prompt becomes markdown body (not a YAML field)
3. Known fields appear in frontmatter: `name`, `description`, `model`, `tools`, `agents`, `constraints`, `tags`, `version`, `thinking`
4. Unknown frontmatter fields survive round-trip via `_extra`
5. Empty `_extra` produces clean output (no empty `_extra: {}` in frontmatter)
6. `_extra` is not a frontmatter field — it should not be serialized as `_extra`

```typescript
import { describe, expect, test } from "bun:test";
import { parseAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { serializeAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";

describe("serializeAgentMarkdown", () => {
	const baseSpec: AgentSpec = {
		name: "test-agent",
		description: "A test agent",
		system_prompt: "You are a helpful test agent.",
		model: "claude-sonnet-4-20250514",
		tools: ["read_file", "write_file"],
		agents: [],
		capabilities: ["read_file", "write_file"],
		constraints: { ...DEFAULT_CONSTRAINTS },
		tags: ["test"],
		version: 1,
	};

	test("round-trips a basic spec", () => {
		const md = serializeAgentMarkdown(baseSpec);
		const parsed = parseAgentMarkdown(md, "test.md");
		expect(parsed.name).toBe(baseSpec.name);
		expect(parsed.description).toBe(baseSpec.description);
		expect(parsed.system_prompt).toBe(baseSpec.system_prompt);
		expect(parsed.model).toBe(baseSpec.model);
		expect(parsed.tools).toEqual(baseSpec.tools);
		expect(parsed.agents).toEqual(baseSpec.agents);
		expect(parsed.tags).toEqual(baseSpec.tags);
		expect(parsed.version).toBe(baseSpec.version);
	});

	test("system prompt is the markdown body, not a frontmatter field", () => {
		const md = serializeAgentMarkdown(baseSpec);
		expect(md).not.toContain("system_prompt:");
		expect(md).toContain("You are a helpful test agent.");
		// Body comes after closing ---
		const parts = md.split("\n---\n");
		expect(parts.length).toBe(2);
		expect(parts[1]!.trim()).toBe("You are a helpful test agent.");
	});

	test("preserves thinking field when present", () => {
		const spec = { ...baseSpec, thinking: { budget_tokens: 5000 } };
		const md = serializeAgentMarkdown(spec);
		const parsed = parseAgentMarkdown(md, "test.md");
		expect(parsed.thinking).toEqual({ budget_tokens: 5000 });
	});

	test("preserves unknown frontmatter fields via _extra", () => {
		const md = [
			"---",
			"name: test-agent",
			"description: A test agent",
			"model: claude-sonnet-4-20250514",
			"tools: [read_file]",
			"agents: []",
			"tags: []",
			"version: 1",
			"custom_field: hello",
			"another_field: 42",
			"---",
			"System prompt here.",
		].join("\n");
		const parsed = parseAgentMarkdown(md, "test.md");
		expect(parsed._extra).toEqual({ custom_field: "hello", another_field: 42 });
		const reserialized = serializeAgentMarkdown(parsed);
		expect(reserialized).toContain("custom_field: hello");
		expect(reserialized).toContain("another_field: 42");
		// _extra itself must NOT appear in output
		expect(reserialized).not.toContain("_extra:");
	});

	test("omits empty arrays and default values for clean output", () => {
		const spec = { ...baseSpec, agents: [], tags: [] };
		const md = serializeAgentMarkdown(spec);
		// Empty arrays should still be represented (so parser doesn't fall back)
		const parsed = parseAgentMarkdown(md, "test.md");
		expect(parsed.agents).toEqual([]);
		expect(parsed.tags).toEqual([]);
	});

	test("does not include capabilities in frontmatter", () => {
		const md = serializeAgentMarkdown(baseSpec);
		expect(md).not.toContain("capabilities:");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test test/agents/markdown-serializer.test.ts`
Expected: FAIL — `serializeAgentMarkdown` doesn't exist yet, `_extra` doesn't exist on `AgentSpec`

**Step 3: Add `_extra` to `AgentSpec`**

In `src/kernel/types.ts`, add to the `AgentSpec` interface:

```typescript
/** Bag for unknown frontmatter fields that survive parse→serialize round-trips. */
_extra?: Record<string, unknown>;
```

**Step 4: Update `parseAgentMarkdown` to collect unknown fields into `_extra`**

In `src/agents/markdown-loader.ts`, after parsing frontmatter and extracting known fields, collect any remaining keys into `_extra`:

```typescript
const KNOWN_FIELDS = new Set([
	"name", "description", "model", "tools", "agents",
	"constraints", "tags", "version", "thinking",
]);

const extra: Record<string, unknown> = {};
for (const key of Object.keys(raw)) {
	if (!KNOWN_FIELDS.has(key)) {
		extra[key] = raw[key];
	}
}
if (Object.keys(extra).length > 0) {
	spec._extra = extra;
}
```

**Step 5: Implement `serializeAgentMarkdown`**

Add to `src/agents/markdown-loader.ts`:

```typescript
import { stringify } from "yaml";

export function serializeAgentMarkdown(spec: AgentSpec): string {
	const fm: Record<string, unknown> = {
		name: spec.name,
		description: spec.description,
		model: spec.model,
		tools: spec.tools,
		agents: spec.agents,
		constraints: spec.constraints,
		tags: spec.tags,
		version: spec.version,
	};
	if (spec.thinking !== undefined) {
		fm.thinking = spec.thinking;
	}
	// Merge unknown fields back (round-trip preservation)
	if (spec._extra) {
		for (const [key, value] of Object.entries(spec._extra)) {
			fm[key] = value;
		}
	}
	const yamlStr = stringify(fm);
	return `---\n${yamlStr}---\n${spec.system_prompt}\n`;
}
```

**Step 6: Run tests to verify they pass**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test test/agents/markdown-serializer.test.ts`
Expected: PASS

**Step 7: Run full test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: All existing tests still pass. The `_extra` field is optional, so no existing code breaks.

**Step 8: Commit**

```bash
git add src/kernel/types.ts src/agents/markdown-loader.ts test/agents/markdown-serializer.test.ts
git commit -m "feat(agents): add serializeAgentMarkdown with round-trip preservation of unknown fields"
```

---

### Task 2: Migrate `Genome` write paths from `.yaml` to `.md`

**Context:** `Genome.addAgent()`, `updateAgent()`, `removeAgent()`, `initFromRoot()`, `syncRoot()`, and `reconcileRootCapabilities()` all write `.yaml` files and call `serializeAgentSpec`. Switch them to write `.md` files using `serializeAgentMarkdown`.

**Files:**
- Modify: `src/genome/genome.ts` — all agent write methods
- Modify: `test/genome/genome.test.ts` — update expectations

**Step 1: Write failing test for `.md` file creation**

Add a test to `test/genome/genome.test.ts` that checks `addAgent` writes a `.md` file:

```typescript
test("addAgent writes .md file, not .yaml", async () => {
	await genome.addAgent(testSpec);
	const mdPath = join(genomePath, "agents", `${testSpec.name}.md`);
	const yamlPath = join(genomePath, "agents", `${testSpec.name}.yaml`);
	expect(await exists(mdPath)).toBe(true);
	expect(await exists(yamlPath)).toBe(false);
	// Verify content is valid markdown-fronted spec
	const content = await readFile(mdPath, "utf-8");
	const parsed = parseAgentMarkdown(content, mdPath);
	expect(parsed.name).toBe(testSpec.name);
	expect(parsed.system_prompt).toBe(testSpec.system_prompt);
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test test/genome/genome.test.ts`
Expected: FAIL — `addAgent` still writes `.yaml`

**Step 3: Migrate `addAgent`**

In `src/genome/genome.ts`, change `addAgent`:

```typescript
async addAgent(spec: AgentSpec): Promise<void> {
	const mdPath = join(this.rootPath, "agents", `${spec.name}.md`);
	await writeFile(mdPath, serializeAgentMarkdown(spec));
	this.agents.set(spec.name, spec);
	await git(this.rootPath, "add", mdPath);
	await git(this.rootPath, "commit", "-m", `genome: add agent '${spec.name}'`);
}
```

Import `serializeAgentMarkdown` from `../agents/markdown-loader.ts`.

**Step 4: Migrate `updateAgent`**

```typescript
async updateAgent(spec: AgentSpec): Promise<void> {
	const existing = this.agents.get(spec.name);
	if (!existing) {
		throw new Error(`Cannot update agent '${spec.name}': not found`);
	}
	const nextVersion = existing.version + 1;
	const updated = { ...spec, version: nextVersion };
	const mdPath = join(this.rootPath, "agents", `${spec.name}.md`);
	await writeFile(mdPath, serializeAgentMarkdown(updated));
	this.agents.set(spec.name, updated);
	await git(this.rootPath, "add", mdPath);
	await git(this.rootPath, "commit", "-m", `genome: update agent '${spec.name}' to v${nextVersion}`);
}
```

**Step 5: Migrate `removeAgent`**

```typescript
async removeAgent(name: string): Promise<void> {
	if (!this.agents.has(name)) {
		throw new Error(`Cannot remove agent '${name}': not found`);
	}
	const mdPath = join(this.rootPath, "agents", `${name}.md`);
	await rm(mdPath);
	this.agents.delete(name);
	await git(this.rootPath, "add", mdPath);
	await git(this.rootPath, "commit", "-m", `genome: remove agent '${name}'`);
}
```

**Step 6: Migrate `initFromRoot`**

```typescript
async initFromRoot(rootDir: string): Promise<void> {
	if (this.agents.size > 0) {
		throw new Error("Cannot initialize from root: agents already exist");
	}
	const specs = await loadRootAgents(rootDir);
	for (const spec of specs) {
		const mdPath = join(this.rootPath, "agents", `${spec.name}.md`);
		await writeFile(mdPath, serializeAgentMarkdown(spec));
		this.agents.set(spec.name, spec);
	}
	await git(this.rootPath, "add", ".");
	await git(this.rootPath, "commit", "-m", "genome: initialize from root agents");
}
```

**Step 7: Migrate `syncRoot`**

Change all `${name}.yaml` references to `${name}.md` and replace `serializeAgentSpec` calls with `serializeAgentMarkdown`. Specifically:
- Line ~351: `const mdPath = join(this.rootPath, "agents", \`${spec.name}.md\`);`
- Line ~361: same
- Line ~389: `filesToStage.push(join(this.rootPath, "agents", \`${name}.md\`));`
- Line ~392: `filesToStage.push(join(this.rootPath, "agents", "root.md"));`
- All `serializeAgentSpec(spec)` → `serializeAgentMarkdown(spec)`

**Step 8: Migrate `reconcileRootCapabilities`**

Line ~445: Change `root.yaml` → `root.md`, `serializeAgentSpec` → `serializeAgentMarkdown`.

**Step 9: Run tests to verify**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test test/genome/genome.test.ts`
Expected: All pass. Some existing tests may need path expectations updated from `.yaml` to `.md`.

**Step 10: Run full test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: PASS

**Step 11: Commit**

```bash
git add src/genome/genome.ts test/genome/genome.test.ts
git commit -m "refactor(genome): write .md files instead of .yaml for agent specs"
```

---

### Task 3: Migrate `save_agent` primitive from inline YAML to `.md`

**Context:** The `save_agent` primitive in `src/kernel/primitives.ts` accepts raw YAML from LLM output, parses it inline, and calls `genome.addAgent()`. Since `addAgent` now writes `.md`, the primitive just needs its parameter name and description updated. The inline parsing should use `parseAgentMarkdown` or accept markdown-formatted input.

**Decision:** The simplest approach is to keep the parameter as `yaml` (accepting YAML input from the LLM) but parse it properly using `parseAgentSpec`-equivalent logic. Since we're deleting `parseAgentSpec` later, inline the essential validation here. Actually — the LLM sends structured YAML. We should accept either YAML or markdown format for robustness, but the cleanest approach is to construct an `AgentSpec` from the parsed fields and let `addAgent` handle serialization.

**Files:**
- Modify: `src/kernel/primitives.ts` — update `save_agent` primitive
- Modify: `test/kernel/primitives.test.ts` (if it tests `save_agent`)

**Step 1: Check existing test coverage for `save_agent`**

Read `test/kernel/primitives.test.ts` (or whatever file tests the save_agent primitive) to understand what's tested.

**Step 2: Update `save_agent` primitive**

The primitive currently parses raw YAML inline with `import("yaml")`. The key change: replace `capabilities` heuristic logic with explicit `tools`/`agents` fields. Also update the description to reflect the new format.

In `src/kernel/primitives.ts`, update `saveAgentPrimitive`:

```typescript
function saveAgentPrimitive(ctx: GenomeContext): Primitive {
	return {
		name: "save_agent",
		description:
			"Save a new agent definition to the genome. The agent becomes available for delegation immediately and persists across sessions.",
		parameters: {
			type: "object",
			properties: {
				yaml: {
					type: "string",
					description:
						"Complete agent definition as YAML. Must include: name, description, model, system_prompt. Optional: tools, agents, constraints, tags, version.",
				},
			},
			required: ["yaml"],
		},
		async execute(args) {
			const yaml = args.yaml as string;
			if (!yaml) {
				return { output: "", success: false, error: "Missing required parameter: yaml" };
			}

			try {
				const { parse } = await import("yaml");
				const { DEFAULT_CONSTRAINTS } = await import("./types.ts");
				const raw = parse(yaml);

				for (const field of ["name", "description", "system_prompt", "model"]) {
					if (!raw[field] || typeof raw[field] !== "string") {
						return {
							output: "",
							success: false,
							error: `Invalid agent spec: missing or invalid '${field}'`,
						};
					}
				}

				const tools: string[] = raw.tools ?? [];
				const agents: string[] = raw.agents ?? [];
				const spec = {
					name: raw.name as string,
					description: raw.description as string,
					system_prompt: raw.system_prompt as string,
					model: raw.model as string,
					capabilities: [...tools, ...agents],
					tools,
					agents,
					constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
					tags: (raw.tags as string[]) ?? [],
					version: (raw.version as number) ?? 1,
				};

				await ctx.genome.addAgent(spec);
				return {
					output: `Agent '${spec.name}' saved and registered. It is available for delegation immediately.`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}
```

Key changes: `tools` and `agents` are now explicit fields (not derived from `capabilities` via `/` heuristic). `capabilities` is computed from tools+agents (not the other way around).

**Step 3: Run tests**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/kernel/primitives.ts
git commit -m "refactor(primitives): update save_agent to use explicit tools/agents fields"
```

---

### Task 4: Migrate `genome-service.ts` `create_agent` mutation

**Context:** `GenomeMutationService.applyMutation` handles `create_agent` mutations from the learn process. It currently derives `tools`/`agents` from `capabilities` via the `/` heuristic. Update to use explicit fields.

**Files:**
- Modify: `src/bus/genome-service.ts`
- Modify: `src/learn/learn-process.ts` — update `LearnMutation` type for `create_agent`

**Step 1: Update `LearnMutation` type**

In `src/learn/learn-process.ts`, change the `create_agent` variant to use `tools` and `agents` instead of `capabilities`:

```typescript
| {
		type: "create_agent";
		name: string;
		description: string;
		system_prompt: string;
		model: string;
		tools: string[];
		agents: string[];
		tags: string[];
  }
```

**Step 2: Update `genome-service.ts` create_agent handler**

```typescript
case "create_agent": {
	validateAgentName(mutation.name);
	await this.genome.addAgent({
		name: mutation.name,
		description: mutation.description,
		system_prompt: mutation.system_prompt,
		model: mutation.model,
		capabilities: [...mutation.tools, ...mutation.agents],
		tools: mutation.tools,
		agents: mutation.agents,
		constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false },
		tags: mutation.tags,
		version: 1,
	});
	break;
}
```

**Step 3: Update any code that constructs `create_agent` mutations**

Search for where `create_agent` mutations are built. This is likely in `learn-process.ts` where the LLM response is parsed into mutations. Update those callsites to populate `tools`/`agents` instead of `capabilities`.

**Step 4: Run tests**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: PASS. Fix any test that constructs `create_agent` mutation objects with the old shape.

**Step 5: Commit**

```bash
git add src/learn/learn-process.ts src/bus/genome-service.ts
git commit -m "refactor(learn): use explicit tools/agents in create_agent mutation"
```

---

### Task 5: Migrate `export-learnings.ts` from `.yaml` to `.md`

**Context:** `exportLearnings` and `stageLearnings` serialize agents as YAML using `serializeAgentSpec` and write `.yaml` files. Switch to `.md` using `serializeAgentMarkdown`.

**Files:**
- Modify: `src/genome/export-learnings.ts`
- Modify: `test/genome/export-learnings.test.ts`

**Step 1: Update `ExportResult` type**

Rename `agentYaml` to `agentMarkdown` (or just keep as `agentContent` — the name `agentYaml` is misleading after migration):

```typescript
export interface ExportResult {
	evolved: EvolvedAgent[];
	genomeOnly: GenomeOnlyAgent[];
	/** Pre-serialized markdown for each agent to export, keyed by name. */
	agentContent: Map<string, string>;
}
```

**Step 2: Update `exportLearnings`**

Replace `serializeAgentSpec` with `serializeAgentMarkdown`:

```typescript
import { serializeAgentMarkdown } from "../agents/markdown-loader.ts";
// Remove: import { serializeAgentSpec } from "./genome.ts";

// In the function body:
agentContent.set(agent.name, serializeAgentMarkdown(agent));
```

**Step 3: Update `stageLearnings`**

Write `.md` files instead of `.yaml`:

```typescript
export async function stageLearnings(result: ExportResult, stagingDir: string): Promise<string[]> {
	await mkdir(stagingDir, { recursive: true });
	const written: string[] = [];
	for (const name of result.agentContent.keys()) {
		const filePath = join(stagingDir, `${name}.md`);
		await writeFile(filePath, result.agentContent.get(name)!, "utf-8");
		written.push(filePath);
	}
	return written;
}
```

**Step 4: Update tests**

Fix `test/genome/export-learnings.test.ts` to expect `.md` files and `agentContent` instead of `agentYaml`.

**Step 5: Run tests**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test test/genome/export-learnings.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/genome/export-learnings.ts test/genome/export-learnings.test.ts
git commit -m "refactor(genome): export learnings as .md instead of .yaml"
```

---

### Task 6: Remove `loadFromDisk` YAML reading, drop `parseAgentSpec`/`serializeAgentSpec`

**Context:** Now that all write paths produce `.md`, `loadFromDisk` should only read `.md` files. Remove YAML reading from `loadFromDisk`. Delete `parseAgentSpec` and `serializeAgentSpec` entirely. Remove `loadAgentSpec` (it uses `parseAgentSpec`).

**Files:**
- Modify: `src/genome/genome.ts` — remove YAML reading from `loadFromDisk`, remove `serializeAgentSpec` export
- Modify: `src/agents/loader.ts` — remove `parseAgentSpec`, `loadAgentSpec`
- Modify: `src/agents/index.ts` — remove `loadAgentSpec` export
- Modify: `test/agents/loader.test.ts` — remove `parseAgentSpec` tests
- Modify: any test that calls `parseAgentSpec` or `loadAgentSpec`

**Step 1: Remove YAML file reading from `loadFromDisk`**

In `src/genome/genome.ts`, `loadFromDisk()` currently reads both `.yaml` and `.md` files. Remove the `.yaml` block entirely:

```typescript
async loadFromDisk(): Promise<void> {
	const agentsDir = join(this.rootPath, "agents");
	let files: string[];
	try {
		files = await readdir(agentsDir);
	} catch {
		files = [];
	}
	const mdFiles = files.filter((f) => f.endsWith(".md"));
	for (const file of mdFiles) {
		const filePath = join(agentsDir, file);
		const content = await readFile(filePath, "utf-8");
		const spec = parseAgentMarkdown(content, filePath);
		this.agents.set(spec.name, spec);
	}

	await this.memories.load();

	const rulesPath = join(this.rootPath, "routing", "rules.yaml");
	try {
		const content = await readFile(rulesPath, "utf-8");
		const parsed = parse(content);
		this.routingRules = Array.isArray(parsed) ? parsed : [];
	} catch {
		this.routingRules = [];
	}
}
```

**Step 2: Delete `serializeAgentSpec` from `genome.ts`**

Remove the `serializeAgentSpec` function entirely. Remove its export from any barrel files.

**Step 3: Delete `parseAgentSpec` and `loadAgentSpec` from `loader.ts`**

Remove both functions. Keep the `yaml` import only if still needed by `readRootDir` for YAML root files (check if the root layer still has YAML files). If the root layer is `.md`-only, remove the YAML import too.

Note: `readRootDir` still supports legacy YAML root directories (the flat `.yaml` layout). This is a separate concern from genome format — root dirs are read-only from the genome's perspective. Keep `parseAgentSpec` in `readRootDir`'s YAML branch for now, OR inline the minimal parsing needed there. **Decision: if root directories still use YAML, keep `parseAgentSpec` for that path only. If root is `.md`-only, delete it entirely.**

Check: does the root directory at `root/` use `.yaml` or `.md` files? Read `root/` to find out.

If root still has `.yaml` files: keep `parseAgentSpec` but rename to a private function used only by the YAML branch of `readRootDir`. Remove the export.

If root is `.md`-only: delete `parseAgentSpec` entirely.

**Step 4: Update `src/agents/index.ts`**

Remove `loadAgentSpec` from exports. Keep `loadRootAgents`.

**Step 5: Remove `loadAgentSpec` import from `genome.ts`**

In `genome.ts`, the import line includes `loadAgentSpec` — remove it. Also remove `serializeAgentSpec` from the file since it's been deleted.

**Step 6: Update tests**

- Remove `parseAgentSpec` tests from `test/agents/loader.test.ts`
- Remove any test that imports `serializeAgentSpec` or `loadAgentSpec`
- Update genome tests if they import `serializeAgentSpec`

**Step 7: Run full test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: PASS

**Step 8: Commit**

```bash
git add -u  # only modified/deleted files
git commit -m "refactor: remove legacy YAML parsing and serialization from genome layer"
```

---

### Task 7: Drop `capabilities` field from `AgentSpec`

**Context:** `AgentSpec.capabilities` is the legacy mixed bag of tools + agents. Now that `tools` and `agents` are explicit everywhere, `capabilities` is redundant. Remove it from the type and all code that references it.

**Files:**
- Modify: `src/kernel/types.ts` — remove `capabilities` from `AgentSpec`
- Modify: every file that references `spec.capabilities`

**Step 1: Search for all `capabilities` references**

Run grep to find every callsite:
```bash
cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree
grep -rn "capabilities" src/ test/ --include="*.ts" | grep -v "node_modules"
```

**Step 2: Remove `capabilities` from `AgentSpec`**

In `src/kernel/types.ts`:
```typescript
// Remove this line:
capabilities: string[];
```

**Step 3: Fix all compilation errors**

Go through every file that references `capabilities` and either:
- Remove the field from object literals (where constructing AgentSpec)
- Replace `capabilities` with `[...tools, ...agents]` where the combined list is needed
- Remove `capabilities` parameters from functions/types

Key files likely affected:
- `src/agents/markdown-loader.ts` — remove `capabilities: [...tools, ...agents]` from parsed spec
- `src/agents/loader.ts` — remove `capabilities` from `parseAgentSpec` (if it still exists for root YAML)
- `src/genome/genome.ts` — `reconcileRootCapabilities` needs rework or removal
- `src/bus/genome-service.ts` — remove capabilities from create_agent
- `src/kernel/primitives.ts` — remove capabilities from save_agent
- `src/genome/root-manifest.ts` — `buildManifestFromSpecs` references `spec.capabilities`
- `src/agents/plan.ts` — `primitivesForAgent` or delegation logic may use capabilities
- Test files that construct `AgentSpec` objects

**Special attention: `reconcileRootCapabilities`**

This method reconciles the combined capabilities list. After removing `capabilities`, it should reconcile `tools` and `agents` separately, or be simplified. Since root sync already handles spec-level updates, this method may be removable if its purpose is fully subsumed by the manifest-based sync. Review carefully.

**Step 4: Run full test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: PASS (after fixing all references)

**Step 5: Commit**

```bash
git add -u
git commit -m "refactor: remove deprecated capabilities field from AgentSpec"
```

---

### Task 8: Update `readRootDir` YAML branch

**Context:** `readRootDir` in `src/agents/loader.ts` has a branch that reads legacy YAML root directories using `parseAgentSpec`. If `parseAgentSpec` was deleted in Task 6, this branch is broken. If it was kept as private, verify it works.

**Check first:** Does the actual `root/` directory in the repo use `.yaml` or `.md` files?

**If root is `.md`-only:** Remove the YAML branch from `readRootDir` entirely. The function simplifies to only the tree scanner path.

**If root has `.yaml` files:** Keep the YAML parsing but ensure it's self-contained (doesn't depend on deleted functions).

**Files:**
- Modify: `src/agents/loader.ts`
- Modify: `test/agents/loader.test.ts`

**Step 1: Check root directory format**

```bash
ls root/
ls root/agents/
```

**Step 2: Update `readRootDir` accordingly**

If `.md`-only: remove the YAML branch (lines 54-68 in current code). The function just uses the tree scanner.

**Step 3: Run tests**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/agents/loader.ts test/agents/loader.test.ts
git commit -m "refactor(loader): remove YAML branch from readRootDir"
```

---

### Task 9: Clean up imports and dead code

**Context:** After all migrations, there may be orphaned imports, unused YAML imports, or dead code paths.

**Files:**
- All modified files from Tasks 1-8

**Step 1: Run biome check**

```bash
cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bunx biome check src/ test/ --write
```

This will catch unused imports.

**Step 2: Run typecheck**

```bash
cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bunx tsc --noEmit
```

**Step 3: Run full test suite**

Run: `cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test`
Expected: PASS

**Step 4: Commit any cleanup**

```bash
git add -u
git commit -m "chore: clean up dead imports and unused code after format unification"
```

---

### Task 10: Full verification

**Step 1: Run the complete test suite**

```bash
cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bun test
```
Expected: All tests pass, no regressions.

**Step 2: Run biome formatting and linting**

```bash
cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bunx biome check src/ test/ --write
```

**Step 3: Run typecheck**

```bash
cd /Users/jesse/prime-radiant/sprout/.worktrees/agent-tree && bunx tsc --noEmit
```

**Step 4: Verify no `.yaml` references remain in genome code**

```bash
grep -rn "\.yaml\|\.yml" src/genome/ --include="*.ts"
```

Expected: Only `routing/rules.yaml` references remain (routing rules stay as YAML — they're not agent specs).

**Step 5: Review git log**

```bash
git log --oneline HEAD~10..HEAD
```

Verify clean commit history with meaningful messages.
