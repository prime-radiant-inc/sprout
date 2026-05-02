export const TASK_PAYLOAD_MAX_BYTES = 64 * 1024;
export const TASK_PAYLOAD_MAX_DEPTH = 8;

export type TaskPayload = Record<string, unknown>;

export interface TaskPayloadMetadata {
	present: true;
	bytes: number;
	key_count: number;
}

export interface NormalizedTaskPayload {
	value: TaskPayload;
	canonicalJson: string;
	metadata: TaskPayloadMetadata;
}

export function normalizeTaskPayload(raw: unknown, source: string): NormalizedTaskPayload {
	const canonical = canonicalizePayloadValue(raw, "payload", 1, new WeakSet<object>());
	if (!isPlainObject(canonical)) {
		throw new Error(`${source}: payload must be a plain object`);
	}
	const canonicalJson = JSON.stringify(canonical);
	const bytes = new TextEncoder().encode(canonicalJson).byteLength;
	if (bytes > TASK_PAYLOAD_MAX_BYTES) {
		throw new Error(`${source}: payload exceeds 64 KiB`);
	}
	return {
		value: canonical as TaskPayload,
		canonicalJson,
		metadata: {
			present: true,
			bytes,
			key_count: Object.keys(canonical).length,
		},
	};
}

export function formatDelegationGoal(input: {
	goal: string;
	hints?: string[];
	payload?: NormalizedTaskPayload;
}): string {
	const parts = [input.goal];
	if (input.hints && input.hints.length > 0) {
		parts.push(`Hints:\n${input.hints.map((hint) => `- ${hint}`).join("\n")}`);
	}
	if (input.payload) {
		parts.push(`<task_payload type="json">\n${input.payload.canonicalJson}\n</task_payload>`);
	}
	return parts.join("\n\n");
}

function canonicalizePayloadValue(
	raw: unknown,
	path: string,
	depth: number,
	seen: WeakSet<object>,
): unknown {
	if (depth > TASK_PAYLOAD_MAX_DEPTH) {
		throw new Error(`${path}: payload exceeds maximum depth of ${TASK_PAYLOAD_MAX_DEPTH}`);
	}
	if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
	if (typeof raw === "number") {
		if (!Number.isFinite(raw)) {
			throw new Error(`${path}: payload values must be finite numbers`);
		}
		return raw;
	}
	if (Array.isArray(raw)) {
		if (seen.has(raw)) throw new Error(`${path}: payload must not contain cycles`);
		seen.add(raw);
		const output = raw.map((item, index) =>
			canonicalizePayloadValue(item, `${path}[${index}]`, depth + 1, seen),
		);
		seen.delete(raw);
		return output;
	}
	if (!isPlainObject(raw)) {
		throw new Error(`${path}: payload values must be JSON-serializable`);
	}
	if (seen.has(raw)) throw new Error(`${path}: payload must not contain cycles`);
	seen.add(raw);

	const output: Record<string, unknown> = {};
	for (const key of Object.keys(raw).sort()) {
		const value = (raw as Record<string, unknown>)[key];
		if (value === undefined) {
			throw new Error(`${path}.${key}: payload values must not be undefined`);
		}
		output[key] = canonicalizePayloadValue(value, `${path}.${key}`, depth + 1, seen);
	}
	seen.delete(raw);
	return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
