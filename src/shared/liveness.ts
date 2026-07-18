/**
 * Liveness contract shared across layers (sap spec §4): the agents layer
 * consumes probes and cadence constants during blocking-wait timer
 * suspension; the host layer implements the ping transport and handlers.
 * Lives in shared/ so agents/ never imports host/.
 */

/** Default ping cadence (sap spec §7 defaults: 15 s). */
export const PING_INTERVAL_MS = 15_000;

/**
 * How long without a ping before a party is considered silent. Two missed
 * intervals: one missed ping can be scheduling jitter; two means the process
 * is wedged or gone.
 */
export const LIVENESS_LOST_AFTER_MS = PING_INTERVAL_MS * 2;

/**
 * How a waiter asks about a counterparty's liveness. Mirrors the registrar
 * split: the host process reads its registry directly; a child process asks
 * over its authenticated connection.
 */
export interface LivenessProbe {
	/** ms since the handle's last ping, or null when there is no signal. */
	msSincePing(handleId: string): Promise<number | null>;
}
