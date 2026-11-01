"""Unit tests for the harness section of installer/tools/bridgesllm-toolctl.py
(per-tool requalify/update; OpenCode, Grok Build, Antigravity, Ollama and Agent Zero in this build).

Run: python3 -I -m unittest discover -s installer/tools/tests -v
Temp dirs, a fake bubblewrap, a fake OpenCode ACP agent and a fake GitHub
fetch only: no root, no network, no real OpenCode.
"""

import ast
import copy
import errno
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

from tool_policy_fixture import unqualified_policy, unqualified_policy_text

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(TOOLS_DIR))
TOOLCTL_PATH = os.path.join(TOOLS_DIR, "bridgesllm-toolctl.py")
POLICY_PATH = os.path.join(TOOLS_DIR, "tool-policy.v2.json")
OPENCODE_HELPER = os.path.join(REPO, "installer", "opencode-runtime.sh")
ACP_PROFILES = os.path.join(REPO, "backend", "src", "agents", "providers", "native", "acp", "AcpHarnessProfiles.ts")

_spec = importlib.util.spec_from_file_location("bridgesllm_toolctl_harness", TOOLCTL_PATH)
toolctl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(toolctl)

UID = os.geteuid()
RUN_ID = "5d1e7c2a-9b44-4f0e-8a61-3c2d9e8f7a10"
NOW = "2026-10-31T00:30:00.000Z"
# The next step every recovery-required update names (Maintenance offers Re-check as the recovery's action).
RECHECK = ("Recovery is required: Re-check %s in Admin > Maintenance. It confirms which version is installed now, and "
           "if the check fails, the card shows the next step.")
REPOSITORY = "anomalyco/opencode"
ASSET = "opencode-linux-x64-baseline.tar.gz"

FAKE_SYSTEMD_RUN = r"""#!/usr/bin/python3 -I
import json, os, sys
FAKE = %(fake)r
argv = sys.argv[1:]
end = argv.index("--")
command = [arg.replace("$$", "$") for arg in argv[end + 1:]]
cwd = next((arg.split("=", 1)[1] for arg in argv[:end] if arg.startswith("--working-directory=")), "/")
first = next(i for i in range(2, len(command)) if "=" not in command[i])
program = command[command.index("--", first) + 1:]
self_test = os.path.basename(program[0]) == "setpriv" and program[1:] == ["--dump"]
with open(os.path.join(FAKE, "sandbox-self-test.log" if self_test else "sandbox-calls.log"), "a") as log:
    log.write(json.dumps(argv) + "\n")
if os.path.exists(os.path.join(FAKE, "fail-installed-probe")) and program[0].startswith(%(bindir)r):
    sys.exit(3)
os.chdir(cwd)
os.execv(command[0], command)
"""

# The privilege drop the probe sandbox runs in its service (setpriv to nobody:nogroup); the fake only records it and
# runs the program (the tests run without real namespaces). `--dump` is the sandbox self-test after the drop.
FAKE_SETPRIV = r"""#!/usr/bin/python3 -I
import json, os, sys
FAKE = %(fake)r
argv = sys.argv[1:]
if argv == ["--dump"]:
    print("uid: 65534\neuid: 65534\ngid: 65534\negid: 65534\nSupplementary groups: [none]\nno_new_privs: 1\n"
          "Inheritable capabilities: [none]\nAmbient capabilities: [none]\nCapability bounding set: [none]")
    sys.exit(0)
with open(os.path.join(FAKE, "setpriv-calls.log"), "a") as log:
    log.write(json.dumps(argv) + "\n")
program = argv[argv.index("--") + 1:]
os.execv(program[0], program)
"""


def sandbox_command(argv):
    """What a recorded probe sandbox's service runs (after systemd-run's `--`), with systemd's $$ escaping undone."""
    return [arg.replace("$$", "$") for arg in argv[argv.index("--") + 1:]]


def boxed(argv):
    """The program a recorded probe sandbox runs: after env -i and its assignments, setpriv's whole drop, and its `--`."""
    command = sandbox_command(argv)
    assert os.path.basename(command[0]) == "env" and command[1] == "-i", argv
    first = next(i for i in range(2, len(command)) if "=" not in command[i])
    drop = command.index("--", first)
    assert os.path.basename(command[first]) == "setpriv" and command[first + 1:drop] == list(toolctl.SANDBOX_DROP), argv
    return command[drop + 1:]


def sandbox_env(argv):
    """The whole environment (env -i) of a recorded probe sandbox."""
    command = sandbox_command(argv)
    first = next(i for i in range(2, len(command)) if "=" not in command[i])
    return dict(arg.split("=", 1) for arg in command[2:first])


def sandbox_binds(argv, kind):
    """(source, destination) of every `kind` (BindPaths / BindReadOnlyPaths) property of the probe's service."""
    prefix = "--property=%s=" % kind
    return [tuple(arg[len(prefix):].split(":", 1)) for arg in argv[:argv.index("--")] if arg.startswith(prefix)]


def sandbox_confined(argv):
    """The service is the probe sandbox: host read-only, no network, /run hidden, no identity or user namespace from
    systemd (setpriv drops to a real host uid), and env -i's environment only."""
    end = argv.index("--")
    properties = [arg[len("--property="):] for arg in argv[:end] if arg.startswith("--property=")]
    return ({"--quiet", "--wait", "--pipe", "--collect"} <= set(argv[:end]) and {"ProtectSystem=strict",
            "PrivateNetwork=yes", "TemporaryFileSystem=/run", "NoNewPrivileges=yes"} <= set(properties)
            and not [p for p in properties if p.startswith(("User=", "DynamicUser=", "PrivateUsers="))]
            and sandbox_command(argv)[1] == "-i")

# A fake OpenCode: `--version` and an ACP agent on stdio. MODE comes from the
# binary itself so the candidate and the installed copy can differ.
FAKE_OPENCODE = r"""#!/usr/bin/python3 -I
import json, sys, time
VERSION, MODE = %(version)r, %(mode)r
if sys.argv[1:] == ["--version"]:
    print(VERSION)
    sys.exit(0)
if sys.argv[1:2] == ["acp"]:
    for line in sys.stdin:
        msg = json.loads(line)
        if msg.get("method") == "initialize":
            caps = {"loadSession": True, "promptCapabilities": {"image": True}, "mcpCapabilities": {"http": True},
                    "sessionCapabilities": {"close": {}, "list": {}, "resume": {}, "fork": {}}}
            if MODE == "no-fork":
                del caps["sessionCapabilities"]["fork"]
            result = {"protocolVersion": 1, "agentInfo": {"name": "OpenCode", "version": VERSION},
                      "agentCapabilities": caps, "authMethods": [{"id": "opencode-login"}]}
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
        elif msg.get("method") == "session/new":
            if MODE == "hang":
                time.sleep(30)
            print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "id": 99, "method": "fs/read_text_file", "params": {}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "ses_0123abc"}}), flush=True)
    sys.exit(0)
sys.exit(2)
"""


def opencode_text(version, mode="ok"):
    return FAKE_OPENCODE % {"version": version, "mode": mode}


def archive_bytes(members):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        for name, text in members:
            data = text.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o755
            bundle.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def load_json(path):
    with open(path) as handle:
        return json.load(handle)


class FakeGitHub(object):
    """URL -> bytes; unknown URLs answer 404 like GitHub."""

    def __init__(self):
        self.responses, self.calls = {}, []

    def release(self, version, archive, digest=True, extra=None):
        doc = {"tag_name": "v" + version, "draft": False, "prerelease": False, "assets": [{
            "name": ASSET, "size": len(archive),
            "browser_download_url": "https://github.com/%s/releases/download/v%s/%s" % (REPOSITORY, version, ASSET)}]}
        if digest:
            doc["assets"][0]["digest"] = "sha256:" + hashlib.sha256(archive).hexdigest()
        doc.update(extra or {})
        self.responses["%s/repos/%s/releases/tags/v%s" % (toolctl.GITHUB_API, REPOSITORY, version)] = json.dumps(doc).encode()
        self.responses[doc["assets"][0]["browser_download_url"]] = archive
        return doc

    def __call__(self, url, dest, max_bytes):
        self.calls.append(url)
        if url not in self.responses:
            raise toolctl.HarnessRefusal("HARNESS_SOURCE_UNAVAILABLE", "%s answered HTTP 404." % url, {"httpStatus": 404})
        body = self.responses[url][:max_bytes]
        if dest is None:
            return body
        with open(dest, "xb") as handle:
            handle.write(body)
        return len(body)


class HarnessHost(unittest.TestCase):
    """A fake host: OpenCode 1.19.4 in the managed layout, fake systemd-run, private state."""

    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="toolctl-harness-")
        self.addCleanup(shutil.rmtree, self.base, True)
        b = self.base
        self.fake = os.path.join(b, "fake")
        os.makedirs(self.fake)
        bins = os.path.join(b, "fakebin")
        os.makedirs(bins)
        self.bin_dir = os.path.join(b, "usr/local/bin")
        with open(os.path.join(bins, "systemd-run"), "w") as handle:
            handle.write(FAKE_SYSTEMD_RUN % {"fake": self.fake, "bindir": self.bin_dir})
        os.chmod(os.path.join(bins, "systemd-run"), 0o755)
        with open(os.path.join(bins, "setpriv"), "w") as handle:
            handle.write(FAKE_SETPRIV % {"fake": self.fake})
        os.chmod(os.path.join(bins, "setpriv"), 0o755)
        self.runtimes = os.path.join(b, "usr/local/lib/bridgesllm-runtimes")
        self.root = os.path.join(self.runtimes, "opencode")
        for d in (self.bin_dir, self.root, os.path.join(b, "var/lib/bridgesllm")):
            os.makedirs(d)
        for d in (os.path.join(b, "usr"), os.path.join(b, "usr/local"), os.path.join(b, "usr/local/lib"), self.runtimes,
                  self.root, self.bin_dir):
            os.chmod(d, 0o755)
        self.install_version("1.19.4")
        os.symlink(os.path.join(self.root, "1.19.4", "opencode"), os.path.join(self.bin_dir, "opencode"))
        values = {name: default for name, (_env, default) in toolctl.DEFAULTS.items()}
        values.update(state_root=os.path.join(b, "var/lib/bridgesllm/tools"), systemd_unit_dirs=[os.path.join(b, "units")])
        self.roots = toolctl.Roots(**values)
        self.roots.systemd_run_bin = os.path.join(bins, "systemd-run")
        self.roots.setpriv_bin = os.path.join(bins, "setpriv")
        self.roots.harness_runtime_root = self.runtimes
        self.roots.harness_bin_dir = self.bin_dir
        # Fake downloads never match a real qualified digest: every recommended version starts proposed, in memory
        # and in the policy file toolctl itself reads.
        self.roots.policy_path = os.path.join(b, "tool-policy.v2.json")
        with open(self.roots.policy_path, "w", encoding="utf-8") as handle:
            handle.write(unqualified_policy_text())
        toolctl.ensure_state_dirs(self.roots)
        self.policy = unqualified_policy()
        self.github = FakeGitHub()

    def install_version(self, version, mode="ok"):
        directory = os.path.join(self.root, version)
        os.makedirs(directory)
        os.chmod(directory, 0o755)
        path = os.path.join(directory, "opencode")
        with open(path, "w") as handle:
            handle.write(opencode_text(version, mode))
        os.chmod(path, 0o755)
        return path

    def run_action(self, action, target=None, tool="opencode"):
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status(tool)
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": tool, "action": action}
        if target is not None:
            request["target"] = target
        self.assertEqual(toolctl.validate_request(request, RUN_ID, self.policy), [])
        status = toolctl.execute_harness_run(self.roots, run, self.policy, request, fetch=self.github, uid=UID,
                                             machine="x86_64", now=lambda: NOW)
        return run, status

    def run_entry(self, target="recommended", tool="opencode", action="update"):
        """The runner entry (`toolctl run <id>`): cmd_run executes the queued run and settles an internal error."""
        self.roots.portal_operation_lock = os.path.join(self.base, "portal-operation.lock")
        self.roots.installer_state_root = os.path.join(self.base, "installer-state")
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        toolctl.atomic_write_json(os.path.join(run.dir, "request.json"), {
            "schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": tool, "action": action, "target": target})
        host = {"fetch": self.github, "uid": UID, "machine": "x86_64", "now": lambda: NOW}
        execute, settle = toolctl.execute_harness_run, toolctl.harness_reconcile_run
        with mock.patch.object(toolctl, "execute_harness_run", lambda *a, **k: execute(*a, **dict(k, **host))), \
                mock.patch.object(toolctl, "harness_reconcile_run", lambda *a, **k: settle(*a, **dict(k, **host))):
            status = toolctl.cmd_run(self.roots, RUN_ID)
        self.assertEqual(toolctl.read_json_file(os.path.join(run.dir, "status.json"))["state"], status["state"])
        self.assertEqual(toolctl.read_history(self.roots)[-1]["outcome"], status["state"])
        self.assertIsNone(toolctl.lock_holder(self.roots))
        return status

    def update_failing_once(self, name, when=lambda *args: True, **entry):
        """run_entry with toolctl.<name> (or Run.save) raising a disk-full OSError the first time `when(*args)` holds."""
        owner = toolctl.Run if name == "save" else toolctl
        original, raised = getattr(owner, name), []

        def fail_once(*args, **kwargs):
            if not raised and when(*args):
                raised.append(True)
                raise OSError(errno.ENOSPC, "No space left on device")
            return original(*args, **kwargs)
        with mock.patch.object(owner, name, fail_once):
            return self.run_entry(**entry)

    @staticmethod
    def swap_state_is(state):
        return lambda run: (run.status.get("swap") or {}).get("state") == state

    def link_target(self):
        return os.path.realpath(os.path.join(self.bin_dir, "opencode"))

    def record_path(self):
        return os.path.join(self.roots.state_root, "admission", "opencode.json")

    def assert_refused(self, status, code):
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", code), status["error"])
        self.assertFalse(os.path.exists(self.record_path()), "no record may be written on a refusal")
        self.assertEqual(self.link_target(), os.path.join(self.root, "1.19.4", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4"], "nothing may be left in the runtime root")


class RequalifyTests(HarnessHost):
    def test_admits_the_official_binary_and_runs_both_probes_in_the_sandbox(self):
        self.github.release("1.19.4", archive_bytes([("opencode", opencode_text("1.19.4"))]))
        _run, status = self.run_action("requalify")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]],
                         ["installed", "resolve", "fetch", "verify-source", "compare", "probe", "commit"])
        record = load_json(self.record_path())
        self.assertEqual((record["schema"], record["toolId"], record["version"], record["admittedBy"], record["admittedAt"]),
                         (toolctl.SCHEMA_HARNESS_RECORD, "opencode", "1.19.4", "requalify:" + RUN_ID, NOW))
        binary = os.path.join(self.root, "1.19.4", "opencode")
        self.assertEqual(record["executables"]["opencode"], {"path": binary, "sha256": toolctl.sha256_file(binary)})
        self.assertEqual(record["probes"], {"passed": ["C-VER", "C-ACP"], "failed": [], "notRun": []})
        self.assertEqual((record["source"]["authority"], record["source"]["provenDigestMatch"]), ("github-asset-digest", None))
        self.assertEqual(stat.S_IMODE(os.stat(self.record_path()).st_mode), 0o600)
        with open(os.path.join(self.fake, "sandbox-calls.log")) as handle:
            calls = [json.loads(line) for line in handle]
        self.assertEqual(len(calls), 2)
        for argv in calls:
            self.assertTrue(sandbox_confined(argv), argv)
            boxed(argv)
            self.assertEqual(sandbox_env(argv)["HOME"], "/tmp/home")
            self.assertEqual(sandbox_env(argv)["OPENCODE_DISABLE_AUTOUPDATE"], "1")
        self.assertEqual(boxed(calls[1])[1:], toolctl.HARNESS_SPECS["opencode"]["acp"]["args"])

    def test_a_binary_that_is_not_the_release_is_refused_with_update_offered(self):
        self.github.release("1.19.4", archive_bytes([("opencode", opencode_text("1.19.4") + "# other build\n")]))
        _run, status = self.run_action("requalify")
        self.assert_refused(status, "HARNESS_BINARY_DIFFERS")
        self.assertEqual(status["error"]["nextAction"], "update-recommended")

    def test_a_release_without_a_recorded_digest_is_unverifiable(self):
        self.github.release("1.19.4", archive_bytes([("opencode", opencode_text("1.19.4"))]), digest=False)
        _run, status = self.run_action("requalify")
        self.assert_refused(status, "HARNESS_SOURCE_UNVERIFIABLE")
        self.assertIn("cannot be verified", status["error"]["message"])

    def test_an_archive_with_more_than_the_program_is_refused(self):
        self.github.release("1.19.4", archive_bytes([("opencode", opencode_text("1.19.4")), ("extra", "x")]))
        _run, status = self.run_action("requalify")
        self.assert_refused(status, "HARNESS_ARCHIVE_UNEXPECTED")

    def test_a_missing_capability_fails_the_acp_probe(self):
        os.unlink(os.path.join(self.root, "1.19.4", "opencode"))
        shutil.rmtree(os.path.join(self.root, "1.19.4"))
        self.install_version("1.19.4", mode="no-fork")
        self.github.release("1.19.4", archive_bytes([("opencode", opencode_text("1.19.4", "no-fork"))]))
        _run, status = self.run_action("requalify")
        self.assert_refused(status, "CLI_PROBE_FAILED")
        self.assertIn("sessionCapabilities.fork", status["error"]["message"])
        self.assertEqual(status["error"]["detail"]["probe"]["id"], "C-ACP")

    def test_an_unmanaged_launcher_is_never_touched(self):
        os.unlink(os.path.join(self.bin_dir, "opencode"))
        with open(os.path.join(self.bin_dir, "opencode"), "w") as handle:
            handle.write("#!/bin/sh\n")
        _run, status = self.run_action("requalify")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_LAYOUT_UNMANAGED"))
        self.assertEqual(self.github.calls, [])

    def test_not_installed_is_a_plain_refusal(self):
        os.unlink(os.path.join(self.bin_dir, "opencode"))
        _run, status = self.run_action("requalify")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_TOOL_ABSENT"))
        self.assertEqual(status["error"]["message"], "OpenCode is not installed on this server (%s is missing). Install "
                         "it from its card in Admin > Maintenance." % os.path.join(self.bin_dir, "opencode"))


