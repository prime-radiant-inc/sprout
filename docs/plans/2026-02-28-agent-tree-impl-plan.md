# Agent Tree & Delegation Redesign Implementation Plan

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

**Goal:** Replace prescriptive capabilities allowlist with directory-based auto-discovery, path-based delegation, and YAML-fronted Markdown agent specs.

**Architecture:** Agent specs become `.md` files with YAML frontmatter. The `capabilities` field splits into `tools` (primitives + `./local`) and `agents` (paths from root). The `bootstrap/` directory becomes `root/` with nested `agents/` subdirectories. Each agent auto-discovers its children; cross-tree references use absolute paths from root.

**Tech Stack:** TypeScript, Bun, YAML frontmatter parsing

**Reference:** `docs/plans/2026-02-28-agent-tree-design.md`

---

### Task 1: YAML-Fronted Markdown Parser

Parse `.md` files with YAML frontmatter into AgentSpec objects. The markdown body becomes the system prompt.

**Files:**
- Create: `src/agents/markdown-loader.ts`
- Create: `test/agents/markdown-loader.test.ts`

**Step 1: Write the failing test**

```typescript
// test/agents/markdown-loader.test.ts
import { describe, test, expect } from "bun:test";
import { parseAgentMarkdown } from "../../src/agents/markdown-loader.ts";

describe("parseAgentMarkdown", () => {
	test("parses frontmatter and markdown body", () => {
		const content = [
			"---",
			"name: reader",
			'description: "Find and read files"',
			"model: fast",
			"tools:",
			"  - read_file",
			"  - grep",
			"agents: []",
			"constraints:",
			"  max_turns: 20",
			"  max_depth: 0",
			"  can_spawn: false",
			"tags: [core]",
			"version: 2",
			"---",
			"You are a reader.",
			"",
			"Read files and return information.",
		].join("\n");

		const spec = parseAgentMarkdown(content, "reader.md");
		expect(spec.name).toBe("reader");
		expect(spec.description).toBe("Find and read files");
		expect(spec.system_prompt).toBe("You are a reader.\n\nRead files and return information.");
		expect(spec.model).toBe("fast");
		expect(spec.tools).toEqual(["read_file", "grep"]);
		expect(spec.agents).toEqual([]);
		expect(spec.constraints.can_spawn).toBe(false);
	});

	test("throws on missing frontmatter delimiter", () => {
		expect(() => parseAgentMarkdown("no frontmatter here", "bad.md")).toThrow();
	});

	test("throws on missing required fields", () => {
		const noName = ["---", "description: test", "model: fast", "---", "prompt"].join("\n");
		expect(() => parseAgentMarkdown(noName, "bad.md")).toThrow(/name/);
	});

	test("defaults tools and agents to empty arrays", () => {
		const content = [
			"---",
			"name: minimal",
			'description: "A minimal agent"',
			"model: fast",
			"---",
			"You are minimal.",
		].join("\n");
		const spec = parseAgentMarkdown(content, "minimal.md");
		expect(spec.tools).toEqual([]);
		expect(spec.agents).toEqual([]);
	});

	test("trims trailing whitespace from markdown body", () => {
		const content = ["---", "name: t", 'description: "t"', "model: fast", "---", "body  \n\n"].join("\n");
		const spec = parseAgentMarkdown(content, "t.md");
		expect(spec.system_prompt).toBe("body");
	});

	test("parses thinking field when present", () => {
		const content = [
			"---",
			"name: thinker",
			'description: "thinks"',
			"model: best",
			"thinking:",
			"  budget_tokens: 5000",
			"---",
			"Think deeply.",
		].join("\n");
		const spec = parseAgentMarkdown(content, "thinker.md");
		expect(spec.thinking).toEqual({ budget_tokens: 5000 });
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/markdown-loader.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/agents/markdown-loader.ts
import { parse } from "yaml";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../kernel/types.ts";

/**
 * Parse an agent spec from a YAML-fronted Markdown file.
 * Frontmatter provides structured fields; the markdown body becomes system_prompt.
 */
export function parseAgentMarkdown(content: string, source: string): AgentSpec {
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		throw new Error(`Invalid agent markdown at ${source}: missing frontmatter delimiter`);
	}

	const endIdx = content.indexOf("\n---\n", 4);
	const endIdxR = content.indexOf("\r\n---\r\n", 4);
	const actualEnd = endIdx !== -1 ? endIdx : endIdxR;
	if (actualEnd === -1) {
		throw new Error(`Invalid agent markdown at ${source}: missing closing frontmatter delimiter`);
	}

	const frontmatterStr = content.slice(4, actualEnd);
	const bodyStart = content.indexOf("\n", actualEnd + 1) + 1;
	const body = content.slice(bodyStart).trim();

	const raw = parse(frontmatterStr);

	for (const field of ["name", "description", "model"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid agent markdown at ${source}: missing or invalid '${field}'`);
		}
	}

	const spec: AgentSpec = {
		name: raw.name,
		description: raw.description,
		system_prompt: body,
		model: raw.model,
		tools: raw.tools ?? [],
		agents: raw.agents ?? [],
		capabilities: [...(raw.tools ?? []), ...(raw.agents ?? [])],
		constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
		tags: raw.tags ?? [],
		version: raw.version ?? 1,
	};
	if (raw.thinking !== undefined) {
		spec.thinking = raw.thinking;
	}
	return spec;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/agents/markdown-loader.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/markdown-loader.ts test/agents/markdown-loader.test.ts
