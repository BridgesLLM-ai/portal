"""Unit tests for the npm CLI section of installer/tools/bridgesllm-toolctl.py
(Codex, Claude Code, ClawHub: admission records, requalify).

Run: python3 -I -m unittest discover -s installer/tools/tests -v
Temp dirs and fake npm/node/CLI binaries only: no root, no network, no real npm.
"""

import base64
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import tempfile
import unittest
from unittest import mock

from tool_policy_fixture import unqualified_policy, unqualified_policy_text

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(TOOLS_DIR))
TOOLCTL_PATH = os.path.join(TOOLS_DIR, "bridgesllm-toolctl.py")
CATALOG_PATH = os.path.join(REPO, "backend", "src", "config", "nativeHostCliAdmissionCatalog.v1.json")
RECORD_TS_PATH = os.path.join(REPO, "backend", "src", "services", "nativeHostCliAdmissionRecord.ts")
FIXTURES = os.path.join(HERE, "fixtures", "npm-admission")
TREE_SPEC_PATH = os.path.join(FIXTURES, "claude-code-tree.json")
RECORD_FIXTURE_PATH = os.path.join(FIXTURES, "claude-code.record.json")

_spec = importlib.util.spec_from_file_location("bridgesllm_toolctl_npm", TOOLCTL_PATH)
toolctl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(toolctl)

UID, GID = os.geteuid(), os.getegid()


def load_json(path):
    with open(path) as handle:
        return json.load(handle)


def policy_tool(tool_id):
    """The shipped entry with its recommended version proposed (fake tarballs never match a real digest)."""
    return toolctl.policy_tool(unqualified_policy(), tool_id)


def sri(data):
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode("ascii")


def materialize(spec_entries, root):
    """Build a tree from a spec (dirs, files, hard links, symlinks) with exact modes."""
    missing, probe = [], root
    while not os.path.exists(probe):
        missing.append(probe)
        probe = os.path.dirname(probe)
    os.makedirs(root, exist_ok=True)
    for path in missing:  # parents this helper creates get a fresh install's modes, whatever the process umask
        os.chmod(path, 0o755)
    os.chmod(root, 0o755)
    order = {"directory": 0, "file": 1, "hardlink": 2, "symlink": 3}
    for entry in sorted(spec_entries, key=lambda e: order[e["kind"]]):
        path = os.path.join(root, entry["path"])
        if entry["kind"] == "directory":
            os.makedirs(path, exist_ok=True)
            os.chmod(path, entry["mode"])
        elif entry["kind"] == "file":
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(entry["text"].encode("utf-8"))
            os.chmod(path, entry["mode"])
        elif entry["kind"] == "hardlink":
            os.link(os.path.join(root, entry["target"]), path)
        else:
            os.symlink(entry["target"], path)


def fixture_record(base):
    """The record the Python writer produces for the shared fixture tree."""
    spec = load_json(TREE_SPEC_PATH)
    tree = os.path.join(base, "tree")
    materialize(spec["entries"], tree)
    snapshot = toolctl.npm_tree_snapshot(tree, uid=UID, gid=GID)
    facts = toolctl.npm_tree_facts(spec["toolId"], snapshot, spec["version"], spec["platform"])
    record = toolctl.build_admission_record(
        spec["toolId"], spec["version"], spec["packageRoot"], spec["platform"], facts, spec["integrity"],
        "unavailable", spec["admittedBy"], spec["admittedAt"], policy_tool(spec["toolId"]))
    path = toolctl.write_admission_record(os.path.join(base, "admission"), record)
    with open(path, "rb") as handle:
        return record, path, handle.read()


class TempCase(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="toolctl-npm-")
        os.chmod(self.base, 0o755)
        self.addCleanup(shutil.rmtree, self.base, True)


class TreeWalkTests(TempCase):
    def tree(self, entries):
        root = os.path.join(self.base, "pkg")
        materialize(entries, root)
        return root

    def test_digest_is_the_backend_canonical_form(self):
        root = self.tree([
            {"path": "b", "kind": "directory", "mode": 0o755},
            {"path": "a.js", "kind": "file", "mode": 0o644, "text": "x"},
            {"path": "b/c", "kind": "symlink", "target": "../a.js"},
        ])
        lines = [
            "f\x00a.js\x00644\x001\x00" + hashlib.sha256(b"x").hexdigest(),
            "d\x00b\x00755",
            "l\x00b/c\x00../a.js",
        ]
        expected = hashlib.sha256("".join(line + "\n" for line in lines).encode("utf-8")).hexdigest()
        self.assertEqual(toolctl.npm_tree_snapshot(root, uid=UID, gid=GID)["digest"], expected)

    def test_refuses_what_the_backend_walker_refuses(self):
        cases = {
            "group-writable": [{"path": "a", "kind": "file", "mode": 0o664, "text": "x"}],
            "escaping symlink": [{"path": "a", "kind": "symlink", "target": "../../etc/passwd"}],
            "dangling symlink": [{"path": "a", "kind": "symlink", "target": "missing"}],
        }
        for label, entries in cases.items():
            with self.subTest(label):
                root = os.path.join(self.base, label.replace(" ", "-"))
                materialize(entries, root)
                with self.assertRaises(toolctl.NpmRefusal) as caught:
                    toolctl.npm_tree_snapshot(root, uid=UID, gid=GID)
                self.assertEqual(caught.exception.code, "NPM_TREE_UNSAFE")
        root = self.tree([])
        os.mkfifo(os.path.join(root, "fifo"), 0o644)
        with self.assertRaises(toolctl.NpmRefusal):
            toolctl.npm_tree_snapshot(root, uid=UID, gid=GID)
        with self.assertRaises(toolctl.NpmRefusal) as caught:
            toolctl.npm_tree_snapshot(root, uid=UID + 1, gid=GID)
        self.assertIn("ownership or permissions are unsafe", caught.exception.message)

    def test_hard_link_outside_the_tree_is_refused(self):
        spec = load_json(TREE_SPEC_PATH)
        root = self.tree(spec["entries"])
        os.link(os.path.join(root, "install.cjs"), os.path.join(self.base, "outside"))
        snapshot = toolctl.npm_tree_snapshot(root, uid=UID, gid=GID)
        with self.assertRaises(toolctl.NpmRefusal) as caught:
            toolctl.npm_tree_facts("claude-code", snapshot, spec["version"], "linux-x64-gnu")
        self.assertIn("hard link outside", caught.exception.message)

    def test_installed_tree_check_matches_the_reader(self):
        spec = load_json(TREE_SPEC_PATH)
        staged = self.tree(spec["entries"])
        facts = toolctl.npm_tree_facts("claude-code", toolctl.npm_tree_snapshot(staged, uid=UID, gid=GID),
                                       spec["version"], "linux-x64-gnu")
        installed = os.path.join(self.base, "installed")
        materialize(spec["entries"], installed)
        self.assertIsNone(toolctl.npm_tree_admits(facts, toolctl.npm_tree_snapshot(installed, uid=UID, gid=GID)))
        # A copy instead of the approved hard link is still admitted (groups are optional).
        exe = os.path.join(installed, "bin/claude.exe")
        os.unlink(exe)
        shutil.copyfile(os.path.join(installed, "node_modules/@anthropic-ai/claude-code-linux-x64/claude"), exe)
        os.chmod(exe, 0o755)
        self.assertIsNone(toolctl.npm_tree_admits(facts, toolctl.npm_tree_snapshot(installed, uid=UID, gid=GID)))
        with open(os.path.join(installed, "cli-wrapper.cjs"), "a") as handle:
            handle.write("tampered\n")
        self.assertEqual(toolctl.npm_tree_admits(facts, toolctl.npm_tree_snapshot(installed, uid=UID, gid=GID)),
                         "its files differ from the verified official release")


class RecordTests(TempCase):
    def facts(self):
        spec = load_json(TREE_SPEC_PATH)
        root = os.path.join(tempfile.mkdtemp(dir=self.base), "tree")
        materialize(spec["entries"], root)
        return spec, toolctl.npm_tree_facts("claude-code", toolctl.npm_tree_snapshot(root, uid=UID, gid=GID),
                                            spec["version"], "linux-x64-gnu")

    def build(self, **overrides):
        spec, facts = self.facts()
        args = dict(tool_id="claude-code", version=spec["version"], package_root=spec["packageRoot"],
                    platform_key="linux-x64-gnu", facts=facts, integrity=spec["integrity"], provenance="unavailable",
                    admitted_by=spec["admittedBy"], admitted_at=spec["admittedAt"], tool_policy=policy_tool("claude-code"))
        args.update(overrides)
        return toolctl.build_admission_record(**args)

    def test_policy_and_parser_rules(self):
        record = self.build()
        self.assertEqual(record["source"]["tarball"],
                         "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.320.tgz")
        refusals = {
            "below the record floor": dict(version="2.1.308"),
            "not a plain release": dict(version="2.1.320-beta.1"),
            "bad integrity": dict(integrity="sha512-short=="),
            "bad author": dict(admitted_by="catalog-v1-migration"),
            "bad time": dict(admitted_at="2026-10-30 22:40:00"),
            "wrong platform": dict(platform_key="linux-x64-musl"),
        }
        for label, override in refusals.items():
            with self.subTest(label), self.assertRaises(toolctl.NpmRefusal):
                self.build(**override)
        denied = dict(policy_tool("claude-code"), denylist=[{"version": "2.1.320", "reason": "breaks headless mode"}])
        with self.assertRaises(toolctl.NpmRefusal) as caught:
            self.build(tool_policy=denied)
        self.assertIn("breaks headless mode", caught.exception.message)
        bad = dict(record, extra=True)
        self.assertIn("unexpected", toolctl.admission_record_problem(bad, "claude-code", record["packageRoot"],
                                                                      "linux-x64-gnu", policy_tool("claude-code")))
        codex_policy = policy_tool("codex")
        unverified = dict(record, toolId="codex", packageName="@openai/codex", version="0.170.0",
                          packageRoot="/usr/lib/node_modules/@openai/codex",
                          source=dict(record["source"], tarball=toolctl.official_npm_tarball_url("@openai/codex", "0.170.0")))
        self.assertIn("publishes provenance", toolctl.admission_record_problem(
            unverified, "codex", "/usr/lib/node_modules/@openai/codex", "linux-x64-gnu", codex_policy))

    def test_writer_modes_and_atomic_replace(self):
        record = self.build()
        directory = os.path.join(self.base, "admission")
        path = toolctl.write_admission_record(directory, record)
        self.assertEqual(stat.S_IMODE(os.lstat(directory).st_mode), 0o700)
        info = os.lstat(path)
        self.assertEqual((stat.S_IMODE(info.st_mode), info.st_nlink), (0o600, 1))
        replaced = toolctl.write_admission_record(directory, dict(record, admittedAt="2026-10-31T01:00:00.000Z"))
        self.assertEqual(replaced, path)
        self.assertEqual(load_json(path)["admittedAt"], "2026-10-31T01:00:00.000Z")
        self.assertEqual(sorted(os.listdir(directory)), ["claude-code.json"])
        linked = os.path.join(self.base, "linked")
        os.symlink(directory, linked)
        with self.assertRaises(toolctl.ToolctlError):
            toolctl.write_admission_record(linked, record)


