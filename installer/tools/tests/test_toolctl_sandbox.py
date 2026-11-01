#!/usr/bin/env python3
"""The probe sandbox never hands root to candidate or vendor code.

Unit tests pin the argv every sandbox entry point builds: a transient systemd service (PID 1 builds the namespaces,
so neither a user namespace nor bubblewrap is involved) with the host read-only, the host's control-socket trees
hidden, no network, a private scratch /tmp owned by the sandbox identity, env -i's whole environment, and setpriv's
drop to nobody:nogroup (no groups, no capabilities, no_new_privs) right before the program; systemd's $ expansion
escaped; the service stopped whenever toolctl stops waiting for it; the self-test that refuses a server where the
mechanism does not work; and the staged-package hand-over and hand-back around the reviewed npm install script. When
this runs as root where PID 1 sees this test's files (not in a private mount namespace), real sandboxes prove it: a
root-only socket and a root-only file are unreachable while a version probe, a staged candidate's probe and an
install script still work.
"""
import errno
import importlib.util
import io
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLCTL_PATH = os.path.join(os.path.dirname(HERE), "bridgesllm-toolctl.py")
_spec = importlib.util.spec_from_file_location("bridgesllm_toolctl_sandbox", TOOLCTL_PATH)
toolctl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(toolctl)

NOBODY = 65534
DROP = ["--reuid=65534", "--regid=65534", "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs"]
OPTIONS = ["--quiet", "--wait", "--pipe", "--collect", "--service-type=exec"]
# The service every probe runs in (pinned here, not read from toolctl).
PROPERTIES = ["ProtectSystem=strict", "PrivateDevices=yes", "TemporaryFileSystem=/dev/shm",
              "TemporaryFileSystem=/dev/mqueue", "TemporaryFileSystem=/dev/hugepages", "PrivateNetwork=yes",
              "PrivateIPC=yes", "ProtectHostname=yes", "ProtectKernelTunables=yes", "ProtectKernelModules=yes",
              "ProtectKernelLogs=yes", "ProtectControlGroups=yes", "ProtectProc=invisible", "NoNewPrivileges=yes",
              "CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP", "KillMode=control-group", "KillSignal=SIGKILL",
              "RuntimeMaxSec=330"]
# Never: an identity or a user namespace from systemd (setpriv alone drops), or capabilities handed to the program.
FORBIDDEN = ("User=", "Group=", "DynamicUser=", "PrivateUsers=", "SupplementaryGroups=", "AmbientCapabilities=",
             "PrivatePIDs=")
HIDDEN_IF_PRESENT = ["/var/run", "/var/lib/docker", "/var/lib/containerd", "/var/lib/lxd", "/var/lib/kubelet", "/var/snap"]
UNIT_RE = re.compile(r"bridgesllm-tools-probe-[0-9a-f]{16}\.service")
REAL_SYSTEMD_RUN, REAL_ENV, REAL_SETPRIV, REAL_NODE = "/usr/bin/systemd-run", "/usr/bin/env", "/usr/bin/setpriv", "/usr/bin/node"
AS_ROOT = os.geteuid() == 0
# `setpriv --dump` of the sandbox identity (util-linux 2.39 / 2.41).
NOBODY_DUMP = ("uid: 65534\neuid: 65534\ngid: 65534\negid: 65534\nSupplementary groups: [none]\nno_new_privs: 1\n"
               "Inheritable capabilities: [none]\nAmbient capabilities: [none]\nCapability bounding set: [none]\n"
               "Securebits: [none]\nParent death signal: [none]\nAppArmor profile: unconfined\n")


def split(argv):
    """(systemd-run options, properties, environment, setpriv argv, program argv) of a probe sandbox argv, with
    systemd's $$ escaping undone."""
    end = argv.index("--")
    options = [arg for arg in argv[1:end] if not arg.startswith("--property=")]
    properties = [arg[len("--property="):] for arg in argv[1:end] if arg.startswith("--property=")]
    command = [arg.replace("$$", "$") for arg in argv[end + 1:]]
    assert command[1] == "-i", argv
    first = next(i for i in range(2, len(command)) if "=" not in command[i])
    environment = dict(arg.split("=", 1) for arg in command[2:first])
    drop = command.index("--", first)
    return options, properties, environment, command[first:drop], command[drop + 1:]


def binds(properties, kind):
    """(source, destination) of every `kind` (BindPaths / BindReadOnlyPaths) property."""
    return [tuple(value[len(kind) + 1:].split(":", 1)) for value in properties if value.startswith(kind + "=")]


def hidden(properties):
    """Every host path hidden behind a fresh mount (the /dev ones aside)."""
    return [value[len("TemporaryFileSystem="):] for value in properties
            if value.startswith("TemporaryFileSystem=") and not value.startswith("TemporaryFileSystem=/dev/")]


def real_sandbox_missing():
    if not AS_ROOT:
        return "toolctl runs the sandbox as root; this test is not root"
    for path in (REAL_SYSTEMD_RUN, REAL_ENV, REAL_SETPRIV):
        if not toolctl.trusted_executable(path):
            return "%s is not installed" % path
    # PID 1 binds this test's files into the box, so it has to see them (not so inside a private mount namespace).
    probe = tempfile.mkdtemp(prefix="toolctl-sandbox-pid1-")
    try:
        if not os.path.samestat(os.stat("/proc/1/root" + probe), os.stat(probe)):
            return "PID 1 sees another %s" % probe
    except OSError:
        return "PID 1 does not see %s (this runs in a private mount namespace)" % probe
    finally:
        os.rmdir(probe)
    return None


REAL_MISSING = real_sandbox_missing()


class Recorded(Exception):
    pass


