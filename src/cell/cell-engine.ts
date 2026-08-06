/**
 * The engine seam (QuickJS spec, 2026-07-20): a cell engine owns ONE thing —
 * executing already-gated cell code inside an isolated realm wired to the
 * worker's ambient bridges. Everything else in the worker (line protocol,
 * ambient correlation, infra-error bookkeeping, console formatting, the
 * lexical gate) is engine-agnostic and lives outside. The QuickJS-WASM engine
 * is the only engine (the node:vm engine and its selector were removed at the
 * P3 cutover); a cell's final value is serialized in-realm (MARSHAL_DISPLAY).
 */

import type { WorkerProgram } from "./cell-bootstrap.ts";

export type CellEngineResult =
	| { ok: true; returnValue: string | undefined }
	| { ok: false; error: string; infrastructure: boolean };

/**
 * Hard caps a cell runs under (P2), enforced in-realm by the QuickJS engine:
 * an allocation-fail memory cap and an interrupt-driven deadline. The parent's
 * kill paths remain the outer net.
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

/**
 * Instantiate the cell engine. The dynamic import keeps the QuickJS singlefile
 * module (which embeds the wasm as ~3 MB of base64 JS) out of this module's
 * import graph until a worker actually needs it, and keeps this module
 * import-cycle-free.
 */
export async function createCellEngine(): Promise<CellEngine> {
	const { QuickJSCellEngine } = await import("./quickjs-engine.ts");
	return new QuickJSCellEngine();
}
