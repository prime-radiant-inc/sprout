import type { AuthChannelClient, AuthRequestHandler } from "./auth-channel.ts";
import type { HandleRegistry } from "./handle-registry.ts";

/**
 * Liveness pings over the authenticated channel (sap spec §4). Every agent
 * process pings the host on an interval; a wedged event loop stops pinging —
 * its own timers can't fire — which is what makes the ping a real liveness
 * signal rather than a formality. Waiters whose inactivity timers are
 * suspended during blocking waits use the probe side to notice a silent
 * counterparty and resume their timers.
 */

/** Request type: "I am alive" — recorded for the connection's own identity. */
export const PING_REQUEST = "ping";

/** Request type: "how long since this handle last pinged?" */
export const LIVENESS_REQUEST = "liveness";

/** Default ping cadence (sap spec §7 defaults: 15 s). */
export const PING_INTERVAL_MS = 15_000;

/**
 * Host-side handler for {@link PING_REQUEST}. The pinged identity is ALWAYS
 * the connection's verified handle — a payload naming another handle is
 * ignored, so no agent can keep a dead sibling looking alive.
 */
export function makePingHandler(
	registry: HandleRegistry,
	now: () => number = Date.now,
): AuthRequestHandler {
	return (ctx) => {
		registry.recordPing(ctx.handleId, now());
		return { ok: true };
	};
}

/**
 * Host-side handler for {@link LIVENESS_REQUEST}. Returns
 * `{ msSincePing: number | null }` for the queried handle; null means the
 * handle is unknown or has never pinged. Liveness is not a secret — any
 * authenticated handle may ask about any other.
 */
export function makeLivenessHandler(
	registry: HandleRegistry,
	now: () => number = Date.now,
): AuthRequestHandler {
	return (_ctx, payload) => {
		if (
			typeof payload !== "object" ||
			payload === null ||
			typeof (payload as Record<string, unknown>).handleId !== "string"
		) {
			throw new Error(`${LIVENESS_REQUEST}: handleId must be a string`);
		}
		const { handleId } = payload as { handleId: string };
		return { msSincePing: registry.msSincePing(handleId, now()) };
	};
}

export interface LivenessReporterOptions {
	/** Authenticated connection to ping over. */
	client: AuthChannelClient;
	/** Ping cadence. Defaults to {@link PING_INTERVAL_MS}. */
	intervalMs?: number;
}

/**
 * Agent-process side: pings the host once at start() and then on the interval
 * until stop(). Ping failures are swallowed — a dropped connection already
 * clears liveness on the host via disconnect, and the reporter must not turn
 * a transient send failure into an unhandled rejection.
 */
export class LivenessReporter {
	private readonly client: AuthChannelClient;
	private readonly intervalMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: LivenessReporterOptions) {
		this.client = options.client;
		this.intervalMs = options.intervalMs ?? PING_INTERVAL_MS;
	}

	start(): void {
		if (this.timer) return;
		const ping = () => {
			this.client.request(PING_REQUEST).catch(() => {});
		};
		ping();
		this.timer = setInterval(ping, this.intervalMs);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}
}

/**
 * How a waiter asks about a counterparty's liveness. Mirrors the registrar
 * split: the host process reads its registry directly; a child process asks
 * over its authenticated connection.
 */
export interface LivenessProbe {
	/** ms since the handle's last ping, or null when there is no signal. */
	msSincePing(handleId: string): Promise<number | null>;
}

export class HostLivenessProbe implements LivenessProbe {
	private readonly registry: HandleRegistry;
	private readonly now: () => number;

	constructor(registry: HandleRegistry, now: () => number = Date.now) {
		this.registry = registry;
		this.now = now;
	}

	async msSincePing(handleId: string): Promise<number | null> {
		return this.registry.msSincePing(handleId, this.now());
	}
}

export class ChannelLivenessProbe implements LivenessProbe {
	private readonly client: AuthChannelClient;

	constructor(client: AuthChannelClient) {
		this.client = client;
	}

	async msSincePing(handleId: string): Promise<number | null> {
		const result = (await this.client.request(LIVENESS_REQUEST, { handleId })) as {
			msSincePing: number | null;
		};
		return result.msSincePing;
	}
}
