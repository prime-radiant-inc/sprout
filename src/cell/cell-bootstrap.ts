/**
 * Realm bootstrap source shared by every cell engine (sap spec §4). The
 * bootstrap runs BEFORE cell code, inside the realm, and installs the entire
 * cell-visible surface from source over three host bridges passed via the
 * realm global: __hostCall__ (proxy an ambient op), __hostLog__ (append console
 * output), and __hostTimers__ (schedule/cancel). All three are captured in a
 * bootstrap closure and then deleted from the realm global, so cell code cannot
 * reach the raw host functions to walk their constructor chain. Ambient results
 * are JSON-severed inside the realm (host promises/objects never leak their
 * prototype to the cell), and timer ids are opaque realm integers mapping to
 * host timer tokens held in the closure.
 *
 * The realm exposes ONLY the ambient API, console, timers, and a realm-native
 * structuredClone. The standard JS intrinsics (Object, Array, JSON, Math,
 * Promise, Map, Set, Date, RegExp, Error, ...) already exist in the fresh
 * realm's global — we do NOT copy host ones in (that would re-introduce the
 * host constructor chain, the whole bug). A fresh realm omits structuredClone,
 * TextEncoder/Decoder, and timers, so those we add: timers as sealed wrappers
 * over the host's (see below), structuredClone as pure realm-source JS.
 * TextEncoder/Decoder are NOT provided — no cell path needs raw byte encoding
 * (get() yields strings), and a sealed reimplementation would be dead weight.
 */

/**
 * A genome program made available to the cell realm (spec §7): its name and JS
 * body. The engine builds `programs.<name>(args)` from these in the realm
 * bootstrap — the body runs in the SAME realm with the SAME ambient API as
 * cell code, no host constructor leak.
 */
export type WorkerProgram = { name: string; body: string };

/** Ambient API methods proxied to the parent (value ops, spawn, handles). */
const AMBIENT_METHODS = [
	"bind",
	"publish",
	"peek",
	"slice",
	"lines",
	"grep",
	"parse",
	"size",
	"get",
] as const;

function buildCellBootstrap(): string {
	const ambientList = JSON.stringify([...AMBIENT_METHODS]);
	return `
"use strict";
(function (hostCall, hostLog, hostTimers) {
	const AMBIENT = ${ambientList};
	const sever = (r) => (r === undefined ? undefined : JSON.parse(JSON.stringify(r)));
	const callAmbient = async (method, args) => sever(await hostCall(method, args));
	for (const method of AMBIENT) {
		globalThis[method] = (...args) => callAmbient(method, args);
	}
	const mkLog = () => (...args) => { hostLog(args); };
	globalThis.console = { log: mkLog(), warn: mkLog(), error: mkLog() };

	function wrapOutcome(wire) {
		const handle = makeHandle(wire.handleId);
		if (wire.kind === "started") return { handle };
		return { ok: wire.ok, summary: wire.summary, bindings: wire.bindings, handle };
	}
	function makeHandle(hid) {
		return {
			id: hid,
			wait: async () => wrapOutcome(await callAmbient("handle_wait", [hid])),
			message: async (text, opts) => wrapOutcome(await callAmbient("handle_message", [hid, text, opts])),
			future: async (name) => callAmbient("handle_future", [hid, name]),
		};
	}
	globalThis.spawn = async (agent, goal, opts) => wrapOutcome(await callAmbient("spawn", [agent, goal, opts]));
	globalThis.handle = (hid) => {
		if (typeof hid !== "string") throw new Error("handle(id): id must be a string");
		return makeHandle(hid);
	};

	let timerSeq = 0;
	const liveTimers = new Map();
	globalThis.setTimeout = (fn, ms, ...a) => {
		const key = ++timerSeq;
		const t = hostTimers.setTimeout(() => { liveTimers.delete(key); fn(...a); }, ms);
		liveTimers.set(key, t);
		return key;
	};
	globalThis.setInterval = (fn, ms, ...a) => {
		const key = ++timerSeq;
		const t = hostTimers.setInterval(() => fn(...a), ms);
		liveTimers.set(key, t);
		return key;
	};
	globalThis.clearTimeout = (key) => {
		const t = liveTimers.get(key);
		if (t !== undefined) { hostTimers.clearTimeout(t); liveTimers.delete(key); }
	};
	globalThis.clearInterval = (key) => {
		const t = liveTimers.get(key);
		if (t !== undefined) { hostTimers.clearInterval(t); liveTimers.delete(key); }
	};

	globalThis.structuredClone = function structuredClone(value, seen) {
		if (value === null || typeof value !== "object") return value;
		seen = seen || new WeakMap();
		if (seen.has(value)) return seen.get(value);
		if (value instanceof Date) return new Date(value.getTime());
		if (value instanceof RegExp) return new RegExp(value.source, value.flags);
		if (Array.isArray(value)) {
			const out = [];
			seen.set(value, out);
			for (let i = 0; i < value.length; i++) out[i] = structuredClone(value[i], seen);
			return out;
		}
		if (value instanceof Map) {
			const out = new Map();
			seen.set(value, out);
			for (const [k, v] of value) out.set(structuredClone(k, seen), structuredClone(v, seen));
			return out;
		}
		if (value instanceof Set) {
			const out = new Set();
			seen.set(value, out);
			for (const v of value) out.add(structuredClone(v, seen));
			return out;
		}
		const out = {};
		seen.set(value, out);
		for (const k of Object.keys(value)) out[k] = structuredClone(value[k], seen);
		return out;
	};
})(__hostCall__, __hostLog__, __hostTimers__);
delete globalThis.__hostCall__;
delete globalThis.__hostLog__;
delete globalThis.__hostTimers__;
`;
}

export const CELL_BOOTSTRAP = buildCellBootstrap();

/**
 * Build the `programs` namespace bootstrap (spec §7). Runs in-realm AFTER the
 * ambient bootstrap: each program becomes `programs.<name> = async (args) =>
 * { <body> }`, so the body reads its typed params off `args` and reaches the
 * value/spawn API through the same realm globals cell code uses. Program
 * names are validated [a-z0-9_] at the genome gate, so the key interpolation is
 * a real identifier-charset string.
 *
 * Program bodies are injected verbatim, trusting the lexical import/require scan
 * already run at genome validation AND load (validateProgram). The `programs`
 * field is parent/CellHost-supplied, never model-supplied, so there is no
 * model-reachable path to inject an unscanned body here. Bodies run in the same
 * confined realm as the cell, at exactly cell privilege.
 */
export function buildProgramsBootstrap(programs: WorkerProgram[]): string {
	const assignments = programs
		.map(
			(program) =>
				`\tprograms[${JSON.stringify(program.name)}] = async (args = {}) => {\n${program.body}\n\t};`,
		)
		.join("\n");
	return `"use strict";
(function () {
	const programs = {};
${assignments}
	globalThis.programs = programs;
})();
`;
}

/** The cell wrapper: an async IIFE so top-level await works; the cell's value
 * is its `return` statement — a documented simplification (a true
 * completion-value REPL needs eval, which the realm bans). */
export function wrapCellCode(code: string): string {
	return `"use strict";\n(async () => {\n${code}\n})();`;
}
