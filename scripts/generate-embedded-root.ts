import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

interface EmbeddedRootFile {
	path: string;
	content: string;
}

const repoRoot = join(import.meta.dir, "..");

async function main(): Promise<void> {
	const rootDir = join(repoRoot, "root");
	const outputPath = join(repoRoot, "src", "generated", "embedded-root.ts");
	const files = await collectFiles(rootDir, rootDir);
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.path);
		hash.update("\0");
		hash.update(file.content);
		hash.update("\0");
	}
	const bundleHash = hash.digest("hex");
	const output = [
		"// biome-ignore-all lint/suspicious/noTemplateCurlyInString: embedded root files contain literal source text.",
		"export const embeddedRootBundle = {",
		`\tversion: ${JSON.stringify(bundleHash)},`,
		`\thash: ${JSON.stringify(bundleHash)},`,
		"\tfiles: [",
		...files.flatMap((file) => [
			"\t\t{",
			`\t\t\tpath: ${JSON.stringify(file.path)},`,
			"\t\t\tcontent:",
			`\t\t\t\t${JSON.stringify(file.content)},`,
			"\t\t},",
		]),
		"\t],",
		"} as const;",
		"",
	].join("\n");

	await mkdir(join(repoRoot, "src", "generated"), { recursive: true });
	await writeFile(outputPath, output);
	await run([join(repoRoot, "node_modules", ".bin", "biome"), "format", "--write", outputPath]);
}

async function collectFiles(rootDir: string, currentDir: string): Promise<EmbeddedRootFile[]> {
	const entries = await readdir(currentDir, { withFileTypes: true });
	const files: EmbeddedRootFile[] = [];

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const fullPath = join(currentDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(rootDir, fullPath)));
			continue;
		}
		const content = await readFile(fullPath, "utf-8");
		files.push({
			path: relative(rootDir, fullPath).replaceAll("\\", "/"),
			content,
		});
	}

	return files;
}

async function run(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
	}
}

await main();