class SandboxCase(unittest.TestCase):
    REAL_SELF_TEST = False  # the self-test has its own tests (SelfTestTests) and runs for real in RealConfinementTests

    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="toolctl-sandbox-")
        os.chmod(self.base, 0o755)
        self.addCleanup(shutil.rmtree, self.base, True)
        bins = os.path.join(self.base, "fakebin")
        os.makedirs(bins)
        os.chmod(bins, 0o755)  # fixtures set their modes: an earlier test may leave another process umask
        for name in ("systemd-run", "env", "setpriv", "systemctl", "node"):
            self.fake(os.path.join(bins, name), "#!/bin/sh\nexit 0\n")
        values = {name: default for name, (_env, default) in toolctl.DEFAULTS.items()}
        values.update(state_root=os.path.join(self.base, "state"), systemd_unit_dirs=[os.path.join(self.base, "units")])
        self.roots = toolctl.Roots(**values)
        self.roots.systemd_run_bin, self.roots.env_bin = os.path.join(bins, "systemd-run"), os.path.join(bins, "env")
        self.roots.setpriv_bin, self.roots.systemctl_bin = os.path.join(bins, "setpriv"), os.path.join(bins, "systemctl")
        self.roots.node_bin = os.path.join(bins, "node")
        self.work = os.path.join(self.base, "work")
        os.mkdir(self.work, 0o700)
        if not self.REAL_SELF_TEST:
            patcher = mock.patch.object(toolctl, "sandbox_self_test", return_value=None)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def fake(path, text):
        with open(path, "w") as handle:
            handle.write(text)
        os.chmod(path, 0o755)
        return path

    def assert_sandboxed(self, argv):
        """The whole contract for one recorded command."""
        options, properties, environment, drop, program = split(argv)
        self.assertEqual(argv[0], self.roots.systemd_run_bin)
        self.assertEqual(options[:len(OPTIONS)], OPTIONS)
        units = [option[len("--unit="):] for option in options if option.startswith("--unit=")]
        self.assertEqual(len(units), 1)
        self.assertTrue(UNIT_RE.fullmatch(units[0]), units)
        self.assertEqual((argv.unit, argv.systemctl), (units[0], self.roots.systemctl_bin))
        self.assertEqual(len([option for option in options if option.startswith("--working-directory=/")]), 1)
        self.assertEqual(properties[:len(PROPERTIES)], PROPERTIES)
        for value in properties:
            self.assertFalse(value.startswith(FORBIDDEN), value)
        self.assertEqual(hidden(properties)[:2], ["/run", "/root"])
        scratch = [source for source, destination in binds(properties, "BindPaths") if destination == "/tmp"]
        self.assertEqual(len(scratch), 1)
        self.assertTrue(scratch[0].startswith(self.work + "/sandbox-tmp-"), scratch)
        end = argv.index("--")
        self.assertEqual(argv[end + 1:end + 3], [self.roots.env_bin, "-i"])
        for arg in argv[end + 1:]:  # PID 1 would expand an unescaped $NAME
            self.assertTrue(all(len(run) % 2 == 0 for run in re.findall(r"\$+", arg)), arg)
        self.assertEqual((environment["HOME"], environment["TMPDIR"], environment["PATH"]),
                         ("/tmp/home", "/tmp", toolctl.CLEAN_PATH))
        self.assertEqual(drop, [self.roots.setpriv_bin] + DROP)
        return properties, environment, program


class ProbeSandboxArgvTests(SandboxCase):
    def test_runs_the_program_as_nobody_after_the_drop_in_a_service_pid1_builds(self):
        argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true", "--version"])
        _properties, environment, program = self.assert_sandboxed(argv)
        self.assertEqual(program, ["/usr/bin/true", "--version"])
        self.assertIn("--working-directory=/tmp", split(argv)[0])
        self.assertEqual(set(environment), {"HOME", "TMPDIR", "PATH", "LANG", "NO_COLOR"})

    def test_hides_every_socket_tree_that_is_present_and_follows_no_symlink(self):
        present = set(HIDDEN_IF_PRESENT)
        with mock.patch.object(toolctl.os.path, "isdir", side_effect=lambda path: path in present), \
                mock.patch.object(toolctl.os.path, "islink", side_effect=lambda path: False):
            argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true"])
        self.assertEqual(hidden(split(argv)[1]), ["/run", "/root"] + HIDDEN_IF_PRESENT)
        # /var/run as the usual symlink to /run is already hidden with /run; an absent tree is not mounted on.
        with mock.patch.object(toolctl.os.path, "isdir", side_effect=lambda path: path in ("/var/run", "/var/snap")), \
                mock.patch.object(toolctl.os.path, "islink", side_effect=lambda path: path == "/var/run"):
            argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true"])
        self.assertEqual(hidden(split(argv)[1]), ["/run", "/root", "/var/snap"])

    @unittest.skipUnless(AS_ROOT, "the scratch /tmp is handed to uid 65534, which needs root")
    def test_each_command_gets_a_fresh_scratch_tmp_owned_by_the_sandbox_identity(self):
        first = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true"])
        second = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true"])
        self.assertNotEqual(first.unit, second.unit)
        sources = [[source for source, destination in binds(split(argv)[1], "BindPaths") if destination == "/tmp"][0]
                   for argv in (first, second)]
        self.assertNotEqual(sources[0], sources[1])
        for scratch in sources:
            self.assertEqual(os.listdir(scratch), ["home"])
            for path in (scratch, os.path.join(scratch, "home")):
                info = os.lstat(path)
                self.assertTrue(stat.S_ISDIR(info.st_mode))
                self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (NOBODY, NOBODY, 0o700))

    def test_the_private_directory_above_a_shown_tree_is_found(self):
        above = toolctl.sandbox_private_ancestor(self.base)
        if above:
            self.skipTest("this test's directory sits below the private directory %s" % above)
        os.chmod(self.base, 0o711)
        private = os.path.join(self.base, "private")
        tree = os.path.join(private, "a", "b")
        os.makedirs(tree)
        os.chmod(private, 0o700)
        for path in (os.path.join(private, "a"), tree):
            os.chmod(path, 0o755)
        self.assertEqual(toolctl.sandbox_private_ancestor(os.path.join(tree, "c")), private)
        self.assertEqual(toolctl.sandbox_private_ancestor(tree), private)
        os.chmod(private, 0o711)
        self.assertIsNone(toolctl.sandbox_private_ancestor(tree))

    def test_a_tree_below_a_private_directory_is_shown_alone(self):
        tree = "/opt/private-tools/runtime/1.0"
        with mock.patch.object(toolctl, "sandbox_private_ancestor", return_value="/opt/private-tools"):
            argv = toolctl.probe_sandbox_argv(self.roots, self.work, [tree + "/tool"], readable=tree)
        properties, _environment, _program = self.assert_sandboxed(argv)
        # The private directory is hidden behind a fresh mount, then the tree shows at its own path (PID 1 makes the
        # path down to it, 0755, inside that mount).
        self.assertEqual(properties[-2:], ["TemporaryFileSystem=/opt/private-tools",
                                           "BindReadOnlyPaths=%s:%s" % (tree, tree)])
        self.assertEqual([bind for bind in binds(properties, "BindPaths") if bind[1] != "/tmp"], [])
        # Below a directory already hidden (root's home here) only the tree is shown.
        with mock.patch.object(toolctl, "sandbox_private_ancestor", return_value="/root/x"):
            argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/root/x/y/z/tool"], readable="/root/x/y/z")
        properties = split(argv)[1]
        self.assertEqual(properties[-1], "BindReadOnlyPaths=/root/x/y/z:/root/x/y/z")
        self.assertEqual(hidden(properties).count("/root"), 1)
        self.assertNotIn("/root/x", hidden(properties))
        # A public tree needs nothing: the host is already read-only.
        with mock.patch.object(toolctl, "sandbox_private_ancestor", return_value=None):
            argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/lib/x/tool"], readable="/usr/lib/x")
        self.assertEqual(binds(split(argv)[1], "BindReadOnlyPaths"), [])

    def test_only_the_named_tree_is_writable(self):
        with mock.patch.object(toolctl, "sandbox_private_ancestor", return_value="/var/lib/private"):
            argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/node", "install.cjs"],
                                              writable="/var/lib/private/stage/pkg", cwd="/var/lib/private/stage/pkg")
        properties, _environment, _program = self.assert_sandboxed(argv)
        self.assertEqual([bind for bind in binds(properties, "BindPaths") if bind[1] != "/tmp"],
                         [("/var/lib/private/stage/pkg", "/var/lib/private/stage/pkg")])
        self.assertEqual(binds(properties, "BindReadOnlyPaths"), [])
        self.assertEqual(properties[-2:], ["TemporaryFileSystem=/var/lib/private",
                                           "BindPaths=/var/lib/private/stage/pkg:/var/lib/private/stage/pkg"])
        self.assertIn("--working-directory=/var/lib/private/stage/pkg", split(argv)[0])

    def test_dollar_signs_reach_the_program_unchanged(self):
        args = ["/usr/bin/printf", "$HOME", "${PATH}", "$$", "a$b", "%n", "it's"]
        argv = toolctl.probe_sandbox_argv(self.roots, self.work, args, env=[("X", "$Y")])
        _properties, environment, program = self.assert_sandboxed(argv)
        self.assertEqual(program, args)
        self.assertEqual(environment["X"], "$Y")
        command = argv[argv.index("--") + 1:]
        self.assertIn("$$HOME", command)
        self.assertIn("$$$$", command)
        self.assertIn("X=$$Y", command)

    def test_a_path_systemd_would_change_is_refused(self):
        for bad in ("/opt/tools/a b", "/opt/tools/a:b", "/opt/tools/a'b", "/opt/tools/%n", "/opt/tools/a\\b"):
            with mock.patch.object(toolctl, "sandbox_private_ancestor", return_value="/opt/tools"):
                with self.assertRaises(ValueError):
                    toolctl.probe_sandbox_argv(self.roots, self.work, [bad + "/tool"], readable=bad)
        with self.assertRaises(ValueError):
            toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true"], cwd="/tmp/a b")
        with self.assertRaises(toolctl.NpmRefusal) as caught:
            toolctl.NpmTool(self.roots, "claude-code", {"label": "Claude Code"}, self.work).sandbox_argv(
                ["/usr/bin/claude"], cwd="/tmp/a b")
        self.assertEqual(caught.exception.code, "NPM_SANDBOX_UNAVAILABLE")
        self.assertIn("could not be set up", caught.exception.message)


