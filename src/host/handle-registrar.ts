import type { AuthChannelClient, AuthRequestHandler } from "./auth-channel.ts";
import type { HandleRegistry, ObserverRemit } from "./handle-registry.ts";
import type { SessionBudget } from "./session-budget.ts";

/**
 * Registration authority for the handle bootstrap (sap spec §1 Transport, §3
 * Identity). Spawners are per-process, so a child agent's process cannot touch
 * the host's registry object to record its own children — it must ask the host
 * over its authenticated connection, and the host must decide *who* is asking
 * from the connection, never from the message body. This module gives both the
 * in-process host/root spawner and a mid-tree child spawner one `registerChild`
 * interface so the spawner code is identical in both places, while the two
 * implementations route to the registry through the correct trust path.
 */

/**
 * Request type for handle registration over the authenticated channel — shared
 * by {@link ChannelHandleRegistrar} (client) and {@link makeRegisterHandleHandler}
 * (host) so the wire type has a single definition.
 */
export const REGISTER_HANDLE_REQUEST = "register_handle";

/**
 * The host's trust-authority identity. Deliberately neither a ULID nor
 * "root", so no agent handle can ever collide with it; the registry also
 * refuses to register any handle claiming it.
 */
export const TRUSTED_REGISTRAR_ID = "sprout:host";

/**
 * Enforce the per-session sub-call/token budget (Phase 7) at the registration
 * boundary. Every subprocess spawn registers here BEFORE launch, and the
 * spawner aborts the launch on rejection, so a thrown budget error surfaces to
 * the delegating agent as a normal failed delegation outcome
 * (infrastructure_error) — never a crash or a silent drop. No budget = no cap
 * (budget-less test/registrar setups are unchanged).
 */
function admitAgainstBudget(budget: SessionBudget | undefined): void {
	if (!budget) return;
	const admission = budget.admitSubCall();
	if (!admission.ok) {
		throw new Error(admission.reason);
	}
}

/**
 * What a spawner supplies to register one child handle. It deliberately carries
 * NO `registrarId`: the registrar is always the caller's own verified identity
 * (the trusted host id in-process, or the connection's handle id over the
 * channel), never a value the caller could name.
 */
export interface RegisterChildInput {
	/** Handle ID being registered (globally unique per session). */
	handleId: string;
	/** Hex sha256 of the child's secret token. */
	tokenHash: string;
	/** Handle ID of the parent that owns the new handle. */
	ownerId: string;
	/** Delegation depth of the new handle. */
	depth: number;
	/** Observer remit, present only for observer handles. */
	observerRemit?: ObserverRemit;
}

/**
 * Uniform registration interface for spawners. Resolves on success; REJECTS
 * with an Error whose message names the failure reason on any failure, so both
 * the in-process and over-the-channel call sites are identical and async.
 */
export interface HandleRegistrar {
	registerChild(input: RegisterChildInput): Promise<void>;
}

/**
 * In-process trusted path for the host/root spawner. The host process holds the
 * registry object directly, so it registers root's direct children against it
 * with the configured trusted registrar id — the only identity the registry
 * lets register handles for any owner.
 */
export class HostHandleRegistrar implements HandleRegistrar {
	private readonly registry: HandleRegistry;
	private readonly trustedRegistrarId: string;
	private readonly budget?: SessionBudget;

	constructor(registry: HandleRegistry, trustedRegistrarId: string, budget?: SessionBudget) {
		this.registry = registry;
		this.trustedRegistrarId = trustedRegistrarId;
		this.budget = budget;
	}

	async registerChild(input: RegisterChildInput): Promise<void> {
		admitAgainstBudget(this.budget);
		const result = this.registry.registerHandle({
			...input,
			registrarId: this.trustedRegistrarId,
		});
		if (!result.ok) {
			throw new Error(`handle registration failed: ${result.reason}`);
		}
	}
}

/**
 * Over-the-channel path for a mid-tree child spawner. A child agent's process
 * cannot reach the host's registry object, so it sends the registration over
 * its own authenticated connection. It sends NO registrarId — the host derives
 * the registrar from the verified connection — and propagates the host's
 * rejection unchanged.
 */
export class ChannelHandleRegistrar implements HandleRegistrar {
	private readonly client: AuthChannelClient;

	constructor(client: AuthChannelClient) {
		this.client = client;
	}

