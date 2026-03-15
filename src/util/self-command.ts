export type InternalSproutCommand = "agent-process" | "task-cli" | "mcp-cli";

export const SPROUT_SELF_EXECUTABLE_ENV = "SPROUT_SELF_EXECUTABLE";
export const SPROUT_SELF_ENTRYPOINT_ENV = "SPROUT_SELF_ENTRYPOINT";

export interface InstallSproutSelfInvocationOptions {
	env?: NodeJS.ProcessEnv;
	argv?: string[];
	execPath?: string;
}

export function installSproutSelfInvocationEnv(
	options: InstallSproutSelfInvocationOptions = {},
): void {
	const env = options.env ?? process.env;
	const argv = options.argv ?? process.argv;
	const execPath = options.execPath ?? process.execPath;

	env.SPROUT_SELF_EXECUTABLE = execPath;

	const entrypoint = resolveSelfEntrypoint(argv);
	if (entrypoint) {
		env.SPROUT_SELF_ENTRYPOINT = entrypoint;
	} else {
		delete env.SPROUT_SELF_ENTRYPOINT;
	}
}

export function buildInternalSproutCommand(
	command: InternalSproutCommand,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const executable = env[SPROUT_SELF_EXECUTABLE_ENV];
	if (!executable) {
		throw new Error("SPROUT_SELF_EXECUTABLE is not set");
	}

	const args = [executable];
	const entrypoint = env[SPROUT_SELF_ENTRYPOINT_ENV];
	if (entrypoint) {
		args.push(entrypoint);
	}
	args.push(`--internal-${command}`);
	return args;
}

function resolveSelfEntrypoint(argv: string[]): string | undefined {
	const candidate = argv[1];
	if (!candidate || candidate.startsWith("-") || candidate.startsWith("/$bunfs/")) {
		return undefined;
	}
	return candidate;
}