class UpdateTests(HarnessHost):
    def candidate(self, version="1.19.5", mode="ok", **kwargs):
        return self.github.release(version, archive_bytes([("opencode", opencode_text(version, mode))]), **kwargs)

    def test_update_switches_atomically_and_keeps_the_previous_version(self):
        self.candidate()
        _run, status = self.run_action("update", "recommended")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]],
                         ["installed", "resolve", "fetch", "verify-source", "probe-candidate", "swap", "probe-installed",
                          "commit", "cleanup"])
        self.assertEqual((status["result"]["from"], status["result"]["to"], status["result"]["admittedBy"]),
                         ("1.19.4", "1.19.5", "run:" + RUN_ID))
        self.assertEqual(self.link_target(), os.path.join(self.root, "1.19.5", "opencode"))
        self.assertEqual(os.readlink(os.path.join(self.bin_dir, "opencode")), os.path.join(self.root, "1.19.5", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4", "1.19.5"], "N-1 is kept for swap-back")
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.root, "1.19.5", "opencode")).st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.root, "1.19.5")).st_mode), 0o755)
        self.assertEqual(load_json(self.record_path())["version"], "1.19.5")
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))
        self.assertEqual(status["swap"]["state"], "committed")
        self.assertEqual([p["target"] for p in load_json(os.path.join(_run.dir, "harness-update.json"))["probes"]],
                         ["candidate", "candidate", "installed", "installed"])

    def test_a_second_update_removes_versions_older_than_the_previous_one(self):
        self.install_version("1.19.3")
        self.candidate()
        _run, status = self.run_action("update", "1.19.5")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4", "1.19.5"])

    def test_newest_is_not_offered_and_nothing_is_looked_up(self):
        # 5.2.0: a harness tool updates only to the version this Portal release qualified.
        self.candidate("1.19.6")
        self.github.responses["%s/repos/%s/releases/latest" % (toolctl.GITHUB_API, REPOSITORY)] = b'{"tag_name": "v1.19.6"}'
        _run, status = self.run_action("update", "newest")
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["message"]),
                         ("refused", "NEWEST_NOT_OFFERED", "This tool updates only to the version this Portal release qualified."))
        self.assertEqual(self.github.calls, [], "nothing may be looked up or downloaded")

    def test_a_digest_mismatch_changes_nothing(self):
        doc = self.candidate()
        url = doc["assets"][0]["browser_download_url"]
        self.github.responses[url] = archive_bytes([("opencode", opencode_text("1.19.5") + "#tampered\n")])
        self.github.responses["%s/repos/%s/releases/tags/v1.19.5" % (toolctl.GITHUB_API, REPOSITORY)] = json.dumps(
            dict(doc, assets=[dict(doc["assets"][0], size=len(self.github.responses[url]))])).encode()
        _run, status = self.run_action("update", "recommended")
        self.assert_refused(status, "HARNESS_DIGEST_MISMATCH")

    def test_a_failing_candidate_changes_nothing(self):
        self.candidate(mode="no-fork")
        _run, status = self.run_action("update", "recommended")
        self.assert_refused(status, "CLI_PROBE_FAILED")
        self.assertIn("before installation", status["error"]["message"])

    def test_a_hanging_agent_fails_within_the_probe_budget(self):
        self.candidate(mode="hang")
        saved = toolctl.ACP_PROBE_TIMEOUT
        toolctl.ACP_PROBE_TIMEOUT = 2
        self.addCleanup(setattr, toolctl, "ACP_PROBE_TIMEOUT", saved)
        _run, status = self.run_action("update", "recommended")
        self.assert_refused(status, "CLI_PROBE_FAILED")
        self.assertIn("session/new was not answered within 2 s", status["error"]["message"])

    def test_an_installed_probe_failure_swaps_back(self):
        self.candidate()
        with open(os.path.join(self.fake, "fail-installed-probe"), "w"):
            pass
        _run, status = self.run_action("update", "recommended")
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "HARNESS_SWAPPED_BACK"), status["error"])
        self.assertEqual(self.link_target(), os.path.join(self.root, "1.19.4", "opencode"))
        self.assertEqual(os.readlink(os.path.join(self.bin_dir, "opencode")), os.path.join(self.root, "1.19.4", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4"])
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))

    def test_targets_that_are_current_older_or_below_the_floor_are_refused(self):
        for target, code in (("1.19.4", "HARNESS_ALREADY_CURRENT"), ("1.19.3", "HARNESS_VERSION_NOT_ADMISSIBLE")):
            _run, status = self.run_action("update", target)
            self.assert_refused(status, code)
            shutil.rmtree(_run.dir)
        self.assertEqual(self.github.calls, [])

    def test_a_prerelease_is_refused(self):
        self.candidate(extra={"prerelease": True})
        _run, status = self.run_action("update", "recommended")
        self.assert_refused(status, "HARNESS_VERSION_NOT_ADMISSIBLE")

    def test_a_qualified_newest_proven_must_match_its_recorded_digest(self):
        self.candidate()
        tool = toolctl.policy_tool(self.policy, "opencode")
        tool["newestProven"].update(status="qualified", integrity={"x86_64": "sha256:" + "0" * 64})
        _run, status = self.run_action("update", "recommended")
        self.assert_refused(status, "HARNESS_PROVEN_DIGEST_MISMATCH")

    def test_a_stop_before_the_switch_changes_nothing(self):
        self.candidate()
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("opencode")
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "opencode", "action": "update",
                   "target": "recommended"}

        class Stop(object):
            def __bool__(self):
                return True

            def record(self):
                return {"signal": "SIGTERM"}
        status = toolctl.execute_harness_run(self.roots, run, self.policy, request, stop=Stop(), fetch=self.github, uid=UID,
                                             machine="x86_64", now=lambda: NOW)
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_STOPPED"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4"])


class NextActionLoopTests(HarnessHost):
    """No harness flow installs the version it already has, so a failed re-check offers an update only below
    the recommended version and the re-check otherwise; each offered action runs without "already current"."""

    def again(self, action, target=None):
        shutil.rmtree(os.path.join(self.roots.runs_dir, RUN_ID), ignore_errors=True)
        return self.run_action(action, target)[1]

    def test_every_offered_next_action_is_admitted(self):
        expected = {("binary", "1.19.5"): "update-recommended", ("binary", "1.19.4"): "requalify",
                    ("binary", "1.19.3"): "requalify", ("probe", "1.19.5"): "update-recommended",
                    ("probe", "1.19.4"): "requalify", ("probe", "1.19.3"): "requalify"}
        first = True
        for (state, recommended), next_action in sorted(expected.items()):
            with self.subTest(state=state, recommended=recommended):
                if not first:
                    self.setUp()
                first = False
                tool = toolctl.policy_tool(self.policy, "opencode")
                tool["floor"], tool["newestProven"]["version"] = "1.19.3", recommended
                if state == "binary":
                    self.github.release("1.19.4", archive_bytes([("opencode", opencode_text("1.19.4") + "# other build\n")]))
                    code = "HARNESS_BINARY_DIFFERS"
                else:
                    os.unlink(os.path.join(self.root, "1.19.4", "opencode"))
                    shutil.rmtree(os.path.join(self.root, "1.19.4"))
                    self.install_version("1.19.4", mode="no-fork")
                    self.github.release("1.19.4", archive_bytes([("opencode", opencode_text("1.19.4", "no-fork"))]))
                    code = "CLI_PROBE_FAILED"
                status = self.again("requalify")
                self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                                 ("refused", code, next_action))
                if next_action == "update-recommended":
                    self.github.release("1.19.5", archive_bytes([("opencode", opencode_text("1.19.5"))]))
                    after = self.again("update", "recommended")
                    self.assertEqual((after["state"], after["result"]["to"]), ("succeeded", "1.19.5"), after.get("error"))
                else:
                    after = self.again("requalify")
                    self.assertEqual((after["state"], after["error"]["id"]), ("refused", code))
                    # The update it does not offer would be refused (already current, or a downgrade).
                    refused = self.again("update", "recommended")
                    self.assertIn(refused["error"]["id"], ("HARNESS_ALREADY_CURRENT", "HARNESS_DOWNGRADE_REFUSED"))


class ReconcileTests(HarnessHost):
    def interrupted_update(self, crash_in):
        """Run an update that dies (like a killed runner) inside `crash_in`."""
        self.github.release("1.19.5", archive_bytes([("opencode", opencode_text("1.19.5"))]))
        original = getattr(toolctl, crash_in)

        def crash(*args, **kwargs):
            raise KeyboardInterrupt()
        setattr(toolctl, crash_in, crash)
        try:
            with self.assertRaises(KeyboardInterrupt):
                self.run_action("update", "recommended")
        finally:
            setattr(toolctl, crash_in, original)
        run = toolctl.Run(self.roots, RUN_ID)
        run.load()
        return run

    def test_crash_after_the_switch_is_checked_and_committed(self):
        run = self.interrupted_update("versioned_finish_swap")
        self.assertEqual(run.status["swap"]["state"], "swapped")
        settled = toolctl.harness_reconcile_run(self.roots, run, self.policy, fetch=self.github, uid=UID, machine="x86_64",
                                                now=lambda: NOW)
        self.assertEqual(settled["state"], "succeeded", run.status.get("error"))
        self.assertEqual(load_json(self.record_path())["version"], "1.19.5")
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4", "1.19.5"])

    def test_crash_before_the_launcher_moved_changes_nothing(self):
        run = self.interrupted_update("_replace_symlink")
        self.assertEqual(run.status["swap"]["state"], "linking")
        settled = toolctl.harness_reconcile_run(self.roots, run, self.policy, uid=UID, machine="x86_64")
        self.assertEqual(settled["state"], "failed")
        self.assertEqual(run.status["error"]["id"], "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE")
        self.assertEqual(self.link_target(), os.path.join(self.root, "1.19.4", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4"])
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))

    def test_cmd_reconcile_settles_an_interrupted_harness_switch(self):
        self.interrupted_update("_replace_symlink")
        settled = toolctl.cmd_reconcile(self.roots)
        self.assertEqual([s["state"] for s in settled], ["failed"])

    def test_a_restarted_runner_settles_the_switch_instead_of_redoing_it(self):
        self.interrupted_update("_replace_symlink")
        status = toolctl.cmd_run(self.roots, RUN_ID)
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE"))
        self.assertEqual(self.link_target(), os.path.join(self.root, "1.19.4", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4"])


class SwitchErrorTests(HarnessHost):
    """An in-process error after the switch began is settled by the crash rules, never reported as nothing changed."""

    def setUp(self):
        super().setUp()
        self.github.release("1.19.5", archive_bytes([("opencode", opencode_text("1.19.5"))]))

    def assert_old_version_live(self):
        self.assertEqual(self.link_target(), os.path.join(self.root, "1.19.4", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4"])
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))

    def test_an_error_after_the_launcher_moved_is_checked_again_and_committed(self):
        status = self.update_failing_once("save", self.swap_state_is("swapped"))
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["reconciled"], "checked and committed after the interruption")
        self.assertEqual((status["internalError"]["phase"], status["internalError"]["swapState"]), ("swap", "swapped"))
        self.assertEqual(self.link_target(), os.path.join(self.root, "1.19.5", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.4", "1.19.5"])
        self.assertEqual((load_json(self.record_path())["version"], load_json(self.record_path())["admittedBy"]),
                         ("1.19.5", "run:" + RUN_ID))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))

    def test_an_error_after_the_launcher_moved_swaps_back_when_the_check_fails(self):
        with open(os.path.join(self.fake, "fail-installed-probe"), "w"):
            pass
        status = self.update_failing_once("save", self.swap_state_is("swapped"))
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "HARNESS_SWAPPED_BACK"), status["error"])
        self.assert_old_version_live()
        self.assertFalse(os.path.exists(self.record_path()))

    def test_an_error_while_committing_is_checked_again_and_committed(self):
        status = self.update_failing_once("write_harness_record")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual((status["internalError"]["phase"], status["internalError"]["swapState"]), ("commit", "committing"))
        self.assertEqual(load_json(self.record_path())["version"], "1.19.5")
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))

    def test_an_error_while_switching_the_launcher_removes_the_new_version(self):
        # The new version dir is placed and fenced; the launcher never moved.
        status = self.update_failing_once("_replace_symlink")
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE"),
                         status["error"])
        self.assertEqual((status["internalError"]["phase"], status["internalError"]["swapState"]), ("swap", "linking"))
        self.assert_old_version_live()
        self.assertFalse(os.path.exists(self.record_path()))

    def test_an_error_that_keeps_raising_after_the_switch_needs_recovery(self):
        with mock.patch.object(toolctl, "write_harness_record", side_effect=OSError(errno.EIO, "I/O error")):
            status = self.run_entry()
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "TOOLS_RUN_INTERNAL_ERROR"))
        self.assertEqual(status["error"]["message"], "The opencode update stopped on an internal error while it was "
                         "switching versions, and the switch could not be settled. " + RECHECK % "OpenCode")
        detail = status["error"]["detail"]
        self.assertEqual((detail["phase"], detail["swapState"]), ("commit", "committing"))
        self.assertTrue(detail["reason"].startswith("OSError: ") and detail["settleReason"].startswith("OSError: "), detail)
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))
        self.assertFalse(os.path.exists(self.record_path()))

    def test_an_error_before_the_switch_began_is_a_failure_that_changed_nothing(self):
        with mock.patch.object(toolctl, "harness_probe_set", side_effect=RuntimeError("a probe bug")):
            status = self.run_entry()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_INTERNAL_ERROR"))
        self.assertIn("before it changed anything", status["error"]["message"])
        self.assertEqual(status["error"]["detail"]["phase"], "probe-candidate")
        self.assertNotIn("swap", status)
        self.assertNotIn("internalError", status)
        self.assert_old_version_live()


class RequestTests(HarnessHost):
    def test_only_requalify_and_update_are_accepted(self):
        for action in ("preflight", "recover-native", "retry-checks"):
            request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "opencode", "action": action}
            self.assertTrue(toolctl.validate_request(request, RUN_ID, self.policy), action)
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "opencode", "action": "update", "target": "beta"}
        self.assertTrue(toolctl.validate_request(request, RUN_ID, self.policy))
        # The Maintenance route writes a target for every action (default "recommended").
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "opencode", "action": "requalify",
                   "target": "recommended", "channel": None}
        self.assertEqual(toolctl.validate_request(request, RUN_ID, self.policy), [])

    def test_newest_is_refused_for_every_harness_tool_before_any_lookup(self):
        # 5.2.0: only the npm CLIs update to the newest release; every harness tool's helpers run the candidate as
        # root outside the probe sandbox, so it updates only to the version this Portal release qualified.
        for tool in toolctl.HARNESS_TOOL_IDS:
            _run, status = self.run_action("update", target="newest", tool=tool)
            self.assertEqual((status["state"], status["error"]["id"], status["error"]["message"]),
                             ("refused", "NEWEST_NOT_OFFERED", "This tool updates only to the version this Portal release qualified."), tool)
            self.assertEqual(status["steps"], [], tool)
            shutil.rmtree(_run.dir)
        self.assertEqual(self.github.calls, [], "nothing may be looked up or downloaded")
        self.assertEqual(set(toolctl.NPM_TOOL_IDS) & set(toolctl.HARNESS_TOOL_IDS), set(), "npm CLIs keep newest")

    def test_a_harness_that_is_not_installed_is_refused_plainly(self):
        for action, target in (("update", "recommended"), ("requalify", None)):  # Hermes runs in this build; not on this host
            _run, status = self.run_action(action, target=target, tool="hermes")
            self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_TOOL_ABSENT"), action)
            self.assertTrue(status["error"]["message"].startswith("Hermes is not installed on this server ("),
                            status["error"]["message"])
            self.assertTrue(status["error"]["message"].endswith(
                ". Install it from its card in Admin > Maintenance."), status["error"]["message"])
            shutil.rmtree(_run.dir)

    def test_fetch_refuses_anything_but_official_https_hosts(self):
        for url in ("http://github.com/x", "https://example.com/x", "https://github.com.evil.test/x"):
            with self.assertRaises(toolctl.HarnessRefusal) as caught:
                toolctl.https_fetch(url, None, 10)
            self.assertEqual(caught.exception.code, "HARNESS_SOURCE_ORIGIN")


class LockstepTests(unittest.TestCase):
    """HARNESS_SPECS mirrors the installer helper and the backend ACP profile."""

    def test_opencode_assets_and_environment_match_the_installer_helper(self):
        with open(OPENCODE_HELPER) as handle:
            helper = handle.read()
        spec = toolctl.HARNESS_SPECS["opencode"]
        for arch, variable in (("x86_64", "OPENCODE_ASSET_X86_64"), ("aarch64", "OPENCODE_ASSET_AARCH64")):
            self.assertIn('readonly %s="%s"' % (variable, spec["assets"][arch]), helper)
        for name in spec["env"]:
            self.assertIn("%s=1" % name, helper)
        self.assertIn("/usr/local/lib/bridgesllm-runtimes/opencode", helper)

    def test_opencode_acp_launch_matches_the_backend_profile(self):
        with open(ACP_PROFILES) as handle:
            text = handle.read()
        block = text[text.index("export const OPENCODE_ACP_PROFILE"):]
        block = block[:block.index("} satisfies AcpHarnessProfile")]
        spec = toolctl.HARNESS_SPECS["opencode"]["acp"]
        args = re.search(r"buildArgs: \(\{ cwd \}\) => \[(.*?)\]", block, re.S).group(1)
        literals = [a.strip().strip("'") for a in args.split(",") if a.strip()]
        self.assertEqual([("/tmp" if a == "cwd" else a) for a in literals], spec["args"])
        self.assertIn("expectedAgentName: '%s'" % spec["agentName"], block)
        capabilities = re.search(r"requiredCapabilities: \[(.*?)\]", block, re.S).group(1)
        self.assertEqual(re.findall(r"'([^']+)'", capabilities), spec["capabilities"])
        self.assertIn("protocolVersion: 1", block)

    def test_policy_lists_every_harness_tool(self):
        policy = load_json(POLICY_PATH)
        for tool_id in toolctl.HARNESS_TOOL_IDS:
            self.assertIsNotNone(toolctl.policy_tool(policy, tool_id), tool_id)
        self.assertEqual(toolctl.policy_tool(policy, "opencode")["source"]["repository"], REPOSITORY)


# Vendor single-file programs. Fake Grok Build: `--version` and an ACP agent
# that reports its version in `_meta`, has no image input and needs a login.
FAKE_GROK = r"""#!/usr/bin/python3 -I
import json, sys
VERSION, MODE = %(version)r, %(mode)r
args = sys.argv[1:]
if args in (["--no-auto-update", "--version"], ["--version"]):
    print("grok " + VERSION)
    sys.exit(0)
if args[:2] == ["--no-auto-update", "agent"]:
    for line in sys.stdin:
        msg = json.loads(line)
        if msg.get("method") == "initialize":
            caps = {"loadSession": True, "promptCapabilities": {"image": MODE == "image"}, "mcpCapabilities": {"http": True, "sse": True}}
            result = {"protocolVersion": 1, "agentCapabilities": caps, "authMethods": [], "_meta": {"agentVersion": VERSION}}
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
        elif msg.get("method") == "session/new":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32000, "message": "Authentication required"}}), flush=True)
    sys.exit(0)
sys.exit(2)
"""

FAKE_AGY = r"""#!/usr/bin/python3 -I
import sys
VERSION, MODE = %(version)r, %(mode)r
if sys.argv[1:] == ["--version"]:
    print("Antigravity CLI")
    print(VERSION)
    sys.exit(0)
sys.exit(2)
"""

# The installer helper's converge, as far as toolctl relies on it: install
# $FAKE/<exe>.new at <bin dir>/<exe> with one rename, or fail.
FAKE_HELPER = r"""#!/bin/bash
set -Eeuo pipefail
FAKE=%(fake)r
bin_dir="${%(env)s:?}"
mode="$(cat "${FAKE}/helper-mode" 2>/dev/null || echo ok)"
[[ "$1" == converge ]] || exit 2
echo "$*" >> "${FAKE}/helper-calls.log"
# Like the real helpers: a program that already reports the tested version is kept as it is.
if "${bin_dir}/%(exe)s" %(verargs)s 2>/dev/null | grep -qx "%(pinned_line)s"; then echo "already verified"; exit 0; fi
if [[ "${mode}" == fail-before ]]; then echo "Could not download the pinned artifact." >&2; exit 1; fi
if [[ "${mode}" == place-nothing ]]; then echo "installed"; exit 0; fi
if [[ "${mode}" == place-link ]]; then ln -s "${FAKE}/%(exe)s.new" "${bin_dir}/%(exe)s"; echo "installed"; exit 0; fi
cp "${FAKE}/%(exe)s.new" "${bin_dir}/.%(exe)s.new"
chmod 0755 "${bin_dir}/.%(exe)s.new"
mv -f "${bin_dir}/.%(exe)s.new" "${bin_dir}/%(exe)s"
if [[ "${mode}" == fail-after ]]; then echo "Installed program failed verification." >&2; exit 1; fi
if [[ "${mode}" == break-probes ]]; then : > "${FAKE}/fail-installed-probe"; fi
echo "installed"
"""


