/**
 * Host-side store handlers for the authenticated channel (sap spec §1
 * Transport, §3 scope-per-delegation). The keystone, mirroring the handle
 * registrar: the caller's scope comes from the verified connection — a
 * caller's scope id IS its handle id — never from the payload. Payloads carry
 * no scope and no identity fields; any such field a crafted payload smuggles
 * in is ignored, and `provenance.agentHandleId` on bind is forced to the
 * connection's handle.
 */

import {
	STORE_BIND_REQUEST,
	STORE_GET_REQUEST,
	STORE_GREP_REQUEST,
	STORE_MANIFEST_REQUEST,
	STORE_METADATA_REQUEST,
	STORE_NAMES_REQUEST,
	STORE_PEEK_REQUEST,
	STORE_PUBLISH_REQUEST,
	STORE_SLICE_REQUEST,
} from "../store/store-access.ts";
import type { StoreWorkerClient } from "../store/store-client.ts";
import { decodeWireContent, type WireEncoding } from "../store/store-worker.ts";
import type { ValueOrigin, ValueType } from "../store/value.ts";
import type { AuthChannelServer } from "./auth-channel.ts";

export interface RegisterStoreHandlersOptions {
	/** Parent scope under which per-caller scopes are created. */
	rootScopeId: string;
}

/**
 * Register the store-op handlers on the authenticated channel. Each caller's
 * scope is created lazily on first use as a child of the root scope; "already
 * exists" from the store is fine — a restarted host may race its own memory
 * against the journal it already wrote.
 */
export function registerStoreHandlers(
	authServer: AuthChannelServer,
	storeClient: StoreWorkerClient,
	options: RegisterStoreHandlersOptions,
): void {
	const createdScopes = new Set<string>();

	async function ensureScope(handleId: string): Promise<string> {
		if (!createdScopes.has(handleId)) {
			try {
				await storeClient.createScope({
					scopeId: handleId,
					ownerHandleId: handleId,
					parentScopeId: options.rootScopeId,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("scope already exists")) throw error;
			}
			createdScopes.add(handleId);
		}
		return handleId;
	}

	authServer.onRequest(STORE_BIND_REQUEST, async (ctx, payload) => {
		const input = parseBindPayload(payload);
		const scopeId = await ensureScope(ctx.handleId);
		const metadata = await storeClient.bind({
			scopeId,
			name: input.name,
			content: decodeWireContent(input.content, input.encoding),
			type: input.type,
			// Identity is the connection's, never the payload's.
			provenance: { agentHandleId: ctx.handleId, origin: input.origin },
			explicit: input.explicit,
		});
		return metadata;
	});

	authServer.onRequest(STORE_PEEK_REQUEST, async (ctx, payload) => {
		const ref = parseRef(payload, STORE_PEEK_REQUEST);
		return storeClient.peek(await ensureScope(ctx.handleId), ref);
	});

	authServer.onRequest(STORE_METADATA_REQUEST, async (ctx, payload) => {
		const ref = parseRef(payload, STORE_METADATA_REQUEST);
		return storeClient.metadata(await ensureScope(ctx.handleId), ref);
	});

	authServer.onRequest(STORE_GET_REQUEST, async (ctx, payload) => {
		const fields = parseObjectPayload(payload, STORE_GET_REQUEST);
		const ref = parseRef(payload, STORE_GET_REQUEST);
		const maxBytes = int(fields, "maxBytes", { min: 0 }, STORE_GET_REQUEST);
		// One worker round-trip: the worker's get op already returns the wire
		// body with the value's own encoding — no separate metadata op.
		return storeClient.getWire(await ensureScope(ctx.handleId), ref, { maxBytes });
	});

	authServer.onRequest(STORE_SLICE_REQUEST, async (ctx, payload) => {
		const fields = parseObjectPayload(payload, STORE_SLICE_REQUEST);
		const ref = parseRef(payload, STORE_SLICE_REQUEST);
		return storeClient.slice(await ensureScope(ctx.handleId), ref, {
			startLine: int(fields, "startLine", { min: 1 }, STORE_SLICE_REQUEST),
			lineCount: int(fields, "lineCount", { min: 1 }, STORE_SLICE_REQUEST),
		});
	});

	authServer.onRequest(STORE_GREP_REQUEST, async (ctx, payload) => {
		const fields = parseObjectPayload(payload, STORE_GREP_REQUEST);
		const ref = parseRef(payload, STORE_GREP_REQUEST);
		if (typeof fields.pattern !== "string") {
			throw new Error(`${STORE_GREP_REQUEST}: pattern must be a string`);
		}
		const maxResults =
			fields.maxResults !== undefined
				? int(fields, "maxResults", { min: 1 }, STORE_GREP_REQUEST)
				: undefined;
		return storeClient.grep(await ensureScope(ctx.handleId), ref, fields.pattern, {
			...(maxResults !== undefined ? { maxResults } : {}),
		});
	});

	authServer.onRequest(STORE_PUBLISH_REQUEST, async (ctx, payload) => {
		const ref = parseRef(payload, STORE_PUBLISH_REQUEST);
		// The publisher identity is the connection's: a caller can only publish
		// from its own scope, and the record's handle IS that scope id.
		await storeClient.publish(await ensureScope(ctx.handleId), ref);
		return null;
	});

	authServer.onRequest(STORE_MANIFEST_REQUEST, async (ctx, payload) => {
		const fields = parseObjectPayload(payload, STORE_MANIFEST_REQUEST);
		if (typeof fields.publisherHandle !== "string") {
			throw new Error(`${STORE_MANIFEST_REQUEST}: publisherHandle must be a string`);
		}
		// The recipient is the connection's verified scope — any recipient/scope
		// field a crafted payload smuggles in is ignored.
		return storeClient.deliverManifest(await ensureScope(ctx.handleId), fields.publisherHandle);
	});

	authServer.onRequest(STORE_NAMES_REQUEST, async (ctx) => {
		// No payload: the only scope a caller can list is its own.
		return storeClient.names(await ensureScope(ctx.handleId));
	});
}

/**
 * Narrow an untrusted numeric field to a safe integer >= min. Rejects
 * Infinity, NaN, floats, and negatives — a crafted number must never reach the
 * engine's arithmetic.
 */
function int(
	fields: Record<string, unknown>,
	name: string,
	opts: { min: number },
	request: string,
): number {
	const value = fields[name];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < opts.min) {
		throw new Error(`${request}: ${name} must be an integer >= ${opts.min}`);
	}
	return value;
}

