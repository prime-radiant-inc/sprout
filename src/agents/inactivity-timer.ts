/**
 * Owner inactivity timeout for the agent run loop, extracted from the loop's inline
 * setTimeout so blocking waits can suspend it. The run loop treats `timeout_ms` as a
 * wall-clock inactivity window: it arms the countdown at run start and reset()s it
 * after planning and after each tool batch. A parent blocked on a child for ten
 * minutes is not "inactive", so the sap data plane pauses the countdown for the
 * duration of every blocking wait on another agent — and waits can overlap
 * (Promise.all of several delegations), so pauses nest via a counter.
 */

export interface InactivityTimerOptions {
	/** Inactivity window in ms. `<= 0` disables the timer entirely: it never arms and
	 * every method is a safe no-op (matches the run loop's historical guard). */
	timeoutMs: number;
	/** Called when `timeoutMs` elapses with no reset() while unpaused. The caller owns
	 * the consequence (today: aborting the run loop's AbortController). Fires at most
	 * once per arming; a later reset() re-arms. */
	onTimeout: () => void;
}

export interface InactivityTimer {
	/** Records activity: clears and re-arms a full countdown. While paused it stays
	 * dormant (resume() will arm); after clear() it is a no-op. */
	reset(): void;
	/** Suspends the countdown for a blocking wait. Reentrant: overlapping waits each
	 * pause once, and no timeout can fire until every one has resumed. */
	pause(): void;
	/** Ends one pause. When the last pause ends, arms a FRESH full countdown rather
	 * than resuming remaining time: inactivity measures time since last activity, and
	 * the child completion that unblocked us IS activity. (Also simpler —
	 * remaining-time bookkeeping buys nothing here.) A resume() with no matching
	 * pause() is a no-op; the depth never goes negative. */
	resume(): void;
	/** Permanently stops the timer (run-loop teardown). All later calls are no-ops. */
	clear(): void;
	/** True while a countdown is pending (armed and not yet fired). */
	isArmed(): boolean;
	/** Number of unmatched pause() calls. */
	pauseDepth(): number;
}

export function createInactivityTimer(options: InactivityTimerOptions): InactivityTimer {
	const { timeoutMs, onTimeout } = options;
	const disabled = timeoutMs <= 0;
	let handle: ReturnType<typeof setTimeout> | undefined;
	let pauseCount = 0;
	let cleared = false;

	const disarm = () => {
		if (handle !== undefined) {
			clearTimeout(handle);
			handle = undefined;
		}
	};

	const arm = () => {
		disarm();
		handle = setTimeout(() => {
			handle = undefined;
			onTimeout();
		}, timeoutMs);
	};

	return {
		reset() {
			if (disabled || cleared || pauseCount > 0) return;
			arm();
		},
		pause() {
			if (disabled || cleared) return;
			pauseCount++;
			disarm();
		},
		resume() {
			if (disabled || cleared || pauseCount === 0) return;
			pauseCount--;
			if (pauseCount === 0) arm();
		},
		clear() {
			cleared = true;
			disarm();
		},
		isArmed() {
			return handle !== undefined;
		},
		pauseDepth() {
			return pauseCount;
		},
	};
}