class VendorHost(HarnessHost):
    """Grok Build (or Antigravity) as a regular file in the bin dir and its installer helper."""

    TOOL, EXE, ENV, TEXT, PINNED = "grok-build", "grok", "GROK_BIN_DIR", FAKE_GROK, "1.0.62"

    def setUp(self):
        super().setUp()
        saved = copy.deepcopy(toolctl.HARNESS_SPECS)
        self.addCleanup(lambda: (toolctl.HARNESS_SPECS.clear(), toolctl.HARNESS_SPECS.update(saved)))
        self.helper_dir = os.path.join(self.base, "portal/installer")
        os.makedirs(self.helper_dir)
        helper = os.path.join(self.helper_dir, toolctl.HARNESS_SPECS[self.TOOL]["helper"])
        with open(helper, "w") as handle:
            handle.write(FAKE_HELPER % {"fake": self.fake, "env": self.ENV, "exe": self.EXE,
                                        "verargs": " ".join(toolctl.HARNESS_SPECS[self.TOOL]["versionArgs"]),
                                        "pinned_line": ("grok " if self.TOOL == "grok-build" else "") + self.PINNED})
        os.chmod(helper, 0o644)
        self.roots.harness_helper_dir = self.helper_dir
        self.launcher = os.path.join(self.bin_dir, self.EXE)
        if self.TOOL == "grok-build":
            toolctl.HARNESS_SPECS[self.TOOL]["pinnedSha256"] = {"x86_64": hashlib.sha256(self.text(self.PINNED).encode()).hexdigest()}
        self.place(self.text(self.PINNED))
        self.stage_new(self.text(self.PINNED))

    def text(self, version, mode="ok"):
        return self.TEXT % {"version": version, "mode": mode}

    def place(self, text):
        temporary = self.launcher + ".tmp"
        with open(temporary, "w") as handle:
            handle.write(text)
        os.chmod(temporary, 0o755)
        os.rename(temporary, self.launcher)

    def stage_new(self, text, mode="ok"):
        with open(os.path.join(self.fake, self.EXE + ".new"), "w") as handle:
            handle.write(text)
        with open(os.path.join(self.fake, "helper-mode"), "w") as handle:
            handle.write(mode)

    def record_path(self):
        return os.path.join(self.roots.state_root, "admission", self.TOOL + ".json")

    def launcher_text(self):
        with open(self.launcher) as handle:
            return handle.read()

    def leftovers(self):
        return sorted(name for name in os.listdir(self.bin_dir) if name.startswith("."))

    def assert_unchanged(self, status, state, code, text):
        self.assertEqual((status["state"], status["error"]["id"]), (state, code), status["error"])
        self.assertFalse(os.path.exists(self.record_path()), "no record may be written")
        self.assertEqual(self.launcher_text(), text)
        self.assertEqual(self.leftovers(), [], "no backup may be left next to the launcher")
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, self.TOOL)))


class VendorRequalifyTests(VendorHost):
    def test_the_pinned_build_is_admitted_with_its_pinned_digest_and_both_probes(self):
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["installed", "compare", "probe", "commit"])
        record = load_json(self.record_path())
        self.assertEqual((record["toolId"], record["version"], record["layout"], record["admittedBy"]),
                         (self.TOOL, self.PINNED, "vendor-file", "requalify:" + RUN_ID))
        self.assertEqual((record["source"]["authority"], record["source"]["bytesVerified"]), ("portal-pinned-digest", True))
        self.assertEqual(record["executables"]["grok"], {"path": self.launcher, "sha256": toolctl.sha256_file(self.launcher)})
        self.assertEqual(record["probes"], {"passed": ["C-VER", "C-ACP"], "failed": [], "notRun": []})
        with open(os.path.join(self.fake, "sandbox-calls.log")) as handle:
            calls = [json.loads(line) for line in handle]
        for argv in calls:
            self.assertTrue(sandbox_confined(argv), argv)
            boxed(argv)
            self.assertEqual(sandbox_env(argv)["GROK_DISABLE_AUTOUPDATER"], "1")
        self.assertEqual(boxed(calls[-1]), [self.launcher, "--no-auto-update", "agent", "stdio"])

    def test_a_version_below_the_floor_records_it_and_offers_the_update_that_then_runs(self):
        # F5 (the published lineage installed Grok Build 1.0.13; the floor is 1.0.62): never another re-check.
        old = self.text("1.0.13")
        self.place(old)
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_VERSION_NOT_ADMISSIBLE", old)
        self.assertEqual((status["error"]["nextAction"], status["result"]["installedVersion"]), ("update-recommended", "1.0.13"))
        self.assertIn("1.0.13 is older than the Portal floor 1.0.62; update it instead", status["error"]["message"])
        shutil.rmtree(_run.dir)
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assertEqual((status["state"], status["result"]["from"], status["result"]["to"]), ("succeeded", "1.0.13", self.PINNED),
                         status.get("error"))
        self.assertNotIn("installedVersion", status["result"])

    def test_the_pinned_version_with_other_bytes_is_refused_with_the_publisher_named(self):
        self.place(self.text(self.PINNED) + "# rebuilt\n")
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_BINARY_DIFFERS"))
        self.assertIsNone(status["error"]["nextAction"], "the helper cannot replace it, so no update is suggested")
        self.assertEqual(status["error"]["message"], "The installed Grok Build %s reports the version the Portal tested but "
                         "is not the build the Portal tested (its digest differs). The Portal does not replace a program "
                         "that reports the tested version: reinstall Grok Build from its publisher, then Re-check it in "
                         "Admin > Maintenance." % self.PINNED)
        self.assertFalse(os.path.exists(self.record_path()))

    def test_a_vendor_self_update_is_admitted_by_its_probes_as_unverified_bytes(self):
        self.place(self.text("1.0.70"))
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["source"]["authority"], record["source"]["bytesVerified"]),
                         ("1.0.70", "vendor-self-update", False))

    def test_image_input_fails_the_acp_probe(self):
        self.place(self.text("1.0.70", mode="image"))
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "CLI_PROBE_FAILED"))
        self.assertIn("image input is on", status["error"]["message"])
        self.assertFalse(os.path.exists(self.record_path()))

    def test_a_linked_or_missing_launcher_is_refused_plainly(self):
        os.unlink(self.launcher)
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assertEqual(status["error"]["id"], "HARNESS_TOOL_ABSENT")
        self.assertIn("Install it from its card in Admin > Maintenance.", status["error"]["message"])
        shutil.rmtree(_run.dir)
        os.symlink(os.path.join(self.fake, "grok.new"), self.launcher)
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assertEqual(status["error"]["id"], "HARNESS_LAYOUT_UNMANAGED")

    def test_only_x86_64_is_supported(self):
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status(self.TOOL)
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": self.TOOL, "action": "requalify"}
        status = toolctl.execute_harness_run(self.roots, run, self.policy, request, uid=UID, machine="aarch64", now=lambda: NOW)
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "UNSUPPORTED_PLATFORM"))


class VendorUpdateTests(VendorHost):
    def setUp(self):
        super().setUp()
        self.old = self.text("1.0.61")
        self.place(self.old)

    def test_update_installs_the_pinned_build_through_the_helper(self):
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]],
                         ["installed", "resolve", "swap", "probe-installed", "commit", "cleanup"])
        self.assertEqual((status["result"]["from"], status["result"]["to"]), ("1.0.61", self.PINNED))
        self.assertEqual(self.launcher_text(), self.text(self.PINNED))
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["admittedBy"], record["source"]["authority"]),
                         (self.PINNED, "run:" + RUN_ID, "portal-pinned-digest"))
        self.assertEqual(self.leftovers(), [])
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, self.TOOL)))
        with open(os.path.join(self.fake, "helper-calls.log")) as handle:
            self.assertEqual(handle.read(), "converge\n")

    def test_newest_or_another_version_is_refused_without_checksums(self):
        _run, status = self.run_action("update", target="newest", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "NEWEST_NOT_OFFERED", self.old)
        shutil.rmtree(_run.dir)
        _run, status = self.run_action("update", target="1.0.70", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_SOURCE_UNVERIFIABLE", self.old)
        self.assertIn("publishes no checksums", status["error"]["message"])
        shutil.rmtree(_run.dir)
        self.assertFalse(os.path.exists(os.path.join(self.fake, "helper-calls.log")), "the helper never ran")

    def test_current_newer_or_rebuilt_are_refused(self):
        self.place(self.text(self.PINNED))
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assertEqual(status["error"]["id"], "HARNESS_ALREADY_CURRENT")
        shutil.rmtree(_run.dir)
        self.place(self.text("1.0.70"))
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assertEqual(status["error"]["id"], "HARNESS_DOWNGRADE_REFUSED")
        shutil.rmtree(_run.dir)
        # The pinned version with other bytes: the helper keeps it, so it is refused with the publisher named.
        self.place(self.text(self.PINNED) + "# rebuilt\n")
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_BINARY_DIFFERS"))
        self.assertIn("does not replace a program that reports the tested version, so nothing was changed: reinstall "
                      "Grok Build from its publisher, then Re-check it", status["error"]["message"])
        self.assertFalse(os.path.exists(os.path.join(self.fake, "helper-calls.log")), "the helper never ran")

    def test_a_helper_failure_before_the_switch_changes_nothing(self):
        before = os.stat(self.launcher).st_ino
        self.stage_new(self.text(self.PINNED), mode="fail-before")
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_HELPER_FAILED", self.old)
        self.assertIn("Could not download", status["error"]["message"])
        self.assertEqual(os.stat(self.launcher).st_ino, before)

    def test_a_helper_that_switched_and_failed_is_put_back(self):
        self.stage_new(self.text(self.PINNED), mode="fail-after")
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_HELPER_FAILED", self.old)

    def test_an_installed_probe_failure_swaps_back(self):
        self.stage_new(self.text(self.PINNED), mode="break-probes")
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "rolled-back", "HARNESS_SWAPPED_BACK", self.old)
        self.assertEqual(status["swap"]["state"], "swapped-back")

    def test_an_error_after_the_helper_switched_puts_the_previous_program_back(self):
        status = self.update_failing_once("save", self.swap_state_is("swapped"), tool=self.TOOL)
        self.assert_unchanged(status, "rolled-back", "HARNESS_SWAPPED_BACK", self.old)
        self.assertEqual((status["internalError"]["phase"], status["internalError"]["swapState"]), ("swap", "swapped"))

    def test_bytes_other_than_the_pinned_build_are_swapped_back(self):
        self.stage_new(self.text(self.PINNED) + "# not the tested build\n")
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "rolled-back", "HARNESS_SWAPPED_BACK", self.old)
        # The previous program is back, so the reason carries no step of its own.
        self.assertIn("failed its check after the switch (the installed Grok Build %s is not the build the Portal tested "
                      "(its digest differs));" % self.PINNED, status["error"]["message"])
        self.assertNotIn("publisher", status["error"]["message"])

    def test_a_policy_that_recommends_another_version_is_refused(self):
        toolctl.policy_tool(self.policy, self.TOOL)["newestProven"]["version"] = "1.0.70"
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "POLICY_INVALID", self.old)

    def test_a_missing_helper_is_refused_plainly(self):
        os.unlink(os.path.join(self.helper_dir, "grok-build-runtime.sh"))
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_HELPER_UNAVAILABLE", self.old)
        # The helper lives in the Portal tree's installer/, which the Portal-only repair restores.
        self.assertTrue(status["error"]["message"].endswith("nothing was changed. Run sudo bash install.sh --repair on the "
                                                            "server to restore the Portal's files."), status["error"]["message"])


class VendorReconcileTests(VendorHost):
    def interrupted(self, state, switched):
        """A run that died with its swap in `state`; the launcher switched or not."""
        self.place(self.text("1.0.61"))
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status(self.TOOL)
        backup = os.path.join(self.bin_dir, ".grok.bridgesllm-prev." + RUN_ID)
        os.link(self.launcher, backup)
        if switched:
            self.place(self.text(self.PINNED))
        fence = toolctl.npm_fence_path(self.roots, self.TOOL)
        toolctl.ensure_private_dir(os.path.dirname(fence))
        toolctl.atomic_write_json(fence, {"runId": RUN_ID})
        run.status.update(state="running", phase="running", swap={
            "kind": "vendor-file", "link": self.launcher, "backup": backup, "fence": fence, "from": "1.0.61",
            "to": self.PINNED, "fromSha256": hashlib.sha256(self.text("1.0.61").encode()).hexdigest(), "state": state})
        run.save()
        return run

    def test_crash_after_the_switch_puts_the_previous_program_back(self):
        run = self.interrupted("swapped", switched=True)
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        self.assertEqual((run.status["state"], run.status["error"]["id"]), ("rolled-back", "HARNESS_SWAPPED_BACK"))
        self.assertEqual(self.launcher_text(), self.text("1.0.61"))
        self.assertEqual(self.leftovers(), [])

    def test_crash_while_the_helper_had_not_switched_changes_nothing(self):
        run = self.interrupted("installing", switched=False)
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        self.assertEqual((run.status["state"], run.status["error"]["id"]), ("failed", "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE"))
        self.assertEqual(self.leftovers(), [])
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, self.TOOL)))

    def test_a_record_written_before_the_crash_settles_as_committed(self):
        run = self.interrupted("committing", switched=True)
        toolctl.write_harness_record(self.roots, {"schema": toolctl.SCHEMA_HARNESS_RECORD, "toolId": self.TOOL,
                                                  "version": self.PINNED, "admittedBy": "run:" + RUN_ID})
        toolctl.cmd_reconcile(self.roots)
        self.assertEqual(run.load()["state"], "succeeded")
        self.assertEqual(self.launcher_text(), self.text(self.PINNED))
        self.assertEqual(self.leftovers(), [])


class AntigravityTests(VendorHost):
    TOOL, EXE, ENV, TEXT, PINNED = "antigravity", "agy", "ANTIGRAVITY_BIN_DIR", FAKE_AGY, "1.4.3"

    def test_requalify_checks_the_version_only_and_records_unverified_bytes(self):
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        record = load_json(self.record_path())
        self.assertEqual(record["probes"], {"passed": ["C-VER"], "failed": [], "notRun": []})
        self.assertEqual((record["source"]["authority"], record["source"]["bytesVerified"]), ("probes-only", False))
        with open(os.path.join(self.fake, "sandbox-calls.log")) as handle:
            calls = [json.loads(line) for line in handle]
        self.assertTrue(calls)
        for argv in calls:
            self.assertEqual(sandbox_env(argv)["AGY_CLI_DISABLE_AUTO_UPDATE"], "true")
            # F10: a probe cannot replace the program either way: the host is read-only, nothing is writable.
            self.assertIn("--property=ProtectSystem=strict", argv)
            self.assertEqual([dest for _source, dest in sandbox_binds(argv, "BindPaths")], ["/tmp"])  # its own scratch only
        self.assertEqual(self.launcher_text(), self.text(self.PINNED))

    def test_update_through_the_helper_records_the_pinned_archive_authority(self):
        self.place(self.text("1.4.2"))
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["source"]["authority"], record["source"]["bytesVerified"]),
                         (self.PINNED, "portal-pinned-digest", True))


class VendorLockstepTests(unittest.TestCase):
    """The vendor facts toolctl carries match the installer helpers, the policy and the backend profile."""

    def helper_value(self, text, name):
        return re.search(r'readonly %s="([^"]+)"' % name, text).group(1)

    def test_grok_build_matches_its_helper_policy_and_acp_profile(self):
        spec = toolctl.HARNESS_SPECS["grok-build"]
        with open(os.path.join(REPO, "installer", spec["helper"])) as handle:
            text = handle.read()
        self.assertEqual(self.helper_value(text, "GROK_BUILD_TESTED_VERSION"), spec["pinnedVersion"])
        self.assertEqual(self.helper_value(text, "GROK_BUILD_SHA256_X86_64"), spec["pinnedSha256"]["x86_64"])
        self.assertEqual(self.helper_value(text, "GROK_BUILD_DOWNLOAD_ROOT"), spec["origin"])
        self.assertIn('${%s:-/usr/local/bin}' % spec["helperBinDirEnv"], text)
        self.assertIn("--no-auto-update --version", text)
        tool = toolctl.policy_tool(load_json(POLICY_PATH), "grok-build")
        self.assertEqual(tool["newestProven"]["version"], spec["pinnedVersion"])
        with open(ACP_PROFILES) as handle:
            profiles = handle.read()
        block = profiles[profiles.index("GROK_ACP_PROFILE"):profiles.index("HERMES_ACP_PROFILE")]
        self.assertIn("const args = ['--no-auto-update', 'agent'];", block)
        self.assertIn("args.push('stdio');", block)
        self.assertIn("agentVersionSource: 'meta-agent-version'", block)
        self.assertIn("requiredCapabilities: ['loadSession']", block)

    def test_antigravity_matches_its_helper_and_policy(self):
        spec = toolctl.HARNESS_SPECS["antigravity"]
        with open(os.path.join(REPO, "installer", spec["helper"])) as handle:
            text = handle.read()
        self.assertEqual(self.helper_value(text, "ANTIGRAVITY_TESTED_VERSION"), spec["pinnedVersion"])
        self.assertTrue(self.helper_value(text, "ANTIGRAVITY_URL_X86_64").startswith(spec["origin"]))
        self.assertIn('${%s:-/usr/local/bin}' % spec["helperBinDirEnv"], text)
        tool = toolctl.policy_tool(load_json(POLICY_PATH), "antigravity")
        self.assertEqual(tool["newestProven"]["version"], spec["pinnedVersion"])
        self.assertEqual(tool["source"]["endpoint"], spec["origin"])


# Ollama: the client prints a warning first when no server answers (as in the sandbox).
FAKE_OLLAMA = r"""#!/usr/bin/python3 -I
import sys
VERSION = %(version)r
if sys.argv[1:] == ["--version"]:
    print("Warning: could not connect to a running Ollama instance")
    print("Warning: client version is " + VERSION)
    sys.exit(0)
sys.exit(2)
"""

# install.sh --toolctl-ollama-update <version> <sha256> <size>, as far as toolctl
# relies on it. Each call takes the next mode from $FAKE/installer-modes
# ("private": the client is left 0700, as anything is under toolctl's umask 077).
FAKE_INSTALLER = r"""#!/bin/bash
set -Eeuo pipefail
FAKE=%(fake)r
BIN=%(bin)r
[[ "$1" == --toolctl-ollama-update && "$#" -eq 4 ]] || exit 2
echo "$*" >> "${FAKE}/installer-calls.log"
read -r mode rest < "${FAKE}/installer-modes" || mode=ok
printf '%%s\n' "${rest:-ok}" > "${FAKE}/installer-modes"
rm -f "${FAKE}/server-stuck"
if [[ "${mode}" == fail ]]; then echo "The Ollama archive failed checksum validation." >&2; exit 1; fi
python3 -I -c 'import sys; open(sys.argv[1], "w").write(open(sys.argv[2]).read().replace("@VERSION@", sys.argv[3]))' \
  "${BIN}/.ollama.new" "${FAKE}/ollama.template" "$2"
if [[ "${mode}" == private ]]; then chmod 0700 "${BIN}/.ollama.new"; else chmod 0755 "${BIN}/.ollama.new"; fi
mv -f "${BIN}/.ollama.new" "${BIN}/ollama"
if [[ "${mode}" == server-mismatch ]]; then echo 0.0.1 > "${FAKE}/server-stuck"; fi
if [[ "${mode}" == fail-changed ]]; then echo "Ollama did not pass exact client/server verification." >&2; exit 1; fi
echo "Ollama $2 is installed and its client and server agree."
"""

FAKE_SYSTEMCTL = r"""#!/bin/bash
[[ "$*" == "is-active --quiet ollama" && -e %(fake)r/ollama-active ]]
"""


