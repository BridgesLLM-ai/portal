"""Unit tests for installer/tools/bridgesllm-toolctl.py.

Run: python3 -I -m unittest discover -s installer/tools/tests -v
Temp dirs and fake state only: no root, no systemctl, no network.
"""

import contextlib
import copy
import fcntl
import io
import importlib.util
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from tool_policy_fixture import core_updates_on, shipped_policy, unqualified_policy, unqualified_policy_text

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.dirname(HERE)
TOOLCTL_PATH = os.path.join(TOOLS_DIR, "bridgesllm-toolctl.py")
# Native outputs DERIVED FROM DIST (see fixtures/native-derived/README.md): shapes
# read from the 2026.10.9 and installed 2026.9.9 code; not yet recorded live.
NATIVE_FIXTURES = os.path.join(HERE, "fixtures", "native-derived")

_spec = importlib.util.spec_from_file_location("bridgesllm_toolctl", TOOLCTL_PATH)
toolctl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(toolctl)

RUN_ID = "0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01"
OTHER_RUN_ID = "5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12"
# One value of each newestProven.integrity form (COMMON-W7 integrity contract).
INTEGRITY_SRI = "sha512-" + "B" * 86 + "=="
INTEGRITY_SHA256 = "sha256:" + "a" * 64
INTEGRITY_SHA512 = "sha512:" + "b" * 128
INTEGRITY_TREE = "sha256-tree:" + "c" * 64
FAKE_SECRET = "fake-secret-value-9f8e7d6c5b4a3210"
TARGET_META = {
    "version": "2026.10.9",
    "engines": {"node": ">=24.22.1 <25 || >=26.12.1"},
    "dist": {"unpackedSize": 250 * 1000 * 1000, "fileCount": 9000,
             "integrity": "sha512-" + "A" * 86 + "=="},
}


class FakeStatvfs(object):
    def __init__(self, free_bytes=10 ** 13, free_inodes=10 ** 7):
        self.free_bytes = free_bytes
        self.free_inodes = free_inodes

    def __call__(self, _path):
        return mock.Mock(f_bavail=self.free_bytes // 4096, f_frsize=4096, f_favail=self.free_inodes)


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(text)
    os.chmod(path, mode)


def native_fixture(name):
    with open(os.path.join(NATIVE_FIXTURES, name)) as handle:
        return handle.read()


# The fake `openclaw` bin keeps the real bin's `#!/usr/bin/env node` first line
# (PF-7 resolves the gateway Node.js from it); its body is shell, run by the
# fake node below. Each call is logged; replies come from files in <base>/fake:
# <key>.json (stdout), <key>.stderr, <key>.exit, optional <key>.sh (sourced).
FAKE_OPENCLAW = """#!/usr/bin/env node
FAKE=%(fake)s
printf '%%s|%%s\\n' "$HOME" "$*" >> "$FAKE/calls.log"
case "$*" in
  "update status --json") key=status ;;
  "gateway status --deep --require-rpc --json") key=gateway-status ;;
  "gateway status --require-rpc --json") key=gateway-rpc ;;
  "plugins inspect "*) key=plugins-inspect ;;
  "plugins install "*) key=plugins-install ;;
  "plugins reload "*) key=plugins-reload ;;
  "update --dry-run --json"*) key=dry-run ;;
  "update --channel"*) key=update ;;
  "update repair"*) key=repair ;;
  "gateway call "*) key=gateway-call ;;
  "config get "*) key=config-get ;;
  "plugins "*) key=plugins ;;
  *) key=unknown ;;
esac
[ -f "$FAKE/$key.sh" ] && . "$FAKE/$key.sh"
[ -f "$FAKE/$key.stderr" ] && cat "$FAKE/$key.stderr" >&2
[ -f "$FAKE/$key.json" ] && cat "$FAKE/$key.json"
exit "$(cat "$FAKE/$key.exit" 2>/dev/null || echo 0)"
"""

# The fake node answers --version and otherwise runs its script argument as shell.
FAKE_NODE = """#!/bin/sh
if [ "$1" = "--version" ]; then echo %(version)s; exit 0; fi
exec /bin/sh "$@"
"""

# Fake plugin registry: $FAKE/plugins/<id>.json is an installed plugin's inspect document.
PLUGINS_INSPECT_SH = """[ -f "$FAKE/plugins/$3.json" ] || { echo "plugin not found: $3" >&2; exit 1; }
cat "$FAKE/plugins/$3.json"; exit 0
"""
PLUGINS_INSTALL_SH = """[ -f "$FAKE/plugins-install.fail" ] && exit 1
base=$(basename "$3" .tgz); id=${base%-*}; version=${base##*-}
mkdir -p "$FAKE/plugins"
printf '{"plugin": {"id": "%s", "version": "%s", "status": "loaded", "enabled": true}, "install": {"source": "archive", "version": "%s"}}' \\
  "$id" "$version" "$version" > "$FAKE/plugins/$id.json"
exit 0
"""


def plugin_doc(plugin_id, version, status="loaded", enabled=True, error=None):
    """A `plugins inspect <id> --json` document (fixtures/native-derived/plugins-inspect.loaded.json shape)."""
    record = {"id": plugin_id, "version": version, "status": status, "enabled": enabled}
    if error is not None:
        record["error"] = error
    return {"plugin": record, "install": {"source": "archive", "version": version}}

# Fake gateway RPC through `gateway call <method>`: config.get answers a config
# (with a secret value that must never reach evidence); the ask-user plugin's
# method answers its own validation error, or "unknown method" when told to.
GATEWAY_CALL_SH = """case "$3" in
  config.get) [ -f "$FAKE/config-get.exit" ] && exit "$(cat "$FAKE/config-get.exit")"
    [ -f "$FAKE/config-get.big" ] && { cat "$FAKE/config-get.big"; exit 0; }
    printf '{"path": "/x/openclaw.json", "exists": true, "valid": true, "hash": "h1", "config": {"gateway": {"auth": {"token": "%s"}}, "plugins": {}}}' "%(secret)s"; exit 0 ;;
  bridgesllm.ask_user.steer) [ -f "$FAKE/steer-unknown" ] && { echo '{"ok": false, "error": {"message": "unknown method: bridgesllm.ask_user.steer"}}'; exit 1; }
    echo '{"ok": false, "error": {"message": "sessionKey, expectedRunId, requestId, and text must be valid bounded strings."}}'; exit 1 ;;
esac
echo '{"ok": false, "error": {"message": "unknown method"}}'; exit 1
"""

# The fake systemctl keeps the unit state in $FAKE/is-active (default active): stop makes it
# inactive (or exits $FAKE/stop.exit), start makes it $FAKE/start-state (default active; or exits
# $FAKE/start.exit, after sourcing $FAKE/start.sh); is-active and anything else print the state.
FAKE_SYSTEMCTL = """#!/bin/sh
FAKE=%(fake)s
printf '%%s\\n' "$*" >> "$FAKE/systemctl.log"
case "$1" in
  stop) [ -f "$FAKE/stop.exit" ] && exit "$(cat "$FAKE/stop.exit")"
    echo inactive > "$FAKE/is-active"; exit 0 ;;
  start) [ -f "$FAKE/start.sh" ] && . "$FAKE/start.sh"
    [ -f "$FAKE/start.exit" ] && exit "$(cat "$FAKE/start.exit")"
    if [ -f "$FAKE/start-state" ]; then cp "$FAKE/start-state" "$FAKE/is-active"; else echo active > "$FAKE/is-active"; fi
    exit 0 ;;
  reset-failed) exit 0 ;;
esac
state=$(cat "$FAKE/is-active" 2>/dev/null || echo active)
echo "$state"
[ "$state" = active ]
"""


# Recorded from `apt-cache madison nodejs` on an Ubuntu host (2026-10-30, read-only).
MADISON = """    nodejs | 24.22.2-1nodesource1 | https://deb.nodesource.com/node_24.x nodistro/main amd64 Packages
    nodejs | 24.22.1-1nodesource1 | https://deb.nodesource.com/node_24.x nodistro/main amd64 Packages
    nodejs | 24.22.0-1nodesource1 | https://deb.nodesource.com/node_24.x nodistro/main amd64 Packages
    nodejs | 24.21.0-1nodesource1 | https://deb.nodesource.com/node_24.x nodistro/main amd64 Packages
    nodejs | 18.19.1+dfsg-6ubuntu5 | http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages
"""

FAKE_APT = """#!/bin/sh
FAKE=%(fake)s
printf '%%s\\n' "$*" >> "$FAKE/apt.log"
case "$1" in
  update) exit "$(cat "$FAKE/apt-update.exit" 2>/dev/null || echo 0)" ;;
  install) cp "$FAKE/node-new" '%(node)s'; exit 0 ;;
  madison) cat "$FAKE/madison.txt" ;;
  -W) cat "$FAKE/dpkg-version.txt" ;;
esac
"""


class FakeHttp(object):
    def __init__(self, status=200):
        self.status = status
        self.urls = []

    def __call__(self, url, timeout):
        self.urls.append(url)
        return (self.status, None) if self.status is not None else (None, "connection refused")


class Host(object):
    """A fake host tree under a temp dir, with every toolctl root injected."""

    def __init__(self, node_version="v24.22.1", installed="2026.9.9", target_meta=None):
        self.base = tempfile.mkdtemp(prefix="toolctl-test-")
        b = self.base
        self.paths = {
            "state_root": b + "/var/lib/bridgesllm/tools",
            "installer_state_root": b + "/var/lib/bridgesllm-installer",
            "gateway_fence_marker": b + "/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1",
            "gateway_fence_permit": b + "/run/bridgesllm/openclaw-gateway-migration-permit.v1",
            "openclaw_hello_snapshot": b + "/var/lib/bridgesllm/openclaw-hello.v1.json",
            "openclaw_state_dir": b + "/root/.openclaw",
            "portal_operation_lock": b + "/run/lock/bridgesllm-portal-installer.lock",
            "policy_path": b + "/policy/tool-policy.v2.json",
            "systemd_unit_dirs": [b + "/etc/systemd/system"],
            "proc_mounts": b + "/proc-mounts",
            "proc_root": b + "/proc",
            "npm_global_root": b + "/usr/lib/node_modules",
            "openclaw_bin": b + "/usr/bin/openclaw",
            "systemctl_bin": b + "/usr/bin/systemctl",
            "portal_plugins_dir": b + "/portal/installer/plugins",
            "apt_get_bin": b + "/usr/bin/apt-get",
            "apt_cache_bin": b + "/usr/bin/apt-cache",
            "dpkg_query_bin": b + "/usr/bin/dpkg-query",
            "apt_sources_dir": b + "/etc/apt/sources.list.d",
        }
        self.fake = b + "/fake"
        os.makedirs(self.fake)
        for directory in (b + "/var/lib/bridgesllm", self.paths["installer_state_root"], b + "/run/lock", b + "/proc",
                          b + "/etc/systemd/system", b + "/usr/bin", b + "/policy"):
            os.makedirs(directory, exist_ok=True)
        os.chmod(b + "/run/lock", 0o755)
        # The fakes' bytes never match a real qualified digest: every recommended version starts proposed.
        # The K7 flow stays behind the 5.2.0 core-update flag: its tests run with the core update on.
        write(self.paths["policy_path"], json.dumps(core_updates_on(json.loads(unqualified_policy_text())), indent=2))
        write(self.paths["proc_mounts"], "/dev/root / ext4 rw 0 0\nproc /proc proc rw 0 0\n")
        package_dir = self.paths["npm_global_root"] + "/openclaw"
        write(package_dir + "/package.json", json.dumps({"name": "openclaw", "version": installed}))
        write(package_dir + "/openclaw.mjs", FAKE_OPENCLAW % {"fake": self.fake}, 0o755)
        os.symlink(package_dir + "/openclaw.mjs", self.paths["openclaw_bin"])
        write(self.paths["systemctl_bin"], FAKE_SYSTEMCTL % {"fake": self.fake}, 0o755)
        self.reply("status", native_fixture("update-status.idle.json"))
        self.reply("gateway-status", native_fixture("gateway-status.ready.json"))
        self.reply("dry-run", native_fixture("update-dry-run.ok.json"))
        self.http = FakeHttp()
        self.set_node(node_version)
        self.write_plugins([("bridgesllm-ask-user", "4.0.0", ">=2026.9.9"), ("bridgesllm-shared-browser", "1.0.0", ">=2026.9.9")])
        self.reply("plugins-inspect", script=PLUGINS_INSPECT_SH)
        self.reply("plugins-install", script=PLUGINS_INSTALL_SH)
        self.reply("plugins-reload", native_fixture("plugins-reload.ok.json"))
        self.reply("gateway-rpc", native_fixture("gateway-status.ready.json"))
        self.reply("gateway-call", script=GATEWAY_CALL_SH % {"secret": FAKE_SECRET})
        for plugin_id, version in (("bridgesllm-ask-user", "4.0.0"), ("bridgesllm-shared-browser", "1.0.0")):
            self.set_plugin(plugin_id, plugin_doc(plugin_id, version))
        self.write_unit()
        oc = self.paths["openclaw_state_dir"]
        write(oc + "/state/openclaw.sqlite", "x" * 4096)
        write(oc + "/state/openclaw.sqlite-wal", "w" * 1024)
        write(oc + "/agents/main/agent/openclaw-agent.sqlite", "a" * 8192)
        write(oc + "/agents/main/agent/openclaw-agent.sqlite-shm", "s" * 512)
        write(oc + "/backups/old.sqlite", "b" * 100)
        self.meta_path = b + "/target-meta.json"
        write(self.meta_path, json.dumps(target_meta or TARGET_META))
        self.statvfs = FakeStatvfs()

    def set_node(self, version):
        write(self.base + "/usr/bin/node", FAKE_NODE % {"version": version}, 0o755)

    def enable_node_runtime(self, current="v24.21.0", package="24.21.0-1nodesource1", new="v24.22.2", madison=MADISON):
        """The gateway Node.js is the managed NodeSource one and too old for the target."""
        policy = self.policy()
        policy["runtimes"]["node"]["managedPath"] = self.base + "/usr/bin/node"
        self.set_policy(policy)
        self.set_node(current)
        write(self.base + "/etc/apt/sources.list.d/nodesource.sources",
              "Types: deb\nURIs: https://deb.nodesource.com/node_24.x\nSuites: nodistro\nComponents: main\n")
        for name in ("apt-get", "apt-cache", "dpkg-query"):
            write(self.base + "/usr/bin/" + name, FAKE_APT % {"fake": self.fake, "node": self.base + "/usr/bin/node"}, 0o755)
        write(self.fake + "/madison.txt", madison)
        write(self.fake + "/dpkg-version.txt", package)
        write(self.fake + "/node-new", FAKE_NODE % {"version": new}, 0o755)

    def set_plugin(self, plugin_id, doc):
        """What `plugins inspect <id> --json` reports (None: not installed)."""
        path = "%s/plugins/%s.json" % (self.fake, plugin_id)
        if doc is None:
            if os.path.exists(path):
                os.unlink(path)
        else:
            write(path, json.dumps(doc))

    def apt_calls(self):
        try:
            with open(self.fake + "/apt.log") as handle:
                return handle.read().splitlines()
        except FileNotFoundError:
            return []

    def write_plugins(self, plugins):
        """A release plugin manifest plus (fixture) archives, as packaging would ship them."""
        directory = self.paths["portal_plugins_dir"]
        entries = []
        for plugin_id, version, openclaw_range in plugins:
            archive = "%s-%s.tgz" % (plugin_id, version)
            write(directory + "/" + archive, "fixture archive %s %s\n" % (plugin_id, version))
            entries.append({"id": plugin_id, "version": version, "archive": archive,
                            "sha256": toolctl.sha256_file(directory + "/" + archive), "openclaw": openclaw_range})
        write(directory + "/manifest.json", json.dumps({"schema": "bridgesllm.portal-plugins.v1", "plugins": entries}))
        return entries

    def reply(self, key, stdout=None, exit_code=None, stderr=None, script=None):
        """Set what the fake openclaw answers for one command key."""
        for suffix, value in ((".json", stdout), (".exit", exit_code), (".stderr", stderr), (".sh", script)):
            path = "%s/%s%s" % (self.fake, key, suffix)
            if value is None:
                continue
            if value is False:
                if os.path.exists(path):
                    os.unlink(path)
                continue
            write(path, value if isinstance(value, str) else json.dumps(value) if suffix == ".json" else str(value))

    def calls(self):
        try:
            with open(self.fake + "/calls.log") as handle:
                return [line.rstrip("\n").split("|", 1)[1] for line in handle if line.strip()]
        except FileNotFoundError:
            return []

    def write_unit(self, exec_start=None, extra=""):
        write(self.base + "/etc/systemd/system/openclaw-gateway.service",
              "[Unit]\nDescription=OpenClaw Gateway\n\n[Service]\nUser=root\n"
              "Environment=\"HOME=%s/root\" \"PATH=%s/usr/bin\"\n"
              "Environment=\"OPENCLAW_STATE_DIR=%s\" \"OPENCLAW_GATEWAY_TOKEN=%s\"\n"
              "WorkingDirectory=%s\nExecStart=%s\n%s"
              % (self.base, self.base, self.paths["openclaw_state_dir"], FAKE_SECRET, self.paths["openclaw_state_dir"],
                 exec_start or self.paths["openclaw_bin"] + " gateway --port 18789", extra))

    def roots(self):
        return toolctl.Roots(**self.paths)

    def policy(self):
        with open(self.paths["policy_path"]) as handle:
            return json.load(handle)

    def set_policy(self, policy):
        with open(self.paths["policy_path"], "w") as handle:
            json.dump(policy, handle)

    def preflight(self, **kwargs):
        options = {"metadata_path": self.meta_path, "statvfs": self.statvfs, "http_get": self.http}
        options.update(kwargs)
        return toolctl.Preflight(self.roots(), self.policy(), **options).run()

    def queue(self, run_id=RUN_ID, **overrides):
        """What the Portal backend does: private run dir + request + queued status."""
        state = self.paths["state_root"]
        for path in (state, state + "/runs", state + "/runs/" + run_id):
            os.makedirs(path, mode=0o700, exist_ok=True)
            os.chmod(path, 0o700)
        request = {"schema": "bridgesllm.tools.request.v1", "runId": run_id, "tool": "openclaw",
                   "action": "preflight", "target": "recommended", "channel": "stable",
                   "requestedBy": "owner-1", "requestedAt": toolctl.utc_now(), "portalVersion": "test",
                   "policySha256": toolctl.sha256_file(self.paths["policy_path"])}
        request.update(overrides)
        toolctl.atomic_write_json(state + "/runs/%s/request.json" % run_id, request)
        return request

    def run(self, run_id=RUN_ID, **kwargs):
        options = {"metadata_path": self.meta_path, "statvfs": self.statvfs, "http_get": self.http,
                   "progress": {"progress_seconds": 0, "poll_seconds": 0.05, "ready_wait_seconds": 0.5,
                                "ready_interval_seconds": 0.05, "probe_deadline_seconds": 5, "probe_sleep": lambda _s: None}}
        options.update(kwargs)
        return toolctl.cmd_run(self.roots(), run_id, **options)

    def native_update_installs(self, version="2026.10.9", result="update-result.succeeded.json", extra=""):
        """The fake `openclaw update` rewrites the installed package version and prints a result."""
        package_json = self.paths["npm_global_root"] + "/openclaw/package.json"
        self.reply("update", native_fixture(result) if result else False, script=(
            "printf '%%s\\n' \"TMPDIR=$TMPDIR NPM_CONFIG_PREFIX=$NPM_CONFIG_PREFIX\" >> \"$FAKE/update-env.log\"\n"
            "echo '[openclaw] update phase: staging' >&2\n"
            "%s"
            "printf '{\"name\": \"openclaw\", \"version\": \"%s\"}' > '%s'\n" % (extra, version, package_json)))

    def versioned_native(self, result="update-result.succeeded.json"):
        """Fake `openclaw update --tag <v>` installs <v>; the fake dry run accepts the tag it is asked for.

        Each update call logs `<args>|<unit state>` to $FAKE/update-calls.log; $FAKE/update-<v>.sh is
        sourced first (a test hook per version); $FAKE/dry-run-refuse-<v> makes the dry run refuse <v>.
        """
        package_json = self.paths["npm_global_root"] + "/openclaw/package.json"
        tag_of = 'tag=""; prev=""; for a in "$@"; do [ "$prev" = "--tag" ] && tag="$a"; prev="$a"; done\n'
        self.reply("update", native_fixture(result) if result else False, script=(
            tag_of + 'printf "%%s|%%s\\n" "$*" "$(cat "$FAKE/is-active" 2>/dev/null || echo active)" >> "$FAKE/update-calls.log"\n'
            '[ -f "$FAKE/update-$tag.sh" ] && . "$FAKE/update-$tag.sh"\n'
            "printf '{\"name\": \"openclaw\", \"version\": \"%%s\"}' \"$tag\" > '%s'\n" % package_json))
        self.reply("dry-run", False, script=(
            tag_of + 'printf "%s|%s\\n" "$*" "$(cat "$FAKE/is-active" 2>/dev/null || echo active)" >> "$FAKE/dry-run-calls.log"\n'
            'if [ -f "$FAKE/dry-run-refuse-$tag" ]; then cat "$FAKE/dry-run-refuse-$tag"; exit 0; fi\n'
            'printf \'{"currentVersion": "x", "targetVersion": "%s", "notes": []}\' "$tag"; exit 0\n'))

    def lines(self, name):
        try:
            with open(self.fake + "/" + name) as handle:
                return handle.read().splitlines()
        except FileNotFoundError:
            return []

    def history(self):
        try:
            with open(self.paths["state_root"] + "/history.jsonl") as handle:
                return [json.loads(line) for line in handle if line.strip()]
        except FileNotFoundError:
            return []

    def cleanup(self):
        shutil.rmtree(self.base, ignore_errors=True)


class HostTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host()
        self.addCleanup(self.host.cleanup)

    def refusal_ids(self, report):
        return [r["id"] for r in report["refusals"]]


class PolicyTests(unittest.TestCase):
    def setUp(self):
        # The shipped file as it is (whichever entries are qualified); the rule tests edit the unqualified copy.
        self.shipped = shipped_policy()
        self.policy = unqualified_policy()

    def test_shipped_policy_is_valid(self):
        self.assertEqual(toolctl.validate_policy(self.shipped), [])
        self.assertEqual(toolctl.validate_policy(self.policy), [])

    def test_shipped_policy_holds_the_openclaw_core_update_for_a_later_release(self):
        # 5.2.0: native self-update can't activate or be repaired under the Portal's unit.
        self.assertEqual(self.shipped["openclaw"]["coreUpdates"], "later-release")
        self.assertEqual(toolctl.validate_policy(core_updates_on(self.shipped)), [])
        for value in ("on", "off", "", None, True, "later"):
            self.assert_invalid(lambda p, value=value: p["openclaw"].__setitem__("coreUpdates", value),
                                "$.openclaw.coreUpdates: must be one of")

    def test_shipped_policy_defaults_follow_open_questions(self):
        self.assertEqual(self.shipped["openclaw"]["defaultChannel"], "stable")
        self.assertIs(self.shipped["openclaw"]["coreAutoUpdateDefault"], False)
        openclaw = toolctl.policy_tool(self.shipped, "openclaw")
        # The Portal's runtime contract floor (capability predicates above it, K2): 2026.9.x hosts are not
        # "Update required" for a minimum nothing depends on (5.2.0).
        self.assertEqual(openclaw["floor"], "2026.9.1")
        contract = os.path.join(TOOLS_DIR, "..", "..", "backend", "src", "services", "openClawRuntimeContract.ts")
        with open(contract, encoding="utf-8") as handle:
            self.assertIn("export const OPENCLAW_RUNTIME_FLOOR = '%s';" % openclaw["floor"], handle.read())
        for tool in self.shipped["tools"]:
            # A recommended version stays proposed (no digest, no date) until qualification records both.
            proven = tool["newestProven"]
            self.assertIn(proven["status"], ("proposed", "qualified"), tool["id"])
            if proven["status"] == "proposed":
                self.assertEqual((proven["integrity"], proven["qualifiedAt"]), (None, None), tool["id"])
            self.assertEqual(tool["restartsGateway"], tool["id"] == "openclaw")

    def assert_invalid(self, mutate, fragment):
        policy = copy.deepcopy(self.policy)
        mutate(policy)
        errors = toolctl.validate_policy(policy)
        self.assertTrue(any(fragment in e for e in errors), errors)

    def test_negative_cases(self):
        oc = lambda p: toolctl.policy_tool(p, "openclaw")
        cases = [
            (lambda p: p.update(extra=1), "$.extra: unknown key"),
            (lambda p: p.update(schema="other"), "$.schema"),
            (lambda p: p["openclaw"].update(defaultChannel="beta"), "$.openclaw.defaultChannel"),
            (lambda p: p["openclaw"].update(coreAutoUpdateDefault="no"), "coreAutoUpdateDefault"),
            (lambda p: oc(p).update(floor="2026.11.1"), "must not be below the floor"),
            (lambda p: oc(p)["newestProven"].update(status="qualified"), "needs integrity and qualifiedAt"),
            (lambda p: oc(p)["newestProven"].update(integrity="sha256-abc"), "SRI"),
            (lambda p: oc(p).update(denylist=[{"version": "2026.10.9", "reason": "bad"}]), "denylists newestProven"),
            (lambda p: oc(p).update(denylist=[{"version": "2026.10.8"}]), "{version, reason}"),
            (lambda p: oc(p)["probes"]["required"].remove("OC-PLUG-ASK"), "OpenClaw must require OC-PLUG-ASK"),
            (lambda p: oc(p)["probes"]["optional"].append("OC-MADE-UP"), "unknown probe"),
            (lambda p: oc(p)["probes"]["optional"].append("OC-HELLO"), "appears twice"),
            (lambda p: oc(p)["newestSelector"].pop("extended-stable"), "missing channel extended-stable"),
            (lambda p: toolctl.policy_tool(p, "codex").update(restartsGateway=True), "only the OpenClaw core run"),
            (lambda p: toolctl.policy_tool(p, "codex")["source"].update(package="Not A Package"), "npm package name"),
            (lambda p: toolctl.policy_tool(p, "grok-build")["source"].update(endpoint="http://x"), "https URL"),
            (lambda p: p["tools"].append(copy.deepcopy(p["tools"][1])), "duplicate id"),
            (lambda p: p.update(tools=[t for t in p["tools"] if t["id"] != "openclaw"]), "must include openclaw"),
            (lambda p: toolctl.policy_tool(p, "codex").update(floor="latest"), ".floor: must be a version"),
            (lambda p: toolctl.policy_tool(p, "codex").update(id="codex\n"), ".id: must match"),
            (lambda p: p["openclaw"].update(gatewayService="openclaw-gateway.service\n"), "gatewayService"),
            (lambda p: toolctl.policy_tool(p, "codex")["source"].update(package="@openai/codex\n"), "npm package name"),
        ]
        for mutate, fragment in cases:
            with self.subTest(fragment=fragment):
                self.assert_invalid(mutate, fragment)

    def test_qualified_entry_with_digests_is_valid(self):
        policy = copy.deepcopy(self.policy)
        toolctl.policy_tool(policy, "openclaw")["newestProven"].update(
            status="qualified", integrity="sha512-" + "B" * 86 + "==", qualifiedAt="2026-11-02T10:00:00Z")
        self.assertEqual(toolctl.validate_policy(policy), [])

    def integrity_errors(self, tool_id, integrity):
        policy = copy.deepcopy(self.policy)
        toolctl.policy_tool(policy, tool_id)["newestProven"].update(
            status="qualified", integrity=integrity, qualifiedAt="2026-11-02T10:00:00Z")
        return toolctl.validate_policy(policy)

    def test_each_source_kind_accepts_its_integrity_form(self):
        accepted = {
            "openclaw": [INTEGRITY_SRI],                                   # npm
            "hermes": [INTEGRITY_TREE],                                    # github-tarball
            "agent-zero": [{"x86_64": INTEGRITY_SHA256}, {"aarch64": INTEGRITY_SHA256},
                           {"x86_64": INTEGRITY_SHA256, "aarch64": INTEGRITY_SHA256}],  # container-image, per machine
            "opencode": [{"x86_64": INTEGRITY_SHA256}, {"aarch64": INTEGRITY_SHA256},
                         {"x86_64": INTEGRITY_SHA256, "aarch64": INTEGRITY_SHA256}],  # github-release
            "ollama": [{"aarch64": INTEGRITY_SHA256}],
            "grok-build": [{"x86_64": INTEGRITY_SHA256}, {"x86_64": INTEGRITY_SHA512, "aarch64": INTEGRITY_SHA256}],  # vendor
            "antigravity": [{"aarch64": INTEGRITY_SHA512}],
        }
        for tool_id, values in accepted.items():
            for value in values:
                with self.subTest(tool=tool_id, value=value):
                    self.assertEqual(self.integrity_errors(tool_id, value), [])

    def test_each_source_kind_refuses_the_other_forms(self):
        sri, sha256, sha512, tree = INTEGRITY_SRI, INTEGRITY_SHA256, INTEGRITY_SHA512, INTEGRITY_TREE
        refused = {
            "openclaw": [sha256, tree, sha512, {"x86_64": sri}, "sha512-abc", sri + "\n"],
            "hermes": [sha256, sri, {"x86_64": tree}, "sha256-tree:" + "A" * 64],
            "agent-zero": [sha256, sri, tree, sha512, {"x86_64": sri}, {"x86_64": sha512}, {}, {"amd64": sha256},
                           {"x86_64": "sha256:" + "a" * 63}],
            "opencode": [sha256, sri, [sha256], {"x86_64": sri}, {"x86_64": sha512}, {"x86_64": tree},
                         {"x86_64": None}, {}, {"arm64": sha256}, {"x86_64": sha256, "amd64": sha256}],
            "grok-build": [sha256, sha512, {"x86_64": sri}, {"x86_64": tree}, {}, {"aarch64 ": sha256}],
        }
        for tool_id, values in refused.items():
            for value in values:
                with self.subTest(tool=tool_id, value=value):
                    errors = self.integrity_errors(tool_id, value)
                    self.assertTrue(errors and all(".newestProven.integrity" in e for e in errors), errors)

    def test_integrity_errors_name_the_field_and_the_form(self):
        sha256 = INTEGRITY_SHA256
        index = {t["id"]: i for i, t in enumerate(self.policy["tools"])}
        path = lambda tool_id: "$.tools[%d].newestProven.integrity" % index[tool_id]
        self.assertEqual(self.integrity_errors("openclaw", sha256), [
            path("openclaw") + ": must be null or an npm sha512 SRI string (sha512-<base64>==) for source kind npm"])
        self.assertEqual(self.integrity_errors("hermes", sha256), [
            path("hermes") + ": must be null or a sha256-tree:<64 hex> source-tree digest for source kind github-tarball"])
        self.assertEqual(self.integrity_errors("opencode", sha256), [
            path("opencode") + ": must be null or an object keyed by machine (x86_64, aarch64) for source kind "
                               "github-release"])
        self.assertEqual(self.integrity_errors("ollama", {}), [
            path("ollama") + ": must name at least one machine (x86_64, aarch64)"])
        self.assertEqual(self.integrity_errors("ollama", {"x86_64": sha256, "arm64": sha256}), [
            path("ollama") + ".arm64: unknown machine (expected x86_64 or aarch64)"])
        self.assertEqual(self.integrity_errors("antigravity", {"x86_64": INTEGRITY_SRI}), [
            path("antigravity") + ".x86_64: must be a sha256:<64 hex> or sha512:<128 hex> digest of that machine's file"])

    def test_a_proposed_entry_keeps_null_integrity_valid(self):
        for tool in self.policy["tools"]:
            self.assertIsNone(tool["newestProven"]["integrity"], tool["id"])
        policy = copy.deepcopy(self.policy)
        toolctl.policy_tool(policy, "opencode")["newestProven"].update(status="qualified")
        self.assertIn("$.tools[4].newestProven: a qualified version needs integrity and qualifiedAt",
                      toolctl.validate_policy(policy))


class VersionTests(unittest.TestCase):
    def test_real_engine_ranges(self):
        cases = {
            ">=24.22.1 <25 || >=26.12.1": {"24.22.1": True, "v24.22.1": True, "24.21.0": False, "24.99.0": True,
                                           "25.0.0": False, "26.0.0": False, "26.12.1": True, "27.1.0": True},
            "^22.13.0 || >=24": {"22.13.0": True, "22.12.9": False, "22.99.1": True, "23.0.0": False, "24.0.0": True},
            ">=16": {"16.0.0": True, "15.9.9": False, "24.22.1": True},
            ">=22.0.0": {"22.0.0": True, "21.7.3": False},
        }
        for range_text, expectations in cases.items():
            for version, expected in expectations.items():
                with self.subTest(range=range_text, version=version):
                    self.assertIs(toolctl.satisfies(version, range_text), expected)

    def test_other_range_forms(self):
        self.assertTrue(toolctl.satisfies("1.2.9", "~1.2.3"))
        self.assertFalse(toolctl.satisfies("1.3.0", "~1.2.3"))
        self.assertTrue(toolctl.satisfies("1.7.0", "1.x"))
        self.assertFalse(toolctl.satisfies("2.0.0", "1.x"))
        self.assertTrue(toolctl.satisfies("2.3.9", "1.2.3 - 2.3"))
        self.assertFalse(toolctl.satisfies("2.4.0", "1.2.3 - 2.3"))
        self.assertTrue(toolctl.satisfies("0.2.5", "^0.2.3"))
        self.assertFalse(toolctl.satisfies("0.3.0", "^0.2.3"))
        self.assertTrue(toolctl.satisfies("5.0.0", "*"))
        self.assertTrue(toolctl.satisfies("24.1.0", ">= 24"))
        self.assertFalse(toolctl.satisfies("25.0.0-rc.1", ">=24"))
        with self.assertRaises(ValueError):
            toolctl.satisfies("24.0.0", ">=banana")

    def test_openclaw_calendar_versions(self):
        self.assertEqual(toolctl.compare_versions("2026.10.9", "2026.9.9"), 1)
        self.assertEqual(toolctl.compare_versions("2026.9.36", "2026.10.9"), -1)
        self.assertEqual(toolctl.compare_versions("2026.10.10-beta.5", "2026.10.10"), -1)
        self.assertEqual(toolctl.compare_versions("2026.10.10-beta.5", "2026.10.9"), 1)
        self.assertEqual(toolctl.compare_versions("2.14", "2.14.0"), 0)
        self.assertIsNone(toolctl.parse_version("latest"))


class PreflightTests(HostTestCase):
    def test_happy_path_and_read_only(self):
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        states = {c["id"]: c["state"] for c in report["checks"]}
        for check in ("PF-2", "PF-3", "PF-4", "PF-5", "PF-5-health", "PF-6", "PF-7", "PF-8", "PF-9", "PF-10", "PF-11", "PF-13"):
            self.assertEqual(states[check], "pass", check)
        for check in ("PF-1", "PF-12"):
            self.assertEqual(states[check], "deferred", check)
        # Exactly three read-only native commands, all on the gateway's Node.js, in the service HOME.
        self.assertEqual(self.host.calls(), ["update status --json", "gateway status --deep --require-rpc --json",
                                             "update --dry-run --json --no-restart --channel stable --tag 2026.10.9"])
        with open(self.host.fake + "/calls.log") as handle:
            self.assertTrue(all(line.startswith(self.host.base + "/root|") for line in handle))
        self.assertEqual(self.host.http.urls, ["http://127.0.0.1:18789/readyz"])
        self.assertEqual(report["facts"]["dryRun"]["targetVersion"], "2026.10.9")
        facts = report["facts"]
        self.assertEqual(facts["installedVersion"], "2026.9.9")
        self.assertEqual(facts["target"]["version"], "2026.10.9")
        self.assertEqual(facts["target"]["tag"], "2026.10.9")
        self.assertIs(facts["target"]["proven"], False)
        self.assertEqual(facts["gatewayNode"]["path"], self.host.base + "/usr/bin/node")
        self.assertEqual(facts["gatewayNode"]["resolvedBy"], "shebang via PATH")
        self.assertEqual(facts["gatewayNode"]["version"], "24.22.1")
        self.assertEqual(facts["disk"]["informational"]["otherSqlite"], {"count": 1, "bytes": 100})
        # Pre-flight is read-only: it did not create the tools state or the operation lock.
        self.assertFalse(os.path.exists(self.host.paths["state_root"]))
        self.assertFalse(os.path.exists(self.host.paths["portal_operation_lock"]))

    def test_disk_math_single_volume(self):
        report = self.host.preflight()
        disk = report["facts"]["disk"]
        t = 4096 + 1024 + 8192 + 512
        largest = 8192 + 512
        self.assertEqual((disk["T"], disk["L"], disk["families"]), (t, largest, 2))
        self.assertEqual(len(disk["volumes"]), 1)
        # The canary is the whole state dir: the store families plus backups/old.sqlite.
        canary = t + 100
        self.assertEqual(disk["canary"], canary)
        # Doctor's kept .bak copy of each store adds T on the stores' volume.
        self.assertEqual(disk["doctorBackups"], t)
        expected = (2 * t + 3 * largest + 64 * toolctl.MIB) + canary + 2 * 250 * 1000 * 1000 + 2 * toolctl.GIB + t
        self.assertEqual(disk["volumes"][0]["required"], expected)

    def test_disk_math_leaves_bak_files_out_of_the_canary(self):
        oc = self.host.paths["openclaw_state_dir"]
        write(oc + "/agents/research/agent/openclaw-agent.sqlite.pre-startup-migration-op1.bak", "b" * 5000)
        write(oc + "/state/openclaw.sqlite.bak", "b" * 3000)
        disk = self.host.preflight()["facts"]["disk"]
        t = 4096 + 1024 + 8192 + 512
        self.assertEqual((disk["T"], disk["canary"], disk["doctorBackups"]), (t, t + 100, t))
        self.assertEqual(disk["volumes"][0]["inodesRequired"], 2 * 9000 + toolctl.INODE_MARGIN)

    def test_pf2_each_legacy_root_refuses_with_recover_action(self):
        for root_id, path in toolctl.legacy_roots(self.host.roots()):
            with self.subTest(root=root_id):
                if root_id.endswith(("-v1", "-v2")) and "fence" not in root_id and "permit" not in root_id:
                    os.makedirs(path)
                else:
                    write(path, "{}")
                report = self.host.preflight()
                self.assertIn("PF2_LEGACY_TRANSACTION_OPEN", self.refusal_ids(report))
                refusal = report["refusals"][0]
                self.assertEqual(refusal["nextAction"], "recover-legacy")
                self.assertEqual(refusal["message"], "An earlier maintenance run is unfinished. Recover it first.")
                self.assertEqual(refusal["detail"]["open"], [{"id": root_id, "path": path}])
                if os.path.isdir(path):
                    os.rmdir(path)
                else:
                    os.unlink(path)

    def test_pf2_terminal_tombstone_is_not_open(self):
        write(self.host.paths["installer_state_root"] + "/native-cli-bundle-v1.terminal", "{}")
        os.makedirs(self.host.paths["installer_state_root"] + "/transactions/old-1")
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        self.assertEqual(report["facts"]["legacyTransactions"]["entries"], 1)

    def test_pf4_tools_lock_held(self):
        os.makedirs(self.host.paths["state_root"], mode=0o700)
        lock = toolctl.ToolsLock(self.host.roots())
        lock.acquire(OTHER_RUN_ID)
        self.addCleanup(lock.release)
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF4_TOOLS_RUN_ACTIVE"])
        self.assertEqual(report["refusals"][0]["detail"], {"runId": OTHER_RUN_ID})

    def test_pf4_portal_operation_lock_held(self):
        path = self.host.paths["portal_operation_lock"]
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX)
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF4_PORTAL_OPERATION_ACTIVE"])

    def test_pf4_portal_update_journal(self):
        write(self.host.paths["installer_state_root"] + "/active-update.json", "{}")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF4_PORTAL_OPERATION_ACTIVE"])

    def test_pf5_gateway_service_missing(self):
        os.unlink(self.host.base + "/etc/systemd/system/openclaw-gateway.service")
        report = self.host.preflight()
        self.assertIn("PF5_GATEWAY_SERVICE_MISSING", self.refusal_ids(report))
        self.assertEqual({c["id"]: c["state"] for c in report["checks"]}["PF-7"], "skipped")

    def test_pf5_dropin_overrides_exec_start(self):
        write(self.host.base + "/etc/systemd/system/openclaw-gateway.service.d/50-node.conf",
              "[Service]\nExecStart=\nExecStart=%s/usr/bin/node /x/dist/index.js gateway\n" % self.host.base)
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        self.assertEqual(report["facts"]["gatewayNode"]["resolvedBy"], "ExecStart")
        self.assertEqual(report["facts"]["gatewayUnit"]["dropins"], ["50-node.conf"])

    def test_pf6_refusals(self):
        policy = self.host.policy()
        toolctl.policy_tool(policy, "openclaw")["denylist"] = [{"version": "2026.10.10", "reason": "breaks chat"}]
        self.host.set_policy(policy)
        cases = [
            ({"target": "newest"}, dict(TARGET_META, version="2026.10.10"), "PF6_TARGET_DENYLISTED",
             "OpenClaw 2026.10.10 is blocked: breaks chat"),
            ({"target": "2026.8.30"}, dict(TARGET_META, version="2026.8.30"), "PF6_TARGET_BELOW_FLOOR",
             "OpenClaw 2026.8.30 is older than the minimum this Portal supports (2026.9.1)."),
            ({}, dict(TARGET_META, version="2026.10.8"), "PF6_TARGET_MISMATCH", None),
            ({"channel": "extended-stable"}, TARGET_META, "PF6_TARGET_CHANNEL_CONFLICT", None),
        ]
        for kwargs, meta, refusal_id, message in cases:
            with self.subTest(refusal=refusal_id):
                write(self.host.meta_path, json.dumps(meta))
                report = self.host.preflight(**kwargs)
                self.assertEqual(self.refusal_ids(report), [refusal_id])
                if message:
                    self.assertEqual(report["refusals"][0]["message"], message)

    def test_pf6_downgrade_and_unavailable(self):
        write(self.host.paths["npm_global_root"] + "/openclaw/package.json", json.dumps({"version": "2026.10.10"}))
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF6_DOWNGRADE"])
        os.unlink(self.host.meta_path)
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF6_TARGET_UNAVAILABLE"])

    def test_pf6_newest_on_extended_stable_uses_selector(self):
        write(self.host.meta_path, json.dumps(dict(TARGET_META, version="2026.9.36")))
        self.host.reply("dry-run", {"currentVersion": "2026.9.9", "targetVersion": "2026.9.36", "notes": []})
        report = self.host.preflight(target="newest", channel="extended-stable")
        self.assertTrue(report["ok"], report["refusals"])
        self.assertEqual(report["facts"]["target"]["spec"], "openclaw@extended-stable")
        self.assertIsNone(report["facts"]["target"]["tag"])

    def test_pf7_node_below_target_engine(self):
        self.host.set_node("v24.21.0")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF7_NODE_UNMANAGED"])
        policy = self.host.policy()
        policy["runtimes"]["node"]["managedPath"] = self.host.base + "/usr/bin/node"
        self.host.set_policy(policy)
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF7_NODE_ENGINE"])
        self.assertEqual(report["refusals"][0]["nextAction"], "node-runtime")
        self.assertEqual(report["refusals"][0]["message"],
                         "Node.js 24.21.0 must be updated to satisfy OpenClaw 2026.10.9 (needs >=24.22.1 <25 || >=26.12.1).")

    def test_pf7_node_missing_or_untrusted(self):
        os.unlink(self.host.base + "/usr/bin/node")
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF7_NODE_UNKNOWN"])
        write(self.host.base + "/usr/bin/node", "#!/bin/sh\necho v24.22.1\n", 0o777)
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF7_NODE_UNKNOWN"])

    def test_pf8_disk_space(self):
        self.host.statvfs = FakeStatvfs(free_bytes=2 * 10 ** 9)
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF8_DISK_SPACE"])
        self.assertRegex(report["refusals"][0]["message"], r"^Needs 2\.7 GB free on /, has 2\.0 GB\.$")

    def test_pf8_inodes(self):
        self.host.statvfs = FakeStatvfs(free_inodes=100)
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF8_INODES"])

    def test_pf8_tmpdir_in_memory(self):
        write(self.host.paths["proc_mounts"], "/dev/root / ext4 rw 0 0\ntmpfs %s tmpfs rw 0 0\n" % (self.host.base + "/var/lib"))
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF8_TMPDIR_IN_MEMORY"])

    def test_pf8_sparse_family_over_real_statvfs(self):
        os.truncate(self.host.paths["openclaw_state_dir"] + "/state/openclaw.sqlite", 3 * 2 ** 40)
        report = self.host.preflight(statvfs=os.statvfs)
        self.assertIn("PF8_DISK_SPACE", self.refusal_ids(report))
        self.assertEqual(len(report["facts"]["disk"]["informational"]["largeFiles"]), 1)

    def fake_process(self, pid, cgroup, files, exe="/usr/bin/python3.12"):
        proc = self.host.paths["proc_root"] + "/%d" % pid
        os.makedirs(proc + "/fd")
        for index, target in enumerate(files):
            os.symlink(target, proc + "/fd/%d" % (index + 3))
        os.symlink("/dev/null", proc + "/fd/0")
        write(proc + "/cgroup", "0::%s\n" % cgroup)
        os.symlink(exe, proc + "/exe")

    def test_pf9_external_sqlite_readers(self):
        oc = self.host.paths["openclaw_state_dir"]
        db = oc + "/agents/main/agent/openclaw-agent.sqlite"
        # The gateway itself and its descendants may hold the databases open.
        self.fake_process(100, "/system.slice/openclaw-gateway.service", [db, oc + "/state/openclaw.sqlite-wal"])
        self.fake_process(101, "/system.slice/openclaw-gateway.service/worker", [db + " (deleted)"])
        self.fake_process(102, "/system.slice/unrelated.service", [oc + "/backups/old.sqlite"])
        self.assertTrue(self.host.preflight()["ok"])
        self.fake_process(200, "/user.slice/user-0.slice/session-4.scope", [db])
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF9_EXTERNAL_DATABASE_READERS"])
        self.assertEqual(report["refusals"][0]["message"],
                         "These processes have OpenClaw databases open: session-4.scope (pid 200). Stop them and retry.")
        self.assertEqual(report["refusals"][0]["detail"]["readers"],
                         [{"pid": 200, "exe": "/usr/bin/python3.12", "unit": "session-4.scope", "files": [db]}])

    def test_pf10_hard_linked_database(self):
        oc = self.host.paths["openclaw_state_dir"]
        os.link(oc + "/state/openclaw.sqlite-wal", oc + "/wal-copy")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF10_HARDLINKED_DATABASE"])
        self.assertEqual(report["refusals"][0]["message"],
                         "Database file openclaw.sqlite-wal has extra hard links; OpenClaw cannot safely restore it.")


