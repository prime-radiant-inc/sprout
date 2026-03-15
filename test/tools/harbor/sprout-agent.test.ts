import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const adapterPath = join(repoRoot, "tools", "harbor", "sprout_agent.py");

function runPython(script: string, env: Record<string, string> = {}) {
	return Bun.spawnSync(["python3", "-c", script], {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
}

function decode(bytes: Uint8Array) {
	return new TextDecoder().decode(bytes);
}

function buildAdapterScript(modelName: string, kwargs: Record<string, string> = {}) {
	const serializedKwargs = JSON.stringify(kwargs);
	return `
import importlib.util
import json
import os
import sys
import tempfile
import types
from dataclasses import dataclass
from pathlib import Path

harbor = types.ModuleType("harbor")
agents = types.ModuleType("harbor.agents")
installed = types.ModuleType("harbor.agents.installed")
base = types.ModuleType("harbor.agents.installed.base")
environments = types.ModuleType("harbor.environments")
environments_base = types.ModuleType("harbor.environments.base")
models = types.ModuleType("harbor.models")
models_agent = types.ModuleType("harbor.models.agent")
models_agent_context = types.ModuleType("harbor.models.agent.context")

@dataclass
class ExecInput:
    command: str
    cwd: str | None = None
    env: dict[str, str] | None = None
    timeout_sec: int | None = None

class BaseInstalledAgent:
    def __init__(self, logs_dir, model_name=None, *args, **kwargs):
        self.logs_dir = Path(logs_dir)
        self.model_name = model_name
        self._parsed_model_provider = None
        self._parsed_model_name = None
        if model_name:
            if "/" in model_name:
                self._parsed_model_provider, self._parsed_model_name = model_name.split("/", 1)
            else:
                self._parsed_model_name = model_name

class BaseEnvironment:
    pass

class AgentContext:
    pass

base.BaseInstalledAgent = BaseInstalledAgent
base.ExecInput = ExecInput
environments_base.BaseEnvironment = BaseEnvironment
models_agent_context.AgentContext = AgentContext

sys.modules["harbor"] = harbor
sys.modules["harbor.agents"] = agents
sys.modules["harbor.agents.installed"] = installed
sys.modules["harbor.agents.installed.base"] = base
sys.modules["harbor.environments"] = environments
sys.modules["harbor.environments.base"] = environments_base
sys.modules["harbor.models"] = models
sys.modules["harbor.models.agent"] = models_agent
sys.modules["harbor.models.agent.context"] = models_agent_context

spec = importlib.util.spec_from_file_location("sprout_agent", ${JSON.stringify(adapterPath)})
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

kwargs = json.loads(${JSON.stringify(serializedKwargs)})
agent = module.SproutAgent(logs_dir=Path(tempfile.mkdtemp()), model_name=${JSON.stringify(modelName)}, **kwargs)
command = agent.create_run_agent_commands("do the thing")[0]
print(json.dumps(command.env, sort_keys=True))
`;
}

function parseEnv(result: ReturnType<typeof runPython>) {
	const stderr = decode(result.stderr);
	expect(result.exitCode, stderr).toBe(0);
	return JSON.parse(decode(result.stdout)) as Record<string, string>;
}

describe("Sprout Harbor adapter model defaults", () => {
	test("uses Harbor model as the fallback for all default slots", () => {
		const result = runPython(buildAdapterScript("openai/gpt-5.4"), {
			OPENAI_API_KEY: "openai-key",
		});
		const env = parseEnv(result);
		expect(env.SPROUT_DEFAULT_BEST_MODEL).toBe("openai:gpt-5.4");
		expect(env.SPROUT_DEFAULT_BALANCED_MODEL).toBe("openai:gpt-5.4");
		expect(env.SPROUT_DEFAULT_FAST_MODEL).toBe("openai:gpt-5.4");
		expect(env.OPENAI_API_KEY).toBe("openai-key");
	});

	test("allows overriding only the fast default model", () => {
		const result = runPython(
			buildAdapterScript("openai/gpt-5.4", {
				fast_model: "openai:gpt-5-mini",
			}),
			{
				OPENAI_API_KEY: "openai-key",
			},
		);
		const env = parseEnv(result);
		expect(env.SPROUT_DEFAULT_BEST_MODEL).toBe("openai:gpt-5.4");
		expect(env.SPROUT_DEFAULT_BALANCED_MODEL).toBe("openai:gpt-5.4");
		expect(env.SPROUT_DEFAULT_FAST_MODEL).toBe("openai:gpt-5-mini");
		expect(env.OPENAI_API_KEY).toBe("openai-key");
	});

	test("exports credentials for every provider referenced by the resolved defaults", () => {
		const result = runPython(
			buildAdapterScript("openai/gpt-5.4", {
				fast_model: "openrouter:openai/gpt-5-mini",
			}),
			{
				OPENAI_API_KEY: "openai-key",
				OPENROUTER_API_KEY: "openrouter-key",
			},
		);
		const env = parseEnv(result);
		expect(env.SPROUT_DEFAULT_BEST_MODEL).toBe("openai:gpt-5.4");
		expect(env.SPROUT_DEFAULT_FAST_MODEL).toBe("openrouter:openai/gpt-5-mini");
		expect(env.OPENAI_API_KEY).toBe("openai-key");
		expect(env.OPENROUTER_API_KEY).toBe("openrouter-key");
	});

	test("rejects malformed per-default override values", () => {
		const result = runPython(
			buildAdapterScript("openai/gpt-5.4", {
				fast_model: "gpt-5-mini",
			}),
		);
		const stderr = decode(result.stderr);
		expect(result.exitCode).toBe(1);
		expect(stderr).toContain("provider:model");
	});
});
