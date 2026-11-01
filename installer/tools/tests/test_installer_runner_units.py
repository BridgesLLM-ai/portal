"""install.sh: per-tool runner installation (updater v2 item K9).

The installer functions are extracted by name from installer/install.sh and run
in bash against a temporary root with a fake systemctl. Nothing touches the
host's unit directory or /var/lib.
"""
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
INSTALL_SH = os.path.join(REPO, "installer", "install.sh")
TOOLS_STATUS_TS = os.path.join(REPO, "backend", "src", "services", "toolsStatus.ts")
FUNCTIONS = (
    "tools_runner_path_is_root_controlled",
    "tools_runner_installed",
    "tools_runner_install_refused",
    "install_tools_runner_unit_file",
    "install_tools_runner_units",
    "install_tools_runner_units_or_warn",
)


def extract_functions(names):
    with open(INSTALL_SH, encoding="utf-8") as handle:
        lines = handle.read().split("\n")
    bodies = []
    for name in names:
        starts = [i for i, line in enumerate(lines) if line == name + "() {"]
        if len(starts) != 1:
            raise AssertionError("%s defined %d times" % (name, len(starts)))
        end = next(i for i in range(starts[0], len(lines)) if lines[i] == "}")
        bodies.append("\n".join(lines[starts[0]:end + 1]))
    return "\n".join(bodies)


def readonly_value(name):
    with open(INSTALL_SH, encoding="utf-8") as handle:
        match = re.search(r'^readonly %s="([^"]*)"$' % name, handle.read(), re.M)
    if not match:
        raise AssertionError("missing readonly %s" % name)
    return match.group(1)


@unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "needs root (chown 0:0)")
class InstallToolsRunnerUnits(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="runner-units-")
        os.chmod(self.root, 0o755)
        self.install_root = os.path.join(self.root, "opt", "bridgesllm")
        self.portal = os.path.join(self.install_root, "portal")
        self.unit_dir = os.path.join(self.root, "etc", "systemd", "system")
        self.state_root = os.path.join(self.root, "var", "lib", "bridgesllm", "tools")
        for directory in (os.path.join(self.portal, "installer", "tools"),
                          os.path.join(self.portal, "installer", "systemd"),
                          self.unit_dir, os.path.join(self.root, "var", "lib"), os.path.join(self.root, "bin")):
            os.makedirs(directory, mode=0o755, exist_ok=True)
        for current, dirs, _files in os.walk(self.root):
            os.chmod(current, 0o755)
        for name in ("bridgesllm-tools@.service", "bridgesllm-tools-reconcile.service"):
            shutil.copyfile(os.path.join(REPO, "installer", "systemd", name),
                            os.path.join(self.portal, "installer", "systemd", name))
        for name in ("bridgesllm-toolctl.py", "tool-policy.v2.json"):
            with open(os.path.join(self.portal, "installer", "tools", name), "w") as handle:
                handle.write("# fixture %s\n" % name)
        for current, _dirs, files in os.walk(self.portal):
            for name in files:
                os.chmod(os.path.join(current, name), 0o644)
        self.calls = os.path.join(self.root, "systemctl.calls")
        fake = os.path.join(self.root, "bin", "systemctl")
        with open(fake, "w") as handle:
            handle.write('#!/bin/bash\nprintf "%%s\\n" "$*" >> %s\n'
                         'if [[ "$1" == "${FAKE_SYSTEMCTL_FAIL:-none}" ]]; then exit 1; fi\nexit 0\n' % self.calls)
        os.chmod(fake, 0o755)
        self.log = os.path.join(self.root, "install.log")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_installer(self, function="install_tools_runner_units_or_warn", extra_env=None):
        script = "\n".join([
            "set -uo pipefail",
            'INSTALL_ROOT="%s"' % self.install_root,
            'PORTAL_DIR="%s"' % self.portal,
            'TOOLS_RUNNER_STATE_ROOT="%s"' % self.state_root,
            'TOOLS_RUNNER_UNIT_DIR="%s"' % self.unit_dir,
            'TOOLS_RUNNER_RUN_UNIT="%s"' % readonly_value("TOOLS_RUNNER_RUN_UNIT"),
            'TOOLS_RUNNER_RECONCILE_UNIT="%s"' % readonly_value("TOOLS_RUNNER_RECONCILE_UNIT"),
            'TOOLS_RUNNER_INSTALL_REASON=""',
            'LOG_FILE="%s"' % self.log,
            'ok() { printf "OK:%s\\n" "$*"; }',
            'warn() { printf "WARN:%s\\n" "$*"; }',
            'info() { printf "INFO:%s\\n" "$*"; }',
            extract_functions(FUNCTIONS),
            function,
            'printf "EXIT:%s\\n" "$?"',
        ])
        env = {"PATH": os.path.join(self.root, "bin") + ":/usr/bin:/bin", "LC_ALL": "C"}
        env.update(extra_env or {})
        result = subprocess.run(["/bin/bash", "-c", script], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def systemctl_calls(self):
        if not os.path.exists(self.calls):
            return []
        with open(self.calls) as handle:
            return handle.read().splitlines()

    def unit(self, name):
        return os.path.join(self.unit_dir, name)

    def assert_installed_unit(self, name):
        path = self.unit(name)
        info = os.lstat(path)
        self.assertTrue(stat.S_ISREG(info.st_mode))
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o644))
        with open(path, "rb") as installed, open(os.path.join(REPO, "installer", "systemd", name), "rb") as shipped:
            self.assertEqual(installed.read(), shipped.read())

    def test_fresh_layout_installs_enables_and_never_starts(self):
        out = self.run_installer()
        self.assertIn("OK:Per-tool AI updater installed", out)
        self.assertIn("EXIT:0", out)
        self.assert_installed_unit("bridgesllm-tools@.service")
        self.assert_installed_unit("bridgesllm-tools-reconcile.service")
        info = os.lstat(self.state_root)
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o700))
        self.assertEqual(self.systemctl_calls(), ["daemon-reload", "enable bridgesllm-tools-reconcile.service"])
        self.assertEqual([n for n in os.listdir(self.unit_dir) if n.startswith(".")], [])
        out = self.run_installer("tools_runner_installed")
        self.assertIn("EXIT:0", out)

    def test_rerun_is_idempotent_and_repairs_mode(self):
        self.run_installer()
        before = os.stat(self.unit("bridgesllm-tools@.service")).st_ino
        os.chmod(self.unit("bridgesllm-tools-reconcile.service"), 0o664)
        os.chmod(self.state_root, 0o755)
        out = self.run_installer()
        self.assertIn("OK:Per-tool AI updater installed", out)
        self.assertEqual(os.stat(self.unit("bridgesllm-tools@.service")).st_ino, before)
        self.assert_installed_unit("bridgesllm-tools-reconcile.service")
        self.assertEqual(stat.S_IMODE(os.lstat(self.state_root).st_mode), 0o700)

    def test_writable_toolctl_is_refused_with_a_reason(self):
        os.chmod(os.path.join(self.portal, "installer", "tools", "bridgesllm-toolctl.py"), 0o666)
        out = self.run_installer()
        self.assertIn("WARN:The per-tool AI updater could not be fully installed: ", out)
        self.assertIn("bridgesllm-toolctl.py is missing, a link, or writable by a non-root user", out)
        self.assertIn("EXIT:0", out)
        self.assertFalse(os.path.lexists(self.unit("bridgesllm-tools@.service")))
        self.assertEqual(self.systemctl_calls(), [])
        out = self.run_installer("tools_runner_installed")
        self.assertIn("EXIT:1", out)

    def test_masked_unit_is_left_alone_and_template_not_published(self):
        os.symlink("/dev/null", self.unit("bridgesllm-tools-reconcile.service"))
        out = self.run_installer()
        self.assertIn("is not a regular file (masked or replaced by the owner)", out)
        self.assertEqual(os.readlink(self.unit("bridgesllm-tools-reconcile.service")), "/dev/null")
        self.assertFalse(os.path.lexists(self.unit("bridgesllm-tools@.service")))
        self.assertEqual(self.systemctl_calls(), [])

    def test_enable_failure_warns_and_never_fails(self):
        out = self.run_installer(extra_env={"FAKE_SYSTEMCTL_FAIL": "enable"})
        self.assertIn("systemd could not enable bridgesllm-tools-reconcile.service for boot", out)
        self.assertIn("EXIT:0", out)
        with open(self.log) as handle:
            self.assertIn("Per-tool AI updater: systemd could not enable", handle.read())

    def test_release_without_toolctl_is_quiet(self):
        os.unlink(os.path.join(self.portal, "installer", "tools", "bridgesllm-toolctl.py"))
        out = self.run_installer()
        self.assertIn("INFO:This Portal release has no per-tool AI updater", out)
        self.assertNotIn("WARN:", out)
        self.assertEqual(self.systemctl_calls(), [])

    def test_stale_temporary_from_an_interrupted_copy_is_removed(self):
        stale = os.path.join(self.unit_dir, ".bridgesllm-tools.AbC123")
        with open(stale, "w") as handle:
            handle.write("partial")
        self.run_installer()
        self.assertFalse(os.path.exists(stale))

    def test_state_root_link_is_refused(self):
        os.makedirs(os.path.dirname(self.state_root), mode=0o755)
        os.symlink(self.root, self.state_root)
        out = self.run_installer()
        self.assertIn("is a link, not a directory, or not owned by root", out)
        self.assertFalse(os.path.lexists(self.unit("bridgesllm-tools-reconcile.service")))


    def maintain_tools(self):
        script = "\n".join([
            "set -uo pipefail",
            'PORTAL_DIR="%s"' % self.portal,
            'TOOLS_RUNNER_UNIT_DIR="%s"' % self.unit_dir,
            'TOOLS_RUNNER_RUN_UNIT="%s"' % readonly_value("TOOLS_RUNNER_RUN_UNIT"),
            'YELLOW=""; BOLD=""; NC=""',
            'terminal_final_state() { printf "FINAL:%s|%s|%s\\n" "$1" "$2" "$3"; }',
            'fail() { echo "FAIL-CALLED"; exit 99; }',
            extract_functions(("tools_runner_installed", "refuse_maintain_tools_on_runner_host")),
            # The exact guard line main runs before any maintenance handler.
            "tools_runner_installed && refuse_maintain_tools_on_runner_host",
            'echo "MAINTENANCE-HANDLER-REACHED"',
        ])
        return subprocess.run(["/bin/bash", "-c", script], capture_output=True, text=True, timeout=60,
                              env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})

    def test_maintain_tools_is_refused_on_a_runner_host(self):
        self.run_installer()
        result = self.maintain_tools()
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("MAINTENANCE-HANDLER-REACHED", result.stdout)
        self.assertNotIn("FAIL-CALLED", result.stdout)
        self.assertIn("AI tools now update one at a time from the Portal's Maintenance page", result.stderr)
        self.assertIn("FINAL:Nothing changed|", result.stdout)
        self.assertEqual(self.systemctl_calls(), ["daemon-reload", "enable bridgesllm-tools-reconcile.service"])

    def test_maintain_tools_keeps_todays_behaviour_without_the_runner(self):
        result = self.maintain_tools()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("MAINTENANCE-HANDLER-REACHED", result.stdout)


