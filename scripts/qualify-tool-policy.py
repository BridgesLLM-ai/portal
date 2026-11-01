#!/usr/bin/env python3
"""Record one qualified tool version in the updater policy (updater v2 d.2).

The qualification suite runs this after it proved a tool's recommended
(newestProven) version: the entry becomes status "qualified" with the digest
it measured and when. The digest's form is the one toolctl reads for the
tool's source kind (toolctl's own table is used). Tools whose bytes differ
per architecture (github-release, vendor, container-image: Agent Zero's
per-architecture image digest, never the multi-arch index) record one entry
per machine: --machine names it, and entries already recorded for other
machines are kept. Only that one line of the file changes; the file is replaced
atomically and only after toolctl accepts the whole new policy.

Usage: qualify-tool-policy.py --tool ID --version V --integrity VALUE [--machine M] --qualified-at ISO [--policy PATH]
"""
from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
import re
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_POLICY = REPO / "installer" / "tools" / "tool-policy.v2.json"
TOOLCTL_PATH = REPO / "installer" / "tools" / "bridgesllm-toolctl.py"
ENTRY_LINE = re.compile(r'\A(?P<indent>[ ]*)"newestProven": (?P<value>\{.*\})(?P<comma>,?)\Z')


class Refusal(Exception):
    """A plain-words reason nothing was written."""


def load_toolctl(path: Path = TOOLCTL_PATH):
    spec = importlib.util.spec_from_file_location("bridgesllm_toolctl_qualify", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def render_entry(entry: dict) -> str:
    """The policy file's one-line style: { "key": value, ... }."""
    return "{ %s }" % ", ".join("%s: %s" % (json.dumps(key), json.dumps(value, separators=(", ", ": ")))
                                for key, value in entry.items())


def qualified_entry(toolctl, tool: dict, version: str, integrity: str, machine: str | None, qualified_at: str) -> dict:
    tool_id = tool.get("id")
    proven = tool.get("newestProven")
    if not isinstance(proven, dict):
        raise Refusal("%s has no newestProven entry to qualify." % tool_id)
    if proven.get("version") != version:
        raise Refusal("%s recommends %s, not %s; qualify the recommended version, or change the recommendation first."
                      % (tool_id, proven.get("version"), version))
    kind = (tool.get("source") or {}).get("kind")
    if kind not in toolctl.INTEGRITY_FORMS:
        raise Refusal("%s has the unknown source kind %r." % (tool_id, kind))
    by_machine, _patterns, words = toolctl.INTEGRITY_FORMS[kind]
    if not toolctl.ISO_TS_RE.fullmatch(qualified_at):
        raise Refusal("--qualified-at must be an ISO-8601 timestamp such as 2026-11-02T10:00:00Z.")
    current = proven.get("integrity") if proven.get("status") == "qualified" else None
    if by_machine:
        if machine not in toolctl.INTEGRITY_MACHINES:
            raise Refusal("%s (%s) records one digest per machine: pass --machine %s."
                          % (tool_id, kind, " or --machine ".join(toolctl.INTEGRITY_MACHINES)))
        recorded = dict(current) if isinstance(current, dict) else {}
        previous = recorded.get(machine)
        recorded[machine] = integrity
        value = recorded
    else:
        if machine is not None:
            raise Refusal("%s (%s) records one digest for every machine; drop --machine." % (tool_id, kind))
        previous, value = current, integrity
    if previous is not None and previous != integrity:
        raise Refusal("%s %s already records a different qualified digest%s (%s). A version's bytes must not change; "
                      "nothing was written." % (tool_id, version, " for " + machine if by_machine else "", previous))
    problems = toolctl.integrity_problems(kind, value)
    if problems:
        raise Refusal("--integrity must be %s (%s)." % (words, "; ".join(problem for _suffix, problem in problems)))
    entry = copy.deepcopy(proven)
    entry.update(status="qualified", integrity=value, qualifiedAt=qualified_at)
    return entry


def qualify(policy_path: Path, tool_id: str, version: str, integrity: str, machine: str | None, qualified_at: str,
            toolctl=None) -> str:
    """Write the qualification; returns a one-line summary. Raises Refusal."""
    toolctl = toolctl or load_toolctl()
    try:
        text = policy_path.read_text(encoding="utf-8")
        policy = json.loads(text)
    except (OSError, UnicodeError, ValueError) as error:
        raise Refusal("%s could not be read as JSON (%s)." % (policy_path, error))
    errors = toolctl.validate_policy(policy)
    if errors:
        raise Refusal("%s is not a valid policy before the change: %s" % (policy_path, "; ".join(errors[:5])))
    index = [i for i, tool in enumerate(policy["tools"]) if tool.get("id") == tool_id]
    if not index:
        raise Refusal("%s lists no tool %r." % (policy_path, tool_id))
    index = index[0]
    entry = qualified_entry(toolctl, policy["tools"][index], version, integrity, machine, qualified_at)
    lines = text.split("\n")
    entry_lines = [n for n, line in enumerate(lines) if ENTRY_LINE.fullmatch(line)]
    if len(entry_lines) != len(policy["tools"]):
        raise Refusal("%s is not laid out with one newestProven line per tool, so it is not edited automatically."
                      % policy_path)
    line_no = entry_lines[index]
    match = ENTRY_LINE.fullmatch(lines[line_no])
    if json.loads(match.group("value")) != policy["tools"][index]["newestProven"]:
        raise Refusal("%s: the newestProven line of %s does not hold its entry; nothing was written." % (policy_path, tool_id))
    lines[line_no] = '%s"newestProven": %s%s' % (match.group("indent"), render_entry(entry), match.group("comma"))
    new_text = "\n".join(lines)
    expected = copy.deepcopy(policy)
    expected["tools"][index]["newestProven"] = entry
    if json.loads(new_text) != expected:
        raise Refusal("the edited policy does not parse back to the intended change; nothing was written.")
    errors = toolctl.validate_policy(expected)
    if errors:
        raise Refusal("toolctl would refuse the result: %s" % "; ".join(errors[:5]))
    summary = "%s %s qualified%s at %s." % (tool_id, version, " on " + machine if machine else "", qualified_at)
    if new_text == text:
        return summary + " Already recorded; nothing changed."
    write_atomically(policy_path, new_text)
    return summary


def write_atomically(path: Path, text: str) -> None:
    mode = os.stat(path).st_mode & 0o7777
    handle, temporary = tempfile.mkstemp(prefix=".%s." % path.name, dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    parser.add_argument("--tool", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--integrity", required=True)
    parser.add_argument("--machine")
    parser.add_argument("--qualified-at", required=True)
    args = parser.parse_args(argv)
    try:
        print(qualify(args.policy, args.tool, args.version, args.integrity, args.machine, args.qualified_at))
    except Refusal as refusal:
        print("Tool policy not changed: %s" % refusal)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
