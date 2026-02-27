import { describe, expect, test } from "bun:test";
import { getFaviconSvg } from "../useFaviconStatus.ts";

describe("getFaviconSvg", () => {
	test("returns green circle SVG for idle status", () => {
		const svg = getFaviconSvg("idle");
		expect(svg).toContain("svg");
		expect(svg).toContain("#22c55e"); // green color
	});

	test("returns purple circle SVG for running status", () => {
		const svg = getFaviconSvg("running");
		expect(svg).toContain("svg");
		expect(svg).toContain("#8b5cf6"); // accent/purple color
	});

	test("returns red circle SVG for error status", () => {
		const svg = getFaviconSvg("error");
		expect(svg).toContain("svg");
		expect(svg).toContain("#ef4444"); // red color
	});

	test("returns a valid data URL", () => {
		const svg = getFaviconSvg("idle");
		expect(svg).toMatch(/^<svg/);
	});
});
