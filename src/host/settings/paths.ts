import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SETTINGS_FILE_NAME = "settings.json";

export interface SettingsPathOptions {
	xdgConfigHome?: string;
	homeDir?: string;
}

export function resolveSettingsDir(options: SettingsPathOptions = {}): string {
	const xdgConfigHome = options.xdgConfigHome?.trim();
	if (xdgConfigHome) return join(xdgConfigHome, "sprout");

	return join(options.homeDir ?? homedir(), ".config", "sprout");
}

export function resolveSettingsPath(options: SettingsPathOptions = {}): string {
	return join(resolveSettingsDir(options), SETTINGS_FILE_NAME);
}

export function buildInvalidSettingsPath(settingsPath: string, timestamp: string): string {
	return join(dirname(settingsPath), `settings.invalid.${timestamp}.json`);
}
