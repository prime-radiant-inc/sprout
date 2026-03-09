import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../src/kernel/types";
import { buildAgentTree } from "../../../web/src/hooks/useAgentTree";

function makeEvent(
	overrides: Partial<SessionEvent> & { kind: SessionEvent["kind"] },
): SessionEvent {
	return {
		timestamp: Date.now(),
		agent_id: "root",
		depth: 0,
		data: {},
		...overrides,
	};
}

describe("buildAgentTree — mnemonic names", () => {
	test("act_start with mnemonic_name sets mnemonicName on child node", () => {
		const events: SessionEvent[] = [
			makeEvent({ kind: "session_start", depth: 0 }),
			makeEvent({
				kind: "act_start",
				depth: 0,
				agent_id: "root",
				data: {
					agent_name: "reader",
					child_id: "child-1",
					goal: "read something",
					mnemonic_name: "Ada Lovelace",
				},
			}),
		];

		const { tree } = buildAgentTree(events);
		expect(tree.children).toHaveLength(1);
		expect(tree.children[0]!.mnemonicName).toBe("Ada Lovelace");
	});

	test("act_start without mnemonic_name leaves mnemonicName undefined", () => {
		const events: SessionEvent[] = [
			makeEvent({ kind: "session_start", depth: 0 }),
			makeEvent({
				kind: "act_start",
				depth: 0,
				agent_id: "root",
				data: {
					agent_name: "reader",
					child_id: "child-2",
					goal: "read something",
				},
			}),
		];

		const { tree } = buildAgentTree(events);
		expect(tree.children).toHaveLength(1);
		expect(tree.children[0]!.mnemonicName).toBeUndefined();
	});

	test("act_start with handle_id and mnemonic_name populates handleToMnemonic map", () => {
		const events: SessionEvent[] = [
			makeEvent({ kind: "session_start", depth: 0 }),
			makeEvent({
				kind: "act_start",
				depth: 0,
				agent_id: "root",
				data: {
					agent_name: "reader",
					child_id: "child-3",
					handle_id: "handle-abc",
					goal: "read something",
					mnemonic_name: "Alan Turing",
				},
			}),
		];

		const { handleToMnemonic } = buildAgentTree(events);
		expect(handleToMnemonic.get("handle-abc")).toBe("Alan Turing");
	});

	test("act_start with child_id and mnemonic_name populates childIdToMnemonic map", () => {
		const events: SessionEvent[] = [
			makeEvent({ kind: "session_start", depth: 0 }),
			makeEvent({
				kind: "act_start",
				depth: 0,
				agent_id: "root",
				data: {
					agent_name: "reader",
					child_id: "child-4",
					goal: "read something",
					mnemonic_name: "Grace Hopper",
				},
			}),
		];

		const { childIdToMnemonic } = buildAgentTree(events);
		expect(childIdToMnemonic.get("child-4")).toBe("Grace Hopper");
	});

	test("act_end with mnemonic_name sets mnemonicName on node if not already set", () => {
		const events: SessionEvent[] = [
			makeEvent({ kind: "session_start", depth: 0 }),
			makeEvent({
				kind: "act_start",
				depth: 0,
				agent_id: "root",
				data: {
					agent_name: "reader",
					child_id: "child-5",
					goal: "read something",
					// no mnemonic_name in act_start
				},
			}),
			makeEvent({
				kind: "act_end",
				depth: 0,
				agent_id: "root",
				data: {
					child_id: "child-5",
					success: true,
					turns: 3,
					mnemonic_name: "Marie Curie",
				},
			}),
		];

		const { tree } = buildAgentTree(events);
		expect(tree.children[0]!.mnemonicName).toBe("Marie Curie");
	});

	test("act_end does not overwrite mnemonicName already set by act_start", () => {
		const events: SessionEvent[] = [
			makeEvent({ kind: "session_start", depth: 0 }),
			makeEvent({
				kind: "act_start",
				depth: 0,
				agent_id: "root",
				data: {
					agent_name: "reader",
					child_id: "child-6",
					goal: "read something",
					mnemonic_name: "Ada Lovelace",
				},
			}),
			makeEvent({
				kind: "act_end",
				depth: 0,
				agent_id: "root",
				data: {
					child_id: "child-6",
					success: true,
					turns: 2,
					mnemonic_name: "Different Name",
				},
			}),
		];

		const { tree } = buildAgentTree(events);
		expect(tree.children[0]!.mnemonicName).toBe("Ada Lovelace");
	});

	test("handleToMnemonic is empty when no handle_id or mnemonic_name present", () => {
		const events: SessionEvent[] = [
			makeEvent({ kind: "session_start", depth: 0 }),
			makeEvent({
				kind: "act_start",
				depth: 0,
				agent_id: "root",
				data: {
					agent_name: "reader",
					child_id: "child-7",
					goal: "read something",
				},
			}),
		];

		const { handleToMnemonic } = buildAgentTree(events);
		expect(handleToMnemonic.size).toBe(0);
	});

	test("childIdToMnemonic is empty when no mnemonic_name present", () => {
		const events: SessionEvent[] = [
			makeEvent({ kind: "session_start", depth: 0 }),
			makeEvent({
				kind: "act_start",
				depth: 0,
				agent_id: "root",
				data: {
					agent_name: "reader",
					child_id: "child-8",
					goal: "read something",
				},
			}),
		];

		const { childIdToMnemonic } = buildAgentTree(events);
		expect(childIdToMnemonic.size).toBe(0);
	});
});