class EntryPointTests(SandboxCase):
    """Every way toolctl runs candidate or vendor code goes through the same sandbox."""

    def setUp(self):
        super().setUp()
        self.calls = []

    def runner(self, argv, cwd, env, timeout, limit, out_path):
        self.calls.append(argv)
        with open(out_path, "wb"):
            pass
        return 0, "", ""

    def acp(self, argv, *_args, **_kwargs):
        self.calls.append(argv)
        raise Recorded()

    def npm_tool(self, tool_id):
        return toolctl.NpmTool(self.roots, tool_id, {"label": tool_id}, self.work, uid=os.geteuid(), gid=os.getegid(),
                               runner=self.runner)

    def harness_tool(self, tool_id):
        self.roots.harness_runtime_root = os.path.join(self.base, "runtimes")
        self.roots.harness_bin_dir = os.path.join(self.base, "bin")
        self.roots.harness_legacy_root = os.path.join(self.base, "legacy")
        return toolctl.HarnessTool(self.roots, tool_id, {"label": tool_id}, self.work, uid=os.geteuid(), runner=self.runner,
                                   acp=self.acp)

    def test_npm_probes(self):
        tool = self.npm_tool("claude-code")
        toolctl.cli_probe_version(tool, "/usr/bin/claude", "2.1.0")
        toolctl.cli_probe_help(tool, "/usr/bin/claude")
        toolctl.cli_probe_stream_json(tool, "/usr/bin/claude")
        codex = self.npm_tool("codex")
        toolctl.codex_probe_headless(codex, "/usr/bin/codex")
        state = os.path.join(self.base, "openclaw")
        os.mkdir(state)
        with open(os.path.join(state, "openclaw.json"), "w") as handle:
            json.dump({"plugins": {"entries": {"codex": {"config": {"appServer": {"command": "codex"}}}}}}, handle)
        self.roots.openclaw_state_dir = state
        with mock.patch.object(toolctl, "acp_exchange", side_effect=self.acp):
            with self.assertRaises(Recorded):
                toolctl.codex_probe_app(codex, "/usr/bin/codex", "0.170.0")
        self.assertGreaterEqual(len(self.calls), 5)  # C-VER, C-HEADLESS, C-OUTPUT, codex C-HEADLESS (1+), C-APP
        for argv in self.calls:
            _properties, _environment, program = self.assert_sandboxed(argv)
            self.assertIn(program[0], ("/usr/bin/claude", "/usr/bin/codex"))
        self.assertEqual(split(self.calls[-1])[4], ["/usr/bin/codex"] + list(toolctl.CODEX_APP_SERVER_ARGS))

    def test_npm_staged_candidate_probe_reads_only_the_staged_package(self):
        tool = self.npm_tool("claude-code")
        staged = os.path.join(self.work, "stage", "node_modules", "@anthropic-ai", "claude-code")
        os.makedirs(os.path.join(staged, "bin"))
        toolctl.cli_probe_version(tool, os.path.join(staged, "bin", "claude.exe"), "2.1.0")
        properties, _environment, _program = self.assert_sandboxed(self.calls[0])
        self.assertEqual(binds(properties, "BindReadOnlyPaths"), [(staged, staged)])
        self.assertEqual([bind for bind in binds(properties, "BindPaths") if bind[1] != "/tmp"], [])

    def test_harness_probes(self):
        tool = self.harness_tool("opencode")
        executable = os.path.join(self.base, "runtimes", "opencode", "1.2.3", "opencode")
        toolctl.harness_probe_version(tool, executable, "1.2.3")
        with self.assertRaises(Recorded):
            toolctl.harness_probe_acp(tool, executable, "1.2.3")
        hermes = self.harness_tool("hermes")
        toolctl.harness_probe_acp_check(hermes, os.path.join(self.base, "runtimes", "hermes", "0.22.2", ".venv/bin/hermes"))
        self.assertEqual(len(self.calls), 3)
        for argv in self.calls:
            self.assert_sandboxed(argv)
        self.assertEqual(split(self.calls[0])[2]["OPENCODE_DISABLE_AUTOUPDATE"], "1")
        self.assertEqual(split(self.calls[1])[4][1:], toolctl.HARNESS_SPECS["opencode"]["acp"]["args"])
        self.assertEqual(split(self.calls[2])[4][1:], ["acp", "--check"])

    def test_harness_runtime_below_a_private_directory_is_shown_alone(self):
        tool = self.harness_tool("opencode")
        legacy = os.path.join(self.base, "legacy", "opencode")
        with mock.patch.object(toolctl, "sandbox_private_ancestor", return_value=os.path.join(self.base, "legacy")):
            toolctl.harness_probe_version(tool, os.path.join(legacy, "1.2.3", "opencode"), "1.2.3")
        properties, _environment, _program = self.assert_sandboxed(self.calls[0])
        # Shown alone: the tool's whole runtime directory (not just the version).
        self.assertEqual(binds(properties, "BindReadOnlyPaths"), [(legacy, legacy)])

    @unittest.skipUnless(AS_ROOT, "the stage is handed to uid 65534, which needs root")
    def test_npm_install_script_runs_on_a_stage_handed_over_and_back(self):
        tool = self.npm_tool("claude-code")
        staged = os.path.join(self.work, "stage", "node_modules", "@anthropic-ai", "claude-code")
        os.makedirs(os.path.join(staged, "bin"))
        with open(os.path.join(staged, "install.cjs"), "w") as handle:
            handle.write("// reviewed\n")
        os.chmod(os.path.join(staged, "install.cjs"), 0o600)
        owners = []

        def runner(argv, cwd, env, timeout, limit, out_path):
            self.calls.append(argv)
            owners.extend((os.lstat(p).st_uid, os.lstat(p).st_gid) for p in (staged, os.path.join(staged, "bin"),
                                                                             os.path.join(staged, "install.cjs")))
            with open(os.path.join(staged, "bin", "made.txt"), "w") as handle:  # what the script leaves
                handle.write("x")
            os.chmod(os.path.join(staged, "bin", "made.txt"), 0o600)
            return 0, "", ""
        tool.runner = runner
        toolctl.npm_run_allowed_script(tool, staged, {"postinstall": "node install.cjs"})
        self.assertEqual(set(owners), {(NOBODY, NOBODY)})
        properties, _environment, program = self.assert_sandboxed(self.calls[0])
        self.assertEqual(program, [self.roots.node_bin, "install.cjs"])
        self.assertIn((staged, staged), binds(properties, "BindPaths"))
        self.assertIn("--working-directory=" + staged, split(self.calls[0])[0])
        for path, mode in ((staged, 0o755), (os.path.join(staged, "bin"), 0o755), (os.path.join(staged, "install.cjs"), 0o644),
                           (os.path.join(staged, "bin", "made.txt"), 0o644)):
            info = os.lstat(path)
            self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (os.geteuid(), os.getegid(), mode), path)

    @unittest.skipUnless(AS_ROOT, "the stage is handed to uid 65534, which needs root")
    def test_a_failed_or_stuck_install_script_still_hands_the_stage_back(self):
        tool = self.npm_tool("claude-code")
        staged = os.path.join(self.work, "stage", "node_modules", "@anthropic-ai", "claude-code")
        os.makedirs(staged)
        for outcome in ((1, "", "boom"), subprocess.TimeoutExpired("node", 1)):
            def runner(argv, cwd, env, timeout, limit, out_path, outcome=outcome):
                self.assertEqual(os.lstat(staged).st_uid, NOBODY)
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome
            tool.runner = runner
            with self.assertRaises(toolctl.NpmRefusal) as caught:
                toolctl.npm_run_allowed_script(tool, staged, {"postinstall": "node install.cjs"})
            self.assertEqual(caught.exception.code, "NPM_INSTALL_SCRIPT_FAILED")
            self.assertEqual(os.lstat(staged).st_uid, os.geteuid())