class OllamaHost(HarnessHost):
    """Ollama 0.40.6 at <bin>/ollama, its running server (fake loopback API) and the installer entry."""

    def setUp(self):
        super().setUp()
        saved = toolctl.OLLAMA_SETTLE_DELAY
        toolctl.OLLAMA_SETTLE_DELAY = 0
        self.addCleanup(setattr, toolctl, "OLLAMA_SETTLE_DELAY", saved)
        self.launcher = os.path.join(self.bin_dir, "ollama")
        with open(os.path.join(self.fake, "ollama.template"), "w") as handle:
            handle.write(FAKE_OLLAMA % {"version": "@VERSION@"})
        self.place("0.40.6")
        self.helper_dir = os.path.join(self.base, "portal/installer")
        os.makedirs(self.helper_dir)
        installer = os.path.join(self.helper_dir, "install.sh")
        with open(installer, "w") as handle:
            handle.write(FAKE_INSTALLER % {"fake": self.fake, "bin": self.bin_dir})
        os.chmod(installer, 0o644)
        self.roots.harness_helper_dir = self.helper_dir
        systemctl = os.path.join(self.base, "fakebin", "systemctl")
        with open(systemctl, "w") as handle:
            handle.write(FAKE_SYSTEMCTL % {"fake": self.fake})
        os.chmod(systemctl, 0o755)
        self.roots.systemctl_bin = systemctl
        self.roots.zstd_bin = "/bin/sh"  # any executable stands in for zstd
        open(os.path.join(self.fake, "ollama-active"), "w").close()
        self.modes("ok")
        self.api_calls = []

    def place(self, version):
        temporary = self.launcher + ".tmp"
        with open(temporary, "w") as handle:
            handle.write(FAKE_OLLAMA % {"version": version})
        os.chmod(temporary, 0o755)
        os.rename(temporary, self.launcher)

    def modes(self, text):
        with open(os.path.join(self.fake, "installer-modes"), "w") as handle:
            handle.write(text + "\n")

    def installed_version(self):
        with open(self.launcher) as handle:
            return re.search(r"VERSION = '([^']+)'", handle.read()).group(1)

    def local_get(self, url, max_bytes):
        self.api_calls.append(url)
        stuck = os.path.join(self.fake, "server-stuck")
        if url == "http://127.0.0.1:11434/api/version":
            version = open(stuck).read().strip() if os.path.exists(stuck) else self.installed_version()
            return json.dumps({"version": version}).encode()
        if url == "http://127.0.0.1:11434/api/tags":
            return json.dumps({"models": [{"name": "llama3.2:3b"}, {"name": "qwen3:8b"}]}).encode()
        raise OSError("connection refused")

    def release(self, version, digest=True, latest=False):
        asset = "ollama-linux-amd64.tar.zst"
        content = ("ollama %s" % version).encode()
        doc = {"tag_name": "v" + version, "draft": False, "prerelease": False, "assets": [{
            "name": asset, "size": 1438364593,
            "browser_download_url": "https://github.com/ollama/ollama/releases/download/v%s/%s" % (version, asset)}]}
        if digest:
            doc["assets"][0]["digest"] = "sha256:" + hashlib.sha256(content).hexdigest()
        body = json.dumps(doc).encode()
        self.github.responses["%s/repos/ollama/ollama/releases/tags/v%s" % (toolctl.GITHUB_API, version)] = body
        if latest:
            self.github.responses["%s/repos/ollama/ollama/releases/latest" % toolctl.GITHUB_API] = body
        return hashlib.sha256(content).hexdigest()

    def run_ollama(self, action, target=None):
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("ollama")
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "ollama", "action": action}
        if target is not None:
            request["target"] = target
        self.assertEqual(toolctl.validate_request(request, RUN_ID, self.policy), [])
        status = toolctl.execute_harness_run(self.roots, run, self.policy, request, fetch=self.github, uid=UID,
                                             machine="x86_64", now=lambda: NOW, local_get=self.local_get)
        return run, status

    def record_path(self):
        return os.path.join(self.roots.state_root, "admission", "ollama.json")

    def installer_calls(self):
        path = os.path.join(self.fake, "installer-calls.log")
        return open(path).read().splitlines() if os.path.exists(path) else []

    def assert_unchanged(self, status, state, code):
        self.assertEqual((status["state"], status["error"]["id"]), (state, code), status["error"])
        self.assertFalse(os.path.exists(self.record_path()), "no record may be written")
        self.assertEqual(self.installed_version(), "0.40.6")
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "ollama")))


class OllamaRequalifyTests(OllamaHost):
    def test_client_server_and_release_agree_so_the_record_is_written(self):
        digest = self.release("0.40.6")
        _run, status = self.run_ollama("requalify")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["installed", "resolve", "probe", "commit"])
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["layout"], record["admittedBy"]), ("0.40.6", "service-restart", "requalify:" + RUN_ID))
        self.assertEqual(record["executables"]["ollama"], {"path": self.launcher, "sha256": toolctl.sha256_file(self.launcher)})
        self.assertEqual((record["source"]["archiveSha256"], record["source"]["bytesVerified"]), (digest, False))
        self.assertEqual(record["probes"]["passed"], ["C-VER"])
        self.assertIn("http://127.0.0.1:11434/api/tags", self.api_calls)
        self.assertEqual(self.installer_calls(), [], "a re-check never runs the installer")
        with open(os.path.join(self.fake, "sandbox-calls.log")) as handle:
            for argv in (json.loads(line) for line in handle):
                self.assertEqual(sandbox_env(argv)["OLLAMA_HOST"], "http://127.0.0.1:1")

    def test_a_server_that_disagrees_or_is_stopped_is_refused(self):
        self.release("0.40.6")
        with open(os.path.join(self.fake, "server-stuck"), "w") as handle:
            handle.write("0.40.5\n")
        _run, status = self.run_ollama("requalify")
        self.assert_unchanged(status, "refused", "OLLAMA_PARITY_FAILED")
        self.assertIn("the server reports 0.40.5 while the client is 0.40.6", status["error"]["message"])
        shutil.rmtree(_run.dir)
        os.unlink(os.path.join(self.fake, "server-stuck"))
        os.unlink(os.path.join(self.fake, "ollama-active"))
        _run, status = self.run_ollama("requalify")
        self.assert_unchanged(status, "refused", "OLLAMA_PARITY_FAILED")
        self.assertIn("ollama.service is not running", status["error"]["message"])

    def test_a_release_without_a_recorded_digest_is_unverifiable(self):
        self.release("0.40.6", digest=False)
        _run, status = self.run_ollama("requalify")
        self.assert_unchanged(status, "refused", "HARNESS_SOURCE_UNVERIFIABLE")
        # A refusal after the version was read records it; only an unadmitted version changes the next action.
        self.assertEqual((status["result"]["installedVersion"], status["error"]["nextAction"]), ("0.40.6", None))

    def test_a_version_below_the_floor_records_it_and_offers_the_update_that_then_runs(self):
        # F5 (the published lineage installed Ollama 0.33.3; the floor is 0.40.6).
        self.place("0.33.3")
        _run, status = self.run_ollama("requalify")
        self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                         ("refused", "HARNESS_VERSION_NOT_ADMISSIBLE", "update-recommended"), status["error"])
        self.assertEqual(status["result"]["installedVersion"], "0.33.3")
        self.assertIn("0.33.3 is older than the Portal floor 0.40.6; update it instead", status["error"]["message"])
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertEqual(self.installer_calls(), [])
        shutil.rmtree(_run.dir)
        self.release("0.40.13")
        _run, status = self.run_ollama("update", target="recommended")
        self.assertEqual((status["state"], status["result"]["from"], status["result"]["to"]), ("succeeded", "0.33.3", "0.40.13"),
                         status.get("error"))


class OllamaUpdateTests(OllamaHost):
    def test_update_runs_only_the_installer_entry_with_the_verified_release(self):
        digest = self.release("0.40.13")
        self.modes("private")
        _run, status = self.run_ollama("update", target="recommended")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        # The client the installer left 0700 is published before the probes run it as the sandbox identity.
        self.assertEqual(stat.S_IMODE(os.lstat(self.launcher).st_mode), 0o755)
        self.assertEqual([s["id"] for s in status["steps"]],
                         ["installed", "resolve", "swap", "probe-installed", "commit", "cleanup"])
        self.assertEqual(self.installer_calls(), ["--toolctl-ollama-update 0.40.13 %s 1438364593" % digest])
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["admittedBy"], record["source"]["bytesVerified"]),
                         ("0.40.13", "run:" + RUN_ID, True))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "ollama")))

    def test_newest_is_not_offered_even_with_a_published_digest(self):
        self.release("0.40.14", latest=True)
        _run, status = self.run_ollama("update", target="newest")
        self.assert_unchanged(status, "refused", "NEWEST_NOT_OFFERED")
        self.assertEqual((self.installer_calls(), self.github.calls), ([], []))

    def test_without_zstd_nothing_runs(self):
        self.release("0.40.13")
        self.roots.zstd_bin = os.path.join(self.base, "missing", "zstd")
        _run, status = self.run_ollama("update", target="recommended")
        self.assert_unchanged(status, "refused", "HARNESS_ZSTD_MISSING")
        self.assertIn("Install the zstd package", status["error"]["message"])
        self.assertEqual(self.installer_calls(), [])

    def test_an_installer_failure_that_changed_nothing_is_a_plain_refusal(self):
        self.release("0.40.13")
        self.modes("fail")
        _run, status = self.run_ollama("update", target="recommended")
        self.assert_unchanged(status, "refused", "HARNESS_HELPER_FAILED")
        self.assertIn("failed checksum validation", status["error"]["message"])

    def test_an_installer_failure_that_left_another_version_needs_recovery(self):
        self.release("0.40.13")
        self.modes("fail-changed")
        _run, status = self.run_ollama("update", target="recommended")
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "HARNESS_SWAP_BACK_FAILED"))
        self.assertTrue(status["error"]["message"].endswith("and the previous version is not back. " + RECHECK % "Ollama"),
                        status["error"]["message"])
        self.assertFalse(os.path.exists(self.record_path()))

    def test_a_failed_check_after_the_switch_installs_the_previous_release_again(self):
        self.release("0.40.13")
        previous = self.release("0.40.6")
        self.modes("server-mismatch ok")
        _run, status = self.run_ollama("update", target="recommended")
        self.assert_unchanged(status, "rolled-back", "HARNESS_SWAPPED_BACK")
        self.assertEqual(self.installer_calls()[1], "--toolctl-ollama-update 0.40.6 %s 1438364593" % previous)
        self.assertEqual(status["swap"]["state"], "swapped-back")

    def test_a_failed_swap_back_needs_recovery(self):
        self.release("0.40.13")
        self.release("0.40.6")
        self.modes("server-mismatch fail")
        _run, status = self.run_ollama("update", target="recommended")
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "HARNESS_SWAP_BACK_FAILED"))
        self.assertTrue(status["error"]["message"].endswith("and 0.40.6 could not be installed again. " + RECHECK % "Ollama"),
                        status["error"]["message"])
        self.assertFalse(os.path.exists(self.record_path()))

    def test_a_qualified_newest_proven_must_match_its_recorded_digest(self):
        self.release("0.40.13")
        toolctl.policy_tool(self.policy, "ollama")["newestProven"].update(status="qualified",
                                                                         integrity={"x86_64": "sha256:" + "0" * 64})
        _run, status = self.run_ollama("update", target="recommended")
        self.assert_unchanged(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH")
        self.assertEqual(self.installer_calls(), [])


class OllamaReconcileTests(OllamaHost):
    def interrupted(self, state, changed):
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("ollama")
        from_sha = toolctl.sha256_file(self.launcher)
        if changed:
            self.place("0.40.13")
        run.status.update(state="running", phase="running", swap={
            "kind": "ollama-installer", "link": self.launcher, "fromSha256": from_sha,
            "fence": toolctl.npm_fence_path(self.roots, "ollama"), "from": "0.40.6", "to": "0.40.13",
            "installer": os.path.join(self.helper_dir, "install.sh"), "state": state})
        run.save()
        return run

    def test_interrupted_before_the_installer_changed_anything(self):
        run = self.interrupted("installing", changed=False)
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        self.assertEqual((run.status["state"], run.status["error"]["id"]), ("failed", "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE"))

    def test_interrupted_after_the_installer_changed_it_needs_recovery(self):
        run = self.interrupted("swapped", changed=True)
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        self.assertEqual((run.status["state"], run.status["error"]["id"]), ("recovery-required", "HARNESS_LAUNCHER_UNKNOWN"))
        # install.sh --recover never settles Ollama's sealed transaction (only its next installer run does).
        self.assertEqual(run.status["error"]["message"], "The Ollama update was interrupted after the installer changed it, "
                         "and it was not checked. " + RECHECK % "Ollama")

    def test_a_record_written_before_the_crash_settles_as_committed(self):
        run = self.interrupted("committing", changed=True)
        toolctl.write_harness_record(self.roots, {"schema": toolctl.SCHEMA_HARNESS_RECORD, "toolId": "ollama",
                                                  "version": "0.40.13", "admittedBy": "run:" + RUN_ID})
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        self.assertEqual(run.status["state"], "succeeded")


class OllamaInstallTests(OllamaHost):
    """install ollama: missing (`--skip-ollama`, or removed); the installer entry an update uses installs it."""

    def setUp(self):
        super().setUp()
        os.unlink(self.launcher)
        self.digest = self.release("0.40.13")
        self.qualify({"x86_64": "sha256:" + self.digest})

    def qualify(self, integrity, status="qualified"):
        toolctl.policy_tool(self.policy, "ollama")["newestProven"].update(
            version="0.40.13", status=status, integrity=integrity, qualifiedAt="2026-11-02T10:00:00Z")

    def assert_not_installed(self, status, state, code):
        self.assertEqual((status["state"], status["error"]["id"]), (state, code), status["error"])
        self.assertFalse(os.path.exists(self.record_path()), "no record may be written")
        self.assertFalse(os.path.lexists(self.launcher))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "ollama")))

    def test_installs_the_recommended_release_through_the_installer_entry(self):
        self.modes("private")
        _run, status = self.run_ollama("install", target="recommended")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(stat.S_IMODE(os.lstat(self.launcher).st_mode), 0o755, "published before the probes")
        self.assertEqual([s["id"] for s in status["steps"]], ["installed", "resolve", "swap", "probe-installed", "commit"])
        self.assertEqual((status["result"]["action"], status["result"]["from"], status["result"]["to"]),
                         ("install", None, "0.40.13"))
        self.assertEqual(self.installer_calls(), ["--toolctl-ollama-update 0.40.13 %s 1438364593" % self.digest])
        self.assertEqual(self.installed_version(), "0.40.13")
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["admittedBy"], record["source"]["bytesVerified"],
                          record["source"]["provenDigestMatch"]), ("0.40.13", "run:" + RUN_ID, True, True))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "ollama")))

    def test_an_installed_ollama_is_refused(self):
        self.place("0.40.6")
        _run, status = self.run_ollama("install")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "INSTALL_TOOL_PRESENT"), status["error"])
        self.assertIn("Use Update or Re-check on its card instead", status["error"]["message"])
        self.assertEqual((self.installed_version(), self.installer_calls()), ("0.40.6", []))

    def test_not_qualified_for_this_machine_installs_as_its_update_would(self):
        # Install admits exactly what Update admits: the release digest GitHub records, no qualified match here.
        self.qualify({"aarch64": "sha256:" + self.digest})  # qualified on the other machine only
        _run, status = self.run_ollama("install")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(self.installer_calls(), ["--toolctl-ollama-update 0.40.13 %s 1438364593" % self.digest])
        self.assertIsNone(load_json(self.record_path())["source"]["provenDigestMatch"])

    def test_an_installer_failure_leaves_nothing_installed(self):
        self.modes("fail")
        _run, status = self.run_ollama("install")
        self.assert_not_installed(status, "refused", "HARNESS_HELPER_FAILED")
        self.assertIn("Ollama is still not installed", status["error"]["message"])

    def test_an_installer_failure_that_left_ollama_behind_needs_the_recheck(self):
        self.modes("fail-changed")
        _run, status = self.run_ollama("install")
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "INSTALL_REMOVE_FAILED"))
        self.assertTrue(status["error"]["message"].endswith(RECHECK % "Ollama"), status["error"]["message"])
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "ollama")))

    def test_a_failed_check_after_the_install_needs_the_recheck(self):
        self.modes("server-mismatch")
        _run, status = self.run_ollama("install")
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "INSTALL_REMOVE_FAILED"))
        self.assertIn("was installed but failed its check", status["error"]["message"])
        self.assertFalse(os.path.exists(self.record_path()))

    def test_a_missing_ollama_names_install_where_it_is_qualified(self):
        tool = toolctl.HarnessTool(self.roots, "ollama", toolctl.policy_tool(self.policy, "ollama"), self.base, uid=UID,
                                   machine="x86_64")
        with self.assertRaises(toolctl.HarnessRefusal) as raised:
            toolctl.vendor_installed(tool)
        self.assertTrue(raised.exception.message.endswith("Install it from its card in Admin > Maintenance."))

    def test_agent_zero_cannot_be_installed_in_this_build(self):
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("agent-zero")
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "agent-zero", "action": "install"}
        self.assertEqual(toolctl.validate_request(request, RUN_ID, self.policy), [])
        status = toolctl.execute_harness_run(self.roots, run, self.policy, request, fetch=self.github, uid=UID,
                                             machine="x86_64", now=lambda: NOW)
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "TOOLS_ACTION_UNSUPPORTED"))
        self.assertIn("cannot be installed from Maintenance", status["error"]["message"])

    def interrupted(self, state, installed):
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("ollama")
        if installed:
            self.place("0.40.13")
        run.status.update(state="running", phase="swap", swap={
            "kind": "ollama-installer", "install": True, "link": self.launcher, "fromSha256": None,
            "fence": toolctl.npm_fence_path(self.roots, "ollama"), "from": None, "to": "0.40.13",
            "installer": os.path.join(self.helper_dir, "install.sh"), "state": state})
        run.save()
        return run

    def test_reconcile_of_an_interrupted_install(self):
        run = self.interrupted("installing", installed=False)
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        self.assertEqual((run.status["state"], run.status["error"]["id"]), ("failed", "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE"))
        shutil.rmtree(run.dir)
        run = self.interrupted("swapped", installed=True)
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        self.assertEqual((run.status["state"], run.status["error"]["id"]), ("recovery-required", "INSTALL_REMOVE_FAILED"))
        self.assertTrue(run.status["error"]["message"].endswith(RECHECK % "Ollama"))
        shutil.rmtree(run.dir)
        run = self.interrupted("committing", installed=True)
        toolctl.write_harness_record(self.roots, {"schema": toolctl.SCHEMA_HARNESS_RECORD, "toolId": "ollama",
                                                  "version": "0.40.13", "admittedBy": "run:" + RUN_ID})
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        self.assertEqual((run.status["state"], run.status["result"]["action"]), ("succeeded", "install"))

    def test_the_installer_entry_runs_the_fresh_install_function(self):
        # Install = the installer's own fresh install of Ollama: install_ai_tools and the toolctl entry run the same
        # install_or_update_ollama, which converges from nothing (service account, unit, enable + start, parity).
        with open(os.path.join(REPO, "installer", "install.sh")) as handle:
            text = handle.read()
        fresh = text[text.index("\ninstall_ai_tools() {"):]
        fresh = fresh[:fresh.index("\n}\n")]
        self.assertIn("    install_or_update_ollama\n", fresh)
        entry = text[text.index("\ndo_toolctl_ollama_update() {"):]
        entry = entry[:entry.index("\n}\n")]
        self.assertIn('  install_or_update_ollama "$2" "$3" "$4"\n', entry)
        body = text[text.index("\ninstall_or_update_ollama() {"):]
        body = body[:body.index("\n}\n")]
        for step in ("ensure_ollama_service_account", "systemctl enable ollama", "systemctl restart ollama",
                     "verify_ollama_client_server_parity 60", "'User=ollama'", "ollama_transaction_action cutover"):
            self.assertIn(step, body)


class OllamaLockstepTests(unittest.TestCase):
    def test_ollama_spec_matches_the_installer_and_policy(self):
        spec = toolctl.HARNESS_SPECS["ollama"]
        with open(os.path.join(REPO, "installer", "install.sh")) as handle:
            text = handle.read()
        self.assertIn('if [[ "${1:-}" == "%s" ]]; then' % spec["installerArgs"][0], text)
        self.assertIn("releases/download/v%s/ollama-linux-%s.tar.zst", text)
        for arch, name in (("x86_64", "amd64"), ("aarch64", "arm64")):
            self.assertEqual(spec["assets"][arch], "ollama-linux-%s.tar.zst" % name)
        self.assertIn('readonly OLLAMA_MANAGED_BIN_PATH="/usr/local/bin/%s"' % spec["executable"], text)
        self.assertIn("http://127.0.0.1:11434/api/version", text)
        self.assertIn("OLLAMA_HOST=%s" % spec["env"]["OLLAMA_HOST"], text)
        self.assertEqual(toolctl.policy_tool(load_json(POLICY_PATH), "ollama")["source"]["repository"], "ollama/ollama")