class TargetDigestTests(HostTestCase):
    """PF-6: a qualified OpenClaw version is proven only when the registry serves the qualified bytes."""

    def qualify(self, integrity=TARGET_META["dist"]["integrity"], version="2026.10.9"):
        policy = self.host.policy()
        toolctl.policy_tool(policy, "openclaw")["newestProven"] = {
            "version": version, "status": "qualified", "integrity": integrity, "qualifiedAt": "2026-10-30T12:00:00Z"}
        self.assertEqual(toolctl.validate_policy(policy), [])
        self.host.set_policy(policy)

    def native_update_calls(self):
        return [c for c in self.host.calls() if c.startswith("update") and c != "update status --json"]

    def test_the_qualified_digest_proves_the_target(self):
        self.qualify()
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        self.assertIs(report["facts"]["target"]["proven"], True)
        self.assertEqual(self.native_update_calls(), ["update --dry-run --json --no-restart --channel stable --tag 2026.10.9"])

    def test_a_different_or_missing_digest_is_refused_before_any_native_update(self):
        self.qualify(INTEGRITY_SRI)
        other = TARGET_META["dist"]["integrity"]
        missing = dict(TARGET_META, dist={k: v for k, v in TARGET_META["dist"].items() if k != "integrity"})
        for target, meta, actual, words in (({}, TARGET_META, other, "does not match"),
                                            ({}, missing, None, "has no digest to compare with"),
                                            ({"target": "newest"}, TARGET_META, other, "does not match"),
                                            ({"target": "2026.10.9"}, missing, None, "has no digest to compare with")):
            with self.subTest(target=target, actual=actual):
                write(self.host.meta_path, json.dumps(meta))
                os.makedirs(self.host.fake, exist_ok=True)
                open(self.host.fake + "/calls.log", "w").close()
                report = self.host.preflight(**target)
                self.assertEqual(self.refusal_ids(report), ["PF6_TARGET_DIGEST_MISMATCH"])
                refusal = report["refusals"][0]
                self.assertEqual(refusal["message"], "The registry's OpenClaw 2026.10.9 %s the package this Portal "
                                 "qualified, so it won't be installed. Nothing was changed." % words)
                self.assertEqual(refusal["detail"], {"expected": INTEGRITY_SRI, "actual": actual})
                self.assertIsNone(refusal["nextAction"])
                self.assertIs(report["facts"]["target"]["proven"], False)
                self.assertEqual(self.native_update_calls(), [])

    def test_an_update_run_with_a_different_digest_changes_nothing(self):
        self.qualify(INTEGRITY_SRI)
        self.host.queue(action="update")
        self.host.native_update_installs()
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "PF6_TARGET_DIGEST_MISMATCH"))
        self.assertEqual(self.native_update_calls(), [])
        with open(self.host.paths["npm_global_root"] + "/openclaw/package.json") as handle:
            self.assertEqual(json.load(handle)["version"], "2026.9.9")

    def test_other_targets_are_unchanged_and_never_proven(self):
        # Unqualified recommended (the shipped policy): any digest, never proven, never refused for it.
        write(self.host.meta_path, json.dumps(dict(TARGET_META, dist=dict(TARGET_META["dist"], integrity=INTEGRITY_SRI))))
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        self.assertIs(report["facts"]["target"]["proven"], False)
        # Newest above the qualified version: not compared, not proven.
        self.qualify(INTEGRITY_SRI)
        write(self.host.meta_path, json.dumps(dict(TARGET_META, version="2026.10.10")))
        report = self.host.preflight(target="newest")
        self.assertEqual([c["state"] for c in report["checks"] if c["id"] == "PF-6"], ["pass"])
        self.assertFalse([r for r in report["refusals"] if r["check"] == "PF-6"])
        self.assertEqual(report["facts"]["target"]["version"], "2026.10.10")
        self.assertIs(report["facts"]["target"]["proven"], False)


class PluginAndDiskExtrasTests(HostTestCase):
    """PF-13 plugin archives and the PF-8 extras (configured stores, dist override)."""

    def test_pf13_not_packaged_damaged_or_unsupported(self):
        directory = self.host.paths["portal_plugins_dir"]
        os.unlink(directory + "/manifest.json")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF13_PLUGINS_NOT_PACKAGED"])
        self.assertNotIn("update --dry-run", " ".join(self.host.calls()))
        entries = self.host.write_plugins([("bridgesllm-ask-user", "4.0.0", ">=2026.9.9")])
        with open(directory + "/" + entries[0]["archive"], "a") as handle:
            handle.write("tampered")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF13_PLUGIN_ARCHIVE_INVALID"])
        self.assertEqual(report["refusals"][0]["message"],
                         "The Portal plugin bridgesllm-ask-user 4.0.0 is missing or damaged in this Portal version.")
        self.host.write_plugins([("bridgesllm-ask-user", "4.0.0", ">=2026.9.9 <2026.10.0")])
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF13_PLUGIN_UNSUPPORTED"])
        self.assertEqual(report["refusals"][0]["message"],
                         "This Portal version's plugins don't support OpenClaw 2026.10.9 yet; choose the recommended version.")

    def test_pf13_manifest_validation(self):
        good = {"id": "bridgesllm-ask-user", "version": "4.0.0", "archive": "bridgesllm-ask-user-4.0.0.tgz",
                "sha256": "a" * 64, "openclaw": ">=2026.9.9"}
        self.assertEqual(toolctl.validate_plugin_manifest({"schema": "bridgesllm.portal-plugins.v1", "plugins": [good]}), [])
        for change, fragment in (({"archive": "../../etc/passwd"}, "archive"), ({"id": "Bad"}, ".id"),
                                 ({"version": "4.0.0\n"}, "version"), ({"sha256": "A" * 64}, "sha256"),
                                 ({"openclaw": ">=banana"}, "openclaw"), ({"extra": 1}, "must be")):
            with self.subTest(change=change):
                errors = toolctl.validate_plugin_manifest({"schema": "bridgesllm.portal-plugins.v1",
                                                          "plugins": [dict(good, **change)]})
                self.assertTrue(any(fragment in e for e in errors), errors)
        write(self.host.paths["portal_plugins_dir"] + "/manifest.json", "{not json")
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF13_PLUGIN_MANIFEST_INVALID"])

    def test_pf8_configured_agent_store_outside_the_layout(self):
        oc = self.host.paths["openclaw_state_dir"]
        elsewhere = self.host.base + "/srv/agents/research"
        write(elsewhere + "/openclaw-agent.sqlite", "r" * 50000)
        write(oc + "/openclaw.json", json.dumps({"agents": {"entries": {
            "main": {"agentDir": "~/.openclaw/agents/main/agent"},
            "research": {"agentDir": elsewhere}}}}))
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        disk = report["facts"]["disk"]
        self.assertEqual(disk["configuredStores"], [{"agent": "research", "base": elsewhere + "/openclaw-agent.sqlite"}])
        # main is the standard family (counted once); research adds 50000 bytes to T.
        self.assertEqual(disk["T"], 4096 + 1024 + 8192 + 512 + 50000)
        write(oc + "/openclaw.json", json.dumps({"agents": {"list": [{"id": "x", "agentDir": "relative/dir"}]}}))
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF8_AGENT_STORE_UNRESOLVED"])
        write(oc + "/openclaw.json", "{ agents: { /* json5 */ } }")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF8_CONFIG_UNREADABLE"])
        self.assertNotIn("PF-8", [c["id"] for c in report["checks"] if c["state"] == "pass"])

    def test_pf8_dist_override_bundle(self):
        package = self.host.paths["npm_global_root"] + "/openclaw"
        write(package + "/dist/a.mjs", "a" * 1000)
        write(package + "/dist/sub/b.mjs", "b" * 3000)
        inventory = [{"path": "dist/a.mjs", "size": 1000, "mode": 420, "sha256": toolctl.sha256_file(package + "/dist/a.mjs")},
                     {"path": "dist/sub/b.mjs", "size": 3000, "mode": 420,
                      "sha256": toolctl.sha256_file(package + "/dist/sub/b.mjs")}]
        write(package + "/dist/postinstall-content-inventory.json", json.dumps(inventory))
        old = os.lstat(package + "/dist/postinstall-content-inventory.json").st_mtime - 100
        for rel, when in (("dist/a.mjs", old), ("dist/sub/b.mjs", old), ("dist/postinstall-content-inventory.json", old + 50)):
            os.utime(package + "/" + rel, (when, when))
        clean = toolctl.dist_override_estimate(package)
        self.assertEqual((clean["localEdits"], clean["distBytes"], clean["inventory"]), (False, 4000, True))
        reasons = lambda: [p["reason"] for v in self.host.preflight()["facts"]["disk"]["volumes"] for p in v["parts"]]
        self.assertFalse([r for r in reasons() if "dist override" in r])
        # Same-size edit after install: caught by the hash of a file newer than the inventory.
        write(package + "/dist/a.mjs", "z" * 1000)
        edited = toolctl.dist_override_estimate(package)
        self.assertEqual((edited["localEdits"], edited["examples"]), (True, ["dist/a.mjs"]))
        self.assertIn("dist override bundle (local edits detected)", reasons())
        os.unlink(package + "/dist/postinstall-content-inventory.json")
        self.assertIsNone(toolctl.dist_override_estimate(package)["localEdits"])
        self.assertIn("dist override bundle (local edits could not be ruled out)", reasons())