class RetreeTests(SandboxCase):
    def stage(self):
        root = os.path.join(self.work, "pkg")
        os.makedirs(os.path.join(root, "bin"), 0o700)
        os.chmod(root, 0o700)
        for name, mode in (("package.json", 0o600), ("bin/tool.js", 0o700)):
            with open(os.path.join(root, name), "w") as handle:
                handle.write("{}")
            os.chmod(os.path.join(root, name), mode)
        os.symlink("tool.js", os.path.join(root, "bin", "link"))
        return root

    def test_publish_gives_the_installer_modes_and_the_runner_owner(self):
        root = self.stage()
        outside = os.path.join(self.base, "outside.txt")
        with open(outside, "w") as handle:
            handle.write("x")
        os.chmod(outside, 0o600)
        os.symlink(outside, os.path.join(root, "escape"))
        toolctl.npm_retree(root, os.geteuid(), os.getegid(), publish=True)
        modes = {name: stat.S_IMODE(os.lstat(os.path.join(root, name)).st_mode)
                 for name in ("", "bin", "package.json", "bin/tool.js")}
        self.assertEqual(modes, {"": 0o755, "bin": 0o755, "package.json": 0o644, "bin/tool.js": 0o755})
        self.assertEqual(stat.S_IMODE(os.stat(outside).st_mode), 0o600, "a link is never followed")

    @unittest.skipUnless(AS_ROOT, "chown to another uid needs root")
    def test_hand_over_changes_owners_only_and_follows_no_link(self):
        root = self.stage()
        outside = os.path.join(self.base, "outside.txt")
        with open(outside, "w") as handle:
            handle.write("x")
        os.symlink(outside, os.path.join(root, "escape"))
        toolctl.npm_retree(root, NOBODY, NOBODY)
        for name in ("", "bin", "package.json", "bin/tool.js", "bin/link", "escape"):
            self.assertEqual(os.lstat(os.path.join(root, name)).st_uid, NOBODY, name)
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(root, "package.json")).st_mode), 0o600)
        self.assertEqual(os.lstat(outside).st_uid, os.geteuid(), "a link is never followed")

    def test_npm_stage_publishes_the_staged_package_and_keeps_its_parents_private(self):
        tool = toolctl.NpmTool(self.roots, "claude-code", {"label": "Claude Code"}, self.work, uid=os.geteuid(),
                               gid=os.getegid())
        package, integrity = tool.layout["packageName"], "sha512-" + "A" * 86 + "=="

        def npm(args, cwd=None, timeout=None, private=True):  # what npm leaves under toolctl's umask 077
            root = os.path.join(cwd, "node_modules", package)
            os.makedirs(os.path.join(root, "bin"), 0o700)
            for path in (os.path.join(cwd, "node_modules"), os.path.dirname(root), root, os.path.join(root, "bin")):
                os.chmod(path, 0o700)
            for name, mode in (("package.json", 0o600), ("bin/claude.exe", 0o700)):
                with open(os.path.join(root, name), "w") as handle:
                    handle.write("{}")
                os.chmod(os.path.join(root, name), mode)
            with open(os.path.join(cwd, "package-lock.json"), "w") as handle:
                json.dump({"lockfileVersion": 3, "packages": {"node_modules/" + package: {"integrity": integrity}}}, handle)
            return 0, "", ""
        tool.npm = npm
        stage, staged = toolctl.npm_stage(tool, "2.1.0", {"node_modules/" + package: integrity})
        modes = {name: stat.S_IMODE(os.lstat(os.path.join(staged, name)).st_mode)
                 for name in ("", "bin", "package.json", "bin/claude.exe")}
        self.assertEqual(modes, {"": 0o755, "bin": 0o755, "package.json": 0o644, "bin/claude.exe": 0o755})
        for path in (stage, os.path.join(stage, "node_modules"), os.path.dirname(staged)):
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o700, path)

    def test_set_id_and_sticky_bits_are_refused(self):
        for name, mode in (("bin/tool.js", 0o4755), ("bin/tool.js", 0o2755), ("bin", 0o3755)):
            root = self.stage()
            os.chmod(os.path.join(root, name), mode)
            with self.assertRaises(toolctl.NpmRefusal) as caught:
                toolctl.npm_retree(root, os.geteuid(), os.getegid(), publish=True)
            self.assertEqual(caught.exception.code, "NPM_TREE_UNSAFE")
            shutil.rmtree(root)

    def test_special_files_are_refused(self):
        root = self.stage()
        os.mkfifo(os.path.join(root, "bin", "pipe"))
        with self.assertRaises(toolctl.NpmRefusal) as caught:
            toolctl.npm_retree(root, os.geteuid(), os.getegid())
        self.assertEqual(caught.exception.code, "NPM_TREE_UNSAFE")

    def test_the_tree_is_bounded(self):
        root = self.stage()
        with self.assertRaises(toolctl.NpmRefusal):
            toolctl.npm_retree(root, os.geteuid(), os.getegid(), max_entries=2)

    def test_sandbox_needs_systemd_run_env_and_setpriv(self):
        self.roots.harness_runtime_root = os.path.join(self.base, "runtimes")
        for name, what in (("systemd_run_bin", "systemd-run"), ("env_bin", "env"), ("setpriv_bin", "setpriv")):
            path = getattr(self.roots, name)
            os.chmod(path, 0o775)  # group-writable: not trusted
            with self.assertRaises(toolctl.NpmRefusal) as caught:
                toolctl.NpmTool(self.roots, "claude-code", {"label": "Claude Code"}, self.work).sandbox_argv(["/usr/bin/claude"])
            self.assertEqual(caught.exception.code, "NPM_SANDBOX_UNAVAILABLE")
            self.assertIn("(%s at %s) is not installed" % (what, path), caught.exception.message)
            with self.assertRaises(toolctl.HarnessRefusal) as caught:
                toolctl.HarnessTool(self.roots, "opencode", {"label": "OpenCode"}, self.work).sandbox_argv(["/usr/bin/opencode"])
            self.assertEqual(caught.exception.code, "HARNESS_SANDBOX_UNAVAILABLE")
            os.chmod(path, 0o755)


