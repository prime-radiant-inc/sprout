import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

describe("harbor runner task filtering", () => {
	test("launch script exposes task-name forwarding", async () => {
		const script = await readFile(join(repoRoot, "inspo", "harbor-runner", "launch.sh"), "utf-8");
		expect(script).toContain("--task-name STR");
		expect(script).toContain('TASK_NAMES=()');
		expect(script).toContain('--task-name)       TASK_NAMES+=("$2"); shift 2 ;;');
		expect(script).toContain('TASK_NAME_LINES+="HARBOR_CMD+=\\" --task-name $escaped_task_name\\"\\n"');
		expect(script).toContain('| sed "s|__TASK_NAME_FLAGS__|$(echo -e "$TASK_NAME_LINES")|g" \\');
	});

	test("userdata template includes task-name placeholder", async () => {
		const template = await readFile(
			join(repoRoot, "inspo", "harbor-runner", "userdata.sh.tpl"),
			"utf-8",
		);
		expect(template).toContain("__TASK_NAME_FLAGS__");
	});
});
