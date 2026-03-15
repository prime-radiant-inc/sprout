import { installSproutSelfInvocationEnv } from "../util/self-command.ts";
import { parseArgs } from "./cli-parse.ts";

export * from "./cli-shared.ts";

/** Execute a parsed CLI command. */
if (import.meta.main) {
	installSproutSelfInvocationEnv();
	const { runInternalCliCommand } = await import("./cli-internal.ts");
	const internalExitCode = await runInternalCliCommand(process.argv.slice(2));
	if (internalExitCode !== null) {
		process.exit(internalExitCode);
	}
	const command = parseArgs(process.argv.slice(2));
	const { runCli } = await import("./cli-run.ts");
	await runCli(command);
}
