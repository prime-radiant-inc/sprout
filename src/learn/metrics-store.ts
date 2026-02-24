import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StumbleEntry {
	type: "stumble";
	agent_name: string;
	kind: string;
	timestamp: number;
}

interface ActionEntry {
	type: "action";
	agent_name: string;
	timestamp: number;
}

type MetricsEntry = StumbleEntry | ActionEntry;

export class MetricsStore {
	private stumbles = new Map<string, number>();
	private totalStumbles = new Map<string, number>();
	private actions = new Map<string, number>();
	private readonly path: string;

	constructor(jsonlPath: string) {
		this.path = jsonlPath;
	}

	/** Read JSONL lines from disk, rebuilding in-memory maps. */
	async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf-8");
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return;
			}
			throw err;
		}

		this.stumbles.clear();
		this.totalStumbles.clear();
		this.actions.clear();

		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			const entry = JSON.parse(line) as MetricsEntry;
			if (entry.type === "stumble") {
				this.incrementStumble(entry.agent_name, entry.kind);
			} else if (entry.type === "action") {
				this.incrementAction(entry.agent_name);
			}
		}
	}

	/** Increment stumble count and append to disk. */
	async recordStumble(agentName: string, kind: string): Promise<void> {
		this.incrementStumble(agentName, kind);
		const entry: StumbleEntry = {
			type: "stumble",
			agent_name: agentName,
			kind,
			timestamp: Date.now(),
		};
		await this.append(entry);
	}

	/** Return stumble count for a given agent+kind pair, 0 if unknown. */
	stumbleCount(agentName: string, kind: string): number {
		return this.stumbles.get(`${agentName}:${kind}`) ?? 0;
	}

	/** Increment action count and append to disk. */
	async recordAction(agentName: string): Promise<void> {
		this.incrementAction(agentName);
		const entry: ActionEntry = {
			type: "action",
			agent_name: agentName,
			timestamp: Date.now(),
		};
		await this.append(entry);
	}

	/** Return total action count for an agent, 0 if unknown. */
	totalActions(agentName: string): number {
		return this.actions.get(agentName) ?? 0;
	}

	/** Return ratio of total stumbles to total actions for an agent, 0 if no actions. */
	stumbleRate(agentName: string): number {
		const actionCount = this.actions.get(agentName) ?? 0;
		if (actionCount === 0) return 0;
		const stumbleTotal = this.totalStumbles.get(agentName) ?? 0;
		return stumbleTotal / actionCount;
	}

	/** Count actions for an agent since a given timestamp, scanning the JSONL on disk. */
	async actionCountSince(agentName: string, since: number): Promise<number> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf-8");
		} catch {
			return 0;
		}

		let count = 0;
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			const entry = JSON.parse(line) as MetricsEntry;
			if (entry.type !== "action") continue;
			if (entry.agent_name !== agentName) continue;
			if (entry.timestamp >= since) count++;
		}
		return count;
	}

	/** Return stumble rate for an agent within a time window, scanning the JSONL on disk. */
	async stumbleRateForPeriod(agentName: string, since: number, until?: number): Promise<number> {
		const end = until ?? Date.now();
		let raw: string;
		try {
			raw = await readFile(this.path, "utf-8");
		} catch {
			return 0;
		}

		let stumbles = 0;
		let actions = 0;

		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			const entry = JSON.parse(line) as MetricsEntry;
			if (entry.timestamp < since || entry.timestamp > end) continue;
			if (entry.agent_name !== agentName) continue;

			if (entry.type === "stumble") stumbles++;
			else if (entry.type === "action") actions++;
		}

		return actions === 0 ? 0 : stumbles / actions;
	}

	private incrementStumble(agentName: string, kind: string): void {
		const key = `${agentName}:${kind}`;
		this.stumbles.set(key, (this.stumbles.get(key) ?? 0) + 1);
		this.totalStumbles.set(agentName, (this.totalStumbles.get(agentName) ?? 0) + 1);
	}

	private incrementAction(agentName: string): void {
		this.actions.set(agentName, (this.actions.get(agentName) ?? 0) + 1);
	}

	private async append(entry: MetricsEntry): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${JSON.stringify(entry)}\n`);
	}
}
