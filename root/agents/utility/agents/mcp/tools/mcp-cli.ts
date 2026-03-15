#!/usr/bin/env bun

/**
 * Lightweight MCP client CLI.
 *
 * Usage:
 *   sprout-mcp list-servers [--config path]
 *   sprout-mcp list-tools   <server> [--config path]
 *   sprout-mcp call-tool    <server> <tool> [json-args] [--config path]
 *
 * Reads MCP server configuration from mcp.json in the working directory
 * (or the path given by --config).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ── Config ──────────────────────────────────────────────────────────────────

interface ServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}

interface McpJson {
	mcpServers: Record<string, ServerConfig>;
}

class McpCliError extends Error {}

function findFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
	return undefined;
}

function loadConfig(args: string[]): McpJson {
	const configPath = resolve(findFlag(args, "--config") ?? "mcp.json");
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
			throw new McpCliError(`Invalid config: missing "mcpServers" key in ${configPath}`);
		}
		return parsed as McpJson;
	} catch (err: unknown) {
		if (err instanceof McpCliError) {
			throw err;
		}
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new McpCliError(`Config file not found: ${configPath}`);
		} else {
			throw new McpCliError(`Failed to read config: ${err}`);
		}
	}
}

// ── MCP helpers ─────────────────────────────────────────────────────────────

async function connectToServer(name: string, cfg: ServerConfig): Promise<Client> {
	let transport: StreamableHTTPClientTransport | StdioClientTransport;
	if (cfg.url) {
		transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
			requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
		});
	} else if (cfg.command) {
		transport = new StdioClientTransport({
			command: cfg.command,
			args: cfg.args,
			env: cfg.env ? ({ ...process.env, ...cfg.env } as Record<string, string>) : undefined,
		});
	} else {
		throw new Error(`Server '${name}' needs either 'url' or 'command' in config`);
	}
	const client = new Client({ name: `sprout-mcp/${name}`, version: "1.0.0" });
	await client.connect(transport);
	return client;
}

async function listAllTools(client: Client) {
	const tools: { name: string; description?: string }[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined);
		for (const t of page.tools) {
			tools.push({ name: t.name, description: t.description });
		}
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

function formatContent(content: unknown): string {
	if (!Array.isArray(content)) return String(content);
	return content
		.map((c: { type: string; text?: string }) =>
			c.type === "text" ? (c.text ?? "") : JSON.stringify(c),
		)
		.join("\n");
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdListServers(args: string[]) {
	const config = loadConfig(args);
	for (const [name, cfg] of Object.entries(config.mcpServers)) {
		if (cfg.url) {
			console.log(`${name}  (${cfg.url})`);
		} else {
			console.log(`${name}  (${cfg.command}${cfg.args ? ` ${cfg.args.join(" ")}` : ""})`);
		}
	}
}

async function cmdListTools(args: string[]) {
	const serverName = args[0];
	if (!serverName) {
		throw new McpCliError("Usage: sprout-mcp list-tools <server> [--config path]");
	}

	const config = loadConfig(args);
	const serverCfg = config.mcpServers[serverName];
	if (!serverCfg) {
		throw new McpCliError(
			`Server '${serverName}' not found. Available: ${Object.keys(config.mcpServers).join(", ")}`,
		);
	}

	const client = await connectToServer(serverName, serverCfg);
	try {
		const tools = await listAllTools(client);
		if (tools.length === 0) {
			console.log("No tools available.");
			return;
		}
		for (const tool of tools) {
			console.log(`${tool.name}`);
			if (tool.description) {
				console.log(`  ${tool.description}`);
			}
		}
	} finally {
		await client.close();
	}
}

async function cmdCallTool(args: string[]) {
	const serverName = args[0];
	const toolName = args[1];
	// Collect everything after serverName and toolName that isn't --config/value
	const rest = args.slice(2).filter((a, i, arr) => {
		if (a === "--config") return false;
		if (i > 0 && arr[i - 1] === "--config") return false;
		return true;
	});
	const jsonArgs = rest.join(" ").trim();

	if (!serverName || !toolName) {
		throw new McpCliError("Usage: sprout-mcp call-tool <server> <tool> [json-args] [--config path]");
	}

	const config = loadConfig(args);
	const serverCfg = config.mcpServers[serverName];
	if (!serverCfg) {
		throw new McpCliError(
			`Server '${serverName}' not found. Available: ${Object.keys(config.mcpServers).join(", ")}`,
		);
	}

	let parsedArgs: Record<string, unknown> = {};
	if (jsonArgs) {
		try {
			parsedArgs = JSON.parse(jsonArgs);
		} catch {
			throw new McpCliError(`Invalid JSON arguments: ${jsonArgs}`);
		}
	}

	const client = await connectToServer(serverName, serverCfg);
	try {
		const result = await client.callTool({ name: toolName, arguments: parsedArgs });

		if (result.isError) {
			throw new McpCliError(`Tool error:\n${formatContent(result.content)}`);
		}

		console.log(formatContent(result.content));
	} finally {
		await client.close();
	}
}

function helpText(): string {
	return `sprout-mcp — MCP server client

Usage:
  sprout-mcp list-servers           List configured MCP servers
  sprout-mcp list-tools <server>    List tools on a server
  sprout-mcp call-tool <server> <tool> [json-args]
                                    Call a tool with optional JSON arguments

Options:
  --config <path>   Path to mcp.json (default: ./mcp.json)

The config file uses the standard mcpServers format:
  {
    "mcpServers": {
      "my-server": {
        "command": "bun",
        "args": ["run", "server.js"],
        "env": { "API_KEY": "..." }
      },
      "remote-server": {
        "url": "https://example.com/mcp/",
        "headers": { "Authorization": "Bearer ..." }
      }
    }
  }`;
}

export async function runSproutMcpCli(args: string[]): Promise<number> {
	const [command, ...rest] = args;

	try {
		switch (command) {
			case "list-servers":
				await cmdListServers(rest);
				return 0;
			case "list-tools":
				await cmdListTools(rest);
				return 0;
			case "call-tool":
				await cmdCallTool(rest);
				return 0;
			default:
				console.log(helpText());
				if (command && command !== "--help" && command !== "help") {
					return 1;
				}
				return 0;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(message);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await runSproutMcpCli(process.argv.slice(2)));
}
