import { describe, expect, test } from "bun:test";
import {
	createSecretStore,
	createSecretStoreRuntime,
	type ProviderSecretRef,
} from "../../src/host/settings/secret-store.ts";

function makeSecretRef(storageBackend: ProviderSecretRef["storageBackend"]): ProviderSecretRef {
	return {
		providerId: "anthropic-main",
		secretKind: "api-key",
		storageBackend,
		storageKey: "sprout/providers/anthropic-main/api-key",
	};
}

describe("SecretStore", () => {
	test("memory backend stores, reads, and deletes secrets", async () => {
		const store = createSecretStore({ backend: "memory", platform: "darwin" });
		const ref = makeSecretRef("memory");

		expect(await store.hasSecret(ref)).toBe(false);
		await store.setSecret(ref, "secret-value");
		expect(await store.hasSecret(ref)).toBe(true);
		expect(await store.getSecret(ref)).toBe("secret-value");
		await store.deleteSecret(ref);
		expect(await store.getSecret(ref)).toBeUndefined();
	});

	test("macos-keychain backend uses the security CLI on darwin", async () => {
		const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
		const store = createSecretStore({
			backend: "macos-keychain",
			platform: "darwin",
			async runCommand(cmd, args, stdin) {
				calls.push({ cmd, args, stdin });
				if (args[0] === "find-generic-password") {
					return { stdout: "secret-value\n", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});
		const ref = makeSecretRef("macos-keychain");

		await store.setSecret(ref, "secret-value");
		expect(await store.getSecret(ref)).toBe("secret-value");
		await store.deleteSecret(ref);

		expect(calls).toEqual([
			{
				cmd: "security",
				args: [
					"add-generic-password",
					"-U",
					"-a",
					ref.storageKey,
					"-s",
					"sprout",
					"-w",
					"secret-value",
				],
				stdin: undefined,
			},
			{
				cmd: "security",
				args: ["find-generic-password", "-a", ref.storageKey, "-s", "sprout", "-w"],
				stdin: undefined,
			},
			{
				cmd: "security",
				args: ["delete-generic-password", "-a", ref.storageKey, "-s", "sprout"],
				stdin: undefined,
			},
		]);
	});

	test("secret-service backend uses secret-tool on linux", async () => {
		const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
		const store = createSecretStore({
			backend: "secret-service",
			platform: "linux",
			async runCommand(cmd, args, stdin) {
				calls.push({ cmd, args, stdin });
				if (args[0] === "lookup") {
					return { stdout: "secret-value\n", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});
		const ref = makeSecretRef("secret-service");

		await store.setSecret(ref, "secret-value");
		expect(await store.getSecret(ref)).toBe("secret-value");
		await store.deleteSecret(ref);

		expect(calls).toEqual([
			{
				cmd: "secret-tool",
				args: ["store", "--label=Sprout", "service", "sprout", "account", ref.storageKey],
				stdin: "secret-value",
			},
			{
				cmd: "secret-tool",
				args: ["lookup", "service", "sprout", "account", ref.storageKey],
				stdin: undefined,
			},
			{
				cmd: "secret-tool",
				args: ["clear", "service", "sprout", "account", ref.storageKey],
				stdin: undefined,
			},
		]);
	});

	test("unsupported backend selection surfaces a configuration error", () => {
		expect(() =>
			createSecretStore({
				backend: "macos-keychain",
				platform: "linux",
			}),
		).toThrow(/unsupported secret backend/i);
	});

	test("backend command failures are surfaced instead of silently succeeding", async () => {
		const store = createSecretStore({
			backend: "macos-keychain",
			platform: "darwin",
			async runCommand() {
				return { stdout: "", stderr: "security failed", exitCode: 1 };
			},
		});

		await expect(store.setSecret(makeSecretRef("macos-keychain"), "secret-value")).rejects.toThrow(
			/security failed/i,
		);
	});

	test("runtime creation degrades unsupported default backends without aborting", async () => {
		const runtime = createSecretStoreRuntime({ platform: "win32" });

		expect(runtime.secretBackendState).toEqual({
			available: false,
			message: "Unsupported secret backend for platform: win32",
		});
		expect(await runtime.secretStore.hasSecret(makeSecretRef("memory"))).toBe(false);
		await expect(
			runtime.secretStore.setSecret(makeSecretRef("memory"), "secret-value"),
		).rejects.toThrow(/unsupported secret backend/i);
	});

	test("runtime creation preserves the requested backend name when it is unavailable", () => {
		const runtime = createSecretStoreRuntime({
			backend: "secret-service",
			platform: "darwin",
		});

		expect(runtime.secretBackendState).toEqual({
			backend: "secret-service",
			available: false,
			message: "Unsupported secret backend: secret-service",
		});
	});

	test("runtime creation honors SPROUT_SECRET_BACKEND from env", () => {
		const runtime = createSecretStoreRuntime({
			platform: "darwin",
			env: {
				SPROUT_SECRET_BACKEND: "memory",
			},
		});

		expect(runtime.secretBackendState).toEqual({
			backend: "memory",
			available: true,
		});
	});
});
