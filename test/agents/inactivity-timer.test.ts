import { describe, expect, test } from "bun:test";
import { createInactivityTimer } from "../../src/agents/inactivity-timer.ts";

/** Inactivity window for these tests: long enough that sub-deadline sleeps keep real
 * headroom against timer jitter, short enough to keep the file fast. */
const TIMEOUT = 60;
/** Sleep clearly below TIMEOUT — activity/pause checks land well before any deadline. */
const SUB = 35;
/** Sleep past TIMEOUT (with margin) where we assert nothing fired. */
const NO_FIRE_WAIT = 100;
/** Sleep comfortably past TIMEOUT where a due timeout must certainly have fired. */
const FIRE_WAIT = 150;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTimer(timeoutMs = TIMEOUT) {
	let fired = 0;
	const timer = createInactivityTimer({
		timeoutMs,
		onTimeout: () => {
			fired++;
		},
	});
	return { timer, fired: () => fired };
}

describe("createInactivityTimer", () => {
	test("starts disarmed and never fires before the first reset()", async () => {
		const { timer, fired } = makeTimer();
		expect(timer.isArmed()).toBe(false);
		await sleep(NO_FIRE_WAIT);
		expect(fired()).toBe(0);
		expect(timer.isArmed()).toBe(false);
		timer.clear();
	});

	test("fires onTimeout after timeoutMs of no activity once armed", async () => {
		const { timer, fired } = makeTimer();
		timer.reset();
		expect(timer.isArmed()).toBe(true);
		await sleep(FIRE_WAIT);
		expect(fired()).toBe(1);
		// A fired arming is spent: disarmed until the next reset().
		expect(timer.isArmed()).toBe(false);
		timer.clear();
	});

	test("reset() postpones firing past the original deadline", async () => {
		const { timer, fired } = makeTimer();
		timer.reset(); // deadline ~TIMEOUT
		await sleep(SUB);
		timer.reset(); // fresh deadline ~SUB + TIMEOUT
		await sleep(SUB); // now past the original deadline (2*SUB > TIMEOUT)
		expect(fired()).toBe(0);
		await sleep(FIRE_WAIT);
		expect(fired()).toBe(1);
		timer.clear();
	});

	test("fires only once per arming; reset() after firing re-arms and fires again", async () => {
		const { timer, fired } = makeTimer();
		timer.reset();
		await sleep(FIRE_WAIT);
		expect(fired()).toBe(1);
		await sleep(FIRE_WAIT);
		expect(fired()).toBe(1); // spent arming never re-fires on its own
		timer.reset();
		expect(timer.isArmed()).toBe(true);
		await sleep(FIRE_WAIT);
		expect(fired()).toBe(2);
		timer.clear();
	});

	test("pause() prevents firing even past the deadline", async () => {
		const { timer, fired } = makeTimer();
		timer.reset();
		timer.pause();
		expect(timer.isArmed()).toBe(false);
		expect(timer.pauseDepth()).toBe(1);
		await sleep(NO_FIRE_WAIT); // well past TIMEOUT
		expect(fired()).toBe(0);
		timer.clear();
	});

	test("resume() re-arms a fresh full countdown, not an immediate fire", async () => {
		const { timer, fired } = makeTimer();
		timer.reset();
		timer.pause();
		await sleep(NO_FIRE_WAIT); // paused well past the original deadline
		timer.resume();
		expect(fired()).toBe(0); // not fired synchronously on resume
		expect(timer.isArmed()).toBe(true);
		await sleep(SUB); // still inside the fresh window
		expect(fired()).toBe(0);
		await sleep(FIRE_WAIT); // ~TIMEOUT after resume
		expect(fired()).toBe(1);
		timer.clear();
	});

	test("pauses nest: paused until every pause() is matched by a resume()", async () => {
		const { timer, fired } = makeTimer();
		timer.reset();
		timer.pause();
		timer.pause();
		expect(timer.pauseDepth()).toBe(2);
		timer.resume();
		expect(timer.pauseDepth()).toBe(1);
		await sleep(NO_FIRE_WAIT); // still paused past the deadline
		expect(fired()).toBe(0);
		expect(timer.isArmed()).toBe(false);
		timer.resume();
		expect(timer.pauseDepth()).toBe(0);
		expect(timer.isArmed()).toBe(true);
		await sleep(FIRE_WAIT);
		expect(fired()).toBe(1);
		timer.clear();
	});

	test("reset() while paused does not arm; resume() starts the fresh countdown", async () => {
		const { timer, fired } = makeTimer();
		timer.reset();
		timer.pause();
		timer.reset(); // activity while paused: recorded as safe no-op, stays dormant
		expect(timer.isArmed()).toBe(false);
		await sleep(NO_FIRE_WAIT);
		expect(fired()).toBe(0);
		timer.resume();
		expect(timer.isArmed()).toBe(true);
		await sleep(FIRE_WAIT);
		expect(fired()).toBe(1);
		timer.clear();
	});

	test("resume() when never paused is a no-op and does not corrupt later nesting", async () => {
		const { timer, fired } = makeTimer();
		timer.resume();
		timer.resume();
		expect(timer.pauseDepth()).toBe(0);
		timer.reset();
		expect(timer.isArmed()).toBe(true);
		// If the counter had gone negative, this single pause() would not reach depth 1
		// and the countdown would keep running.
		timer.pause();
		expect(timer.pauseDepth()).toBe(1);
		await sleep(NO_FIRE_WAIT);
		expect(fired()).toBe(0);
		timer.resume();
		await sleep(FIRE_WAIT);
		expect(fired()).toBe(1);
		timer.clear();
	});

	test("clear() stops everything permanently; later calls are safe no-ops", async () => {
		const { timer, fired } = makeTimer();
		timer.reset();
		timer.clear();
		expect(timer.isArmed()).toBe(false);
		await sleep(NO_FIRE_WAIT);
		expect(fired()).toBe(0);
		timer.reset(); // no-op after clear
		expect(timer.isArmed()).toBe(false);
		timer.pause(); // no-op after clear
		expect(timer.pauseDepth()).toBe(0);
		timer.resume(); // no-op after clear
		await sleep(NO_FIRE_WAIT);
		expect(fired()).toBe(0);
	});

	test("timeoutMs <= 0 is completely inert: never arms, all methods are no-ops", async () => {
		const zero = makeTimer(0);
		const negative = makeTimer(-1000);
		for (const { timer } of [zero, negative]) {
			timer.reset();
			expect(timer.isArmed()).toBe(false);
			timer.pause();
			expect(timer.pauseDepth()).toBe(0);
			timer.resume();
			expect(timer.pauseDepth()).toBe(0);
		}
		await sleep(NO_FIRE_WAIT);
		expect(zero.fired()).toBe(0);
		expect(negative.fired()).toBe(0);
		zero.timer.clear();
		negative.timer.clear();
	});

	test("isArmed() and pauseDepth() track state transitions", () => {
		const { timer } = makeTimer();
		expect(timer.isArmed()).toBe(false);
		expect(timer.pauseDepth()).toBe(0);
		timer.reset();
		expect(timer.isArmed()).toBe(true);
		timer.pause();
		expect(timer.isArmed()).toBe(false);
		expect(timer.pauseDepth()).toBe(1);
		timer.pause();
		expect(timer.pauseDepth()).toBe(2);
		timer.reset(); // dormant while paused
		expect(timer.isArmed()).toBe(false);
		timer.resume();
		expect(timer.pauseDepth()).toBe(1);
		expect(timer.isArmed()).toBe(false);
		timer.resume();
		expect(timer.pauseDepth()).toBe(0);
		expect(timer.isArmed()).toBe(true);
		timer.resume(); // extra resume: no-op, stays armed at depth 0
		expect(timer.pauseDepth()).toBe(0);
		expect(timer.isArmed()).toBe(true);
		timer.clear();
		expect(timer.isArmed()).toBe(false);
	});
});