class CrossLanguageFixtureTests(TempCase):
    """The committed record is what the Python writer produces; the backend jest
    test nativeHostCliAdmissionRecordToolctl.test.ts parses and attests it."""

    def test_writer_output_equals_the_committed_fixture(self):
        _record, _path, data = fixture_record(self.base)
        with open(RECORD_FIXTURE_PATH, "rb") as handle:
            self.assertEqual(data, handle.read(),
                             "regenerate %s from fixture_record() when the writer changes on purpose" % RECORD_FIXTURE_PATH)


class LockstepTests(unittest.TestCase):
    """toolctl's copies of backend facts must not drift from the backend."""

    def test_layouts_and_limits_match_the_catalog(self):
        catalog = load_json(CATALOG_PATH)
        self.assertEqual(catalog["limits"], toolctl.NPM_TREE_LIMITS)
        for tool_id, layout in toolctl.NPM_TOOL_LAYOUTS.items():
            with self.subTest(tool_id):
                entry = catalog["tools"][tool_id]
                self.assertEqual(entry["packageName"], layout["packageName"])
                self.assertEqual(entry["packageRoot"], "/usr/lib/node_modules/" + layout["packageName"])
                self.assertEqual((entry["binName"], entry["binRelative"]), (layout["binName"], layout["binRelative"]))
                self.assertEqual(entry["executables"], {
                    "/usr/bin/" + name: "../lib/node_modules/%s/%s" % (layout["packageName"], layout["binRelative"])
                    for name in layout["executables"]})
                version, latest = list(entry["versions"].items())[-1]
                for platform_key, platform in latest["platforms"].items():
                    arch = platform_key.split("-")[1]
                    if layout["platformPackage"] is None:
                        self.assertIsNone(platform["platformPackageRelative"])
                        continue
                    relative, name, pattern, binary = layout["platformPackage"][arch]
                    self.assertEqual((platform["platformPackageRelative"], platform["platformPackageName"],
                                      platform["platformPackageVersion"], platform["platformBinRelative"]),
                                     (relative, name, pattern.format(version=version), binary))

    def test_record_floors_and_provenance_match_the_backend_reader(self):
        with open(RECORD_TS_PATH) as handle:
            source = handle.read()
        rows = dict((tool, (floor, provenance)) for tool, floor, provenance in re.findall(
            r"'?([a-z-]+)'?: Object\.freeze\(\{ floor: '([0-9.]+)', provenance: '([a-z]+)', denylist: Object\.freeze\(\[\]\) \}\)",
            source))
        self.assertEqual(sorted(rows), sorted(toolctl.NPM_TOOL_IDS))
        for tool_id in toolctl.NPM_TOOL_IDS:
            with self.subTest(tool_id):
                self.assertEqual(rows[tool_id][0], toolctl.NPM_RECORD_FLOORS[tool_id])
                tool = policy_tool(tool_id)
                self.assertEqual(rows[tool_id][1], tool["source"]["provenance"])
                self.assertEqual(tool["denylist"], [], "the backend record deny-list is empty; keep both in step")


# -- requalify with fake npm / node / systemd-run -----------------------------

RUN_ID = "0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01"
CLAUDE_VERSION = "2.1.320"
PLATFORM_DIR = "node_modules/@anthropic-ai/claude-code-linux-x64"
# The fixture postinstall is Python (the fake node runs scripts with python3):
# like the vendor's install.cjs it replaces the stub with a hard link.
INSTALL_CJS = 'import os\nos.unlink("bin/claude.exe")\nos.link("%s/claude", "bin/claude.exe")\n' % PLATFORM_DIR

FAKE_NODE = """#!/bin/sh
if [ "$1" = "--version" ]; then echo v24.22.1; exit 0; fi
exec /usr/bin/python3 -I "$@"
"""

FAKE_NPM = r"""
import json, os, shutil, sys
FAKE = %(fake)r
args = [a for a in sys.argv[1:] if not a.startswith("--userconfig=") and not a.startswith("--globalconfig=")
        and not a.startswith("--cache=") and a not in ("--registry=https://registry.npmjs.org/", "--no-update-notifier", "--loglevel=warn")]
with open(os.path.join(FAKE, "npm-calls.log"), "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "home": os.environ.get("HOME")}) + "\n")
def load(name, default=None):
    path = os.path.join(FAKE, name)
    if not os.path.exists(path):
        return default
    with open(path) as handle:
        return json.load(handle)
cfg = load("config.json", {})
if args[:2] == ["config", "get"]:
    print(cfg.get(args[2], "https://registry.npmjs.org/" if args[2] == "registry" else "undefined")); sys.exit(0)
if args[0] == "view":
    meta = load("meta.json")[args[1]] if args[1] in load("meta.json") else None
    if meta is None:
        sys.stderr.write("E404 not found\n"); sys.exit(1)
    print(json.dumps(meta)); sys.exit(0)
if args[0] == "pack":
    spec, dest = args[1], args[args.index("--pack-destination") + 1]
    name = spec.rpartition("@")[0].split("/")[-1] + "-" + spec.rpartition("@")[2] + ".tgz"
    with open(os.path.join(dest, name), "wb") as handle:
        handle.write(load("tarballs.json")[spec].encode("utf-8"))
    print(json.dumps([{"filename": name}])); sys.exit(0)
if args[0] == "install":
    sys.path.insert(0, %(tests)r)
    from test_toolctl_npm import materialize
    deps = load_pkg = json.load(open("package.json"))["dependencies"]
    for name, version in deps.items():
        materialize(load("staged-tree.json"), os.path.join(os.getcwd(), "node_modules", name))
    with open("package-lock.json", "w") as handle:
        json.dump({"lockfileVersion": 3, "packages": load("lock.json")}, handle)
    sys.exit(0)
if args[:2] == ["audit", "signatures"]:
    print(json.dumps(load("audit.json"))); sys.exit(cfg.get("auditExit", 0))
sys.stderr.write("fake npm: unexpected %%r\n" %% (args,)); sys.exit(2)
"""

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
if os.path.exists(os.path.join(FAKE, "nobody-probe")) and program[0].startswith(%(bindir)r):
    npm_root = os.path.join(os.path.dirname(%(bindir)r), "lib", "node_modules")
    directory = os.path.dirname(os.path.realpath(program[0]))
    while directory.startswith(npm_root + os.sep):
        if not os.stat(directory).st_mode & 0o001:
            sys.stderr.write("%%s: Permission denied\n" %% program[0])
            sys.exit(126)
        directory = os.path.dirname(directory)
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

def fake_claude(version, flags=None, stream=None):
    """A fake Claude CLI: --version, --help (the adapter flags) and offline stream-json."""
    flags = toolctl.CLAUDE_HEADLESS_FLAGS if flags is None else flags
    stream = '{"type":"system","subtype":"init"}\n{"type":"result","is_error":true,"result":"Not logged in"}' \
        if stream is None else stream
    return ("#!/bin/sh\ncase \"$1\" in\n  --version) echo '%s (Claude Code)' ;;\n"
            "  --help) printf '%%s\\n' 'Usage: claude [options]' %s ;;\n"
            "  -p) printf '%%s\\n' %s ;;\nesac\n") % (
        version, " ".join("'  %s <value>'" % flag for flag in flags),
        " ".join("'%s'" % line for line in stream.split("\n")))


def fake_codex(version, drop=(), served=None, app_answer=None):
    """A fake Codex CLI: --version, each command's --help (the Portal's flags minus ``drop``) and an
    app server that answers one initialize line with ``served`` (default: ``version``) in its userAgent."""
    cases = []
    for command, flags in toolctl.CODEX_HEADLESS_FLAGS:
        lines = ["Usage: codex %s[OPTIONS]" % "".join(c + " " for c in command)] + [
            "  %s <value>" % ("-c, --config" if f == "-c" else f) for f in flags if (command, f) not in drop]
        cases.append('  "%s") printf \'%%s\\n\' %s ;;' % (" ".join(list(command) + ["--help"]),
                                                    " ".join("'%s'" % line for line in lines)))
    answer = app_answer if app_answer is not None else (
        '{"id":1,"result":{"userAgent":"codex_cli_rs/%s (Linux 6.8; x86_64) bridgesllm-portal/1"}}' % (served or version))
    cases.append('  "app-server --listen stdio://") read -r line; echo "$line" > "$(dirname "$0")/app-server-request.json"; '
                 'printf \'%%s\\n\' \'%s\'; read -r rest ;;' % answer)
    return "#!/bin/sh\ncase \"$*\" in\n  --version) echo 'codex-cli %s' ;;\n%s\nesac\n" % (version, "\n".join(cases))


def claude_entries(stub=False, wrapper="// fixture wrapper\n"):
    entries = []
    for entry in load_json(TREE_SPEC_PATH)["entries"]:
        entry = dict(entry)
        if entry["path"] == PLATFORM_DIR + "/claude":
            entry["text"] = fake_claude(CLAUDE_VERSION)
        if entry["path"] == "install.cjs":
            entry["text"] = INSTALL_CJS
        if entry["path"] == "cli-wrapper.cjs":
            entry["text"] = wrapper
        if entry["path"] == "bin/claude.exe" and stub:
            entry = {"path": "bin/claude.exe", "kind": "file", "mode": 0o755, "text": "#!/bin/sh\necho stub\n"}
        entries.append(entry)
    return entries


