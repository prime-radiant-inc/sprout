import { describe, expect, test } from "bun:test";
import { ulid } from "../../src/util/ulid.ts";

describe("ulid", () => {
	test("returns a 26-character string", () => {
		const id = ulid();
		expect(id).toHaveLength(26);
	});

	test("uses only Crockford Base32 characters", () => {
		const id = ulid();
		expect(id).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
	});

	test("is monotonically increasing", () => {
		const ids = Array.from({ length: 100 }, () => ulid());
		const sorted = [...ids].sort();
		expect(ids).toEqual(sorted);
	});

	test("two ULIDs generated at the same ms are different", () => {
		const a = ulid();
		const b = ulid();
		expect(a).not.toBe(b);
	});

	test("encodes timestamp in first 10 characters", () => {
		const before = Date.now();
		const id = ulid();
		const after = Date.now();

		// Decode first 10 chars as timestamp
		const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
		let ts = 0;
		for (let i = 0; i < 10; i++) {
			ts = ts * 32 + ENCODING.indexOf(id[i]!);
		}
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});
});