class MaintainToolsGuardPlacement(unittest.TestCase):
    """main refuses before the exact-tuple handler starts; dry-run says the same."""

    def test_guard_precedes_the_handler(self):
        with open(INSTALL_SH, encoding="utf-8") as handle:
            text = handle.read()
        block = text[text.index("  if $MAINTAIN_TOOLS; then\n    tools_runner_installed && refuse_maintain_tools_on_runner_host\n"):]
        guard = block.index("refuse_maintain_tools_on_runner_host")
        self.assertLess(guard, block.index("terminal_operation_begin compatible-ai-tools"))
        self.assertLess(guard, block.index("terminal_run_captured_handler do_maintain_compatible_ai_tools"))
        body = extract_functions(("refuse_maintain_tools_on_runner_host",))
        self.assertNotIn("fail ", body)
        self.assertNotIn("dashboard_update_progress", body)
        dry = extract_functions(("print_dry_run_plan",))
        case = dry[dry.index("    maintain-tools)"):dry.index("    uninstall)")]
        self.assertIn("if tools_runner_installed; then", case)
        self.assertIn("A real run would change nothing", case)


class FreshInstallLeavesOpenClawUpdateSettings(unittest.TestCase):
    """h.7: only the legacy --maintain-tools path writes or gates update.checkOnStart / update.auto.enabled."""

    def test_pin_policy_is_legacy_maintenance_only(self):
        with open(INSTALL_SH, encoding="utf-8") as handle:
            text = handle.read()
        calls = [line.strip() for line in text.split("\n")
                 if re.search(r"\b(enforce|verify|apply)_openclaw_update_pin_policy\b", line)
                 and not re.match(r"^(enforce|verify|apply)_openclaw_update_pin_policy\(\) \{$", line)]
        self.assertEqual(calls, [
            'verify_openclaw_update_pin_policy "${config_path}"',
            'if ! apply_openclaw_update_pin_policy "${config_path}" >> "$LOG_FILE" 2>&1; then',
            "if $MAINTAIN_TOOLS && ! enforce_openclaw_update_pin_policy; then",
            "if $MAINTAIN_TOOLS && ! verify_openclaw_update_pin_policy; then",
        ])
        prepare = extract_functions(("prepare_openclaw_runtime_for_portal",))
        self.assertIn("if $MAINTAIN_TOOLS && ! enforce_openclaw_update_pin_policy; then", prepare)
        self.assertIn("if $MAINTAIN_TOOLS && ! verify_openclaw_update_pin_policy; then", prepare)


class RunnerPathsMatchThePortal(unittest.TestCase):
    """The layout the installer creates is the one readToolsRunnerState reads."""

    def test_paths_agree(self):
        with open(TOOLS_STATUS_TS, encoding="utf-8") as handle:
            source = handle.read()
        self.assertEqual(readonly_value("INSTALL_ROOT"), "/opt/bridgesllm")
        self.assertIn("env.PORTAL_ROOT || '/opt/bridgesllm/portal'", source)
        self.assertIn("path.join(portalRoot, 'installer', 'tools', 'bridgesllm-toolctl.py')", source)
        self.assertIn("'/etc/systemd/system'", source)
        self.assertIn("'bridgesllm-tools@.service'", source)
        self.assertEqual(readonly_value("TOOLS_RUNNER_UNIT_DIR"), "/etc/systemd/system")
        self.assertEqual(readonly_value("TOOLS_RUNNER_RUN_UNIT"), "bridgesllm-tools@.service")
        self.assertIn("|| '/var/lib/bridgesllm/tools'", source)
        self.assertEqual(readonly_value("TOOLS_RUNNER_STATE_ROOT"), "/var/lib/bridgesllm/tools")
        with open(INSTALL_SH, encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn('readonly PORTAL_DIR="${INSTALL_ROOT}/portal"', text)


if __name__ == "__main__":
    unittest.main()
