"""toolctl legacy section: reconcile entry point and h.4 gateway drop-in retirement.

Temp roots and a fake systemctl runner only: no host unit directory, no gateway.
"""
import errno
import fcntl
import importlib.util
import io
import json
import os
import re
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.dirname(HERE)
INSTALL_SH = os.path.join(os.path.dirname(TOOLS_DIR), "install.sh")
_spec = importlib.util.spec_from_file_location("bridgesllm_toolctl_legacy", os.path.join(TOOLS_DIR, "bridgesllm-toolctl.py"))
toolctl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(toolctl)


def installer_dropin_texts():
    """The exact drop-in bytes install.sh writes (install_openclaw_gateway_authorization_fence_dropin)."""
    with open(INSTALL_SH, encoding="utf-8") as handle:
        text = handle.read()
    system = re.search(r"\n  local expected_system='([^']*)'\n", text).group(1)
    root_user = re.search(r"\n  local expected_root_user='([^']*)'\n", text).group(1)
    permit = re.search(r"\nopenclaw_gateway_migration_permit_dropin_text\(\) \{\n  cat <<'EOF'\n(.*?)\nEOF\n\}", text, re.S).group(1)
    return system, permit + "\n", root_user


class FakeRunner(object):
    def __init__(self, active="active", reload_code=0):
        self.calls = []
        self.active = active
        self.reload_code = reload_code

    def __call__(self, argv, timeout=15, env=None):
        self.calls.append(list(argv[1:]))
        if argv[1:] == ["is-active", "openclaw-gateway.service"]:
            return (0 if self.active == "active" else 3), self.active + "\n", ""
        if argv[1:] == ["daemon-reload"]:
            return self.reload_code, "", "" if self.reload_code == 0 else "Access denied"
        raise AssertionError("unexpected systemctl call %r" % (argv,))


class LegacyEnv(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="toolctl-legacy-")
        b = self.base
        paths = {}
        for name, (_env, default) in toolctl.DEFAULTS.items():
            if name == "systemd_unit_dirs":
                paths[name] = [b + "/etc/systemd/system", b + "/root/.config/systemd/user"]
            else:
                paths[name] = b + default
        self.paths = paths
        for directory in (b + "/var/lib/bridgesllm", paths["installer_state_root"], b + "/run/lock",
                          b + "/run/bridgesllm", paths["openclaw_state_dir"]):
            os.makedirs(directory, exist_ok=True)
        os.chmod(b + "/run/lock", 0o755)
        self.roots = toolctl.Roots(**paths)
        self.system_dir = b + "/etc/systemd/system/openclaw-gateway.service.d"
        self.user_dir = b + "/root/.config/systemd/user/openclaw-gateway.service.d"
        system, permit, root_user = installer_dropin_texts()
        self.texts = {"20-bridgesllm-authorization-fence.conf": system, "30-bridgesllm-migration-permit.conf": permit}
        os.makedirs(self.system_dir)
        os.makedirs(self.user_dir)
        for name, text in self.texts.items():
            self.write(os.path.join(self.system_dir, name), text)
        self.inhibitor = os.path.join(self.user_dir, "20-bridgesllm-authorization-fence.conf")
        self.write(self.inhibitor, root_user)
        self.clock = iter("2026-10-31T06:0%d:00.000Z" % i for i in range(10))

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def write(self, path, text):
        with open(path, "w") as handle:
            handle.write(text)
        os.chmod(path, 0o644)

    def now(self):
        return next(self.clock)

    def retire(self, runner):
        return toolctl.retire_legacy_gateway_dropins(self.roots, runner=runner, now=self.now)

    def system_dropins(self):
        return sorted(os.listdir(self.system_dir))