class RequalifyHost(TempCase):
    """A fake host: installed Claude Code, fake npm/node/systemd-run, private state."""

    def setUp(self):
        super().setUp()
        b = self.base
        self.fake = os.path.join(b, "fake")
        os.makedirs(self.fake)
        bins = os.path.join(b, "fakebin")
        os.makedirs(bins)
        for name, text in (("node", FAKE_NODE), ("npm", FAKE_NPM % {"fake": self.fake, "tests": HERE}),
                           ("systemd-run", FAKE_SYSTEMD_RUN % {"fake": self.fake, "bindir": os.path.join(b, "usr/bin")}),
                           ("setpriv", FAKE_SETPRIV % {"fake": self.fake})):
            with open(os.path.join(bins, name), "w") as handle:
                handle.write(text)
            os.chmod(os.path.join(bins, name), 0o755)
        for d in ("usr/lib/node_modules/@anthropic-ai", "usr/bin", "var/lib/bridgesllm"):
            os.makedirs(os.path.join(b, d))
        for d in ("usr/lib/node_modules/@anthropic-ai", "usr/bin"):  # a fresh install's public dirs, whatever the umask
            while d:
                os.chmod(os.path.join(b, d), 0o755)
                d = os.path.dirname(d)
        self.package_root = os.path.join(b, "usr/lib/node_modules/@anthropic-ai/claude-code")
        materialize(claude_entries(), self.package_root)
        os.symlink("../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", os.path.join(b, "usr/bin/claude"))
        values = {name: default for name, (_env, default) in toolctl.DEFAULTS.items()}
        values.update(state_root=os.path.join(b, "var/lib/bridgesllm/tools"), npm_global_root=os.path.join(b, "usr/lib/node_modules"),
                      systemd_unit_dirs=[os.path.join(b, "units")])
        self.roots = toolctl.Roots(**values)
        for name, value in (("npm_bin_dir", os.path.join(b, "usr/bin")), ("node_bin", os.path.join(bins, "node")),
                            ("npm_bin", os.path.join(bins, "npm")), ("systemd_run_bin", os.path.join(bins, "systemd-run")),
                            ("setpriv_bin", os.path.join(bins, "setpriv"))):
            setattr(self.roots, name, value)
        # Fake tarballs never match a real qualified digest: every recommended version starts proposed, in memory
        # and in the policy file toolctl itself reads.
        self.roots.policy_path = os.path.join(b, "tool-policy.v2.json")
        with open(self.roots.policy_path, "w", encoding="utf-8") as handle:
            handle.write(unqualified_policy_text())
        toolctl.ensure_state_dirs(self.roots)
        self.policy = unqualified_policy()
        root_spec = "@anthropic-ai/claude-code@" + CLAUDE_VERSION
        platform_spec = "@anthropic-ai/claude-code-linux-x64@" + CLAUDE_VERSION
        self.tarballs = {root_spec: "root tarball bytes", platform_spec: "platform tarball bytes"}
        self.meta = {
            root_spec: {"name": "@anthropic-ai/claude-code", "version": CLAUDE_VERSION,
                        "scripts": {"postinstall": "node install.cjs", "prepare": "node -e guard"},
                        "dist": {"tarball": toolctl.official_npm_tarball_url("@anthropic-ai/claude-code", CLAUDE_VERSION),
                                 "integrity": sri(b"root tarball bytes")}},
            platform_spec: {"name": "@anthropic-ai/claude-code-linux-x64", "version": CLAUDE_VERSION,
                            "dist": {"tarball": toolctl.official_npm_tarball_url("@anthropic-ai/claude-code-linux-x64", CLAUDE_VERSION),
                                     "integrity": sri(b"platform tarball bytes")}},
        }
        self.lock = {"": {"name": "bridgesllm-stage"},
                     "node_modules/@anthropic-ai/claude-code": {"version": CLAUDE_VERSION, "integrity": sri(b"root tarball bytes")},
                     "node_modules/@anthropic-ai/claude-code/" + PLATFORM_DIR: {"version": CLAUDE_VERSION,
                                                                                "integrity": sri(b"platform tarball bytes")}}
        self.audit = {"invalid": [], "missing": [], "verified": []}
        self.config = {}
        self.staged = claude_entries(stub=True)

    def fake_files(self):
        for name, value in (("meta.json", self.meta), ("tarballs.json", self.tarballs), ("lock.json", self.lock),
                            ("audit.json", self.audit), ("config.json", self.config), ("staged-tree.json", self.staged)):
            with open(os.path.join(self.fake, name), "w") as handle:
                json.dump(value, handle)

    def requalify(self):
        self.fake_files()
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "claude-code", "action": "requalify"}
        self.assertEqual(toolctl.validate_request(request, RUN_ID, self.policy), [])
        return toolctl.execute_npm_run(self.roots, run, self.policy, request, uid=UID, gid=GID, platform_key="linux-x64-gnu",
                                       now=lambda: "2026-10-30T23:00:00.000Z")

    def record_path(self):
        return os.path.join(self.roots.state_root, "admission", "claude-code.json")

    def npm_calls(self):
        with open(os.path.join(self.fake, "npm-calls.log")) as handle:
            return [json.loads(line) for line in handle]

    def assert_refused(self, status, code):
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", code), status["error"])
        self.assertFalse(os.path.exists(self.record_path()), "no record may be written on a refusal")

    def admit_installed(self):
        """The record a passed re-check writes for the installed tree."""
        snapshot = toolctl.npm_tree_snapshot(self.package_root, uid=UID, gid=GID)
        facts = toolctl.npm_tree_facts("claude-code", snapshot, CLAUDE_VERSION, "linux-x64-gnu")
        record = toolctl.build_admission_record(
            "claude-code", CLAUDE_VERSION, self.package_root, "linux-x64-gnu", facts, sri(b"root tarball bytes"),
            "unavailable", "requalify:" + RUN_ID, "2026-10-30T22:00:00.000Z", toolctl.policy_tool(self.policy, "claude-code"))
        return toolctl.write_admission_record(os.path.join(self.roots.state_root, "admission"), record)

    def recommend(self, version):
        toolctl.policy_tool(self.policy, "claude-code")["newestProven"]["version"] = version


class RequalifyTests(RequalifyHost):
    def test_admits_a_self_updated_tree_that_is_the_official_release(self):
        status = self.requalify()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]],
                         ["installed", "resolve", "fetch", "verify-source", "compare", "probe", "commit"])
        record = load_json(self.record_path())
        self.assertIsNone(toolctl.admission_record_problem(record, "claude-code", self.package_root, "linux-x64-gnu",
                                                           toolctl.policy_tool(self.policy, "claude-code")))
        self.assertEqual((record["version"], record["admittedBy"], record["source"]["provenance"]),
                         (CLAUDE_VERSION, "requalify:" + RUN_ID, "unavailable"))
        self.assertEqual(stat.S_IMODE(os.stat(self.record_path()).st_mode), 0o600)
        installs = [c for c in self.npm_calls() if c["argv"][0] == "install"]
        self.assertEqual(len(installs), 1)
        self.assertIn("--ignore-scripts", installs[0]["argv"])
        self.assertIn("--install-strategy=shallow", installs[0]["argv"])
        for call in self.npm_calls():
            if call["argv"][:2] != ["config", "get"]:
                self.assertIn("--registry=https://registry.npmjs.org/", call["argv"])
                self.assertTrue(any(a.startswith("--userconfig=" + self.roots.tmp_dir) for a in call["argv"]))
        with open(os.path.join(self.fake, "sandbox-calls.log")) as handle:
            boxes = [json.loads(line) for line in handle]
        self.assertEqual(len(boxes), 4)  # the reviewed postinstall, then C-VER, C-HEADLESS, C-OUTPUT
        staged_root = os.path.join(self.roots.tmp_dir, RUN_ID, "claude-code", "stage", "node_modules/@anthropic-ai/claude-code")
        for box in boxes:
            self.assertTrue(sandbox_confined(box), box)  # setpriv drops to a real host uid in PID 1's box
            self.assertEqual(sandbox_binds(box, "BindPaths")[0][1], "/tmp")  # the command's own scratch /tmp
            boxed(box)
        # The reviewed postinstall may write the staged package only; the probes (of the installed tree) write nothing.
        self.assertEqual(sandbox_binds(boxes[0], "BindPaths")[1:], [(staged_root, staged_root)])
        for probe_box in boxes[1:]:
            self.assertEqual(sandbox_binds(probe_box, "BindPaths")[1:], [])
            self.assertEqual(sandbox_binds(probe_box, "BindReadOnlyPaths"), [])
        self.assertFalse(os.path.exists(os.path.join(self.roots.tmp_dir, RUN_ID, "claude-code")), "the stage is cleaned up")

    def test_integrity_mismatch_is_refused_before_anything_is_staged(self):
        self.tarballs["@anthropic-ai/claude-code@" + CLAUDE_VERSION] = "tampered tarball bytes"
        status = self.requalify()
        self.assert_refused(status, "NPM_INTEGRITY_MISMATCH")
        self.assertFalse([c for c in self.npm_calls() if c["argv"][0] == "install"])

    def test_platform_integrity_mismatch_is_refused(self):
        self.tarballs["@anthropic-ai/claude-code-linux-x64@" + CLAUDE_VERSION] = "tampered platform bytes"
        self.assert_refused(self.requalify(), "NPM_INTEGRITY_MISMATCH")

    def test_installed_files_that_differ_are_named_and_not_admitted(self):
        shutil.rmtree(self.package_root)
        materialize(claude_entries(wrapper="// edited locally\n"), self.package_root)
        status = self.requalify()
        self.assert_refused(status, "NPM_TREE_DIFFERS")
        self.assertEqual(status["error"]["detail"]["differingPaths"], ["cli-wrapper.cjs"])
        self.assertIn("re-check", status["error"]["message"] + " re-check")  # wording owned by the reader

    def test_custom_registry_is_refused(self):
        self.config = {"registry": "https://mirror.example.invalid/"}
        self.assert_refused(self.requalify(), "NPM_CUSTOM_REGISTRY")

    def test_bad_signatures_are_refused(self):
        self.audit = {"invalid": [{"name": "@anthropic-ai/claude-code", "version": CLAUDE_VERSION, "code": "EINTEGRITYSIGNATURE"}],
                      "missing": []}
        self.config = {"auditExit": 1}
        self.assert_refused(self.requalify(), "NPM_SIGNATURES_INVALID")

    def test_unreviewed_install_script_is_refused(self):
        self.meta["@anthropic-ai/claude-code@" + CLAUDE_VERSION]["scripts"] = {"postinstall": "node other.js"}
        self.assert_refused(self.requalify(), "NPM_INSTALL_SCRIPT_UNREVIEWED")

    def test_version_probe_must_print_the_version(self):
        shutil.rmtree(self.package_root)
        entries = claude_entries()
        self.staged = claude_entries(stub=True)
        for group in (entries, self.staged):
            for entry in group:
                if entry["path"] == PLATFORM_DIR + "/claude":
                    entry["text"] = "#!/bin/sh\necho '2.1.3200 (Claude Code)'\n"
        materialize(entries, self.package_root)
        self.assert_refused(self.requalify(), "CLI_PROBE_FAILED")

    def test_below_the_record_floor_is_refused_without_npm(self):
        shutil.rmtree(self.package_root)
        materialize([dict(e, text=e["text"].replace(CLAUDE_VERSION, "2.1.308")) if e.get("text") else e
                     for e in claude_entries()], self.package_root)
        self.assert_refused(self.requalify(), "NPM_VERSION_NOT_ADMISSIBLE")
        self.assertFalse(os.path.exists(os.path.join(self.fake, "npm-calls.log")))

    def test_an_unreadable_staged_package_json_is_refused(self):
        root = os.path.join(self.base, "staged")
        materialize(claude_entries(), root)
        os.makedirs(os.path.join(root, "node_modules/dep"))
        os.symlink("../../package.json", os.path.join(root, "node_modules/dep/package.json"))
        problem = toolctl.npm_staged_scripts_problem(root, {"postinstall": "node install.cjs"})
        self.assertIn("could not be inspected", problem)

    def test_codex_without_provenance_is_refused(self):
        policy = toolctl.policy_tool(self.policy, "codex")
        tool = toolctl.NpmTool(self.roots, "codex", policy, self.base, uid=UID, gid=GID, platform_key="linux-x64-gnu")
        self.fake_files()
        stage = os.path.join(self.base, "stage-audit")
        os.makedirs(stage)
        self.assertFalse(toolctl.npm_audit_signatures(tool, stage, ["@openai/codex@0.170.0"]))
        self.audit["verified"] = [{"name": "@openai/codex", "version": "0.170.0", "attestations": {"provenance": {}}}]
        self.fake_files()
        self.assertTrue(toolctl.npm_audit_signatures(tool, stage, ["@openai/codex@0.170.0"]))
    def test_a_0700_scope_directory_is_opened_before_the_installed_cli_is_probed(self):
        # B2: fresh installs before 5.2.0 created the scope directory 0700; the probe runs as nobody.
        scope = os.path.dirname(self.package_root)
        os.chmod(scope, 0o700)
        open(os.path.join(self.fake, "nobody-probe"), "w").close()
        status = self.requalify()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(stat.S_IMODE(os.lstat(scope).st_mode), 0o755)
        probe = [s for s in status["steps"] if s["id"] == "probe"][0]
        self.assertIn("was mode 0700, so only root could run Claude Code; it is now 0755.", probe["detail"])


NEW_VERSION = "2.1.330"


def versioned(entries, version):
    return [dict(e, text=e["text"].replace(CLAUDE_VERSION, version)) if e.get("text") else dict(e) for e in entries]


