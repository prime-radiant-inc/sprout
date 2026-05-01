# Genome Reconciler & Internal Tool System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `sprout-internal` tool interpreter, two-layer tool resolution (genome overrides bootstrap), refactor misplaced agent tools into bootstrap directories, add `--genome sync` CLI, create the qm-reconciler agent, and update the quartermaster prompt.

**Architecture:** Tool files with `interpreter: sprout-internal` run as TypeScript modules in-process via `import()`, receiving a `ToolContext` with the live Genome and ExecutionEnvironment. Tools load from both `bootstrap/{agent}/tools/` (defaults) and `genome/agents/{agent}/tools/` (overrides), with genome winning on name collision. The qm-reconciler agent uses standard file primitives to compare bootstrap and genome specs.

**Tech Stack:** TypeScript, Bun, dynamic `import()`, YAML frontmatter

**Design doc:** `docs/plans/2026-02-28-qm-reconciler-design.md`

---

## Task 1: Add `provenance` field to `AgentToolDefinition`

The tool definition type needs a `provenance` field so the loader can record where each tool came from (bootstrap vs genome).

**Files:**
- Modify: `src/genome/genome.ts:601-606` (AgentToolDefinition interface)
- Test: `test/genome/workspace.test.ts`

**Step 1: Write the failing test**

Add to the existing `describe("loadAgentTools")` block in `test/genome/workspace.test.ts`:

```typescript
test("tools include provenance field", async () => {
	const root = join(tempDir, "load-tools-provenance");
	const genome = new Genome(root);
	await genome.init();
	await genome.addAgent(makeSpec({ name: "editor" }));

	await genome.saveAgentTool("editor", {
		name: "lint-fix",
		description: "Run linter",
		script: "#!/bin/bash\neslint --fix .",
		interpreter: "bash",
	});

	const tools = await genome.loadAgentTools("editor");
	expect(tools[0]!.provenance).toBe("genome");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/genome/workspace.test.ts`
Expected: FAIL — `provenance` property doesn't exist on the type

**Step 3: Add provenance to the type and loader**

In `src/genome/genome.ts`, update the `AgentToolDefinition` interface:

```typescript
export interface AgentToolDefinition {
	name: string;
	description: string;
	interpreter: string;
	scriptPath: string;
	provenance: "genome" | "bootstrap";
}
```

In `loadAgentTools()` method (line 489), add `provenance: "genome"` to each tool definition pushed into the array:

```typescript
tools.push({
	name: parsed.name,
	description: parsed.description,
	interpreter: parsed.interpreter,
	scriptPath: toolPath,
	provenance: "genome",
});
```

**Step 4: Run test to verify it passes**

Run: `bun test test/genome/workspace.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass. If any test references `AgentToolDefinition` without the new field, fix the shape.

**Step 6: Commit**

```bash
git add src/genome/genome.ts test/genome/workspace.test.ts
git commit -m "feat: add provenance field to AgentToolDefinition"
```

---

## Task 2: Two-layer tool resolution — `loadAgentToolsWithBootstrap`

Add a method to Genome that loads tools from both genome and bootstrap directories, with genome overriding bootstrap on name collision.

**Files:**
- Modify: `src/genome/genome.ts` (add `loadAgentToolsWithBootstrap` method)
- Test: `test/genome/workspace.test.ts`

**Step 1: Write failing tests**

Add a new `describe("loadAgentToolsWithBootstrap")` block in `test/genome/workspace.test.ts`:

```typescript
import { mkdir, writeFile } from "node:fs/promises";