class NodeRuntimeTests(HostTestCase):
    """PF-7 (a) and c.2.0 against fake apt/dpkg; the madison golden is recorded from this host."""

    def test_candidate_choice(self):
        candidates = toolctl.nodesource_candidates(MADISON)
        self.assertEqual([c[0] for c in candidates], ["24.22.2", "24.22.1", "24.22.0", "24.21.0"])
        engines = ">=24.22.1 <25 || >=26.12.1"
        self.assertEqual(toolctl.choose_node_upgrade(candidates, "24.21.0", engines), ("24.22.2", "24.22.2-1nodesource1"))
        self.assertIsNone(toolctl.choose_node_upgrade(candidates, "24.21.0", ">=24.23.0 <25"))
        self.assertIsNone(toolctl.choose_node_upgrade(candidates, "22.12.0", ">=22.13"))  # never a major jump

    def test_preflight_plans_the_node_step_only_when_accepted(self):
        self.host.enable_node_runtime()
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF7_NODE_ENGINE"])
        report = self.host.preflight(node_update=True)
        self.assertTrue(report["ok"], report["refusals"])
        states = {c["id"]: c["state"] for c in report["checks"]}
        self.assertEqual((states["PF-7"], states["PF-11"]), ("action", "deferred"))
        self.assertEqual(report["facts"]["nodeRuntime"]["from"], "24.21.0")
        self.assertNotIn("update --dry-run", " ".join(self.host.calls()))
        self.assertEqual(self.host.apt_calls(), ["-W -f=${Version} nodejs"])
        write(self.host.fake + "/dpkg-version.txt", "24.21.0-1ubuntu1")
        self.assertEqual(self.refusal_ids(self.host.preflight(node_update=True)), ["PF7_NODE_NOT_NODESOURCE"])

    def test_run_updates_node_then_rechecks_then_updates_openclaw(self):
        self.host.enable_node_runtime()
        self.host.queue(action="update", acknowledgements={"confirmation": True, "maintenanceWindow": True, "nodeRuntime": True})
        self.host.native_update_installs()
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]][:3], ["preflight", "node-runtime", "plugins-pre"])
        self.assertEqual(status["result"]["nodeRuntime"], {"from": "24.21.0", "to": "24.22.2"})
        apt = self.host.apt_calls()
        parts = "%s/tmp/%s/apt-sources" % (self.host.paths["state_root"], RUN_ID)
        self.assertEqual(apt[1], "update -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=%s -o APT::Get::List-Cleanup=0" % parts)
        self.assertEqual(apt[2:], ["madison nodejs", "install -y --only-upgrade --no-install-recommends nodejs=24.22.2-1nodesource1"])
        calls = self.host.calls()
        # The dry run happens once, after the Node.js update, and before the native update.
        self.assertEqual([c for c in calls if c.startswith("update --")],
                         ["update --dry-run --json --no-restart --channel stable --tag 2026.10.9",
                          "update --channel stable --tag 2026.10.9 --yes --json --no-restart"])
        evidence = toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/node-runtime.json" % RUN_ID)
        self.assertEqual(evidence["chosen"], {"version": "24.22.2", "package": "24.22.2-1nodesource1"})

    def test_apt_source_copy_is_cleaned_up(self):
        self.host.enable_node_runtime()
        self.host.queue(action="update", acknowledgements={"nodeRuntime": True})
        self.host.native_update_installs()
        self.assertEqual(self.host.run()["state"], "succeeded")
        self.assertEqual(os.listdir(self.host.paths["state_root"] + "/tmp"), [])

    def test_no_suitable_node_changes_nothing(self):
        self.host.enable_node_runtime(madison="    nodejs | 24.21.0-1nodesource1 | https://deb.nodesource.com/node_24.x nodistro/main amd64 Packages\n")
        self.host.queue(action="update", acknowledgements={"nodeRuntime": True})
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "NODE_RUNTIME_UNAVAILABLE"))
        self.assertNotIn("install", " ".join(self.host.apt_calls()))
        self.assertNotIn("update --channel", " ".join(self.host.calls()))

    def test_native_still_refusing_after_node_update(self):
        self.host.enable_node_runtime()
        self.host.reply("dry-run", {"currentVersion": "2026.9.9", "targetVersion": "2026.10.9",
                                    "notes": ["Would refuse update: the configured plugin x is unavailable"]})
        self.host.queue(action="update", acknowledgements={"nodeRuntime": True})
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "PF11_NATIVE_WOULD_REFUSE"))
        self.assertTrue(status["error"]["message"].startswith("Node.js was updated to 24.22.2. OpenClaw would refuse this update:"))
        self.assertNotIn("update --channel", " ".join(self.host.calls()))

    def test_acknowledgement_must_be_boolean(self):
        self.host.queue(action="update", acknowledgements={"nodeRuntime": "yes"})
        self.assertEqual(self.host.run()["error"]["id"], "REQUEST_INVALID")


class NativePreflightTests(HostTestCase):
    """PF-3, PF-5 health, PF-6 already-current and PF-11 against the fake native CLI."""

    def test_pf3_native_run_active_or_stale(self):
        active = {"runId": "r1", "phase": "validating", "status": "running"}
        self.host.reply("status", {"activeRun": active})
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF3_NATIVE_RUN_ACTIVE"])
        self.assertEqual(report["refusals"][0]["message"],
                         "OpenClaw has its own update or recovery in progress (phase: validating).")
        self.assertIsNone(report["refusals"][0]["nextAction"])
        # Nothing else native runs once PF-3 refuses.
        self.assertEqual(self.host.calls(), ["update status --json"])
        self.host.reply("status", {"activeRun": active, "abandonedRun": {"runId": "r1", "rule": "driver-dead"}})
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF3_NATIVE_RUN_STALE"])
        self.assertEqual(report["refusals"][0]["nextAction"], "recover-native")

    def test_pf3_recovery_pending_and_unreadable_history(self):
        self.host.reply("status", {"lastRun": {"runId": "r2", "status": "failed", "phase": "activating",
                                               "reason": "update-recovery-pending",
                                               "origin": {"nextAction": "openclaw update repair"}}})
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF3_NATIVE_RECOVERY_PENDING"])
        self.assertEqual(report["refusals"][0]["detail"]["nativeNextAction"], "openclaw update repair")
        self.assertEqual(report["refusals"][0]["nextAction"], "recover-native")
        self.host.reply("status", {"runStatusError": "history database is locked"})
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF3_NATIVE_HISTORY_UNREADABLE"])
        # A last run that simply failed or rolled back does not block a new update.
        self.host.reply("status", {"lastRun": {"runId": "r3", "status": "rolled-back", "phase": "finished"}})
        self.assertTrue(self.host.preflight()["ok"])

    def test_pf3_unsettled_package_activation_needs_repair(self):
        idle = json.loads(native_fixture("update-status.idle.json"))
        for extra in ({"packageActivation": {"phase": "activating", "operationId": "op1"}},
                      {"packageActivationError": "activation journal is unreadable"}):
            with self.subTest(extra=sorted(extra)):
                self.host.reply("status", dict(idle, **extra))
                report = self.host.preflight()
                self.assertEqual(self.refusal_ids(report), ["PF3_NATIVE_ACTIVATION_PENDING"])
                self.assertEqual(report["refusals"][0]["nextAction"], "recover-native")
        self.host.reply("status", dict(idle, packageActivation={"phase": "complete", "operationId": "op1"}))
        self.assertTrue(self.host.preflight()["ok"])

    def test_pf11_failures_list_refuses_like_a_would_refuse_note(self):
        self.host.reply("dry-run", native_fixture("update-dry-run.refuse.json"))
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF11_NATIVE_WOULD_REFUSE"])
        self.assertEqual(report["refusals"][0]["message"],
                         "OpenClaw would refuse this update: The global package directory is not writable by this user.")
        self.assertEqual(report["facts"]["dryRun"]["failures"][0]["reason"], "package-permissions")

    def test_pf3_status_unavailable_fails_closed(self):
        for stdout, code in (("not json", 0), ("{}", 1), ("[1, 2]", 0)):
            with self.subTest(stdout=stdout, code=code):
                self.host.reply("status", stdout, exit_code=code)
                report = self.host.preflight()
                self.assertEqual(self.refusal_ids(report), ["PF3_NATIVE_STATUS_UNAVAILABLE"])
        self.host.reply("status", "{}", exit_code=0, stderr="api_key=" + FAKE_SECRET + " oops")
        self.host.reply("status", "garbage")
        report = self.host.preflight()
        self.assertNotIn(FAKE_SECRET, json.dumps(report))

    def test_pf3_tolerates_leading_log_lines(self):
        self.host.reply("status", "[openclaw] reading state\n" + native_fixture("update-status.idle.json"))
        self.assertTrue(self.host.preflight()["ok"])

    def test_pf5_health_each_signal(self):
        write(self.host.fake + "/is-active", "activating")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF5_GATEWAY_UNHEALTHY"])
        self.assertEqual(report["refusals"][0]["message"],
                         "OpenClaw isn't healthy, so a safe rollback couldn't be guaranteed. Fix it first.")
        self.assertEqual([p["check"] for p in report["refusals"][0]["detail"]["problems"]], ["service"])
        os.unlink(self.host.fake + "/is-active")
        self.host.http.status = 503
        report = self.host.preflight()
        self.assertEqual([p["check"] for p in report["refusals"][0]["detail"]["problems"]], ["readyz"])
        self.host.http.status = None
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF5_GATEWAY_UNHEALTHY"])
        self.host.http.status = 200
        self.host.reply("gateway-status", "{}", exit_code=1)
        report = self.host.preflight()
        self.assertEqual([p["check"] for p in report["refusals"][0]["detail"]["problems"]], ["rpc"])
        self.assertEqual(report["refusals"][0]["nextAction"], "openclaw-status")
        with open(self.host.fake + "/systemctl.log") as handle:
            self.assertEqual(handle.read().splitlines()[0], "is-active openclaw-gateway.service")

    def test_pf5_readyz_uses_the_unit_port(self):
        self.host.write_unit(exec_start=self.host.paths["openclaw_bin"] + " gateway --port=19999")
        self.assertTrue(self.host.preflight()["ok"])
        self.assertEqual(self.host.http.urls, ["http://127.0.0.1:19999/readyz"])
        self.assertEqual(toolctl.gateway_port("/usr/bin/openclaw gateway", {"OPENCLAW_GATEWAY_PORT": "18800"}), 18800)
        self.assertEqual(toolctl.gateway_port("/usr/bin/openclaw gateway", {}), 18789)
        self.assertIsNone(toolctl.gateway_port("/usr/bin/openclaw gateway --port 99999", {}))

    def test_pf6_already_current_makes_no_native_update_calls(self):
        write(self.host.meta_path, json.dumps(dict(TARGET_META, version="2026.9.9")))
        policy = self.host.policy()
        toolctl.policy_tool(policy, "openclaw")["newestProven"]["version"] = "2026.9.9"
        self.host.set_policy(policy)
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF6_ALREADY_CURRENT"])
        self.assertEqual(report["refusals"][0]["message"], "OpenClaw 2026.9.9 is already installed. Nothing to update.")
        self.assertNotIn("update --dry-run", " ".join(self.host.calls()))

    def test_pf11_dry_run_refusals(self):
        cases = [
            ({"currentVersion": "2026.9.9", "targetVersion": "2026.10.9",
              "notes": ["Would refuse update: Node.js 24.21.0 does not satisfy >=24.22.1"]}, 0, "PF11_NATIVE_WOULD_REFUSE"),
            ({"currentVersion": "2026.9.9", "targetVersion": None, "targetVersionReason": "dist-tag lookup failed"}, 0,
             "PF11_TARGET_UNRESOLVED"),
            ({"currentVersion": "2026.9.9", "targetVersion": "2026.10.8"}, 0, "PF11_TARGET_MISMATCH"),
            ({"targetVersion": "2026.10.9"}, 1, "PF11_DRY_RUN_FAILED"),
        ]
        for doc, code, refusal in cases:
            with self.subTest(refusal=refusal):
                self.host.reply("dry-run", doc, exit_code=code)
                report = self.host.preflight()
                self.assertEqual(self.refusal_ids(report), [refusal])
        self.assertEqual(report["refusals"][0]["message"], "OpenClaw's own update check didn't complete, so the update can't start.")
        self.host.reply("dry-run", {"targetVersion": None, "targetVersionReason": "registry unreachable"}, exit_code=0)
        self.assertEqual(self.host.preflight()["refusals"][0]["message"],
                         "OpenClaw couldn't resolve the version to install: registry unreachable.")

    def test_pf11_newest_has_no_tag(self):
        write(self.host.meta_path, json.dumps(dict(TARGET_META, version="2026.9.36")))
        self.host.reply("dry-run", {"currentVersion": "2026.9.9", "targetVersion": "2026.9.36", "notes": []})
        report = self.host.preflight(target="newest", channel="extended-stable")
        self.assertTrue(report["ok"], report["refusals"])
        self.assertEqual(self.host.calls()[-1], "update --dry-run --json --no-restart --channel extended-stable")

    def test_no_native_command_while_a_legacy_transaction_is_open(self):
        write(self.host.paths["gateway_fence_marker"], "{}")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF2_LEGACY_TRANSACTION_OPEN"])
        self.assertEqual(self.host.calls(), [])
        self.assertEqual(self.host.http.urls, [])
        self.assertFalse(os.path.exists(self.host.fake + "/systemctl.log"))


class RunTests(HostTestCase):
    def status_files(self):
        state = self.host.paths["state_root"]
        return [os.path.join(dp, f) for dp, _dn, fn in os.walk(state) for f in fn]

    def test_preflight_run_succeeds_durably(self):
        self.host.queue()
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded")
        self.assertEqual(status["schema"], "bridgesllm.tools.run.v1")
        self.assertEqual([s["id"] for s in status["steps"]], ["preflight"])
        self.assertEqual(status["steps"][0]["evidence"], ["preflight.json"])
        self.assertEqual(status["result"]["from"], "2026.9.9")
        run_dir = self.host.paths["state_root"] + "/runs/" + RUN_ID
        for path in self.status_files():
            mode = stat.S_IMODE(os.lstat(path).st_mode)
            if not path.endswith("/lock"):
                self.assertEqual(mode, 0o600, path)
        for path in (self.host.paths["state_root"], run_dir, self.host.paths["state_root"] + "/tmp"):
            self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o700, path)
        self.assertFalse(os.path.exists(self.host.paths["state_root"] + "/lock.owner.json"))
        self.assertIsNone(toolctl.lock_holder(self.host.roots()))
        self.assertFalse([p for p in self.status_files() if p.endswith(".tmp")])
        history = self.host.history()
        self.assertEqual(len(history), 1)
        self.assertEqual((history[0]["runId"], history[0]["outcome"], history[0]["from"]), (RUN_ID, "succeeded", "2026.9.9"))
        # Idempotent: a second start of the same unit changes nothing.
        again = self.host.run()
        self.assertEqual(again, status)
        self.assertEqual(len(self.host.history()), 1)

    def test_update_run_executes_the_native_update(self):
        self.host.queue(action="update")
        self.host.native_update_installs()
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([(s["id"], s["state"]) for s in status["steps"]],
                         [("preflight", "passed"), ("plugins-pre", "passed"), ("native", "passed"),
                          ("gateway-stop", "passed"), ("gateway-start", "passed"), ("plugins-post", "passed"),
                          ("contract", "passed")])
        self.assertEqual(status["result"]["updateMode"]["mode"], "live")
        self.assertEqual(status["result"]["contract"]["passed"], ["OC-READY", "OC-HELLO", "OC-CONFIG", "OC-PLUG-ASK"])
        self.assertIn("OC-QUESTION", status["result"]["contract"]["notRun"])
        probes = sorted(os.listdir(self.host.paths["state_root"] + "/runs/%s/probes" % RUN_ID))
        self.assertIn("OC-READY.json", probes)
        self.assertIn("OC-HELLO.json", probes)
        self.assertEqual((status["result"]["from"], status["result"]["to"]), ("2026.9.9", "2026.10.9"))
        self.assertEqual(status["result"]["native"]["status"], "succeeded")
        calls = self.host.calls()
        update_at = calls.index("update --channel stable --tag 2026.10.9 --yes --json --no-restart")
        # Plugins already at the release's versions: inspected, never reinstalled.
        self.assertEqual(calls[3:update_at], ["plugins inspect bridgesllm-ask-user --json",
                                              "plugins inspect bridgesllm-shared-browser --json"])
        self.assertFalse([c for c in calls if c.startswith(("plugins install", "plugins reload"))])
        native = status["native"]
        self.assertEqual(native["command"]["argv"], [self.host.base + "/usr/bin/node", self.host.paths["openclaw_bin"], "update",
                                                     "--channel", "stable", "--tag", "2026.10.9", "--yes", "--json",
                                                     "--no-restart"])
        self.assertEqual(native["command"]["env"]["OPENCLAW_GATEWAY_TOKEN"], "<redacted>")
        self.assertEqual(native["exitCode"], 0)
        with open(self.host.fake + "/update-env.log") as handle:
            self.assertEqual(handle.read().strip(), "TMPDIR=%s/tmp/%s NPM_CONFIG_PREFIX=/usr" % (self.host.paths["state_root"], RUN_ID))
        run_dir = self.host.paths["state_root"] + "/runs/" + RUN_ID
        result = toolctl.read_json_file(run_dir + "/native-result.json")
        self.assertEqual(result["run"]["status"], "succeeded")
        with open(run_dir + "/native-stderr.log") as handle:
            self.assertIn("update phase: staging", handle.read())
        for name in ("native-stdout.json", "native-stderr.log", "native-result.json", "native-status-after.json"):
            self.assertEqual(stat.S_IMODE(os.lstat(run_dir + "/" + name).st_mode), 0o600, name)
        self.assertFalse(os.path.exists(self.host.paths["state_root"] + "/tmp/" + RUN_ID))
        self.assertEqual(self.host.history()[-1]["outcome"], "succeeded")
        self.assertEqual((self.host.history()[-1]["from"], self.host.history()[-1]["to"]), ("2026.9.9", "2026.10.9"))

    def test_internal_error_never_leaves_an_active_run(self):
        self.host.queue(action="update")
        self.host.native_update_installs()
        with mock.patch.object(toolctl.NativeUpdate, "execute", side_effect=RuntimeError("disk full api_key=" + FAKE_SECRET)):
            status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "TOOLS_RUN_INTERNAL_ERROR"))
        self.assertEqual(status["error"]["detail"]["phase"], "native")
        self.assertNotIn(FAKE_SECRET, json.dumps(status))
        self.assertIsNone(toolctl.lock_holder(self.host.roots()))
        self.assertEqual(self.host.history()[-1]["outcome"], "recovery-required")
        with mock.patch.object(toolctl, "plugins_pre", side_effect=OSError("boom")):
            shutil.rmtree(self.host.paths["state_root"])
            self.host.queue(action="update")
            status = self.host.run()
        # plugins-pre is a changing phase: an error inside it needs recovery, not "nothing changed".
        self.assertEqual((status["state"], status["error"]["detail"]["phase"]), ("recovery-required", "plugins-pre"))

    def test_native_rolled_back(self):
        self.host.queue(action="update")
        self.host.native_update_installs(version="2026.9.9", result="update-result.rolled-back.json")
        self.host.reply("update", exit_code=1)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "NATIVE_ROLLED_BACK"))
        self.assertEqual(status["error"]["message"],
                         "The update failed; OpenClaw automatically returned to 2026.9.9. Reason: update-rolled-back.")
        self.assertEqual(status["error"]["nextAction"], "Inspect the update report with: openclaw update status")
        self.assertEqual(status["result"]["to"], "2026.9.9")

    def test_native_killed_without_result_needs_recovery(self):
        self.host.queue(action="update")
        self.host.native_update_installs(result=None, extra="kill -KILL $$\n")
        status = self.host.run()
        # The package never changed: repair is tried (it fails here), then 2026.9.9 is started again;
        # native's own recovery stays the one open action.
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "UPDATE_NOT_APPLIED"))
        self.assertEqual(status["error"]["nextAction"], "recover-native")
        self.assertIn("The OpenClaw updater stopped without reporting a result", status["error"]["message"])
        self.assertEqual(status["native"]["exitCode"], -9)
        with open(self.host.fake + "/is-active") as handle:
            self.assertEqual(handle.read().strip(), "active")
        self.assertEqual(toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/native-result.json" % RUN_ID),
                         {"unparsed": True, "stdoutBytes": 0})

    def test_sigterm_during_native_is_forwarded_and_awaited(self):
        self.host.queue(action="update")
        self.host.native_update_installs(version="2026.9.9", result=None, extra=(
            "on_term() { echo restoring >&2; sleep 0.3; cat '%s'; exit 1; }\n"
            "trap on_term TERM\n"
            "kill -TERM $PPID\n"
            "i=0; while [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\n"
            "echo not-reached >&2\n" % os.path.join(NATIVE_FIXTURES, "update-result.rolled-back.json")))
        before = signal.getsignal(signal.SIGTERM)
        status = self.host.run()
        self.assertIs(signal.getsignal(signal.SIGTERM), before)
        self.assertEqual(status["state"], "rolled-back")
        self.assertEqual(status["native"]["stop"]["signal"], "SIGTERM")
        self.assertIs(status["native"]["stop"]["forwardedToChild"], True)
        self.assertEqual(status["stop"]["signal"], "SIGTERM")
        with open(self.host.paths["state_root"] + "/runs/%s/native-stderr.log" % RUN_ID) as handle:
            log = handle.read()
        self.assertIn("restoring", log)
        self.assertNotIn("not-reached", log)
        self.assertIsNone(toolctl.lock_holder(self.host.roots()))

    def test_live_progress_is_recorded(self):
        self.host.queue(action="update")
        self.host.native_update_installs(extra=(
            "printf '{\"activeRun\": {\"runId\": \"n\", \"phase\": \"validating\", \"status\": \"running\"}}' "
            "> \"$FAKE/status.json\"\nsleep 0.5\n"
            "cp '%s' \"$FAKE/status.json\"\n" % os.path.join(NATIVE_FIXTURES, "update-status.idle.json")))
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded")
        self.assertIn("validating", status["native"]["phasesSeen"])
        self.assertEqual(status["native"]["phasesSeen"][0], "requested")

    def test_refused_run_names_reason_and_changes_nothing(self):
        write(self.host.paths["gateway_fence_marker"], "{}")
        self.host.queue(action="update")
        status = self.host.run()
        self.assertEqual(status["state"], "refused")
        self.assertEqual(status["error"]["id"], "PF2_LEGACY_TRANSACTION_OPEN")
        self.assertEqual(status["error"]["nextAction"], "recover-legacy")
        self.assertEqual(self.host.history()[0]["outcome"], "refused")
        self.assertFalse(os.path.exists(self.host.paths["state_root"] + "/runs/%s/native-plan.json" % RUN_ID))

    def test_the_run_unit_ends_failed_for_failures_and_crashes_never_for_a_refusal(self):
        # F8: `toolctl run` is the unit's ExecStart. A refusal is a recorded normal outcome: exit 0, so no failed
        # bridgesllm-tools@<runId>.service is left behind; failures and open recoveries still fail the unit.
        self.addCleanup(os.umask, os.umask(0o022))  # main() sets 077
        argv = ["--%s=%s" % (name.replace("_", "-"), ":".join(value) if isinstance(value, list) else value)
                for name, value in self.host.paths.items()] + ["run", RUN_ID]
        for state, code in (("succeeded", 0), ("succeeded-degraded", 0), ("refused", 0), ("failed", 3),
                            ("rolled-back", 3), ("recovery-required", 4), ("running", 1)):
            with self.subTest(state=state), mock.patch.object(toolctl, "cmd_run", return_value={"state": state}), \
                    mock.patch.object(toolctl, "emit"):
                self.assertEqual(toolctl.main(argv), code)
        with mock.patch.object(toolctl, "cmd_run", side_effect=toolctl.ToolctlError("no run directory")), \
                mock.patch.object(sys, "stderr"):
            self.assertEqual(toolctl.main(argv), toolctl.EXIT_ERROR)
        # A crash is never caught: python3 exits 1 and the unit is failed.
        with mock.patch.object(toolctl, "cmd_run", side_effect=RuntimeError("crash")), self.assertRaises(RuntimeError):
            toolctl.main(argv)
        # The pre-flight command keeps its refusal exit status (it is not a run unit).
        self.assertEqual(toolctl.EXIT_REFUSED, 2)

    def test_invalid_requests_fail(self):
        cases = [
            {"tool": "codex"}, {"target": "2026.10.9"}, {"action": "purge"}, {"runId": OTHER_RUN_ID},
            {"channel": "beta"}, {"schema": "x"},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                shutil.rmtree(self.host.paths["state_root"], ignore_errors=True)
                self.host.queue(**overrides)
                status = self.host.run()
                self.assertEqual((status["state"], status["error"]["id"]), ("failed", "REQUEST_INVALID"))

    def test_policy_changed_after_request(self):
        self.host.queue(policySha256="0" * 64)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "POLICY_CHANGED"))

    def test_invalid_policy_fails_run(self):
        self.host.queue()
        policy = self.host.policy()
        policy["schema"] = "broken"
        self.host.set_policy(policy)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "POLICY_INVALID"))

    def test_integrity_in_the_wrong_form_for_its_kind_fails_run_with_the_field(self):
        self.host.queue()
        policy = self.host.policy()
        toolctl.policy_tool(policy, "opencode")["newestProven"].update(
            status="qualified", integrity=INTEGRITY_SRI, qualifiedAt="2026-11-02T10:00:00Z")
        self.host.set_policy(policy)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "POLICY_INVALID"))
        self.assertEqual(status["error"]["detail"]["errors"], [
            "$.tools[4].newestProven.integrity: must be null or an object keyed by machine (x86_64, aarch64) for "
            "source kind github-release"])

    def test_bad_run_ids(self):
        for run_id in ("../etc", "ABCDEF00-0000-0000-0000-000000000000", "", RUN_ID + "x", RUN_ID + "\n", "\n" + RUN_ID):
            with self.subTest(run_id=run_id), self.assertRaises(toolctl.ToolctlError):
                toolctl.cmd_run(self.host.roots(), run_id)
        with self.assertRaises(toolctl.ToolctlError):
            toolctl.cmd_run(self.host.roots(), OTHER_RUN_ID)  # no request directory

    def test_run_id_with_trailing_newline_is_refused_even_with_a_request(self):
        # `$` matches before a trailing newline; a run dir named "<uuid>\n" must not run.
        self.host.queue(run_id=RUN_ID + "\n", runId=RUN_ID)
        self.assertIsNone(toolctl.RUN_ID_RE.match(RUN_ID + "\n"))
        with self.assertRaises(toolctl.ToolctlError):
            toolctl.cmd_run(self.host.roots(), RUN_ID + "\n")
        self.assertEqual(toolctl.list_runs(self.host.roots()), [])
        self.assertEqual(toolctl.cmd_reconcile(self.host.roots(), stale_queued_seconds=0), [])
        self.assertFalse(os.path.exists(self.host.paths["state_root"] + "/runs/%s\n/status.json" % RUN_ID))

    def test_interrupted_runs_resolve_by_phase(self):
        for phase, state, expected, error_id in (
                ("native", "running", "recovery-required", "TOOLS_RUN_INTERRUPTED"),
                ("plugins-post", "verifying", "recovery-required", "TOOLS_RUN_INTERRUPTED"),
                ("preflight", "preflight", "failed", "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE"),
                ("native-plan", "running", "failed", "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE")):
            with self.subTest(phase=phase):
                shutil.rmtree(self.host.paths["state_root"], ignore_errors=True)
                self.host.queue()
                run = toolctl.Run(self.host.roots(), RUN_ID)
                run.init_status("openclaw")
                run.transition(phase, state)
                status = self.host.run()
                self.assertEqual((status["state"], status["error"]["id"]), (expected, error_id))

    def test_lock_busy(self):
        self.host.queue()
        os.makedirs(self.host.paths["state_root"] + "/tmp", mode=0o700, exist_ok=True)
        other = toolctl.ToolsLock(self.host.roots())
        other.acquire(OTHER_RUN_ID)
        try:
            status = self.host.run()
            self.assertEqual((status["state"], status["error"]["id"]), ("refused", "PF4_TOOLS_RUN_ACTIVE"))
        finally:
            other.release()
        # The same run already holding the lock (a duplicate start) is left untouched.
        shutil.rmtree(self.host.paths["state_root"] + "/runs/" + RUN_ID)
        self.host.queue()
        run = toolctl.Run(self.host.roots(), RUN_ID)
        run.init_status("openclaw")
        run.transition("preflight", "preflight")
        same = toolctl.ToolsLock(self.host.roots())
        same.acquire(RUN_ID)
        try:
            status = self.host.run()
            self.assertEqual(status["state"], "preflight")
        finally:
            same.release()

    def test_portal_operation_lock_busy_refuses(self):
        self.host.queue()
        path = self.host.paths["portal_operation_lock"]
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "PF4_PORTAL_OPERATION_ACTIVE"))

    def test_run_holds_portal_operation_lock_without_writing_it(self):
        self.host.queue()
        seen = {}
        original = toolctl.Preflight.run

        def spy(preflight):
            seen["busy"] = toolctl.portal_operation_lock_busy(self.host.paths["portal_operation_lock"])
            seen["holder"] = toolctl.lock_holder(self.host.roots())
            return original(preflight)

        with mock.patch.object(toolctl.Preflight, "run", spy):
            status = self.host.run()
        self.assertEqual(status["state"], "succeeded")
        self.assertIs(seen["busy"], True)
        self.assertEqual(seen["holder"]["runId"], RUN_ID)
        self.assertEqual(os.lstat(self.host.paths["portal_operation_lock"]).st_size, 0)
        self.assertFalse(toolctl.portal_operation_lock_busy(self.host.paths["portal_operation_lock"]))

    def test_secrets_never_reach_run_artifacts(self):
        self.host.queue(action="update")
        self.host.native_update_installs()
        with mock.patch.dict(os.environ, {"OPENCLAW_GATEWAY_TOKEN": FAKE_SECRET, "NPM_TOKEN": FAKE_SECRET}):
            self.assertEqual(self.host.run()["state"], "succeeded")
        files = self.status_files()
        self.assertTrue(any(p.endswith("native-result.json") for p in files))
        for path in files:
            with open(path, "rb") as handle:
                self.assertNotIn(FAKE_SECRET.encode(), handle.read(), path)


