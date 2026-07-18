import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	HandleRegistry,
	hashToken,
	mintToken,
	type ObserverRemit,
} from "../../src/host/handle-registry.ts";

function registerOwned(
	registry: HandleRegistry,
	handleId: string,
	ownerId: string,
	token: string,
	options: { depth?: number; observerRemit?: ObserverRemit } = {},
) {
	return registry.registerHandle({
		handleId,
		tokenHash: hashToken(token),
		registrarId: ownerId,
		ownerId,
		depth: options.depth ?? 1,
		observerRemit: options.observerRemit,
	});
}

describe("mintToken", () => {
	test("returns 32 random bytes as hex", () => {
		const token = mintToken();
		expect(token).toMatch(/^[0-9a-f]{64}$/);
	});

	test("returns a different token every call", () => {
		expect(mintToken()).not.toBe(mintToken());
	});
});

describe("hashToken", () => {
	test("returns the hex sha256 of the token", () => {
		const token = "secret-token";
		const expected = createHash("sha256").update(token).digest("hex");
		expect(hashToken(token)).toBe(expected);
	});
});

describe("registerHandle", () => {
	test("records a handle registered by its owner", () => {
		const registry = new HandleRegistry();
		const result = registerOwned(registry, "h-child", "h-parent", mintToken(), { depth: 2 });

		expect(result).toEqual({ ok: true });
		expect(registry.get("h-child")).toEqual({ ownerId: "h-parent", depth: 2, live: false });
		expect(registry.isLive("h-child")).toBe(false);
	});

	test("rejects registration when the registrar does not own the handle", () => {
		const registry = new HandleRegistry();
		const result = registry.registerHandle({
			handleId: "h-child",
			tokenHash: hashToken(mintToken()),
			registrarId: "h-intruder",
			ownerId: "h-parent",
			depth: 2,
		});

		expect(result).toEqual({ ok: false, reason: "not_parent" });
		expect(registry.get("h-child")).toBeUndefined();
	});

	test("trusted registrar may register handles for any owner", () => {
		const registry = new HandleRegistry({ trustedRegistrarId: "host" });
		const token = mintToken();
		const result = registry.registerHandle({
			handleId: "h-root",
			tokenHash: hashToken(token),
			registrarId: "host",
			ownerId: "h-session",
			depth: 0,
		});

		expect(result).toEqual({ ok: true });
		expect(registry.authenticate("h-root", token).ok).toBe(true);
	});

	test("rejects registration of an existing handle by a different owner", () => {
		const registry = new HandleRegistry();
		registerOwned(registry, "h-child", "h-parent", mintToken());

		const result = registerOwned(registry, "h-child", "h-intruder", mintToken());

		expect(result).toEqual({ ok: false, reason: "duplicate" });
	});

	test("rejects registration of an existing handle for a different owner via the trusted registrar", () => {
		const registry = new HandleRegistry({ trustedRegistrarId: "host" });
		registerOwned(registry, "h-child", "h-parent", mintToken());

		const result = registry.registerHandle({
			handleId: "h-child",
			tokenHash: hashToken(mintToken()),
			registrarId: "host",
			ownerId: "h-other",
			depth: 1,
		});

		expect(result).toEqual({ ok: false, reason: "duplicate" });
	});

	test("owner re-registers with a fresh token while not live; old token stops authenticating", () => {
		const registry = new HandleRegistry();
		const oldToken = mintToken();
		const newToken = mintToken();
		registerOwned(registry, "h-child", "h-parent", oldToken);

		const result = registerOwned(registry, "h-child", "h-parent", newToken);

		expect(result).toEqual({ ok: true });
		expect(registry.authenticate("h-child", oldToken)).toEqual({
			ok: false,
			reason: "bad_token",
		});
		const auth = registry.authenticate("h-child", newToken);
		expect(auth.ok).toBe(true);
	});

	test("rejects re-registration while the handle is live, even by its owner", () => {
		const registry = new HandleRegistry();
		const token = mintToken();
		registerOwned(registry, "h-child", "h-parent", token);
		registry.authenticate("h-child", token);

		const result = registerOwned(registry, "h-child", "h-parent", mintToken());

		expect(result).toEqual({ ok: false, reason: "live_connection" });
		expect(registry.authenticate("h-child", token)).toEqual({
			ok: false,
			reason: "already_live",
		});
	});

	test("rejects re-registration of a live handle by the trusted registrar", () => {
		const registry = new HandleRegistry({ trustedRegistrarId: "host" });
		const token = mintToken();
		registerOwned(registry, "h-child", "h-parent", token);
		registry.authenticate("h-child", token);

		const result = registry.registerHandle({
			handleId: "h-child",
			tokenHash: hashToken(mintToken()),
			registrarId: "host",
			ownerId: "h-parent",
			depth: 1,
		});

		expect(result).toEqual({ ok: false, reason: "live_connection" });
	});
});

