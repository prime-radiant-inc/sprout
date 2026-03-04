import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory =
	| "llm"
	| "agent"
	| "primitive"
	| "learn"
	| "compaction"
	| "session"
	| "system";

export interface LogEntry {
	timestamp: number;
	level: LogLevel;
	category: LogCategory;
	message: string;
	component: string;
	sessionId?: string;
	agentId?: string;
	depth?: number;
	data?: Record<string, unknown>;
}

export interface LogContext {
	component?: string;
	sessionId?: string;
	agentId?: string;
	depth?: number;
}

export interface Logger {
	debug(category: LogCategory, message: string, data?: Record<string, unknown>): void;
	info(category: LogCategory, message: string, data?: Record<string, unknown>): void;
	warn(category: LogCategory, message: string, data?: Record<string, unknown>): void;
	error(category: LogCategory, message: string, data?: Record<string, unknown>): void;
	child(context: LogContext): Logger;
	flush(): Promise<void>;
	reconfigure(opts: { sessionId?: string; logPath?: string }): void;
}

export interface LogEventBus {
	emitEvent(kind: string, agentId: string, depth: number, data: Record<string, unknown>): void;
}

export interface SessionLoggerOptions {
	logPath: string;
	component: string;
	sessionId?: string;
	bus?: LogEventBus;
	/** Minimum level to also emit to stderr. Omit to disable stderr logging. */
	stderrLevel?: LogLevel;
	/** Override stderr output sink (defaults to process.stderr.write). For testing. */
	stderrWrite?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** Format a log entry as a human-readable line for stderr. */
export function formatLogEntry(entry: LogEntry): string {
	const tag = `[${entry.level.toUpperCase()}]`;
	const source = entry.agentId ? `${entry.component}(${entry.agentId})` : entry.component;
	let line = `${tag} ${source}: ${entry.message}`;
	if (entry.data) {
		const pairs = Object.entries(entry.data).map(([k, v]) =>
			typeof v === "string" ? `${k}="${v}"` : `${k}=${v}`,
		);
		line += ` ${pairs.join(" ")}`;
	}
	return line;
}

interface SharedWriteFailureState {
	count: number;
	warningEventEmitted: boolean;
}

// ---------------------------------------------------------------------------
// SessionLogger
// ---------------------------------------------------------------------------

export class SessionLogger implements Logger {
	private logPath: string;
	private context: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">;
	private readonly bus?: LogEventBus;
	/** Shared write chain — parent and all children append to the same chain. */
	private writeChain: { promise: Promise<void> };
	private dirCreated: { value: boolean };
	private readonly stderrLevel?: LogLevel;
	private readonly stderrWrite?: (line: string) => void;
	private writeFailures: SharedWriteFailureState;

	constructor(options: SessionLoggerOptions);
	constructor(
		logPath: string,
		context: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">,
		bus: LogEventBus | undefined,
		writeChain: { promise: Promise<void> },
		dirCreated: { value: boolean },
		stderrLevel: LogLevel | undefined,
		stderrWrite: ((line: string) => void) | undefined,
		writeFailures: SharedWriteFailureState,
	);
	constructor(
		optionsOrPath: SessionLoggerOptions | string,
		context?: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">,
		bus?: LogEventBus,
		writeChain?: { promise: Promise<void> },
		dirCreated?: { value: boolean },
		stderrLevel?: LogLevel,
		stderrWrite?: (line: string) => void,
		writeFailures?: SharedWriteFailureState,
	) {
		if (typeof optionsOrPath === "string") {
			// Internal child constructor
			this.logPath = optionsOrPath;
			this.context = context!;
			this.bus = bus;
			this.writeChain = writeChain!;
			this.dirCreated = dirCreated!;
			this.stderrLevel = stderrLevel;
			this.stderrWrite = stderrWrite;
			this.writeFailures = writeFailures!;
		} else {
			// Public constructor
			this.logPath = optionsOrPath.logPath;
			this.context = {
				component: optionsOrPath.component,
				sessionId: optionsOrPath.sessionId,
			};
			this.bus = optionsOrPath.bus;
			this.writeChain = { promise: Promise.resolve() };
			this.dirCreated = { value: false };
			this.stderrLevel = optionsOrPath.stderrLevel;
			this.stderrWrite = optionsOrPath.stderrWrite;
			this.writeFailures = { count: 0, warningEventEmitted: false };
		}
	}

	debug(category: LogCategory, message: string, data?: Record<string, unknown>): void {
		this.log("debug", category, message, data);
	}

	info(category: LogCategory, message: string, data?: Record<string, unknown>): void {
		this.log("info", category, message, data);
	}

	warn(category: LogCategory, message: string, data?: Record<string, unknown>): void {
		this.log("warn", category, message, data);
	}