# A child that logs, counts SIGTERMs and needs `restore` seconds to stop, like
# OpenClaw's updater restoring on SIGTERM.
TERM_CHILD = """#!/bin/sh
log=$1; restore=$2
on_term() { echo term >> "$log"; sleep "$restore"; echo restored >> "$log"; exit 143; }
trap on_term TERM
echo started >> "$log"
i=0
while [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done
echo finished >> "$log"
"""


class NativeOutcomeTests(unittest.TestCase):
    """c.2.4 mapping over SYNTHESIZED records (shapes from the 2026.10.9 docs, unverified until recorded live)."""

    def outcome(self, status=None, reason=None, phase="finished", exit_code=0, status_doc=None, after="2026.10.9",
                launched=1000):
        doc = None if status is None else {"runId": "n1", "run": {"runId": "n1", "status": status, "reason": reason,
                                                                   "phase": phase, "origin": {"nextAction": "do X"}}}
        return toolctl.map_native_outcome(exit_code, doc, status_doc, launched, "2026.9.9", after, "2026.10.9")

    def test_table(self):
        cases = [
            (dict(status="succeeded"), "succeeded", True),
            (dict(status="skipped", reason="already-current"), "succeeded", True),
            (dict(status="skipped", reason="gateway-readiness-unverified"), "succeeded-degraded", True),
            (dict(status="skipped", reason="no-package-manager-owner", after="2026.9.9"), "refused", False),
            (dict(status="rolled-back", reason="post-install-verify", exit_code=1, after="2026.9.9"), "rolled-back", True),
            (dict(status="failed", reason="snapshot-capacity-insufficient", phase="staging", exit_code=1, after="2026.9.9"),
             "refused", False),
            (dict(status="failed", reason="update-recovery-pending", phase="activating", exit_code=1), "recovery-required", False),
            # Native refuses at admission while its recovery still owns the run: not "nothing changed".
            (dict(status="failed", reason="update-recovery-pending", phase="requested", exit_code=1), "recovery-required", False),
            (dict(status="failed", reason="update-activation-timeout", phase="restarting", exit_code=1), "recovery-required", False),
            (dict(status="failed", reason="update-failed", phase="verifying", exit_code=1), "recovery-required", False),
            (dict(status="repairing"), "recovery-required", False),
            (dict(status=None, exit_code=-15), "recovery-required", False),
        ]
        for kwargs, state, cont in cases:
            with self.subTest(**{k: str(v) for k, v in kwargs.items()}):
                mapped = self.outcome(**kwargs)
                self.assertEqual((mapped["state"], mapped["continue"]), (state, cont))
        self.assertEqual(self.outcome(status="failed", reason="update-activation-timeout", phase="restarting",
                                      exit_code=1)["error"]["id"], "NATIVE_RECOVERY_REQUIRED")
        self.assertEqual(self.outcome(status="failed", reason="update-failed", phase="verifying",
                                      exit_code=1)["error"]["id"], "NATIVE_FAILED_AFTER_ACTIVATION")
        refused = self.outcome(status="failed", reason="snapshot-capacity-insufficient", phase="staging", exit_code=1)
        self.assertEqual(refused["error"]["nextAction"], "do X")
        self.assertEqual(refused["error"]["message"],
                         "OpenClaw stopped the update before changing anything: snapshot-capacity-insufficient. Nothing was changed.")

    def test_missing_result_is_settled_only_by_a_newer_finished_status_row(self):
        newer = {"lastRun": {"runId": "n9", "status": "rolled-back", "phase": "finished", "finishedAtMs": 2000}}
        self.assertEqual(self.outcome(exit_code=-15, status_doc=newer)["state"], "rolled-back")
        older = {"lastRun": dict(newer["lastRun"], finishedAtMs=500)}
        self.assertEqual(self.outcome(exit_code=-15, status_doc=older)["state"], "recovery-required")
        busy = dict(newer, activeRun={"runId": "n9", "phase": "restarting"})
        self.assertEqual(self.outcome(exit_code=-15, status_doc=busy)["state"], "recovery-required")
        self.assertEqual(self.outcome(exit_code=-15, status_doc=None)["error"]["id"], "NATIVE_RESULT_MISSING")

    def test_success_contradicted_by_the_exit_code(self):
        self.assertEqual(self.outcome(status="succeeded", exit_code=1)["error"]["id"], "NATIVE_RESULT_CONTRADICTED")
        agrees = {"lastRun": {"runId": "n1", "status": "succeeded", "phase": "finished"}}
        self.assertEqual(self.outcome(status="succeeded", exit_code=1, status_doc=agrees)["state"], "succeeded")

    def test_progress_phase_from_stderr(self):
        self.assertEqual(toolctl.last_phase_in("x staging\ny Validating candidate\n"), "validating")
        self.assertEqual(toolctl.last_phase_in("update phase: repairing\n"), "repairing")
        self.assertIsNone(toolctl.last_phase_in("nothing here"))

    def derived(self, name, exit_code=1, status_doc=None, after="2026.9.9"):
        doc = json.loads(native_fixture(name))
        return toolctl.map_native_outcome(exit_code, doc, status_doc, 1000, "2026.9.9", after, "2026.10.9")

    def test_derived_results_map_by_the_steps_a_finished_run_reached(self):
        # A finished record always says phase "finished"; steps[] tell pre- from post-activation.
        refused = self.derived("update-result.failed-validating.json")
        self.assertEqual((refused["state"], refused["error"]["id"]), ("refused", "NATIVE_REFUSED"))
        self.assertIs(refused["native"]["postCore"], False)
        self.assertEqual(refused["error"]["nextAction"], "Inspect the update report with: openclaw update status")
        changed = self.derived("update-result.failed-activating.json")
        self.assertEqual((changed["state"], changed["error"]["id"]), ("recovery-required", "NATIVE_FAILED_AFTER_ACTIVATION"))
        rolled = self.derived("update-result.rolled-back.json")
        self.assertEqual((rolled["state"], rolled["continue"]), ("rolled-back", True))
        ok = self.derived("update-result.succeeded.json", exit_code=0, after="2026.10.9")
        self.assertEqual((ok["state"], ok["continue"], ok["native"]["resultStatus"]), ("succeeded", True, "ok"))

    def test_admission_refusal_without_a_run_changed_nothing(self):
        mapped = self.derived("update-result.admission-refused.json")
        self.assertEqual((mapped["state"], mapped["error"]["id"]), ("refused", "NATIVE_ADMISSION_REFUSED"))
        self.assertIn("gateway-service-ownership", mapped["error"]["message"])
        self.assertEqual(mapped["error"]["detail"]["stderrTail"], "The Gateway service is owned by another account.")
        # The same result once a run exists is not an admission refusal.
        doc = json.loads(native_fixture("update-result.admission-refused.json"))
        doc["runId"] = "n7"
        self.assertEqual(toolctl.map_native_outcome(1, doc, None, 1000, "2026.9.9", "2026.9.9", "2026.10.9")["error"]["id"],
                         "NATIVE_RESULT_MISSING")

    def test_result_without_its_run_record_is_settled_by_the_same_run_in_status(self):
        doc = {"status": "error", "reason": "update-rolled-back", "runId": "n5"}
        same = {"lastRun": {"runId": "n5", "status": "rolled-back", "phase": "finished", "finishedAtMs": 10}}
        self.assertEqual(toolctl.map_native_outcome(1, doc, same, 1000, "2026.9.9", "2026.9.9", "2026.10.9")["state"],
                         "rolled-back")
        other = {"lastRun": dict(same["lastRun"], runId="n6", finishedAtMs=5000)}
        self.assertEqual(toolctl.map_native_outcome(1, doc, other, 1000, "2026.9.9", "2026.9.9", "2026.10.9")["state"],
                         "recovery-required")

    def test_running_or_stepless_records_never_read_as_nothing_changed(self):
        pending = {"status": "error", "reason": "update-recovery-pending", "runId": "n1",
                   "run": {"runId": "n1", "status": "running", "phase": "activating", "reason": None, "steps": []}}
        self.assertEqual(toolctl.map_native_outcome(1, pending, None, 1000, "2026.9.9", None, "2026.10.9")["error"]["id"],
                         "NATIVE_RECOVERY_REQUIRED")
        pending["reason"] = None
        self.assertEqual(toolctl.map_native_outcome(1, pending, None, 1000, "2026.9.9", None, "2026.10.9")["error"]["id"],
                         "NATIVE_RUN_UNFINISHED")
        stepless = self.outcome(status="failed", reason="update-failed", phase="finished", exit_code=1)
        self.assertEqual(stepless["state"], "recovery-required")

    def test_wait_reason_is_the_in_progress_step(self):
        active = json.loads(native_fixture("update-status.active.json"))["activeRun"]
        self.assertEqual(toolctl.active_wait(active),
                         {"step": "validating", "detail": "Waiting for the canary Gateway to become ready."})
        self.assertIsNone(toolctl.active_wait({"steps": [{"step": "staging", "status": "completed"}]}))
        self.assertIsNone(toolctl.active_wait(None))


class PluginReconcileAndContractTests(HostTestCase):
    """c.2.1, c.3 and the c.4 probes this build runs, against the fake plugin registry."""

    def update(self, **native):
        self.host.queue(action="update")
        self.host.native_update_installs(**native)
        return self.host.run()

    def test_plugins_pre_installs_what_differs_and_reloads_once(self):
        self.host.set_plugin("bridgesllm-ask-user", {"id": "bridgesllm-ask-user", "version": "3.9.0", "status": "enabled"})
        self.host.set_plugin("bridgesllm-shared-browser", None)
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        calls = self.host.calls()
        directory = self.host.paths["portal_plugins_dir"]
        self.assertIn("plugins install %s/bridgesllm-ask-user-4.0.0.tgz --force --accept-capabilities" % directory, calls)
        self.assertIn("plugins install %s/bridgesllm-shared-browser-1.0.0.tgz --force --accept-capabilities" % directory, calls)
        reloads = [c for c in calls if c.startswith("plugins reload")]
        self.assertEqual(reloads, ["plugins reload bridgesllm-ask-user bridgesllm-shared-browser --wait --json --accept-capabilities"])
        self.assertLess(calls.index(reloads[0]), calls.index("update --channel stable --tag 2026.10.9 --yes --json --no-restart"))

    def test_plugins_pre_failure_stops_before_the_core_update(self):
        self.host.set_plugin("bridgesllm-ask-user", None)
        write(self.host.fake + "/plugins-install.fail", "")
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "PLUGINS_PRE_FAILED"))
        self.assertNotIn("update --channel", " ".join(self.host.calls()))

    def test_plugins_pre_never_runs_before_openclaw_admits_the_update(self):
        """N4: plugins-pre changes OpenClaw, so it runs only after native's own dry run accepted the update."""
        self.host.set_plugin("bridgesllm-shared-browser", None)
        with mock.patch.object(toolctl.Preflight, "check_dry_run",
                               lambda preflight, _channel, _meta: preflight.check("PF-11", "pass", "not run")):
            status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "PF11_NOT_ADMITTED"))
        self.assertFalse([c for c in self.host.calls() if c.startswith(("plugins install", "plugins reload", "update --channel"))])
        self.assertNotIn("plugins-pre", [s["id"] for s in status["steps"]])

    def test_a_failed_plugin_reload_fails_plugins_pre_and_says_what_changed(self):
        """2026.9.3: the reload failed ("no command reload") yet the step showed "passed"."""
        self.host.set_plugin("bridgesllm-shared-browser", None)
        self.host.reply("plugins-reload", "", exit_code=1,
                        stderr='OpenClaw plugins has no command "reload".')
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "PLUGINS_PRE_RELOAD_FAILED"))
        self.assertEqual(status["error"]["message"],
                         "The Portal installed its plugin bridgesllm-shared-browser 1.0.0 into OpenClaw, but OpenClaw couldn't "
                         "reload it: OpenClaw plugins has no command \"reload\". The plugin stays installed; OpenClaw itself "
                         "was not updated.")
        self.assertEqual([s["state"] for s in status["steps"] if s["id"] == "plugins-pre"], ["failed"])
        self.assertEqual(status["result"]["pluginsInstalled"], ["bridgesllm-shared-browser 1.0.0"])
        self.assertNotIn("update --channel", " ".join(self.host.calls()))

    def test_a_refusal_after_plugins_pre_says_which_plugins_it_installed(self):
        """N4: "Nothing was changed" only when nothing was."""
        self.host.set_plugin("bridgesllm-shared-browser", None)
        self.host.queue(action="update")
        self.host.reply("update", {"status": "error", "reason": "managed-service-preflight"}, exit_code=1, script=False)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "NATIVE_ADMISSION_REFUSED"))
        self.assertEqual(status["error"]["message"],
                         "OpenClaw refused the update before starting it: managed-service-preflight. OpenClaw itself was not "
                         "changed, but the Portal had already installed its plugin bridgesllm-shared-browser 1.0.0 into it; "
                         "it stays installed.")
        self.assertEqual(status["result"]["pluginsInstalled"], ["bridgesllm-shared-browser 1.0.0"])

    def test_a_refusal_after_plugins_pre_that_installed_nothing_says_nothing_changed(self):
        self.host.queue(action="update")
        self.host.reply("update", {"status": "error", "reason": "managed-service-preflight"}, exit_code=1, script=False)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["message"]), (
            "refused", "OpenClaw refused the update before starting it: managed-service-preflight. Nothing was changed."))
        self.assertNotIn("pluginsInstalled", status["result"])

    def test_plugins_post_reinstalls_and_restarts_once_when_reload_cannot(self):
        # The core update drops the ask-user plugin; reload needs a restart.
        self.host.native_update_installs(extra="rm -f \"$FAKE/plugins/bridgesllm-ask-user.json\"\n")
        self.host.reply("plugins-reload", {"pluginIds": ["bridgesllm-ask-user"], "restartRequired": True})
        self.host.queue(action="update")
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertIs(status["result"]["pluginsRestartedGateway"], True)
        with open(self.host.fake + "/systemctl.log") as handle:
            self.assertEqual([l for l in handle.read().splitlines() if l.startswith("restart")], ["restart openclaw-gateway.service"])

    def test_both_reloads_accept_capabilities_and_only_for_release_plugins(self):
        # plugins-pre installs the bundled ask-user plugin; the core update then drops it again.
        self.host.set_plugin("bridgesllm-ask-user", plugin_doc("bridgesllm-ask-user", "3.9.0"))
        self.host.native_update_installs(extra="rm -f \"$FAKE/plugins/bridgesllm-ask-user.json\"\n")
        self.host.queue(action="update")
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        reloads = [c for c in self.host.calls() if c.startswith("plugins reload")]
        self.assertEqual(reloads, ["plugins reload bridgesllm-ask-user --wait --json --accept-capabilities",
                                   "plugins reload bridgesllm-ask-user --wait --json --accept-capabilities"])
        evidence = toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/plugins-pre.json" % RUN_ID)
        self.assertEqual(evidence["commands"][-1]["args"][-1], "--accept-capabilities")
        worker = toolctl.PortalPlugins(self.host.roots(), {}, self.host.base + "/usr/bin/node", toolctl.run_bounded)
        with self.assertRaises(toolctl.ToolctlError):
            worker.reload(["bridgesllm-ask-user", "someone-elses-plugin"], accept_for=["bridgesllm-ask-user"])
        self.assertEqual(len([c for c in self.host.calls() if c.startswith("plugins reload")]), 2)

    def test_plugins_pre_never_accepts_capabilities_for_an_id_outside_the_manifest(self):
        # A manifest-owned id passes; anything else raises before `plugins reload` runs (same rule as plugins-post).
        self.host.set_plugin("bridgesllm-ask-user", plugin_doc("bridgesllm-ask-user", "3.9.0"))
        manifest, _problem = toolctl.load_plugin_manifest(self.host.roots())
        worker = toolctl.PortalPlugins(self.host.roots(), {}, self.host.base + "/usr/bin/node", toolctl.run_bounded)
        with mock.patch.object(worker, "install", return_value=True):
            with mock.patch.object(worker, "reload", wraps=worker.reload) as reload:
                worker.converge(manifest, accept_capabilities=True)
        self.assertEqual(reload.call_args, mock.call(["bridgesllm-ask-user"], accept_for=[p["id"] for p in manifest]))
        with self.assertRaises(toolctl.ToolctlError):
            worker.reload(["someone-elses-plugin"], accept_for=[p["id"] for p in manifest])
        self.assertEqual(len([c for c in self.host.calls() if c.startswith("plugins reload")]), 1)

    def test_a_broken_plugin_alone_after_update_degrades_without_rollback(self):
        self.host.versioned_native()
        write(self.host.fake + "/update-2026.10.9.sh", (
            "printf '{\"id\": \"bridgesllm-ask-user\", \"version\": \"4.0.0\", \"status\": \"error\", "
            "\"error\": \"SDK mismatch\"}' > \"$FAKE/plugins/bridgesllm-ask-user.json\"\n"))
        write(self.host.fake + "/plugins-install.fail", "")
        self.host.queue(action="update")
        status = self.host.run()
        # K7: OC-PLUG-ASK failing alone leaves chat up: no rollback; Some features off with Retry checks.
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                         ("succeeded-degraded", "CONTRACT_REQUIRED_PROBE_FAILED", "retry-checks"))
        self.assertEqual(status["error"]["message"], "Chat works, but questions from agents are off: OC-PLUG-ASK failed.")
        self.assertEqual(status["result"]["contract"]["failed"], ["OC-PLUG-ASK"])
        self.assertEqual(status["result"]["to"], "2026.10.9")
        self.assertNotIn("rollback", [s["id"] for s in status["steps"]])
        self.assertEqual(len(self.host.lines("update-calls.log")), 1)
        self.assertEqual(self.host.lines("is-active"), ["active"])
        plug = toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/probes/OC-PLUG-ASK.json" % RUN_ID)
        self.assertEqual(plug["state"], "failed")

    def test_readiness_never_settles_rolls_back_then_needs_recovery(self):
        self.host.queue(action="update")
        self.host.versioned_native()
        write(self.host.fake + "/update-2026.10.9.sh", "echo 503 > \"$FAKE/readyz\"\n")
        original = self.host.http

        def readyz(url, timeout):
            if os.path.exists(self.host.fake + "/readyz"):
                return 503, None
            return original(url, timeout)

        status = self.host.run(http_get=readyz)
        # Never ready: the start fails, the rollback restores 2026.9.9, which never gets ready either.
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "ROLLBACK_START_FAILED"))
        self.assertEqual(status["error"]["nextAction"], "recover-native")
        self.assertIn("OpenClaw 2026.10.9 didn't start: OpenClaw did not become ready", status["error"]["message"])
        ready = toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/probes/gateway-start-ready.json" % RUN_ID)
        self.assertEqual(ready["state"], "failed")
        self.assertGreater(len(ready["attempts"]), 1)

    def test_plugin_state_shapes(self):
        self.assertEqual(toolctl.plugin_state(json.loads(native_fixture("plugins-inspect.loaded.json"))), ("4.0.0", True, None))
        self.assertEqual(toolctl.plugin_state({"plugin": {"version": "4.0.0", "status": "loaded", "imported": True}}),
                         ("4.0.0", True, None))
        self.assertEqual(toolctl.plugin_state({"install": {"version": "4.0.0"}, "status": "disabled"}), ("4.0.0", False, "disabled"))
        # A disabled record carries its reason as `error` (markPluginActivationDisabled): still "disabled".
        self.assertEqual(toolctl.plugin_state(plugin_doc("p", "4.0.0", status="disabled", enabled=False, error="not allowed")),
                         ("4.0.0", False, "disabled: not allowed"))
        self.assertEqual(toolctl.plugin_state(plugin_doc("p", "4.0.0", status="error", error="SDK mismatch"))[2],
                         "load error: SDK mismatch")
        self.assertEqual(toolctl.plugin_state(None), (None, False, "not installed or not inspectable"))
        self.assertFalse(toolctl.plugin_state({"version": "4.0.0", "status": "quarantined"})[1])


class StopTests(HostTestCase):
    def term_child(self, restore="0"):
        path = self.host.base + "/term-child.sh"
        write(path, TERM_CHILD, 0o755)
        log = self.host.base + "/term-child.log"
        return [path, log, restore], log

    def read_lines(self, path):
        with open(path) as handle:
            return handle.read().split()

    def supervise_with_stop(self, argv, signals=1):
        stop = toolctl.StopRequest()
        stop.install()
        self.addCleanup(stop.restore)
        ticks = []

        def tick(child):
            ticks.append(child.pid)
            if len(ticks) == 2:
                for _ in range(signals):
                    os.kill(os.getpid(), signal.SIGTERM)

        started = time.monotonic()
        code, _pid = toolctl.supervise_child(argv, {"PATH": "/usr/bin:/bin"}, self.host.base + "/out", self.host.base + "/err",
                                             stop, on_tick=tick, poll_seconds=0.05)
        return code, stop, time.monotonic() - started

    def test_sigterm_is_forwarded_once_and_the_child_is_awaited(self):
        argv, log = self.term_child(restore="0.4")
        code, stop, elapsed = self.supervise_with_stop(argv, signals=3)
        self.assertEqual(code, 143)
        self.assertEqual(self.read_lines(log), ["started", "term", "restored"])
        self.assertGreaterEqual(elapsed, 0.4)
        self.assertEqual(stop.record()["signal"], "SIGTERM")
        self.assertIs(stop.record()["forwardedToChild"], True)
        self.assertIsNone(stop.child)

    def test_stop_before_launch_is_forwarded_at_launch(self):
        argv, log = self.term_child()
        stop = toolctl.StopRequest()
        stop.signal_name, stop.requested_at = "SIGTERM", toolctl.utc_now()
        code, _pid = toolctl.supervise_child(argv, {"PATH": "/usr/bin:/bin"}, self.host.base + "/out", self.host.base + "/err",
                                             stop, poll_seconds=0.05)
        # The forward can land before the child's own handler exists; either way it was told to stop.
        self.assertIn(code, (143, -signal.SIGTERM))
        self.assertIs(stop.forwarded, True)

    def test_run_stopped_during_preflight_finishes_and_releases(self):
        self.host.queue(action="update")
        original = toolctl.Preflight.run

        def preflight_then_stop(preflight):
            report = original(preflight)
            os.kill(os.getpid(), signal.SIGTERM)
            return report

        before = signal.getsignal(signal.SIGTERM)
        with mock.patch.object(toolctl.Preflight, "run", preflight_then_stop):
            status = self.host.run()
        self.assertIs(signal.getsignal(signal.SIGTERM), before)
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_STOPPED"))
        self.assertEqual(status["stop"]["signal"], "SIGTERM")
        self.assertNotIn("update --channel", " ".join(self.host.calls()))
        self.assertIsNone(toolctl.lock_holder(self.host.roots()))
        self.assertFalse(toolctl.portal_operation_lock_busy(self.host.paths["portal_operation_lock"]))
        self.assertEqual(self.host.history()[-1]["outcome"], "failed")

    def test_interrupted_contract_phase_needs_recovery(self):
        self.host.queue()
        run = toolctl.Run(self.host.roots(), RUN_ID)
        run.init_status("openclaw")
        run.transition("contract", "verifying")
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "TOOLS_RUN_INTERRUPTED"))


class ReconcileTests(HostTestCase):
    def make_run(self, run_id, phase, state, age_seconds=0):
        self.host.queue(run_id=run_id)
        run = toolctl.Run(self.host.roots(), run_id)
        run.init_status("openclaw")
        if state != "queued":
            run.transition(phase, state)
        created = toolctl.parse_ts(run.status["createdAt"]) - age_seconds
        run.status["createdAt"] = toolctl.datetime.datetime.fromtimestamp(created, toolctl.datetime.timezone.utc) \
            .strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        run.save()

    def test_reconcile_settles_only_orphans(self):
        ids = ["%08d-0000-4000-8000-000000000000" % i for i in range(5)]
        self.make_run(ids[0], "queued", "queued", age_seconds=3600)
        self.make_run(ids[1], "queued", "queued", age_seconds=5)
        self.make_run(ids[2], "native", "running")
        self.make_run(ids[3], "preflight", "preflight")
        self.make_run(ids[4], "queued", "queued")
        toolctl.Run(self.host.roots(), ids[4]).load()
        finished = toolctl.Run(self.host.roots(), ids[4])
        finished.load()
        finished.finish("succeeded")
        settled = toolctl.cmd_reconcile(self.host.roots())
        self.assertEqual(settled, [
            {"runId": ids[0], "state": "failed"},
            {"runId": ids[2], "state": "recovery-required"},
            {"runId": ids[3], "state": "failed"},
        ])
        self.assertEqual(toolctl.Run(self.host.roots(), ids[1]).load()["state"], "queued")
        self.assertEqual(toolctl.cmd_reconcile(self.host.roots()), [])

    def test_reconcile_skips_the_live_run(self):
        self.make_run(RUN_ID, "native", "running")
        lock = toolctl.ToolsLock(self.host.roots())
        lock.acquire(RUN_ID)
        try:
            self.assertEqual(toolctl.cmd_reconcile(self.host.roots()), [])
        finally:
            lock.release()


