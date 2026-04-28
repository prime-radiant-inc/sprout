import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SettingsPathOptions } from "./paths.ts";
import { buildInvalidSettingsPath, resolveSettingsPath } from "./paths.ts";
import {
	type AgentModelOverride,
	type AgentModelOverridesConfig,
	createEmptySettings,
	MEMORY_MODEL_PURPOSES,
	type MemoryModelsConfig,
	type ModelRef,
	SETTINGS_SCHEMA_VERSION,
	type SproutSettings,
	validateSproutSettings,
} from "./types.ts";
import { normalizeProviderConfig, validateProviderConfig } from "./validation.ts";

interface SproutSettingsV3 {
	version: 3;
	providers: SproutSettings["providers"];
	defaults: SproutSettings["defaults"];
	memoryModels?: MemoryModelsConfig;
	agentModels?: Partial<Record<"observer.metacognitive", ModelRef>>;
}

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
		if (parsed.version === 3) {
			const settings = this.migrateV3Settings(parsed as SproutSettingsV3);
			this.validateSettings(settings);
			return settings;
		}
		throw new Error(`Unsupported settings schema version: ${String(parsed.version)}`);
	}

	private migrateV3Settings(settings: SproutSettingsV3): SproutSettings {
		return this.normalizeSettings({
			version: SETTINGS_SCHEMA_VERSION,
			providers: settings.providers,
			defaults: settings.defaults,
			memoryModels: migrateV3MemoryModels(settings.defaults, settings.memoryModels),
			agentModelOverrides: migrateV3AgentModels(settings.agentModels),
		});
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
			memoryModels: normalizeMemoryModels(settings.memoryModels),
			agentModelOverrides: normalizeAgentModelOverrides(settings.agentModelOverrides),
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

function migrateV3MemoryModels(
	defaults: SproutSettingsV3["defaults"],
	memoryModels: MemoryModelsConfig | undefined,
): MemoryModelsConfig {
	const normalized = normalizeMemoryModels(memoryModels);
	if (!normalized.subcortical) {
		const modelRef = defaults.fast ?? defaults.balanced ?? defaults.best;
		if (modelRef) {
			normalized.subcortical = {
				providerId: modelRef.providerId,
				modelId: modelRef.modelId,
			};
		}
	}
	return normalized;
}

function normalizeAgentModelOverrides(
	agentModelOverrides: AgentModelOverridesConfig | undefined,
): AgentModelOverridesConfig {
	const normalized: AgentModelOverridesConfig = {};
	if (agentModelOverrides === undefined) return normalized;
	if (
		typeof agentModelOverrides !== "object" ||
		agentModelOverrides === null ||
		Array.isArray(agentModelOverrides)
	) {
		throw new Error("agentModelOverrides must be an object");
	}
	const raw = agentModelOverrides as Record<string, unknown>;
	for (const [agentKey, value] of Object.entries(raw)) {
		if (agentKey.trim().length === 0) {
			throw new Error("Agent model override keys must be non-empty strings");
		}
		normalized[agentKey] = normalizeAgentModelOverride(value, `Agent model override '${agentKey}'`);
	}
	return normalized;
}

function migrateV3AgentModels(
	agentModels: SproutSettingsV3["agentModels"] | undefined,
): AgentModelOverridesConfig {
	const normalized: AgentModelOverridesConfig = {};
	if (agentModels === undefined) return normalized;
	if (typeof agentModels !== "object" || agentModels === null || Array.isArray(agentModels)) {
		throw new Error("agentModels must be an object");
	}
	const raw = agentModels as Record<string, unknown>;
	if (Object.hasOwn(raw, "observer.metacognitive")) {
		normalized.metacognitive = {
			kind: "model",
			model: normalizeModelRef(
				raw["observer.metacognitive"],
				"Agent model 'observer.metacognitive'",
			),
		};
	}
	return normalized;
}

function normalizeAgentModelOverride(value: unknown, label: string): AgentModelOverride {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an agent model override object`);
	}
	const raw = value as Partial<AgentModelOverride>;
	if (raw.kind === "tier") {
		if (raw.tier !== "best" && raw.tier !== "balanced" && raw.tier !== "fast") {
			throw new Error(`${label} tier must be best, balanced, or fast`);
		}
		return { kind: "tier", tier: raw.tier };
	}
	if (raw.kind === "model") {
		return { kind: "model", model: normalizeModelRef(raw.model, label) };
	}
	throw new Error(`${label} kind must be tier or model`);
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
