import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

let reclaimCounter = 0;

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
			continue;
		}
		const owner = await writeLockOwner(lockDir);
		if (!owner) continue; // lost the directory to a racing reclaim — retry
		return () => releaseLockIfOwnedBy(lockDir, owner);
	}
}

/**
 * Stamp our ownership into a freshly created lock directory. Returns the
 * owner record, or undefined when the directory was lost to a racing
 * reclaimer (vanished, or a restored live lock took the path) — the caller
 * retries. Only genuinely unexpected failures remove the directory.
 */
async function writeLockOwner(lockDir: string): Promise<DirectoryLockOwner | undefined> {
	const owner: DirectoryLockOwner = {
		pid: process.pid,
		hostname: hostname(),
		createdAt: Date.now(),
	};
	try {
		await writeFile(join(lockDir, OWNER_FILE), JSON.stringify(owner), { flag: "wx" });
		return owner;
	} catch (error) {
		const code =
			error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		// ENOENT: our directory was removed under us. EEXIST: another lock's
		// owner file occupies the path (a reclaim restored a live lock there).
		// Either way the path is not ours to clean up.
		if (code === "ENOENT" || code === "EEXIST") return undefined;
		await rm(lockDir, { recursive: true, force: true });
		throw error;
	}
}

/** Release only the lock we hold — never a successor's lock at the same path. */
async function releaseLockIfOwnedBy(lockDir: string, owner: DirectoryLockOwner): Promise<void> {
	const current = await readLockOwner(lockDir);
	if (
		current &&
		current.pid === owner.pid &&
		current.hostname === owner.hostname &&
		current.createdAt === owner.createdAt
	) {
		await rm(lockDir, { recursive: true, force: true });
	}
}

async function reclaimStaleLock(lockDir: string, staleMs: number): Promise<boolean> {
	const owner = await readLockOwner(lockDir);
	if (owner) {
		const ageMs = Date.now() - owner.createdAt;
		const ownerIsStale =
			owner.hostname === hostname() ? !processIsAlive(owner.pid) : ageMs >= staleMs;
		if (!ownerIsStale) return false;
		return claimAndRemoveStaleLock(lockDir, owner);
	}

	try {
		const stats = await stat(lockDir);
		if (Date.now() - stats.mtimeMs >= staleMs) {
			return claimAndRemoveStaleLock(lockDir, undefined);
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
		throw error;
	}
	return false;
}

/**
 * Atomically claim a lock judged stale, then remove it. Concurrent waiters
 * all judge the same dead lock stale; a plain rm would let a second waiter
 * remove the lock AFTER the first already reclaimed and re-acquired it — two
 * holders at once. The rename makes claiming single-winner: losers get
 * ENOENT and go back to polling. If the claimed directory turns out to hold
 * a different (live) owner than the one judged stale, it is renamed back.
 */
async function claimAndRemoveStaleLock(
	lockDir: string,
	judged: DirectoryLockOwner | undefined,
): Promise<boolean> {
	reclaimCounter = (reclaimCounter + 1) % Number.MAX_SAFE_INTEGER;
	const tombstone = `${lockDir}.reclaim.${process.pid}.${reclaimCounter}`;
	try {
		await rename(lockDir, tombstone);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
	const claimed = await readLockOwner(tombstone);
	const sameOwner =
		claimed === undefined
			? judged === undefined
			: judged !== undefined &&
				claimed.pid === judged.pid &&
				claimed.hostname === judged.hostname &&
				claimed.createdAt === judged.createdAt;
	if (!sameOwner) {
		// We claimed a lock that changed hands while we deliberated — give it
		// back. If the path was re-taken meanwhile, the displaced holder's
		// validated release keeps it from touching the new occupant.
		try {
			await rename(tombstone, lockDir);
		} catch {
			await rm(tombstone, { recursive: true, force: true });
		}
		return false;
	}
	await rm(tombstone, { recursive: true, force: true });
	return true;
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