class InterruptedNativeSettleTests(HostTestCase):
    """c.6 row 4: reconcile settles a run whose runner died in `native` from `update status --json`."""

    STARTED = "2026-10-30T22:00:00.000Z"

    def setUp(self):
        super().setUp()
        self.launched = int(toolctl.parse_ts(self.STARTED) * 1000)
        self.marker = self.host.paths["installer_state_root"] + "/openclaw-mutation-maintenance-v1.json"
        self.quiesce = self.host.paths["state_root"] + "/openclaw-diagnostics-quiesce.v1.json"

    def died_in_native(self, status_doc=None, status_exit=None, active_run_id=None, before_reconcile=None, via_host=False):
        """A run whose runner died during the native step, leaving both of its markers behind."""
        self.host.queue(action="update")
        roots = self.host.roots()
        run = toolctl.Run(roots, RUN_ID)
        run.init_status("openclaw")
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        run.write_evidence("preflight.json", report)
        run.transition("native", "running")
        run.step_start("native", "OpenClaw is updating")
        run.status["native"] = {"startedAt": self.STARTED, "phase": "activating", "phasesSeen": ["requested", "activating"]}
        if active_run_id:
            run.status["native"]["activeRunId"] = active_run_id
        run.save()
        operation = RUN_ID.replace("-", "")
        write(self.quiesce, toolctl.quiesce_marker_bytes(operation, RUN_ID, self.STARTED).decode(), 0o600)
        write(self.marker, toolctl.canonical_marker_bytes(operation, "openclaw-gateway.service", self.STARTED,
                                                          self.STARTED).decode(), 0o600)
        if status_doc is not None:
            self.host.reply("status", status_doc)
        if status_exit is not None:
            self.host.reply("status", exit_code=status_exit)
        os.unlink(self.host.fake + "/calls.log")
        if before_reconcile is not None:
            before_reconcile()
        settle = {"ready_wait_seconds": 0.5, "ready_interval_seconds": 0.05, "probe_deadline_seconds": 5,
                  "probe_sleep": lambda _s: None}
        if via_host:
            settled = toolctl.cmd_reconcile_host(roots, http_get=self.host.http, settle=settle)["settled"]
        else:
            settled = toolctl.cmd_reconcile(roots, http_get=self.host.http, settle=settle)
        return settled, toolctl.Run(roots, RUN_ID).load()

    def last_run(self, fixture, **changes):
        doc = json.loads(native_fixture(fixture))
        doc.pop("activeRun", None)
        doc["lastRun"].update({"createdAtMs": self.launched + 1000, "updatedAtMs": self.launched + 60000,
                               "finishedAtMs": self.launched + 60000}, **changes)
        return doc

    def assert_markers_cleared(self):
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))

    def test_native_still_pending_needs_recovery(self):
        settled, status = self.died_in_native(native_fixture("update-status.active.json"))
        self.assertEqual(settled, [{"runId": RUN_ID, "state": "recovery-required"}])
        self.assertEqual(status["native"]["settledBy"], "reconcile")
        self.assertEqual((status["error"]["id"], status["error"]["nextAction"]), ("NATIVE_RUN_PENDING", "recover-native"))
        self.assertIn("still active", status["error"]["message"])
        self.assertEqual([s["state"] for s in status["steps"] if s["id"] == "native"], ["failed"])
        self.assertEqual(self.host.calls(), ["update status --json"])
        self.assert_markers_cleared()

    def test_interrupted_before_activation_is_failed_with_the_native_text(self):
        settled, status = self.died_in_native(self.last_run("update-status.interrupted-before-activation.json"))
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["error"]["id"], "NATIVE_INTERRUPTED_BEFORE_ACTIVATION")
        self.assertIn("OpenClaw: interrupted", status["error"]["message"])
        self.assertIn("Nothing was changed", status["error"]["message"])
        self.assertEqual(status["error"]["nextAction"], "Inspect the update report with: openclaw update status")
        self.assertEqual(self.host.calls(), ["update status --json"])
        self.assert_markers_cleared()

    def test_completed_native_continues_with_verification_and_never_updates_again(self):
        installed = lambda: write(self.host.paths["npm_global_root"] + "/openclaw/package.json",  # noqa: E731
                                  json.dumps({"name": "openclaw", "version": "2026.10.9"}))
        settled, status = self.died_in_native(self.last_run("update-status.idle.json"), before_reconcile=installed)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(settled, [{"runId": RUN_ID, "state": "succeeded"}])
        calls = self.host.calls()
        self.assertFalse([c for c in calls if c.startswith(("update --channel", "update --dry-run", "update repair"))], calls)
        self.assertTrue([c for c in calls if c.startswith("plugins inspect")])
        self.assertTrue([c for c in calls if c.startswith("gateway call")])
        self.assertEqual([s["id"] for s in status["steps"]], ["native", "plugins-post", "contract"])
        self.assertEqual(status["steps"][0]["state"], "passed")
        self.assertEqual((status["result"]["from"], status["result"]["to"], status["result"]["reconciled"]),
                         ("2026.9.9", "2026.10.9", True))
        self.assertEqual(status["native"]["settledBy"], "reconcile")
        self.assert_markers_cleared()

    def test_the_reconcile_command_runs_the_checks_under_its_own_operation_lock(self):
        # `reconcile` (cmd_reconcile_host) holds the installer operation lock
        # itself; the settle must not try to take it a second time and report
        # the checks as skipped.
        installed = lambda: write(self.host.paths["npm_global_root"] + "/openclaw/package.json",  # noqa: E731
                                  json.dumps({"name": "openclaw", "version": "2026.10.9"}))
        settled, status = self.died_in_native(self.last_run("update-status.idle.json"), before_reconcile=installed,
                                              via_host=True)
        self.assertEqual(settled, [{"runId": RUN_ID, "state": "succeeded"}], status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["native", "plugins-post", "contract"])
        self.assertTrue([c for c in self.host.calls() if c.startswith("plugins inspect")])
        self.assert_markers_cleared()
        fd = os.open(self.host.paths["portal_operation_lock"], os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # released afterwards
        finally:
            os.close(fd)

    def test_matches_the_native_run_by_id_when_the_runner_saw_it(self):
        doc = self.last_run("update-status.idle.json")
        settled, status = self.died_in_native(doc, active_run_id="not-the-one-in-history")
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "NATIVE_RESULT_MISSING"))
        self.assertIn("doesn't show how its update ended", status["error"]["message"])

    def test_rolled_back_native_is_verified_and_stays_rolled_back(self):
        doc = self.last_run("update-status.idle.json", status="rolled-back", reason="post-update-verification-failed")
        settled, status = self.died_in_native(doc)
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "NATIVE_ROLLED_BACK"))
        self.assertTrue([c for c in self.host.calls() if c.startswith("plugins inspect")])

    def test_unknown_or_unreadable_status_keeps_recovery_required(self):
        for doc, exit_code, why in ((None, 1, "couldn't be read"),
                                    (self.last_run("update-status.idle.json", createdAtMs=self.launched - 5000,
                                                   updatedAtMs=self.launched - 4000, finishedAtMs=self.launched - 4000),
                                     None, "doesn't show how")):
            with self.subTest(why=why):
                self.host = Host()
                self.addCleanup(self.host.cleanup)
                self.marker = self.host.paths["installer_state_root"] + "/openclaw-mutation-maintenance-v1.json"
                self.quiesce = self.host.paths["state_root"] + "/openclaw-diagnostics-quiesce.v1.json"
                settled, status = self.died_in_native(doc, status_exit=exit_code)
                self.assertEqual(status["state"], "recovery-required")
                self.assertIn(why, status["error"]["message"])
                self.assertFalse([c for c in self.host.calls() if not c.startswith("update status")])
                self.assert_markers_cleared()

    def test_failed_after_activation_needs_recovery(self):
        doc = self.last_run("update-status.idle.json", status="failed", reason="restart-health-failed")
        settled, status = self.died_in_native(doc)
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "NATIVE_FAILED_AFTER_ACTIVATION"))

    def test_busy_locks_settle_without_checks(self):
        lock = toolctl.PortalOperationLock(self.host.paths["portal_operation_lock"])
        self.addCleanup(lock.release)
        settled, status = self.died_in_native(self.last_run("update-status.idle.json"), before_reconcile=lock.acquire)
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                         ("succeeded-degraded", "TOOLS_RUN_INTERRUPTED_BEFORE_CHECKS", "retry-checks"))
        self.assertFalse([c for c in self.host.calls() if not c.startswith("update status")])
        self.assert_markers_cleared()

    def test_a_restarted_runner_settles_the_same_way(self):
        self.host.reply("status", self.last_run("update-status.interrupted-before-activation.json"))
        self.host.queue(action="update")
        run = toolctl.Run(self.host.roots(), RUN_ID)
        run.init_status("openclaw")
        run.write_evidence("preflight.json", self.host.preflight())
        run.transition("native", "running")
        run.status["native"] = {"startedAt": self.STARTED, "phase": "validating"}
        run.save()
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "NATIVE_INTERRUPTED_BEFORE_ACTIVATION"))
        self.assertNotIn("update --channel", " ".join(self.host.calls()))

    def test_an_interrupted_run_reports_the_plugins_installed_before_it(self):
        """N4: the reconcile message names what plugins-pre installed instead of "Nothing was changed"."""
        self.host.reply("status", self.last_run("update-status.interrupted-before-activation.json"))
        self.host.queue(action="update")
        run = toolctl.Run(self.host.roots(), RUN_ID)
        run.init_status("openclaw")
        run.write_evidence("preflight.json", self.host.preflight())
        run.status["pluginsPre"] = {"installed": ["bridgesllm-shared-browser 1.0.0"], "reload": "reloaded"}
        run.transition("native", "running")
        run.status["native"] = {"startedAt": self.STARTED, "phase": "validating"}
        run.save()
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "NATIVE_INTERRUPTED_BEFORE_ACTIVATION"))
        self.assertNotIn("Nothing was changed", status["error"]["message"])
        self.assertIn("OpenClaw itself was not changed, but the Portal had already installed its plugin "
                      "bridgesllm-shared-browser 1.0.0 into it; it stays installed; try again.", status["error"]["message"])


class DurabilityTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="toolctl-durable-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_atomic_write_survives_a_failed_rename(self):
        path = os.path.join(self.dir, "status.json")
        toolctl.atomic_write_json(path, {"state": "queued"})
        with mock.patch.object(toolctl.os, "replace", side_effect=OSError("crash")):
            with self.assertRaises(OSError):
                toolctl.atomic_write_json(path, {"state": "preflight"})
        self.assertEqual(toolctl.read_json_file(path), {"state": "queued"})
        self.assertEqual(os.listdir(self.dir), ["status.json"])
        self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o600)

    def test_read_json_refuses_symlinks(self):
        target = os.path.join(self.dir, "real.json")
        toolctl.atomic_write_json(target, {})
        os.symlink(target, os.path.join(self.dir, "link.json"))
        with self.assertRaises(toolctl.ToolctlError):
            toolctl.read_json_file(os.path.join(self.dir, "link.json"))

    def test_private_dir_refuses_symlink_and_tightens_mode(self):
        loose = os.path.join(self.dir, "loose")
        os.mkdir(loose, 0o755)
        os.chmod(loose, 0o755)
        toolctl.ensure_private_dir(loose)
        self.assertEqual(stat.S_IMODE(os.lstat(loose).st_mode), 0o700)
        os.symlink(loose, os.path.join(self.dir, "link"))
        with self.assertRaises(toolctl.ToolctlError):
            toolctl.ensure_private_dir(os.path.join(self.dir, "link"))

    def test_history_rotation_keeps_last_runs(self):
        roots = mock.Mock(state_root=self.dir, history_path=os.path.join(self.dir, "history.jsonl"))
        for i in range(30):
            toolctl.append_history(roots, {"runId": "r%02d" % i, "pad": "x" * 100}, rotate_bytes=2000, keep=5)
        with open(roots.history_path) as handle:
            ids = [json.loads(line)["runId"] for line in handle]
        self.assertLessEqual(len(ids), 15)
        self.assertEqual(ids[-1], "r29")
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(stat.S_IMODE(os.lstat(roots.history_path).st_mode), 0o600)


class RedactionTests(unittest.TestCase):
    def test_text_patterns(self):
        cases = {
            "OPENCLAW_GATEWAY_TOKEN=abc123def": "OPENCLAW_GATEWAY_TOKEN=<redacted>",
            "npm error at https://user:pa55word@registry.example/x": "npm error at https://<redacted>@registry.example/x",
            "Authorization: Bearer abcdefghijkl": "Authorization: <redacted>",
            "password: hunter2hunter2": "password: <redacted>",
            "token npm_abcdefghijklmnopqrstuvwxyz0123 used": "token <redacted> used",
            "key sk-ant-abcdefghijklmnopqrstu end": "key <redacted> end",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(toolctl.redact_text(raw), expected)

    def test_structured_keys(self):
        value = toolctl.redact({"env": {"HOME": "/root", "OPENCLAW_GATEWAY_TOKEN": "x", "ANTHROPIC_API_KEY": "y",
                                        "OPENCLAW_STATE_DIR": "/root/.openclaw"}, "ok": True})
        self.assertEqual(value, {"env": {"HOME": "/root", "OPENCLAW_GATEWAY_TOKEN": "<redacted>",
                                         "ANTHROPIC_API_KEY": "<redacted>", "OPENCLAW_STATE_DIR": "/root/.openclaw"},
                                 "ok": True})


class NativeCommandTests(unittest.TestCase):
    def setUp(self):
        self.roots = mock.Mock(openclaw_bin="/usr/bin/openclaw", tmp_dir="/var/lib/bridgesllm/tools/tmp")
        self.service_env = {"HOME": "/root", "OPENCLAW_PROFILE": "main", "OPENCLAW_STATE_DIR": "/root/.openclaw",
                            "NODE_OPTIONS": "--inspect", "PATH": "/evil", "CI": "1"}

    def test_stable_with_tag(self):
        with mock.patch.dict(os.environ, {"CANARY_ENV": "leak", "CI": "1"}):
            argv, env = toolctl.build_native_update_command("stable", "2026.10.9", self.service_env, RUN_ID, self.roots)
        self.assertEqual(argv, ["/usr/bin/openclaw", "update", "--channel", "stable", "--tag", "2026.10.9", "--yes", "--json",
                                "--no-restart"])
        self.assertEqual(env, {
            "HOME": "/root",
            "OPENCLAW_PROFILE": "main",
            "OPENCLAW_STATE_DIR": "/root/.openclaw",
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG": "C.UTF-8",
            "NPM_CONFIG_PREFIX": "/usr",
            "TMPDIR": "/var/lib/bridgesllm/tools/tmp/" + RUN_ID,
            "NO_COLOR": "1",
        })

    def test_channel_heads_have_no_tag(self):
        for channel in ("stable", "extended-stable"):
            argv, _env = toolctl.build_native_update_command(channel, None, {}, RUN_ID, self.roots)
            self.assertEqual(argv, ["/usr/bin/openclaw", "update", "--channel", channel, "--yes", "--json", "--no-restart"])
            for flag in ("--timeout", "--accept-capabilities", "--tag"):
                self.assertNotIn(flag, argv)
        _argv, env = toolctl.build_native_update_command("stable", None, {}, RUN_ID, self.roots)
        self.assertEqual(env["HOME"], "/root")

    def test_node_pinned_form(self):
        argv, env = toolctl.build_native_update_command("stable", None, self.service_env, RUN_ID, self.roots,
                                                        node_path="/usr/bin/node")
        self.assertEqual(argv, ["/usr/bin/node", "/usr/bin/openclaw", "update", "--channel", "stable", "--yes", "--json",
                                "--no-restart"])
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertEqual(env["PATH"], toolctl.CLEAN_PATH)

    def test_rejections(self):
        cases = [("extended-stable", "2026.9.36", RUN_ID), ("beta", None, RUN_ID), ("stable", "latest", RUN_ID),
                 ("stable", "v2026.10.9", RUN_ID), ("stable", "2026.10.9 --timeout 5", RUN_ID), ("stable", None, "x"),
                 ("stable", None, RUN_ID + "\n"), ("stable", "2026.10.9\n", RUN_ID)]
        for channel, tag, run_id in cases:
            with self.subTest(channel=channel, tag=tag), self.assertRaises(toolctl.ToolctlError):
                toolctl.build_native_update_command(channel, tag, {}, run_id, self.roots)

    def test_systemctl_show_parser(self):
        text = ("Environment=HOME=/root OPENCLAW_PROFILE=main \"OPENCLAW_LABEL=two words\"\n"
                "User=root\nWorkingDirectory=/root/.openclaw\n"
                "ExecStart={ path=/usr/bin/openclaw ; argv[]=/usr/bin/openclaw gateway --port 18789 ; ignore_errors=no ; "
                "start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n")
        parsed = toolctl.parse_systemctl_show(text)
        self.assertEqual(parsed["Environment"], {"HOME": "/root", "OPENCLAW_PROFILE": "main", "OPENCLAW_LABEL": "two words"})
        self.assertEqual(parsed["User"], "root")
        self.assertEqual(parsed["ExecStart"], "/usr/bin/openclaw gateway --port 18789")
        self.assertEqual(toolctl.exec_start_argv0(parsed["ExecStart"]), "/usr/bin/openclaw")


class CliTests(HostTestCase):
    def cli(self, *args):
        argv = [sys.executable, "-I", TOOLCTL_PATH]
        for name, value in self.host.paths.items():
            argv += ["--" + name.replace("_", "-"), ":".join(value) if isinstance(value, list) else value]
        completed = subprocess.run(argv + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
                                   env={"PATH": "/usr/bin:/bin"})
        return completed.returncode, completed.stdout.decode(), completed.stderr.decode()

    def test_status_and_validate_policy(self):
        code, out, err = self.cli("status")
        self.assertEqual(code, 0, err)
        status = json.loads(out)
        self.assertEqual(status["schema"], "bridgesllm.toolctl.status.v1")
        self.assertTrue(status["policy"]["valid"])
        self.assertEqual(status["legacy"]["open"], [])
        code, out, _ = self.cli("validate-policy")
        self.assertEqual((code, json.loads(out)["valid"]), (0, True))

    def test_preflight_exit_codes(self):
        # The real statvfs is used here: only check refusals that do not depend on free space.
        write(self.host.paths["gateway_fence_permit"], "{}")
        code, out, _ = self.cli("preflight", "openclaw", "--target-metadata", self.host.meta_path)
        self.assertEqual(code, 2)
        self.assertIn("PF2_LEGACY_TRANSACTION_OPEN", [r["id"] for r in json.loads(out)["refusals"]])

    def test_rejects_relative_roots(self):
        code, _out, err = self.cli("--state-root", "relative/path", "status")
        self.assertEqual(code, 1)
        self.assertIn("canonical absolute path", err)


class Json5ConfigTests(HostTestCase):
    """PF-8 when openclaw.json isn't plain JSON: OpenClaw's own `config get agents --json` reads it."""

    def setUp(self):
        super().setUp()
        self.oc = self.host.paths["openclaw_state_dir"]
        write(self.oc + "/openclaw.json", "{\n  // JSON5: comments and trailing commas\n  agents: { entries: {}, },\n}\n")

    def test_native_read_finds_configured_agent_stores(self):
        elsewhere = self.host.base + "/srv/agents/research"
        write(elsewhere + "/openclaw-agent.sqlite", "r" * 50000)
        self.host.reply("config-get", {"entries": {"research": {"agentDir": elsewhere, "apiKey": "__OPENCLAW_REDACTED__"}}})
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        self.assertIn("config get agents --json", self.host.calls())
        self.assertEqual(report["facts"]["disk"]["configuredStores"],
                         [{"agent": "research", "base": elsewhere + "/openclaw-agent.sqlite"}])
        self.assertEqual(report["facts"]["configRead"]["via"], "openclaw config get agents --json")

    def test_unset_agents_add_no_stores(self):
        self.host.reply("config-get", {"ok": False, "error": {"type": "cli_error",
                                                              "message": "Config path is valid but unset: agents."}}, exit_code=1)
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        self.assertEqual(report["facts"]["disk"]["configuredStores"], [])

    def test_refuses_only_when_the_native_read_fails_too(self):
        self.host.reply("config-get", {"ok": False, "error": {"type": "cli_error", "message": "Invalid config."}}, exit_code=1)
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF8_CONFIG_UNREADABLE"])
        self.assertEqual(report["refusals"][0]["detail"]["nativeRead"], "Invalid config.")

    def test_no_native_read_on_a_host_that_is_already_refused(self):
        write(self.host.paths["gateway_fence_permit"], "{}")
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF2_LEGACY_TRANSACTION_OPEN"])
        self.assertNotIn("config get agents --json", self.host.calls())
        self.assertIn(("PF-8-config", "skipped"), [(c["id"], c["state"]) for c in report["checks"]])


class ContractProbeTests(HostTestCase):
    """C4: OC-HELLO, OC-CONFIG and OC-PLUG-ASK through the CLI's gateway-call path (fakes only)."""

    def checks(self):
        self.host.queue(action="retry-checks", target=None)
        return self.host.run()

    def probe(self, probe_id):
        return toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/probes/%s.json" % (RUN_ID, probe_id))

    def test_required_probes_pass_and_keep_no_config_values(self):
        status = self.checks()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        contract = status["result"]["contract"]
        self.assertEqual(contract["passed"], ["OC-READY", "OC-HELLO", "OC-CONFIG", "OC-PLUG-ASK"])
        self.assertEqual(contract["failed"], [])
        self.assertEqual(contract["notRun"], toolctl.policy_tool(self.host.policy(), "openclaw")["probes"]["optional"])
        calls = self.host.calls()
        self.assertIn("gateway call config.get --params {} --json --timeout 60000", calls)
        self.assertIn("gateway call bridgesllm.ask_user.steer --params {} --json --timeout 60000", calls)
        config = self.probe("OC-CONFIG")
        self.assertEqual(config["attempts"][0]["configKeys"], ["gateway", "plugins"])
        with open(self.host.paths["state_root"] + "/runs/%s/probes/OC-CONFIG.json" % RUN_ID) as handle:
            self.assertNotIn(FAKE_SECRET, handle.read())
        hello = self.probe("OC-HELLO")
        self.assertEqual((hello["attempts"][0]["serverVersion"], hello["methods"]["state"]), ("2026.9.9", "not-run"))

    def big_config_reply(self, size):
        """A config.get reply shaped like 10.9's (337,845 B): copies of the config beside `config`."""
        write(self.host.fake + "/config-get.big", json.dumps({
            "path": "/x/openclaw.json", "exists": True, "valid": True, "hash": "h1",
            "config": {"gateway": {}, "plugins": {}}, "parsed": {"agents": "x" * size}}))

    def test_a_config_reply_past_64_kib_passes_oc_config(self):
        self.big_config_reply(340 * 1024)
        status = self.checks()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertIn("OC-CONFIG", status["result"]["contract"]["passed"])
        self.assertEqual(self.probe("OC-CONFIG")["attempts"][0]["configKeys"], ["gateway", "plugins"])

    def test_a_config_reply_past_its_ceiling_is_unproven_with_the_named_reason(self):
        self.big_config_reply(200 * 1024)
        with mock.patch.object(toolctl, "CONFIG_GET_REPLY_LIMIT_BYTES", 128 * 1024):
            status = self.checks()
        reason = "config.get's reply exceeded 131072 bytes, so the Portal couldn't read the answer"
        self.assertEqual((status["state"], status["error"]["id"]), ("succeeded-degraded", "CONTRACT_REQUIRED_PROBE_UNPROVEN"))
        self.assertEqual(status["error"]["message"], "OpenClaw is running, but OC-CONFIG is unproven: %s." % reason)
        contract = status["result"]["contract"]
        self.assertEqual((contract["failed"], contract["unproven"]), ([], ["OC-CONFIG"]))
        self.assertNotIn("OC-CONFIG", contract["passed"] + contract["notRun"])
        record = self.probe("OC-CONFIG")
        self.assertEqual((record["state"], record["reason"]), ("unproven", reason))
        self.assertEqual(len(record["attempts"]), 1)  # a reply past its ceiling isn't retried
        self.assertEqual((record["attempts"][0]["configKeys"], record["attempts"][0]["replyExceededBytes"]), (None, 131072))
        self.assertIn("unproven", [s["state"] for s in status["steps"]])

    def test_run_bounded_marks_a_reply_cut_at_its_ceiling(self):
        code, out, _err = toolctl.run_bounded(["/bin/sh", "-c", "head -c 70000 /dev/zero"], limit=65536)
        self.assertEqual((code, len(out), toolctl.reply_exceeded(out)), (0, 65536, 65536))
        code, out, _err = toolctl.run_bounded(["/bin/sh", "-c", "head -c 70000 /dev/zero"], limit=70000)
        self.assertEqual((len(out), toolctl.reply_exceeded(out)), (70000, None))

    def test_a_failing_required_probe_degrades_with_its_name(self):
        cases = [
            ("OC-HELLO", lambda: self.host.reply("gateway-rpc", json.dumps(
                {"rpc": {"ok": True, "server": {"version": "2026.8.30"}, "version": "2026.8.30"}}))),  # below the floor
            ("OC-CONFIG", lambda: write(self.host.fake + "/config-get.exit", "1")),
            ("OC-PLUG-ASK", lambda: write(self.host.fake + "/steer-unknown", "")),
        ]
        for probe_id, damage in cases:
            with self.subTest(probe_id):
                self.host = Host()
                self.addCleanup(self.host.cleanup)
                damage()
                status = self.checks()
                self.assertEqual((status["state"], status["error"]["id"]), ("succeeded-degraded", "CONTRACT_REQUIRED_PROBE_FAILED"))
                self.assertEqual(status["error"]["message"], (
                    "Chat works, but questions from agents are off: OC-PLUG-ASK failed." if probe_id == "OC-PLUG-ASK"
                    else "Chat is unavailable: %s failed." % probe_id))
                record = self.probe(probe_id)
                self.assertEqual(record["state"], "failed")
                self.assertEqual(len(record["attempts"]), toolctl.PROBE_ATTEMPTS)  # retried within the deadline

    def test_no_rpc_probe_fails_while_the_gateway_is_not_ready(self):
        self.host.http.status = 503
        status = self.checks()
        self.assertEqual(status["error"]["message"], "Chat is unavailable: OC-READY failed.")
        self.assertEqual(status["result"]["contract"]["failed"], ["OC-READY"])
        for probe_id in ("OC-HELLO", "OC-CONFIG", "OC-PLUG-ASK"):
            self.assertEqual(self.probe(probe_id)["state"], "not-run")
        self.assertFalse([c for c in self.host.calls() if c.startswith("gateway call")])

    def test_retry_rule_stops_when_a_full_attempt_no_longer_fits(self):
        clock = [0.0]
        with mock.patch.object(toolctl.time, "monotonic", side_effect=lambda: clock[0]):
            def attempt():
                clock[0] += 4.0  # each failing attempt takes 4 s
                return False, {}
            passed, records = toolctl.probe_attempts(attempt, deadline_seconds=9, backoff=0, sleep=lambda _s: None)
        self.assertFalse(passed)
        self.assertEqual(len(records), 2)  # a third 4 s attempt would end after the 9 s deadline


class HelloMethodsTests(HostTestCase):
    """OC-HELLO methods half: one required/optional list; a missing required method degrades naming it."""

    ALL = list(toolctl.OPENCLAW_REQUIRED_METHODS) + [m for _f, ms in toolctl.OPENCLAW_OPTIONAL_METHODS for m in ms]

    def test_required_list_is_design_b4_and_optional_features_cover_the_backend_gates(self):
        # DESIGN b.4, OC-HELLO row.
        self.assertEqual(toolctl.OPENCLAW_REQUIRED_METHODS, (
            "chat.send", "chat.history", "chat.abort", "sessions.list", "sessions.create", "sessions.patch",
            "sessions.describe", "sessions.delete", "config.get", "config.patch", "agents.list", "models.list"))
        with open(os.path.join(TOOLS_DIR, "..", "..", "backend", "src", "services", "openClawCompatibility.ts")) as handle:
            source = handle.read()
        optional = {m for _f, ms in toolctl.OPENCLAW_OPTIONAL_METHODS for m in ms}
        for method in ("sessions.goal.update", "sessions.goal.clear", "progressCard.get", "canvas.document.view"):
            self.assertIn("'%s'" % method, source)
            self.assertIn(method, optional)

    def test_verdict(self):
        self.assertEqual(toolctl.hello_methods_verdict(self.ALL), {"state": "passed", "missing": [], "featuresOff": {},
                                                                   "offered": len(self.ALL)})
        partial = [m for m in self.ALL if m not in ("chat.send", "canvas.document.view", "sessions.steer")]
        verdict = toolctl.hello_methods_verdict(partial)
        self.assertEqual((verdict["state"], verdict["missing"]), ("failed", ["chat.send"]))
        self.assertEqual(verdict["featuresOff"], {"inline widgets": ["canvas.document.view"], "steering": ["sessions.steer"]})
        self.assertEqual(toolctl.hello_methods_verdict([])["state"], "failed")
        self.assertEqual(toolctl.hello_methods_verdict("chat.send")["missing"], list(toolctl.OPENCLAW_REQUIRED_METHODS))

    def hello(self, methods):
        return toolctl.probe_hello(self.host.roots(), {}, self.host.base + "/usr/bin/node", toolctl.run_bounded, "2026.9.9", 5,
                                   sleep=lambda _s: None, hello_methods=None if methods is None else (lambda: methods))

    def test_probe_hello_with_and_without_a_method_list(self):
        record = self.hello(None)
        self.assertEqual((record["state"], record["methods"]["state"]), ("passed", "not-run"))
        self.assertIn("isn't checked in this build", record["methods"]["reason"])
        record = self.hello([m for m in self.ALL if m != "tools.catalog"])
        self.assertEqual((record["state"], record["methods"]["featuresOff"]), ("passed", {"tool catalog": ["tools.catalog"]}))
        record = self.hello([m for m in self.ALL if m not in ("chat.history", "models.list")])
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["reason"], "OpenClaw doesn't offer chat.history, models.list")

    def test_a_missing_required_method_degrades_naming_it_and_optional_ones_show_as_off(self):
        contract = {"passed": ["OC-READY"], "failed": ["OC-HELLO"], "notRun": [], "missingMethods": ["chat.send"],
                    "featuresOff": {"goals": ["sessions.goal.update"]}}
        state, error = toolctl.contract_outcome("succeeded", None, contract, [])
        self.assertEqual((state, error["id"]), ("succeeded-degraded", "CONTRACT_REQUIRED_PROBE_FAILED"))
        self.assertEqual(error["message"], "Chat is unavailable: OpenClaw doesn't offer chat.send.")
        self.assertEqual(toolctl.contract_step_detail(contract),
                         "Failed: OC-HELLO. Off: goals (sessions.goal.update not offered).")
        contract = dict(contract, failed=[], missingMethods=[])
        self.assertEqual(toolctl.contract_outcome("succeeded", None, contract, []), ("succeeded", None))


