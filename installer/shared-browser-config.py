#!/usr/bin/env python3
"""Source-only shared-browser config composer: product config JSON on stdin -> JSON on stdout.

`patch` emits an `openclaw config patch` merge patch for the product instance.
The installer applies it through OpenClaw's own validating
writer (dry run first). `verify` exits 0 only when the configuration already carries the
commissioned shape. No runtime mutation and no host/VM config discovery happens here.
This composer requires the qualified runtime's agents.entries.<id> roster.
A configuration carrying agents.list needs an explicit runtime migration first.
"""
import copy
import json
import re
import sys

PLUGIN_ID = 'bridgesllm-shared-browser'
PROFILE_NAME = 'portal-shared'
PROFILE = {'cdpUrl': 'http://127.0.0.1:18901', 'attachOnly': True}
GRANTS = ('browser', 'shared_browser_select', 'shared_browser_handover')
AGENT_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')


def _object(value, label):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    return value


def _strings(value, label):
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f'{label} must be a list of strings')
    return list(value)


def _appended(values, additions):
    result = list(values)
    for item in additions:
        if item not in result:
            result.append(item)
    return result


def _profile_targets_port(profile):
    return isinstance(profile, dict) and (profile.get('cdpPort') == 18901
                                          or str(profile.get('cdpUrl', '')).rstrip('/').endswith(':18901'))


def compose(config, agent_ids, plugin_path):
    if not isinstance(config, dict):
        raise ValueError('Product configuration must be a JSON object')
    if not agent_ids or len(agent_ids) > 32 or len(set(agent_ids)) != len(agent_ids) \
            or any(not AGENT_ID.fullmatch(value) for value in agent_ids):
        raise ValueError('Explicit, unique authorized agent IDs are required')
    if not plugin_path.startswith('/') or '/../' in plugin_path or plugin_path.endswith('/..'):
        raise ValueError('Explicit installed plugin path is required')
    agents = _object(config.get('agents'), 'agents')
    if 'list' in agents:
        raise ValueError('This configuration still carries a legacy agents.list roster; migrate it explicitly first')
    entries = _object(agents.get('entries'), 'agents.entries')
    missing = [agent_id for agent_id in agent_ids if not isinstance(entries.get(agent_id), dict)]
    if missing:
        raise ValueError('Authorized agents must be explicit agents.entries in this product configuration: '
                         + ', '.join(missing))
    browser = _object(config.get('browser'), 'browser')
    if browser.get('enabled') is False:
        raise ValueError('The browser is disabled in this product configuration; review explicitly')
    profiles = _object(browser.get('profiles'), 'browser.profiles')
    if PROFILE_NAME in profiles and profiles[PROFILE_NAME] != PROFILE:
        raise ValueError('portal-shared already exists with a different target; review explicitly')
    if any(_profile_targets_port(profile) for name, profile in profiles.items() if name != PROFILE_NAME):
        raise ValueError('Another browser profile already targets the shared-browser CDP port 18901')
    plugins = _object(config.get('plugins'), 'plugins')
    if plugins.get('enabled') is False:
        raise ValueError('Plugins are disabled in this product configuration; review explicitly')
    denied = set(_strings(plugins.get('deny'), 'plugins.deny'))
    if denied & {PLUGIN_ID, 'browser'}:
        raise ValueError('A plugin deny rule blocks the shared browser; review explicitly')
    plugin_entries = _object(plugins.get('entries'), 'plugins.entries')
    if _object(plugin_entries.get('browser'), 'plugins.entries.browser').get('enabled') is False:
        raise ValueError('The bundled browser plugin is disabled; review explicitly')
    global_deny = set(_strings(_object(config.get('tools'), 'tools').get('deny'), 'tools.deny'))
    load = _object(plugins.get('load'), 'plugins.load')
    patch = {
        'browser': {'enabled': True, 'allowSystemProfileImport': False, 'profiles': {PROFILE_NAME: dict(PROFILE)}},
        # No node auto-routing: the shared browser is the host target only.
        'gateway': {'nodes': {'browser': {'mode': 'off'}}},
        'plugins': {
            'load': {'paths': _appended(_strings(load.get('paths'), 'plugins.load.paths'), [plugin_path])},
            'entries': {PLUGIN_ID: {'enabled': True, 'config': {'agentIds': list(agent_ids)}}},
        },
        'agents': {'entries': {}},
    }
    if 'allow' in plugins:
        patch['plugins']['allow'] = _appended(_strings(plugins['allow'], 'plugins.allow'), ['browser', PLUGIN_ID])
    for agent_id in agent_ids:
        tools = _object(entries[agent_id].get('tools'), f'agents.entries.{agent_id}.tools')
        if tools.get('allow') and tools.get('alsoAllow'):
            raise ValueError(f'agents.entries.{agent_id}.tools sets both allow and alsoAllow; review explicitly')
        if (set(_strings(tools.get('deny'), f'agents.entries.{agent_id}.tools.deny')) | global_deny) & set(GRANTS):
            raise ValueError(f'A tool deny rule blocks the shared browser for {agent_id}; review explicitly')
        # Additive grants only: extend an explicit allow list, otherwise alsoAllow.
        key = 'allow' if tools.get('allow') else 'alsoAllow'
        granted = _appended(_strings(tools.get(key), f'agents.entries.{agent_id}.tools.{key}'), GRANTS)
        patch['agents']['entries'][agent_id] = {'tools': {key: granted}}
    return patch


def merged(config, patch):
    """Apply the merge-patch semantics of `openclaw config patch` (objects merge, lists replace)."""
    result = copy.deepcopy(config)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merged(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def commissioned(config, agent_ids, plugin_path):
    return merged(config, compose(config, agent_ids, plugin_path)) == config


if __name__ == '__main__':
    if len(sys.argv) < 4 or sys.argv[1] not in {'patch', 'verify'}:
        raise SystemExit('Usage: shared-browser-config.py patch|verify /absolute/installed/plugin/path agent-id [agent-id...] < product-config.json')
    try:
        product = json.load(sys.stdin)
        if sys.argv[1] == 'verify':
            raise SystemExit(0 if commissioned(product, sys.argv[3:], sys.argv[2]) else 1)
        json.dump(compose(product, sys.argv[3:], sys.argv[2]), sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write('\n')
    except (ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f'shared-browser configuration refused: {error}')
