/**
 * The QuickJS-WASM cell engine (QuickJS spec, 2026-07-20): the fails-closed
 * replacement for the node:vm realm. NOT BUILT YET — this stub exists so the
 * engine selector typechecks; P1 replaces it with the real engine.
 */

import type { CellEngine, CellEngineRequest, CellEngineResult } from "./cell-engine.ts";

export class QuickJSCellEngine implements CellEngine {
	async runCell(_request: CellEngineRequest): Promise<CellEngineResult> {
		throw new Error("QuickJS cell engine is not built yet (P1)");
	}
}
