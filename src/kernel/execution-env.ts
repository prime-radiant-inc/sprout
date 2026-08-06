import { spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform, release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

/** One structured grep match — capture binds these as a JSON value. */
export interface GrepStructuredMatch {
	path: string;
	line: number;
	text: string;
}

/**
 * Render raw file content as read_file's line-numbered output. The single
 * rendering implementation — both the plain read path and the capture wrapper
 * use it, so captured raw bytes and rendered output can never diverge.
 */
export function renderReadFile(content: string, startLine = 1): string {
	return content
		.split("\n")
		.map((line, i) => `${startLine + i}\t${line}`)
		.join("\n");
}

/**
 * Parse rg/grep `path:line:text` output into structured matches. Splits on the
 * first two colons only, so colons in the matched text survive.
 */
function parseGrepOutput(raw: string): GrepStructuredMatch[] {
	const matches: GrepStructuredMatch[] = [];
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		const first = line.indexOf(":");
		if (first === -1) continue;
		const second = line.indexOf(":", first + 1);
		if (second === -1) continue;
		const lineNumber = Number(line.slice(first + 1, second));
		if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
		matches.push({ path: line.slice(0, first), line: lineNumber, text: line.slice(second + 1) });
	}
	return matches;
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
	// Control-plane endpoints (not secrets, but reachability): model-authored shell must not
	// be able to speak raw bus or authenticated-channel protocol. The per-handle token is
	// already covered by /_TOKEN$/; identifiers like SPROUT_HANDLE_ID are not filtered.
	/^SPROUT_BUS_URL$/i,
	/^SPROUT_AUTH_URL$/i,
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

function isCommandNotFound(result: ExecResult): boolean {
	return result.exit_code === 127 || /command not found|not found/i.test(result.stderr);
}

/**
 * Abstract execution environment interface.
 * Decouples tool logic from where it runs.
 */
export interface ExecutionEnvironment {
	read_file(path: string, options?: ReadFileOptions): Promise<string>;
	/**
	 * The raw bytes of exactly what read_file would render — same offset/limit
	 * slice, no line numbering. Optional: capture requires it and skips
	 * gracefully on environments that don't provide it.
	 */
	read_file_raw?(path: string, options?: ReadFileOptions): Promise<string>;
	write_file(path: string, content: string): Promise<void>;
	file_exists(path: string): Promise<boolean>;
	exec_command(command: string, options?: ExecOptions): Promise<ExecResult>;
	grep(pattern: string, path?: string, options?: GrepOptions): Promise<string>;
	/**
	 * grep's matches in structured form. Optional: capture requires it and
	 * skips gracefully on environments that don't provide it.
	 */
	grep_structured?(
		pattern: string,
		path?: string,
		options?: GrepOptions,
	): Promise<GrepStructuredMatch[]>;
	glob(pattern: string, path?: string): Promise<string[]>;
	working_directory(): string;
	platform(): string;
	os_version(): string;
	/** Add a directory to PATH for all exec_command calls. */
	addToPath?(dir: string): void;
}

/**
 * Local filesystem execution environment.
 * All paths are resolved relative to the working directory.
 */
export class LocalExecutionEnvironment implements ExecutionEnvironment {
	private readonly workDir: string;
	private readonly extraPathDirs: string[] = [];

	constructor(workingDirectory: string) {
		this.workDir = resolve(workingDirectory);
	}

	/** Add a directory to PATH for all exec_command calls (e.g., agent tools dir). */
	addToPath(dir: string): void {
		if (!this.extraPathDirs.includes(dir)) {
			this.extraPathDirs.push(dir);
		}
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
		if (path.startsWith("~/")) return join(homedir(), path.slice(2));
		if (path === "~") return homedir();
		return join(this.workDir, path);
	}

	async read_file(path: string, options?: ReadFileOptions): Promise<string> {
		return renderReadFile(await this.read_file_raw(path, options), options?.offset ?? 1);
	}

	async read_file_raw(path: string, options?: ReadFileOptions): Promise<string> {
		const fullPath = this.resolvePath(path);
		const content = await readFile(fullPath, "utf-8");
		const lines = content.split("\n");

		const offset = (options?.offset ?? 1) - 1; // convert 1-based to 0-based
		const limit = options?.limit ?? lines.length;
		return lines.slice(offset, offset + limit).join("\n");
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
		const requestedCwd = options?.working_dir
			? this.resolvePath(options.working_dir)
			: this.workDir;
		const cwd = await realpath(requestedCwd).catch(() => requestedCwd);
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
			: { ...baseEnv };

		// Prepend extra PATH directories (agent workspace tools, etc.)
		if (this.extraPathDirs.length > 0) {
			mergedEnv.PATH = [...this.extraPathDirs, mergedEnv.PATH ?? ""].join(":");
		}
		mergedEnv.PWD = cwd;

		const start = performance.now();

		return new Promise<ExecResult>((resolve) => {
			const proc = spawn("/bin/bash", ["-c", command], {
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
		// -H forces the file path even for a single explicit file, where rg/grep
		// would otherwise print bare `line:text` and structured parsing would
		// drop every match.
		const rgArgs = [
			"--line-number",
			"--with-filename",
			"--fixed-strings",
			"--color",
			"never",
			"--no-heading",
		];

		if (options?.case_insensitive) rgArgs.push("-i");
		if (options?.max_results) rgArgs.push("-m", String(options.max_results));
		if (options?.glob_filter) rgArgs.push("-g", options.glob_filter);
		rgArgs.push("--", pattern, searchPath);

		const rgResult = await this.exec_command(`rg ${rgArgs.map(shellEscape).join(" ")}`, {
			timeout_ms: 10_000,
		});
		if (rgResult.exit_code <= 1) {
			return rgResult.stdout;
		}
		if (!isCommandNotFound(rgResult)) {
			throw new Error(`grep failed: ${rgResult.stderr}`);
		}

		const args = ["--line-number", "-H", "-F"];

		if (options?.case_insensitive) args.push("-i");
		if (options?.max_results) args.push("-m", String(options.max_results));
		if (options?.glob_filter) args.push("--include", options.glob_filter);

		args.push("-r", "--", pattern, searchPath);

		const result = await this.exec_command(`grep ${args.map(shellEscape).join(" ")}`, {
			timeout_ms: 10_000,
		});

		// grep returns exit code 1 for no matches, which is fine
		if (result.exit_code > 1) {
			throw new Error(`grep failed: ${result.stderr}`);
		}

		return result.stdout;
	}

	async grep_structured(
		pattern: string,
		path?: string,
		options?: GrepOptions,
	): Promise<GrepStructuredMatch[]> {
		// One rg/grep run, parsed — capture and rendering share this result.
		return parseGrepOutput(await this.grep(pattern, path, options));
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
				const fullPath = isAbsolute(m) ? m : join(basePath, m);
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