def new_release(case):
    """The registry serves Claude Code NEW_VERSION (the fake npm's metadata, tarballs, lockfile and staged tree)."""
    root_spec = "@anthropic-ai/claude-code@" + NEW_VERSION
    platform_spec = "@anthropic-ai/claude-code-linux-x64@" + NEW_VERSION
    case.tarballs = {root_spec: "new root bytes", platform_spec: "new platform bytes"}
    case.meta = {
        root_spec: {"name": "@anthropic-ai/claude-code", "version": NEW_VERSION, "engines": {"node": ">=22.0.0"},
                    "scripts": {"postinstall": "node install.cjs"},
                    "dist": {"tarball": toolctl.official_npm_tarball_url("@anthropic-ai/claude-code", NEW_VERSION),
                             "integrity": sri(b"new root bytes")}},
        platform_spec: {"name": "@anthropic-ai/claude-code-linux-x64", "version": NEW_VERSION,
                        "dist": {"tarball": toolctl.official_npm_tarball_url("@anthropic-ai/claude-code-linux-x64", NEW_VERSION),
                                 "integrity": sri(b"new platform bytes")}},
    }
    case.lock = {"": {"name": "bridgesllm-stage"},
                 "node_modules/@anthropic-ai/claude-code": {"integrity": sri(b"new root bytes")},
                 "node_modules/@anthropic-ai/claude-code/" + PLATFORM_DIR: {"integrity": sri(b"new platform bytes")}}
    case.staged = versioned(claude_entries(stub=True), NEW_VERSION)


class UpdateTests(RequalifyHost):
    def setUp(self):
        super().setUp()
        new_release(self)

    def update(self, target=NEW_VERSION):
        self.fake_files()
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "claude-code", "action": "update", "target": target}
        self.assertEqual(toolctl.validate_request(request, RUN_ID, self.policy), [])
        return toolctl.execute_npm_run(self.roots, run, self.policy, request, uid=UID, gid=GID, platform_key="linux-x64-gnu",
                                       now=lambda: "2026-10-30T23:10:00.000Z")

    def live_version(self):
        return load_json(os.path.join(self.package_root, "package.json"))["version"]

    def prev_dir(self):
        return os.path.join(self.roots.npm_global_root, ".bridgesllm-prev", "claude-code")

    def test_update_swaps_atomically_and_keeps_the_previous_tree(self):
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], [
            "installed", "resolve", "fetch", "verify-source", "probe-candidate", "swap", "probe-installed", "commit", "cleanup"])
        self.assertEqual((status["result"]["from"], status["result"]["to"]), (CLAUDE_VERSION, NEW_VERSION))
        self.assertEqual(self.live_version(), NEW_VERSION)
        self.assertEqual(os.listdir(self.prev_dir()), ["%s.%s" % (CLAUDE_VERSION, RUN_ID)])
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["admittedBy"]), (NEW_VERSION, "run:" + RUN_ID))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))
        self.assertEqual(status["swap"]["state"], "committed")
        # The backend reader's rules admit the live tree by the new record.
        live = toolctl.npm_tree_snapshot(self.package_root, uid=UID, gid=GID)
        self.assertIsNone(toolctl.npm_tree_admits(record, live))
        # The candidate's probes read it where it is staged (its private parents stay hidden); the installed
        # probes need only the read-only host. Neither may write anything but its own scratch /tmp.
        staged_root = os.path.join(self.roots.tmp_dir, RUN_ID, "claude-code", "stage", "node_modules/@anthropic-ai/claude-code")
        with open(os.path.join(self.fake, "sandbox-calls.log")) as handle:
            boxes = [json.loads(line) for line in handle]
        candidate = [box for box in boxes if boxed(box)[0].startswith(staged_root + "/")]
        installed = [box for box in boxes if boxed(box)[0] == os.path.join(self.base, "usr/bin/claude")]
        self.assertEqual((len(candidate), len(installed)), (3, 3))  # C-VER, C-HEADLESS, C-OUTPUT each
        for box in candidate + installed:
            self.assertEqual([dest for _source, dest in sandbox_binds(box, "BindPaths")], ["/tmp"])
        for box in candidate:
            self.assertEqual(sandbox_binds(box, "BindReadOnlyPaths"), [(staged_root, staged_root)])
        for box in installed:
            self.assertEqual(sandbox_binds(box, "BindReadOnlyPaths"), [])

    def test_a_0700_scope_directory_is_opened_before_the_switch(self):
        # B2: with the scope directory left 0700 the installed probe (nobody) fails and the update is swapped back.
        scope = os.path.dirname(self.package_root)
        os.chmod(scope, 0o700)
        open(os.path.join(self.fake, "nobody-probe"), "w").close()
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(self.live_version(), NEW_VERSION)
        self.assertEqual(stat.S_IMODE(os.lstat(scope).st_mode), 0o755)
        swap = [s for s in status["steps"] if s["id"] == "swap"][0]
        self.assertIn("was mode 0700, so only root could run Claude Code; it is now 0755.", swap["detail"])

    def test_a_0755_scope_directory_is_left_alone(self):
        scope = os.path.dirname(self.package_root)
        os.chmod(scope, 0o755)
        before = os.lstat(scope)
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        after = os.lstat(scope)
        self.assertEqual((after.st_ino, stat.S_IMODE(after.st_mode)), (before.st_ino, 0o755))
        self.assertNotIn("now 0755", [s for s in status["steps"] if s["id"] == "swap"][0]["detail"])

    @unittest.skipUnless(UID == 0, "giving the scope directory another owner needs root")
    def test_a_scope_directory_owned_by_another_user_is_refused_before_any_change(self):
        scope = os.path.dirname(self.package_root)
        os.chmod(scope, 0o700)
        os.chown(scope, 65534, -1)
        status = self.update()
        self.assert_refused(status, "NPM_SCOPE_DIR_UNSAFE")
        self.assertIn("is not a directory owned by root (owner uid 65534)", status["error"]["message"])
        self.assertEqual((os.lstat(scope).st_uid, stat.S_IMODE(os.lstat(scope).st_mode)), (65534, 0o700))
        self.assertEqual(self.live_version(), CLAUDE_VERSION)
        self.assertFalse(os.path.exists(self.prev_dir()))

    def test_failed_check_after_the_swap_puts_the_previous_version_back(self):
        open(os.path.join(self.fake, "fail-installed-probe"), "w").close()
        before = toolctl.npm_tree_snapshot(self.package_root, uid=UID, gid=GID)["digest"]
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "NPM_SWAPPED_BACK"), status.get("error"))
        self.assertIn("2.1.320 was put back", status["error"]["message"])
        self.assertEqual(self.live_version(), CLAUDE_VERSION)
        self.assertEqual(toolctl.npm_tree_snapshot(self.package_root, uid=UID, gid=GID)["digest"], before)
        self.assertEqual(os.listdir(self.prev_dir()), [])
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def test_reconcile_after_a_crash_between_the_renames_restores_the_previous_tree(self):
        self.fake_files()
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        prev = os.path.join(self.prev_dir(), "%s.%s" % (CLAUDE_VERSION, RUN_ID))
        for directory in (os.path.dirname(self.prev_dir()), self.prev_dir(), os.path.dirname(toolctl.npm_fence_path(self.roots, "x"))):
            toolctl.ensure_private_dir(directory)
        fence = toolctl.npm_fence_path(self.roots, "claude-code")
        open(fence, "w").close()
        os.rename(self.package_root, prev)
        run.status.update(state="running", phase="swap", swap={
            "live": self.package_root, "prev": prev, "failed": os.path.join(self.prev_dir(), "failed." + RUN_ID),
            "fence": fence, "from": CLAUDE_VERSION, "to": NEW_VERSION, "state": "moving-candidate"})
        run.save()
        settled = toolctl.cmd_reconcile(self.roots)
        self.assertEqual(settled, [{"runId": RUN_ID, "state": "rolled-back"}])
        self.assertEqual(self.live_version(), CLAUDE_VERSION)
        self.assertFalse(os.path.exists(fence))

    def test_reconcile_with_neither_tree_present_says_the_tool_is_not_installed(self):
        self.fake_files()
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        for directory in (os.path.dirname(self.prev_dir()), self.prev_dir(), os.path.dirname(toolctl.npm_fence_path(self.roots, "x"))):
            toolctl.ensure_private_dir(directory)
        shutil.rmtree(self.package_root)
        fence = toolctl.npm_fence_path(self.roots, "claude-code")
        open(fence, "w").close()
        run.status.update(state="running", phase="swap", swap={
            "live": self.package_root, "prev": os.path.join(self.prev_dir(), "%s.%s" % (CLAUDE_VERSION, RUN_ID)),
            "failed": os.path.join(self.prev_dir(), "failed." + RUN_ID), "fence": fence,
            "from": CLAUDE_VERSION, "to": NEW_VERSION, "state": "moving-candidate"})
        run.save()
        self.assertEqual(toolctl.cmd_reconcile(self.roots), [{"runId": RUN_ID, "state": "recovery-required"}])
        error = toolctl.read_json_file(os.path.join(run.dir, "status.json"))["error"]
        self.assertEqual((error["id"], error["message"]), ("NPM_TREE_MISSING", "Neither the new nor the previous claude-code "
                         "tree is present, so Claude Code is not installed on this server. Re-check Claude Code in "
                         "Admin > Maintenance; once it confirms that, its card offers Install."))
        # The Portal's CLI admission reads the fence; a finished run must not leave it behind.
        self.assertFalse(os.path.exists(fence))

    def run_entry(self, target=NEW_VERSION):
        """The runner entry (`toolctl run <id>`): cmd_run executes the queued request and settles an internal error."""
        self.fake_files()
        self.roots.portal_operation_lock = os.path.join(self.base, "portal-operation.lock")
        self.roots.installer_state_root = os.path.join(self.base, "installer-state")
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        toolctl.atomic_write_json(os.path.join(run.dir, "request.json"), {
            "schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "claude-code", "action": "update", "target": target})
        host = {"uid": UID, "gid": GID, "platform_key": "linux-x64-gnu", "now": lambda: "2026-10-30T23:10:00.000Z"}
        execute, settle = toolctl.execute_npm_run, toolctl.npm_reconcile_run
        with mock.patch.object(toolctl, "execute_npm_run", lambda *a, **k: execute(*a, **dict(k, **host))), \
                mock.patch.object(toolctl, "npm_reconcile_run", lambda *a, **k: settle(*a, **dict(k, **host))):
            status = toolctl.cmd_run(self.roots, RUN_ID)
        self.assertEqual(toolctl.read_json_file(os.path.join(run.dir, "status.json"))["state"], status["state"])
        self.assertEqual(toolctl.read_history(self.roots)[-1]["outcome"], status["state"])
        self.assertIsNone(toolctl.lock_holder(self.roots))
        return status

    def test_an_error_between_the_renames_puts_the_previous_tree_back(self):
        # Disk full while recording the second rename: the live path is empty and the old tree is only at prev.
        save, raised = toolctl.Run.save, []

        def save_or_fail(run):
            if (run.status.get("swap") or {}).get("state") == "moving-candidate" and not raised:
                raised.append(True)
                raise OSError(errno.ENOSPC, "No space left on device")
            return save(run)
        with mock.patch.object(toolctl.Run, "save", save_or_fail):
            status = self.run_entry()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "NPM_SWAPPED_BACK"), status["error"])
        self.assertIn("2.1.320 was put back", status["error"]["message"])
        self.assertEqual((status["internalError"]["phase"], status["internalError"]["swapState"]), ("swap", "moving-candidate"))
        self.assertTrue(status["internalError"]["reason"].startswith("OSError: "))
        self.assertEqual(self.live_version(), CLAUDE_VERSION)
        self.assertEqual(os.listdir(self.prev_dir()), [])
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def test_an_error_while_committing_is_checked_again_and_committed(self):
        write, raised = toolctl.write_admission_record, []

        def write_or_fail(*args):
            if not raised:
                raised.append(True)
                raise OSError(errno.ENOSPC, "No space left on device")
            return write(*args)
        with mock.patch.object(toolctl, "write_admission_record", write_or_fail):
            status = self.run_entry()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["reconciled"], "checked and committed after the interruption")
        self.assertEqual((status["internalError"]["phase"], status["internalError"]["swapState"]), ("commit", "committing"))
        self.assertEqual(self.live_version(), NEW_VERSION)
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["admittedBy"]), (NEW_VERSION, "run:" + RUN_ID))
        self.assertIsNone(toolctl.npm_tree_admits(record, toolctl.npm_tree_snapshot(self.package_root, uid=UID, gid=GID)))
        self.assertEqual(os.listdir(self.prev_dir()), ["%s.%s" % (CLAUDE_VERSION, RUN_ID)])
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def test_an_error_that_keeps_raising_after_the_switch_needs_recovery(self):
        secret = "api_key=fake-secret-value-9f8e7d6c5b4a3210"
        with mock.patch.object(toolctl, "write_admission_record", side_effect=OSError(errno.EIO, "I/O error " + secret)):
            status = self.run_entry()
        self.assertEqual((status["state"], status["error"]["id"]), ("recovery-required", "TOOLS_RUN_INTERNAL_ERROR"))
        self.assertIn("could not be settled. Recovery is required: Re-check Claude Code in Admin > Maintenance.",
                      status["error"]["message"])
        detail = status["error"]["detail"]
        self.assertEqual((detail["phase"], detail["swapState"]), ("commit", "committing"))
        self.assertTrue(detail["reason"].startswith("OSError: ") and detail["settleReason"].startswith("OSError: "), detail)
        self.assertNotIn("fake-secret-value", json.dumps(status))
        self.assertEqual(self.live_version(), NEW_VERSION, "the switched tree is left for the repair, never half-moved")
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def test_an_error_before_the_switch_began_is_a_failure_that_changed_nothing(self):
        with mock.patch.object(toolctl, "cli_probe_set", side_effect=RuntimeError("a probe bug")):
            status = self.run_entry()
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_INTERNAL_ERROR"))
        self.assertIn("before it changed anything", status["error"]["message"])
        self.assertEqual(status["error"]["detail"]["phase"], "probe-candidate")
        self.assertNotIn("swap", status)
        self.assertNotIn("internalError", status)
        self.assertEqual(self.live_version(), CLAUDE_VERSION)

    def test_a_stop_request_before_the_swap_changes_nothing(self):
        self.fake_files()
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        stop = toolctl.StopRequest()
        stop.signal_name = "SIGTERM"
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "claude-code", "action": "update", "target": NEW_VERSION}
        status = toolctl.execute_npm_run(self.roots, run, self.policy, request, stop=stop, uid=UID, gid=GID,
                                         platform_key="linux-x64-gnu")
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_STOPPED"))
        self.assertEqual(self.live_version(), CLAUDE_VERSION)
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def qualify(self, integrity):
        toolctl.policy_tool(self.policy, "claude-code")["newestProven"].update(
            version=NEW_VERSION, status="qualified", integrity=integrity, qualifiedAt="2026-11-02T10:00:00Z")

    def test_a_qualified_version_must_carry_its_qualified_sri(self):
        # The SRI string applies on every machine (behaviour unchanged by the per-machine contract).
        self.qualify("sha512-" + "B" * 86 + "==")
        self.assert_refused(self.update(), "NPM_PROVEN_DIGEST_MISMATCH")
        self.assertEqual(self.live_version(), CLAUDE_VERSION)
        shutil.rmtree(os.path.join(self.roots.runs_dir, RUN_ID))
        self.qualify(sri(b"new root bytes"))
        status = self.update()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(self.live_version(), NEW_VERSION)

    def test_already_current_and_downgrades_are_refused(self):
        # Already current: the installed tree matches its admission record (read fresh by the run).
        record = self.admit_installed()
        with open(record, "rb") as handle:
            admitted = handle.read()
        status = self.update(target=CLAUDE_VERSION)
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "NPM_ALREADY_CURRENT"), status["error"])
        self.assertEqual(status["error"]["message"], "Claude Code 2.1.320 is already installed. Nothing to update.")
        with open(record, "rb") as handle:
            self.assertEqual(handle.read(), admitted)
        self.assertFalse(os.path.exists(os.path.join(self.fake, "npm-calls.log")), "npm is never called")
        shutil.rmtree(os.path.join(self.roots.runs_dir, RUN_ID))
        os.unlink(record)
        self.assert_refused(self.update(target="2.1.310"), "NPM_DOWNGRADE_REFUSED")

    def test_bad_targets_are_refused_by_request_validation(self):
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "codex", "action": "update", "target": "latest; rm"}
        self.assertTrue(toolctl.validate_request(request, RUN_ID, self.policy))
        request.update(action="recover-native", target="newest")
        self.assertIn("not implemented", " ".join(toolctl.validate_request(request, RUN_ID, self.policy)))