interface BindPayload {
	name: string;
	content: string;
	encoding: WireEncoding;
	type: ValueType;
	origin: ValueOrigin;
	explicit: boolean;
}

/**
 * Narrow an untrusted bind payload field-by-field. Deliberately extracts only
 * the origin from any provenance the payload carries — the producing identity
 * is always the connection's.
 */
function parseBindPayload(payload: unknown): BindPayload {
	const fields = parseObjectPayload(payload, STORE_BIND_REQUEST);
	const { name, content, encoding, type, explicit } = fields;
	if (typeof name !== "string") {
		throw new Error(`${STORE_BIND_REQUEST}: name must be a string`);
	}
	if (typeof content !== "string") {
		throw new Error(`${STORE_BIND_REQUEST}: content must be a string`);
	}
	if (encoding !== "utf8" && encoding !== "base64") {
		throw new Error(`${STORE_BIND_REQUEST}: encoding must be "utf8" or "base64"`);
	}
	if (type !== "text" && type !== "json" && type !== "bytes") {
		throw new Error(`${STORE_BIND_REQUEST}: type must be "text", "json", or "bytes"`);
	}
	if (typeof explicit !== "boolean") {
		throw new Error(`${STORE_BIND_REQUEST}: explicit must be a boolean`);
	}
	const provenance =
		typeof fields.provenance === "object" && fields.provenance !== null
			? (fields.provenance as Record<string, unknown>)
			: {};
	return { name, content, encoding, type, explicit, origin: parseOrigin(provenance.origin) };
}

/** Narrow an untrusted value origin; anything malformed defaults to a cell bind. */
function parseOrigin(value: unknown): ValueOrigin {
	if (typeof value !== "object" || value === null) return { kind: "cell" };
	const fields = value as Record<string, unknown>;
	if (fields.kind === "delegation") return { kind: "delegation" };
	if (fields.kind === "primitive" && typeof fields.name === "string") {
		return {
			kind: "primitive",
			name: fields.name,
			...(typeof fields.argsSummary === "string" ? { argsSummary: fields.argsSummary } : {}),
		};
	}
	return { kind: "cell" };
}

function parseObjectPayload(payload: unknown, request: string): Record<string, unknown> {
	if (typeof payload !== "object" || payload === null) {
		throw new Error(`${request}: payload must be an object`);
	}
	return payload as Record<string, unknown>;
}

function parseRef(payload: unknown, request: string): string {
	const fields = parseObjectPayload(payload, request);
	if (typeof fields.ref !== "string") {
		throw new Error(`${request}: ref must be a string`);
	}
	return fields.ref;
}
