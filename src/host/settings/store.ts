import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { SettingsPathOptions } from "./paths.ts";
import { buildInvalidSettingsPath, resolveSettingsPath } from "./paths.ts";
import {
	createEmptySettings,
	SETTINGS_SCHEMA_VERSION,
	type SproutSettings,
	validateSproutSettings,
} from "./types.ts";

export interface SettingsLoadResult {
	settings: SproutSettings;
	recoveredInvalidFilePath?: string;
	skipEnvImport: boolean;
}

export interface SettingsStoreOptions {
	settingsPath?: string;
	pathOptions?: SettingsPathOptions;
	now?: () => string;
	migrate?: (raw: unknown) => SproutSettings;
}

export class SettingsStore {
	private readonly settingsPath: string;
	private readonly now: () => string;
	private readonly migrate?: (raw: unknown) => SproutSettings;

	constructor(options: SettingsStoreOptions = {}) {
		this.settingsPath = options.settingsPath ?? resolveSettingsPath(options.pathOptions);
		this.now = options.now ?? (() => new Date().toISOString().replaceAll(":", "-"));
		this.migrate = options.migrate;
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
				};
			}
			throw error;
		}

		try {
			const settings = this.parseSettings(raw);
			return {
				settings,
				skipEnvImport: false,
			};
		} catch {
			const recoveredInvalidFilePath = await this.recoverInvalidFile();
			return {
				settings: createEmptySettings(),
				recoveredInvalidFilePath,
				skipEnvImport: true,
			};
		}
	}

	async save(settings: SproutSettings): Promise<void> {
		validateSproutSettings(settings);
		await mkdir(new URL(".", `file://${this.settingsPath}`), { recursive: true }).catch(() => {
			// Bun's URL mkdir behavior is inconsistent; fall through to dirname-based mkdir below.
		});
		const { dirname } = await import("node:path");
		await mkdir(dirname(this.settingsPath), { recursive: true });
		const tempPath = `${this.settingsPath}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
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
			validateSproutSettings(parsed as SproutSettings);
			return parsed as SproutSettings;
		}
		if (this.migrate) {
			const migrated = this.migrate(parsed);
			validateSproutSettings(migrated);
			return migrated;
		}
		throw new Error(`Unsupported settings schema version: ${String(parsed.version)}`);
	}
}
