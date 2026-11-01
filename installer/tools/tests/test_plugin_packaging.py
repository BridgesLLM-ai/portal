"""Release packaging of the Portal-owned OpenClaw plugins (C9) and its PF-13 acceptance.

Run: python3 -I -m unittest discover -s installer/tools/tests -v
Packages the repository's own plugin sources into temp dirs; no release build runs.
"""

import gzip
import io
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import unittest

import test_toolctl
from test_toolctl import Host, toolctl, write

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
PACKAGER_PATH = os.path.join(REPO, "scripts", "build-portal-plugins.py")

_spec = test_toolctl.importlib.util.spec_from_file_location("build_portal_plugins", PACKAGER_PATH)
packager = test_toolctl.importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(packager)


def read(relative):
    with open(os.path.join(REPO, relative), encoding="utf-8") as handle:
        return handle.read()


class PackagingCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.mkdtemp(prefix="plugin-packaging-")
        self.addCleanup(shutil.rmtree, self.temp, True)

    def copy_source_root(self):
        """The parts of the Portal tree the packager reads, copied so they can be changed."""
        root = os.path.join(self.temp, "src")
        for relative in packager.PLUGIN_SOURCES + ("installer/tools",):
            shutil.copytree(os.path.join(REPO, relative), os.path.join(root, relative),
                            ignore=shutil.ignore_patterns("tests", "__pycache__"))
        return root

    def build(self, source_root=REPO, name="out", mtime=0):
        out = os.path.join(self.temp, name)
        self.assertEqual(packager.main(["--source-root", source_root, "--out", out, "--mtime", str(mtime)]), 0)
        return out