	error(category: LogCategory, message: string, data?: Record<string, unknown>): void {
		this.log("error", category, message, data);
	}

	child(context: LogContext): SessionLogger {
		const merged = { ...this.context, ...context };
		// Remove undefined values so they don't shadow parent context
		for (const key of Object.keys(merged) as (keyof typeof merged)[]) {
			if (merged[key] === undefined) delete merged[key];
		}
		return new SessionLogger(
			this.logPath,
			merged as Required<Pick<LogContext, "component">> & Omit<LogContext, "component">,
			this.bus,
			this.writeChain,
			this.dirCreated, // Shared reference — parent and child share mkdir state
			this.stderrLevel,
			this.stderrWrite,
			this.writeFailures,
		);
	}

	/**
	 * Update sessionId and/or logPath for subsequent writes.
	 * Does NOT propagate to existing child loggers — callers must ensure
	 * no live children depend on the old values (e.g. /clear destroys the
	 * current agent before the next submitGoal creates a new one).
	 */
	reconfigure(opts: { sessionId?: string; logPath?: string }): void {
		if (opts.sessionId !== undefined) {
			this.context.sessionId = opts.sessionId;
		}
		if (opts.logPath !== undefined) {
			this.logPath = opts.logPath;
			// New object so in-flight writes to the old path keep the old flag
			this.dirCreated = { value: false };
		}
	}

	async flush(): Promise<void> {
		await this.writeChain.promise;
	}

	private log(
		level: LogLevel,
		category: LogCategory,
		message: string,
		data?: Record<string, unknown>,
	): void {
		const entry: LogEntry = {
			timestamp: Date.now(),
			level,
			category,
			message,
			component: this.context.component,
			...(this.context.sessionId !== undefined && { sessionId: this.context.sessionId }),
			...(this.context.agentId !== undefined && { agentId: this.context.agentId }),
			...(this.context.depth !== undefined && { depth: this.context.depth }),
			...(data !== undefined && { data }),
		};

		// Forward info+ to bus
		if (this.bus && level !== "debug") {
			try {
				this.bus.emitEvent(
					"log",
					this.context.agentId ?? "",
					this.context.depth ?? 0,
					entry as unknown as Record<string, unknown>,
				);
			} catch {
				// Never throw from logging
			}
		}

		// Write to stderr if level meets threshold
		if (this.stderrLevel && LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.stderrLevel]) {
			this.writeStderr(`${formatLogEntry(entry)}\n`);
		}

		// Capture logPath and dirCreated at call time so reconfigure() between
		// log() and the async write doesn't redirect in-flight entries.
		const logPath = this.logPath;
		const dirCreated = this.dirCreated;
		const line = `${JSON.stringify(entry)}\n`;
		this.writeChain.promise = this.writeChain.promise
			.then(async () => {
				if (!dirCreated.value) {
					await mkdir(dirname(logPath), { recursive: true });
					dirCreated.value = true;
				}
				await appendFile(logPath, line);
			})
			.catch((err) => {
				this.handleWriteFailure(logPath, err);
			});
	}

	private writeStderr(line: string): void {
		const write = this.stderrWrite ?? ((s: string) => process.stderr.write(s));
		try {
			write(line);
		} catch {
			// Never throw from logging
		}
	}

	private handleWriteFailure(logPath: string, err: unknown): void {
		this.writeFailures.count += 1;
		const count = this.writeFailures.count;
		const errorText = err instanceof Error ? err.message : String(err);
		this.writeStderr(
			`[WARN] logger: failed to write session log path="${logPath}" failures=${count} error="${errorText}"\n`,
		);

		if (!this.bus || this.writeFailures.warningEventEmitted) return;
		this.writeFailures.warningEventEmitted = true;
		try {
			this.bus.emitEvent("warning", "logger", 0, {
				message: "Session logger failed to write to disk; continuing with stderr fallback.",
				log_path: logPath,
				failure_count: count,
				error: errorText,
			});
		} catch {
			// Never throw from logging
		}
	}
}

// ---------------------------------------------------------------------------
// NullLogger — no-op implementation for tests
// ---------------------------------------------------------------------------

export class NullLogger implements Logger {
	debug(_category: LogCategory, _message: string, _data?: Record<string, unknown>): void {}
	info(_category: LogCategory, _message: string, _data?: Record<string, unknown>): void {}
	warn(_category: LogCategory, _message: string, _data?: Record<string, unknown>): void {}
	error(_category: LogCategory, _message: string, _data?: Record<string, unknown>): void {}
	child(_context: LogContext): NullLogger {
		return this;
	}
	async flush(): Promise<void> {}
	reconfigure(_opts: { sessionId?: string; logPath?: string }): void {}
}