CLAUDE_LINK = "../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"


class InstallTests(RequalifyHost):
    """install: a missing CLI gets exactly what `update --target recommended` installs, from nothing."""

    def setUp(self):
        super().setUp()
        new_release(self)
        # Missing: no package tree, no launcher link and no scope directory (npm uninstall -g, or never installed).
        shutil.rmtree(self.package_root)
        os.unlink(self.link())
        self.scope = os.path.dirname(self.package_root)
        os.rmdir(self.scope)
        self.qualify(sri(b"new root bytes"))

    def link(self):
        return os.path.join(self.base, "usr/bin/claude")

    def qualify(self, integrity, status="qualified"):
        toolctl.policy_tool(self.policy, "claude-code")["newestProven"].update(
            version=NEW_VERSION, status=status, integrity=integrity, qualifiedAt="2026-11-02T10:00:00Z")

    def request(self, target="recommended"):
        return {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "claude-code", "action": "install", "target": target}

    def install(self, stop=None):
        self.fake_files()
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        self.assertEqual(toolctl.validate_request(self.request(), RUN_ID, self.policy), [])
        return toolctl.execute_npm_run(self.roots, run, self.policy, self.request(), stop=stop, uid=UID, gid=GID,
                                       platform_key="linux-x64-gnu", now=lambda: "2026-10-31T23:10:00.000Z")

    def run_entry(self):
        """`toolctl run <id>` (cmd_run): both locks, then the run; an internal error is settled by the crash rules."""
        self.fake_files()
        self.roots.portal_operation_lock = os.path.join(self.base, "portal-operation.lock")
        self.roots.installer_state_root = os.path.join(self.base, "installer-state")
        # cmd_run reads the policy file: this Portal's policy, with the recommended version qualified.
        self.roots.policy_path = os.path.join(self.base, "tool-policy.v2.json")
        toolctl.atomic_write_json(self.roots.policy_path, self.policy)
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        toolctl.atomic_write_json(os.path.join(run.dir, "request.json"), self.request())
        host = {"uid": UID, "gid": GID, "platform_key": "linux-x64-gnu", "now": lambda: "2026-10-31T23:10:00.000Z"}
        execute, settle = toolctl.execute_npm_run, toolctl.npm_reconcile_run
        with mock.patch.object(toolctl, "execute_npm_run", lambda *a, **k: execute(*a, **dict(k, **host))), \
                mock.patch.object(toolctl, "npm_reconcile_run", lambda *a, **k: settle(*a, **dict(k, **host))):
            status = toolctl.cmd_run(self.roots, RUN_ID)
        self.assertEqual(toolctl.read_json_file(os.path.join(run.dir, "status.json"))["state"], status["state"])
        self.assertIsNone(toolctl.lock_holder(self.roots))
        return status

    def test_an_existing_0700_scope_directory_is_opened_before_the_install(self):
        # B2: the CLI was removed but its 0700 scope directory (from a fresh install before 5.2.0) stayed.
        os.mkdir(self.scope, 0o700)
        os.chmod(self.scope, 0o700)
        open(os.path.join(self.fake, "nobody-probe"), "w").close()
        status = self.install()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(stat.S_IMODE(os.lstat(self.scope).st_mode), 0o755)
        swap = [s for s in status["steps"] if s["id"] == "swap"][0]
        self.assertIn("was mode 0700, so only root could run Claude Code; it is now 0755.", swap["detail"])

    def test_a_scope_directory_that_is_a_symlink_is_refused_before_any_change(self):
        os.mkdir(self.scope + ".real", 0o700)
        os.chmod(self.scope + ".real", 0o700)
        os.symlink(os.path.basename(self.scope) + ".real", self.scope)
        status = self.install()
        self.assert_refused(status, "NPM_SCOPE_DIR_UNSAFE")
        self.assertIn("is not a real directory", status["error"]["message"])
        self.assertTrue(os.path.islink(self.scope))
        self.assertEqual(os.listdir(self.scope + ".real"), [])
        self.assertEqual(stat.S_IMODE(os.lstat(self.scope + ".real").st_mode), 0o700, "nothing was changed")
        self.assertFalse(os.path.lexists(self.link()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def assert_nothing_installed(self):
        self.assertFalse(os.path.lexists(self.package_root))
        self.assertFalse(os.path.lexists(self.link()))
        self.assertFalse(os.path.lexists(self.scope), "the scope directory this run created goes too")
        self.assertFalse(os.path.exists(self.record_path()))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))
        prev = os.path.join(self.roots.npm_global_root, ".bridgesllm-prev", "claude-code")
        self.assertEqual(os.listdir(prev) if os.path.isdir(prev) else [], [])

    def test_installs_the_recommended_version_with_the_link_a_fresh_install_creates(self):
        status = self.install()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], [
            "installed", "resolve", "fetch", "verify-source", "probe-candidate", "swap", "link", "probe-installed", "commit"])
        self.assertEqual((status["result"]["action"], status["result"]["from"], status["result"]["to"]),
                         ("install", None, NEW_VERSION))
        self.assertEqual(load_json(os.path.join(self.package_root, "package.json"))["version"], NEW_VERSION)
        self.assertEqual(os.readlink(self.link()), CLAUDE_LINK)
        catalog = load_json(CATALOG_PATH)["tools"]["claude-code"]
        self.assertEqual(catalog["executables"], {"/usr/bin/claude": CLAUDE_LINK}, "the link the installer's catalog names")
        self.assertEqual(stat.S_IMODE(os.stat(self.scope).st_mode), 0o755)
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["admittedBy"]), (NEW_VERSION, "run:" + RUN_ID))
        self.assertIsNone(toolctl.admission_record_problem(record, "claude-code", self.package_root, "linux-x64-gnu",
                                                           toolctl.policy_tool(self.policy, "claude-code")))
        # The backend reader admits the installed tree by the new record: the card reads installed, no extra click.
        self.assertIsNone(toolctl.npm_tree_admits(record, toolctl.npm_tree_snapshot(self.package_root, uid=UID, gid=GID)))
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))
        self.assertFalse(os.path.exists(os.path.join(self.roots.npm_global_root, ".bridgesllm-prev")), "nothing to swap back to")
        self.assertEqual(status["swap"]["state"], "committed")

    def test_a_link_left_by_a_removed_tree_is_kept(self):
        os.symlink(CLAUDE_LINK, self.link())
        status = self.install()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["swap"]["links"], [])
        self.assertEqual(os.readlink(self.link()), CLAUDE_LINK)

    def test_an_installed_tool_is_refused(self):
        materialize(claude_entries(), self.package_root)
        status = self.install()
        self.assert_refused(status, "INSTALL_TOOL_PRESENT")
        self.assertIn("Use Update or Re-check on its card instead; nothing was changed.", status["error"]["message"])
        self.assertFalse(os.path.exists(os.path.join(self.fake, "npm-calls.log")), "npm is never called")
        self.assertEqual(load_json(os.path.join(self.package_root, "package.json"))["version"], CLAUDE_VERSION)

    def test_another_program_at_the_link_path_is_refused_and_kept(self):
        with open(self.link(), "w") as handle:
            handle.write("#!/bin/sh\necho another claude\n")
        status = self.install()
        self.assert_refused(status, "INSTALL_PATH_OCCUPIED")
        with open(self.link()) as handle:
            self.assertIn("another claude", handle.read())
        self.assertFalse(os.path.lexists(self.package_root))

    def test_an_unqualified_recommended_version_is_installed_as_its_update_would_be(self):
        # Install admits exactly what Update admits for the same tool and version (an unqualified recommended version
        # too; the release gate keeps those out of published builds), so test builds can exercise Install.
        self.qualify(None, status="proposed")
        status = self.install()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(status["result"]["to"], NEW_VERSION)
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["source"]["integrity"]), (NEW_VERSION, sri(b"new root bytes")))

    def test_a_digest_other_than_the_qualified_one_is_refused(self):
        self.qualify(sri(b"other root bytes"))
        status = self.install()
        self.assert_refused(status, "NPM_PROVEN_DIGEST_MISMATCH")
        self.assert_nothing_installed()

    def test_a_failed_check_after_the_install_removes_what_it_added(self):
        open(os.path.join(self.fake, "fail-installed-probe"), "w").close()
        status = self.install()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "INSTALL_REMOVED"), status["error"])
        self.assertIn("failed its check after it was installed", status["error"]["message"])
        self.assertIn("it was removed again, so nothing was changed.", status["error"]["message"])
        self.assert_nothing_installed()

    def test_a_failed_check_keeps_the_link_this_run_did_not_create(self):
        os.makedirs(self.scope)
        os.symlink(CLAUDE_LINK, self.link())
        open(os.path.join(self.fake, "fail-installed-probe"), "w").close()
        status = self.install()
        self.assertEqual((status["state"], status["error"]["id"]), ("rolled-back", "INSTALL_REMOVED"), status["error"])
        self.assertEqual(os.readlink(self.link()), CLAUDE_LINK)
        self.assertTrue(os.path.isdir(self.scope), "a scope directory that was there stays")
        self.assertFalse(os.path.lexists(self.package_root))

    def test_a_tree_that_appears_before_the_switch_is_left_alone(self):
        check = toolctl.npm_check_candidate

        def check_then_appear(*args, **kwargs):
            detail = check(*args, **kwargs)
            materialize(claude_entries(), self.package_root)  # someone installed it meanwhile
            return detail
        with mock.patch.object(toolctl, "npm_check_candidate", check_then_appear):
            status = self.install()
        self.assert_refused(status, "INSTALL_TOOL_PRESENT")
        self.assertEqual(load_json(os.path.join(self.package_root, "package.json"))["version"], CLAUDE_VERSION)
        self.assertFalse(os.path.lexists(self.link()))
        self.assertNotIn("swap", status, "refused before the run recorded a switch")

    def test_a_tree_that_appears_at_the_last_moment_is_left_alone(self):
        write = toolctl.atomic_write_json

        def write_then_appear(path, doc, *args, **kwargs):
            result = write(path, doc, *args, **kwargs)
            if path == toolctl.npm_fence_path(self.roots, "claude-code"):
                materialize(claude_entries(), self.package_root)
            return result
        with mock.patch.object(toolctl, "atomic_write_json", write_then_appear):
            status = self.install()
        self.assert_refused(status, "INSTALL_TOOL_PRESENT")
        self.assertIn("appeared", status["error"]["message"])
        self.assertEqual(load_json(os.path.join(self.package_root, "package.json"))["version"], CLAUDE_VERSION)
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def test_runs_under_both_locks(self):
        seen = []
        links = toolctl.npm_install_links

        def links_under_lock(tool):
            holder = toolctl.lock_holder(self.roots) or {}
            with open(self.roots.portal_operation_lock) as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    portal_held = True
                else:
                    portal_held = False
                    fcntl.flock(handle, fcntl.LOCK_UN)
            seen.append((holder.get("runId"), portal_held))
            return links(tool)
        with mock.patch.object(toolctl, "npm_install_links", links_under_lock):
            status = self.run_entry()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual(seen, [(RUN_ID, True), (RUN_ID, True)], "read under the run lock, and again before the switch")
        self.assertEqual(status["action"], "install", "the Portal reads what an active run does from its status")

    def test_an_error_while_committing_is_checked_again_and_committed(self):
        write, raised = toolctl.write_admission_record, []

        def write_or_fail(*args):
            if not raised:
                raised.append(True)
                raise OSError(errno.ENOSPC, "No space left on device")
            return write(*args)
        with mock.patch.object(toolctl, "write_admission_record", write_or_fail):
            status = self.run_entry()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual((status["result"]["action"], status["result"]["reconciled"]),
                         ("install", "checked and committed after the interruption"))
        self.assertEqual(os.readlink(self.link()), CLAUDE_LINK)
        self.assertEqual(load_json(self.record_path())["admittedBy"], "run:" + RUN_ID)

    def crashed_run(self, state, rename=True):
        """A runner that died in `state`: the staged tree renamed into place (or not), no link yet."""
        self.fake_files()
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        candidate = os.path.join(self.base, "candidate", "claude-code")
        materialize(versioned(claude_entries(), NEW_VERSION), candidate)  # the staged tree after its reviewed postinstall
        facts = toolctl.npm_tree_facts("claude-code", toolctl.npm_tree_snapshot(candidate, uid=UID, gid=GID), NEW_VERSION,
                                       "linux-x64-gnu")
        info = os.lstat(candidate)
        fence = toolctl.npm_fence_path(self.roots, "claude-code")
        toolctl.ensure_private_dir(os.path.dirname(fence))
        open(fence, "w").close()
        os.makedirs(self.scope)
        if rename:
            os.rename(candidate, self.package_root)
        run.status.update(state="running", phase="swap", swap={
            "kind": "npm-install", "live": self.package_root, "candidate": candidate,
            "failed": os.path.join(self.roots.npm_global_root, ".bridgesllm-prev", "claude-code", "failed." + RUN_ID),
            "fence": fence, "from": None, "to": NEW_VERSION, "integrity": sri(b"new root bytes"), "provenance": "unavailable",
            "treeSha256": facts["treeSha256"], "linkTarget": CLAUDE_LINK, "links": [self.link()],
            "createdDirs": [self.scope], "identity": [info.st_dev, info.st_ino], "state": state})
        run.save()
        return run

    def test_reconcile_after_a_crash_before_the_link_finishes_the_install(self):
        run = self.crashed_run("linking")
        self.assertEqual(toolctl.npm_reconcile_run(self.roots, run, self.policy, uid=UID, gid=GID, platform_key="linux-x64-gnu"),
                         {"runId": RUN_ID, "state": "succeeded"})
        self.assertEqual(run.status["result"]["reconciled"], "checked and committed after the interruption")
        self.assertEqual(os.readlink(self.link()), CLAUDE_LINK)
        self.assertEqual(load_json(self.record_path())["version"], NEW_VERSION)
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def test_reconcile_before_the_rename_changed_nothing_but_the_scope_directory(self):
        run = self.crashed_run("moving-candidate", rename=False)
        self.assertEqual(toolctl.npm_reconcile_run(self.roots, run, self.policy, uid=UID, gid=GID, platform_key="linux-x64-gnu"),
                         {"runId": RUN_ID, "state": "rolled-back"})
        self.assertEqual(run.status["error"]["id"], "INSTALL_REMOVED")
        self.assert_nothing_installed()

    def test_reconcile_never_removes_a_tree_that_is_not_this_runs(self):
        run = self.crashed_run("linked")
        shutil.move(self.package_root, os.path.join(self.base, "elsewhere"))
        materialize(claude_entries(), self.package_root)  # another tree, not the directory this run renamed there
        self.assertEqual(toolctl.npm_reconcile_run(self.roots, run, self.policy, uid=UID, gid=GID, platform_key="linux-x64-gnu"),
                         {"runId": RUN_ID, "state": "recovery-required"})
        self.assertEqual(run.status["error"]["id"], "INSTALL_REMOVE_FAILED")
        self.assertIn("Recovery is required: Re-check Claude Code in Admin > Maintenance.", run.status["error"]["message"])
        self.assertEqual(load_json(os.path.join(self.package_root, "package.json"))["version"], CLAUDE_VERSION)
        self.assertFalse(os.path.exists(toolctl.npm_fence_path(self.roots, "claude-code")))

    def test_a_stop_before_the_switch_changes_nothing(self):
        stop = toolctl.StopRequest()
        stop.signal_name = "SIGTERM"
        status = self.install(stop=stop)
        self.assertEqual((status["state"], status["error"]["id"]), ("failed", "TOOLS_RUN_STOPPED"))
        self.assert_nothing_installed()

    def test_install_takes_the_recommended_version_only_and_never_for_openclaw(self):
        self.assertEqual(toolctl.validate_request(self.request(target=None), RUN_ID, self.policy), [])
        self.assertIn("install installs the recommended version only",
                      toolctl.validate_request(self.request(target="newest"), RUN_ID, self.policy))
        self.assertTrue(toolctl.validate_request(dict(self.request(), tool="openclaw"), RUN_ID, self.policy))

    def test_a_missing_cli_names_install_qualified_or_not(self):
        tool = toolctl.NpmTool(self.roots, "claude-code", toolctl.policy_tool(self.policy, "claude-code"), self.base,
                               uid=UID, gid=GID, platform_key="linux-x64-gnu")
        for integrity, status in ((sri(b"new root bytes"), "qualified"), (None, "proposed")):
            self.qualify(integrity, status=status)
            with self.assertRaises(toolctl.NpmRefusal) as raised:
                toolctl.npm_installed(tool)
            self.assertEqual(raised.exception.message,
                             "Claude Code is not installed. Install it from its card in Admin > Maintenance.")

    def test_clawhub_gets_both_of_its_links(self):
        tool = toolctl.NpmTool(self.roots, "clawhub", toolctl.policy_tool(self.policy, "clawhub"), self.base,
                               uid=UID, gid=GID, platform_key="linux-x64-gnu")
        target, missing = toolctl.npm_install_links(tool)
        self.assertEqual(target, "../lib/node_modules/clawhub/bin/clawdhub.js")
        self.assertEqual(missing, [os.path.join(self.base, "usr/bin", name) for name in ("clawdhub", "clawhub")])
        catalog = load_json(CATALOG_PATH)["tools"]["clawhub"]["executables"]
        self.assertEqual(catalog, {"/usr/bin/" + name: target for name in ("clawdhub", "clawhub")})


