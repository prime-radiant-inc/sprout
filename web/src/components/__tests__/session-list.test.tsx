import { describe, expect, test } from "bun:test";
import type { ProjectSessionEntry } from "@kernel/types.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionList } from "../SessionList.tsx";

function entry(overrides: Partial<ProjectSessionEntry> = {}): ProjectSessionEntry {
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
		project: "-home-jesse-alpha",
		...overrides,
	};
}

const noop = () => {};

function render(sessions: ProjectSessionEntry[], live: string | null, current: string | null) {
	return renderToStaticMarkup(
		<SessionList
			sessions={sessions}
			liveSessionId={live}
			currentProject={current}
			loading={false}
			error={null}
			onReload={noop}
			onClose={noop}
		/>,
	);
}

describe("SessionList", () => {
	test("lists each session with its goal, agent, turns, and id", () => {
		const html = render(
			[
				entry({ sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA", firstPrompt: "fix the flaky test" }),
				entry({ sessionId: "01BBBBBBBBBBBBBBBBBBBBBBBB", firstPrompt: "add mobile styles" }),
			],
			"01BBBBBBBBBBBBBBBBBBBBBBBB",
			"-home-jesse-alpha",
		);
		expect(html).toContain("fix the flaky test");
		expect(html).toContain("add mobile styles");
		expect(html).toContain("01AAAAAAAAAAAAAAAAAAAAAAAA");
		expect(html).toContain("3 turns");
	});

	test("groups sessions by project with the current project first and marked", () => {
		const html = render(
			[
				entry({ sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA", project: "-home-jesse-beta" }),
				entry({ sessionId: "01BBBBBBBBBBBBBBBBBBBBBBBB", project: "-home-jesse-alpha" }),
			],
			null,
			"-home-jesse-alpha",
		);
		// Current project's group renders before the other project's.
		expect(html.indexOf('data-project="-home-jesse-alpha"')).toBeLessThan(
			html.indexOf('data-project="-home-jesse-beta"'),
		);
		expect(html).toContain("current");
		expect(html).toContain("home-jesse-beta");
	});

	test("marks the live session across projects", () => {
		const html = render(
			[
				entry({ sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA", project: "-home-jesse-alpha" }),
				entry({ sessionId: "01BBBBBBBBBBBBBBBBBBBBBBBB", project: "-home-jesse-beta" }),
			],
			"01AAAAAAAAAAAAAAAAAAAAAAAA",
			"-home-jesse-alpha",
		);
		expect(html.match(/data-live="true"/g)).toHaveLength(1);
		expect(html).toContain(">live<");
	});

	test("newest session (highest ULID) renders first within a project", () => {
		const html = render(
			[
				entry({ sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA", firstPrompt: "older" }),
				entry({ sessionId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", firstPrompt: "newer" }),
			],
			null,
			"-home-jesse-alpha",
		);
		expect(html.indexOf("newer")).toBeLessThan(html.indexOf("older"));
	});

	test("shows an empty state when there are no sessions", () => {
		expect(render([], null, null)).toContain("No sessions yet.");
	});

	test("surfaces a load error", () => {
		const html = renderToStaticMarkup(
			<SessionList
				sessions={[]}
				liveSessionId={null}
				currentProject={null}
				loading={false}
				error="Failed to load sessions (500)"
				onReload={noop}
				onClose={noop}
			/>,
		);
		expect(html).toContain("Failed to load sessions (500)");
	});
});
