/**
 * Genome programs — the fourth artifact (sap spec §7). A program is a named,
 * versioned skill written as JS that runs against the cell ambient API and is
 * exposed to code-mode agents as `programs.<name>(...)`. Programs are genome
 * content (evolvable by Learn), NOT kernel — but their bodies are model-written
 * code evaluated in the cell realm, so they pass the SAME lexical import/require
 * scan as cell source (spec §4), at genome validation AND at load.
 */

import { parse, stringify } from "yaml";
import { rejectImportRequire } from "../cell/cell-worker.ts";

/** A typed parameter a program body reads off its `args` object. */
export interface ProgramParam {
	name: string;
	type: string;
	description: string;
}

export interface Program {
	name: string;
	description: string;
	/** Typed params the body reads via `args.<name>`. */
	params: ProgramParam[];
	/** Agent names the body delegates to via spawn() — rendered for callers. */
	spawns: string[];
	version: number;
	/** Optional origin note (e.g. fabricated-from-pattern, repaired-from-stumble). */
	provenance?: string;
	/** JS body run against the cell ambient API. */
	body: string;
}

/** Program names follow the value-name charset so `programs.<name>` is a real key. */
const PROGRAM_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const PROGRAM_NAME_MAX_LENGTH = 64;

export type ValidateProgramResult = { ok: true } | { ok: false; reason: string };

/**
 * Parse a program from a YAML-fronted Markdown file, mirroring
 * parseAgentMarkdown: frontmatter provides structured fields, the markdown body
 * becomes the JS `body`.
 */
export function parseProgramMarkdown(source: string, filename: string): Program {
	const crlf = source.startsWith("---\r\n");
	const lf = source.startsWith("---\n");
	if (!lf && !crlf) {
		throw new Error(`Invalid program markdown at ${filename}: missing frontmatter delimiter`);
	}

	const fmStart = crlf ? 5 : 4;
	const endDelimiter = crlf ? "\r\n---\r\n" : "\n---\n";
	const actualEnd = source.indexOf(endDelimiter, fmStart);
	if (actualEnd === -1) {
		throw new Error(
			`Invalid program markdown at ${filename}: missing closing frontmatter delimiter`,
		);
	}

	const frontmatterStr = source.slice(fmStart, actualEnd);
	const bodyStart = actualEnd + endDelimiter.length;
	const body = source.slice(bodyStart).trim();

	const raw = parse(frontmatterStr) ?? {};

	for (const field of ["name", "description"] as const) {
		if (!raw[field] || typeof raw[field] !== "string") {
			throw new Error(`Invalid program markdown at ${filename}: missing or invalid '${field}'`);
		}
	}
	if (raw.params != null && !Array.isArray(raw.params)) {
		throw new Error(`Invalid program markdown at ${filename}: 'params' must be an array`);
	}
	if (raw.spawns != null && !Array.isArray(raw.spawns)) {
		throw new Error(`Invalid program markdown at ${filename}: 'spawns' must be an array`);
	}

	const params: ProgramParam[] = (raw.params ?? []).map((entry: unknown, index: number) =>
		normalizeParam(entry, filename, index),
	);

	const program: Program = {
		name: raw.name,
		description: raw.description,
		params,
		spawns: raw.spawns ?? [],
		version: raw.version ?? 1,
		body,
	};
	if (raw.provenance !== undefined) {
		program.provenance = String(raw.provenance);
	}
	return program;
}

function normalizeParam(raw: unknown, filename: string, index: number): ProgramParam {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`Invalid program markdown at ${filename}: params[${index}] must be an object`);
	}
	const param = raw as Record<string, unknown>;
	if (typeof param.name !== "string" || param.name.trim() === "") {
		throw new Error(
			`Invalid program markdown at ${filename}: params[${index}].name must be a non-empty string`,
		);
	}
	return {
		name: param.name,
		type: typeof param.type === "string" ? param.type : "unknown",
		description: typeof param.description === "string" ? param.description : "",
	};
}

/**
 * Validate a program against the sap §7 invariants: its body passes the SAME
 * lexical import/require scan as cell source (the one shared function, imported
 * from cell-worker), and its name is a valid `programs.<name>` key. A body
 * containing import/require — static, dynamic, or even inside a string — is
 * rejected (over-rejection is the specified v1 behavior, matching cells).
 */
export function validateProgram(program: Program): ValidateProgramResult {
	if (program.name.length === 0 || program.name.length > PROGRAM_NAME_MAX_LENGTH) {
		return {
			ok: false,
			reason: `program name must be 1..${PROGRAM_NAME_MAX_LENGTH} characters`,
		};
	}
	if (!PROGRAM_NAME_PATTERN.test(program.name)) {
		return {
			ok: false,
			reason: `program name '${program.name}' must use only [a-z0-9_] and must not start with a digit`,
		};
	}
	const rejection = rejectImportRequire(program.body);
	if (rejection !== undefined) {
		return { ok: false, reason: rejection };
	}
	return { ok: true };
}

/** Serialize a Program back to YAML-fronted Markdown for staging/sync. */
export function serializeProgramMarkdown(program: Program): string {
	const fm: Record<string, unknown> = {
		name: program.name,
		description: program.description,
		params: program.params,
		spawns: program.spawns,
		version: program.version,
	};
	if (program.provenance !== undefined) {
		fm.provenance = program.provenance;
	}
	return `---\n${stringify(fm)}---\n${program.body}\n`;
}
