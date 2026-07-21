/**
 * The cell-worker process transport: spawn the real subprocess, frame its
 * stdout into lines, and watch its resident set. State-free — the CellHost
 * owns lifecycle and policy.
 */
import { readFile } from "node:fs/promises";
import { buildInternalSproutCommand } from "../util/self-command.ts";

/** Minimal worker process surface — real Bun.spawn or an in-process test fake. */
export interface CellWorkerProcessHandle {
	pid?: number;
	send(line: string): void;
	kill(): void;
	onLine(handler: (line: string) => void): void;
	onExit(handler: () => void): void;
}

export async function readRssBytes(pid: number): Promise<number | undefined> {
	if (process.platform === "linux") {
		try {
			const statm = await readFile(`/proc/${pid}/statm`, "utf8");
			const resident = Number(statm.split(/\s+/)[1]);
			if (!Number.isFinite(resident)) return undefined;
			return resident * 4096;
		} catch {
			return undefined;
		}
	}
	try {
		const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		const kb = Number(out.trim());
		if (!Number.isFinite(kb) || kb <= 0) return undefined;
		return kb * 1024;
	} catch {
		return undefined;
	}
}

/** Default spawn: the sprout binary's internal cell-worker subcommand. */
export function spawnCellWorkerProcess(cmd?: string[]): CellWorkerProcessHandle {
	const proc = Bun.spawn(cmd ?? buildInternalSproutCommand("cell-worker"), {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	let lineHandler: (line: string) => void = () => {};
	let exitHandler: () => void = () => {};
	void (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of proc.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			let newline = buffered.indexOf("\n");
			while (newline !== -1) {
				lineHandler(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
			}
		}
	})();
	void proc.exited.then(() => exitHandler());
	return {
		pid: proc.pid,
		send(line) {
			proc.stdin.write(line);
		},
		kill() {
			proc.kill("SIGKILL");
		},
		onLine(handler) {
			lineHandler = handler;
		},
		onExit(handler) {
			exitHandler = handler;
		},
	};
}
