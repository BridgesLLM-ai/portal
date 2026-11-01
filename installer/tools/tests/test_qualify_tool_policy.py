"""Tests for scripts/qualify-tool-policy.py: it records one qualified version
in the policy file with toolctl's integrity table, changes only that entry's
line, writes atomically, and leaves a policy that toolctl and the release gate
accept."""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from tool_policy_fixture import core_updates_on, shipped_policy_text, unqualified_policy_text

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(TOOLS_DIR))
SCRIPT = os.path.join(REPO, "scripts", "qualify-tool-policy.py")
GATE = os.path.join(REPO, "scripts", "validation", "tool-policy-qualified-static.py")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


qualifier = load("qualify_tool_policy", SCRIPT)
gate = load("tool_policy_qualified_static_qualify", GATE)
toolctl = qualifier.load_toolctl()

SRI = "sha512-" + "D" * 86 + "=="
SHA_A = "sha256:" + "a" * 64
SHA_B = "sha256:" + "b" * 64
SHA512 = "sha512:" + "e" * 128
TREE = "sha256-tree:" + "f" * 64
WHEN = "2026-11-02T10:00:00Z"
LATER = "2026-11-03T09:30:00Z"
# One value of each tool's form (object kinds name their machine).
VALUES = {"openclaw": (SRI, None), "codex": (SRI, None), "claude-code": (SRI, None), "clawhub": (SRI, None),
          "opencode": (SHA_A, "x86_64"), "hermes": (TREE, None), "grok-build": (SHA_A, "x86_64"),
          "antigravity": (SHA512, "x86_64"), "ollama": (SHA_B, "aarch64"), "agent-zero": (SHA_A, "x86_64")}
ALL_TEN = "Tool policy release gate passed: all 10 tools recommend qualified versions."
# While the policy holds the OpenClaw core update for a later Portal release (the shipped 5.2.0 flag).
HELD = ("Tool policy release gate passed: all 9 tools Maintenance updates recommend qualified versions; OpenClaw needs "
        "none while its core update is held for a later Portal release (openclaw.coreUpdates).")


class QualifyToolPolicyTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="qualify-policy-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.path = Path(self.root) / "tool-policy.v2.json"
        # The shipped file with every recommended version proposed: each test qualifies from there.
        self.path.write_text(unqualified_policy_text(), encoding="utf-8")
        os.chmod(self.path, 0o644)
        self.original = self.path.read_text(encoding="utf-8")

    def proven(self, tool_id):
        return toolctl.policy_tool(json.loads(self.path.read_text(encoding="utf-8")), tool_id)["newestProven"]

    def version(self, tool_id):
        return toolctl.policy_tool(json.loads(self.original), tool_id)["newestProven"]["version"]

    def qualify(self, tool_id, integrity, machine=None, when=WHEN, version=None):
        return qualifier.qualify(self.path, tool_id, version or self.version(tool_id), integrity, machine, when,
                                 toolctl=toolctl)

    def assert_gate_passes(self):
        """The release gate passes the policy at self.path, with the held-OpenClaw message while it carries the
        shipped coreUpdates flag; a copy without the flag must pass with all 10 tools qualified."""
        policy = json.loads(self.path.read_text(encoding="utf-8"))
        held = (policy.get("openclaw") or {}).get("coreUpdates") == "later-release"
        flag_free = Path(self.root) / "core-updates-on.json"
        flag_free.write_text(json.dumps(core_updates_on(policy), indent=2) + "\n", encoding="utf-8")
        self.assertNotIn("coreUpdates", flag_free.read_text(encoding="utf-8"))
        for path, expected in ((self.path, HELD if held else ALL_TEN), (flag_free, ALL_TEN)):
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(gate.check(path), 0, out.getvalue())
            self.assertEqual(out.getvalue().strip(), expected, path.name)

    def assert_refused(self, fragment, *args, **kwargs):
        before = self.path.read_bytes()
        with self.assertRaises(qualifier.Refusal) as caught:
            self.qualify(*args, **kwargs)
        self.assertIn(fragment, str(caught.exception))
        self.assertEqual(self.path.read_bytes(), before, "a refusal writes nothing")
        self.assertEqual(os.listdir(self.root), [self.path.name], "no temporary file is left")

    def test_every_shipped_entry_line_is_reproduced_byte_for_byte(self):
        # The shipped file as it is, and the unqualified copy the other tests edit.
        for text in (shipped_policy_text(), self.original):
            policy = json.loads(text)
            lines = [line for line in text.split("\n") if '"newestProven":' in line]
            self.assertEqual(len(lines), len(policy["tools"]))
            for line, tool in zip(lines, policy["tools"]):
                self.assertEqual(line, '      "newestProven": %s,' % qualifier.render_entry(tool["newestProven"]))

    def test_only_the_edited_line_changes_and_the_rest_parses_equal(self):
        self.assertEqual(self.qualify("opencode", SHA_A, "x86_64"), "opencode 1.19.5 qualified on x86_64 at %s." % WHEN)
        old, new = self.original.split("\n"), self.path.read_text(encoding="utf-8").split("\n")
        self.assertEqual(len(old), len(new))
        changed = [n for n, (a, b) in enumerate(zip(old, new)) if a != b]
        self.assertEqual(len(changed), 1)
        self.assertEqual(new[changed[0]], '      "newestProven": { "version": "1.19.5", "status": "qualified", "integrity": '
                                          '{"x86_64": "%s"}, "qualifiedAt": "%s" },' % (SHA_A, WHEN))
        before, after = json.loads(self.original), json.loads("\n".join(new))
        toolctl.policy_tool(after, "opencode")["newestProven"] = toolctl.policy_tool(before, "opencode")["newestProven"]
        self.assertEqual(after, before)
        self.assertEqual(toolctl.validate_policy(json.loads("\n".join(new))), [])
        self.assertEqual(os.stat(self.path).st_mode & 0o7777, 0o644)
        self.assertEqual(os.listdir(self.root), [self.path.name])

    def test_a_repeated_qualification_is_a_no_op_round_trip(self):
        self.qualify("hermes", TREE)
        first = self.path.read_bytes()
        inode = os.stat(self.path).st_ino
        self.assertTrue(self.qualify("hermes", TREE).endswith("Already recorded; nothing changed."))
        self.assertEqual(self.path.read_bytes(), first)
        self.assertEqual(os.stat(self.path).st_ino, inode, "an unchanged policy is not rewritten")

    def test_object_kinds_merge_one_machine_at_a_time(self):
        self.qualify("ollama", SHA_A, "x86_64")
        self.qualify("ollama", SHA_B, "aarch64", when=LATER)
        self.assertEqual(self.proven("ollama"), {"version": "0.40.13", "status": "qualified",
                                                 "integrity": {"x86_64": SHA_A, "aarch64": SHA_B}, "qualifiedAt": LATER})

    def test_string_kinds_record_one_digest_and_refuse_a_machine(self):
        self.qualify("hermes", TREE)
        self.assertEqual(self.proven("hermes")["integrity"], TREE)
        self.assert_refused("records one digest for every machine; drop --machine", "codex", SRI, "x86_64")

    def test_agent_zero_records_the_image_of_each_machine(self):
        # The per-architecture image digest the helper pins, one machine at a time; never one string.
        self.assert_refused("pass --machine x86_64 or --machine aarch64", "agent-zero", SHA_A)
        self.assert_refused("--integrity must be a sha256:<64 hex> digest of that machine's image", "agent-zero", SRI,
                            "x86_64")
        self.qualify("agent-zero", SHA_A, "x86_64")
        self.qualify("agent-zero", SHA_B, "aarch64", when=LATER)
        self.assertEqual(self.proven("agent-zero")["integrity"], {"x86_64": SHA_A, "aarch64": SHA_B})

    def test_refusals_change_nothing(self):
        self.assert_refused("recommends 1.19.5, not 1.19.4", "opencode", SHA_A, "x86_64", version="1.19.4")
        self.assert_refused("--integrity must be a sha256:<64 hex> digest of that machine's file", "opencode", SRI, "x86_64")
        self.assert_refused("--integrity must be a sha256-tree:<64 hex> source-tree digest", "hermes", SHA_A)
        self.assert_refused("--integrity must be an npm sha512 SRI string", "openclaw", SHA_A)
        self.assert_refused("pass --machine x86_64 or --machine aarch64", "grok-build", SHA_A, "arm64")
        self.assert_refused("pass --machine x86_64 or --machine aarch64", "grok-build", SHA_A)
        self.assert_refused("must be an ISO-8601 timestamp", "grok-build", SHA_A, "x86_64", when="2026-11-02")
        self.assert_refused("lists no tool 'nope'", "nope", SHA_A, version="1.0.0")
        self.qualify("opencode", SHA_A, "x86_64")
        self.assert_refused("already records a different qualified digest for x86_64", "opencode", SHA_B, "x86_64")

    def test_a_fully_qualified_policy_passes_toolctl_and_the_release_gate(self):
        for tool_id, (integrity, machine) in VALUES.items():
            self.qualify(tool_id, integrity, machine)
        self.assertEqual(toolctl.validate_policy(json.loads(self.path.read_text(encoding="utf-8"))), [])
        self.assert_gate_passes()

    def test_the_shipped_policy_completes_to_a_passing_release_gate(self):
        # The shipped file as it is: its qualified entries stay as they are; each one still proposed takes a
        # value of its form.
        shipped = json.loads(shipped_policy_text())
        self.path.write_text(shipped_policy_text(), encoding="utf-8")
        for tool in shipped["tools"]:
            if tool["newestProven"]["status"] != "qualified":
                self.qualify(tool["id"], *VALUES[tool["id"]])
        for tool in shipped["tools"]:
            if tool["newestProven"]["status"] == "qualified":
                self.assertEqual(self.proven(tool["id"]), tool["newestProven"], tool["id"])
        self.assertEqual(toolctl.validate_policy(json.loads(self.path.read_text(encoding="utf-8"))), [])
        self.assert_gate_passes()

    def test_command_line(self):
        def run(*args):
            result = subprocess.run(["/usr/bin/python3", "-I", SCRIPT, "--policy", str(self.path)] + list(args),
                                    capture_output=True, text=True, timeout=60)
            return result.returncode, result.stdout + result.stderr
        code, out = run("--tool", "grok-build", "--version", "1.0.62", "--integrity", SHA_A, "--machine", "x86_64",
                        "--qualified-at", WHEN)
        self.assertEqual((code, out.strip()), (0, "grok-build 1.0.62 qualified on x86_64 at %s." % WHEN))
        code, out = run("--tool", "grok-build", "--version", "1.0.63", "--integrity", SHA_A, "--machine", "x86_64",
                        "--qualified-at", WHEN)
        self.assertEqual(code, 1)
        self.assertIn("Tool policy not changed: grok-build recommends 1.0.62, not 1.0.63", out)
        self.assertEqual(run("--tool", "grok-build")[0], 2)


if __name__ == "__main__":
    unittest.main()
