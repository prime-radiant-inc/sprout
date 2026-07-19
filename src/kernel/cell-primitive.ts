/**
 * The `cell` kernel tool (sap spec §4): submit JS to the agent's cell worker.
 * The CellHost already applies the above-the-line gate (redaction + auto-bind)
 * to everything in the result; this layer only renders it for the transcript.
 */

import type { CellResult } from "../cell/cell-host.ts";
import { renderCellApiTypes, type SpawnableAgentInfo } from "./cell-api-types.ts";
import type { Primitive } from "./primitives.ts";
import type { PrimitiveResult } from "./types.ts";

/** The seam the primitive needs — CellHost, or a test double. */
export interface CellRunner {
	runCell(code: string): Promise<CellResult>;
}

const CELL_DESCRIPTION = `Run JavaScript in your cell worker with the ambient value API.

Namespace contract: only bind(name, value) persists — it stores the value in your scope under the name, and it survives across cells and resume. Plain JS locals die at cell end. Referencing an unknown value name errors, listing the names actually in scope.

To surface a value as the cell's result, end with a \`return\` statement.

Ambient API (all async — await them):
- bind(name, value): persist a value (strings as text, everything else as JSON). The only persistence.
- publish(name): mark a bound value for your result manifest.
- peek(name): cheap preview (type, size, excerpt) — use before reading.
- get(name): full content (budgeted at 1 MB; over-budget refuses — slice/grep instead).
- parse(name): get + JSON.parse, same budget.
- slice(name, start, end) / lines(name, from, to): 1-based inclusive line range.
- grep(name, pattern, {maxResults}): regex search, any size.
- size(name): content size in bytes.
- console.log/warn/error: captured into the cell's output.

Spawning (when delegation is available to you):
- spawn(agent, goal, {env, hints, blocking, shared}): blocking (default) resolves {ok, summary, bindings, handle} on child completion REGARDLESS of child success — check r.ok; it rejects (throws) only on spawn-infrastructure failure (unknown agent, denial, depth, transport). blocking: false resolves immediately to {handle}. At most 64 spawns per cell; fan out with Promise.all.
- handle(id): re-acquire a handle in a later cell. handle.id; await handle.wait() (no timeout cap); await handle.message(text, {env}).

No import/require (rejected before execution), no fs/fetch/process/Bun — pure JS plus the API above. Cells have a 5s compute budget; time awaiting the ambient API (including spawns) does not count.`;

/**
 * Compose the cell tool description: the prose contract plus the typed
 * declaration block for THIS agent's spawnable agents (spec §6). Stable per
 * allowlist so the tool description only changes when the allowlist does.
 */
function cellDescription(spawnableAgents: SpawnableAgentInfo[]): string {
	return `${CELL_DESCRIPTION}\n\nTyped surface (declaration only — the ambient API and the agents you can spawn):\n\n${renderCellApiTypes(spawnableAgents)}`;
}

export function buildCellPrimitive(
	cellRunner: CellRunner,
	spawnableAgents: SpawnableAgentInfo[] = [],
): Primitive {
	return {
		name: "cell",
		description: cellDescription(spawnableAgents),
		parameters: {
			type: "object",
			properties: {
				code: { type: "string", description: "JavaScript source to execute in the cell" },
			},
			required: ["code"],
		},
		async execute(args): Promise<PrimitiveResult> {
			const code = args.code as string;
			if (typeof code !== "string" || code.length === 0) {
				return { output: "", success: false, error: "cell requires non-empty string code" };
			}
			let result: CellResult;
			try {
				result = await cellRunner.runCell(code);
			} catch (err) {
				return {
					output: "",
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
			const parts: string[] = [];
			if (result.output.length > 0) parts.push(result.output.replace(/\n$/, ""));
			if (result.returnValue !== undefined) parts.push(`return: ${result.returnValue}`);
			for (const binding of result.newBindings) {
				parts.push(`bound: ⟦${binding.name}⟧ (${binding.size} bytes)`);
			}
			const rendered: PrimitiveResult = {
				output: parts.join("\n"),
				success: result.ok,
				metrics: result.metrics,
				stumbleCount: result.stumbleCount,
			};
			if (result.error?.infrastructure === true) rendered.infrastructure = true;
			if (result.newBindings.length > 0) {
				rendered.boundValues = result.newBindings.map(({ name, ulid, size }) => ({
					name,
					ulid,
					size,
				}));
			}
			if (!result.ok && result.error !== undefined) {
				rendered.error =
					result.error.scopeNames.length > 0
						? `${result.error.message}\nnames in scope: ${result.error.scopeNames.join(", ")}`
						: result.error.message;
			} else if (!result.ok) {
				rendered.error = "cell failed";
			}
			return rendered;
		},
	};
}