class SelfTestTests(SandboxCase):
    """Before a process's first probe the box must show nobody without privileges; otherwise one plain refusal."""
    REAL_SELF_TEST = True

    def systemd_run(self, body):
        """A fake systemd-run: it logs its argv, then runs `body`."""
        log = os.path.join(self.base, "systemd-run.log")
        self.fake(self.roots.systemd_run_bin, "#!/bin/sh\necho \"$@\" >> %s\n%s\n" % (log, body))
        return log

    def refusals(self):
        npm = harness = None
        try:
            toolctl.NpmTool(self.roots, "claude-code", {"label": "Claude Code"}, self.work).sandbox_argv(["/usr/bin/claude"])
        except toolctl.NpmRefusal as refusal:
            npm = refusal
        self.roots.harness_runtime_root = os.path.join(self.base, "runtimes")
        try:
            toolctl.HarnessTool(self.roots, "opencode", {"label": "OpenCode"}, self.work).sandbox_argv(["/usr/bin/opencode"])
        except toolctl.HarnessRefusal as refusal:
            harness = refusal
        return npm, harness

    def test_a_box_that_shows_nobody_without_privileges_passes_once_per_process(self):
        log = self.systemd_run("cat <<'EOF'\n%sEOF" % NOBODY_DUMP)
        self.assertEqual(self.refusals(), (None, None))
        self.assertEqual(self.refusals(), (None, None))
        with open(log) as handle:
            runs = handle.read().splitlines()
        self.assertEqual(len(runs), 1, runs)  # once for the process, whichever tool asks
        self.assertTrue(runs[0].endswith(" NO_COLOR=1 %s %s -- %s --dump" % (self.roots.setpriv_bin, " ".join(DROP),
                                                                               self.roots.setpriv_bin)), runs[0])

    def test_a_server_that_forbids_the_mechanism_gets_one_plain_refusal(self):
        cases = (("echo 'Failed to connect to bus: No such file or directory' >&2; exit 1",
                  "systemd could not run a sandboxed check: exit status 1, Failed to connect to bus: No such file or "
                  "directory"),
                 ("echo 'setpriv: setresuid failed: Operation not permitted' >&2; exit 127",
                  "exit status 127, setpriv: setresuid failed: Operation not permitted"),
                 ("exit 226", "systemd could not run a sandboxed check: exit status 226/NAMESPACE, no message"),
                 ("printf 'uid: 65534\\neuid: 65534\\ngid: 65534\\negid: 65534\\nno_new_privs: 0\\n'",
                  "did not run as nobody without privileges (no 'Supplementary groups: [none]'; no 'no_new_privs: 1'"))
        for body, reason in cases:
            toolctl._SANDBOX_SELF_TESTS.clear()
            self.systemd_run(body)
            npm, harness = self.refusals()
            self.assertEqual((npm.code, harness.code), ("NPM_SANDBOX_UNAVAILABLE", "HARNESS_SANDBOX_UNAVAILABLE"))
            self.assertTrue(npm.message.startswith("The probe sandbox does not work on this server ("), npm.message)
            self.assertTrue(npm.message.endswith("), so Claude Code cannot be checked safely."), npm.message)
            self.assertIn(reason, npm.message)
            self.assertIn(reason, harness.message)


class ReleaseTests(SandboxCase):
    """systemd-run's end does not end the service: toolctl stops it whenever it stops waiting for it."""

    def setUp(self):
        super().setUp()
        self.log = os.path.join(self.base, "systemctl.log")
        self.fake(self.roots.systemctl_bin, "#!/bin/sh\necho \"$@\" >> %s\n" % self.log)

    def stops(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as handle:
            return handle.read().splitlines()

    def test_a_timed_out_or_killed_probe_has_its_service_stopped(self):
        out = os.path.join(self.work, "probe.out")
        for body in ("exec sleep 30", "kill -TERM $$"):
            self.fake(self.roots.systemd_run_bin, "#!/bin/sh\n%s\n" % body)
            argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true"])
            try:
                toolctl.run_captured(argv, "/", {"PATH": toolctl.CLEAN_PATH}, 1, 100, out)
            except subprocess.TimeoutExpired:
                pass
            self.assertEqual(self.stops()[-1], "stop " + argv.unit)
        self.assertEqual(len(self.stops()), 2)
        # The service ran and ended (systemd-run --wait reported it): nothing is left to stop.
        self.fake(self.roots.systemd_run_bin, "#!/bin/sh\nexit 3\n")
        argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true"])
        self.assertEqual(toolctl.run_captured(argv, "/", {"PATH": toolctl.CLEAN_PATH}, 5, 100, out)[0], 3)
        self.assertEqual(len(self.stops()), 2)

    def test_an_acp_exchange_that_ends_its_client_stops_the_service(self):
        self.fake(self.roots.systemd_run_bin, "#!/bin/sh\nexec sleep 30\n")  # never answers, ignores the closed stdin
        argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/true"])
        outcome = toolctl.acp_exchange(argv, [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}], 1,
                                       os.path.join(self.work, "acp.out"))
        self.assertTrue(outcome["timedOut"])
        self.assertEqual(self.stops(), ["stop " + argv.unit])