# installer/agent-zero-runtime.sh as far as toolctl relies on it; each call takes the next mode.
FAKE_A0_HELPER = r"""#!/bin/bash
FAKE=%(fake)r
cmd="$1"
echo "${cmd} AUTH=${AGENT_ZERO_AUTH_FILE}" >> "${FAKE}/a0-calls.log"
read -r mode rest < "${FAKE}/a0-modes" || mode=ok
printf '%%s\n' "${rest:-ok}" > "${FAKE}/a0-modes"
case "${cmd}" in
  status)
    if [[ "${mode}" == orphan ]]; then
      echo "[Agent Zero] ERROR: Refusing to replace an existing Agent Zero container whose /a0/usr is not the managed persistent volume. Back it up and migrate it explicitly." >&2
      exit 1
    fi
    if [[ "${mode}" == not-ready ]]; then
      echo "[Agent Zero] ERROR: Agent Zero connector protocol is not ready or outside the tested v2.14 contract." >&2
      exit 1
    fi
    echo "Agent Zero $(cat "${FAKE}/a0-version") runtime protocol-ready on 127.0.0.1:50001 with Codex OAuth model discovery configured; protected session authentication is verified separately" ;;
  reconcile)
    if [[ "${mode}" == fail ]]; then echo "[Agent Zero] ERROR: Agent Zero update failed; the previous runtime was restored." >&2; exit 1; fi
    if [[ "${mode}" == fail-after ]]; then
      # replaced the container, then its own rollback stopped
      cp "${FAKE}/a0-version" "${FAKE}/a0-previous"; echo 2.14 > "${FAKE}/a0-version"
      echo "[Agent Zero] ERROR: Previous Agent Zero runtime identity is not exact." >&2; exit 1
    fi
    cp "${FAKE}/a0-version" "${FAKE}/a0-previous"
    echo 2.14 > "${FAKE}/a0-version"
    echo "[Agent Zero] Updated Agent Zero to 2.14. Rollback container and data snapshot were retained." >&2 ;;
  rollback)
    if [[ "${mode}" == fail ]]; then echo "[Agent Zero] ERROR: No Agent Zero rollback container exists." >&2; exit 1; fi
    cp "${FAKE}/a0-previous" "${FAKE}/a0-version" ;;
  *) exit 2 ;;
esac
"""


class AgentZeroHost(HarnessHost):
    def setUp(self):
        super().setUp()
        self.env_file = os.path.join(self.base, "etc/bridgesllm/agent-zero.env")
        os.makedirs(os.path.dirname(self.env_file))
        with open(self.env_file, "w") as handle:
            handle.write("A0_AUTH_LOGIN=portal\n")
        self.roots.agent_zero_env = self.env_file
        self.helper_dir = os.path.join(self.base, "portal/installer")
        os.makedirs(self.helper_dir)
        helper = os.path.join(self.helper_dir, "agent-zero-runtime.sh")
        with open(helper, "w") as handle:
            handle.write(FAKE_A0_HELPER % {"fake": self.fake})
        os.chmod(helper, 0o644)
        self.roots.harness_helper_dir = self.helper_dir
        self.version("2.14")
        self.modes("ok")

    def version(self, value):
        with open(os.path.join(self.fake, "a0-version"), "w") as handle:
            handle.write(value + "\n")

    def modes(self, text):
        with open(os.path.join(self.fake, "a0-modes"), "w") as handle:
            handle.write(text + "\n")

    def calls(self):
        path = os.path.join(self.fake, "a0-calls.log")
        return [line.split()[0] for line in open(path)] if os.path.exists(path) else []

    def record_path(self):
        return os.path.join(self.roots.state_root, "admission", "agent-zero.json")

    def refused(self, status, state, code):
        self.assertEqual((status["state"], status["error"]["id"]), (state, code), status["error"])
        self.assertFalse(os.path.exists(self.record_path()), "no record may be written")
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "agent-zero")))


class AgentZeroTests(AgentZeroHost):
    def test_requalify_reads_the_helper_status_and_records_the_pinned_image(self):
        _run, status = self.run_action("requalify", tool="agent-zero")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["installed", "probe", "commit"])
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["layout"], record["admittedBy"], record["executables"]),
                         ("2.14", "managed-container", "requalify:" + RUN_ID, {}))
        self.assertEqual(record["container"], {"name": "bridgesllm-agent-zero", "image": "agent0ai/agent-zero@" +
                                               toolctl.HARNESS_SPECS["agent-zero"]["pinnedDigests"]["x86_64"]})
        with open(os.path.join(self.fake, "a0-calls.log")) as handle:
            self.assertEqual(handle.read(), "status AUTH=%s\n" % self.env_file)

    def test_not_configured_is_said_plainly_and_runs_nothing(self):
        os.unlink(self.env_file)
        _run, status = self.run_action("requalify", tool="agent-zero")
        self.refused(status, "refused", "AGENT_ZERO_NOT_CONFIGURED")
        self.assertIn("not configured", status["error"]["message"])
        self.assertEqual(self.calls(), [])

    def test_a_named_blocker_is_shown_as_itself(self):
        self.modes("orphan")
        _run, status = self.run_action("requalify", tool="agent-zero")
        self.refused(status, "refused", "AGENT_ZERO_BLOCKED")
        self.assertIn("Refusing to replace an existing Agent Zero container whose /a0/usr is not the managed persistent "
                      "volume.", status["error"]["message"])
        self.assertTrue(status["error"]["detail"]["blocker"].startswith("Refusing to replace"))

    def test_update_reconciles_to_the_pinned_image(self):
        self.version("2.13")
        _run, status = self.run_action("update", target="recommended", tool="agent-zero")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(self.calls(), ["status", "reconcile", "status"])
        self.assertEqual([s["id"] for s in status["steps"]],
                         ["installed", "swap", "probe-installed", "commit", "cleanup"])
        self.assertEqual(load_json(self.record_path())["admittedBy"], "run:" + RUN_ID)

    def test_only_the_pinned_image_and_never_twice(self):
        _run, status = self.run_action("update", target="recommended", tool="agent-zero")
        self.refused(status, "refused", "HARNESS_ALREADY_CURRENT")
        shutil.rmtree(_run.dir)
        self.version("2.13")
        _run, status = self.run_action("update", target="newest", tool="agent-zero")
        self.refused(status, "refused", "NEWEST_NOT_OFFERED")
        self.assertNotIn("reconcile", self.calls())

    def test_a_failed_reconcile_reports_the_helper_reason(self):
        self.version("2.13")
        self.modes("ok fail")
        _run, status = self.run_action("update", target="recommended", tool="agent-zero")
        self.refused(status, "refused", "AGENT_ZERO_BLOCKED")
        self.assertEqual(status["error"]["message"], "Agent Zero was not updated: Agent Zero update failed; the previous "
                                                     "runtime was restored.")
        self.assertEqual(self.calls(), ["status", "reconcile", "status"], "status still reports 2.13; rollback never runs")
        self.assertEqual(status["swap"]["state"], "unchanged")

    def test_a_failed_reconcile_that_left_another_version_needs_recovery(self):
        self.version("2.13")
        self.modes("ok fail-after")
        _run, status = self.run_action("update", target="recommended", tool="agent-zero")
        self.refused(status, "recovery-required", "HARNESS_SWAP_BACK_FAILED")
        self.assertEqual(status["error"]["message"], "The Agent Zero helper failed (Previous Agent Zero runtime identity is "
                         "not exact), and Agent Zero now reports 2.14, not 2.13. " + RECHECK % "Agent Zero")
        self.assertEqual((status["swap"]["state"], status["swap"]["running"]), ("swap-back-failed", "2.14"))
        self.assertEqual(status["error"]["detail"]["running"], "2.14")
        self.assertEqual(self.calls(), ["status", "reconcile", "status"], "the helper's rollback is never run here")

    def test_a_failed_reconcile_whose_status_cannot_be_read_needs_recovery(self):
        self.version("2.13")
        self.modes("ok fail not-ready")
        _run, status = self.run_action("update", target="recommended", tool="agent-zero")
        self.refused(status, "recovery-required", "HARNESS_SWAP_BACK_FAILED")
        self.assertEqual(status["error"]["message"], "The Agent Zero helper failed (Agent Zero update failed; the previous "
                         "runtime was restored), and Agent Zero cannot be read (Agent Zero connector protocol is not ready "
                         "or outside the tested v2.14 contract). " + RECHECK % "Agent Zero")
        self.assertEqual((status["swap"]["state"], status["swap"]["running"]), ("swap-back-failed", None))
        self.assertTrue(status["error"]["detail"]["statusProblem"].startswith("Agent Zero connector protocol is not ready"))
        self.assertEqual(self.calls(), ["status", "reconcile", "status"])

    def test_a_failed_check_after_the_switch_rolls_back_through_the_helper(self):
        self.version("2.13")
        self.modes("ok ok not-ready ok")
        _run, status = self.run_action("update", target="recommended", tool="agent-zero")
        self.refused(status, "rolled-back", "HARNESS_SWAPPED_BACK")
        self.assertEqual(self.calls(), ["status", "reconcile", "status", "rollback"])
        self.assertEqual(open(os.path.join(self.fake, "a0-version")).read().strip(), "2.13")

    def test_a_failed_rollback_needs_recovery(self):
        self.version("2.13")
        self.modes("ok ok not-ready fail")
        _run, status = self.run_action("update", target="recommended", tool="agent-zero")
        self.refused(status, "recovery-required", "HARNESS_SWAP_BACK_FAILED")
        self.assertIn("No Agent Zero rollback container exists", status["error"]["message"])

    def test_an_interrupted_update_is_settled_from_its_recorded_state(self):
        for state, expected in (("fencing", "failed"), ("installing", "recovery-required")):
            run = toolctl.Run(self.roots, RUN_ID)
            toolctl.ensure_private_dir(run.dir)
            run.init_status("agent-zero")
            run.status.update(state="running", phase="running", swap={
                "kind": "agent-zero-helper", "fence": toolctl.npm_fence_path(self.roots, "agent-zero"), "from": "2.13",
                "to": "2.14", "state": state})
            run.save()
            toolctl.harness_reconcile_run(self.roots, run, self.policy)
            self.assertEqual(run.status["state"], expected, state)
            if expected == "recovery-required":
                self.assertEqual(run.status["error"]["message"], "The Agent Zero update was interrupted while its container "
                                 "was being replaced. " + RECHECK % "Agent Zero")
            shutil.rmtree(run.dir)


class AgentZeroLockstepTests(unittest.TestCase):
    def test_agent_zero_spec_matches_its_helper_and_policy(self):
        spec = toolctl.HARNESS_SPECS["agent-zero"]
        with open(os.path.join(REPO, "installer", spec["helper"])) as handle:
            text = handle.read()
        value = lambda name: re.search(r'readonly %s="([^"]+)"' % name, text).group(1)
        self.assertEqual(value("A0_VERSION"), spec["pinnedVersion"])
        self.assertEqual(value("A0_IMAGE_REPOSITORY"), spec["image"])
        self.assertEqual(value("A0_AMD64_DIGEST"), spec["pinnedDigests"]["x86_64"])
        self.assertEqual(value("A0_ARM64_DIGEST"), spec["pinnedDigests"]["aarch64"])
        self.assertEqual(value("A0_CONTAINER"), spec["container"])
        self.assertEqual(value("A0_DEFAULT_AUTH_FILE"), toolctl.HARNESS_PATH_DEFAULTS["agent_zero_env"][1])
        self.assertIn("printf 'Agent Zero %s runtime protocol-ready on %s:%s ", text)
        self.assertIn('die() { log "ERROR: $*"; exit 1; }', text)
        self.assertIn("  status) status_runtime ;;\n  reconcile) install_or_update ;;\n  rollback) rollback_runtime ;;", text)
        self.assertEqual(toolctl.policy_tool(load_json(POLICY_PATH), "agent-zero")["newestProven"]["version"],
                         spec["pinnedVersion"])


HERMES_HELPER = os.path.join(REPO, "installer", "hermes-runtime.sh")
HERMES_REPOSITORY = "NousResearch/hermes-agent"
HERMES_COMMIT = "d923a5eb487a17c0a68801bba9ef0f56c81040a8"
HERMES_SOURCE = [("pyproject.toml", "[project]\nname = 'hermes-agent'\n", 0o644), ("uv.lock", "version = 1\n", 0o644),
                 ("hermes/__init__.py", "", 0o644), ("acp_adapter/server.py", "print('acp')\n", 0o644),
                 ("scripts/install.sh", "#!/bin/sh\n", 0o755)]


def hermes_archive(files=HERMES_SOURCE, root="NousResearch-hermes-agent-d923a5e", extra=()):
    """A GitHub-style commit tarball: one root directory, its directories, then files (plus raw extra members)."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as bundle:
        directories = sorted({root} | {root + "/" + "/".join(name.split("/")[:i])
                                       for name, _text, _mode in files for i in range(1, name.count("/") + 1)})
        for path in directories:
            directory = tarfile.TarInfo(path)
            directory.type, directory.mode = tarfile.DIRTYPE, 0o755
            bundle.addfile(directory)
        for name, text, mode in files:
            data = text.encode("utf-8")
            info = tarfile.TarInfo(root + "/" + name)
            info.size, info.mode = len(data), mode
            bundle.addfile(info, io.BytesIO(data))
        for info, data in extra:
            bundle.addfile(info, io.BytesIO(data) if data is not None else None)
    return buffer.getvalue()


def hermes_program(version, check="Hermes ACP check OK"):
    return "#!/bin/sh\nif [ \"$2\" = --check ]; then echo '%s'; else echo '%s'; fi\n" % (check, version)


class HermesHost(HarnessHost):
    """Hermes 0.22.2 in the helper's layout: <root>/0.22.2/.venv/bin/hermes, its attestation, the alias."""

    def setUp(self):
        super().setUp()
        self.hroot = os.path.join(self.runtimes, "hermes")
        self.archive = hermes_archive()
        path = os.path.join(self.base, "source.tar.gz")
        with open(path, "wb") as handle:
            handle.write(self.archive)
        self.tree = toolctl.hermes_source_tree_sha256(path)
        self.entry = self.install_generation("0.22.2")
        os.symlink(self.entry, os.path.join(self.bin_dir, "hermes"))
        self.tag_points_to(HERMES_COMMIT)
        self.github.responses["%s/repos/%s/tarball/%s" % (toolctl.GITHUB_API, HERMES_REPOSITORY, HERMES_COMMIT)] = self.archive

    def install_generation(self, version, commit=HERMES_COMMIT, tree=None, program=None):
        generation = os.path.join(self.hroot, version)
        os.makedirs(os.path.join(generation, ".venv", "bin"))
        for d in (self.hroot, generation, os.path.join(generation, ".venv"), os.path.join(generation, ".venv", "bin")):
            os.chmod(d, 0o755)
        entry = os.path.join(generation, ".venv", "bin", "hermes")
        with open(entry, "w") as handle:
            handle.write(program or hermes_program(version))
        os.chmod(entry, 0o755)
        attestation = os.path.join(generation, ".portal-runtime-attestation-v1")
        with open(attestation, "w") as handle:
            handle.write("schema=bridgesllm-hermes-runtime-v1\nproduct_version=%s\nupstream_tag=v%s\nupstream_commit=%s\n"
                         "source_tree_sha256=%s\nuv_version=0.12.5\npython_version=3.14.7\npython_build=20260901\n"
                         "install_stamp_update_mechanism=external\nextras=acp,mcp\n" % (version, version, commit, tree or self.tree))
        os.chmod(attestation, 0o644)
        return entry

    def tag_points_to(self, sha, kind="commit"):
        self.github.responses["%s/repos/%s/git/ref/tags/v0.22.2" % (toolctl.GITHUB_API, HERMES_REPOSITORY)] = json.dumps(
            {"ref": "refs/tags/v0.22.2", "object": {"type": kind, "sha": sha}}).encode()

    def hermes_record_path(self):
        return os.path.join(self.roots.state_root, "admission", "hermes.json")

    def requalify(self):
        return self.run_action("requalify", tool="hermes")[1]

    def assert_hermes_refused(self, status, code):
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", code), status["error"])
        self.assertFalse(os.path.exists(self.hermes_record_path()), "no record may be written on a refusal")
        self.assertEqual(os.path.realpath(os.path.join(self.bin_dir, "hermes")), self.entry)


class HermesTreeDigestTests(unittest.TestCase):
    """toolctl's tree digest is the helper's hermes_source_tree_sha256, byte for byte, refusals included."""

    def helper_digest(self, archive):
        script = 'HERMES_RUNTIME_SOURCE_ONLY=1 source "$1"; hermes_source_tree_sha256 "$2"'
        done = subprocess.run(["bash", "-c", script, "lockstep", HERMES_HELPER, archive], capture_output=True, text=True,
                              timeout=60)
        return done.stdout.strip() if done.returncode == 0 else None

    def toolctl_digest(self, archive):
        try:
            return toolctl.hermes_source_tree_sha256(archive)
        except toolctl.HarnessRefusal as refusal:
            self.assertEqual(refusal.code, "HARNESS_ARCHIVE_UNEXPECTED")
            return None

    def test_both_digests_agree_on_one_fixture_and_refuse_the_same_archives(self):
        base = tempfile.mkdtemp(prefix="hermes-lockstep-")
        self.addCleanup(shutil.rmtree, base, True)
        link = tarfile.TarInfo("NousResearch-hermes-agent-d923a5e/link")
        link.type, link.linkname = tarfile.SYMTYPE, "pyproject.toml"
        second = tarfile.TarInfo("other-root/file")
        second.size = 1
        dup = tarfile.TarInfo("NousResearch-hermes-agent-d923a5e/uv.lock")
        dup.size = 3
        cases = {
            "fixture": (hermes_archive(), True),
            "modes-and-order": (hermes_archive(list(reversed(HERMES_SOURCE)) + [("zz/b.py", "b", 0o700), ("a.txt", "", 0o600)]),
                                True),
            "symlink": (hermes_archive(extra=[(link, None)]), False),
            "two-roots": (hermes_archive(extra=[(second, b"x")]), False),
            "duplicate": (hermes_archive(extra=[(dup, b"abc")]), False),
            "no-acp-adapter": (hermes_archive([f for f in HERMES_SOURCE if not f[0].startswith("acp_adapter/")]), False),
            "not-gzip": (b"not an archive", False),
        }
        digests = set()
        for name, (data, ok) in cases.items():
            with self.subTest(name):
                path = os.path.join(base, name + ".tar.gz")
                with open(path, "wb") as handle:
                    handle.write(data)
                helper, ours = self.helper_digest(path), self.toolctl_digest(path)
                self.assertEqual(ours, helper)
                self.assertEqual(ours is not None, ok)
                digests.add(ours)
        self.assertEqual(len(digests), 3)  # two distinct trees + None

    def test_both_admit_a_v0_22_5_sized_tree_and_share_one_entry_limit(self):
        # v0.22.5's tarball (bf0203a794a0) has 22,045 members, over the old 20,000 cap on both sides (TEST N7).
        with open(HERMES_HELPER) as handle:
            helper = handle.read()
        self.assertEqual(re.findall(r"\nreadonly HERMES_SOURCE_MAX_ENTRIES=([0-9]+)\n", helper), [str(toolctl.HERMES_SOURCE_MAX_ENTRIES)])
        self.assertEqual(helper.count('"${HERMES_SOURCE_MAX_EXPANDED_BYTES}" "${HERMES_SOURCE_MAX_ENTRIES}" <<'), 1)
        self.assertEqual((toolctl.HERMES_SOURCE_MAX_BYTES, toolctl.HERMES_SOURCE_MAX_EXPANDED_BYTES),
                         (96 * toolctl.MIB, 512 * toolctl.MIB))  # the byte limits are unchanged
        base = tempfile.mkdtemp(prefix="hermes-entries-")
        self.addCleanup(shutil.rmtree, base, True)
        fixture = len(tarfile.open(fileobj=io.BytesIO(hermes_archive())).getmembers())
        limit = toolctl.HERMES_SOURCE_MAX_ENTRIES
        for count, ok in ((22045, True), (limit, True), (limit + 1, False)):
            with self.subTest(count=count):
                pad = []
                for index in range(count - fixture):
                    info = tarfile.TarInfo("NousResearch-hermes-agent-d923a5e/pad/%05d" % index)
                    info.type, info.mode = tarfile.DIRTYPE, 0o755
                    pad.append((info, None))
                path = os.path.join(base, "%d.tar.gz" % count)
                with open(path, "wb") as handle:
                    handle.write(hermes_archive(extra=pad))
                helper_digest, ours = self.helper_digest(path), self.toolctl_digest(path)
                self.assertEqual(ours, helper_digest)
                self.assertEqual(ours is not None, ok)

    def test_spec_matches_the_helper(self):
        with open(HERMES_HELPER) as handle:
            helper = handle.read()
        spec = toolctl.HARNESS_SPECS["hermes"]
        self.assertIn('readonly HERMES_ATTESTATION_NAME="%s"' % spec["attestation"], helper)
        self.assertIn('[[ "${output}" == "%s" ]]' % spec["acpCheck"]["expect"], helper)
        self.assertIn('timeout 30 "${binary}" acp --version', helper)
        self.assertIn('timeout 30 "${binary}" acp --check', helper)
        for name, value in spec["env"].items():
            if name != "HERMES_HOME":
                self.assertIn("%s=%s" % (name, value), helper)
        self.assertIn("readonly HERMES_SOURCE_MAX_BYTES=$((96 * 1024 * 1024))", helper)
        self.assertIn("readonly HERMES_SOURCE_MAX_EXPANDED_BYTES=$((512 * 1024 * 1024))", helper)
        self.assertEqual(toolctl.HERMES_SOURCE_MAX_BYTES, 96 * toolctl.MIB)
        self.assertIn("printf 'https://api.github.com/repos/%s/tarball/%%s\\n'" % HERMES_REPOSITORY, helper)
        self.assertEqual(toolctl.policy_tool(load_json(POLICY_PATH), "hermes")["source"]["repository"], HERMES_REPOSITORY)
        self.assertIn("codeload.github.com", toolctl.HARNESS_DOWNLOAD_HOSTS)