class PackagerTests(PackagingCase):
    def test_packages_every_portal_plugin_with_a_valid_manifest(self):
        out = self.build()
        manifest = toolctl.read_json_file(os.path.join(out, "manifest.json"))
        self.assertEqual(toolctl.validate_plugin_manifest(manifest), [])
        floor = toolctl.policy_tool(json.loads(read("installer/tools/tool-policy.v2.json")), "openclaw")["floor"]
        expected = []
        for relative in packager.PLUGIN_SOURCES:
            package = json.loads(read(relative + "/package.json"))
            expected.append((package["name"], package["version"], ">=" + floor))
        self.assertEqual([(p["id"], p["version"], p["openclaw"]) for p in manifest["plugins"]], sorted(expected))
        self.assertEqual(sorted(os.listdir(out)), sorted(["manifest.json"] + [p["archive"] for p in manifest["plugins"]]))
        for plugin in manifest["plugins"]:
            self.assertEqual(toolctl.sha256_file(os.path.join(out, plugin["archive"])), plugin["sha256"])
            self.assertEqual(os.stat(os.path.join(out, plugin["archive"])).st_mode & 0o777, 0o644)

    def test_archive_is_npm_pack_layout_with_only_the_runtime_files(self):
        out = self.build()
        with tarfile.open(os.path.join(out, "bridgesllm-ask-user-4.0.0.tgz")) as tar:
            members = tar.getmembers()
        self.assertEqual([m.name for m in members],
                         ["package/index.js", "package/openclaw.plugin.json", "package/package.json"])
        for member in members:
            self.assertEqual((member.uid, member.gid, member.uname, member.gname, member.mtime, member.mode),
                             (0, 0, "", "", 0, 0o644))
            self.assertTrue(member.isreg())
        # Portal-side helpers and tests stay out of the plugin package.
        with tarfile.open(os.path.join(out, "bridgesllm-shared-browser-1.0.0.tgz")) as tar:
            self.assertNotIn("package/index.test.cjs", tar.getnames())
        with tarfile.open(os.path.join(out, "bridgesllm-ask-user-4.0.0.tgz")) as tar:
            self.assertNotIn("package/register.py", tar.getnames())

    def test_output_is_deterministic_and_free_of_host_paths(self):
        first = self.build(name="a")
        source = self.copy_source_root()
        for current, _dirs, files in os.walk(source):
            for name in files:
                os.utime(os.path.join(current, name), (1234567890, 1234567890))
        second = self.build(source_root=source, name="b")
        for name in sorted(os.listdir(first)):
            with open(os.path.join(first, name), "rb") as a, open(os.path.join(second, name), "rb") as b:
                self.assertEqual(a.read(), b.read(), name)
        for name in os.listdir(first):
            if not name.endswith(".tgz"):
                continue
            with open(os.path.join(first, name), "rb") as handle:
                data = handle.read()
            # gzip header: no FNAME flag, MTIME 0.
            self.assertEqual(data[3] & 0x08, 0)
            self.assertEqual(data[4:8], b"\0\0\0\0")
            raw = gzip.decompress(data)
            for path in (REPO, source, self.temp):
                self.assertNotIn(path.encode(), raw)

    def test_packaging_adds_nothing_to_the_source_tree(self):
        # build-release.sh packages inside each release stage and then compares the two stages byte for byte; a
        # bytecode cache left there embeds the stage path (2026-10-31: "unsigned release stages differ").
        source = self.copy_source_root()
        before = sorted(os.path.relpath(os.path.join(current, name), source)
                        for current, dirs, files in os.walk(source) for name in dirs + files)
        previous = sys.dont_write_bytecode
        sys.dont_write_bytecode = False  # as under a plain `python3 -I`, whatever this test runner was started with
        try:
            self.build(source_root=source)
        finally:
            sys.dont_write_bytecode = previous
        after = sorted(os.path.relpath(os.path.join(current, name), source)
                       for current, dirs, files in os.walk(source) for name in dirs + files)
        self.assertEqual(after, before)

    def test_fixed_mtime_is_applied(self):
        out = self.build(mtime=1700000000)
        with tarfile.open(os.path.join(out, "bridgesllm-ask-user-4.0.0.tgz")) as tar:
            self.assertEqual({m.mtime for m in tar.getmembers()}, {1700000000})

    def test_declared_min_host_version_is_the_range(self):
        source = self.copy_source_root()
        path = os.path.join(source, "installer/openclaw-ask-user-plugin/package.json")
        package = json.loads(open(path).read())
        package["openclaw"]["install"] = {"minHostVersion": ">=2026.10.9"}
        write(path, json.dumps(package))
        manifest = toolctl.read_json_file(os.path.join(self.build(source_root=source), "manifest.json"))
        self.assertEqual({p["id"]: p["openclaw"] for p in manifest["plugins"]}["bridgesllm-ask-user"], ">=2026.10.9")

    def test_refuses_unsafe_or_inconsistent_sources(self):
        cases = {
            "id mismatch": lambda d: write(d + "/openclaw.plugin.json", json.dumps({"id": "other-plugin"})),
            "missing entry point": lambda d: os.unlink(d + "/index.js"),
            "symlinked entry point": lambda d: (os.unlink(d + "/index.js"), os.symlink("/etc/hostname", d + "/index.js")),
            "escaping entry point": lambda d: write(d + "/package.json", json.dumps(
                {"name": "bridgesllm-ask-user", "version": "4.0.0", "main": "../../tools/bridgesllm-toolctl.py"})),
            "inexact version": lambda d: write(d + "/package.json", json.dumps(
                {"name": "bridgesllm-ask-user", "version": "^4.0.0", "main": "index.js"})),
            "unreadable range": lambda d: write(d + "/package.json", json.dumps(
                {"name": "bridgesllm-ask-user", "version": "4.0.0", "main": "index.js",
                 "openclaw": {"install": {"minHostVersion": "whenever"}}})),
        }
        for label, damage in cases.items():
            with self.subTest(label):
                source = self.copy_source_root()
                damage(os.path.join(source, "installer/openclaw-ask-user-plugin"))
                with self.assertRaises(packager.PackagingError):
                    packager.render(source)
                shutil.rmtree(source)

    def test_out_dir_must_be_new_or_empty(self):
        out = os.path.join(self.temp, "busy")
        write(out + "/stale.tgz", "old")
        self.assertEqual(packager.main(["--source-root", REPO, "--out", out]), 1)
        self.assertEqual(os.listdir(out), ["stale.tgz"])


