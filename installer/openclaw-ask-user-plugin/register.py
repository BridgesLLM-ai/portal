#!/usr/bin/env python3
"""Register the BridgesLLM ask-user plugin with OpenClaw.

Merges into the existing OpenClaw config rather than replacing it: the file is
shared with every other plugin and with the operator's own settings.
"""

import json
import os

PLUGIN_ID = "bridgesllm-ask-user"
CONFIG_PATH = "/root/.openclaw/openclaw.json"
CLAUDE_CLI_BACKEND_ID = "claude-cli"
CLAUDE_CLI_DEFAULT_COMMAND = "claude"
CLAUDE_CLI_MCP_TIMEOUT_ENV = {
    # The ask-user tool can wait for a person for ten minutes. Claude Code has
    # separate total-call and idle HTTP MCP timers, so both need the same
    # bounded grace beyond the plugin's 600-second question lifetime.
    "MCP_TOOL_TIMEOUT": "660000",
    "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT": "660000",
}


def main() -> int:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except FileNotFoundError:
        config = {}
    except (OSError, ValueError) as error:
        print(f"ask-user plugin: unreadable OpenClaw config: {error}")
        return 1

    if not isinstance(config, dict):
        print("ask-user plugin: OpenClaw config is not an object")
        return 1

    if "plugins" not in config:
        config["plugins"] = {}
    plugins = config["plugins"]
    if not isinstance(plugins, dict):
        print("ask-user plugin: plugins block is not an object")
        return 1

    # Only extend an allowlist that already exists. Creating one where there
    # was none would turn "allow everything" into "allow exactly this plugin"
    # and silently disable every other plugin on the host.
    if "allow" in plugins:
        allow = plugins["allow"]
        if not isinstance(allow, list):
            print("ask-user plugin: plugins.allow is not an array")
            return 1
        if PLUGIN_ID not in allow:
            allow.append(PLUGIN_ID)

    if "entries" not in plugins:
        plugins["entries"] = {}
    entries = plugins["entries"]
    if not isinstance(entries, dict):
        print("ask-user plugin: plugins.entries is not an object")
        return 1

    if PLUGIN_ID not in entries:
        entries[PLUGIN_ID] = {}
    entry = entries[PLUGIN_ID]
    if not isinstance(entry, dict):
        print(f"ask-user plugin: plugins.entries.{PLUGIN_ID} is not an object")
        return 1
    entry["enabled"] = True
    # Version 1 used a loopback HTTP broker and a blocking before_tool_call
    # hook. Remove those stale settings so the empty v3 schema loads cleanly
    # and no gateway token remains duplicated in plugin configuration. A
    # positional token is accepted and ignored for compatibility with older
    # installers.
    entry["config"] = {}
    entry.pop("hooks", None)

    # OpenClaw's registered Claude backend merges `env` key-by-key, while its
    # config schema still requires every override entry to carry a command.
    # Preserve an operator's existing command and every unrelated backend/env
    # field; only provide the stock command when no override existed yet.
    if "agents" not in config:
        config["agents"] = {}
    agents = config["agents"]
    if not isinstance(agents, dict):
        print("ask-user plugin: agents block is not an object")
        return 1

    if "defaults" not in agents:
        agents["defaults"] = {}
    defaults = agents["defaults"]
    if not isinstance(defaults, dict):
        print("ask-user plugin: agents.defaults is not an object")
        return 1

    if "cliBackends" not in defaults:
        defaults["cliBackends"] = {}
    cli_backends = defaults["cliBackends"]
    if not isinstance(cli_backends, dict):
        print("ask-user plugin: agents.defaults.cliBackends is not an object")
        return 1

    if CLAUDE_CLI_BACKEND_ID not in cli_backends:
        cli_backends[CLAUDE_CLI_BACKEND_ID] = {}
    claude_backend = cli_backends[CLAUDE_CLI_BACKEND_ID]
    if not isinstance(claude_backend, dict):
        print(
            "ask-user plugin: "
            f"agents.defaults.cliBackends.{CLAUDE_CLI_BACKEND_ID} is not an object"
        )
        return 1

    if "command" not in claude_backend:
        claude_backend["command"] = CLAUDE_CLI_DEFAULT_COMMAND
    command = claude_backend["command"]
    if not isinstance(command, str) or not command.strip():
        print(
            "ask-user plugin: "
            f"agents.defaults.cliBackends.{CLAUDE_CLI_BACKEND_ID}.command "
            "is not a non-empty string"
        )
        return 1

    if "env" not in claude_backend:
        claude_backend["env"] = {}
    claude_env = claude_backend["env"]
    if not isinstance(claude_env, dict):
        print(
            "ask-user plugin: "
            f"agents.defaults.cliBackends.{CLAUDE_CLI_BACKEND_ID}.env is not an object"
        )
        return 1
    claude_env.update(CLAUDE_CLI_MCP_TIMEOUT_ENV)

    temporary = CONFIG_PATH + ".ask-user.tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, CONFIG_PATH)
        directory_fd = os.open(os.path.dirname(CONFIG_PATH), os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as error:
        print(f"ask-user plugin: could not write OpenClaw config: {error}")
        try:
            os.unlink(temporary)
        except OSError:
            pass
        return 1

    print(f"ask-user plugin: registered {PLUGIN_ID}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
