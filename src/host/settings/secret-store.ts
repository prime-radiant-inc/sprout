export type SecretStorageBackend = "memory" | "macos-keychain" | "secret-service";

export interface ProviderSecretRef {
	providerId: string;
	secretKind: "api-key";
	storageBackend: SecretStorageBackend;
	storageKey: string;
}

export function createProviderSecretRef(
	providerId: string,
	storageBackend: SecretStorageBackend,
): ProviderSecretRef {
	return {
		providerId,
		secretKind: "api-key",
		storageBackend,
		storageKey: `sprout/providers/${providerId}/api-key`,
	};
}

export interface SecretStore {
	getSecret(ref: ProviderSecretRef): Promise<string | undefined>;
	setSecret(ref: ProviderSecretRef, value: string): Promise<void>;
	deleteSecret(ref: ProviderSecretRef): Promise<void>;
	hasSecret(ref: ProviderSecretRef): Promise<boolean>;
}

export interface RunCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type RunCommand = (cmd: string, args: string[], stdin?: string) => Promise<RunCommandResult>;

export interface CreateSecretStoreOptions {
	backend: SecretStorageBackend;
	platform?: NodeJS.Platform;
	env?: Record<string, string | undefined>;
	runCommand?: RunCommand;
}

export interface SecretBackendState {
	backend?: SecretStorageBackend;
	available: boolean;
	message?: string;
}

export interface SecretStoreRuntime {
	secretRefBackend: SecretStorageBackend;
	secretBackendState: SecretBackendState;
	secretStore: SecretStore;
}

export function resolveDefaultSecretStorageBackend(
	platform: NodeJS.Platform = process.platform,
): SecretStorageBackend {
	switch (platform) {
		case "darwin":
			return "macos-keychain";
		case "linux":
			return "secret-service";
		default:
			throw new Error(`Unsupported secret backend for platform: ${platform}`);
	}
}

export function createSecretStore(options: CreateSecretStoreOptions): SecretStore {
	switch (options.backend) {
		case "memory":
			return new MemorySecretStore();
		case "macos-keychain":
			if ((options.platform ?? process.platform) !== "darwin") {
				throw new Error("Unsupported secret backend: macos-keychain");
			}
			return new MacOsKeychainSecretStore(options.runCommand ?? runCommand);
		case "secret-service":
			if ((options.platform ?? process.platform) !== "linux") {
				throw new Error("Unsupported secret backend: secret-service");
			}
			return new SecretServiceSecretStore(options.runCommand ?? runCommand);
	}
}

export function createSecretStoreRuntime(
	options: Partial<CreateSecretStoreOptions> = {},
): SecretStoreRuntime {
	const platform = options.platform ?? process.platform;
	const envBackend = options.env?.SPROUT_SECRET_BACKEND?.trim();
	const requestedBackend = options.backend ?? parseSecretBackend(envBackend);
	if (requestedBackend) {
		try {
			return {
				secretRefBackend: requestedBackend,
				secretBackendState: {
					backend: requestedBackend,
					available: true,
				},
				secretStore: createSecretStore({
					backend: requestedBackend,
					platform,
					runCommand: options.runCommand,
				}),
			};
		} catch (error) {
			return {
				secretRefBackend: requestedBackend,
				secretBackendState: {
					backend: requestedBackend,
					available: false,
					message: error instanceof Error ? error.message : String(error),
				},
				secretStore: new UnavailableSecretStore(
					error instanceof Error ? error.message : String(error),
				),
			};
		}
	}

	try {
		const backend = resolveDefaultSecretStorageBackend(platform);
		return {
			secretRefBackend: backend,
			secretBackendState: {
				backend,
				available: true,
			},
			secretStore: createSecretStore({
				backend,
				platform,
				runCommand: options.runCommand,
			}),
		};
	} catch (error) {
		return {
			secretRefBackend: "memory",
			secretBackendState: {
				available: false,
				message: error instanceof Error ? error.message : String(error),
			},
			secretStore: new UnavailableSecretStore(
				error instanceof Error ? error.message : String(error),
			),
		};
	}
}