CHECKER = r'''import errno, json, os, socket, stat, sys
def attempt(action, path):
    try:
        action(path)
        return "ok"
    except OSError as error:
        return errno.errorcode.get(error.errno, str(error.errno))
def connect(path):
    # From the socket's directory: a Unix socket address is at most 107 bytes, a test directory can be longer.
    os.chdir(os.path.dirname(path))
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(os.path.basename(path))
    finally:
        client.close()
def read(path):
    with open(path, "rb") as handle:
        handle.read(1)
def write(path):
    with open(path, "wb") as handle:
        handle.write(b"x")
status = {}
for line in open("/proc/self/status"):
    key, _, value = line.partition(":")
    if key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"):
        status[key] = value.strip()
plan = json.loads(sys.argv[1])
sockets = [os.path.join(top, name) for top, dirs, files in os.walk("/run") for name in dirs + files
           if stat.S_ISSOCK(os.lstat(os.path.join(top, name)).st_mode)]
print(json.dumps({"ids": [os.getuid(), os.geteuid(), os.getgid(), os.getegid()], "groups": os.getgroups(),
                  "status": status, "run": sorted(os.listdir("/run")), "runSockets": sockets,
                  "env": sorted(os.environ),
                  "connect": {p: attempt(connect, p) for p in plan["connect"]},
                  "read": {p: attempt(read, p) for p in plan["read"]},
                  "write": {p: attempt(write, p) for p in plan["write"]}}))
'''