	async registerChild(input: RegisterChildInput): Promise<void> {
		await this.client.request(REGISTER_HANDLE_REQUEST, input);
	}
}

/**
 * Host-side handler for {@link REGISTER_HANDLE_REQUEST}, registered via
 * `authServer.onRequest`. It validates the payload shape (a malformed payload
 * throws, so the client's request rejects) and registers the child with the
 * registrar taken from `ctx.handleId` — the connection's verified identity.
 *
 * The keystone: `registrarId` ALWAYS comes from the verified connection, NEVER
 * from the payload. A connected agent can therefore only register children it
 * owns; the registry's own `not_parent` check then enforces
 * `ownerId === registrarId` (unless trusted). Any `registrarId` a crafted
 * payload might carry is ignored entirely.
 */
export function makeRegisterHandleHandler(
	registry: HandleRegistry,
	budget?: SessionBudget,
): AuthRequestHandler {
	return (ctx, payload) => {
		const input = parseRegisterChildInput(payload);
		admitAgainstBudget(budget);
		// A channel registrar is never the trusted registrar (that identity is
		// reserved and unregisterable), so constrain what it may claim about
		// its child: depth exactly one below its own — depth feeds
		// MAX_AGENT_DEPTH enforcement — and an observer remit scoped to its
		// OWN delegations. Session-wide remits belong to root/session
		// observers registered via the trusted in-process path; accepting one
		// here would let a mid-tree agent grant its observer session-wide
		// read scope. The remit is recorded now and trusted by scope checks
		// later, so it must be constrained at registration.
		if (input.depth !== ctx.depth + 1) {
			throw new Error(
				`${REGISTER_HANDLE_REQUEST}: depth must be ${ctx.depth + 1} (one below the registrar)`,
			);
		}
		if (
			input.observerRemit &&
			(input.observerRemit.kind !== "delegate" || input.observerRemit.ownerId !== ctx.handleId)
		) {
			throw new Error(
				`${REGISTER_HANDLE_REQUEST}: observerRemit must be a delegate remit scoped to the registrar`,
			);
		}
		const result = registry.registerHandle({
			...input,
			registrarId: ctx.handleId,
		});
		if (!result.ok) {
			throw new Error(`handle registration failed: ${result.reason}`);
		}
		return { ok: true };
	};
}

/**
 * Narrow an untrusted wire payload to a {@link RegisterChildInput}, throwing a
 * field-named error on any type mismatch. Producing a typed value honestly
 * requires checking each field rather than casting an `unknown` body.
 */
function parseRegisterChildInput(payload: unknown): RegisterChildInput {
	if (typeof payload !== "object" || payload === null) {
		throw new Error(`${REGISTER_HANDLE_REQUEST}: payload must be an object`);
	}
	const fields = payload as Record<string, unknown>;
	const { handleId, tokenHash, ownerId, depth } = fields;
	if (typeof handleId !== "string") {
		throw new Error(`${REGISTER_HANDLE_REQUEST}: handleId must be a string`);
	}
	if (typeof tokenHash !== "string") {
		throw new Error(`${REGISTER_HANDLE_REQUEST}: tokenHash must be a string`);
	}
	if (typeof ownerId !== "string") {
		throw new Error(`${REGISTER_HANDLE_REQUEST}: ownerId must be a string`);
	}
	if (typeof depth !== "number") {
		throw new Error(`${REGISTER_HANDLE_REQUEST}: depth must be a number`);
	}
	const input: RegisterChildInput = { handleId, tokenHash, ownerId, depth };
	if (fields.observerRemit !== undefined) {
		input.observerRemit = parseObserverRemit(fields.observerRemit);
	}
	return input;
}

/**
 * Narrow an untrusted observer remit to {@link ObserverRemit}. The remit fixes
 * an observer's read scope, so a malformed one must be rejected rather than
 * stored and later trusted by scope checks.
 */
function parseObserverRemit(value: unknown): ObserverRemit {
	if (typeof value !== "object" || value === null) {
		throw new Error(`${REGISTER_HANDLE_REQUEST}: observerRemit must be an object`);
	}
	const remit = value as Record<string, unknown>;
	if (remit.kind === "session") {
		return { kind: "session" };
	}
	if (remit.kind === "delegate" && typeof remit.ownerId === "string") {
		return { kind: "delegate", ownerId: remit.ownerId };
	}
	throw new Error(`${REGISTER_HANDLE_REQUEST}: observerRemit must be a session or delegate remit`);
}
