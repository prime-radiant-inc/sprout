import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

export interface DirectoryLockOptions {
	timeoutMs?: number;
	pollMs?: number;
	staleMs?: number;
}

interface DirectoryLockOwner {
	pid: number;
	hostname: string;
	createdAt: number;
}

const DEFAULT_STALE_MS = 5 * 60_000;
const OWNER_FILE = "owner.json";

export async function acquireDirectoryLock(
	lockDir: string,
	options: DirectoryLockOptions = {},
): Promise<() => Promise<void>> {
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	const pollMs = options.pollMs ?? 25;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	while (true) {
		try {
			await mkdir(lockDir);
			await writeLockOwner(lockDir);
			return async () => {
				await rm(lockDir, { recursive: true, force: true });
			};
		} catch (err) {
			if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") {
				throw err;
			}
			if (await reclaimStaleLock(lockDir, staleMs)) {
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for directory lock at ${lockDir}`);
			}
			await sleep(pollMs);
		}
	}
}

async function writeLockOwner(lockDir: string): Promise<void> {
	try {
		const owner: DirectoryLockOwner = {
			pid: process.pid,
			hostname: hostname(),
			createdAt: Date.now(),
		};
		await writeFile(join(lockDir, OWNER_FILE), JSON.stringify(owner), { flag: "wx" });
	} catch (error) {
		await rm(lockDir, { recursive: true, force: true });
		throw error;
	}
}

async function reclaimStaleLock(lockDir: string, staleMs: number): Promise<boolean> {
	const owner = await readLockOwner(lockDir);
	if (owner) {
		const ageMs = Date.now() - owner.createdAt;
		if (owner.hostname === hostname()) {
			if (!processIsAlive(owner.pid)) {
				await rm(lockDir, { recursive: true, force: true });
				return true;
			}
			return false;
		}
		if (ageMs >= staleMs) {
			await rm(lockDir, { recursive: true, force: true });
			return true;
		}
		return false;
	}

	try {
		const stats = await stat(lockDir);
		if (Date.now() - stats.mtimeMs >= staleMs) {
			await rm(lockDir, { recursive: true, force: true });
			return true;
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
		throw error;
	}
	return false;
}

async function readLockOwner(lockDir: string): Promise<DirectoryLockOwner | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(lockDir, OWNER_FILE), "utf-8"));
		if (!isRecord(parsed)) return undefined;
		const pid = parsed.pid;
		const ownerHostname = parsed.hostname;
		const createdAt = parsed.createdAt;
		if (
			typeof pid !== "number" ||
			typeof ownerHostname !== "string" ||
			typeof createdAt !== "number"
		) {
			return undefined;
		}
		return { pid, hostname: ownerHostname, createdAt };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			((error as NodeJS.ErrnoException).code === "ESRCH" ||
				(error as NodeJS.ErrnoException).code === "EINVAL")
		) {
			return false;
		}
		return true;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