function parseSecretBackend(value: string | undefined): SecretStorageBackend | undefined {
	switch (value) {
		case undefined:
		case "":
			return undefined;
		case "memory":
		case "macos-keychain":
		case "secret-service":
			return value;
		default:
			throw new Error(`Unsupported secret backend: ${value}`);
	}
}

class MemorySecretStore implements SecretStore {
	private readonly secrets = new Map<string, string>();

	async getSecret(ref: ProviderSecretRef): Promise<string | undefined> {
		return this.secrets.get(ref.storageKey);
	}

	async setSecret(ref: ProviderSecretRef, value: string): Promise<void> {
		this.secrets.set(ref.storageKey, value);
	}

	async deleteSecret(ref: ProviderSecretRef): Promise<void> {
		this.secrets.delete(ref.storageKey);
	}

	async hasSecret(ref: ProviderSecretRef): Promise<boolean> {
		return this.secrets.has(ref.storageKey);
	}
}

class UnavailableSecretStore implements SecretStore {
	constructor(private readonly message: string) {}

	async getSecret(): Promise<string | undefined> {
		return undefined;
	}

	async setSecret(): Promise<void> {
		throw new Error(this.message);
	}

	async deleteSecret(): Promise<void> {
		throw new Error(this.message);
	}

	async hasSecret(): Promise<boolean> {
		return false;
	}
}

class MacOsKeychainSecretStore implements SecretStore {
	constructor(private readonly runCommandImpl: RunCommand) {}

	async getSecret(ref: ProviderSecretRef): Promise<string | undefined> {
		const result = await this.runCommandImpl("security", [
			"find-generic-password",
			"-a",
			ref.storageKey,
			"-s",
			"sprout",
			"-w",
		]);
		return result.exitCode === 0 ? result.stdout.trimEnd() : undefined;
	}

	async setSecret(ref: ProviderSecretRef, value: string): Promise<void> {
		const result = await this.runCommandImpl("security", [
			"add-generic-password",
			"-U",
			"-a",
			ref.storageKey,
			"-s",
			"sprout",
			"-w",
			value,
		]);
		assertCommandSucceeded(result, "security");
	}

	async deleteSecret(ref: ProviderSecretRef): Promise<void> {
		const result = await this.runCommandImpl("security", [
			"delete-generic-password",
			"-a",
			ref.storageKey,
			"-s",
			"sprout",
		]);
		assertCommandSucceeded(result, "security");
	}

	async hasSecret(ref: ProviderSecretRef): Promise<boolean> {
		return (await this.getSecret(ref)) !== undefined;
	}
}

class SecretServiceSecretStore implements SecretStore {
	constructor(private readonly runCommandImpl: RunCommand) {}

	async getSecret(ref: ProviderSecretRef): Promise<string | undefined> {
		const result = await this.runCommandImpl("secret-tool", [
			"lookup",
			"service",
			"sprout",
			"account",
			ref.storageKey,
		]);
		return result.exitCode === 0 ? result.stdout.trimEnd() : undefined;
	}

	async setSecret(ref: ProviderSecretRef, value: string): Promise<void> {
		const result = await this.runCommandImpl(
			"secret-tool",
			["store", "--label=Sprout", "service", "sprout", "account", ref.storageKey],
			value,
		);
		assertCommandSucceeded(result, "secret-tool");
	}

	async deleteSecret(ref: ProviderSecretRef): Promise<void> {
		const result = await this.runCommandImpl("secret-tool", [
			"clear",
			"service",
			"sprout",
			"account",
			ref.storageKey,
		]);
		assertCommandSucceeded(result, "secret-tool");
	}

	async hasSecret(ref: ProviderSecretRef): Promise<boolean> {
		return (await this.getSecret(ref)) !== undefined;
	}
}

async function runCommand(cmd: string, args: string[], stdin?: string): Promise<RunCommandResult> {
	const proc = Bun.spawn([cmd, ...args], {
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

function assertCommandSucceeded(result: RunCommandResult, cmd: string): void {
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `${cmd} exited with code ${result.exitCode}`);
	}
}
