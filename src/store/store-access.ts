/**
 * Caller-scoped store surface (sap spec §1, §3). A StoreAccess carries its own
 * scope authority — no method takes a scopeId, so a holder can never name a
 * scope it was not given. The host process uses DirectStoreAccess with a fixed
 * scope; an agent process uses ChannelStoreAccess, whose scope is decided
 * host-side from its verified connection identity (src/host/store-channel.ts).
 *
 * ChannelStoreAccess imports host types as type-only so the agents layer,
 * which reaches this module through the kernel's value primitives, never pulls
 * host runtime code.
 */

import type { AuthChannelClient } from "../host/auth-channel.ts";
import type { GrepResult } from "./store.ts";
import type { StoreWorkerClient } from "./store-client.ts";
import { decodeWireContent, encodeWireContent, type WireBody } from "./store-worker.ts";
import type { ValueMetadata, ValueProvenance, ValueType } from "./value.ts";

/** Request types the store channel carries (client and host share these). */
export const STORE_BIND_REQUEST = "store_bind";
export const STORE_PEEK_REQUEST = "store_peek";
export const STORE_METADATA_REQUEST = "store_metadata";
export const STORE_GET_REQUEST = "store_get";
export const STORE_SLICE_REQUEST = "store_slice";
export const STORE_GREP_REQUEST = "store_grep";

export interface StoreBindInput {
	name: string;
	content: Uint8Array | string;
	type: ValueType;
	provenance: ValueProvenance;
	/** Model-named bind (true) vs provenance-derived auto-bind (false). */
	explicit: boolean;
}

/**
 * The caller-scoped store surface. Every implementation resolves refs (value
 * names or ulids) in the scope it carries; none accepts a scope parameter.
 */
export interface StoreAccess {
	bind(args: StoreBindInput): Promise<ValueMetadata>;
	peek(ref: string): Promise<string>;
	metadata(ref: string): Promise<ValueMetadata>;
	get(ref: string, options: { maxBytes: number }): Promise<Uint8Array>;
	slice(ref: string, options: { startLine: number; lineCount: number }): Promise<string>;
	grep(ref: string, pattern: string, options?: { maxResults?: number }): Promise<GrepResult>;
}

/** Host-process implementation: delegates to the store worker with a fixed scope. */
export class DirectStoreAccess implements StoreAccess {
	private readonly client: StoreWorkerClient;
	private readonly scopeId: string;

	constructor(client: StoreWorkerClient, scopeId: string) {
		this.client = client;
		this.scopeId = scopeId;
	}

	bind(args: StoreBindInput): Promise<ValueMetadata> {
		return this.client.bind({ scopeId: this.scopeId, ...args });
	}

	peek(ref: string): Promise<string> {
		return this.client.peek(this.scopeId, ref);
	}

	metadata(ref: string): Promise<ValueMetadata> {
		return this.client.metadata(this.scopeId, ref);
	}

	get(ref: string, options: { maxBytes: number }): Promise<Uint8Array> {
		return this.client.get(this.scopeId, ref, options);
	}

	slice(ref: string, options: { startLine: number; lineCount: number }): Promise<string> {
		return this.client.slice(this.scopeId, ref, options);
	}

	grep(ref: string, pattern: string, options: { maxResults?: number } = {}): Promise<GrepResult> {
		return this.client.grep(this.scopeId, ref, pattern, options);
	}
}

/**
 * Largest wire form (base64/utf8 content string) a bind may put on the
 * channel. Kept under the server's 8 MB WebSocket frame cap so an oversized
 * value fails with a clear error instead of a silently dropped socket.
 */
export const CHANNEL_BIND_WIRE_LIMIT = 6 * 1024 * 1024;

/**
 * Agent-process implementation: sends store ops over the authenticated
 * channel. Payloads carry NO scope and NO identity — the host derives both
 * from the connection's verified handle. Binary content crosses as base64.
 */
export class ChannelStoreAccess implements StoreAccess {
	private readonly client: AuthChannelClient;

	constructor(client: AuthChannelClient) {
		this.client = client;
	}

	async bind(args: StoreBindInput): Promise<ValueMetadata> {
		const wire = encodeWireContent(
			typeof args.content === "string" ? new TextEncoder().encode(args.content) : args.content,
			args.type,
		);
		if (wire.content.length > CHANNEL_BIND_WIRE_LIMIT) {
			throw new Error(
				`value too large for the channel (${wire.content.length} > ${CHANNEL_BIND_WIRE_LIMIT} wire bytes); ` +
					"large-value capture lands with CAS handoff (Phase 3)",
			);
		}
		return (await this.client.request(STORE_BIND_REQUEST, {
			name: args.name,
			content: wire.content,
			encoding: wire.encoding,
			type: args.type,
			// agentHandleId is forced host-side; only the origin is meaningful.
			provenance: args.provenance,
			explicit: args.explicit,
		})) as ValueMetadata;
	}

	async peek(ref: string): Promise<string> {
		return (await this.client.request(STORE_PEEK_REQUEST, { ref })) as string;
	}

	async metadata(ref: string): Promise<ValueMetadata> {
		return (await this.client.request(STORE_METADATA_REQUEST, { ref })) as ValueMetadata;
	}

	async get(ref: string, options: { maxBytes: number }): Promise<Uint8Array> {
		const body = (await this.client.request(STORE_GET_REQUEST, {
			ref,
			maxBytes: options.maxBytes,
		})) as WireBody;
		return decodeWireContent(body.content, body.encoding);
	}

	async slice(ref: string, options: { startLine: number; lineCount: number }): Promise<string> {
		return (await this.client.request(STORE_SLICE_REQUEST, { ref, ...options })) as string;
	}

	async grep(
		ref: string,
		pattern: string,
		options: { maxResults?: number } = {},
	): Promise<GrepResult> {
		return (await this.client.request(STORE_GREP_REQUEST, {
			ref,
			pattern,
			...(options.maxResults !== undefined ? { maxResults: options.maxResults } : {}),
		})) as GrepResult;
	}
}