class HelloSnapshotTests(HostTestCase):
    """OC-HELLO methods source: the backend's hello snapshot counts only when safe, fresh and from the installed version."""

    ALL = HelloMethodsTests.ALL
    OPENED = "2026-01-01T00:00:00.000Z"

    def setUp(self):
        super().setUp()
        self.path = self.host.paths["openclaw_hello_snapshot"]
        os.chmod(os.path.dirname(self.path), 0o755)

    def snapshot(self, version="2026.9.9", methods=None, received=None, mode=0o600, raw=None):
        doc = {"schema": "bridgesllm.openclaw-hello.v1", "serverVersion": version,
               "methods": self.ALL if methods is None else methods, "events": ["chat", "agent"],
               "receivedAt": received or toolctl.utc_now()}
        with open(self.path + ".tmp", "wb") as handle:
            handle.write(raw if raw is not None else (json.dumps(doc) + "\n").encode())
        os.chmod(self.path + ".tmp", mode)
        os.replace(self.path + ".tmp", self.path)

    def read(self, installed="2026.9.9", not_before=None):
        return toolctl.read_hello_snapshot(self.path, installed, not_before, "this run's restart window opened")

    def test_fresh_absent_stale_and_wrong_version(self):
        self.assertEqual(self.read()["state"], "absent")
        self.snapshot(received="2026-10-31T06:10:00.000Z")
        fresh = self.read(not_before=toolctl.parse_ts("2026-10-31T06:09:59.999Z"))
        self.assertEqual((fresh["state"], fresh["serverVersion"], fresh["methods"]), ("fresh", "2026.9.9", self.ALL))
        stale = self.read(not_before=toolctl.parse_ts("2026-10-31T06:10:00.000Z"))  # must be strictly after
        self.assertEqual(stale["state"], "stale")
        self.assertNotIn("methods", stale)
        self.assertEqual(stale["reason"], "The Portal backend hasn't reconnected to OpenClaw since this run's restart window "
                                          "opened, so OpenClaw's method list wasn't checked.")
        wrong = self.read(installed="2026.10.9")
        self.assertEqual(wrong["state"], "wrong-version")
        self.assertIn("came from OpenClaw 2026.9.9, not the installed 2026.10.9", wrong["reason"])
        self.assertEqual(self.read(installed=None)["state"], "wrong-version")
        self.assertEqual(self.read(not_before=None)["state"], "fresh")  # a run without a restart: version only

    def test_malformed_and_oversize(self):
        good = {"schema": "bridgesllm.openclaw-hello.v1", "serverVersion": "2026.9.9", "methods": [], "events": [],
                "receivedAt": "2026-10-31T06:10:00.000Z"}
        for raw in (b"{", b"[]", b"\xff\xfe", json.dumps(dict(good, schema="other")).encode(),
                    json.dumps(dict(good, receivedAt="yesterday")).encode(), json.dumps(dict(good, methods=["ok", 7])).encode(),
                    json.dumps(dict(good, events=None)).encode(), json.dumps(dict(good, serverVersion=None)).encode()):
            with self.subTest(raw=raw[:60]):
                self.snapshot(raw=raw)
                self.assertEqual(self.read()["state"], "malformed")
        self.snapshot(raw=json.dumps(good).encode())
        self.assertEqual(self.read()["state"], "fresh")
        self.snapshot(raw=json.dumps(dict(good, methods=["x" * 100] * 3000)).encode())
        oversize = self.read()
        self.assertEqual(oversize["state"], "oversize")
        self.assertIn("larger than 262144 bytes", oversize["reason"])

    def test_unsafe_files_and_directories_are_never_used(self):
        self.snapshot(mode=0o644)
        self.assertEqual(self.read()["state"], "unsafe")
        self.snapshot(mode=0o640)
        self.assertIn("isn't a private root-owned file", self.read()["reason"])
        self.snapshot()
        os.link(self.path, self.path + ".second")
        self.assertEqual(self.read()["state"], "unsafe")
        os.unlink(self.path + ".second")
        if os.geteuid() == 0:
            os.chown(self.path, 12345, -1)
            self.assertIn("isn't a private root-owned file", self.read()["reason"])
        self.snapshot()
        elsewhere = os.path.join(os.path.dirname(self.path), "elsewhere.json")
        os.replace(self.path, elsewhere)
        os.symlink(elsewhere, self.path)
        symlink = self.read()
        self.assertEqual(symlink["state"], "unsafe")
        self.assertIn("is a symlink", symlink["reason"])
        os.unlink(self.path)
        os.mkfifo(self.path, 0o600)  # opened non-blocking: no hang
        self.assertIn("isn't a regular file", self.read()["reason"])
        os.unlink(self.path)
        self.snapshot()
        os.chmod(os.path.dirname(self.path), 0o775)
        self.assertIn("isn't a root-owned directory", self.read()["reason"])
        os.chmod(os.path.dirname(self.path), 0o755)
        with mock.patch.object(toolctl.os, "geteuid", return_value=os.geteuid() + 1):
            self.assertEqual(self.read()["state"], "unsafe")
        self.assertEqual(self.read()["state"], "fresh")

    def test_anchor_is_the_restart_window_else_the_end_of_native(self):
        self.assertEqual(toolctl.hello_snapshot_anchor({}), (None, None))
        status = {"native": {"endedAt": "2026-10-31T06:00:00.000Z"}}
        self.assertEqual(toolctl.hello_snapshot_anchor(status),
                         (toolctl.parse_ts("2026-10-31T06:00:00.000Z"), "OpenClaw's update step finished"))
        status["maintenanceMarker"] = {"publishedAt": "2026-10-31T05:58:00.100Z"}  # plugins-post's restart, or a repair
        self.assertEqual(toolctl.hello_snapshot_anchor(status)[0], toolctl.parse_ts("2026-10-31T05:58:00.100Z"))
        status["native"]["chatPause"] = {"at": "2026-10-31T05:58:00.000Z", "reason": "OpenClaw is activating"}
        self.assertEqual(toolctl.hello_snapshot_anchor(status),
                         (toolctl.parse_ts("2026-10-31T05:58:00.000Z"), "this run's restart window opened"))

    def test_the_reader_polls_until_the_backend_reconnects_within_the_deadline(self):
        run = mock.Mock(status={"maintenanceMarker": {"publishedAt": self.OPENED}})
        self.snapshot(received="2025-12-31T23:59:59.000Z")  # before the window: stale
        slept = []

        def sleep(seconds):
            slept.append(seconds)
            if len(slept) == 2:
                self.snapshot()  # the backend reconnected
        seen = toolctl.hello_snapshot_reader(self.host.roots(), run, 10, sleep=sleep)()
        self.assertEqual((seen["state"], seen["polls"], slept), ("fresh", 2, [2, 2]))
        self.assertEqual(seen["anchor"], "this run's restart window opened")
        os.unlink(self.path)
        seen = toolctl.hello_snapshot_reader(self.host.roots(), run, 5, sleep=lambda _s: None)()
        self.assertEqual((seen["state"], seen["polls"]), ("absent", 2))  # 5 s deadline, 2 s polls
        stop = mock.Mock(__bool__=lambda _self: True)
        self.assertEqual(toolctl.hello_snapshot_reader(self.host.roots(), run, 60, sleep=lambda _s: None, stop=stop)()["polls"], 0)

    def test_probe_hello_reports_the_snapshot_verdict_and_never_passes_a_stale_one(self):
        def hello(found, gateway_ok=True):
            if not gateway_ok:
                self.host.reply("gateway-rpc", json.dumps({"rpc": {"ok": True, "server": {"version": "2026.9.1"}}}))
            return toolctl.probe_hello(self.host.roots(), {}, self.host.base + "/usr/bin/node", toolctl.run_bounded, "2026.9.9",
                                       5, sleep=lambda _s: None, hello_methods=lambda: found)
        stale = {"path": self.path, "state": "stale", "reason": "The Portal backend hasn't reconnected …", "anchor": "x"}
        record = hello(stale)
        self.assertEqual((record["state"], record["methods"]["state"]), ("passed", "not-run"))
        self.assertEqual(record["methods"]["reason"], "The Portal backend hasn't reconnected …")
        self.assertEqual(record["methods"]["source"], {"path": self.path, "state": "stale", "anchor": "x"})
        fresh = {"path": self.path, "state": "fresh", "reason": None, "methods": [m for m in self.ALL if m != "chat.abort"]}
        record = hello(fresh)
        self.assertEqual((record["state"], record["reason"]), ("failed", "OpenClaw doesn't offer chat.abort"))
        record = hello(dict(fresh, methods=self.ALL), gateway_ok=False)  # a failed hello: the list isn't read
        self.assertEqual((record["state"], record["methods"]["state"]), ("failed", "not-run"))

    def checks(self):
        self.host.queue(action="retry-checks", target=None)
        return self.host.run()

    def test_retry_checks_use_a_snapshot_from_the_installed_version(self):
        self.snapshot(methods=[m for m in self.ALL if m != "sessions.steer"])
        status = self.checks()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        contract = status["result"]["contract"]
        self.assertEqual((contract["methods"], contract["featuresOff"]), ({"state": "passed"}, {"steering": ["sessions.steer"]}))
        self.assertNotIn("method list", status["steps"][-1]["detail"])

    def test_retry_checks_degrade_naming_a_missing_required_method(self):
        self.snapshot(methods=[m for m in self.ALL if m != "chat.send"])
        status = self.checks()
        self.assertEqual((status["state"], status["error"]["id"]), ("succeeded-degraded", "CONTRACT_REQUIRED_PROBE_FAILED"))
        self.assertEqual(status["error"]["message"], "Chat is unavailable: OpenClaw doesn't offer chat.send.")
        self.assertEqual(status["error"]["detail"]["missingMethods"], ["chat.send"])

    def test_an_update_counts_only_a_hello_received_after_native_from_the_new_version(self):
        self.snapshot(version="2026.10.9", received="2025-12-31T23:59:59.000Z")  # before the run
        self.host.queue(action="update")
        self.host.native_update_installs()
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["contract"]["methods"]["state"], "not-run")
        self.assertIn("hasn't reconnected to OpenClaw since the OpenClaw gateway started again", status["steps"][-1]["detail"])
        hello = toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/probes/OC-HELLO.json" % RUN_ID)
        self.assertEqual(hello["methods"]["source"]["state"], "stale")

    def test_an_update_reads_the_hello_the_backend_records_after_native(self):
        self.snapshot(version="2026.9.9")  # the old gateway's hello, recorded before the run
        progress = {"progress_seconds": 0, "poll_seconds": 0.05, "ready_wait_seconds": 0.5, "ready_interval_seconds": 0.05,
                    "probe_deadline_seconds": 5, "probe_sleep": lambda _s: self.snapshot(version="2026.10.9")}
        self.host.queue(action="update")
        self.host.native_update_installs()
        status = self.host.run(progress=progress)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["contract"]["methods"], {"state": "passed"})
        hello = toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/probes/OC-HELLO.json" % RUN_ID)
        self.assertEqual((hello["methods"]["source"]["serverVersion"], hello["methods"]["source"]["polls"]), ("2026.10.9", 1))


class RecoveryActionTests(HostTestCase):
    """c.6 recover-native and retry-checks: same locks and fences as update; never another update."""

    def repair(self, stdout=None, exit_code=0, status=None):
        if status is not None:
            self.host.reply("status", status)
        self.host.reply("repair", stdout if stdout is not None else False, exit_code=exit_code)
        self.host.queue(action="recover-native", target=None)
        return self.host.run()

    def test_recover_native_repairs_then_verifies_and_never_updates(self):
        status = self.repair(native_fixture("update-repair.ok.json"))
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        calls = self.host.calls()
        self.assertIn("update repair --yes --no-restart --json", calls)
        self.assertFalse([c for c in calls if c.startswith(("update --channel", "update --dry-run", "plugins install"))])
        self.assertEqual([s["id"] for s in status["steps"]],
                         ["preflight", "gateway-stop", "native", "gateway-start", "plugins-post", "contract"])
        # The repair ran with the gateway stopped, and the unit was started again after it.
        with open(self.host.fake + "/systemctl.log") as handle:
            verbs = [line.split()[0] for line in handle.read().splitlines() if line.split()[0] in ("stop", "start")]
        self.assertEqual(verbs, ["stop", "start"])
        self.assertEqual((status["result"]["action"], status["result"]["native"]["status"]), ("recover-native", "ok"))
        run_dir = self.host.paths["state_root"] + "/runs/" + RUN_ID
        self.assertTrue(os.path.exists(run_dir + "/probes/OC-READY.json"))
        self.assertEqual(toolctl.read_json_file(run_dir + "/native-repair-result.json")["mode"], "repair")
        self.assertIsNotNone(status["maintenanceMarker"]["clearedAt"])
        self.assertFalse(os.path.exists(self.host.paths["installer_state_root"] + "/openclaw-mutation-maintenance-v1.json"))

    def test_recover_native_outcomes_stay_recovery_required_unless_confirmed(self):
        pending = {"lastRun": {"runId": "r9", "status": "failed", "phase": "finished", "reason": "update-recovery-pending"}}
        cases = [
            (dict(stdout={"status": "warning", "mode": "finalize", "nextAction": "Stop the Gateway, then rerun repair."}),
             "RECOVERY_INCOMPLETE"),
            (dict(stdout={"ok": False, "error": {"type": "cli_error", "message": "An update is still in progress."}}, exit_code=1),
             "RECOVERY_FAILED"),
            (dict(stdout=native_fixture("update-repair.ok.json"), status=pending), "RECOVERY_STILL_PENDING"),
            (dict(stdout="not json", exit_code=1), "RECOVERY_FAILED"),
        ]
        for kwargs, error_id in cases:
            with self.subTest(error_id=error_id, exit_code=kwargs.get("exit_code", 0)):
                self.host = Host()
                self.addCleanup(self.host.cleanup)
                status = self.repair(**kwargs)
                self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", error_id))
                # Every outcome names the one action, and the gateway that ran before is restored.
                self.assertEqual(status["error"]["nextAction"], "recover-native")
                self.assertTrue(status["error"]["message"].endswith(" The gateway was started again."), status["error"])
                self.assertNotIn("plugins-post", [s["id"] for s in status["steps"]])
        self.assertEqual(status["error"]["message"], "OpenClaw repair failed: OpenClaw gave no reason (exit code 1). "
                                                     "Chat may be unavailable. The gateway was started again.")
        envelope = toolctl.map_native_repair(1, {"ok": False, "error": {"message": "An update is still in progress."}}, None)
        self.assertEqual(envelope["error"]["message"], "OpenClaw repair failed: An update is still in progress. Chat may be unavailable.")
        warning = toolctl.map_native_repair(0, {"status": "warning", "nextAction": "Stop the Gateway, then rerun repair."}, None)
        self.assertEqual(warning["error"]["message"], "OpenClaw repair couldn't finish: Stop the Gateway, then rerun repair.")
        self.assertEqual(warning["error"]["detail"]["nativeNextAction"], "Stop the Gateway, then rerun repair.")

    def test_recover_native_refuses_with_an_open_legacy_transaction(self):
        write(self.host.paths["gateway_fence_permit"], "{}")
        status = self.repair(native_fixture("update-repair.ok.json"))
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "PF2_LEGACY_TRANSACTION_OPEN"))
        self.assertEqual(self.host.calls(), [])

    def test_retry_checks_runs_probes_only(self):
        self.host.queue(action="retry-checks", target=None)
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["preflight", "contract"])
        calls = self.host.calls()
        self.assertTrue(calls)
        self.assertTrue(all(c.startswith(("plugins inspect ", "gateway status --require-rpc", "gateway call config.get ",
                                          "gateway call bridgesllm.ask_user.steer ")) for c in calls), calls)

    def test_retry_checks_reports_a_broken_plugin_without_reinstalling_it(self):
        self.host.set_plugin("bridgesllm-ask-user", plugin_doc("bridgesllm-ask-user", "4.0.0", status="error", error="SDK mismatch"))
        self.host.queue(action="retry-checks")
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("succeeded-degraded", "CONTRACT_REQUIRED_PROBE_FAILED"))
        self.assertFalse([c for c in self.host.calls() if c.startswith(("plugins install", "plugins reload", "update "))])

    def test_unimplemented_pair_is_refused_in_plain_words(self):
        self.host.queue(action="requalify", target=None)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "TOOLS_ACTION_UNSUPPORTED"))
        self.assertEqual(status["error"]["message"],
                         "OpenClaw isn't re-qualified like the command-line tools; use \"Retry checks\" to check it again.")
        self.assertEqual(self.host.calls(), [])
        self.host.queue(run_id=OTHER_RUN_ID, action="update", target=None)
        self.assertEqual(self.host.run(run_id=OTHER_RUN_ID)["error"]["id"], "REQUEST_INVALID")

    def test_interrupted_retry_checks_changed_nothing(self):
        self.host.queue(action="retry-checks")
        run = toolctl.Run(self.host.roots(), RUN_ID)
        run.init_status("openclaw")
        run.transition("checks", "verifying")
        self.assertEqual(toolctl.cmd_reconcile(self.host.roots()), [{"runId": RUN_ID, "state": "failed"}])
        self.assertEqual(run.load()["error"]["id"], "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE")


THIRD_RUN_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
LATER_RELEASE = ("Updating OpenClaw from Maintenance comes in a later Portal release. OpenClaw keeps working; "
                 "this Portal works with OpenClaw 2026.9.1 and newer.")


class CoreUpdatesLaterReleaseTests(HostTestCase):
    """5.2.0: policy openclaw.coreUpdates "later-release" turns the OpenClaw core update off."""

    def setUp(self):
        super().setUp()
        policy = self.host.policy()
        policy["openclaw"]["coreUpdates"] = "later-release"
        self.host.set_policy(policy)
        self.installed = toolctl.installed_openclaw_version(self.host.roots())

    def prior(self, run_id, state, error_id, next_action="recover-native", created="2026-11-01T10:00:00.000Z", **result):
        roots = self.host.roots()
        toolctl.ensure_state_dirs(roots)
        run = toolctl.Run(roots, run_id)
        os.makedirs(run.dir, mode=0o700, exist_ok=True)
        run.init_status("openclaw")
        run.finish(state, error={"id": error_id, "nextAction": next_action, "message": "x"},
                   result=dict({"action": "update", "from": self.installed, "to": self.installed}, **result))
        run.status["createdAt"] = created
        run.save()

    def stops_and_starts(self):
        try:
            with open(self.host.fake + "/systemctl.log") as handle:
                return [line.split()[0] for line in handle.read().splitlines() if line.split()[0] in ("stop", "start")]
        except FileNotFoundError:
            return []

    def test_preflight_and_update_are_refused_before_anything_runs(self):
        for run_id, action in ((RUN_ID, "preflight"), (OTHER_RUN_ID, "update")):
            with self.subTest(action=action):
                self.host.queue(run_id=run_id, action=action)
                status = self.host.run(run_id=run_id)
                self.assertEqual((status["state"], status["error"]["id"]), ("refused", "OPENCLAW_UPDATE_LATER_RELEASE"))
                self.assertEqual(status["error"]["message"], LATER_RELEASE)
                self.assertIsNone(status["error"]["nextAction"])
                self.assertEqual(status["error"]["refusals"][0]["message"], LATER_RELEASE)
                self.assertEqual(status["result"], {"action": action, "from": self.installed, "to": None})
                self.assertEqual(status["steps"], [])
        # No native call, no plugin change, no gateway stop.
        self.assertEqual(self.host.calls(), [])
        self.assertEqual(self.stops_and_starts(), [])

    def test_cli_preflight_is_refused(self):
        self.addCleanup(os.umask, os.umask(0o022))  # main() sets 077
        argv = []
        for name, value in self.host.paths.items():
            argv += ["--" + name.replace("_", "-"), ":".join(value) if isinstance(value, list) else value]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = toolctl.main(argv + ["preflight", "openclaw", "--target-metadata", self.host.meta_path])
        report = json.loads(out.getvalue())
        self.assertEqual((code, report["ok"], [r["id"] for r in report["refusals"]]),
                         (toolctl.EXIT_REFUSED, False, ["OPENCLAW_UPDATE_LATER_RELEASE"]))
        self.assertEqual((report["refusals"][0]["message"], report["facts"]["installedVersion"]), (LATER_RELEASE, self.installed))
        self.assertEqual(self.host.calls(), [])

    def test_repair_and_retry_checks_need_an_open_recovery(self):
        for run_id, action, verb in ((RUN_ID, "recover-native", "repair"), (OTHER_RUN_ID, "retry-checks", "check again")):
            with self.subTest(action=action):
                self.host.queue(run_id=run_id, action=action, target=None)
                status = self.host.run(run_id=run_id)
                self.assertEqual((status["state"], status["error"]["id"]), ("refused", "OPENCLAW_UPDATE_LATER_RELEASE"))
                self.assertEqual(status["error"]["message"],
                                 "No OpenClaw recovery is open, so there is nothing to %s. %s" % (verb, LATER_RELEASE))
        self.assertEqual(self.host.calls(), [])
        self.assertEqual(self.stops_and_starts(), [])

    def test_repair_continues_an_open_recovery_and_a_refused_run_does_not_close_it(self):
        self.prior(THIRD_RUN_ID, "recovery-required", "RECOVERY_FAILED")
        # A newer refused run changed nothing: the recovery is still open.
        self.prior(OTHER_RUN_ID, "refused", "PF4_TOOLS_RUN_ACTIVE", created="2026-11-01T10:05:00.000Z")
        self.host.reply("repair", native_fixture("update-repair.ok.json"))
        self.host.queue(action="recover-native", target=None)
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertIn("update repair --yes --no-restart --json", self.host.calls())

    def test_retry_checks_closes_an_update_that_was_not_applied(self):
        self.prior(THIRD_RUN_ID, "recovery-required", "UPDATE_NOT_APPLIED")
        self.host.queue(action="retry-checks", target=None)
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["preflight", "contract"])
        self.assertEqual(self.stops_and_starts(), [])
        self.assertIsNone(toolctl.open_openclaw_recovery(self.host.roots()))

    def test_a_not_applied_recovery_stays_open_until_every_check_passes(self):
        self.prior(THIRD_RUN_ID, "recovery-required", "UPDATE_NOT_APPLIED")
        self.host.set_plugin("bridgesllm-ask-user", plugin_doc("bridgesllm-ask-user", "4.0.0", status="error", error="SDK mismatch"))
        self.host.queue(action="retry-checks", target=None)
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                         ("recovery-required", "UPDATE_NOT_APPLIED", "retry-checks"))
        self.assertTrue(status["error"]["message"].startswith("OpenClaw %s is running, but not every Portal check passed"
                                                              % self.installed), status["error"])
        # Still closable: the package still never changed.
        self.assertTrue(toolctl.not_applied_closable(toolctl.open_openclaw_recovery(self.host.roots()), self.installed))

    def test_retry_checks_refuses_a_recovery_it_cannot_close(self):
        cases = [(dict(error_id="UPDATE_NOT_APPLIED"), {"from": "2026.9.2", "to": "2026.9.2"}),
                 (dict(error_id="RECOVERY_FAILED"), {})]
        for kwargs, result in cases:
            with self.subTest(**kwargs):
                self.host = Host()
                self.addCleanup(self.host.cleanup)
                self.setUp_flag_only()
                self.prior(THIRD_RUN_ID, "recovery-required", kwargs["error_id"], **result)
                self.host.queue(action="retry-checks", target=None)
                status = self.host.run()
                self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                                 ("refused", "RETRY_CHECKS_NOT_CLOSABLE", "recover-native"))
                self.assertEqual(self.host.calls(), [])

    def test_retry_checks_after_a_refused_rollback_still_runs(self):
        self.prior(THIRD_RUN_ID, "recovery-required", "ROLLBACK_REFUSED", next_action="retry-checks", **{"from": "2026.9.2"})
        self.host.queue(action="retry-checks", target=None)
        self.assertEqual(self.host.run()["state"], "succeeded")

    def setUp_flag_only(self):
        policy = self.host.policy()
        policy["openclaw"]["coreUpdates"] = "later-release"
        self.host.set_policy(policy)
        self.installed = toolctl.installed_openclaw_version(self.host.roots())


