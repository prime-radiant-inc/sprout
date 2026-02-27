import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionBus } from "./event-bus.ts";

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

export interface SessionLoggerOptions {
	logPath: string;
	component: string;
	sessionId?: string;
	bus?: SessionBus;
}

// ---------------------------------------------------------------------------
// SessionLogger
// ---------------------------------------------------------------------------

export class SessionLogger implements Logger {
	private logPath: string;
	private context: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">;
	private readonly bus?: SessionBus;
	/** Shared write chain — parent and all children append to the same chain. */
	private writeChain: { promise: Promise<void> };
	private dirCreated: { value: boolean };

	constructor(options: SessionLoggerOptions);
	constructor(
		logPath: string,
		context: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">,
		bus: SessionBus | undefined,
		writeChain: { promise: Promise<void> },
		dirCreated: { value: boolean },
	);
	constructor(
		optionsOrPath: SessionLoggerOptions | string,
		context?: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">,
		bus?: SessionBus,
		writeChain?: { promise: Promise<void> },
		dirCreated?: { value: boolean },
	) {
		if (typeof optionsOrPath === "string") {
			// Internal child constructor
			this.logPath = optionsOrPath;
			this.context = context!;
			this.bus = bus;
			this.writeChain = writeChain!;
			this.dirCreated = dirCreated!;
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
			.catch(() => {});
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
