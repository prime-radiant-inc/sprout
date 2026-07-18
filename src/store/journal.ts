/**
 * Append-only JSONL session journal (sap store durability, spec §1).
 *
 * Each record is one JSON line. Multi-record appends land in a single write so
 * that a manifest-delivery record and its recipient's binds are durable
 * atomically. Replay is metadata-level: bodies stay as written (inline string
 * or CAS ref) — lazy body loading from CAS is the store engine's job.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ValueOrigin, ValueProvenance, ValueType } from "./value.ts";

/** Inline bodies are only legal under this size; larger values go to CAS. */
export const INLINE_BODY_LIMIT = 64 * 1024;

/** Value body as journaled: inline text (utf8/base64) or a hex sha256 CAS ref. */
export type JournalBody = { inline: string } | { cas: string };

export interface BindRecord {
	kind: "bind";
	ulid: string;
	name: string;
	scope: string;
	type: ValueType;
	size: number;
	provenance: ValueProvenance;
	preview: string;
	/** Model-named bind vs provenance-derived auto-bind — collision rules key on this. */
	explicit: boolean;
	/** Bind timestamp (ms since epoch). */
	createdAt: number;
	body: JournalBody;
}

/** Scope created at delegation. */
export interface ScopeRecord {
	kind: "scope";
	scopeId: string;
	ownerHandleId: string;
	parentScopeId: string;
}

export interface PublishRecord {
	kind: "publish";
	handle: string;
	ulids: string[];
	seq: number;
}

/**
 * Manifest-delivery cursor: written atomically with the recipient's manifest
 * binds so the cursor advances exactly when delivery is durable.
 */
export interface ManifestDeliveryRecord {
	kind: "manifest_delivery";
	handle: string;
	recipient: string;
	throughPublishSeq: number;
}

export interface GrantRecord {
	kind: "grant";
	granter: string;
	recipient: string;
	name: string;
	ulid: string;
}

export interface CellRecord {
	kind: "cell";
	handle: string;
	code: string;
	bindings: { name: string; ulid: string }[];
	error?: string;
	computeTimeMs: number;
}

export type JournalRecord =
	| BindRecord
	| ScopeRecord
	| PublishRecord
	| ManifestDeliveryRecord
	| GrantRecord
	| CellRecord;

export class SessionJournal {
	private dirReady = false;

	constructor(private readonly path: string) {}

	/**
	 * Append one record or several as one JSON line each. An array is
	 * concatenated into a single write() so the records are durable atomically
	 * — the manifest-delivery guarantee depends on this.
	 */
	async append(record: JournalRecord | JournalRecord[]): Promise<void> {
		const records = Array.isArray(record) ? record : [record];
		if (records.length === 0) return;
		if (!this.dirReady) {
			await mkdir(dirname(this.path), { recursive: true });
			this.dirReady = true;
		}
		const lines = records.map((r) => `${JSON.stringify(r)}\n`).join("");
		await appendFile(this.path, lines, "utf8");
	}