class SameVersionTests(RequalifyHost):
    """An update to the installed version reinstalls it through the verified path only when the run's own
    check finds the installed tree differs from its admission record or has none; else it is already current."""

    def update(self, target="recommended"):
        self.fake_files()
        shutil.rmtree(os.path.join(self.roots.runs_dir, RUN_ID), ignore_errors=True)
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "claude-code", "action": "update", "target": target}
        return toolctl.execute_npm_run(self.roots, run, self.policy, request, uid=UID, gid=GID, platform_key="linux-x64-gnu",
                                       now=lambda: "2026-10-30T23:10:00.000Z")

    def evidence(self, status):
        return load_json(os.path.join(self.roots.runs_dir, RUN_ID, status["result"]["evidence"]))

    def assert_reinstalled(self, status, reason):
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        self.assertEqual([s["id"] for s in status["steps"]], [
            "installed", "resolve", "fetch", "verify-source", "probe-candidate", "swap", "probe-installed", "commit", "cleanup"])
        self.assertEqual((status["result"]["from"], status["result"]["to"]), (CLAUDE_VERSION, CLAUDE_VERSION))
        self.assertIn("is installed, but %s; the official release is installed again." % reason, status["steps"][0]["detail"])
        self.assertEqual(self.evidence(status)["reinstall"], reason)
        prev = os.path.join(self.roots.npm_global_root, ".bridgesllm-prev", "claude-code")
        self.assertEqual(os.listdir(prev), ["%s.%s" % (CLAUDE_VERSION, RUN_ID)], "the old tree is kept for swap-back")
        record = load_json(self.record_path())
        self.assertEqual((record["version"], record["admittedBy"]), (CLAUDE_VERSION, "run:" + RUN_ID))
        self.assertIsNone(toolctl.npm_tree_admits(record, toolctl.npm_tree_snapshot(self.package_root, uid=UID, gid=GID)))

    def test_a_tree_that_matches_its_record_is_already_current(self):
        self.recommend(CLAUDE_VERSION)
        self.admit_installed()
        status = self.update()
        self.assertEqual((status["state"], status["error"]["id"]), ("refused", "NPM_ALREADY_CURRENT"), status["error"])
        calls = [c["argv"][0] for c in self.npm_calls()] if os.path.exists(os.path.join(self.fake, "npm-calls.log")) else []
        self.assertFalse([c for c in calls if c in ("pack", "install")], "nothing is fetched or staged")

    def test_a_tree_without_a_record_is_installed_again_through_the_verified_path(self):
        self.recommend(CLAUDE_VERSION)
        self.assert_reinstalled(self.update(), "it has no admission record")

    def test_a_tree_that_differs_from_its_record_is_put_back_to_the_official_release(self):
        self.recommend(CLAUDE_VERSION)
        self.admit_installed()
        shutil.rmtree(self.package_root)
        materialize(claude_entries(wrapper="// edited locally\n"), self.package_root)
        self.assert_reinstalled(self.update(), "its files differ from the verified official release")
        with open(os.path.join(self.package_root, "cli-wrapper.cjs")) as handle:
            self.assertEqual(handle.read(), "// fixture wrapper\n")

    def test_a_record_for_another_version_or_an_invalid_one_is_not_a_match(self):
        self.recommend(CLAUDE_VERSION)
        path = self.admit_installed()
        record = load_json(path)
        other = dict(record["source"], tarball=toolctl.official_npm_tarball_url("@anthropic-ai/claude-code", "2.1.318"))
        for change, reason in (({"version": "2.1.318", "source": other}, "its admission record is for 2.1.318"),
                               ({"admittedBy": "someone"}, "its admission record is not valid")):
            with self.subTest(reason=reason):
                with open(path, "w") as handle:
                    json.dump(dict(record, **change), handle)
                self.assertEqual(toolctl.npm_reinstall_reason(self.tool(), CLAUDE_VERSION, self.snapshot()), reason)
        with open(path, "w") as handle:
            json.dump(record, handle)
        self.assertIsNone(toolctl.npm_reinstall_reason(self.tool(), CLAUDE_VERSION, self.snapshot()))

    def tool(self):
        return toolctl.NpmTool(self.roots, "claude-code", toolctl.policy_tool(self.policy, "claude-code"), self.base,
                               uid=UID, gid=GID, platform_key="linux-x64-gnu")

    def snapshot(self):
        return toolctl.npm_tree_snapshot(self.package_root, uid=UID, gid=GID)