git commit -m "feat: add YAML-fronted Markdown parser for agent specs"
```

---

### Task 2: Update AgentSpec Type

Add `tools` and `agents` fields to `AgentSpec`. Keep `capabilities` for backward compatibility during migration — it will be populated from `tools` + `agents` so existing runtime code continues to work.

**Files:**
- Modify: `src/kernel/types.ts`
- Modify: `test/helpers/make-spec.ts`
- Modify: `test/kernel/types.test.ts` (if it tests AgentSpec)

**Step 1: Write the failing test**

```typescript
// In test/kernel/types.test.ts, add:
test("AgentSpec accepts tools and agents fields", () => {
	const spec: AgentSpec = {
		name: "test",
		description: "test",
		system_prompt: "test",
		model: "fast",
		tools: ["read_file", "grep"],
		agents: ["utility/reader"],
		capabilities: ["read_file", "grep", "utility/reader"],
		constraints: { ...DEFAULT_CONSTRAINTS },
		tags: [],
		version: 1,
	};
	expect(spec.tools).toEqual(["read_file", "grep"]);
	expect(spec.agents).toEqual(["utility/reader"]);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/kernel/types.test.ts`
Expected: FAIL — `tools` does not exist on type AgentSpec

**Step 3: Add fields to AgentSpec**

In `src/kernel/types.ts`, add to the `AgentSpec` interface:

```typescript
export interface AgentSpec {
	name: string;
	description: string;
	system_prompt: string;
	model: string;
	/** Primitive tool names and ./local sprout-internal tool references */
	tools: string[];
	/** Agent paths from root for explicit cross-tree delegation */
	agents: string[];
	/** @deprecated Combined tools + agents for backward compat during migration */
	capabilities: string[];
	constraints: AgentConstraints;
	tags: string[];
	version: number;
	thinking?: boolean | { budget_tokens: number };
}
```

Update `makeSpec()` in `test/helpers/make-spec.ts` to include `tools` and `agents` with sensible defaults:

```typescript
export function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: "test-agent",
		description: "A test agent",
		system_prompt: "You are a test agent.",
		model: "fast",
		tools: ["read_file"],
		agents: [],
		capabilities: ["read_file"],
		constraints: { ...DEFAULT_CONSTRAINTS },
		tags: ["test"],
		version: 1,
		...overrides,
	};
}
```

Update `parseAgentSpec()` in `src/agents/loader.ts` to populate the new fields from the old `capabilities` field (backward compat for existing .yaml files):

```typescript
// In parseAgentSpec, after building the spec:
// Populate tools/agents from capabilities for .yaml backward compat
spec.tools = spec.capabilities.filter(c => !c.includes("/"));
spec.agents = spec.capabilities.filter(c => c.includes("/"));
```

Note: This heuristic (slash = agent path) only needs to work during migration. The new .md parser sets `tools` and `agents` explicitly.

**Step 4: Run tests**

Run: `bun test`
Expected: ALL tests pass (the new fields are additive, old code still uses `capabilities`)

**Step 5: Commit**

```bash
git add src/kernel/types.ts test/helpers/make-spec.ts src/agents/loader.ts test/kernel/types.test.ts
git commit -m "feat: add tools and agents fields to AgentSpec"
```

---

### Task 3: Agent Tree Scanner

Build a function that recursively scans a directory tree and returns a map of agent paths to specs. Handles both `.md` (new) and `.yaml` (old) files.

**Files:**
- Modify: `src/agents/loader.ts` (add `scanAgentTree`)
- Create: `test/agents/tree-scanner.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/agents/tree-scanner.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanAgentTree } from "../../src/agents/loader.ts";

