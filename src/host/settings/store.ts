import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { backfillRequiredMemoryModels } from "./memory-model-defaults.ts";
import type { SettingsPathOptions } from "./paths.ts";
import { buildInvalidSettingsPath, resolveSettingsPath } from "./paths.ts";
import {
	AGENT_MODEL_PURPOSES,
	type AgentModelsConfig,
	createEmptySettings,
	MEMORY_MODEL_PURPOSES,
	type MemoryModelsConfig,
	type ModelRef,
	SETTINGS_SCHEMA_VERSION,
	type SproutSettings,
	validateSproutSettings,
} from "./types.ts";
import { normalizeProviderConfig, validateProviderConfig } from "./validation.ts";

export interface SettingsLoadResult {
	settings: SproutSettings;
	recoveredInvalidFilePath?: string;
	skipEnvImport: boolean;
	source: "missing" | "loaded" | "recovered";
}

export interface SettingsStoreOptions {
	settingsPath?: string;
	pathOptions?: SettingsPathOptions;
	now?: () => string;
}

export class SettingsStore {
	private readonly settingsPath: string;
	private readonly now: () => string;

	constructor(options: SettingsStoreOptions = {}) {
		this.settingsPath = options.settingsPath ?? resolveSettingsPath(options.pathOptions);
		this.now = options.now ?? (() => new Date().toISOString().replaceAll(":", "-"));
	}

	async load(): Promise<SettingsLoadResult> {
		let raw: string;
		try {
			raw = await readFile(this.settingsPath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {
					settings: createEmptySettings(),
					skipEnvImport: false,
					source: "missing",
				};
			}
			throw error;
		}

		try {
			const settings = this.parseSettings(raw);
			return {
				settings,
				skipEnvImport: false,
				source: "loaded",
			};
		} catch {
			const recoveredInvalidFilePath = await this.recoverInvalidFile();
			return {
				settings: createEmptySettings(),
				recoveredInvalidFilePath,
				skipEnvImport: true,
				source: "recovered",
			};
		}
	}

	async save(settings: SproutSettings): Promise<void> {
		const normalized = this.normalizeSettings(settings);
		this.validateSettings(normalized);
		await mkdir(dirname(this.settingsPath), { recursive: true });
		const tempPath = `${this.settingsPath}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(normalized, null, "\t")}\n`, "utf-8");
		await rename(tempPath, this.settingsPath);
	}

	async recoverInvalidFile(): Promise<string | undefined> {
		const invalidPath = buildInvalidSettingsPath(this.settingsPath, this.now());
		try {
			await rename(this.settingsPath, invalidPath);
			return invalidPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return undefined;
			}
			throw error;
		}
	}

	private parseSettings(raw: string): SproutSettings {
		const parsed = JSON.parse(raw) as { version?: unknown };
		if (parsed.version === SETTINGS_SCHEMA_VERSION) {
			const settings = this.normalizeSettings(parsed as SproutSettings);
			this.validateSettings(settings);
			return settings;
		}
		if (parsed.version === 2) {
			const settings = this.normalizeSettings({
				...(parsed as Omit<SproutSettings, "version" | "memoryModels" | "agentModels">),
				version: SETTINGS_SCHEMA_VERSION,
				memoryModels: {},
				agentModels: {},
			} as SproutSettings);
			this.validateSettings(settings);
			return settings;
		}
		throw new Error(`Unsupported settings schema version: ${String(parsed.version)}`);
	}

	private normalizeSettings(settings: SproutSettings): SproutSettings {
		const defaults = {
			...(settings.defaults.best ? { best: settings.defaults.best } : {}),
			...(settings.defaults.balanced ? { balanced: settings.defaults.balanced } : {}),
			...(settings.defaults.fast ? { fast: settings.defaults.fast } : {}),
		};
		return {
			version: settings.version,
			providers: settings.providers.map((provider) => normalizeProviderConfig(provider)),
			defaults,
			memoryModels: backfillRequiredMemoryModels(
				defaults,
				normalizeMemoryModels(settings.memoryModels),
			),
			agentModels: normalizeAgentModels(settings.agentModels),
		};
	}

	private validateSettings(settings: SproutSettings): void {
		for (const provider of settings.providers) {
			const validation = validateProviderConfig(provider);
			if (validation.errors.length > 0) {
				throw new Error(validation.errors.join("; "));
			}
		}
		validateSproutSettings(settings);
	}
}

function normalizeMemoryModels(memoryModels: MemoryModelsConfig | undefined): MemoryModelsConfig {
	const normalized: MemoryModelsConfig = {};
	if (memoryModels === undefined) return normalized;
	if (typeof memoryModels !== "object" || memoryModels === null || Array.isArray(memoryModels)) {
		throw new Error("memoryModels must be an object");
	}
	const raw = memoryModels as Record<string, unknown>;
	for (const purpose of MEMORY_MODEL_PURPOSES) {
		if (!Object.hasOwn(raw, purpose)) continue;
		normalized[purpose] = normalizeModelRef(raw[purpose], `Memory model '${purpose}'`);
	}
	return normalized;
}

function normalizeAgentModels(agentModels: AgentModelsConfig | undefined): AgentModelsConfig {
	const normalized: AgentModelsConfig = {};
	if (agentModels === undefined) return normalized;
	if (typeof agentModels !== "object" || agentModels === null || Array.isArray(agentModels)) {
		throw new Error("agentModels must be an object");
	}
	const raw = agentModels as Record<string, unknown>;
	for (const purpose of AGENT_MODEL_PURPOSES) {
		if (!Object.hasOwn(raw, purpose)) continue;
		normalized[purpose] = normalizeModelRef(raw[purpose], `Agent model '${purpose}'`);
	}
	return normalized;
}

function normalizeModelRef(modelRef: unknown, label: string): ModelRef {
	if (typeof modelRef !== "object" || modelRef === null || Array.isArray(modelRef)) {
		throw new Error(`${label} must be a model reference object`);
	}
	const raw = modelRef as Partial<ModelRef>;
	return {
		providerId: raw.providerId as string,
		modelId: raw.modelId as string,
	};
}
