import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GenomeCommand =
	| { kind: "genome-list"; genomePath: string }
	| { kind: "genome-log"; genomePath: string }
	| { kind: "genome-rollback"; genomePath: string; commit: string }
	| { kind: "genome-export"; genomePath: string }
	| { kind: "genome-sync"; genomePath: string };

export function isGenomeCommand<T extends { kind: string }>(
	command: T,
): command is T & GenomeCommand {
	return (
		command.kind === "genome-list" ||
		command.kind === "genome-log" ||
		command.kind === "genome-rollback" ||
		command.kind === "genome-export" ||
		command.kind === "genome-sync"
	);
}

export async function runGenomeCommand(command: GenomeCommand): Promise<void> {
	if (command.kind === "genome-list") {
		const { Genome } = await import("../genome/genome.ts");
		const rootDir = join(import.meta.dir, "../../root");
		const genome = new Genome(command.genomePath, rootDir);
		await genome.loadFromDisk();
		const agents = genome.allAgents();
		if (agents.length === 0) {
			console.log("No agents in genome.");
		} else {
			for (const agent of agents) {
				console.log(`  ${agent.name} (v${agent.version}) — ${agent.description}`);
			}
		}
		return;
	}

	if (command.kind === "genome-log") {
		const proc = Bun.spawn(["git", "-C", command.genomePath, "log", "--oneline"], {
			stdout: "inherit",
			stderr: "inherit",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	if (command.kind === "genome-rollback") {
		const proc = Bun.spawn(
			["git", "-C", command.genomePath, "revert", "--no-edit", command.commit],
			{
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	if (command.kind === "genome-sync") {
		const { Genome } = await import("../genome/genome.ts");
		const rootDir = join(import.meta.dir, "../../root");

		const genome = new Genome(command.genomePath, rootDir);
		try {
			await genome.loadFromDisk();
		} catch (err) {
			console.error(
				`Failed to load genome at ${command.genomePath}: ${err instanceof Error ? err.message : err}`,
			);
			process.exitCode = 1;
			return;
		}

		const result = await genome.syncRoot();

		if (result.added.length === 0 && result.conflicts.length === 0) {
			console.log("Genome is up to date with root agents.");
			return;
		}

		if (result.added.length > 0) {
			console.log(`Added: ${result.added.join(", ")}`);
		}
		if (result.conflicts.length > 0) {
			console.log(`Conflicts (genome preserved): ${result.conflicts.join(", ")}`);
		}
		return;
	}

	const { exportLearnings, stageLearnings } = await import("../genome/export-learnings.ts");
	const rootDir = join(import.meta.dir, "../../root");

	let result: Awaited<ReturnType<typeof exportLearnings>>;
	try {
		result = await exportLearnings(command.genomePath, rootDir);
	} catch (err) {
		console.error(
			`Failed to load genome at ${command.genomePath}: ${err instanceof Error ? err.message : err}`,
		);
		process.exitCode = 1;
		return;
	}

	if (result.evolved.length === 0 && result.genomeOnly.length === 0) {
		console.log("No learnings to export. Genome matches root specs.");
		return;
	}

	if (result.evolved.length > 0) {
		console.log("\nEvolved agents (genome improved beyond root specs):");
		for (const agent of result.evolved) {
			console.log(`  ${agent.name}: v${agent.rootVersion} → v${agent.genomeVersion}`);
		}
	}

	if (result.genomeOnly.length > 0) {
		console.log("\nGenome-only agents (created by learn process):");
		for (const agent of result.genomeOnly) {
			console.log(`  ${agent.name} (v${agent.version}) — ${agent.description}`);
		}
	}

	const stagingDir = await mkdtemp(join(tmpdir(), "sprout-export-"));
	const written = await stageLearnings(result, stagingDir);
	console.log(`\nWrote ${written.length} agent spec files to: ${stagingDir}/`);
	console.log("Copy desired files to root/ to incorporate learnings.");
}