class PackagedPluginsPassPreflightTests(test_toolctl.HostTestCase):
    """PF-13 accepts exactly what the release packaging produces."""

    def test_pf13_accepts_the_packager_output(self):
        shutil.rmtree(self.host.paths["portal_plugins_dir"])
        self.assertEqual(packager.main(["--source-root", REPO, "--out", self.host.paths["portal_plugins_dir"]]), 0)
        report = self.host.preflight()
        self.assertTrue(report["ok"], report["refusals"])
        self.assertEqual([c["state"] for c in report["checks"] if c["id"] == "PF-13"], ["pass"])
        self.assertEqual(sorted(p["id"] for p in report["facts"]["portalPlugins"]),
                         ["bridgesllm-ask-user", "bridgesllm-shared-browser"])
        plugins, problem = toolctl.load_plugin_manifest(self.host.roots())
        self.assertIsNone(problem)
        self.assertEqual(len(plugins), 2)

    def test_pf13_refuses_a_tampered_packaged_archive(self):
        shutil.rmtree(self.host.paths["portal_plugins_dir"])
        out = self.host.paths["portal_plugins_dir"]
        self.assertEqual(packager.main(["--source-root", REPO, "--out", out]), 0)
        with open(os.path.join(out, "bridgesllm-ask-user-4.0.0.tgz"), "ab") as handle:
            handle.write(b"x")
        self.assertEqual(self.refusal_ids(self.host.preflight()), ["PF13_PLUGIN_ARCHIVE_INVALID"])


class ReleasePrivacyTests(PackagingCase):
    """The privacy gate admits only the packaged plugins and still scans inside them."""

    def privacy(self):
        path = os.path.join(REPO, "scripts", "validation", "release-artifact-privacy.py")
        spec = test_toolctl.importlib.util.spec_from_file_location("release_artifact_privacy", path)
        module = test_toolctl.importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def stage_with(self, source_root, name):
        stage = os.path.join(self.temp, name)
        _manifest, outputs = packager.render(source_root)
        os.makedirs(os.path.join(stage, "installer"))
        packager.write_outputs(os.path.join(stage, "installer", "plugins"), outputs)
        return stage

    def test_packaged_plugins_pass_and_a_secret_inside_one_fails(self):
        from pathlib import Path
        privacy = self.privacy()
        privacy.validate_stage(Path(self.stage_with(REPO, "clean")))
        source = self.copy_source_root()
        with open(os.path.join(source, "installer/openclaw-ask-user-plugin/index.js"), "a") as handle:
            handle.write("\nconst leaked = '%s';\n" % ("sk-" + "proj-" + "A" * 40))
        with self.assertRaises(SystemExit) as raised:
            privacy.validate_stage(Path(self.stage_with(source, "leaky")))
        self.assertIn("credential-shaped value leaked into installer/plugins/bridgesllm-ask-user-4.0.0.tgz",
                      str(raised.exception))
        other = os.path.join(self.temp, "other")
        write(other + "/installer/vendor-1.0.0.tgz", "x")
        with self.assertRaises(SystemExit) as raised:
            privacy.validate_stage(Path(other))
        self.assertIn("private/generated file type is forbidden", str(raised.exception))


