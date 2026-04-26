import { mkdir, rm } from "node:fs/promises";

export interface DirectoryLockOptions {
	timeoutMs?: number;
	pollMs?: number;
}

export async function acquireDirectoryLock(
	lockDir: string,
	options: DirectoryLockOptions = {},
): Promise<() => Promise<void>> {
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	const pollMs = options.pollMs ?? 25;
	while (true) {
		try {
			await mkdir(lockDir);
			return async () => {
				await rm(lockDir, { recursive: true, force: true });
			};
		} catch (err) {
			if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") {
				throw err;
			}
			if (Date.now() >= deadline) {
				throw new Error(`Timed out waiting for directory lock at ${lockDir}`);
			}
			await sleep(pollMs);
		}
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
