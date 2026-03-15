"""Harbor installed-agent adapter for Sprout."""

import json
import os
import shlex
import shutil
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, ExecInput
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_AGENT_DIR = Path(__file__).parent
_CONTAINER_STATE_DIR = "/logs/agent/agent-state"
PROVIDER_ENV_KEYS = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}

_ARTIFACT_EXCLUDES = [
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "*.pyc",
    "*.o",
    "*.so",
    ".cache",
]


def _parse_model_ref(model_ref: str, label: str) -> tuple[str, str]:
    if ":" not in model_ref:
        raise ValueError(
            f"Invalid {label}: {model_ref!r}. Expected a full provider:model reference."
        )

    provider, model = model_ref.split(":", 1)
    if not provider or not model:
        raise ValueError(
            f"Invalid {label}: {model_ref!r}. Expected a full provider:model reference."
        )

    return provider, model


class SproutAgent(BaseInstalledAgent):
    """Sprout agent: headless coding agent with native ATIF logging."""

    def __init__(self, *args, **kwargs):
        self._default_model_overrides = {
            "best": kwargs.pop("best_model", None),
            "balanced": kwargs.pop("balanced_model", None),
            "fast": kwargs.pop("fast_model", None),
        }
        super().__init__(*args, **kwargs)
        if self._parsed_model_provider:
            self._provider = self._parsed_model_provider
            self._model = self._parsed_model_name
        else:
            self._provider = os.environ.get("SPROUT_PROVIDER", "openai")
            self._model = self._parsed_model_name or "gpt-5-mini"

        self._resolved_default_models = self._resolve_default_models()

    @staticmethod
    def name() -> str:
        return "sprout"

    @property
    def _install_agent_template_path(self) -> Path:
        return _AGENT_DIR / "install-sprout.sh.j2"

    async def setup(self, environment: BaseEnvironment) -> None:
        await environment.exec(command="mkdir -p /installed-agent")
        for binary in sorted(_AGENT_DIR.glob("sprout-linux-*")):
            await environment.upload_file(
                source_path=binary,
                target_path=f"/installed-agent/{binary.name}",
            )

        await super().setup(environment)

    def create_run_agent_commands(self, instruction: str) -> list[ExecInput]:
        escaped_instruction = shlex.quote(instruction)

        env = {
            "SPROUT_SECRET_BACKEND": "memory",
            "SPROUT_DEFAULT_BEST_MODEL": self._resolved_default_models["best"],
            "SPROUT_DEFAULT_BALANCED_MODEL": self._resolved_default_models["balanced"],
            "SPROUT_DEFAULT_FAST_MODEL": self._resolved_default_models["fast"],
            "XDG_CONFIG_HOME": f"{_CONTAINER_STATE_DIR}/config",
        }

        for provider in self._referenced_providers():
            provider_env_key = PROVIDER_ENV_KEYS.get(provider)
            if not provider_env_key:
                raise ValueError(f"Unsupported Sprout benchmark provider: {provider}")
            api_key = os.environ.get(provider_env_key)
            if api_key:
                env[provider_env_key] = api_key

        return [
            ExecInput(
                command=(
                    f"mkdir -p {_CONTAINER_STATE_DIR} "
                    f"&& cd /app "
                    "&& sprout --genome-path /logs/agent/agent-state/genome "
                    "--log-atif /logs/agent/agent-state/trajectory.json "
                    f"--eval-mode "
                    f"--prompt {escaped_instruction}"
                ),
                env=env,
            )
        ]

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        try:
            await super().run(instruction, environment, context)
        finally:
            local_state_dir = self.logs_dir / "agent-state"
            try:
                await environment.download_dir(_CONTAINER_STATE_DIR, local_state_dir)
                self.logger.info("Downloaded Sprout agent state to %s", local_state_dir)
            except Exception as error:
                self.logger.warning("Could not download Sprout agent state: %s", error)

            trajectory_src = local_state_dir / "trajectory.json"
            if trajectory_src.exists():
                shutil.copy2(trajectory_src, self.logs_dir / "trajectory.json")
                self.logger.info("Copied trajectory to %s", self.logs_dir / "trajectory.json")

            self._populate_context(context)

            artifacts_dir = self.logs_dir / "artifacts"
            try:
                await environment.download_dir("/app", artifacts_dir)
                _prune_artifacts(artifacts_dir, _ARTIFACT_EXCLUDES)
            except Exception as error:
                self.logger.warning("Could not download /app artifacts: %s", error)

    def populate_context_post_run(self, context: AgentContext) -> None:
        pass

    def _populate_context(self, context: AgentContext) -> None:
        trajectory_path = self.logs_dir / "trajectory.json"
        if not trajectory_path.exists():
            return

        try:
            trajectory = json.loads(trajectory_path.read_text())
        except (json.JSONDecodeError, OSError) as error:
            self.logger.warning("Failed to read Sprout trajectory: %s", error)
            return

        metrics = trajectory.get("final_metrics", {})
        context.n_input_tokens = metrics.get("total_prompt_tokens", 0)
        context.n_output_tokens = metrics.get("total_completion_tokens", 0)
        context.n_cache_tokens = metrics.get("total_cached_tokens", 0)

    def _fallback_model_ref(self) -> str:
        return f"{self._provider}:{self._model}"

    def _resolve_default_models(self) -> dict[str, str]:
        defaults: dict[str, str] = {}
        fallback = self._fallback_model_ref()
        for slot, override in self._default_model_overrides.items():
            model_ref = fallback if override is None else override
            provider, model = _parse_model_ref(model_ref, f"{slot}_model")
            defaults[slot] = f"{provider}:{model}"
        return defaults

    def _referenced_providers(self) -> set[str]:
        providers: set[str] = set()
        for model_ref in self._resolved_default_models.values():
            provider, _ = _parse_model_ref(model_ref, "default model")
            providers.add(provider)
        return providers


def _prune_artifacts(root: Path, excludes: list[str]) -> None:
    for pattern in excludes:
        for match in root.rglob(pattern):
            if match.is_dir():
                shutil.rmtree(match, ignore_errors=True)
            elif match.is_file():
                match.unlink(missing_ok=True)
