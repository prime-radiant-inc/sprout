import { describe, expect, test } from "bun:test";
import { redactCredentialText } from "@/host/settings/redaction";

describe("redactCredentialText", () => {
	test("redacts OAuth and secret-store credential material", () => {
		const input = [
			"Authorization: Bearer sk-live-secret",
			"http://localhost:1455/auth/callback?code=abc123&state=state123",
			"OAuth callback code: abc123",
			"raw code raw-code-123",
			"raw state raw-state-123",
			"raw code abc/def+ghi=",
			"raw state abc/def+ghi=",
			"security item sprout/providers/openai-codex/oauth failed",
			"backend error token refresh_token_123",
			"token response access_token=access-secret",
			'stored {"access_token":"snake-access","refresh_token":"snake-refresh","id_token":"snake-id"}',
			'stored {"accessToken":"access-json","refreshToken":"refresh-json","idToken":"id-json"}',
			"saved accessToken=access-equals refreshToken: refresh-colon idToken='id-quoted'",
		].join("\n");

		const redacted = redactCredentialText(input);

		expect(redacted).not.toContain("sk-live-secret");
		expect(redacted).not.toContain("abc123");
		expect(redacted).not.toContain("raw-code-123");
		expect(redacted).not.toContain("raw-state-123");
		expect(redacted).not.toContain("abc/def+ghi=");
		expect(redacted).not.toContain("refresh_token_123");
		expect(redacted).not.toContain("access-secret");
		expect(redacted).not.toContain("snake-access");
		expect(redacted).not.toContain("snake-refresh");
		expect(redacted).not.toContain("snake-id");
		expect(redacted).not.toContain("access-json");
		expect(redacted).not.toContain("refresh-json");
		expect(redacted).not.toContain("id-json");
		expect(redacted).not.toContain("access-equals");
		expect(redacted).not.toContain("refresh-colon");
		expect(redacted).not.toContain("id-quoted");
		expect(redacted).not.toContain("sprout/providers/openai-codex/oauth");
		expect(redacted).toContain('"access_token":"[redacted]"');
		expect(redacted).toContain('"accessToken":"[redacted]"');
		expect(redacted).toContain("refreshToken: [redacted]");
		expect(redacted).toContain("idToken='[redacted]'");
		expect(redacted).toContain("access_token=[redacted]");
		expect(redacted).toContain("[redacted]");
	});

	test("preserves ordinary code and state diagnostics", () => {
		const input = [
			"normal state transition failed",
			"error code failed",
			"status code unavailable",
			"diagnostic code: EAUTH",
			"the state: ready",
		].join("\n");

		expect(redactCredentialText(input)).toBe(input);
	});
});
