/**
 * The node:vm cell engine (sap spec §4). Cell code runs inside a fresh context
 * created by `node:vm` — its `globalThis`, `Function`, `eval`, and constructor
 * chain all resolve to THAT context, so `Function("return process")()`,
 * `eval("Bun")`, and `({}).constructor.constructor("return globalThis")()` all
 * evaluate against the sandbox global, which has no Bun/process/require/fetch.
 * Shadowing globals as parameters (the old `new Function` realm) was cosmetic —
 * those escapes reached the host scope. A vm context is the real boundary.
 *
 * SECURITY POSTURE — THE node:vm CEILING (Phase 7, for operators and
 * reviewers): this realm is a confused-deputy bar, NOT a hard sandbox. What it
 * guarantees is that correctly-executing JS in the cell cannot reach host
 * capabilities: no Bun/process/require/fetch, no store credentials, no channel
 * token — every effect flows through the parent-mediated ambient API at cell
 * privilege. What it does NOT guarantee is containment of a determined
 * attacker who brings a V8/JSC engine exploit: the worker is a same-UID
 * process sharing the engine with its own host-side JS, and node:vm is
 * documented as not a security mechanism against hostile code with an engine
 * escape. In that scenario this boundary fails OPEN. The fails-closed design
 * is the QuickJS-WASM engine (quickjs-engine.ts), replacing this one at P3
 * cutover — tracked as GitHub issue prime-radiant-inc/sprout#1.
 */

import vm from "node:vm";
import { buildProgramsBootstrap, CELL_BOOTSTRAP, wrapCellCode } from "./cell-bootstrap.ts";
import type { CellEngine, CellEngineRequest, CellEngineResult } from "./cell-engine.ts";

export class VmCellEngine implements CellEngine {
	async runCell(request: CellEngineRequest): Promise<CellEngineResult> {
		try {
			const sandbox: Record<string, unknown> = {
				__hostCall__: (method: string, args: unknown[]) => request.callAmbient(method, args),
				__hostLog__: (args: unknown[]) => request.log(args),
				__hostTimers__: {
					setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
					setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
					clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
					clearInterval: (t: ReturnType<typeof setInterval>) => clearInterval(t),
				},
			};
			const context = vm.createContext(sandbox);
			vm.runInContext(CELL_BOOTSTRAP, context);
			if (request.programs !== undefined && request.programs.length > 0) {
				vm.runInContext(buildProgramsBootstrap(request.programs), context);
			}
			const value: unknown = await vm.runInContext(wrapCellCode(request.code), context);
			return { ok: true, value };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				infrastructure: request.isInfraError(err),
			};
		}
	}
}
