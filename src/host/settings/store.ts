import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SettingsPathOptions } from "./paths.ts";
import { buildInvalidSettingsPath, resolveSettingsPath } from "./paths.ts";
import {
	createEmptySettings,
	MEMORY_MODEL_PURPOSES,
	SETTINGS_SCHEMA_VERSION,
	type MemoryModelsConfig,
	type ModelRef,
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
				...(parsed as Omit<SproutSettings, "version" | "memoryModels">),
				version: SETTINGS_SCHEMA_VERSION,
				memoryModels: {},
			} as SproutSettings);
			this.validateSettings(settings);
			return settings;
		}
		throw new Error(`Unsupported settings schema version: ${String(parsed.version)}`);
	}

	private normalizeSettings(settings: SproutSettings): SproutSettings {
		return {
			version: settings.version,
			providers: settings.providers.map((provider) => normalizeProviderConfig(provider)),
			defaults: {
				...(settings.defaults.best ? { best: settings.defaults.best } : {}),
				...(settings.defaults.balanced ? { balanced: settings.defaults.balanced } : {}),
				...(settings.defaults.fast ? { fast: settings.defaults.fast } : {}),
			},
			memoryModels: normalizeMemoryModels(settings.memoryModels),
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
	if (!memoryModels) return normalized;
	const raw = memoryModels as Record<string, unknown>;
	for (const purpose of MEMORY_MODEL_PURPOSES) {
		if (!Object.hasOwn(raw, purpose)) continue;
		normalized[purpose] = normalizeModelRef(raw[purpose], purpose);
	}
	return normalized;
}

function normalizeModelRef(modelRef: unknown, purpose: string): ModelRef {
	if (typeof modelRef !== "object" || modelRef === null || Array.isArray(modelRef)) {
		throw new Error(`Memory model '${purpose}' must be a model reference object`);
	}
	const raw = modelRef as Partial<ModelRef>;
	return {
		providerId: raw.providerId as string,
		modelId: raw.modelId as string,
	};
}