class NextActionLoopTests(RequalifyHost):
    """Every next action a failed re-check offers is admitted when run against the same state: never refused
    as already current (or as a downgrade)."""

    def serve(self, version):
        """The fake registry serves `version` too and stages its tree."""
        root_spec = "@anthropic-ai/claude-code@" + version
        platform_spec = "@anthropic-ai/claude-code-linux-x64@" + version
        root_bytes, platform_bytes = ("root tarball bytes", "platform tarball bytes") if version == CLAUDE_VERSION else (
            "root %s" % version, "platform %s" % version)
        self.tarballs.update({root_spec: root_bytes, platform_spec: platform_bytes})
        self.meta.update({
            root_spec: {"name": "@anthropic-ai/claude-code", "version": version, "scripts": {"postinstall": "node install.cjs"},
                        "dist": {"tarball": toolctl.official_npm_tarball_url("@anthropic-ai/claude-code", version),
                                 "integrity": sri(root_bytes.encode())}},
            platform_spec: {"name": "@anthropic-ai/claude-code-linux-x64", "version": version,
                            "dist": {"tarball": toolctl.official_npm_tarball_url("@anthropic-ai/claude-code-linux-x64", version),
                                     "integrity": sri(platform_bytes.encode())}}})
        self.lock = {"": {"name": "bridgesllm-stage"},
                     "node_modules/@anthropic-ai/claude-code": {"version": version, "integrity": sri(root_bytes.encode())},
                     "node_modules/@anthropic-ai/claude-code/" + PLATFORM_DIR: {"version": version,
                                                                                "integrity": sri(platform_bytes.encode())}}
        self.staged = versioned(claude_entries(stub=True), version)

    def run_action(self, action):
        self.fake_files()
        shutil.rmtree(os.path.join(self.roots.runs_dir, RUN_ID), ignore_errors=True)
        run = toolctl.Run(self.roots, RUN_ID)
        toolctl.ensure_private_dir(run.dir)
        run.init_status("claude-code")
        request = {"schema": toolctl.SCHEMA_REQUEST, "runId": RUN_ID, "tool": "claude-code", "action": action}
        if action == "update":
            request["target"] = "recommended"
        self.assertEqual(toolctl.validate_request(request, RUN_ID, self.policy), [])
        return toolctl.execute_npm_run(self.roots, run, self.policy, request, uid=UID, gid=GID, platform_key="linux-x64-gnu",
                                       now=lambda: "2026-10-30T23:20:00.000Z")

    def test_every_offered_next_action_is_admitted(self):
        newer, older = "2.1.330", "2.1.314"
        # (state, recommended, admitted before the change) -> the refusal and the next action it offers.
        expected = {
            ("files", newer): ("NPM_TREE_DIFFERS", "update-recommended"),
            ("files", CLAUDE_VERSION): ("NPM_TREE_DIFFERS", "update-recommended"),  # same-version reinstall
            ("files", older): ("NPM_TREE_DIFFERS", "requalify"),  # an update would be a downgrade
            ("probe", newer): ("CLI_PROBE_FAILED", "update-recommended"),
            ("probe", CLAUDE_VERSION): ("CLI_PROBE_FAILED", "requalify"),  # the same bytes would come back
            ("probe", older): ("CLI_PROBE_FAILED", "requalify"),
        }
        first = True
        for (state, recommended), (code, next_action) in sorted(expected.items()):
            for admitted in (False, True):
                with self.subTest(state=state, recommended=recommended, admitted=admitted):
                    if not first:
                        RequalifyHost.setUp(self)
                    first = False
                    self.serve(CLAUDE_VERSION)
                    toolctl.policy_tool(self.policy, "claude-code")["newestProven"]["version"] = recommended
                    if admitted:
                        self.admit_installed()
                    if state == "files":
                        shutil.rmtree(self.package_root)
                        materialize(claude_entries(wrapper="// edited locally\n"), self.package_root)
                    else:
                        open(os.path.join(self.fake, "fail-installed-probe"), "w").close()
                    status = self.run_action("requalify")
                    self.assertEqual((status["state"], status["error"]["id"], status["error"]["nextAction"]),
                                     ("refused", code, next_action))
                    if next_action == "requalify" and code == "CLI_PROBE_FAILED":
                        self.assertIn("so installing it again would not change them; re-check it once the cause is fixed.",
                                      status["error"]["message"])
                    if next_action == "update-recommended":
                        self.serve(recommended)
                    after = self.run_action("update" if next_action == "update-recommended" else "requalify")
                    self.assertNotIn((after["state"], (after.get("error") or {}).get("id")),
                                     [("refused", "NPM_ALREADY_CURRENT"), ("refused", "NPM_DOWNGRADE_REFUSED")])
                    if state == "files" and next_action == "update-recommended":
                        self.assertEqual(after["state"], "succeeded", after.get("error"))
                        self.assertEqual(after["result"]["to"], recommended)