describe("authenticate", () => {
	test("verifies the token, marks the handle live, and returns its identity", () => {
		const registry = new HandleRegistry();
		const token = mintToken();
		registerOwned(registry, "h-child", "h-parent", token, { depth: 3 });

		const result = registry.authenticate("h-child", token);

		expect(result).toEqual({
			ok: true,
			identity: { ownerId: "h-parent", depth: 3, live: true },
		});
		expect(registry.isLive("h-child")).toBe(true);
	});

	test("rejects the wrong token without marking the handle live", () => {
		const registry = new HandleRegistry();
		registerOwned(registry, "h-child", "h-parent", mintToken());

		const result = registry.authenticate("h-child", mintToken());

		expect(result).toEqual({ ok: false, reason: "bad_token" });
		expect(registry.isLive("h-child")).toBe(false);
	});

	test("rejects unknown handles", () => {
		const registry = new HandleRegistry();

		expect(registry.authenticate("h-ghost", mintToken())).toEqual({
			ok: false,
			reason: "unknown_handle",
		});
	});

	test("rejects a second authentication while the handle is live", () => {
		const registry = new HandleRegistry();
		const token = mintToken();
		registerOwned(registry, "h-child", "h-parent", token);
		expect(registry.authenticate("h-child", token).ok).toBe(true);

		expect(registry.authenticate("h-child", token)).toEqual({
			ok: false,
			reason: "already_live",
		});
		expect(registry.isLive("h-child")).toBe(true);
	});
});

describe("disconnect", () => {
	test("clears live state so the same token authenticates again", () => {
		const registry = new HandleRegistry();
		const token = mintToken();
		registerOwned(registry, "h-child", "h-parent", token);
		registry.authenticate("h-child", token);

		expect(registry.disconnect("h-child")).toEqual({ ok: true });
		expect(registry.isLive("h-child")).toBe(false);

		const result = registry.authenticate("h-child", token);
		expect(result.ok).toBe(true);
		expect(registry.isLive("h-child")).toBe(true);
	});

	test("allows the owner to re-register with a fresh token after disconnect", () => {
		const registry = new HandleRegistry();
		const oldToken = mintToken();
		const newToken = mintToken();
		registerOwned(registry, "h-child", "h-parent", oldToken);
		registry.authenticate("h-child", oldToken);
		registry.disconnect("h-child");

		expect(registerOwned(registry, "h-child", "h-parent", newToken)).toEqual({ ok: true });
		expect(registry.authenticate("h-child", oldToken)).toEqual({
			ok: false,
			reason: "bad_token",
		});
		expect(registry.authenticate("h-child", newToken).ok).toBe(true);
	});

	test("reports unknown handles", () => {
		const registry = new HandleRegistry();

		expect(registry.disconnect("h-ghost")).toEqual({ ok: false, reason: "unknown_handle" });
	});
});

describe("get", () => {
	test("returns undefined for unknown handles", () => {
		const registry = new HandleRegistry();
		expect(registry.get("h-ghost")).toBeUndefined();
	});

	test("never exposes the token hash", () => {
		const registry = new HandleRegistry();
		const token = mintToken();
		registerOwned(registry, "h-child", "h-parent", token);

		const identity = registry.get("h-child");
		expect(identity).toBeDefined();
		expect(Object.keys(identity!).sort()).toEqual(["depth", "live", "ownerId"]);
		expect(JSON.stringify(identity)).not.toContain(hashToken(token));
	});

	test("stores and returns the observer remit", () => {
		const registry = new HandleRegistry();
		const remit: ObserverRemit = { kind: "delegate", ownerId: "h-parent" };
		registerOwned(registry, "h-observer", "h-parent", mintToken(), { observerRemit: remit });

		expect(registry.get("h-observer")).toEqual({
			ownerId: "h-parent",
			depth: 1,
			observerRemit: { kind: "delegate", ownerId: "h-parent" },
			live: false,
		});
	});
});

describe("isLive", () => {
	test("returns false for unknown handles", () => {
		const registry = new HandleRegistry();
		expect(registry.isLive("h-ghost")).toBe(false);
	});
});
