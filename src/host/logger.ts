import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionBus } from "./event-bus.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory = "system" | "llm" | "agent" | "web" | "tool";

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
	private readonly logPath: string;
	private readonly context: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">;
	private readonly bus?: SessionBus;
	/** Shared write chain — parent and all children append to the same chain. */
	private writeChain: { promise: Promise<void> };
	private dirCreated = false;

	constructor(options: SessionLoggerOptions);
	constructor(
		logPath: string,
		context: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">,
		bus: SessionBus | undefined,
		writeChain: { promise: Promise<void> },
		dirCreated: boolean,
	);
	constructor(
		optionsOrPath: SessionLoggerOptions | string,
		context?: Required<Pick<LogContext, "component">> & Omit<LogContext, "component">,
		bus?: SessionBus,
		writeChain?: { promise: Promise<void> },
		dirCreated?: boolean,
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
			this.dirCreated,
		);
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
					"log" as any,
					this.context.agentId ?? "",
					this.context.depth ?? 0,
					entry as unknown as Record<string, unknown>,
				);
			} catch {
				// Never throw from logging
			}
		}

		// Append to disk via shared write chain
		const line = `${JSON.stringify(entry)}\n`;
		this.writeChain.promise = this.writeChain.promise
			.then(async () => {
				if (!this.dirCreated) {
					await mkdir(dirname(this.logPath), { recursive: true });
					this.dirCreated = true;
				}
				await appendFile(this.logPath, line);
			})
			.catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// NullLogger — no-op implementation for tests
// ---------------------------------------------------------------------------

export class NullLogger implements Logger {
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
	child(): NullLogger {
		return this;
	}
	async flush(): Promise<void> {}
}