	/**
	 * Read the journal back. A trailing partial line (crash mid-append) is
	 * skipped silently; a bad line followed by valid lines means corruption and
	 * throws with the line number. A missing file replays to no records.
	 */
	async replay(): Promise<JournalRecord[]> {
		let content: string;
		try {
			content = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const lines = content.split("\n");
		// A well-formed journal ends with a newline, so the final split element
		// is empty; anything else there is a torn tail from a crashed append.
		const complete = lines.slice(0, -1);
		const records: JournalRecord[] = [];
		let badLine: { line: number; message: string } | undefined;
		for (let i = 0; i < complete.length; i++) {
			let record: JournalRecord;
			try {
				record = parseJournalRecord(JSON.parse(complete[i] as string));
			} catch (error) {
				// Tolerate this only if nothing valid follows (torn tail with a
				// stray newline after it would still be corruption, so remember
				// it and throw if any later line parses).
				if (badLine) {
					throw new Error(`journal corrupt at line ${badLine.line}: ${badLine.message}`);
				}
				badLine = { line: i + 1, message: (error as Error).message };
				continue;
			}
			if (badLine) {
				throw new Error(`journal corrupt at line ${badLine.line}: ${badLine.message}`);
			}
			records.push(record);
		}
		return records;
	}
}

/**
 * Narrow untrusted parsed JSON to a {@link JournalRecord}, throwing a
 * field-named error on any mismatch. Producing a typed value honestly requires
 * checking each field rather than casting an `unknown` body.
 */
export function parseJournalRecord(value: unknown): JournalRecord {
	if (typeof value !== "object" || value === null) {
		throw new Error("journal record must be an object");
	}
	const fields = value as Record<string, unknown>;
	switch (fields.kind) {
		case "bind":
			return parseBind(fields);
		case "scope":
			return {
				kind: "scope",
				scopeId: str(fields.scopeId, "scopeId"),
				ownerHandleId: str(fields.ownerHandleId, "ownerHandleId"),
				parentScopeId: str(fields.parentScopeId, "parentScopeId"),
			};
		case "publish":
			return {
				kind: "publish",
				handle: str(fields.handle, "handle"),
				ulids: strArray(fields, "ulids"),
				seq: num(fields, "seq"),
			};
		case "manifest_delivery":
			return {
				kind: "manifest_delivery",
				handle: str(fields.handle, "handle"),
				recipient: str(fields.recipient, "recipient"),
				throughPublishSeq: num(fields, "throughPublishSeq"),
			};
		case "grant":
			return {
				kind: "grant",
				granter: str(fields.granter, "granter"),
				recipient: str(fields.recipient, "recipient"),
				name: str(fields.name, "name"),
				ulid: str(fields.ulid, "ulid"),
			};
		case "cell":
			return parseCell(fields);
		default:
			throw new Error(
				`journal record kind must be a known kind, got ${JSON.stringify(fields.kind)}`,
			);
	}
}

function parseBind(fields: Record<string, unknown>): BindRecord {
	const type = str(fields.type, "type");
	if (type !== "text" && type !== "json" && type !== "bytes") {
		throw new Error(`bind type must be text, json, or bytes, got ${JSON.stringify(type)}`);
	}
	const size = num(fields, "size");
	const body = parseBody(fields.body, size);
	return {
		kind: "bind",
		ulid: str(fields.ulid, "ulid"),
		name: str(fields.name, "name"),
		scope: str(fields.scope, "scope"),
		type,
		size,
		provenance: parseProvenance(fields.provenance),
		preview: str(fields.preview, "preview"),
		explicit: bool(fields.explicit, "explicit"),
		createdAt: num(fields, "createdAt"),
		body,
	};
}

function parseBody(value: unknown, size: number): JournalBody {
	if (typeof value !== "object" || value === null) {
		throw new Error("body must be an object");
	}
	const body = value as Record<string, unknown>;
	const hasInline = body.inline !== undefined;
	const hasCas = body.cas !== undefined;
	if (hasInline === hasCas) {
		throw new Error("body must have exactly one of inline or cas");
	}
	if (hasInline) {
		if (typeof body.inline !== "string") throw new Error("body.inline must be a string");
		if (size >= INLINE_BODY_LIMIT) {
			throw new Error(`inline body requires size under ${INLINE_BODY_LIMIT}, got ${size}`);
		}
		return { inline: body.inline };
	}
	if (typeof body.cas !== "string" || !/^[0-9a-f]{64}$/.test(body.cas)) {
		throw new Error("body.cas must be a hex sha256 string");
	}
	return { cas: body.cas };
}

function parseProvenance(value: unknown): ValueProvenance {
	if (typeof value !== "object" || value === null) {
		throw new Error("provenance must be an object");
	}
	const fields = value as Record<string, unknown>;
	return {
		agentHandleId: str(fields.agentHandleId, "provenance.agentHandleId"),
		origin: parseOrigin(fields.origin),
	};
}

function parseOrigin(value: unknown): ValueOrigin {
	if (typeof value !== "object" || value === null) {
		throw new Error("provenance.origin must be an object");
	}
	const fields = value as Record<string, unknown>;
	if (fields.kind === "cell") return { kind: "cell" };
	if (fields.kind === "delegation") return { kind: "delegation" };
	if (fields.kind === "primitive") {
		const origin: ValueOrigin = {
			kind: "primitive",
			name: str(fields.name, "provenance.origin.name"),
		};
		if (fields.argsSummary !== undefined) {
			origin.argsSummary = str(fields.argsSummary, "provenance.origin.argsSummary");
		}
		return origin;
	}
	throw new Error(
		`provenance.origin.kind must be cell, delegation, or primitive, got ${JSON.stringify(fields.kind)}`,
	);
}

function parseCell(fields: Record<string, unknown>): CellRecord {
	const rawBindings = fields.bindings;
	if (!Array.isArray(rawBindings)) {
		throw new Error("cell bindings must be an array");
	}
	const bindings = rawBindings.map((entry, i) => {
		if (typeof entry !== "object" || entry === null) {
			throw new Error(`cell bindings[${i}] must be an object`);
		}
		const binding = entry as Record<string, unknown>;
		return {
			name: str(binding.name, `bindings[${i}].name`),
			ulid: str(binding.ulid, `bindings[${i}].ulid`),
		};
	});
	const record: CellRecord = {
		kind: "cell",
		handle: str(fields.handle, "handle"),
		code: str(fields.code, "code"),
		bindings,
		computeTimeMs: num(fields, "computeTimeMs"),
	};
	if (fields.error !== undefined) {
		record.error = str(fields.error, "error");
	}
	return record;
}

/** Narrow a value to boolean, naming the field in the error. */
function bool(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${name} must be a boolean`);
	}
	return value;
}

/** Narrow a value to string, naming the field in the error. */
function str(value: unknown, name: string): string {
	if (typeof value !== "string") {
		throw new Error(`${name} must be a string`);
	}
	return value;
}

/** Narrow a field to a finite number, naming the field in the error. */
function num(fields: Record<string, unknown>, name: string): number {
	const v = fields[name];
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new Error(`${name} must be a number`);
	}
	return v;
}

/** Narrow a field to string[], naming the field in the error. */
function strArray(fields: Record<string, unknown>, name: string): string[] {
	const v = fields[name];
	if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
		throw new Error(`${name} must be an array of strings`);
	}
	return v as string[];
}
