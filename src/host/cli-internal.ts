export async function runInternalCliCommand(argv: string[]): Promise<number | null> {
	const [command, ...rest] = argv;

	switch (command) {
		case "--internal-agent-process": {
			const { runAgentProcessFromEnvironment } = await import("../bus/agent-process.ts");
			return runAgentProcessFromEnvironment();
		}
		case "--internal-task-cli": {
			const { runTaskCli } = await import(
				"../../root/agents/utility/agents/task-manager/tools/cli.ts"
			);
			return runTaskCli(rest);
		}
		case "--internal-mcp-cli": {
			const { runSproutMcpCli } = await import(
				"../../root/agents/utility/agents/mcp/tools/mcp-cli.ts"
			);
			return runSproutMcpCli(rest);
		}
		default:
			return null;
	}
}
