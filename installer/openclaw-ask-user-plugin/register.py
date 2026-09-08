#!/usr/bin/env python3
"""Register the BridgesLLM ask-user plugin with OpenClaw.

Merges into the existing OpenClaw config rather than replacing it: the file is
shared with every other plugin and with the operator's own settings.
"""

import json
import os

PLUGIN_ID = "bridgesllm-ask-user"
CONFIG_PATH = "/root/.openclaw/openclaw.json"


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
