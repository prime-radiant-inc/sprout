/**
 * The engine seam (QuickJS spec, 2026-07-20): a cell engine owns ONE thing —
 * executing already-gated cell code inside an isolated realm wired to the
 * worker's ambient bridges. Everything else in the worker (line protocol,
 * ambient correlation, infra-error bookkeeping, console formatting, return
 * serialization, the lexical gate) is engine-agnostic and lives outside.
 *
 * TEMPORARY SCAFFOLD: the vm/quickjs selector exists only for the P1–P2
 * dual-engine build window. At P3 cutover the selector and the node:vm engine
 * are deleted together (spec: no dual-engine ship, no compatibility flag).
 */

import type { WorkerProgram } from "./cell-bootstrap.ts";

export type CellEngineResult =
	| { ok: true; returnValue: string | undefined }
	| { ok: false; error: string; infrastructure: boolean };

/**
 * Serialize a cell's final value for the result line. Strings pass verbatim;
 * everything else goes through JSON (String() as the honest fallback);
 * undefined stays absent — "no return statement" and "return undefined" look
 * the same, which the tool description documents.
 *
 * Serialization is the ENGINE's job (not the worker's): only the engine can
 * see the live realm value with its type intact — once a Date has crossed the
 * wasm boundary it is already a string, and re-serializing host-side would
 * quote it differently than the vm realm did. The vm engine applies this
 * function to the live value; the QuickJS engine runs the same algorithm
 * in-context (MARSHAL_DISPLAY) and ships the resulting bytes.
 */
export function serializeReturnValue(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return json;
	} catch {
		// fall through
	}
	return String(value);
}

/**
 * Hard caps a cell runs under (P2). Enforced in-realm by the QuickJS engine
 * (allocation-fail memory cap, interrupt-driven deadline); the vm engine
 * cannot enforce them and relies on the parent's kill paths, which remain the
 * outer net either way.
 */
export type CellLimits = {
	/** Byte-precise allocation cap for the realm. */
	memoryBytes?: number;
	/** Compute-time deadline; parked ambient time never accrues. */
	budgetMs?: number;
};

export interface CellEngineRequest {
	/** Cell source, already past the lexical import/require gate. */
	code: string;
	/** Genome programs to install as `programs.<name>` in the realm. */
	programs?: WorkerProgram[];
	/** Hard caps; absent means uncapped (tests, trusted callers). */
	limits?: CellLimits;
	/** Proxy one ambient op to the parent; rejects with the worker's Error. */
	callAmbient(method: string, args: unknown[]): Promise<unknown>;
	/** True when the given rejection IS a host infrastructure error (identity). */
	isInfraError(err: unknown): boolean;
	/** Append one console call's args to the cell's output buffer. */
	log(args: unknown[]): void;
}

export interface CellEngine {
	runCell(request: CellEngineRequest): Promise<CellEngineResult>;
}

/** Env knob selecting the engine during the migration window. */
export const CELL_ENGINE_ENV = "SPROUT_CELL_ENGINE";

export type CellEngineName = "vm" | "quickjs";

export function resolveCellEngineName(
	env: Record<string, string | undefined> = process.env,
): CellEngineName {
	const name = env[CELL_ENGINE_ENV] ?? "vm";
	if (name !== "vm" && name !== "quickjs") {
		throw new Error(`${CELL_ENGINE_ENV} must be "vm" or "quickjs", got "${name}"`);
	}
	return name;
}

/**
 * Instantiate an engine by name. Dynamic imports on both arms: the QuickJS
 * singlefile module embeds the wasm as base64 (~3 MB of JS) and must not load
 * into vm-engine workers; keeping both arms dynamic also keeps this module
 * import-cycle-free.
 */
export async function createCellEngine(name: CellEngineName): Promise<CellEngine> {
	if (name === "quickjs") {
		const { QuickJSCellEngine } = await import("./quickjs-engine.ts");
		return new QuickJSCellEngine();
	}
	const { VmCellEngine } = await import("./vm-engine.ts");
	return new VmCellEngine();
}
