"""install.sh: uninstall removes the per-tool runner (updater v2 item K9).

The uninstall functions are extracted by name from installer/install.sh and run
in bash against a temporary unit directory with a fake systemctl. Nothing
touches the host's systemd or /var/lib.
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
INSTALL_SH = os.path.join(REPO, "installer", "install.sh")
FUNCTIONS = (
    "tools_runner_running_units",
    "refuse_uninstall_during_tools_run",
    "remove_portal_tools_runner",
)
RUN_ID = "0b6c3f2e-6f1d-4c39-9a57-2f1f4d0f8c11"


def read_install_sh():
    with open(INSTALL_SH, encoding="utf-8") as handle:
        return handle.read()


def function_body(source, name):
    lines = source.split("\n")
    starts = [i for i, line in enumerate(lines) if line == name + "() {"]
    if len(starts) != 1:
        raise AssertionError("%s defined %d times" % (name, len(starts)))
    end = next(i for i in range(starts[0], len(lines)) if lines[i] == "}")
    return "\n".join(lines[starts[0]:end + 1])


def readonly_value(source, name):
    match = re.search(r'^readonly %s="([^"]*)"$' % name, source, re.M)
    if not match:
        raise AssertionError("missing readonly %s" % name)
    return match.group(1)


FAKE_SYSTEMCTL = r'''#!/bin/bash
printf '%s\n' "$*" >> "${FAKE_CALLS}"
case "$1" in
  list-units)
    [[ "${FAKE_LIST_RC:-0}" == 0 ]] || exit "${FAKE_LIST_RC}"
    [[ -f "${FAKE_UNITS}" ]] && cat "${FAKE_UNITS}"
    exit 0 ;;
  disable) exit "${FAKE_DISABLE_RC:-0}" ;;
  daemon-reload) exit "${FAKE_RELOAD_RC:-0}" ;;
  *) exit 0 ;;
esac
'''


class RunnerUninstall(unittest.TestCase):
    def setUp(self):
        self.source = read_install_sh()
        self.root = tempfile.mkdtemp(prefix="runner-uninstall-")
        self.unit_dir = os.path.join(self.root, "etc", "systemd", "system")
        self.wants_dir = os.path.join(self.unit_dir, "multi-user.target.wants")
        self.state_root = os.path.join(self.root, "var", "lib", "bridgesllm", "tools")
        for directory in (self.wants_dir, os.path.join(self.state_root, "runs", RUN_ID),
                          os.path.join(self.root, "bin")):
            os.makedirs(directory)
        self.run_unit = readonly_value(self.source, "TOOLS_RUNNER_RUN_UNIT")
        self.reconcile_unit = readonly_value(self.source, "TOOLS_RUNNER_RECONCILE_UNIT")
        self.calls = os.path.join(self.root, "systemctl.calls")
        self.units = os.path.join(self.root, "units.txt")
        fake = os.path.join(self.root, "bin", "systemctl")
        with open(fake, "w") as handle:
            handle.write(FAKE_SYSTEMCTL)
        os.chmod(fake, 0o755)
        self.evidence = os.path.join(self.state_root, "runs", RUN_ID, "status.json")
        with open(self.evidence, "w") as handle:
            handle.write('{"state": "succeeded"}\n')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def install_units(self):
        for name in (self.run_unit, self.reconcile_unit):
            shutil.copyfile(os.path.join(REPO, "installer", "systemd", name), os.path.join(self.unit_dir, name))
        os.symlink(os.path.join(self.unit_dir, self.reconcile_unit), os.path.join(self.wants_dir, self.reconcile_unit))
        with open(os.path.join(self.unit_dir, ".bridgesllm-tools.Ab3dE9"), "w") as handle:
            handle.write("partial copy\n")

    def set_units(self, *lines):
        with open(self.units, "w") as handle:
            handle.write("".join(line + "\n" for line in lines))

    def run_bash(self, function, extra_env=None):
        script = "\n".join([
            "set -uo pipefail",
            'TOOLS_RUNNER_STATE_ROOT="%s"' % self.state_root,
            'TOOLS_RUNNER_UNIT_DIR="%s"' % self.unit_dir,
            'TOOLS_RUNNER_RUN_UNIT="%s"' % self.run_unit,
            'TOOLS_RUNNER_RECONCILE_UNIT="%s"' % self.reconcile_unit,
            'YELLOW=""; BOLD=""; NC=""',
            'fail() { printf "FAIL:%s\\n" "$*"; exit 1; }',
            'terminal_final_state() { printf "FINAL:%s|%s|%s\\n" "$1" "$2" "$3"; }',
            "\n".join(function_body(self.source, name) for name in FUNCTIONS),
            function,
            'printf "RETURNED:%s\\n" "$?"',
        ])
        env = {"PATH": os.path.join(self.root, "bin") + ":/usr/bin:/bin", "LC_ALL": "C",
               "FAKE_CALLS": self.calls, "FAKE_UNITS": self.units}
        env.update(extra_env or {})
        return subprocess.run(["/bin/bash", "-c", script], env=env, capture_output=True, text=True, timeout=60)

    def systemctl_calls(self):
        if not os.path.exists(self.calls):
            return []
        with open(self.calls) as handle:
            return handle.read().splitlines()

    def leftovers(self):
        found = []
        for current, _dirs, files in os.walk(self.unit_dir):
            found.extend(os.path.relpath(os.path.join(current, name), self.unit_dir) for name in files)
        found.extend(os.path.relpath(os.path.join(self.wants_dir, name), self.unit_dir)
                     for name in os.listdir(self.wants_dir) if os.path.islink(os.path.join(self.wants_dir, name)))
        return sorted(set(found))

    def assert_never_stopped(self):
        for call in self.systemctl_calls():
            self.assertNotRegex(call, r"^(stop|kill)\b|--now", call)

    def test_removes_both_units_wants_link_and_temp_and_keeps_state(self):
        self.install_units()
        self.set_units("bridgesllm-tools@%s.service loaded failed failed BridgesLLM AI tools maintenance run" % RUN_ID,
                       "bridgesllm-tools@1f.service loaded inactive dead BridgesLLM AI tools maintenance run")
        result = self.run_bash("remove_portal_tools_runner")
        self.assertIn("RETURNED:0", result.stdout, result.stdout + result.stderr)
        self.assertEqual(self.leftovers(), [])
        calls = self.systemctl_calls()
        self.assertIn("disable %s" % self.reconcile_unit, calls)
        self.assertIn("daemon-reload", calls)
        self.assertLess(calls.index("disable %s" % self.reconcile_unit), calls.index("daemon-reload"))
        self.assertIn("reset-failed %s bridgesllm-tools@*.service" % self.reconcile_unit, calls)
        self.assert_never_stopped()
        self.assertTrue(os.path.isfile(self.evidence), "run history must stay in both uninstall modes")

    def test_already_missing_files_are_tolerated(self):
        result = self.run_bash("remove_portal_tools_runner", {"FAKE_DISABLE_RC": "1"})
        self.assertIn("RETURNED:0", result.stdout, result.stdout + result.stderr)
        self.assertIn("daemon-reload", self.systemctl_calls())
        # A dangling enable link left after the unit file vanished is still removed.
        os.symlink(os.path.join(self.unit_dir, self.reconcile_unit), os.path.join(self.wants_dir, self.reconcile_unit))
        result = self.run_bash("remove_portal_tools_runner", {"FAKE_DISABLE_RC": "1"})
        self.assertIn("RETURNED:0", result.stdout, result.stdout + result.stderr)
        self.assertEqual(self.leftovers(), [])

    def test_running_instance_stops_the_uninstall_before_any_change(self):
        for state in ("active running", "activating start", "deactivating stop-sigterm", "reloading reload"):
            self.install_units()
            os.unlink(self.calls) if os.path.exists(self.calls) else None
            self.set_units("bridgesllm-tools@%s.service loaded %s BridgesLLM AI tools maintenance run" % (RUN_ID, state))
            result = self.run_bash("remove_portal_tools_runner")
            self.assertEqual(result.returncode, 1, state)
            self.assertIn("FAIL:An AI tools update is still running (bridgesllm-tools@%s.service)" % RUN_ID, result.stdout)
            self.assertIn("run the installer again to resume the uninstall", result.stdout)
            self.assertEqual(self.systemctl_calls()[0].split()[0], "list-units")
            self.assertEqual(len(self.systemctl_calls()), 1, "nothing may be disabled or reloaded: %s" % state)
            self.assertTrue(os.path.isfile(os.path.join(self.unit_dir, self.run_unit)))
            self.assertTrue(os.path.islink(os.path.join(self.wants_dir, self.reconcile_unit)))
            shutil.rmtree(self.unit_dir)
            os.makedirs(self.wants_dir)

    def test_unreadable_systemd_state_fails_closed(self):
        self.install_units()
        result = self.run_bash("remove_portal_tools_runner", {"FAKE_LIST_RC": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL:AI tools update state could not be verified", result.stdout)
        self.assertTrue(os.path.isfile(os.path.join(self.unit_dir, self.reconcile_unit)))

    def test_reload_failure_fails(self):
        self.install_units()
        result = self.run_bash("remove_portal_tools_runner", {"FAKE_RELOAD_RC": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAIL:Systemd could not forget the removed AI tools runner", result.stdout)

    def test_refusal_before_prompts(self):
        self.set_units()
        result = self.run_bash("refuse_uninstall_during_tools_run")
        self.assertIn("RETURNED:0", result.stdout)
        self.assertNotIn("FINAL:", result.stdout)
        self.set_units("bridgesllm-tools@%s.service loaded active running BridgesLLM AI tools maintenance run" % RUN_ID)
        result = self.run_bash("refuse_uninstall_during_tools_run")
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("RETURNED:", result.stdout)
        self.assertIn("FINAL:Nothing changed|An AI tools update is still running (bridgesllm-tools@%s.service)."
                      " Uninstall never stops it" % RUN_ID, result.stdout)
        self.assertIn("Maintenance page", result.stdout)
        self.assertIn("Uninstall not started:", result.stderr)
        result = self.run_bash("refuse_uninstall_during_tools_run", {"FAKE_LIST_RC": "1"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("FINAL:Nothing changed|The installer could not check whether an AI tools update is running",
                      result.stdout)
        self.assert_never_stopped()


class RunnerUninstallWiring(unittest.TestCase):
    def setUp(self):
        self.source = read_install_sh()

    def test_main_refuses_before_the_uninstall_handler(self):
        main = function_body(self.source, "main")
        block = main[main.index("  if $UNINSTALL_MODE; then\n"):]
        block = block[:block.index("\n  fi\n")]
        self.assertLess(block.index("refuse_uninstall_during_tools_run"), block.index("terminal_operation_begin uninstall"))
        self.assertLess(main.index("acquire_portal_operation_lock"), main.index("  if $UNINSTALL_MODE; then\n"))

    def test_phase_machine_removes_runner_with_backup_automation_in_both_modes(self):
        machine = function_body(self.source, "resume_active_uninstall_transaction")
        self.assertIn("        remove_portal_backup_automation\n        remove_portal_tools_runner\n"
                      "        advance_uninstall_transaction_phase remote_desktop_removed backup_automation_removed",
                      machine)
        self.assertEqual(machine.count("remove_portal_tools_runner"), 1)

    def test_removal_never_stops_runs_or_deletes_state(self):
        body = function_body(self.source, "remove_portal_tools_runner")
        for forbidden in ("systemctl stop", "--now", "kill", "rm -rf", "rm -r "):
            self.assertNotIn(forbidden, body)
        code = "\n".join(line for line in body.split("\n") if not line.lstrip().startswith("#"))
        self.assertNotIn("TOOLS_RUNNER_STATE_ROOT", code)


if __name__ == "__main__":
    unittest.main()
