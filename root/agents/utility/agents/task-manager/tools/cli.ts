import { TaskStore } from "./store.ts";

function usage(): string {
	return [
		"Usage: task-cli [--tasks-file <path>] <command> [options]",
		"",
		"Tasks file defaults to $SPROUT_GENOME_PATH/logs/$SPROUT_SESSION_ID/tasks.json",
		"",
		"Commands:",
		"  create   --description <text> [--prompt <text>] [--assigned-to <agent>]",
		"  list     [--status <status>]",
		"  get      --id <task-id>",
		"  update   --id <task-id> [--status <status>] [--assigned-to <agent>] [--description <text>]",
		"  comment  --id <task-id> --text <text>",
	].join("\n");
}

function parseArgs(argv: string[]): { flags: Record<string, string>; command: string | undefined } {
	const flags: Record<string, string> = {};
	let command: string | undefined;
	let i = 0;

	while (i < argv.length) {
		const arg = argv[i]!;
		if (arg.startsWith("--") && i + 1 < argv.length) {
			flags[arg.slice(2)] = argv[i + 1]!;
			i += 2;
		} else if (!command && !arg.startsWith("--")) {
			command = arg;
			i++;
		} else {
			i++;
		}
	}

	return { flags, command };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const { flags, command } = parseArgs(args);

	const tasksFile =
		flags["tasks-file"] ??
		(process.env.SPROUT_GENOME_PATH && process.env.SPROUT_SESSION_ID
			? `${process.env.SPROUT_GENOME_PATH}/logs/${process.env.SPROUT_SESSION_ID}/tasks.json`
			: undefined);
	if (!tasksFile) {
		console.error(
			JSON.stringify({
				error:
					"No tasks file: pass --tasks-file or set SPROUT_GENOME_PATH and SPROUT_SESSION_ID",
			}),
		);
		process.exit(1);
	}

	if (!command) {
		console.error(JSON.stringify({ error: `No command specified.\n${usage()}` }));
		process.exit(1);
	}

	const store = new TaskStore(tasksFile);

	try {
		switch (command) {
			case "create": {
				const description = flags.description;
				if (!description) {
					console.error(JSON.stringify({ error: "create requires --description" }));
					process.exit(1);
				}
				const task = await store.create(description, flags.prompt, flags["assigned-to"]);
				console.log(JSON.stringify(task, null, 2));
				break;
			}

			case "list": {
				const status = flags.status as "new" | "in_progress" | "done" | "cancelled" | undefined;
				const tasks = await store.list(status);
				console.log(JSON.stringify(tasks, null, 2));
				break;
			}

			case "get": {
				const id = flags.id;
				if (!id) {
					console.error(JSON.stringify({ error: "get requires --id" }));
					process.exit(1);
				}
				const task = await store.get(id);
				console.log(JSON.stringify(task, null, 2));
				break;
			}

			case "update": {
				const id = flags.id;
				if (!id) {
					console.error(JSON.stringify({ error: "update requires --id" }));
					process.exit(1);
				}
				const fields: Record<string, string | null> = {};
				if (flags.status) fields.status = flags.status;
				if (flags["assigned-to"] !== undefined) fields.assigned_to = flags["assigned-to"];
				if (flags.description) fields.description = flags.description;
				const task = await store.update(id, fields);
				console.log(JSON.stringify(task, null, 2));
				break;
			}

			case "comment": {
				const id = flags.id;
				const text = flags.text;
				if (!id || !text) {
					console.error(JSON.stringify({ error: "comment requires --id and --text" }));
					process.exit(1);
				}
				const task = await store.comment(id, text);
				console.log(JSON.stringify(task, null, 2));
				break;
			}

			default:
				console.error(JSON.stringify({ error: `Unknown command: ${command}\n${usage()}` }));
				process.exit(1);
		}
	} catch (err) {
		console.error(JSON.stringify({ error: String(err) }));
		process.exit(1);
	}
}

main();