@unittest.skipIf(REAL_MISSING, REAL_MISSING)
class RealConfinementTests(SandboxCase):
    """Real systemd-run, env and setpriv, as toolctl runs them."""
    REAL_SELF_TEST = True

    def setUp(self):
        super().setUp()
        self.roots.systemd_run_bin, self.roots.env_bin, self.roots.setpriv_bin = REAL_SYSTEMD_RUN, REAL_ENV, REAL_SETPRIV
        self.roots.systemctl_bin = toolctl.DEFAULTS["systemctl_bin"][1]
        os.chmod(self.base, 0o700)  # like the tools state root: nothing below it is reachable unless shown
        self.shown = os.path.join(self.base, "shown")
        os.mkdir(self.shown)
        os.chmod(self.shown, 0o755)

    def tree(self, *parts):
        """A directory below the shown tree, each level 0755 whatever the process umask."""
        path = self.shown
        for part in parts:
            path = os.path.join(path, part)
            if not os.path.isdir(path):
                os.mkdir(path)
            os.chmod(path, 0o755)
        return path

    def under_umask_077(self):
        """What production runs toolctl with (bridgesllm-tools@.service UMask=0077; main() sets 077 too)."""
        self.addCleanup(os.umask, os.umask(0o077))

    def assert_published(self, root):
        """Every entry: directories and executables 0755, other files 0644, links left alone."""
        for directory, names, files in os.walk(root):
            for path in [directory] + [os.path.join(directory, name) for name in names + files]:
                info = os.lstat(path)
                if stat.S_ISLNK(info.st_mode):
                    continue
                expected = 0o755 if stat.S_ISDIR(info.st_mode) or info.st_mode & 0o100 else 0o644
                self.assertEqual(oct(stat.S_IMODE(info.st_mode)), oct(expected), path)

    def at(self, path, action):
        """`action(name)` from the directory of `path` (a Unix socket address is at most 107 bytes)."""
        here = os.getcwd()
        os.chdir(os.path.dirname(path))
        try:
            return action(os.path.basename(path))
        finally:
            os.chdir(here)

    def listen(self, path, mode):
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(server.close)
        self.at(path, server.bind)
        os.chmod(path, mode)
        server.listen(4)
        return server

    def file(self, path, text, mode):
        with open(path, "w") as handle:
            handle.write(text)
        os.chmod(path, mode)
        return path

    def test_a_probe_cannot_reach_root_only_sockets_or_files(self):
        root_socket = os.path.join(self.shown, "root-only.sock")
        self.listen(root_socket, 0o600)
        private_dir = os.path.join(self.shown, "private")
        os.mkdir(private_dir, 0o700)
        open_socket = os.path.join(private_dir, "open.sock")
        self.listen(open_socket, 0o666)
        secret = self.file(os.path.join(self.shown, "secret.env"), "TOKEN=1\n", 0o600)
        public = self.file(os.path.join(self.shown, "public.txt"), "hello\n", 0o644)
        checker = self.file(os.path.join(self.shown, "checker.py"), CHECKER, 0o644)
        # Controls outside the sandbox: both sockets answer root.
        for path in (root_socket, open_socket):
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.at(path, client.connect)
            client.close()
        plan = {"connect": [root_socket, open_socket, "/run/systemd/private", "/run/dbus/system_bus_socket",
                            "/var/run/docker.sock"],
                "read": [secret, public], "write": ["/tmp/home/probe.txt", os.path.join(self.shown, "new.txt"), "/etc/x"]}
        self.assertIsNone(toolctl.sandbox_self_test(self.roots, self.work))
        argv = toolctl.probe_sandbox_argv(self.roots, self.work, ["/usr/bin/python3", "-I", checker, json.dumps(plan)],
                                          readable=self.shown)
        completed = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace")[-800:])
        seen = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(seen["ids"], [NOBODY] * 4)
        self.assertEqual(seen["groups"], [])
        self.assertEqual(seen["status"], {"CapInh": "0" * 16, "CapPrm": "0" * 16, "CapEff": "0" * 16, "CapBnd": "0" * 16,
                                          "CapAmb": "0" * 16, "NoNewPrivs": "1"})
        self.assertLessEqual(set(seen["run"]), {"systemd"})  # systemd 255 leaves its root-only incoming/ there
        self.assertEqual(seen["runSockets"], [])
        self.assertEqual(seen["env"], ["HOME", "LANG", "NO_COLOR", "PATH", "TMPDIR"])
        state = subprocess.run([self.roots.systemctl_bin, "is-active", argv.unit], capture_output=True, text=True)
        self.assertNotIn(state.stdout.strip(), ("active", "activating", "deactivating"))
        self.assertEqual(seen["connect"], {root_socket: "EACCES", open_socket: "EACCES", "/run/systemd/private": "ENOENT",
                                           "/run/dbus/system_bus_socket": "ENOENT", "/var/run/docker.sock": "ENOENT"})
        self.assertEqual(seen["read"], {secret: "EACCES", public: "ok"})
        self.assertEqual(seen["write"]["/tmp/home/probe.txt"], "ok")
        self.assertIn(seen["write"][os.path.join(self.shown, "new.txt")], ("EROFS", "EACCES"))
        self.assertIn(seen["write"]["/etc/x"], ("EROFS", "EACCES"))
        self.assertFalse(os.path.exists(os.path.join(self.shown, "new.txt")))

    def test_version_probes_still_pass_for_a_harness_and_a_staged_candidate(self):
        self.roots.harness_runtime_root = os.path.join(self.shown, "runtimes")
        executable = os.path.join(self.tree("runtimes", "opencode", "1.2.3"), "opencode")
        self.file(executable, "#!/usr/bin/python3 -I\nimport os\nprint('1.2.3' if os.getuid() == 65534 else 'root')\n", 0o755)
        harness = toolctl.HarnessTool(self.roots, "opencode", {"label": "OpenCode"}, self.work)
        record = toolctl.harness_probe_version(harness, executable, "1.2.3")
        self.assertEqual(record["state"], "passed", record)
        # npm stages under toolctl's umask 077 in its private work area; npm_stage publishes the staged package.
        tool = toolctl.NpmTool(self.roots, "claude-code", {"label": "Claude Code"}, self.work)
        staged = os.path.join(self.work, "stage", "node_modules", "@anthropic-ai", "claude-code")
        os.makedirs(os.path.join(staged, "bin"), 0o700)
        for path in (os.path.join(self.work, "stage"), os.path.join(self.work, "stage", "node_modules"),
                     os.path.dirname(staged), staged):
            os.chmod(path, 0o700)
        claude = self.file(os.path.join(staged, "bin", "claude.exe"),
                           "#!/usr/bin/python3 -I\nimport os\nprint('2.1.0 (Claude Code)' if os.getuid() == 65534 else 'root')\n",
                           0o700)
        record = toolctl.cli_probe_version(tool, claude, "2.1.0")
        self.assertEqual(record["state"], "failed", "unpublished, the candidate is unreadable to the sandbox identity")
        toolctl.npm_retree(staged, 0, 0, publish=True)
        record = toolctl.cli_probe_version(tool, claude, "2.1.0")
        self.assertEqual(record["state"], "passed", record)

    @unittest.skipUnless(toolctl.trusted_executable(REAL_NODE), "Node.js is not installed")
    def test_the_install_script_runs_as_nobody_and_set_id_bits_are_refused(self):
        self.roots.node_bin = REAL_NODE
        tool = toolctl.NpmTool(self.roots, "claude-code", {"label": "Claude Code"}, self.work)
        staged = os.path.join(self.work, "stage", "node_modules", "@anthropic-ai", "claude-code")
        os.makedirs(os.path.join(staged, "bin"))
        self.file(os.path.join(staged, "bin", "claude.exe"), "#!/bin/sh\n", 0o755)
        self.file(os.path.join(staged, "install.cjs"),
                  "const fs = require('fs');\n"
                  "fs.writeFileSync('made.txt', String(process.getuid()));\n"
                  "fs.writeFileSync(require('os').homedir() + '/state', 'x');\n"
                  "try { fs.writeFileSync('/etc/bridgesllm-probe', 'x'); process.exit(3); } catch (e) {}\n"
                  "const bus = require('net').connect('/run/systemd/private');\n"
                  "bus.on('connect', () => process.exit(4)); bus.on('error', () => {});\n"
                  "if (process.env.SETUID) fs.chmodSync('bin/claude.exe', 0o4755);\n", 0o644)
        toolctl.npm_retree(staged, 0, 0, publish=True)
        toolctl.npm_run_allowed_script(tool, staged, {"postinstall": "node install.cjs"})
        with open(os.path.join(staged, "made.txt")) as handle:
            self.assertEqual(handle.read(), str(NOBODY))
        info = os.lstat(os.path.join(staged, "made.txt"))
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o644))
        self.assertFalse(os.path.exists("/etc/bridgesllm-probe"))
        # A script that leaves a set-user-ID file is refused when the stage is handed back.
        original = toolctl.probe_sandbox_argv

        def with_setuid(*args, **kwargs):
            argv = original(*args, **kwargs)
            at = argv.index("-i", argv.index("--")) + 1
            changed = toolctl.SandboxArgv(argv[:at] + ["SETUID=1"] + argv[at:])
            changed.unit, changed.systemctl = argv.unit, argv.systemctl
            return changed
        with mock.patch.object(toolctl, "probe_sandbox_argv", side_effect=with_setuid):
            with self.assertRaises(toolctl.NpmRefusal) as caught:
                toolctl.npm_run_allowed_script(tool, staged, {"postinstall": "node install.cjs"})
        self.assertEqual(caught.exception.code, "NPM_TREE_UNSAFE")
        self.assertIn("set-user-ID", caught.exception.message)

    # The flows below produce their tree under umask 077, as on a server, and run toolctl's real probes on it.

    def test_a_harness_candidate_staged_under_umask_077_passes_its_real_probe(self):
        self.under_umask_077()
        self.roots.harness_runtime_root = self.tree("runtimes")
        self.tree("runtimes", "opencode")
        program = b"#!/usr/bin/python3 -I\nimport os\nprint('1.2.3' if os.getuid() == 65534 else 'root')\n"
        archive = os.path.join(self.work, "opencode.tar.gz")
        with tarfile.open(archive, "w:gz") as bundle:
            member = tarfile.TarInfo("opencode")
            member.size, member.mode = len(program), 0o700
            bundle.addfile(member, io.BytesIO(program))
        tool = toolctl.HarnessTool(self.roots, "opencode", {"label": "OpenCode", "probes": {"required": ["C-VER"]}},
                                   self.work)
        run, evidence = types.SimpleNamespace(run_id="20261101T000000Z-aaaaaaaa"), {}
        with mock.patch.object(toolctl, "harness_fetch_release", return_value=archive), \
                mock.patch.object(toolctl, "harness_verify_archive", return_value={"kind": "github-release"}):
            stage, staged, _sha, _source = toolctl.versioned_candidate(tool, run, "1.2.3", {"size": len(program)},
                                                                       toolctl._phase_factory(None), evidence, None)
        self.assertEqual([(p["id"], p["state"]) for p in evidence["probes"]], [("C-VER", "passed")], evidence["probes"])
        self.assertEqual(os.listdir(stage), ["1.2.3"])
        self.assert_published(stage)

    def test_a_hermes_generation_built_under_umask_077_passes_its_real_probes(self):
        self.under_umask_077()
        self.roots.harness_runtime_root = self.tree("runtimes")
        root = self.tree("runtimes", "hermes")
        helper = self.file(os.path.join(self.work, "hermes-runtime.sh"), HERMES_STAGE_HELPER, 0o755)
        tool = toolctl.HarnessTool(self.roots, "hermes", {"label": "Hermes", "probes": {"required": ["C-VER", "C-ACP"]}},
                                   self.work)
        run, evidence = types.SimpleNamespace(run_id="20261101T000000Z-bbbbbbbb"), {}
        swap = toolctl.harness_install_swap(tool, run, "0.22.5", os.path.join(root, ".bridgesllm-stage-x"), {},
                                            source={"treeSha256": "0" * 64}, state="staging")
        toolctl.hermes_stage_generation(tool, helper, swap, "c" * 40, evidence, "Hermes is still not installed")
        self.assertEqual(evidence["helper"]["exitCode"], 0, evidence["helper"])
        self.assertEqual(evidence["helper"]["stdout"].split(), ["0700", "0600"], "what the helper left under umask 077")
        probes, failed = toolctl.harness_probe_set(tool, swap["toBinary"], "0.22.5")
        self.assertIsNone(failed, probes)
        self.assertEqual([(p["id"], p["state"]) for p in probes], [("C-VER", "passed"), ("C-ACP", "passed")])
        self.assert_published(swap["versionDir"])
        self.assertEqual(os.readlink(os.path.join(swap["versionDir"], ".portal-tools", "python3")), "/usr/bin/python3")

    def test_a_vendor_program_placed_under_umask_077_passes_its_real_probes(self):
        self.under_umask_077()
        self.roots.harness_bin_dir = self.tree("bin")
        os.makedirs(os.path.join(self.base, "state"), 0o700)
        helper = self.file(os.path.join(self.work, "antigravity-runtime.sh"), VENDOR_CONVERGE_HELPER, 0o755)
        tool = toolctl.HarnessTool(self.roots, "antigravity", {"label": "Antigravity", "probes": {"required": ["C-VER"]}},
                                   self.work, machine="x86_64")
        # On a server the launcher directory is public (/usr/local/bin); here it sits below the private test root,
        # so it is shown the way a runtime root is.
        tool.root = self.roots.harness_bin_dir
        evidence = {}
        code, reason = toolctl.vendor_run_helper(tool, helper, evidence)
        self.assertEqual(code, 0, reason)
        self.assertEqual(stat.S_IMODE(os.lstat(tool.link).st_mode), 0o700, "what the helper left under umask 077")
        swap = {"kind": "vendor-file", "install": True, "link": tool.link, "backup": None, "fromSha256": None,
                "placed": toolctl.vendor_placed_identity(tool.link), "fence": toolctl.npm_fence_path(self.roots, tool.tool_id),
                "from": None, "to": "1.4.3", "helper": helper, "state": "swapped"}
        run = types.SimpleNamespace(run_id="20261101T000000Z-cccccccc", status={"swap": swap}, save=lambda: None)
        record, evidence = toolctl.vendor_finish_swap(tool, run, swap, evidence, toolctl._phase_factory(None),
                                                      toolctl.utc_now)
        self.assertEqual(swap["state"], "committed")
        self.assertEqual([(p["id"], p["state"]) for p in evidence["probes"]], [("C-VER", "passed")], evidence["probes"])
        self.assertEqual(record["version"], "1.4.3")
        info = os.lstat(tool.link)
        self.assertEqual((info.st_uid, stat.S_IMODE(info.st_mode)), (0, 0o755))
        self.assertEqual(toolctl.vendor_placed_identity(tool.link), swap["placed"], "a mode change keeps the identity")

    def test_a_set_id_program_or_a_special_file_is_refused_before_any_probe(self):
        self.under_umask_077()
        root = self.tree("runtimes", "hermes", "0.22.5")
        self.file(os.path.join(root, "hermes"), "#!/bin/sh\n", 0o4755)
        tool = toolctl.HarnessTool(self.roots, "hermes", {"label": "Hermes"}, self.work)
        with self.assertRaises(toolctl.HarnessRefusal) as caught:
            toolctl.harness_publish(tool, root)
        self.assertEqual(caught.exception.code, "HARNESS_TREE_UNSAFE")
        self.assertIn("set-user-ID", caught.exception.message)
        self.assertIn(root, caught.exception.message)
        os.chmod(os.path.join(root, "hermes"), 0o755)
        os.mkfifo(os.path.join(root, "pipe"))
        with self.assertRaises(toolctl.HarnessRefusal) as caught:
            toolctl.harness_publish(tool, root)
        self.assertEqual(caught.exception.code, "HARNESS_TREE_UNSAFE")
        self.assertIn("special file", caught.exception.message)