describe("loadAgentToolsWithBootstrap", () => {
	test("loads tools from bootstrap when genome has none", async () => {
		const root = join(tempDir, "two-layer-bootstrap-only");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "task-manager" }));

		// Create a bootstrap tool directory with a tool file
		const bootstrapDir = join(tempDir, "bootstrap-two-layer-1");
		const toolDir = join(bootstrapDir, "task-manager", "tools");
		await mkdir(toolDir, { recursive: true });
		await writeFile(
			join(toolDir, "task-cli"),
			'---\nname: task-cli\ndescription: Manage tasks\ninterpreter: bash\n---\necho "hello"',
		);

		const tools = await genome.loadAgentToolsWithBootstrap("task-manager", bootstrapDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("task-cli");
		expect(tools[0]!.provenance).toBe("bootstrap");
	});

	test("genome tool overrides bootstrap tool with same name", async () => {
		const root = join(tempDir, "two-layer-override");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "task-manager" }));

		// Save a genome-level tool
		await genome.saveAgentTool("task-manager", {
			name: "task-cli",
			description: "Genome version of task CLI",
			script: 'echo "genome"',
			interpreter: "bash",
		});

		// Create a bootstrap tool with same name
		const bootstrapDir = join(tempDir, "bootstrap-two-layer-2");
		const toolDir = join(bootstrapDir, "task-manager", "tools");
		await mkdir(toolDir, { recursive: true });
		await writeFile(
			join(toolDir, "task-cli"),
			'---\nname: task-cli\ndescription: Bootstrap version\ninterpreter: bash\n---\necho "bootstrap"',
		);

		const tools = await genome.loadAgentToolsWithBootstrap("task-manager", bootstrapDir);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("task-cli");
		expect(tools[0]!.provenance).toBe("genome");
		expect(tools[0]!.description).toBe("Genome version of task CLI");
	});

	test("merges genome and bootstrap tools without collision", async () => {
		const root = join(tempDir, "two-layer-merge");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "editor" }));

		// Save a genome-only tool
		await genome.saveAgentTool("editor", {
			name: "genome-tool",
			description: "Only in genome",
			script: 'echo "genome"',
			interpreter: "bash",
		});

		// Create a bootstrap-only tool
		const bootstrapDir = join(tempDir, "bootstrap-two-layer-3");
		const toolDir = join(bootstrapDir, "editor", "tools");
		await mkdir(toolDir, { recursive: true });
		await writeFile(
			join(toolDir, "bootstrap-tool"),
			'---\nname: bootstrap-tool\ndescription: Only in bootstrap\ninterpreter: bash\n---\necho "bootstrap"',
		);

		const tools = await genome.loadAgentToolsWithBootstrap("editor", bootstrapDir);
		expect(tools).toHaveLength(2);
		const names = tools.map((t) => t.name);
		expect(names).toContain("genome-tool");
		expect(names).toContain("bootstrap-tool");
	});

	test("returns empty when neither directory has tools", async () => {
		const root = join(tempDir, "two-layer-empty");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "reader" }));

		const bootstrapDir = join(tempDir, "bootstrap-two-layer-empty");
		await mkdir(bootstrapDir, { recursive: true });

		const tools = await genome.loadAgentToolsWithBootstrap("reader", bootstrapDir);
		expect(tools).toEqual([]);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/genome/workspace.test.ts`
Expected: FAIL — `loadAgentToolsWithBootstrap` doesn't exist

**Step 3: Implement `loadAgentToolsWithBootstrap`**

Add to `Genome` class in `src/genome/genome.ts`, after the existing `loadAgentTools` method:

```typescript
/**
 * Load tool definitions from both genome and bootstrap, with genome overriding bootstrap.
 * Tools from bootstrap/{agentName}/tools/ are the defaults; genome tools win on name collision.
 */
async loadAgentToolsWithBootstrap(
	agentName: string,
	bootstrapDir: string,
): Promise<AgentToolDefinition[]> {
	// 1. Load genome tools (existing method)
	const genomeTools = await this.loadAgentTools(agentName);

	// 2. Load bootstrap tools
	const bootstrapToolDir = join(bootstrapDir, agentName, "tools");
	const bootstrapTools = await this.loadToolsFromDir(bootstrapToolDir, "bootstrap");

	// 3. Merge: genome wins on name collision
	const genomeNames = new Set(genomeTools.map((t) => t.name));
	const merged = [...genomeTools];
	for (const tool of bootstrapTools) {
		if (!genomeNames.has(tool.name)) {
			merged.push(tool);
		}
	}

	return merged;
}