# Records, on every fake `openclaw` call, whether the L3 marker exists and whether
# a shared (Portal reader) lease on the readers lock could be taken right now.
MARKER_PROBE_SH = """m="%(marker)s"; q="%(quiesce)s"; l="%(lock)s"
present=absent; [ -e "$m" ] && present=present
quiesced=absent; [ -e "$q" ] && quiesced=present
lease=free; [ -e "$l" ] && { /usr/bin/flock --shared --nonblock "$l" true || lease=held; }
printf '%%s|%%s|%%s|%%s\\n' "$*" "$present" "$lease" "$quiesced" >> "$FAKE/marker.log"
"""
# The fake native update reports `activating`, waits until toolctl has paused
# chat (the maintenance marker exists), then goes back to the idle status.
WINDOW_UPDATE_SH = """cp "$FAKE/status.json" "$FAKE/status-idle.json"; %(reveal)s
i=0; while [ ! -e "%(marker)s" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done
[ -e "%(marker)s" ] && echo seen > "$FAKE/window-seen"
rm -f "$FAKE/status.exit"; cp "$FAKE/status-idle.json" "$FAKE/status.json"
"""


class MaintenanceMarkerTests(HostTestCase):
    """L3 (a.5) split: the quiesce marker pauses Portal diagnostics from pre-flight to verification; the
    maintenance marker pauses chat only for native's restart window (until plugins are reconnected)."""

    def setUp(self):
        super().setUp()
        installer = self.host.paths["installer_state_root"]
        self.marker = installer + "/openclaw-mutation-maintenance-v1.json"
        self.quiesce = self.host.paths["state_root"] + "/openclaw-diagnostics-quiesce.v1.json"
        self.lock = installer + "/openclaw-diagnostic-readers.lock"
        probe = MARKER_PROBE_SH % {"marker": self.marker, "quiesce": self.quiesce, "lock": self.lock}
        # Prepend the probe to the fake openclaw (it runs for every native call).
        path = self.host.paths["npm_global_root"] + "/openclaw/openclaw.mjs"
        with open(path) as handle:
            lines = handle.read().split("\n")
        lines.insert(2, probe)
        write(path, "\n".join(lines), 0o755)

    def marker_log(self):
        try:
            with open(self.host.fake + "/marker.log") as handle:
                return [line.rstrip("\n").split("|") for line in handle if line.strip()]
        except FileNotFoundError:
            return []

    def update(self, **run_options):
        self.host.queue(action="update")
        self.host.native_update_installs(extra="cp '%s' \"$FAKE/marker-during.json\" 2>/dev/null\n" % self.marker)
        return self.host.run(**run_options)

    def saved(self):
        return toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/status.json" % RUN_ID)

    def test_marker_bytes_are_what_the_backend_validator_accepts(self):
        data = toolctl.canonical_marker_bytes("0b6c2f1e4a594d389d0e2a7f5c1b9e01", "openclaw-gateway.service",
                                              "2026-10-30T22:00:00.000Z", "2026-10-30T22:00:00.000Z")
        # openClawExecutionAdmission.ts validateCanonicalMaintenanceMarker: JSON.stringify in this key order + "\n".
        self.assertEqual(data, (
            b'{"createdAt":"2026-10-30T22:00:00.000Z","operationId":"0b6c2f1e4a594d389d0e2a7f5c1b9e01",'
            b'"phase":"maintenance","schema":"bridgesllm.openclaw-mutation-maintenance.v1",'
            b'"systemDropInSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",'
            b'"unit":"openclaw-gateway.service","updatedAt":"2026-10-30T22:00:00.000Z"}\n'))
        self.assertEqual(toolctl.marker_run_id("0b6c2f1e4a594d389d0e2a7f5c1b9e01"), RUN_ID)
        self.assertIsNone(toolctl.marker_run_id("not-a-run"))

    def window_update(self, reveal):
        self.host.queue(action="update")
        self.host.native_update_installs(extra=WINDOW_UPDATE_SH % {"reveal": reveal, "marker": self.marker})
        return self.host.run()

    def test_quiesce_covers_native_and_chat_keeps_running_before_activation(self):
        status = self.update()  # `update status` never leaves the idle shape: no restart window
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        log = self.marker_log()
        native = next(i for i, row in enumerate(log) if row[0].startswith("update --channel"))
        # Columns: maintenance marker, readers lease, quiesce marker.
        self.assertEqual(log[0][1:], ["absent", "free", "absent"])  # pre-flight
        self.assertEqual(log[native][1:], ["absent", "held", "present"])  # chat keeps running while native starts
        post = next(i for i in range(native, len(log)) if log[i][0].startswith("plugins "))
        self.assertTrue(all(row[2:] == ["held", "present"] for row in log[native:post]), log[native:post])
        # Verification: diagnostics resume at once; chat resumes once the plugins are reconnected.
        self.assertTrue(all(row[2:] == ["free", "absent"] for row in log[post:]), log[post:])
        self.assertEqual(log[-1][1], "absent")
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))
        saved = self.saved()
        self.assertTrue(saved["quiesceMarker"]["readersDrained"])
        self.assertIsNotNone(saved["quiesceMarker"]["clearedAt"])
        # Native finished without a status showing its switch-over: toolctl still restarts the
        # gateway (stop, start) to load the new package, and chat pauses only for that.
        self.assertEqual(saved["maintenanceMarker"]["reason"], "OpenClaw is finishing its update")
        self.assertIsNotNone(saved["maintenanceMarker"]["clearedAt"])
        self.assertIsNone(saved["native"].get("chatPause"))
        self.assertEqual(os.stat(self.lock).st_mode & 0o777, 0o600)

    def test_chat_pauses_from_activation_until_plugins_reconnect(self):
        activating = json.loads(native_fixture("update-status.active.json"))
        activating["activeRun"]["phase"] = "activating"
        write(self.host.fake + "/status-window.json", json.dumps(activating))
        status = self.window_update('cp "$FAKE/status-window.json" "$FAKE/status.json"')
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertTrue(os.path.exists(self.host.fake + "/window-seen"))
        log = self.marker_log()
        native = next(i for i, row in enumerate(log) if row[0].startswith("update --channel"))
        self.assertEqual(log[native][1:], ["absent", "held", "present"])  # chat still running at launch
        post = next(i for i in range(native, len(log)) if log[i][0].startswith("plugins "))
        opened = next(i for i in range(native, post) if log[i][1] == "present")
        self.assertTrue(all(row[1:] == ["present", "held", "present"] for row in log[opened:post]), log[opened:post])
        last_plugins = max(i for i, row in enumerate(log) if row[0].startswith("plugins "))
        # plugins-post: diagnostics resumed, chat still paused; the contract runs with chat back.
        self.assertTrue(all(row[1:] == ["present", "free", "absent"] for row in log[post:last_plugins + 1]))
        self.assertTrue(log[last_plugins + 1:])
        self.assertTrue(all(row[1:] == ["absent", "free", "absent"] for row in log[last_plugins + 1:]))
        saved = self.saved()
        self.assertEqual(saved["native"]["chatPause"]["reason"], "OpenClaw is activating")
        self.assertIsNone(saved["native"]["chatPause"]["problem"])
        marker = saved["maintenanceMarker"]
        self.assertEqual((marker["reason"], marker["operationId"]), ("OpenClaw is activating", RUN_ID.replace("-", "")))
        self.assertIsNotNone(marker["clearedAt"])
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))

    def test_unreadable_native_status_alone_never_pauses_chat(self):
        """Unreadable status while native validates isn't a switch-over."""
        self.host.queue(action="update")
        self.host.native_update_installs(extra=(
            'echo 1 > "$FAKE/status.exit"; i=0; while [ ! -e "%(marker)s" ] && [ $i -lt 20 ]; do sleep 0.05; i=$((i+1)); done\n'
            '[ -e "%(marker)s" ] && echo seen > "$FAKE/window-seen"; rm -f "$FAKE/status.exit"\n') % {"marker": self.marker})
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertFalse(os.path.exists(self.host.fake + "/window-seen"))
        self.assertIsNone(self.saved()["native"].get("chatPause"))
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))

    def test_window_opens_only_when_native_reaches_activation(self):
        idle = json.loads(native_fixture("update-status.idle.json"))
        active = json.loads(native_fixture("update-status.active.json"))
        validating = dict(active, activeRun=dict(active["activeRun"], phase="validating"))
        self.assertIsNone(toolctl.native_restart_window(idle))
        for phase in ("requested", "staging", "validating"):
            self.assertIsNone(toolctl.native_restart_window(dict(active, activeRun=dict(active["activeRun"], phase=phase))))
        for phase in ("activating", "restarting", "verifying", "repairing", "finished"):
            self.assertEqual(toolctl.native_restart_window(dict(active, activeRun=dict(active["activeRun"], phase=phase))),
                             "OpenClaw is %s" % phase)
        # Nothing here proves activation began (the record exists before native's
        # previous-Gateway verification), so none of it opens the window.
        for doc in (None, [], dict(active, activeRun=dict(active["activeRun"], phase="draining")),
                    dict(active, activeRun=dict(active["activeRun"], phase=None)), dict(active, activeRun="validating"),
                    dict(idle, runStatusError="locked"), dict(idle, packageActivation={"phase": "activating"}),
                    dict(idle, packageActivation="pending"), dict(idle, packageActivationError="unreadable"),
                    dict(idle, staleRun={"runId": "x"}), dict(idle, abandonedRun={"runId": "x"}),
                    dict(validating, packageActivation={"phase": "prepared", "operationId": "op1"}),
                    dict(validating, packageActivationError="unreadable"), dict(validating, runStatusError="locked")):
            self.assertIsNone(toolctl.native_restart_window(doc), doc)
        self.assertEqual(toolctl.native_restart_window(dict(active, activeRun=dict(active["activeRun"], phase="activating"),
                                                            packageActivation={"phase": "prepared"})), "OpenClaw is activating")

    def test_package_fallback_needs_the_package_gone_or_swapped(self):
        roots = self.host.roots()
        self.assertIsNone(toolctl.native_package_window(roots, "2026.9.9"))
        write(self.host.paths["npm_global_root"] + "/openclaw/package.json", json.dumps({"name": "openclaw", "version": "2026.10.9"}))
        self.assertEqual(toolctl.native_package_window(roots, "2026.9.9"), "OpenClaw's package was replaced")
        os.rename(roots.openclaw_bin, roots.openclaw_bin + ".away")
        self.assertEqual(toolctl.native_package_window(roots, "2026.9.9"), "OpenClaw's package is being replaced")

    def test_recovery_pauses_chat_for_the_whole_repair(self):
        self.host.reply("repair", native_fixture("update-repair.ok.json"), exit_code=0)
        self.host.queue(action="recover-native", target=None)
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        log = self.marker_log()
        repair = next(row for row in log if row[0].startswith("update repair"))
        self.assertEqual(repair[1:], ["present", "held", "present"])
        self.assertEqual(status["maintenanceMarker"]["reason"], "OpenClaw repair is running")
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))

    def test_a_plugins_post_restart_pauses_chat_first(self):
        self.host.native_update_installs(extra="rm -f \"$FAKE/plugins/bridgesllm-ask-user.json\"\n")
        self.host.reply("plugins-reload", {"pluginIds": ["bridgesllm-ask-user"], "restartRequired": True})
        # The fake systemctl also logs whether chat was paused when it was called.
        write(self.host.paths["systemctl_bin"], (
            "#!/bin/sh\nFAKE=%s\n"
            "printf '%%s|%%s\\n' \"$*\" \"$([ -e '%s' ] && echo paused || echo running)\" >> \"$FAKE/systemctl.log\"\n"
            "case \"$1\" in stop) echo inactive > \"$FAKE/is-active\"; exit 0 ;; start) echo active > \"$FAKE/is-active\"; exit 0 ;;\n"
            "  reset-failed) exit 0 ;; esac\n"
            "state=$(cat \"$FAKE/is-active\" 2>/dev/null || echo active); echo \"$state\"; [ \"$state\" = active ]\n")
              % (self.host.fake, self.marker), 0o755)
        self.host.queue(action="update")
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        with open(self.host.fake + "/systemctl.log") as handle:
            restarts = [l for l in handle.read().splitlines() if l.startswith("restart")]
        self.assertEqual(restarts, ["restart openclaw-gateway.service|paused"])
        # Chat was already paused for toolctl's own restart of the gateway after native (K7).
        self.assertEqual(status["maintenanceMarker"]["reason"], "OpenClaw is finishing its update")
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))

    def test_a_rollback_after_verification_quiets_diagnostics_again(self):
        self.host.versioned_native()
        write(self.host.fake + "/update-2026.10.9.sh", "echo 1 > \"$FAKE/config-get.exit\"\n")  # OC-CONFIG fails
        self.host.queue(action="update")
        status = self.host.run()
        self.assertEqual(status["state"], "rolled-back", status.get("error"))
        rollback = [row for row in self.marker_log() if row[0].startswith("update --channel stable --tag 2026.9.9")]
        # Columns: maintenance marker, readers lease, quiesce marker — chat paused and diagnostics quiet again.
        self.assertEqual([row[1:] for row in rollback], [["present", "held", "present"]])
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))

    def test_cleared_on_native_failure_and_recovery(self):
        for result, state in (("update-result.failed-validating.json", "refused"),
                              ("update-result.failed-activating.json", "recovery-required")):
            with self.subTest(result=result):
                self.host = Host()
                self.addCleanup(self.host.cleanup)
                self.marker = self.host.paths["installer_state_root"] + "/openclaw-mutation-maintenance-v1.json"
                self.host.queue(action="update")
                self.host.native_update_installs(version="2026.9.9", result=result)
                self.host.reply("update", exit_code=1)
                status = self.host.run()
                self.assertEqual(status["state"], state)
                self.assertFalse(os.path.exists(self.marker))
                self.assertFalse(os.path.exists(self.host.paths["state_root"] + "/openclaw-diagnostics-quiesce.v1.json"))
                self.assertIsNotNone(self.saved()["quiesceMarker"]["clearedAt"])

    def test_cleared_when_the_run_ends_on_an_internal_error(self):
        self.host.queue(action="update")
        self.host.native_update_installs()
        with mock.patch.object(toolctl, "plugins_pre", side_effect=RuntimeError("boom")):
            status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "TOOLS_RUN_INTERNAL_ERROR"))
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))
        # Cleared as part of the terminal state, not only by the process exit path.
        saved = self.saved()
        self.assertEqual(saved["state"], "recovery-required")
        self.assertIsNotNone(saved["quiesceMarker"]["clearedAt"])

    def test_busy_readers_refuse_without_changing_anything(self):
        write(self.lock, "", 0o600)
        fd = os.open(self.lock, os.O_RDWR)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_SH)  # a Portal diagnostic still running
        self.host.queue(action="update")
        self.host.native_update_installs()
        options = {"progress": {"progress_seconds": 0, "poll_seconds": 0.05, "ready_wait_seconds": 0.5,
                                "ready_interval_seconds": 0.05, "drain_seconds": 0.3}}
        status = self.host.run(**options)
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "QUIESCE_READERS_BUSY"))
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))
        self.assertNotIn("update --channel", " ".join(self.host.calls()))
        self.assertEqual(self.host.history()[-1]["outcome"], "failed")

    def test_foreign_marker_refuses_and_a_stale_own_marker_is_cleared(self):
        foreign = toolctl.canonical_marker_bytes("f" * 32, "openclaw-gateway.service",
                                                 "2026-10-30T20:00:00.000Z", "2026-10-30T20:00:00.000Z")
        write(self.marker, foreign.decode(), 0o600)
        report = self.host.preflight()
        self.assertEqual(self.refusal_ids(report), ["PF4_MAINTENANCE_MARKER_PRESENT"])
        self.assertEqual(report["refusals"][0]["detail"]["operationId"], "f" * 32)
        # A marker left by an earlier toolctl run that is final no longer blocks.
        self.host.queue(run_id=OTHER_RUN_ID)
        other = toolctl.Run(self.host.roots(), OTHER_RUN_ID)
        other.init_status("openclaw")
        other.finish("failed")
        write(self.marker, toolctl.canonical_marker_bytes(OTHER_RUN_ID.replace("-", ""), "openclaw-gateway.service",
                                                          "2026-10-30T20:00:00.000Z", "2026-10-30T20:00:00.000Z").decode(), 0o600)
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(self.saved()["staleMaintenanceMarker"]["cleared"], True)
        # The same for the quiesce marker: a foreign one refuses, a final run's own one is cleared.
        write(self.quiesce, toolctl.quiesce_marker_bytes("f" * 32, "not-a-run", "2026-10-30T20:00:00.000Z").decode(), 0o600)
        report = self.host.preflight()  # (the update above made the target current, too)
        refusal = next(r for r in report["refusals"] if r["id"] == "PF4_MAINTENANCE_MARKER_PRESENT")
        self.assertEqual(refusal["detail"]["path"], self.quiesce)
        write(self.quiesce, toolctl.quiesce_marker_bytes(OTHER_RUN_ID.replace("-", ""), OTHER_RUN_ID,
                                                         "2026-10-30T20:00:00.000Z").decode(), 0o600)
        self.assertEqual(toolctl.clear_stale_quiesce_marker(self.host.roots())["cleared"], True)
        self.assertFalse(os.path.exists(self.quiesce))

    def test_reconcile_clears_only_a_final_runs_marker(self):
        roots = self.host.roots()
        self.host.queue(run_id=OTHER_RUN_ID)
        other = toolctl.Run(roots, OTHER_RUN_ID)
        other.init_status("openclaw")
        other.transition("native", "running")
        stamp = "2026-10-30T20:00:00.000Z"
        write(self.marker, toolctl.canonical_marker_bytes(OTHER_RUN_ID.replace("-", ""), "openclaw-gateway.service",
                                                          stamp, stamp).decode(), 0o600)
        write(self.quiesce, toolctl.quiesce_marker_bytes(OTHER_RUN_ID.replace("-", ""), OTHER_RUN_ID, stamp).decode(), 0o600)
        lock = toolctl.ToolsLock(roots)
        lock.acquire(OTHER_RUN_ID)
        toolctl.cmd_reconcile(roots)  # its runner is alive: untouched
        self.assertTrue(os.path.exists(self.marker) and os.path.exists(self.quiesce))
        lock.release()
        toolctl.cmd_reconcile(roots)  # runner gone: the run settles, then its markers clear
        self.assertEqual(toolctl.Run(roots, OTHER_RUN_ID).load()["state"], "recovery-required")
        self.assertFalse(os.path.exists(self.marker) or os.path.exists(self.quiesce))
        write(self.marker, "{}", 0o600)  # not a toolctl marker: never removed
        write(self.quiesce, "{}", 0o600)
        toolctl.cmd_reconcile(roots)
        self.assertTrue(os.path.exists(self.marker) and os.path.exists(self.quiesce))

    def test_quiesce_marker_path_is_the_one_the_backend_reads(self):
        lease = os.path.join(TOOLS_DIR, "..", "..", "backend", "src", "utils", "openclawDiagnosticLease.ts")
        with open(lease, encoding="utf-8") as handle:
            source = handle.read()
        expected = os.path.join(toolctl.DEFAULTS["state_root"][1], toolctl.QUIESCE_MARKER_NAME)
        self.assertIn("OPENCLAW_DIAGNOSTICS_QUIESCE_MARKER =\n  '%s';" % expected, source)
        self.assertIn("'%s/%s'" % (toolctl.DEFAULTS["installer_state_root"][1], toolctl.MAINTENANCE_MARKER_NAME), source)


def maintenance_pending_result():
    """An `update --json` result whose run Doctor couldn't finish (finishLedger: skipped/doctor-maintenance-pending)."""
    doc = json.loads(native_fixture("update-result.succeeded.json"))
    doc["run"].update(status="skipped", reason="doctor-maintenance-pending")
    return doc