# installer/hermes-runtime.sh `stage` builds the generation with uv; this one leaves what anything does under the
# caller's umask 077 (0700 directories, 0600 files) and prints two of those modes.
HERMES_STAGE_HELPER = r'''set -eu
dir="$2"; version="$3"
mkdir -p "$dir/.venv/bin" "$dir/.venv/lib/hermes_fake" "$dir/.portal-tools"
ln -s /usr/bin/python3 "$dir/.portal-tools/python3"
printf 'VERSION = "%s"\n' "$version" > "$dir/.venv/lib/hermes_fake/__init__.py"
cat > "$dir/.venv/bin/hermes" <<'EOF'
#!/usr/bin/python3 -I
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "lib"))
import hermes_fake
if os.getuid() != 65534:
    sys.exit("not the sandbox identity")
if sys.argv[1:] == ["acp", "--version"]:
    print("hermes-agent " + hermes_fake.VERSION)
elif sys.argv[1:] == ["acp", "--check"]:
    print("Hermes ACP check OK")
else:
    sys.exit(2)
EOF
chmod u+x "$dir/.venv/bin/hermes"
printf '{}\n' > "$dir/.portal-runtime-attestation-v1"
stat -c %a "$dir/.venv" "$dir/.venv/lib/hermes_fake/__init__.py" | sed 's/^/0/'
'''

# installer/antigravity-runtime.sh `converge` places the vendor program with one rename; this one writes it under the
# caller's umask 077 (0700).
VENDOR_CONVERGE_HELPER = r'''set -eu
[ "$1" = converge ]
cat > "$ANTIGRAVITY_BIN_DIR/.agy.new" <<'EOF'
#!/usr/bin/python3 -I
import os
print("Antigravity CLI 1.4.3" if os.getuid() == 65534 else "root")
EOF
chmod u+x "$ANTIGRAVITY_BIN_DIR/.agy.new"
mv -f "$ANTIGRAVITY_BIN_DIR/.agy.new" "$ANTIGRAVITY_BIN_DIR/agy"
'''


if __name__ == "__main__":
    unittest.main()