class HermesRequalifyTests(HermesHost):
    def test_admits_the_installed_generation_built_from_the_tag_commit(self):
        status = self.requalify()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["installed", "resolve", "fetch", "compare", "probe", "commit"])
        record = load_json(self.hermes_record_path())
        self.assertEqual((record["toolId"], record["version"], record["layout"], record["admittedBy"]),
                         ("hermes", "0.22.2", "venv-generation", "requalify:" + RUN_ID))
        self.assertEqual(record["executables"]["hermes"], {"path": self.entry, "sha256": toolctl.sha256_file(self.entry)})
        attestation = os.path.join(self.hroot, "0.22.2", ".portal-runtime-attestation-v1")
        self.assertEqual(record["attestationSha256"], toolctl.sha256_file(attestation))
        source = record["source"]
        self.assertEqual((source["kind"], source["tag"], source["commit"], source["treeSha256"], source["authority"],
                          source["bytesVerified"], source["provenDigestMatch"]),
                         ("github-commit", "v0.22.2", HERMES_COMMIT, self.tree, "github-tag-commit", False, None))
        self.assertEqual(record["probes"], {"passed": ["C-VER", "C-ACP"], "failed": [], "notRun": []})
        with open(os.path.join(self.fake, "sandbox-calls.log")) as handle:
            calls = [json.loads(line) for line in handle]
        self.assertEqual([boxed(c)[1:] for c in calls], [["acp", "--version"], ["acp", "--check"]])
        for argv in calls:
            self.assertTrue(sandbox_confined(argv), argv)
            boxed(argv)
            self.assertEqual(sandbox_env(argv)["HERMES_DISABLE_LAZY_INSTALLS"], "1")
        self.assertEqual(self.github.calls[-1], "%s/repos/%s/tarball/%s" % (toolctl.GITHUB_API, HERMES_REPOSITORY, HERMES_COMMIT))

    def test_an_annotated_tag_takes_one_more_hop(self):
        tag_object = "a" * 40
        self.tag_points_to(tag_object, kind="tag")
        self.github.responses["%s/repos/%s/git/tags/%s" % (toolctl.GITHUB_API, HERMES_REPOSITORY, tag_object)] = json.dumps(
            {"tag": "v0.22.2", "object": {"type": "commit", "sha": HERMES_COMMIT}}).encode()
        self.assertEqual(self.requalify()["state"], "succeeded")
        self.github.responses["%s/repos/%s/git/tags/%s" % (toolctl.GITHUB_API, HERMES_REPOSITORY, tag_object)] = json.dumps(
            {"tag": "v0.22.1", "object": {"type": "commit", "sha": HERMES_COMMIT}}).encode()
        os.unlink(self.hermes_record_path())
        self.assert_hermes_refused(self.requalify(), "HARNESS_METADATA_INVALID")

    def test_another_commit_or_tree_is_refused_with_update_offered(self):
        self.tag_points_to("b" * 40)
        status = self.requalify()
        self.assert_hermes_refused(status, "HARNESS_BINARY_DIFFERS")
        self.assertEqual(status["error"]["nextAction"], "update-recommended")
        self.assertIn("names bbbbbbbbbbbb", status["error"]["message"])
        self.tag_points_to(HERMES_COMMIT)
        self.github.responses["%s/repos/%s/tarball/%s" % (toolctl.GITHUB_API, HERMES_REPOSITORY, HERMES_COMMIT)] = \
            hermes_archive(HERMES_SOURCE + [("hermes/extra.py", "x = 1\n", 0o644)])
        status = self.requalify()
        self.assert_hermes_refused(status, "HARNESS_BINARY_DIFFERS")
        self.assertIn("attests a source tree other than the official commit's", status["error"]["message"])

    def test_a_failed_probe_is_refused_with_update_offered(self):
        with open(self.entry, "w") as handle:
            handle.write(hermes_program("0.22.2", check="ACP adapter missing"))
        status = self.requalify()
        self.assert_hermes_refused(status, "CLI_PROBE_FAILED")
        self.assertEqual((status["error"]["detail"]["probe"]["id"], status["error"]["nextAction"]), ("C-ACP", "update-recommended"))

    def test_layout_and_attestation_problems_change_nothing(self):
        attestation = os.path.join(self.hroot, "0.22.2", ".portal-runtime-attestation-v1")
        with open(attestation) as handle:
            good = handle.read()
        cases = [
            ("HARNESS_LAYOUT_UNMANAGED", lambda: open(attestation, "w").write(good.replace("product_version=0.22.2",
                                                                                          "product_version=0.22.3"))),
            ("HARNESS_LAYOUT_UNMANAGED", lambda: open(attestation, "w").write(good.replace(HERMES_COMMIT, "short"))),
            ("HARNESS_TREE_UNSAFE", lambda: os.unlink(attestation)),
            ("HARNESS_TREE_UNSAFE", lambda: os.chmod(self.entry, 0o777)),
        ]
        for code, damage in cases:
            with self.subTest(code):
                damage()
                self.assert_hermes_refused(self.requalify(), code)
                with open(attestation, "w") as handle:
                    handle.write(good)
                os.chmod(attestation, 0o644)
                os.chmod(self.entry, 0o755)
        os.unlink(os.path.join(self.bin_dir, "hermes"))
        with open(os.path.join(self.bin_dir, "hermes"), "w") as handle:
            handle.write("#!/bin/sh\n")
        status = self.requalify()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_LAYOUT_UNMANAGED"))



FAKE_HERMES_HELPER = r"""#!/bin/bash
# Fake installer/hermes-runtime.sh: `stage <dir> <version> <tag> <commit> <tree>` builds a generation in place.
set -eu
[ "$1" = stage ] || exit 2
dir="$2" version="$3" tag="$4" commit="$5" tree="$6"
echo "$*" >> "%(fake)s/helper-calls.log"
if [ -e "%(fake)s/helper-fail" ]; then echo "Could not acquire the pinned Hermes source artifact." >&2; exit 1; fi
[ ! -e "$dir" ] || { echo "exists: $dir" >&2; exit 1; }
mkdir -p "$dir/.venv/bin"
check="Hermes ACP check OK"; [ ! -e "%(fake)s/candidate-acp-broken" ] || check="broken"
printf '#!/bin/sh\nif [ "$2" = --check ]; then echo "%%s"; else echo "%%s"; fi\n' "$check" "$version" > "$dir/.venv/bin/hermes"
printf 'schema=bridgesllm-hermes-runtime-v1\nproduct_version=%%s\nupstream_tag=%%s\nupstream_commit=%%s\nsource_tree_sha256=%%s\n' \
  "$version" "$tag" "$commit" "$tree" > "$dir/.portal-runtime-attestation-v1"
chmod 0755 "$dir/.venv/bin/hermes"
chmod -R u+rwX,go+rX,go-w "$dir"
"""
NEW_COMMIT = "c" * 40


class HermesUpdateHost(HermesHost):
    """A Hermes 0.22.5 release to update to, and the fake helper that stages it."""

    def setUp(self):
        super().setUp()
        helpers = os.path.join(self.base, "portal", "installer")
        os.makedirs(helpers)
        with open(os.path.join(helpers, "hermes-runtime.sh"), "w") as handle:
            handle.write(FAKE_HERMES_HELPER % {"fake": self.fake})
        os.chmod(os.path.join(helpers, "hermes-runtime.sh"), 0o755)
        self.roots.harness_helper_dir = helpers
        self.new_archive = hermes_archive(HERMES_SOURCE + [("hermes/new.py", "new = True\n", 0o644)])
        path = os.path.join(self.base, "new.tar.gz")
        with open(path, "wb") as handle:
            handle.write(self.new_archive)
        self.new_tree = toolctl.hermes_source_tree_sha256(path)
        self.github.responses["%s/repos/%s/git/ref/tags/v0.22.5" % (toolctl.GITHUB_API, HERMES_REPOSITORY)] = json.dumps(
            {"ref": "refs/tags/v0.22.5", "object": {"type": "commit", "sha": NEW_COMMIT}}).encode()
        self.github.responses["%s/repos/%s/tarball/%s" % (toolctl.GITHUB_API, HERMES_REPOSITORY, NEW_COMMIT)] = self.new_archive
        self.new_entry = os.path.join(self.hroot, "0.22.5", ".venv", "bin", "hermes")

    def update(self):
        run, status = self.run_action("update", target="recommended", tool="hermes")
        self.addCleanup(shutil.rmtree, run.dir, True)
        return status


class HermesUpdateTests(HermesUpdateHost):
    """update hermes: in-place stage by the helper, candidate probes, one alias rename, the versioned finish."""

    def unchanged(self):
        self.assertEqual(os.path.realpath(os.path.join(self.bin_dir, "hermes")), self.entry)
        self.assertEqual(sorted(os.listdir(self.hroot)), ["0.22.2"])
        self.assertFalse(os.path.exists(self.hermes_record_path()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "hermes")))

    def test_builds_in_place_probes_switches_and_commits(self):
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["installed", "resolve", "fetch", "stage", "probe-candidate", "swap",
                                                             "probe-installed", "commit", "cleanup"])
        self.assertEqual(os.path.realpath(os.path.join(self.bin_dir, "hermes")), self.new_entry)
        with open(os.path.join(self.fake, "helper-calls.log")) as handle:
            self.assertEqual(handle.read().split(), ["stage", os.path.join(self.hroot, "0.22.5"), "0.22.5", "v0.22.5", NEW_COMMIT,
                                                     self.new_tree])
        record = load_json(self.hermes_record_path())
        self.assertEqual((record["version"], record["admittedBy"], record["source"]["bytesVerified"], record["source"]["commit"],
                          record["source"]["treeSha256"]), ("0.22.5", "run:" + RUN_ID, True, NEW_COMMIT, self.new_tree))
        self.assertEqual(record["executables"]["hermes"], {"path": self.new_entry, "sha256": toolctl.sha256_file(self.new_entry)})
        self.assertEqual(record["attestationSha256"], toolctl.sha256_file(
            os.path.join(self.hroot, "0.22.5", ".portal-runtime-attestation-v1")))
        self.assertEqual(sorted(os.listdir(self.hroot)), ["0.22.2", "0.22.5"])  # the previous generation is kept
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "hermes")))

    def test_a_helper_failure_or_a_bad_candidate_changes_nothing(self):
        for marker, code in (("helper-fail", "HARNESS_HELPER_FAILED"), ("candidate-acp-broken", "CLI_PROBE_FAILED")):
            with self.subTest(code):
                with open(os.path.join(self.fake, marker), "w"):
                    pass
                run, status = self.run_action("update", target="recommended", tool="hermes")
                self.assertEqual((status["state"], status["error"]["id"]), ("refused", code), status["error"])
                self.assertEqual(status["swap"]["state"], "unchanged")
                self.unchanged()
                os.unlink(os.path.join(self.fake, marker))
                shutil.rmtree(run.dir)

    def test_a_leftover_generation_is_kept_aside_and_put_back(self):
        os.makedirs(os.path.join(self.hroot, "0.22.5", "leftover"))
        with open(os.path.join(self.fake, "candidate-acp-broken"), "w"):
            pass
        status = self.update()
        self.assertEqual(status["error"]["id"], "CLI_PROBE_FAILED")
        self.assertEqual(sorted(os.listdir(os.path.join(self.hroot, "0.22.5"))), ["leftover"])

    def test_a_failed_check_after_the_switch_swaps_back(self):
        with open(os.path.join(self.fake, "fail-installed-probe"), "w"):
            pass
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "HARNESS_SWAPPED_BACK"), status["error"])
        self.unchanged()

    def reconcile(self, state, linked):
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        self.addCleanup(shutil.rmtree, run.dir, True)
        run.init_status("hermes")
        version_dir = os.path.join(self.hroot, "0.22.5")
        subprocess.run(["/bin/bash", os.path.join(self.roots.harness_helper_dir, "hermes-runtime.sh"), "stage", version_dir,
                        "0.22.5", "v0.22.5", NEW_COMMIT, self.new_tree], check=True)
        prev = os.path.join(self.hroot, ".bridgesllm-prev")
        run.status["swap"] = {
            "kind": "versioned-symlink", "link": os.path.join(self.bin_dir, "hermes"), "root": self.hroot,
            "stage": os.path.join(self.hroot, ".bridgesllm-stage-" + RUN_ID),
            "staged": os.path.join(self.hroot, ".bridgesllm-stage-" + RUN_ID, "0.22.5"), "versionDir": version_dir,
            "toBinary": self.new_entry, "fromTarget": self.entry, "fromBinary": self.entry,
            "displaced": os.path.join(prev, "0.22.5." + RUN_ID), "failed": os.path.join(prev, "failed." + RUN_ID),
            "fence": toolctl.npm_fence_path(self.roots, "hermes"), "from": "0.22.2", "to": "0.22.5",
            "binarySha256": toolctl.sha256_file(self.new_entry), "state": state,
            "source": {"kind": "github-commit", "tag": "v0.22.5", "commit": NEW_COMMIT, "treeSha256": self.new_tree,
                       "bytesVerified": True}}
        run.save()
        if linked:
            toolctl._replace_symlink(os.path.join(self.bin_dir, "hermes"), self.new_entry, "test")
        toolctl.harness_reconcile_run(self.roots, run, self.policy, fetch=self.github, uid=UID, machine="x86_64",
                                      now=lambda: NOW)
        return run.status

    def test_reconcile_removes_a_half_built_generation_or_finishes_a_switched_one(self):
        status = self.reconcile("staging", linked=False)
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE"))
        self.unchanged()

    def test_reconcile_commits_a_generation_the_alias_already_names(self):
        status = self.reconcile("swapped", linked=True)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(load_json(self.hermes_record_path())["version"], "0.22.5")
        self.assertEqual(os.path.realpath(os.path.join(self.bin_dir, "hermes")), self.new_entry)


# -- newestProven.integrity on this machine (COMMON-W7 integrity contract): qualified + match,
# qualified + mismatch (refused, nothing changed), qualified for the other machine only (not refused,
# provenDigestMatch null), proposed (not compared). The hosts run as machine x86_64.

QUALIFIED_AT = "2026-11-02T10:00:00Z"
OTHER_SHA256 = "sha256:" + "0" * 64


def qualify(policy, tool_id, integrity, version=None):
    proven = toolctl.policy_tool(policy, tool_id)["newestProven"]
    proven.update(status="qualified", integrity=integrity, qualifiedAt=QUALIFIED_AT)
    if version:
        proven["version"] = version


class _PolicyTool(object):
    def __init__(self, kind, integrity, status, machine):
        self.machine = machine
        self.policy = {"label": "Fixture", "source": {"kind": kind}, "newestProven": {
            "version": "1.2.3", "status": status, "integrity": integrity, "qualifiedAt": QUALIFIED_AT}}

    def label(self, version=None):
        return "Fixture %s" % version if version else "Fixture"


class QualifiedIntegrityTests(unittest.TestCase):
    SRI, A, B, TREE = "sha512-" + "B" * 86 + "==", "sha256:" + "a" * 64, "sha256:" + "b" * 64, "sha256-tree:" + "c" * 64

    def value(self, kind, integrity, status="qualified", machine="x86_64", version="1.2.3"):
        return toolctl.qualified_integrity(_PolicyTool(kind, integrity, status, machine), version)

    def test_a_string_applies_on_every_machine(self):
        for kind, integrity in (("npm", self.SRI), ("github-tarball", self.TREE)):
            for machine in ("x86_64", "aarch64", None):
                self.assertEqual(self.value(kind, integrity, machine=machine), integrity)

    def test_an_object_gives_this_machines_entry_or_nothing(self):
        both = {"x86_64": self.A, "aarch64": self.B}
        for kind in ("github-release", "vendor", "container-image"):
            self.assertEqual(self.value(kind, both, machine="x86_64"), self.A)
            self.assertEqual(self.value(kind, both, machine="aarch64"), self.B)
            self.assertIsNone(self.value(kind, {"aarch64": self.B}, machine="x86_64"))
            self.assertIsNone(self.value(kind, {"x86_64": self.A}, machine="aarch64"))
            self.assertIsNone(self.value(kind, both, machine=None))

    def test_proposed_or_another_version_is_not_compared(self):
        self.assertIsNone(self.value("npm", None, status="proposed"))
        self.assertIsNone(self.value("github-release", {"x86_64": self.A}, status="proposed"))
        self.assertIsNone(self.value("npm", self.SRI, version="1.2.4"))

    def test_a_qualified_entry_in_another_form_is_refused_not_skipped(self):
        for kind, integrity in (("github-release", self.A), ("vendor", self.A), ("github-release", {}),
                                ("npm", {"x86_64": self.SRI}), ("github-tarball", self.A), ("container-image", None),
                                ("container-image", self.A)):
            with self.subTest(kind=kind, integrity=integrity), self.assertRaises(toolctl.NpmRefusal) as caught:
                self.value(kind, integrity)
            self.assertEqual(caught.exception.code, "POLICY_INVALID")


class OpenCodeQualifiedTests(HarnessHost):
    def candidate(self, version="1.19.5"):
        return self.github.release(version, archive_bytes([("opencode", opencode_text(version))]))["assets"][0]["digest"]

    def updated(self):
        _run, status = self.run_action("update", "recommended")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        return load_json(self.record_path())["source"]["provenDigestMatch"]

    def test_qualified_for_this_machine_and_matching_updates(self):
        qualify(self.policy, "opencode", {"x86_64": self.candidate(), "aarch64": OTHER_SHA256})
        self.assertIs(self.updated(), True)

    def test_qualified_for_this_machine_and_different_is_refused_before_the_switch(self):
        digest = self.candidate()
        qualify(self.policy, "opencode", {"x86_64": OTHER_SHA256, "aarch64": digest})
        _run, status = self.run_action("update", "recommended")
        self.assert_refused(status, "HARNESS_PROVEN_DIGEST_MISMATCH")
        self.assertIn("does not match the digest the Portal qualified for this server", status["error"]["message"])
        self.assertEqual((status["error"]["detail"]["machine"], status["error"]["detail"]["actual"]), ("x86_64", digest))

    def test_qualified_for_the_other_machine_only_is_not_refused(self):
        self.candidate()
        qualify(self.policy, "opencode", {"aarch64": OTHER_SHA256})
        self.assertIsNone(self.updated())

    def test_proposed_is_not_compared(self):
        self.candidate()
        self.assertIsNone(self.updated())


