"""
Knowhow Harbor Agent Adapter

Runs the Knowhow CLI agent inside a Harbor environment to solve Terminal-Bench tasks.

Usage with harbor run:
    PYTHONPATH=. harbor run \
      -d terminal-bench/terminal-bench-2-1 \
      -a "harbor_agent.knowhow_agent:KnowhowAgent" \
      -m "openai/gpt-5.6-luna" \
      --ak reasoning_effort=high \
      --ak knowhow_version=0.0.145 \
      --ak agent_name=Patcher \
      --ak max_spend_limit=25 \
      -k 3 \
      -i terminal-bench/fix-git -i terminal-bench/overfull-hbox ...
"""

import os
import json
import shlex
from typing import override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class KnowhowAgent(BaseAgent):
    """
    Harbor agent adapter that installs and runs the Knowhow CLI agent.
    """

    SUPPORTS_ATIF: bool = False

    def __init__(
        self,
        *args,
        reasoning_effort: str | None = None,
        knowhow_version: str = "0.0.145",
        agent_name: str = "Patcher",
        max_spend_limit: float = 25,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._reasoning_effort = reasoning_effort
        self._knowhow_version = knowhow_version
        self._agent_name = agent_name
        self._max_spend_limit = max_spend_limit

    @staticmethod
    @override
    def name() -> str:
        return "knowhow"

    @override
    def version(self) -> str | None:
        return self._knowhow_version

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        """Install Node.js and the Knowhow CLI in the task container."""
        package_spec = shlex.quote(f"@tyvm/knowhow@{self._knowhow_version}")
        setup_cmd = (
            "set -euo pipefail; "
            "apt-get update -qq && apt-get install -y -qq curl git 2>&1 | tail -2; "
            "curl -fsSL https://deb.nodesource.com/setup_24.x | bash - 2>&1 | tail -2; "
            "apt-get install -y -qq nodejs 2>&1 | tail -2; "
            "node --version && npm --version; "
            f"npm install -g {package_spec}; "
            # Invoke the real CLI entry point. Calling ts_build/src/index.js is a
            # silent no-op because that file is the SDK, not the CLI.
            "echo \"npm root -g: $(npm root -g)\"; "
            "KH_CLI=\"$(npm root -g)/@tyvm/knowhow/bin/knowhow.js\"; "
            "KH_PLUGINS=\"$(npm root -g)/@tyvm/knowhow/ts_build/src/plugins/plugins.js\"; "
            "echo \"KH_CLI found: $KH_CLI\"; "
            "[ -f \"$KH_CLI\" ] || { echo 'ERROR: could not find knowhow CLI'; exit 1; }; "
            "[ -f \"$KH_PLUGINS\" ] || { echo 'ERROR: could not find Knowhow plugins'; exit 1; }; "
            # v0.0.145 reads plugins.disabled but does not apply it to CLI
            # plugin instances. Do not construct GitPlugin: its event listener
            # creates a shadow task branch and auto-commits benchmark changes.
            "sed -i '/pluginMap\\.set(\"git\", new GitPlugin/d' \"$KH_PLUGINS\"; "
            "! grep -q 'pluginMap\\.set(\"git\", new GitPlugin' \"$KH_PLUGINS\" || "
            "{ echo 'ERROR: could not disable GitPlugin'; exit 1; }; "
            "echo \"$KH_CLI\" > /etc/knowhow_cli_path; "
            "printf '#!/bin/sh\\nexec node --no-node-snapshot %s \"$@\"\\n' \"$KH_CLI\" > /usr/local/bin/kh; "
            "chmod +x /usr/local/bin/kh; "
            "echo \"kh wrapper created: /usr/local/bin/kh\"; cat /usr/local/bin/kh; "
            # Fail setup immediately if packaging or CLI flags regress.
            "kh --version; "
            "kh agent --help | grep -q -- '--reasoning-effort'; "
            "echo 'Knowhow CLI smoke test passed'"
        )
        # Log setup output to the agent log dir
        logged_cmd = f"mkdir -p /logs/agent && {{ {setup_cmd}; }} > /logs/agent/setup.txt 2>&1"
        await self._exec(environment, logged_cmd)

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Run the Knowhow agent on the task instruction."""
        escaped_instruction = shlex.quote(instruction)

        # Determine provider/model from model_name (format: "provider/model")
        model_name = self.model_name or "openai/gpt-5.6-luna"
        if "/" in model_name:
            provider, model = model_name.split("/", 1)
        else:
            provider, model = "openai", model_name

        # Inject only the credential required by this run. Giving every provider
        # key to the task container lets an unrelated shell command disclose all
        # of them through tool output and captured agent logs.
        provider_env_keys = {
            "openai": "OPENAI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
            "qwen": "QWEN_CLOUD_API_KEY",
            "google": "GEMINI_API_KEY",
            "xai": "XAI_API_KEY",
        }
        env_key = provider_env_keys.get(provider)
        if env_key is None:
            raise ValueError(f"No credential mapping configured for provider: {provider}")
        env_value = os.environ.get(env_key)
        if not env_value:
            raise ValueError(f"Required credential is not set: {env_key}")
        env: dict[str, str] = {env_key: env_value}

        # Build reasoning effort flag
        effort_flag = ""
        if self._reasoning_effort:
            effort_flag = f"--reasoning-effort {shlex.quote(self._reasoning_effort)} "

        # `knowhow init` intentionally creates an example browser MCP and module.
        # Neither belongs in a headless benchmark container: npx can block while
        # starting Playwright and the example module is not installed. Use a
        # deterministic, minimal config containing only terminal-agent plugins.
        benchmark_config = json.dumps({
            "promptsDir": ".knowhow/prompts",
            "modules": [],
            "plugins": {
                # The git plugin creates a task branch automatically. That is
                # useful interactively but can alter git benchmark fixtures
                # before the agent receives their instructions.
                "enabled": ["language", "exec", "linter"],
                # Migration 1 enables every known plugin not explicitly listed
                # in either collection, so all unused built-ins must be named.
                "disabled": [
                    "embeddings", "git", "vim", "github", "asana", "jira",
                    "linear", "notion", "download", "figma", "url", "tmux",
                    "agents-md",
                ],
            },
            "mcps": [],
            "modelProviders": [{"provider": provider, "envKey": env_key}],
            "syncRemote": False,
        })

        # Run the real CLI entry point in the task working directory. Knowhow's
        # minimal config is written in the task directory so tools act on the task.
        cmd = (
            "set -o pipefail; { "
            # Diagnostics
            "echo '=== DIAGNOSTICS ==='; "
            "echo \"node: $(node --version 2>&1)\"; "
            "echo \"npm root -g: $(npm root -g 2>&1)\"; "
            "echo \"ls npm global: $(ls $(npm root -g) 2>&1 | head -8)\"; "
            "echo \"HOME: $HOME, PWD: $PWD\"; "
            f"echo \"Selected provider credential present: ${{{env_key}:+YES}}\"; "
            "KH_CLI=$(cat /etc/knowhow_cli_path); "
            "echo \"KH_CLI: $KH_CLI\"; "
            "echo 'Writing benchmark Knowhow config'; "
            "mkdir -p .knowhow; "
            # Hide runtime state without changing the task's tracked
            # .gitignore. `--git-path` supports nonstandard git directories.
            "if git rev-parse --git-dir >/dev/null 2>&1; then "
            "exclude_file=$(git rev-parse --git-path info/exclude); "
            "mkdir -p \"$(dirname \"$exclude_file\")\"; "
            "grep -qxF '/.knowhow/' \"$exclude_file\" 2>/dev/null || "
            "printf '/.knowhow/\\n' >> \"$exclude_file\"; fi; "
            f"printf '%s\\n' {shlex.quote(benchmark_config)} > .knowhow/knowhow.json; "
            "echo '=== STARTING AGENT ==='; "
            f"timeout 840 node --no-node-snapshot \"$KH_CLI\" agent "
            f"--provider {shlex.quote(provider)} "
            f"--model {shlex.quote(model)} "
            f"--agent-name {shlex.quote(self._agent_name)} "
            f"--max-time-limit 14 --max-spend-limit {shlex.quote(str(self._max_spend_limit))} "
            "--renderer plain "
            f"{effort_flag}"
            f"--input {escaped_instruction}; "
            "rc=$?; echo \"exit_code=$rc\"; exit $rc; "
            "} 2>&1 | tee /logs/agent/knowhow.txt"
        )

        await self._exec(environment, cmd, env=env)

    async def _exec(
        self,
        environment: BaseEnvironment,
        command: str,
        env: dict[str, str] | None = None,
    ) -> None:
        """Execute a command in the environment."""
        await environment.exec(
            command=command,
            user=getattr(environment, "default_user", "root"),
            env=env or {},
        )
