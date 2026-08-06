import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDirectoryLock } from "../../src/genome/file-lock.ts";

describe("acquireDirectoryLock", () => {
	test("times out while an active lock is held", async () => {
		const root = join(tmpdir(), `sprout-lock-active-${Date.now()}`);
		const lockDir = join(root, "memory-write.lock");
		await mkdir(root, { recursive: true });
		const release = await acquireDirectoryLock(lockDir);
		try {
			await expect(
				acquireDirectoryLock(lockDir, { timeoutMs: 20, pollMs: 5, staleMs: 0 }),
			).rejects.toThrow("Timed out");
		} finally {
			await release();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reclaims a lock owned by a dead local process", async () => {
		const root = join(tmpdir(), `sprout-lock-dead-${Date.now()}`);
		const lockDir = join(root, "memory-write.lock");
		await mkdir(lockDir, { recursive: true });
		await writeFile(
			join(lockDir, "owner.json"),
			JSON.stringify({
				pid: 99_999_999,
				hostname: hostname(),
				createdAt: Date.now(),
			}),
		);

		const release = await acquireDirectoryLock(lockDir, {
			timeoutMs: 200,
			pollMs: 5,
			staleMs: 60_000,
		});
		await release();
		await rm(root, { recursive: true, force: true });
	});

	test("concurrent waiters reclaiming a dead lock never hold it together", async () => {
		// Regression net for the reclaim TOCTOU: a waiter that judged the old
		// owner stale must not remove the lock after it has changed hands. Race
		// several waiters at a dead-owner lock and assert exclusive holds.
		const root = join(tmpdir(), `sprout-lock-race-${Date.now()}`);
		const lockDir = join(root, "memory-write.lock");
		await mkdir(lockDir, { recursive: true });
		await writeFile(
			join(lockDir, "owner.json"),
			JSON.stringify({ pid: 99_999_999, hostname: hostname(), createdAt: Date.now() }),
		);

		let holders = 0;
		let maxHolders = 0;
		const contend = async (): Promise<void> => {
			const release = await acquireDirectoryLock(lockDir, {
				timeoutMs: 5_000,
				pollMs: 1,
				staleMs: 60_000,
			});
			holders++;
			maxHolders = Math.max(maxHolders, holders);
			await new Promise((resolve) => setTimeout(resolve, 5));
			holders--;
			await release();
		};
		await Promise.all(Array.from({ length: 6 }, contend));

		expect(maxHolders).toBe(1);
		await rm(root, { recursive: true, force: true });
	});

	test("reclaims ownerless stale lock directories", async () => {
		const root = join(tmpdir(), `sprout-lock-ownerless-${Date.now()}`);
		const lockDir = join(root, "memory-write.lock");
		await mkdir(lockDir, { recursive: true });

		const release = await acquireDirectoryLock(lockDir, {
			timeoutMs: 200,
			pollMs: 5,
			staleMs: 0,
		});
		await release();
		await rm(root, { recursive: true, force: true });
	});
});