class CoreUpdateFlowTests(HostTestCase):
    """K7: the Portal's unit owns the gateway; native updates with --no-restart; toolctl stops and starts the unit."""

    ACTIVATING = {"activeRun": {"runId": "a1", "status": "running", "phase": "activating", "createdAtMs": 0, "steps": []}}

    def verbs(self):
        return [line.split()[0] for line in self.host.lines("systemctl.log") if line.split()[:1] in (["stop"], ["start"])]

    def update(self, **run_options):
        self.host.queue(action="update")
        return self.host.run(**run_options)

    def fail_new_version_start(self):
        """The new version refuses to start (exit 78 leaves the unit failed); the previous one starts."""
        package_json = self.host.paths["npm_global_root"] + "/openclaw/package.json"
        write(self.host.fake + "/start.sh", 'grep -q 2026.10.9 "%s" && { echo failed > "$FAKE/is-active"; exit 1; }\n'
              % package_json)

    VALIDATING = {"activeRun": {"runId": "a1", "status": "running", "phase": "validating", "createdAtMs": 0, "steps": []},
                  "packageActivation": {"phase": "prepared", "operationId": "op1"}}

    def test_mode_a_keeps_chat_up_while_native_validates(self):
        """An unsettled packageActivation record during `validating`, then unreadable status,
        stopped the gateway before native's previous-Gateway check. Neither stops it now."""
        self.host.versioned_native()
        write(self.host.fake + "/update-2026.10.9.sh", (
            "cp \"$FAKE/status.json\" \"$FAKE/status-idle.json\"; printf '%%s' '%s' > \"$FAKE/status.json\"\n"
            "sleep 0.5; cat \"$FAKE/is-active\" 2>/dev/null > \"$FAKE/state-validating\" || echo active > \"$FAKE/state-validating\"\n"
            "echo 1 > \"$FAKE/status.exit\"; sleep 0.5\n"
            "cat \"$FAKE/is-active\" 2>/dev/null > \"$FAKE/state-unreadable\" || echo active > \"$FAKE/state-unreadable\"\n"
            "rm -f \"$FAKE/status.exit\"; cp \"$FAKE/status-idle.json\" \"$FAKE/status.json\"\n") % json.dumps(self.VALIDATING))
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(self.host.lines("state-validating") + self.host.lines("state-unreadable"), ["active", "active"])
        self.assertIsNone(status["native"].get("gatewayStop"))
        self.assertIsNone(status["native"].get("chatPause"))
        self.assertIn("validating", status["native"]["phasesSeen"])
        self.assertEqual(self.verbs(), ["stop", "start"])  # after native: the restart that loads the new package

    def test_mode_a_stops_when_the_package_is_gone_and_status_cannot_be_read(self):
        """The fallback that proves activation began: native is swapping the package directory."""
        self.host.versioned_native()
        write(self.host.fake + "/update-2026.10.9.sh", (
            "mv '%(bin)s' '%(bin)s.away'\n"
            "i=0; while [ \"$(cat \"$FAKE/is-active\" 2>/dev/null)\" != inactive ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\n"
            "cat \"$FAKE/is-active\" > \"$FAKE/state-at-swap\"; mv '%(bin)s.away' '%(bin)s'\n") % {"bin": self.host.roots().openclaw_bin})
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(self.host.lines("state-at-swap"), ["inactive"])
        self.assertEqual(status["native"]["gatewayStop"]["reason"], "OpenClaw's package is being replaced")
        self.assertEqual(self.verbs(), ["stop", "start"])

    def test_mode_a_stops_the_gateway_at_activation_and_starts_it_after_native(self):
        self.host.versioned_native()
        # Native shows `activating`, then waits for the unit to stop before its package swap.
        write(self.host.fake + "/update-2026.10.9.sh", (
            "cp \"$FAKE/status.json\" \"$FAKE/status-idle.json\"; printf '%%s' '%s' > \"$FAKE/status.json\"\n"
            "i=0; while [ \"$(cat \"$FAKE/is-active\" 2>/dev/null)\" != inactive ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\n"
            "cat \"$FAKE/is-active\" > \"$FAKE/state-at-swap\"; cp \"$FAKE/status-idle.json\" \"$FAKE/status.json\"\n")
            % json.dumps(self.ACTIVATING))
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["updateMode"]["mode"], "live")
        # Chat was up when native started; the unit was down before the swap; one stop, one start.
        self.assertEqual(self.host.lines("update-calls.log"), ["update --channel stable --tag 2026.10.9 --yes --json --no-restart|active"])
        self.assertEqual(self.host.lines("state-at-swap"), ["inactive"])
        self.assertEqual(self.verbs(), ["stop", "start"])
        self.assertEqual((status["native"]["gatewayStop"]["reason"], status["native"]["gatewayStop"]["problem"]),
                         ("OpenClaw is activating", None))
        ids = [s["id"] for s in status["steps"]]
        self.assertNotIn("native-repair", ids)
        self.assertLess(ids.index("gateway-stop"), ids.index("gateway-start"))
        self.assertEqual(status["result"]["to"], "2026.10.9")
        self.assertEqual(self.host.lines("is-active"), ["active"])

    def test_mode_a_a_failed_stop_at_activation_stops_native_before_the_swap(self):
        """The unit didn't stop at activation; native must not swap under the live gateway."""
        self.host.versioned_native()
        write(self.host.fake + "/stop.exit", "1")  # systemctl stop fails; the unit stays active
        # Native shows `activating`, then waits for the unit to stop before its package swap.
        write(self.host.fake + "/update-2026.10.9.sh", (
            "printf '%%s' '%s' > \"$FAKE/status.json\"\n"
            "i=0; while [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done\n"
            "echo swapped > \"$FAKE/swapped\"\n") % json.dumps(self.ACTIVATING))
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                         ("recovery-required", "GATEWAY_STOP_FAILED_AT_SWITCH_OVER", "recover-native"), status.get("error"))
        self.assertEqual(self.host.lines("swapped"), [])  # stopped (SIGTERM) before its swap
        record = status["native"]["gatewayStop"]
        self.assertEqual((record["nativeStopped"], record["packageReplacing"]), (True, False))
        self.assertEqual(record["problem"], "the OpenClaw gateway didn't stop (it is active)")
        self.assertEqual(status["error"]["message"],
                         "The OpenClaw gateway couldn't be stopped for the switch-over (the OpenClaw gateway didn't stop (it "
                         "is active)), so the Portal stopped OpenClaw's update before it replaced the installed version. "
                         "The gateway is still running. Run OpenClaw repair.")
        self.assertEqual(self.verbs(), ["stop"])  # one failed stop; nothing stops or starts it again
        self.assertEqual([s["state"] for s in status["steps"] if s["id"] in ("gateway-stop", "native")], ["failed", "failed"])
        self.assertNotIn("native-repair", [s["id"] for s in status["steps"]])
        self.assertIsNone(status["gateway"]["stoppedByToolctl"] or None)

    def test_mode_a_a_failed_stop_while_the_package_is_replaced_lets_native_finish(self):
        """Once native is replacing the package it has to finish; the run still ends recovery-required."""
        self.host.versioned_native()
        write(self.host.fake + "/stop.exit", "1")
        write(self.host.fake + "/update-2026.10.9.sh", (
            "mv '%(bin)s' '%(bin)s.away'\n"
            "i=0; while ! grep -q '^stop' \"$FAKE/systemctl.log\" 2>/dev/null && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\n"
            "sleep 0.2; mv '%(bin)s.away' '%(bin)s'; echo finished > \"$FAKE/finished\"\n") % {"bin": self.host.roots().openclaw_bin})
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                         ("recovery-required", "GATEWAY_STOP_FAILED_AT_SWITCH_OVER", "recover-native"), status.get("error"))
        self.assertEqual(self.host.lines("finished"), ["finished"])  # never interrupted mid-swap
        record = status["native"]["gatewayStop"]
        self.assertEqual((record["reason"], record["nativeStopped"], record["packageReplacing"]),
                         ("OpenClaw's package is being replaced", False, True))
        self.assertIn("after OpenClaw had begun replacing its installation; OpenClaw's update ran to its end with the old "
                      "gateway still running.", status["error"]["message"])
        self.assertEqual(self.verbs(), ["stop"])

    def test_mode_a_unfinished_maintenance_repairs_with_the_gateway_stopped_then_starts(self):
        self.host.versioned_native(result=None)
        self.host.reply("update", json.dumps(maintenance_pending_result()))
        self.host.reply("repair", native_fixture("update-repair.ok.json"), script='cat "$FAKE/is-active" > "$FAKE/state-at-repair"\n')
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertIn("update repair --yes --no-restart --json", self.host.calls())
        self.assertEqual(self.host.lines("state-at-repair"), ["inactive"])
        self.assertEqual([s["id"] for s in status["steps"]][-5:],
                         ["gateway-stop", "native-repair", "gateway-start", "plugins-post", "contract"])
        self.assertEqual([s["state"] for s in status["steps"] if s["id"] == "native"], ["passed"])
        self.assertEqual(self.verbs(), ["stop", "start"])

    def test_mode_b_stops_the_gateway_before_native(self):
        self.host = Host(installed="2026.9.3")  # predates the installation-replacement watcher
        self.addCleanup(self.host.cleanup)
        self.host.versioned_native()
        write(self.host.fake + "/update-2026.10.9.sh", "sleep 0.6\n")  # long enough for many 0.05 s ticks
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["updateMode"], {"mode": "stopped", "reason": "no-replacement-watcher",
                                                          "installed": "2026.9.3"})
        self.assertEqual(self.host.lines("update-calls.log"), ["update --channel stable --tag 2026.10.9 --yes --json --no-restart|inactive"])
        # PF-11 once, in the pre-flight with the gateway up: no second dry run once it is stopped.
        self.assertEqual([line.split("|")[1] for line in self.host.lines("dry-run-calls.log")], ["active"])
        self.assertEqual(self.verbs(), ["stop", "start"])
        self.assertEqual(status["steps"][2]["id"], "gateway-stop")
        # Parked from the start: no stop at activation, and status polled gently: the first tick and the
        # read after native only, not one per 0.05 s tick.
        self.assertIsNone(status["native"].get("gatewayStop"))
        calls = self.host.calls()
        after = calls[calls.index("update --channel stable --tag 2026.10.9 --yes --json --no-restart"):]
        self.assertEqual(after.count("update status --json"), 2, after)

    # 2026.9.3 under the Portal's unit: the same answer running or stopped.
    SELF_UPDATE_REFUSAL = {"status": "error", "mode": "unknown", "reason": "managed-service-preflight", "steps": []}
    SELF_UPDATE_STDERR = ("Gateway service inspection is unavailable. Refusing to mutate code because managed service "
                          "ownership cannot be verified.")
    SELF_UPDATE_MESSAGE = ("OpenClaw 2026.9.3 cannot update itself while the Portal runs it; it keeps working with this "
                           "Portal; updating it from Maintenance needs a later Portal release.")

    def refuse_self_update(self):
        self.host = Host(installed="2026.9.3")
        self.addCleanup(self.host.cleanup)
        self.host.versioned_native()
        self.host.reply("dry-run", json.dumps(self.SELF_UPDATE_REFUSAL), exit_code=1, stderr=self.SELF_UPDATE_STDERR,
                        script=False)

    def test_a_self_update_refusal_ends_the_preflight_with_one_plain_message(self):
        self.refuse_self_update()
        report = self.host.preflight()
        self.assertFalse(report["ok"])
        self.assertEqual([(r["id"], r["check"], r["message"]) for r in report["refusals"]],
                         [("PF11_SELF_UPDATE_UNSUPPORTED", "PF-11", self.SELF_UPDATE_MESSAGE)])
        self.assertEqual(report["refusals"][0]["detail"]["nativeReason"], "managed-service-preflight")
        self.assertNotIn("updateMode", report["facts"])
        self.host.queue(action="preflight")
        status = self.host.run()
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["message"], status["result"]["from"]),
                         ("refused", "PF11_SELF_UPDATE_UNSUPPORTED", self.SELF_UPDATE_MESSAGE, "2026.9.3"))
        self.assertEqual(self.verbs(), [])

    def test_a_self_update_refusal_never_stops_the_gateway_or_changes_plugins(self):
        """N3/N4: the update ends refused at its own pre-flight: no outage, no plugin install, no native update."""
        self.refuse_self_update()
        os.unlink(self.host.fake + "/plugins/bridgesllm-shared-browser.json")  # plugins-pre would install it
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["message"]),
                         ("refused", "PF11_SELF_UPDATE_UNSUPPORTED", self.SELF_UPDATE_MESSAGE))
        self.assertEqual([s["id"] for s in status["steps"]], ["preflight"])
        self.assertEqual(self.verbs(), [])  # the fake unit was never stopped: it is still active
        self.assertEqual(self.host.lines("update-calls.log"), [])
        self.assertEqual(len(self.host.lines("dry-run-calls.log")) + self.host.calls().count(
            "update --dry-run --json --no-restart --channel stable --tag 2026.10.9"), 1)
        self.assertFalse([c for c in self.host.calls() if c.startswith(("plugins install", "plugins reload"))])
        self.assertIsNone(status.get("gateway"))

    def test_a_passing_preflight_records_its_update_mode_in_the_result(self):
        """N2: the card and the consent dialog read the mode from the pre-flight run's result."""
        self.host.versioned_native()
        self.host.queue(action="preflight")
        status = self.host.run()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["updateMode"], {"mode": "live", "reason": "replacement-watcher"})

    def test_a_failed_start_rolls_back_to_the_previous_version(self):
        self.host.versioned_native()
        self.fail_new_version_start()
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "UPDATE_ROLLED_BACK"))
        self.assertIn("OpenClaw 2026.10.9 didn't start", status["error"]["message"])
        self.assertIn("returned OpenClaw to 2026.9.9; chat is working again", status["error"]["message"])
        self.assertEqual(status["result"]["to"], "2026.9.9")
        self.assertEqual(self.host.lines("update-calls.log"), [
            "update --channel stable --tag 2026.10.9 --yes --json --no-restart|active",
            "update --channel stable --tag 2026.9.9 --yes --json --no-restart|inactive"])
        self.assertIn("update --dry-run --json --no-restart --channel stable --tag 2026.9.9", self.host.calls())
        self.assertEqual([s["state"] for s in status["steps"] if s["id"] == "rollback"], ["passed"])
        self.assertEqual(self.host.lines("is-active"), ["active"])

    def test_a_failed_repair_rolls_back(self):
        self.host.versioned_native(result=None)
        self.host.reply("update", json.dumps(maintenance_pending_result()))
        package_json = self.host.paths["npm_global_root"] + "/openclaw/package.json"
        write(self.host.fake + "/update-2026.9.9.sh", "printf '{\"name\": \"openclaw\", \"version\": \"2026.9.9\"}' > '%s'\n"
              "cat '%s'; exit 0\n" % (package_json, os.path.join(NATIVE_FIXTURES, "update-result.succeeded.json")))
        self.host.reply("repair", {"status": "failed", "error": {"message": "Doctor could not migrate the agent stores."}},
                        exit_code=1)
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "UPDATE_ROLLED_BACK"))
        self.assertIn("Doctor could not migrate the agent stores", status["error"]["message"])
        self.assertEqual(status["result"]["to"], "2026.9.9")
        self.assertEqual(self.host.lines("is-active"), ["active"])

    def test_a_refused_rollback_leaves_the_gateway_stopped_with_one_recovery_action(self):
        self.host.versioned_native()
        self.fail_new_version_start()
        write(self.host.fake + "/dry-run-refuse-2026.9.9", json.dumps({"failures": [
            {"reason": "state-migrated-no-rollback", "message": "The previous version can't read the migrated state."}]}))
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "ROLLBACK_REFUSED"))
        self.assertEqual(status["error"]["nextAction"], "recover-native")
        self.assertIn("can't read the migrated state", status["error"]["message"])
        self.assertTrue(status["error"]["message"].endswith("The OpenClaw gateway is stopped; run OpenClaw repair."))
        self.assertEqual(len(self.host.lines("update-calls.log")), 1)
        # 2026.10.9 never became ready: it is not started again.
        self.assertEqual(self.verbs(), ["stop", "start", "stop"])
        self.assertEqual(self.host.lines("is-active"), ["inactive"])

    def break_config_after_update(self):
        """2026.10.9 starts and becomes ready, then OC-CONFIG (a core probe) fails: the version is unusable."""
        write(self.host.fake + "/update-2026.10.9.sh", "echo 1 > \"$FAKE/config-get.exit\"\n")

    def fail_downgrade(self, fixture, package=None):
        """Native's return to 2026.9.9 exits 1 with ``fixture``; with ``package`` it first replaces the package."""
        package_json = self.host.paths["npm_global_root"] + "/openclaw/package.json"
        swap = "printf '{\"name\": \"openclaw\", \"version\": \"%s\"}' > '%s'\n" % (package, package_json) if package else ""
        write(self.host.fake + "/update-2026.9.9.sh", "%scat '%s'; exit 1\n" % (swap, os.path.join(NATIVE_FIXTURES, fixture)))

    def test_an_unproven_core_probe_after_the_update_keeps_the_new_version_running(self):
        """A config.get reply that couldn't be read isn't a failed check: no rollback, chat stays up."""
        self.host.versioned_native()
        write(self.host.fake + "/config-get.big", json.dumps({"exists": True, "valid": True, "config": {}, "parsed": "x" * 200000}))
        with mock.patch.object(toolctl, "CONFIG_GET_REPLY_LIMIT_BYTES", 128 * 1024):
            status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("succeeded-degraded", "CONTRACT_REQUIRED_PROBE_UNPROVEN"))
        self.assertEqual(status["result"]["to"], "2026.10.9")
        self.assertEqual([s for s in status["steps"] if s["id"] == "rollback"], [])
        self.assertEqual(self.verbs()[-1:], ["start"])
        self.assertEqual(self.host.lines("is-active"), ["active"])

    def test_a_failed_core_probe_after_a_ready_start_rolls_back(self):
        self.host.versioned_native()
        self.break_config_after_update()
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "UPDATE_ROLLED_BACK"))
        self.assertIn("OpenClaw 2026.10.9 started, but its checks failed (OC-CONFIG).", status["error"]["message"])
        self.assertEqual(status["result"]["to"], "2026.9.9")
        self.assertEqual([s["state"] for s in status["steps"] if s["id"] == "rollback"], ["passed"])
        self.assertEqual(self.host.lines("is-active"), ["active"])

    def test_a_refused_rollback_after_a_ready_start_starts_that_version_again(self):
        self.host.versioned_native()
        self.break_config_after_update()
        write(self.host.fake + "/dry-run-refuse-2026.9.9", json.dumps({"failures": [
            {"reason": "state-migrated-no-rollback", "message": "The previous version can't read the migrated state."}]}))
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                         ("recovery-required", "ROLLBACK_REFUSED", "retry-checks"))
        message = status["error"]["message"]
        self.assertTrue(message.startswith("OpenClaw 2026.10.9 is running again, but its checks failed (OC-CONFIG); "
                                           "the Portal could not return to 2026.9.9: "), message)
        self.assertIn("can't read the migrated state", message)
        self.assertNotIn("run OpenClaw repair", message)
        self.assertEqual(status["error"]["detail"]["runningAgain"], "2026.10.9")
        self.assertEqual(status["result"]["to"], "2026.10.9")
        self.assertEqual(len(self.host.lines("update-calls.log")), 1)
        self.assertEqual(self.verbs(), ["stop", "start", "stop", "start"])
        self.assertEqual(self.host.lines("is-active"), ["active"])

    def test_a_downgrade_refused_before_the_package_changed_starts_the_ready_version_again(self):
        self.host.versioned_native()
        self.break_config_after_update()
        self.fail_downgrade("update-result.admission-refused.json")
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                         ("recovery-required", "ROLLBACK_FAILED", "retry-checks"))
        self.assertTrue(status["error"]["message"].startswith(
            "OpenClaw 2026.10.9 is running again, but its checks failed (OC-CONFIG); the Portal could not return to "
            "2026.9.9: OpenClaw refused the update before starting it"), status["error"]["message"])
        self.assertEqual(len(self.host.lines("update-calls.log")), 2)
        self.assertEqual(self.verbs(), ["stop", "start", "stop", "start"])
        self.assertEqual(self.host.lines("is-active"), ["active"])

    def test_a_downgrade_that_may_have_changed_something_leaves_the_gateway_stopped(self):
        # Failed after activation (package unchanged), and a refusal the replaced package contradicts.
        for fixture, package in (("update-result.failed-activating.json", None),
                                 ("update-result.admission-refused.json", "2026.9.9")):
            with self.subTest(fixture=fixture, package=package):
                self.host = Host()
                self.addCleanup(self.host.cleanup)
                self.host.versioned_native()
                self.break_config_after_update()
                self.fail_downgrade(fixture, package)
                status = self.update()
                self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                                 ("recovery-required", "ROLLBACK_FAILED", "recover-native"))
                self.assertTrue(status["error"]["message"].endswith("The OpenClaw gateway is stopped; run OpenClaw repair."))
                self.assertEqual(self.verbs(), ["stop", "start", "stop"])
                self.assertEqual(self.host.lines("is-active"), ["inactive"])

    def test_a_unit_that_exits_during_the_readiness_wait_fails_fast(self):
        self.host.versioned_native()
        package_json = self.host.paths["npm_global_root"] + "/openclaw/package.json"
        # 2026.10.9 starts, then exits (78) before it is ready; 2026.9.9 starts normally.
        write(self.host.fake + "/start.sh", 'grep -q 2026.10.9 "%s" && touch "$FAKE/dies"\n' % package_json)
        original = self.host.http

        def readyz(url, timeout):
            if os.path.exists(self.host.fake + "/dies"):
                os.unlink(self.host.fake + "/dies")
                write(self.host.fake + "/is-active", "failed\n")
                return 503, None
            return original(url, timeout)

        self.host.queue(action="update")
        status = self.host.run(http_get=readyz, progress={"progress_seconds": 0, "poll_seconds": 0.05, "ready_wait_seconds": 30,
                                                          "ready_interval_seconds": 0.05, "probe_deadline_seconds": 5,
                                                          "probe_sleep": lambda _s: None})
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "UPDATE_ROLLED_BACK"))
        self.assertIn("didn't start: the OpenClaw gateway exited (it is failed)", status["error"]["message"])
        ready = toolctl.read_json_file(self.host.paths["state_root"] + "/runs/%s/probes/gateway-start-ready.json" % RUN_ID)
        self.assertEqual((ready["state"], len(ready["attempts"])), ("failed", 1))

    def test_an_internal_error_after_the_stop_names_the_recovery(self):
        self.host.versioned_native()
        with mock.patch.object(toolctl.CoreUpdate, "needs_repair", side_effect=RuntimeError("boom")):
            status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "TOOLS_RUN_INTERNAL_ERROR"))
        self.assertEqual(status["error"]["nextAction"], "recover-native")
        self.assertIn("The OpenClaw gateway is stopped; run OpenClaw repair.", status["error"]["message"])

    def test_a_parked_native_polls_gently_and_never_while_the_package_is_absent(self):
        self.host.queue(action="update")
        roots = self.host.roots()
        run = toolctl.Run(roots, RUN_ID)
        run.init_status("openclaw")
        run.status["native"] = {}
        native = toolctl.NativeUpdate(roots, run, {}, self.host.base + "/usr/bin/node", toolctl.run_bounded, None,
                                      progress_seconds=0, activating_poll_seconds=3600)
        native.gateway_parked = True
        target = os.readlink(roots.openclaw_bin)
        os.unlink(roots.openclaw_bin)
        os.symlink(self.host.base + "/absent/openclaw.mjs", roots.openclaw_bin)  # the package dir is mid-swap
        native.tick(None)
        self.assertTrue(run.status["native"]["packageAbsent"])
        os.unlink(roots.openclaw_bin)
        os.symlink(target, roots.openclaw_bin)
        native.tick(None)  # within the gentle interval: no poll either
        self.assertNotIn("update status --json", self.host.calls())
        native.activating_poll_seconds = 0
        native.tick(None)
        self.assertIn("update status --json", self.host.calls())
        self.assertNotIn("packageAbsent", run.status["native"])


class ContractRollbackRuleTests(unittest.TestCase):
    def test_only_an_unusable_version_rolls_back(self):
        rule, core = toolctl.contract_needs_rollback, ["OC-READY", "OC-HELLO", "OC-CONFIG"]
        self.assertFalse(rule({"passed": core + ["OC-PLUG-ASK"], "failed": []}))
        self.assertFalse(rule({"passed": core, "failed": ["OC-PLUG-ASK"]}))
        for probe in core:
            rest = [p for p in core if p != probe]
            self.assertTrue(rule({"passed": rest + ["OC-PLUG-ASK"], "failed": [probe]}), probe)
            self.assertTrue(rule({"passed": rest, "failed": [probe, "OC-PLUG-ASK"]}), probe)
        # Fail closed: core probes not proven (not run) while the plugin failed, and a probe the rule doesn't know.
        self.assertTrue(rule({"passed": ["OC-READY"], "failed": ["OC-PLUG-ASK"]}))
        self.assertTrue(rule({"passed": core, "failed": ["OC-NEW"]}))


class InterruptedWhileParkedTests(HostTestCase):
    def test_a_runner_that_died_with_the_gateway_stopped_leaves_one_recovery_action(self):
        self.host.queue(action="update")
        run = toolctl.Run(self.host.roots(), RUN_ID)
        run.init_status("openclaw")
        toolctl.atomic_write_json(run.dir + "/preflight.json", {"facts": {"installedVersion": "2026.9.9",
                                                                          "target": {"version": "2026.10.9"}}})
        run.status["native"] = {"startedAt": toolctl.utc_now(), "phase": "activating"}
        run.status["gateway"] = {"unit": "openclaw-gateway.service", "actions": [], "stoppedByToolctl": True}
        run.transition("native", "running")
        outcome = toolctl.settle_interrupted_native(self.host.roots(), run, tools_lock_held=True, portal_lock_held=True)
        self.assertEqual(outcome["state"], "recovery-required")
        self.assertEqual((run.status["error"]["id"], run.status["error"]["nextAction"]), ("GATEWAY_LEFT_STOPPED", "recover-native"))


class NativeRuleTests(unittest.TestCase):
    # A recorded lastRun: a Control-UI attempt refused at `requested`.
    PROD = {"lastRun": {"runId": "d1", "status": "failed", "phase": "finished", "reason": "managed-service-handoff-failed",
                        "steps": [{"step": "requested", "status": "failed"},
                                  {"step": "installation-inspection", "status": "completed"},
                                  {"step": "notice:ack", "status": "completed"}]},
            "recoverySets": []}

    def test_pf3_a_handoff_refused_before_any_change_is_history(self):
        self.assertIsNone(toolctl.native_recovery_pending(self.PROD))

    def test_pf3_other_shapes_stay_recovery_pending(self):
        variants = {
            "recovery sets recorded": lambda d: d.update(recoverySets=[{"id": "s1"}]),
            "recovery sets unknown": lambda d: d.pop("recoverySets"),
            "reached activation": lambda d: d["lastRun"]["steps"].append({"step": "activating", "status": "failed"}),
            "requested completed": lambda d: d["lastRun"]["steps"][0].update(status="completed"),
            "another reason": lambda d: d["lastRun"].update(reason="update-recovery-pending"),
        }
        for name, change in variants.items():
            with self.subTest(name):
                doc = copy.deepcopy(self.PROD)
                change(doc)
                self.assertIsNotNone(toolctl.native_recovery_pending(doc))
                self.assertTrue(toolctl.native_last_run_pending(doc, doc["lastRun"]))

    def test_update_mode_thresholds(self):
        for installed, mode in (("2026.10.9", "live"), ("2026.9.9", "live"), ("2026.9.6", "live"), ("2026.9.5", "stopped"),
                                ("2026.9.3", "stopped"), (None, "stopped"), ("garbage", "stopped")):
            with self.subTest(installed):
                self.assertEqual(toolctl.update_mode_for(installed)["mode"], mode)

    def test_doctor_maintenance_pending_continues_into_repair(self):
        mapped = toolctl.map_native_outcome(0, maintenance_pending_result(), None, 0, "2026.9.9", "2026.10.9", "2026.10.9")
        self.assertEqual((mapped["state"], mapped["continue"], mapped["error"]["id"], mapped["error"]["nextAction"]),
                         ("recovery-required", True, "NATIVE_MAINTENANCE_PENDING", "recover-native"))

    def test_repair_warning_keeps_doctor_warnings_and_names_the_action(self):
        doc = {"status": "warning", "mode": "finalize", "restart": False, "postUpdate": {"doctor": {
            "status": "warning", "warnings": ["Doctor maintenance was deferred: GatewayStateOwnerContention"]}}}
        mapped = toolctl.map_native_repair(0, doc, None)
        self.assertEqual((mapped["state"], mapped["error"]["id"], mapped["error"]["nextAction"]),
                         ("recovery-required", "RECOVERY_INCOMPLETE", "recover-native"))
        self.assertEqual(mapped["error"]["message"],
                         "OpenClaw repair couldn't finish: Doctor maintenance was deferred: GatewayStateOwnerContention.")
        self.assertEqual(mapped["error"]["detail"]["warnings"], ["Doctor maintenance was deferred: GatewayStateOwnerContention"])
        bare = toolctl.map_native_repair(0, {"status": "warning"}, None)
        self.assertEqual((bare["error"]["message"], bare["error"]["nextAction"]),
                         ("OpenClaw repair couldn't finish: OpenClaw gave no reason.", "recover-native"))

    def test_native_postinstall_inventory_is_not_a_local_edit(self):
        base = tempfile.mkdtemp(prefix="toolctl-dist-")
        self.addCleanup(shutil.rmtree, base, True)
        write(base + "/dist/a.js", "aaaa")
        inventory = [{"path": "dist/a.js", "size": 4, "sha256": toolctl.sha256_file(base + "/dist/a.js")}]
        write(base + "/dist/postinstall-content-inventory.json", json.dumps(inventory))
        # Shipped by the stock 2026.10.9 and 2026.9.9 packages, not listed in the content inventory.
        write(base + "/dist/postinstall-inventory.json", json.dumps({"files": ["dist/a.js"]}))
        self.assertIs(toolctl.dist_override_estimate(base)["localEdits"], False)
        write(base + "/dist/b.js", "a local edit")
        self.assertIs(toolctl.dist_override_estimate(base)["localEdits"], True)


class PreflightFixesTests(HostTestCase):
    def test_pf3_passes_with_this_hosts_last_run(self):
        doc = json.loads(native_fixture("update-status.idle.json"))
        doc.update(copy.deepcopy(NativeRuleTests.PROD))
        self.host.reply("status", json.dumps(doc))
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])

    def test_pf6_npm_view_uses_a_private_home_under_tmpdir(self):
        seen = {}

        def runner(argv, timeout=15, env=None):
            seen.update(argv=argv, env=env)
            return 0, json.dumps(TARGET_META), ""

        roots = self.host.roots()
        os.makedirs(roots.state_root, mode=0o700, exist_ok=True)
        home = toolctl.npm_read_home(roots)
        meta = toolctl.resolve_target_metadata("openclaw@2026.10.9", runner=runner, home=home)
        self.assertEqual(meta["version"], "2026.10.9")
        self.assertEqual(seen["argv"][:2], ["npm", "view"])
        self.assertEqual((seen["env"]["HOME"], seen["env"]["npm_config_cache"]),
                         (roots.tmp_dir + "/npm-home", roots.tmp_dir + "/npm-home/.npm"))
        self.assertEqual(stat.S_IMODE(os.stat(home).st_mode), 0o700)
        with self.assertRaises(toolctl.ToolctlError):
            toolctl.resolve_target_metadata("openclaw@2026.10.9", runner=runner)

    def test_pf8_snapshots_on_the_npm_root_volume_and_the_canary_is_the_whole_state_dir(self):
        oc = self.host.paths["openclaw_state_dir"]
        write(oc + "/npm/projects/x/package.json", "n" * 3000)
        write(oc + "/extensions/y/index.js", "e" * 2000)
        roots = self.host.roots()
        npm = self.host.paths["npm_global_root"]
        real_stat = os.stat

        def fake_stat(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            return mock.Mock(st_dev=1 if str(path).startswith(npm) else 2, st_mode=info.st_mode, st_size=info.st_size)

        families = toolctl.sqlite_store_families(oc)
        total = sum(f["total"] for f in families)
        with mock.patch.object(toolctl.os, "stat", side_effect=fake_stat):
            plan = toolctl.disk_plan(roots, families, None, statvfs=FakeStatvfs())
        self.assertEqual(plan["canary"], total + 100 + 3000 + 2000)
        reasons = {v["path"]: [p["reason"] for p in v["parts"]] for v in plan["volumes"]}
        self.assertIn("native snapshots 2T + 3L + 64 MiB", reasons[npm])
        others = [r for path, rs in reasons.items() if path != npm for r in rs]
        self.assertNotIn("native snapshots 2T + 3L + 64 MiB", others)
        self.assertIn("canary copy of the OpenClaw state dir without *.bak (TMPDIR)", others)
        self.assertIn("source volume T_v + L_v + 64 MiB", others)
        self.assertIn("Doctor's .bak copy of each store, kept after the update", others)
        self.assertNotIn("Doctor's .bak copy of each store, kept after the update", reasons[npm])

    def test_pf8_arithmetic_with_the_k10_round_2_numbers(self):
        """One volume: 2T+3L+64 MiB 15.08 GB + canary (measured 8.4 GB) + Doctor .bak T 4.56 GB + 2 x package
        0.50 GB + margin 2.15 GB."""
        roots = self.host.roots()
        oc = self.host.paths["openclaw_state_dir"]
        t, largest = 4561068864, 1963738368
        rest = (t - largest) // 2  # two smaller stores
        families = [{"base": oc + "/agents/main/agent/openclaw-agent.sqlite", "total": largest, "dev": 7},
                    {"base": oc + "/agents/kernel/agent/openclaw-agent.sqlite", "total": rest, "dev": 7},
                    {"base": oc + "/state/openclaw.sqlite", "total": t - largest - rest, "dev": 7}]
        real_stat = os.stat

        def fake_stat(path, *args, **kwargs):
            info = real_stat(path, *args, **kwargs)
            return mock.Mock(st_dev=7, st_mode=info.st_mode, st_size=info.st_size)

        with mock.patch.object(toolctl.os, "stat", side_effect=fake_stat), \
                mock.patch.object(toolctl, "state_dir_bytes", return_value=8400000000) as walk:
            plan = toolctl.disk_plan(roots, families, {"unpackedSize": 250055860}, statvfs=FakeStatvfs())
        self.assertEqual(walk.call_args.kwargs, {"skip_suffixes": (".bak",)})
        self.assertEqual(len(plan["volumes"]), 1)
        parts = {p["reason"]: p["bytes"] for p in plan["volumes"][0]["parts"]}
        self.assertEqual(parts, {"native snapshots 2T + 3L + 64 MiB": 15080461696,
                                 "canary copy of the OpenClaw state dir without *.bak (TMPDIR)": 8400000000,
                                 "2 x package unpacked size": 500111720, "safety margin": 2147483648,
                                 "Doctor's .bak copy of each store, kept after the update": t})
        self.assertEqual(plan["volumes"][0]["required"], 30689125928)


if __name__ == "__main__":
    unittest.main()