class OllamaQualifiedTests(OllamaHost):
    def updated(self):
        _run, status = self.run_ollama("update", target="recommended")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        return load_json(self.record_path())["source"]["provenDigestMatch"]

    def test_qualified_for_this_machine_and_matching_updates(self):
        qualify(self.policy, "ollama", {"x86_64": "sha256:" + self.release("0.40.13")})
        self.assertIs(self.updated(), True)

    def test_qualified_for_this_machine_and_different_is_refused_before_the_installer_runs(self):
        qualify(self.policy, "ollama", {"x86_64": OTHER_SHA256, "aarch64": "sha256:" + self.release("0.40.13")})
        _run, status = self.run_ollama("update", target="recommended")
        self.assert_unchanged(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH")
        self.assertEqual(self.installer_calls(), [])

    def test_qualified_for_the_other_machine_only_is_not_refused(self):
        self.release("0.40.13")
        qualify(self.policy, "ollama", {"aarch64": OTHER_SHA256})
        self.assertIsNone(self.updated())

    def test_proposed_is_not_compared(self):
        self.release("0.40.13")
        self.assertIsNone(self.updated())


class HermesQualifiedTests(HermesHost):
    """One canonical source tree for every machine: the string applies everywhere (behaviour unchanged)."""

    def requalified(self):
        status = self.requalify()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        return load_json(self.hermes_record_path())["source"]["provenDigestMatch"]

    def test_qualified_and_matching_is_admitted(self):
        qualify(self.policy, "hermes", "sha256-tree:" + self.tree, version="0.22.2")
        self.assertIs(self.requalified(), True)

    def test_qualified_and_different_is_refused(self):
        qualify(self.policy, "hermes", "sha256-tree:" + "0" * 64, version="0.22.2")
        status = self.requalify()
        self.assert_hermes_refused(status, "HARNESS_PROVEN_DIGEST_MISMATCH")
        self.assertIn("does not match the source tree the Portal qualified", status["error"]["message"])

    def test_proposed_is_not_compared(self):
        toolctl.policy_tool(self.policy, "hermes")["newestProven"]["version"] = "0.22.2"
        self.assertIsNone(self.requalified())


class VendorQualifiedTests(VendorHost):
    def setUp(self):
        super().setUp()
        self.old = self.text("1.0.61")
        self.place(self.old)
        self.program = self.text(self.PINNED).encode()

    def helper_ran(self):
        return os.path.exists(os.path.join(self.fake, "helper-calls.log"))

    def updated(self):
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(self.launcher_text(), self.text(self.PINNED))
        return load_json(self.record_path())["source"]["provenDigestMatch"]

    def test_qualified_for_this_machine_and_matching_updates(self):
        for integrity in ("sha256:" + hashlib.sha256(self.program).hexdigest(), "sha512:" + hashlib.sha512(self.program).hexdigest()):
            with self.subTest(integrity=integrity[:7]):
                qualify(self.policy, self.TOOL, {"x86_64": integrity})
                self.assertIs(self.updated(), True)
                self.place(self.old)
                os.unlink(self.record_path())
                shutil.rmtree(toolctl.Run(self.roots, RUN_ID).dir)

    def test_a_different_sha256_is_refused_before_the_helper_runs(self):
        qualify(self.policy, self.TOOL, {"x86_64": OTHER_SHA256})
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH", self.old)
        self.assertFalse(self.helper_ran(), "nothing may be switched")

    def test_a_different_sha512_puts_the_previous_program_back(self):
        qualify(self.policy, self.TOOL, {"x86_64": "sha512:" + "0" * 128})
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH", self.old)
        self.assertTrue(self.helper_ran())
        self.assertIn("1.0.61 was put back, so nothing was changed", status["error"]["message"])

    def test_qualified_for_the_other_machine_only_is_not_refused(self):
        qualify(self.policy, self.TOOL, {"aarch64": OTHER_SHA256})
        self.assertIsNone(self.updated())

    def test_proposed_is_not_compared(self):
        self.assertIsNone(self.updated())

    def test_requalify_refuses_a_program_that_is_not_the_qualified_one(self):
        self.place(self.text(self.PINNED))
        qualify(self.policy, self.TOOL, {"x86_64": "sha512:" + "0" * 128})
        _run, status = self.run_action("requalify", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH", self.text(self.PINNED))


class AntigravityQualifiedTests(VendorQualifiedTests):
    """No pinned program digest (the helper pins the archive): every comparison runs after the helper."""
    TOOL, EXE, ENV, TEXT, PINNED = "antigravity", "agy", "ANTIGRAVITY_BIN_DIR", FAKE_AGY, "1.4.3"

    def setUp(self):
        super().setUp()
        self.old = self.text("1.4.2")
        self.place(self.old)

    def test_a_different_sha256_is_refused_before_the_helper_runs(self):
        qualify(self.policy, self.TOOL, {"x86_64": OTHER_SHA256})
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH", self.old)
        self.assertTrue(self.helper_ran(), "without a pinned program digest the check runs after the helper")
        self.assertIn("1.4.2 was put back", status["error"]["message"])

    def test_a_different_sha512_puts_the_previous_program_back(self):
        qualify(self.policy, self.TOOL, {"x86_64": "sha512:" + "0" * 128})
        _run, status = self.run_action("update", target="recommended", tool=self.TOOL)
        self.assert_unchanged(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH", self.old)
        self.assertIn("1.4.2 was put back, so nothing was changed", status["error"]["message"])


class AgentZeroQualifiedTests(AgentZeroHost):
    """container-image integrity is keyed by machine: each value is the per-architecture image digest the
    helper pins for that machine (A0_AMD64_DIGEST / A0_ARM64_DIGEST), never the multi-arch index."""

    def setUp(self):
        super().setUp()
        self.version("2.13")
        self.digests = toolctl.HARNESS_SPECS["agent-zero"]["pinnedDigests"]

    def updated(self):
        _run, status = self.run_action("update", target="recommended", tool="agent-zero")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        return load_json(self.record_path())["source"]["provenDigestMatch"]

    def test_qualified_for_the_image_this_machine_pulls_updates(self):
        qualify(self.policy, "agent-zero", {"x86_64": self.digests["x86_64"], "aarch64": self.digests["aarch64"]})
        self.assertIs(self.updated(), True)

    def test_a_different_digest_is_refused_before_the_helper_replaces_anything(self):
        # Another architecture's pinned image under this machine's key is a mismatch, not "not qualified here".
        for wrong in (OTHER_SHA256, self.digests["aarch64"]):
            with self.subTest(wrong=wrong):
                os.makedirs(self.fake, exist_ok=True)
                open(os.path.join(self.fake, "a0-calls.log"), "w").close()
                qualify(self.policy, "agent-zero", {"x86_64": wrong, "aarch64": self.digests["aarch64"]})
                _run, status = self.run_action("update", target="recommended", tool="agent-zero")
                self.refused(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH")
                self.assertEqual(self.calls(), ["status"])
                self.assertIn("does not match the image the Portal qualified for this server", status["error"]["message"])
                self.assertEqual(status["error"]["detail"],
                                 {"expected": wrong, "actual": self.digests["x86_64"], "machine": "x86_64"})

    def test_qualified_for_the_other_machine_only_is_not_refused(self):
        for other in (self.digests["aarch64"], OTHER_SHA256):
            with self.subTest(other=other):
                qualify(self.policy, "agent-zero", {"aarch64": other})
                self.assertIsNone(toolctl.agent_zero_proven_match(self.a0_tool(), "2.14"))
        self.assertIsNone(self.updated())

    def test_each_machine_compares_its_own_pinned_image(self):
        qualify(self.policy, "agent-zero", {"x86_64": OTHER_SHA256, "aarch64": self.digests["aarch64"]})
        self.assertIs(toolctl.agent_zero_proven_match(self.a0_tool("aarch64"), "2.14"), True)
        qualify(self.policy, "agent-zero", {"x86_64": self.digests["x86_64"], "aarch64": OTHER_SHA256})
        with self.assertRaises(toolctl.HarnessRefusal) as caught:
            toolctl.agent_zero_proven_match(self.a0_tool("aarch64"), "2.14")
        self.assertEqual((caught.exception.code, caught.exception.detail["actual"]),
                         ("HARNESS_PROVEN_DIGEST_MISMATCH", self.digests["aarch64"]))

    def test_a_single_string_is_not_a_qualified_image_digest(self):
        qualify(self.policy, "agent-zero", self.digests["x86_64"])
        self.assertTrue(any(".newestProven.integrity" in e for e in toolctl.validate_policy(self.policy)))
        with self.assertRaises(toolctl.NpmRefusal) as caught:
            toolctl.agent_zero_proven_match(self.a0_tool(), "2.14")
        self.assertEqual(caught.exception.code, "POLICY_INVALID")

    def test_proposed_is_not_compared(self):
        self.assertIsNone(self.updated())

    def test_requalify_refuses_an_image_that_is_not_the_qualified_one(self):
        self.version("2.14")
        qualify(self.policy, "agent-zero", {"x86_64": OTHER_SHA256})
        _run, status = self.run_action("requalify", tool="agent-zero")
        self.refused(status, "refused", "HARNESS_PROVEN_DIGEST_MISMATCH")

    def a0_tool(self, machine="x86_64"):
        return toolctl.HarnessTool(self.roots, "agent-zero", toolctl.policy_tool(self.policy, "agent-zero"), self.base,
                                   uid=UID, machine=machine)


def phrases_in_source(path, phrases):
    """(line, phrase) for each phrase in a Python source: in its lines (comments
    too) and in its string constants, where the parser has already joined
    adjacent literals (a phrase split across two lines)."""
    with open(path) as handle:
        source = handle.read()
    found = [(number, phrase) for number, line in enumerate(source.splitlines(), 1) for phrase in phrases if phrase in line]
    found += [(node.lineno, phrase) for node in ast.walk(ast.parse(source))
              if isinstance(node, ast.Constant) and isinstance(node.value, str) for phrase in phrases if phrase in node.value]
    return sorted(set(found))


class RecoveryAdviceGuardTests(unittest.TestCase):
    # Steps that work nowhere toolctl runs: the installer never reads toolctl's
    # runs, its Portal-only repair changes no AI tool, and nothing on a server
    # with the per-tool runner installs a missing one.
    RETIRED = ("installer's repair", "Portal installer first", "keeps maintaining it")

    def test_no_message_names_an_installer_step_that_does_not_work_here(self):
        self.assertEqual(phrases_in_source(TOOLCTL_PATH, self.RETIRED), [])


class LegacyLayoutTests(HarnessHost):
    """F4/F5: Portal 5.0.x left OpenCode at /opt/bridgesllm/tools/opencode/<v>/opencode behind a direct absolute link
    (dirs 0700/0755/0700, binary 0755 root) and never created the managed root. Read it; Update installs into the
    managed layout, switches the launcher and retires the 5.0 generation only after the commit."""

    def setUp(self):
        super().setUp()
        os.chmod(self.base, 0o755)  # a public ancestor, like /usr/local/lib (the managed root is created under it)
        self.legacy = os.path.join(self.base, "opt/bridgesllm/tools")
        self.roots.harness_legacy_root = self.legacy
        self.old = os.path.join(self.legacy, "opencode", "1.18.29")
        os.makedirs(self.old)
        for directory, mode in ((self.legacy, 0o700), (os.path.dirname(self.old), 0o755), (self.old, 0o700)):
            os.chmod(directory, mode)
        self.old_binary = os.path.join(self.old, "opencode")
        with open(self.old_binary, "w") as handle:
            handle.write(opencode_text("1.18.29"))
        os.chmod(self.old_binary, 0o755)
        shutil.rmtree(self.runtimes)  # the managed root never existed there
        self.launcher = os.path.join(self.bin_dir, "opencode")
        os.unlink(self.launcher)
        os.symlink(self.old_binary, self.launcher)
        self.github.release("1.19.5", archive_bytes([("opencode", opencode_text("1.19.5"))]))

    def assert_legacy_unchanged(self):
        self.assertEqual(os.readlink(self.launcher), self.old_binary)
        self.assertTrue(os.path.isfile(self.old_binary))
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))

    def test_the_legacy_version_is_read_and_its_recheck_names_the_update(self):
        _run, status = self.run_action("requalify")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_VERSION_NOT_ADMISSIBLE"), status["error"])
        self.assertEqual(status["error"]["message"], "OpenCode 1.18.29 is older than the Portal floor 1.19.4; update it "
                         "instead.")
        self.assert_legacy_unchanged()

    def test_update_moves_it_into_the_managed_layout_and_retires_the_legacy_generation(self):
        _run, status = self.run_action("update", "recommended")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual((status["result"]["from"], status["result"]["to"]), ("1.18.29", "1.19.5"))
        self.assertEqual(os.readlink(self.launcher), os.path.join(self.root, "1.19.5", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.5"])
        for directory in (self.runtimes, self.root, os.path.join(self.root, "1.19.5")):
            self.assertEqual(stat.S_IMODE(os.stat(directory).st_mode), 0o755, directory)
        self.assertEqual(load_json(self.record_path())["version"], "1.19.5")
        self.assertFalse(os.path.lexists(os.path.dirname(self.old)), "the 5.0 generation and its empty tool directory go")
        self.assertTrue(os.path.isdir(self.legacy), "only that tool's tree is retired")
        self.assertEqual(status["steps"][-1]["detail"], "The 5.0 runtime at %s was retired." % self.old)

    def test_a_failed_check_after_the_switch_puts_the_legacy_launcher_back_and_keeps_its_tree(self):
        with open(os.path.join(self.fake, "fail-installed-probe"), "w"):
            pass
        _run, status = self.run_action("update", "recommended")
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "HARNESS_SWAPPED_BACK"), status["error"])
        self.assert_legacy_unchanged()
        self.assertEqual(os.listdir(self.root), [])

    def test_an_interrupted_cleanup_retires_it_when_the_run_is_settled(self):
        status = self.update_failing_once("harness_retire_legacy")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(os.readlink(self.launcher), os.path.join(self.root, "1.19.5", "opencode"))
        self.assertFalse(os.path.lexists(self.old))

    def test_a_generation_replaced_since_the_update_read_it_is_left_alone(self):
        swap = {"legacyGeneration": self.old, "legacyIdentity": [0, 0], "link": self.launcher, "toBinary": self.old_binary}
        self.assertIn("was left in place", toolctl.harness_retire_legacy(swap))
        self.assertTrue(os.path.isfile(self.old_binary))

    def test_legacy_shapes_the_installer_never_left_are_refused(self):
        os.makedirs(os.path.join(self.old, "bin"))
        nested = os.path.join(self.old, "bin", "opencode")
        shutil.copy2(self.old_binary, nested)
        alias = os.path.join(self.base, "opt/alias")
        os.symlink(self.legacy, alias)
        for target, code in ((os.path.relpath(self.old_binary, self.bin_dir), "HARNESS_LAYOUT_UNMANAGED"),
                             (nested, "HARNESS_LAYOUT_UNMANAGED"),
                             (os.path.join(alias, "opencode", "1.18.29", "opencode"), "HARNESS_LAYOUT_UNMANAGED")):
            with self.subTest(target):
                os.unlink(self.launcher)
                os.symlink(target, self.launcher)
                run, status = self.run_action("update", "recommended")
                self.assertEqual((status["state"], status["error"]["id"]), ("refused", code), status["error"])
                self.assertTrue(os.path.isfile(self.old_binary))
                self.assertFalse(os.path.exists(self.runtimes), "nothing is created for a refused layout")
                shutil.rmtree(run.dir)
        os.unlink(self.launcher)
        os.symlink(self.old_binary, self.launcher)
        os.chmod(self.old_binary, 0o757)
        _run, status = self.run_action("update", "recommended")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_TREE_UNSAFE"), status["error"])
        self.assertTrue(os.path.isfile(self.old_binary))


class HermesLegacyLayoutTests(HermesUpdateHost):
    """F5: Portal 5.0.x left Hermes 0.21.1 at /opt/bridgesllm/tools/hermes/0.21.1 (built from the date tag v2026.9.7)."""

    def setUp(self):
        super().setUp()
        os.chmod(self.base, 0o755)  # a public ancestor, like /usr/local/lib (the managed root is created under it)
        self.legacy = os.path.join(self.base, "opt/bridgesllm/tools")
        self.roots.harness_legacy_root = self.legacy
        hroot, self.hroot = self.hroot, os.path.join(self.legacy, "hermes")
        self.old_entry = self.install_generation("0.21.1")
        attestation = os.path.join(self.hroot, "0.21.1", ".portal-runtime-attestation-v1")
        with open(attestation) as handle:
            text = handle.read()
        with open(attestation, "w") as handle:
            handle.write(text.replace("upstream_tag=v0.21.1", "upstream_tag=v2026.9.7"))
        self.hroot = hroot
        shutil.rmtree(self.hroot)  # no managed Hermes on that server
        self.launcher = os.path.join(self.bin_dir, "hermes")
        os.unlink(self.launcher)
        os.symlink(self.old_entry, self.launcher)

    def test_update_moves_it_into_the_managed_layout_and_retires_the_legacy_generation(self):
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual((status["result"]["from"], status["result"]["to"]), ("0.21.1", "0.22.5"))
        self.assertEqual(os.path.realpath(self.launcher), self.new_entry)
        self.assertEqual(sorted(os.listdir(self.hroot)), ["0.22.5"])
        self.assertEqual(stat.S_IMODE(os.stat(self.hroot).st_mode), 0o755)
        self.assertFalse(os.path.lexists(os.path.join(self.legacy, "hermes")))
        self.assertEqual(load_json(self.hermes_record_path())["version"], "0.22.5")

    def test_a_date_tag_is_accepted_only_for_a_legacy_generation(self):
        tool = toolctl.HarnessTool(self.roots, "hermes", toolctl.policy_tool(self.policy, "hermes"), self.base, uid=UID)
        self.assertEqual(toolctl.hermes_installed(tool)["legacyGeneration"], os.path.join(self.legacy, "hermes", "0.21.1"))
        managed = self.install_generation("0.22.2")
        attestation = os.path.join(self.hroot, "0.22.2", ".portal-runtime-attestation-v1")
        with open(attestation) as handle:
            text = handle.read()
        with open(attestation, "w") as handle:
            handle.write(text.replace("upstream_tag=v0.22.2", "upstream_tag=v2026.9.7"))
        os.unlink(self.launcher)
        os.symlink(managed, self.launcher)
        with self.assertRaises(toolctl.HarnessRefusal) as raised:
            toolctl.hermes_installed(tool)
        self.assertEqual(raised.exception.code, "HARNESS_LAYOUT_UNMANAGED")

    def test_a_helper_failure_changes_nothing(self):
        with open(os.path.join(self.fake, "helper-fail"), "w"):
            pass
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_HELPER_FAILED"), status["error"])
        self.assertEqual(os.readlink(self.launcher), self.old_entry)
        self.assertTrue(os.path.isfile(self.old_entry))

    def test_a_failed_check_after_the_switch_swaps_back(self):
        with open(os.path.join(self.fake, "fail-installed-probe"), "w"):
            pass
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "HARNESS_SWAPPED_BACK"), status["error"])
        self.assertEqual(os.readlink(self.launcher), self.old_entry)
        self.assertTrue(os.path.isfile(self.old_entry))
        self.assertFalse(os.path.exists(self.hermes_record_path()))


