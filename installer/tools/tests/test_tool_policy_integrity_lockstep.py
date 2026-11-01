"""Lockstep: toolctl's policy validation and the release gate
(scripts/validation/tool-policy-qualified-static.py) accept and refuse exactly
the same newestProven.integrity values per source kind (COMMON-W7 integrity
contract). Both are loaded from their file paths; neither runs anything at
import beyond its definitions."""

import copy
import importlib.util
import os
import unittest

from tool_policy_fixture import shipped_policy, unqualified

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(TOOLS_DIR))
TOOLCTL_PATH = os.path.join(TOOLS_DIR, "bridgesllm-toolctl.py")
GATE_PATH = os.path.join(REPO, "scripts", "validation", "tool-policy-qualified-static.py")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


toolctl = load("bridgesllm_toolctl_lockstep", TOOLCTL_PATH)
gate = load("tool_policy_qualified_static_lockstep", GATE_PATH)

SRI = "sha512-" + "C" * 86 + "=="
SHA256 = "sha256:" + "d" * 64
SHA512 = "sha512:" + "e" * 128
TREE = "sha256-tree:" + "f" * 64
STRINGS = {
    "sri": SRI, "sha256": SHA256, "sha512": SHA512, "tree": TREE,
    "sha256-upper": "sha256:" + "D" * 64, "sha256-short": "sha256:" + "d" * 63, "sha256-newline": SHA256 + "\n",
    "sha512-short": "sha512:" + "e" * 127, "tree-upper": "sha256-tree:" + "F" * 64, "sri-unpadded": "sha512-" + "C" * 88,
    "bare-hex": "d" * 64, "empty": "",
}
# One shared fixture list: every string form, each form under each machine key,
# and the object shapes the contract refuses.
VALUES = dict(STRINGS)
for _name, _value in STRINGS.items():
    VALUES["x86_64:" + _name] = {"x86_64": _value}
    VALUES["aarch64:" + _name] = {"aarch64": _value}
VALUES.update({
    "both:sha256": {"x86_64": SHA256, "aarch64": SHA256},
    "both:sha512+sha256": {"x86_64": SHA512, "aarch64": SHA256},
    "both:sha256+sri": {"x86_64": SHA256, "aarch64": SRI},
    "empty-object": {}, "unknown-machine": {"arm64": SHA256}, "extra-machine": {"x86_64": SHA256, "amd64": SHA256},
    "machine-case": {"X86_64": SHA256}, "null-machine": {"x86_64": None}, "nested": {"x86_64": {"sha256": SHA256}},
    "list": [SHA256], "number": 1, "zero": 0, "true": True, "false": False,
})
ACCEPTED = {
    "npm": {"sri"},
    "github-tarball": {"tree"},
    # Agent Zero: the per-architecture image digest the helper pins for that machine.
    "container-image": {"x86_64:sha256", "aarch64:sha256", "both:sha256"},
    "github-release": {"x86_64:sha256", "aarch64:sha256", "both:sha256"},
    "vendor": {"x86_64:sha256", "aarch64:sha256", "x86_64:sha512", "aarch64:sha512", "both:sha256",
               "both:sha512+sha256"},
}
# A shipped tool of each kind carries the fixture value.
TOOL_OF_KIND = {"npm": "openclaw", "github-tarball": "hermes", "container-image": "agent-zero",
                "github-release": "opencode", "vendor": "grok-build"}


class IntegrityLockstepTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy = shipped_policy()  # as shipped, whichever entries are qualified

    def toolctl_accepts(self, kind, value):
        policy = copy.deepcopy(self.policy)
        tool = toolctl.policy_tool(policy, TOOL_OF_KIND[kind])
        self.assertEqual(tool["source"]["kind"], kind)
        tool["newestProven"].update(status="qualified", integrity=value, qualifiedAt="2026-11-02T10:00:00Z")
        errors = toolctl.validate_policy(policy)
        self.assertTrue(all(".newestProven.integrity" in e for e in errors), errors)  # nothing else is wrong
        return not errors

    def gate_accepts(self, kind, value):
        entry = {"id": "fixture", "label": "Fixture", "source": {"kind": kind},
                 "newestProven": {"version": "1.2.3", "status": "qualified", "integrity": value,
                                  "qualifiedAt": "2026-11-02T10:00:00Z"}}
        _name, problems = gate.tool_problems(entry)
        self.assertTrue(all("integrity" in p for p in problems), problems)
        return not problems

    def test_both_accept_and_refuse_the_same_values_per_kind(self):
        self.assertEqual(set(TOOL_OF_KIND), set(toolctl.SOURCE_KINDS))
        for kind in toolctl.SOURCE_KINDS:
            for name, value in VALUES.items():
                with self.subTest(kind=kind, value=name):
                    expected = name in ACCEPTED[kind]
                    self.assertEqual((self.toolctl_accepts(kind, value), self.gate_accepts(kind, value)),
                                     (expected, expected))

    def test_both_tables_name_the_same_kinds_shapes_and_machines(self):
        self.assertEqual(set(toolctl.INTEGRITY_FORMS), set(gate.INTEGRITY_FORMS))
        self.assertEqual(set(toolctl.INTEGRITY_FORMS), set(toolctl.SOURCE_KINDS))
        self.assertEqual(tuple(toolctl.INTEGRITY_MACHINES), tuple(gate.MACHINES))
        for kind in toolctl.INTEGRITY_FORMS:
            self.assertEqual(toolctl.INTEGRITY_FORMS[kind][0], gate.INTEGRITY_FORMS[kind][0], kind)

    def test_null_integrity_is_valid_while_proposed_and_refused_by_the_gate(self):
        policy = unqualified(self.policy)
        self.assertEqual(toolctl.validate_policy(policy), [])
        for tool in policy["tools"]:
            _name, problems = gate.tool_problems(tool)
            self.assertTrue(any("not qualified yet" in p for p in problems), problems)

    def test_the_shipped_policy_is_valid_and_the_gate_refuses_only_its_proposed_entries(self):
        self.assertEqual(toolctl.validate_policy(self.policy), [])
        for tool in self.policy["tools"]:
            with self.subTest(tool=tool["id"]):
                _name, problems = gate.tool_problems(tool)
                if tool["newestProven"]["status"] == "qualified":
                    self.assertEqual(problems, [])
                else:
                    self.assertEqual(tool["newestProven"]["integrity"], None)
                    self.assertTrue(any("not qualified yet" in p for p in problems), problems)


if __name__ == "__main__":
    unittest.main()
