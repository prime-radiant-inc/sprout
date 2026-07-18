import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Host-side registry that is the single source of truth for agent-handle
 * identity (sap spec §1 Transport, §3 Identity). Spawners register each child
 * handle here *before* launching it; the host later authenticates the child
 * process's connection handshake against that registration. Pure logic — no
 * I/O, no timers, no bus imports — so later phases can wire it into the
 * authenticated host channel.
 */

/**
 * What an observer handle is allowed to read (sap spec §3 scope rules):
 * session-wide for a root/session observer, or one owner's delegations for a
 * delegate observer. Recorded at spawn so scope checks never trust the
 * observer's own claims.
 */
export type ObserverRemit = { kind: "session" } | { kind: "delegate"; ownerId: string };

export interface RegisterHandleInput {
	/** Handle ID being registered (globally unique per session). */
	handleId: string;
	/** Hex sha256 of the handle's secret token — raw tokens are never stored. */
	tokenHash: string;
	/** Verified identity of the connection performing the registration. */
	registrarId: string;
	/** Handle ID of the parent that owns the new handle. */
	ownerId: string;
	/** Delegation depth of the new handle. */
	depth: number;
	/** Observer remit, present only for observer handles. */
	observerRemit?: ObserverRemit;
}

/** Identity record exposed to callers — never includes the token hash. */
export interface HandleIdentity {
	ownerId: string;
	depth: number;
	observerRemit?: ObserverRemit;
	live: boolean;
}

export type RegisterHandleResult =
	| { ok: true }
	| { ok: false; reason: "not_parent" | "duplicate" | "live_connection" };

export type AuthenticateResult =
	| { ok: true; identity: HandleIdentity }
	| { ok: false; reason: "unknown_handle" | "bad_token" | "already_live" };

export type DisconnectResult = { ok: true } | { ok: false; reason: "unknown_handle" };

export interface HandleRegistryOptions {
	/**
	 * Identity allowed to register handles for any owner — the host/root
	 * in-process trusted path. Ordinary registrars may only register handles
	 * they own.
	 */
	trustedRegistrarId?: string;
}

interface HandleRecord {
	tokenHash: string;
	ownerId: string;
	depth: number;
	observerRemit?: ObserverRemit;
	live: boolean;
}

/**
 * Mint a fresh per-handle secret token (32 random bytes, hex). Spawner-side:
 * the raw token goes into the child's environment, only its hash is registered.
 */
export function mintToken(): string {
	return randomBytes(32).toString("hex");
}

/**
 * Hex sha256 of a token — the only form of a token the registry ever stores,
 * so a registry dump can never leak credentials.
 */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export class HandleRegistry {
	private readonly handles = new Map<string, HandleRecord>();
	private readonly trustedRegistrarId?: string;

	constructor(options: HandleRegistryOptions = {}) {
		this.trustedRegistrarId = options.trustedRegistrarId;
	}

	/**
	 * Record a handle ahead of its process launch. The registrar must own the
	 * new handle (or be the trusted registrar) — otherwise an authenticated
	 * agent could register or re-register another agent's handle and capture
	 * its identity. Duplicate handle IDs are rejected, with one carve-out: the
	 * same owner may re-register with a fresh token hash while the handle has
	 * no live connection (respawn/owner-resume; tokens are never journaled, so
	 * a resumed parent must mint anew). Re-registration replaces the token
	 * hash; a live handle can be re-registered by no one.
	 */
	registerHandle(input: RegisterHandleInput): RegisterHandleResult {
		const trusted =
			this.trustedRegistrarId !== undefined && input.registrarId === this.trustedRegistrarId;
		if (!trusted && input.registrarId !== input.ownerId) {
			return { ok: false, reason: "not_parent" };
		}
		const existing = this.handles.get(input.handleId);
		if (existing) {
			if (existing.live) return { ok: false, reason: "live_connection" };
			if (existing.ownerId !== input.ownerId) return { ok: false, reason: "duplicate" };
		}
		this.handles.set(input.handleId, {
			tokenHash: input.tokenHash,
			ownerId: input.ownerId,
			depth: input.depth,
			observerRemit: input.observerRemit,
			live: false,
		});
		return { ok: true };
	}

	/**
	 * Verify a connection handshake: sha256 the presented token and compare it
	 * to the stored hash in constant time (hashing first keeps lengths equal,
	 * which timingSafeEqual requires, and avoids leaking match length). Success
	 * marks the handle live — one connection per handle, so a second handshake
	 * while live is rejected.
	 */
	authenticate(handleId: string, token: string): AuthenticateResult {
		const record = this.handles.get(handleId);
		if (!record) return { ok: false, reason: "unknown_handle" };
		const presented = createHash("sha256").update(token).digest();
		const stored = Buffer.from(record.tokenHash, "hex");
		if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
			return { ok: false, reason: "bad_token" };
		}
		if (record.live) return { ok: false, reason: "already_live" };
		record.live = true;
		return { ok: true, identity: toIdentity(record) };
	}

	/**
	 * Clear a handle's live state when its process dies or its connection
	 * drops. The same token authenticates again afterwards (process reconnect),
	 * and the owner may re-register with a fresh token.
	 */
	disconnect(handleId: string): DisconnectResult {
		const record = this.handles.get(handleId);
		if (!record) return { ok: false, reason: "unknown_handle" };
		record.live = false;
		return { ok: true };
	}

	/** Identity of a registered handle, without its token hash. */
	get(handleId: string): HandleIdentity | undefined {
		const record = this.handles.get(handleId);
		return record ? toIdentity(record) : undefined;
	}

	/** Whether the handle currently has an authenticated connection. */
	isLive(handleId: string): boolean {
		return this.handles.get(handleId)?.live ?? false;
	}
}

function toIdentity(record: HandleRecord): HandleIdentity {
	const identity: HandleIdentity = {
		ownerId: record.ownerId,
		depth: record.depth,
		live: record.live,
	};
	if (record.observerRemit) identity.observerRemit = record.observerRemit;
	return identity;
}
