import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { JsonlStore } from "./jsonl-store.ts";

export type ProjectDetectionSource =
	| "explicit"
	| "metadata"
	| "package"
	| "remote"
	| "git"
	| "unknown";

export interface ProjectDetectionInput {
	explicitProject?: string;
	metadataProject?: string;
	cwd?: string;
	gitRoot?: string;
	packageName?: string;
	remoteUrl?: string;
}

export interface DetectedProject {
	id: string;
	name: string;
	confidence: number;
	source: ProjectDetectionSource;
	remote?: string;
}

export interface ProjectActivityRecord {
	id: string;
	name: string;
	cumulative_active_days: number;
	last_active_date?: string;
	last_consolidated_active_day?: number;
	last_entity_gc_active_day?: number;
}

export interface ProjectActivityStoreOptions {
	timeZone?: string;
}

const UNKNOWN_PROJECT: DetectedProject = {
	id: "unknown",
	name: "unknown",
	confidence: 0,
	source: "unknown",
};

const GENERIC_PROJECT_NAMES = new Set([
	"",
	".",
	"app",
	"code",
	"project",
	"repo",
	"src",
	"tmp",
	"workspace",
	"worktree",
]);

export class ProjectActivityStore {
	private entries: ProjectActivityRecord[] = [];
	private readonly jsonl: JsonlStore<unknown>;
	private readonly timeZone: string | undefined;

	constructor(jsonlPath: string, options: ProjectActivityStoreOptions = {}) {
		this.jsonl = new JsonlStore(jsonlPath);
		this.timeZone = options.timeZone;
	}

	async load(): Promise<void> {
		this.entries = (await this.jsonl.load()).map(normalizeProjectActivityRecord);
	}

	all(): ProjectActivityRecord[] {
		return [...this.entries];
	}

	getById(id: string): ProjectActivityRecord | undefined {
		return this.entries.find((entry) => entry.id === id);
	}

	recordActiveDay(project: DetectedProject, date: Date): ProjectActivityRecord | undefined {
		if (project.id === "unknown" || project.id === "global") return undefined;
		const activeDate = projectActivityDateKey(date, this.timeZone);
		let record = this.getById(project.id);
		if (!record) {
			record = {
				id: project.id,
				name: project.name,
				cumulative_active_days: 0,
			};
			this.entries.push(record);
		}
		record.name = project.name;
		if (record.last_active_date !== activeDate) {
			record.cumulative_active_days += 1;
			record.last_active_date = activeDate;
		}
		return record;
	}

	markConsolidated(projectId: string): ProjectActivityRecord | undefined {
		const record = this.getById(projectId);
		if (!record) return undefined;
		record.last_consolidated_active_day = record.cumulative_active_days;
		return record;
	}

	markEntityGc(projectId: string): ProjectActivityRecord | undefined {
		const record = this.getById(projectId);
		if (!record) return undefined;
		record.last_entity_gc_active_day = record.cumulative_active_days;
		return record;
	}

	async save(): Promise<void> {
		await this.jsonl.rewrite(this.entries);
	}
}

export function projectActivityDateKey(date: Date, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "00";
	return `${part("year")}-${part("month")}-${part("day")}`;
}

export function detectProject(input: ProjectDetectionInput): DetectedProject {
	const explicit = explicitProject(input.explicitProject, "explicit");
	if (explicit) return explicit;
	const metadata = explicitProject(input.metadataProject, "metadata");
	if (metadata) return metadata;

	const packageProject = packageProjectName(input.packageName);
	if (packageProject) return packageProject;

	const remoteProject = remoteProjectName(input.remoteUrl);
	if (remoteProject) return remoteProject;

	const rootName = input.gitRoot ? basename(input.gitRoot) : input.cwd ? basename(input.cwd) : "";
	if (isUsefulName(rootName)) {
		return {
			id: projectId(rootName),
			name: rootName,
			confidence: 0.7,
			source: "git",
		};
	}

	return { ...UNKNOWN_PROJECT };
}

