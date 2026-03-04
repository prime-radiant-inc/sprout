import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BusClient } from "../../src/bus/client.ts";
import { BusLearnForwarder } from "../../src/bus/learn-forwarder.ts";
import { BusServer } from "../../src/bus/server.ts";
import { genomeMutations } from "../../src/bus/topics.ts";
import type { LearnSignal } from "../../src/kernel/types.ts";

describe("BusLearnForwarder", () => {
	let server: BusServer;
	let publisherBus: BusClient;
	let subscriberBus: BusClient;

	const SESSION_ID = "learn-fwd-test";

	beforeEach(async () => {
		server = new BusServer({ port: 0 });
		await server.start();

		// Two clients: one for the forwarder (publisher), one to observe messages
		publisherBus = new BusClient(server.url);
		await publisherBus.connect();

		subscriberBus = new BusClient(server.url);
		await subscriberBus.connect();
	});

	afterEach(async () => {
		await publisherBus.disconnect();
		await subscriberBus.disconnect();
		await server.stop();
	});

	function makeSignal(overrides?: Partial<LearnSignal>): LearnSignal {
		return {
			kind: "error",
			goal: "write a test",
			agent_name: "code-editor",
			details: {
				agent_name: "code-editor",
				goal: "write a test",
				output: "Failed to write file",
				success: false,
				stumbles: 1,
				turns: 3,
				timed_out: false,
			},
			session_id: SESSION_ID,
			timestamp: Date.now(),
			...overrides,
		};
	}

	test("push() publishes a learn_request signal message to genomeMutations topic", async () => {
		const forwarder = new BusLearnForwarder(publisherBus, SESSION_ID);

		const messagePromise = subscriberBus.waitForMessage(genomeMutations(SESSION_ID), 5000);

		const signal = makeSignal();
		forwarder.push(signal);

		const raw = await messagePromise;
		const msg = JSON.parse(raw);

		expect(msg.kind).toBe("learn_request");
		expect(typeof msg.request_id).toBe("string");
		expect(msg.payload.kind).toBe("signal");
		expect(msg.payload.signal).toEqual(signal);
	}, 10_000);

	test("push() publishes multiple signals independently", async () => {
		const forwarder = new BusLearnForwarder(publisherBus, SESSION_ID);

		const received: any[] = [];
		await subscriberBus.subscribe(genomeMutations(SESSION_ID), (payload) => {
			received.push(JSON.parse(payload));
		});

		const signal1 = makeSignal({ agent_name: "agent-a" });
		const signal2 = makeSignal({ agent_name: "agent-b", kind: "retry" });

		forwarder.push(signal1);
		forwarder.push(signal2);

		// Wait for both messages to arrive
		await waitUntil(() => received.length >= 2, 5000);

		expect(received.length).toBe(2);
		expect(received[0]!.payload.signal.agent_name).toBe("agent-a");
		expect(received[1]!.payload.signal.agent_name).toBe("agent-b");
		expect(received[1]!.payload.signal.kind).toBe("retry");
	}, 10_000);

	test("recordAction() is a no-op (does not throw)", () => {
		const forwarder = new BusLearnForwarder(publisherBus, SESSION_ID);
		// Should not throw
		forwarder.recordAction("some-agent");
	});

	test("startBackground() is a no-op (does not throw)", () => {
		const forwarder = new BusLearnForwarder(publisherBus, SESSION_ID);
		forwarder.startBackground();
	});

	test("stopBackground() resolves immediately", async () => {
		const forwarder = new BusLearnForwarder(publisherBus, SESSION_ID);
		await forwarder.stopBackground();
	});
});

/** Poll until a condition is true or timeout. */
function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const check = () => {
			if (condition()) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error("waitUntil timed out"));
				return;
			}
			setTimeout(check, 20);
		};
		check();
	});
}
