import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Load the tool function once ──────────────────────────────────────────────

let loadTranscript: (ctx: any) => Promise<any>;
let tempToolPath: string;

beforeAll(async () => {
  const toolSource = readFileSync(
    join(
      process.cwd(),
      "root/agents/utility/agents/transcript-analyst/tools/load-transcript",
    ),
    "utf-8",
  );

  // Strip YAML frontmatter
  const scriptBody = toolSource.startsWith("---\n")
    ? toolSource.slice(toolSource.indexOf("\n---\n", 4) + 5)
    : toolSource;

  tempToolPath = join(
    tmpdir(),
    `load-transcript-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
  );
  writeFileSync(tempToolPath, scriptBody);

  const mod = await import(tempToolPath);
  loadTranscript = mod.default;
});

afterAll(() => {
  if (tempToolPath) {
    try {
      rmSync(tempToolPath);
    } catch {}
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(
  kind: string,
  agent_id: string,
  data: Record<string, unknown> = {},
  timestamp = 1000,
): string {
  return JSON.stringify({ kind, timestamp, agent_id, depth: 0, data });
}

function makeLog(...events: string[]): string {
  return events.join("\n");
}

function makeCtx(
  args: Record<string, unknown> = {},
  envOverrides: {
    working_directory?: () => string;
    glob?: (pattern: string, dir: string) => Promise<string[]>;
    read_file?: (path: string) => Promise<string>;
  } = {},
) {
  return {
    args,
    agentName: "transcript-analyst",
    genome: {} as any,
    env: {
      working_directory: () => "/test/project",
      glob: async (_pattern: string, _dir: string) => [] as string[],
      read_file: async (_path: string) => "",
      ...envOverrides,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("load-transcript tool", () => {
  // ── Group 1: Basic filesystem behavior ───────────────────────────────────

  describe("filesystem behavior", () => {
    test("glob throws → returns error about no session logs", async () => {
      const ctx = makeCtx({}, {
        glob: async () => {
          throw new Error("ENOENT");
        },
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not find session logs");
      const output = JSON.parse(result.output);
      expect(output.error).toBe("No session logs found");
      expect(output.logsDir).toContain("logs");
    });

    test("glob returns empty array → returns error about no .jsonl files", async () => {
      const ctx = makeCtx({}, {
        glob: async () => [],
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No session log files found");
      const output = JSON.parse(result.output);
      expect(output.error).toBe("No .jsonl log files found");
    });

    test("read_file throws → returns error about failed read", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session1.jsonl"],
        read_file: async () => {
          throw new Error("EACCES");
        },
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to read");
      const output = JSON.parse(result.output);
      expect(output.error).toBe("Failed to read log file");
    });

    test("log file has no valid events → returns error", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session1.jsonl"],
        read_file: async () => "not valid json\nalso not json\n",
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("no valid events");
    });

    test("picks the latest log file (last alphabetically)", async () => {
      let readPath = "";
      const ctx = makeCtx({}, {
        glob: async () => [
          "01ABC_early.jsonl",
          "01ZZZ_latest.jsonl",
          "01DEF_middle.jsonl",
        ],
        read_file: async (path: string) => {
          readPath = path;
          return makeLog(
            makeEvent("session_start", "agent1", {}, 1000),
          );
        },
      });

      await loadTranscript(ctx);

      // After sort, "01ZZZ_latest.jsonl" is last alphabetically
      expect(readPath).toContain("01ZZZ_latest.jsonl");
    });
  });

  // ── Group 2: Event parsing ───────────────────────────────────────────────

  describe("event parsing", () => {
    test("malformed JSON lines are skipped, valid ones parsed", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            "this is not json",
            makeEvent("session_start", "agent1", {}, 1000),
            "{broken json",
            makeEvent("session_end", "agent1", {}, 2000),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.session.total_events).toBe(2);
    });

    test("returns success with summary when valid events present", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            makeEvent("session_start", "agent1", {}, 1000),
            makeEvent("plan_end", "agent1", { turn: 1, text: "step 1" }, 1500),
            makeEvent("session_end", "agent1", {}, 2000),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.session).toBeDefined();
      expect(summary.turns).toBeDefined();
      expect(summary.tools).toBeDefined();
      expect(summary.delegations).toBeDefined();
      expect(summary.diagnostics).toBeDefined();
      expect(summary.session.total_events).toBe(3);
      expect(summary.session.filtered_events).toBe(3);
      expect(summary.session.duration_ms).toBe(1000);
    });
  });

  // ── Group 3: agent_id filtering ──────────────────────────────────────────

  describe("agent_id filtering", () => {
    test("filters events by agent_id", async () => {
      const ctx = makeCtx(
        { agent_id: "agent-A" },
        {
          glob: async () => ["session.jsonl"],
          read_file: async () =>
            makeLog(
              makeEvent("session_start", "agent-A", {}, 1000),
              makeEvent("session_start", "agent-B", {}, 1000),
              makeEvent("plan_end", "agent-A", { turn: 1, text: "hi" }, 1500),
            ),
        },
      );

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.session.total_events).toBe(3);
      expect(summary.session.filtered_events).toBe(2);
      expect(summary.session.target_agent_id).toBe("agent-A");
    });

    test("no agent_id → includes all agents", async () => {
      const ctx = makeCtx(
        {},
        {
          glob: async () => ["session.jsonl"],
          read_file: async () =>
            makeLog(
              makeEvent("session_start", "agent-A", {}, 1000),
              makeEvent("session_start", "agent-B", {}, 1000),
            ),
        },
      );

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.session.filtered_events).toBe(2);
      expect(summary.session.target_agent_id).toBe("all");
    });
  });

  // ── Group 4: handle_id resolution ────────────────────────────────────────

  describe("handle_id resolution", () => {
    test("resolves handle_id to child_id from act_start event", async () => {
      const ctx = makeCtx(
        { handle_id: "handle-123" },
        {
          glob: async () => ["session.jsonl"],
          read_file: async (path: string) => {
            if (path.includes("handle-123")) throw new Error("not found");
            return makeLog(
              makeEvent("act_start", "parent", {
                handle_id: "handle-123",
                child_id: "child-agent-456",
                agent_name: "worker",
                goal: "do work",
              }),
              makeEvent("plan_end", "child-agent-456", { turn: 1, text: "working" }),
              makeEvent("plan_end", "parent", { turn: 1, text: "delegating" }),
              makeEvent("plan_end", "child-agent-456", { turn: 2, text: "done" }),
            );
          },
        },
      );

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      // Should have resolved to child-agent-456 and filtered
      expect(summary.session.target_agent_id).toBe("child-agent-456");
      // Only events for child-agent-456 (2 plan_end events)
      expect(summary.session.filtered_events).toBe(2);
    });

    test("falls back to handle_id as agent_id if events exist with that agent_id", async () => {
      const ctx = makeCtx(
        { handle_id: "direct-agent" },
        {
          glob: async () => ["session.jsonl"],
          read_file: async () =>
            makeLog(
              makeEvent("session_start", "direct-agent", {}, 1000),
              makeEvent("session_start", "other-agent", {}, 1000),
            ),
        },
      );

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.session.target_agent_id).toBe("direct-agent");
      expect(summary.session.filtered_events).toBe(1);
    });

    test("returns error if handle_id not found", async () => {
      const ctx = makeCtx(
        { handle_id: "nonexistent-handle" },
        {
          glob: async () => ["session.jsonl"],
          read_file: async (path: string) => {
            if (path.includes("nonexistent-handle")) throw new Error("not found");
            return makeLog(
              makeEvent("session_start", "agent-A", {}, 1000),
            );
          },
        },
      );

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain("No act_start event found for handle nonexistent-handle");
      const output = JSON.parse(result.output);
      expect(output.handle_id).toBe("nonexistent-handle");
      expect(output.suggestion).toBeDefined();
    });
  });

  // ── Group 5: kinds filtering ─────────────────────────────────────────────

  describe("kinds filtering", () => {
    test("filters events by kinds array", async () => {
      const ctx = makeCtx(
        { kinds: ["session_start", "primitive_start"] },
        {
          glob: async () => ["session.jsonl"],
          read_file: async () =>
            makeLog(
              makeEvent("session_start", "agent1", {}, 1000),
              makeEvent("plan_end", "agent1", { turn: 1, text: "thinking" }),
              makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/a" } }),
              makeEvent("primitive_end", "agent1", { name: "read_file" }),
              makeEvent("session_end", "agent1", {}, 5000),
            ),
        },
      );

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      // Only session_start + primitive_start = 2 events
      expect(summary.session.filtered_events).toBe(2);
    });
  });

  // ── Group 6: Turn counting ───────────────────────────────────────────────

  describe("turn counting", () => {
    test("counts max turn from plan_end events", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            makeEvent("plan_end", "agent1", { turn: 1, text: "step 1" }),
            makeEvent("plan_end", "agent1", { turn: 5, text: "step 5" }),
            makeEvent("plan_end", "agent1", { turn: 3, text: "step 3" }),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.turns.total).toBe(5);
    });
  });

  // ── Group 7: Tool usage ──────────────────────────────────────────────────

  describe("tool usage", () => {
    test("tracks tool usage counts from primitive_start events", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/a" } }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/b" } }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
            makeEvent("primitive_start", "agent1", { name: "exec", args: {} }),
            makeEvent("primitive_end", "agent1", { name: "exec" }),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.tools.usage_counts.read_file).toBe(2);
      expect(summary.tools.usage_counts.exec).toBe(1);
      expect(summary.tools.total_calls).toBe(3);
    });

    test("tracks files accessed from read_file/grep/glob primitives", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/src/index.ts" } }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
            makeEvent("primitive_start", "agent1", { name: "grep", args: { pattern: "TODO" } }),
            makeEvent("primitive_end", "agent1", { name: "grep" }),
            makeEvent("primitive_start", "agent1", { name: "glob", args: { pattern: "*.ts" } }),
            makeEvent("primitive_end", "agent1", { name: "glob" }),
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/src/index.ts" } }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      // read_file uses args.path, grep uses args.pattern, glob uses args.pattern
      expect(summary.tools.files_accessed).toContain("/src/index.ts");
      expect(summary.tools.files_accessed).toContain("TODO");
      expect(summary.tools.files_accessed).toContain("*.ts");
      // Deduplicated
      expect(summary.tools.files_accessed.length).toBe(3);
    });
  });

  // ── Group 8: Parallel call detection ─────────────────────────────────────

  describe("parallel call detection", () => {
    test("detects parallel group when multiple primitive_start before primitive_end", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            // Two consecutive starts → parallel group
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/a" } }),
            makeEvent("primitive_start", "agent1", { name: "grep", args: { pattern: "test" } }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
            makeEvent("primitive_end", "agent1", { name: "grep" }),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.tools.parallel_call_groups.length).toBe(1);
      expect(summary.tools.parallel_call_groups[0].tools).toEqual(["read_file", "grep"]);
      expect(summary.tools.parallel_call_groups[0].count).toBe(2);
    });

    test("no parallel group for sequential calls", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/a" } }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
            makeEvent("primitive_start", "agent1", { name: "grep", args: { pattern: "test" } }),
            makeEvent("primitive_end", "agent1", { name: "grep" }),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.tools.parallel_call_groups.length).toBe(0);
    });

    test("parallel groups track correct turn number", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            // Turn 1: first parallel group
            makeEvent("plan_end", "agent1", { turn: 1, text: "step 1" }),
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/a" } }),
            makeEvent("primitive_start", "agent1", { name: "grep", args: { pattern: "test" } }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
            makeEvent("primitive_end", "agent1", { name: "grep" }),
            // Turn 3: second parallel group
            makeEvent("plan_end", "agent1", { turn: 3, text: "step 3" }),
            makeEvent("primitive_start", "agent1", { name: "glob", args: { pattern: "*.ts" } }),
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/b" } }),
            makeEvent("primitive_end", "agent1", { name: "glob" }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.tools.parallel_call_groups.length).toBe(2);
      expect(summary.tools.parallel_call_groups[0].turn).toBe(1);
      expect(summary.tools.parallel_call_groups[1].turn).toBe(3);
    });

    test("parallel group turn is 0 when no preceding plan_end", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            // No plan_end before these starts
            makeEvent("primitive_start", "agent1", { name: "read_file", args: { path: "/a" } }),
            makeEvent("primitive_start", "agent1", { name: "grep", args: { pattern: "test" } }),
            makeEvent("primitive_end", "agent1", { name: "read_file" }),
            makeEvent("primitive_end", "agent1", { name: "grep" }),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.tools.parallel_call_groups.length).toBe(1);
      expect(summary.tools.parallel_call_groups[0].turn).toBe(0);
    });
  });

  // ── Group 9: Delegation tracking ────────────────────────────────────────

  describe("delegation tracking", () => {
    test("tracks delegations from act_start events", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            makeEvent("act_start", "parent", {
              agent_name: "worker",
              goal: "implement feature",
              handle_id: "h-1",
              child_id: "child-001",
              blocking: true,
            }),
            makeEvent("act_start", "parent", {
              agent_name: "reviewer",
              goal: "review code",
              handle_id: "h-2",
              child_id: "child-002",
              blocking: false,
            }),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.delegations).toHaveLength(2);
      expect(summary.delegations[0].agent_name).toBe("worker");
      expect(summary.delegations[0].goal).toBe("implement feature");
      expect(summary.delegations[0].handle_id).toBe("h-1");
      expect(summary.delegations[0].child_id).toBe("child-001");
      expect(summary.delegations[0].blocking).toBe(true);
      expect(summary.delegations[1].agent_name).toBe("reviewer");
      expect(summary.delegations[1].blocking).toBe(false);
    });
  });

  // ── Group 10: Warnings and errors ────────────────────────────────────────

  describe("warnings and errors", () => {
    test("collects warning and error events", async () => {
      const ctx = makeCtx({}, {
        glob: async () => ["session.jsonl"],
        read_file: async () =>
          makeLog(
            makeEvent("session_start", "agent1", {}, 1000),
            makeEvent("warning", "agent1", { message: "something is off" }, 2000),
            makeEvent("error", "agent1", { message: "something broke" }, 3000),
            makeEvent("warning", "agent1", { message: "another warning" }, 4000),
          ),
      });

      const result = await loadTranscript(ctx);

      expect(result.success).toBe(true);
      const summary = JSON.parse(result.output);
      expect(summary.diagnostics.warnings).toHaveLength(2);
      expect(summary.diagnostics.warnings[0].data.message).toBe("something is off");
      expect(summary.diagnostics.warnings[1].data.message).toBe("another warning");
      expect(summary.diagnostics.errors).toHaveLength(1);
      expect(summary.diagnostics.errors[0].data.message).toBe("something broke");
    });
  });

  // ── Group 11: Logs directory path construction ───────────────────────────

  describe("logs directory path", () => {
    test("constructs correct logs dir from working_directory slug", async () => {
      let globDir = "";
      const ctx = makeCtx(
        {},
        {
          working_directory: () => "/test/project",
          glob: async (_pattern: string, dir: string) => {
            globDir = dir;
            return [];
          },
        },
      );

      await loadTranscript(ctx);

      // Slug: "/test/project" → "-test-project"
      const home = process.env.HOME || process.env.USERPROFILE || "~";
      expect(globDir).toBe(
        `${home}/.local/share/sprout-genome/projects/-test-project/logs`,
      );
    });

    test("glob is called with *.jsonl pattern", async () => {
      let globPattern = "";
      const ctx = makeCtx(
        {},
        {
          glob: async (pattern: string, _dir: string) => {
            globPattern = pattern;
            return [];
          },
        },
      );

      await loadTranscript(ctx);

      expect(globPattern).toBe("*.jsonl");
    });
  });
});