export async function detectProjectFromCwd(input: {
	cwd: string;
	explicitProject?: string;
	metadataProject?: string;
}): Promise<DetectedProject> {
	const explicit = explicitProject(input.explicitProject, "explicit");
	if (explicit) return explicit;
	const metadata = explicitProject(input.metadataProject, "metadata");
	if (metadata) return metadata;

	const [gitRoot, packageName, remoteUrl] = await Promise.all([
		readGitValue(input.cwd, ["rev-parse", "--show-toplevel"]),
		readPackageName(input.cwd),
		readGitValue(input.cwd, ["config", "--get", "remote.origin.url"]),
	]);

	return detectProject({
		cwd: input.cwd,
		gitRoot,
		packageName,
		remoteUrl,
	});
}

function explicitProject(
	value: string | undefined,
	source: "explicit" | "metadata",
): DetectedProject | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return {
		id: projectId(trimmed),
		name: trimmed,
		confidence: source === "explicit" ? 1 : 0.95,
		source,
	};
}

function packageProjectName(value: string | undefined): DetectedProject | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.startsWith("@") ? trimmed.slice(1).replace("/", "-") : trimmed;
	if (!isUsefulName(normalized)) return undefined;
	return {
		id: projectId(normalized),
		name: normalized,
		confidence: 0.85,
		source: "package",
	};
}

function remoteProjectName(value: string | undefined): DetectedProject | undefined {
	const remote = normalizeRemote(value);
	if (!remote) return undefined;
	const repoName = remote.split("/").at(-1) ?? "";
	if (!isUsefulName(repoName)) return undefined;
	return {
		id: projectId(remote),
		name: repoName,
		confidence: 0.9,
		source: "remote",
		remote,
	};
}

function normalizeRemote(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const sshMatch = /^git@([^:]+):(.+)$/.exec(trimmed);
	const remotePath = sshMatch ? sshMatch[2] : trimmed.replace(/^https?:\/\/[^/]+\//, "");
	const withoutGit = remotePath?.replace(/\.git$/, "");
	const parts = withoutGit?.split("/").filter(Boolean);
	if (!parts || parts.length < 2) return undefined;
	return parts.slice(-2).join("/").toLowerCase();
}

async function readPackageName(cwd: string): Promise<string | undefined> {
	try {
		const raw = await readFile(`${cwd}/package.json`, "utf-8");
		const parsed = JSON.parse(raw) as { name?: unknown };
		return typeof parsed.name === "string" ? parsed.name : undefined;
	} catch {
		return undefined;
	}
}

async function readGitValue(cwd: string, args: string[]): Promise<string | undefined> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return undefined;
	const trimmed = stdout.trim();
	return trimmed ? trimmed : undefined;
}

function projectId(value: string): string {
	return value
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "")
		.slice(0, 96);
}

function normalizeProjectActivityRecord(raw: unknown): ProjectActivityRecord {
	if (!isRecord(raw)) throw new Error("Project activity record must be an object");
	const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : undefined;
	if (!id) throw new Error("Project activity record is missing id");
	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : id;
	const days =
		typeof raw.cumulative_active_days === "number" && Number.isFinite(raw.cumulative_active_days)
			? raw.cumulative_active_days
			: 0;
	const lastActiveDate =
		typeof raw.last_active_date === "string" && raw.last_active_date.trim()
			? raw.last_active_date
			: undefined;
	return {
		id,
		name,
		cumulative_active_days: Math.max(0, Math.floor(days)),
		...(lastActiveDate ? { last_active_date: lastActiveDate } : {}),
		...numberField(raw, "last_consolidated_active_day"),
		...numberField(raw, "last_entity_gc_active_day"),
	};
}

function numberField(raw: Record<string, unknown>, key: string): Record<string, number> {
	const value = raw[key];
	if (typeof value !== "number" || !Number.isFinite(value)) return {};
	return { [key]: Math.max(0, Math.floor(value)) };
}

function isUsefulName(value: string): boolean {
	const id = projectId(value);
	return id.length >= 3 && !GENERIC_PROJECT_NAMES.has(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
