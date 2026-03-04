import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function listTsFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listTsFiles(fullPath)));
			continue;
		}
		if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
			files.push(fullPath);
		}
	}
	return files;
}

function isHostImport(specifier: string): boolean {
	return (
		specifier === "../host" ||
		specifier === "./host" ||
		specifier.startsWith("../host/") ||
		specifier.startsWith("./host/") ||
		specifier.includes("/host/")
	);
}

describe("dependency boundaries", () => {
	test("agents layer does not import host layer", async () => {
		const agentsDir = join(import.meta.dir, "../../src/agents");
		const files = await listTsFiles(agentsDir);
		const violations: string[] = [];

		for (const file of files) {
			const raw = await readFile(file, "utf-8");
			const lines = raw.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				const staticImport = line.match(/from\s+["']([^"']+)["']/);
				if (staticImport && isHostImport(staticImport[1]!)) {
					violations.push(`${file}:${i + 1} -> ${staticImport[1]}`);
				}
				const dynamicImport = line.match(/import\(\s*["']([^"']+)["']\s*\)/);
				if (dynamicImport && isHostImport(dynamicImport[1]!)) {
					violations.push(`${file}:${i + 1} -> ${dynamicImport[1]}`);
				}
			}
		}

		expect(violations, violations.join("\n")).toEqual([]);
	});
});
