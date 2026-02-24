import { spawn } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { platform as osPlatform, release } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ExecResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	timed_out: boolean;
	duration_ms: number;
}

export interface ExecOptions {
	timeout_ms?: number;
	working_dir?: string;
	env_vars?: Record<string, string>;
	signal?: AbortSignal;
}

export interface ReadFileOptions {
	offset?: number;
	limit?: number;
}

export interface GrepOptions {
	glob_filter?: string;
	case_insensitive?: boolean;
	max_results?: number;
}

/** Sensitive env var patterns to exclude by default */
const SENSITIVE_PATTERNS = [
	/_API_KEY$/i,
	/_SECRET$/i,
	/_TOKEN$/i,
	/_PASSWORD$/i,
	/_CREDENTIAL$/i,
	/^ANTHROPIC_API_KEY$/i,
	/^OPENAI_API_KEY$/i,
	/^GEMINI_API_KEY$/i,
];

function filterEnvVars(env: Record<string, string | undefined>): Record<string, string> {
	const filtered: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const isSensitive = SENSITIVE_PATTERNS.some((p) => p.test(key));
		if (!isSensitive) {
			filtered[key] = value;
		}
	}
	return filtered;
}

/**
 * Abstract execution environment interface.
 * Decouples tool logic from where it runs.
 */
export interface ExecutionEnvironment {
	read_file(path: string, options?: ReadFileOptions): Promise<string>;
	write_file(path: string, content: string): Promise<void>;
	file_exists(path: string): Promise<boolean>;
	exec_command(command: string, options?: ExecOptions): Promise<ExecResult>;
	grep(pattern: string, path?: string, options?: GrepOptions): Promise<string>;
	glob(pattern: string, path?: string): Promise<string[]>;
	working_directory(): string;
	platform(): string;
	os_version(): string;
}

/**
 * Local filesystem execution environment.
 * All paths are resolved relative to the working directory.
 */
export class LocalExecutionEnvironment implements ExecutionEnvironment {
	private readonly workDir: string;

	constructor(workingDirectory: string) {
		this.workDir = resolve(workingDirectory);
	}

	working_directory(): string {
		return this.workDir;
	}

	platform(): string {
		const p = osPlatform();
		if (p === "darwin") return "darwin";
		if (p === "win32") return "windows";
		return "linux";
	}

	os_version(): string {
		return release();
	}

	private resolvePath(path: string): string {
		if (path.startsWith("/")) return path;
		return join(this.workDir, path);
	}

	async read_file(path: string, options?: ReadFileOptions): Promise<string> {
		const fullPath = this.resolvePath(path);
		const content = await readFile(fullPath, "utf-8");
		const lines = content.split("\n");

		const offset = (options?.offset ?? 1) - 1; // convert 1-based to 0-based
		const limit = options?.limit ?? lines.length;
		const sliced = lines.slice(offset, offset + limit);

		// Return line-numbered output
		return sliced.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
	}

	async write_file(path: string, content: string): Promise<void> {
		const fullPath = this.resolvePath(path);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content, "utf-8");
	}

	async file_exists(path: string): Promise<boolean> {
		try {
			await access(this.resolvePath(path));
			return true;
		} catch {
			return false;
		}
	}

	async exec_command(command: string, options?: ExecOptions): Promise<ExecResult> {
		const cwd = options?.working_dir ? this.resolvePath(options.working_dir) : this.workDir;
		const timeout = options?.timeout_ms ?? 10_000;
		const signal = options?.signal;

		// Short-circuit if already aborted
		if (signal?.aborted) {
			return {
				stdout: "",
				stderr: "Aborted",
				exit_code: 130,
				timed_out: false,
				duration_ms: 0,
			};
		}

		// Build environment: start from filtered process env, merge user-provided vars
		const baseEnv = filterEnvVars(process.env);
		const mergedEnv = options?.env_vars
			? { ...baseEnv, ...filterEnvVars(options.env_vars) }
			: baseEnv;

		const start = performance.now();

		return new Promise<ExecResult>((resolve) => {
			const proc = spawn("/bin/sh", ["-c", command], {
				cwd,
				env: mergedEnv,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true, // new process group for clean killing
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let settled = false;

			proc.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			const timer = setTimeout(() => {
				timedOut = true;
				// Kill the process group
				try {
					process.kill(-proc.pid!, "SIGTERM");
				} catch {
					// Process may have already exited
				}
				setTimeout(() => {
					try {
						process.kill(-proc.pid!, "SIGKILL");
					} catch {
						// Already dead
					}
				}, 2000);
			}, timeout);

			// Kill child process on abort signal
			const onAbort = () => {
				try {
					process.kill(-proc.pid!, "SIGTERM");
				} catch {
					// Process may have already exited
				}
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			proc.on("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve({
					stdout,
					stderr,
					exit_code: code ?? 1,
					timed_out: timedOut,
					duration_ms: Math.round(performance.now() - start),
				});
			});

			proc.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve({
					stdout,
					stderr: stderr + err.message,
					exit_code: 1,
					timed_out: false,
					duration_ms: Math.round(performance.now() - start),
				});
			});
		});
	}

	async grep(pattern: string, path?: string, options?: GrepOptions): Promise<string> {
		const searchPath = path ? this.resolvePath(path) : this.workDir;
		const args = ["--line-number"];

		if (options?.case_insensitive) args.push("-i");
		if (options?.max_results) args.push("-m", String(options.max_results));
		if (options?.glob_filter) args.push("--include", options.glob_filter);

		args.push("-r", pattern, searchPath);

		const result = await this.exec_command(`grep ${args.map(shellEscape).join(" ")}`, {
			timeout_ms: 10_000,
		});

		// grep returns exit code 1 for no matches, which is fine
		if (result.exit_code > 1) {
			throw new Error(`grep failed: ${result.stderr}`);
		}

		return result.stdout;
	}

	async glob(pattern: string, _path?: string): Promise<string[]> {
		const g = new Bun.Glob(pattern);
		const basePath = _path ? this.resolvePath(_path) : this.workDir;
		const matches: string[] = [];

		for await (const match of g.scan({ cwd: basePath, absolute: false })) {
			matches.push(match);
		}

		// Sort by modification time (newest first) - need stat calls
		if (matches.length === 0) return [];

		const withStats = await Promise.all(
			matches.map(async (m) => {
				const fullPath = join(basePath, m);
				const s = await stat(fullPath);
				return { path: m, mtime: s.mtimeMs };
			}),
		);

		withStats.sort((a, b) => b.mtime - a.mtime);
		return withStats.map((w) => w.path);
	}
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