class Retirement(LegacyEnv):
    def test_installer_texts_are_accepted_as_inert(self):
        for name, text in self.texts.items():
            self.assertIsNone(toolctl.legacy_dropin_problem(name, text), name)

    def test_moves_both_writes_receipt_reloads_and_never_restarts(self):
        runner = FakeRunner()
        result = self.retire(runner)
        self.assertEqual(result["state"], "retired", result)
        self.assertEqual(self.system_dropins(), [])
        self.assertEqual(runner.calls, [["is-active", "openclaw-gateway.service"], ["daemon-reload"]])
        with open(result["receipt"]) as handle:
            receipt = json.load(handle)
        self.assertEqual(receipt["schema"], "bridgesllm.tools.dropin-retirement.v1")
        self.assertFalse(receipt["gatewayRestarted"])
        self.assertEqual(receipt["daemonReload"], "ok")
        target = os.path.dirname(result["receipt"])
        self.assertEqual(os.path.dirname(target), self.paths["state_root"] + "/retired-dropins")
        for entry in receipt["files"]:
            with open(entry["to"]) as handle:
                self.assertEqual(handle.read(), self.texts[entry["name"]])
        self.assertEqual(oct(os.lstat(target).st_mode & 0o777), "0o700")
        # The root user-unit inhibitor is marker-independent and stays.
        self.assertTrue(os.path.isfile(self.inhibitor))

    def test_second_run_is_idempotent(self):
        self.retire(FakeRunner())
        runner = FakeRunner()
        self.assertEqual(self.retire(runner), {"state": "nothing-to-retire"})
        self.assertEqual(runner.calls, [])

    def assert_refused(self, result, fragment, runner):
        self.assertEqual(result["state"], "refused", result)
        self.assertIn(fragment, result["reason"])
        self.assertEqual(self.system_dropins(), sorted(self.texts))
        self.assertNotIn(["daemon-reload"], runner.calls)
        self.assertFalse(os.path.exists(self.paths["state_root"] + "/retired-dropins"))

    def test_fence_marker_present(self):
        self.write(self.paths["gateway_fence_marker"], "")
        runner = FakeRunner()
        self.assert_refused(self.retire(runner), "fence marker is present", runner)
        self.assertEqual(runner.calls, [])

    def test_permit_present(self):
        self.write(self.paths["gateway_fence_permit"], "1 2 boot")
        runner = FakeRunner()
        self.assert_refused(self.retire(runner), "start permit is present", runner)

    def test_open_legacy_root(self):
        os.makedirs(self.paths["installer_state_root"] + "/native-cli-bundle-v1")
        runner = FakeRunner()
        self.assert_refused(self.retire(runner), "native-cli-bundle-v1", runner)

    def test_unfinished_portal_update_journal(self):
        self.write(self.paths["installer_state_root"] + "/active-update.json", "{}")
        runner = FakeRunner()
        self.assert_refused(self.retire(runner), "did not finish (portal-update)", runner)

    def test_gateway_not_active(self):
        runner = FakeRunner(active="inactive")
        self.assert_refused(self.retire(runner), "gateway is not running (inactive)", runner)

    def test_changed_dropin_is_left_in_place(self):
        name = "20-bridgesllm-authorization-fence.conf"
        self.write(os.path.join(self.system_dir, name), self.texts[name] + "Environment=FOO=1\n")
        runner = FakeRunner()
        self.assert_refused(self.retire(runner), "setting the Portal never wrote (Environment=FOO=1)", runner)

    def test_ungated_start_condition_is_left_in_place(self):
        name = "30-bridgesllm-migration-permit.conf"
        self.write(os.path.join(self.system_dir, name), "[Service]\nExecCondition=/usr/bin/false\n")
        runner = FakeRunner()
        self.assert_refused(self.retire(runner), "never wrote", runner)

    def test_link_is_left_in_place(self):
        name = "20-bridgesllm-authorization-fence.conf"
        os.unlink(os.path.join(self.system_dir, name))
        os.symlink(self.inhibitor, os.path.join(self.system_dir, name))
        runner = FakeRunner()
        result = self.retire(runner)
        self.assertEqual(result["state"], "refused")
        self.assertIn("not a root-owned regular file", result["reason"])
        self.assertTrue(os.path.islink(os.path.join(self.system_dir, name)))

    def test_cross_filesystem_move_copies_then_unlinks(self):
        real_rename = os.rename

        def rename(source, destination):
            if source.startswith(self.system_dir):
                raise OSError(errno.EXDEV, "Invalid cross-device link")
            return real_rename(source, destination)

        with mock.patch.object(toolctl.os, "rename", side_effect=rename):
            result = self.retire(FakeRunner())
        self.assertEqual(result["state"], "retired", result)
        self.assertEqual(self.system_dropins(), [])
        target = os.path.dirname(result["receipt"])
        self.assertEqual(sorted(n for n in os.listdir(target) if n.endswith(".conf")), sorted(self.texts))
        self.assertFalse([n for n in os.listdir(target) if n.endswith(".partial")])

    def test_failed_cross_filesystem_copy_leaves_source_and_no_partial(self):
        real_rename = os.rename

        def rename(source, destination):
            if source.startswith(self.system_dir):
                raise OSError(errno.EXDEV, "Invalid cross-device link")
            return real_rename(source, destination)

        with mock.patch.object(toolctl.os, "rename", side_effect=rename), \
                mock.patch.object(toolctl.shutil, "copyfile", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            result = self.retire(FakeRunner())
        self.assertEqual(result["state"], "failed", result)
        self.assertIn("No space left on device", result["reason"])
        self.assertEqual(self.system_dropins(), sorted(self.texts))
        retired = self.paths["state_root"] + "/retired-dropins"
        leftovers = [name for _root, _dirs, files in os.walk(retired) for name in files]
        self.assertEqual(leftovers, [])

    def test_reload_failure_is_reported_plainly(self):
        result = self.retire(FakeRunner(reload_code=1))
        self.assertEqual(result["state"], "retired")
        self.assertIn("systemd could not reload", result["reason"])
        with open(result["receipt"]) as handle:
            self.assertEqual(json.load(handle)["daemonReload"], "failed")


class ReconcileEntry(LegacyEnv):
    def hold_operation_lock(self):
        fd = os.open(self.paths["portal_operation_lock"], os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)

    def test_operation_lock_held_defers_quietly_and_changes_nothing(self):
        self.hold_operation_lock()
        runner = FakeRunner()
        result = toolctl.cmd_reconcile_host(self.roots, runner=runner)
        self.assertEqual(result["settled"], [])
        self.assertIn("holds the operation lock", result["deferred"])
        self.assertEqual(runner.calls, [])
        self.assertFalse(os.path.exists(self.paths["state_root"]))
        self.assertEqual(self.system_dropins(), sorted(self.texts))

    def test_main_reconcile_exits_zero_while_an_update_holds_the_lock(self):
        self.hold_operation_lock()
        self.addCleanup(os.umask, os.umask(0o022))  # main() sets 077
        argv = ["--%s=%s" % (name.replace("_", "-"), ":".join(value) if isinstance(value, list) else value)
                for name, value in self.paths.items()] + ["reconcile"]
        out = io.StringIO()
        with redirect_stdout(out):
            code = toolctl.main(argv)
        self.assertEqual(code, toolctl.EXIT_OK)
        self.assertIn("deferred", json.loads(out.getvalue()))

    def test_free_lock_settles_and_retires_then_releases(self):
        runner = FakeRunner()
        result = toolctl.cmd_reconcile_host(self.roots, runner=runner)
        self.assertEqual(result["settled"], [])
        self.assertEqual(result["dropinRetirement"]["state"], "retired")
        fd = os.open(self.paths["portal_operation_lock"], os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)


if __name__ == "__main__":
    unittest.main()
