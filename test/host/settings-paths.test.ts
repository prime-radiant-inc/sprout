import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	buildInvalidSettingsPath,
	resolveSettingsDir,
	resolveSettingsPath,
} from "../../src/host/settings/paths.ts";

describe("settings paths", () => {
	test("uses XDG_CONFIG_HOME from the process environment by default", () => {
		const original = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = "/tmp/runtime-xdg-home";

		try {
			expect(resolveSettingsDir({ homeDir: "/Users/tester" })).toBe("/tmp/runtime-xdg-home/sprout");
			expect(resolveSettingsPath({ homeDir: "/Users/tester" })).toBe(
				"/tmp/runtime-xdg-home/sprout/settings.json",
			);
		} finally {
			if (original === undefined) {
				delete process.env.XDG_CONFIG_HOME;
			} else {
				process.env.XDG_CONFIG_HOME = original;
			}
		}
	});

	test("uses XDG_CONFIG_HOME when set", () => {
		expect(
			resolveSettingsDir({
				xdgConfigHome: "/tmp/xdg-home",
				homeDir: "/Users/tester",
			}),
		).toBe("/tmp/xdg-home/sprout");
		expect(
			resolveSettingsPath({
				xdgConfigHome: "/tmp/xdg-home",
				homeDir: "/Users/tester",
			}),
		).toBe("/tmp/xdg-home/sprout/settings.json");
	});

	test("falls back to ~/.config/sprout/settings.json", () => {
		expect(
			resolveSettingsDir({
				homeDir: "/Users/tester",
			}),
		).toBe("/Users/tester/.config/sprout");
		expect(
			resolveSettingsPath({
				homeDir: "/Users/tester",
			}),
		).toBe("/Users/tester/.config/sprout/settings.json");
	});

	test("builds a deterministic invalid-file path", () => {
		expect(
			buildInvalidSettingsPath("/tmp/xdg-home/sprout/settings.json", "2026-03-11T12-34-56Z"),
		).toBe(join("/tmp/xdg-home/sprout", "settings.invalid.2026-03-11T12-34-56Z.json"));
	});
});
