import { readFile } from "node:fs/promises";
import { basename } from "node:path";

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

function isUsefulName(value: string): boolean {
	const id = projectId(value);
	return id.length >= 3 && !GENERIC_PROJECT_NAMES.has(id);
}
