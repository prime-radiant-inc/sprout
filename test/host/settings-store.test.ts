import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../../src/host/settings/store.ts";
import { createEmptySettings } from "../../src/host/settings/types.ts";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

async function makeStore() {
	tempDir = await mkdtemp(join(tmpdir(), "sprout-settings-store-"));
	const settingsPath = join(tempDir, "settings.json");
	const store = new SettingsStore({
		settingsPath,
		now: () => "2026-03-11T12-34-56Z",
	});
	return { store, settingsPath };
}

describe("SettingsStore", () => {
	test("save persists settings via temp-file-then-rename", async () => {
		const { store, settingsPath } = await makeStore();
		const settings = createEmptySettings();

		await store.save(settings);

		expect(JSON.parse(await readFile(settingsPath, "utf-8"))).toEqual(settings);
		expect((await readdir(tempDir!)).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	test("load renames invalid JSON and skips env import", async () => {
		const { store, settingsPath } = await makeStore();
		await writeFile(settingsPath, "{ invalid json", "utf-8");

		const result = await store.load();

		expect(result.settings).toEqual(createEmptySettings());
		expect(result.skipEnvImport).toBe(true);
		expect(result.recoveredInvalidFilePath).toBe(
			join(tempDir!, "settings.invalid.2026-03-11T12-34-56Z.json"),
		);
		expect(await readFile(result.recoveredInvalidFilePath!, "utf-8")).toBe("{ invalid json");
		await expect(access(settingsPath)).rejects.toThrow();
	});

	test("load recovers unsupported schema versions", async () => {
		const { store, settingsPath } = await makeStore();
		await writeFile(settingsPath, JSON.stringify({ version: 999 }), "utf-8");

		const result = await store.load();

		expect(result.settings).toEqual(createEmptySettings());
		expect(result.recoveredInvalidFilePath).toBe(
			join(tempDir!, "settings.invalid.2026-03-11T12-34-56Z.json"),
		);
		expect(result.skipEnvImport).toBe(true);
	});

	test("load recovers failed migrations", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-settings-store-"));
		const settingsPath = join(tempDir, "settings.json");
		await writeFile(settingsPath, JSON.stringify({ version: 0 }), "utf-8");
		const store = new SettingsStore({
			settingsPath,
			now: () => "2026-03-11T12-34-56Z",
			migrate(raw) {
				expect(raw).toEqual({ version: 0 });
				throw new Error("migration failed");
			},
		});

		const result = await store.load();

		expect(result.settings).toEqual(createEmptySettings());
		expect(result.recoveredInvalidFilePath).toBe(
			join(tempDir!, "settings.invalid.2026-03-11T12-34-56Z.json"),
		);
		expect(result.skipEnvImport).toBe(true);
	});

	test("load recovers partially written settings files", async () => {
		const { store, settingsPath } = await makeStore();
		await writeFile(settingsPath, '{"version": 1, "providers": [', "utf-8");

		const result = await store.load();

		expect(result.settings).toEqual(createEmptySettings());
		expect(result.recoveredInvalidFilePath).toBe(
			join(tempDir!, "settings.invalid.2026-03-11T12-34-56Z.json"),
		);
		expect(result.skipEnvImport).toBe(true);
	});

	test("load leaves env import enabled when settings file is absent", async () => {
		const { store } = await makeStore();

		const result = await store.load();

		expect(result.settings).toEqual(createEmptySettings());
		expect(result.skipEnvImport).toBe(false);
		expect(result.recoveredInvalidFilePath).toBeUndefined();
	});
});
