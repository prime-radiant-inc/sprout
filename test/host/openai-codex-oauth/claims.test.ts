import { describe, expect, test } from "bun:test";
import { extractChatGPTAccountId } from "@/host/openai-codex-oauth/claims";

function base64UrlEncode(value: string): string {
	return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function jwt(payload: Record<string, unknown>): string {
	return `header.${base64UrlEncode(JSON.stringify(payload))}.signature`;
}

describe("extractChatGPTAccountId", () => {
	test("reads the ChatGPT account id from access token claims", () => {
		expect(
			extractChatGPTAccountId({
				accessToken: jwt({ "https://api.openai.com/auth.chatgpt_account_id": "acct_123" }),
			}),
		).toBe("acct_123");
	});

	test("falls back to id token and stored account id", () => {
		expect(
			extractChatGPTAccountId({
				accessToken: jwt({}),
				idToken: jwt({ "https://api.openai.com/auth.chatgpt_account_id": "acct_id" }),
			}),
		).toBe("acct_id");
		expect(extractChatGPTAccountId({ accessToken: jwt({}), storedAccountId: "acct_old" })).toBe(
			"acct_old",
		);
		expect(
			extractChatGPTAccountId({ accessToken: jwt({}), storedAccountId: "  acct_trimmed  " }),
		).toBe("acct_trimmed");
	});

	test("throws a generic error for malformed JWTs", () => {
		expect(() => extractChatGPTAccountId({ accessToken: "not-a-jwt" })).toThrow(
			"Unable to decode OpenAI OAuth token claims",
		);
		expect(() =>
			extractChatGPTAccountId({
				accessToken: jwt({}),
				idToken: `header.${base64UrlEncode("not-json")}.signature`,
			}),
		).toThrow("Unable to decode OpenAI OAuth token claims");
	});

	test("throws a distinct error when no account id is available", () => {
		expect(() => extractChatGPTAccountId({ accessToken: jwt({}) })).toThrow(
			"OpenAI OAuth token claims did not include a ChatGPT account id",
		);
	});
});