/** Load tool definitions from an arbitrary directory, setting provenance. */
private async loadToolsFromDir(
	toolDir: string,
	provenance: "genome" | "bootstrap",
): Promise<AgentToolDefinition[]> {
	let entries: string[];
	try {
		entries = await readdir(toolDir);
	} catch {
		return [];
	}

	const tools: AgentToolDefinition[] = [];
	for (const entry of entries) {
		const toolPath = join(toolDir, entry);
		const content = await readFile(toolPath, "utf-8");
		const parsed = parseToolFrontmatter(content);
		if (parsed) {
			tools.push({
				name: parsed.name,
				description: parsed.description,
				interpreter: parsed.interpreter,
				scriptPath: toolPath,
				provenance,
			});
		}
	}
	return tools;
}
```

Then refactor the existing `loadAgentTools` to use `loadToolsFromDir`:

```typescript
async loadAgentTools(agentName: string): Promise<AgentToolDefinition[]> {
	const toolDir = join(this.agentDir(agentName), "tools");
	return this.loadToolsFromDir(toolDir, "genome");
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/genome/workspace.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/genome/genome.ts test/genome/workspace.test.ts
git commit -m "feat: two-layer tool resolution (genome overrides bootstrap)"
```

---

## Task 3: Wire two-layer tool loading into agent startup

Replace the genome-only tool loading in `agent.ts` with the two-layer version. The agent needs a `bootstrapDir` to pass through.

**Files:**
- Modify: `src/agents/agent.ts:52-85` (AgentOptions) and `src/agents/agent.ts:625-644` (tool loading in `run()`)
- Modify: `src/agents/factory.ts:139-159` (pass bootstrapDir to Agent)

**Step 1: Add `bootstrapDir` to `AgentOptions`**

In `src/agents/agent.ts`, add to the `AgentOptions` interface:

```typescript
/** Path to bootstrap agent directory (for two-layer tool resolution). */
bootstrapDir?: string;
```

Store it in the constructor:

```typescript
private readonly bootstrapDir?: string;

// In constructor:
this.bootstrapDir = options.bootstrapDir;
```

**Step 2: Update tool loading in `run()`**

In `agent.ts`, replace the tool loading block (around line 625-644) to use `loadAgentToolsWithBootstrap` when `bootstrapDir` is available:

```typescript
let wsToolDefs: import("../genome/genome.ts").AgentToolDefinition[] = [];
if (this.genome && this.primitiveTools.length > 0) {
	wsToolDefs = this.bootstrapDir
		? await this.genome.loadAgentToolsWithBootstrap(this.spec.name, this.bootstrapDir)
		: await this.genome.loadAgentTools(this.spec.name);
	if (wsToolDefs.length > 0) {
		const toolPrims = buildAgentToolPrimitives(wsToolDefs);
		for (const prim of toolPrims) {
			this.primitiveRegistry.register(prim);
			this.primitiveTools.push({
				name: prim.name,
				description: prim.description,
				parameters: prim.parameters,
			});
		}
	}

	// Add both genome and bootstrap tool directories to PATH
	const genomeToolsDir = join(this.genome.agentDir(this.spec.name), "tools");
	this.env.addToPath?.(genomeToolsDir);
	if (this.bootstrapDir) {
		const bootstrapToolsDir = join(this.bootstrapDir, this.spec.name, "tools");
		this.env.addToPath?.(bootstrapToolsDir);
	}
}
```

Also remove the `&& this.genome.loadAgentTools` guard from line 627 — the method always exists.

**Step 3: Pass bootstrapDir from factory.ts**

In `src/agents/factory.ts`, the `Agent` constructor call (around line 139) should include `bootstrapDir`:

```typescript
const agent = new Agent({
	// ...existing options...
	bootstrapDir: options.bootstrapDir,
});
```

**Step 4: Run full test suite**

Run: `bun test`
Expected: All pass (this is a wiring change, no new logic to test separately — the two-layer resolution tests from Task 2 cover the core logic)

**Step 5: Commit**

```bash
git add src/agents/agent.ts src/agents/factory.ts
git commit -m "feat: wire two-layer tool resolution into agent startup"
```

---

## Task 4: `sprout-internal` interpreter

Add support for `interpreter: sprout-internal` in the tool loading system. These tools run as TypeScript modules in-process via `import()`.

**Files:**
- Modify: `src/kernel/tool-loading.ts`
- Create: `src/kernel/tool-context.ts` (ToolContext type)
- Test: `test/kernel/tool-loading.test.ts`

**Step 1: Create the ToolContext type**

Create `src/kernel/tool-context.ts`:

```typescript
import type { Genome } from "../genome/genome.ts";
import type { ExecutionEnvironment } from "./execution-env.ts";

export interface ToolContext {
	agentName: string;
	args: Record<string, unknown>;
	genome: Genome;
	env: ExecutionEnvironment;
}

export interface ToolResult {
	output: string;
	success: boolean;
	error?: string;
}
```

**Step 2: Write failing tests**

Add to `test/kernel/tool-loading.test.ts`:

```typescript
import { writeFile, mkdir } from "node:fs/promises";

describe("sprout-internal tools", () => {
	test("executes a sprout-internal tool and returns its result", async () => {
		const root = join(tempDir, "internal-tool");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "runner" }));

		// Write a sprout-internal tool as a .ts file
		const toolDir = join(root, "agents", "runner", "tools");
		await mkdir(toolDir, { recursive: true });
		const toolPath = join(toolDir, "hello-internal");
		await writeFile(
			toolPath,
			`---
name: hello-internal
description: A test internal tool
interpreter: sprout-internal
---
export default async function(ctx) {
  return {
    output: "hello from " + ctx.agentName,
    success: true,
  };
}
`,
		);

		const toolDefs = await genome.loadAgentTools("runner");
		expect(toolDefs).toHaveLength(1);
		expect(toolDefs[0]!.interpreter).toBe("sprout-internal");

		const env = new LocalExecutionEnvironment(tempDir);
		const prims = buildAgentToolPrimitives(toolDefs, { genome, env, agentName: "runner" });

		const result = await prims[0]!.execute({}, env);
		expect(result.success).toBe(true);
		expect(result.output).toBe("hello from runner");
	});

	test("sprout-internal tool receives parsed args", async () => {
		const root = join(tempDir, "internal-args");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "runner" }));

		const toolDir = join(root, "agents", "runner", "tools");
		await mkdir(toolDir, { recursive: true });
		const toolPath = join(toolDir, "echo-args");
		await writeFile(
			toolPath,
			`---
name: echo-args
description: Echo args back
interpreter: sprout-internal
---
export default async function(ctx) {
  return {
    output: JSON.stringify(ctx.args),
    success: true,
  };
}
`,
		);

		const toolDefs = await genome.loadAgentTools("runner");
		const env = new LocalExecutionEnvironment(tempDir);
		const prims = buildAgentToolPrimitives(toolDefs, { genome, env, agentName: "runner" });

		const result = await prims[0]!.execute({ args: '{"name":"test","count":3}' }, env);
		expect(result.success).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.name).toBe("test");
		expect(parsed.count).toBe(3);
	});

	test("sprout-internal tool wraps thrown errors", async () => {
		const root = join(tempDir, "internal-error");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "runner" }));

		const toolDir = join(root, "agents", "runner", "tools");
		await mkdir(toolDir, { recursive: true });
		const toolPath = join(toolDir, "throw-tool");
		await writeFile(
			toolPath,
			`---
name: throw-tool
description: Always throws
interpreter: sprout-internal
---
export default async function(ctx) {
  throw new Error("intentional failure");
}
`,
		);

		const toolDefs = await genome.loadAgentTools("runner");
		const env = new LocalExecutionEnvironment(tempDir);
		const prims = buildAgentToolPrimitives(toolDefs, { genome, env, agentName: "runner" });

		const result = await prims[0]!.execute({}, env);
		expect(result.success).toBe(false);
		expect(result.error).toContain("intentional failure");
	});

	test("sprout-internal tool with invalid JSON args receives empty object", async () => {
		const root = join(tempDir, "internal-bad-json");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "runner" }));

		const toolDir = join(root, "agents", "runner", "tools");
		await mkdir(toolDir, { recursive: true });
		const toolPath = join(toolDir, "check-args");
		await writeFile(
			toolPath,
			`---
name: check-args
description: Check args
interpreter: sprout-internal
---
export default async function(ctx) {
  return {
    output: JSON.stringify(ctx.args),
    success: true,
  };
}
`,
		);

		const toolDefs = await genome.loadAgentTools("runner");
		const env = new LocalExecutionEnvironment(tempDir);
		const prims = buildAgentToolPrimitives(toolDefs, { genome, env, agentName: "runner" });

		const result = await prims[0]!.execute({ args: "not valid json" }, env);
		expect(result.success).toBe(true);
		expect(JSON.parse(result.output)).toEqual({});
	});
});
```

**Step 3: Run tests to verify they fail**

Run: `bun test test/kernel/tool-loading.test.ts`
Expected: FAIL — `buildAgentToolPrimitives` doesn't accept the second parameter

**Step 4: Implement sprout-internal dispatch**

Update `src/kernel/tool-loading.ts`. The function signature gains an optional `InternalToolContext` parameter:

```typescript
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Genome, AgentToolDefinition } from "../genome/genome.ts";
import type { ExecutionEnvironment } from "./execution-env.ts";
import type { Primitive } from "./primitives.ts";
import type { ToolContext } from "./tool-context.ts";

