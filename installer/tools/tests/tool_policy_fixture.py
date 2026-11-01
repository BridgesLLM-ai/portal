"""The shipped tool policy (installer/tools/tool-policy.v2.json) as the tests use it.

Most tests drive toolctl against fake hosts, fake registries and fake downloads, so
their bytes can never match a digest the Portal really qualified. Those tests start
from unqualified_policy(): the shipped file with every recommended (newestProven)
version reset to "proposed" (integrity and qualifiedAt null). Floors, sources,
versions and probes stay the shipped ones; a test that needs a qualified entry
records one itself on that copy. Tests whose subject is the shipped file itself
(its values, its forms, the release gate) read shipped_policy() and must pass
whichever of its entries are qualified.
"""

import copy
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SHIPPED_POLICY_PATH = os.path.join(os.path.dirname(HERE), "tool-policy.v2.json")
UNQUALIFIED = {"status": "proposed", "integrity": None, "qualifiedAt": None}
# The file's one newestProven line per tool (the line scripts/qualify-tool-policy.py edits).
ENTRY_LINE = re.compile(r'\A(?P<indent>[ ]*)"newestProven": (?P<value>\{.*\})(?P<comma>,?)\Z')


def shipped_policy_text():
    with open(SHIPPED_POLICY_PATH, encoding="utf-8") as handle:
        return handle.read()


def shipped_policy():
    return json.loads(shipped_policy_text())


def unqualified(policy):
    """A copy of policy with every recommended version back to proposed."""
    policy = copy.deepcopy(policy)
    for tool in policy["tools"]:
        tool["newestProven"].update(UNQUALIFIED)
    return policy


def unqualified_policy():
    return unqualified(shipped_policy())


def core_updates_on(policy):
    """A copy of policy with the OpenClaw core update on. The shipped 5.2.0 policy holds it for a later
    Portal release (openclaw.coreUpdates "later-release"); the K7 update flow stays in place behind that
    flag, so the tests that drive it start from this copy and the flag's own tests set it."""
    policy = copy.deepcopy(policy)
    policy["openclaw"].pop("coreUpdates", None)
    return policy


def unqualified_policy_text():
    """The shipped file's text with only its newestProven lines reset, in the file's one-line style."""
    text = shipped_policy_text()
    lines = text.split("\n")
    edited = 0
    for number, line in enumerate(lines):
        match = ENTRY_LINE.fullmatch(line)
        if match:
            entry = json.loads(match.group("value"))
            entry.update(UNQUALIFIED)
            rendered = ", ".join("%s: %s" % (json.dumps(key), json.dumps(value)) for key, value in entry.items())
            lines[number] = '%s"newestProven": { %s }%s' % (match.group("indent"), rendered, match.group("comma"))
            edited += 1
    result = "\n".join(lines)
    expected = unqualified(json.loads(text))
    if edited != len(expected["tools"]) or json.loads(result) != expected:
        raise AssertionError("%s no longer has one newestProven line per tool; update tool_policy_fixture.py"
                             % SHIPPED_POLICY_PATH)
    return result