class OpenCodeInstallTests(HarnessHost):
    """install opencode: missing (never installed, or removed); what update --target recommended installs, from nothing."""

    def setUp(self):
        super().setUp()
        os.chmod(self.base, 0o755)  # a public ancestor, like /usr/local/lib
        self.launcher = os.path.join(self.bin_dir, "opencode")
        os.unlink(self.launcher)
        shutil.rmtree(self.runtimes)  # the managed root goes too: install creates it like the installer does
        self.state_dir = os.path.join(self.base, "var/lib/bridgesllm/opencode")
        self.github.release("1.19.5", archive_bytes([("opencode", opencode_text("1.19.5"))]))

    def assert_nothing_installed(self):
        self.assertFalse(os.path.lexists(self.launcher))
        self.assertEqual(os.listdir(self.root) if os.path.isdir(self.root) else [], [])
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertFalse(os.path.exists(self.state_dir), "the state directory this run created goes too")
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))

    def test_installs_the_recommended_version_with_what_a_fresh_install_creates(self):
        _run, status = self.run_action("install", "recommended")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], [
            "installed", "resolve", "fetch", "verify-source", "probe-candidate", "swap", "probe-installed", "commit", "cleanup"])
        self.assertEqual((status["result"]["action"], status["result"]["from"], status["result"]["to"]),
                         ("install", None, "1.19.5"))
        self.assertEqual(os.readlink(self.launcher), os.path.join(self.root, "1.19.5", "opencode"))
        self.assertEqual(sorted(os.listdir(self.root)), ["1.19.5"])
        for directory, mode in ((self.runtimes, 0o755), (self.root, 0o755), (self.state_dir, 0o700)):
            self.assertEqual(stat.S_IMODE(os.stat(directory).st_mode), mode, directory)
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["admittedBy"]), ("1.19.5", "run:" + RUN_ID))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "opencode")))

    def test_an_installed_or_occupied_path_is_refused_and_kept(self):
        os.symlink("/elsewhere/opencode", self.launcher)
        run, status = self.run_action("install")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "INSTALL_TOOL_PRESENT"), status["error"])
        self.assertIn("Use Update or Re-check on its card instead", status["error"]["message"])
        self.assertEqual(os.readlink(self.launcher), "/elsewhere/opencode")
        shutil.rmtree(run.dir)
        os.unlink(self.launcher)
        os.makedirs(os.path.join(self.root, "1.19.5"))
        _run, status = self.run_action("install")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "INSTALL_PATH_OCCUPIED"), status["error"])
        self.assertTrue(os.path.isdir(os.path.join(self.root, "1.19.5")))

    def test_a_failed_check_after_the_install_removes_what_it_added(self):
        with open(os.path.join(self.fake, "fail-installed-probe"), "w"):
            pass
        _run, status = self.run_action("install")
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "INSTALL_REMOVED"), status["error"])
        self.assertIn("it was removed again, so nothing was changed.", status["error"]["message"])
        self.assert_nothing_installed()

    def test_a_bad_candidate_changes_nothing(self):
        self.github.release("1.19.5", archive_bytes([("opencode", opencode_text("1.19.5", "no-fork"))]))
        _run, status = self.run_action("install")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "CLI_PROBE_FAILED"), status["error"])
        self.assert_nothing_installed()

    def test_a_crash_after_the_launcher_was_created_is_checked_and_committed(self):
        status = self.update_failing_once("save", self.swap_state_is("swapped"), action="install")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["reconciled"], "checked and committed after the interruption")
        self.assertEqual(os.readlink(self.launcher), os.path.join(self.root, "1.19.5", "opencode"))

    def test_a_crash_while_placing_removes_what_it_added(self):
        status = self.update_failing_once("save", self.swap_state_is("placing"), action="install")
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "INSTALL_REMOVED"), status["error"])
        self.assert_nothing_installed()

    def leftover(self, version="1.18.29", entry_mode=0o755, dir_mode=0o755):
        """A tree the 5.0.x installer left (its `opencode` chmod 0755 in a root-owned version directory), no launcher."""
        old = os.path.join(self.base, "opt/bridgesllm/tools/opencode", version)
        os.makedirs(old)
        with open(os.path.join(old, "opencode"), "w") as handle:
            handle.write(opencode_text("1.18.29"))
        os.chmod(os.path.join(old, "opencode"), entry_mode)
        os.chmod(old, dir_mode)
        self.roots.harness_legacy_root = os.path.join(self.base, "opt/bridgesllm/tools")
        return old

    def test_a_5_0_tree_without_a_launcher_is_retired_after_the_install(self):
        old = self.leftover()
        _run, status = self.run_action("install")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertFalse(os.path.lexists(os.path.dirname(old)))
        self.assertEqual(status["steps"][-1]["detail"], "The 5.0 runtime at %s was retired." % old)

    def test_a_leftover_not_in_the_5_0_installer_shape_is_left_in_place(self):
        # Without a launcher, only the installer's shape proves a 5.0.x tree; anything else is kept.
        def empty(old):
            os.unlink(os.path.join(old, "opencode"))

        def linked(old):
            os.unlink(os.path.join(old, "opencode"))
            os.symlink("/bin/true", os.path.join(old, "opencode"))

        def renamed(old):
            os.rename(old, os.path.join(os.path.dirname(old), "backup"))

        cases = (
            ("empty", empty, "{old}/opencode is missing"),
            ("entry link", linked, "{old}/opencode is not a regular file"),
            ("entry writable", lambda old: os.chmod(os.path.join(old, "opencode"), 0o775),
             "{old}/opencode is writable by other users"),
            ("entry not executable", lambda old: os.chmod(os.path.join(old, "opencode"), 0o644),
             "{old}/opencode is not executable"),
            ("directory writable", lambda old: os.chmod(old, 0o777), "{old} is writable by other users"),
            ("not a version", renamed, "{root}/backup is not a version directory a Portal installer created"),
        )
        for name, damage, reason in cases:
            with self.subTest(name):
                old = self.leftover()
                damage(old)
                root = os.path.dirname(old)
                before = sorted(os.listdir(root))
                run, status = self.run_action("install")
                self.assertEqual(status["state"], "succeeded", status.get("error"))
                self.assertEqual(sorted(os.listdir(root)), before)
                self.assertEqual(status["steps"][-1]["detail"], "What is under %s was left in place: %s." % (
                    root, reason.format(old=old, root=root)))
                self.assertEqual(os.readlink(self.launcher), os.path.join(self.root, "1.19.5", "opencode"))
                for path in (run.dir, os.path.join(self.root, "1.19.5"), os.path.dirname(root)):
                    shutil.rmtree(path)
                os.unlink(self.launcher)
                os.unlink(self.record_path())

    def test_a_runtime_directory_that_is_not_this_runs_is_never_removed(self):
        version_dir = os.path.join(self.root, "1.19.5")
        os.makedirs(os.path.join(version_dir, "kept"))
        swap = toolctl.harness_install_swap(toolctl.HarnessTool(self.roots, "opencode", {}, self.base, uid=UID), toolctl.Run(
            self.roots, RUN_ID), "1.19.5", os.path.join(self.root, ".bridgesllm-stage-x"), toolctl.harness_legacy_facts(None, False))
        swap["identity"] = [0, 0]
        self.assertFalse(toolctl.harness_install_remove(swap))
        self.assertTrue(os.path.isdir(os.path.join(version_dir, "kept")))

    def test_two_5_0_generations_without_a_launcher_are_left_alone(self):
        legacy = os.path.join(self.base, "opt/bridgesllm/tools/opencode")
        for version in ("1.18.28", "1.18.29"):
            os.makedirs(os.path.join(legacy, version))
        self.roots.harness_legacy_root = os.path.dirname(legacy)
        _run, status = self.run_action("install")
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(sorted(os.listdir(legacy)), ["1.18.28", "1.18.29"])
        self.assertEqual(status["steps"][-1]["detail"], "What is under %s was left in place: %s holds 2 entries, so none "
                         "is provably the one this install replaces." % (legacy, legacy))

    def test_a_private_ancestor_is_refused_before_anything_is_created(self):
        os.chmod(self.base, 0o700)
        _run, status = self.run_action("install")
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_TREE_UNSAFE"), status["error"])
        self.assertFalse(os.path.exists(self.runtimes))


class HermesInstallTests(HermesUpdateHost):
    """install hermes: the helper builds the generation in the managed root; the launcher is created after its probes."""

    def setUp(self):
        super().setUp()
        os.chmod(self.base, 0o755)
        self.launcher = os.path.join(self.bin_dir, "hermes")
        os.unlink(self.launcher)
        shutil.rmtree(self.hroot)
        self.state_dir = os.path.join(self.base, "var/lib/bridgesllm/hermes")

    def install(self):
        run, status = self.run_action("install", target="recommended", tool="hermes")
        self.addCleanup(shutil.rmtree, run.dir, True)
        return status

    def test_builds_probes_links_and_commits(self):
        status = self.install()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], ["installed", "resolve", "fetch", "stage", "probe-candidate",
                                                             "swap", "probe-installed", "commit", "cleanup"])
        self.assertEqual(os.readlink(self.launcher), self.new_entry)
        with open(os.path.join(self.fake, "helper-calls.log")) as handle:
            self.assertEqual(handle.read().split(), ["stage", os.path.join(self.hroot, "0.22.5"), "0.22.5", "v0.22.5",
                                                     NEW_COMMIT, self.new_tree])
        self.assertEqual(load_json(self.hermes_record_path())["version"], "0.22.5")
        self.assertEqual(stat.S_IMODE(os.stat(self.state_dir).st_mode), 0o700)

    def test_a_helper_failure_or_a_bad_candidate_leaves_nothing(self):
        for marker, code in (("helper-fail", "HARNESS_HELPER_FAILED"), ("candidate-acp-broken", "CLI_PROBE_FAILED")):
            with self.subTest(code):
                with open(os.path.join(self.fake, marker), "w"):
                    pass
                run, status = self.run_action("install", target="recommended", tool="hermes")
                self.assertEqual((status["state"], status["error"]["id"]), ("refused", code), status["error"])
                self.assertFalse(os.path.lexists(self.launcher))
                self.assertEqual(os.listdir(self.hroot), [])
                self.assertFalse(os.path.exists(self.hermes_record_path()))
                os.unlink(os.path.join(self.fake, marker))
                shutil.rmtree(run.dir)

    def test_a_failed_check_after_the_install_removes_what_it_added(self):
        with open(os.path.join(self.fake, "fail-installed-probe"), "w"):
            pass
        status = self.install()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "INSTALL_REMOVED"), status["error"])
        self.assertFalse(os.path.lexists(self.launcher))
        self.assertEqual(os.listdir(self.hroot), [])
        self.assertFalse(os.path.exists(self.state_dir))

    def legacy_generation(self, tag="v2026.9.7"):
        """What Portal 5.0.x left: /opt/bridgesllm/tools/hermes/0.21.1 with its attestation (date tag), no launcher."""
        legacy = os.path.join(self.base, "opt/bridgesllm/tools")
        self.roots.harness_legacy_root = legacy
        hroot, self.hroot = self.hroot, os.path.join(legacy, "hermes")
        try:
            self.install_generation("0.21.1")
        finally:
            self.hroot = hroot
        generation = os.path.join(legacy, "hermes", "0.21.1")
        attestation = os.path.join(generation, ".portal-runtime-attestation-v1")
        with open(attestation) as handle:
            text = handle.read()
        with open(attestation, "w") as handle:
            handle.write(text.replace("upstream_tag=v0.21.1", "upstream_tag=" + tag))
        return generation

    def test_a_5_0_generation_with_its_attestation_is_retired_after_the_install(self):
        generation = self.legacy_generation()
        status = self.install()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertFalse(os.path.lexists(os.path.dirname(generation)))
        self.assertEqual(status["steps"][-1]["detail"], "The 5.0 runtime at %s was retired." % generation)

    def test_a_generation_without_a_valid_attestation_is_left_in_place(self):
        for name, damage, reason in (
                ("no attestation", lambda g: os.unlink(os.path.join(g, ".portal-runtime-attestation-v1")),
                 "{g}/.portal-runtime-attestation-v1 is missing"),
                ("another version", lambda g: os.rename(g, os.path.join(os.path.dirname(g), "0.21.0")),
                 "{root}/0.21.0 has no valid Portal runtime attestation for 0.21.0"),
                ("not a tag", lambda g: None, "{g} has no valid Portal runtime attestation for 0.21.1"),
                ("linked bin", lambda g: (os.rename(os.path.join(g, ".venv", "bin"), os.path.join(g, "bin-real")),
                                          os.symlink("../bin-real", os.path.join(g, ".venv", "bin"))),
                 "{g}/.venv/bin/hermes is reached through a symbolic link")):
            with self.subTest(name):
                generation = self.legacy_generation(tag="main" if name == "not a tag" else "v2026.9.7")
                root = os.path.dirname(generation)
                damage(generation)
                before = sorted(os.listdir(root))
                run, status = self.run_action("install", target="recommended", tool="hermes")
                self.assertEqual(status["state"], "succeeded", status.get("error"))
                self.assertEqual(sorted(os.listdir(root)), before)
                self.assertEqual(status["steps"][-1]["detail"], "What is under %s was left in place: %s." % (
                    root, reason.format(g=generation, root=root)))
                for path in (run.dir, os.path.join(self.hroot, "0.22.5"), os.path.dirname(root)):
                    shutil.rmtree(path)
                os.unlink(self.launcher)
                os.unlink(self.hermes_record_path())


class VendorInstallTests(VendorHost):
    """install grok-build: the helper's converge installs the pinned program from nothing."""

    def setUp(self):
        super().setUp()
        os.unlink(self.launcher)

    def install(self):
        run, status = self.run_action("install", target="recommended", tool=self.TOOL)
        self.addCleanup(shutil.rmtree, run.dir, True)
        return status

    def test_installs_the_pinned_program_through_the_helper(self):
        status = self.install()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]],
                         ["installed", "resolve", "swap", "probe-installed", "commit", "cleanup"])
        self.assertEqual((status["result"]["action"], status["result"]["from"], status["result"]["to"]),
                         ("install", None, self.PINNED))
        self.assertEqual(self.launcher_text(), self.text(self.PINNED))
        self.assertEqual(load_json(self.record_path())["version"], self.PINNED)
        self.assertEqual(self.leftovers(), [])
        with open(os.path.join(self.fake, "helper-calls.log")) as handle:
            self.assertEqual(handle.read(), "converge\n")

    def test_a_helper_failure_leaves_nothing_installed(self):
        for mode in ("fail-before", "fail-after"):
            with self.subTest(mode):
                self.stage_new(self.text(self.PINNED), mode)
                run, status = self.run_action("install", target="recommended", tool=self.TOOL)
                self.assertEqual((status["state"], status["error"]["id"]), ("refused", "HARNESS_HELPER_FAILED"), status["error"])
                self.assertIn("is still not installed", status["error"]["message"])
                self.assertFalse(os.path.lexists(self.launcher))
                self.assertFalse(os.path.exists(self.record_path()))
                # Nothing placed: reported unchanged, nothing unlinked; placed then failed: that file removed.
                self.assertEqual(status["swap"]["state"], {"fail-before": "unchanged", "fail-after": "removed"}[mode])
                self.assertEqual(status["swap"]["placed"] is None, mode == "fail-before")
                shutil.rmtree(run.dir)

    def test_a_helper_that_places_no_program_file_is_refused_and_touches_nothing(self):
        for mode, state, code in (("place-nothing", "refused", "HARNESS_HELPER_FAILED"),
                                  ("place-link", "recovery-required", "INSTALL_REMOVE_FAILED")):
            with self.subTest(mode):
                self.stage_new(self.text(self.PINNED), mode)
                run, status = self.run_action("install", target="recommended", tool=self.TOOL)
                self.assertEqual((status["state"], status["error"]["id"]), (state, code), status["error"])
                self.assertIn("(it placed no program file at %s)" % self.launcher, status["error"]["message"])
                self.assertEqual(os.path.islink(self.launcher), mode == "place-link")  # a link is never removed
                self.assertFalse(os.path.exists(self.record_path()))
                if mode == "place-link":
                    os.unlink(self.launcher)
                shutil.rmtree(run.dir)

    def test_a_failed_check_after_the_install_removes_the_program(self):
        self.stage_new(self.text(self.PINNED), "break-probes")
        status = self.install()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "INSTALL_REMOVED"), status["error"])
        self.assertFalse(os.path.lexists(self.launcher))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, self.TOOL)))

    def test_removal_never_touches_a_link_at_the_launcher(self):
        self.place(self.text(self.PINNED))
        placed = toolctl.vendor_placed_identity(self.launcher)
        os.unlink(self.launcher)
        os.symlink(os.path.join(self.fake, self.EXE + ".new"), self.launcher)
        self.assertIsNone(toolctl.vendor_placed_identity(self.launcher))
        for swap in ({"link": self.launcher}, {"link": self.launcher, "placed": placed}):
            self.assertEqual(toolctl.vendor_install_remove(swap), "kept")
            self.assertTrue(os.path.islink(self.launcher))

    def test_removal_unlinks_only_the_file_the_helper_placed(self):
        # Identity (device, inode, size, mtime) recorded right after the helper; nothing else is unlinked.
        self.place(self.text(self.PINNED))
        swap = {"link": self.launcher, "placed": toolctl.vendor_placed_identity(self.launcher)}
        self.place(self.text(self.PINNED))  # another file put there since (a new inode, same bytes)
        self.assertEqual(toolctl.vendor_install_remove(swap), "kept")
        self.assertTrue(os.path.isfile(self.launcher))
        swap["placed"] = toolctl.vendor_placed_identity(self.launcher)
        with open(self.launcher, "a") as handle:  # the same inode rewritten
            handle.write("# changed\n")
        self.assertEqual(toolctl.vendor_install_remove(swap), "kept")
        self.assertTrue(os.path.isfile(self.launcher))
        swap["placed"] = toolctl.vendor_placed_identity(self.launcher)
        self.assertEqual(toolctl.vendor_install_remove(swap), "removed")
        self.assertFalse(os.path.lexists(self.launcher))
        self.assertEqual(toolctl.vendor_install_remove({"link": self.launcher, "placed": None}), "unchanged")
        self.place("#!/bin/sh\necho mine\n")
        self.assertEqual(toolctl.vendor_install_remove({"link": self.launcher}), "kept")  # no identity: kept
        self.assertEqual(self.launcher_text(), "#!/bin/sh\necho mine\n")

    def test_a_present_program_is_refused_and_kept(self):
        self.place("#!/bin/sh\necho mine\n")
        status = self.install()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "INSTALL_TOOL_PRESENT"), status["error"])
        self.assertEqual(self.launcher_text(), "#!/bin/sh\necho mine\n")

    def interrupted(self, placed, state="swapped"):
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status(self.TOOL)
        run.status.update(state="running", phase="swap", swap={
            "kind": "vendor-file", "install": True, "link": self.launcher, "backup": None, "fromSha256": None,
            "fence": toolctl.npm_fence_path(self.roots, self.TOOL), "from": None, "to": self.PINNED, "state": state,
            "placed": placed})
        run.save()
        toolctl.harness_reconcile_run(self.roots, run, self.policy)
        return run

    def test_an_interrupted_install_removes_the_program_it_placed(self):
        self.place(self.text(self.PINNED))
        run = self.interrupted(toolctl.vendor_placed_identity(self.launcher))
        self.assertEqual((run.status["state"], run.status["error"]["id"]), ("rolled-back", "INSTALL_REMOVED"))
        self.assertFalse(os.path.lexists(self.launcher))

    def test_an_interrupted_install_keeps_a_program_it_cannot_prove_it_placed(self):
        self.place(self.text(self.PINNED))
        placed = toolctl.vendor_placed_identity(self.launcher)
        for name, identity, state in (("before the identity was recorded", None, "installing"),
                                      ("replaced since", placed, "swapped")):
            with self.subTest(name):
                self.place(self.text(self.PINNED))
                run = self.interrupted(identity, state)
                self.assertEqual((run.status["state"], run.status["error"]["id"]), ("recovery-required", "INSTALL_REMOVE_FAILED"))
                self.assertEqual(self.launcher_text(), self.text(self.PINNED))
                shutil.rmtree(run.dir)


class AntigravityInstallTests(VendorInstallTests):
    TOOL, EXE, ENV, TEXT, PINNED = "antigravity", "agy", "ANTIGRAVITY_BIN_DIR", FAKE_AGY, "1.4.3"


if __name__ == "__main__":
    unittest.main()
