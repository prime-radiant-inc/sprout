import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputHistory } from "../../src/tui/history.ts";

describe("InputHistory", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-hist-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("stores and retrieves entries", () => {
		const history = new InputHistory(join(tempDir, "history.txt"));

		history.add("first command");
		history.add("second command");

		expect(history.previous()).toBe("second command");
		expect(history.previous()).toBe("first command");
		expect(history.previous()).toBe("first command"); // stays at oldest
	});

	test("navigates forward with next()", () => {
		const history = new InputHistory(join(tempDir, "history.txt"));

		history.add("a");
		history.add("b");
		history.add("c");

		history.previous(); // c
		history.previous(); // b
		expect(history.next()).toBe("c");
		expect(history.next()).toBe(""); // back to empty input
	});

	test("persists to file and reloads", async () => {
		const path = join(tempDir, "history.txt");

		const h1 = new InputHistory(path);
		h1.add("saved command");
		await h1.save();

		const h2 = new InputHistory(path);
		await h2.load();
		expect(h2.previous()).toBe("saved command");
	});

	test("handles multiline entries by escaping newlines", async () => {
		const path = join(tempDir, "history.txt");

		const h1 = new InputHistory(path);
		h1.add("line1\nline2\nline3");
		await h1.save();

		const h2 = new InputHistory(path);
		await h2.load();
		expect(h2.previous()).toBe("line1\nline2\nline3");
	});

	test("previous() returns empty string when no entries", () => {
		const history = new InputHistory(join(tempDir, "history.txt"));
		expect(history.previous()).toBe("");
	});

	test("add resets cursor position", () => {
		const history = new InputHistory(join(tempDir, "history.txt"));
		history.add("a");
		history.add("b");
		history.previous(); // b
		history.previous(); // a
		history.add("c"); // resets cursor
		expect(history.previous()).toBe("c");
	});

	test("load handles missing file gracefully", async () => {
		const history = new InputHistory(join(tempDir, "nonexistent.txt"));
		await history.load(); // should not throw
		expect(history.previous()).toBe("");
	});
});