describe("scanAgentTree", () => {
	let rootDir: string;

	beforeEach(async () => {
		rootDir = await mkdtemp(join(tmpdir(), "tree-"));
	});

	afterEach(async () => {
		await rm(rootDir, { recursive: true });
	});

	function writeAgentMd(relPath: string, name: string, desc: string) {
		const content = [
			"---",
			`name: ${name}`,
			`description: "${desc}"`,
			"model: fast",
			"---",
			`You are ${name}.`,
		].join("\n");
		return writeFile(join(rootDir, relPath), content);
	}

	test("discovers top-level agents", async () => {
		// root/agents/tech-lead.md
		await mkdir(join(rootDir, "agents"), { recursive: true });
		await writeAgentMd("agents/tech-lead.md", "tech-lead", "Manages implementation");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("tech-lead")).toBe(true);
		expect(tree.get("tech-lead")!.spec.name).toBe("tech-lead");
		expect(tree.get("tech-lead")!.path).toBe("tech-lead");
	});

	test("discovers nested agents with correct paths", async () => {
		await mkdir(join(rootDir, "agents/tech-lead/agents"), { recursive: true });
		await writeAgentMd("agents/tech-lead.md", "tech-lead", "Manages implementation");
		await writeAgentMd("agents/tech-lead/agents/engineer.md", "engineer", "Writes code");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("tech-lead")).toBe(true);
		expect(tree.has("tech-lead/engineer")).toBe(true);
		expect(tree.get("tech-lead/engineer")!.path).toBe("tech-lead/engineer");
	});

	test("discovers deeply nested agents", async () => {
		await mkdir(join(rootDir, "agents/a/agents/b/agents"), { recursive: true });
		await writeAgentMd("agents/a.md", "a", "Agent A");
		await writeAgentMd("agents/a/agents/b.md", "b", "Agent B");
		await writeAgentMd("agents/a/agents/b/agents/c.md", "c", "Agent C");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("a/b/c")).toBe(true);
	});

	test("returns children list for each agent", async () => {
		await mkdir(join(rootDir, "agents/qm/agents"), { recursive: true });
		await writeAgentMd("agents/qm.md", "qm", "Quartermaster");
		await writeAgentMd("agents/qm/agents/fab.md", "fab", "Fabricator");
		await writeAgentMd("agents/qm/agents/idx.md", "idx", "Indexer");

		const tree = await scanAgentTree(rootDir);
		const qm = tree.get("qm")!;
		expect(qm.children.sort()).toEqual(["fab", "idx"]);
	});

	test("ignores non-.md files in agents directories", async () => {
		await mkdir(join(rootDir, "agents"), { recursive: true });
		await writeAgentMd("agents/valid.md", "valid", "Valid agent");
		await writeFile(join(rootDir, "agents/readme.txt"), "not an agent");

		const tree = await scanAgentTree(rootDir);
		expect(tree.size).toBe(1);
	});

	test("handles utility namespace without a spec file", async () => {
		// utility/ has no utility.md — just agents/ inside
		await mkdir(join(rootDir, "agents/utility/agents"), { recursive: true });
		await writeAgentMd("agents/utility/agents/reader.md", "reader", "Reads files");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("utility/reader")).toBe(true);
		// "utility" itself is not in the tree since it has no spec
		expect(tree.has("utility")).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/tree-scanner.test.ts`
Expected: FAIL — `scanAgentTree` not exported

**Step 3: Write implementation**

In `src/agents/loader.ts`, add:

```typescript
import { parseAgentMarkdown } from "./markdown-loader.ts";

export interface AgentTreeEntry {
	spec: AgentSpec;
	path: string;          // e.g. "tech-lead/engineer"
	children: string[];    // direct child agent names
	diskPath: string;      // absolute filesystem path to the .md file
}

/**
 * Recursively scan an agent root directory, building a map of agent paths to specs.
 * Directory structure: root/agents/<name>.md, root/agents/<name>/agents/<child>.md, etc.
 */
export async function scanAgentTree(rootDir: string): Promise<Map<string, AgentTreeEntry>> {
	const tree = new Map<string, AgentTreeEntry>();
	await scanLevel(join(rootDir, "agents"), "", tree);
	return tree;
}

async function scanLevel(
	dir: string,
	pathPrefix: string,
	tree: Map<string, AgentTreeEntry>,
): Promise<string[]> {
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return [];
	}

	const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
	const childNames: string[] = [];

	for (const file of mdFiles) {
		const name = file.replace(/\.md$/, "");
		const agentPath = pathPrefix ? `${pathPrefix}/${name}` : name;
		const diskPath = join(dir, file);
		const content = await readFile(diskPath, "utf-8");
		const spec = parseAgentMarkdown(content, diskPath);

		// Recurse into <name>/agents/ for children
		const childDir = join(dir, name, "agents");
		const children = await scanLevel(childDir, agentPath, tree);

		tree.set(agentPath, { spec, path: agentPath, children, diskPath });
		childNames.push(name);
	}

	// Handle namespace directories without a spec file (e.g., utility/)
	const dirs = files.filter((f) => !f.includes("."));
	for (const d of dirs) {
		if (mdFiles.some((f) => f.replace(/\.md$/, "") === d)) continue; // already handled
		const childDir = join(dir, d, "agents");
		await scanLevel(childDir, pathPrefix ? `${pathPrefix}/${d}` : d, tree);
	}

	return childNames;
}
```

Note: The namespace directory detection (`dirs` loop) handles `utility/` which has no `.md` file — it just has `agents/` inside.

**Step 4: Run tests**

Run: `bun test test/agents/tree-scanner.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/loader.ts test/agents/tree-scanner.test.ts
git commit -m "feat: add recursive agent tree scanner"
```

---

### Task 4: Path-Based Agent Resolution

Build a resolver that takes an agent tree map and an agent's context (its own path + its `agents` field) and returns the full set of delegatable agents: auto-discovered children + explicit references.

**Files:**
- Create: `src/agents/resolver.ts`
- Create: `test/agents/resolver.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/agents/resolver.test.ts
import { describe, test, expect } from "bun:test";
import { resolveAgentDelegates } from "../../src/agents/resolver.ts";
import { makeSpec } from "../helpers/make-spec.ts";
import type { AgentTreeEntry } from "../../src/agents/loader.ts";

