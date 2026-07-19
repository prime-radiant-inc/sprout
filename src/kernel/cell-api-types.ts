/**
 * Typed surface for the cell ambient API (sap spec §6, "types not bare
 * functions" review add). The cell tool's description carries a `.d.ts`-style
 * declaration of the ambient API AND the caller's spawnable agents, because
 * TYPES — not bare signatures — are what make model-written cells reliable
 * (Cloudflare evidence). The SpawnableAgent union is generated from the caller's
 * allowlist so it stays honest: it never names an agent the cell can't spawn.
 *
 * Signatures MUST mirror the worker/host ground truth (cell-worker.ts +
 * cell-host.ts). This is a pure rendering concern — no behavior change.
 */

export interface SpawnableAgentInfo {
	name: string;
	description: string;
}

/** A genome program surfaced to a code-mode caller (spec §7). */
export interface ProgramInfo {
	name: string;
	description: string;
	params: { name: string; type: string; description: string }[];
	/** Agent names the body delegates to — shown so callers see compatibility. */
	spawns: string[];
}

/** Fixed declaration of the ambient value + spawn API (worker-exact). */
const AMBIENT_DECLARATIONS = `interface BoundValue { name: string; ulid: string; size: number; preview: string; type: "text" | "json" | "bytes" }
interface GrepMatch { line: number; text: string }
interface GrepResult { matches: GrepMatch[]; truncated: boolean }

// Value API — all calls are async; await them. Only bind() persists.
declare function bind(name: string, value: unknown): Promise<BoundValue>;
declare function publish(name: string): Promise<void>;
declare function peek(name: string): Promise<string>;
declare function get(name: string): Promise<string>;
declare function parse(name: string): Promise<unknown>;
declare function slice(name: string, start: number, end: number): Promise<string>;
declare function lines(name: string, from: number, to: number): Promise<string>;
declare function grep(name: string, pattern: string, opts?: { maxResults?: number }): Promise<GrepResult>;
declare function size(name: string): Promise<number>;
declare const console: {
	log(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
};`;

/** Fixed declaration of the spawn/handle surface (references SpawnableAgent). */
const SPAWN_DECLARATIONS = `interface SpawnOptions { env?: Record<string, string>; hints?: string[]; blocking?: boolean; shared?: boolean; model?: string }
interface SpawnResult { ok: boolean; summary: string; bindings: BoundValue[]; handle: Handle }
interface Handle {
	id: string;
	wait(): Promise<SpawnResult>;
	message(text: string, opts?: { env?: Record<string, string>; blocking?: boolean }): Promise<SpawnResult>;
}
declare function spawn(agent: SpawnableAgent, goal: string, opts?: SpawnOptions): Promise<SpawnResult>;
declare function handle(id: string): Handle;`;

/** Collapse a description into a single-line `/** ... *\/` doc comment. */
function docComment(description: string): string {
	const oneLine = description.replace(/\s+/g, " ").trim();
	return `/** ${oneLine} */`;
}

/**
 * Render the SpawnableAgent union from the allowlist. Empty → `never` (no agent
 * is spawnable), which keeps `spawn()`'s first argument uncallable honestly.
 */
function renderSpawnableAgentUnion(agents: SpawnableAgentInfo[]): string {
	if (agents.length === 0) {
		return "type SpawnableAgent = never;";
	}
	const members = agents
		.map((agent) => `\t${docComment(agent.description)}\n\t| ${JSON.stringify(agent.name)}`)
		.join("\n");
	return `type SpawnableAgent =\n${members};`;
}

/**
 * Render the `<programs>` block (spec §7): the genome programs this caller can
 * invoke as `programs.<name>(args)`, each with its typed params and declared
 * `spawns`. The spawns render so the caller sees compatibility; runtime
 * enforcement stays the caller's delegation allowlist, NOT the declared spawns.
 * Returns "" when the caller has no programs (block omitted entirely).
 */
export function renderProgramsBlock(programs: ProgramInfo[]): string {
	if (programs.length === 0) return "";
	const members = programs
		.map((program) => {
			const args = program.params
				.map((param) => `${param.name}: ${param.type} /* ${param.description} */`)
				.join("; ");
			const spawns = program.spawns.length > 0 ? ` — spawns: ${program.spawns.join(", ")}` : "";
			return [
				`\t${docComment(`${program.description}${spawns}`)}`,
				`\t${program.name}(args: { ${args} }): Promise<unknown>;`,
			].join("\n");
		})
		.join("\n");
	return [
		"<programs>",
		"Genome programs available as `programs.<name>(args)` — the same ambient API runs their bodies.",
		"```ts",
		"declare const programs: {",
		members,
		"};",
		"```",
		"</programs>",
	].join("\n");
}

/**
 * Render the `.d.ts`-style ambient-API declaration block the model reads to
 * write cells. Pure: same allowlist → same string (cache-friendly).
 */
export function renderCellApiTypes(spawnableAgents: SpawnableAgentInfo[]): string {
	return [
		"```ts",
		"// Ambient API available inside a cell (sap data plane). Declaration only — do not redeclare.",
		AMBIENT_DECLARATIONS,
		"",
		"// Delegation — spawn a subagent by name; the union lists exactly what you can spawn.",
		renderSpawnableAgentUnion(spawnableAgents),
		SPAWN_DECLARATIONS,
		"```",
	].join("\n");
}
