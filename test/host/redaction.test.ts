import { describe, expect, test } from "bun:test";
import { redactCredentialText } from "@/host/settings/redaction";

describe("redactCredentialText", () => {
	test("redacts OAuth and secret-store credential material", () => {
		const input = [
			"Authorization: Bearer sk-live-secret",
			"http://localhost:1455/auth/callback?code=abc123&state=state123",
			"raw code abc123",
			"security item sprout/providers/openai-codex/oauth failed",
			"backend error token refresh_token_123",
			"token response access_token=access-secret",
		].join("\n");

		const redacted = redactCredentialText(input);

		expect(redacted).not.toContain("sk-live-secret");
		expect(redacted).not.toContain("abc123");
		expect(redacted).not.toContain("refresh_token_123");
		expect(redacted).not.toContain("access-secret");
		expect(redacted).not.toContain("sprout/providers/openai-codex/oauth");
		expect(redacted).toContain("access_token=[redacted]");
		expect(redacted).toContain("[redacted]");
	});
});