function entry(name: string, path: string, children: string[] = []): AgentTreeEntry {
	return {
		spec: makeSpec({ name, description: `The ${name} agent` }),
		path,
		children,
		diskPath: `/fake/${path}.md`,
	};
}

describe("resolveAgentDelegates", () => {
	const tree = new Map<string, AgentTreeEntry>([
		["tech-lead", entry("tech-lead", "tech-lead", ["engineer", "spec-reviewer"])],
		["tech-lead/engineer", entry("engineer", "tech-lead/engineer")],
		["tech-lead/spec-reviewer", entry("spec-reviewer", "tech-lead/spec-reviewer")],
		["quartermaster", entry("quartermaster", "quartermaster", ["qm-fabricator"])],
		["quartermaster/qm-fabricator", entry("qm-fabricator", "quartermaster/qm-fabricator")],
		["utility/reader", entry("reader", "utility/reader")],
		["utility/task-manager", entry("task-manager", "utility/task-manager")],
		["project-explorer", entry("project-explorer", "project-explorer")],
	]);

	test("returns auto-discovered children for root", () => {
		// Root's children are top-level entries (no slash in path)
		const topLevel = [...tree.entries()]
			.filter(([p]) => !p.includes("/"))
			.map(([p]) => p);
		const result = resolveAgentDelegates(tree, "root", topLevel, ["utility/task-manager"]);

		const names = result.map((s) => s.spec.name);
		expect(names).toContain("tech-lead");
		expect(names).toContain("quartermaster");
		expect(names).toContain("project-explorer");
		expect(names).toContain("task-manager"); // explicit reference
	});

	test("returns auto-discovered children for orchestrator", () => {
		const result = resolveAgentDelegates(tree, "tech-lead", ["engineer", "spec-reviewer"], []);
		const names = result.map((s) => s.spec.name);
		expect(names).toContain("engineer");
		expect(names).toContain("spec-reviewer");
		expect(names).toHaveLength(2);
	});

	test("includes explicit agent references by path", () => {
		const result = resolveAgentDelegates(
			tree,
			"quartermaster",
			["qm-fabricator"],
			["utility/reader", "project-explorer"],
		);
		const names = result.map((s) => s.spec.name);
		expect(names).toContain("qm-fabricator");
		expect(names).toContain("reader");
		expect(names).toContain("project-explorer");
	});

	test("skips unresolvable paths without crashing", () => {
		const result = resolveAgentDelegates(tree, "root", [], ["nonexistent/agent"]);
		expect(result).toHaveLength(0);
	});

	test("does not include self in results", () => {
		const result = resolveAgentDelegates(tree, "tech-lead", ["tech-lead", "engineer"], []);
		const names = result.map((s) => s.spec.name);
		expect(names).not.toContain("tech-lead");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/resolver.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/agents/resolver.ts
import type { AgentTreeEntry } from "./loader.ts";

export interface ResolvedDelegate {
	spec: import("../kernel/types.ts").AgentSpec;
	path: string;
}

/**
 * Resolve the full set of agents an agent can delegate to.
 *
 * @param tree - The complete agent tree map (path -> entry)
 * @param selfName - This agent's name (excluded from results)
 * @param childNames - Auto-discovered direct child names (from tree entry)
 * @param agentRefs - Explicit agent paths from the `agents` field
 * @returns Array of resolved delegates with specs and paths
 */
export function resolveAgentDelegates(
	tree: Map<string, AgentTreeEntry>,
	selfName: string,
	childNames: string[],
	agentRefs: string[],
): ResolvedDelegate[] {
	const result: ResolvedDelegate[] = [];
	const seen = new Set<string>();

	// Auto-discovered children (direct path lookup)
	for (const childPath of childNames) {
		const entry = tree.get(childPath);
		if (!entry || entry.spec.name === selfName) continue;
		if (seen.has(entry.spec.name)) continue;
		seen.add(entry.spec.name);
		result.push({ spec: entry.spec, path: childPath });
	}

	// Explicit references from agents field
	for (const ref of agentRefs) {
		const entry = tree.get(ref);
		if (!entry || entry.spec.name === selfName) continue;
		if (seen.has(entry.spec.name)) continue;
		seen.add(entry.spec.name);
		result.push({ spec: entry.spec, path: ref });
	}

	return result;
}
```

**Step 4: Run tests**

Run: `bun test test/agents/resolver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/resolver.ts test/agents/resolver.test.ts
git commit -m "feat: add path-based agent delegate resolver"
```

---

### Task 5: Update Delegate Tool for Path-Based Delegation

Remove the restrictive enum from the delegate tool. Accept any string for `agent_name`. List known agents in the description instead.

**Files:**
- Modify: `src/agents/plan.ts`
- Modify: `test/agents/plan.test.ts`

**Step 1: Write the failing test**

```typescript
// Add to test/agents/plan.test.ts:
test("delegate tool accepts any agent string, not just enum", () => {
	const tool = buildDelegateTool([makeSpec({ name: "reader" }), makeSpec({ name: "editor" })]);
	const agentNameProp = tool.parameters.properties.agent_name;
	// Should NOT have an enum — accepts any string
	expect(agentNameProp.enum).toBeUndefined();
	// But should list known agents in description
	expect(agentNameProp.description).toContain("reader");
	expect(agentNameProp.description).toContain("editor");
});
```

**Step 2: Run to verify it fails**

Run: `bun test test/agents/plan.test.ts`
Expected: FAIL — `agentNameProp.enum` is still defined

**Step 3: Update buildDelegateTool**

In `src/agents/plan.ts`, modify `buildDelegateTool`:

```typescript
export function buildDelegateTool(agents: AgentSpec[]): ToolDefinition {
	const knownNames = agents.map((a) => a.name);
	const nameList = knownNames.length > 0 ? ` Known agents: ${knownNames.join(", ")}.` : "";
	return {
		name: DELEGATE_TOOL_NAME,
		description:
			"Delegate a task to a specialist agent. See the <agents> section in your instructions for available agents and their descriptions.",
		parameters: {
			type: "object",
			properties: {
				agent_name: {
					type: "string",
					description: `Name or path of the agent to delegate to.${nameList}`,
				},
				goal: {
					type: "string",
					description: "What you want this agent to achieve",
				},
				hints: {
					type: "array",
					items: { type: "string" },
					description: "Optional context that might help the agent",
				},
				blocking: {
					type: "boolean",
					description:
						"If false, run the agent asynchronously. Use wait_agent to get the result later. Default: true",
				},
				shared: {
					type: "boolean",
					description:
						"If true, other agents can message_agent or wait_agent this handle. Default: false",
				},
			},
			required: ["agent_name", "goal"],
		},
	};
}
```

**Step 4: Run tests and fix any that depend on enum**

Run: `bun test test/agents/plan.test.ts`

Existing tests that check for `enum` on the delegate tool need updating. Find and update them to match the new behavior (no enum, known agents listed in description).

**Step 5: Commit**

```bash
git add src/agents/plan.ts test/agents/plan.test.ts
git commit -m "feat: delegate tool accepts any agent path, not just enum"
```

---

### Task 6: Convert Agent Specs from YAML to Markdown

Convert every `.yaml` agent spec in `bootstrap/` to `.md` format. Move the `system_prompt` field to the markdown body. Split `capabilities` into `tools` and `agents`.

**This is a mechanical conversion task. No new code — just file format changes.**

**Files:**
- Convert: every `bootstrap/*.yaml` → corresponding `.md` file (in new locations, see Task 7)

**Important:** This task and Task 7 (directory restructure) should be done together as one atomic operation. The conversion changes file format while the restructure moves files into the nested tree.

**For each agent YAML file:**

1. Read the YAML
2. Extract `system_prompt` → becomes markdown body
3. Split `capabilities` into `tools` (primitives and `./` prefixed) and `agents` (cross-tree paths)
4. Write remaining fields as YAML frontmatter
5. Save as `.md`

**Classification of current capabilities per agent:**

| Agent | tools | agents |
|-------|-------|--------|
| root | (none) | utility/task-manager |
| tech-lead | (none) | (auto-discovers engineer, spec-reviewer, quality-reviewer) |
| architect | (none) | (auto-discovers children, if any) |
| quartermaster | (none) | utility/reader, project-explorer |
| verifier | read_file, grep, glob, exec | (none) |
| debugger | read_file, grep, glob, exec | (none) |
| project-explorer | read_file, grep, glob | (none) |
| reader | read_file, grep, glob | (none) |
| editor | read_file, write_file, edit_file, grep, glob | (none) |
| command-runner | exec | (none) |
| web-reader | fetch | (none) |
| mcp | ./sprout-mcp | (none) |
| task-manager | ./task-cli | (none) |
| engineer | read_file, write_file, edit_file, exec, grep, glob | (none) |
| spec-reviewer | read_file, grep, glob | (none) |
| quality-reviewer | read_file, grep, glob, exec | (none) |
| qm-fabricator | read_file, write_file, grep, glob | (none) |
| qm-indexer | read_file, grep, glob | (none) |
| qm-planner | read_file, grep, glob | (none) |
| qm-reconciler | read_file, grep, glob | (none) |

**Verification:** After conversion, run `bun test` to confirm nothing breaks (the old `parseAgentSpec` won't be called for these files since they're `.md` now — the tree scanner will use `parseAgentMarkdown`).

**Note for implementer:** Read each YAML file carefully. The system_prompt is a multi-line YAML string — copy it exactly as the markdown body. Check each agent's current capabilities against the table above and assign to the correct field. Verify the verifier and debugger — they currently list both primitives AND agent names; separate those. Read the current YAML files to determine the correct classification.

**Commit:**

```bash
git commit -m "refactor: convert agent specs from YAML to markdown format"
```

---

### Task 7: Restructure Directory — bootstrap/ → root/

Rename `bootstrap/` to `root/` and move agent files into the nested tree structure.

**This task is combined with Task 6 — do them as one atomic operation.**

**Directory moves:**

```
bootstrap/root.yaml           → root/root.md
bootstrap/tech-lead.yaml      → root/agents/tech-lead.md
bootstrap/architect.yaml      → root/agents/architect.md
bootstrap/quartermaster.yaml  → root/agents/quartermaster.md
bootstrap/verifier.yaml       → root/agents/verifier.md
bootstrap/debugger.yaml       → root/agents/debugger.md
bootstrap/project-explorer.yaml → root/agents/project-explorer.md

bootstrap/engineer.yaml        → root/agents/tech-lead/agents/engineer.md
bootstrap/spec-reviewer.yaml   → root/agents/tech-lead/agents/spec-reviewer.md
bootstrap/quality-reviewer.yaml → root/agents/tech-lead/agents/quality-reviewer.md

bootstrap/qm-fabricator.yaml   → root/agents/quartermaster/agents/qm-fabricator.md
bootstrap/qm-indexer.yaml      → root/agents/quartermaster/agents/qm-indexer.md
bootstrap/qm-planner.yaml      → root/agents/quartermaster/agents/qm-planner.md
bootstrap/qm-reconciler.yaml   → root/agents/quartermaster/agents/qm-reconciler.md

bootstrap/reader.yaml          → root/agents/utility/agents/reader.md
bootstrap/editor.yaml          → root/agents/utility/agents/editor.md
bootstrap/command-runner.yaml  → root/agents/utility/agents/command-runner.md
bootstrap/web-reader.yaml      → root/agents/utility/agents/web-reader.md
bootstrap/mcp.yaml             → root/agents/utility/agents/mcp.md
bootstrap/task-manager.yaml    → root/agents/utility/agents/task-manager.md

bootstrap/preambles/           → root/preambles/

bootstrap/task-manager/tools/  → root/agents/utility/agents/task-manager/tools/
bootstrap/mcp/tools/           → root/agents/utility/agents/mcp/tools/
```

**Create new directories:**

```bash
mkdir -p root/agents/tech-lead/agents
mkdir -p root/agents/quartermaster/agents
mkdir -p root/agents/quartermaster/resources
mkdir -p root/agents/utility/agents
mkdir -p root/agents/utility/agents/task-manager/tools
mkdir -p root/agents/utility/agents/mcp/tools
```

**After moving, update all source code references from `bootstrap` to `root`:**

Key files that reference `bootstrap/` or `bootstrapDir`:
- `src/agents/factory.ts` — default bootstrap path
- `src/host/cli.ts` — bootstrap path resolution
- `src/genome/genome.ts` — `syncBootstrap`, `initFromBootstrap`, `loadAgentToolsWithBootstrap`
- Any test files referencing bootstrap paths

Search for `"bootstrap"` across `src/` and `test/` and update each reference.

**Verification:**

Run: `bun test`
Expected: ALL pass

**Commit:**

```bash
git commit -m "refactor: restructure bootstrap/ into root/ nested agent tree"
```

---

### Task 8: Update Loader and Genome for Agent Tree

Replace flat directory scanning with tree-based scanning. Update the genome to load from nested directories and `.md` files.

**Files:**
- Modify: `src/agents/loader.ts` — update `readBootstrapDir` or replace with tree scan
- Modify: `src/genome/genome.ts` — update `loadFromDisk`, `initFromBootstrap`, `syncBootstrap`, `allAgents`
- Modify: `src/agents/factory.ts` — pass tree data to Agent
- Modify: `test/genome/genome.test.ts`
- Modify: `test/agents/loader.test.ts`

**The genome needs these changes:**

1. **`loadFromDisk()`** — scan genome's `agents/` recursively for `.md` files (not just flat `.yaml`)
2. **`initFromBootstrap()`** — use tree scanner on the root directory, write `.md` files to genome preserving tree structure
3. **`allAgents()`** — return all agents from the tree (already flat map)
4. **`syncBootstrap()`** — handle the new tree structure and `.md` format
5. **`addAgent()`/`updateAgent()`** — write `.md` format to genome

**The factory needs these changes:**

1. Load the agent tree via `scanAgentTree(rootDir)` instead of `loadBootstrapAgents(bootstrapDir)`
2. Pass the tree map to the Agent constructor (or resolve delegates before passing)
3. Store the tree for runtime path resolution

**Step 1: Write failing tests for genome loading .md files**

Add tests in `test/genome/genome.test.ts` that create `.md` agent files in the genome directory and verify `loadFromDisk()` loads them correctly.

**Step 2: Implement genome changes**

Update `loadFromDisk()` to handle `.md` files with `parseAgentMarkdown`.
Update `initFromBootstrap()` to use `scanAgentTree`.
Update write methods to produce `.md` format.

**Step 3: Update factory**

Replace `loadBootstrapAgents(bootstrapDir)` with `scanAgentTree(rootDir)`.
Pass tree to agent construction.

**Step 4: Run all tests**

Run: `bun test`
Fix test failures from the format/path changes.

**Step 5: Commit**

```bash
git commit -m "feat: genome and factory support nested agent tree with .md format"
```

---

### Task 9: Update Agent Constructor for Auto-Discovery

Modify the Agent constructor to use tree-based auto-discovery and path resolution instead of the capabilities-based allowlist.

**Files:**
- Modify: `src/agents/agent.ts` — constructor, `getDelegatableAgents`
- Modify: `test/agents/agent.test.ts`

**Changes to agent.ts:**

1. **Constructor**: Accept `agentTree` (or resolved delegates) in `AgentOptions`
2. **Build delegation targets**: Use the resolver: auto-discovered children + explicit `agents` field
3. **`getDelegatableAgents()`**: Use tree-based resolution instead of flat capabilities scan
4. **Delegation execution**: Resolve agent path to spec when delegating (handle dynamic paths from quartermaster)

**In `executeDelegation()`** (the in-process delegation path): look up the agent name/path in the tree. If not found in the pre-built delegate list, try resolving it as a path in the tree (dynamic delegation).

**Step 1: Write failing test**

```typescript
test("agent auto-discovers children from tree", () => {
	// Build tree with root having children
	const tree = new Map([
		["tech-lead", { spec: makeSpec({ name: "tech-lead" }), path: "tech-lead", children: [], diskPath: "" }],
	]);
	const agent = new Agent({
		spec: makeSpec({ name: "root", tools: [], agents: [], capabilities: [] }),
		// ... pass tree
	});
	// Agent should see tech-lead as a delegatable agent
});
```

**Step 2: Update Agent constructor**

Replace the capabilities scan with tree-based resolution. Use `resolveAgentDelegates()`.

**Step 3: Run tests**

Run: `bun test test/agents/agent.test.ts`

**Step 4: Commit**

```bash
git commit -m "feat: agent uses tree-based auto-discovery for delegation"
```

---

### Task 10: Update System Prompt to Use Markdown Body

The system prompt is now the markdown body of the spec file, not a YAML field. Update `buildSystemPrompt()` and related code.

**Files:**
- Modify: `src/agents/plan.ts` — `buildSystemPrompt` already uses `spec.system_prompt`; this field is now populated from the markdown body by the parser. Verify it works correctly.
- Modify: `src/agents/agent.ts` — the `renderAgentsForPrompt` call

**This is primarily a verification task.** Since `parseAgentMarkdown` puts the markdown body into `spec.system_prompt`, and `buildSystemPrompt` already reads `spec.system_prompt`, the plumbing should work. Verify with tests.

**Step 1: Write a test that loads an actual .md agent file and verifies the system prompt**

```typescript
test("system prompt built from markdown body includes preamble and body", () => {
	const spec = parseAgentMarkdown([
		"---",
		"name: tester",
		'description: "test"',
		"model: fast",
		"---",
		"You are a tester.",
		"",
		"Test everything thoroughly.",
	].join("\n"), "tester.md");

	const prompt = buildSystemPrompt(spec, "/work", "darwin", "25.0");
	expect(prompt).toContain("You are a tester.\n\nTest everything thoroughly.");
});
```

**Step 2: Run and verify**

Run: `bun test test/agents/plan.test.ts`
Expected: PASS

**Step 3: Commit (only if changes were needed)**

---

### Task 11: Create Quartermaster Resources Doc

Write the agent-tree-spec.md reference document that the quartermaster and fabricator use when creating agents.

**Files:**
- Create: `root/agents/quartermaster/resources/agent-tree-spec.md`
- Modify: `root/agents/quartermaster.md` — reference the resource in system prompt
- Modify: `root/agents/quartermaster/agents/qm-fabricator.md` — reference the resource

**Step 1: Write the resource document**

The document should cover:
1. Agent spec format (YAML frontmatter + markdown body)
2. Directory conventions (`<name>.md`, `<name>/agents/`, `<name>/tools/`)
3. Field definitions (`tools` and `agents`)
4. Auto-discovery rules (parent sees children)
5. Path resolution (absolute from root)
6. Placement rules (child of requester, utility/ for shared)
7. Dynamic delegation (return path to caller)

This is the design doc condensed into a reference the LLM can follow when creating agents. Use concrete examples from the actual tree.

**Step 2: Update quartermaster system prompt**

Add a section like:

```markdown
## Agent Tree Structure

When creating or managing agents, follow the conventions in your resources/agent-tree-spec.md file.
Read it before creating any agent.
```

**Step 3: Update fabricator system prompt**

Add similar reference to the resource doc.

**Step 4: Commit**

```bash
git add root/agents/quartermaster/resources/agent-tree-spec.md
git commit -m "docs: add agent tree spec resource for quartermaster"
```

---

### Task 12: Update References and Clean Up

Update all remaining references to `bootstrap`, old field names, and old paths. Remove deprecated code.

**Files:**
- Modify: `src/agents/index.ts` — update exports
- Modify: `README.md` — update any bootstrap references
- Modify: `docs/FILE_REFERENCE_GUIDE.md` — update paths
- Modify: Various test files — update bootstrap path references
- Remove: old YAML parsing code if fully replaced (or keep for genome backward compat)

**Step 1: Search and update all `bootstrap` references**

```bash
grep -r "bootstrap" src/ test/ --include="*.ts" -l
```

Update each file. The variable names `bootstrapDir` throughout the codebase should be renamed to `rootDir` or `agentRootDir`.

**Step 2: Search and update all `capabilities` references in runtime code**

The runtime should now use `spec.tools` for primitives and the tree resolver for agents. Find any remaining code that reads `spec.capabilities` and update it.

**Step 3: Update docs**

Update `README.md`, `docs/FILE_REFERENCE_GUIDE.md`, and any other docs referencing old paths.

**Step 4: Run full test suite**

Run: `bun test`
Expected: ALL pass

**Step 5: Final commit**

```bash
git commit -m "chore: clean up bootstrap references, update docs"
```

---

## Task Dependency Graph

```
Task 1 (parser) ─────────────────────┐
Task 2 (type changes) ───────────────┤
Task 3 (tree scanner) ───────────────┤
Task 4 (resolver) ───────────────────┤
Task 5 (delegate tool) ──────────────┤
                                      ├── Task 6+7 (convert + restructure) ──┐
                                      │                                       ├── Task 8 (genome/factory)
                                      │                                       ├── Task 9 (agent constructor)
                                      │                                       ├── Task 10 (system prompt verify)
                                      │                                       ├── Task 11 (QM resources)
                                      │                                       └── Task 12 (cleanup)
```

Tasks 1-5 are independent foundations that can be built and tested in isolation. Tasks 6+7 are the big restructure. Tasks 8-12 wire everything together.