class ProbeTests(RequalifyHost):
    def with_claude(self, text):
        shutil.rmtree(self.package_root)
        installed = claude_entries()
        self.staged = claude_entries(stub=True)
        for group in (installed, self.staged):
            for entry in group:
                if entry["path"] == PLATFORM_DIR + "/claude":
                    entry["text"] = text
        materialize(installed, self.package_root)

    def test_requalify_runs_the_claude_probe_set(self):
        status = self.requalify()
        self.assertEqual(status["state"], "succeeded", status.get("error"))
        probe_step = [s for s in status["steps"] if s["id"] == "probe"][0]
        self.assertEqual(probe_step["detail"], "C-VER, C-HEADLESS, C-OUTPUT passed.")

    def test_a_missing_headless_flag_is_named(self):
        self.with_claude(fake_claude(CLAUDE_VERSION, flags=[f for f in toolctl.CLAUDE_HEADLESS_FLAGS if f != "--strict-mcp-config"]))
        status = self.requalify()
        self.assert_refused(status, "CLI_PROBE_FAILED")
        self.assertIn("C-HEADLESS", status["error"]["message"])
        self.assertIn("--strict-mcp-config", status["error"]["message"])

    def test_unframed_stream_json_output_fails_c_output(self):
        self.with_claude(fake_claude(CLAUDE_VERSION, stream='Error: not logged in'))
        status = self.requalify()
        self.assert_refused(status, "CLI_PROBE_FAILED")
        self.assertIn("C-OUTPUT", status["error"]["message"])

    def test_clawhub_help_must_list_the_portal_subcommands(self):
        tool = toolctl.NpmTool(self.roots, "clawhub", toolctl.policy_tool(self.policy, "clawhub"), self.base, uid=UID, gid=GID,
                               platform_key="linux-x64-gnu")
        cli = os.path.join(self.base, "fake-clawhub")
        for listed, state in ((("search", "inspect", "explore"), "passed"), (("search", "explore"), "failed")):
            with open(cli, "w") as handle:
                handle.write("#!/bin/sh\necho 'Usage: clawhub [options] [command]'\necho 'Commands:'\n" +
                             "".join("echo '  %s [options]'\n" % name for name in listed))
            os.chmod(cli, 0o755)
            record = toolctl.cli_probe_help(tool, cli)
            self.assertEqual(record["state"], state, record)
        self.assertEqual(record["missing"], ["inspect"])

    def test_clawhub_reports_its_version_with_its_own_flag(self):
        # ClawHub's CLI (commander) as published: `-V, --cli-version` prints the package.json version and exits 0;
        # `--version` is not a top-level option (0.23.3 "unknown option"; 0.24.1 prints help to stderr, exit 1).
        tool = toolctl.NpmTool(self.roots, "clawhub", toolctl.policy_tool(self.policy, "clawhub"), self.base, uid=UID, gid=GID,
                               platform_key="linux-x64-gnu")
        cli = os.path.join(self.base, "fake-clawhub")
        with open(cli, "w") as handle:
            handle.write("#!/bin/sh\ncase \"$1\" in\n  -V|--cli-version) echo 0.24.1 ;;\n"
                         "  --help) echo 'Commands:'; for c in explore inspect search; do echo \"  $c [options]\"; done ;;\n"
                         "  *) echo \"error: unknown option '$1'\" >&2; exit 1 ;;\nesac\n")
        os.chmod(cli, 0o755)
        record = toolctl.cli_probe_version(tool, cli, "0.24.1")
        self.assertEqual((record["state"], record["argv"], record["exitCode"]), ("passed", [cli, "--cli-version"], 0), record)
        records, failed = toolctl.cli_probe_set(tool, cli, "0.24.1")
        self.assertIsNone(failed, failed)
        self.assertEqual([(r["id"], r["state"]) for r in records][:2], [("C-VER", "passed"), ("C-HEADLESS", "passed")])
        # It still has to be this version, printed by the program itself.
        other = toolctl.cli_probe_version(tool, cli, "0.23.3")
        self.assertEqual(other["state"], "failed")
        self.assertEqual(other["reason"], "--cli-version printed '0.24.1', not 0.23.3")
        with open(cli, "w") as handle:
            handle.write("#!/bin/sh\necho \"error: unknown option '$1'\" >&2\nexit 1\n")
        broken = toolctl.cli_probe_version(tool, cli, "0.24.1")
        self.assertEqual((broken["state"], broken["exitCode"]), ("failed", 1), broken)
        # Every other CLI keeps `--version`.
        self.assertEqual(sorted(toolctl.CLI_VERSION_ARGS), ["clawhub"])

    def codex(self, script, config=None):
        """A codex tool + fake CLI; ``config`` is openclaw.json's text (None: no OpenClaw configuration)."""
        self.roots.openclaw_state_dir = os.path.join(self.base, "openclaw-state")
        os.makedirs(self.roots.openclaw_state_dir, exist_ok=True)
        config_path = os.path.join(self.roots.openclaw_state_dir, "openclaw.json")
        if config is None:
            if os.path.exists(config_path):
                os.unlink(config_path)
        else:
            with open(config_path, "w") as handle:
                handle.write(config)
        tool = toolctl.NpmTool(self.roots, "codex", toolctl.policy_tool(self.policy, "codex"), self.base, uid=UID, gid=GID,
                               platform_key="linux-x64-gnu")
        cli = os.path.join(self.base, "fake-codex", "codex")
        os.makedirs(os.path.dirname(cli), exist_ok=True)
        with open(cli, "w") as handle:
            handle.write(script)
        os.chmod(cli, 0o755)
        return tool, cli

    OVERRIDE = json.dumps({"plugins": {"entries": {"codex": {"config": {"appServer": {
        "transport": "stdio", "command": "/usr/bin/codex", "args": ["app-server", "--listen", "stdio://"]}}}}}})

    def test_codex_probes_c_app_only_while_the_override_remains(self):
        for config, app_state in ((self.OVERRIDE, "passed"), (None, "not-required"),
                                  (json.dumps({"plugins": {"entries": {"codex": {"enabled": True}}}}), "not-required"),
                                  ("{plugins: {entries: {}}} // JSON5", "passed")):
            with self.subTest(config=config):
                tool, cli = self.codex(fake_codex("0.170.0"), config)
                records, failed = toolctl.cli_probe_set(tool, cli, "0.170.0")
                self.assertIsNone(failed, failed)
                self.assertEqual([(r["id"], r["state"]) for r in records],
                                 [("C-VER", "passed"), ("C-HEADLESS", "passed"), ("C-APP", app_state)])
                app = records[2]
                self.assertEqual(app["override"], {"passed": "present" if config == self.OVERRIDE else "unknown"}.get(
                    app_state, "absent"))
                if app_state == "passed":
                    self.assertEqual(app["servedVersion"], "0.170.0")
                    with open(os.path.join(os.path.dirname(cli), "app-server-request.json")) as handle:
                        request = json.loads(handle.read())
                    self.assertEqual((request["id"], request["method"]), (1, "initialize"))
                    self.assertNotIn("jsonrpc", request)  # framed as the OpenClaw plugin frames it
                    self.assertEqual(request["params"]["clientInfo"]["name"], "bridgesllm-portal")
                self.assertIn("C-APP", toolctl._probe_summary(records))
        # Every Codex help ran in the sandbox: no network, empty HOME, cleared environment.
        with open(os.path.join(self.fake, "sandbox-calls.log")) as handle:
            calls = [json.loads(line) for line in handle if line.strip()]
        helps = [boxed(c) for c in calls if c[-1] == "--help"]
        self.assertIn([cli, "exec", "resume", "--help"], helps)
        self.assertTrue(all(sandbox_confined(c) for c in calls))

    def test_codex_help_must_list_every_flag_the_portal_passes(self):
        tool, cli = self.codex(fake_codex("0.170.0", drop=((("exec",), "--ignore-rules"), (("sandbox",), "--permission-profile"))),
                               self.OVERRIDE)
        records, failed = toolctl.cli_probe_set(tool, cli, "0.170.0")
        self.assertEqual((failed["id"], failed["state"]), ("C-HEADLESS", "failed"))
        self.assertEqual(failed["missing"], ["codex exec --ignore-rules", "codex sandbox --permission-profile"])
        self.assertEqual([r["id"] for r in records], ["C-VER", "C-HEADLESS"])  # C-APP is not reached

    def test_codex_app_server_must_answer_with_this_version(self):
        for script, reason in ((fake_codex("0.170.0", served="0.163.0"), "reports Codex 0.163.0, expected 0.170.0"),
                               (fake_codex("0.170.0", app_answer='{"id":1,"error":{"message":"not ready"}}'),
                                "didn't answer initialize: not ready"),
                               (fake_codex("0.148.0"), "OpenClaw needs at least 0.149.0")):
            with self.subTest(reason=reason):
                version = "0.148.0" if "0.149.0" in reason else "0.170.0"
                tool, cli = self.codex(script, self.OVERRIDE)
                record = toolctl.codex_probe_app(tool, cli, version)
                self.assertEqual(record["state"], "failed", record)
                self.assertIn(reason, record["reason"])
        tool, cli = self.codex("#!/bin/sh\nsleep 5\n", self.OVERRIDE)
        with mock.patch.object(toolctl, "CODEX_APP_TIMEOUT", 0.5):
            record = toolctl.codex_probe_app(tool, cli, "0.170.0")
        self.assertEqual((record["state"], record["timedOut"]), ("failed", True))
        self.assertIn("within", record["reason"])


class ProbeLockstepTests(unittest.TestCase):
    def test_claude_flags_match_the_adapter_and_project_sandbox(self):
        flags = set()
        for relative in ("backend/src/agents/providers/native/adapters/claude.ts",
                         "backend/src/agents/providers/native/projectSandbox/ClaudeCodeProjectSandbox.ts"):
            with open(os.path.join(REPO, relative)) as handle:
                flags |= set(re.findall(r"'(--[a-z][a-zA-Z-]*|-p)'", handle.read()))
        self.assertEqual(sorted(flags), sorted(toolctl.CLAUDE_HEADLESS_FLAGS))

    def test_codex_flags_match_the_adapter_and_project_sandbox(self):
        used = set()
        for relative in ("backend/src/agents/providers/native/adapters/codex.ts",
                         "backend/src/agents/providers/native/projectSandbox/CodexProjectSandbox.ts"):
            with open(os.path.join(REPO, relative)) as handle:
                used |= set(re.findall(r"'(--[a-z][a-zA-Z-]*|-[a-zA-Z])'", handle.read()))
        # Not Codex flags: docker's `--format` and node's `-e`; `--version` is C-VER.
        used -= {"--format", "-e", "--version"}
        listed = {flag for _command, flags in toolctl.CODEX_HEADLESS_FLAGS for flag in flags}
        self.assertEqual(sorted(used), sorted(listed))

    def test_clawhub_subcommands_match_the_skills_route(self):
        with open(os.path.join(REPO, "backend/src/routes/skills.ts")) as handle:
            used = set(re.findall(r"runClawHub\(\['([a-z-]+)'", handle.read()))
        self.assertEqual(sorted(used), sorted(toolctl.CLAWHUB_SUBCOMMANDS))


REAL_NODE, REAL_NPM = "/usr/bin/node", "/usr/bin/npm"


class RealNpmConfigTests(TempCase):
    """F2: the host's own npm must accept the private config flags toolctl builds.

    npm 11 refused the same file as --userconfig and --globalconfig, which failed
    every npm CLI update; the fake npm above strips these flags, so only the real
    binary can catch it. `npm config list` loads the config without the network.
    """

    def test_user_and_global_config_are_distinct_private_files(self):
        flags = dict(flag.split("=", 1) for flag in toolctl._npm_flags(self.base) if "=" in flag)
        self.assertNotEqual(flags["--userconfig"], flags["--globalconfig"])
        for flag in ("--userconfig", "--globalconfig", "--cache"):
            self.assertEqual(os.path.dirname(flags[flag]), self.base)

    @unittest.skipUnless(os.access(REAL_NODE, os.X_OK) and os.access(REAL_NPM, os.X_OK), "no real npm on this host")
    def test_real_npm_loads_the_config_toolctl_builds(self):
        values = {name: default for name, (_env, default) in toolctl.DEFAULTS.items()}
        roots = toolctl.Roots(**values)
        roots.node_bin, roots.npm_bin = REAL_NODE, REAL_NPM
        work = os.path.join(self.base, "work")
        toolctl.ensure_private_dir(work)
        tool = toolctl.NpmTool(roots, "codex", policy_tool("codex"), work, platform_key="linux-x64-gnu")
        code, out, err = tool.npm(["config", "list", "--json"], timeout=120)
        self.assertEqual(code, 0, err[-600:])
        config = json.loads(out)
        self.assertEqual((config["userconfig"], config["globalconfig"]),
                         (os.path.join(work, "npmrc"), os.path.join(work, "npmrc-global")))
        self.assertEqual((config["registry"], config["cache"]), (toolctl.NPM_REGISTRY, os.path.join(work, "cache")))
        for name in toolctl.NPM_PRIVATE_CONFIGS:
            info = os.lstat(os.path.join(work, name))
            self.assertTrue(stat.S_ISREG(info.st_mode), name)
            self.assertEqual((info.st_size, stat.S_IMODE(info.st_mode)), (0, 0o600), name)


if __name__ == "__main__":
    unittest.main()
