import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const launchScriptPath = join(repoRoot, "inspo", "harbor-runner", "launch.sh");
const userdataTemplatePath = join(repoRoot, "inspo", "harbor-runner", "userdata.sh.tpl");
const fixtureTest =
	existsSync(launchScriptPath) && existsSync(userdataTemplatePath) ? test : test.skip;

describe("harbor runner task filtering", () => {
	fixtureTest("launch script exposes task-name forwarding", async () => {
		const script = await readFile(launchScriptPath, "utf-8");
		expect(script).toContain("--task-name STR");
		expect(script).toContain("TASK_NAMES=()");
		expect(script).toContain('--task-name)       TASK_NAMES+=("$2"); shift 2 ;;');
		expect(script).toContain(
			'TASK_NAME_LINES+="HARBOR_CMD+=\\" --task-name $escaped_task_name\\"\\n"',
		);
		expect(script).toContain('| sed "s|__TASK_NAME_FLAGS__|$(echo -e "$TASK_NAME_LINES")|g" \\');
	});

	fixtureTest("userdata template includes task-name placeholder", async () => {
		const template = await readFile(userdataTemplatePath, "utf-8");
		expect(template).toContain("__TASK_NAME_FLAGS__");
	});
});