/** Extract the script body from a tool file, stripping the YAML frontmatter. */
function extractScriptBody(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const endIdx = content.indexOf("\n---\n", 4);
	if (endIdx === -1) return content;
	return content.slice(endIdx + 5);
}

export interface InternalToolContext {
	genome: Genome;
	env: ExecutionEnvironment;
	agentName: string;
}

/**
 * Build Primitive instances from loaded agent tool definitions.
 * Each tool becomes a primitive that executes its script using the specified interpreter.
 * For `sprout-internal` tools, the optional `internalCtx` is required.
 */
export function buildAgentToolPrimitives(
	tools: AgentToolDefinition[],
	internalCtx?: InternalToolContext,
): Primitive[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: {
			type: "object",
			properties: {
				args: {
					type: "string",
					description: "Arguments to pass to the tool",
				},
			},
		},
		async execute(args: Record<string, unknown>, env: ExecutionEnvironment) {
			const toolArgs = (args.args as string) ?? "";

			if (tool.interpreter === "sprout-internal") {
				if (!internalCtx) {
					return {
						output: "",
						success: false,
						error: "sprout-internal tools require an InternalToolContext",
					};
				}

				// Parse args as JSON; fall back to empty object
				let parsedArgs: Record<string, unknown> = {};
				if (toolArgs) {
					try {
						parsedArgs = JSON.parse(toolArgs);
					} catch {
						// Invalid JSON — use empty object
					}
				}

				const ctx: ToolContext = {
					agentName: internalCtx.agentName,
					args: parsedArgs,
					genome: internalCtx.genome,
					env: internalCtx.env,
				};

				try {
					// Dynamic import with cache-busting (unique query param)
					const mod = await import(`${tool.scriptPath}?t=${Date.now()}`);
					const fn = mod.default;
					if (typeof fn !== "function") {
						return {
							output: "",
							success: false,
							error: `Tool '${tool.name}' does not export a default function`,
						};
					}
					const result = await fn(ctx);
					return {
						output: result?.output ?? "",
						success: result?.success ?? false,
						error: result?.error,
					};
				} catch (err) {
					return {
						output: "",
						success: false,
						error: String(err),
					};
				}
			}

			// Existing shell tool execution
			try {
				const fileContent = await readFile(tool.scriptPath, "utf-8");
				const script = extractScriptBody(fileContent);
				const escapedScript = script.replace(/'/g, "'\\''");
				const command = toolArgs
					? `echo '${escapedScript}' | ${tool.interpreter} /dev/stdin ${toolArgs}`
					: `echo '${escapedScript}' | ${tool.interpreter} /dev/stdin`;

				const result = await env.exec_command(command, { timeout_ms: 30_000 });
				const output = [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : ""]
					.filter(Boolean)
					.join("\n");

				return {
					output,
					success: result.exit_code === 0 && !result.timed_out,
					error:
						result.exit_code !== 0
							? `Tool exited with code ${result.exit_code}`
							: result.timed_out
								? "Tool timed out"
								: undefined,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	}));
}
```

**Step 5: Update agent.ts to pass InternalToolContext**

In `src/agents/agent.ts`, update the `buildAgentToolPrimitives` call (around line 630):

```typescript
const toolPrims = buildAgentToolPrimitives(wsToolDefs, {
	genome: this.genome,
	env: this.env,
	agentName: this.spec.name,
});
```

**Step 6: Run tests to verify they pass**

Run: `bun test test/kernel/tool-loading.test.ts`
Expected: PASS

**Step 7: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 8: Commit**

```bash
git add src/kernel/tool-context.ts src/kernel/tool-loading.ts src/agents/agent.ts test/kernel/tool-loading.test.ts
git commit -m "feat: add sprout-internal interpreter for in-process TypeScript tools"
```

---

## Task 5: Move task-manager tools to bootstrap

Move `src/tasks/cli.ts`, `src/tasks/store.ts`, and `src/tasks/types.ts` into `bootstrap/task-manager/tools/` and update the agent prompt.

**Files:**
- Create: `bootstrap/task-manager/tools/task-cli` (the tool file with frontmatter + script body)
- Keep: `src/tasks/store.ts` and `src/tasks/types.ts` — these are imported by the CLI, and the CLI will still be a bun script run via the shell interpreter (not sprout-internal). The task-cli tool will invoke `bun run` on itself.
- Modify: `bootstrap/task-manager.yaml` (update system prompt to reference the tool by name instead of hardcoded path)
- Test: existing `test/tasks/cli.test.ts` must continue to pass

**Important context:** The task-manager CLI is a standalone bun script that reads/writes a JSON file. It doesn't need sprout-internal because it doesn't access the Genome — it just manages a JSON task list. The cleanest approach is to make it a `bash` tool that invokes `bun run` on the supporting modules that live alongside it.

**Step 1: Create the bootstrap tool directory**

```bash
mkdir -p bootstrap/task-manager/tools
```

**Step 2: Create the tool file**

Create `bootstrap/task-manager/tools/task-cli` with YAML frontmatter wrapping the bash invocation. The supporting modules (`store.ts`, `types.ts`) live alongside it:

Copy `src/tasks/store.ts` → `bootstrap/task-manager/tools/store.ts`
Copy `src/tasks/types.ts` → `bootstrap/task-manager/tools/types.ts`
Copy `src/tasks/cli.ts` → `bootstrap/task-manager/tools/cli.ts`

Update the import paths in the copied `cli.ts` to be relative to its new location (they already use `"./store.ts"` so this should work).

Create `bootstrap/task-manager/tools/task-cli` frontmatter wrapper:

```
---
name: task-cli
description: "Manage session tasks: create, list, get, update, comment"
interpreter: bash
---
#!/bin/bash
# The tool directory is added to PATH by the tool loader.
# Use BASH_SOURCE to find sibling modules.
TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
exec bun run "$TOOL_DIR/cli.ts" "$@"
```

**Step 3: Update task-manager.yaml prompt**

Replace the hardcoded `bun run src/tasks/cli.ts` paths in `bootstrap/task-manager.yaml` with tool-based invocation. The system prompt should reference the tool by name:

```yaml
system_prompt: |
  You manage a task list for the current session.

  ## How to Use

  Run the task-cli tool via exec. It is on your PATH automatically:

  ```
  task-cli --tasks-file <TASKS_FILE_PATH> <command> [options]
  ```

  The tasks file path will be provided to you when you receive a goal.

  ## Commands

  Create a task:
    task-cli --tasks-file <path> create --description "..." [--prompt "..."] [--assigned-to <agent>]

  List all tasks:
    task-cli --tasks-file <path> list [--status new|in_progress|done|cancelled]

  Get a specific task:
    task-cli --tasks-file <path> get --id <task-id>

  Update a task:
    task-cli --tasks-file <path> update --id <task-id> [--status <status>] [--assigned-to <agent>] [--description "..."]

  Comment on a task:
    task-cli --tasks-file <path> comment --id <task-id> --text "..."

  ## Output

  All commands output JSON. Report results clearly and concisely to your caller.

  ## Role

  You are a data store, not a decision maker. Execute the requested operations
  and report the results. Do not make judgments about task priority or ordering.
```

**Step 4: Update test CLI path**

In `test/tasks/cli.test.ts`, update the CLI path constant:

```typescript
const CLI = join(import.meta.dir, "../../bootstrap/task-manager/tools/cli.ts");
```

**Step 5: Run tests**

Run: `bun test test/tasks/cli.test.ts`
Expected: PASS — the CLI logic is identical, just moved

**Step 6: Verify imports from src/tasks are not broken elsewhere**

Run: `grep -r "from.*src/tasks" src/ test/ --include="*.ts" | grep -v node_modules`

If any files import from `src/tasks/types.ts`, keep a re-export or update the import. Common pattern: add a `src/tasks/types.ts` that re-exports from the new location, or update the imports directly.

**Step 7: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 8: Commit**

```bash
git add bootstrap/task-manager/ test/tasks/cli.test.ts bootstrap/task-manager.yaml
# If src/tasks files are being removed or re-exported:
git add src/tasks/
git commit -m "refactor: move task-manager CLI tools to bootstrap/task-manager/tools/"
```

---

## Task 6: Move MCP CLI to bootstrap

Move `src/mcp-cli.ts` to `bootstrap/mcp/tools/` as a properly-wrapped tool.

**Files:**
- Create: `bootstrap/mcp/tools/sprout-mcp` (bash frontmatter wrapper)
- Copy: `src/mcp-cli.ts` → `bootstrap/mcp/tools/mcp-cli.ts` (the actual implementation)
- Modify: `bootstrap/mcp.yaml` (update system prompt)

**Step 1: Create the bootstrap tool directory**

```bash
mkdir -p bootstrap/mcp/tools
```

**Step 2: Copy the MCP CLI and create the wrapper**

Copy `src/mcp-cli.ts` → `bootstrap/mcp/tools/mcp-cli.ts`

Create `bootstrap/mcp/tools/sprout-mcp`:

```
---
name: sprout-mcp
description: "Connect to MCP servers and invoke their tools"
interpreter: bash
---
#!/bin/bash
TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
exec bun run "$TOOL_DIR/mcp-cli.ts" "$@"
```

**Step 3: Update mcp.yaml prompt**

The `bootstrap/mcp.yaml` system prompt already references `sprout-mcp` by name in its usage docs. Verify it still makes sense (the tool is now on PATH via the tool loader, so the existing prompt should work). If needed, add a note:

```yaml
system_prompt: |
  You are an MCP (Model Context Protocol) client agent. You drive MCP servers
  through the `sprout-mcp` CLI tool (on your PATH automatically).
  ...
```

Minor tweak: remove the fallback sentence "If sprout-mcp is not on PATH, fall back to reading mcp.json directly" — the tool loader guarantees it's on PATH.

**Step 4: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 5: Commit**

```bash
git add bootstrap/mcp/ bootstrap/mcp.yaml
git commit -m "refactor: move MCP CLI to bootstrap/mcp/tools/"
```

---

## Task 7: `--genome sync` CLI command

Add the `--genome sync` subcommand to the CLI.

**Files:**
- Modify: `src/host/cli.ts` (add `genome-sync` command kind and handler)
- Test: `test/host/cli.test.ts` (add parseArgs test)

**Step 1: Write failing test**

Add to the `parseArgs` tests in `test/host/cli.test.ts`:

```typescript
test("--genome sync returns genome-sync command", () => {
	const cmd = parseArgs(["--genome", "sync"]);
	expect(cmd.kind).toBe("genome-sync");
	expect(cmd.genomePath).toBeDefined();
});

test("--genome sync with custom genome path", () => {
	const cmd = parseArgs(["--genome-path", "/custom/path", "--genome", "sync"]);
	expect(cmd.kind).toBe("genome-sync");
	expect(cmd.genomePath).toBe("/custom/path");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/host/cli.test.ts -t "genome sync"`
Expected: FAIL — parseArgs returns `{ kind: "help" }` for unknown genome subcommand

**Step 3: Add `genome-sync` to CliCommand type and parseArgs**

In `src/host/cli.ts`, add to the `CliCommand` union type:

```typescript
| { kind: "genome-sync"; genomePath: string }
```

In `parseArgs`, in the `--genome` pre-scan block, add before the `return { kind: "help" }`:

```typescript
if (sub === "sync") return { kind: "genome-sync", genomePath };
```

Add the sync handler in `runCli`, before the `genome-export` handler:

```typescript
if (command.kind === "genome-sync") {
	const { Genome } = await import("../genome/genome.ts");
	const bootstrapDir = join(import.meta.dir, "../../bootstrap");

	const genome = new Genome(command.genomePath);
	try {
		await genome.loadFromDisk();
	} catch (err) {
		console.error(
			`Failed to load genome at ${command.genomePath}: ${err instanceof Error ? err.message : err}`,
		);
		process.exitCode = 1;
		return;
	}

	const result = await genome.syncBootstrap(bootstrapDir);

	if (result.added.length === 0 && result.updated.length === 0 && result.conflicts.length === 0) {
		console.log("Genome is up to date with bootstrap.");
		return;
	}

	if (result.added.length > 0) {
		console.log(`Added: ${result.added.join(", ")}`);
	}
	if (result.updated.length > 0) {
		console.log(`Updated: ${result.updated.join(", ")}`);
	}
	if (result.conflicts.length > 0) {
		console.log(`Conflicts (genome preserved): ${result.conflicts.join(", ")}`);
	}
	return;
}
```

Update the USAGE string to include `--genome sync`:

```
Genome management:
  sprout --genome list                  List agents in the genome
  sprout --genome log                   Show genome git log
  sprout --genome sync                  Sync bootstrap agents to runtime genome
  sprout --genome rollback <commit>     Revert a genome commit
  sprout --genome export                Show learnings that evolved beyond bootstrap
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/host/cli.test.ts -t "genome sync"`
Expected: PASS

**Step 5: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 6: Commit**

```bash
git add src/host/cli.ts test/host/cli.test.ts
git commit -m "feat: add --genome sync CLI command"
```

---

## Task 8: Create qm-reconciler agent spec

Create the bootstrap agent YAML for qm-reconciler.

**Files:**
- Create: `bootstrap/qm-reconciler.yaml`

**Step 1: Write the agent spec**

Create `bootstrap/qm-reconciler.yaml`:

```yaml
name: qm-reconciler
description: "Reconcile genome/bootstrap differences and propose contributions"
model: fast
capabilities:
  - read_file
  - grep
  - glob
  - write_file
constraints:
  max_turns: 20
  max_depth: 0
  can_spawn: false
  timeout_ms: 120000
tags:
  - quartermaster
  - reconciliation
version: 1
system_prompt: |
  You reconcile differences between the bootstrap source code and the runtime genome,
  and propose improvements from the genome back to bootstrap.

  ## Two jobs

  ### 1. Reconcile overlays

  When bootstrap updates an agent that the genome has customized, both versions diverge.
  The sync process (via `syncBootstrap`) reports these as conflicts.

  Your job: read both versions, understand the diff, and recommend one of:
  - **Absorb**: Take the bootstrap change (genome's customization wasn't valuable)
  - **Keep**: Preserve the genome version (the customization matters more)
  - **Merge**: Combine both changes (the bootstrap update and the genome improvement are complementary)

  Write your recommendation as a YAML file to the genome's agents directory.

  ### 2. Propose contributions

  Compare genome agents to their bootstrap counterparts. When the genome version
  exceeds the bootstrap version (Learn improved it), that's a candidate for promotion
  to core.

  Read both prompts, summarize what changed and why it's better, and write a proposal
  to the genome's agents directory explaining the improvement.

  ## Where to find things

  - Bootstrap agent specs: `bootstrap/*.yaml`
  - Genome agent specs: `~/.local/share/sprout-genome/agents/*.yaml`
  - Bootstrap manifest: `~/.local/share/sprout-genome/bootstrap-manifest.json`

  ## How to work

  Use your file primitives directly — read_file to examine specs, grep to search,
  glob to discover, write_file to save proposals. You're good at reading files and
  reasoning about content. No special tools needed.

  Be specific in your recommendations. Quote relevant sections from both versions.
  Explain the tradeoff clearly so a human or the quartermaster can act on it.
```

**Step 2: Verify the spec loads**

Run: `bun test test/agents/loader.test.ts`
Expected: PASS (existing loader tests should handle the new file)

If there's no specific loader test, verify by checking the bootstrap agent count hasn't broken anything:

Run: `bun test`
Expected: All pass

**Step 3: Commit**

```bash
git add bootstrap/qm-reconciler.yaml
git commit -m "feat: add qm-reconciler bootstrap agent spec"
```

---

## Task 9: Update quartermaster with reconciler mode and tool documentation

Add the reconciler mode and tool system documentation to the quartermaster's system prompt and capabilities.

**Files:**
- Modify: `bootstrap/quartermaster.yaml`

**Step 1: Add qm-reconciler to capabilities**

In `bootstrap/quartermaster.yaml`, add `qm-reconciler` to the capabilities list:

```yaml
capabilities:
  - qm-indexer
  - qm-planner
  - qm-fabricator
  - qm-reconciler
```

**Step 2: Add reconciler mode and tool documentation to system prompt**

Append to the system prompt, after the Fabricator Mode section:

```
  **Reconciler Mode** — "What's drifted? Reconcile overlays. Propose contributions."
  Delegate to qm-reconciler to inspect state, reconcile conflicts between
  bootstrap and genome, or propose genome improvements for promotion to bootstrap.
  Use this when:
  - Bootstrap sync reported conflicts
  - You want to review what the genome has improved beyond bootstrap
  - You need to reconcile after a sprout update

  How to choose modes:
  - Questions about what's available → Oracle
  - Questions about how to do something → Planner (which may cascade to Fabricator)
  - Explicit requests to build an agent → Fabricator (with indexing for context)
  - Questions about drift or reconciliation → Reconciler

  ## Agent tool system

  Agents can have dedicated tools in their workspace. Tools are scripts with YAML
  frontmatter (name, description, interpreter) stored in `agents/{name}/tools/`.

  Two interpreter types:
  - **Shell** (`bash`, `python`, `node`, etc.) — script piped to interpreter via stdin
  - **`sprout-internal`** — TypeScript module run in-process via `import()`, receiving
    a ToolContext with the live Genome and ExecutionEnvironment

  Two-layer resolution:
  - `~/.local/share/sprout-genome/agents/{name}/tools/` — genome overrides (layer 1)
  - `bootstrap/{name}/tools/` — defaults (layer 2)
  - Genome wins on name collision. Delete genome override to restore bootstrap default.

  ToolContext for sprout-internal tools:
  ```
  { agentName: string, args: Record<string, unknown>, genome: Genome, env: ExecutionEnvironment }
  ```

  Tools return: `{ output: string, success: boolean, error?: string }`

  When the fabricator creates tools, they should follow this convention. Use
  `sprout-internal` when the tool needs access to the Genome or ExecutionEnvironment.
  Use shell interpreters for standalone scripts.
```

**Step 3: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 4: Commit**

```bash
git add bootstrap/quartermaster.yaml
git commit -m "feat: add reconciler mode and tool system docs to quartermaster"
```

---

## Task 10: Update qm-fabricator with tool conventions

The fabricator creates tools for agents. Update its prompt to document the bootstrap tool directory convention and sprout-internal interpreter.

**Files:**
- Modify: `bootstrap/qm-fabricator.yaml`

**Step 1: Update the fabricator prompt**

In `bootstrap/qm-fabricator.yaml`, find the section about creating tools and expand it:

Replace the existing tool documentation paragraph (around "You can also create tools for agents...") with:

```
  ## Creating agent tools

  Agents can have dedicated tools. Write executable scripts to `agents/{name}/tools/{tool-name}`.
  Tools must have YAML frontmatter with name, description, and interpreter fields.

  Two interpreter types:
  - **Shell** (`bash`, `python`, `node`) — script piped to interpreter via stdin.
    Good for standalone operations that don't need Genome access.
  - **`sprout-internal`** — TypeScript module run in-process. Gets a ToolContext with
    `{ agentName, args, genome, env }`. Good for tools that need to read/write the
    genome or use the execution environment directly.

  Example shell tool:
  ```
  ---
  name: run-lint
  description: Run linter on the project
  interpreter: bash
  ---
  #!/bin/bash
  cd "$1" && eslint --fix .
  ```

  Example sprout-internal tool:
  ```
  ---
  name: count-agents
  description: Count agents in the genome
  interpreter: sprout-internal
  ---
  export default async function(ctx) {
    const agents = ctx.genome.allAgents();
    return {
      output: `${agents.length} agents in genome`,
      success: true,
    };
  }
  ```

  Tools return `{ output: string, success: boolean, error?: string }`.
  Access sprout internals via `ctx`, not via imports — keeps tools portable
  across both genome and bootstrap layers.
```

**Step 2: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 3: Commit**

```bash
git add bootstrap/qm-fabricator.yaml
git commit -m "docs: add tool creation conventions to qm-fabricator prompt"
```

---

## Task 11: Clean up — remove old src/tasks imports and verify

After all moves are complete, clean up any dangling imports and verify the whole system works.

**Files:**
- Modify: Any files still importing from `src/tasks/` (update to import from `bootstrap/task-manager/tools/`)
- Delete: `src/tasks/cli.ts`, `src/tasks/store.ts`, `src/tasks/types.ts` (if nothing else imports them) — OR keep them as re-exports if other code depends on them
- Delete: `src/mcp-cli.ts` (if nothing else imports it) — OR keep as re-export

**Step 1: Check for remaining imports**

Run: `grep -r "from.*['\"].*src/tasks" src/ test/ --include="*.ts" | grep -v node_modules`
Run: `grep -r "from.*['\"].*mcp-cli" src/ test/ --include="*.ts" | grep -v node_modules`
Run: `grep -r "src/tasks/cli" bootstrap/ --include="*.yaml"`
Run: `grep -r "src/mcp-cli" bootstrap/ --include="*.yaml"`

**Step 2: Update or remove as needed**

If `src/tasks/types.ts` is imported by other code (not just the CLI), keep it or move the types to a shared location. If only the CLI uses it, remove it.

If `src/mcp-cli.ts` is referenced nowhere else, remove it.

**Step 3: Run full test suite**

Run: `bun test`
Expected: All pass

**Step 4: Run biome format check**

Run: `bunx biome check --write src/ test/ bootstrap/`
Expected: No errors

**Step 5: Commit**

```bash
git add -A  # After verifying git status shows only expected changes
git commit -m "chore: clean up old tool paths after bootstrap migration"
```

---

## Summary of test commands

```bash
# Individual task verification
bun test test/genome/workspace.test.ts          # Tasks 1, 2
bun test test/kernel/tool-loading.test.ts        # Task 4
bun test test/tasks/cli.test.ts                  # Task 5
bun test test/host/cli.test.ts                   # Task 7

# Full suite (run after every task)
bun test
```
