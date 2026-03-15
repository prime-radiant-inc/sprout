import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { replayPathFromLogBase } from "./paths.ts";
import type { ReplayTurnRecord } from "./types.ts";

export interface CreateReplayRecorderOptions {
	logBasePath: string;
}

export class ReplayRecorder {
	readonly outputPath: string;
	private writeChain: Promise<void> = Promise.resolve();
	private dirReady = false;

	constructor(options: CreateReplayRecorderOptions) {
		this.outputPath = replayPathFromLogBase(options.logBasePath);
	}

	async record(record: ReplayTurnRecord): Promise<void> {
		const sanitized = sanitizeReplayRecord(record);
		const line = `${JSON.stringify(sanitized)}\n`;
		this.writeChain = this.writeChain.then(async () => {
			if (!this.dirReady) {
				await mkdir(dirname(this.outputPath), { recursive: true });
				this.dirReady = true;
			}
			await appendFile(this.outputPath, line);
		});
		return this.writeChain;
	}

	async flush(): Promise<void> {
		await this.writeChain;
	}

	async close(): Promise<void> {
		await this.flush();
	}
}

export function createReplayRecorder(options: CreateReplayRecorderOptions): ReplayRecorder {
	return new ReplayRecorder(options);
}

function sanitizeReplayRecord(record: ReplayTurnRecord): ReplayTurnRecord {
	return {
		...record,
		request: { ...record.request },
	};
}