class ReleaseWiringTests(unittest.TestCase):
    """The release ships toolctl, its unit, the policy and the packaged plugins."""

    SHIPPED = ("installer/systemd/bridgesllm-tools-reconcile.service", "installer/systemd/bridgesllm-tools@.service",
               "installer/tools/bridgesllm-toolctl.py",
               "installer/tools/tool-policy.v2.json")

    def test_required_members_list_the_runner_and_the_packaged_plugins(self):
        members = read("installer/release-required-members.txt").splitlines()
        manifest, outputs = packager.render(REPO)
        for relative in self.SHIPPED + tuple("installer/plugins/" + name for name in outputs):
            self.assertIn("portal/" + relative, members)

    def test_inventory_validator_repackages_staged_plugins_and_compares_bytes(self):
        from pathlib import Path
        path = os.path.join(REPO, "scripts", "validation", "release-inventory-static.py")
        spec = test_toolctl.importlib.util.spec_from_file_location("release_inventory_static", path)
        validator = test_toolctl.importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validator)
        temp = tempfile.mkdtemp(prefix="plugin-stage-")
        self.addCleanup(shutil.rmtree, temp, True)
        stage = Path(temp)
        for relative in packager.PLUGIN_SOURCES + ("installer/tools",):
            shutil.copytree(os.path.join(REPO, relative), str(stage / relative),
                            ignore=shutil.ignore_patterns("tests", "__pycache__"))
        expected = validator.portal_plugin_outputs(Path(REPO), stage)
        _manifest, outputs = packager.render(str(stage))
        packager.write_outputs(str(stage / "installer" / "plugins"), outputs)
        staged = {p.relative_to(stage).as_posix() for p in stage.rglob("*") if p.is_file()}
        validator.validate_portal_plugin_outputs(stage, staged, expected)
        self.assertTrue(validator.is_generated_stage_metadata("installer/plugins/manifest.json"))
        with open(str(stage / "installer/plugins/manifest.json"), "ab") as handle:
            handle.write(b" ")
        with self.assertRaises(SystemExit) as raised:
            validator.validate_portal_plugin_outputs(stage, staged, expected)
        self.assertIn("differs from its committed sources: installer/plugins/manifest.json", str(raised.exception))
        with self.assertRaises(SystemExit):
            validator.validate_portal_plugin_outputs(stage, staged | {"installer/plugins/extra.tgz"}, expected)

    def test_ask_user_probe_matches_the_plugin_source(self):
        # OC-PLUG-ASK calls this method without parameters and expects the plugin's own validation answer.
        source = read("installer/openclaw-ask-user-plugin/index.js")
        self.assertIn("steer: '%s'" % toolctl.ASK_USER_STEER_METHOD, source)
        self.assertIn(toolctl.ASK_USER_STEER_INVALID, source)
        self.assertEqual(json.loads(read("installer/openclaw-ask-user-plugin/openclaw.plugin.json"))["id"],
                         toolctl.ASK_USER_PLUGIN_ID)

    def test_boot_reconcile_unit_settles_runs_and_starts_nothing(self):
        unit = read("installer/systemd/bridgesllm-tools-reconcile.service")
        self.assertIn("Type=oneshot\n", unit)
        self.assertIn("ExecStart=/usr/bin/python3 -I /opt/bridgesllm/portal/installer/tools/bridgesllm-toolctl.py reconcile\n", unit)
        self.assertIn("WantedBy=multi-user.target\n", unit)

    def test_release_build_stages_the_runner_and_packages_the_plugins(self):
        builder = read("scripts/build-release.sh")
        release_paths = re.search(r"local release_paths=\(\n(.*?)\n  \)\n", builder, re.S).group(1).split()
        for relative in self.SHIPPED:
            self.assertIn(relative, release_paths)
        self.assertIn('scripts/build-portal-plugins.py" \\\n      --source-root "${candidate_stage}"', builder)
        self.assertIn('--out "${candidate_stage}/installer/plugins"', builder)
        dockerfile = read("backend/Dockerfile")
        for relative in self.SHIPPED:
            self.assertIn('COPY ["%s", "/runtime/%s"]' % (relative, relative), dockerfile)


if __name__ == "__main__":
    unittest.main()
