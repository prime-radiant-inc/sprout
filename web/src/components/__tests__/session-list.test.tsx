import { describe, expect, test } from "bun:test";
import type { SessionListEntry } from "@kernel/types.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionList } from "../SessionList.tsx";

function entry(overrides: Partial<SessionListEntry> = {}): SessionListEntry {
	return {
		sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
		agentSpec: "root",
		status: "idle",
		turns: 3,
		contextTokens: 100,
		contextWindowSize: 200000,
		createdAt: "2026-07-21T00:00:00.000Z",
		updatedAt: "2026-07-21T01:00:00.000Z",
		selection: { kind: "tier", tier: "fast" },
		firstPrompt: "fix the flaky test",
		...overrides,
	};
}

const noop = () => {};

describe("SessionList", () => {
	test("lists each session with its goal, agent, turns, and id", () => {
		const html = renderToStaticMarkup(
			<SessionList
				sessions={[
					entry({ sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA", firstPrompt: "fix the flaky test" }),
					entry({ sessionId: "01BBBBBBBBBBBBBBBBBBBBBBBB", firstPrompt: "add mobile styles" }),
				]}
				liveSessionId="01BBBBBBBBBBBBBBBBBBBBBBBB"
				loading={false}
				error={null}
				onReload={noop}
				onClose={noop}
			/>,
		);
		expect(html).toContain("fix the flaky test");
		expect(html).toContain("add mobile styles");
		expect(html).toContain("01AAAAAAAAAAAAAAAAAAAAAAAA");
		expect(html).toContain("3 turns");
	});

	test("marks the live session", () => {
		const html = renderToStaticMarkup(
			<SessionList
				sessions={[
					entry({ sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA" }),
					entry({ sessionId: "01BBBBBBBBBBBBBBBBBBBBBBBB" }),
				]}
				liveSessionId="01AAAAAAAAAAAAAAAAAAAAAAAA"
				loading={false}
				error={null}
				onReload={noop}
				onClose={noop}
			/>,
		);
		// Exactly one row flagged live, and it carries the live badge.
		expect(html.match(/data-live="true"/g)).toHaveLength(1);
		expect(html).toContain(">live<");
	});

	test("newest session (highest ULID) renders first", () => {
		const html = renderToStaticMarkup(
			<SessionList
				sessions={[
					entry({ sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA", firstPrompt: "older" }),
					entry({ sessionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", firstPrompt: "newer" }),
				]}
				liveSessionId={null}
				loading={false}
				error={null}
				onReload={noop}
				onClose={noop}
			/>,
		);
		expect(html.indexOf("newer")).toBeLessThan(html.indexOf("older"));
	});

	test("shows an empty state when there are no sessions", () => {
		const html = renderToStaticMarkup(
			<SessionList
				sessions={[]}
				liveSessionId={null}
				loading={false}
				error={null}
				onReload={noop}
				onClose={noop}
			/>,
		);
		expect(html).toContain("No sessions yet.");
	});

	test("surfaces a load error", () => {
		const html = renderToStaticMarkup(
			<SessionList
				sessions={[]}
				liveSessionId={null}
				loading={false}
				error="Failed to load sessions (500)"
				onReload={noop}
				onClose={noop}
			/>,
		);
		expect(html).toContain("Failed to load sessions (500)");
	});
});
