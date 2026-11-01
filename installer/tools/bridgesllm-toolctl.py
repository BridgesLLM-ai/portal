#!/usr/bin/env python3
"""BridgesLLM AI tools maintenance runner (updater v2, "toolctl").

Python 3 standard library only. Run it with ``python3 -I`` so nothing from the
current directory, the script directory, or PYTHON* environment variables is
imported or honoured.

Subcommands:
  status                 print a JSON snapshot of the tools state (read-only)
  preflight openclaw     run the read-only OpenClaw pre-flight checks (JSON)
  run <runId>            execute one queued run (normally started by
                         bridgesllm-tools@<runId>.service)
  reconcile              settle runs whose runner disappeared
  validate-policy        validate tool-policy.v2.json

Every filesystem root is injectable through command-line options or
environment variables so tests never touch real system paths. In production
the systemd unit passes none of them and the defaults below apply.

An OpenClaw core update runs OpenClaw's own `openclaw update` as a child of
this runner; the Portal never changes OpenClaw any other way. Portal plugins are
reconciled around it with OpenClaw's own plugin commands, and the required
Portal feature checks run through the CLI's gateway-call path; optional
feature probes are recorded as not run. Recovery runs OpenClaw's own
`openclaw update repair` (action recover-native) or only the checks
(action retry-checks).
"""

import argparse
import base64
import datetime
import errno
import fcntl
import hashlib
import json
import os
import re
import selectors
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

SCHEMA_POLICY = "bridgesllm.tools.policy.v2"
SCHEMA_REQUEST = "bridgesllm.tools.request.v1"
SCHEMA_RUN_STATUS = "bridgesllm.tools.run.v1"
SCHEMA_PREFLIGHT = "bridgesllm.tools.preflight.v1"
SCHEMA_HISTORY = "bridgesllm.tools.history.v1"
SCHEMA_LOCK_OWNER = "bridgesllm.tools.lock-owner.v1"
SCHEMA_TOOLCTL_STATUS = "bridgesllm.toolctl.status.v1"
SCHEMA_PORTAL_PLUGINS = "bridgesllm.portal-plugins.v1"

# Identifier patterns are anchored with \A/\Z and used with fullmatch: `$` also
# matches before a trailing newline, so "<uuid>\n" would pass a `^…$` match.
RUN_ID_RE = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
VERSION_RE = re.compile(r"\A(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){1,3}(-[0-9A-Za-z][0-9A-Za-z.-]*)?\Z")
TOOL_ID_RE = re.compile(r"\A[a-z][a-z0-9-]{1,31}\Z")
INTEGRITY_RE = re.compile(r"\Asha512-[A-Za-z0-9+/]{86}==\Z")
ISO_TS_RE = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})\Z")

RUN_STATES = (
    "queued", "preflight", "running", "verifying",
    "succeeded", "succeeded-degraded", "refused", "failed", "rolled-back", "recovery-required",
)
TERMINAL_STATES = frozenset(("succeeded", "succeeded-degraded", "refused", "failed", "rolled-back", "recovery-required"))
# Phases that may have changed the host, or that follow such a change. A run
# interrupted in one of them can only be settled by recovery; any other
# interrupted run changed nothing.
MUTATING_PHASES = frozenset(("node-runtime", "plugins-pre", "native", "plugins-post", "contract"))
# Wave-3 shared contract. toolctl refuses, in plain words, any (tool, action)
# pair it doesn't implement; "checks" (retry-checks) changes nothing.
RUN_ACTIONS = ("preflight", "update", "requalify", "recover-native", "retry-checks")
TARGETED_ACTIONS = ("preflight", "update")
OPENCLAW_ACTIONS = ("preflight", "update", "recover-native", "retry-checks")
RUN_TARGETS = ("recommended", "newest")
OPENCLAW_CHANNELS = ("stable", "extended-stable")
# The policy's openclaw.coreUpdates. "later-release" (5.2.0): native self-update refuses at
# activation on the Portal's gateway unit and its repair can't finish there; the
# runtime is replaced and finalized by the Portal in a later release. While it is
# set, OpenClaw preflight and update are refused before anything runs; repair and Retry checks
# only continue an OpenClaw recovery that is already open. The K7 flow stays behind the flag.
OPENCLAW_CORE_UPDATES = ("later-release",)
OPENCLAW_UPDATE_LATER_RELEASE_MESSAGE = ("Updating OpenClaw from Maintenance comes in a later Portal release. "
                                         "OpenClaw keeps working; this Portal works with OpenClaw %s and newer.")

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_REFUSED = 2
EXIT_FAILED = 3
EXIT_RECOVERY = 4
# `run` is the ExecStart of bridgesllm-tools@<runId>.service. A refusal changed
# nothing and is recorded (status.json, history), so it must not leave a failed
# unit behind in `systemctl --failed`; a failure, an open recovery or a crash
# (an uncaught exception exits 1) still fails the unit.
EXIT_BY_STATE = {
    "succeeded": EXIT_OK,
    "succeeded-degraded": EXIT_OK,
    "refused": EXIT_OK,
    "failed": EXIT_FAILED,
    "rolled-back": EXIT_FAILED,
    "recovery-required": EXIT_RECOVERY,
}

MIB = 1024 * 1024
GIB = 1024 * MIB
HISTORY_ROTATE_BYTES = 10 * MIB
HISTORY_KEEP_RUNS = 200
SNAPSHOT_FIXED_OVERHEAD = 64 * MIB
DISK_MARGIN = 2 * GIB
DEFAULT_PACKAGE_UNPACKED_BYTES = 300 * MIB
DEFAULT_PACKAGE_FILE_COUNT = 30000
INODE_MARGIN = 10000
LARGE_FILE_BYTES = 2 * GIB
STATE_WALK_MAX_ENTRIES = 200000
DIST_WALK_MAX_ENTRIES = 100000
CONFIG_MAX_BYTES = 8 * MIB
INVENTORY_MAX_BYTES = 32 * MIB
STALE_QUEUED_SECONDS = 600
DEFAULT_GATEWAY_PORT = 18789
# Read-only native command budgets (c.1, about 10-60 s typical). `update status`
# and `gateway status --deep` may consult the registry; generous but bounded.
SYSTEMCTL_TIMEOUT = 15
READYZ_TIMEOUT = 10
NATIVE_STATUS_TIMEOUT = 180
GATEWAY_STATUS_TIMEOUT = 120
NATIVE_DRY_RUN_TIMEOUT = 300
NATIVE_CONFIG_TIMEOUT = 120
# Live progress (c.2.3): `update status --json` about every 15 s while native runs.
NATIVE_PROGRESS_SECONDS = 15
NATIVE_STDOUT_LIMIT = 4 * MIB
APT_LIST_TIMEOUT = 300
PLUGIN_INSPECT_TIMEOUT = 60
PLUGIN_INSTALL_TIMEOUT = 300
# `plugins reload --wait` has no drain deadline of its own; ending the CLI
# disconnects the request, which cancels the reload before publication.
PLUGIN_RELOAD_TIMEOUT = 600
GATEWAY_RESTART_TIMEOUT = 120
# c.5: wait up to 20 min after activation for readiness to settle.
READY_WAIT_SECONDS = 1200
READY_INTERVAL_SECONDS = 10
CAPTURE_LIMIT_BYTES = 64 * 1024
# Byte ceilings for the native JSON replies toolctl parses. run_bounded marks a reply cut at its
# ceiling and the reader reports "reply exceeded N bytes" instead of parsing it. Measured:
# OpenClaw 10.9's config.get answered 337,845 B on a production-shaped state (parsed,
# sourceConfig, resolved, runtimeConfig and config copies); the 64 KiB capture cut it and
# OC-CONFIG read "no config", so a healthy gateway was stopped for a rollback.
CONFIG_GET_REPLY_LIMIT_BYTES = 16 * 1024 * 1024
# update status (24,817 B after the 55-store run), gateway status, plugins, other gateway calls.
NATIVE_REPLY_LIMIT_BYTES = 4 * 1024 * 1024
CLEAN_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
SYSTEMD_DEFAULT_PATH = CLEAN_PATH

DEFAULTS = {
    "state_root": ("BRIDGESLLM_TOOLS_STATE_ROOT", "/var/lib/bridgesllm/tools"),
    "installer_state_root": ("BRIDGESLLM_INSTALLER_STATE_ROOT", "/var/lib/bridgesllm-installer"),
    "gateway_fence_marker": ("BRIDGESLLM_GATEWAY_FENCE_MARKER", "/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1"),
    "gateway_fence_permit": ("BRIDGESLLM_GATEWAY_FENCE_PERMIT", "/run/bridgesllm/openclaw-gateway-migration-permit.v1"),
    "openclaw_hello_snapshot": ("BRIDGESLLM_OPENCLAW_HELLO_SNAPSHOT", "/var/lib/bridgesllm/openclaw-hello.v1.json"),
    "openclaw_state_dir": ("BRIDGESLLM_OPENCLAW_STATE_DIR", "/root/.openclaw"),
    "portal_operation_lock": ("BRIDGESLLM_PORTAL_OPERATION_LOCK", "/run/lock/bridgesllm-portal-installer.lock"),
    "policy_path": ("BRIDGESLLM_TOOL_POLICY", os.path.join(os.path.dirname(os.path.abspath(__file__)), "tool-policy.v2.json")),
    "systemd_unit_dirs": ("BRIDGESLLM_SYSTEMD_UNIT_DIRS",
                          "/etc/systemd/system:/run/systemd/system:/lib/systemd/system:/usr/lib/systemd/system:/root/.config/systemd/user"),
    "proc_mounts": ("BRIDGESLLM_PROC_MOUNTS", "/proc/self/mounts"),
    "proc_root": ("BRIDGESLLM_PROC_ROOT", "/proc"),
    "npm_global_root": ("BRIDGESLLM_NPM_GLOBAL_ROOT", "/usr/lib/node_modules"),
    "openclaw_bin": ("BRIDGESLLM_OPENCLAW_BIN", "/usr/bin/openclaw"),
    "systemctl_bin": ("BRIDGESLLM_SYSTEMCTL_BIN", "/usr/bin/systemctl"),
    "apt_get_bin": ("BRIDGESLLM_APT_GET_BIN", "/usr/bin/apt-get"),
    "apt_cache_bin": ("BRIDGESLLM_APT_CACHE_BIN", "/usr/bin/apt-cache"),
    "dpkg_query_bin": ("BRIDGESLLM_DPKG_QUERY_BIN", "/usr/bin/dpkg-query"),
    "apt_sources_dir": ("BRIDGESLLM_APT_SOURCES_DIR", "/etc/apt/sources.list.d"),
    "portal_plugins_dir": ("BRIDGESLLM_PORTAL_PLUGINS_DIR",
                           os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "plugins")),
}


class ToolctlError(Exception):
    """An internal or usage error: the runner could not do its job safely."""


class LockBusy(Exception):
    def __init__(self, owner=None):
        super().__init__("lock is held")
        self.owner = owner


# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------

def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def parse_ts(value):
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc).timestamp()
    except (TypeError, ValueError):
        return None


class Roots(object):
    """Every path toolctl touches. Built from args, then env, then defaults."""

    def __init__(self, **values):
        for name in DEFAULTS:
            setattr(self, name, values[name])

    @classmethod
    def resolve(cls, args=None, environ=None):
        environ = os.environ if environ is None else environ
        values = {}
        for name, (env_name, default) in DEFAULTS.items():
            value = getattr(args, name, None) if args is not None else None
            if not value:
                value = environ.get(env_name) or default
            values[name] = value
        dirs = values["systemd_unit_dirs"]
        values["systemd_unit_dirs"] = [d for d in (dirs.split(":") if isinstance(dirs, str) else dirs) if d]
        for name, value in values.items():
            paths = value if isinstance(value, list) else [value]
            for path in paths:
                if not os.path.isabs(path) or os.path.normpath(path) != path:
                    raise ToolctlError("%s must be a canonical absolute path: %r" % (name, path))
        return cls(**values)

    @property
    def runs_dir(self):
        return os.path.join(self.state_root, "runs")

    @property
    def lock_path(self):
        return os.path.join(self.state_root, "lock")

    @property
    def lock_owner_path(self):
        return os.path.join(self.state_root, "lock.owner.json")

    @property
    def history_path(self):
        return os.path.join(self.state_root, "history.jsonl")

    @property
    def tmp_dir(self):
        return os.path.join(self.state_root, "tmp")

    def run_dir(self, run_id):
        return os.path.join(self.runs_dir, run_id)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def ensure_private_dir(path):
    """Create (mode 0700) or attest a directory owned by this euid.

    A symlink, a foreign owner, or a non-directory is refused. An own
    directory with a looser mode is tightened to 0700.
    """
    try:
        os.mkdir(path, 0o700)
        fsync_dir(os.path.dirname(path))
    except FileExistsError:
        pass
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise ToolctlError("%s is not a real directory" % path)
    if info.st_uid != os.geteuid():
        raise ToolctlError("%s is not owned by the runner (uid %d)" % (path, info.st_uid))
    if stat.S_IMODE(info.st_mode) != 0o700:
        os.chmod(path, 0o700)


def atomic_write_json(path, obj, mode=0o600):
    """tmp + fsync + rename + directory fsync; the file is never torn."""
    directory = os.path.dirname(path)
    data = (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=".%s." % os.path.basename(path), suffix=".tmp", dir=directory)
    try:
        try:
            os.fchmod(fd, mode)
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(directory)


def read_json_file(path, max_bytes=4 * MIB):
    """Read a regular, non-symlinked JSON file; None if it does not exist."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ToolctlError("%s is a symlink" % path)
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ToolctlError("%s is not a regular file" % path)
        if info.st_size > max_bytes:
            raise ToolctlError("%s is larger than %d bytes" % (path, max_bytes))
        chunks = []
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        os.close(fd)
    try:
        return json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ToolctlError("%s is not valid JSON: %s" % (path, error))


def sha256_file(path):
    return file_digest(path, "sha256")


def file_digest(path, algorithm):
    digest = hashlib.new(algorithm)
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def path_present(path):
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False
    except NotADirectoryError:
        return False


def nearest_existing(path):
    current = path
    while not path_present(current):
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return current


# --------------------------------------------------------------------------
# Redaction (i.5): nothing written by toolctl may carry a secret value.
# --------------------------------------------------------------------------

SENSITIVE_KEY_RE = re.compile(r"(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|_KEY$|^KEY$|AUTHORIZATION|COOKIE)", re.I)
_REDACTIONS = (
    (re.compile(r"(?i)\b([A-Z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY)[A-Z0-9_.-]*)(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;&\"']+)"),
     r"\1\2<redacted>"),
    (re.compile(r"(?i)\b(authorization\s*:\s*)(bearer|basic|token)?\s*[^\s,;]+"), r"\1<redacted>"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer <redacted>"),
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@"), r"\1<redacted>@"),
    (re.compile(r"\bnpm_[A-Za-z0-9]{20,}\b"), "<redacted>"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "<redacted>"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "<redacted>"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), "<redacted>"),
)


def redact_text(text):
    if not isinstance(text, str):
        return text
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def redact(value, key=None):
    if key is not None and isinstance(key, str) and SENSITIVE_KEY_RE.search(key) and isinstance(value, (str, int, float)) \
            and not isinstance(value, bool):
        return "<redacted>"
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


# --------------------------------------------------------------------------
# Versions and node-semver ranges (PF-6, PF-7)
# --------------------------------------------------------------------------

def parse_version(text):
    """Parse 1-4 dotted numeric parts plus an optional prerelease.

    Returns ((major, minor, patch, build), prerelease_tuple_or_None) or None.
    """
    if not isinstance(text, str):
        return None
    text = text.strip()
    if text.startswith("v"):
        text = text[1:]
    if not VERSION_RE.fullmatch(text):
        return None
    main, _, pre = text.partition("-")
    nums = [int(p) for p in main.split(".")]
    while len(nums) < 4:
        nums.append(0)
    prerelease = None
    if pre:
        prerelease = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split("."))
    return tuple(nums), prerelease


def compare_versions(a, b):
    pa, pb = parse_version(a), parse_version(b)
    if pa is None or pb is None:
        raise ValueError("not a version: %r / %r" % (a, b))
    if pa[0] != pb[0]:
        return -1 if pa[0] < pb[0] else 1
    if pa[1] == pb[1]:
        return 0
    if pa[1] is None:
        return 1
    if pb[1] is None:
        return -1
    return -1 if pa[1] < pb[1] else 1


_PARTIAL_RE = re.compile(r"^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$")


def _partial(text):
    match = _PARTIAL_RE.match(text)
    if not match:
        raise ValueError("bad version in range: %r" % text)
    parts = []
    for group in match.groups()[:3]:
        if group is None or group in ("x", "X", "*"):
            parts.append(None)
        else:
            parts.append(int(group))
    # Anything after a wildcard is a wildcard too.
    for i in range(3):
        if parts[i] is None:
            parts[i + 1:] = [None] * (2 - i)
            break
    return parts, match.group(4)


def _fmt(parts, pre=None):
    text = ".".join(str(p) for p in parts)
    return text + ("-" + pre if pre else "")


def _expand_comparator(token):
    """Expand one node-semver comparator into a list of (op, version) pairs."""
    if token in ("*", "x", "X", ""):
        return []
    op_match = re.match(r"^(>=|<=|>|<|=|\^|~)?\s*(.+)$", token)
    op, rest = op_match.group(1) or "", op_match.group(2)
    parts, pre = _partial(rest)
    major, minor, patch = parts
    if major is None:
        return [] if op in ("", "=", ">=", "<=", "^", "~") else [("<", "0.0.0")]
    if op == "^":
        low = [major, minor or 0, patch or 0]
        if major > 0 or minor is None:
            high = [major + 1, 0, 0]
        elif minor > 0 or patch is None:
            high = [0, minor + 1, 0]
        else:
            high = [0, 0, patch + 1]
        return [(">=", _fmt(low, pre)), ("<", _fmt(high))]
    if op == "~":
        low = [major, minor or 0, patch or 0]
        high = [major + 1, 0, 0] if minor is None else [major, minor + 1, 0]
        return [(">=", _fmt(low, pre)), ("<", _fmt(high))]
    if minor is None or patch is None:
        # Partial version: an x-range.
        low = [major, minor or 0, 0]
        high = [major + 1, 0, 0] if minor is None else [major, minor + 1, 0]
        if op in ("", "="):
            return [(">=", _fmt(low)), ("<", _fmt(high))]
        if op == ">":
            return [(">=", _fmt(high))]
        if op == ">=":
            return [(">=", _fmt(low))]
        if op == "<":
            return [("<", _fmt(low))]
        if op == "<=":
            return [("<", _fmt(high))]
    return [(op or "=", _fmt(parts, pre))]


def parse_range(text):
    """Parse a node-semver range into a list of comparator sets."""
    if not isinstance(text, str) or len(text) > 256:
        raise ValueError("range must be a short string")
    sets = []
    for alternative in text.split("||"):
        alternative = alternative.strip()
        hyphen = re.match(r"^(\S+)\s+-\s+(\S+)$", alternative)
        if hyphen:
            low_parts, low_pre = _partial(hyphen.group(1))
            high_parts, high_pre = _partial(hyphen.group(2))
            comparators = [(">=", _fmt([p or 0 for p in low_parts], low_pre))]
            if high_parts[0] is not None:
                if None in high_parts:
                    comparators += _expand_comparator("<=" + _fmt([p for p in high_parts if p is not None]))
                else:
                    comparators.append(("<=", _fmt(high_parts, high_pre)))
            sets.append(comparators)
            continue
        # Join operators separated from their version by whitespace (">= 1.2").
        alternative = re.sub(r"(>=|<=|>|<|=|\^|~)\s+", r"\1", alternative)
        comparators = []
        for token in alternative.split():
            comparators.extend(_expand_comparator(token))
        sets.append(comparators)
    return sets


def satisfies(version, range_text):
    sets = parse_range(range_text)
    parsed = parse_version(version)
    if parsed is None:
        raise ValueError("not a version: %r" % version)
    for comparators in sets:
        ok = True
        for op, bound in comparators:
            cmp = compare_versions(version, bound)
            if not {"=": cmp == 0, ">": cmp > 0, ">=": cmp >= 0, "<": cmp < 0, "<=": cmp <= 0}[op]:
                ok = False
                break
        # node-semver: a prerelease only satisfies a set with a prerelease
        # comparator on the same [major, minor, patch].
        if ok and parsed[1] is not None:
            ok = any(parse_version(b)[1] is not None and parse_version(b)[0] == parsed[0] for _, b in comparators)
        if ok:
            return True
    return False


# --------------------------------------------------------------------------
# Policy (C3) and its validator
# --------------------------------------------------------------------------

POLICY_TOP_KEYS = {"schema", "policyRevision", "notes", "openclaw", "runtimes", "tools"}
TOOL_KEYS = {"id", "label", "category", "source", "floor", "floorStatus", "newestProven", "newestSelector",
             "denylist", "probes", "swapLayout", "restartsGateway"}
TOOL_CATEGORIES = ("core", "cli", "harness", "runtime")
SOURCE_KINDS = ("npm", "github-release", "github-tarball", "vendor", "container-image")
# newestProven.integrity per source kind (null while proposed). Tools whose
# bytes differ per architecture (a release file, a vendor program, Agent Zero's
# per-architecture image: the digest the helper pins for that machine, never
# the multi-arch index) record an object keyed by machine (at least one key);
# a machine without a key has not been qualified. The release gate
# (scripts/validation/tool-policy-qualified-static.py) accepts exactly the same
# forms; a lockstep test keeps the two in step.
INTEGRITY_MACHINES = ("x86_64", "aarch64")
_INTEGRITY_SHA256_RE = re.compile(r"\Asha256:[0-9a-f]{64}\Z")
_INTEGRITY_SHA512_HEX_RE = re.compile(r"\Asha512:[0-9a-f]{128}\Z")
_INTEGRITY_TREE_RE = re.compile(r"\Asha256-tree:[0-9a-f]{64}\Z")
INTEGRITY_FORMS = {  # kind -> (keyed by machine, accepted value patterns, the form in words)
    "npm": (False, (INTEGRITY_RE,), "an npm sha512 SRI string (sha512-<base64>==)"),
    "github-tarball": (False, (_INTEGRITY_TREE_RE,), "a sha256-tree:<64 hex> source-tree digest"),
    "github-release": (True, (_INTEGRITY_SHA256_RE,), "a sha256:<64 hex> digest of that machine's file"),
    "container-image": (True, (_INTEGRITY_SHA256_RE,), "a sha256:<64 hex> digest of that machine's image"),
    "vendor": (True, (_INTEGRITY_SHA256_RE, _INTEGRITY_SHA512_HEX_RE),
               "a sha256:<64 hex> or sha512:<128 hex> digest of that machine's file"),
}


def integrity_problems(kind, integrity):
    """[(path suffix, problem)] for a non-null newestProven.integrity of a
    source kind; empty means valid."""
    if kind not in INTEGRITY_FORMS:
        return [("", "cannot be checked for the unknown source kind %r" % (kind,))]
    by_machine, patterns, words = INTEGRITY_FORMS[kind]

    def form_ok(value):
        return isinstance(value, str) and any(pattern.fullmatch(value) for pattern in patterns)

    if not by_machine:
        return [] if form_ok(integrity) else [("", "must be null or %s for source kind %s" % (words, kind))]
    if not isinstance(integrity, dict):
        return [("", "must be null or an object keyed by machine (%s) for source kind %s"
                 % (", ".join(INTEGRITY_MACHINES), kind))]
    if not integrity:
        return [("", "must name at least one machine (%s)" % ", ".join(INTEGRITY_MACHINES))]
    problems = []
    for machine in sorted(integrity, key=str):
        if machine not in INTEGRITY_MACHINES:
            problems.append(("." + str(machine), "unknown machine (expected %s)" % " or ".join(INTEGRITY_MACHINES)))
        elif not form_ok(integrity[machine]):
            problems.append(("." + machine, "must be %s" % words))
    return problems


SWAP_LAYOUTS =("native-openclaw-update", "npm-global", "versioned-dir", "service-restart", "managed-container")
KNOWN_PROBES = frozenset((
    "OC-HELLO", "OC-READY", "OC-CONFIG", "OC-PLUG-ASK", "OC-QUESTION", "OC-STEER", "OC-GOALS", "OC-PROGRESS",
    "OC-CANVAS", "OC-CATALOG", "OC-BROWSER", "OC-PURGE", "OC-CODEX-PLUG",
    "C-VER", "C-HEADLESS", "C-ACP", "C-APP", "C-OUTPUT",
))
OPENCLAW_REQUIRED_PROBES = ("OC-HELLO", "OC-READY", "OC-CONFIG", "OC-PLUG-ASK")
# K7: an update rolls back only when the new version is unusable, i.e. one of these failed or wasn't
# proven. OC-PLUG-ASK failing alone leaves chat up (questions from agents are off): succeeded-degraded.
OPENCLAW_CORE_PROBES = ("OC-READY", "OC-HELLO", "OC-CONFIG")
OPENCLAW_DEGRADING_PROBES = ("OC-PLUG-ASK",)


def validate_policy(policy):
    """Return a list of "path: problem" strings; empty means valid."""
    errors = []

    def err(path, message):
        errors.append("%s: %s" % (path, message))

    def is_version(value):
        return isinstance(value, str) and parse_version(value) is not None

    if not isinstance(policy, dict):
        return ["$: policy must be an object"]
    for key in sorted(set(policy) - POLICY_TOP_KEYS):
        err("$." + key, "unknown key")
    if policy.get("schema") != SCHEMA_POLICY:
        err("$.schema", "must be %s" % SCHEMA_POLICY)
    revision = policy.get("policyRevision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        err("$.policyRevision", "must be a positive integer")
    if "notes" in policy and not isinstance(policy["notes"], str):
        err("$.notes", "must be a string")

    oc = policy.get("openclaw")
    if not isinstance(oc, dict):
        err("$.openclaw", "must be an object")
    else:
        for key in sorted(set(oc) - {"channels", "defaultChannel", "coreAutoUpdateDefault", "gatewayService", "coreUpdates"}):
            err("$.openclaw." + key, "unknown key")
        if "coreUpdates" in oc and oc["coreUpdates"] not in OPENCLAW_CORE_UPDATES:
            err("$.openclaw.coreUpdates", "must be one of %s when present" % (OPENCLAW_CORE_UPDATES,))
        channels = oc.get("channels")
        if not isinstance(channels, list) or not channels or any(c not in OPENCLAW_CHANNELS for c in channels) \
                or len(set(channels)) != len(channels):
            err("$.openclaw.channels", "must be a non-empty list of distinct values from %s" % (OPENCLAW_CHANNELS,))
        elif oc.get("defaultChannel") not in channels:
            err("$.openclaw.defaultChannel", "must be one of the channels")
        if not isinstance(oc.get("coreAutoUpdateDefault"), bool):
            err("$.openclaw.coreAutoUpdateDefault", "must be a boolean")
        service = oc.get("gatewayService")
        if not isinstance(service, str) or not re.fullmatch(r"[A-Za-z0-9@._-]+\.service", service):
            err("$.openclaw.gatewayService", "must be a systemd service name")

    runtimes = policy.get("runtimes")
    if not isinstance(runtimes, dict) or not isinstance(runtimes.get("node"), dict):
        err("$.runtimes.node", "must be an object")
    else:
        node = runtimes["node"]
        if node.get("floorRule") != "target-engines":
            err("$.runtimes.node.floorRule", "must be target-engines")
        if not isinstance(node.get("managedPath"), str) or not os.path.isabs(node.get("managedPath")):
            err("$.runtimes.node.managedPath", "must be an absolute path")
        if node.get("manager") != "nodesource-apt":
            err("$.runtimes.node.manager", "must be nodesource-apt")
        if not isinstance(node.get("label"), str) or not node.get("label"):
            err("$.runtimes.node.label", "must be a non-empty string")

    tools = policy.get("tools")
    if not isinstance(tools, list) or not tools:
        err("$.tools", "must be a non-empty list")
        return errors
    seen = set()
    for index, tool in enumerate(tools):
        base = "$.tools[%d]" % index
        if not isinstance(tool, dict):
            err(base, "must be an object")
            continue
        for key in sorted(set(tool) - TOOL_KEYS):
            err(base + "." + key, "unknown key")
        tool_id = tool.get("id")
        if not isinstance(tool_id, str) or not TOOL_ID_RE.fullmatch(tool_id):
            err(base + ".id", "must match %s" % TOOL_ID_RE.pattern)
        elif tool_id in seen:
            err(base + ".id", "duplicate id %s" % tool_id)
        else:
            seen.add(tool_id)
        if not isinstance(tool.get("label"), str) or not tool.get("label").strip():
            err(base + ".label", "must be a non-empty string")
        if tool.get("category") not in TOOL_CATEGORIES:
            err(base + ".category", "must be one of %s" % (TOOL_CATEGORIES,))
        source = tool.get("source")
        if not isinstance(source, dict) or source.get("kind") not in SOURCE_KINDS:
            err(base + ".source.kind", "must be one of %s" % (SOURCE_KINDS,))
        else:
            kind = source["kind"]
            if kind == "npm":
                if not isinstance(source.get("package"), str) or not re.fullmatch(r"(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*", source.get("package")):
                    err(base + ".source.package", "must be an npm package name")
                if source.get("provenance") not in ("required", "unavailable"):
                    err(base + ".source.provenance", "must be required or unavailable")
            elif kind in ("github-release", "github-tarball", "container-image"):
                if not isinstance(source.get("repository"), str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source.get("repository")):
                    err(base + ".source.repository", "must be owner/name")
            elif kind == "vendor":
                if not isinstance(source.get("endpoint"), str) or not source.get("endpoint").startswith("https://"):
                    err(base + ".source.endpoint", "must be an https URL")
                if source.get("checksums") not in ("published", "unavailable"):
                    err(base + ".source.checksums", "must be published or unavailable")
        floor = tool.get("floor")
        if not is_version(floor):
            err(base + ".floor", "must be a version")
        if "floorStatus" in tool and tool["floorStatus"] not in ("proposed", "qualified"):
            err(base + ".floorStatus", "must be proposed or qualified")
        proven = tool.get("newestProven")
        if not isinstance(proven, dict):
            err(base + ".newestProven", "must be an object")
        else:
            for key in sorted(set(proven) - {"version", "status", "integrity", "qualifiedAt"}):
                err(base + ".newestProven." + key, "unknown key")
            if not is_version(proven.get("version")):
                err(base + ".newestProven.version", "must be a version")
            elif is_version(floor) and compare_versions(proven["version"], floor) < 0:
                err(base + ".newestProven.version", "must not be below the floor")
            status = proven.get("status")
            if status not in ("proposed", "qualified"):
                err(base + ".newestProven.status", "must be proposed or qualified")
            integrity = proven.get("integrity")
            qualified_at = proven.get("qualifiedAt")
            kind = source.get("kind") if isinstance(source, dict) else None
            if integrity is not None and kind in SOURCE_KINDS:  # an unknown kind is already an error above
                for suffix, problem in integrity_problems(kind, integrity):
                    err(base + ".newestProven.integrity" + suffix, problem)
            if qualified_at is not None and (not isinstance(qualified_at, str) or not ISO_TS_RE.fullmatch(qualified_at)):
                err(base + ".newestProven.qualifiedAt", "must be null or an ISO-8601 timestamp")
            if status == "qualified" and (integrity is None or qualified_at is None):
                err(base + ".newestProven", "a qualified version needs integrity and qualifiedAt")
        selector = tool.get("newestSelector")
        if not isinstance(selector, dict) or not selector or not all(
                isinstance(k, str) and isinstance(v, str) and re.fullmatch(r"[a-z][a-z0-9-]*", v) for k, v in selector.items()):
            err(base + ".newestSelector", "must map channel names to dist-tag/selector names")
        denylist = tool.get("denylist")
        if not isinstance(denylist, list):
            err(base + ".denylist", "must be a list")
        else:
            for d_index, entry in enumerate(denylist):
                if not isinstance(entry, dict) or not is_version(entry.get("version")) \
                        or not isinstance(entry.get("reason"), str) or not entry.get("reason").strip():
                    err("%s.denylist[%d]" % (base, d_index), "must be {version, reason}")
                elif isinstance(proven, dict) and entry.get("version") == proven.get("version"):
                    err("%s.denylist[%d]" % (base, d_index), "denylists newestProven")
        probes = tool.get("probes")
        if not isinstance(probes, dict):
            err(base + ".probes", "must be an object")
        else:
            all_ids = []
            for group in ("required", "optional", "conditional"):
                ids = probes.get(group)
                if not isinstance(ids, list):
                    err("%s.probes.%s" % (base, group), "must be a list")
                    continue
                for probe in ids:
                    if probe not in KNOWN_PROBES:
                        err("%s.probes.%s" % (base, group), "unknown probe %r" % (probe,))
                all_ids.extend(ids)
            if len(all_ids) != len(set(all_ids)):
                err(base + ".probes", "a probe id appears twice")
            if not probes.get("required"):
                err(base + ".probes.required", "must not be empty")
            if tool_id == "openclaw":
                missing = [p for p in OPENCLAW_REQUIRED_PROBES if p not in (probes.get("required") or [])]
                if missing:
                    err(base + ".probes.required", "OpenClaw must require %s" % ", ".join(missing))
        if tool.get("swapLayout") not in SWAP_LAYOUTS:
            err(base + ".swapLayout", "must be one of %s" % (SWAP_LAYOUTS,))
        if not isinstance(tool.get("restartsGateway"), bool):
            err(base + ".restartsGateway", "must be a boolean")
        if tool_id == "openclaw":
            if tool.get("category") != "core" or tool.get("swapLayout") != "native-openclaw-update":
                err(base, "openclaw must be the core tool updated natively")
            if isinstance(selector, dict) and isinstance(oc, dict) and isinstance(oc.get("channels"), list):
                for channel in oc["channels"]:
                    if channel not in selector:
                        err(base + ".newestSelector", "missing channel %s" % channel)
        elif tool.get("restartsGateway") is True:
            err(base + ".restartsGateway", "only the OpenClaw core run may restart the gateway")
    if "openclaw" not in seen:
        err("$.tools", "must include openclaw")
    return errors


def qualified_integrity(tool, version):
    """The digest the Portal qualified for `version` on this host, or None when
    `version` is not the policy's qualified newestProven or this machine has
    no entry (then nothing is refused and provenDigestMatch stays null). An
    entry in another form than its kind's is refused, never skipped."""
    policy = tool.policy or {}
    proven = policy.get("newestProven") or {}
    if proven.get("version") != version or proven.get("status") != "qualified":
        return None
    kind, integrity = (policy.get("source") or {}).get("kind"), proven.get("integrity")
    if integrity is None or integrity_problems(kind, integrity):
        raise NpmRefusal("POLICY_INVALID", "The tool policy's qualified digest for %s is not in the form its source "
                         "uses; nothing was changed." % tool.label(version))
    if INTEGRITY_FORMS[kind][0]:
        return integrity.get(getattr(tool, "machine", None))
    return integrity


def load_policy(roots):
    """Return (policy, sha256, errors). A missing or invalid policy has errors."""
    try:
        policy = read_json_file(roots.policy_path)
    except ToolctlError as error:
        return None, None, ["$: %s" % error]
    if policy is None:
        return None, None, ["$: policy file %s is missing" % roots.policy_path]
    errors = validate_policy(policy)
    return policy, sha256_file(roots.policy_path), errors


def policy_tool(policy, tool_id):
    for tool in (policy or {}).get("tools", []):
        if isinstance(tool, dict) and tool.get("id") == tool_id:
            return tool
    return None


def policy_label(roots, tool_id):
    """The tool's label in this Portal's policy file; its id when that cannot be read."""
    try:
        policy = read_json_file(roots.policy_path)
    except (ToolctlError, OSError, ValueError):
        policy = None
    tools = policy.get("tools") if isinstance(policy, dict) else None
    label = (policy_tool(policy, tool_id) or {}).get("label") if isinstance(tools, list) else None
    return label if isinstance(label, str) and label else tool_id


def recheck_recovery_advice(label):
    """The next step a recovery-required update of a tool other than OpenClaw
    names. Maintenance offers Re-check as that recovery's own action; the
    installer never reads toolctl's runs, and its Portal-only repair changes
    no AI tool, so it cannot settle one."""
    return ("Recovery is required: Re-check %s in Admin > Maintenance. It confirms which version is installed now, "
            "and if the check fails, the card shows the next step." % label)


# The installer installs no AI tool on a server with the per-tool runner.
# Maintenance installs a missing tool only for the tools in INSTALL_TOOL_IDS,
# and only the version `update --target recommended` would install, admitted
# the same way (`install` runs).
MISSING_TOOL_NOTE = "Maintenance updates and re-checks installed tools; it cannot install a missing one in this Portal release."
# `install <tool>`: the tools whose update path also installs from nothing
# (npm CLIs: staged tree + the links a fresh install creates; Ollama: the
# installer's own fresh-install function through its toolctl entry; OpenCode
# and Hermes: the verified runtime in the managed root, the state directory
# and the launcher link their installer helpers create; Grok Build and
# Antigravity: their helper's converge, which installs only the program).
# Agent Zero needs the Owner's login and password file first, so it is not one.
INSTALL_TOOL_IDS = ("codex", "claude-code", "clawhub", "ollama", "opencode", "hermes", "grok-build", "antigravity")
INSTALL_TARGETS = (None, "recommended", "newestProven")
# The terminal state of an npm or harness run that stopped on one of these
# codes; any other refusal changed nothing ("refused").
RUN_REFUSAL_STATES = {"NPM_SWAPPED_BACK": "rolled-back", "NPM_SWAP_BACK_FAILED": "recovery-required",
                      "HARNESS_SWAPPED_BACK": "rolled-back", "HARNESS_SWAP_BACK_FAILED": "recovery-required",
                      "INSTALL_REMOVED": "rolled-back", "INSTALL_REMOVE_FAILED": "recovery-required"}


def missing_tool_note(tool_id):
    """The next step a refusal for a missing tool names: Install where
    Maintenance offers it for that tool."""
    if tool_id not in INSTALL_TOOL_IDS:
        return MISSING_TOOL_NOTE
    return "Install it from its card in Admin > Maintenance."


def install_version(tool, version_refusal):
    """The version `install` installs: the one `update --target recommended`
    would (the policy's newestProven), admitted exactly as that update admits
    it (an unqualified one is installed and recorded as verified, the way an
    update records it; the release gate keeps those out of published builds).
    Raises the flow's refusal class when it is not admissible."""
    refusal_class = HarnessRefusal if isinstance(tool, HarnessTool) else NpmRefusal
    version = (tool.policy.get("newestProven") or {}).get("version")
    refusal = version_refusal(version)
    if refusal:
        raise refusal_class("HARNESS_VERSION_NOT_ADMISSIBLE" if refusal_class is HarnessRefusal else
                            "NPM_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + ".")
    return version


# --------------------------------------------------------------------------
# Locks (a.5 L1) and the installer operation lock
# --------------------------------------------------------------------------

def boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id", "r") as handle:
            return handle.read().strip()[:64]
    except OSError:
        return None


def lock_holder(roots):
    """Return the owner record if the L1 lock is held, else None. Read-only."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(roots.lock_path, flags)
    except FileNotFoundError:
        return None
    except OSError as error:
        if error.errno == errno.ELOOP:
            return {"error": "lock path is a symlink"}
        raise
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError):
            try:
                owner = read_json_file(roots.lock_owner_path)
            except ToolctlError:
                owner = None
            return owner if isinstance(owner, dict) else {"runId": None}
        fcntl.flock(fd, fcntl.LOCK_UN)
        return None
    finally:
        os.close(fd)


class ToolsLock(object):
    """L1: one tools run at a time; owner record beside the flock file."""

    def __init__(self, roots):
        self.roots = roots
        self.fd = None
        self.run_id = None

    def acquire(self, run_id):
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        fd = os.open(self.roots.lock_path, flags, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 \
                    or stat.S_IMODE(info.st_mode) & 0o077:
                raise ToolctlError("tools lock inode is unsafe")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                try:
                    owner = read_json_file(self.roots.lock_owner_path)
                except ToolctlError:
                    owner = None
                raise LockBusy(owner)
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd
        self.run_id = run_id
        atomic_write_json(self.roots.lock_owner_path, {
            "schema": SCHEMA_LOCK_OWNER,
            "runId": run_id,
            "pid": os.getpid(),
            "bootId": boot_id(),
            "invocationId": (os.environ.get("INVOCATION_ID") or "")[:64] or None,
            "acquiredAt": utc_now(),
        })

    def release(self):
        if self.fd is None:
            return
        try:
            owner = read_json_file(self.roots.lock_owner_path)
            if isinstance(owner, dict) and owner.get("runId") == self.run_id and owner.get("pid") == os.getpid():
                os.unlink(self.roots.lock_owner_path)
                fsync_dir(self.roots.state_root)
        except (OSError, ToolctlError):
            pass
        finally:
            os.close(self.fd)
            self.fd = None


class PortalOperationLock(object):
    """The installer's exclusive operation lock (install.sh acquire_portal_operation_lock).

    Opened exactly like ``prepare_portal_operation_lock``: canonical path,
    root-owned (runner-owned) ancestors that are not writable without the
    sticky bit, a regular empty single-link file, ``flock -n`` exclusive.
    Nothing is ever written into it.
    """

    def __init__(self, path):
        self.path = path
        self.fd = None

    def _check_parents(self):
        current = os.path.sep
        for component in os.path.dirname(self.path).strip(os.path.sep).split(os.path.sep):
            if not component:
                continue
            current = os.path.join(current, component)
            info = os.lstat(current)
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ToolctlError("Portal operation lock directory boundary is unsafe")
            if info.st_uid not in (0, os.geteuid()):
                raise ToolctlError("Portal operation lock directory boundary is unsafe")
            if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
                raise ToolctlError("Portal operation lock directory is writable without sticky-bit protection")

    def acquire(self):
        self._check_parents()
        flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(self.path, flags | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            fd = os.open(self.path, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_gid != os.getegid() \
                    or info.st_nlink != 1 or info.st_size != 0 or info.st_mode & 0o022:
                raise ToolctlError("Portal operation lock inode is unsafe")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise LockBusy()
        except BaseException:
            os.close(fd)
            raise
        self.fd = fd

    def release(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def portal_operation_lock_busy(path):
    """Read-only probe of the installer operation lock; never creates it."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return False
    except OSError as error:
        if error.errno == errno.ELOOP:
            return True
        raise
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError):
            return True
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


# --------------------------------------------------------------------------
# Legacy transaction roots (PF-2, h.2)
# --------------------------------------------------------------------------

def legacy_roots(roots):
    """Every legacy ledger, fence or permit whose presence means "recover first"."""
    installer = roots.installer_state_root
    oc_state = roots.openclaw_state_dir
    return [
        ("openclaw-migration-v2", os.path.join(installer, "openclaw-2026.9.1-migration-v2")),
        ("openclaw-native-chat-v1", os.path.join(installer, "openclaw-native-chat-v1")),
        ("native-cli-bundle-v1", os.path.join(installer, "native-cli-bundle-v1")),
        ("native-cli-bundle-terminal-intent", os.path.join(installer, "native-cli-bundle-v1.terminal-intent.json")),
        ("gateway-authorization-fence", roots.gateway_fence_marker),
        ("gateway-migration-permit", roots.gateway_fence_permit),
        ("tested-pair-commit-record", os.path.join(oc_state, ".bridgesllm-tested-pair-commit-v5.json")),
        ("ask-user-transaction", os.path.join(oc_state, ".bridgesllm-ask-user-tested-pair-v1")),
    ]


def open_legacy_roots(roots):
    return [{"id": rid, "path": path} for rid, path in legacy_roots(roots) if path_present(path)]


def portal_operation_journals(roots):
    installer = roots.installer_state_root
    return [
        ("portal-update", os.path.join(installer, "active-update.json")),
        ("portal-update-cutover", os.path.join(installer, "cutover-update.json")),
        ("portal-uninstall", os.path.join(installer, "uninstall", "active-uninstall.json")),
    ]


def legacy_transactions_info(roots):
    """`/var/lib/bridgesllm-installer/transactions` is informational (UNVERIFIED relevance)."""
    path = os.path.join(roots.installer_state_root, "transactions")
    try:
        names = sorted(os.listdir(path))
    except (FileNotFoundError, NotADirectoryError):
        return {"path": path, "entries": 0}
    except PermissionError:
        return {"path": path, "entries": None}
    return {"path": path, "entries": len(names)}


# --------------------------------------------------------------------------
# Gateway service (PF-5, PF-7)
# --------------------------------------------------------------------------

def _unit_files(roots, unit_name):
    """The unit file (first directory wins) and its drop-ins merged across directories."""
    unit_path = None
    for directory in roots.systemd_unit_dirs:
        path = os.path.join(directory, unit_name)
        if os.path.isfile(path):
            unit_path = path
            break
    if unit_path is None:
        return None, []
    dropins = {}
    for directory in roots.systemd_unit_dirs:
        dropin_dir = os.path.join(directory, unit_name + ".d")
        if os.path.isdir(dropin_dir):
            for name in os.listdir(dropin_dir):
                if name.endswith(".conf") and name not in dropins and os.path.isfile(os.path.join(dropin_dir, name)):
                    dropins[name] = os.path.join(dropin_dir, name)
    return unit_path, [dropins[name] for name in sorted(dropins)]


def parse_unit_service_section(paths):
    """Return {ExecStart:[...], Environment:{...}, User, WorkingDirectory} from unit + drop-ins."""
    result = {"ExecStart": None, "Environment": {}, "User": None, "WorkingDirectory": None}
    for path in paths:
        section = None
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
        joined = []
        buffer = ""
        for line in lines:
            if line.endswith("\\"):
                buffer += line[:-1] + " "
                continue
            joined.append(buffer + line)
            buffer = ""
        for line in joined:
            stripped = line.strip()
            if not stripped or stripped.startswith(("#", ";")):
                continue
            if stripped.startswith("[") and stripped.endswith("]"):
                section = stripped[1:-1]
                continue
            if section != "Service" or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key, value = key.strip(), value.strip()
            if key == "ExecStart":
                result["ExecStart"] = None if value == "" else value
            elif key == "Environment":
                if value == "":
                    result["Environment"] = {}
                    continue
                try:
                    for assignment in shlex.split(value):
                        if "=" in assignment:
                            env_key, env_value = assignment.split("=", 1)
                            result["Environment"][env_key] = env_value
                except ValueError:
                    pass
            elif key in ("User", "WorkingDirectory"):
                result[key] = value or None
    return result


def parse_systemctl_show(text):
    """Parse `systemctl show -p Environment -p User -p WorkingDirectory -p ExecStart` output."""
    result = {"Environment": {}, "User": None, "WorkingDirectory": None, "ExecStart": None}
    for line in (text or "").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key == "Environment":
            try:
                tokens = shlex.split(value)
            except ValueError:
                tokens = value.split()
            for token in tokens:
                if "=" in token:
                    env_key, env_value = token.split("=", 1)
                    result["Environment"][env_key] = env_value
        elif key in ("User", "WorkingDirectory"):
            result[key] = value or None
        elif key == "ExecStart":
            match = re.search(r"argv\[\]=([^;]*);", value)
            result["ExecStart"] = match.group(1).strip() if match else (value or None)
    return result


def exec_start_argv0(exec_start):
    if not exec_start:
        return None
    try:
        tokens = shlex.split(exec_start)
    except ValueError:
        return None
    if not tokens:
        return None
    first = tokens[0].lstrip("@-:+!")
    return first if os.path.isabs(first) else None


def resolve_gateway_node(exec_start, unit_env):
    """Find the Node.js binary that runs the gateway, without executing anything.

    `ExecStart=/usr/bin/node …` names it directly. `ExecStart=/usr/bin/openclaw …`
    is a script; its shebang names node directly or via `/usr/bin/env node`,
    which systemd resolves on the unit's PATH.
    """
    argv0 = exec_start_argv0(exec_start)
    if not argv0:
        return None, "ExecStart has no absolute program"
    if os.path.basename(argv0) in ("node", "nodejs"):
        return argv0, "ExecStart"
    try:
        target = os.path.realpath(argv0)
        with open(target, "rb") as handle:
            first_line = handle.read(256).split(b"\n", 1)[0].decode("utf-8", "replace")
    except OSError as error:
        return None, "cannot read %s: %s" % (argv0, error.strerror)
    if not first_line.startswith("#!"):
        return None, "%s is not a script with a Node.js shebang" % argv0
    parts = first_line[2:].strip().split()
    if not parts:
        return None, "empty shebang in %s" % argv0
    if os.path.basename(parts[0]) == "env":
        names = [p for p in parts[1:] if not p.startswith("-")]
        if not names or names[0] not in ("node", "nodejs"):
            return None, "shebang of %s does not run node" % argv0
        search = unit_env.get("PATH") or SYSTEMD_DEFAULT_PATH
        for directory in search.split(":"):
            candidate = os.path.join(directory, names[0])
            if directory and os.path.isabs(directory) and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate, "shebang via PATH"
        return None, "node not found on the gateway PATH"
    if os.path.basename(parts[0]) in ("node", "nodejs"):
        return parts[0], "shebang"
    return None, "shebang of %s does not run node" % argv0


class CapturedText(str):
    """run_bounded's stdout; ``exceeded`` is the byte ceiling the reply ran past (it is cut there)."""
    exceeded = None


def reply_exceeded(out):
    """The byte ceiling a captured reply ran past, or None."""
    return getattr(out, "exceeded", None)


def run_bounded(argv, timeout=15, env=None, limit=CAPTURE_LIMIT_BYTES):
    """Run a short read-only command with a clean environment; bounded capture.

    stdout longer than ``limit`` bytes comes back cut and marked (reply_exceeded), so a
    caller never parses a cut reply as a short one."""
    clean_env = {"PATH": CLEAN_PATH, "LANG": "C.UTF-8", "NO_COLOR": "1", "HOME": "/nonexistent"}
    if env:
        clean_env.update(env)
    completed = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=timeout, env=clean_env, close_fds=True, check=False)
    out = CapturedText(completed.stdout[:limit].decode("utf-8", "replace"))
    if len(completed.stdout) > limit:
        out.exceeded = limit
    return completed.returncode, out, completed.stderr[:CAPTURE_LIMIT_BYTES].decode("utf-8", "replace")


def trusted_executable(path):
    """Only execute binaries owned by root or this runner and not group/world-writable."""
    try:
        info = os.stat(path)
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.geteuid()) and not stat.S_IMODE(info.st_mode) & 0o022 \
        and bool(info.st_mode & 0o111)


def node_version_of(path, runner=run_bounded):
    if not trusted_executable(path):
        return None, "%s is missing or not a trusted executable" % path
    try:
        code, out, _ = runner([path, "--version"])
    except (OSError, subprocess.SubprocessError) as error:
        return None, "could not run %s --version: %s" % (path, error)
    version = out.strip().splitlines()[0] if out.strip() else ""
    if code != 0 or parse_version(version) is None:
        return None, "%s --version did not print a version" % path
    return version.lstrip("v"), None


def installed_openclaw_version(roots):
    try:
        package = read_json_file(os.path.join(roots.npm_global_root, "openclaw", "package.json"), max_bytes=MIB)
    except ToolctlError:
        return None
    version = package.get("version") if isinstance(package, dict) else None
    return version if parse_version(version) else None


# --------------------------------------------------------------------------
# Target metadata (PF-6)
# --------------------------------------------------------------------------

def target_spec(policy, tool, target, channel):
    """Map a policy target to (npm spec, tag-or-None). Never free-form from a browser."""
    if target == "recommended":
        version = tool["newestProven"]["version"]
        return "%s@%s" % (tool["source"]["package"], version), version
    if target == "newest":
        selector = tool["newestSelector"].get(channel) or tool["newestSelector"].get("default")
        if not selector:
            raise ToolctlError("no newest selector for channel %s" % channel)
        return "%s@%s" % (tool["source"]["package"], selector), None
    if parse_version(target):
        return "%s@%s" % (tool["source"]["package"], target), target
    raise ToolctlError("target must be recommended, newest, or an exact version")


def npm_read_home(roots):
    """PF-6: a private HOME (and npm cache) for npm reads, under toolctl's own TMPDIR.

    run_bounded's HOME=/nonexistent made `npm view` create /nonexistent/.npm on
    real hosts and fail where it can't; npm keeps its cache and logs in HOME.
    """
    ensure_private_dir(roots.tmp_dir)
    home = os.path.join(roots.tmp_dir, "npm-home")
    ensure_private_dir(home)
    return home


def npm_read_env(home):
    return {"HOME": home, "npm_config_cache": os.path.join(home, ".npm"), "npm_config_update_notifier": "false"}


def resolve_target_metadata(spec, metadata_path=None, runner=run_bounded, home=None):
    """Registry metadata only (no download). A fixture file replaces the registry in tests.

    ``home`` is npm's HOME (npm_read_home); None only where no registry is read.
    """
    if metadata_path:
        data = read_json_file(metadata_path, max_bytes=MIB)
        source = "fixture"
    else:
        if home is None:
            raise ToolctlError("npm view needs a private HOME")
        try:
            code, out, err = runner(["npm", "view", spec, "version", "engines", "dist", "--json"], timeout=60,
                                    env=npm_read_env(home))
        except (OSError, subprocess.SubprocessError) as error:
            raise ToolctlError("npm view failed: %s" % error)
        if code != 0:
            raise ToolctlError("npm view %s failed: %s" % (spec, redact_text(err.strip())[:400]))
        try:
            data = json.loads(out)
        except ValueError:
            raise ToolctlError("npm view %s returned invalid JSON" % spec)
        source = "npm-view"
    if not isinstance(data, dict) or parse_version(data.get("version")) is None:
        raise ToolctlError("target metadata has no single exact version")
    engines = data.get("engines") if isinstance(data.get("engines"), dict) else {}
    dist = data.get("dist") if isinstance(data.get("dist"), dict) else {}
    return {
        "source": source,
        "version": data["version"],
        "enginesNode": engines.get("node") if isinstance(engines.get("node"), str) else None,
        "unpackedSize": dist.get("unpackedSize") if isinstance(dist.get("unpackedSize"), int) else None,
        "fileCount": dist.get("fileCount") if isinstance(dist.get("fileCount"), int) else None,
        "integrity": dist.get("integrity") if isinstance(dist.get("integrity"), str) else None,
    }


# --------------------------------------------------------------------------
# Native read-only commands (PF-3, PF-5, PF-11)
#
# Every native command runs as `<gateway node> <openclaw bin> ...`: exactly
# what the bin's `#!/usr/bin/env node` shebang does, but pinned to the Node.js
# that PF-7 resolved for the gateway, so the CLI never runs on another Node.
# The environment mirrors the gateway service (HOME, OPENCLAW_*), never ours.
#
# The JSON shapes read here are derived from the code that builds them, read
# statically in the 2026.10.9 dist and in an installed 2026.9.9 dist
# (the first hop on an existing host runs the installed updater, h.6). They are
# not yet recorded from a live run. Unknown shapes refuse rather than pass.
# --------------------------------------------------------------------------

# Native run reasons that leave the installation owned by native recovery.
NATIVE_RECOVERY_REASONS = frozenset((
    "update-recovery-pending", "update-activation-timeout", "state-migrated-no-rollback",
    "rollback-state-unverified", "managed-service-handoff-failed",
))
# Handoff failures that can stop a run at `requested`, before anything changed (e.g. a
# lastRun of managed-service-handoff-failed with steps requested=failed,
# installation-inspection, notice:ack and recoverySets []). Only that shape is history.
NATIVE_PRE_MUTATION_HANDOFF_REASONS = frozenset(("managed-service-handoff-failed", "managed-service-handoff-unavailable"))
# UPDATE_RUN_PHASES (update-run-vocabulary, identical in 2026.9.9 and 2026.10.9).
NATIVE_PHASES = ("requested", "staging", "validating", "repairing", "activating", "restarting", "verifying", "finished")
NATIVE_PRE_ACTIVATION_PHASES = frozenset(("requested", "staging", "validating"))
# A finished run record always carries phase "finished" (finishUpdateRunRecord);
# which phases it reached is in steps[]. Native's own post-core rule
# (update-run-activity needsPostCoreRepair) decides whether it changed the install.
NATIVE_POST_CORE_PHASES = frozenset(("activating", "restarting", "verifying"))
# A package activation receipt in these phases is settled (package-update-activation).
NATIVE_SETTLED_ACTIVATION_PHASES = frozenset(("complete", "superseded"))


def native_env(service_env, extra=None):
    """Environment for a native OpenClaw command, built from scratch."""
    service_env = service_env or {}
    env = {}
    for key in sorted(service_env):
        if MIRRORED_ENV_RE.fullmatch(key):
            env[key] = service_env[key]
    env["HOME"] = service_env.get("HOME") or "/root"
    env["PATH"] = CLEAN_PATH
    env["LANG"] = "C.UTF-8"
    env["NO_COLOR"] = "1"
    env.update(extra or {})
    return env


def native_argv(node_path, openclaw_bin, args):
    return [node_path, openclaw_bin] + list(args)


def gateway_port(exec_start, unit_env):
    """The gateway's loopback port: ExecStart `--port N`, then OPENCLAW_GATEWAY_PORT, then the default."""
    try:
        tokens = shlex.split(exec_start or "")
    except ValueError:
        tokens = []
    for index, token in enumerate(tokens):
        value = None
        if token == "--port" and index + 1 < len(tokens):
            value = tokens[index + 1]
        elif token.startswith("--port="):
            value = token.split("=", 1)[1]
        if value is not None:
            return int(value) if value.isdigit() and 0 < int(value) < 65536 else None
    value = (unit_env or {}).get("OPENCLAW_GATEWAY_PORT")
    if value is not None:
        return int(value) if value.isdigit() and 0 < int(value) < 65536 else None
    return DEFAULT_GATEWAY_PORT


def http_get_status(url, timeout=READYZ_TIMEOUT):
    """GET a loopback URL without proxies; return (status|None, problem|None)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(urllib.request.Request(url, method="GET"), timeout=timeout) as response:
            return response.status, None
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, OSError, ValueError) as error:
        return None, str(getattr(error, "reason", error))[:200]


def parse_json_output(text):
    """The JSON document a native `--json` command printed on stdout, or None."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    # Tolerate leading log lines: take the last line that starts a JSON object.
    lines = text.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        if lines[index].startswith("{"):
            try:
                return json.loads("\n".join(lines[index:]))
            except ValueError:
                continue
    return None


def tail_text(text, limit=400):
    text = redact_text((text or "").strip())
    return text[-limit:] if len(text) > limit else text


def native_notes(doc):
    """`notes` as a list of strings; entries may be strings or {message|text}."""
    notes = []
    for note in (doc or {}).get("notes") or []:
        if isinstance(note, str):
            notes.append(note)
        elif isinstance(note, dict):
            text = note.get("message") or note.get("text")
            if isinstance(text, str):
                notes.append(text)
    return notes


# --------------------------------------------------------------------------
# Disk (PF-8, PF-10)
# --------------------------------------------------------------------------

SQLITE_SUFFIXES = ("", "-wal", "-shm", "-journal")
# Files native's validation canary doesn't copy from the state dir (no *.bak in it).
CANARY_SKIPPED_SUFFIXES = (".bak",)


def sqlite_store_families(oc_state_dir):
    """Store SQLite families from the standard layout; `lstat` only, never `open`."""
    bases = [os.path.join(oc_state_dir, "state", "openclaw.sqlite")]
    agents_dir = os.path.join(oc_state_dir, "agents")
    try:
        agent_ids = sorted(os.listdir(agents_dir))
    except (FileNotFoundError, NotADirectoryError):
        agent_ids = []
    for agent_id in agent_ids:
        bases.append(os.path.join(agents_dir, agent_id, "agent", "openclaw-agent.sqlite"))
    families = []
    for base in bases:
        members = []
        for suffix in SQLITE_SUFFIXES:
            path = base + suffix
            try:
                info = os.lstat(path)
            except (FileNotFoundError, NotADirectoryError):
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            members.append({"path": path, "size": info.st_size, "nlink": info.st_nlink, "dev": info.st_dev})
        if members:
            families.append({"base": base, "members": members, "total": sum(m["size"] for m in members),
                             "dev": members[0]["dev"]})
    return families


def state_dir_informational(oc_state_dir, store_paths, max_entries=STATE_WALK_MAX_ENTRIES):
    """Other .sqlite files and >2 GiB files under the state dir (informational only)."""
    other_sqlite = {"count": 0, "bytes": 0}
    large = []
    walked = 0
    truncated = False
    for current, dirnames, filenames in os.walk(oc_state_dir, followlinks=False):
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(current, d))]
        for name in filenames:
            walked += 1
            if walked > max_entries:
                truncated = True
                break
            path = os.path.join(current, name)
            try:
                info = os.lstat(path)
            except OSError:
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            if info.st_size > LARGE_FILE_BYTES:
                large.append({"path": path, "size": info.st_size})
            if name.endswith(".sqlite") and path not in store_paths:
                other_sqlite["count"] += 1
                other_sqlite["bytes"] += info.st_size
        if truncated:
            break
    return {"otherSqlite": other_sqlite, "largeFiles": large[:50], "walkTruncated": truncated}


def read_mounts(proc_mounts):
    mounts = []
    try:
        with open(proc_mounts, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                fields = line.split()
                if len(fields) >= 3:
                    mount_point = fields[1].replace("\\040", " ")
                    mounts.append((mount_point, fields[2]))
    except OSError:
        pass
    return mounts


def mount_for(path, mounts):
    real = os.path.realpath(path)
    best = ("/", None)
    for mount_point, fstype in mounts:
        if real == mount_point or real.startswith(mount_point.rstrip("/") + "/") or mount_point == "/":
            if len(mount_point) >= len(best[0]) or best[1] is None:
                best = (mount_point, fstype)
    return best


def format_gb(value):
    return "%.1f GB" % (value / 1e9)


def disk_plan(roots, families, target_meta, statvfs=os.statvfs, extra=None):
    """PF-8 requirement per device; native rule 2T + 3L + 64 MiB plus Portal margins.

    ``extra`` is a list of (anchor path, bytes, reason) added on the anchor's volume.
    """
    by_dev = {}

    def need(path, amount, reason):
        anchor = nearest_existing(path)
        info = os.stat(anchor)
        entry = by_dev.setdefault(info.st_dev, {"path": anchor, "required": 0, "parts": []})
        entry["required"] += amount
        entry["parts"].append({"reason": reason, "bytes": amount})

    total = sum(f["total"] for f in families)
    largest = max([f["total"] for f in families] or [0])
    unpacked = (target_meta or {}).get("unpackedSize") or DEFAULT_PACKAGE_UNPACKED_BYTES
    # Activation snapshots go beside the retained package (`<package-backup>.databases`, native
    # "Recovery limits"): the npm global root's volume, not the state dir's.
    snapshot_anchor = roots.npm_global_root
    need(snapshot_anchor, 2 * total + 3 * largest + SNAPSHOT_FIXED_OVERHEAD, "native snapshots 2T + 3L + 64 MiB")
    # The validation canary copies the state dir, npm/ and extensions included (7.7 GB
    # measured vs T 4.56 GB), but none of its *.bak files. Measured: the whole dir was charged
    # 11.01 GB, the copy measured 8.4 GB with no *.bak in it (a sparse historical .bak of > 2 GiB
    # apparent size was skipped). So canary = max(T, state-dir bytes without *.bak) ≈ 8.4 GB there,
    # still apparent sizes (conservative for sparse files); never less than the store families.
    canary = max(total, state_dir_bytes(roots.openclaw_state_dir, skip_suffixes=CANARY_SKIPPED_SUFFIXES))
    need(roots.tmp_dir, canary, "canary copy of the OpenClaw state dir without *.bak (TMPDIR)")
    need(roots.npm_global_root, 2 * unpacked, "2 x package unpacked size")
    need(roots.openclaw_state_dir, DISK_MARGIN, "safety margin")
    # Updater-owned Doctor writes a full `<store>.pre-startup-migration-<op>.bak` copy beside each
    # store before migrating it and keeps it after the update (measured: agents/ 4.5 -> 8.1 GB,
    # +3.6 GB, not charged before). Charged as T_v, the store bytes on each volume (measured: one
    # volume, T 4.56 GB >= 3.6 GB). PF-8 there is then 2T+3L+64 MiB 15.08 + canary ~8.4
    # + Doctor .bak 4.56 + 2 x package 0.50 + margin 2.15 ~ 30.7 GB (was 28.74).
    doctor_backups = {}
    for family in families:
        slot = doctor_backups.setdefault(family["dev"], [os.path.dirname(family["base"]), 0])
        slot[1] += family["total"]
    for anchor, amount in doctor_backups.values():
        need(anchor, amount, "Doctor's .bak copy of each store, kept after the update")
    for anchor, amount, reason in extra or ():
        need(anchor, amount, reason)
    snapshot_dev = os.stat(nearest_existing(snapshot_anchor)).st_dev
    other = {}
    for family in families:
        if family["dev"] != snapshot_dev:
            slot = other.setdefault(family["dev"], {"total": 0, "largest": 0, "path": family["base"]})
            slot["total"] += family["total"]
            slot["largest"] = max(slot["largest"], family["total"])
    for slot in other.values():
        need(os.path.dirname(slot["path"]), slot["total"] + slot["largest"] + SNAPSHOT_FIXED_OVERHEAD,
             "source volume T_v + L_v + 64 MiB")
    file_count = (target_meta or {}).get("fileCount") or DEFAULT_PACKAGE_FILE_COUNT
    npm_dev = os.stat(nearest_existing(roots.npm_global_root)).st_dev
    volumes = []
    for dev, entry in sorted(by_dev.items()):
        fs = statvfs(entry["path"])
        # The package install (new tree + backup) is the only bulk inode consumer.
        inodes_needed = INODE_MARGIN + (2 * file_count if dev == npm_dev else 0)
        volumes.append({"path": entry["path"], "required": entry["required"], "free": fs.f_bavail * fs.f_frsize,
                        "parts": entry["parts"], "inodesFree": fs.f_favail, "inodesRequired": inodes_needed})
    return {"T": total, "L": largest, "canary": canary, "doctorBackups": sum(a for _p, a in doctor_backups.values()),
            "volumes": volumes}


def state_dir_bytes(oc_state_dir, max_entries=STATE_WALK_MAX_ENTRIES, skip_suffixes=()):
    """Regular-file bytes under the state dir (no symlinks followed), leaving out names ending in
    ``skip_suffixes``. A truncated walk counts what it saw."""
    total, walked = 0, 0
    for current, dirnames, filenames in os.walk(oc_state_dir, followlinks=False):
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(current, d))]
        for name in filenames:
            walked += 1
            if walked > max_entries:
                return total
            if skip_suffixes and name.endswith(skip_suffixes):
                continue
            try:
                info = os.lstat(os.path.join(current, name))
            except OSError:
                continue
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
    return total


def configured_agent_dirs(config, home):
    """agentDir values from `agents.entries.<id>` (current) or `agents.list[]` (older configs).

    Returns ([(agentId, absolute path)], [problems]). `~` expands to the gateway HOME.
    """
    agents = config.get("agents") if isinstance(config, dict) else None
    found, problems = [], []
    if not isinstance(agents, dict):
        return found, problems
    candidates = []
    entries = agents.get("entries")
    if isinstance(entries, dict):
        candidates.extend((str(k), v) for k, v in sorted(entries.items()))
    listed = agents.get("list")
    if isinstance(listed, list):
        candidates.extend((str((v or {}).get("id") if isinstance(v, dict) else i), v) for i, v in enumerate(listed))
    for agent_id, entry in candidates:
        agent_dir = entry.get("agentDir") if isinstance(entry, dict) else None
        if agent_dir is None:
            continue
        if not isinstance(agent_dir, str) or not agent_dir:
            problems.append({"agent": agent_id[:64], "reason": "agentDir is not a path"})
            continue
        if agent_dir == "~" or agent_dir.startswith("~/"):
            agent_dir = home.rstrip("/") + agent_dir[1:]
        if not os.path.isabs(agent_dir):
            problems.append({"agent": agent_id[:64], "reason": "agentDir %s is relative" % agent_dir[:200]})
            continue
        found.append((agent_id[:64], os.path.normpath(agent_dir)))
    return found, problems


def sqlite_family(base):
    members = []
    for suffix in SQLITE_SUFFIXES:
        path = base + suffix
        try:
            info = os.lstat(path)
        except (FileNotFoundError, NotADirectoryError):
            continue
        if stat.S_ISREG(info.st_mode):
            members.append({"path": path, "size": info.st_size, "nlink": info.st_nlink, "dev": info.st_dev})
    if not members:
        return None
    return {"base": base, "members": members, "total": sum(m["size"] for m in members), "dev": members[0]["dev"]}


def dist_override_estimate(package_dir, max_entries=DIST_WALK_MAX_ENTRIES):
    """Whether the installed OpenClaw `dist` carries local edits, and its size.

    Compares the tree with `dist/postinstall-content-inventory.json` by path and
    size; files changed after the inventory was written are hashed. Without a
    readable inventory, edits can't be ruled out (`localEdits: None`).
    """
    dist = os.path.join(package_dir, "dist")
    inventory_path = os.path.join(dist, "postinstall-content-inventory.json")
    # The stock package ships dist/postinstall-inventory.json and the content inventory doesn't
    # list it (checked in the 2026.10.9 tarball and a 2026.9.9 install): native's own
    # file, not a local edit.
    native_inventory_path = os.path.join(dist, "postinstall-inventory.json")
    result = {"distBytes": 0, "localEdits": None, "changedFiles": 0, "examples": [], "inventory": False}
    if not os.path.isdir(dist) or os.path.islink(dist):
        return result
    try:
        inventory = read_json_file(inventory_path, max_bytes=INVENTORY_MAX_BYTES)
        inventory_mtime = os.lstat(inventory_path).st_mtime
    except (ToolctlError, OSError):
        inventory = None
    expected = {}
    if isinstance(inventory, list):
        for entry in inventory:
            if isinstance(entry, dict) and isinstance(entry.get("path"), str) and entry["path"].startswith("dist/"):
                expected[entry["path"]] = entry
        result["inventory"] = bool(expected)
    seen, changed, walked = set(), [], 0
    for current, dirnames, filenames in os.walk(dist, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not os.path.islink(os.path.join(current, d)))
        for name in sorted(filenames):
            walked += 1
            if walked > max_entries:
                result["walkTruncated"] = True
                result["localEdits"] = None if not expected else (True if changed else None)
                return result
            path = os.path.join(current, name)
            if path in (inventory_path, native_inventory_path):
                continue
            try:
                info = os.lstat(path)
            except OSError:
                continue
            rel = os.path.relpath(path, package_dir)
            if stat.S_ISREG(info.st_mode):
                result["distBytes"] += info.st_size
            if not expected:
                continue
            seen.add(rel)
            entry = expected.get(rel)
            if entry is None or not stat.S_ISREG(info.st_mode) or entry.get("size") != info.st_size:
                changed.append(rel)
            elif info.st_mtime > inventory_mtime + 1:
                try:
                    if sha256_file(path) != entry.get("sha256"):
                        changed.append(rel)
                except OSError:
                    changed.append(rel)
    if expected:
        changed.extend(sorted(set(expected) - seen))
        result["localEdits"] = bool(changed)
        result["changedFiles"] = len(changed)
        result["examples"] = changed[:5]
    return result


PLUGIN_ID_RE = re.compile(r"\A[a-z][a-z0-9-]{1,63}\Z")
SHA256_RE = re.compile(r"\A[0-9a-f]{64}\Z")


def validate_plugin_manifest(manifest):
    """The release's Portal-owned OpenClaw plugin list (C9). Returns errors."""
    errors = []
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA_PORTAL_PLUGINS:
        return ["schema must be %s" % SCHEMA_PORTAL_PLUGINS]
    plugins = manifest.get("plugins")
    if not isinstance(plugins, list) or not plugins:
        return ["plugins must be a non-empty list"]
    seen = set()
    for index, plugin in enumerate(plugins):
        where = "plugins[%d]" % index
        if not isinstance(plugin, dict) or set(plugin) - {"id", "version", "archive", "sha256", "openclaw"}:
            errors.append("%s: must be {id, version, archive, sha256, openclaw}" % where)
            continue
        plugin_id, version = plugin.get("id"), plugin.get("version")
        if not isinstance(plugin_id, str) or not PLUGIN_ID_RE.fullmatch(plugin_id) or plugin_id in seen:
            errors.append("%s.id: invalid or duplicate" % where)
            continue
        seen.add(plugin_id)
        if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            errors.append("%s.version: must be an exact version" % where)
            continue
        if plugin.get("archive") != "%s-%s.tgz" % (plugin_id, version):
            errors.append("%s.archive: must be %s-%s.tgz" % (where, plugin_id, version))
        if not isinstance(plugin.get("sha256"), str) or not SHA256_RE.fullmatch(plugin["sha256"]):
            errors.append("%s.sha256: must be 64 lowercase hex digits" % where)
        try:
            parse_range(plugin.get("openclaw") if isinstance(plugin.get("openclaw"), str) else "")
        except ValueError:
            errors.append("%s.openclaw: must be a version range" % where)
    return errors


def _cgroup_units(cgroup_path):
    """systemd units named in a /proc/<pid>/cgroup file (every path component)."""
    units = []
    try:
        with open(cgroup_path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                parts = line.rstrip("\n").split(":", 2)
                if len(parts) == 3:
                    units.extend(c for c in parts[2].split("/") if c.endswith((".service", ".scope")))
    except OSError:
        pass
    return units


def external_sqlite_readers(proc_root, family_paths, gateway_unit):
    """PF-9: processes outside the gateway unit's cgroup holding store SQLite files open.

    Reads only /proc/<pid>/fd links, /proc/<pid>/cgroup and /proc/<pid>/exe;
    never opens a database.
    """
    targets = set()
    for path in family_paths:
        targets.add(path)
        targets.add(os.path.realpath(path))
    readers = []
    try:
        pids = sorted((n for n in os.listdir(proc_root) if n.isdigit()), key=int)
    except OSError:
        return readers
    for pid in pids:
        if int(pid) == os.getpid():
            continue
        fd_dir = os.path.join(proc_root, pid, "fd")
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        hits = set()
        for fd in fds:
            try:
                target = os.readlink(os.path.join(fd_dir, fd))
            except OSError:
                continue
            if target.endswith(" (deleted)"):
                target = target[:-len(" (deleted)")]
            if target in targets:
                hits.add(target)
        if not hits:
            continue
        units = _cgroup_units(os.path.join(proc_root, pid, "cgroup"))
        if gateway_unit in units:
            continue
        try:
            exe = os.readlink(os.path.join(proc_root, pid, "exe"))
        except OSError:
            exe = None
        readers.append({"pid": int(pid), "exe": exe, "unit": units[-1] if units else None, "files": sorted(hits)})
    return readers


# --------------------------------------------------------------------------
# Node.js runtime (PF-7 a, c.2.0): NodeSource apt packages only
# --------------------------------------------------------------------------

def nodesource_source_file(roots):
    for name in ("nodesource.sources", "nodesource.list"):
        path = os.path.join(roots.apt_sources_dir, name)
        if os.path.isfile(path) and not os.path.islink(path):
            return path
    return None


def nodesource_installed_version(roots, runner):
    """The installed nodejs package version if it is a NodeSource build, else (None, reason)."""
    if nodesource_source_file(roots) is None:
        return None, "no NodeSource apt source is configured"
    try:
        code, out, _err = runner([roots.dpkg_query_bin, "-W", "-f=${Version}", "nodejs"], timeout=SYSTEMCTL_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        return None, "dpkg-query failed: %s" % error
    version = out.strip()
    if code != 0 or not version:
        return None, "the nodejs package is not installed"
    if "nodesource" not in version:
        return None, "nodejs %s is not a NodeSource package" % version[:64]
    return version, None


def nodesource_candidates(madison_text):
    """[(upstream, debian version)] from `apt-cache madison nodejs`, NodeSource rows only."""
    found = []
    for line in (madison_text or "").splitlines():
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 3 or parts[0] != "nodejs" or "nodesource" not in (parts[1] + parts[2]):
            continue
        upstream = parts[1].split("-", 1)[0].split(":", 1)[-1]
        if parse_version(upstream) and re.fullmatch(r"[0-9A-Za-z.:~+-]+", parts[1]):
            found.append((upstream, parts[1]))
    return found


def choose_node_upgrade(candidates, current, engines):
    """Newest same-major NodeSource build newer than ``current`` that satisfies ``engines``."""
    major = parse_version(current)[0][0]
    best = None
    for upstream, debian in candidates:
        if parse_version(upstream)[0][0] != major or compare_versions(upstream, current) <= 0:
            continue
        try:
            if not satisfies(upstream, engines):
                continue
        except ValueError:
            continue
        if best is None or compare_versions(upstream, best[0]) > 0:
            best = (upstream, debian)
    return best


# --------------------------------------------------------------------------
# Pre-flight (c.1). Read-only. Each refusal has a stable id + plain message.
# --------------------------------------------------------------------------

class Preflight(object):
    def __init__(self, roots, policy, target="recommended", channel=None, metadata_path=None,
                 runner=run_bounded, statvfs=os.statvfs, holding_tools_lock=False, http_get=http_get_status,
                 node_update=False):
        self.roots = roots
        self.http_get = http_get
        self.node_update = node_update
        self.gateway_node = None
        self.service_env = {}
        self.policy = policy
        self.target = target
        self.channel = channel
        self.metadata_path = metadata_path
        self.runner = runner
        self.statvfs = statvfs
        self.holding_tools_lock = holding_tools_lock
        self.checks = []
        self.refusals = []
        self.facts = {}

    def check(self, check_id, state, summary, detail=None):
        self.checks.append({"id": check_id, "state": state, "summary": summary, "detail": detail})

    def refuse(self, refusal_id, check_id, message, next_action=None, detail=None):
        self.refusals.append({"id": refusal_id, "check": check_id, "message": message,
                              "nextAction": next_action, "detail": detail})
        self.check(check_id, "fail", message, detail)

    def run(self):
        tool = policy_tool(self.policy, "openclaw")
        oc = self.policy["openclaw"]
        channel = self.channel or oc["defaultChannel"]
        if channel not in oc["channels"]:
            self.refuse("PF6_CHANNEL_UNSUPPORTED", "PF-6", "OpenClaw channel %s is not offered by this Portal." % channel)
            return self.report(tool, channel)
        self.check("PF-1", "deferred", "Owner, confirmation and maintenance window are checked by the Portal before a run is queued.")
        self.check_legacy()
        self.check_concurrency()
        installed = installed_openclaw_version(self.roots)
        self.facts["installedVersion"] = installed
        exec_start, unit_env = self.check_gateway_service(oc["gatewayService"])
        self.service_env = unit_env or {}
        self.resolve_node(exec_start)
        # Native commands only run on a host with nothing else in flight: an
        # open legacy transaction or another operation must not be disturbed.
        self.check_native_status(not self.refusals)
        self.check_gateway_health(oc["gatewayService"], exec_start, not self.refusals and exec_start is not None)
        target_meta = self.check_target(tool, channel, installed)
        self.check_node(exec_start, target_meta)
        self.check_disk(target_meta)
        self.check_plugins(target_meta)
        self.check_dry_run(channel, target_meta)
        self.check("PF-12", "deferred", "The Portal requires a verified maintenance backup before queuing a run.")
        return self.report(tool, channel)

    def check_plugins(self, target_meta):
        """PF-13: the release's Portal plugin archives are present, intact and support the target."""
        manifest_path = os.path.join(self.roots.portal_plugins_dir, "manifest.json")
        try:
            manifest = read_json_file(manifest_path, max_bytes=MIB)
        except ToolctlError as error:
            self.refuse("PF13_PLUGIN_MANIFEST_INVALID", "PF-13", "This Portal version's OpenClaw plugin packages are damaged.",
                        detail={"reason": str(error)[:300]})
            return
        if manifest is None:
            self.refuse("PF13_PLUGINS_NOT_PACKAGED", "PF-13",
                        "This Portal version doesn't include its OpenClaw plugin packages, so it couldn't reconnect "
                        "its features after an OpenClaw update.", detail={"path": manifest_path})
            return
        errors = validate_plugin_manifest(manifest)
        if errors:
            self.refuse("PF13_PLUGIN_MANIFEST_INVALID", "PF-13", "This Portal version's OpenClaw plugin packages are damaged.",
                        detail={"errors": errors[:20]})
            return
        self.facts["portalPlugins"] = [{k: p[k] for k in ("id", "version", "openclaw")} for p in manifest["plugins"]]
        for plugin in manifest["plugins"]:
            archive = os.path.join(self.roots.portal_plugins_dir, plugin["archive"])
            try:
                info = os.lstat(archive)
                intact = stat.S_ISREG(info.st_mode) and sha256_file(archive) == plugin["sha256"]
            except OSError:
                intact = False
            if not intact:
                self.refuse("PF13_PLUGIN_ARCHIVE_INVALID", "PF-13",
                            "The Portal plugin %s %s is missing or damaged in this Portal version." % (plugin["id"], plugin["version"]),
                            detail={"archive": archive})
                return
        if target_meta is None:
            self.check("PF-13", "skipped", "Plugin archives are intact; the OpenClaw range needs a resolved target.")
            return
        unsupported = [p for p in manifest["plugins"] if not satisfies(target_meta["version"], p["openclaw"])]
        if unsupported:
            self.refuse("PF13_PLUGIN_UNSUPPORTED", "PF-13",
                        "This Portal version's plugins don't support OpenClaw %s yet; choose the recommended version."
                        % target_meta["version"],
                        detail={"plugins": [{"id": p["id"], "version": p["version"], "openclaw": p["openclaw"]} for p in unsupported]})
            return
        self.check("PF-13", "pass", "The Portal's OpenClaw plugins are packaged, intact and support OpenClaw %s."
                   % target_meta["version"])

    def configured_families(self, standard):
        """PF-8 extras: agent stores the config places outside the standard layout."""
        config_path = self.service_env.get("OPENCLAW_CONFIG_PATH")
        if not (isinstance(config_path, str) and os.path.isabs(config_path)):
            config_path = os.path.join(self.roots.openclaw_state_dir, "openclaw.json")
        try:
            config = read_json_file(config_path, max_bytes=CONFIG_MAX_BYTES)
        except ToolctlError as error:
            config = self.native_config_agents(config_path, str(error)[:300])
            if config is None:
                return []
        agent_dirs, problems = configured_agent_dirs(config, self.service_env.get("HOME") or "/root")
        if problems:
            self.refuse("PF8_AGENT_STORE_UNRESOLVED", "PF-8",
                        "An agent's data location in OpenClaw's configuration can't be resolved, so its database can't be measured.",
                        detail={"problems": problems[:20]})
        known = {os.path.realpath(f["base"]) for f in standard}
        extra = []
        for agent_id, agent_dir in agent_dirs:
            base = os.path.join(agent_dir, "openclaw-agent.sqlite")
            if os.path.realpath(base) in known:
                continue
            family = sqlite_family(base)
            if family is not None:
                known.add(os.path.realpath(base))
                family["configuredBy"] = agent_id
                extra.append(family)
        return extra

    def native_config_agents(self, config_path, reason):
        """PF-8 when openclaw.json isn't plain JSON (JSON5): OpenClaw reads it, `config get agents --json`.

        config-cli runConfigGet (same in 2026.9.9 and 2026.10.9) prints the value
        as JSON (secrets redacted by OpenClaw); an unset path prints the CLI
        failure envelope and exits 1. Returns {"agents": …}, {} when unset, or
        None after refusing. Like every native read it runs only on a quiet host.
        """
        unreadable = "OpenClaw's configuration couldn't be read, so the space its databases need can't be measured."
        if self.refusals:
            self.check("PF-8-config", "skipped", "OpenClaw's configuration isn't plain JSON; OpenClaw reads it only on a quiet host.")
            return None
        if not self.node_usable():
            self.refuse("PF8_CONFIG_UNREADABLE", "PF-8", unreadable, detail={"path": config_path, "reason": reason,
                                                                             "nativeRead": "the gateway's Node.js is unknown"})
            return None
        code, doc, err, problem = self.native(["config", "get", "agents", "--json"], NATIVE_CONFIG_TIMEOUT)
        if problem is None and code == 0 and isinstance(doc, dict) and doc.get("ok") is not False:
            self.facts["configRead"] = {"path": config_path, "via": "openclaw config get agents --json"}
            return {"agents": doc}
        error = doc.get("error") if isinstance(doc, dict) and doc.get("ok") is False else None
        message = (error.get("message") if isinstance(error, dict) else error) if error is not None else None
        if problem is None and code != 0 and isinstance(message, str) and "unset" in message.lower():
            self.facts["configRead"] = {"path": config_path, "via": "openclaw config get agents --json", "agents": "unset"}
            return {}
        self.refuse("PF8_CONFIG_UNREADABLE", "PF-8", unreadable,
                    detail={"path": config_path, "reason": reason,
                            "nativeRead": problem or (redact_text(message)[:300] if isinstance(message, str) else "exit code %s" % code),
                            "stderr": tail_text(err)})
        return None

    def native(self, args, timeout):
        """Run a read-only native command; (code|None, doc|None, stderr, problem|None)."""
        node_path = (self.gateway_node or {}).get("path")
        argv = native_argv(node_path, self.roots.openclaw_bin, args)
        try:
            code, out, err = self.runner(argv, timeout=timeout, env=native_env(self.service_env), limit=NATIVE_REPLY_LIMIT_BYTES)
        except subprocess.TimeoutExpired:
            return None, None, "", "did not finish within %d s" % timeout
        except (OSError, subprocess.SubprocessError) as error:
            return None, None, "", "could not be started: %s" % error
        if reply_exceeded(out):
            return code, None, err, "its reply exceeded %d bytes" % reply_exceeded(out)
        return code, parse_json_output(out), err, None

    def resolve_node(self, exec_start):
        """PF-7 part 1: which Node.js runs the gateway (refusals come from check_node)."""
        if exec_start is None:
            return
        node_path, how = resolve_gateway_node(exec_start, self.service_env)
        if node_path is None:
            self.gateway_node = {"path": None, "resolvedBy": None, "version": None, "problem": how}
            return
        version, problem = node_version_of(node_path, runner=self.runner)
        self.gateway_node = {"path": node_path, "resolvedBy": how, "version": version, "problem": problem}
        self.facts["gatewayNode"] = {"path": node_path, "resolvedBy": how, "version": version}

    def node_usable(self):
        return bool(self.gateway_node and self.gateway_node.get("path") and self.gateway_node.get("version"))

    def check_native_status(self, quiet):
        """PF-3: OpenClaw has no update or recovery of its own in progress."""
        if not quiet or not self.node_usable():
            self.check("PF-3", "skipped", "Needs a quiet host and the gateway's Node.js.")
            return
        code, doc, err, problem = self.native(["update", "status", "--json"], NATIVE_STATUS_TIMEOUT)
        if problem or code != 0 or not isinstance(doc, dict):
            reason = problem or ("exit code %s" % code if code != 0 else "no JSON status")
            self.refuse("PF3_NATIVE_STATUS_UNAVAILABLE", "PF-3",
                        "OpenClaw's own update status couldn't be read, so an update can't be started safely.",
                        detail={"reason": reason, "stderr": tail_text(err)})
            return
        self.facts["nativeStatus"] = {k: doc.get(k) for k in ("activeRun", "lastRun", "abandonedRun", "staleRun", "advisories",
                                                              "runReconciliationError", "packageActivation")
                                      if doc.get(k) is not None}
        if doc.get("runStatusError"):
            self.refuse("PF3_NATIVE_HISTORY_UNREADABLE", "PF-3",
                        "OpenClaw can't read its own update history right now, so an update can't be started safely.",
                        next_action="recover-native", detail={"reason": tail_text(str(doc.get("runStatusError")))})
            return
        active = doc.get("activeRun")
        if active is not None:
            phase = active.get("phase") if isinstance(active, dict) else None
            if doc.get("abandonedRun") or doc.get("staleRun"):
                self.refuse("PF3_NATIVE_RUN_STALE", "PF-3",
                            "OpenClaw has an unfinished update of its own (phase: %s). Run OpenClaw repair first." % (phase or "unknown"),
                            next_action="recover-native", detail={"runId": active.get("runId") if isinstance(active, dict) else None})
            else:
                self.refuse("PF3_NATIVE_RUN_ACTIVE", "PF-3",
                            "OpenClaw has its own update or recovery in progress (phase: %s)." % (phase or "unknown"),
                            detail={"runId": active.get("runId") if isinstance(active, dict) else None, "phase": phase})
            return
        activation = doc.get("packageActivation")
        if doc.get("packageActivationError") or (isinstance(activation, dict)
                                                 and activation.get("phase") not in NATIVE_SETTLED_ACTIVATION_PHASES):
            # An unsettled package activation receipt: `update repair` settles it
            # (update-repair-command settlePendingPackageActivation).
            self.refuse("PF3_NATIVE_ACTIVATION_PENDING", "PF-3",
                        "OpenClaw's last package update didn't finish activating. Run OpenClaw repair first.",
                        next_action="recover-native",
                        detail={"phase": activation.get("phase") if isinstance(activation, dict) else None,
                                "error": tail_text(str(doc.get("packageActivationError") or ""), 300) or None})
            return
        last = doc.get("lastRun")
        # lastRun is the newest non-dry-run record; with no activeRun it can't be running.
        if native_last_run_pending(doc, last):
            self.refuse("PF3_NATIVE_RECOVERY_PENDING", "PF-3",
                        "OpenClaw's last update needs recovery before another update can run.",
                        next_action="recover-native",
                        detail={"runId": last.get("runId"), "status": last.get("status"), "reason": last.get("reason"),
                                "nativeNextAction": (last.get("origin") or {}).get("nextAction")
                                if isinstance(last.get("origin"), dict) else None})
            return
        self.check("PF-3", "pass", "OpenClaw has no update or recovery of its own in progress.")

    def check_gateway_health(self, unit_name, exec_start, quiet):
        """PF-5 health: active unit, /readyz 200, deep status with a read RPC."""
        if not quiet or not self.node_usable():
            self.check("PF-5-health", "skipped", "Needs a quiet host, the gateway service and the gateway's Node.js.")
            return
        problems = []
        try:
            code, out, _err = self.runner([self.roots.systemctl_bin, "is-active", unit_name], timeout=SYSTEMCTL_TIMEOUT)
            state = (out.strip().splitlines() or [""])[0]
        except (OSError, subprocess.SubprocessError) as error:
            code, state = None, "unknown (%s)" % error
        if code != 0 or state != "active":
            problems.append({"check": "service", "reason": "the gateway service is %s" % (state or "not active")})
        port = gateway_port(exec_start, self.service_env)
        if port is None:
            problems.append({"check": "readyz", "reason": "the gateway port could not be determined"})
        else:
            status, why = self.http_get("http://127.0.0.1:%d/readyz" % port, READYZ_TIMEOUT)
            if status != 200:
                problems.append({"check": "readyz", "reason": "readiness answered %s" % status if status is not None
                                 else "readiness check failed: %s" % why})
        code, doc, err, problem = self.native(["gateway", "status", "--deep", "--require-rpc", "--json"], GATEWAY_STATUS_TIMEOUT)
        if problem or code != 0:
            problems.append({"check": "rpc", "reason": problem or "deep status exited %s" % code, "stderr": tail_text(err, 200)})
        elif isinstance(doc, dict) and isinstance(doc.get("gateway"), dict) and isinstance(doc["gateway"].get("version"), str):
            self.facts["gatewayRuntimeVersion"] = doc["gateway"]["version"]
        if problems:
            self.refuse("PF5_GATEWAY_UNHEALTHY", "PF-5-health",
                        "OpenClaw isn't healthy, so a safe rollback couldn't be guaranteed. Fix it first.",
                        next_action="openclaw-status", detail={"problems": problems})
        else:
            self.check("PF-5-health", "pass", "The OpenClaw gateway is active, ready and answering.")

    def check_dry_run(self, channel, target_meta):
        """PF-11: the native updater's own dry run for exactly this target."""
        if target_meta is None or self.refusals or not self.node_usable():
            self.check("PF-11", "skipped", "Runs only when every earlier check passed.")
            return
        if self.facts.get("nodeRuntime"):
            # The running Node.js is known to be too old for the target; native
            # would refuse now. The run repeats this check after updating Node.js.
            self.check("PF-11", "deferred", "OpenClaw's own dry run runs after the Node.js update.")
            return
        self.dry_run_gate(channel, target_meta)

    def dry_run_gate(self, channel, target_meta, tag=None):
        """PF-11 with `--no-restart` (the flag the update runs with) and the update mode (K7).

        Mode A ("live"): the dry run passes and the installed OpenClaw has the installation-replacement
        watcher; chat stays up until native reaches `activating`. Mode B ("stopped"): the dry run passes
        but the installed version predates the watcher (docs: 2026.9.5 first-hop note); the gateway is
        stopped for the whole update. A refusal is never retried with the gateway stopped: no documented
        refusal is lifted by that (2026.9.3 refuses the same way stopped), so a
        refusal ends the check before anything is stopped or changed.
        """
        tag = tag if tag is not None else (self.facts.get("target") or {}).get("tag")
        args = ["update", "--dry-run", "--json", "--no-restart", "--channel", channel] + (["--tag", tag] if tag else [])
        code, doc, err, problem = self.native(args, NATIVE_DRY_RUN_TIMEOUT)
        service_reason = doc.get("reason") if isinstance(doc, dict) and isinstance(doc.get("reason"), str) else None
        if not problem and code != 0 and service_reason in NATIVE_SERVICE_INSPECTION_REASONS:
            self.facts["dryRun"] = {"currentVersion": doc.get("currentVersion"), "targetVersion": doc.get("targetVersion"),
                                    "nativeReason": service_reason, "notes": native_notes(doc)[:20]}
            installed = self.facts.get("installedVersion") or doc.get("currentVersion")
            self.refuse("PF11_SELF_UPDATE_UNSUPPORTED", "PF-11", self_update_unsupported_message(installed),
                        detail={"nativeReason": service_reason, "stderr": tail_text(err)})
            return
        if problem or code != 0 or not isinstance(doc, dict):
            self.refuse("PF11_DRY_RUN_FAILED", "PF-11", "OpenClaw's own update check didn't complete, so the update can't start.",
                        detail={"reason": problem or ("exit code %s" % code if code != 0 else "no JSON result"),
                                "stderr": tail_text(err)})
            return
        notes = native_notes(doc)
        # `failures` (reason + message) accompanies each "Would refuse update:" note
        # (update-command-schema printUpdateDryRun, 2026.9.9 and 2026.10.9).
        failures = [f for f in doc.get("failures") or [] if isinstance(f, dict)] if isinstance(doc.get("failures"), list) else []
        self.facts["dryRun"] = {"currentVersion": doc.get("currentVersion"), "targetVersion": doc.get("targetVersion"),
                                "targetVersionReason": doc.get("targetVersionReason"), "notes": notes[:20],
                                "failures": [{"reason": str(f.get("reason"))[:100], "message": redact_text(str(f.get("message")))[:300]}
                                             for f in failures[:10]]}
        refusing = [n for n in notes if "would refuse" in n.lower()]
        if refusing or failures:
            first = refusing[0] if refusing else str(failures[0].get("message") or failures[0].get("reason"))
            self.refuse("PF11_NATIVE_WOULD_REFUSE", "PF-11", "OpenClaw would refuse this update: %s" % redact_text(first.strip())[:300],
                        detail={"notes": notes[:20], "failures": self.facts["dryRun"]["failures"]})
        elif not isinstance(doc.get("targetVersion"), str):
            self.refuse("PF11_TARGET_UNRESOLVED", "PF-11", "OpenClaw couldn't resolve the version to install%s." % (
                ": %s" % str(doc.get("targetVersionReason"))[:200] if doc.get("targetVersionReason") else ""))
        elif doc["targetVersion"] != target_meta["version"]:
            self.refuse("PF11_TARGET_MISMATCH", "PF-11", "OpenClaw would install %s, not the checked %s." % (
                doc["targetVersion"][:64], target_meta["version"]))
        else:
            self.facts["updateMode"] = update_mode_for(self.facts.get("installedVersion"))
            self.check("PF-11", "pass", "OpenClaw's own dry run accepts the update to %s." % target_meta["version"])

    def report(self, tool, channel):
        return {
            "schema": SCHEMA_PREFLIGHT,
            "tool": "openclaw",
            "generatedAt": utc_now(),
            "channel": channel,
            "target": self.target,
            "ok": not self.refusals,
            "refusals": self.refusals,
            "checks": self.checks,
            "facts": self.facts,
        }

    def check_legacy(self):
        open_roots = open_legacy_roots(self.roots)
        self.facts["legacyTransactions"] = legacy_transactions_info(self.roots)
        if open_roots:
            self.refuse("PF2_LEGACY_TRANSACTION_OPEN", "PF-2",
                        "An earlier maintenance run is unfinished. Recover it first.",
                        next_action="recover-legacy", detail={"open": open_roots})
        else:
            self.check("PF-2", "pass", "No unfinished legacy maintenance.")

    def check_concurrency(self):
        holder = None if self.holding_tools_lock else lock_holder(self.roots)
        if holder is not None:
            self.refuse("PF4_TOOLS_RUN_ACTIVE", "PF-4", "Another maintenance operation is running.",
                        detail={"runId": holder.get("runId")})
            return
        journals = [{"id": jid, "path": path} for jid, path in portal_operation_journals(self.roots) if path_present(path)]
        if journals:
            self.refuse("PF4_PORTAL_OPERATION_ACTIVE", "PF-4",
                        "A Portal update or uninstall is running or unfinished. Let it finish first.",
                        detail={"journals": journals})
            return
        for path, (marker_state, marker) in ((maintenance_marker_path(self.roots), read_maintenance_marker(self.roots)),
                                             (quiesce_marker_path(self.roots), read_quiesce_marker(self.roots))):
            if marker_state != "absent":
                self.refuse("PF4_MAINTENANCE_MARKER_PRESENT", "PF-4",
                            "OpenClaw maintenance is marked as active, so another one can't start. Let it finish first.",
                            detail={"path": path, "state": marker_state,
                                    "operationId": (marker or {}).get("operationId") if marker_state == "present" else None})
                return
        if not self.holding_tools_lock and portal_operation_lock_busy(self.roots.portal_operation_lock):
            self.refuse("PF4_PORTAL_OPERATION_ACTIVE", "PF-4",
                        "Another BridgesLLM install, update, uninstall, backup, restore, or repair operation is already running.")
            return
        self.check("PF-4", "pass", "No other maintenance operation is running.")

    def check_gateway_service(self, unit_name):
        unit_path, dropins = _unit_files(self.roots, unit_name)
        if unit_path is None:
            self.refuse("PF5_GATEWAY_SERVICE_MISSING", "PF-5",
                        "The OpenClaw gateway service is not installed here, so a safe update can't be guaranteed.")
            return None, {}
        parsed = parse_unit_service_section([unit_path] + dropins)
        self.facts["gatewayUnit"] = {"path": unit_path, "dropins": [os.path.basename(d) for d in dropins],
                                     "user": parsed["User"], "workingDirectory": parsed["WorkingDirectory"]}
        if not exec_start_argv0(parsed["ExecStart"]):
            self.refuse("PF5_GATEWAY_SERVICE_INVALID", "PF-5",
                        "The OpenClaw gateway service has no usable start command.")
            return None, parsed["Environment"]
        self.check("PF-5", "pass", "The OpenClaw gateway service is installed.")
        return parsed["ExecStart"], parsed["Environment"]

    def check_target(self, tool, channel, installed):
        if channel == "extended-stable" and self.target == "recommended":
            # --tag cannot be combined with extended-stable (b.3); its selector is the target.
            self.refuse("PF6_TARGET_CHANNEL_CONFLICT", "PF-6",
                        "The recommended version can only be installed on the stable channel. Choose \"newest\" for extended-stable.")
            return None
        try:
            spec, tag = target_spec(self.policy, tool, self.target, channel)
            meta = resolve_target_metadata(spec, self.metadata_path, runner=self.runner,
                                           home=None if self.metadata_path else npm_read_home(self.roots))
        except ToolctlError as error:
            self.refuse("PF6_TARGET_UNAVAILABLE", "PF-6", "The requested OpenClaw version is not available right now.",
                        detail={"reason": redact_text(str(error))[:400]})
            return None
        version = meta["version"]
        # Proven means the registry serves the bytes the Portal qualified: the
        # resolved version is the qualified newestProven and the registry's
        # dist.integrity is its SRI. A qualified status alone proves nothing.
        qualified = tool["newestProven"]
        compare = qualified["status"] == "qualified" and qualified["version"] == version
        expected = qualified["integrity"] if compare else None
        self.facts["target"] = dict(meta, spec=spec, tag=tag,
                                    proven=compare and isinstance(expected, str) and meta["integrity"] == expected)
        if tag is not None and version != tag:
            self.refuse("PF6_TARGET_MISMATCH", "PF-6", "The registry answered with OpenClaw %s instead of %s." % (version, tag))
            return None
        for entry in tool["denylist"]:
            if entry["version"] == version:
                self.refuse("PF6_TARGET_DENYLISTED", "PF-6", "OpenClaw %s is blocked: %s" % (version, entry["reason"]))
                return None
        if compare_versions(version, tool["floor"]) < 0:
            self.refuse("PF6_TARGET_BELOW_FLOOR", "PF-6",
                        "OpenClaw %s is older than the minimum this Portal supports (%s)." % (version, tool["floor"]))
            return None
        if installed and compare_versions(version, installed) < 0:
            self.refuse("PF6_DOWNGRADE", "PF-6",
                        "OpenClaw %s is older than the installed %s. Downgrades are not offered." % (version, installed))
            return None
        if installed and compare_versions(version, installed) == 0:
            self.refuse("PF6_ALREADY_CURRENT", "PF-6", "OpenClaw %s is already installed. Nothing to update." % version)
            return None
        if compare and not self.facts["target"]["proven"]:
            # Before any native update command (dry run included): nothing is fetched or changed.
            self.refuse("PF6_TARGET_DIGEST_MISMATCH", "PF-6",
                        "The registry's OpenClaw %s %s the package this Portal qualified, so it won't be installed. "
                        "Nothing was changed." % (version, "does not match" if meta["integrity"] else
                                                  "has no digest to compare with"),
                        detail={"expected": expected, "actual": meta["integrity"]})
            return None
        self.check("PF-6", "pass", "OpenClaw %s is available%s." % (version, "" if installed is None else " (installed: %s)" % installed))
        return meta

    def check_node(self, exec_start, target_meta):
        if exec_start is None or self.gateway_node is None:
            self.check("PF-7", "skipped", "Needs the gateway service.")
            return
        managed = self.policy["runtimes"]["node"]["managedPath"]
        node_path, version, problem = self.gateway_node["path"], self.gateway_node["version"], self.gateway_node["problem"]
        if node_path is None:
            self.refuse("PF7_NODE_UNKNOWN", "PF-7", "The Node.js runtime of the OpenClaw gateway could not be found.",
                        detail={"reason": problem})
            return
        if version is None:
            self.refuse("PF7_NODE_UNKNOWN", "PF-7", "The gateway's Node.js version could not be determined.",
                        detail={"reason": problem})
            return
        if target_meta is None:
            self.check("PF-7", "skipped", "Needs a resolved target.")
            return
        engines = target_meta.get("enginesNode")
        if not engines:
            self.check("PF-7", "pass", "OpenClaw %s declares no Node.js requirement." % target_meta["version"])
            return
        try:
            ok = satisfies(version, engines)
        except ValueError:
            self.refuse("PF7_ENGINE_UNPARSEABLE", "PF-7",
                        "OpenClaw %s declares a Node.js requirement this Portal can't read (%s)." % (target_meta["version"], engines))
            return
        if ok:
            self.check("PF-7", "pass", "Node.js %s satisfies OpenClaw %s (needs %s)." % (version, target_meta["version"], engines))
        elif node_path == managed and self.node_update:
            package, problem = nodesource_installed_version(self.roots, self.runner)
            if package is None:
                self.refuse("PF7_NODE_NOT_NODESOURCE", "PF-7",
                            "Node.js %s must be updated for OpenClaw %s (needs %s), but it isn't installed from NodeSource "
                            "packages, so the Portal can't update it." % (version, target_meta["version"], engines),
                            detail={"reason": problem})
                return
            self.facts["nodeRuntime"] = {"path": node_path, "from": version, "package": package, "needs": engines}
            self.check("PF-7", "action", "Node.js %s will be updated to satisfy OpenClaw %s (needs %s)." % (
                version, target_meta["version"], engines))
        elif node_path == managed:
            self.refuse("PF7_NODE_ENGINE", "PF-7",
                        "Node.js %s must be updated to satisfy OpenClaw %s (needs %s)." % (version, target_meta["version"], engines),
                        next_action="node-runtime")
        else:
            self.refuse("PF7_NODE_UNMANAGED", "PF-7",
                        "Node.js %s at %s doesn't satisfy OpenClaw %s (needs %s), and it isn't the system Node.js the Portal can update."
                        % (version, node_path, target_meta["version"], engines))

    def check_readers(self, families):
        unit = self.policy["openclaw"]["gatewayService"]
        members = [m["path"] for f in families for m in f["members"]]
        readers = external_sqlite_readers(self.roots.proc_root, members, unit)
        if readers:
            names = ", ".join("%s (pid %d)" % (r["unit"] or r["exe"] or "unknown process", r["pid"]) for r in readers[:5])
            self.refuse("PF9_EXTERNAL_DATABASE_READERS", "PF-9",
                        "These processes have OpenClaw databases open: %s. Stop them and retry." % names,
                        detail={"readers": readers[:20]})
        else:
            self.check("PF-9", "pass", "No process outside the OpenClaw gateway has its databases open.")

    def check_disk(self, target_meta):
        families = sqlite_store_families(self.roots.openclaw_state_dir)
        configured = self.configured_families(families)
        families = families + configured
        dist = dist_override_estimate(os.path.join(self.roots.npm_global_root, "openclaw"))
        extra = []
        if dist["localEdits"] is not False and dist["distBytes"]:
            extra.append((self.roots.npm_global_root, dist["distBytes"],
                          "dist override bundle (local edits detected)" if dist["localEdits"]
                          else "dist override bundle (local edits could not be ruled out)"))
        mounts = read_mounts(self.roots.proc_mounts)
        tmp_mount, tmp_fstype = mount_for(nearest_existing(self.roots.tmp_dir), mounts)
        if tmp_fstype in ("tmpfs", "ramfs"):
            self.refuse("PF8_TMPDIR_IN_MEMORY", "PF-8",
                        "The update work directory %s is in memory (%s); it must be on disk." % (self.roots.tmp_dir, tmp_fstype))
        linked = [m["path"] for f in families for m in f["members"] if m["nlink"] > 1]
        if linked:
            self.refuse("PF10_HARDLINKED_DATABASE", "PF-10",
                        "Database file %s has extra hard links; OpenClaw cannot safely restore it." % os.path.basename(linked[0]),
                        detail={"files": linked})
        else:
            self.check("PF-10", "pass", "No database file has extra hard links.")
        self.check_readers(families)
        plan = disk_plan(self.roots, families, target_meta, statvfs=self.statvfs, extra=extra)
        store_paths = {m["path"] for f in families for m in f["members"]}
        info = state_dir_informational(self.roots.openclaw_state_dir, store_paths) \
            if os.path.isdir(self.roots.openclaw_state_dir) else {"otherSqlite": {"count": 0, "bytes": 0}, "largeFiles": [], "walkTruncated": False}
        self.facts["disk"] = {"T": plan["T"], "L": plan["L"], "canary": plan["canary"],
                              "doctorBackups": plan["doctorBackups"], "families": len(families),
                              "volumes": plan["volumes"],
                              "informational": info, "distOverride": dist,
                              "configuredStores": [{"agent": f["configuredBy"], "base": f["base"]} for f in configured]}
        short = False
        for volume in plan["volumes"]:
            mount_point, _ = mount_for(volume["path"], mounts)
            if volume["free"] < volume["required"]:
                short = True
                self.refuse("PF8_DISK_SPACE", "PF-8", "Needs %s free on %s, has %s." % (
                    format_gb(volume["required"]), mount_point, format_gb(volume["free"])),
                    detail={"parts": volume["parts"]})
            if volume["inodesFree"] < volume["inodesRequired"]:
                short = True
                self.refuse("PF8_INODES", "PF-8", "Needs %d free inodes on %s, has %d." % (
                    volume["inodesRequired"], mount_point, volume["inodesFree"]))
        if not short and tmp_fstype not in ("tmpfs", "ramfs") and not any(r["check"] == "PF-8" for r in self.refusals):
            self.check("PF-8", "pass", "Enough free disk for snapshots, the canary copy and the package.")


# --------------------------------------------------------------------------
# Gateway unit control (K7 revision of c.2)
#
# The Portal's systemd system unit is the gateway's owner (OpenClaw: its "service or
# foreground process owner"). `openclaw update --no-restart` replaces the package and
# runs native's updater-owned Doctor but never stops or restarts the gateway, so
# toolctl does, at fixed points (how-updates-run.md "When restart is skipped or
# fails", the 2026.9.5 first-hop note, and "If the package was already replaced and
# Doctor failed on the live Gateway lock"):
#   mode A: stop when native's run reaches `activating` (before the package swap);
#   mode B: stop before native starts;
#   after native (and any `update repair --yes --no-restart --json`) has exited: start,
#   wait for readiness, run the contract probes; on failure, native's managed rollback
#   (`openclaw update --tag <previous>`, install/updating/rollback-and-recovery.md
#   "Downgrade") with --no-restart, then start again. RestartPreventExitStatus=78 stays.
# --------------------------------------------------------------------------

# The unit's cooperative-shutdown drop-in sets TimeoutStopSec=330; a stop waits past it.
GATEWAY_STOP_TIMEOUT = 420
GATEWAY_START_TIMEOUT = 120
GATEWAY_RUNNING_STATES = frozenset(("active", "activating", "reloading"))
GATEWAY_STOPPED_STATES = frozenset(("inactive", "failed"))
# While the gateway is parked for activation, `update status` is polled gently (each
# poll spawns a CLI and SQLite readers) and not at all while the package is absent.
NATIVE_ACTIVATING_POLL_SECONDS = 60
# First installed version with the installation-replacement watcher: "Published 2026.9.5
# Gateways do not have an installation-replacement watcher ... stop the Gateway through its
# foreground process owner and wait for it to exit, run `openclaw update`, then launch the
# Gateway again" (how-updates-run.md, ≈ line 1097).
MODE_A_MIN_INSTALLED = "2026.9.6"
# Dry-run refusals raised by native's own service inspection, not by the target: published 2026.9.3
# answers `managed-service-preflight` ("Gateway service inspection is unavailable … managed service
# ownership cannot be verified") under the Portal's unit, running or stopped, with or without the root
# user fence drop-in. Its docs: the update "refuses to mutate … including with
# `--no-restart`" (cli/update.md), and "OpenClaw self-update is refused so the supervisor can stop the
# Gateway, replace and finalize the runtime" (cli/gateway.md, External supervisors). This Portal has no
# supervisor-side replacement, so such a version can't be updated from Maintenance (5.2.0).
NATIVE_SERVICE_INSPECTION_REASONS = frozenset(("managed-service-preflight",))


def self_update_unsupported_message(installed):
    """The one plain refusal for an OpenClaw that can't update itself under the Portal's unit."""
    return ("OpenClaw %s cannot update itself while the Portal runs it; it keeps working with this Portal; updating "
            "it from Maintenance needs a later Portal release." % (installed if isinstance(installed, str) and installed
                                                                 else "(installed version)"))
UPDATE_MODE_LIVE = "live"        # mode A: chat stays up until activation
UPDATE_MODE_STOPPED = "stopped"  # mode B: chat is down for the whole update


def update_mode_for(installed):
    """The update mode once native's dry run accepted the target (unknown version: mode B, fail closed)."""
    if installed and parse_version(installed) and compare_versions(installed, MODE_A_MIN_INSTALLED) >= 0:
        return {"mode": UPDATE_MODE_LIVE, "reason": "replacement-watcher"}
    return {"mode": UPDATE_MODE_STOPPED, "reason": "no-replacement-watcher", "installed": installed}


class GatewayUnit(object):
    """Stop/start of the gateway's systemd unit; every action is recorded in status["gateway"]. Never raises."""

    def __init__(self, roots, run, unit, runner):
        self.roots = roots
        self.run = run
        self.unit = unit
        self.runner = runner
        self.stopped_by_us = False
        self.was_running = None  # the unit's state before toolctl first stopped it

    def systemctl(self, verb, timeout):
        try:
            return self.runner([self.roots.systemctl_bin, verb, self.unit], timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, "", "did not finish within %d s" % timeout
        except (OSError, subprocess.SubprocessError) as error:
            return None, "", str(error)

    def state(self):
        code, out, _err = self.systemctl("is-active", SYSTEMCTL_TIMEOUT)
        lines = (out or "").strip().splitlines()
        return lines[0].strip()[:40] if code is not None and lines else "unknown"

    def record(self, action, code, state, problem=None):
        doc = self.run.status.setdefault("gateway", {"unit": self.unit, "actions": []})
        doc["actions"] = (doc.get("actions") or [])[-19:] + [
            {"action": action, "at": utc_now(), "exitCode": code, "state": state, "problem": problem}]
        doc["stoppedByToolctl"] = self.stopped_by_us
        self.run.save()

    def stop(self):
        """Cooperative stop through the unit, waiting for it to exit. Returns None or a problem string."""
        before = self.state()
        if self.was_running is None:
            self.was_running = before in GATEWAY_RUNNING_STATES
        code, _out, err = self.systemctl("stop", GATEWAY_STOP_TIMEOUT)
        state = self.state()
        if state in GATEWAY_STOPPED_STATES:
            self.stopped_by_us = True  # from here toolctl owns starting it again (or recording why not)
            self.record("stop", code, state)
            return None
        problem = "the OpenClaw gateway didn't stop (it is %s%s)" % (state, "; %s" % tail_text(err, 200) if err else "")
        self.record("stop", code, state, problem)
        return problem

    def start(self):
        """Start through the unit (after reset-failed: a refused start leaves the unit failed). None or a problem."""
        self.systemctl("reset-failed", SYSTEMCTL_TIMEOUT)
        code, _out, err = self.systemctl("start", GATEWAY_START_TIMEOUT)
        state = self.state()
        if code == 0 and state in GATEWAY_RUNNING_STATES:
            self.stopped_by_us = False
            self.record("start", code, state)
            return None
        problem = "the OpenClaw gateway didn't start (it is %s%s)" % (state, "; %s" % tail_text(err, 200) if err else "")
        self.record("start", code, state, problem)
        return problem

    def dead(self):
        """None while the unit runs; why not once it stopped or failed (a readiness wait ends early)."""
        state = self.state()
        return None if state in GATEWAY_RUNNING_STATES else "the OpenClaw gateway exited (it is %s)" % state


# --------------------------------------------------------------------------
# Native update command builder (c.2.2)
# --------------------------------------------------------------------------

FORBIDDEN_NATIVE_FLAGS = ("--timeout", "--accept-capabilities")
MIRRORED_ENV_RE = re.compile(r"\AOPENCLAW_[A-Z0-9_]+\Z")


def build_native_update_command(channel, tag, service_env, run_id, roots, openclaw_bin=None, node_path=None):
    """Return (argv, env) for `openclaw update` per DESIGN c.2.2 (K7 revision).

    - `--yes --json --no-restart`; never `--timeout`, `--accept-capabilities`. The Portal's
      system unit owns the gateway: native replaces the package and runs its Doctor, but
      never stops or restarts the gateway (how-updates-run.md "When restart is skipped or
      fails"); toolctl stops and starts the unit itself (GatewayUnit).
    - `--tag` only with the stable channel (it can't be combined with extended-stable).
    - With ``node_path`` the bin runs on that Node.js (see native_argv); without
      it the bin's own shebang picks Node.js from PATH.
    - The environment is built from scratch: HOME and OPENCLAW_* mirrored from the
      gateway service, NPM_CONFIG_PREFIX=/usr, TMPDIR under the run's tools tmp,
      NO_COLOR=1, and a clean PATH that includes the sbin directories.
    """
    if channel not in OPENCLAW_CHANNELS:
        raise ToolctlError("unsupported channel %r" % (channel,))
    if not RUN_ID_RE.fullmatch(run_id or ""):
        raise ToolctlError("invalid run id")
    if tag is not None:
        if channel != "stable":
            raise ToolctlError("--tag cannot be combined with the %s channel" % channel)
        # parse_version() tolerates a leading "v" and surrounding whitespace; an argv value may not.
        if not isinstance(tag, str) or not VERSION_RE.fullmatch(tag):
            raise ToolctlError("tag must be an exact version")
    args = ["update", "--channel", channel]
    if tag is not None:
        args += ["--tag", tag]
    args += ["--yes", "--json", "--no-restart"]
    openclaw_bin = openclaw_bin or roots.openclaw_bin
    argv = native_argv(node_path, openclaw_bin, args) if node_path else [openclaw_bin] + args
    env = native_env(service_env, {"NPM_CONFIG_PREFIX": "/usr", "TMPDIR": os.path.join(roots.tmp_dir, run_id)})
    assert not any(flag in argv for flag in FORBIDDEN_NATIVE_FLAGS)
    return argv, env


# --------------------------------------------------------------------------
# Stop requests (SIGTERM) and supervised children
#
# The run unit uses KillMode=control-group, KillSignal=SIGTERM, SendSIGKILL=no
# and TimeoutStopSec=3600: a stop reaches toolctl and every child, and nothing
# is ever escalated to SIGKILL. The handler only records the request and
# forwards SIGTERM once to a supervised child (covering a stop that targets
# toolctl alone). It never raises: an exception inside subprocess.run would
# SIGKILL the child, which OpenClaw's updater can't restore from.
# --------------------------------------------------------------------------

STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
SUPERVISE_POLL_SECONDS = 1.0


class StopRequest(object):
    def __init__(self):
        self.signal_name = None
        self.requested_at = None
        self.child = None
        self.forwarded = False
        self._previous = {}

    def __bool__(self):
        return self.signal_name is not None

    def handle(self, signum, _frame):
        if self.signal_name is None:
            try:
                self.signal_name = signal.Signals(signum).name
            except ValueError:
                self.signal_name = "signal %d" % signum
            self.requested_at = utc_now()
        self.forward()

    def forward(self):
        child = self.child
        if child is None or self.forwarded or child.returncode is not None:
            return
        self.forwarded = True
        try:
            child.send_signal(signal.SIGTERM)
        except OSError:
            pass

    def install(self):
        for sig in STOP_SIGNALS:
            self._previous[sig] = signal.signal(sig, self.handle)

    def restore(self):
        for sig, previous in self._previous.items():
            signal.signal(sig, previous)
        self._previous = {}

    def record(self):
        return {"signal": self.signal_name, "at": self.requested_at, "forwardedToChild": self.forwarded}


def supervise_child(argv, env, stdout_path, stderr_path, stop, on_tick=None, poll_seconds=SUPERVISE_POLL_SECONDS,
                    cwd="/", forward_stop=True):
    """Run one long child to completion; it is never killed from here.

    stdout and stderr go straight to files (no pipes to fill). ``on_tick`` is
    called about every ``poll_seconds`` while the child runs (progress and the
    stop record). A stop forwards SIGTERM once and keeps waiting.
    Returns (exit code, pid).
    """
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    out_fd = os.open(stdout_path, flags, 0o600)
    try:
        err_fd = os.open(stderr_path, flags, 0o600)
    except BaseException:
        os.close(out_fd)
        raise
    try:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out_fd, stderr=err_fd, env=env, cwd=cwd,
                                 close_fds=True)
    finally:
        os.close(out_fd)
        os.close(err_fd)
    # A child that must not be interrupted (dpkg) is not handed to the stop forwarder.
    stop.child = child if forward_stop else None
    if stop and forward_stop:
        stop.forward()
    try:
        while True:
            try:
                code = child.wait(timeout=poll_seconds)
                break
            except subprocess.TimeoutExpired:
                if on_tick is not None:
                    try:
                        on_tick(child)
                    except Exception as error:  # progress must never end supervision
                        sys.stderr.write("bridgesllm-toolctl: progress update failed: %s\n" % redact_text(str(error))[:200])
    finally:
        stop.child = None
    return code, child.pid


# --------------------------------------------------------------------------
# Native outcome → Portal state (c.2.4)
#
# Sources: the `--json` result on stdout and `update status --json` read right
# after. The result is `{...UpdateRunResult, run?, reportPath}` (progress
# printResult): `status` ok|error|skipped plus `reason`, and, once a run record
# exists, `run` with `status` running|succeeded|failed|rolled-back|skipped,
# `phase`, `reason`, `origin.nextAction` and `steps[]`. A read-only admission
# refusal prints a result with neither `runId` nor `run`: no run was created
# (update-command-result withUpdateAdmissionReporting). Anything unrecognised
# maps to recovery-required.
# --------------------------------------------------------------------------

def native_post_core(record):
    """Native's needsPostCoreRepair: did this run reach activation or later? None if unknown."""
    steps = record.get("steps")
    if not isinstance(steps, list):
        return None
    if record.get("phase") in NATIVE_POST_CORE_PHASES:
        return True
    for step in steps:
        name = step.get("step") if isinstance(step, dict) else None
        if not isinstance(name, str):
            return None
        if name in NATIVE_POST_CORE_PHASES or name == "post-update verification" or name.startswith("finalize:"):
            return True
    return False


def native_run_record(doc):
    """The run record of an UpdateRunResult (or a status row); {} if absent."""
    if not isinstance(doc, dict):
        return {}
    record = doc.get("run") if isinstance(doc.get("run"), dict) else doc
    origin = record.get("origin") if isinstance(record.get("origin"), dict) else {}
    out = {}
    for key in ("runId", "status", "phase", "reason"):
        value = record.get(key)
        if value is None and key == "runId":
            value = doc.get("runId")
        out[key] = value[:200] if isinstance(value, str) else None
    out["nextAction"] = origin.get("nextAction")[:500] if isinstance(origin.get("nextAction"), str) else None
    out["postCore"] = native_post_core(record)
    return out


def _record_time_ms(record):
    for key in ("finishedAtMs", "updatedAtMs", "createdAtMs"):
        if isinstance(record.get(key), (int, float)) and not isinstance(record.get(key), bool):
            return record[key]
    return None


def active_wait(active):
    """What an active native run is waiting on: its in-progress step and that step's detail."""
    steps = active.get("steps") if isinstance(active, dict) and isinstance(active.get("steps"), list) else []
    for step in reversed(steps):
        if isinstance(step, dict) and step.get("status") == "in_progress" and isinstance(step.get("step"), str):
            detail = step.get("detail")
            return {"step": step["step"][:120], "detail": tail_text(detail, 300) if isinstance(detail, str) else None}
    return None


def map_native_outcome(exit_code, result_doc, status_doc, launched_ms, installed_before, installed_after, target):
    """Return {state, error, native, continue, degraded} for one finished native child."""
    result = result_doc if isinstance(result_doc, dict) else {}
    result_status = result.get("status") if isinstance(result.get("status"), str) else None
    result_reason = result.get("reason")[:200] if isinstance(result.get("reason"), str) else None
    if result and not isinstance(result.get("run"), dict) and not result.get("runId") and result_status in ("error", "skipped"):
        # Refused by read-only admission before a run record existed: nothing changed.
        failed = result.get("failedStep") if isinstance(result.get("failedStep"), dict) else {}
        native = {"runId": None, "status": None, "phase": None, "reason": result_reason, "nextAction": None, "postCore": None,
                  "resultStatus": result_status, "exitCode": exit_code, "source": "result"}
        return {"state": "refused", "continue": False, "degraded": None, "native": native,
                "error": {"id": "NATIVE_ADMISSION_REFUSED", "nextAction": None,
                          "message": "OpenClaw refused the update before starting it%s. Nothing was changed." % (
                              ": %s" % result_reason if result_reason else ""),
                          "detail": {"nativeResultStatus": result_status, "nativeReason": result_reason,
                                     "stderrTail": tail_text(failed.get("stderrTail"), 300) if isinstance(failed.get("stderrTail"), str)
                                     else None}}}
    record = native_run_record(result) if isinstance(result.get("run"), dict) else {}
    source = "result"
    if not record.get("status"):
        # No usable run record (killed, crash, history unreadable at print time):
        # only `update status` can prove otherwise, with a finished row of this
        # run (same runId), or else one recorded after this child started.
        status_doc = status_doc if isinstance(status_doc, dict) else {}
        last = status_doc.get("lastRun") if isinstance(status_doc.get("lastRun"), dict) else None
        when = _record_time_ms(last) if last else None
        run_id = result.get("runId") if isinstance(result.get("runId"), str) else None
        same_run = bool(last and run_id and last.get("runId") == run_id)
        if status_doc.get("activeRun") is None and last and (same_run or (not run_id and when is not None and when >= launched_ms)) \
                and last.get("status") in ("succeeded", "rolled-back", "failed", "skipped"):
            record, source = native_run_record(last), "status"
        else:
            return {"state": "recovery-required", "continue": False, "degraded": None,
                    "native": dict(record, runId=run_id, resultStatus=result_status, exitCode=exit_code, source=None),
                    "error": {"id": "NATIVE_RESULT_MISSING",
                              "message": "The OpenClaw updater stopped without reporting a result. Recovery is required.",
                              "detail": {"exitCode": exit_code, "nativeReason": result_reason}}}
    native = dict(record, resultStatus=result_status, exitCode=exit_code, source=source)
    status, phase, next_action = record["status"], record["phase"], record["nextAction"]
    reason = record["reason"] or result_reason

    def outcome(state, error_id=None, message=None, cont=False, degraded=None):
        error = None if error_id is None else {"id": error_id, "message": message, "nextAction": next_action,
                                               "detail": {"nativeStatus": status, "nativeReason": reason, "nativePhase": phase}}
        return {"state": state, "continue": cont, "degraded": degraded, "native": native, "error": error}

    if status == "succeeded":
        if exit_code != 0 and source == "result":
            # A success the process itself contradicts: trust it only if status agrees.
            confirm = native_run_record((status_doc or {}).get("lastRun")) if isinstance(status_doc, dict) else {}
            if confirm.get("status") != "succeeded" or (record.get("runId") and confirm.get("runId") != record.get("runId")):
                return outcome("recovery-required", "NATIVE_RESULT_CONTRADICTED",
                               "The OpenClaw updater reported success but exited with an error. Recovery is required.")
        return outcome("succeeded", cont=True)
    if status == "skipped":
        if reason == "doctor-maintenance-pending":
            # The package may be replaced while Doctor couldn't enter maintenance (the live gateway
            # held state): `update repair --yes --no-restart --json` with the gateway stopped finishes it
            # (how-updates-run.md "If the package was already replaced and Doctor failed ...").
            mapped = outcome("recovery-required", "NATIVE_MAINTENANCE_PENDING",
                             "OpenClaw %s was installed, but its Doctor maintenance is unfinished. Recovery is required."
                             % (installed_after or target), cont=True)
            mapped["error"]["nextAction"] = "recover-native"
            return mapped
        if reason == "gateway-readiness-unverified":
            return outcome("succeeded-degraded", cont=True,
                           degraded="OpenClaw %s was installed, but its readiness wasn't confirmed in time. Check OpenClaw's status."
                           % (installed_after or target))
        if installed_after and target and installed_after == target:
            return outcome("succeeded", cont=True)
        return outcome("refused", "NATIVE_SKIPPED", "OpenClaw skipped the update%s. Nothing was changed." % (
            ": %s" % reason if reason else ""))
    if status == "rolled-back":
        return outcome("rolled-back", "NATIVE_ROLLED_BACK",
                       "The update failed; OpenClaw automatically returned to %s.%s" % (
                           installed_after or installed_before or "the previous version", " Reason: %s." % reason if reason else ""),
                       cont=True)
    if status in ("failed", "running") and reason in NATIVE_RECOVERY_REASONS:
        return outcome("recovery-required", "NATIVE_RECOVERY_REQUIRED",
                       "OpenClaw needs recovery%s. Chat may be unavailable." % (" (%s)" % reason if reason else ""))
    if status == "failed":
        # A finished record says "finished"; its steps tell whether activation was reached.
        if phase in NATIVE_PRE_ACTIVATION_PHASES or (phase == "finished" and record.get("postCore") is False):
            return outcome("refused", "NATIVE_REFUSED",
                           "OpenClaw stopped the update before changing anything%s. Nothing was changed." % (
                               ": %s" % reason if reason else ""))
        return outcome("recovery-required", "NATIVE_FAILED_AFTER_ACTIVATION",
                       "The OpenClaw update failed after it started changing the installation. Recovery is required.")
    if status == "running":
        return outcome("recovery-required", "NATIVE_RUN_UNFINISHED",
                       "The OpenClaw updater exited while its update was still recorded as running. Recovery is required.")
    return outcome("recovery-required", "NATIVE_OUTCOME_UNKNOWN",
                   "OpenClaw reported an update outcome this Portal doesn't recognise (%s). Recovery is required." % (status or "none"))


PHASE_WORD_RE = re.compile(r"\b(requested|staging|validating|repairing|activating|restarting|verifying|finished)\b", re.I)


def last_phase_in(text):
    found = PHASE_WORD_RE.findall(text or "")
    return found[-1].lower() if found else None


def read_tail(path, limit=8192):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return ""


class NativeUpdate(object):
    """Launch `openclaw update` (c.2.2), follow it (c.2.3) and map its outcome (c.2.4)."""

    def __init__(self, roots, run, service_env, node_path, runner, stop, progress_seconds=NATIVE_PROGRESS_SECONDS,
                 poll_seconds=SUPERVISE_POLL_SECONDS, on_window=None, on_activating=None,
                 activating_poll_seconds=NATIVE_ACTIVATING_POLL_SECONDS, status_key="native"):
        self.roots = roots
        self.run = run
        self.service_env = service_env or {}
        self.node_path = node_path
        self.runner = runner
        self.stop = stop
        self.progress_seconds = progress_seconds
        self.poll_seconds = poll_seconds
        self.last_progress = None
        # Called once with a reason when `update status` shows the restart window (L3 chat pause).
        self.on_window = on_window
        # Mode A: called once when native reaches activation; stops the gateway unit (K7).
        self.on_activating = on_activating
        self.activating_poll_seconds = activating_poll_seconds
        self.gateway_parked = False  # true only once the unit really stopped
        self.gateway_stop_failed = None  # mode A: why the unit didn't stop at activation
        self.installed_before = None
        self.status_key = status_key  # "native" for the update, "nativeRepair"/"nativeRollback" after it
        self.launched_ms = None

    def status_doc(self):
        try:
            code, out, _err = self.runner(native_argv(self.node_path, self.roots.openclaw_bin, ["update", "status", "--json"]),
                                          timeout=NATIVE_STATUS_TIMEOUT, env=native_env(self.service_env),
                                          limit=NATIVE_REPLY_LIMIT_BYTES)
        except (OSError, subprocess.SubprocessError):
            return None
        doc = parse_json_output(out) if code == 0 and not reply_exceeded(out) else None
        return doc if isinstance(doc, dict) else None

    def tick(self, _child):
        native = self.run.status[self.status_key]
        now = time.monotonic()
        stop_news = bool(self.stop) and native.get("stop") is None
        interval = self.activating_poll_seconds if self.gateway_parked else self.progress_seconds
        if not stop_news and self.last_progress is not None and now - self.last_progress < interval:
            return
        self.last_progress = now
        if self.stop:
            native["stop"] = self.stop.record()
        if self.gateway_parked and not os.path.exists(self.roots.openclaw_bin):
            # Native is swapping the package (its directory is absent for minutes): a status
            # CLI can't run and would only add load. Poll again on the next gentle tick.
            native.update({"observedAt": utc_now(), "packageAbsent": True})
            self.run.status["updatedAt"] = native["observedAt"]
            self.run.save()
            return
        native.pop("packageAbsent", None)
        doc = self.status_doc()
        active = doc.get("activeRun") if isinstance(doc, dict) and isinstance(doc.get("activeRun"), dict) else {}
        phase = active.get("phase") if active.get("phase") in NATIVE_PHASES else None
        source = "status" if phase else None
        if phase is None:
            phase = last_phase_in(read_tail(os.path.join(self.run.dir, "native-stderr.log")))
            source = "stderr" if phase else None
        if phase and phase != native.get("phase"):
            native["phasesSeen"] = (native.get("phasesSeen") or []) + [phase]
        created = active.get("createdAtMs")
        if isinstance(active.get("runId"), str) and isinstance(created, (int, float)) and self.launched_ms is not None \
                and created >= self.launched_ms:
            native["activeRunId"] = active["runId"][:80]  # the native run this launch created (reconcile matches it)
        # Only proof that activation began opens the window: native's run at `activating` or later or,
        # while its status can't be read, the package directory absent or swapped. An unreadable
        # status alone never pauses chat or stops the gateway.
        window = native_restart_window(doc) if doc is not None else native_package_window(self.roots, self.installed_before)
        if window and self.on_window is not None and native.get("chatPause") is None:
            native["chatPause"] = {"at": utc_now(), "reason": window, "problem": self.on_window(window)}
        if window and self.on_activating is not None and not self.gateway_parked and native.get("gatewayStop") is None:
            native["gatewayStop"] = {"at": utc_now(), "reason": window, "problem": None}
            self.run.save()
            problem = native["gatewayStop"]["problem"] = self.on_activating(window)
            if problem is None:
                self.gateway_parked = True
            else:
                self.stop_native_for_failed_park(_child, problem, native)
        # Run records have no wait-reason field: the in-progress step and its detail are it.
        native.update({"phase": phase or native.get("phase"), "phaseSource": source or native.get("phaseSource"),
                       "observedAt": utc_now(), "statusReadable": doc is not None, "waitReason": active_wait(active)})
        self.run.status["updatedAt"] = native["observedAt"]
        self.run.save()

    def stop_native_for_failed_park(self, child, problem, native):
        """Mode A, the unit didn't stop at activation: native must not swap the package under a
        live gateway. While the package is still in place, stop native the way Stop does (one SIGTERM, never
        escalated); once it is being replaced, native has to finish. The gateway is left as it is."""
        self.gateway_stop_failed = problem
        swapping = native_package_window(self.roots, self.installed_before) is not None
        native["gatewayStop"]["nativeStopped"] = False
        if not swapping and child is not None and child.returncode is None:
            try:
                child.send_signal(signal.SIGTERM)
                native["gatewayStop"]["nativeStopped"] = True
            except OSError:
                pass
            if self.stop is not None and hasattr(self.stop, "forwarded"):
                self.stop.forwarded = True  # a later Stop sends no second SIGTERM
        native["gatewayStop"]["packageReplacing"] = swapping
        self.run.save()

    def execute(self, channel, tag, installed_before, target, tag_name=""):
        """``tag_name`` keeps a second native update in one run (the rollback) in its own files."""
        argv, env = build_native_update_command(channel, tag, self.service_env, self.run.run_id, self.roots,
                                                node_path=self.node_path)
        ensure_private_dir(env["TMPDIR"])
        stdout_path = os.path.join(self.run.dir, "native%s-stdout.json" % tag_name)
        stderr_path = os.path.join(self.run.dir, "native%s-stderr.log" % tag_name)
        launched_ms = self.launched_ms = int(time.time() * 1000)
        self.installed_before = installed_before
        self.run.status[self.status_key] = {"command": describe_command(argv, env), "startedAt": utc_now(), "phase": "requested",
                                            "phaseSource": None, "phasesSeen": ["requested"], "pid": None, "exitCode": None,
                                            "stop": None}
        self.run.save()
        exit_code, pid = supervise_child(argv, env, stdout_path, stderr_path, self.stop, on_tick=self.tick,
                                         poll_seconds=self.poll_seconds)
        native = self.run.status[self.status_key]
        native.update({"pid": pid, "exitCode": exit_code, "endedAt": utc_now()})
        if self.stop:
            native["stop"] = self.stop.record()
        try:
            with open(stdout_path, "rb") as handle:
                raw = handle.read(NATIVE_STDOUT_LIMIT + 1)
        except OSError:
            raw = b""
        result_doc = parse_json_output(raw[:NATIVE_STDOUT_LIMIT].decode("utf-8", "replace"))
        evidence = [self.run.write_evidence("native%s-result.json" % tag_name, result_doc if isinstance(result_doc, dict)
                                            else {"unparsed": True, "stdoutBytes": len(raw)})]
        status_doc = self.status_doc()
        evidence.append(self.run.write_evidence("native-status-after.json",
                                                status_doc if status_doc is not None else {"readable": False}))
        self.result_doc = result_doc if isinstance(result_doc, dict) else None
        self.status_after = status_doc
        installed_after = installed_openclaw_version(self.roots)
        mapped = map_native_outcome(exit_code, result_doc, status_doc, launched_ms, installed_before, installed_after, target)
        native.update({k: v for k, v in mapped["native"].items() if k != "exitCode"})
        try:
            os.rmdir(env["TMPDIR"])
        except OSError:
            pass
        self.run.save()
        return mapped, installed_after, evidence + [os.path.basename(stdout_path), os.path.basename(stderr_path)]

    def repair(self, tag_name=""):
        """c.6 `openclaw update repair --yes --no-restart --json`, run with the gateway already stopped by toolctl
        (how-updates-run.md: "stop the foreground Gateway through its owner, and run `openclaw update repair --yes
        --no-restart --json` from the updated installation. Verify the repair result before starting the Gateway
        again."). Same options in 2026.9.9 and 2026.10.9; never another update.

        Returns (result document|None, `update status` document|None, exit code, evidence names).
        """
        argv = native_argv(self.node_path, self.roots.openclaw_bin, ["update", "repair", "--yes", "--no-restart", "--json"])
        env = native_env(self.service_env, {"NPM_CONFIG_PREFIX": "/usr", "TMPDIR": os.path.join(self.roots.tmp_dir, self.run.run_id)})
        assert not any(flag in argv for flag in FORBIDDEN_NATIVE_FLAGS)
        ensure_private_dir(env["TMPDIR"])
        stdout_path = os.path.join(self.run.dir, "native-repair%s-stdout.json" % tag_name)
        stderr_path = os.path.join(self.run.dir, "native-stderr.log")
        self.run.status[self.status_key] = {"command": describe_command(argv, env), "startedAt": utc_now(), "phase": None,
                                            "phaseSource": None, "phasesSeen": [], "pid": None, "exitCode": None, "stop": None}
        self.run.save()
        exit_code, pid = supervise_child(argv, env, stdout_path, stderr_path, self.stop, on_tick=self.tick,
                                         poll_seconds=self.poll_seconds)
        native = self.run.status[self.status_key]
        native.update({"pid": pid, "exitCode": exit_code, "endedAt": utc_now()})
        if self.stop:
            native["stop"] = self.stop.record()
        try:
            with open(stdout_path, "rb") as handle:
                raw = handle.read(NATIVE_STDOUT_LIMIT + 1)
        except OSError:
            raw = b""
        doc = parse_json_output(raw[:NATIVE_STDOUT_LIMIT].decode("utf-8", "replace"))
        doc = doc if isinstance(doc, dict) else None
        evidence = [self.run.write_evidence("native-repair%s-result.json" % tag_name, doc if doc is not None
                                            else {"unparsed": True, "stdoutBytes": len(raw)})]
        status_doc = self.status_doc()
        evidence.append(self.run.write_evidence("native-status-after.json",
                                                status_doc if status_doc is not None else {"readable": False}))
        try:
            os.rmdir(env["TMPDIR"])
        except OSError:
            pass
        self.run.save()
        return doc, status_doc, exit_code, evidence + [os.path.basename(stdout_path), "native-stderr.log"]


def native_failed_before_mutation(status_doc, last):
    """PF-3: a handoff failure at step `requested` with no recovery sets recorded changed nothing."""
    if not isinstance(last, dict) or last.get("status") != "failed" \
            or last.get("reason") not in NATIVE_PRE_MUTATION_HANDOFF_REASONS:
        return False
    recovery_sets = status_doc.get("recoverySets") if isinstance(status_doc, dict) else None
    if not isinstance(recovery_sets, list) or recovery_sets:
        return False
    if native_post_core(last) is not False:
        return False
    steps = last.get("steps") if isinstance(last.get("steps"), list) else []
    return any(isinstance(s, dict) and s.get("step") == "requested" and s.get("status") == "failed" for s in steps)


def native_last_run_pending(status_doc, last):
    """PF-3: does lastRun (no activeRun) still own recovery work?"""
    if not isinstance(last, dict):
        return False
    if last.get("status") == "running":
        return True
    return last.get("reason") in NATIVE_RECOVERY_REASONS and not native_failed_before_mutation(status_doc, last)


def native_recovery_pending(status_doc):
    """Why `update status --json` still shows recovery work, or None (the PF-3 rules)."""
    if not isinstance(status_doc, dict):
        return "OpenClaw's update status couldn't be read"
    if status_doc.get("runStatusError"):
        return "OpenClaw can't read its update history"
    if status_doc.get("activeRun") is not None:
        return "an OpenClaw update or recovery is still active"
    activation = status_doc.get("packageActivation")
    if status_doc.get("packageActivationError") or (isinstance(activation, dict)
                                                    and activation.get("phase") not in NATIVE_SETTLED_ACTIVATION_PHASES):
        return "a package activation is still unsettled"
    last = status_doc.get("lastRun")
    if native_last_run_pending(status_doc, last):
        return "the last update still needs recovery (%s)" % (last.get("reason") or last.get("status"))
    if isinstance(last, dict) and last.get("reason") == "doctor-maintenance-pending":
        return "OpenClaw's Doctor maintenance is still unfinished"
    return None


def native_repair_warnings(doc):
    """`postUpdate.doctor.warnings` then `postUpdate.plugins.warnings` of a repair/update result (strings or {message})."""
    post = doc.get("postUpdate") if isinstance(doc, dict) and isinstance(doc.get("postUpdate"), dict) else {}
    found = []
    for key in ("doctor", "plugins"):
        part = post.get(key) if isinstance(post.get(key), dict) else {}
        warnings = part.get("warnings") if isinstance(part.get("warnings"), list) else []
        for warning in warnings:
            text = warning if isinstance(warning, str) else warning.get("message") if isinstance(warning, dict) else None
            if isinstance(text, str) and text.strip():
                found.append(redact_text(text.strip())[:300])
    return found[:5]


def map_native_repair(exit_code, doc, status_doc):
    """`update repair --json` → {state, error}. Only a clean repair that status confirms is a success.

    Shapes (update-repair-command reportRepairResult; update-command-finalize): `status` ok, warning (with
    `nextAction` and `postUpdate.doctor.warnings`, e.g. Doctor maintenance deferred), error or failed (with
    `error`); a refusal thrown before work prints the CLI failure envelope `{ok: false, error: {message}}`.
    Exit 1 on error. Every failure carries a reason and the one Portal action, recover-native (P7);
    native's own free-text next step stays in the detail.
    """
    doc = doc if isinstance(doc, dict) else {}
    status = doc.get("status") if isinstance(doc.get("status"), str) else None
    error = doc.get("error")
    message = doc.get("message") if isinstance(doc.get("message"), str) else None
    if isinstance(error, str):
        message = error
    elif isinstance(error, dict) and isinstance(error.get("message"), str):
        message = error["message"]
    message = redact_text(message.strip())[:400] if message else None
    native_next = redact_text(doc.get("nextAction").strip())[:500] if isinstance(doc.get("nextAction"), str) else None
    warnings = native_repair_warnings(doc)
    reason = message or (warnings[0] if warnings else None) or native_next
    detail = {"nativeStatus": status, "exitCode": exit_code, "nativeMessage": message, "warnings": warnings,
              "nativeNextAction": native_next}
    if exit_code == 0 and status == "ok":
        pending = native_recovery_pending(status_doc)
        if pending is None:
            return {"state": "succeeded", "error": None, "message": message}
        return {"state": "recovery-required", "message": message, "error": {
            "id": "RECOVERY_STILL_PENDING", "nextAction": "recover-native", "detail": dict(detail, pending=pending),
            "message": "OpenClaw repair finished, but %s. Recovery is still required." % pending}}
    if status == "warning":
        return {"state": "recovery-required", "message": reason, "error": {
            "id": "RECOVERY_INCOMPLETE", "nextAction": "recover-native", "detail": detail,
            "message": "OpenClaw repair couldn't finish: %s." % (reason.rstrip(".") if reason
                                                                 else "OpenClaw gave no reason")}}
    return {"state": "recovery-required", "message": reason, "error": {
        "id": "RECOVERY_FAILED", "nextAction": "recover-native", "detail": detail,
        "message": "OpenClaw repair failed: %s. Chat may be unavailable." % (reason.rstrip(".") if reason
                                                                            else "OpenClaw gave no reason (exit code %s)" % exit_code)}}


def describe_command(argv, env):
    """Evidence form of a command: values of sensitive variables are redacted."""
    return {"argv": list(argv), "env": redact(dict(env))}


# --------------------------------------------------------------------------
# Runs: request, status, evidence, history
# --------------------------------------------------------------------------

def validate_request(request, run_id, policy):
    errors = []
    if not isinstance(request, dict):
        return ["request must be an object"]
    if request.get("tool") in NPM_TOOL_IDS:
        return validate_npm_request(request, run_id, policy)
    if request.get("tool") in HARNESS_TOOL_IDS:
        return validate_harness_request(request, run_id, policy)
    if request.get("schema") != SCHEMA_REQUEST:
        errors.append("schema must be %s" % SCHEMA_REQUEST)
    if request.get("runId") != run_id:
        errors.append("runId does not match the unit instance")
    if request.get("tool") != "openclaw":
        errors.append("only the openclaw tool is supported by this runner build")
    elif policy_tool(policy, request.get("tool")) is None:
        errors.append("tool is not in the policy")
    if request.get("action") not in RUN_ACTIONS:
        errors.append("action must be one of %s" % (RUN_ACTIONS,))
    if (request.get("action") in TARGETED_ACTIONS or request.get("target") is not None) \
            and request.get("target") not in RUN_TARGETS:
        errors.append("target must be one of %s" % (RUN_TARGETS,))
    channel = request.get("channel")
    if channel is not None and channel not in (policy or {}).get("openclaw", {}).get("channels", []):
        errors.append("channel is not offered by the policy")
    acks = request.get("acknowledgements")
    if acks is not None and (not isinstance(acks, dict) or not isinstance(acks.get("nodeRuntime", False), bool)):
        errors.append("acknowledgements.nodeRuntime must be a boolean")
    return errors


def node_update_accepted(request):
    acks = request.get("acknowledgements") if isinstance(request, dict) else None
    return isinstance(acks, dict) and acks.get("nodeRuntime") is True


class Run(object):
    """One run directory. Every transition is written before it is acted on."""

    def __init__(self, roots, run_id):
        self.roots = roots
        self.run_id = run_id
        self.dir = roots.run_dir(run_id)
        self.status_path = os.path.join(self.dir, "status.json")
        self.status = None
        self.quiesce = None  # DiagnosticQuiesce while the L3 marker may be published
        self.gateway = None  # GatewayUnit once a run may stop the gateway unit (K7)

    def load(self):
        self.status = read_json_file(self.status_path)
        return self.status

    def save(self):
        atomic_write_json(self.status_path, redact(self.status))

    def init_status(self, tool):
        now = utc_now()
        self.status = {"schema": SCHEMA_RUN_STATUS, "runId": self.run_id, "tool": tool, "phase": "queued",
                       "phaseStartedAt": now, "state": "queued", "createdAt": now, "updatedAt": now,
                       "steps": [], "native": None, "error": None, "result": None}
        self.save()

    def transition(self, phase, state):
        now = utc_now()
        self.status.update({"phase": phase, "state": state, "phaseStartedAt": now, "updatedAt": now})
        self.save()

    def step_start(self, step_id, label):
        step = {"id": step_id, "label": label, "state": "running", "startedAt": utc_now(), "endedAt": None,
                "detail": None, "evidence": []}
        self.status["steps"].append(step)
        self.status["updatedAt"] = step["startedAt"]
        self.save()
        return step

    def step_end(self, step, state, detail=None, evidence=None):
        step.update({"state": state, "endedAt": utc_now(), "detail": detail})
        if evidence:
            step["evidence"].extend(evidence)
        self.status["updatedAt"] = step["endedAt"]
        self.save()

    def write_evidence(self, name, obj):
        """Append-only evidence: an existing file is never overwritten."""
        stem, ext = os.path.splitext(name)
        candidate = name
        counter = 1
        while path_present(os.path.join(self.dir, candidate)):
            counter += 1
            candidate = "%s-%d%s" % (stem, counter, ext)
        atomic_write_json(os.path.join(self.dir, candidate), redact(obj))
        return candidate

    def finish(self, state, error=None, result=None):
        if state not in TERMINAL_STATES:
            raise ToolctlError("not a terminal state: %s" % state)
        if self.quiesce is not None:
            # Every terminal state, including an internal error, ends the L3 quiesce first.
            self.quiesce.clear()
        now = utc_now()
        self.status.update({"phase": state, "state": state, "phaseStartedAt": now, "updatedAt": now,
                            "endedAt": now, "error": error, "result": result})
        self.save()
        append_history(self.roots, history_entry(self.status))


def history_entry(status):
    started = parse_ts(status.get("createdAt"))
    ended = parse_ts(status.get("endedAt"))
    result = status.get("result") or {}
    return {
        "schema": SCHEMA_HISTORY,
        "runId": status.get("runId"),
        "tool": status.get("tool"),
        "action": result.get("action"),
        "from": result.get("from"),
        "to": result.get("to"),
        "outcome": status.get("state"),
        "errorId": (status.get("error") or {}).get("id"),
        "startedAt": status.get("createdAt"),
        "endedAt": status.get("endedAt"),
        "durationMs": int((ended - started) * 1000) if started is not None and ended is not None else None,
        "reportPath": os.path.join("runs", status.get("runId") or "", "status.json"),
    }


def append_history(roots, entry, rotate_bytes=HISTORY_ROTATE_BYTES, keep=HISTORY_KEEP_RUNS):
    path = roots.history_path
    line = (json.dumps(redact(entry), sort_keys=True) + "\n").encode("utf-8")
    try:
        size = os.lstat(path).st_size
    except FileNotFoundError:
        size = 0
    if size + len(line) > rotate_bytes:
        lines = []
        try:
            with open(path, "rb") as handle:
                lines = [l for l in handle.read().splitlines() if l.strip()]
        except FileNotFoundError:
            pass
        kept = lines[-(keep - 1):] if keep > 1 else []
        data = b"".join(l + b"\n" for l in kept)
        fd, tmp = tempfile.mkstemp(prefix=".history.", suffix=".tmp", dir=roots.state_root)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        fsync_dir(roots.state_root)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ToolctlError("history file is unsafe")
        os.write(fd, line)
        os.fsync(fd)
    finally:
        os.close(fd)


def read_history(roots, limit=20):
    try:
        with open(roots.history_path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 512 * 1024))
            tail = handle.read().splitlines()
    except FileNotFoundError:
        return []
    entries = []
    for raw in tail[-limit:]:
        try:
            entries.append(json.loads(raw.decode("utf-8")))
        except ValueError:
            continue
    return entries


def ensure_state_dirs(roots):
    parent = os.path.dirname(roots.state_root)
    if not os.path.isdir(parent):
        raise ToolctlError("state root parent %s does not exist" % parent)
    for path in (roots.state_root, roots.runs_dir, roots.tmp_dir):
        ensure_private_dir(path)


def stop_before_change(run, stop, result=None):
    """Finish a run stopped before it changed anything."""
    run.status["stop"] = stop.record()
    run.finish("failed", error={"id": "TOOLS_RUN_STOPPED", "message": "The run was stopped before it changed anything. Try again."},
               result=result)
    return run.status


# --------------------------------------------------------------------------
# L3 Portal quiesce (a.5), in two markers
#
# 1. The diagnostics quiesce marker, toolctl's own file in its state root,
#    covers the core run from the end of pre-flight until verification starts.
#    The backend starts no Portal OpenClaw CLI reader while it exists
#    (openclawDiagnosticLease.ts) but keeps chat running on its last readiness
#    attestation (openClawExecutionAdmission.ts). Readers already running are
#    drained by taking the shared readers lock exclusively, as install.sh's
#    acquire_openclaw_diagnostic_lease does. The marker lives outside the
#    directories whose stamps the backend reads as runtime-mutation boundaries,
#    so publishing it doesn't throw away chat's attestation.
# 2. The existing maintenance marker (exact bytes the backend validates) pauses
#    chat only for the restart window. Native records `activating` and only
#    then drains and stops the gateway (2026.10.9 update-execution.runtime-
#    rxr-yrm4.mjs:489 then :506 -> update-command-service-maintenance-
#    BP-uK8oW.mjs:719 drain, :698 stop; 2026.9.9 update-execution.runtime-
#    D4ynQF5N.mjs:1136-1137); before that only requested, staging (:182) and
#    validating (:385) run, against a staged copy, while the live gateway
#    serves. So the window opens when `update status` shows any other phase,
#    can't be read or is not understood (fail closed), and stays open until
#    Portal plugins are reconnected after the native step. A recovery run
#    keeps it open for the whole repair.
# Both are cleared on every terminal state; reconcile clears one whose run is
# final.
# --------------------------------------------------------------------------

SCHEMA_MAINTENANCE_MARKER = "bridgesllm.openclaw-mutation-maintenance.v1"
MAINTENANCE_MARKER_NAME = "openclaw-mutation-maintenance-v1.json"
SCHEMA_QUIESCE_MARKER = "bridgesllm.tools.openclaw-diagnostics-quiesce.v1"
QUIESCE_MARKER_NAME = "openclaw-diagnostics-quiesce.v1.json"
DIAGNOSTIC_READERS_LOCK_NAME = "openclaw-diagnostic-readers.lock"
MAINTENANCE_MARKER_MAX_BYTES = 2048
READER_DRAIN_SECONDS = 75
READER_DRAIN_POLL_SECONDS = 0.25
# The marker names the gateway drop-in it installed; v2 installs none (a.5).
NO_DROPIN_SHA256 = hashlib.sha256(b"").hexdigest()


def maintenance_marker_path(roots):
    return os.path.join(roots.installer_state_root, MAINTENANCE_MARKER_NAME)


def quiesce_marker_path(roots):
    return os.path.join(roots.state_root, QUIESCE_MARKER_NAME)


def canonical_marker_bytes(operation_id, unit, created_at, updated_at):
    """Exactly the bytes validateCanonicalMaintenanceMarker accepts: sorted keys, compact, ASCII, one newline."""
    return (json.dumps({"createdAt": created_at, "operationId": operation_id, "phase": "maintenance",
                        "schema": SCHEMA_MAINTENANCE_MARKER, "systemDropInSha256": NO_DROPIN_SHA256, "unit": unit,
                        "updatedAt": updated_at}, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")


def quiesce_marker_bytes(operation_id, run_id, created_at):
    """The backend only checks that the quiesce marker exists; its content names the run for reconcile."""
    return (json.dumps({"createdAt": created_at, "operationId": operation_id, "runId": run_id,
                        "schema": SCHEMA_QUIESCE_MARKER}, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
            + "\n").encode("ascii")


def marker_run_id(operation_id):
    """The toolctl run id a marker belongs to (operationId = run id without dashes), else None."""
    if not isinstance(operation_id, str) or not re.fullmatch(r"[0-9a-f]{32}", operation_id):
        return None
    o = operation_id
    run_id = "%s-%s-%s-%s-%s" % (o[:8], o[8:12], o[12:16], o[16:20], o[20:])
    return run_id if RUN_ID_RE.fullmatch(run_id) else None


def _read_marker(path):
    """("absent"|"present"|"unreadable", document|None); never follows a link."""
    if not path_present(path):
        return "absent", None
    try:
        doc = read_json_file(path, max_bytes=MAINTENANCE_MARKER_MAX_BYTES)
    except (ToolctlError, OSError):
        return "unreadable", None
    return ("present", doc) if isinstance(doc, dict) else ("unreadable", None)


def read_maintenance_marker(roots):
    return _read_marker(maintenance_marker_path(roots))


def read_quiesce_marker(roots):
    return _read_marker(quiesce_marker_path(roots))


def check_marker_directory(path):
    """The marker directory must be a real directory of this runner, not writable by others."""
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() \
            or stat.S_IMODE(info.st_mode) & 0o022:
        raise ToolctlError("%s is not a private directory of the runner" % path)


def publish_marker(directory, name, data):
    """Write ``data`` as directory/name, mode 0600, by rename (the backend reads a second link as unsafe).

    The caller has checked that no marker exists; under the Portal operation lock
    no other writer can create one.
    """
    check_marker_directory(directory)
    fd, tmp = tempfile.mkstemp(prefix="." + name + ".", suffix=".tmp", dir=directory)
    try:
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp, os.path.join(directory, name))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(directory)


def native_restart_window(doc):
    """Why chat must pause now (native's run has reached its switch-over), or None.

    ``doc`` is `update status --json`. Native parks the gateway only at `activating` (10.9
    how-updates-run: "Only `activating` stops the managed service"); its previous-Gateway
    readiness verification runs before that, inside `validating`. In a rehearsal (ET): the
    unsettled packageActivation record was there by 23:00:26 while native still validated;
    the stop it caused (23:00:30) left the previous-Gateway verification that followed
    seeing "service=stopped" (37 s into its 1110 s budget), so native's rollback basis was
    lost. `activating` began 23:02:35, before the DB snapshots (23:02:39) and the package
    swap (directory gone 23:08:11). So an unsettled activation record, or an unreadable or
    unusual status, never
    opens the window; native_package_window covers a status that can't be read once the
    swap has begun.
    """
    active = doc.get("activeRun") if isinstance(doc, dict) else None
    phase = active.get("phase") if isinstance(active, dict) else None
    if phase in NATIVE_PHASES and phase not in NATIVE_PRE_ACTIVATION_PHASES:
        return "OpenClaw is %s" % phase
    return None


def native_package_window(roots, installed_before):
    """The fallback that proves activation began without a status: the package directory is
    absent (native is swapping it) or holds another version than before the run; else None."""
    if not os.path.exists(roots.openclaw_bin):
        return "OpenClaw's package is being replaced"
    installed = installed_openclaw_version(roots)
    if installed_before and installed and installed != installed_before:
        return "OpenClaw's package was replaced"
    return None


class DiagnosticQuiesce(object):
    """L3 for one run: the diagnostics quiesce marker with the readers lock, and the chat-pause window."""

    def __init__(self, roots, run, unit, drain_seconds=READER_DRAIN_SECONDS, poll_seconds=READER_DRAIN_POLL_SECONDS,
                 sleep=time.sleep, stop=None):
        self.roots = roots
        self.run = run
        self.unit = unit
        self.drain_seconds = drain_seconds
        self.poll_seconds = poll_seconds
        self.sleep = sleep
        self.stop = stop
        self.operation_id = run.run_id.replace("-", "")
        self.lock_fd = None
        self.published = False
        self.chat_paused = False

    def record(self, **values):
        state = self.run.status.setdefault("quiesceMarker", {"path": quiesce_marker_path(self.roots),
                                                             "operationId": self.operation_id})
        state.update(values)

    def record_chat(self, **values):
        state = self.run.status.setdefault("maintenanceMarker", {"path": maintenance_marker_path(self.roots),
                                                                 "operationId": self.operation_id})
        state.update(values)

    def publish(self):
        """Quiesce marker, then drain readers. Returns None, or an error dict; on error nothing stays published."""
        try:
            # The chat marker is published there later in the run: check it now, before anything changes.
            check_marker_directory(self.roots.installer_state_root)
            for path, (state, doc) in ((quiesce_marker_path(self.roots), read_quiesce_marker(self.roots)),
                                       (maintenance_marker_path(self.roots), read_maintenance_marker(self.roots))):
                if state != "absent":
                    return {"id": "QUIESCE_MARKER_PRESENT", "message": "Another OpenClaw maintenance is marked as active, so "
                            "OpenClaw wasn't updated. Nothing was changed.",
                            "detail": {"path": path, "operationId": (doc or {}).get("operationId") if state == "present" else None}}
            now = utc_now()
            publish_marker(self.roots.state_root, QUIESCE_MARKER_NAME, quiesce_marker_bytes(self.operation_id, self.run.run_id, now))
        except (OSError, ToolctlError) as error:
            return {"id": "QUIESCE_FAILED", "message": "The Portal couldn't pause its OpenClaw diagnostics, so OpenClaw wasn't "
                    "updated. Nothing was changed.", "detail": {"reason": str(error)[:300]}}
        self.published = True
        self.record(publishedAt=now, clearedAt=None, readersDrained=False)
        self.run.save()
        problem = self.drain()
        if problem is not None:
            self.clear()
            return problem
        self.record(readersDrained=True, drainedAt=utc_now())
        self.run.save()
        return None

    def drain(self):
        path = os.path.join(self.roots.installer_state_root, DIAGNOSTIC_READERS_LOCK_NAME)
        try:
            fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0), 0o600)
        except OSError as error:
            return {"id": "QUIESCE_FAILED", "message": "The Portal couldn't pause its OpenClaw diagnostics, so OpenClaw wasn't "
                    "updated. Nothing was changed.", "detail": {"reason": str(error)[:300]}}
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_size != 0 \
                or stat.S_IMODE(info.st_mode) & 0o022:
            os.close(fd)
            return {"id": "QUIESCE_FAILED", "message": "The Portal's OpenClaw diagnostics lock is unsafe, so OpenClaw wasn't "
                    "updated. Nothing was changed.", "detail": {"path": path}}
        deadline = time.monotonic() + self.drain_seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.lock_fd = fd
                return None
            except BlockingIOError:
                pass
            if self.stop or time.monotonic() >= deadline:
                os.close(fd)
                if self.stop:
                    return {"id": "TOOLS_RUN_STOPPED", "message": "The run was stopped before it changed anything. Try again."}
                return {"id": "QUIESCE_READERS_BUSY", "message": "Portal diagnostics didn't finish within %d seconds, so OpenClaw "
                        "wasn't updated. Nothing was changed; try again." % self.drain_seconds}
            self.sleep(self.poll_seconds)

    def pause_chat(self, reason):
        """Open the restart window: publish the maintenance marker. Idempotent; never raises.

        Returns None, or a problem string (recorded; the run goes on, as native is already running).
        """
        if self.chat_paused:
            return None
        reason = str(reason)[:200]
        try:
            state, _doc = read_maintenance_marker(self.roots)
            if state == "absent":
                now = utc_now()
                publish_marker(self.roots.installer_state_root, MAINTENANCE_MARKER_NAME,
                               canonical_marker_bytes(self.operation_id, self.unit, now, now))
                self.chat_paused = True
                self.record_chat(publishedAt=now, clearedAt=None, reason=reason)
                self.run.save()
                return None
            problem = "another maintenance marker is present"
        except (OSError, ToolctlError) as error:
            problem = "could not publish the maintenance marker: %s" % (getattr(error, "strerror", None) or error)
        self.record_chat(publishProblem=problem[:300], reason=reason)
        self.run.save()
        return problem

    def resume_chat(self):
        """Close the restart window: remove this run's maintenance marker. Idempotent; never raises."""
        if not self.chat_paused:
            return
        problem = clear_marker_of(self.roots, self.run.run_id)
        self.chat_paused = problem is not None
        self.record_chat(clearedAt=None if problem else utc_now(), clearProblem=problem)

    def end_quiesce(self):
        """Verification starts: Portal diagnostics may resume. Idempotent; never raises."""
        if self.lock_fd is not None:
            try:
                os.close(self.lock_fd)
            except OSError:
                pass
            self.lock_fd = None
        if not self.published:
            return
        problem = clear_quiesce_marker_of(self.roots, self.run.run_id)
        self.published = problem is not None
        self.record(clearedAt=None if problem else utc_now(), clearProblem=problem)

    def adopt(self):
        """Take over this run's markers left by a runner that died (reconcile), so they clear like its own."""
        state, doc = read_quiesce_marker(self.roots)
        self.published = state == "present" and quiesce_marker_run_id(doc) == self.run.run_id
        state, doc = read_maintenance_marker(self.roots)
        self.chat_paused = state == "present" and marker_run_id(doc.get("operationId")) == self.run.run_id

    def clear(self):
        """Every terminal state: end the quiesce, then the restart window. Idempotent; never raises."""
        self.end_quiesce()
        self.resume_chat()


def clear_marker_of(roots, run_id):
    """Remove the maintenance marker if it belongs to ``run_id``. Returns a problem string or None."""
    try:
        state, doc = read_maintenance_marker(roots)
        if state == "absent":
            return None
        if state != "present" or marker_run_id(doc.get("operationId")) != run_id:
            return "the maintenance marker belongs to another operation"
        os.unlink(maintenance_marker_path(roots))
        fsync_dir(roots.installer_state_root)
        return None
    except OSError as error:
        return "could not remove the maintenance marker: %s" % (error.strerror or error)


def quiesce_marker_run_id(doc):
    """The toolctl run a quiesce marker names, if its two ids agree; else None."""
    run_id = doc.get("runId") if isinstance(doc, dict) else None
    return run_id if isinstance(run_id, str) and marker_run_id(doc.get("operationId")) == run_id else None


def clear_quiesce_marker_of(roots, run_id):
    """Remove the quiesce marker if it belongs to ``run_id``. Returns a problem string or None."""
    try:
        state, doc = read_quiesce_marker(roots)
        if state == "absent":
            return None
        if state != "present" or quiesce_marker_run_id(doc) != run_id:
            return "the diagnostics quiesce marker belongs to another operation"
        os.unlink(quiesce_marker_path(roots))
        fsync_dir(roots.state_root)
        return None
    except OSError as error:
        return "could not remove the diagnostics quiesce marker: %s" % (error.strerror or error)


def _clear_stale_marker(roots, read, run_id_of, clear, active_run):
    state, doc = read(roots)
    if state == "absent":
        return None
    run_id = run_id_of(doc) if state == "present" else None
    report = {"state": state, "operationId": (doc or {}).get("operationId") if state == "present" else None,
              "runId": run_id, "cleared": False}
    if run_id is None:
        report["reason"] = "not a toolctl run's marker"
        return report
    if run_id == active_run:
        report["reason"] = "its run is active"
        return report
    try:
        status = read_json_file(os.path.join(roots.run_dir(run_id), "status.json"))
    except ToolctlError:
        status = None
    if isinstance(status, dict) and status.get("state") not in TERMINAL_STATES:
        report["reason"] = "its run is not final"
        return report
    problem = clear(roots, run_id)
    report.update({"cleared": problem is None, "reason": problem or ("its run is final" if status else "its run is gone")})
    return report


def clear_stale_maintenance_marker(roots, active_run=None):
    """Reconcile: clear a toolctl maintenance marker whose run is final (or gone). Returns a report or None if absent."""
    return _clear_stale_marker(roots, read_maintenance_marker, lambda doc: marker_run_id(doc.get("operationId")),
                               clear_marker_of, active_run)


def clear_stale_quiesce_marker(roots, active_run=None):
    """Reconcile: the same for the diagnostics quiesce marker."""
    return _clear_stale_marker(roots, read_quiesce_marker, quiesce_marker_run_id, clear_quiesce_marker_of, active_run)


# --------------------------------------------------------------------------
# Portal plugins (c.2.1 plugins-pre, c.3 plugins-post) and contract (c.4)
#
# `plugins inspect <id> --json` prints `{...inspect report, install}` with the
# registry record under `plugin` (plugins-inspect-command formatPluginInspection):
# `status` loaded|disabled|error (loader-shared createPluginRecord), `enabled`,
# `version`, and `error` on both a disabled and a failed record. Same in
# 2026.9.9 and 2026.10.9. A plugin that isn't installed exits 1. Only
# Portal-owned plugins from the release manifest are touched; official plugin
# records are never rewritten (c.3 item 4).
# --------------------------------------------------------------------------

def plugin_state(doc):
    """(installed version|None, healthy, problem|None) from one `plugins inspect --json` document."""
    if not isinstance(doc, dict):
        return None, False, "not installed or not inspectable"
    plugin = doc.get("plugin") if isinstance(doc.get("plugin"), dict) else doc
    version = None
    for holder in (plugin, doc.get("install"), plugin.get("install"), plugin.get("manifest")):
        if isinstance(holder, dict) and isinstance(holder.get("version"), str):
            version = holder["version"]
            break
    status = plugin.get("status")
    error = plugin.get("error") or plugin.get("loadError")
    # markPluginActivationDisabled sets status "disabled" and the reason as `error`.
    if plugin.get("enabled") is False or status == "disabled":
        return version, False, "disabled%s" % (": %s" % tail_text(str(error), 200) if error else "")
    if error or status == "error":
        return version, False, "load error: %s" % tail_text(str(error or "error"), 200)
    if status not in (None, "enabled", "loaded"):
        return version, False, "status %s" % str(status)[:40]
    return version, True, None


def load_plugin_manifest(roots):
    """The release manifest with every archive re-verified; (plugins, error message|None)."""
    try:
        manifest = read_json_file(os.path.join(roots.portal_plugins_dir, "manifest.json"), max_bytes=MIB)
    except ToolctlError as error:
        return None, str(error)
    errors = validate_plugin_manifest(manifest) if manifest is not None else ["manifest.json is missing"]
    if errors:
        return None, "; ".join(errors[:5])
    for plugin in manifest["plugins"]:
        archive = os.path.join(roots.portal_plugins_dir, plugin["archive"])
        try:
            if not stat.S_ISREG(os.lstat(archive).st_mode) or sha256_file(archive) != plugin["sha256"]:
                return None, "%s does not match the manifest" % plugin["archive"]
        except OSError:
            return None, "%s is missing" % plugin["archive"]
    return manifest["plugins"], None


class PortalPlugins(object):
    def __init__(self, roots, service_env, node_path, runner):
        self.roots = roots
        self.service_env = service_env or {}
        self.node_path = node_path
        self.runner = runner
        self.log = []

    def native(self, args, timeout):
        argv = native_argv(self.node_path, self.roots.openclaw_bin, args)
        try:
            code, out, err = self.runner(argv, timeout=timeout, env=native_env(self.service_env), limit=NATIVE_REPLY_LIMIT_BYTES)
        except subprocess.TimeoutExpired:
            code, out, err = None, "", "did not finish within %d s" % timeout
        except (OSError, subprocess.SubprocessError) as error:
            code, out, err = None, "", "could not be started: %s" % error
        entry = {"args": list(args), "exitCode": code, "stderr": tail_text(err, 300)}
        if reply_exceeded(out):
            entry["problem"] = "its reply exceeded %d bytes" % reply_exceeded(out)
        self.log.append(entry)
        return code, None if reply_exceeded(out) else parse_json_output(out), err

    def inspect(self, plugin_id):
        code, doc, _err = self.native(["plugins", "inspect", plugin_id, "--json"], PLUGIN_INSPECT_TIMEOUT)
        return plugin_state(doc if code == 0 else None)

    def install(self, plugin):
        archive = os.path.join(self.roots.portal_plugins_dir, plugin["archive"])
        # --force: a reviewed non-ClawHub source; --accept-capabilities: local copies need consent.
        # Both are justified because the bytes are this signed Portal release's own (c.2.1).
        code, _doc, _err = self.native(["plugins", "install", archive, "--force", "--accept-capabilities"], PLUGIN_INSTALL_TIMEOUT)
        return code == 0

    def reload(self, ids, accept_for=None):
        """"reloaded", "restart-required" or "failed" (older OpenClaw may lack reload: pending restart).

        ``accept_for``: the release manifest's plugin ids. When given, the reload
        also accepts capability changes (`--accept-capabilities`, 2026.9.9
        plugins-cli-BVhCO2DS.mjs:32, 2026.10.9 plugins-cli-DDE4iq1o.mjs:31): the
        owner decision for this release's own plugin bytes only, so any id outside
        the manifest is refused before anything runs.
        """
        consent = []
        if accept_for is not None:
            foreign = [i for i in ids if i not in set(accept_for)]
            if foreign:
                raise ToolctlError("refusing to accept capabilities for plugins this release doesn't own: %s" % ", ".join(foreign))
            consent = ["--accept-capabilities"]
        code, doc, _err = self.native(["plugins", "reload"] + list(ids) + ["--wait", "--json"] + consent, PLUGIN_RELOAD_TIMEOUT)
        if code != 0:
            return "failed"
        return "restart-required" if isinstance(doc, dict) and doc.get("restartRequired") is True else "reloaded"

    def converge(self, plugins, accept_capabilities=False):
        """Install what differs from the release, reload once (accepting capabilities for these
        release-owned plugins if asked). Returns per-plugin rows and the reload outcome."""
        rows, changed = [], []
        for plugin in plugins:
            version, healthy, problem = self.inspect(plugin["id"])
            row = {"id": plugin["id"], "bundled": plugin["version"], "installedBefore": version, "healthyBefore": healthy,
                   "problemBefore": problem, "installed": None}
            if version != plugin["version"] or not healthy:
                row["installed"] = self.install(plugin)
                if not row["installed"]:
                    rows.append(row)
                    return rows, None, "The Portal plugin %s %s couldn't be installed." % (plugin["id"], plugin["version"])
                changed.append(plugin["id"])
            rows.append(row)
        accept_for = [p["id"] for p in plugins] if accept_capabilities else None
        reload_outcome = self.reload(changed, accept_for=accept_for) if changed else "unchanged"
        return rows, reload_outcome, None


def plugins_pre_changes(status):
    """The Portal plugins ("<id> <version>") this run installed into OpenClaw before its own update (N4)."""
    record = status.get("pluginsPre") if isinstance(status, dict) and isinstance(status.get("pluginsPre"), dict) else {}
    installed = record.get("installed") if isinstance(record.get("installed"), list) else []
    return [entry for entry in installed if isinstance(entry, str)][:10]


def plugins_installed_note(changes):
    """One sentence for what plugins-pre changed before OpenClaw's own update ("" when nothing, N4)."""
    if not changes:
        return ""
    return "OpenClaw itself was not changed, but the Portal had already installed its plugin%s %s into it; %s installed." % (
        "s" if len(changes) > 1 else "", " and ".join(changes), "they stay" if len(changes) > 1 else "it stays")


def report_prior_changes(message, changes, append=False):
    """``message`` with its "nothing was changed" claim replaced by what plugins-pre changed (N4).

    ``append``: add the sentence when the message makes no such claim (only where native changed nothing).
    """
    note = plugins_installed_note(changes)
    if not note or not isinstance(message, str):
        return message
    for claim in ("Nothing was changed.", "OpenClaw wasn't changed.", "OpenClaw was not changed.", "OpenClaw wasn't updated."):
        if claim in message:
            return message.replace(claim, note, 1)
    if "Nothing was changed;" in message:
        return message.replace("Nothing was changed;", note[:-1] + ";", 1)
    return "%s %s" % (message.rstrip(), note) if append else message


def plugins_pre(roots, run, service_env, node_path, runner):
    """c.2.1: bring Portal plugins to the release's versions before the core update (no gateway restart).

    What it installs is recorded in status["pluginsPre"] before anything else can end the run, so no later
    message says "Nothing was changed" (N4). A reload that fails is a failed step.
    """
    plugins, problem = load_plugin_manifest(roots)
    if plugins is None:
        return {"id": "PLUGINS_PRE_FAILED", "message": "This Portal version's OpenClaw plugin packages are damaged. OpenClaw was not updated.",
                "detail": {"reason": problem}}, None
    worker = PortalPlugins(roots, service_env, node_path, runner)
    # Same owner decision as plugins-post: the plugins just installed from this release's own bytes are
    # reloaded with capability consent, for the release manifest's ids only (reload() refuses any other).
    rows, reload_outcome, failure = worker.converge(plugins, accept_capabilities=True)
    installed = ["%s %s" % (row["id"], row["bundled"]) for row in rows if row.get("installed")]
    run.status["pluginsPre"] = {"installed": installed, "reload": reload_outcome}
    run.save()
    evidence = run.write_evidence("plugins-pre.json", {"plugins": rows, "reload": reload_outcome, "commands": worker.log})
    if failure:
        message = failure + " OpenClaw was not updated."
        others = [entry for entry in installed if not failure.startswith("The Portal plugin %s couldn't" % entry)]
        if others:
            message = "%s Before that, the Portal installed its plugin%s %s into OpenClaw; %s installed." % (
                message, "s" if len(others) > 1 else "", " and ".join(others), "they stay" if len(others) > 1 else "it stays")
        return {"id": "PLUGINS_PRE_FAILED", "message": message, "evidence": evidence}, evidence
    if reload_outcome == "failed":
        reload_log = [entry for entry in worker.log if entry.get("args", [])[:2] == ["plugins", "reload"]]
        why = (reload_log[-1].get("problem") or reload_log[-1].get("stderr") or "exit code %s" % reload_log[-1].get("exitCode")) \
            if reload_log else "no result"
        many = len(installed) > 1
        return {"id": "PLUGINS_PRE_RELOAD_FAILED", "evidence": evidence,
                "message": "The Portal installed its plugin%s %s into OpenClaw, but OpenClaw couldn't reload %s: %s. "
                           "The plugin%s stay%s installed; OpenClaw itself was not updated." % (
                               "s" if many else "", " and ".join(installed), "them" if many else "it",
                               tail_text(str(why), 200).strip().rstrip("."), "s" if many else "", "" if many else "s"),
                "detail": {"reload": reload_outcome}}, evidence
    return None, evidence


def plugins_post(roots, run, service_env, node_path, runner, gateway_unit, restart_allowed=True, before_restart=None):
    """c.3: Portal plugins loaded, enabled and at the release's versions after the core update.

    Reinstall and reload what is missing or broken; if a reload can't take
    effect, one gateway restart (this is the core run, so that is acceptable),
    after ``before_restart()`` (the L3 chat pause). Returns (rows, restarted, evidence name).
    """
    plugins, problem = load_plugin_manifest(roots)
    if plugins is None:
        evidence = run.write_evidence("plugins-post.json", {"error": problem})
        return [{"id": None, "healthy": False, "problem": "plugin packages damaged: %s" % problem}], False, evidence
    worker = PortalPlugins(roots, service_env, node_path, runner)
    # Owner decision: the release's own plugin bytes are reloaded with capability consent.
    rows, reload_outcome, failure = worker.converge(plugins, accept_capabilities=True)
    restarted = False
    if failure is None and reload_outcome in ("failed", "restart-required") and restart_allowed:
        if before_restart is not None:
            before_restart()
        try:
            code, _out, err = runner([roots.systemctl_bin, "restart", gateway_unit], timeout=GATEWAY_RESTART_TIMEOUT)
        except (OSError, subprocess.SubprocessError) as error:
            code, err = None, str(error)
        worker.log.append({"args": ["systemctl", "restart", gateway_unit], "exitCode": code, "stderr": tail_text(err, 300)})
        restarted = code == 0
    final = []
    for plugin in plugins:
        version, healthy, why = worker.inspect(plugin["id"])
        ok = healthy and version == plugin["version"]
        final.append({"id": plugin["id"], "bundled": plugin["version"], "installed": version, "healthy": ok,
                      "problem": None if ok else (why or "version %s, expected %s" % (version, plugin["version"]))})
    evidence = run.write_evidence("plugins-post.json", {"converge": rows, "reload": reload_outcome, "failure": failure,
                                                        "restartedGateway": restarted, "plugins": final, "commands": worker.log})
    return final, restarted, evidence


def write_probe(run, probe_id, record):
    """probes/<id>.json, append-only (P4: probe output is never deleted)."""
    ensure_private_dir(os.path.join(run.dir, "probes"))
    return run.write_evidence(os.path.join("probes", probe_id + ".json"), dict(record, probe=probe_id))


def probe_ready(roots, service_env, node_path, exec_start, runner, http_get, wait_seconds, interval_seconds, stop=None,
                sleep=time.sleep, dead=None):
    """OC-READY: /readyz 200 and `gateway status --require-rpc` within the settle budget (c.5).

    A non-200 /readyz means the gateway is still starting; no failure is
    declared before the deadline. Returns the probe record.
    """
    port = gateway_port(exec_start, service_env)
    started = time.monotonic()
    attempts = []
    while True:
        status, why = http_get("http://127.0.0.1:%d/readyz" % port, READYZ_TIMEOUT) if port else (None, "no port")
        rpc = None
        if status == 200:
            argv = native_argv(node_path, roots.openclaw_bin, ["gateway", "status", "--require-rpc", "--json"])
            try:
                rpc, _out, _err = runner(argv, timeout=GATEWAY_STATUS_TIMEOUT, env=native_env(service_env))
            except (OSError, subprocess.SubprocessError) as error:
                rpc, why = None, str(error)[:200]
        attempts.append({"at": utc_now(), "readyz": status, "rpcExit": rpc, "problem": why})
        if status == 200 and rpc == 0:
            return {"state": "passed", "attempts": attempts[-20:], "elapsedSeconds": round(time.monotonic() - started, 1)}
        if stop:
            return {"state": "not-run", "attempts": attempts[-20:], "reason": "the run was stopped"}
        why_dead = dead() if dead is not None else None
        if why_dead:
            # RestartPreventExitStatus=78 keeps a refused start down: no need to wait out the budget.
            return {"state": "failed", "attempts": attempts[-20:], "elapsedSeconds": round(time.monotonic() - started, 1),
                    "reason": why_dead}
        # Retry only if a full attempt still fits before the deadline (memory e988 rule).
        if time.monotonic() - started + interval_seconds > wait_seconds:
            return {"state": "failed", "attempts": attempts[-20:], "elapsedSeconds": round(time.monotonic() - started, 1),
                    "reason": "OpenClaw did not become ready within %d minutes" % max(1, wait_seconds // 60)}
        sleep(interval_seconds)


# --------------------------------------------------------------------------
# C4 probe library (b.4, c.4, c.5)
#
# Gateway RPC goes through the CLI's own gateway-call path,
# `openclaw gateway call <method> --params <json> --json --timeout <ms>`
# (gateway-cli: identical in 2026.9.9 and 2026.10.9; a failed call exits 1),
# and the hello's server version through `gateway status --require-rpc --json`
# (`rpc.server.version`, probe probeGatewayStatus). The CLI prints no hello
# feature list, so the `features.methods` half of OC-HELLO is recorded as not
# run. Each attempt is bounded in time and output; a retry runs only if a full
# failing attempt still fits before the deadline (c.5).
# --------------------------------------------------------------------------

PROBE_RPC_TIMEOUT_MS = 60000
# Run options for verification timing (tests shorten them).
SETTLE_KEYS = ("ready_wait_seconds", "ready_interval_seconds", "probe_deadline_seconds", "probe_sleep")
PROBE_ATTEMPTS = 3
PROBE_BACKOFF_SECONDS = 2
ASK_USER_PLUGIN_ID = "bridgesllm-ask-user"
ASK_USER_STEER_METHOD = "bridgesllm.ask_user.steer"
# The plugin's own answer to a call without parameters (installer/openclaw-ask-user-plugin
# index.js respondInvalid): proof its handler ran, and nothing was steered.
ASK_USER_STEER_INVALID = "must be valid bounded strings"
# OC-HELLO methods half: what the gateway's hello `features.methods` must offer.
# Source: DESIGN b.4 (OC-HELLO row and the optional probes), taken from the
# backend's gateway RPC inventory (compat audit §2.2: chat.*, sessions.*,
# config.*, agents.list, models.list, question.*, sessions.goal.*, progressCard.get,
# canvas.document.view, tools.catalog, browser.request). A missing required
# method degrades the run naming it; a missing optional one turns only its
# feature off.
OPENCLAW_REQUIRED_METHODS = (
    "chat.send", "chat.history", "chat.abort", "sessions.list", "sessions.create", "sessions.patch", "sessions.describe",
    "sessions.delete", "config.get", "config.patch", "agents.list", "models.list",
)
OPENCLAW_OPTIONAL_METHODS = (
    ("native questions", ("question.list", "question.get", "question.resolve")),
    ("steering", ("sessions.steer",)),
    ("goals", ("sessions.goal.update", "sessions.goal.clear")),
    ("progress cards", ("progressCard.get",)),
    ("inline widgets", ("canvas.document.view",)),
    ("tool catalog", ("tools.catalog",)),
    ("shared browser", ("browser.request",)),
)
# Where the method list comes from: OpenClaw builds features.methods only into
# the hello-ok frame (2026.10.9 message-handler-a7VR9SDC.mjs:2413-2424) and no
# CLI command prints it (`gateway status`/`gateway call` keep only hello.server
# and the auth summary, probe-D0V4xllL.mjs:54-63, call-D6fWfxgB.mjs:560-578).
# Another process would open a second signed socket and displace the backend's,
# so the Portal backend writes the hello it was granted after every
# authenticated connect (backend/src/utils/openclawHelloSnapshot.ts) and toolctl
# reads that snapshot. It counts only when it is a private root-owned file,
# received after this run's restart window opened (or after native finished, for
# a run without one) and from the OpenClaw version now installed.
HELLO_METHODS_UNAVAILABLE = ("No OpenClaw command prints the gateway's method list, and the Portal's gateway client "
                             "only runs inside the Portal backend, so the method list isn't checked in this build.")
OPENCLAW_HELLO_SNAPSHOT_SCHEMA = "bridgesllm.openclaw-hello.v1"
OPENCLAW_HELLO_SNAPSHOT_MAX_BYTES = 256 * 1024  # = the backend writer's bound
HELLO_SNAPSHOT_POLL_SECONDS = 2


def hello_snapshot_anchor(status):
    """(epoch seconds, label) a usable hello must follow, or (None, None) for a run that changed nothing (retry-checks)."""
    gateway = status.get("gateway") if isinstance(status.get("gateway"), dict) else {}
    actions = gateway.get("actions") if isinstance(gateway.get("actions"), list) else []
    started = [parse_ts(a.get("at")) for a in actions if isinstance(a, dict) and a.get("action") == "start"
               and a.get("problem") is None]
    started = [t for t in started if t is not None]
    if started:
        return max(started), "the OpenClaw gateway started again"
    native = status.get("native") if isinstance(status.get("native"), dict) else {}
    pause = native.get("chatPause") if isinstance(native.get("chatPause"), dict) else {}
    marker = status.get("maintenanceMarker") if isinstance(status.get("maintenanceMarker"), dict) else {}
    opened = [t for t in (parse_ts(pause.get("at")), parse_ts(marker.get("publishedAt"))) if t is not None]
    if opened:
        return min(opened), "this run's restart window opened"
    ended = parse_ts(native.get("endedAt"))
    if ended is not None:
        return ended, "OpenClaw's update step finished"
    return None, None


def read_hello_snapshot(path, installed, not_before, anchor=None):
    """One look at the backend's hello snapshot: {state, reason, …}; only state "fresh" carries `methods`.

    States: fresh, absent, stale, wrong-version, unsafe (symlink, not a regular
    file, owner, mode, links, parent), oversize, malformed.
    """
    record = {"path": path}

    def result(state, reason, **values):
        record.update(values, state=state, reason=reason)
        return record
    unused = "so it wasn't used and OpenClaw's method list wasn't checked."
    parent = os.path.dirname(path)
    try:
        info = os.lstat(parent)
    except FileNotFoundError:
        info = None
    except OSError as error:
        return result("unsafe", "The gateway hello snapshot's directory couldn't be read (%s), %s" % (error.strerror, unused))
    if info is not None and (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                             or stat.S_IMODE(info.st_mode) & 0o022):
        return result("unsafe", "%s isn't a root-owned directory closed to group and other writes, %s" % (parent, unused))
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return result("absent", "The Portal backend hasn't recorded a gateway hello yet, so OpenClaw's method list wasn't checked.")
    except OSError as error:
        why = "a symlink" if error.errno == errno.ELOOP else "unreadable (%s)" % error.strerror
        return result("unsafe", "The gateway hello snapshot is %s, %s" % (why, unused))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return result("unsafe", "The gateway hello snapshot isn't a regular file, %s" % unused)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077 or info.st_nlink != 1:
            return result("unsafe", "The gateway hello snapshot isn't a private root-owned file, %s" % unused)
        chunks, size = [], 0
        while size <= OPENCLAW_HELLO_SNAPSHOT_MAX_BYTES:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
    finally:
        os.close(fd)
    if size > OPENCLAW_HELLO_SNAPSHOT_MAX_BYTES:
        return result("oversize", "The gateway hello snapshot is larger than %d bytes, %s" % (OPENCLAW_HELLO_SNAPSHOT_MAX_BYTES, unused))
    try:
        doc = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        doc = None

    def names(value):
        return isinstance(value, list) and all(isinstance(v, str) and len(v) <= 200 for v in value)
    received = parse_ts(doc.get("receivedAt")) if isinstance(doc, dict) else None
    if not isinstance(doc, dict) or doc.get("schema") != OPENCLAW_HELLO_SNAPSHOT_SCHEMA or received is None \
            or not isinstance(doc.get("serverVersion"), str) or not names(doc.get("methods")) or not names(doc.get("events")):
        return result("malformed", "The gateway hello snapshot isn't a %s record, %s" % (OPENCLAW_HELLO_SNAPSHOT_SCHEMA, unused))
    record.update(serverVersion=doc["serverVersion"][:80], receivedAt=doc["receivedAt"])
    if not_before is not None and received <= not_before:
        return result("stale", "The Portal backend hasn't reconnected to OpenClaw since %s, so OpenClaw's method list "
                      "wasn't checked." % (anchor or "this run started"))
    if installed is None or doc["serverVersion"] != installed:
        return result("wrong-version", "The Portal backend's last gateway hello came from OpenClaw %s, not the installed %s, "
                      "so OpenClaw's method list wasn't checked." % (record["serverVersion"], installed or "(unreadable)"))
    return result("fresh", None, methods=doc["methods"])


def hello_snapshot_reader(roots, run, deadline_seconds, sleep=time.sleep, stop=None, poll_seconds=HELLO_SNAPSHOT_POLL_SECONDS):
    """``probe_hello(hello_methods=…)``: the snapshot, polled until fresh within the probe's deadline (from now)."""
    ends = time.monotonic() + deadline_seconds

    def read():
        not_before, anchor = hello_snapshot_anchor(run.status)
        polls = 0
        while True:
            seen = read_hello_snapshot(roots.openclaw_hello_snapshot, installed_openclaw_version(roots), not_before, anchor)
            if seen["state"] == "fresh" or stop or polls >= int(deadline_seconds // poll_seconds) \
                    or time.monotonic() + poll_seconds > ends:
                break
            sleep(poll_seconds)
            polls += 1
        seen.update(anchor=anchor, polls=polls)
        return seen
    return read


def hello_methods_verdict(methods):
    """{state, missing, featuresOff, offered} for one hello `features.methods` list."""
    offered = {m for m in methods if isinstance(m, str)} if isinstance(methods, (list, tuple)) else set()
    missing = [m for m in OPENCLAW_REQUIRED_METHODS if m not in offered]
    off = {feature: [m for m in needed if m not in offered] for feature, needed in OPENCLAW_OPTIONAL_METHODS}
    return {"state": "failed" if missing or not offered else "passed", "missing": missing if offered else
            list(OPENCLAW_REQUIRED_METHODS), "featuresOff": {k: v for k, v in off.items() if v}, "offered": len(offered)}


def gateway_call(roots, service_env, node_path, runner, method, params=None, timeout_ms=PROBE_RPC_TIMEOUT_MS):
    """One bounded `gateway call`; returns {exitCode, doc, text, elapsedMs, problem, replyExceededBytes}.

    A reply past the method's ceiling is never parsed: doc None, text empty, and the problem says so."""
    args = ["gateway", "call", method, "--params", json.dumps(params or {}, separators=(",", ":"), sort_keys=True),
            "--json", "--timeout", str(int(timeout_ms))]
    limit = CONFIG_GET_REPLY_LIMIT_BYTES if method == "config.get" else NATIVE_REPLY_LIMIT_BYTES
    started = time.monotonic()
    try:
        code, out, err = runner(native_argv(node_path, roots.openclaw_bin, args), timeout=timeout_ms / 1000.0 + 30,
                                env=native_env(service_env), limit=limit)
        problem = None
    except subprocess.TimeoutExpired:
        code, out, err, problem = None, "", "", "did not finish in time"
    except (OSError, subprocess.SubprocessError) as error:
        code, out, err, problem = None, "", "", "could not be started: %s" % error
    exceeded = reply_exceeded(out)
    if exceeded:
        out, problem = "", "%s's reply exceeded %d bytes" % (method, exceeded)
    return {"method": method, "exitCode": code, "doc": parse_json_output(out), "text": (out or "") + "\n" + (err or ""),
            "elapsedMs": int((time.monotonic() - started) * 1000), "problem": problem, "replyExceededBytes": exceeded}


def probe_attempts(attempt, deadline_seconds, attempts=PROBE_ATTEMPTS, backoff=PROBE_BACKOFF_SECONDS, sleep=time.sleep,
                   stop=None):
    """Run ``attempt()`` → (passed, record) up to ``attempts`` times within the deadline (c.5 retry rule)."""
    started = time.monotonic()
    records, last_duration = [], 0.0
    for index in range(attempts):
        if index and (stop or time.monotonic() - started + last_duration + backoff * index > deadline_seconds):
            break
        if index:
            sleep(backoff * index)
        began = time.monotonic()
        passed, record = attempt()
        last_duration = time.monotonic() - began
        records.append(record)
        if passed:
            return True, records
        if record.get("replyExceededBytes"):
            break  # a reply past its ceiling won't shrink on a retry
    return False, records


def unproven_reason(records, what):
    """The reason a probe whose reply exceeded its ceiling is unproven, or None."""
    exceeded = next((r["replyExceededBytes"] for r in records if r.get("replyExceededBytes")), None)
    return ("%s's reply exceeded %d bytes, so the Portal couldn't read the answer" % (what, exceeded)
            if exceeded else None)


def probe_hello(roots, service_env, node_path, runner, floor, deadline_seconds, stop=None, sleep=time.sleep,
                hello_methods=None):
    """OC-HELLO: the gateway's hello `server.version` is at least the floor, and (when a hello
    method list is available: ``hello_methods()`` → list|None, or a `read_hello_snapshot` record)
    it offers every required method."""
    def attempt():
        argv = native_argv(node_path, roots.openclaw_bin, ["gateway", "status", "--require-rpc", "--json"])
        try:
            code, out, _err = runner(argv, timeout=GATEWAY_STATUS_TIMEOUT, env=native_env(service_env),
                                     limit=NATIVE_REPLY_LIMIT_BYTES)
        except (OSError, subprocess.SubprocessError) as error:
            return False, {"exitCode": None, "problem": str(error)[:200]}
        if reply_exceeded(out):
            return False, {"exitCode": code, "problem": "its reply exceeded %d bytes" % reply_exceeded(out),
                           "replyExceededBytes": reply_exceeded(out)}
        doc = parse_json_output(out)
        rpc = doc.get("rpc") if isinstance(doc, dict) and isinstance(doc.get("rpc"), dict) else {}
        server = rpc.get("server") if isinstance(rpc.get("server"), dict) else {}
        version = server.get("version") if isinstance(server.get("version"), str) else rpc.get("version")
        version = version if isinstance(version, str) and parse_version(version) else None
        ok = code == 0 and rpc.get("ok") is True and version is not None and compare_versions(version, floor) >= 0
        return ok, {"exitCode": code, "rpcOk": rpc.get("ok"), "serverVersion": version}
    passed, records = probe_attempts(attempt, deadline_seconds, sleep=sleep, stop=stop)
    found = hello_methods() if hello_methods is not None and passed else None
    snapshot = found if isinstance(found, dict) else None
    methods = (snapshot.get("methods") if snapshot.get("state") == "fresh" else None) if snapshot is not None else found
    if methods is not None:
        verdict = hello_methods_verdict(methods)
    elif not passed:
        verdict = {"state": "not-run", "reason": "The gateway's hello didn't pass, so its method list wasn't checked."}
    else:
        verdict = {"state": "not-run", "reason": snapshot["reason"] if snapshot is not None else HELLO_METHODS_UNAVAILABLE}
    if snapshot is not None:
        verdict["source"] = {k: v for k, v in snapshot.items() if k not in ("methods", "reason")}
    record = {"state": "passed" if passed and verdict["state"] != "failed" else "failed", "floor": floor, "attempts": records,
              "methods": verdict}
    unproven = None if passed else unproven_reason(records, "gateway status")
    if unproven:
        record.update(state="unproven", reason=unproven)
    elif not passed:
        last = records[-1] if records else {}
        record["reason"] = ("OpenClaw %s is older than the floor %s" % (last["serverVersion"], floor) if last.get("serverVersion")
                            else "the gateway's hello didn't report a version")
    elif verdict["state"] == "failed":
        record["reason"] = "OpenClaw doesn't offer %s" % ", ".join(verdict["missing"][:6])
    return record


def probe_config(roots, service_env, node_path, runner, deadline_seconds, stop=None, sleep=time.sleep):
    """OC-CONFIG: `config.get` answers with a valid config. Only key names are kept, never values."""
    def attempt():
        call = gateway_call(roots, service_env, node_path, runner, "config.get")
        doc = call["doc"] if isinstance(call["doc"], dict) else {}
        config = doc.get("config") if isinstance(doc.get("config"), dict) else None
        ok = call["exitCode"] == 0 and config is not None and doc.get("valid") is not False and doc.get("exists") is not False
        return ok, {"exitCode": call["exitCode"], "elapsedMs": call["elapsedMs"], "problem": call["problem"],
                    "replyExceededBytes": call["replyExceededBytes"], "valid": doc.get("valid"), "exists": doc.get("exists"),
                    "configKeys": sorted(str(k)[:64] for k in config)[:50] if config is not None else None}
    passed, records = probe_attempts(attempt, deadline_seconds, sleep=sleep, stop=stop)
    record = {"state": "passed" if passed else "failed", "attempts": records,
              "patchDryRun": {"state": "not-run", "reason": "The planned Portal config.patch list isn't in this build."}}
    unproven = None if passed else unproven_reason(records, "config.get")
    if unproven:
        # Unread is not "no config": the check is unproven, not failed.
        record.update(state="unproven", reason=unproven)
    elif not passed:
        record["reason"] = "config.get didn't answer with a valid configuration"
    return record


def probe_plugin_ask(roots, service_env, node_path, runner, plugin_row, deadline_seconds, stop=None, sleep=time.sleep):
    """OC-PLUG-ASK: the plugin is loaded at the bundled version and its gateway method answers."""
    record = {"plugin": plugin_row}
    if plugin_row is None or not plugin_row.get("healthy"):
        record.update(state="failed", reason="bridgesllm-ask-user is not in this release's plugin manifest" if plugin_row is None
                      else "bridgesllm-ask-user is not loaded at its bundled version: %s" % plugin_row.get("problem"))
        return record

    def attempt():
        call = gateway_call(roots, service_env, node_path, runner, ASK_USER_STEER_METHOD)
        answered = ASK_USER_STEER_INVALID in call["text"]
        return answered, {"exitCode": call["exitCode"], "elapsedMs": call["elapsedMs"], "problem": call["problem"],
                          "replyExceededBytes": call["replyExceededBytes"], "answered": answered,
                          "output": tail_text(call["text"], 300)}
    passed, records = probe_attempts(attempt, deadline_seconds, sleep=sleep, stop=stop)
    record.update(state="passed" if passed else "failed", method=ASK_USER_STEER_METHOD, attempts=records)
    unproven = None if passed else unproven_reason(records, ASK_USER_STEER_METHOD)
    if unproven:
        record.update(state="unproven", reason=unproven)
    elif not passed:
        record["reason"] = "the plugin's gateway method %s didn't answer" % ASK_USER_STEER_METHOD
    return record


def run_contract(roots, run, policy, service_env, node_path, exec_start, runner, http_get, post_rows, settle, stop=None):
    """c.4: OC-READY, then OC-HELLO, OC-CONFIG and OC-PLUG-ASK; optional probes are recorded as not run.

    A probe whose reply couldn't be read is ``unproven`` (with its reason), never passed or failed."""
    tool = policy_tool(policy, "openclaw")
    passed, failed, not_run, unproven = [], [], [], {}
    ready = probe_ready(roots, service_env, node_path, exec_start, runner, http_get,
                        settle.get("ready_wait_seconds", READY_WAIT_SECONDS), settle.get("ready_interval_seconds", READY_INTERVAL_SECONDS),
                        stop=stop)
    write_probe(run, "OC-READY", ready)
    {"passed": passed, "failed": failed}.get(ready["state"], not_run).append("OC-READY")
    deadline = settle.get("probe_deadline_seconds", PROBE_RPC_TIMEOUT_MS / 1000.0 * PROBE_ATTEMPTS)
    sleep = settle.get("probe_sleep", time.sleep)
    ask = next((r for r in post_rows if r.get("id") == ASK_USER_PLUGIN_ID), None)
    probes = (
        ("OC-HELLO", lambda: probe_hello(roots, service_env, node_path, runner, tool["floor"], deadline, stop=stop, sleep=sleep,
                                         hello_methods=hello_snapshot_reader(roots, run, deadline, sleep=sleep, stop=stop))),
        ("OC-CONFIG", lambda: probe_config(roots, service_env, node_path, runner, deadline, stop=stop, sleep=sleep)),
        ("OC-PLUG-ASK", lambda: probe_plugin_ask(roots, service_env, node_path, runner, ask, deadline, stop=stop, sleep=sleep)),
    )
    features_off, missing_methods, methods = {}, [], {"state": "not-run", "reason": "OpenClaw wasn't ready."}
    for probe_id, probe in probes:
        if ready["state"] == "passed":
            record = probe()
        elif probe_id == "OC-PLUG-ASK" and (ask is None or not ask.get("healthy")):
            record = probe()  # fails on the plugin inspection alone; no RPC is made
        else:
            # No RPC probe declares failure while the gateway isn't ready (c.5).
            record = {"state": "not-run", "reason": "OpenClaw wasn't ready."}
        write_probe(run, probe_id, record)
        if record["state"] == "unproven":
            unproven[probe_id] = record["reason"]
        else:
            {"passed": passed, "failed": failed}.get(record["state"], not_run).append(probe_id)
        if probe_id == "OC-HELLO" and isinstance(record.get("methods"), dict):
            features_off = record["methods"].get("featuresOff") or {}
            missing_methods = record["methods"].get("missing") or [] if record["methods"].get("state") == "failed" else []
            methods = {k: record["methods"][k] for k in ("state", "reason") if record["methods"].get(k) is not None}
    for probe_id in tool["probes"]["optional"]:
        write_probe(run, probe_id, {"state": "not-run", "reason": "Optional probes are not in this Portal build."})
        not_run.append(probe_id)
    return {"passed": passed, "failed": failed, "notRun": not_run, "unproven": sorted(unproven),
            "unprovenReasons": unproven, "missingMethods": missing_methods, "featuresOff": features_off, "methods": methods}


def update_node_runtime(roots, run, plan, engines, runner, stop):
    """c.2.0: upgrade the NodeSource nodejs package within its major; never stops the gateway.

    Returns (new version, None) or (None, error). dpkg replaces /usr/bin/node by
    rename; the running gateway keeps its old inode until the native restart.
    """
    source = nodesource_source_file(roots)
    if source is None:
        return None, {"id": "NODE_RUNTIME_SOURCE_MISSING", "message": "The NodeSource package source is gone. Nothing was changed."}
    lists = ["-o", "APT::Get::List-Cleanup=0"]
    if source.endswith(".sources"):
        parts = os.path.join(roots.tmp_dir, run.run_id, "apt-sources")
        ensure_private_dir(os.path.dirname(parts))
        ensure_private_dir(parts)
        with open(source, "rb") as handle:
            data = handle.read(64 * 1024)
        with open(os.path.join(parts, "nodesource.sources"), "wb") as handle:
            handle.write(data)
        lists = ["-o", "Dir::Etc::sourcelist=/dev/null", "-o", "Dir::Etc::sourceparts=" + parts] + lists
    else:
        lists = ["-o", "Dir::Etc::sourcelist=" + source, "-o", "Dir::Etc::sourceparts=-"] + lists
    apt_env = {"DEBIAN_FRONTEND": "noninteractive", "HOME": "/root"}
    evidence = {"source": source, "commands": []}
    try:
        return _update_node_runtime(roots, run, plan, engines, runner, stop, lists, apt_env, evidence)
    finally:
        if source.endswith(".sources"):
            for path in (os.path.join(parts, "nodesource.sources"), parts):
                try:
                    os.unlink(path) if path.endswith(".sources") else os.rmdir(path)
                except OSError:
                    pass


def _update_node_runtime(roots, run, plan, engines, runner, stop, lists, apt_env, evidence):
    try:
        code, _out, err = runner([roots.apt_get_bin, "update"] + lists, timeout=APT_LIST_TIMEOUT, env=apt_env)
        evidence["commands"].append({"argv": ["apt-get", "update"] + lists, "exitCode": code, "stderr": tail_text(err)})
        if code != 0:
            return None, {"id": "NODE_RUNTIME_LIST_FAILED", "message": "The NodeSource package list couldn't be refreshed. Nothing was changed.",
                          "detail": evidence}
        code, out, err = runner([roots.apt_cache_bin, "madison", "nodejs"], timeout=60, env=apt_env)
    except (OSError, subprocess.SubprocessError) as error:
        return None, {"id": "NODE_RUNTIME_LIST_FAILED", "message": "The NodeSource package list couldn't be refreshed. Nothing was changed.",
                      "detail": {"reason": str(error)[:300]}}
    choice = choose_node_upgrade(nodesource_candidates(out), plan["from"], engines) if code == 0 else None
    evidence["candidates"] = [c[0] for c in nodesource_candidates(out)][:20]
    if choice is None:
        return None, {"id": "NODE_RUNTIME_UNAVAILABLE",
                      "message": "NodeSource offers no Node.js %s.x that satisfies OpenClaw's requirement (%s) for this system. Nothing was changed."
                      % (parse_version(plan["from"])[0][0], engines), "detail": evidence}
    evidence["chosen"] = {"version": choice[0], "package": choice[1]}
    argv = [roots.apt_get_bin, "install", "-y", "--only-upgrade", "--no-install-recommends", "nodejs=" + choice[1]]
    env = {"PATH": CLEAN_PATH, "LANG": "C.UTF-8", "DEBIAN_FRONTEND": "noninteractive", "HOME": "/root"}
    log = os.path.join(run.dir, "node-runtime-apt.log")
    exit_code, _pid = supervise_child(argv, env, log, log, stop, forward_stop=False)
    evidence["commands"].append({"argv": argv[1:], "exitCode": exit_code})
    run.write_evidence("node-runtime.json", evidence)
    version, problem = node_version_of(plan["path"], runner=runner)
    if exit_code != 0 or version is None or not satisfies(version, engines):
        return None, {"id": "NODE_RUNTIME_UNVERIFIED",
                      "message": "Node.js could not be confirmed at a version OpenClaw accepts (%s). OpenClaw was not changed." % engines,
                      "detail": {"exitCode": exit_code, "version": version, "reason": problem}}
    return version, None


def execute_update(roots, run, policy, request, report, result, runner, stop, progress, http_get=http_get_status):
    """c.2: native update and its outcome. Pre-flight has passed and both locks are held."""
    progress = dict(progress or {})
    settle = {k: progress.pop(k) for k in SETTLE_KEYS if k in progress}
    drain = {k: progress.pop(k) for k in ("drain_seconds",) if k in progress}
    facts = report["facts"]
    target = (facts.get("target") or {}).get("version")
    channel = request.get("channel") or policy["openclaw"]["defaultChannel"]
    tag = (facts.get("target") or {}).get("tag")
    unit_path, dropins = _unit_files(roots, policy["openclaw"]["gatewayService"])
    service_env = parse_unit_service_section([unit_path] + dropins)["Environment"] if unit_path else {}
    node_path = (facts.get("gatewayNode") or {}).get("path")
    result = dict(result, targetVersion=target)
    if stop:
        return stop_before_change(run, stop, result=result)
    if not node_path or not target:
        run.finish("failed", error={"id": "GATEWAY_NODE_UNKNOWN", "message": "The gateway's Node.js or the target version "
                                    "wasn't resolved, so OpenClaw can't be updated. Nothing was changed."}, result=result)
        return run.status
    # L3: from here until verification the Portal starts no OpenClaw CLI reader; chat
    # pauses only once native reaches its restart window.
    run.quiesce = DiagnosticQuiesce(roots, run, policy["openclaw"]["gatewayService"], stop=stop, **drain)
    problem = run.quiesce.publish()
    if problem is not None:
        if problem["id"] == "TOOLS_RUN_STOPPED":
            return stop_before_change(run, stop, result=result)
        run.finish("failed", error=problem, result=result)
        return run.status
    plan = facts.get("nodeRuntime")
    if plan:
        run.transition("node-runtime", "running")
        step = run.step_start("node-runtime", "Updating Node.js runtime")
        version, error = update_node_runtime(roots, run, plan, (facts.get("target") or {}).get("enginesNode"), runner, stop)
        result = dict(result, nodeRuntime={"from": plan["from"], "to": version})
        if error is not None:
            run.step_end(step, "failed", detail=error["message"], evidence=["node-runtime.json"]
                         if path_present(os.path.join(run.dir, "node-runtime.json")) else None)
            run.finish("failed", error=error, result=result)
            return run.status
        run.step_end(step, "passed", detail="Node.js %s → %s." % (plan["from"], version), evidence=["node-runtime.json"])
        if stop:
            run.status["stop"] = stop.record()
            run.finish("failed", error={"id": "TOOLS_RUN_STOPPED", "message": "The run was stopped after Node.js was updated to %s. "
                                        "OpenClaw was not changed." % version}, result=result)
            return run.status
        # PF-11 again, now on the new Node.js: OpenClaw's own dry run must accept the target.
        gate = Preflight(roots, policy, target=request["target"], channel=channel, runner=runner, http_get=http_get)
        gate.service_env, gate.facts["target"] = service_env, facts.get("target")
        gate.gateway_node = {"path": node_path, "version": version, "problem": None}
        gate.facts["installedVersion"] = facts.get("installedVersion")
        gate.dry_run_gate(channel, facts.get("target"))
        dry_run = run.write_evidence("dry-run-after-node.json", {"checks": gate.checks, "facts": gate.facts})
        if gate.facts.get("updateMode"):
            facts["updateMode"] = gate.facts["updateMode"]  # PF-11 was deferred: its update mode comes from here
        if gate.refusals:
            first = gate.refusals[0]
            run.finish("failed", error={"id": first["id"], "message": "Node.js was updated to %s. %s OpenClaw was not changed." % (
                version, first["message"]), "refusals": gate.refusals, "evidence": dry_run}, result=result)
            return run.status
    if stop:
        return stop_before_change(run, stop, result=result)
    if not isinstance(facts.get("updateMode"), dict):
        # plugins-pre changes OpenClaw (it installs and enables plugins): only once OpenClaw's own dry run
        # accepted this update, which is what records the update mode (N4).
        run.finish("refused", error={"id": "PF11_NOT_ADMITTED", "message": "OpenClaw's own update check didn't accept "
                                     "this update, so it can't start. Nothing was changed."}, result=result)
        return run.status
    run.transition("plugins-pre", "running")
    step = run.step_start("plugins-pre", "Preparing Portal plugins")
    error, evidence = plugins_pre(roots, run, service_env, node_path, runner)
    changes = plugins_pre_changes(run.status)
    if changes:
        result = dict(result, pluginsInstalled=changes)
    if error is not None:
        run.step_end(step, "failed", detail=error["message"], evidence=[evidence] if evidence else None)
        run.finish("failed", error=error, result=result)
        return run.status
    run.step_end(step, "passed", detail="Portal plugins match this Portal version%s." % (
        "; they take effect when the gateway restarts for the update"
        if (run.status.get("pluginsPre") or {}).get("reload") == "restart-required" else ""), evidence=[evidence])
    if stop:
        run.status["stop"] = stop.record()
        run.finish("failed", error={"id": "TOOLS_RUN_STOPPED", "message": report_prior_changes(
            "The run was stopped before OpenClaw was updated. Nothing was changed.", changes)}, result=result)
        return run.status
    exec_start = parse_unit_service_section([unit_path] + dropins)["ExecStart"] if unit_path else None
    mode = (facts.get("updateMode") or {}).get("mode")
    if mode not in (UPDATE_MODE_LIVE, UPDATE_MODE_STOPPED):
        mode = UPDATE_MODE_STOPPED  # unknown: the documented safe order (stop, update, start)
    result = dict(result, updateMode=dict(facts.get("updateMode") or {}, mode=mode))
    core = CoreUpdate(roots, run, policy, service_env, node_path, exec_start, runner, http_get, settle, stop, progress,
                      facts.get("installedVersion"), target, result)
    run.transition("native", "running")
    if mode == UPDATE_MODE_STOPPED:
        problem = core.park("OpenClaw updates with the gateway stopped; chat is unavailable until the update finishes")
        if problem is not None:
            return core.finish_unchanged("failed", {"id": "GATEWAY_STOP_FAILED", "nextAction": "openclaw-status",
                                                    "message": "The OpenClaw gateway couldn't be stopped for the update (%s). "
                                                               "OpenClaw wasn't changed." % problem})
        if stop:
            return core.finish_unchanged("failed", {"id": "TOOLS_RUN_STOPPED",
                                                    "message": "The run was stopped before OpenClaw was updated. Nothing was changed."})
    step = run.step_start("native", "OpenClaw is updating")
    native = core.native = NativeUpdate(roots, run, service_env, node_path, runner, stop, on_window=run.quiesce.pause_chat,
                                        on_activating=core.park_for_activation if mode == UPDATE_MODE_LIVE else None,
                                        **progress)
    native.gateway_parked = mode == UPDATE_MODE_STOPPED  # mode B: parked already; poll gently from the start
    mapped, installed_after, evidence = native.execute(channel, tag, facts.get("installedVersion"), target)
    core.result = dict(core.result, to=installed_after, native={k: mapped["native"].get(k) for k in
                                                                ("runId", "status", "phase", "reason", "nextAction", "exitCode")})
    if native.gateway_stop_failed is not None:
        # Mode A: the switch-over stop failed. Nothing else touches the gateway; recover-native is the one action (P7).
        message = core.switch_over_stop_message(native.gateway_stop_failed,
                                                (run.status.get("native") or {}).get("gatewayStop") or {})
        run.step_end(step, "failed", detail=message, evidence=evidence)
        if stop:
            run.status["stop"] = stop.record()
        return core.recovery("GATEWAY_STOP_FAILED_AT_SWITCH_OVER", message,
                             detail={"native": mapped["native"], "nativeOutcome": mapped["state"]})
    step_state = {"succeeded": "passed", "succeeded-degraded": "passed", "refused": "failed"}.get(mapped["state"], "failed")
    detail = (mapped["error"] or {}).get("message") or mapped["degraded"] \
        or "OpenClaw finished: %s." % (mapped["native"].get("status") or "unknown")
    if (mapped["error"] or {}).get("id") == "NATIVE_MAINTENANCE_PENDING":
        step_state, detail = "passed", "OpenClaw %s was installed; its maintenance finishes next, with the gateway stopped." % (
            installed_after or target)
    run.step_end(step, step_state, detail=detail, evidence=evidence)
    if stop:
        run.status["stop"] = stop.record()
    return core.after_native(mapped, installed_after)


class CoreUpdate(object):
    """The K7 sequence around one native core update: park the gateway, then after native has exited
    repair if maintenance is unfinished, start, wait ready, verify; on failure, native's managed rollback.

    Every terminal path either leaves the unit started or ends recovery-required with the one recovery
    action (P7), recover-native.
    """

    def __init__(self, roots, run, policy, service_env, node_path, exec_start, runner, http_get, settle, stop, progress,
                 installed_before, target, result):
        self.roots = roots
        self.run = run
        self.policy = policy
        self.service_env = service_env
        self.node_path = node_path
        self.exec_start = exec_start
        self.runner = runner
        self.http_get = http_get
        self.settle = settle
        self.stop = stop
        self.progress = progress
        self.installed_before = installed_before
        self.target = target
        self.result = result
        self.native = None
        self.gateway = run.gateway = GatewayUnit(roots, run, policy["openclaw"]["gatewayService"], runner)

    def park(self, reason):
        """Pause chat, then stop the gateway unit and wait for it to exit. Returns None or a problem string."""
        if self.run.quiesce is not None:
            self.run.quiesce.pause_chat(reason)
        step = self.run.step_start("gateway-stop", "Stopping the OpenClaw gateway")
        problem = self.gateway.stop()
        self.run.step_end(step, "failed" if problem else "passed", detail=problem or "Stopped: %s." % reason)
        return problem

    def park_for_activation(self, window):
        """Mode A: native reached its switch-over; the gateway must exit before the package swap."""
        return self.park("OpenClaw is switching over (%s)" % window)

    def switch_over_stop_message(self, problem, record):
        """What happened when the unit didn't stop at native's switch-over."""
        running = " The gateway is still running." if self.gateway.state() in GATEWAY_RUNNING_STATES else ""
        if record.get("nativeStopped"):
            return ("The OpenClaw gateway couldn't be stopped for the switch-over (%s), so the Portal stopped OpenClaw's "
                    "update before it replaced the installed version.%s" % (problem, running))
        return ("The OpenClaw gateway couldn't be stopped for the switch-over (%s) after OpenClaw had begun replacing its "
                "installation; OpenClaw's update ran to its end with the old gateway still running.%s" % (problem, running))

    def start_ready(self, label):
        return start_gateway_ready(self.run, self.gateway, self.roots, self.service_env, self.node_path, self.exec_start,
                                   self.runner, self.http_get, self.settle, label)

    def repair(self, tag_name=""):
        step = self.run.step_start("native-repair", "Finishing OpenClaw maintenance")
        native = NativeUpdate(self.roots, self.run, self.service_env, self.node_path, self.runner, self.stop,
                              status_key="nativeRepair", **self.progress)
        doc, status_doc, exit_code, evidence = native.repair(tag_name)
        mapped = map_native_repair(exit_code, doc, status_doc)
        self.run.step_end(step, "passed" if mapped["state"] == "succeeded" else "failed",
                          detail=(mapped["error"] or {}).get("message") or "OpenClaw finished its maintenance.",
                          evidence=evidence)
        return mapped

    def gateway_tail(self):
        return " The OpenClaw gateway is stopped; run OpenClaw repair." if self.gateway.state() in GATEWAY_STOPPED_STATES \
            else " Run OpenClaw repair."

    def recovery(self, error_id, message, detail=None):
        """Terminal recovery-required with the one recovery action, saying whether the gateway is down."""
        self.run.finish("recovery-required", error={"id": error_id, "nextAction": "recover-native",
                                                    "message": message + self.gateway_tail(), "detail": detail},
                        result=dict(self.result, to=installed_openclaw_version(self.roots)))
        return self.run.status

    def finish_unchanged(self, state, error):
        """Native changed nothing: start the gateway again if toolctl stopped it, then finish ``state``.
        What plugins-pre installed before is said, never "Nothing was changed" (N4)."""
        error = dict(error or {})
        changes = plugins_pre_changes(self.run.status)
        if changes:
            error["message"] = report_prior_changes(error.get("message") or "OpenClaw wasn't updated.", changes, append=True)
        if self.gateway.stopped_by_us:
            problem = self.start_ready("Starting OpenClaw %s again" % (self.installed_before or ""))
            if problem:
                return self.recovery("GATEWAY_RESTART_FAILED", "%s The gateway was stopped for the update and didn't start "
                                     "again: %s." % (error.get("message") or "OpenClaw wasn't updated.", problem),
                                     detail={"failure": error})
            error["message"] = "%s Chat is available again." % (error.get("message") or "OpenClaw wasn't updated.")
        self.run.finish(state, error=error or None, result=self.result)
        return self.run.status

    def needs_repair(self, mapped):
        if mapped["state"] == "recovery-required":
            return True
        native = self.native
        if native is not None and native_recovery_pending(getattr(native, "status_after", None)) is not None:
            return True
        post = (getattr(native, "result_doc", None) or {}).get("postUpdate") if native is not None else None
        doctor = post.get("doctor") if isinstance(post, dict) and isinstance(post.get("doctor"), dict) else {}
        return doctor.get("status") in ("warning", "skipped", "failed", "error")

    def after_native(self, mapped, installed_after):
        state, error = mapped["state"], mapped["error"]
        if state == "refused":
            return self.finish_unchanged("refused", error)
        if state == "rolled-back":
            # Native returned to the previous package itself; with --no-restart nobody has started it.
            if self.gateway.stopped_by_us or self.gateway.state() not in GATEWAY_RUNNING_STATES:
                problem = self.start_ready("Starting OpenClaw %s again" % (installed_after or ""))
                if problem:
                    return self.recovery("ROLLBACK_START_FAILED", "%s It didn't start again: %s." % (error["message"], problem),
                                         detail={"failure": error})
            self.run.finish("rolled-back", error=error, result=self.result)
            return self.run.status
        # The package may have been replaced: the new version starts only once its maintenance is complete.
        if not (self.gateway.stopped_by_us and self.gateway.state() in GATEWAY_STOPPED_STATES):
            problem = self.park("OpenClaw is finishing its update")
            if problem:
                return self.recovery("GATEWAY_STOP_FAILED", "OpenClaw was updated, but its gateway couldn't be stopped to "
                                     "finish the update: %s." % problem, detail={"native": mapped["native"]})
        repair_needed = self.needs_repair(mapped)
        if self.stop:
            if repair_needed:
                return self.recovery("TOOLS_RUN_STOPPED_BEFORE_REPAIR", "The run was stopped before OpenClaw's maintenance "
                                     "finished.", detail={"native": mapped["native"]})
            problem = self.start_ready("Starting OpenClaw %s" % (installed_after or ""))
            if problem:
                return self.recovery("GATEWAY_START_FAILED", "The run was stopped, and OpenClaw %s didn't start: %s."
                                     % (installed_after, problem))
            self.run.finish("succeeded-degraded", error={
                "id": "TOOLS_RUN_STOPPED_BEFORE_CHECKS", "nextAction": "retry-checks",
                "message": "OpenClaw finished updating, but the run was stopped before the Portal's plugin and feature checks ran."},
                result=self.result)
            return self.run.status
        if repair_needed:
            repaired = self.repair()
            if repaired["state"] != "succeeded":
                lead = "%s " % error["message"] if state == "recovery-required" and (error or {}).get("message") else ""
                return self.rollback({"id": repaired["error"]["id"], "message": "%sOpenClaw's maintenance after the update "
                                      "didn't finish (%s)." % (lead, repaired["error"]["message"].rstrip("."))})
        problem = self.start_ready("Starting OpenClaw %s" % (installed_after or ""))
        if problem:
            return self.rollback({"id": "GATEWAY_START_FAILED", "message": "OpenClaw %s didn't start: %s." % (installed_after, problem)})
        result, contract, post_rows = verify_portal(self.roots, self.run, self.policy, self.service_env, self.node_path,
                                                    self.exec_start, self.runner, self.http_get, self.settle, self.stop,
                                                    self.result)
        self.result = result
        if contract_needs_rollback(contract):
            # It started and became ready before its checks failed: a rollback that can't change
            # anything starts it again rather than leave chat down.
            return self.rollback({"id": "CONTRACT_REQUIRED_PROBE_FAILED", "message": "OpenClaw %s started, but its checks "
                                  "failed (%s)." % (installed_after, ", ".join(contract["failed"])),
                                  "detail": {"failed": contract["failed"], "missingMethods": contract.get("missingMethods")}},
                                 ready=installed_openclaw_version(self.roots))
        installed_now = installed_openclaw_version(self.roots)
        if installed_now != self.target:
            self.run.finish("failed", error={"id": "NATIVE_NOT_UPDATED", "nextAction": None, "message":
                                             "OpenClaw wasn't updated (%s); OpenClaw %s is running and chat works." % (
                                                 (error or {}).get("message") or "it reported no change", installed_now)},
                            result=dict(result, to=installed_now))
            return self.run.status
        state = "succeeded" if state == "recovery-required" else state
        if state == "succeeded-degraded":
            error = {"id": "NATIVE_READINESS_UNVERIFIED", "message": mapped["degraded"], "nextAction": "openclaw-status"}
        else:
            error = None
        state, error = contract_outcome(state, error, contract, post_rows)
        self.run.finish(state, error=error, result=result)
        return self.run.status

    def rollback(self, failure, ready=None):
        """Native's managed rollback for a package install, with --no-restart and the gateway stopped:
        `openclaw update --tag <previous> --dry-run`, then `openclaw update --tag <previous>`
        (install/updating/rollback-and-recovery.md "Downgrade": "For a target that can read the current
        state, preview and use the managed rollback path"; native refuses a target that can't read the
        migrated state, rollback-and-recovery.md 26-32). Then start and wait for readiness. Finishes the run.

        ``ready`` is the version that started and became ready before its checks failed. When the return
        is refused or fails before the package was touched, that version starts again (chat comes back)
        and the run ends recovery-required with Retry checks. A version that never became ready stays
        stopped (recover-native).
        """
        previous = self.installed_before
        why = failure["message"]
        self.run.transition("native", "running")
        step = self.run.step_start("rollback", "Returning to OpenClaw %s" % (previous or "the previous version"))

        def stuck(error_id, message, detail=None, untouched=None):
            """``untouched``: why the Portal couldn't return, given only when nothing was changed."""
            self.run.step_end(step, "failed", detail=message)
            if untouched is not None and ready and installed_openclaw_version(self.roots) == ready:
                return self.resume_ready(ready, failure, error_id, untouched, detail)
            return self.recovery(error_id, "%s %s" % (why, message), detail=dict(detail or {}, failure=failure))

        quiesce = self.run.quiesce
        if quiesce is not None and not quiesce.published:
            # Verification had resumed Portal diagnostics (a probe failed): quiet their OpenClaw readers
            # again before native's rollback works on the state (L3). A busy reader doesn't block recovery.
            problem = quiesce.publish()
            if problem is not None:
                self.run.status["rollbackQuiesce"] = {"problem": problem.get("message")}
        if quiesce is not None:
            quiesce.pause_chat("returning to the previous OpenClaw version")
        problem = self.gateway.stop()
        if problem:
            return stuck("ROLLBACK_GATEWAY_STOP_FAILED", "The gateway couldn't be stopped to return to the previous version: %s."
                         % problem)
        installed_now = installed_openclaw_version(self.roots)
        if not previous or not VERSION_RE.fullmatch(previous):
            return stuck("ROLLBACK_PREVIOUS_UNKNOWN", "The previous OpenClaw version isn't known, so the Portal can't return to it.",
                         untouched="the previous version isn't known")
        if installed_now == previous:
            # The package never changed (native stopped before its swap, which precedes Doctor's
            # migrations): the previous version starts again as it was; native's recovery stays open.
            problem = self.start_ready("Starting OpenClaw %s again" % previous)
            if problem:
                return stuck("ROLLBACK_START_FAILED", "OpenClaw %s didn't start again: %s." % (previous, problem))
            self.run.step_end(step, "passed", detail="OpenClaw %s is running again." % previous)
            return self.recovery("UPDATE_NOT_APPLIED", "%s OpenClaw stayed on %s and is running again, but its own update "
                                 "recovery is unfinished." % (why, previous), detail={"failure": failure})
        gate = Preflight(self.roots, self.policy, target=None, runner=self.runner, holding_tools_lock=True, http_get=self.http_get)
        gate.service_env = self.service_env
        gate.gateway_node = {"path": self.node_path, "version": None, "problem": None}
        gate.facts["installedVersion"] = installed_now
        gate.dry_run_gate("stable", {"version": previous}, tag=previous)
        evidence = self.run.write_evidence("rollback-dry-run.json", {"checks": gate.checks, "facts": gate.facts,
                                                                    "refusals": gate.refusals})
        if gate.refusals:
            return stuck("ROLLBACK_REFUSED", "OpenClaw won't return to %s: %s" % (previous, gate.refusals[0]["message"]),
                         detail={"evidence": evidence}, untouched=gate.refusals[0]["message"])
        native = NativeUpdate(self.roots, self.run, self.service_env, self.node_path, self.runner, self.stop,
                              status_key="nativeRollback", **self.progress)
        mapped, installed_after, _evidence = native.execute("stable", previous, installed_now, previous, tag_name="-rollback")
        if mapped["state"] == "recovery-required" and (mapped["error"] or {}).get("id") == "NATIVE_MAINTENANCE_PENDING" \
                and installed_after == previous:
            repaired = self.repair("-rollback")
            if repaired["state"] != "succeeded":
                return stuck("ROLLBACK_REPAIR_FAILED", "OpenClaw %s was restored, but its maintenance didn't finish (%s)."
                             % (previous, repaired["error"]["message"].rstrip(".")))
        elif mapped["state"] != "succeeded" or installed_after != previous:
            reason = (mapped["error"] or {}).get("message") or "OpenClaw is %s." % (installed_after or "unknown")
            # Native refused before changing anything ("Nothing was changed"): the package is as it was.
            return stuck("ROLLBACK_FAILED", "Returning to OpenClaw %s failed: %s" % (previous, reason),
                         detail={"native": mapped["native"]}, untouched=reason if mapped["state"] == "refused" else None)
        problem = self.start_ready("Starting OpenClaw %s again" % previous)
        if problem:
            return stuck("ROLLBACK_START_FAILED", "OpenClaw %s was restored but didn't start: %s." % (previous, problem))
        self.run.step_end(step, "passed", detail="OpenClaw %s is running again." % previous)
        self.run.finish("rolled-back", error={"id": "UPDATE_ROLLED_BACK", "nextAction": None,
                                              "message": "%s The Portal returned OpenClaw to %s; chat is working again."
                                                         % (why, previous), "detail": {"failure": failure}},
                        result=dict(self.result, to=previous, rolledBackTo=previous))
        return self.run.status

    def resume_ready(self, version, failure, error_id, reason, detail):
        """The rollback changed nothing and ``version`` had been ready: start it again, then end
        recovery-required with the gateway running and Retry checks as the one action (P7). If it
        doesn't start again it stays stopped with recover-native."""
        previous = self.installed_before or "the previous version"
        detail = dict(detail or {}, failure=failure)
        problem = self.start_ready("Starting OpenClaw %s again" % version)
        if problem:
            return self.recovery(error_id, "%s The Portal couldn't return to %s (%s), and OpenClaw %s didn't start again: %s."
                                 % (failure["message"], previous, reason.rstrip("."), version, problem), detail=detail)
        failed = (failure.get("detail") or {}).get("failed") or []
        self.run.finish("recovery-required", error={
            "id": error_id, "nextAction": "retry-checks", "detail": dict(detail, runningAgain=version),
            "message": "OpenClaw %s is running again, but %s; the Portal could not return to %s: %s." % (
                version, "its checks failed (%s)" % ", ".join(failed) if failed else "its checks failed", previous,
                reason.rstrip("."))},
                        result=dict(self.result, to=version))
        return self.run.status


def start_gateway_ready(run, gateway, roots, service_env, node_path, exec_start, runner, http_get, settle, label):
    """Start the unit, then wait for OC-READY (ending early if the unit exits). Returns None or a problem string."""
    step = run.step_start("gateway-start", label.strip())
    problem = gateway.start()
    evidence = None
    if problem is None:
        record = probe_ready(roots, service_env, node_path, exec_start, runner, http_get,
                             settle.get("ready_wait_seconds", READY_WAIT_SECONDS),
                             settle.get("ready_interval_seconds", READY_INTERVAL_SECONDS), dead=gateway.dead)
        evidence = [write_probe(run, "gateway-start-ready", record)]
        if record["state"] != "passed":
            problem = record.get("reason") or "OpenClaw did not become ready"
    run.step_end(step, "failed" if problem else "passed", detail=problem or "The OpenClaw gateway is running and ready.",
                 evidence=evidence)
    return problem


def contract_step_state(contract):
    return "failed" if contract["failed"] else "unproven" if contract.get("unproven") else "passed"


def contract_step_detail(contract):
    off = contract.get("featuresOff") or {}
    tail = " Off: %s." % "; ".join("%s (%s not offered)" % (feature, ", ".join(methods))
                                    for feature, methods in sorted(off.items())) if off else ""
    unchecked = contract.get("methods") or {}
    if unchecked.get("state") == "not-run" and unchecked.get("reason") and "OC-HELLO" in contract.get("passed", []):
        tail += " " + unchecked["reason"]
    unproven = "".join(" Unproven: %s (%s)." % (probe, reason) for probe, reason in sorted(
        (contract.get("unprovenReasons") or {}).items()))
    if contract["failed"]:
        return "Failed: %s.%s%s" % (", ".join(contract["failed"]), unproven, tail)
    if unproven:
        return unproven.strip() + tail
    if contract["notRun"]:
        return "Required checks passed; not run in this build: %s.%s" % (", ".join(contract["notRun"]), tail)
    return "All checks passed.%s" % tail


def contract_needs_rollback(contract):
    """K7: a failed check rolls an update back only when the new version is unusable: a core probe failed
    or wasn't proven, or a probe this rule doesn't know failed (fail closed)."""
    failed = contract["failed"]
    if not failed:
        return False
    return any(probe not in OPENCLAW_DEGRADING_PROBES for probe in failed) \
        or not all(probe in contract["passed"] for probe in OPENCLAW_CORE_PROBES)


def contract_outcome(state, error, contract, post_rows):
    """c.4: a failed required probe turns a success into succeeded-degraded."""
    if contract["failed"] and state in ("succeeded", "succeeded-degraded"):
        missing = contract.get("missingMethods") or []
        if not missing and not contract_needs_rollback(contract):
            message = "Chat works, but questions from agents are off: %s failed." % " and ".join(contract["failed"])
        else:
            message = "Chat is unavailable: %s." % ("OpenClaw doesn't offer %s" % ", ".join(missing[:6]) if missing
                                                    else "%s failed" % " and ".join(contract["failed"]))
        return "succeeded-degraded", {
            "id": "CONTRACT_REQUIRED_PROBE_FAILED", "nextAction": "retry-checks",
            "message": message,
            "detail": {"failed": contract["failed"], "missingMethods": missing[:20],
                       "plugins": [r for r in post_rows if not r["healthy"]][:5]}}
    reasons = contract.get("unprovenReasons") or {}
    if reasons and state in ("succeeded", "succeeded-degraded"):
        # Nothing failed, but a check couldn't read its answer: not proven, so not a plain success.
        probe = sorted(reasons)[0]
        return "succeeded-degraded", {
            "id": "CONTRACT_REQUIRED_PROBE_UNPROVEN", "nextAction": "retry-checks",
            "message": "OpenClaw is running, but %s is unproven: %s." % (" and ".join(sorted(reasons)), reasons[probe]),
            "detail": {"unproven": sorted(reasons), "reasons": reasons}}
    return state, error


def verify_portal(roots, run, policy, service_env, node_path, exec_start, runner, http_get, settle, stop, result):
    """Verification after a native change: plugins-post (c.3) then contract (c.4). Returns (result, contract, rows)."""
    if run.quiesce is not None:
        run.quiesce.end_quiesce()  # verification starts: Portal diagnostics resume
    run.transition("plugins-post", "verifying")
    step = run.step_start("plugins-post", "Reconnecting Portal plugins")
    post_rows, restarted, evidence = plugins_post(
        roots, run, service_env, node_path, runner, policy["openclaw"]["gatewayService"],
        before_restart=(lambda: run.quiesce.pause_chat("a gateway restart reconnects Portal plugins"))
        if run.quiesce is not None else None)
    if run.quiesce is not None:
        run.quiesce.resume_chat()  # the restart window ends; chat resumes on a fresh readiness check
    broken = [r for r in post_rows if not r["healthy"]]
    run.step_end(step, "failed" if broken else "passed", evidence=[evidence], detail=(
        "Not reconnected: %s." % ", ".join("%s (%s)" % (r["id"], r["problem"]) for r in broken[:5]) if broken
        else "Portal plugins are loaded%s." % (" after one gateway restart" if restarted else "")))
    run.transition("contract", "verifying")
    step = run.step_start("contract", "Checking Portal features")
    contract = run_contract(roots, run, policy, service_env, node_path, exec_start, runner, http_get, post_rows, settle, stop=stop)
    run.step_end(step, contract_step_state(contract), evidence=["probes"], detail=contract_step_detail(contract))
    return dict(result, contract=contract, pluginsRestartedGateway=restarted), contract, post_rows


def recovery_preflight(roots, policy, runner, http_get):
    """Read-only checks before a recovery action: no legacy transaction, nothing else running, the gateway's Node.js."""
    gate = Preflight(roots, policy, target=None, runner=runner, holding_tools_lock=True, http_get=http_get)
    gate.check_legacy()
    gate.check_concurrency()
    gate.facts["installedVersion"] = installed_openclaw_version(roots)
    exec_start, unit_env = gate.check_gateway_service(policy["openclaw"]["gatewayService"])
    gate.service_env = unit_env or {}
    gate.resolve_node(exec_start)
    if exec_start is not None and not gate.node_usable():
        gate.refuse("PF7_NODE_UNKNOWN", "PF-7", "The gateway's Node.js runtime could not be found or run.",
                    detail={"reason": (gate.gateway_node or {}).get("problem")})
    return gate, exec_start


def core_updates_later(policy):
    """True while the policy holds the OpenClaw core update for a later Portal release."""
    oc = policy.get("openclaw") if isinstance(policy, dict) else None
    return isinstance(oc, dict) and oc.get("coreUpdates") == "later-release"


def later_release_refusal(policy, lead=None):
    floor = (policy_tool(policy, "openclaw") or {}).get("floor")
    message = OPENCLAW_UPDATE_LATER_RELEASE_MESSAGE % floor
    return {"id": "OPENCLAW_UPDATE_LATER_RELEASE", "check": "PF-0", "nextAction": None,
            "message": "%s %s" % (lead, message) if lead else message,
            "detail": {"coreUpdates": policy["openclaw"]["coreUpdates"]}}


def open_openclaw_recovery(roots, exclude_run_id=None):
    """The open OpenClaw recovery: the newest OpenClaw run (refused runs changed nothing, so they are
    skipped) when it ended recovery-required; otherwise None."""
    for status in list_runs(roots, limit=None):
        if status.get("tool") != "openclaw" or status.get("runId") == exclude_run_id or status.get("state") == "refused":
            continue
        return status if status.get("state") == "recovery-required" else None
    return None


def not_applied_closable(recovery, installed):
    """An UPDATE_NOT_APPLIED recovery: native stopped before its swap, so the package never
    changed and the previous version runs again. Retry checks closes it once that version answers every check."""
    if not isinstance(recovery, dict) or not installed:
        return False
    error = recovery.get("error") if isinstance(recovery.get("error"), dict) else {}
    result = recovery.get("result") if isinstance(recovery.get("result"), dict) else {}
    return error.get("id") == "UPDATE_NOT_APPLIED" and result.get("from") == installed and result.get("to") == installed


def refuse_later_release(roots, run, policy, action):
    """While openclaw.coreUpdates is "later-release": preflight and update are refused before any check,
    gateway stop, plugin change or native call; repair and Retry checks need an open OpenClaw recovery
    (Retry checks one it can close). Returns the finished status, or None when the run may go on."""
    installed = installed_openclaw_version(roots)
    refusal = None
    if action in ("preflight", "update"):
        refusal = later_release_refusal(policy)
    else:
        recovery = open_openclaw_recovery(roots, exclude_run_id=run.run_id)
        if recovery is None:
            refusal = later_release_refusal(policy, "No OpenClaw recovery is open, so there is nothing to %s." % (
                "repair" if action == "recover-native" else "check again"))
        elif action == "retry-checks" and (recovery.get("error") or {}).get("nextAction") != "retry-checks" \
                and not not_applied_closable(recovery, installed):
            refusal = {"id": "RETRY_CHECKS_NOT_CLOSABLE", "check": "PF-0", "nextAction": "recover-native",
                       "message": "Retry checks can't close this OpenClaw recovery: OpenClaw's package changed during "
                                  "that update. Run OpenClaw repair.",
                       "detail": {"recoveryRunId": recovery.get("runId"), "installedVersion": installed}}
    if refusal is None:
        return None
    run.finish("refused", error={"id": refusal["id"], "message": refusal["message"], "nextAction": refusal["nextAction"],
                                 "refusals": [refusal]}, result={"action": action, "from": installed, "to": None})
    return run.status


def start_recovery(run, gate, action):
    """Record the recovery pre-flight; finish refused if it failed. Returns (result, finished?)."""
    run.transition("preflight", "preflight")
    step = run.step_start("preflight", "Checking…")
    report = gate.report(policy_tool(gate.policy, "openclaw"), None)
    evidence = run.write_evidence("preflight.json", report)
    installed = report["facts"].get("installedVersion")
    result = {"action": action, "from": installed, "to": installed, "preflight": evidence}
    if not report["ok"]:
        first = report["refusals"][0]
        run.step_end(step, "failed", detail=first["message"], evidence=[evidence])
        run.finish("refused", error={"id": first["id"], "message": first["message"], "nextAction": first.get("nextAction"),
                                     "refusals": report["refusals"]}, result=result)
        return result, True
    run.step_end(step, "passed", detail="All available checks passed.", evidence=[evidence])
    return result, False


def execute_recover_native(roots, run, policy, runner, stop, progress, http_get=http_get_status):
    """c.6 "Run OpenClaw repair": native `update repair`, then the Portal's verification. Never retries the update."""
    progress = dict(progress or {})
    settle = {k: progress.pop(k) for k in SETTLE_KEYS if k in progress}
    drain = {k: progress.pop(k) for k in ("drain_seconds",) if k in progress}
    gate, exec_start = recovery_preflight(roots, policy, runner, http_get)
    result, finished = start_recovery(run, gate, "recover-native")
    if finished:
        return run.status
    if stop:
        return stop_before_change(run, stop, result=result)
    service_env, node_path = gate.service_env, gate.gateway_node["path"]
    run.quiesce = DiagnosticQuiesce(roots, run, policy["openclaw"]["gatewayService"], stop=stop, **drain)
    problem = run.quiesce.publish()
    if problem is not None:
        if problem["id"] == "TOOLS_RUN_STOPPED":
            return stop_before_change(run, stop, result=result)
        run.finish("failed", error=dict(problem, message=problem["message"].replace("OpenClaw wasn't updated",
                                                                                    "OpenClaw repair didn't start")),
                   result=result)
        return run.status
    run.transition("native", "running")
    # A repair runs with the gateway stopped (with it up, Doctor deferred on
    # GatewayStateOwnerContention): chat pauses for all of it (L3; a publish problem is
    # recorded under maintenanceMarker). The owner consented to this downtime.
    run.quiesce.pause_chat("OpenClaw repair is running")
    gateway = run.gateway = GatewayUnit(roots, run, policy["openclaw"]["gatewayService"], runner)
    step = run.step_start("gateway-stop", "Stopping the OpenClaw gateway for the repair")
    problem = gateway.stop()
    run.step_end(step, "failed" if problem else "passed", detail=problem or "Stopped for the repair.")

    def start_again(label):
        return start_gateway_ready(run, gateway, roots, service_env, node_path, exec_start, runner, http_get, settle, label)

    if problem:
        problem_again = start_again("Starting the OpenClaw gateway again") if gateway.stopped_by_us or gateway.was_running else None
        run.finish("recovery-required", error={
            "id": "GATEWAY_STOP_FAILED", "nextAction": "recover-native",
            "message": "OpenClaw repair didn't start: %s. Nothing was changed.%s" % (
                problem, " The gateway didn't start again: %s." % problem_again if problem_again else "")}, result=result)
        return run.status
    step = run.step_start("native", "OpenClaw repair is running")
    native = NativeUpdate(roots, run, service_env, node_path, runner, stop, **progress)
    doc, status_doc, exit_code, evidence = native.repair()
    mapped = map_native_repair(exit_code, doc, status_doc)
    result = dict(result, to=installed_openclaw_version(roots), native={"status": (doc or {}).get("status"), "exitCode": exit_code,
                                                                        "message": mapped["message"]})
    run.step_end(step, "passed" if mapped["state"] == "succeeded" else "failed",
                 detail=(mapped["error"] or {}).get("message") or mapped["message"] or "OpenClaw repair finished.", evidence=evidence)
    if stop:
        run.status["stop"] = stop.record()
    if mapped["state"] != "succeeded":
        error = dict(mapped["error"])
        if gateway.was_running:
            # Like native's own repair parent: a service it stopped for maintenance is restored, also
            # after a failed Doctor child (repair-and-recovery.md "The parent restores and verifies ...").
            problem = start_again("Starting the OpenClaw gateway again")
            error["message"] += " The gateway was started again." if problem is None else \
                " The gateway didn't start again: %s." % problem
        else:
            error["message"] += " The OpenClaw gateway was already stopped and stays stopped."
        run.finish(mapped["state"], error=error, result=result)
        return run.status
    problem = start_again("Starting the OpenClaw gateway")
    if problem:
        run.finish("recovery-required", error={"id": "GATEWAY_START_FAILED", "nextAction": "recover-native",
                                               "message": "OpenClaw repair finished, but the gateway didn't start: %s." % problem},
                   result=result)
        return run.status
    if stop:
        run.finish("succeeded-degraded", error={
            "id": "TOOLS_RUN_STOPPED_BEFORE_CHECKS", "nextAction": "retry-checks",
            "message": "OpenClaw repair finished, but the run was stopped before the Portal's plugin and feature checks ran."},
            result=result)
        return run.status
    result, contract, post_rows = verify_portal(roots, run, policy, service_env, node_path, exec_start, runner, http_get,
                                                settle, stop, result)
    state, error = contract_outcome("succeeded", None, contract, post_rows)
    run.finish(state, error=error, result=result)
    return run.status


def execute_retry_checks(roots, run, policy, runner, stop, progress, http_get=http_get_status):
    """c.4 "Retry checks": the contract probes only. No native update or repair, no plugin reinstall."""
    progress = dict(progress or {})
    settle = {k: progress.pop(k) for k in SETTLE_KEYS if k in progress}
    gate, exec_start = recovery_preflight(roots, policy, runner, http_get)
    result, finished = start_recovery(run, gate, "retry-checks")
    if finished:
        return run.status
    # The open recovery is an update that was never applied: only a full pass closes it (flag only).
    closing_not_applied = core_updates_later(policy) and not_applied_closable(
        open_openclaw_recovery(roots, exclude_run_id=run.run_id), result.get("from"))
    if stop:
        return stop_before_change(run, stop, result=result)
    run.transition("checks", "verifying")  # not a mutating phase: an interrupted check changed nothing
    step = run.step_start("contract", "Checking Portal features")
    plugins, problem = load_plugin_manifest(roots)
    worker = PortalPlugins(roots, gate.service_env, gate.gateway_node["path"], runner)
    rows = []
    if plugins is None:
        rows.append({"id": None, "healthy": False, "problem": "plugin packages damaged: %s" % problem})
    for plugin in plugins or []:
        version, healthy, why = worker.inspect(plugin["id"])
        ok = healthy and version == plugin["version"]
        rows.append({"id": plugin["id"], "bundled": plugin["version"], "installed": version, "healthy": ok,
                     "problem": None if ok else (why or "version %s, expected %s" % (version, plugin["version"]))})
    run.write_evidence("plugins-check.json", {"plugins": rows, "commands": worker.log})
    contract = run_contract(roots, run, policy, gate.service_env, gate.gateway_node["path"], exec_start, runner, http_get,
                            rows, settle, stop=stop)
    run.step_end(step, contract_step_state(contract), evidence=["plugins-check.json", "probes"],
                 detail=contract_step_detail(contract))
    state, error = contract_outcome("succeeded", None, contract, rows)
    if closing_not_applied and state != "succeeded":
        state, error = "recovery-required", {
            "id": "UPDATE_NOT_APPLIED", "nextAction": "retry-checks",
            "message": "OpenClaw %s is running, but not every Portal check passed, so its recovery stays open: %s "
                       "Retry checks again later." % (result.get("from"), (error or {}).get("message") or "a check failed."),
            "detail": {"checks": (error or {}).get("detail")}}
    run.finish(state, error=error, result=dict(result, contract=contract))
    return run.status


def interrupted_native_context(roots, run):
    """What a dead runner had recorded: the action, versions before and target, and the native launch time (ms)."""
    try:
        request = read_json_file(os.path.join(run.dir, "request.json"), max_bytes=64 * 1024)
    except ToolctlError:
        request = None
    try:
        report = read_json_file(os.path.join(run.dir, "preflight.json"))
    except ToolctlError:
        report = None
    facts = report.get("facts") if isinstance(report, dict) and isinstance(report.get("facts"), dict) else {}
    native = run.status.get("native") if isinstance(run.status.get("native"), dict) else {}
    started = parse_ts(native.get("startedAt"))
    return {"action": request.get("action") if isinstance(request, dict) else None,
            "installedBefore": facts.get("installedVersion"), "target": (facts.get("target") or {}).get("version"),
            "launchedMs": int(started * 1000) if started is not None else None, "nativeRunId": native.get("activeRunId")}


def settle_interrupted_native(roots, run, runner=run_bounded, http_get=http_get_status, settle=None, tools_lock_held=False,
                              portal_lock_held=False):
    """c.6 row 4: settle an OpenClaw `update` run whose runner died in `native`, from `update status --json`.

    Native still pending (a running record, an unsettled activation, a recovery
    reason) → recovery-required. Native finished before activation (an
    `interrupted` failure) → failed with its text. Native finished (succeeded or
    rolled back) → the Portal's verification (plugins-post, contract) runs now.
    The update itself is never run again. A status that can't be read or
    recognised keeps recovery-required with the reason. Returns {runId, state};
    `status.native.settledBy` says how.
    """
    context = interrupted_native_context(roots, run)
    native = run.status["native"] = run.status.get("native") if isinstance(run.status.get("native"), dict) else {}
    step = next((s for s in reversed(run.status.get("steps") or [])
                 if isinstance(s, dict) and s.get("id") == "native" and s.get("state") == "running"), None)
    result = {"action": context["action"], "from": context["installedBefore"], "to": None, "targetVersion": context["target"],
              "preflight": "preflight.json", "reconciled": True}

    def finish(state, error_id, message, next_action="recover-native", detail=None, step_state="failed"):
        if step is not None:
            run.step_end(step, step_state, detail=message)
        run.finish(state, error={"id": error_id, "message": message, "nextAction": next_action, "detail": dict(detail or {})},
                   result=result)
        return {"runId": run.run_id, "state": state}

    policy = load_policy(roots)[0]
    unit_name = policy["openclaw"]["gatewayService"] if policy else None
    unit_path, dropins = _unit_files(roots, unit_name) if unit_name else (None, [])
    parsed = parse_unit_service_section([unit_path] + dropins) if unit_path else {"Environment": {}, "ExecStart": None}
    service_env, exec_start = parsed["Environment"] or {}, parsed["ExecStart"]
    node_path = resolve_gateway_node(exec_start, service_env)[0] if exec_start else None
    doc = NativeUpdate(roots, run, service_env, node_path, runner, None).status_doc() if node_path else None
    evidence = run.write_evidence("native-status-reconcile.json", doc if doc is not None else {"readable": False})
    native.update(settledBy="reconcile", settleEvidence=evidence)
    if doc is None or context["launchedMs"] is None or context["action"] != "update":
        why = ("OpenClaw's update status couldn't be read" if doc is None else
               "the run didn't record when OpenClaw's updater started" if context["launchedMs"] is None else
               "it wasn't an update run")
        return finish("recovery-required", "TOOLS_RUN_INTERRUPTED",
                      "The update was interrupted while it was changing the server, and %s. Recovery is required." % why,
                      detail={"phase": "native", "reason": why})
    gateway_doc = run.status.get("gateway") if isinstance(run.status.get("gateway"), dict) else {}
    if gateway_doc.get("stoppedByToolctl"):
        # K7: the dead runner had stopped the gateway unit and nothing started it again. Only
        # recover-native stops, repairs and starts it (P7); the Portal checks can't run on a stopped unit.
        return finish("recovery-required", "GATEWAY_LEFT_STOPPED",
                      "The update was interrupted while the OpenClaw gateway was stopped for it. Run OpenClaw repair to "
                      "finish OpenClaw's maintenance and start the gateway again.", detail={"phase": "native"})
    pending = native_recovery_pending(doc)
    if pending is not None:
        return finish("recovery-required", "NATIVE_RUN_PENDING",
                      "The update was interrupted while OpenClaw's own update was unfinished (%s). Recovery is required." % pending,
                      detail={"phase": "native", "pending": pending})
    installed_after = installed_openclaw_version(roots)
    mapped = map_native_outcome(None, {"runId": context["nativeRunId"]} if context["nativeRunId"] else None, doc,
                                context["launchedMs"], context["installedBefore"], installed_after, context["target"])
    native.update({k: v for k, v in mapped["native"].items() if k != "exitCode"})
    result.update(to=installed_after, native={k: mapped["native"].get(k) for k in ("runId", "status", "phase", "reason", "nextAction")})
    state, error = mapped["state"], mapped["error"] or {}
    if state == "refused":
        # Native finished it before activation (an interruption records `failed`, reason `interrupted`).
        reason = (error.get("detail") or {}).get("nativeReason")
        return finish("failed", "NATIVE_INTERRUPTED_BEFORE_ACTIVATION", report_prior_changes(
                      "The update was interrupted before OpenClaw changed anything%s. Nothing was changed; try again." % (
                          " (OpenClaw: %s)" % reason if reason else ""), plugins_pre_changes(run.status)),
                      next_action=error.get("nextAction"), detail=error.get("detail"))
    if not mapped["continue"]:
        message = error.get("message")
        if error.get("id") == "NATIVE_RESULT_MISSING":
            message = ("The update was interrupted, and OpenClaw's update history doesn't show how its update ended. "
                       "Recovery is required.")
        return finish(state, error.get("id") or "TOOLS_RUN_INTERRUPTED", message or "Recovery is required.",
                      next_action=error.get("nextAction") or "recover-native", detail=error.get("detail"))
    # Native finished: the Portal's verification runs now, under the run's locks.
    if step is not None:
        run.step_end(step, "passed", detail="OpenClaw finished while the run was interrupted: %s." % mapped["native"].get("status"))
    tools_lock = None if tools_lock_held else ToolsLock(roots)
    # `reconcile` already holds the installer operation lock (cmd_reconcile_host);
    # a second flock on a new descriptor in this process would only report busy.
    portal_lock = None if portal_lock_held else PortalOperationLock(roots.portal_operation_lock)
    locked = False
    try:
        try:
            if tools_lock is not None:
                tools_lock.acquire(run.run_id)
            if portal_lock is not None:
                portal_lock.acquire()
            locked = True
        except (LockBusy, OSError, ToolctlError):
            pass
        if not locked:
            if state in ("succeeded", "succeeded-degraded"):
                state, error = "succeeded-degraded", {
                    "id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHECKS", "nextAction": "retry-checks",
                    "message": "OpenClaw finished updating, but the run was interrupted before the Portal's plugin and feature checks ran."}
            run.finish(state, error=error or None, result=result)
            return {"runId": run.run_id, "state": state}
        run.quiesce = DiagnosticQuiesce(roots, run, unit_name)
        run.quiesce.adopt()
        settle = dict(settle or {})
        result, contract, post_rows = verify_portal(roots, run, policy, service_env, node_path, exec_start, runner, http_get,
                                                    settle, None, result)
        if state == "succeeded-degraded":
            error = {"id": "NATIVE_READINESS_UNVERIFIED", "message": mapped["degraded"], "nextAction": "openclaw-status"}
        state, error = contract_outcome(state, error or None, contract, post_rows)
        run.finish(state, error=error, result=result)
        return {"runId": run.run_id, "state": state}
    finally:
        if run.quiesce is not None:
            run.quiesce.clear()
        if portal_lock is not None:
            portal_lock.release()
        if tools_lock is not None:
            tools_lock.release()


def unsupported_action(tool, action):
    """The plain refusal for a (tool, action) pair this runner doesn't implement; the UI shows it verbatim."""
    if tool == "openclaw" and action == "requalify":
        return "OpenClaw isn't re-qualified like the command-line tools; use \"Retry checks\" to check it again."
    return "This Portal can't run \"%s\" for %s." % (action, tool)


def cmd_run(roots, run_id, metadata_path=None, runner=run_bounded, statvfs=os.statvfs, http_get=http_get_status, stop=None,
            progress=None):
    if not RUN_ID_RE.fullmatch(run_id or ""):
        raise ToolctlError("run id must be a lowercase UUID")
    own_stop = stop is None
    stop = StopRequest() if own_stop else stop
    if own_stop:
        try:
            stop.install()
        except ValueError:  # not the main thread (embedded use): no handler to install
            pass
    try:
        return _cmd_run(roots, run_id, metadata_path, runner, statvfs, http_get, stop, progress)
    finally:
        if own_stop:
            stop.restore()


def _cmd_run(roots, run_id, metadata_path, runner, statvfs, http_get, stop, progress):
    ensure_state_dirs(roots)
    run = Run(roots, run_id)
    if not os.path.isdir(run.dir) or os.path.islink(run.dir):
        raise ToolctlError("run %s has no request directory" % run_id)
    ensure_private_dir(run.dir)
    request_path = os.path.join(run.dir, "request.json")
    tools_lock = ToolsLock(roots)
    try:
        tools_lock.acquire(run_id)
    except LockBusy as busy:
        run.load()
        if run.status is not None and run.status.get("state") in TERMINAL_STATES:
            return run.status
        if (busy.owner or {}).get("runId") == run_id:
            # This run is already executing under another runner; leave it alone.
            return run.status or {"runId": run_id, "state": "queued"}
        if run.status is None:
            run.init_status("openclaw")
        run.finish("refused", error={"id": "PF4_TOOLS_RUN_ACTIVE", "message": "Another maintenance operation is running.",
                                     "detail": {"runId": (busy.owner or {}).get("runId")}})
        return run.status
    portal_lock = PortalOperationLock(roots.portal_operation_lock)
    try:
        status = run.load()
        if status is not None and status.get("state") in TERMINAL_STATES:
            return status
        if status is not None and status.get("state") != "queued":
            # The previous runner died mid-run. Nothing here re-performs work.
            if status.get("tool") in NPM_TOOL_IDS and isinstance(status.get("swap"), dict):
                npm_reconcile_run(roots, run, load_policy(roots)[0])
            elif status.get("tool") in HARNESS_TOOL_IDS and isinstance(status.get("swap"), dict):
                harness_reconcile_run(roots, run, load_policy(roots)[0])
            elif status.get("tool") == "openclaw" and status.get("phase") == "native":
                settle_interrupted_native(roots, run, runner=runner, http_get=http_get, settle=progress, tools_lock_held=True)
            elif status.get("phase") in MUTATING_PHASES:
                run.finish("recovery-required", error={
                    "id": "TOOLS_RUN_INTERRUPTED", "message": "The update was interrupted while it was changing the server. Recovery is required.",
                    "detail": {"phase": status.get("phase")}})
            else:
                run.finish("failed", error={
                    "id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE", "message": "The run was interrupted before it changed anything. Try again.",
                    "detail": {"phase": status.get("phase")}})
            return run.status
        policy, policy_sha, policy_errors = load_policy(roots)
        try:
            request = read_json_file(request_path, max_bytes=64 * 1024)
        except ToolctlError as error:
            request, request_error = None, str(error)
        else:
            request_error = None
        if status is None:
            run.init_status((request or {}).get("tool") if isinstance(request, dict) and isinstance(request.get("tool"), str) else "openclaw")
        if policy_errors:
            run.finish("failed", error={"id": "POLICY_INVALID", "message": "This Portal's tool policy is invalid.",
                                        "detail": {"errors": policy_errors[:20]}})
            return run.status
        problems = [request_error] if request_error else (["request.json is missing"] if request is None
                                                         else validate_request(request, run_id, policy))
        if problems:
            run.finish("failed", error={"id": "REQUEST_INVALID", "message": "The run request is invalid.",
                                        "detail": {"errors": problems}})
            return run.status
        if request.get("policySha256") not in (None, policy_sha):
            run.finish("refused", error={"id": "POLICY_CHANGED", "message": "The Portal was updated after this run was requested. Request it again."})
            return run.status
        # What the run does, for the Portal while it is active (an install reads "Installing…", not "updating").
        run.status["action"] = request["action"]
        try:
            portal_lock.acquire()
        except LockBusy:
            run.finish("refused", error={"id": "PF4_PORTAL_OPERATION_ACTIVE",
                                         "message": "Another BridgesLLM install, update, uninstall, backup, restore, or repair operation is already running."})
            return run.status
        except (OSError, ToolctlError) as error:
            run.finish("failed", error={"id": "PORTAL_OPERATION_LOCK_UNSAFE", "message": "The Portal operation lock could not be taken safely.",
                                        "detail": {"reason": str(error)}})
            return run.status
        if stop:
            return stop_before_change(run, stop)
        # Both locks are held: a toolctl marker whose run is final is stale (L3).
        for key, stale_marker in (("staleMaintenanceMarker", clear_stale_maintenance_marker(roots)),
                                  ("staleQuiesceMarker", clear_stale_quiesce_marker(roots))):
            if stale_marker is not None:
                run.status[key] = stale_marker
        if request.get("tool") in NPM_TOOL_IDS:
            return execute_npm_run(roots, run, policy, request, stop)
        if request.get("tool") in HARNESS_TOOL_IDS:
            return execute_harness_run(roots, run, policy, request, stop)
        action = request["action"]
        if request["tool"] == "openclaw" and action not in OPENCLAW_ACTIONS:
            run.finish("refused", error={"id": "TOOLS_ACTION_UNSUPPORTED", "message": unsupported_action(request["tool"], action)})
            return run.status
        if request["tool"] == "openclaw" and core_updates_later(policy):
            refused = refuse_later_release(roots, run, policy, action)
            if refused is not None:
                return refused
        if action == "recover-native":
            return execute_recover_native(roots, run, policy, runner, stop, progress, http_get=http_get)
        if action == "retry-checks":
            return execute_retry_checks(roots, run, policy, runner, stop, progress, http_get=http_get)
        run.transition("preflight", "preflight")
        step = run.step_start("preflight", "Checking…")
        report = Preflight(roots, policy, target=request["target"], channel=request.get("channel"),
                           metadata_path=metadata_path, runner=runner, statvfs=statvfs,
                           holding_tools_lock=True, http_get=http_get,
                           node_update=request["action"] == "update" and node_update_accepted(request)).run()
        evidence = run.write_evidence("preflight.json", report)
        installed = report["facts"].get("installedVersion")
        target_version = (report["facts"].get("target") or {}).get("version")
        result = {"action": request["action"], "from": installed, "to": None, "preflight": evidence}
        if not report["ok"]:
            run.step_end(step, "failed", detail=report["refusals"][0]["message"], evidence=[evidence])
            first = report["refusals"][0]
            run.finish("refused", error={"id": first["id"], "message": first["message"], "nextAction": first.get("nextAction"),
                                         "refusals": report["refusals"]}, result=result)
            return run.status
        run.step_end(step, "passed", detail="All available checks passed.", evidence=[evidence])
        if stop:
            return stop_before_change(run, stop, result=result)
        if request["action"] == "preflight":
            # The update mode is part of the result: the card and the consent dialog read it from here (N2).
            mode = report["facts"].get("updateMode")
            run.finish("succeeded", result=dict(result, to=installed, targetVersion=target_version,
                                                **({"updateMode": mode} if isinstance(mode, dict) else {})))
            return run.status
        return execute_update(roots, run, policy, request, report, result, runner, stop, progress, http_get=http_get)
    except Exception as error:
        # A bug or an I/O failure must never leave a run that looks active.
        if run.status is not None and run.status.get("state") not in TERMINAL_STATES:
            reason = redact_text("%s: %s" % (type(error).__name__, error))[:400]
            if settle_switch_after_error(roots, run, reason):
                return run.status
            changed = run.status.get("phase") in MUTATING_PHASES
            parked = run.gateway is not None and run.gateway.stopped_by_us
            run.finish("recovery-required" if changed or parked else "failed", error={
                "id": "TOOLS_RUN_INTERNAL_ERROR",
                "message": "The update stopped on an internal error%s.%s" % (
                    " after it began changing the server. Recovery is required" if changed else " before it changed anything",
                    " The OpenClaw gateway is stopped; run OpenClaw repair." if parked else ""),
                "nextAction": "recover-native" if changed or parked else None,
                "detail": {"phase": run.status.get("phase"), "reason": reason}})
            return run.status
        raise
    finally:
        if run.quiesce is not None:
            run.quiesce.clear()
        portal_lock.release()
        tools_lock.release()


def settle_switch_after_error(roots, run, reason):
    """An npm or harness run that raised after its switch began (its swap record
    exists) is settled by the crash rules for a runner that died: they re-read
    the filesystem and never replay. If they cannot settle it, recovery is
    required. False when no switch had begun (nothing was moved before that)."""
    status = run.status
    swap, tool_id = status.get("swap"), status.get("tool")
    if not isinstance(swap, dict) or tool_id not in NPM_TOOL_IDS and tool_id not in HARNESS_TOOL_IDS:
        return False
    detail = {"phase": status.get("phase"), "swapState": swap.get("state"), "reason": reason}
    status["internalError"] = detail  # kept by finish(): what stopped the run before the crash rules settled it
    try:
        (npm_reconcile_run if tool_id in NPM_TOOL_IDS else harness_reconcile_run)(roots, run, load_policy(roots)[0])
    except Exception as error:
        detail["settleReason"] = redact_text("%s: %s" % (type(error).__name__, error))[:400]
    else:
        if run.status.get("state") in TERMINAL_STATES:
            return True
    try:
        if isinstance(swap.get("fence"), str):
            _remove_fence(swap)  # the run is final: nothing settles it later, and the record decides what may run
    except OSError as error:
        detail["fence"] = "could not be removed: %s" % (error.strerror or error)
    run.finish("recovery-required", error={
        "id": "TOOLS_RUN_INTERNAL_ERROR",
        "message": "The %s update stopped on an internal error while it was switching versions, and the switch could not be "
                   "settled. %s" % (tool_id, recheck_recovery_advice(policy_label(roots, tool_id))),
        "detail": detail})
    return True


def cmd_reconcile(roots, stale_queued_seconds=STALE_QUEUED_SECONDS, now=None, runner=run_bounded, http_get=http_get_status,
                  settle=None, portal_lock_held=False):
    """Settle non-terminal runs whose runner is gone. Idempotent."""
    now = time.time() if now is None else now
    if not os.path.isdir(roots.runs_dir):
        return []
    holder = lock_holder(roots)
    active_run = (holder or {}).get("runId")
    settled = []
    for run_id in sorted(os.listdir(roots.runs_dir)):
        if not RUN_ID_RE.fullmatch(run_id) or run_id == active_run:
            continue
        run = Run(roots, run_id)
        try:
            status = run.load()
        except ToolctlError:
            continue
        if status is None or status.get("state") in TERMINAL_STATES:
            continue
        if status.get("tool") in NPM_TOOL_IDS and isinstance(status.get("swap"), dict):
            settled.append(npm_reconcile_run(roots, run, load_policy(roots)[0]))
            continue
        if status.get("tool") in HARNESS_TOOL_IDS and isinstance(status.get("swap"), dict):
            settled.append(harness_reconcile_run(roots, run, load_policy(roots)[0]))
            continue
        if status.get("tool") == "openclaw" and status.get("phase") == "native" and status.get("state") != "queued":
            settled.append(settle_interrupted_native(roots, run, runner=runner, http_get=http_get, settle=settle,
                                                     portal_lock_held=portal_lock_held))
            continue
        if status.get("state") == "queued":
            created = parse_ts(status.get("createdAt"))
            if created is not None and now - created < stale_queued_seconds:
                continue
            run.finish("failed", error={"id": "TOOLS_RUN_NEVER_STARTED", "message": "The run never started. Nothing was changed. Try again."})
        elif status.get("phase") in MUTATING_PHASES:
            run.finish("recovery-required", error={
                "id": "TOOLS_RUN_INTERRUPTED", "message": "The update was interrupted while it was changing the server. Recovery is required.",
                "detail": {"phase": status.get("phase")}})
        else:
            run.finish("failed", error={
                "id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE", "message": "The run was interrupted before it changed anything. Try again.",
                "detail": {"phase": status.get("phase")}})
        settled.append({"runId": run_id, "state": run.status["state"]})
    # L3: a marker left by a run that is now final no longer pauses the Portal.
    clear_stale_quiesce_marker(roots, active_run=active_run)
    clear_stale_maintenance_marker(roots, active_run=active_run)
    return settled


def list_runs(roots, limit=20):
    if not os.path.isdir(roots.runs_dir):
        return []
    runs = []
    for run_id in os.listdir(roots.runs_dir):
        if not RUN_ID_RE.fullmatch(run_id):
            continue
        try:
            status = read_json_file(os.path.join(roots.runs_dir, run_id, "status.json"))
        except ToolctlError:
            continue
        if isinstance(status, dict):
            runs.append(status)
    runs.sort(key=lambda s: s.get("createdAt") or "", reverse=True)
    return runs[:limit]


def cmd_status(roots):
    policy, policy_sha, policy_errors = load_policy(roots)
    holder = lock_holder(roots)
    runs = list_runs(roots)
    active = next((r for r in runs if r.get("state") not in TERMINAL_STATES), None)
    return {
        "schema": SCHEMA_TOOLCTL_STATUS,
        "generatedAt": utc_now(),
        "policy": {"path": roots.policy_path, "sha256": policy_sha, "valid": not policy_errors,
                   "errors": policy_errors[:20], "revision": (policy or {}).get("policyRevision")},
        "lock": {"held": holder is not None, "owner": holder},
        "legacy": {"open": open_legacy_roots(roots), "transactions": legacy_transactions_info(roots)},
        "activeRun": active,
        "runs": [{k: r.get(k) for k in ("runId", "tool", "state", "phase", "createdAt", "endedAt")} for r in runs],
        "history": read_history(roots),
    }


# ==========================================================================
# npm CLIs (Codex, Claude Code, ClawHub): admission records (C5) and their
# flows. This section belongs to the npm CLI lane; the OpenClaw core flow
# above uses nothing from it. toolctl is the only writer of admission
# records; the backend (nativeHostCliAdmission.ts) only reads them.
# ==========================================================================

SCHEMA_ADMISSION_RECORD = "bridgesllm.tools.admission.v1"
NPM_REGISTRY = "https://registry.npmjs.org/"
NPM_TOOL_IDS = ("codex", "claude-code", "clawhub")
ADMISSION_RECORD_MAX_BYTES = 64 * 1024
# The backend admission walker's limits (catalog `limits`; a test keeps them equal).
NPM_TREE_LIMITS = {"maxEntries": 4096, "maxDepth": 24, "maxFileBytes": 629145600, "maxTotalBytes": 1258291200}
# Lowest version the backend admits by record (NATIVE_HOST_CLI_RECORD_POLICY in
# backend/src/services/nativeHostCliAdmissionRecord.ts; a test keeps them equal).
# Older versions stay catalog-only, so toolctl never writes a record for them.
NPM_RECORD_FLOORS = {"codex": "0.163.0", "claude-code": "2.1.309", "clawhub": "0.23.3"}
# Package layout, mirrored from backend/src/config/nativeHostCliAdmissionCatalog.v1.json
# (a test keeps them equal). The record may only vouch for these paths.
NPM_TOOL_LAYOUTS = {
    "codex": {
        "packageName": "@openai/codex", "binName": "codex", "binRelative": "bin/codex.js", "executables": ("codex",),
        "platformPackage": {
            "x64": ("node_modules/@openai/codex-linux-x64", "@openai/codex", "{version}-linux-x64",
                    "vendor/x86_64-unknown-linux-musl/bin/codex"),
            "arm64": ("node_modules/@openai/codex-linux-arm64", "@openai/codex", "{version}-linux-arm64",
                      "vendor/aarch64-unknown-linux-musl/bin/codex"),
        },
    },
    "claude-code": {
        "packageName": "@anthropic-ai/claude-code", "binName": "claude", "binRelative": "bin/claude.exe",
        "executables": ("claude",),
        "platformPackage": {
            "x64": ("node_modules/@anthropic-ai/claude-code-linux-x64", "@anthropic-ai/claude-code-linux-x64", "{version}",
                    "claude"),
            "arm64": ("node_modules/@anthropic-ai/claude-code-linux-arm64", "@anthropic-ai/claude-code-linux-arm64",
                      "{version}", "claude"),
        },
    },
    "clawhub": {
        "packageName": "clawhub", "binName": "clawhub", "binRelative": "bin/clawdhub.js",
        "executables": ("clawdhub", "clawhub"), "platformPackage": None,
    },
}

_HEX_SHA256_RE = re.compile(r"\A[a-f0-9]{64}\Z")
_SRI_SHA512_RE = re.compile(r"\Asha512-[A-Za-z0-9+/]{86}==\Z")
_PLATFORM_KEY_RE = re.compile(r"\Alinux-(?:x64|arm64)-gnu\Z")
_ADMITTED_BY_RE = re.compile(r"\A(?:(?:run|requalify):[A-Za-z0-9][A-Za-z0-9._-]{0,63}|catalog-v1-migration)\Z")
_ISO_INSTANT_RE = re.compile(r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z\Z")
_PLAIN_VERSION_RE = re.compile(r"\A(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\Z")
_PLATFORM_PACKAGE_NAME_RE = re.compile(r"\A(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*\Z")
_PLATFORM_PACKAGE_VERSION_RE = re.compile(r"\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\Z")
_UNSAFE_PATH_CHARS_RE = re.compile(r"[\x00-\x1f\x7f\\]")
ADMISSION_RECORD_KEYS = frozenset((
    "schema", "toolId", "packageName", "version", "platform", "packageRoot", "treeSha256", "criticalFiles",
    "hardlinkGroups", "platformPackageRelative", "platformPackageName", "platformPackageVersion",
    "platformBinRelative", "source", "admittedAt", "admittedBy"))
ADMISSION_SOURCE_KEYS = frozenset(("kind", "tarball", "integrity", "signatures", "provenance", "verifier"))


class NpmRefusal(Exception):
    """A plain-words reason an npm CLI flow stops; `code` is the stable id;
    `next_action` what a failed re-check offers (see recheck_next_action)."""

    def __init__(self, code, message, detail=None, next_action=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail
        self.next_action = next_action


# Paths only the npm flows use: an attribute on Roots (tests), else the
# environment, else the default. Kept out of DEFAULTS so the core flow's roots
# are unchanged.
NPM_PATH_DEFAULTS = {
    "npm_bin_dir": ("BRIDGESLLM_NPM_BIN_DIR", "/usr/bin"),
    "node_bin": ("BRIDGESLLM_NODE_BIN", "/usr/bin/node"),
    "npm_bin": ("BRIDGESLLM_NPM_BIN", "/usr/bin/npm"),
    "systemd_run_bin": ("BRIDGESLLM_SYSTEMD_RUN_BIN", "/usr/bin/systemd-run"),
    "env_bin": ("BRIDGESLLM_ENV_BIN", "/usr/bin/env"),
    "setpriv_bin": ("BRIDGESLLM_SETPRIV_BIN", "/usr/bin/setpriv"),
}


def npm_path(roots, name):
    value = getattr(roots, name, None)
    if not value:
        env_name, default = NPM_PATH_DEFAULTS[name]
        value = os.environ.get(env_name) or default
    if not os.path.isabs(value) or os.path.normpath(value) != value:
        raise ToolctlError("%s must be a canonical absolute path: %r" % (name, value))
    return value


def npm_admission_dir(roots):
    return os.path.join(roots.state_root, "admission")


def npm_platform_key(machine=None, libc=None, system=None):
    """`linux-<x64|arm64>-gnu` for this host, or None (the backend's key)."""
    system = sys.platform if system is None else system
    machine = os.uname().machine if machine is None else machine
    if libc is None:
        try:
            libc = os.confstr("CS_GNU_LIBC_VERSION") or ""
        except (ValueError, OSError):
            libc = ""
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    if not system.startswith("linux") or arch is None or not libc.startswith("glibc"):
        return None
    return "linux-%s-gnu" % arch


def official_npm_tarball_url(package_name, version):
    """npm's own tarball URL for name@version (officialNpmTarballUrl in the backend)."""
    file_name = package_name.split("/")[1] if package_name.startswith("@") else package_name
    return "%s%s/-/%s-%s.tgz" % (NPM_REGISTRY, package_name, file_name, version)


def _record_safe_relative(value):
    return isinstance(value, str) and 0 < len(value) <= 1024 and not value.startswith("/") \
        and not _UNSAFE_PATH_CHARS_RE.search(value) and all(part not in ("", ".", "..") for part in value.split("/"))


# -- Tree facts: the same walk and digest as snapshotTree() in nativeHostCliAdmission.ts --

def _stat_key(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid, info.st_gid, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _path_inside(root, candidate):
    relative = os.path.relpath(candidate, root)
    return relative == "." or not (relative == ".." or relative.startswith("../") or os.path.isabs(relative))


def _npm_hash_file(path, expected, max_bytes):
    if expected.st_size > max_bytes:
        raise NpmRefusal("NPM_TREE_UNSAFE", "%s is larger than the admission walker allows." % path)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    except OSError as error:
        raise NpmRefusal("NPM_TREE_CHANGED", "%s changed before it was read (%s)." % (path, error.strerror))
    try:
        opened = os.fstat(fd)
        if _stat_key(opened) != _stat_key(expected) or not stat.S_ISREG(opened.st_mode):
            raise NpmRefusal("NPM_TREE_CHANGED", "%s changed before it was read." % path)
        digest = hashlib.sha256()
        remaining = opened.st_size
        while remaining > 0:
            chunk = os.read(fd, min(remaining, 1 << 20))
            if not chunk:
                raise NpmRefusal("NPM_TREE_CHANGED", "%s was truncated while it was read." % path)
            digest.update(chunk)
            remaining -= len(chunk)
        if _stat_key(os.fstat(fd)) != _stat_key(opened):
            raise NpmRefusal("NPM_TREE_CHANGED", "%s changed while it was read." % path)
        return digest.hexdigest()
    finally:
        os.close(fd)


def _real_path_strict(path):
    try:
        return os.path.realpath(path, strict=True)
    except TypeError:  # Python < 3.10
        real = os.path.realpath(path)
        os.stat(real)
        return real


def npm_tree_snapshot(root, uid=0, gid=0, limits=None):
    """Walk a package tree exactly like the backend admission walker.

    Returns {"digest", "entries": {relativePath: entry}, "inodes": {(dev, ino): [paths]}}.
    Anything the backend would refuse (foreign owner, group/world-writable,
    special file, symlink leaving the tree, another filesystem, a change during
    the walk, a bound) is refused here with a plain reason.
    """
    limits = NPM_TREE_LIMITS if limits is None else limits

    def unsafe(message):
        raise NpmRefusal("NPM_TREE_UNSAFE", message)

    def check_owner(info, label, allow_symlink_mode=False):
        if info.st_uid != uid or info.st_gid != gid or (
                (not allow_symlink_mode or not stat.S_ISLNK(info.st_mode)) and stat.S_IMODE(info.st_mode) & 0o022):
            unsafe("%s ownership or permissions are unsafe." % label)

    try:
        root_info = os.lstat(root)
    except FileNotFoundError:
        raise NpmRefusal("NPM_TREE_MISSING", "%s does not exist." % root)
    check_owner(root_info, "The package root %s" % root)
    if not stat.S_ISDIR(root_info.st_mode):
        unsafe("The package root %s is not a real directory." % root)
    if os.path.realpath(root) != root:
        unsafe("The package root %s is not canonical." % root)
    entries, inode_hash, inode_paths, total = {}, {}, {}, [0]

    def walk(directory, depth):
        if depth > limits["maxDepth"]:
            unsafe("The package tree is deeper than the admission walker allows.")
        before = os.lstat(directory)
        if not stat.S_ISDIR(before.st_mode):
            raise NpmRefusal("NPM_TREE_CHANGED", "%s changed during the walk." % directory)
        for raw in sorted(os.listdir(os.fsencode(directory))):
            try:
                name = raw.decode("utf-8")
            except UnicodeDecodeError:
                unsafe("The package tree contains a name that is not UTF-8.")
            if "\0" in name or name in (".", ".."):
                unsafe("The package tree contains an invalid name.")
            if len(entries) >= limits["maxEntries"]:
                unsafe("The package tree has more entries than the admission walker allows.")
            absolute = os.path.join(directory, name)
            relative = os.path.relpath(absolute, root)
            if not _record_safe_relative(relative) or len(relative) > 4096:
                unsafe("The package tree contains an invalid or overlong path.")
            info = os.lstat(absolute)
            check_owner(info, "Package entry %s" % relative, allow_symlink_mode=True)
            if info.st_dev != root_info.st_dev:
                unsafe("Package entry %s crosses a filesystem boundary." % relative)
            mode = stat.S_IMODE(info.st_mode)
            if stat.S_ISDIR(info.st_mode):
                entries[relative] = {"kind": "directory", "mode": mode, "path": absolute, "stat": _stat_key(info)}
                walk(absolute, depth + 1)
                continue
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(absolute)
                if os.path.isabs(target) or "\0" in target:
                    unsafe("Symlink %s is unsafe." % relative)
                if not _path_inside(root, os.path.normpath(os.path.join(os.path.dirname(absolute), target))):
                    unsafe("Symlink %s escapes the package root." % relative)
                try:
                    real = _real_path_strict(absolute)
                except OSError:
                    unsafe("Symlink %s has no safe target." % relative)
                if not _path_inside(root, real):
                    unsafe("Symlink %s resolves outside the package root." % relative)
                if _stat_key(os.lstat(absolute)) != _stat_key(info) or os.readlink(absolute) != target:
                    raise NpmRefusal("NPM_TREE_CHANGED", "Symlink %s changed during the walk." % relative)
                entries[relative] = {"kind": "symlink", "mode": mode, "target": target, "path": absolute,
                                     "stat": _stat_key(info)}
                continue
            if not stat.S_ISREG(info.st_mode):
                unsafe("Package entry %s is a special file." % relative)
            key = (info.st_dev, info.st_ino)
            digest = inode_hash.get(key)
            if digest is None:
                total[0] += info.st_size
                if total[0] > limits["maxTotalBytes"]:
                    unsafe("The package tree is larger than the admission walker allows.")
                digest = _npm_hash_file(absolute, info, limits["maxFileBytes"])
                inode_hash[key] = digest
            inode_paths.setdefault(key, []).append(relative)
            entries[relative] = {"kind": "file", "mode": mode, "size": info.st_size, "sha256": digest,
                                 "nlink": info.st_nlink, "path": absolute, "stat": _stat_key(info)}
        if _stat_key(os.lstat(directory)) != _stat_key(before):
            raise NpmRefusal("NPM_TREE_CHANGED", "%s changed during the walk." % directory)

    walk(root, 0)
    digest = hashlib.sha256()
    for relative in sorted(entries, key=lambda item: item.encode("utf-8")):
        entry = entries[relative]
        if entry["kind"] == "directory":
            line = "d\0%s\0%s" % (relative, format(entry["mode"], "o"))
        elif entry["kind"] == "symlink":
            line = "l\0%s\0%s" % (relative, entry["target"])
        else:
            line = "f\0%s\0%s\0%d\0%s" % (relative, format(entry["mode"], "o"), entry["size"], entry["sha256"])
        digest.update(line.encode("utf-8"))
        digest.update(b"\n")
    return {"root": root, "rootStat": _stat_key(root_info), "digest": digest.hexdigest(), "entries": entries,
            "inodes": {key: sorted(paths) for key, paths in inode_paths.items()}}


def npm_snapshot_unchanged(snapshot):
    """The backend's verifySnapshotStable(): nothing in the tree moved since the walk."""
    if _stat_key(os.lstat(snapshot["root"])) != snapshot["rootStat"]:
        return False
    for entry in snapshot["entries"].values():
        try:
            if _stat_key(os.lstat(entry["path"])) != entry["stat"]:
                return False
            if entry["kind"] == "symlink" and os.readlink(entry["path"]) != entry["target"]:
                return False
        except OSError:
            return False
    return True


def _snapshot_json(snapshot, relative, label):
    entry = snapshot["entries"].get(relative)
    if not entry or entry["kind"] != "file" or entry["size"] > 1024 * 1024:
        raise NpmRefusal("NPM_TREE_UNSAFE", "%s is missing or not a bounded file." % label)
    with open(entry["path"], "rb") as handle:
        data = handle.read(1024 * 1024 + 1)
    try:
        doc = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise NpmRefusal("NPM_TREE_UNSAFE", "%s is not valid JSON." % label)
    if not isinstance(doc, dict):
        raise NpmRefusal("NPM_TREE_UNSAFE", "%s is not a JSON object." % label)
    return doc


def _bin_mapping_ok(package_json, bin_name, bin_relative):
    bin_field = package_json.get("bin")
    if isinstance(bin_field, str):
        return bin_name == package_json.get("name") and bin_field == bin_relative
    return isinstance(bin_field, dict) and all(isinstance(v, str) for v in bin_field.values()) \
        and bin_field.get(bin_name) == bin_relative


def npm_tree_facts(tool_id, snapshot, version, platform_key):
    """The facts a record vouches for, checked the way the backend reader checks them."""
    layout = NPM_TOOL_LAYOUTS[tool_id]
    label = "%s %s" % (tool_id, version)
    package_json = _snapshot_json(snapshot, "package.json", "%s package.json" % label)
    if package_json.get("name") != layout["packageName"] or package_json.get("version") != version:
        raise NpmRefusal("NPM_TREE_MISMATCH", "%s package.json does not name %s@%s." % (label, layout["packageName"], version))
    if not _bin_mapping_ok(package_json, layout["binName"], layout["binRelative"]):
        raise NpmRefusal("NPM_TREE_MISMATCH", "%s package.json does not map %s to %s." % (label, layout["binName"], layout["binRelative"]))
    critical = ["package.json", layout["binRelative"]]
    platform_fields = (None, None, None, None)
    platform_table = layout["platformPackage"]
    if platform_table is not None:
        arch = platform_key.split("-")[1]
        relative, name, version_pattern, bin_relative = platform_table[arch]
        platform_version = version_pattern.format(version=version)
        platform_json = _snapshot_json(snapshot, relative + "/package.json", "%s platform package.json" % label)
        if platform_json.get("name") != name or platform_json.get("version") != platform_version:
            raise NpmRefusal("NPM_TREE_MISMATCH", "%s platform package is not %s@%s." % (label, name, platform_version))
        binary = snapshot["entries"].get(relative + "/" + bin_relative)
        if not binary or binary["kind"] != "file" or not binary["mode"] & 0o111:
            raise NpmRefusal("NPM_TREE_MISMATCH", "%s platform binary %s is missing or not executable." % (label, bin_relative))
        critical += [relative + "/package.json", relative + "/" + bin_relative]
        platform_fields = (relative, name, platform_version, bin_relative)
    critical_files = {}
    for relative in critical:
        entry = snapshot["entries"].get(relative)
        if not entry or entry["kind"] != "file":
            raise NpmRefusal("NPM_TREE_MISMATCH", "%s critical member %s is missing or not a file." % (label, relative))
        critical_files[relative] = entry["sha256"]
    groups = []
    for paths in snapshot["inodes"].values():
        links = snapshot["entries"][paths[0]]["nlink"]
        if links == 1 and len(paths) == 1:
            continue
        if links != len(paths):
            raise NpmRefusal("NPM_TREE_UNSAFE", "%s has a hard link outside its package tree." % label)
        groups.append(sorted(paths))
    return {
        "treeSha256": snapshot["digest"],
        "criticalFiles": critical_files,
        "hardlinkGroups": sorted(groups),
        "platformPackageRelative": platform_fields[0],
        "platformPackageName": platform_fields[1],
        "platformPackageVersion": platform_fields[2],
        "platformBinRelative": platform_fields[3],
    }


def npm_tree_admits(record_facts, snapshot):
    """Why the backend reader would refuse `snapshot` against a record with
    `record_facts` (plain words), or None: tree digest, critical files and the
    hard-link rule (observed groups must be approved; approved ones are optional)."""
    if snapshot["digest"] != record_facts["treeSha256"]:
        return "its files differ from the verified official release"
    for relative, digest in record_facts["criticalFiles"].items():
        entry = snapshot["entries"].get(relative)
        if not entry or entry["kind"] != "file" or entry["sha256"] != digest:
            return "its member %s differs from the verified official release" % relative
    allowed = set("\0".join(sorted(group)) for group in record_facts["hardlinkGroups"])
    for paths in snapshot["inodes"].values():
        links = snapshot["entries"][paths[0]]["nlink"]
        if links == 1 and len(paths) == 1:
            continue
        if links != len(paths):
            return "it has a hard link outside its package tree"
        if "\0".join(paths) not in allowed:
            return "it has hard links the verified official release does not have"
    return None


# -- Admission records: build, validate (the backend parser's rules), write --

def npm_record_version_refusal(tool_id, version, tool_policy):
    """Plain reason a record may not admit `version`, or None: a plain release,
    not deny-listed, at or above the policy floor and the backend record floor."""
    if not isinstance(version, str) or not _PLAIN_VERSION_RE.fullmatch(version):
        return "%s version %s is not a plain release version" % (tool_id, version or "unknown")
    for entry in (tool_policy or {}).get("denylist") or []:
        if entry.get("version") == version:
            return "%s %s is refused by the Portal: %s" % (tool_id, version, entry.get("reason"))
    floor = (tool_policy or {}).get("floor")
    if not isinstance(floor, str) or parse_version(floor) is None or compare_versions(version, floor) < 0:
        return "%s %s is older than the Portal floor %s; update it instead" % (tool_id, version, floor)
    record_floor = NPM_RECORD_FLOORS[tool_id]
    if compare_versions(version, record_floor) < 0:
        return "%s %s is older than the admission-record floor %s" % (tool_id, version, record_floor)
    return None


def admission_record_problem(record, tool_id, package_root, platform_key, tool_policy):
    """Mirror of parseNativeHostCliAdmissionRecord(): None if the backend would accept it."""
    layout = NPM_TOOL_LAYOUTS.get(tool_id)
    if layout is None:
        return "%s has no admission-record layout" % tool_id
    if not isinstance(record, dict) or set(record) != ADMISSION_RECORD_KEYS:
        return "admission record has unexpected or missing fields"
    if record["schema"] != SCHEMA_ADMISSION_RECORD:
        return "admission record schema is not supported"
    if record["toolId"] != tool_id or record["packageName"] != layout["packageName"] or record["packageRoot"] != package_root:
        return "admission record does not describe the catalog's %s package" % tool_id
    if not isinstance(record["platform"], str) or not _PLATFORM_KEY_RE.fullmatch(record["platform"]) \
            or record["platform"] != platform_key:
        return "admission record platform is invalid"
    refusal = npm_record_version_refusal(tool_id, record["version"], tool_policy)
    if refusal:
        return refusal
    if not isinstance(record["treeSha256"], str) or not _HEX_SHA256_RE.fullmatch(record["treeSha256"]):
        return "admission record tree digest is invalid"
    critical = record["criticalFiles"]
    if not isinstance(critical, dict) or len(critical) > 64 or not all(
            _record_safe_relative(k) and isinstance(v, str) and _HEX_SHA256_RE.fullmatch(v) for k, v in critical.items()):
        return "admission record critical files are invalid"
    groups = record["hardlinkGroups"]
    if not isinstance(groups, list) or len(groups) > 64 or not all(
            isinstance(g, list) and 2 <= len(g) <= 64 and all(_record_safe_relative(p) for p in g) and len(set(g)) == len(g)
            for g in groups):
        return "admission record hard-link groups are invalid"
    platform_values = [record["platformPackageRelative"], record["platformPackageName"],
                       record["platformPackageVersion"], record["platformBinRelative"]]
    tests = [_record_safe_relative, lambda v: bool(_PLATFORM_PACKAGE_NAME_RE.fullmatch(v)),
             lambda v: bool(_PLATFORM_PACKAGE_VERSION_RE.fullmatch(v)), _record_safe_relative]
    for value, test in zip(platform_values, tests):
        if value is not None and (not isinstance(value, str) or not test(value)):
            return "admission record platform package fields are invalid"
    if any(v is None for v in platform_values) and any(v is not None for v in platform_values):
        return "admission record platform package authority is incomplete"
    if not isinstance(record["admittedAt"], str) or not _ISO_INSTANT_RE.fullmatch(record["admittedAt"]) \
            or parse_ts(record["admittedAt"] if "." in record["admittedAt"] else record["admittedAt"][:-1] + ".000Z") is None:
        return "admission record time is invalid"
    if not isinstance(record["admittedBy"], str) or not _ADMITTED_BY_RE.fullmatch(record["admittedBy"]) \
            or record["admittedBy"] == "catalog-v1-migration":
        return "admission record author is invalid (toolctl writes run and requalify records only)"
    source = record["source"]
    if not isinstance(source, dict) or set(source) != ADMISSION_SOURCE_KEYS or source["kind"] != "npm-registry":
        return "admission record source must be the npm registry"
    if source["signatures"] != "verified" or source["verifier"] != "npm-audit-signatures":
        return "admission record does not prove verified registry signatures"
    if source["provenance"] not in ("verified", "unavailable"):
        return "admission record provenance is invalid"
    if ((tool_policy or {}).get("source") or {}).get("provenance") != "unavailable" and source["provenance"] != "verified":
        return "%s publishes provenance, and the record does not prove it was verified" % tool_id
    if source["tarball"] != official_npm_tarball_url(layout["packageName"], record["version"]):
        return "admission record tarball is not the official npm registry tarball for this version"
    if not isinstance(source["integrity"], str) or not _SRI_SHA512_RE.fullmatch(source["integrity"]):
        return "admission record integrity is not a sha512 digest"
    return None


def build_admission_record(tool_id, version, package_root, platform_key, facts, integrity, provenance, admitted_by,
                           admitted_at, tool_policy):
    layout = NPM_TOOL_LAYOUTS[tool_id]
    record = {
        "schema": SCHEMA_ADMISSION_RECORD,
        "toolId": tool_id,
        "packageName": layout["packageName"],
        "version": version,
        "platform": platform_key,
        "packageRoot": package_root,
        "treeSha256": facts["treeSha256"],
        "criticalFiles": dict(facts["criticalFiles"]),
        "hardlinkGroups": [list(group) for group in facts["hardlinkGroups"]],
        "platformPackageRelative": facts["platformPackageRelative"],
        "platformPackageName": facts["platformPackageName"],
        "platformPackageVersion": facts["platformPackageVersion"],
        "platformBinRelative": facts["platformBinRelative"],
        "source": {"kind": "npm-registry", "tarball": official_npm_tarball_url(layout["packageName"], version),
                   "integrity": integrity, "signatures": "verified", "provenance": provenance,
                   "verifier": "npm-audit-signatures"},
        "admittedAt": admitted_at,
        "admittedBy": admitted_by,
    }
    problem = admission_record_problem(record, tool_id, package_root, platform_key, tool_policy)
    if problem:
        raise NpmRefusal("ADMISSION_RECORD_INVALID", "The admission record could not be built: %s." % problem)
    return record


def write_admission_record(admission_dir, record):
    """Atomically replace <dir>/<toolId>.json (dir 0700, file 0600): exclusive
    temp file, fsync, rename, directory fsync. Returns the record path."""
    data = (json.dumps(record, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if len(data) > ADMISSION_RECORD_MAX_BYTES:
        raise NpmRefusal("ADMISSION_RECORD_INVALID", "The admission record is larger than the backend reads.")
    if record.get("toolId") not in NPM_TOOL_IDS:
        raise ToolctlError("admission records are written for npm CLIs only")
    ensure_private_dir(admission_dir)
    target = os.path.join(admission_dir, record["toolId"] + ".json")
    temporary = os.path.join(admission_dir, ".%s.%d.%s.tmp" % (record["toolId"], os.getpid(), os.urandom(6).hex()))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                 0o600)
    try:
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
    fsync_dir(admission_dir)
    return target


# -- requalify <tool> (b.5): prove the INSTALLED tree is the official release --

NPM_ACTIONS = ("requalify", "update", "install")
NPM_COMMAND_TIMEOUT = 600
NPM_INSTALL_TIMEOUT = 1200
NPM_SCRIPT_TIMEOUT = 300
CLI_PROBE_TIMEOUT = 60
NPM_OUTPUT_LIMIT = 8 * MIB
CLI_PROBE_OUTPUT_LIMIT = 256 * 1024
# Lifecycle scripts npm runs when it installs a registry package.
NPM_INSTALL_SCRIPTS = ("preinstall", "install", "postinstall")
_ALLOWED_SCRIPT_RE = re.compile(r"\Anode ([A-Za-z0-9_][A-Za-z0-9_.-]*\.c?js)\Z")


def npm_tool_layout_spec(tool_id, version, platform_key):
    """(root spec, platform spec or None) for `npm view`/`npm pack`."""
    layout = NPM_TOOL_LAYOUTS[tool_id]
    root = "%s@%s" % (layout["packageName"], version)
    table = layout["platformPackage"]
    if table is None:
        return root, None
    _relative, name, pattern, _bin = table[platform_key.split("-")[1]]
    return root, "%s@%s" % (name, pattern.format(version=version))


def _npm_env(work):
    return {"PATH": CLEAN_PATH, "LANG": "C.UTF-8", "NO_COLOR": "1", "HOME": os.path.join(work, "home")}


# The run's own user and global npm config: two distinct files. npm 11 refuses
# one file given as both ("double-loading config ... as global, previously
# loaded as user"), which failed every npm CLI update.
NPM_PRIVATE_CONFIGS = ("npmrc", "npmrc-global")


def _npm_flags(work):
    # Private config and cache: the host's npmrc (tokens, mirrors) is never read
    # here, and every request goes to the official registry.
    user_config, global_config = (os.path.join(work, name) for name in NPM_PRIVATE_CONFIGS)
    return ["--userconfig=" + user_config, "--globalconfig=" + global_config,
            "--cache=" + os.path.join(work, "cache"), "--registry=" + NPM_REGISTRY, "--no-update-notifier",
            "--loglevel=warn"]


def _npm_private_configs(work):
    """Create (or empty) the run's private npm config files, mode 0600, never through a symlink."""
    for name in NPM_PRIVATE_CONFIGS:
        try:
            fd = os.open(os.path.join(work, name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        except OSError as error:
            raise NpmRefusal("NPM_UNAVAILABLE", "The run's private npm settings file %s could not be prepared (%s)." % (
                name, error.strerror))
        os.close(fd)


def run_captured(argv, cwd, env, timeout, limit, out_path):
    """Run argv with stdout in a file (bounded read back) and bounded stderr. A probe sandbox's service is stopped
    when this stops waiting for it (sandbox_release)."""
    with open(out_path, "wb") as out:
        try:
            completed = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.PIPE,
                                       timeout=timeout, env=env, close_fds=True, check=False)
        except subprocess.TimeoutExpired:
            sandbox_release(argv)
            raise
    if completed.returncode < 0:
        sandbox_release(argv)
    with open(out_path, "rb") as handle:
        stdout = handle.read(limit + 1)
    if len(stdout) > limit:
        raise NpmRefusal("NPM_OUTPUT_TOO_LARGE", "%s printed more output than toolctl reads." % os.path.basename(argv[1 if len(argv) > 1 else 0]))
    return completed.returncode, stdout.decode("utf-8", "replace"), completed.stderr[:CAPTURE_LIMIT_BYTES].decode("utf-8", "replace")


# -- the probe sandbox --
# Candidate and vendor programs (the C-VER, C-HEADLESS, C-OUTPUT, C-APP and
# C-ACP probes, and the one reviewed npm install script) run in a transient
# systemd service. PID 1 builds its namespaces and mounts as root, outside any
# user namespace, so AppArmor's user-namespace rules do not apply (Ubuntu
# 26.04 confines whatever bubblewrap starts without any capability, so setpriv
# could not drop to nobody inside bwrap there). In the service, env -i gives
# the program only the environment named here, and setpriv runs it as
# nobody:nogroup with no supplementary groups, no capabilities and
# no_new_privs. The program's uid is a real host uid: Unix sockets that
# authorize by peer credentials, and root-only files, refuse it.
SANDBOX_UID = SANDBOX_GID = 65534
SANDBOX_DROP = ("--reuid=%d" % SANDBOX_UID, "--regid=%d" % SANDBOX_GID, "--clear-groups", "--inh-caps=-all",
                "--bounding-set=-all", "--no-new-privs")
SANDBOX_UNIT_PREFIX = "bridgesllm-tools-probe-"
# No probe service outlives the longest sandboxed command (the npm install script) by much, even if the toolctl
# waiting for it is killed; toolctl itself stops the service whenever it stops waiting (sandbox_release).
SANDBOX_RUNTIME_MAX_SECONDS = NPM_SCRIPT_TIMEOUT + 30
SANDBOX_PROPERTIES = (
    # The host read-only; a minimal /dev with empty /dev/shm, /dev/mqueue and /dev/hugepages; a private loopback
    # network, IPC and hostname; kernel tunables, modules, logs and cgroups out of reach; other users' processes
    # not visible in /proc.
    "ProtectSystem=strict", "PrivateDevices=yes", "TemporaryFileSystem=/dev/shm", "TemporaryFileSystem=/dev/mqueue",
    "TemporaryFileSystem=/dev/hugepages", "PrivateNetwork=yes", "PrivateIPC=yes", "ProtectHostname=yes",
    "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes",
    "ProtectProc=invisible",
    # Root in the service only until setpriv runs, with just the capabilities setpriv needs to become nobody.
    "NoNewPrivileges=yes", "CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP",
    # Every process of the probe ends with it, at once.
    "KillMode=control-group", "KillSignal=SIGKILL", "RuntimeMaxSec=%d" % SANDBOX_RUNTIME_MAX_SECONDS,
)
# Hidden behind fresh empty mounts: /run holds the host's control sockets on
# every supported distro (systemd's private socket, D-Bus, docker, containerd,
# snapd); /root is root's home.
SANDBOX_HIDDEN = ("/run", "/root")
# Hidden when present: other trees that can hold host control sockets or other
# services' state (container root filesystems, the LXD snap socket). /var/run
# is a symlink to /run on supported distros; a real directory there is hidden.
SANDBOX_HIDDEN_IF_PRESENT = ("/var/run", "/var/lib/docker", "/var/lib/containerd", "/var/lib/lxd", "/var/lib/kubelet",
                             "/var/snap")
# A path toolctl writes into a property: systemd-run splits property values on whitespace and colons and unquotes
# them, so only plain path characters pass unchanged.
_SANDBOX_PATH_RE = re.compile(r"/[A-Za-z0-9._@+/-]*")
# What `setpriv --dump` prints inside the box: the sandbox identity, no groups, no capabilities, no_new_privs.
SANDBOX_SELF_TEST_LINES = ("uid: %d" % SANDBOX_UID, "euid: %d" % SANDBOX_UID, "gid: %d" % SANDBOX_GID,
                           "egid: %d" % SANDBOX_GID, "Supplementary groups: [none]", "no_new_privs: 1",
                           "Inheritable capabilities: [none]", "Ambient capabilities: [none]",
                           "Capability bounding set: [none]")
SANDBOX_SELF_TEST_TIMEOUT = 60
_SANDBOX_SELF_TESTS = {}
# systemd's own exit statuses for a service it could not start as asked (systemd.exec(5) "Process Exit Codes").
SANDBOX_SYSTEMD_STATUS = {200: "CHDIR", 203: "EXEC", 217: "USER", 218: "CAPABILITIES", 226: "NAMESPACE", 228: "SECCOMP",
                          242: "NUMA"}


def sandbox_private_ancestor(path):
    """The highest directory above `path` that the sandbox identity cannot search, or None."""
    current = "/"
    for part in [p for p in os.path.dirname(path).split("/") if p]:
        current = os.path.join(current, part)
        try:
            if not os.stat(current).st_mode & stat.S_IXOTH:
                return current
        except OSError:
            return None
    return None


def sandbox_scratch(work):
    """A new empty directory in the run's work area, owned by the sandbox identity: one command's /tmp, with
    home/ as its HOME, so nothing one command leaves there reaches the next."""
    index = 0
    while True:
        index += 1
        scratch = os.path.join(work, "sandbox-tmp-%02d" % index)
        try:
            os.mkdir(scratch, 0o700)
            break
        except FileExistsError:
            continue
    os.mkdir(os.path.join(scratch, "home"), 0o700)
    for path in (os.path.join(scratch, "home"), scratch):
        os.chown(path, SANDBOX_UID, SANDBOX_GID, follow_symlinks=False)
    return scratch


class SandboxArgv(list):
    """A probe sandbox command line: `unit` names its transient service and `systemctl` stops it."""
    unit = systemctl = None


def sandbox_exec_arg(arg):
    """PID 1 expands $NAME and ${NAME} in a service's command line; $$ stands for one $."""
    return arg.replace("$", "$$")


def sandbox_property_path(path):
    if not _SANDBOX_PATH_RE.fullmatch(path) or os.path.normpath(path) != path:
        raise ValueError("systemd cannot be given the path %r unchanged" % path)
    return path


def probe_sandbox_argv(roots, work, argv, cwd="/tmp", env=(), readable=None, writable=None):
    """PID 1 builds the box (a transient service, through systemd-run), then setpriv runs `argv` in it as the
    sandbox identity.

    The host is read-only, with /run, /root and SANDBOX_HIDDEN_IF_PRESENT hidden; no network (a private loopback
    only), only the environment named here, and a fresh private /tmp owned by the sandbox identity (HOME=/tmp/home).
    `readable` is a host tree the program must read below a directory it cannot search (the staged candidate);
    `writable` is the one host tree it may write (the staged package, for its reviewed install script). Each is
    shown at its own path; the private directory around it stays hidden (PID 1 makes the path down to the tree,
    0755, inside the fresh mount). ValueError: a path systemd-run would not pass on unchanged.
    """
    hidden = list(SANDBOX_HIDDEN) + [p for p in SANDBOX_HIDDEN_IF_PRESENT if os.path.isdir(p) and not os.path.islink(p)]
    properties = list(SANDBOX_PROPERTIES) + ["TemporaryFileSystem=%s" % path for path in hidden]
    properties.append("BindPaths=%s:/tmp" % sandbox_property_path(sandbox_scratch(work)))
    for tree, option in ((readable, "BindReadOnlyPaths"), (writable, "BindPaths")):
        if not tree:
            continue
        tree = sandbox_property_path(os.path.realpath(tree))
        private = sandbox_private_ancestor(tree)
        if private and not any(_path_inside(path, private) for path in hidden + ["/tmp"]):
            properties.append("TemporaryFileSystem=%s" % private)
        if private or option == "BindPaths":
            properties.append("%s=%s:%s" % (option, tree, tree))
    unit = "%s%s.service" % (SANDBOX_UNIT_PREFIX, os.urandom(8).hex())
    box = SandboxArgv([npm_path(roots, "systemd_run_bin"), "--quiet", "--wait", "--pipe", "--collect",
                       "--service-type=exec", "--unit=" + unit, "--working-directory=" + sandbox_property_path(cwd)])
    box += ["--property=" + value for value in properties]
    environment = [("HOME", "/tmp/home"), ("TMPDIR", "/tmp"), ("PATH", CLEAN_PATH), ("LANG", "C.UTF-8"),
                   ("NO_COLOR", "1")] + list(env)
    command = ([npm_path(roots, "env_bin"), "-i"] + ["%s=%s" % pair for pair in environment]
               + [npm_path(roots, "setpriv_bin")] + list(SANDBOX_DROP) + ["--"] + list(argv))
    box += ["--"] + [sandbox_exec_arg(arg) for arg in command]
    box.unit, box.systemctl = unit, roots.systemctl_bin
    return box


def sandbox_release(argv):
    """Stop a probe sandbox's service once toolctl stops waiting for it (a timeout, a stop request, an ACP exchange
    that is over): systemd-run only reports on the service, so its own end leaves the service running."""
    unit, systemctl = getattr(argv, "unit", None), getattr(argv, "systemctl", None)
    if not unit or not systemctl:
        return
    try:
        subprocess.run([systemctl, "stop", unit], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=SYSTEMCTL_TIMEOUT, close_fds=True, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass  # RuntimeMaxSec still ends it


def sandbox_self_test(roots, work):
    """None when `setpriv --dump` in the box shows exactly the sandbox identity without privileges, else what went
    wrong. Once per toolctl process, before its first probe: a server that does not allow the mechanism gets one
    plain refusal instead of every probe failing as if the tool were broken."""
    key = (npm_path(roots, "systemd_run_bin"), npm_path(roots, "env_bin"), npm_path(roots, "setpriv_bin"))
    if key in _SANDBOX_SELF_TESTS:
        return _SANDBOX_SELF_TESTS[key]
    argv = probe_sandbox_argv(roots, work, [key[2], "--dump"])
    try:
        completed = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=SANDBOX_SELF_TEST_TIMEOUT, env={"PATH": CLEAN_PATH}, close_fds=True,
                                   check=False)
    except subprocess.TimeoutExpired:
        sandbox_release(argv)
        problem = "a sandboxed check did not finish within %d seconds" % SANDBOX_SELF_TEST_TIMEOUT
    except OSError as error:
        problem = "systemd-run could not be started: %s" % (error.strerror or error)
    else:
        if completed.returncode < 0:
            sandbox_release(argv)
        seen = completed.stdout.decode("utf-8", "replace").splitlines()
        missing = [line for line in SANDBOX_SELF_TEST_LINES if line not in seen]
        if completed.returncode != 0:
            status = "%d/%s" % (completed.returncode, SANDBOX_SYSTEMD_STATUS[completed.returncode]) \
                if completed.returncode in SANDBOX_SYSTEMD_STATUS else "%d" % completed.returncode
            problem = "systemd could not run a sandboxed check: exit status %s, %s" % (
                status, tail_text(completed.stderr.decode("utf-8", "replace").strip(), 200) or "no message")
        elif missing:
            problem = "a sandboxed check did not run as nobody without privileges (no %s)" % "; no ".join(
                "'%s'" % line for line in missing)
        else:
            problem = None
    _SANDBOX_SELF_TESTS[key] = problem
    return problem


def sandbox_unavailable(roots, label, work=None):
    """The reason the probe sandbox cannot run here, or None. With the run's `work` directory, the box must also have
    passed its self-test on this server (sandbox_self_test)."""
    for name, what in (("systemd_run_bin", "systemd-run"), ("env_bin", "env"), ("setpriv_bin", "setpriv")):
        if not trusted_executable(npm_path(roots, name)):
            return "The probe sandbox (%s at %s) is not installed, so %s cannot be checked safely." % (
                what, npm_path(roots, name), label)
    try:
        problem = sandbox_self_test(roots, work) if work else None
    except (OSError, ValueError) as error:
        problem = "its private /tmp could not be prepared: %s" % (getattr(error, "strerror", None) or error)
    if problem:
        return "The probe sandbox does not work on this server (%s), so %s cannot be checked safely." % (problem, label)
    return None


def npm_retree(root, uid, gid, publish=False, max_entries=None, refusal=None):
    """Make uid:gid own every entry of a staged package tree, never through a link (uid None keeps every owner). With
    `publish`, refuse set-user-ID, set-group-ID and sticky bits, give the installer's public modes (directories and
    executables 0755, other files 0644) and re-read each entry to prove it. Refusals are NpmRefusal (NPM_TREE_*), or
    HarnessRefusal (HARNESS_TREE_*, naming the tree) when `refusal` is HarnessRefusal."""
    limit = NPM_TREE_LIMITS["maxEntries"] if max_entries is None else max_entries
    refusal = refusal or NpmRefusal
    unsafe, changed = ("NPM_TREE_UNSAFE", "NPM_TREE_CHANGED") if refusal is NpmRefusal else \
        ("HARNESS_TREE_UNSAFE", "HARNESS_TREE_CHANGED")
    entry = "Package entry %s" if refusal is NpmRefusal else "Entry %s of " + root
    pending, seen = [root], 0
    while pending:
        path = pending.pop()
        seen += 1
        if seen > limit + 1:
            raise refusal(unsafe, "The package tree has more entries than the admission walker allows."
                          if refusal is NpmRefusal else "%s has more than %d entries; it is not admitted." % (root, limit))
        relative = os.path.relpath(path, root)
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            if uid is not None:
                os.chown(path, uid, gid, follow_symlinks=False)
            continue
        directory = stat.S_ISDIR(info.st_mode)
        if not directory and not stat.S_ISREG(info.st_mode):
            raise refusal(unsafe, (entry + " is a special file.") % relative)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC | (os.O_DIRECTORY if directory else 0))
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise refusal(changed, (entry + " changed while its owner was set.") % relative)
            if publish and stat.S_IMODE(opened.st_mode) & 0o7000:
                raise refusal(unsafe, (entry + " has set-user-ID, set-group-ID or sticky permissions; it is not "
                                       "admitted.") % relative)
            if uid is not None:
                os.fchown(fd, uid, gid)
            if publish:
                mode = 0o755 if directory or opened.st_mode & 0o100 else 0o644
                os.fchmod(fd, mode)
                after = os.fstat(fd)
                if stat.S_IMODE(after.st_mode) != mode or (uid is not None and (after.st_uid, after.st_gid) != (uid, gid)):
                    raise refusal(unsafe, (entry + " did not take its owner and permissions.") % relative)
            if directory:
                pending.extend(os.path.join(path, name) for name in os.listdir(fd))
        finally:
            os.close(fd)


class NpmTool(object):
    """One npm CLI flow's private workspace and the commands it may run."""

    def __init__(self, roots, tool_id, tool_policy, work, uid=0, gid=0, platform_key=None, runner=run_captured):
        self.roots = roots
        self.tool_id = tool_id
        self.policy = tool_policy
        self.layout = NPM_TOOL_LAYOUTS[tool_id]
        self.work = work
        self.uid, self.gid = uid, gid
        self.platform_key = platform_key or npm_platform_key()
        self.runner = runner
        self.package_root = os.path.join(roots.npm_global_root, self.layout["packageName"])
        self.calls = 0

    def label(self, version=None):
        return "%s %s" % (self.policy.get("label") or self.tool_id, version) if version else (self.policy.get("label") or self.tool_id)

    def npm(self, args, cwd=None, timeout=NPM_COMMAND_TIMEOUT, private=True):
        for path in (npm_path(self.roots, "node_bin"), npm_path(self.roots, "npm_bin")):
            if not trusted_executable(path):
                raise NpmRefusal("NPM_UNAVAILABLE", "%s is missing or not a trusted executable." % path)
        self.calls += 1
        if private:
            _npm_private_configs(self.work)
        argv = [npm_path(self.roots, "node_bin"), npm_path(self.roots, "npm_bin")] + list(args) + (_npm_flags(self.work) if private else [])
        env = _npm_env(self.work) if private else {"PATH": CLEAN_PATH, "LANG": "C.UTF-8", "NO_COLOR": "1", "HOME": "/root"}
        try:
            return self.runner(argv, cwd or self.work, env, timeout, NPM_OUTPUT_LIMIT,
                               os.path.join(self.work, "npm-%02d.out" % self.calls))
        except subprocess.TimeoutExpired:
            raise NpmRefusal("NPM_TIMEOUT", "npm %s did not finish within %d seconds." % (args[0], timeout))

    def sandbox_argv(self, argv, writable=None, cwd=None):
        """The probe sandbox (probe_sandbox_argv), run as nobody:nogroup. The staged candidate is readable;
        `writable` (the staged package, for its reviewed install script) is the only writable host tree."""
        problem = sandbox_unavailable(self.roots, self.label(), self.work)
        if problem:
            raise NpmRefusal("NPM_SANDBOX_UNAVAILABLE", problem)
        staged = os.path.join(self.work, "stage", "node_modules", self.layout["packageName"])
        readable = staged if writable is None and _path_inside(staged, argv[0]) else None
        try:
            return probe_sandbox_argv(self.roots, self.work, argv, cwd or "/tmp", readable=readable, writable=writable)
        except OSError as error:
            raise NpmRefusal("NPM_SANDBOX_UNAVAILABLE", "The probe sandbox's private /tmp could not be prepared (%s), so "
                             "%s cannot be checked safely." % (error.strerror or error, self.label()))
        except ValueError as error:
            raise NpmRefusal("NPM_SANDBOX_UNAVAILABLE", "The probe sandbox could not be set up (%s), so %s cannot be "
                             "checked safely." % (error, self.label()))


def _json_doc(text, what):
    try:
        doc = json.loads(text)
    except ValueError:
        raise NpmRefusal("NPM_METADATA_INVALID", "%s is not valid JSON." % what)
    return doc


def npm_registry_check(tool):
    """d.2 step 1: the host's npm must point at the official registry (Q6)."""
    names = ["registry"]
    if tool.layout["packageName"].startswith("@"):
        names.append(tool.layout["packageName"].split("/")[0] + ":registry")
    for name in names:
        code, out, _err = tool.npm(["config", "get", name], private=False, timeout=60)
        value = out.strip()
        if code != 0:
            raise NpmRefusal("NPM_UNAVAILABLE", "npm could not report its %s setting." % name)
        if name != "registry" and value in ("", "undefined", "null"):
            continue
        if value.rstrip("/") + "/" != NPM_REGISTRY:
            raise NpmRefusal("NPM_CUSTOM_REGISTRY", "This server's npm uses %s for %s. A custom registry is not supported "
                             "for admitted tools; only %s is." % (redact_text(value) or "an unknown registry", name, NPM_REGISTRY))


def npm_allowed_scripts(tool_policy):
    allowed = ((tool_policy or {}).get("source") or {}).get("installScripts") or {}
    if not isinstance(allowed, dict) or not all(
            k in NPM_INSTALL_SCRIPTS and isinstance(v, str) and _ALLOWED_SCRIPT_RE.fullmatch(v) for k, v in allowed.items()):
        raise NpmRefusal("POLICY_INVALID", "The tool policy lists install scripts in a form toolctl cannot run safely.")
    return allowed


def npm_view(tool, spec):
    """Registry metadata for an exact spec, checked against the official tarball URL."""
    name, _, version = spec.rpartition("@")
    code, out, err = tool.npm(["view", spec, "--json"])
    if code != 0:
        raise NpmRefusal("NPM_METADATA_UNAVAILABLE", "The npm registry did not describe %s (%s)." % (spec, tail_text(redact_text(err), 200)))
    doc = _json_doc(out, "npm view %s" % spec)
    if isinstance(doc, list) and len(doc) == 1:
        doc = doc[0]
    dist = doc.get("dist") if isinstance(doc, dict) else None
    if not isinstance(dist, dict) or doc.get("name") != name or doc.get("version") != version:
        raise NpmRefusal("NPM_METADATA_INVALID", "The npm registry answer for %s does not describe that exact release." % spec)
    if dist.get("tarball") != official_npm_tarball_url(name, version):
        raise NpmRefusal("NPM_CUSTOM_REGISTRY", "%s is not served from the official npm registry tarball." % spec)
    if not isinstance(dist.get("integrity"), str) or not _SRI_SHA512_RE.fullmatch(dist["integrity"]):
        raise NpmRefusal("NPM_METADATA_INVALID", "The npm registry gives no sha512 integrity for %s." % spec)
    return doc


def npm_scripts_problem(scripts, allowed, package_label):
    scripts = scripts if isinstance(scripts, dict) else {}
    for name in NPM_INSTALL_SCRIPTS:
        if name in scripts and allowed.get(name) != scripts[name]:
            return "%s declares a %s script the Portal has not reviewed (%s)" % (package_label, name, tail_text(str(scripts[name]), 80))
    return None


def sri_sha512_file(path):
    digest = hashlib.sha512()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return "sha512-" + base64.b64encode(digest.digest()).decode("ascii")


def npm_fetch_verified(tool, spec, expected_integrity):
    """`npm pack` the exact release; its sha512 must equal the registry integrity (d.2 step 2)."""
    destination = os.path.join(tool.work, "fetch")
    ensure_private_dir(destination)
    code, out, err = tool.npm(["pack", spec, "--json", "--pack-destination", destination])
    doc = _json_doc(out, "npm pack %s" % spec) if code == 0 else None
    entry = doc[0] if isinstance(doc, list) and len(doc) == 1 and isinstance(doc[0], dict) else None
    filename = entry.get("filename") if entry else None
    if not isinstance(filename, str) or os.path.basename(filename) != filename or not filename.endswith(".tgz"):
        raise NpmRefusal("NPM_FETCH_FAILED", "npm could not download %s (%s)." % (spec, tail_text(redact_text(err), 200)))
    path = os.path.join(destination, filename)
    if not os.path.isfile(path) or os.path.islink(path):
        raise NpmRefusal("NPM_FETCH_FAILED", "npm reported %s but wrote no tarball." % spec)
    actual = sri_sha512_file(path)
    if actual != expected_integrity:
        raise NpmRefusal("NPM_INTEGRITY_MISMATCH", "The downloaded %s does not match the registry's sha512 integrity; "
                         "it was not used." % spec, {"expected": expected_integrity, "actual": actual})
    return {"spec": spec, "file": filename, "integrity": actual}


def npm_stage(tool, version, integrities):
    """Install the exact release into a private project with npm's global
    layout (`--install-strategy=shallow`), scripts off; bind its lockfile
    integrity to the verified tarballs. Returns the staged package root."""
    stage = os.path.join(tool.work, "stage")
    ensure_private_dir(stage)
    atomic_write_json(os.path.join(stage, "package.json"), {
        "name": "bridgesllm-stage", "version": "0.0.0", "private": True,
        "dependencies": {tool.layout["packageName"]: version}})
    code, _out, err = tool.npm(["install", "--install-strategy=shallow", "--ignore-scripts", "--no-audit", "--no-fund",
                                "--prefer-offline"], cwd=stage, timeout=NPM_INSTALL_TIMEOUT)
    if code != 0:
        raise NpmRefusal("NPM_STAGE_FAILED", "npm could not stage %s (%s)." % (tool.label(version), tail_text(redact_text(err), 200)))
    lock = read_json_file(os.path.join(stage, "package-lock.json"), max_bytes=NPM_OUTPUT_LIMIT)
    packages = lock.get("packages") if isinstance(lock, dict) else None
    if not isinstance(packages, dict):
        raise NpmRefusal("NPM_STAGE_FAILED", "The staged install left no readable lockfile.")
    for location, integrity in integrities.items():
        entry = packages.get(location)
        if not isinstance(entry, dict) or entry.get("integrity") != integrity:
            raise NpmRefusal("NPM_INTEGRITY_MISMATCH", "The staged %s is not the verified tarball." % location)
    staged_root = os.path.join(stage, "node_modules", tool.layout["packageName"])
    # npm wrote it under toolctl's umask 077, but the probes run the candidate as the sandbox identity, so the staged
    # package takes the installer's public runtime modes (it holds no secrets; its private parents stay private).
    if os.path.isdir(staged_root) and not os.path.islink(staged_root):
        npm_retree(staged_root, tool.uid, tool.gid, publish=True)
    return stage, staged_root


def npm_staged_scripts_problem(staged_root, allowed, max_packages=4096):
    """Any package in the staged tree that wants an install script (or a native
    build) the policy does not list is refused: nothing ran, nothing will."""
    seen = 0
    for directory, dirs, files in os.walk(staged_root):
        dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(directory, d)))
        if "package.json" not in files:
            continue
        if directory != staged_root and os.path.basename(os.path.dirname(directory)) not in ("node_modules",) \
                and not os.path.basename(os.path.dirname(directory)).startswith("@"):
            continue
        seen += 1
        if seen > max_packages:
            return "the staged tree has more packages than toolctl inspects"
        try:
            doc = read_json_file(os.path.join(directory, "package.json"), max_bytes=1024 * 1024)
        except ToolctlError as error:
            return "a staged package could not be inspected (%s)" % error
        if not isinstance(doc, dict):
            return "a staged package.json in %s is not a JSON object" % os.path.relpath(directory, staged_root)
        label = "%s@%s" % (doc.get("name"), doc.get("version"))
        problem = npm_scripts_problem(doc.get("scripts"), allowed if directory == staged_root else {}, label)
        if problem:
            return problem
        if "binding.gyp" in files and not any(k in (doc.get("scripts") or {}) for k in ("install", "preinstall")):
            return "%s builds native code at install time, which the Portal has not reviewed" % label
    return None


def npm_audit_signatures(tool, stage, specs):
    """d.2 steps 3-4 via `npm audit signatures` on the staged project."""
    code, out, err = tool.npm(["audit", "signatures", "--json", "--include-attestations"], cwd=stage)
    doc = _json_doc(out, "npm audit signatures") if out.strip() else None
    if not isinstance(doc, dict) or not isinstance(doc.get("invalid"), list) or not isinstance(doc.get("missing"), list):
        raise NpmRefusal("NPM_SIGNATURES_UNVERIFIED", "npm could not verify the registry signatures (%s)." % tail_text(redact_text(err), 200))
    if doc["invalid"] or doc["missing"] or code != 0:
        bad = ["%s@%s" % (i.get("name"), i.get("version")) for i in (doc["invalid"] + doc["missing"]) if isinstance(i, dict)]
        raise NpmRefusal("NPM_SIGNATURES_INVALID", "The npm registry signatures did not verify for %s; nothing was admitted."
                         % (", ".join(bad[:5]) or "the staged release"), {"invalid": len(doc["invalid"]), "missing": len(doc["missing"])})
    attested = set()
    for item in doc.get("verified") or []:
        if isinstance(item, dict) and item.get("attestations"):
            attested.add("%s@%s" % (item.get("name"), item.get("version")))
    return all(spec in attested for spec in specs)


def npm_run_allowed_script(tool, staged_root, allowed):
    """The reviewed install script (e.g. Claude Code's `node install.cjs`), run
    only inside the sandbox: no network, read-only host, only the stage writable."""
    for name in NPM_INSTALL_SCRIPTS:
        command = allowed.get(name)
        if not command:
            continue
        script = _ALLOWED_SCRIPT_RE.fullmatch(command).group(1)
        if not trusted_executable(npm_path(tool.roots, "node_bin")):
            raise NpmRefusal("NPM_UNAVAILABLE", "%s is missing or not a trusted executable." % npm_path(tool.roots, "node_bin"))
        argv = tool.sandbox_argv([npm_path(tool.roots, "node_bin"), script], writable=staged_root, cwd=staged_root)
        # The script runs as the sandbox identity: the staged package is its own for the run, then the runner's again
        # with the installer's public modes (and no set-ID bits) before anything is checked or committed.
        npm_retree(staged_root, SANDBOX_UID, SANDBOX_GID)
        try:
            code, _out, err = tool.runner(argv, staged_root, {"PATH": CLEAN_PATH}, NPM_SCRIPT_TIMEOUT, CLI_PROBE_OUTPUT_LIMIT,
                                          os.path.join(tool.work, "script-%s.out" % name))
        except subprocess.TimeoutExpired:
            code = None
        finally:
            npm_retree(staged_root, tool.uid, tool.gid, publish=True)
        if code is None:
            raise NpmRefusal("NPM_INSTALL_SCRIPT_FAILED", "The %s %s script did not finish in time." % (tool.label(), name))
        if code != 0:
            raise NpmRefusal("NPM_INSTALL_SCRIPT_FAILED", "The %s %s script failed in the sandbox (%s)." % (
                tool.label(), name, tail_text(redact_text(err), 200)))


# C-VER: the flag each CLI answers with its own version. ClawHub has no
# `--version` (0.23.3: "unknown option '--version'"; 0.24.1: help on stderr,
# exit 1); its own flag is `-V, --cli-version`, which prints the version from
# the package.json beside its code and exits 0.
CLI_VERSION_ARGS = {"clawhub": ("--cli-version",)}


def cli_probe_version(tool, executable, version):
    """C-VER: the CLI's version flag (`--version`; ClawHub `--cli-version`) in
    the sandbox prints exactly this version: the program runs and reports it."""
    args = list(CLI_VERSION_ARGS.get(tool.tool_id, ("--version",)))
    flag = " ".join(args)
    argv = tool.sandbox_argv([executable] + args)
    started = time.time()
    try:
        code, out, err = tool.runner(argv, "/", {"PATH": CLEAN_PATH}, CLI_PROBE_TIMEOUT, CLI_PROBE_OUTPUT_LIMIT,
                                     os.path.join(tool.work, "probe-c-ver.out"))
    except subprocess.TimeoutExpired:
        return {"id": "C-VER", "state": "failed", "reason": "%s did not answer within %d s" % (flag, CLI_PROBE_TIMEOUT)}
    record = {"id": "C-VER", "argv": [executable] + args, "exitCode": code, "stdout": tail_text(redact_text(out), 400),
              "stderr": tail_text(redact_text(err), 400), "seconds": round(time.time() - started, 3)}
    first = out.strip().splitlines()[0] if out.strip() else ""
    if code == 0 and re.search(r"(?<![0-9.])%s(?![0-9]|\.[0-9])" % re.escape(version), first):
        record["state"] = "passed"
    else:
        record.update(state="failed", reason="%s printed %r, not %s" % (flag, tail_text(first, 80), version))
    return record


# C-HEADLESS: every flag the native Claude adapter and the Project sandbox pass
# (backend/src/agents/providers/native/adapters/claude.ts and
# projectSandbox/ClaudeCodeProjectSandbox.ts; a test keeps this list equal to
# their literals), and the ClawHub subcommands backend/src/routes/skills.ts runs.
CLAUDE_HEADLESS_FLAGS = (
    "--add-dir", "--allowedTools", "--disable-slash-commands", "--disallowedTools", "--include-partial-messages",
    "--input-format", "--mcp-config", "--model", "--output-format", "--permission-mode", "--resume", "--safe-mode",
    "--session-id", "--setting-sources", "--settings", "--strict-mcp-config", "--tools", "--verbose", "-p",
)
CLAWHUB_SUBCOMMANDS = ("explore", "inspect", "search")
CLI_HELP_WORDS = {"claude-code": CLAUDE_HEADLESS_FLAGS, "clawhub": CLAWHUB_SUBCOMMANDS}
# C-OUTPUT: the adapter's headless stream-json invocation, offline and without
# credentials, so nothing can reach a model; only the framing is checked.
CLAUDE_OUTPUT_ARGS = ("-p", "--verbose", "--output-format", "stream-json", "--setting-sources", "", "--strict-mcp-config",
                      "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk", "BridgesLLM capability probe")
CLI_OUTPUT_TIMEOUT = 30


def _sandboxed_probe(tool, probe_id, argv, timeout):
    """Run a probe in the sandbox; a timeout keeps what was printed so far."""
    out_path = os.path.join(tool.work, "probe-%s.out" % probe_id.lower())
    started = time.time()
    try:
        code, out, err = tool.runner(tool.sandbox_argv(argv), "/", {"PATH": CLEAN_PATH}, timeout, CLI_PROBE_OUTPUT_LIMIT, out_path)
        timed_out = False
    except subprocess.TimeoutExpired:
        with open(out_path, "rb") as handle:
            out = handle.read(CLI_PROBE_OUTPUT_LIMIT).decode("utf-8", "replace")
        code, err, timed_out = None, "", True
    record = {"id": probe_id, "argv": list(argv), "exitCode": code, "timedOut": timed_out,
              "stdout": tail_text(redact_text(out), 800), "stderr": tail_text(redact_text(err), 400),
              "seconds": round(time.time() - started, 3)}
    return record, out, err


def cli_probe_help(tool, executable):
    """C-HEADLESS: `<cli> --help` names every flag/subcommand the Portal uses."""
    words = CLI_HELP_WORDS[tool.tool_id]
    record, out, err = _sandboxed_probe(tool, "C-HEADLESS", [executable, "--help"], CLI_PROBE_TIMEOUT)
    text = out + "\n" + err
    missing = [w for w in words if not re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(w), text)]
    if record["exitCode"] == 0 and not missing:
        record["state"] = "passed"
    else:
        record.update(state="failed", missing=missing, reason="--help does not list %s" % ", ".join(missing)
                      if missing else "--help did not exit cleanly")
    return record


def cli_probe_stream_json(tool, executable):
    """C-OUTPUT: every line of the headless stream-json output is a JSON object with a `type`."""
    record, out, _err = _sandboxed_probe(tool, "C-OUTPUT", [executable] + list(CLAUDE_OUTPUT_ARGS), CLI_OUTPUT_TIMEOUT)
    lines = [line for line in out.splitlines() if line.strip()]
    if record["timedOut"] and lines and not out.endswith("\n"):
        lines = lines[:-1]  # the line being written when the probe was stopped
    bad = None
    for line in lines:
        try:
            doc = json.loads(line)
        except ValueError:
            doc = None
        if not isinstance(doc, dict) or not isinstance(doc.get("type"), str):
            bad = line
            break
    if lines and bad is None:
        record.update(state="passed", records=len(lines))
    else:
        record.update(state="failed", reason="the stream-json output is not framed as JSON records" if lines
                      else "the headless mode printed no stream-json records")
    return record


# C-HEADLESS for Codex: each command's --help must list the flags the Portal
# passes to it: backend/src/agents/providers/native/adapters/codex.ts (`exec`,
# `exec resume`) and projectSandbox/CodexProjectSandbox.ts (global flags before
# the command, `exec`, `exec resume`, and the `sandbox` egress check). A test
# keeps the union equal to their literals.
CODEX_HEADLESS_FLAGS = (
    ((), ("--ask-for-approval", "--cd", "--profile", "--strict-config")),
    (("exec",), ("--color", "--dangerously-bypass-approvals-and-sandbox", "--ignore-rules", "--image", "--json", "--model",
                 "--sandbox", "--skip-git-repo-check", "-c")),
    (("exec", "resume"), ("--dangerously-bypass-approvals-and-sandbox", "--ignore-rules", "--image", "--json", "--model",
                          "--skip-git-repo-check", "-c")),
    (("sandbox",), ("--cd", "--permission-profile", "--profile")),
)
# C-APP: the handshake OpenClaw's Codex plugin makes with an app server it
# starts (@openclaw/codex client-initialize: `initialize` with clientInfo and
# capabilities, newline-delimited JSON over stdio, no "jsonrpc" member). Its
# answer's userAgent names the server version (readCodexVersionFromUserAgent),
# and the plugin refuses servers older than 0.149.0
# (assertSupportedCodexAppServerVersion). The args are the ones the legacy
# override (DESIGN d.6) passes.
CODEX_APP_SERVER_ARGS = ("app-server", "--listen", "stdio://")
CODEX_APP_SERVER_MIN_VERSION = "0.149.0"
CODEX_APP_INITIALIZE = {"id": 1, "method": "initialize", "params": {
    "clientInfo": {"name": "bridgesllm-portal", "title": "BridgesLLM Portal capability check", "version": "1"},
    "capabilities": {"experimentalApi": True}}}
CODEX_USER_AGENT_RE = re.compile(r"^[^/]+/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[\s(]|$)")
CODEX_APP_TIMEOUT = 30


def codex_probe_headless(tool, executable):
    """C-HEADLESS (Codex): `<command> --help` lists every flag the Portal passes to that command."""
    commands, missing = [], []
    for index, (command, flags) in enumerate(CODEX_HEADLESS_FLAGS):
        argv = [executable] + list(command) + ["--help"]
        record, out, err = _sandboxed_probe(tool, "C-HEADLESS-%d" % index, argv, CLI_PROBE_TIMEOUT)
        text = out + "\n" + err
        absent = [f for f in flags if not re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(f), text)]
        label = " ".join(("codex",) + tuple(command))
        commands.append({"argv": argv, "exitCode": record["exitCode"], "timedOut": record["timedOut"], "missing": absent,
                         "stdout": record["stdout"], "seconds": record["seconds"]})
        if record["exitCode"] != 0:
            missing.append("%s --help (did not exit cleanly)" % label)
        missing.extend("%s %s" % (label, flag) for flag in absent)
    record = {"id": "C-HEADLESS", "commands": commands}
    if missing:
        record.update(state="failed", missing=missing, reason="--help does not list %s" % ", ".join(missing[:8]))
    else:
        record["state"] = "passed"
    return record


def codex_app_server_override(roots):
    """d.6: does OpenClaw's Codex plugin still start the host Codex? ("present"|"absent"|"unknown", detail).

    Read from openclaw.json when it is plain JSON; anything else is unknown, so
    C-APP stays required (fail closed).
    """
    path = os.path.join(roots.openclaw_state_dir, "openclaw.json")
    try:
        config = read_json_file(path, max_bytes=CONFIG_MAX_BYTES)
    except (ToolctlError, OSError) as error:
        return "unknown", {"path": path, "reason": "openclaw.json isn't plain JSON or can't be read: %s" % str(error)[:200]}
    if config is None:
        return "absent", {"path": path, "reason": "no OpenClaw configuration"}
    node = config
    for key in ("plugins", "entries", "codex", "config", "appServer"):
        if not isinstance(node, dict):
            return "unknown", {"path": path, "reason": "the configuration above plugins.entries.codex.config.appServer has "
                               "an unexpected shape"}
        node = node.get(key)
        if node is None:
            return "absent", {"path": path}
    if isinstance(node, dict) and node.get("command") is None:
        return "absent", {"path": path}
    if isinstance(node, dict) and isinstance(node.get("command"), str):
        args = node.get("args") if isinstance(node.get("args"), list) else None
        return "present", {"path": path, "command": node["command"][:300],
                           "args": [str(a)[:100] for a in args[:10]] if args is not None else None}
    return "unknown", {"path": path, "reason": "plugins.entries.codex.config.appServer has an unexpected shape"}


def codex_probe_app(tool, executable, version):
    """C-APP: `codex app-server` answers OpenClaw's initialize handshake, offline and without credentials.

    Required only while the legacy appServer.command override is in place (d.6);
    otherwise recorded as not required.
    """
    override, detail = codex_app_server_override(tool.roots)
    if override == "absent":
        return {"id": "C-APP", "state": "not-required", "override": override, "overrideDetail": detail,
                "reason": "OpenClaw's Codex plugin runs its own bundled Codex, not this one."}
    argv = [executable] + list(CODEX_APP_SERVER_ARGS)
    started = time.time()
    try:
        exchange = acp_exchange(tool.sandbox_argv(argv), [CODEX_APP_INITIALIZE], CODEX_APP_TIMEOUT,
                                os.path.join(tool.work, "probe-c-app.out"))
    except OSError as error:
        return {"id": "C-APP", "state": "failed", "argv": argv, "override": override, "overrideDetail": detail,
                "reason": "the app server could not be started: %s" % (error.strerror or error)}
    answer = exchange["answers"].get(1) or {}
    result = answer.get("result") if isinstance(answer.get("result"), dict) else None
    agent = result.get("userAgent") if result is not None and isinstance(result.get("userAgent"), str) else None
    match = CODEX_USER_AGENT_RE.match(agent or "")
    served = match.group(1) if match else None
    record = {"id": "C-APP", "argv": argv, "override": override, "overrideDetail": detail, "exitCode": exchange["exitCode"],
              "timedOut": exchange["timedOut"], "userAgent": tail_text(agent, 200) if agent else None, "servedVersion": served,
              "lines": [tail_text(redact_text(line), 300) for line in exchange["lines"][:5]],
              "stderr": tail_text(redact_text(exchange["stderr"]), 400), "seconds": round(time.time() - started, 3)}
    if served is not None and parse_version(served) and served == version \
            and compare_versions(served, CODEX_APP_SERVER_MIN_VERSION) >= 0:
        record["state"] = "passed"
    elif served is not None:
        record.update(state="failed", reason="the app server reports Codex %s, expected %s (OpenClaw needs at least %s)" % (
            served, version, CODEX_APP_SERVER_MIN_VERSION))
    else:
        error = answer.get("error") if isinstance(answer.get("error"), dict) else None
        record.update(state="failed", reason="the app server didn't answer initialize%s" % (
            ": %s" % tail_text(str(error.get("message")), 200) if error and error.get("message")
            else " within %d s" % CODEX_APP_TIMEOUT if exchange["timedOut"] else ""))
    return record


def cli_probe_set(tool, executable, version):
    """The policy's required probes this build implements; others are recorded
    as not run (never as passed). Returns (records, first failed record or None)."""
    required = list(((tool.policy.get("probes") or {}).get("required")) or [])
    records = []
    for probe_id in required:
        if probe_id == "C-VER":
            record = cli_probe_version(tool, executable, version)
        elif probe_id == "C-HEADLESS" and tool.tool_id in CLI_HELP_WORDS:
            record = cli_probe_help(tool, executable)
        elif probe_id == "C-HEADLESS" and tool.tool_id == "codex":
            record = codex_probe_headless(tool, executable)
        elif probe_id == "C-APP" and tool.tool_id == "codex":
            record = codex_probe_app(tool, executable, version)
        elif probe_id == "C-OUTPUT" and tool.tool_id == "claude-code":
            record = cli_probe_stream_json(tool, executable)
        else:
            record = {"id": probe_id, "state": "not-run", "reason": "Not in this Portal build yet."}
        records.append(record)
        if record["state"] == "failed":
            return records, record
    return records, None


def npm_installed(tool):
    """The installed version and tree, after the same path checks the backend makes."""
    layout = tool.layout
    expected_link = "../lib/node_modules/%s/%s" % (layout["packageName"], layout["binRelative"])
    executable = os.path.join(npm_path(tool.roots, "npm_bin_dir"), layout["executables"][0])
    try:
        link = os.readlink(executable)
    except FileNotFoundError:
        raise NpmRefusal("NPM_TOOL_ABSENT", "%s is not installed. %s" % (
            tool.label(), missing_tool_note(tool.tool_id)))
    except OSError:
        raise NpmRefusal("NPM_TREE_UNSAFE", "%s is not the expected symlink." % executable)
    if link != expected_link or os.path.normpath(os.path.join(os.path.dirname(executable), link)) != \
            os.path.join(tool.package_root, layout["binRelative"]):
        raise NpmRefusal("NPM_TREE_UNSAFE", "%s does not point at the %s package." % (executable, tool.label()))
    snapshot = npm_tree_snapshot(tool.package_root, uid=tool.uid, gid=tool.gid)
    package_json = _snapshot_json(snapshot, "package.json", "%s package.json" % tool.label())
    version = package_json.get("version")
    if package_json.get("name") != layout["packageName"] or not isinstance(version, str):
        raise NpmRefusal("NPM_TREE_MISMATCH", "%s package.json does not name %s." % (tool.label(), layout["packageName"]))
    return version, snapshot, executable


def npm_scope_dir_ready(tool):
    """The scope directory of a scoped CLI (@openai, @anthropic-ai), set to 0755 before the installed CLI is probed
    or switched. Fresh installs before 5.2.0 created it 0700, so nobody but root could reach the CLI: the probe (run
    as nobody) failed and every update was swapped back, and other users got "Permission denied". Only a real
    directory owned by the tree's owner (root) is changed; anything else is refused before any change. Returns a
    sentence when the mode was changed, else None (unscoped CLI, no scope directory yet, or already 0755)."""
    scope = os.path.dirname(tool.package_root)
    if os.path.normpath(scope) == os.path.normpath(tool.roots.npm_global_root):
        return None
    try:
        fd = os.open(scope, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
                     | getattr(os, "O_CLOEXEC", 0))
    except FileNotFoundError:
        return None
    except OSError:
        raise NpmRefusal("NPM_SCOPE_DIR_UNSAFE", "%s is not a real directory, so %s cannot be checked or changed "
                         "safely; nothing was changed." % (scope, tool.label()))
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != tool.uid:
            raise NpmRefusal("NPM_SCOPE_DIR_UNSAFE", "%s is not a directory owned by root (owner uid %d), so %s cannot "
                             "be checked or changed safely; nothing was changed." % (scope, info.st_uid, tool.label()))
        mode = stat.S_IMODE(info.st_mode)
        if mode == 0o755:
            return None
        os.fchmod(fd, 0o755)
        os.fsync(fd)
    finally:
        os.close(fd)
    return "%s was mode %04o, so only root could run %s; it is now 0755." % (scope, mode, tool.label())


def npm_verify_release(tool, version, phase, evidence):
    """resolve -> fetch -> verify-source for one exact release. Returns the
    staged candidate: scripts off, then only the policy-listed install script,
    sandboxed; plus its tree facts and the proof the record will carry."""
    with phase("resolve", "Reading the official release from the npm registry") as current:
        npm_registry_check(tool)
        allowed = npm_allowed_scripts(tool.policy)
        root_spec, platform_spec = npm_tool_layout_spec(tool.tool_id, version, tool.platform_key)
        root_meta = npm_view(tool, root_spec)
        problem = npm_scripts_problem(root_meta.get("scripts"), allowed, root_spec)
        if problem:
            raise NpmRefusal("NPM_INSTALL_SCRIPT_UNREVIEWED", problem[0].upper() + problem[1:] + "; it is not admitted.")
        platform_meta = npm_view(tool, platform_spec) if platform_spec else None
        if platform_meta is not None:
            problem = npm_scripts_problem(platform_meta.get("scripts"), {}, platform_spec)
            if problem:
                raise NpmRefusal("NPM_INSTALL_SCRIPT_UNREVIEWED", problem[0].upper() + problem[1:] + "; it is not admitted.")
        current.detail = "Official release %s found." % root_spec
    with phase("fetch", "Downloading and checking the official tarballs") as current:
        fetched = [npm_fetch_verified(tool, root_spec, root_meta["dist"]["integrity"])]
        integrities = {"node_modules/" + tool.layout["packageName"]: root_meta["dist"]["integrity"]}
        if platform_meta is not None:
            fetched.append(npm_fetch_verified(tool, platform_spec, platform_meta["dist"]["integrity"]))
            relative = tool.layout["platformPackage"][tool.platform_key.split("-")[1]][0]
            integrities["node_modules/%s/%s" % (tool.layout["packageName"], relative)] = platform_meta["dist"]["integrity"]
        evidence["fetched"] = fetched
        current.detail = "sha512 integrity matches the registry."
    with phase("verify-source", "Verifying registry signatures") as current:
        stage, staged_root = npm_stage(tool, version, integrities)
        problem = npm_staged_scripts_problem(staged_root, allowed)
        if problem:
            raise NpmRefusal("NPM_INSTALL_SCRIPT_UNREVIEWED", problem[0].upper() + problem[1:] + "; it is not admitted.")
        attested = npm_audit_signatures(tool, stage, [root_spec] + ([platform_spec] if platform_spec else []))
        required = (tool.policy.get("source") or {}).get("provenance") != "unavailable"
        if required and not attested:
            raise NpmRefusal("NPM_PROVENANCE_MISSING", "%s should carry npm provenance, and it does not; it is not admitted."
                             % tool.label(version))
        provenance = "verified" if attested else "unavailable"
        npm_run_allowed_script(tool, staged_root, allowed)
        staged = npm_tree_snapshot(staged_root, uid=tool.uid, gid=tool.gid)
        facts = npm_tree_facts(tool.tool_id, staged, version, tool.platform_key)
        evidence.update(signatures="verified", provenance=provenance, treeSha256=facts["treeSha256"])
        current.detail = "Registry signatures verified; provenance %s." % provenance
    return {"stage": stage, "stagedRoot": staged_root, "rootMeta": root_meta, "provenance": provenance,
            "staged": staged, "facts": facts}


def _phase_factory(step):
    return (lambda step_id, label: step(step_id, label)) if step else (lambda _i, _l: _NullStep())


def recheck_next_action(tool, version, reinstall=False):
    """The next action after a failed re-check of `version`, always one toolctl
    admits: an update when the recommended version is newer, or is `version`
    and `reinstall` (the flow reinstalls the same version because the
    installed tree differs from its admission record); otherwise a re-check
    once the cause is fixed (an update would be refused as already current or
    as a downgrade). None when either version is unknown."""
    recommended = (tool.policy.get("newestProven") or {}).get("version")
    if parse_version(version) is None or parse_version(recommended) is None:
        return None
    order = compare_versions(version, recommended)
    return "update-recommended" if order < 0 or (order == 0 and reinstall) else "requalify"


def npm_reinstall_reason(tool, version, installed):
    """Why the installed `version` may be installed again (plain words), or
    None when a valid admission record for it matches the installed tree (then
    an update to it is already current). Read fresh in the calling run."""
    try:
        record = read_json_file(os.path.join(npm_admission_dir(tool.roots), tool.tool_id + ".json"),
                                max_bytes=ADMISSION_RECORD_MAX_BYTES)
    except (ToolctlError, OSError):
        return "its admission record cannot be read"
    if record is None:
        return "it has no admission record"
    if admission_record_problem(record, tool.tool_id, tool.package_root, tool.platform_key, tool.policy):
        return "its admission record is not valid"
    if record["version"] != version:
        return "its admission record is for %s" % record["version"]
    return npm_tree_admits(record, installed)


def npm_requalify(tool, run_id, step=None, now=utc_now):
    """requalify <tool>: installs and swaps nothing; writes the record only when
    the installed tree is proven to be the official release and C-VER passes.
    `step(id, label)` is a context manager factory for run steps (or None)."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run_id}
    with phase("installed", "Reading the installed version") as current:
        version, installed, executable = npm_installed(tool)
        evidence["installedVersion"] = version
        refusal = npm_record_version_refusal(tool.tool_id, version, tool.policy)
        if refusal:
            raise NpmRefusal("NPM_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + ".")
        if tool.platform_key is None:
            raise NpmRefusal("UNSUPPORTED_PLATFORM", "This server is not a supported GNU/Linux x64 or arm64 host.")
        current.detail = "%s is installed." % tool.label(version)
    verified = npm_verify_release(tool, version, phase, evidence)
    with phase("compare", "Comparing the installed files with the official release") as current:
        staged, facts = verified["staged"], verified["facts"]
        reason = npm_tree_admits(facts, installed)
        if reason:
            differing = sorted(p for p in set(staged["entries"]) | set(installed["entries"])
                               if _entry_line(staged["entries"].get(p)) != _entry_line(installed["entries"].get(p)))
            raise NpmRefusal("NPM_TREE_DIFFERS", "The installed %s is not the official release: %s." % (tool.label(version), reason),
                             {"differingPaths": differing[:10], "differingCount": len(differing)},
                             next_action=recheck_next_action(tool, version,
                                                             npm_reinstall_reason(tool, version, installed) is not None))
        current.detail = "The installed files are the official release."
    with phase("probe", "Checking the installed CLI") as current:
        scope_note = npm_scope_dir_ready(tool)
        if scope_note:
            evidence["scopeDir"] = scope_note
        probes, failed = cli_probe_set(tool, executable, version)
        evidence["probes"] = probes
        if failed:
            # The files are the verified official release: installing them again would change nothing.
            next_action = recheck_next_action(tool, version)
            raise NpmRefusal("CLI_PROBE_FAILED", "%s failed its %s check: %s.%s" % (
                tool.label(version), failed["id"], failed["reason"], "" if next_action != "requalify" else
                " Its files are the official release, so installing it again would not change them; re-check it once "
                "the cause is fixed."), {"probe": failed}, next_action=next_action)
        current.detail = _probe_summary(probes) + (" " + scope_note if scope_note else "")
    with phase("commit", "Recording the admission") as current:
        if not npm_snapshot_unchanged(installed):
            raise NpmRefusal("NPM_TREE_CHANGED", "The installed %s changed while it was being checked; nothing was admitted."
                             % tool.label(version))
        record = build_admission_record(tool.tool_id, version, tool.package_root, tool.platform_key, facts,
                                        verified["rootMeta"]["dist"]["integrity"], verified["provenance"],
                                        "requalify:%s" % run_id, now(), tool.policy)
        evidence["recordPath"] = write_admission_record(npm_admission_dir(tool.roots), record)
        current.detail = "Admitted %s (re-qualified, %s)." % (tool.label(version), "unproven" if (
            (tool.policy.get("newestProven") or {}).get("version") != version) else "proven version")
    return record, evidence


# -- update <tool> --target newestProven|newest|<exact> (d.1, d.3) --

def npm_resolve_target(tool, target, installed_version, installed=None):
    """(version, reinstall reason or None). The installed version itself is
    installed again only when npm_reinstall_reason names why (the installed
    tree differs from its admission record, or has none); else it is already
    current."""
    proven = tool.policy.get("newestProven") or {}
    if target in ("recommended", "newestProven"):
        version = proven.get("version")
    elif target == "newest":
        npm_registry_check(tool)
        selector = sorted((tool.policy.get("newestSelector") or {"default": "latest"}).items())[0][1]
        code, out, err = tool.npm(["view", "%s@%s" % (tool.layout["packageName"], selector), "version", "--json"])
        try:
            version = json.loads(out) if code == 0 else None
        except ValueError:
            version = None
        if not isinstance(version, str):
            raise NpmRefusal("NPM_METADATA_UNAVAILABLE", "The npm registry did not name the newest %s (%s)." % (
                tool.label(), tail_text(redact_text(err), 200)))
    else:
        version = target
    refusal = npm_record_version_refusal(tool.tool_id, version, tool.policy)
    if refusal:
        raise NpmRefusal("NPM_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + ".")
    order = compare_versions(version, installed_version)
    if order == 0:
        reason = npm_reinstall_reason(tool, version, installed) if installed is not None else None
        if reason is None:
            raise NpmRefusal("NPM_ALREADY_CURRENT", "%s is already installed. Nothing to update." % tool.label(version))
        return version, reason
    if order < 0:
        raise NpmRefusal("NPM_DOWNGRADE_REFUSED", "%s is older than the installed %s; the Portal does not downgrade tools." % (
            tool.label(version), installed_version))
    return version, None


def npm_fence_path(roots, tool_id):
    return os.path.join(roots.state_root, "fence", tool_id)


def npm_swap_back(swap):
    """Put the previous tree back at the live path (atomic rename); the failed
    candidate is moved aside first and then deleted. Idempotent on the
    filesystem state."""
    live, prev, failed = swap["live"], swap["prev"], swap["failed"]
    if not path_present(prev):
        return path_present(live)
    if path_present(live):
        os.rename(live, failed)
    os.rename(prev, live)
    fsync_dir(os.path.dirname(live))
    shutil.rmtree(failed, ignore_errors=True)
    return True


def _remove_fence(swap):
    try:
        os.unlink(swap["fence"])
    except FileNotFoundError:
        pass


class NpmStopped(Exception):
    """A stop request (SIGTERM) arrived before the swap: nothing was changed."""


def npm_check_candidate(tool, version, verified, evidence, parent=None):
    """probe-candidate of an update or install: the qualified digest, the Node.js
    engines range, the CLI probes on the staged tree, and a stage on the
    filesystem of `parent` (default: the live tree's directory), so the rename
    is atomic. Returns the step detail."""
    expected = qualified_integrity(tool, version)
    if expected is not None and expected != verified["rootMeta"]["dist"]["integrity"]:
        raise NpmRefusal("NPM_PROVEN_DIGEST_MISMATCH", "%s does not match the digest the Portal qualified." % tool.label(version))
    engines = (verified["rootMeta"].get("engines") or {}).get("node")
    if engines:
        node_version, problem = node_version_of(npm_path(tool.roots, "node_bin"), runner=run_bounded)
        try:
            fits = node_version is not None and satisfies(node_version, engines)
        except ValueError:
            fits = False
        if not fits:
            raise NpmRefusal("NPM_NODE_TOO_OLD", "%s needs Node.js %s; this server has %s." % (
                tool.label(version), engines, node_version or problem))
    probes, failed = cli_probe_set(tool, os.path.join(verified["stagedRoot"], tool.layout["binRelative"]), version)
    evidence["probes"] = [dict(probe, target="candidate") for probe in probes]
    if failed:
        raise NpmRefusal("CLI_PROBE_FAILED", "%s failed its %s check before installation, so nothing was changed: %s."
                         % (tool.label(version), failed["id"], failed["reason"]), {"probe": failed})
    if os.stat(verified["stagedRoot"]).st_dev != os.stat(parent or os.path.dirname(tool.package_root)).st_dev:
        raise NpmRefusal("NPM_STAGE_OTHER_FILESYSTEM", "The tools work area is on another filesystem than %s, so the "
                         "swap could not be atomic; nothing was changed." % tool.roots.npm_global_root)
    return _probe_summary(probes) + " (candidate)"


def npm_update(tool, run, target, step=None, now=utc_now, stop=None):
    """update <tool>: verify and probe the candidate, fence, swap atomically,
    probe the installed path, commit the record; any failure after the swap
    puts the previous tree back. The gateway is never stopped or restarted."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": target}
    with phase("installed", "Reading the installed version") as current:
        old_version, installed, executable = npm_installed(tool)
        if tool.platform_key is None:
            raise NpmRefusal("UNSUPPORTED_PLATFORM", "This server is not a supported GNU/Linux x64 or arm64 host.")
        version, reinstall = npm_resolve_target(tool, target, old_version, installed)
        evidence.update({"from": old_version, "to": version})
        if reinstall:
            # The normal verified path below: stage, digest check, probe, swap (the old tree is kept), new record.
            evidence["reinstall"] = reinstall
            current.detail = "%s is installed, but %s; the official release is installed again." % (
                tool.label(old_version), reinstall)
        else:
            current.detail = "%s is installed; %s is the target." % (tool.label(old_version), version)
    verified = npm_verify_release(tool, version, phase, evidence)
    with phase("probe-candidate", "Checking the new version before it is installed") as current:
        current.detail = npm_check_candidate(tool, version, verified, evidence)
    prev_dir = os.path.join(tool.roots.npm_global_root, ".bridgesllm-prev")
    swap = {"live": tool.package_root, "candidate": verified["stagedRoot"],
            "prev": os.path.join(prev_dir, tool.tool_id, "%s.%s" % (old_version, run.run_id)),
            "failed": os.path.join(prev_dir, tool.tool_id, "failed.%s" % run.run_id),
            "fence": npm_fence_path(tool.roots, tool.tool_id), "from": old_version, "to": version,
            "integrity": verified["rootMeta"]["dist"]["integrity"], "provenance": verified["provenance"],
            "treeSha256": verified["facts"]["treeSha256"], "state": "fencing"}
    if stop:
        raise NpmStopped()
    with phase("swap", "Switching to the new version") as current:
        scope_note = npm_scope_dir_ready(tool)
        if scope_note:
            evidence["scopeDir"] = scope_note
        for directory in (prev_dir, os.path.dirname(swap["prev"]), os.path.dirname(swap["fence"])):
            ensure_private_dir(directory)
        run.status["swap"] = swap
        run.save()
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        for state, source, destination in (("moving-live", swap["live"], swap["prev"]),
                                           ("moving-candidate", swap["candidate"], swap["live"])):
            swap["state"] = state
            run.save()
            os.rename(source, destination)
        fsync_dir(os.path.dirname(swap["live"]))
        fsync_dir(os.path.dirname(swap["prev"]))
        swap["state"] = "swapped"
        run.save()
        current.detail = "%s is now at %s; %s is kept for swap-back.%s" % (
            tool.label(version), swap["live"], old_version, " " + scope_note if scope_note else "")
    return npm_finish_swap(tool, run, swap, evidence, executable, phase, now)


def npm_finish_swap(tool, run, swap, evidence, executable, phase, now):
    """probe-installed -> commit -> cleanup, or swap back. Shared by the run and
    by reconcile after a crash between swap and commit."""
    version = swap["to"]
    try:
        with phase("probe-installed", "Checking the installed new version") as current:
            probes, failed = cli_probe_set(tool, executable, version)
            evidence.setdefault("probes", []).extend(dict(probe, target="installed") for probe in probes)
            if failed:
                raise NpmRefusal("CLI_PROBE_FAILED", "%s: %s" % (failed["id"], failed["reason"]), {"probe": failed})
            installed = npm_tree_snapshot(tool.package_root, uid=tool.uid, gid=tool.gid)
            facts = npm_tree_facts(tool.tool_id, installed, version, tool.platform_key)
            if facts["treeSha256"] != swap["treeSha256"]:
                raise NpmRefusal("NPM_TREE_CHANGED", "the installed files are not the verified candidate")
            current.detail = _probe_summary(probes) + " (installed)"
        with phase("commit", "Recording the admission") as current:
            record = build_admission_record(tool.tool_id, version, tool.package_root, tool.platform_key, facts,
                                            swap["integrity"], swap["provenance"], "run:%s" % run.run_id, now(), tool.policy)
            swap["state"] = "committing"
            run.save()
            evidence["recordPath"] = write_admission_record(npm_admission_dir(tool.roots), record)
            swap["state"] = "committed"
            run.save()
            current.detail = "Admitted %s." % tool.label(version)
    except NpmRefusal as refusal:
        swap["state"] = "swapping-back"
        run.save()
        restored = npm_swap_back(swap)
        swap["state"] = "swapped-back" if restored else "swap-back-failed"
        run.save()
        old_probe = cli_probe_version(tool, executable, swap["from"]) if restored else None
        _remove_fence(swap)
        raise NpmRefusal("NPM_SWAPPED_BACK" if restored else "NPM_SWAP_BACK_FAILED",
                         ("%s failed its check after the switch (%s); %s was put back." % (
                             tool.label(version), refusal.message, swap["from"])) if restored else
                         ("%s failed its check after the switch (%s) and the previous version could not be put back."
                          % (tool.label(version), refusal.message)),
                         {"probe": (refusal.detail or {}).get("probe"), "previousProbe": old_probe})
    _remove_fence(swap)
    with phase("cleanup", "Cleaning up") as current:
        tool_prev = os.path.dirname(swap["prev"])
        for name in sorted(os.listdir(tool_prev)):
            path = os.path.join(tool_prev, name)
            if path != swap["prev"]:
                shutil.rmtree(path, ignore_errors=True)
        current.detail = "%s is kept at %s until the next successful update." % (swap["from"], swap["prev"])
    return record, evidence


def npm_reconcile_run(roots, run, policy, runner=run_captured, uid=0, gid=0, platform_key=None, now=utc_now):
    """d.1 crash rules, decided by re-reading the filesystem, never by replay."""
    status = run.status
    swap = status.get("swap")
    if not isinstance(swap, dict):
        return None
    if swap.get("kind") == "npm-install":
        npm_reconcile_install(roots, run, swap, policy, runner, uid, gid, platform_key, now)
        return {"runId": run.run_id, "state": run.status["state"]}
    live_present, prev_present = path_present(swap["live"]), path_present(swap["prev"])
    if swap.get("state") == "committed":
        _remove_fence(swap)
        run.finish("succeeded", result={"action": "update", "from": swap["from"], "to": swap["to"],
                                        "reconciled": "committed before the interruption"})
    elif live_present and not prev_present:
        _remove_fence(swap)
        run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE",
                                    "message": "The update was interrupted before it changed anything. Try again."})
    elif prev_present and not live_present:
        npm_swap_back(swap)
        _remove_fence(swap)
        run.finish("rolled-back", error={"id": "NPM_SWAPPED_BACK", "message": "The update was interrupted during the switch; "
                                         "%s %s was put back." % (status.get("tool"), swap["from"])})
    elif live_present and prev_present and policy_tool(policy, status.get("tool")) is None:
        _remove_fence(swap)
        run.finish("recovery-required", error={"id": "POLICY_INVALID", "message": "The update was interrupted after the "
                                               "switch and this Portal's tool policy cannot be read to check it. "
                                               "Recovery is required."})
    elif live_present and prev_present:
        tool_id = status.get("tool")
        tool = NpmTool(roots, tool_id, policy_tool(policy, tool_id), os.path.join(roots.tmp_dir, run.run_id, tool_id),
                       uid=uid, gid=gid, platform_key=platform_key, runner=runner)
        ensure_private_dir(os.path.dirname(tool.work))
        ensure_private_dir(tool.work)
        executable = os.path.join(npm_path(roots, "npm_bin_dir"), tool.layout["executables"][0])
        try:
            npm_finish_swap(tool, run, swap, {"reconciled": True}, executable, _phase_factory(None), now)
        except NpmRefusal as refusal:
            run.finish("rolled-back" if refusal.code == "NPM_SWAPPED_BACK" else "recovery-required",
                       error={"id": refusal.code, "message": refusal.message})
        else:
            run.finish("succeeded", result={"action": "update", "from": swap["from"], "to": swap["to"],
                                            "reconciled": "checked and committed after the interruption"})
        finally:
            shutil.rmtree(tool.work, ignore_errors=True)
    else:
        # Nothing is left to switch, so the launch fence goes too: the Portal's CLI admission reads it and would
        # otherwise report "being switched right now" for good, even for a tree restored later.
        _remove_fence(swap)
        tool_id = status.get("tool")
        note = MISSING_TOOL_NOTE if tool_id not in INSTALL_TOOL_IDS else (
            "Re-check %s in Admin > Maintenance; once it confirms that, its card offers Install." % policy_label(roots, tool_id))
        run.finish("recovery-required", error={"id": "NPM_TREE_MISSING", "message": "Neither the new nor the previous %s "
                                               "tree is present, so %s is not installed on this server. %s" % (
                                                   tool_id, policy_label(roots, tool_id), note)})
    return {"runId": run.run_id, "state": run.status["state"]}


# -- install <tool> (5.2.0): a missing CLI from nothing, the way update installs it --

def npm_install_links(tool):
    """(link target, links to create): a fresh install of this CLI creates its
    package tree and npm's global launcher links (the admission catalog's
    `executables`; installer/install-missing-cli.py creates the same). Read
    under the run lock; refused unless the CLI is absent: its package
    directory missing (what the backend reads as not installed), and each
    launcher link missing or exactly the link a fresh install creates (left
    behind when the tree was removed; it is kept and never removed)."""
    target = "../lib/node_modules/%s/%s" % (tool.layout["packageName"], tool.layout["binRelative"])
    if not os.path.isdir(tool.roots.npm_global_root) or os.path.islink(tool.roots.npm_global_root):
        raise NpmRefusal("NPM_UNAVAILABLE", "npm's global package directory %s is missing, so %s cannot be installed "
                         "there; nothing was changed." % (tool.roots.npm_global_root, tool.label()))
    if path_present(tool.package_root):
        raise NpmRefusal("INSTALL_TOOL_PRESENT", "%s is already installed on this server (%s exists). Use Update or "
                         "Re-check on its card instead; nothing was changed." % (tool.label(), tool.package_root))
    missing = []
    for name in tool.layout["executables"]:
        link = os.path.join(npm_path(tool.roots, "npm_bin_dir"), name)
        try:
            current = os.readlink(link)
        except FileNotFoundError:
            missing.append(link)
            continue
        except OSError:
            current = None
        if current != target:
            raise NpmRefusal("INSTALL_PATH_OCCUPIED", "%s already exists and is not the %s link a fresh install creates, "
                             "so the Portal does not replace it; nothing was changed." % (link, tool.label()))
    return target, missing


def _same_directory(path, identity):
    """True when `path` is the directory whose (st_dev, st_ino) a run recorded
    before it renamed that directory there (a rename keeps both)."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return isinstance(identity, list) and stat.S_ISDIR(info.st_mode) and [info.st_dev, info.st_ino] == identity


def npm_install(tool, run, step=None, now=utc_now, stop=None):
    """install <tool>: exactly what `update --target recommended` installs, from
    nothing: the same verified release, digest check and probes; the staged
    tree is renamed into place (there is no previous tree to keep), the
    launcher links a fresh install creates are added, the installed CLI is
    probed and the record committed. A failure after the rename removes
    exactly what this run added. The gateway is never stopped or restarted."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": "recommended", "from": None}
    with phase("installed", "Checking that it is not installed") as current:
        npm_install_links(tool)
        if tool.platform_key is None:
            raise NpmRefusal("UNSUPPORTED_PLATFORM", "This server is not a supported GNU/Linux x64 or arm64 host.")
        version = install_version(tool, lambda v: npm_record_version_refusal(tool.tool_id, v, tool.policy))
        evidence["to"] = version
        current.detail = "%s is not installed; %s will be installed." % (tool.label(), version)
    verified = npm_verify_release(tool, version, phase, evidence)
    scope = os.path.dirname(tool.package_root)
    with phase("probe-candidate", "Checking the new version before it is installed") as current:
        current.detail = npm_check_candidate(tool, version, verified, evidence,
                                             parent=scope if os.path.isdir(scope) else tool.roots.npm_global_root)
    swap = {"kind": "npm-install", "live": tool.package_root, "candidate": verified["stagedRoot"],
            "failed": os.path.join(tool.roots.npm_global_root, ".bridgesllm-prev", tool.tool_id, "failed.%s" % run.run_id),
            "fence": npm_fence_path(tool.roots, tool.tool_id), "from": None, "to": version,
            "integrity": verified["rootMeta"]["dist"]["integrity"], "provenance": verified["provenance"],
            "treeSha256": verified["facts"]["treeSha256"], "linkTarget": None, "links": [], "createdDirs": [],
            "identity": None, "state": "fencing"}
    if stop:
        raise NpmStopped()
    with phase("swap", "Installing the new version") as current:
        # Read again right before anything changes: still absent, or nothing is changed.
        swap["linkTarget"], swap["links"] = npm_install_links(tool)
        scope_note = npm_scope_dir_ready(tool)
        if scope_note:
            evidence["scopeDir"] = scope_note
        ensure_private_dir(os.path.dirname(swap["fence"]))
        run.status["swap"] = swap
        run.save()
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        if scope != tool.roots.npm_global_root and not path_present(scope):
            # npm creates the package's scope directory on a fresh install; recorded first, removed with the rest.
            swap["createdDirs"] = [scope]
            run.save()
            os.mkdir(scope, 0o755)
            os.chmod(scope, 0o755)
        info = os.lstat(swap["candidate"])
        swap.update(identity=[info.st_dev, info.st_ino], state="moving-candidate")
        run.save()
        if path_present(swap["live"]):
            _remove_fence(swap)  # nothing was moved: another installation is not this run's to change
            raise NpmRefusal("INSTALL_TOOL_PRESENT", "%s appeared at %s while this run was installing it; nothing was "
                             "changed." % (tool.label(), swap["live"]))
        os.rename(swap["candidate"], swap["live"])
        fsync_dir(os.path.dirname(swap["live"]))
        swap["state"] = "linking"
        run.save()
        current.detail = "%s is now at %s.%s" % (tool.label(version), swap["live"], " " + scope_note if scope_note else "")
    return npm_finish_install(tool, run, swap, evidence, phase, now)


def npm_finish_install(tool, run, swap, evidence, phase, now):
    """link -> probe-installed -> commit, or remove what the install added.
    Shared by the run and by reconcile after a crash between rename and commit."""
    version = swap["to"]
    executable = os.path.join(npm_path(tool.roots, "npm_bin_dir"), tool.layout["executables"][0])
    try:
        if swap["state"] in ("moving-candidate", "linking"):
            with phase("link", "Adding the launcher") as current:
                for link in swap["links"]:
                    if not os.path.lexists(link):
                        os.symlink(swap["linkTarget"], link)
                    elif not (os.path.islink(link) and os.readlink(link) == swap["linkTarget"]):
                        raise NpmRefusal("INSTALL_PATH_OCCUPIED", "%s changed while it was being installed" % link)
                fsync_dir(npm_path(tool.roots, "npm_bin_dir"))
                swap["state"] = "linked"
                run.save()
                current.detail = "%s runs %s." % (", ".join(os.path.join(npm_path(tool.roots, "npm_bin_dir"), name)
                                                            for name in tool.layout["executables"]), tool.label(version))
        with phase("probe-installed", "Checking the installed new version") as current:
            probes, failed = cli_probe_set(tool, executable, version)
            evidence.setdefault("probes", []).extend(dict(probe, target="installed") for probe in probes)
            if failed:
                raise NpmRefusal("CLI_PROBE_FAILED", "%s: %s" % (failed["id"], failed["reason"]), {"probe": failed})
            installed = npm_tree_snapshot(tool.package_root, uid=tool.uid, gid=tool.gid)
            facts = npm_tree_facts(tool.tool_id, installed, version, tool.platform_key)
            if facts["treeSha256"] != swap["treeSha256"]:
                raise NpmRefusal("NPM_TREE_CHANGED", "the installed files are not the verified candidate")
            current.detail = _probe_summary(probes) + " (installed)"
        with phase("commit", "Recording the admission") as current:
            record = build_admission_record(tool.tool_id, version, tool.package_root, tool.platform_key, facts,
                                            swap["integrity"], swap["provenance"], "run:%s" % run.run_id, now(), tool.policy)
            swap["state"] = "committing"
            run.save()
            evidence["recordPath"] = write_admission_record(npm_admission_dir(tool.roots), record)
            swap["state"] = "committed"
            run.save()
            current.detail = "Admitted %s." % tool.label(version)
    except NpmRefusal as refusal:
        swap["state"] = "removing"
        run.save()
        removed = npm_install_remove(swap)
        swap["state"] = "removed" if removed else "remove-failed"
        run.save()
        _remove_fence(swap)
        raise NpmRefusal("INSTALL_REMOVED" if removed else "INSTALL_REMOVE_FAILED",
                         ("%s failed its check after it was installed (%s); it was removed again, so nothing was changed."
                          % (tool.label(version), refusal.message)) if removed else
                         ("%s failed its check after it was installed (%s) and could not be removed again. %s" % (
                             tool.label(version), refusal.message, recheck_recovery_advice(tool.label()))),
                         {"probe": (refusal.detail or {}).get("probe")})
    _remove_fence(swap)
    return record, evidence


def npm_install_remove(swap):
    """Remove exactly what an install run added: the tree it renamed into place
    (only that directory, by identity), the links it created and the scope
    directory it created (when empty). True when none of them is left; False
    when the live tree is not provably this run's (then it is left alone)."""
    live, failed = swap["live"], swap["failed"]
    if path_present(live):
        if not _same_directory(live, swap.get("identity")):
            return False
        for directory in (os.path.dirname(os.path.dirname(failed)), os.path.dirname(failed)):
            ensure_private_dir(directory)
        os.rename(live, failed)
        fsync_dir(os.path.dirname(live))
    shutil.rmtree(failed, ignore_errors=True)
    for link in swap.get("links") or []:
        if os.path.islink(link) and os.readlink(link) == swap.get("linkTarget"):
            os.unlink(link)
            fsync_dir(os.path.dirname(link))
    for directory in swap.get("createdDirs") or []:
        try:
            os.rmdir(directory)
        except FileNotFoundError:
            pass
        except OSError:
            pass  # someone else's package is in it now: that is not this run's to remove
    return not path_present(live) and not path_present(failed) and not any(
        os.path.islink(link) and os.readlink(link) == swap.get("linkTarget") for link in swap.get("links") or [])


def npm_reconcile_install(roots, run, swap, policy, runner, uid, gid, platform_key, now):
    """d.1 crash rules for an install, decided by re-reading the filesystem: the
    tree at the live path is this run's only when it is the directory the run
    renamed there."""
    tool_id = run.status.get("tool")
    label = policy_label(roots, tool_id)
    ours = _same_directory(swap["live"], swap.get("identity"))
    result = {"action": "install", "from": None, "to": swap.get("to")}
    if swap.get("state") == "committed":
        _remove_fence(swap)
        run.finish("succeeded", result=dict(result, reconciled="committed before the interruption"))
    elif swap.get("state") in ("fencing", "moving-candidate") and not ours and not swap.get("createdDirs"):
        _remove_fence(swap)
        run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE",
                                    "message": "The installation was interrupted before it changed anything. Try again."})
    elif ours and swap.get("state") in ("moving-candidate", "linking", "linked", "committing") and \
            policy_tool(policy, tool_id) is not None:
        tool = NpmTool(roots, tool_id, policy_tool(policy, tool_id), os.path.join(roots.tmp_dir, run.run_id, tool_id),
                       uid=uid, gid=gid, platform_key=platform_key, runner=runner)
        ensure_private_dir(os.path.dirname(tool.work))
        ensure_private_dir(tool.work)
        try:
            npm_finish_install(tool, run, swap, {"reconciled": True}, _phase_factory(None), now)
        except NpmRefusal as refusal:
            run.finish("rolled-back" if refusal.code == "INSTALL_REMOVED" else "recovery-required",
                       error={"id": refusal.code, "message": refusal.message})
        else:
            run.finish("succeeded", result=dict(result, reconciled="checked and committed after the interruption"))
        finally:
            shutil.rmtree(tool.work, ignore_errors=True)
    else:
        # Removing when interrupted, this run's tree gone or the policy unreadable: remove what this run added.
        removed = npm_install_remove(swap)
        _remove_fence(swap)
        if removed:
            run.finish("rolled-back", error={"id": "INSTALL_REMOVED", "message": "The %s installation was interrupted; "
                                             "what it had added was removed, so nothing is installed. Try again." % label})
        else:
            run.finish("recovery-required", error={"id": "INSTALL_REMOVE_FAILED", "message": "The %s installation was "
                                                   "interrupted, and %s is not provably the files it installed, so they "
                                                   "were left alone. %s" % (label, swap["live"],
                                                                            recheck_recovery_advice(label))})


def _probe_summary(probes):
    passed = [p["id"] for p in probes if p["state"] == "passed"]
    skipped = [p["id"] for p in probes if p["state"] == "not-run"]
    unneeded = [p["id"] for p in probes if p["state"] == "not-required"]
    return "%s passed%s%s." % (", ".join(passed) or "No probe", "; not in this build: %s" % ", ".join(skipped) if skipped else "",
                               "; not required here: %s" % ", ".join(unneeded) if unneeded else "")


def _entry_line(entry):
    if entry is None:
        return None
    return (entry["kind"], entry["mode"], entry.get("size"), entry.get("sha256"), entry.get("target"))


class _NullStep(object):
    detail = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class _RunStep(object):
    """Run step bookkeeping: recorded before the work, closed with its outcome."""

    def __init__(self, run, step_id, label):
        self.run, self.step_id, self.label, self.detail, self.step = run, step_id, label, None, None

    def __enter__(self):
        self.run.status["phase"] = self.step_id
        self.step = self.run.step_start(self.step_id, self.label)
        return self

    def __exit__(self, exc_type, exc, _tb):
        if exc_type is None:
            self.run.step_end(self.step, "passed", detail=self.detail)
        else:
            self.run.step_end(self.step, "failed", detail=getattr(exc, "message", None) or "Stopped on an internal error.")
        return False


def validate_npm_request(request, run_id, policy):
    errors = []
    if request.get("schema") != SCHEMA_REQUEST:
        errors.append("schema must be %s" % SCHEMA_REQUEST)
    if request.get("runId") != run_id:
        errors.append("runId does not match the unit instance")
    if policy_tool(policy, request.get("tool")) is None:
        errors.append("tool is not in the policy")
    if request.get("action") not in NPM_ACTIONS:
        errors.append("%s supports only %s in this runner build; %s is not implemented" % (
            request.get("tool"), ", ".join(NPM_ACTIONS), request.get("action")))
    if request.get("action") == "update":
        target = request.get("target")
        if target not in ("recommended", "newestProven", "newest") and not (
                isinstance(target, str) and _PLAIN_VERSION_RE.fullmatch(target)):
            errors.append("target must be recommended, newestProven, newest or an exact release version")
    if request.get("action") == "install" and request.get("target") not in INSTALL_TARGETS:
        errors.append("install installs the recommended version only")
    return errors


def execute_npm_run(roots, run, policy, request, stop=None, runner=run_captured, uid=0, gid=0, platform_key=None, now=utc_now):
    """Run one npm CLI action under the run lock; the gateway is never touched."""
    tool_id = request["tool"]
    work_parent = os.path.join(roots.tmp_dir, run.run_id)
    ensure_private_dir(work_parent)
    work = os.path.join(work_parent, tool_id)
    if path_present(work):
        shutil.rmtree(work)
    ensure_private_dir(work)
    tool = NpmTool(roots, tool_id, policy_tool(policy, tool_id), work, uid=uid, gid=gid, platform_key=platform_key, runner=runner)
    result = {"action": request["action"], "from": None, "to": None}
    run.transition("verifying", "verifying")
    try:
        if request["action"] == "update":
            run.transition("running", "running")
            record, evidence = npm_update(tool, run, request["target"], step=lambda i, l: _RunStep(run, i, l), now=now,
                                          stop=stop)
        elif request["action"] == "install":
            run.transition("running", "running")
            record, evidence = npm_install(tool, run, step=lambda i, l: _RunStep(run, i, l), now=now, stop=stop)
        else:
            record, evidence = npm_requalify(tool, run.run_id, step=lambda i, l: _RunStep(run, i, l), now=now)
    except NpmStopped:
        return stop_before_change(run, stop, result=result)
    except NpmRefusal as refusal:
        evidence_name = run.write_evidence("npm-requalify.json", {"tool": tool_id, "error": refusal.code,
                                                                   "message": refusal.message, "detail": refusal.detail})
        state = RUN_REFUSAL_STATES.get(refusal.code, "refused")
        next_action = refusal.next_action if request["action"] == "requalify" else None
        run.finish(state, error={"id": refusal.code, "message": refusal.message, "nextAction": next_action,
                                 "detail": refusal.detail}, result=dict(result, evidence=evidence_name))
        return run.status
    finally:
        shutil.rmtree(work, ignore_errors=True)
    evidence_name = run.write_evidence("npm-requalify.json", evidence)
    run.finish("succeeded", result=dict(result, **{"from": evidence.get("from", record["version"]), "to": record["version"],
                                                    "admittedBy": record["admittedBy"], "evidence": evidence_name}))
    return run.status


# ==========================================================================
# Harness tools (OpenCode, Hermes, Grok Build, Antigravity, Ollama, Agent
# Zero): per-tool requalify and update (d.1, d.4). This section belongs to
# the harness lane. A harness run never stops or restarts the OpenClaw
# gateway. Each tool keeps its installer layout (the installer helpers still
# do fresh installs); toolctl verifies the official release, probes it in the
# sandbox, switches it atomically and writes the tool's admission record,
# which the helpers then accept instead of their exact pin. Tools this build
# does not run yet are refused in plain words, and the backend does not
# offer them.
# ==========================================================================

HARNESS_TOOL_IDS = ("opencode", "hermes", "grok-build", "antigravity", "ollama", "agent-zero")
NEWEST_NOT_OFFERED_MESSAGE = "This tool updates only to the version this Portal release qualified."
HARNESS_ACTIONS = ("requalify", "update", "install")
SCHEMA_HARNESS_RECORD = "bridgesllm.tools.harness-admission.v1"
HARNESS_PATH_DEFAULTS = {
    "harness_runtime_root": ("BRIDGESLLM_HARNESS_RUNTIME_ROOT", "/usr/local/lib/bridgesllm-runtimes"),
    "harness_bin_dir": ("BRIDGESLLM_HARNESS_BIN_DIR", "/usr/local/bin"),
    # Where Portal 5.0.x installed OpenCode and Hermes (<root>/<tool>/<version>/); see harness_runtime_target.
    "harness_legacy_root": ("BRIDGESLLM_HARNESS_LEGACY_ROOT", "/opt/bridgesllm/tools"),
    # The Portal's installer helpers (`<portal>/installer/*-runtime.sh`), next to this file's directory.
    "harness_helper_dir": ("BRIDGESLLM_HARNESS_HELPER_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "zstd_bin": ("BRIDGESLLM_ZSTD_BIN", "/usr/bin/zstd"),
    "agent_zero_env": ("BRIDGESLLM_AGENT_ZERO_ENV", "/etc/bridgesllm/agent-zero.env"),
}
GITHUB_API = "https://api.github.com"
# Official hosts a release download may come from (GitHub serves release
# assets by redirecting to its object storage).
# Commit tarballs (Hermes) redirect from api.github.com to codeload.github.com.
HARNESS_DOWNLOAD_HOSTS = frozenset(("api.github.com", "github.com", "objects.githubusercontent.com",
                                    "release-assets.githubusercontent.com", "codeload.github.com"))
HARNESS_METADATA_LIMIT = 4 * MIB
HARNESS_FETCH_TIMEOUT = 600
ACP_PROBE_TIMEOUT = 45
# An installer helper downloads and checks one vendor program (about 100 MB).
VENDOR_HELPER_TIMEOUT = 900
_GITHUB_DIGEST_RE = re.compile(r"\Asha256:([0-9a-f]{64})\Z")
_GITHUB_REPOSITORY_RE = re.compile(r"\A[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\Z")
_ACP_SESSION_ID_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,255}\Z")
# A version as the vendor programs print it (the helpers' own pattern).
_VERSION_IN_TEXT_RE = re.compile(r"(?<![0-9.])([0-9]+\.[0-9]+\.[0-9]+)(?![0-9]|\.[0-9])")

# Per-tool facts. OpenCode: installer/opencode-runtime.sh (layout, assets,
# environment) and backend acp/AcpHarnessProfiles.ts (ACP launch and the
# capabilities the Portal requires); a test keeps them in step.
HARNESS_SPECS = {
    "opencode": {
        "layout": "versioned-dir",
        "runtimeDir": "opencode",
        "executable": "opencode",
        "assets": {"x86_64": "opencode-linux-x64-baseline.tar.gz", "aarch64": "opencode-linux-arm64.tar.gz"},
        "maxArchiveBytes": 128 * MIB,
        "maxBinaryBytes": 256 * MIB,
        "env": {"OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_SHARE": "1"},
        "acp": {"args": ["acp", "--pure", "--cwd", "/tmp", "--hostname", "127.0.0.1", "--port", "0", "--no-mdns"],
                "agentName": "OpenCode",
                "capabilities": ["loadSession", "sessionCapabilities.close", "sessionCapabilities.list",
                                 "sessionCapabilities.resume", "sessionCapabilities.fork"],
                "image": True, "sessionNew": "accepted"},
    },
    # Hermes: installer/hermes-runtime.sh (versioned venv generations, the
    # attestation, source = a commit tarball and its canonical tree digest, the
    # probe environment and `acp --version`/`acp --check`); a test keeps them in step.
    "hermes": {
        "layout": "venv-generation",
        "runtimeDir": "hermes",
        "executable": "hermes",
        "entry": (".venv", "bin", "hermes"),
        "helper": "hermes-runtime.sh",
        "attestation": ".portal-runtime-attestation-v1",
        "versionArgs": ["acp", "--version"],
        "acpCheck": {"args": ["acp", "--check"], "expect": "Hermes ACP check OK"},
        "env": {"HERMES_HOME": "/tmp/home/state", "HERMES_DISABLE_LAZY_INSTALLS": "1", "HERMES_ACP_SKIP_CONFIGURED_MCP": "1",
                "PYTHONDONTWRITEBYTECODE": "1"},
    },
    # Vendor single-file programs: installer/grok-build-runtime.sh and
    # installer/antigravity-runtime.sh (pinned version and digest, launcher,
    # helper environment) and AcpHarnessProfiles.ts (Grok's ACP launch); a
    # test keeps them in step. The vendors publish no checksums, so the
    # helper's pinned version is the only one installable (d.2 step 7).
    "grok-build": {
        "layout": "vendor-file",
        "executable": "grok",
        "machines": ("x86_64",),
        "helper": "grok-build-runtime.sh",
        "helperBinDirEnv": "GROK_BIN_DIR",
        "pinnedVersion": "1.0.62",
        # sha256 of the program itself (the vendor serves the bare binary).
        "pinnedSha256": {"x86_64": "2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa"},
        "origin": "https://x.ai/cli",
        "versionArgs": ["--no-auto-update", "--version"],
        "env": {"GROK_DISABLE_AUTOUPDATER": "1"},
        "acp": {"args": ["--no-auto-update", "agent", "stdio"], "agentName": None, "versionSource": "meta",
                "capabilities": ["loadSession"], "image": False, "sessionNew": "auth-required"},
    },
    "antigravity": {
        "layout": "vendor-file",
        "executable": "agy",
        "machines": ("x86_64",),
        "helper": "antigravity-runtime.sh",
        "helperBinDirEnv": "ANTIGRAVITY_BIN_DIR",
        "pinnedVersion": "1.4.3",
        # The helper pins the vendor archive's sha512, not the program's digest.
        "pinnedSha256": {},
        "origin": "https://storage.googleapis.com/antigravity-public/antigravity-cli/",
        "versionArgs": ["--version"],
        "env": {"AGY_CLI_DISABLE_AUTO_UPDATE": "true"},
    },
    # Ollama: installer/install.sh install_or_update_ollama through its toolctl
    # entry (asset names, managed binary, loopback API); a test keeps them in step.
    "ollama": {
        "layout": "service-restart",
        "executable": "ollama",
        "assets": {"x86_64": "ollama-linux-amd64.tar.zst", "aarch64": "ollama-linux-arm64.tar.zst"},
        "maxArchiveBytes": 4096 * MIB,
        "versionArgs": ["--version"],
        # No server answers inside the sandbox, so the client prints its own version.
        "env": {"OLLAMA_HOST": "http://127.0.0.1:1"},
        "api": "http://127.0.0.1:11434",
        "service": "ollama",
        "installer": "install.sh",
        "installerArgs": ["--toolctl-ollama-update"],
    },
    # Agent Zero: installer/agent-zero-runtime.sh (pinned version, image and
    # per-arch digest, container); a test keeps them in step. Configured only
    # when /etc/bridgesllm/agent-zero.env exists.
    "agent-zero": {
        "layout": "managed-container",
        "helper": "agent-zero-runtime.sh",
        "pinnedVersion": "2.14",
        "versionPattern": re.compile(r"\A(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){1,2}\Z"),
        "image": "agent0ai/agent-zero",
        "pinnedDigests": {"x86_64": "sha256:307a2ceffc8501ba05a1e7253e8b6e4d656d2e1c3b97f0eb943c18b9c40a30fd",
                          "aarch64": "sha256:3b048a33c8698d396688ebd05096daab1f441cf310f299db2ed808a00433bc13"},
        "container": "bridgesllm-agent-zero",
    },
}


class HarnessRefusal(NpmRefusal):
    """A plain-words reason a harness flow stops; `code` is the stable id."""


def harness_path(roots, name):
    value = getattr(roots, name, None)
    if not value:
        env_name, default = HARNESS_PATH_DEFAULTS[name]
        value = os.environ.get(env_name) or default
    if not os.path.isabs(value) or os.path.normpath(value) != value:
        raise ToolctlError("%s must be a canonical absolute path: %r" % (name, value))
    return value


def harness_machine(machine=None):
    value = (machine or os.uname().machine).lower()
    return {"x86_64": "x86_64", "amd64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(value)


class _OfficialRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to an official HTTPS host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != "https" or target.hostname not in HARNESS_DOWNLOAD_HOSTS:
            raise HarnessRefusal("HARNESS_SOURCE_ORIGIN", "The download was redirected to %s, which is not an official "
                                 "source; nothing was installed." % (target.hostname or "an unknown host"))
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


def https_fetch(url, dest, max_bytes, timeout=HARNESS_FETCH_TIMEOUT):
    """GET an official HTTPS URL, bounded: the body (dest None) or written to
    the new file `dest` (returns its size)."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in HARNESS_DOWNLOAD_HOSTS:
        raise HarnessRefusal("HARNESS_SOURCE_ORIGIN", "%s is not an official source." % url)
    accept = "application/vnd.github+json" if parsed.hostname == "api.github.com" else "application/octet-stream"
    request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "bridgesllm-toolctl"})
    too_large = HarnessRefusal("HARNESS_DOWNLOAD_TOO_LARGE", "%s sent more than the %d bytes toolctl accepts." % (url, max_bytes))
    try:
        with urllib.request.build_opener(_OfficialRedirects()).open(request, timeout=timeout) as response:
            if dest is None:
                body = response.read(max_bytes + 1)
                if len(body) > max_bytes:
                    raise too_large
                return body
            size = 0
            fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
                         0o600)
            with os.fdopen(fd, "wb") as out:
                for chunk in iter(lambda: response.read(1 << 20), b""):
                    size += len(chunk)
                    if size > max_bytes:
                        raise too_large
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            return size
    except urllib.error.HTTPError as error:
        raise HarnessRefusal("HARNESS_SOURCE_UNAVAILABLE", "%s answered HTTP %d." % (parsed.hostname, error.code),
                             {"httpStatus": error.code})
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise HarnessRefusal("HARNESS_SOURCE_UNAVAILABLE", "%s could not be reached (%s)." % (
            parsed.hostname, tail_text(str(error), 160)))


class HarnessTool(object):
    """One harness flow's private workspace, its paths and the commands it may run."""

    def __init__(self, roots, tool_id, tool_policy, work, uid=0, runner=run_captured, fetch=https_fetch, acp=None,
                 machine=None, local_get=None):
        self.roots, self.tool_id, self.policy, self.work, self.uid = roots, tool_id, tool_policy or {}, work, uid
        self.spec = HARNESS_SPECS[tool_id]
        self.runner, self.fetch, self.acp = runner, fetch, acp or acp_exchange
        self.local_get = local_get or loopback_get
        self.machine = harness_machine(machine)
        self.installed_version = None  # what a re-check read, for its next action (recheck_next_action)
        self.root = os.path.join(harness_path(roots, "harness_runtime_root"), self.spec["runtimeDir"]) \
            if "runtimeDir" in self.spec else None
        self.legacy_root = os.path.join(harness_path(roots, "harness_legacy_root"), self.spec["runtimeDir"]) \
            if "runtimeDir" in self.spec else None
        self.link = os.path.join(harness_path(roots, "harness_bin_dir"), self.spec["executable"]) \
            if "executable" in self.spec else None

    def label(self, version=None):
        name = self.policy.get("label") or self.tool_id
        return "%s %s" % (name, version) if version else name

    def sandbox_argv(self, argv, cwd="/tmp"):
        """The probe sandbox (probe_sandbox_argv), run as nobody:nogroup with the tool's own environment. The tool's
        runtime tree stays readable below a private directory (Portal 5.0.x placed it under /opt/bridgesllm/tools)."""
        problem = sandbox_unavailable(self.roots, self.label(), self.work)
        if problem:
            raise HarnessRefusal("HARNESS_SANDBOX_UNAVAILABLE", problem)
        real = os.path.realpath(argv[0])
        readable = next((root for root in (self.root, self.legacy_root) if root and _path_inside(root, real)), None)
        try:
            return probe_sandbox_argv(self.roots, self.work, argv, cwd, env=sorted((self.spec.get("env") or {}).items()),
                                      readable=readable)
        except OSError as error:
            raise HarnessRefusal("HARNESS_SANDBOX_UNAVAILABLE", "The probe sandbox's private /tmp could not be prepared "
                                 "(%s), so %s cannot be checked safely." % (error.strerror or error, self.label()))
        except ValueError as error:
            raise HarnessRefusal("HARNESS_SANDBOX_UNAVAILABLE", "The probe sandbox could not be set up (%s), so %s "
                                 "cannot be checked safely." % (error, self.label()))


# -- source: the official GitHub release and the digest GitHub records (d.2 step 6) --

def _github_json(tool, path, missing):
    try:
        body = tool.fetch(GITHUB_API + path, None, HARNESS_METADATA_LIMIT)
    except HarnessRefusal as refusal:
        if (refusal.detail or {}).get("httpStatus") == 404:
            raise HarnessRefusal("HARNESS_RELEASE_NOT_FOUND", missing)
        raise
    try:
        doc = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        doc = None
    if not isinstance(doc, dict):
        raise HarnessRefusal("HARNESS_METADATA_INVALID", "GitHub's release metadata for %s is not valid JSON." % tool.label())
    return doc


def harness_repository(tool):
    repository = (tool.policy.get("source") or {}).get("repository")
    if not isinstance(repository, str) or not _GITHUB_REPOSITORY_RE.fullmatch(repository):
        raise HarnessRefusal("POLICY_INVALID", "The tool policy names no valid GitHub repository for %s." % tool.label())
    return repository


def github_latest_version(tool):
    repository = harness_repository(tool)
    doc = _github_json(tool, "/repos/%s/releases/latest" % repository, "%s has no published release." % repository)
    tag = doc.get("tag_name")
    if not isinstance(tag, str) or not tag.startswith("v") or not _PLAIN_VERSION_RE.fullmatch(tag[1:]):
        raise HarnessRefusal("HARNESS_METADATA_INVALID", "GitHub's newest %s release is tagged %r, which is not a plain "
                             "release version." % (tool.label(), tail_text(str(tag), 40)))
    return tag[1:]


def github_release_asset(tool, version):
    """The release asset for this server and the sha256 GitHub records for it.
    No recorded digest means the bytes cannot be verified: refused."""
    repository = harness_repository(tool)
    name = tool.spec["assets"].get(tool.machine)
    if name is None:
        raise HarnessRefusal("UNSUPPORTED_PLATFORM", "%s is published for x86_64 and arm64 Linux only." % tool.label())
    doc = _github_json(tool, "/repos/%s/releases/tags/v%s" % (repository, version),
                       "%s is not an official release (GitHub has no release v%s)." % (tool.label(version), version))
    if doc.get("tag_name") != "v" + version or doc.get("draft") is not False:
        raise HarnessRefusal("HARNESS_METADATA_INVALID", "GitHub's release metadata does not describe %s." % tool.label(version))
    if doc.get("prerelease") is not False:
        raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", "%s is a pre-release; the Portal installs releases only."
                             % tool.label(version))
    assets = [a for a in doc.get("assets") or [] if isinstance(a, dict) and a.get("name") == name]
    if len(assets) != 1:
        raise HarnessRefusal("HARNESS_RELEASE_ASSET_MISSING", "The %s release has no %s file for this server." % (
            tool.label(version), name))
    asset = assets[0]
    url = "https://github.com/%s/releases/download/v%s/%s" % (repository, version, name)
    if asset.get("browser_download_url") != url:
        raise HarnessRefusal("HARNESS_SOURCE_ORIGIN", "The %s download is not served from the official release." % tool.label(version))
    digest = _GITHUB_DIGEST_RE.fullmatch(asset.get("digest") or "")
    if not digest:
        raise HarnessRefusal("HARNESS_SOURCE_UNVERIFIABLE", "GitHub records no sha256 digest for the %s file %s, so it cannot "
                             "be verified; nothing was installed." % (tool.label(version), name))
    size = asset.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= tool.spec["maxArchiveBytes"]:
        raise HarnessRefusal("HARNESS_METADATA_INVALID", "The %s file %s has an unexpected size." % (tool.label(version), name))
    return {"version": version, "asset": name, "url": url, "sha256": digest.group(1), "size": size}


def harness_fetch_release(tool, release):
    directory = os.path.join(tool.work, "fetch")
    ensure_private_dir(directory)
    archive = os.path.join(directory, release["asset"])
    if tool.fetch(release["url"], archive, release["size"]) != release["size"]:
        raise HarnessRefusal("HARNESS_DIGEST_MISMATCH", "The downloaded %s is not the size GitHub records for it; nothing "
                             "was installed." % release["asset"])
    return archive


def proven_digest_match(tool, version, actual, what="the digest", detail=None):
    """True when `actual` is the digest the Portal qualified for `version` on
    this machine; None when nothing was qualified for it here (never refused).
    A mismatch is refused (callers check before anything is switched)."""
    expected = qualified_integrity(tool, version)
    if expected is None:
        return None
    if actual != expected:
        raise HarnessRefusal("HARNESS_PROVEN_DIGEST_MISMATCH", "%s does not match %s the Portal qualified for this server; "
                             "nothing was changed." % (tool.label(version), what),
                             dict({"expected": expected, "actual": actual, "machine": getattr(tool, "machine", None)},
                                  **(detail or {})))
    return True


def harness_verify_archive(tool, release, archive):
    actual = sha256_file(archive)
    if actual != release["sha256"]:
        raise HarnessRefusal("HARNESS_DIGEST_MISMATCH", "The downloaded %s does not match the digest GitHub records for "
                             "it; nothing was installed." % release["asset"], {"expected": release["sha256"], "actual": actual})
    proven_match = proven_digest_match(tool, release["version"], "sha256:" + actual)
    return {"kind": "github-release", "origin": release["url"], "archiveSha256": actual,
            "authority": "github-asset-digest", "provenDigestMatch": proven_match}


def harness_extract_single(tool, archive, destination):
    """The archive holds exactly one regular file, the executable: copy it to
    `destination` (new file, 0755). Returns its sha256."""
    executable, limit = tool.spec["executable"], tool.spec["maxBinaryBytes"]
    digest = hashlib.sha256()
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            members = bundle.getmembers()
            if len(members) != 1 or members[0].name != executable or not members[0].isreg() \
                    or not 0 < members[0].size <= limit:
                raise HarnessRefusal("HARNESS_ARCHIVE_UNEXPECTED", "The %s archive does not hold exactly one %s program; "
                                     "nothing was installed." % (tool.label(), executable))
            source = bundle.extractfile(members[0])
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o755)
            with os.fdopen(fd, "wb") as out:
                os.fchmod(out.fileno(), 0o755)
                for chunk in iter(lambda: source.read(1 << 20), b""):
                    digest.update(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
    except (tarfile.TarError, OSError, EOFError) as error:
        raise HarnessRefusal("HARNESS_ARCHIVE_UNEXPECTED", "The %s archive could not be read (%s); nothing was installed." % (
            tool.label(), tail_text(str(error), 160)))
    return digest.hexdigest()


def harness_version_refusal(tool, version):
    """Plain reason `version` may not be admitted, or None."""
    if not isinstance(version, str) or not tool.spec.get("versionPattern", _PLAIN_VERSION_RE).fullmatch(version):
        return "%s version %s is not a plain release version" % (tool.label(), version or "unknown")
    for entry in tool.policy.get("denylist") or []:
        if isinstance(entry, dict) and entry.get("version") == version:
            return "%s is refused by the Portal: %s" % (tool.label(version), entry.get("reason"))
    floor = tool.policy.get("floor")
    if not isinstance(floor, str) or parse_version(floor) is None or compare_versions(version, floor) < 0:
        return "%s is older than the Portal floor %s" % (tool.label(version), floor)
    return None


def harness_resolve_target(tool, target, installed_version):
    if target in ("recommended", "newestProven"):
        version = (tool.policy.get("newestProven") or {}).get("version")
    elif target == "newest":
        version = github_latest_version(tool)
    else:
        version = target
    refusal = harness_version_refusal(tool, version)
    if refusal:
        raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + ".")
    order = compare_versions(version, installed_version)
    if order == 0:
        raise HarnessRefusal("HARNESS_ALREADY_CURRENT", "%s is already installed. Nothing to update." % tool.label(version))
    if order < 0:
        raise HarnessRefusal("HARNESS_DOWNGRADE_REFUSED", "%s is older than the installed %s; the Portal does not downgrade "
                             "tools." % (tool.label(version), installed_version))
    return version


# -- installed layout: launcher symlink -> <runtime root>/<version>/<executable> --

def _harness_owned_problem(path, uid, directory):
    info = os.lstat(path)
    if (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) is False:
        return "is not a %s" % ("directory" if directory else "regular file")
    if info.st_uid != uid:
        return "is not owned by root"
    if stat.S_IMODE(info.st_mode) & 0o022:
        return "is writable by other users"
    return None


def versioned_installed(tool):
    try:
        info = os.lstat(tool.link)
    except FileNotFoundError:
        raise HarnessRefusal("HARNESS_TOOL_ABSENT", "%s is not installed on this server (%s is missing). %s"
                             % (tool.label(), tool.link, missing_tool_note(tool.tool_id)))
    if not stat.S_ISLNK(info.st_mode):
        raise HarnessRefusal("HARNESS_LAYOUT_UNMANAGED", "%s is not the Portal-managed launcher link, so the Portal does not "
                             "change it." % tool.link)
    target = os.readlink(tool.link)
    resolved = os.path.realpath(tool.link)
    runtime = harness_runtime_target(tool, target, resolved, (tool.spec["executable"],))
    if runtime is None:
        raise HarnessRefusal("HARNESS_LAYOUT_UNMANAGED", "%s points to %s, which is not a Portal-managed %s runtime under %s."
                             % (tool.link, resolved, tool.label(), tool.root))
    version, generation, legacy = runtime
    for path, directory in ((resolved, False), (os.path.dirname(resolved), True)):
        problem = _harness_owned_problem(path, tool.uid, directory)
        if problem:
            raise HarnessRefusal("HARNESS_TREE_UNSAFE", "%s %s; nothing was changed." % (path, problem))
    return dict({"version": version, "binary": resolved, "linkTarget": target, "sha256": sha256_file(resolved)},
                **harness_legacy_facts(generation, legacy))


# Portal 5.0.x installed OpenCode and Hermes privately under /opt/bridgesllm/tools/<tool>/<version>/ and 5.1.0 did
# not move them. toolctl reads exactly the shape the installer itself migrates (installer/opencode-runtime.sh and
# hermes-runtime.sh *_legacy_managed_alias): a direct absolute launcher link to <legacy root>/<tool>/<version>/<entry>,
# a root-owned regular file. Its update installs the new version into the managed root, switches the launcher, and
# retires that generation only after the new version is committed (until then it is what a swap-back restores).
def harness_runtime_target(tool, target, resolved, entry):
    """(version, generation, legacy) of the runtime the launcher runs: <root>/<version>/<entry...> under the managed
    root, or the 5.0.x shape under the legacy root; None for anything else (refused as unmanaged)."""
    for root, legacy in ((tool.root, False), (tool.legacy_root, True)):
        if not root:
            continue
        relative = os.path.relpath(resolved, os.path.realpath(root))
        parts = tuple(relative.split(os.sep))
        if relative.startswith("..") or parts[1:] != tuple(entry) or not _PLAIN_VERSION_RE.fullmatch(parts[0]):
            continue
        if legacy and (target != resolved or resolved != os.path.join(root, *parts)):
            return None  # a relative or indirect link into the 5.0.x tree: not a shape a Portal installer left
        return parts[0], os.path.join(os.path.realpath(root), parts[0]), legacy
    return None


def harness_legacy_facts(generation, legacy):
    """What an update records to retire a 5.0.x generation later: its path and directory identity."""
    if not legacy:
        return {"legacyGeneration": None, "legacyIdentity": None}
    info = os.lstat(generation)
    return {"legacyGeneration": generation, "legacyIdentity": [info.st_dev, info.st_ino]}


def ensure_harness_root(tool):
    """The managed runtime root, created the way the installer creates it (umask 022; install -d -m 0755) when the
    server never had it (a 5.0.x install). Returns the directories it created."""
    missing, path = [], tool.root
    while not os.path.lexists(path):
        missing.append(path)
        path = os.path.dirname(path)
    if missing:
        # installer/opencode-runtime.sh refuses a private or inaccessible ancestor: nobody else could run the tool.
        ancestor = path
        while True:
            if stat.S_IMODE(os.stat(ancestor).st_mode) & 0o005 != 0o005:
                raise HarnessRefusal("HARNESS_TREE_UNSAFE", "%s is private or not accessible to other users, so a runtime "
                                     "under %s would not run for them; nothing was changed." % (ancestor, tool.root))
            if ancestor == os.path.dirname(ancestor):
                break
            ancestor = os.path.dirname(ancestor)
    for directory in reversed(missing):
        os.mkdir(directory, 0o755)
        os.chmod(directory, 0o755)
    return list(reversed(missing))


def harness_retire_legacy(swap):
    """After a committed update from a 5.0.x runtime: remove that generation, and its tool directory when empty. Only
    while the launcher runs the committed version and the generation is the directory the update read (by identity).
    Returns the step detail; for an install that left a leftover alone, why; otherwise None (no 5.0.x runtime)."""
    generation = swap.get("legacyGeneration")
    if not generation:
        return swap.get("legacyLeftAlone")
    if not path_present(generation):
        return "The 5.0 runtime at %s is gone." % generation
    if not _links_to(swap["link"], swap["toBinary"]) or not _same_directory(generation, swap.get("legacyIdentity")):
        return "The 5.0 runtime at %s was left in place: it is not provably the one this update replaced." % generation
    try:
        shutil.rmtree(generation)
    except OSError as error:
        return "The 5.0 runtime at %s could not be removed (%s); nothing runs it." % (generation, error.strerror or error)
    try:
        os.rmdir(os.path.dirname(generation))  # only when empty
    except OSError:
        pass
    return "The 5.0 runtime at %s was retired." % generation


# -- install <tool> for harness tools (5.2.0): from nothing, the way update installs it --

def harness_install_check(tool):
    """Under the run lock: nothing at the launcher path (anything there is refused, never replaced). Returns the
    version install installs (install_version)."""
    if os.path.lexists(tool.link):
        raise HarnessRefusal("INSTALL_TOOL_PRESENT", "%s is already installed on this server (%s exists). Use Update or "
                             "Re-check on its card instead; nothing was changed." % (tool.label(), tool.link))
    return install_version(tool, lambda v: harness_version_refusal(tool, v))


def harness_state_dir(tool):
    """The tool's private state directory a fresh install creates (installer/<tool>-runtime.sh: install -d -m 0700
    /var/lib/bridgesllm/<tool>), next to toolctl's own state."""
    return os.path.join(os.path.dirname(tool.roots.state_root), tool.spec["runtimeDir"])


def harness_legacy_shape_problem(tool, generation):
    """Why <legacy root>/<version>/ is not provably what a Portal 5.0.x installer left (None when it is). Without a
    launcher this is the only proof, so it is the shape the update path reads through the launcher: a root-owned
    directory holding the entry (OpenCode `opencode`, Hermes `.venv/bin/hermes`) as a root-owned executable regular
    file reached without a symbolic link, none of it writable by other users (TEST's 5.0.10 Hermes: 0700, 0711), and
    for Hermes the generation's attestation for that version, read as hermes_installed reads a 5.0.x one."""
    version = os.path.basename(generation)
    entry = tool.spec.get("entry") or (tool.spec["executable"],)
    binary = os.path.join(generation, *entry)
    attestation = os.path.join(generation, tool.spec["attestation"]) if tool.spec.get("attestation") else None
    for path, directory in ((generation, True), (binary, False)) + (((attestation, False),) if attestation else ()):
        problem = _harness_owned_problem(path, tool.uid, directory) if path_present(path) else "is missing"
        if problem:
            return "%s %s" % (path, problem)
    if os.path.realpath(binary) != os.path.join(os.path.realpath(generation), *entry):
        return "%s is reached through a symbolic link" % binary
    if not os.lstat(binary).st_mode & stat.S_IXUSR:
        return "%s is not executable" % binary
    if attestation:
        fields = hermes_read_attestation(attestation) or {}
        tag = fields.get("upstream_tag", "")
        if fields.get("product_version") != version or not (tag == "v" + version or _HERMES_DATE_TAG_RE.fullmatch(tag)) \
                or not _GIT_SHA_RE.fullmatch(fields.get("upstream_commit", "")) \
                or not _SHA256_HEX_RE.fullmatch(fields.get("source_tree_sha256", "")):
            return "%s has no valid Portal runtime attestation for %s" % (generation, version)
    return None


def harness_legacy_only(tool):
    """For an install: the single generation a Portal 5.0.x installer left under the legacy root with no launcher,
    retired once the install is committed. Anything else there (more than one entry, a name that is not a plain
    version, a link, or a tree not in the installer's shape) is left alone, and the cleanup step says why."""
    root = tool.legacy_root
    if not root or not os.path.lexists(root):
        return harness_legacy_facts(None, False)
    names = os.listdir(root) if os.path.isdir(root) and not os.path.islink(root) else None
    if names == []:
        return harness_legacy_facts(None, False)
    generation = os.path.join(root, names[0]) if names and len(names) == 1 else None
    if names is None:
        problem = "%s is not a directory a Portal installer created" % root
    elif generation is None:
        problem = "%s holds %d entries, so none is provably the one this install replaces" % (root, len(names))
    elif not _PLAIN_VERSION_RE.fullmatch(names[0]) or os.path.islink(generation) or not os.path.isdir(generation):
        problem = "%s is not a version directory a Portal installer created" % generation
    else:
        problem = harness_legacy_shape_problem(tool, generation)
    if problem:
        return dict(harness_legacy_facts(None, False),
                    legacyLeftAlone="What is under %s was left in place: %s." % (root, problem))
    return harness_legacy_facts(generation, True)


def harness_install_swap(tool, run, version, stage, legacy, **extra):
    """The switch record of a versioned (OpenCode) or venv (Hermes) install: what reconcile and removal re-read."""
    version_dir = os.path.join(tool.root, version)
    entry = tool.spec.get("entry") or (tool.spec["executable"],)
    return dict({"kind": "versioned-install", "link": tool.link, "root": tool.root, "stage": stage,
                 "staged": os.path.join(stage, version), "versionDir": version_dir,
                 "toBinary": os.path.join(version_dir, *entry),
                 "failed": os.path.join(tool.root, ".bridgesllm-prev", "failed.%s" % run.run_id),
                 "fence": npm_fence_path(tool.roots, tool.tool_id), "from": None, "to": version, "identity": None,
                 "createdDirs": [], "state": "fencing"}, **dict(legacy, **extra))


def harness_place_install(tool, run, swap, now, place=None):
    """The install's switch: fence, the state directory a fresh install creates, the runtime directory (renamed into
    place by `place`, or already built there), then the launcher link created; nothing is ever replaced."""
    ensure_private_dir(os.path.dirname(swap["fence"]))
    run.status["swap"] = swap
    run.save()
    atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
    state_dir = harness_state_dir(tool)
    if not os.path.lexists(state_dir):
        swap["createdDirs"] = [state_dir]  # recorded first, removed (when empty) with the rest
        run.save()
        os.mkdir(state_dir, 0o700)
        os.chmod(state_dir, 0o700)
    if place is not None:
        swap["state"] = "placing"
        run.save()
        place()
        fsync_dir(tool.root)
    info = os.lstat(swap["versionDir"])
    swap.update(identity=[info.st_dev, info.st_ino], state="linking")
    run.save()
    try:
        os.symlink(swap["toBinary"], swap["link"])
    except FileExistsError:
        removed = harness_install_remove(swap)
        _remove_fence(swap)
        swap["state"] = "removed" if removed else "remove-failed"
        run.save()
        raise HarnessRefusal("INSTALL_TOOL_PRESENT" if removed else "INSTALL_REMOVE_FAILED",
                             "%s appeared at %s while this run was installing it; %s" % (
                                 tool.label(), swap["link"], "nothing was changed." if removed else
                                 "what this run added could not be removed. %s" % recheck_recovery_advice(tool.label())))
    fsync_dir(os.path.dirname(swap["link"]))
    swap["state"] = "swapped"
    run.save()


def harness_install_remove(swap):
    """Remove exactly what an install added: the launcher link while it is the one this run created, the runtime
    directory it placed or built (only that directory: by identity once recorded; before that the run had found the
    path empty under its lock), its stage, and the directories it created (when empty). True when none is left."""
    link, version_dir = swap["link"], swap["versionDir"]
    if os.path.islink(link) and os.readlink(link) == swap["toBinary"]:
        os.unlink(link)
        fsync_dir(os.path.dirname(link))
    if path_present(version_dir) and (swap.get("identity") is None or _same_directory(version_dir, swap["identity"])):
        ensure_private_dir(os.path.dirname(swap["failed"]))
        os.rename(version_dir, swap["failed"])
        shutil.rmtree(swap["failed"], ignore_errors=True)
        try:
            os.rmdir(os.path.dirname(swap["failed"]))  # only when empty
        except OSError:
            pass
    shutil.rmtree(swap["stage"], ignore_errors=True)
    for directory in swap.get("createdDirs") or []:
        try:
            os.rmdir(directory)
        except OSError:
            pass  # not empty any more: not this run's to remove
    return not (os.path.islink(link) and os.readlink(link) == swap["toBinary"]) and not path_present(version_dir) \
        and not path_present(swap["failed"])


def install_removed_refusal(tool, version, refusal, removed):
    """The refusal of an install that failed after it changed the server: removed again, or needing its Re-check."""
    return HarnessRefusal("INSTALL_REMOVED" if removed else "INSTALL_REMOVE_FAILED",
                          ("%s failed its check after it was installed (%s); it was removed again, so nothing was "
                           "changed." % (tool.label(version), refusal.message)) if removed else
                          ("%s failed its check after it was installed (%s) and could not be removed again. %s" % (
                              tool.label(version), refusal.message, recheck_recovery_advice(tool.label()))),
                          {"probe": (refusal.detail or {}).get("probe")})


def versioned_install(tool, run, step=None, now=utc_now, stop=None):
    """install opencode: the launcher is missing. The same release, digest check and candidate probes as an update;
    the verified runtime is renamed into the managed root and the launcher created; then the versioned finish
    (probe-installed, commit, cleanup), or what this run added is removed again. The gateway is never touched."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": "recommended", "from": None}
    with phase("installed", "Checking that it is not installed") as current:
        version = harness_install_check(tool)
        if path_present(os.path.join(tool.root, version)):
            raise HarnessRefusal("INSTALL_PATH_OCCUPIED", "%s already exists without a launcher, so the Portal does not "
                                 "replace it; nothing was changed." % os.path.join(tool.root, version))
        legacy = harness_legacy_only(tool)
        evidence["to"] = version
        current.detail = "%s is not installed; %s will be installed." % (tool.label(), version)
    with phase("resolve", "Finding the official release") as current:
        release = github_release_asset(tool, version)
        current.detail = "%s from %s." % (release["asset"], release["url"])
    stage, staged, binary_sha, source = versioned_candidate(tool, run, version, release, phase, evidence, stop)
    swap = harness_install_swap(tool, run, version, stage, legacy, binarySha256=binary_sha, source=source)
    with phase("swap", "Installing the new version") as current:
        harness_place_install(tool, run, swap, now, place=lambda: os.rename(staged, swap["versionDir"]))
        current.detail = "%s is now at %s." % (tool.label(version), tool.link)
    return versioned_finish_swap(tool, run, swap, evidence, phase, now)


# -- probes (b.4): C-VER, C-ACP; anything else is recorded as not run --

def harness_probe_version(tool, executable, version):
    record, out, err = _sandboxed_probe(tool, "C-VER", [executable] + tool.spec.get("versionArgs", ["--version"]),
                                        CLI_PROBE_TIMEOUT)
    first = out.strip().splitlines()[0] if out.strip() else ""
    # Vendor programs and Ollama may print a banner or a warning first; the installer reads any line.
    text = first if tool.spec["layout"] == "versioned-dir" else out + "\n" + err
    if record["exitCode"] == 0 and re.search(r"(?<![0-9.])%s(?![0-9]|\.[0-9])" % re.escape(version), text):
        record["state"] = "passed"
    else:
        record.update(state="failed", reason="--version printed %r, not %s" % (tail_text(first, 80), version))
    return record


def _acp_send(child, message):
    try:
        child.stdin.write((json.dumps(message) + "\n").encode("utf-8"))
        child.stdin.flush()
        return True
    except (BrokenPipeError, OSError, ValueError):
        return False


def _end_child(child):
    try:
        child.stdin.close()
    except (BrokenPipeError, OSError, ValueError):
        pass
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    child.stdout.close()


def acp_exchange(argv, messages, timeout, out_path):
    """Send JSON-RPC requests one at a time over stdio (newline-delimited, as
    ACP does) and collect each answer. Bounded in time and output. A request
    from the agent is refused; no prompt is ever sent (no inference)."""
    deadline = time.monotonic() + timeout
    answers, lines, timed_out, too_large = {}, [], False, False
    with open(out_path + ".stderr", "wb") as stderr:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                                 env={"PATH": CLEAN_PATH}, close_fds=True)
    try:
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        pending, received = b"", 0
        for message in messages:
            if not _acp_send(child, message):
                break
            while message["id"] not in answers and not (timed_out or too_large):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    timed_out = True
                    break
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                received += len(chunk)
                if received > CLI_PROBE_OUTPUT_LIMIT:
                    too_large = True
                    break
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    text = line.decode("utf-8", "replace").strip()
                    if not text:
                        continue
                    lines.append(text)
                    try:
                        doc = json.loads(text)
                    except ValueError:
                        continue
                    if not isinstance(doc, dict) or "id" not in doc:
                        continue
                    if "method" in doc:
                        _acp_send(child, {"jsonrpc": "2.0", "id": doc["id"], "error": {
                            "code": -32601, "message": "The Portal's check does not answer agent requests."}})
                    elif "result" in doc or "error" in doc:
                        answers[doc["id"]] = doc
            if message["id"] not in answers:
                break
        selector.close()
    finally:
        _end_child(child)
        if child.returncode < 0:
            sandbox_release(argv)
    with open(out_path + ".stderr", "rb") as handle:
        err = handle.read(CAPTURE_LIMIT_BYTES).decode("utf-8", "replace")
    with open(out_path, "w") as handle:
        handle.write("\n".join(lines[:200]))
    return {"answers": answers, "lines": lines, "timedOut": timed_out, "tooLarge": too_large,
            "exitCode": child.returncode, "stderr": err}


def _acp_advertised(capabilities, dotted):
    value = capabilities
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            return False
        value = value[part]
    return value is True or isinstance(value, dict)


def acp_initialize_problem(spec, answer, version):
    """None when `initialize` matches what the Portal's ACP launch requires."""
    if not isinstance(answer, dict):
        return "initialize was not answered"
    if "error" in answer:
        return "initialize failed: %s" % tail_text(str((answer.get("error") or {}).get("message")), 160)
    result = answer.get("result")
    if not isinstance(result, dict) or result.get("protocolVersion") != 1:
        return "initialize did not agree on ACP protocol version 1"
    info = result.get("agentInfo") if isinstance(result.get("agentInfo"), dict) else {}
    # Grok Build reports its version in `_meta.agentVersion` (AcpHarnessProfiles.ts agentVersionSource).
    meta = result.get("_meta") if isinstance(result.get("_meta"), dict) else {}
    reported = meta.get("agentVersion") if spec.get("versionSource") == "meta" else info.get("version")
    if (spec["agentName"] is not None and info.get("name") != spec["agentName"]) or reported != version:
        return "the agent reports itself as %s %s, not %s %s" % (
            tail_text(str(info.get("name")), 40), tail_text(str(reported), 40), spec["agentName"] or "version", version)
    capabilities = result.get("agentCapabilities") if isinstance(result.get("agentCapabilities"), dict) else {}
    missing = [c for c in spec["capabilities"] if not _acp_advertised(capabilities, c)]
    if missing:
        return "the agent does not advertise %s" % ", ".join(missing)
    image = (capabilities.get("promptCapabilities") or {}).get("image") is True \
        if isinstance(capabilities.get("promptCapabilities"), dict) else False
    if "image" in spec and image != spec["image"]:
        return "image input is %s, the Portal expects %s" % ("on" if image else "off", "on" if spec["image"] else "off")
    return None


def acp_session_problem(spec, answer):
    """None when `session/new` without a login behaves as recorded for the tool."""
    if not isinstance(answer, dict):
        return "session/new was not answered"
    if "result" in answer:
        session_id = (answer.get("result") or {}).get("sessionId") if isinstance(answer.get("result"), dict) else None
        if isinstance(session_id, str) and _ACP_SESSION_ID_RE.fullmatch(session_id):
            return None
        return "session/new returned no usable session id"
    message = str((answer.get("error") or {}).get("message") if isinstance(answer.get("error"), dict) else answer.get("error"))
    if spec["sessionNew"] == "auth-required" and re.search(r"auth", message, re.IGNORECASE):
        return None
    return "session/new failed: %s" % tail_text(message, 160)


def harness_probe_acp(tool, executable, version):
    """C-ACP: `initialize` and an unauthenticated `session/new` in the sandbox."""
    spec = tool.spec["acp"]
    argv = [executable] + list(spec["args"])
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": 1, "clientCapabilities": {"terminal": False, "fs": {"readTextFile": False, "writeTextFile": False}},
            "clientInfo": {"name": "bridgesllm-portal", "title": "BridgesLLM Portal", "version": "probe"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": "/tmp", "mcpServers": []}},
    ]
    started = time.time()
    try:
        outcome = tool.acp(tool.sandbox_argv(argv), messages, ACP_PROBE_TIMEOUT, os.path.join(tool.work, "probe-c-acp.out"))
    except OSError as error:
        return {"id": "C-ACP", "argv": argv, "state": "failed", "reason": "the ACP agent could not start (%s)" % error}
    record = {"id": "C-ACP", "argv": argv, "exitCode": outcome["exitCode"], "timedOut": outcome["timedOut"],
              "stdout": tail_text(redact_text("\n".join(outcome["lines"])), 800),
              "stderr": tail_text(redact_text(outcome["stderr"]), 400), "seconds": round(time.time() - started, 3)}
    reason = acp_initialize_problem(spec, outcome["answers"].get(1), version) \
        or acp_session_problem(spec, outcome["answers"].get(2))
    if reason and outcome["tooLarge"]:
        reason += " (the agent printed more than toolctl reads)"
    elif reason and outcome["timedOut"]:
        reason += " within %d s" % ACP_PROBE_TIMEOUT
    if reason:
        record.update(state="failed", reason=reason)
    else:
        record["state"] = "passed"
    return record


# The probes run a tree as the sandbox identity (SANDBOX_UID), so it must be
# readable by any user. The installer helpers, install.sh and toolctl itself
# run under umask 077 (bridgesllm-tools@.service UMask=0077; main() sets it),
# so each tree a run produces is given the installer's public modes right
# before its first probe, as npm candidates are (npm_stage).
HARNESS_PUBLISH_MAX_ENTRIES = 262144  # a Hermes generation (its venv) holds about 22,000


def harness_publish(tool, path):
    """Give the tree (or single program) at `path` that this run produced the installer's public modes: directories
    and executables 0755, other files 0644, owners unchanged, no link followed; set-user-ID, set-group-ID or sticky
    bits and special files are refused (HARNESS_TREE_UNSAFE) and each entry is re-read to prove its mode."""
    try:
        npm_retree(path, None, None, publish=True, max_entries=HARNESS_PUBLISH_MAX_ENTRIES, refusal=HarnessRefusal)
    except OSError as error:
        raise HarnessRefusal("HARNESS_TREE_UNSAFE", "%s could not be made readable to the probe sandbox (%s), so %s "
                             "cannot be checked safely." % (path, error.strerror or error, tool.label()))


def harness_publish_placed(tool):
    """harness_publish for the program a helper or install.sh just placed at the launcher, when it is a root-owned
    regular file no other user can write; anything else is left as it is for vendor_installed to refuse."""
    try:
        if _harness_owned_problem(tool.link, tool.uid, False) is not None:
            return
    except FileNotFoundError:
        return
    harness_publish(tool, tool.link)


def harness_probe_set(tool, executable, version):
    """The policy's required probes this build implements; others are recorded
    as not run (never as passed). Returns (records, first failed record or None)."""
    records = []
    for probe_id in list(((tool.policy.get("probes") or {}).get("required")) or []):
        if probe_id == "C-VER":
            record = harness_probe_version(tool, executable, version)
        elif probe_id == "C-ACP" and "acp" in tool.spec:
            record = harness_probe_acp(tool, executable, version)
        elif probe_id == "C-ACP" and "acpCheck" in tool.spec:
            record = harness_probe_acp_check(tool, executable)
        else:
            record = {"id": probe_id, "state": "not-run", "reason": "Not in this Portal build yet."}
        records.append(record)
        if record["state"] == "failed":
            return records, record
    return records, None


# -- admission record (C5 extension for harness tools) --

def build_harness_record(tool, installed, source, probes, admitted_by, admitted_at):
    return {
        "schema": SCHEMA_HARNESS_RECORD,
        "toolId": tool.tool_id,
        "version": installed["version"],
        "layout": tool.spec["layout"],
        "runtimeRoot": tool.root,
        "launcher": tool.link,
        "executables": {tool.spec.get("executable", tool.tool_id): {"path": installed["binary"], "sha256": installed["sha256"]}},
        "source": dict(source),
        "probes": {state: [p["id"] for p in probes or [] if p["state"] == key]
                   for state, key in (("passed", "passed"), ("failed", "failed"), ("notRun", "not-run"))},
        "admittedAt": admitted_at,
        "admittedBy": admitted_by,
    }


def write_harness_record(roots, record):
    """Atomically replace <state>/admission/<toolId>.json (dir 0700, file 0600)."""
    if record.get("toolId") not in HARNESS_TOOL_IDS or record.get("schema") != SCHEMA_HARNESS_RECORD:
        raise ToolctlError("harness admission records are written for harness tools only")
    if len(json.dumps(record, indent=2, sort_keys=True)) + 1 > ADMISSION_RECORD_MAX_BYTES:
        raise HarnessRefusal("ADMISSION_RECORD_INVALID", "The admission record is larger than the backend reads.")
    directory = npm_admission_dir(roots)
    ensure_private_dir(directory)
    path = os.path.join(directory, record["toolId"] + ".json")
    atomic_write_json(path, record)
    fsync_dir(directory)
    return path


# -- requalify / update for the versioned-dir layout (OpenCode) --

def versioned_requalify(tool, run_id, step=None, now=utc_now):
    """requalify <tool>: installs and switches nothing; writes the record only
    when the installed binary is the official release's and the probes pass."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run_id}
    with phase("installed", "Reading the installed version") as current:
        installed = versioned_installed(tool)
        version = installed["version"]
        evidence["installedVersion"] = tool.installed_version = version
        refusal = harness_version_refusal(tool, version)
        if refusal:
            raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + "; update it instead.")
        current.detail = "%s is installed." % tool.label(version)
    with phase("resolve", "Finding the official release") as current:
        release = github_release_asset(tool, version)
        current.detail = "%s from %s." % (release["asset"], release["url"])
    with phase("fetch", "Downloading the official release") as current:
        archive = harness_fetch_release(tool, release)
        current.detail = "%d bytes." % release["size"]
    with phase("verify-source", "Verifying the download") as current:
        source = harness_verify_archive(tool, release, archive)
        ensure_private_dir(os.path.join(tool.work, "official"))
        official = harness_extract_single(tool, archive, os.path.join(tool.work, "official", tool.spec["executable"]))
        current.detail = "The download matches the digest GitHub records."
    with phase("compare", "Comparing the installed program with the official release") as current:
        if official != installed["sha256"]:
            raise HarnessRefusal("HARNESS_BINARY_DIFFERS", "The installed %s is not the official release program." % (
                tool.label(version)), {"installedSha256": installed["sha256"], "officialSha256": official})
        current.detail = "The installed program is the official release."
    with phase("probe", "Checking the installed program") as current:
        probes, failed = harness_probe_set(tool, tool.link, version)
        evidence["probes"] = probes
        if failed:
            raise HarnessRefusal("CLI_PROBE_FAILED", "%s failed its %s check: %s." % (tool.label(version), failed["id"],
                                                                                    failed["reason"]), {"probe": failed})
        current.detail = _probe_summary(probes)
    with phase("commit", "Recording the admission") as current:
        again = versioned_installed(tool)
        if (again["binary"], again["sha256"]) != (installed["binary"], installed["sha256"]):
            raise HarnessRefusal("HARNESS_TREE_CHANGED", "The installed %s changed while it was being checked; nothing was "
                                 "admitted." % tool.label(version))
        record = build_harness_record(tool, installed, source, probes, "requalify:%s" % run_id, now())
        evidence["recordPath"] = write_harness_record(tool.roots, record)
        current.detail = "Admitted %s (re-checked)." % tool.label(version)
    return record, evidence


def _replace_symlink(link, target, tag):
    """Point `link` at `target` with one rename (atomic for every reader)."""
    temporary = os.path.join(os.path.dirname(link), ".%s.%s.tmp" % (os.path.basename(link), tag))
    if path_present(temporary):
        os.unlink(temporary)
    os.symlink(target, temporary)
    os.rename(temporary, link)
    fsync_dir(os.path.dirname(link))


def _links_to(link, binary):
    return os.path.islink(link) and path_present(binary) and os.path.realpath(link) == os.path.realpath(binary)


def versioned_swap_back(swap):
    """Launcher back to the previous runtime, the candidate removed, a
    displaced directory put back. Idempotent on the filesystem state; True
    when the previous runtime is live again."""
    if not _links_to(swap["link"], swap["fromBinary"]) and path_present(swap["fromBinary"]):
        _replace_symlink(swap["link"], swap["fromTarget"], "swap-back")
    if path_present(swap["versionDir"]) and not path_present(swap["staged"]):
        ensure_private_dir(os.path.dirname(swap["failed"]))
        os.rename(swap["versionDir"], swap["failed"])
        shutil.rmtree(swap["failed"], ignore_errors=True)
    if path_present(swap["displaced"]) and not path_present(swap["versionDir"]):
        os.rename(swap["displaced"], swap["versionDir"])
    shutil.rmtree(swap["stage"], ignore_errors=True)
    try:
        os.rmdir(os.path.dirname(swap["failed"]))  # only when empty
    except OSError:
        pass
    fsync_dir(swap["root"])
    return _links_to(swap["link"], swap["fromBinary"])


def versioned_cleanup(tool, keep, current_stage):
    """After a commit: keep the new and the previous version (instant
    swap-back), delete older managed versions and leftovers."""
    for name in sorted(os.listdir(tool.root)):
        path = os.path.join(tool.root, name)
        if os.path.islink(path) or not os.path.isdir(path) or name in keep:
            continue
        if _PLAIN_VERSION_RE.fullmatch(name) or name == ".bridgesllm-prev" or (
                name.startswith(".bridgesllm-stage-") and path != current_stage):
            shutil.rmtree(path, ignore_errors=True)
    shutil.rmtree(current_stage, ignore_errors=True)


def versioned_update(tool, run, target, step=None, now=utc_now, stop=None):
    """update <tool>: verify and probe the candidate, fence, switch the launcher
    atomically, probe the installed path, commit the record; any failure after
    the switch puts the previous version back. The gateway is never touched."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": target}
    with phase("installed", "Reading the installed version") as current:
        installed = versioned_installed(tool)
        old_version = installed["version"]
        version = harness_resolve_target(tool, target, old_version)
        evidence.update({"from": old_version, "to": version})
        current.detail = "%s is installed; %s is the target." % (tool.label(old_version), version)
    with phase("resolve", "Finding the official release") as current:
        release = github_release_asset(tool, version)
        current.detail = "%s from %s." % (release["asset"], release["url"])
    stage, staged, binary_sha, source = versioned_candidate(tool, run, version, release, phase, evidence, stop)
    prev_dir = os.path.join(tool.root, ".bridgesllm-prev")
    swap = {"kind": "versioned-symlink", "link": tool.link, "root": tool.root, "stage": stage, "staged": staged,
            "versionDir": os.path.join(tool.root, version),
            "toBinary": os.path.join(tool.root, version, tool.spec["executable"]),
            "fromTarget": installed["linkTarget"], "fromBinary": installed["binary"],
            "displaced": os.path.join(prev_dir, "%s.%s" % (version, run.run_id)),
            "failed": os.path.join(prev_dir, "failed.%s" % run.run_id),
            "fence": npm_fence_path(tool.roots, tool.tool_id), "from": old_version, "to": version,
            "binarySha256": binary_sha, "source": source, "state": "fencing",
            "legacyGeneration": installed["legacyGeneration"], "legacyIdentity": installed["legacyIdentity"]}
    return versioned_switch(tool, run, swap, evidence, phase, now, prev_dir, old_version)


def versioned_candidate(tool, run, version, release, phase, evidence, stop):
    """fetch -> verify-source -> probe-candidate of an update or install: the official release staged in the managed
    root (created when missing). Returns (stage, staged, binary sha256, source); the stage is removed on any failure."""
    with phase("fetch", "Downloading the official release") as current:
        archive = harness_fetch_release(tool, release)
        current.detail = "%d bytes." % release["size"]
    ensure_harness_root(tool)
    stage = os.path.join(tool.root, ".bridgesllm-stage-%s" % run.run_id)
    staged = os.path.join(stage, version)
    try:
        with phase("verify-source", "Verifying the download") as current:
            source = harness_verify_archive(tool, release, archive)
            if path_present(stage):
                shutil.rmtree(stage)
            for directory in (stage, staged):
                os.mkdir(directory, 0o755)
                os.chmod(directory, 0o755)
            binary_sha = harness_extract_single(tool, archive, os.path.join(staged, tool.spec["executable"]))
            current.detail = "The download matches the digest GitHub records."
        with phase("probe-candidate", "Checking the new version before it is installed") as current:
            harness_publish(tool, stage)
            probes, failed = harness_probe_set(tool, os.path.join(staged, tool.spec["executable"]), version)
            evidence["probes"] = [dict(probe, target="candidate") for probe in probes]
            if failed:
                raise HarnessRefusal("CLI_PROBE_FAILED", "%s failed its %s check before installation, so nothing was changed: "
                                     "%s." % (tool.label(version), failed["id"], failed["reason"]), {"probe": failed})
            current.detail = _probe_summary(probes) + " (candidate)"
        if stop:
            raise NpmStopped()
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return stage, staged, binary_sha, source


def versioned_switch(tool, run, swap, evidence, phase, now, prev_dir, old_version):
    """The update's switch (a leftover version directory kept aside), then the versioned finish."""
    version, staged = swap["to"], swap["staged"]
    with phase("swap", "Switching to the new version") as current:
        ensure_private_dir(os.path.dirname(swap["fence"]))
        run.status["swap"] = swap
        run.save()
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        if path_present(swap["versionDir"]):
            # A leftover of an earlier attempt: kept aside, put back on swap-back.
            swap["state"] = "displacing"
            run.save()
            ensure_private_dir(prev_dir)
            os.rename(swap["versionDir"], swap["displaced"])
        swap["state"] = "placing"
        run.save()
        os.rename(staged, swap["versionDir"])
        fsync_dir(tool.root)
        swap["state"] = "linking"
        run.save()
        _replace_symlink(tool.link, swap["toBinary"], run.run_id)
        swap["state"] = "swapped"
        run.save()
        current.detail = "%s is now at %s; %s is kept for swap-back." % (tool.label(version), tool.link, old_version)
    return versioned_finish_swap(tool, run, swap, evidence, phase, now)


def versioned_finish_swap(tool, run, swap, evidence, phase, now):
    """probe-installed -> commit -> cleanup, or swap back. Shared by the run and
    by reconcile after a crash between the switch and the commit."""
    version = swap["to"]
    try:
        with phase("probe-installed", "Checking the installed new version") as current:
            probes, failed = harness_probe_set(tool, tool.link, version)
            evidence.setdefault("probes", []).extend(dict(probe, target="installed") for probe in probes)
            if failed:
                raise HarnessRefusal("CLI_PROBE_FAILED", "%s: %s" % (failed["id"], failed["reason"]), {"probe": failed})
            venv = tool.spec["layout"] == "venv-generation"
            installed = hermes_installed(tool) if venv else versioned_installed(tool)
            if (installed["version"], installed["sha256"]) != (version, swap["binarySha256"]) or venv and (
                    installed["commit"], installed["treeSha256"]) != (swap["source"]["commit"], swap["source"]["treeSha256"]):
                raise HarnessRefusal("HARNESS_TREE_CHANGED", "the installed program is not the verified candidate")
            current.detail = _probe_summary(probes) + " (installed)"
        with phase("commit", "Recording the admission") as current:
            record = (hermes_record if venv else build_harness_record)(tool, installed, swap["source"], probes,
                                                                       "run:%s" % run.run_id, now())
            swap["state"] = "committing"
            run.save()
            evidence["recordPath"] = write_harness_record(tool.roots, record)
            swap["state"] = "committed"
            run.save()
            current.detail = "Admitted %s." % tool.label(version)
    except HarnessRefusal as refusal:
        if swap["kind"] == "versioned-install":
            swap["state"] = "removing"
            run.save()
            removed = harness_install_remove(swap)
            swap["state"] = "removed" if removed else "remove-failed"
            run.save()
            _remove_fence(swap)
            raise install_removed_refusal(tool, version, refusal, removed)
        swap["state"] = "swapping-back"
        run.save()
        restored = versioned_swap_back(swap)
        swap["state"] = "swapped-back" if restored else "swap-back-failed"
        run.save()
        old_probe = harness_probe_version(tool, tool.link, swap["from"]) if restored else None
        _remove_fence(swap)
        raise HarnessRefusal("HARNESS_SWAPPED_BACK" if restored else "HARNESS_SWAP_BACK_FAILED",
                             ("%s failed its check after the switch (%s); %s was put back." % (
                                 tool.label(version), refusal.message, swap["from"])) if restored else
                             ("%s failed its check after the switch (%s) and the previous version could not be put back."
                              % (tool.label(version), refusal.message)),
                             {"probe": (refusal.detail or {}).get("probe"), "previousProbe": old_probe})
    _remove_fence(swap)
    with phase("cleanup", "Cleaning up") as current:
        if swap["kind"] == "versioned-install":
            shutil.rmtree(swap["stage"], ignore_errors=True)
            current.detail = harness_retire_legacy(swap) or "Done."
        else:
            versioned_cleanup(tool, (swap["to"], swap["from"]), swap["stage"])
            current.detail = harness_retire_legacy(swap) or "%s is kept until the next successful update." % tool.label(
                swap["from"])
    return record, evidence


# -- requalify / update for vendor single-file programs (Grok Build, Antigravity) --

def vendor_installed(tool):
    """The launcher is a root-owned regular file; its version is what it
    reports inside the sandbox (never run outside it here)."""
    try:
        info = os.lstat(tool.link)
    except FileNotFoundError:
        raise HarnessRefusal("HARNESS_TOOL_ABSENT", "%s is not installed on this server (%s is missing). %s"
                             % (tool.label(), tool.link, missing_tool_note(tool.tool_id)))
    if not stat.S_ISREG(info.st_mode):
        raise HarnessRefusal("HARNESS_LAYOUT_UNMANAGED", "%s is not the program the Portal installer places (a regular "
                             "file), so the Portal does not change it." % tool.link)
    for path, directory in ((tool.link, False), (os.path.dirname(tool.link), True)):
        problem = _harness_owned_problem(path, tool.uid, directory)
        if problem:
            raise HarnessRefusal("HARNESS_TREE_UNSAFE", "%s %s; nothing was changed." % (path, problem))
    record, out, err = _sandboxed_probe(tool, "C-VER", [tool.link] + tool.spec["versionArgs"], CLI_PROBE_TIMEOUT)
    match = _VERSION_IN_TEXT_RE.search(out + "\n" + err)
    if record["exitCode"] != 0 or not match:
        record.update(state="failed", reason="--version printed %r" % tail_text(out.strip(), 80))
        raise HarnessRefusal("CLI_PROBE_FAILED", "%s did not report its version in the sandbox; nothing was changed."
                             % tool.label(), {"probe": record})
    return {"version": match.group(1), "binary": tool.link, "sha256": sha256_file(tool.link)}


def vendor_proven_match(tool, installed):
    """The installed program against the digest the Portal qualified for its
    version on this machine: a sha256 entry is the recorded binarySha256, a
    sha512 entry is computed from the same file."""
    expected = qualified_integrity(tool, installed["version"])
    if expected is None:
        return None
    actual = ("sha256:" + installed["sha256"]) if expected.startswith("sha256:") else \
        "sha512:" + file_digest(installed["binary"], "sha512")
    return proven_digest_match(tool, installed["version"], actual, "the program")


def vendor_source(tool, installed, updated=False):
    """What vouches for the installed bytes. The pinned version must carry the
    pinned digest where one exists; a vendor self-update is re-checked by its
    probes only and recorded as unverified bytes (d.2 step 7). A version the
    Portal qualified for this machine must also carry the qualified digest."""
    digest = tool.spec["pinnedSha256"].get(tool.machine)
    source = {"kind": "vendor", "origin": tool.spec["origin"], "binarySha256": installed["sha256"]}
    if installed["version"] != tool.spec["pinnedVersion"]:
        return dict(source, authority="vendor-self-update", bytesVerified=False,
                    provenDigestMatch=vendor_proven_match(tool, installed))
    if digest is not None:
        if installed["sha256"] != digest:
            # After an update's switch this is the reason its swap-back message quotes.
            raise HarnessRefusal("HARNESS_BINARY_DIFFERS", "the installed %s is not the build the Portal tested (its digest "
                                 "differs)" % tool.label(installed["version"]) if updated else
                                 vendor_binary_differs_message(tool, installed["version"], False),
                                 {"installedSha256": installed["sha256"], "pinnedSha256": digest})
        return dict(source, authority="portal-pinned-digest", bytesVerified=True,
                    provenDigestMatch=vendor_proven_match(tool, installed))
    # The pinned digest covers the vendor archive: only an install through the helper checked it.
    return dict(source, authority="portal-pinned-digest" if updated else "probes-only", bytesVerified=updated,
                provenDigestMatch=vendor_proven_match(tool, installed))


def vendor_binary_differs_message(tool, version, nothing_changed):
    """A program that reports the tested version with other bytes: nothing in
    the Portal replaces it (the helper's converge keeps any program that reports
    the tested version), so the step is the publisher's install, then a
    re-check. Another version from the publisher is re-checked as a vendor
    self-update (vendor_source)."""
    return ("The installed %s reports the version the Portal tested but is not the build the Portal tested (its digest "
            "differs). The Portal does not replace a program that reports the tested version%s: reinstall %s from its "
            "publisher, then Re-check it in Admin > Maintenance." % (
                tool.label(version), ", so nothing was changed" if nothing_changed else "", tool.label()))


def vendor_requalify(tool, run_id, step=None, now=utc_now):
    """requalify <tool>: installs nothing; writes the record when the program
    passes its probes (and, at the pinned version, carries the pinned digest)."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run_id}
    with phase("installed", "Reading the installed version") as current:
        installed = vendor_installed(tool)
        version = installed["version"]
        evidence["installedVersion"] = tool.installed_version = version
        refusal = harness_version_refusal(tool, version)
        if refusal:
            raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + "; update it instead.")
        current.detail = "%s is installed." % tool.label(version)
    with phase("compare", "Comparing the installed program with the version the Portal tested") as current:
        source = vendor_source(tool, installed)
        evidence["source"] = source
        current.detail = {"portal-pinned-digest": "The installed program is the build the Portal tested.",
                          "probes-only": "The vendor publishes no checksum; the program is checked by its probes.",
                          "vendor-self-update": "The vendor updated it to %s; it publishes no checksum, so it is checked "
                                                "by its probes only." % version}[source["authority"]]
    with phase("probe", "Checking the installed program") as current:
        probes, failed = harness_probe_set(tool, tool.link, version)
        evidence["probes"] = probes
        if failed:
            raise HarnessRefusal("CLI_PROBE_FAILED", "%s failed its %s check: %s." % (tool.label(version), failed["id"],
                                                                                    failed["reason"]), {"probe": failed})
        current.detail = _probe_summary(probes)
    with phase("commit", "Recording the admission") as current:
        if sha256_file(tool.link) != installed["sha256"]:
            raise HarnessRefusal("HARNESS_TREE_CHANGED", "The installed %s changed while it was being checked; nothing was "
                                 "admitted." % tool.label(version))
        record = build_harness_record(tool, installed, source, probes, "requalify:%s" % run_id, now())
        evidence["recordPath"] = write_harness_record(tool.roots, record)
        current.detail = "Admitted %s (re-checked)." % tool.label(version)
    return record, evidence


def vendor_resolve_target(tool, target, installed):
    """Only the helper's pinned version, with its pinned digest, is installable."""
    pinned = tool.spec["pinnedVersion"]
    if target not in ("recommended", "newestProven", pinned):
        raise HarnessRefusal("HARNESS_SOURCE_UNVERIFIABLE", "%s publishes no checksums, so this Portal installs only the "
                             "version it tested, %s; nothing was changed." % (tool.label(), pinned))
    if (tool.policy.get("newestProven") or {}).get("version") != pinned:
        raise HarnessRefusal("POLICY_INVALID", "The tool policy recommends a %s version other than the %s this Portal's "
                             "installer pins; nothing was changed." % (tool.label(), pinned))
    refusal = harness_version_refusal(tool, pinned)
    if refusal:
        raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + ".")
    order = compare_versions(pinned, installed["version"])
    digest = tool.spec["pinnedSha256"].get(tool.machine)
    if order == 0 and digest is not None and installed["sha256"] != digest:
        # The helper's converge keeps any program that reports the tested version.
        raise HarnessRefusal("HARNESS_BINARY_DIFFERS", vendor_binary_differs_message(tool, pinned, True))
    if order == 0:
        raise HarnessRefusal("HARNESS_ALREADY_CURRENT", "%s is already installed. Nothing to update." % tool.label(pinned))
    if order < 0:
        raise HarnessRefusal("HARNESS_DOWNGRADE_REFUSED", "%s is older than the installed %s; the Portal does not downgrade "
                             "tools." % (tool.label(pinned), installed["version"]))
    return pinned


def vendor_helper(tool, name=None):
    path = os.path.join(harness_path(tool.roots, "harness_helper_dir"), name or tool.spec["helper"])
    try:
        problem = _harness_owned_problem(path, tool.uid, False)
    except FileNotFoundError:
        problem = "is missing"
    if problem:
        # On a server the helper directory is the Portal tree's installer/ (toolctl's parent), which --repair restores.
        raise HarnessRefusal("HARNESS_HELPER_UNAVAILABLE", "The Portal installer helper %s %s, so %s cannot be installed; "
                             "nothing was changed. Run sudo bash install.sh --repair on the server to restore the Portal's "
                             "files." % (path, problem, tool.label()))
    return path


def vendor_swap_back(swap):
    """The previous program back at the launcher with one rename. True when
    the launcher holds the previous program again."""
    backup, link = swap["backup"], swap["link"]
    if path_present(backup):
        if path_present(link) and os.path.samefile(backup, link):
            os.unlink(backup)  # the launcher never moved: renaming a link onto itself is a no-op
        else:
            os.rename(backup, link)
        fsync_dir(os.path.dirname(link))
    return os.path.isfile(link) and not os.path.islink(link) and sha256_file(link) == swap["fromSha256"]


def vendor_update(tool, run, target, step=None, now=utc_now, stop=None):
    """update <tool> to the Portal-tested version through the installer helper
    (it downloads, checks the pinned digest and version, and replaces the
    launcher with one rename); then probe the installed program, commit the
    record, or put the previous program back. The gateway is never touched."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": target}
    with phase("installed", "Reading the installed version") as current:
        installed = vendor_installed(tool)
        old_version = installed["version"]
        version = vendor_resolve_target(tool, target, installed)
        evidence.update({"from": old_version, "to": version})
        current.detail = "%s is installed; %s is the target." % (tool.label(old_version), version)
    with phase("resolve", "Finding the Portal-tested release") as current:
        helper = vendor_helper(tool)
        pinned_sha = tool.spec["pinnedSha256"].get(tool.machine)
        expected = qualified_integrity(tool, version)
        if pinned_sha is not None and expected is not None and expected.startswith("sha256:"):
            # The helper installs exactly the pinned program, so a qualified digest that differs is refused now.
            proven_digest_match(tool, version, "sha256:" + pinned_sha, "the program")
        current.detail = "%s with the digest the Portal pinned, installed by %s." % (tool.label(version), helper)
    if stop:
        raise NpmStopped()
    swap = {"kind": "vendor-file", "link": tool.link,
            "backup": os.path.join(os.path.dirname(tool.link), ".%s.bridgesllm-prev.%s" % (tool.spec["executable"], run.run_id)),
            "fromSha256": installed["sha256"], "fence": npm_fence_path(tool.roots, tool.tool_id), "from": old_version,
            "to": version, "helper": helper, "state": "fencing"}
    with phase("swap", "Installing the Portal-tested version") as current:
        ensure_private_dir(os.path.dirname(swap["fence"]))
        run.status["swap"] = swap
        run.save()
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        if path_present(swap["backup"]):
            os.unlink(swap["backup"])
        os.link(tool.link, swap["backup"])  # the previous program, kept for swap-back
        swap["state"] = "installing"
        run.save()
        code, reason = vendor_run_helper(tool, helper, evidence)
        if code != 0:
            if vendor_swap_back(swap):
                _remove_fence(swap)
                swap["state"] = "unchanged"
                run.save()
                raise HarnessRefusal("HARNESS_HELPER_FAILED", "The installer helper could not install %s (%s); %s is "
                                     "unchanged." % (tool.label(version), reason, tool.label(old_version)))
            raise HarnessRefusal("HARNESS_SWAP_BACK_FAILED", "The installer helper failed (%s) and the previous %s could not "
                                 "be put back." % (reason, tool.label(old_version)))
        swap["state"] = "swapped"
        run.save()
        current.detail = "%s is now at %s; %s is kept for swap-back." % (tool.label(version), tool.link, old_version)
    return vendor_finish_swap(tool, run, swap, evidence, phase, now)


def vendor_install(tool, run, step=None, now=utc_now, stop=None):
    """install grok-build / antigravity: the program is missing. The installer helper's converge installs the pinned
    program from nothing (it creates only that program: installer/grok-build-runtime.sh, antigravity-runtime.sh);
    then the same checks and record as an update. The regular file at the launcher right after this run's helper
    ran is recorded by identity ("placed"; the path was empty under the run lock), and a failure removes that file
    and nothing else. The gateway is never touched."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": "recommended", "from": None}
    with phase("installed", "Checking that it is not installed") as current:
        version = harness_install_check(tool)
        if version != tool.spec["pinnedVersion"]:
            raise HarnessRefusal("POLICY_INVALID", "The tool policy recommends a %s version other than the %s this Portal's "
                                 "installer pins; nothing was changed." % (tool.label(), tool.spec["pinnedVersion"]))
        evidence["to"] = version
        current.detail = "%s is not installed; %s will be installed." % (tool.label(), version)
    with phase("resolve", "Finding the Portal-tested release") as current:
        helper = vendor_helper(tool)
        pinned_sha = tool.spec["pinnedSha256"].get(tool.machine)
        expected = qualified_integrity(tool, version)
        if pinned_sha is not None and expected is not None and expected.startswith("sha256:"):
            proven_digest_match(tool, version, "sha256:" + pinned_sha, "the program")
        current.detail = "%s with the digest the Portal pinned, installed by %s." % (tool.label(version), helper)
    if stop:
        raise NpmStopped()
    swap = {"kind": "vendor-file", "install": True, "link": tool.link, "backup": None, "fromSha256": None,
            "fence": npm_fence_path(tool.roots, tool.tool_id), "from": None, "to": version, "helper": helper,
            "state": "fencing"}
    with phase("swap", "Installing the Portal-tested version") as current:
        ensure_private_dir(os.path.dirname(swap["fence"]))
        run.status["swap"] = swap
        run.save()
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        swap["state"] = "installing"
        run.save()
        code, reason = vendor_run_helper(tool, helper, evidence)
        swap["placed"] = vendor_placed_identity(tool.link)
        run.save()
        if code != 0 or swap["placed"] is None:
            reason = reason or "it placed no program file at %s" % tool.link
            outcome = vendor_install_remove(swap)
            swap["state"] = "remove-failed" if outcome == "kept" else outcome
            run.save()
            _remove_fence(swap)
            if outcome != "kept":
                raise HarnessRefusal("HARNESS_HELPER_FAILED", "The installer helper could not install %s (%s); %s is "
                                     "still not installed." % (tool.label(version), reason, tool.label()))
            raise HarnessRefusal("INSTALL_REMOVE_FAILED", "The installer helper could not install %s (%s), and %s is not "
                                 "a program it could remove again. %s" % (tool.label(version), reason, tool.link,
                                                                          recheck_recovery_advice(tool.label())))
        swap["state"] = "swapped"
        run.save()
        current.detail = "%s is now at %s." % (tool.label(version), tool.link)
    return vendor_finish_swap(tool, run, swap, evidence, phase, now)


def vendor_run_helper(tool, helper, evidence):
    """The installer helper's converge (it downloads, checks the pinned digest and version, and places the program
    with one rename). Returns (exit code, plain reason)."""
    env = {"PATH": CLEAN_PATH, "LANG": "C.UTF-8", "HOME": "/root", tool.spec["helperBinDirEnv"]: os.path.dirname(tool.link)}
    try:
        code, out, err = tool.runner(["/bin/bash", helper, "converge"], tool.work, env, VENDOR_HELPER_TIMEOUT,
                                     CLI_PROBE_OUTPUT_LIMIT, os.path.join(tool.work, "helper.out"))
    except subprocess.TimeoutExpired:
        code, out, err = None, "", "did not finish within %d s" % VENDOR_HELPER_TIMEOUT
    evidence["helper"] = {"argv": ["/bin/bash", helper, "converge"], "exitCode": code,
                          "stdout": tail_text(redact_text(out), 800), "stderr": tail_text(redact_text(err), 400)}
    return code, (tail_text((err or out).strip(), 200) or "exit %s" % code) if code != 0 else None


def vendor_placed_identity(link):
    """lstat identity [device, inode, size, mtime ns] of the regular file at the launcher; None for nothing there, a
    link or anything else."""
    try:
        info = os.lstat(link)
    except FileNotFoundError:
        return None
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns] if stat.S_ISREG(info.st_mode) else None


def vendor_install_remove(swap):
    """Remove the program this install's helper placed: only the regular file whose identity was recorded right after
    the helper ran (swap "placed"). Returns "removed", "unchanged" (nothing was placed and nothing is there) or "kept"
    (what is there is not provably this run's: a link, a directory, another file, or an identity never recorded)."""
    link, placed = swap["link"], swap.get("placed")
    if not os.path.lexists(link):
        return "removed" if placed else "unchanged"
    if not placed or vendor_placed_identity(link) != placed:
        return "kept"
    os.unlink(link)
    fsync_dir(os.path.dirname(link))
    return "kept" if os.path.lexists(link) else "removed"


def vendor_finish_swap(tool, run, swap, evidence, phase, now):
    """probe-installed -> commit -> cleanup, or put the previous program back."""
    version = swap["to"]
    try:
        with phase("probe-installed", "Checking the installed new version") as current:
            harness_publish_placed(tool)
            installed = vendor_installed(tool)
            if installed["version"] != version:
                raise HarnessRefusal("HARNESS_TREE_CHANGED", "the installed program reports %s, not %s" % (
                    installed["version"], version))
            source = vendor_source(tool, installed, updated=True)
            probes, failed = harness_probe_set(tool, tool.link, version)
            evidence.setdefault("probes", []).extend(dict(probe, target="installed") for probe in probes)
            if failed:
                raise HarnessRefusal("CLI_PROBE_FAILED", "%s: %s" % (failed["id"], failed["reason"]), {"probe": failed})
            current.detail = _probe_summary(probes) + " (installed)"
        with phase("commit", "Recording the admission") as current:
            record = build_harness_record(tool, installed, source, probes, "run:%s" % run.run_id, now())
            swap["state"] = "committing"
            run.save()
            evidence["recordPath"] = write_harness_record(tool.roots, record)
            swap["state"] = "committed"
            run.save()
            current.detail = "Admitted %s." % tool.label(version)
    except HarnessRefusal as refusal:
        if swap.get("install"):
            swap["state"] = "removing"
            run.save()
            outcome = vendor_install_remove(swap)
            swap["state"] = "remove-failed" if outcome == "kept" else outcome
            run.save()
            _remove_fence(swap)
            raise install_removed_refusal(tool, version, refusal, outcome != "kept")
        swap["state"] = "swapping-back"
        run.save()
        restored = vendor_swap_back(swap)
        swap["state"] = "swapped-back" if restored else "swap-back-failed"
        run.save()
        _remove_fence(swap)
        if restored and refusal.code == "HARNESS_PROVEN_DIGEST_MISMATCH":
            raise HarnessRefusal(refusal.code, "%s does not match the program the Portal qualified for this server; %s was "
                                 "put back, so nothing was changed." % (tool.label(version), swap["from"]), refusal.detail)
        raise HarnessRefusal("HARNESS_SWAPPED_BACK" if restored else "HARNESS_SWAP_BACK_FAILED",
                             ("%s failed its check after the switch (%s); %s was put back." % (
                                 tool.label(version), refusal.message, swap["from"])) if restored else
                             ("%s failed its check after the switch (%s) and the previous version could not be put back."
                              % (tool.label(version), refusal.message)),
                             {"probe": (refusal.detail or {}).get("probe")})
    _remove_fence(swap)
    with phase("cleanup", "Cleaning up") as current:
        if swap["backup"] and path_present(swap["backup"]):
            os.unlink(swap["backup"])
        current.detail = "Done."
    return record, evidence


def _harness_committed(roots, run, swap):
    """Committed, or interrupted while committing after this run's record was written."""
    if swap.get("state") == "committed":
        return True
    if swap.get("state") != "committing":
        return False
    try:
        with open(os.path.join(npm_admission_dir(roots), run.status.get("tool") + ".json")) as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        return False
    return isinstance(record, dict) and record.get("admittedBy") == "run:%s" % run.run_id


def vendor_reconcile_run(roots, run, swap):
    """d.1 crash rules for a vendor-file switch, decided by re-reading the launcher."""
    if swap.get("install"):
        return vendor_reconcile_install(roots, run, swap)
    if _harness_committed(roots, run, swap):
        if path_present(swap["backup"]):
            os.unlink(swap["backup"])
        _remove_fence(swap)
        run.finish("succeeded", result={"action": "update", "from": swap["from"], "to": swap["to"],
                                        "reconciled": "committed before the interruption"})
        return
    unchanged = path_present(swap["backup"]) and path_present(swap["link"]) and os.path.samefile(swap["backup"], swap["link"])
    restored = vendor_swap_back(swap)
    _remove_fence(swap)
    if unchanged or (restored and swap.get("state") in ("fencing", "unchanged")):
        run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE",
                                    "message": "The update was interrupted before it switched versions. Nothing was changed. Try again."})
    elif restored:
        run.finish("rolled-back", error={"id": "HARNESS_SWAPPED_BACK", "message": "The update was interrupted after the "
                                         "switch and could not be checked; the previous version was put back."})
    else:
        run.finish("recovery-required", error={"id": "HARNESS_LAUNCHER_UNKNOWN", "message": "The %s update was interrupted "
                                               "and %s is neither version. %s" % (
                                                   run.status.get("tool"), swap["link"],
                                                   recheck_recovery_advice(policy_label(roots, run.status.get("tool"))))})


def vendor_reconcile_install(roots, run, swap):
    """An interrupted Grok Build or Antigravity install: committed, or the program this run's helper placed is
    removed again (by its recorded identity; interrupted before that was recorded, it is kept for a Re-check)."""
    label = policy_label(roots, run.status.get("tool"))
    result = {"action": "install", "from": None, "to": swap.get("to")}
    _remove_fence(swap)
    if _harness_committed(roots, run, swap):
        run.finish("succeeded", result=dict(result, reconciled="committed before the interruption"))
    elif not os.path.lexists(swap["link"]):
        run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE", "message": "The %s installation was "
                                    "interrupted before it installed anything. Try again." % label})
    elif vendor_install_remove(swap) == "removed":
        run.finish("rolled-back", error={"id": "INSTALL_REMOVED", "message": "The %s installation was interrupted and "
                                         "could not be checked; the program it placed was removed again, so nothing is "
                                         "installed. Try again." % label})
    else:
        run.finish("recovery-required", error={"id": "INSTALL_REMOVE_FAILED", "message": "The %s installation was "
                                               "interrupted, and %s is not a program it could remove again. %s" % (
                                                   label, swap["link"], recheck_recovery_advice(label))})


# -- Ollama: install.sh's sealed transaction through its toolctl entry (restarts ollama.service only) --

# A whole release archive is about 1.5 GB; the installer downloads and checks it.
OLLAMA_INSTALL_TIMEOUT = 3600
OLLAMA_SETTLE_ATTEMPTS = 3
OLLAMA_SETTLE_DELAY = 2


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def loopback_get(url, max_bytes, timeout=10):
    """GET the local Ollama API: loopback HTTP only, no proxy, no redirect, bounded."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
        raise ValueError("%s is not a loopback URL" % url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirects())
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "bridgesllm-toolctl"}), timeout=timeout) as response:
        body = response.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise ValueError("the answer is larger than toolctl reads")
    return body


def _ollama_json(tool, path):
    try:
        doc = json.loads(tool.local_get(tool.spec["api"] + path, HARNESS_METADATA_LIMIT).decode("utf-8"))
    except Exception:  # any transport or parse failure is "did not answer"
        return None
    return doc if isinstance(doc, dict) else None


def ollama_server_check(tool, version):
    """install.sh verify_ollama_client_server_parity, read-only: the service is
    active and /api/version answers the client's version; /api/tags lists the
    models (read only, never touched)."""
    problem = None
    for attempt in range(OLLAMA_SETTLE_ATTEMPTS):
        if attempt:
            time.sleep(OLLAMA_SETTLE_DELAY)
        try:
            code, _out, _err = tool.runner([tool.roots.systemctl_bin, "is-active", "--quiet", tool.spec["service"]], "/",
                                           {"PATH": CLEAN_PATH}, 30, 4096, os.path.join(tool.work, "systemctl.out"))
        except subprocess.TimeoutExpired:
            code = None
        server = _ollama_json(tool, "/api/version") if code == 0 else None
        tags = _ollama_json(tool, "/api/tags") if server is not None and server.get("version") == version else None
        if code != 0:
            problem = "%s.service is not running" % tool.spec["service"]
        elif server is None:
            problem = "the server does not answer /api/version"
        elif server.get("version") != version:
            problem = "the server reports %s while the client is %s" % (tail_text(str(server.get("version")), 40), version)
        elif tags is None or not isinstance(tags.get("models"), list):
            problem = "the server does not list its models"
        else:
            return {"service": "active", "serverVersion": version, "models": len(tags["models"])}
    raise HarnessRefusal("OLLAMA_PARITY_FAILED", "Ollama %s failed its client/server check: %s." % (version, problem),
                         {"problem": problem})


def ollama_release(tool, version):
    """The official release for this server and the digest GitHub records for
    it (refused without one); a qualified newestProven must match it."""
    release = github_release_asset(tool, version)
    return release, proven_digest_match(tool, version, "sha256:" + release["sha256"])


def ollama_source(release, proven_match, installed):
    """`bytesVerified` only when the Portal installer downloaded and checked
    the archive itself; a re-check reads GitHub's record, not the bytes."""
    return {"kind": "github-release", "origin": release["url"], "archiveSha256": release["sha256"],
            "authority": "github-asset-digest", "bytesVerified": installed, "provenDigestMatch": proven_match}


def ollama_requalify(tool, run_id, step=None, now=utc_now):
    """requalify ollama: installs and restarts nothing; writes the record when
    the client, the running server and the official release agree."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run_id}
    with phase("installed", "Reading the installed version") as current:
        installed = vendor_installed(tool)
        version = installed["version"]
        evidence["installedVersion"] = tool.installed_version = version
        refusal = harness_version_refusal(tool, version)
        if refusal:
            raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + "; update it instead.")
        current.detail = "%s is installed." % tool.label(version)
    with phase("resolve", "Finding the official release") as current:
        release, proven_match = ollama_release(tool, version)
        current.detail = "%s (GitHub records its digest)." % release["url"]
    with phase("probe", "Checking the client and the running server") as current:
        probes, failed = harness_probe_set(tool, tool.link, version)
        evidence["probes"] = probes
        if failed:
            raise HarnessRefusal("CLI_PROBE_FAILED", "%s failed its %s check: %s." % (tool.label(version), failed["id"],
                                                                                    failed["reason"]), {"probe": failed})
        evidence["server"] = ollama_server_check(tool, version)
        current.detail = "%s; the server agrees and lists %d models." % (_probe_summary(probes), evidence["server"]["models"])
    with phase("commit", "Recording the admission") as current:
        if sha256_file(tool.link) != installed["sha256"]:
            raise HarnessRefusal("HARNESS_TREE_CHANGED", "The installed %s changed while it was being checked; nothing was "
                                 "admitted." % tool.label(version))
        record = build_harness_record(tool, installed, ollama_source(release, proven_match, False), probes,
                                      "requalify:%s" % run_id, now())
        evidence["recordPath"] = write_harness_record(tool.roots, record)
        current.detail = "Admitted %s (re-checked)." % tool.label(version)
    return record, evidence


def ollama_run_installer(tool, installer, release, evidence, label):
    """install.sh --toolctl-ollama-update <version> <sha256> <size>: only
    install_or_update_ollama (its own transaction, cutover and rollback)."""
    argv = ["/bin/bash", installer] + list(tool.spec["installerArgs"]) + [
        release["version"], release["sha256"], str(release["size"])]
    try:
        code, out, err = tool.runner(argv, tool.work, {"PATH": CLEAN_PATH, "LANG": "C.UTF-8", "HOME": "/root", "TERM": "dumb"},
                                     OLLAMA_INSTALL_TIMEOUT, HARNESS_METADATA_LIMIT, os.path.join(tool.work, "installer-%s.out" % label))
    except subprocess.TimeoutExpired:
        code, out, err = None, "", "did not finish within %d s" % OLLAMA_INSTALL_TIMEOUT
    evidence.setdefault("installer", []).append({"argv": argv, "exitCode": code, "stdout": tail_text(redact_text(out), 800),
                                                 "stderr": tail_text(redact_text(err), 400)})
    return code, tail_text((err or out).strip(), 200) or "exit %s" % code


def ollama_swap_back(tool, swap, evidence):
    """Reinstall the previous official release through the same entry; True
    when it runs again with client/server parity."""
    try:
        previous, _match = ollama_release(tool, swap["from"])
        code, reason = ollama_run_installer(tool, swap["installer"], previous, evidence, "swap-back")
        if code != 0:
            raise HarnessRefusal("HARNESS_HELPER_FAILED", reason)
        if vendor_installed(tool)["version"] != swap["from"]:
            raise HarnessRefusal("HARNESS_TREE_CHANGED", "the previous version is not installed")
        ollama_server_check(tool, swap["from"])
    except NpmRefusal as refusal:
        evidence["swapBack"] = {"error": refusal.code, "message": refusal.message}
        return False
    return True


def ollama_update(tool, run, target, step=None, now=utc_now, stop=None):
    """update ollama: the Portal installer installs the verified release in
    its sealed transaction (ollama.service restarts; models are kept); then the
    client and server are checked and the record committed, or the previous
    release is installed again. The gateway is never touched."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": target}
    with phase("installed", "Reading the installed version") as current:
        installed = vendor_installed(tool)
        old_version = installed["version"]
        version = harness_resolve_target(tool, target, old_version)
        evidence.update({"from": old_version, "to": version})
        current.detail = "%s is installed; %s is the target." % (tool.label(old_version), version)
    with phase("resolve", "Finding the official release") as current:
        release, proven_match = ollama_release(tool, version)
        zstd = harness_path(tool.roots, "zstd_bin")
        if not (os.path.isfile(zstd) and os.access(zstd, os.X_OK)):
            raise HarnessRefusal("HARNESS_ZSTD_MISSING", "zstd is not installed, so the Ollama release archive (.tar.zst) "
                                 "cannot be unpacked. Install the zstd package, then try again; nothing was changed.")
        installer = vendor_helper(tool, tool.spec["installer"])
        current.detail = "%s (%d bytes, GitHub records its digest)." % (release["url"], release["size"])
    if stop:
        raise NpmStopped()
    swap = {"kind": "ollama-installer", "link": tool.link, "fromSha256": installed["sha256"],
            "fence": npm_fence_path(tool.roots, tool.tool_id), "from": old_version, "to": version, "installer": installer,
            "state": "fencing"}
    with phase("swap", "Installing the new version (Ollama restarts; models are kept)") as current:
        ensure_private_dir(os.path.dirname(swap["fence"]))
        run.status["swap"] = swap
        run.save()
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        swap["state"] = "installing"
        run.save()
        code, reason = ollama_run_installer(tool, installer, release, evidence, "update")
        if code != 0:
            unchanged = os.path.isfile(tool.link) and sha256_file(tool.link) == swap["fromSha256"]
            swap["state"] = "unchanged" if unchanged else "swap-back-failed"
            run.save()
            _remove_fence(swap)
            if unchanged:
                raise HarnessRefusal("HARNESS_HELPER_FAILED", "The Portal installer could not install %s (%s); %s is "
                                     "unchanged." % (tool.label(version), reason, tool.label(old_version)))
            raise HarnessRefusal("HARNESS_SWAP_BACK_FAILED", "The Portal installer could not install %s (%s) and the previous "
                                 "version is not back. %s" % (tool.label(version), reason, recheck_recovery_advice(tool.label())))
        swap["state"] = "swapped"
        run.save()
        current.detail = "The Portal installer installed %s and restarted ollama.service." % tool.label(version)
    try:
        with phase("probe-installed", "Checking the client and the running server") as current:
            harness_publish_placed(tool)
            now_installed = vendor_installed(tool)
            if now_installed["version"] != version:
                raise HarnessRefusal("HARNESS_TREE_CHANGED", "the installed client reports %s, not %s" % (
                    now_installed["version"], version))
            probes, failed = harness_probe_set(tool, tool.link, version)
            evidence["probes"] = [dict(probe, target="installed") for probe in probes]
            if failed:
                raise HarnessRefusal("CLI_PROBE_FAILED", "%s: %s" % (failed["id"], failed["reason"]), {"probe": failed})
            evidence["server"] = ollama_server_check(tool, version)
            current.detail = "%s; the server agrees and lists %d models." % (_probe_summary(probes), evidence["server"]["models"])
        with phase("commit", "Recording the admission") as current:
            record = build_harness_record(tool, now_installed, ollama_source(release, proven_match, True), probes,
                                          "run:%s" % run.run_id, now())
            swap["state"] = "committing"
            run.save()
            evidence["recordPath"] = write_harness_record(tool.roots, record)
            swap["state"] = "committed"
            run.save()
            current.detail = "Admitted %s." % tool.label(version)
    except HarnessRefusal as refusal:
        swap["state"] = "swapping-back"
        run.save()
        restored = ollama_swap_back(tool, swap, evidence)
        swap["state"] = "swapped-back" if restored else "swap-back-failed"
        run.save()
        _remove_fence(swap)
        raise HarnessRefusal("HARNESS_SWAPPED_BACK" if restored else "HARNESS_SWAP_BACK_FAILED",
                             ("%s failed its check after the switch (%s); %s was installed again." % (
                                 tool.label(version), refusal.message, swap["from"])) if restored else
                             ("%s failed its check after the switch (%s) and %s could not be installed again. %s" % (
                                 tool.label(version), refusal.message, swap["from"], recheck_recovery_advice(tool.label()))),
                             {"probe": (refusal.detail or {}).get("probe"), "swapBack": evidence.get("swapBack")})
    _remove_fence(swap)
    with phase("cleanup", "Cleaning up") as current:
        current.detail = "Done; the installer removed its own rollback files after its commit."
    return record, evidence


def ollama_install(tool, run, step=None, now=utc_now, stop=None):
    """install ollama: Ollama is missing. The installer's own fresh-install
    function, install_or_update_ollama (through the same entry an update uses),
    installs the qualified recommended release: the program, its library,
    ollama.service and its service account, enabled and started, with its own
    sealed transaction (it removes what it added when it fails). Then the client
    and server are checked and the record committed. After the installer has
    committed, nothing here can remove Ollama again, so a failed check ends
    needing recovery (Re-check). The gateway is never touched."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": "recommended", "from": None}
    with phase("installed", "Checking that it is not installed") as current:
        if os.path.lexists(tool.link):
            raise HarnessRefusal("INSTALL_TOOL_PRESENT", "%s is already installed on this server (%s exists). Use Update or "
                                 "Re-check on its card instead; nothing was changed." % (tool.label(), tool.link))
        version = install_version(tool, lambda v: harness_version_refusal(tool, v))
        evidence["to"] = version
        current.detail = "%s is not installed; %s will be installed." % (tool.label(), version)
    with phase("resolve", "Finding the official release") as current:
        release, proven_match = ollama_release(tool, version)
        zstd = harness_path(tool.roots, "zstd_bin")
        if not (os.path.isfile(zstd) and os.access(zstd, os.X_OK)):
            raise HarnessRefusal("HARNESS_ZSTD_MISSING", "zstd is not installed, so the Ollama release archive (.tar.zst) "
                                 "cannot be unpacked. Install the zstd package, then try again; nothing was changed.")
        installer = vendor_helper(tool, tool.spec["installer"])
        current.detail = "%s (%d bytes, GitHub records its digest)." % (release["url"], release["size"])
    if stop:
        raise NpmStopped()
    swap = {"kind": "ollama-installer", "install": True, "link": tool.link, "fromSha256": None,
            "fence": npm_fence_path(tool.roots, tool.tool_id), "from": None, "to": version, "installer": installer,
            "state": "fencing"}
    with phase("swap", "Installing Ollama (its service starts)") as current:
        ensure_private_dir(os.path.dirname(swap["fence"]))
        run.status["swap"] = swap
        run.save()
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        swap["state"] = "installing"
        run.save()
        code, reason = ollama_run_installer(tool, installer, release, evidence, "install")
        if code != 0:
            absent = not os.path.lexists(tool.link)
            swap["state"] = "unchanged" if absent else "remove-failed"
            run.save()
            _remove_fence(swap)
            if absent:
                raise HarnessRefusal("HARNESS_HELPER_FAILED", "The Portal installer could not install %s (%s); Ollama is "
                                     "still not installed." % (tool.label(version), reason))
            raise HarnessRefusal("INSTALL_REMOVE_FAILED", "The Portal installer could not install %s (%s), and %s is "
                                 "present now. %s" % (tool.label(version), reason, tool.link,
                                                      recheck_recovery_advice(tool.label())))
        swap["state"] = "swapped"
        run.save()
        current.detail = "The Portal installer installed %s and started ollama.service." % tool.label(version)
    try:
        with phase("probe-installed", "Checking the client and the running server") as current:
            harness_publish_placed(tool)
            now_installed = vendor_installed(tool)
            if now_installed["version"] != version:
                raise HarnessRefusal("HARNESS_TREE_CHANGED", "the installed client reports %s, not %s" % (
                    now_installed["version"], version))
            probes, failed = harness_probe_set(tool, tool.link, version)
            evidence["probes"] = [dict(probe, target="installed") for probe in probes]
            if failed:
                raise HarnessRefusal("CLI_PROBE_FAILED", "%s: %s" % (failed["id"], failed["reason"]), {"probe": failed})
            evidence["server"] = ollama_server_check(tool, version)
            current.detail = "%s; the server agrees and lists %d models." % (_probe_summary(probes), evidence["server"]["models"])
        with phase("commit", "Recording the admission") as current:
            record = build_harness_record(tool, now_installed, ollama_source(release, proven_match, True), probes,
                                          "run:%s" % run.run_id, now())
            swap["state"] = "committing"
            run.save()
            evidence["recordPath"] = write_harness_record(tool.roots, record)
            swap["state"] = "committed"
            run.save()
            current.detail = "Admitted %s." % tool.label(version)
    except HarnessRefusal as refusal:
        swap["state"] = "remove-failed"
        run.save()
        _remove_fence(swap)
        raise HarnessRefusal("INSTALL_REMOVE_FAILED", "%s was installed but failed its check (%s); Maintenance cannot "
                             "remove it again. %s" % (tool.label(version), refusal.message,
                                                      recheck_recovery_advice(tool.label())),
                             {"probe": (refusal.detail or {}).get("probe")})
    _remove_fence(swap)
    return record, evidence


def ollama_reconcile_run(roots, run, swap):
    """d.1 crash rules for an Ollama installer run; Ollama's own sealed journal
    is settled by its next installer run (recover_pending_ollama_transaction)."""
    _remove_fence(swap)
    if swap.get("install"):
        ollama_reconcile_install(roots, run, swap)
    elif _harness_committed(roots, run, swap):
        run.finish("succeeded", result={"action": "update", "from": swap["from"], "to": swap["to"],
                                        "reconciled": "committed before the interruption"})
    elif os.path.isfile(swap["link"]) and sha256_file(swap["link"]) == swap["fromSha256"]:
        run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE", "message": "The Ollama update was "
                                    "interrupted before it changed the installed version. Try again."})
    else:
        run.finish("recovery-required", error={"id": "HARNESS_LAUNCHER_UNKNOWN", "message": "The Ollama update was "
                                               "interrupted after the installer changed it, and it was not checked. %s"
                                               % recheck_recovery_advice(policy_label(roots, run.status.get("tool")))})


def ollama_reconcile_install(roots, run, swap):
    """An interrupted Ollama install: committed, or nothing installed (the
    installer's journal, if any, is settled by the next installer run), or an
    installed Ollama nobody checked."""
    result = {"action": "install", "from": None, "to": swap.get("to")}
    if _harness_committed(roots, run, swap):
        run.finish("succeeded", result=dict(result, reconciled="committed before the interruption"))
    elif not os.path.lexists(swap["link"]):
        run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE", "message": "The Ollama installation was "
                                    "interrupted before Ollama was installed. Try again."})
    else:
        run.finish("recovery-required", error={"id": "INSTALL_REMOVE_FAILED", "message": "The Ollama installation was "
                                               "interrupted after the installer added it, and it was not checked. %s"
                                               % recheck_recovery_advice(policy_label(roots, run.status.get("tool")))})


# -- Agent Zero: the managed container through its helper (status, reconcile, rollback) --

# reconcile pulls the pinned image (several GB) and waits for readiness.
AGENT_ZERO_RECONCILE_TIMEOUT = 3600
AGENT_ZERO_STATUS_TIMEOUT = 300
_A0_READY_RE = re.compile(r"^Agent Zero ((?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){1,2}) runtime protocol-ready on ",
                          re.MULTILINE)


def agent_zero_configured(tool):
    path = harness_path(tool.roots, "agent_zero_env")
    if not os.path.isfile(path) or os.path.islink(path):
        raise HarnessRefusal("AGENT_ZERO_NOT_CONFIGURED", "Agent Zero is not configured on this server (%s is missing); "
                             "nothing was changed." % path)
    return path


def _helper_blocker(text):
    """The helper's own reason (its last `[Agent Zero] ERROR: …` line), word for word."""
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    errors = [line.split("ERROR:", 1)[1].strip() for line in lines if "ERROR:" in line]
    return tail_text(redact_text(errors[-1] if errors else (lines[-1] if lines else "no reason given")), 300)


def agent_zero_helper(tool, command, evidence, timeout):
    helper = vendor_helper(tool)
    argv = ["/bin/bash", helper, command]
    env = {"PATH": CLEAN_PATH, "LANG": "C.UTF-8", "HOME": "/root", "AGENT_ZERO_AUTH_FILE": agent_zero_configured(tool)}
    try:
        code, out, err = tool.runner(argv, tool.work, env, timeout, HARNESS_METADATA_LIMIT,
                                     os.path.join(tool.work, "helper-%s-%d.out" % (command, len(evidence.get("helper", [])))))
    except subprocess.TimeoutExpired:
        code, out, err = None, "", "ERROR: did not finish within %d s" % timeout
    evidence.setdefault("helper", []).append({"argv": argv, "exitCode": code, "stdout": tail_text(redact_text(out), 800),
                                              "stderr": tail_text(redact_text(err), 800)})
    return code, out, err


def agent_zero_status(tool, evidence):
    """helper `status`: the pinned container contract, the connector protocol
    on its loopback port (the health check) and the host bridge. A named
    blocker (an orphan volume, a contract violation) is reported as itself."""
    code, out, err = agent_zero_helper(tool, "status", evidence, AGENT_ZERO_STATUS_TIMEOUT)
    match = _A0_READY_RE.search(out)
    if code != 0 or not match:
        blocker = _helper_blocker(err or out)
        raise HarnessRefusal("AGENT_ZERO_BLOCKED", "Agent Zero is not ready: %s" % blocker, {"blocker": blocker})
    return match.group(1)


def agent_zero_proven_match(tool, version):
    """The image this machine runs (the helper pulls, and its status checks,
    exactly the digest it pins for this architecture) against this machine's
    entry in the qualified digests; no entry means this machine was not
    qualified (null, never refused)."""
    return proven_digest_match(tool, version, tool.spec["pinnedDigests"].get(tool.machine), "the image")


def agent_zero_record(tool, version, admitted_by, admitted_at, proven_match=None):
    image = "%s@%s" % (tool.spec["image"], tool.spec["pinnedDigests"].get(tool.machine))
    record = build_harness_record(tool, {"version": version, "binary": None, "sha256": None}, {
        "kind": "container-image", "origin": image, "authority": "portal-pinned-digest", "bytesVerified": True,
        "provenDigestMatch": proven_match}, [{"id": "A0-STATUS", "state": "passed"}], admitted_by, admitted_at)
    record["executables"] = {}
    record["container"] = {"name": tool.spec["container"], "image": image}
    return record


def agent_zero_requalify(tool, run_id, step=None, now=utc_now):
    """requalify agent-zero: changes nothing; the helper's status names the version."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run_id}
    with phase("installed", "Checking that Agent Zero is configured") as current:
        agent_zero_configured(tool)
        current.detail = "Agent Zero is configured."
    with phase("probe", "Checking the running Agent Zero") as current:
        version = tool.installed_version = agent_zero_status(tool, evidence)
        refusal = harness_version_refusal(tool, version)
        if refusal:
            raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + "; update it instead.")
        if version != tool.spec["pinnedVersion"]:
            raise HarnessRefusal("HARNESS_BINARY_DIFFERS", "Agent Zero %s is running, but this Portal manages only %s."
                                 % (version, tool.spec["pinnedVersion"]))
        proven_match = agent_zero_proven_match(tool, version)
        current.detail = "Agent Zero %s is ready on its loopback port." % version
    with phase("commit", "Recording the admission") as current:
        record = agent_zero_record(tool, version, "requalify:%s" % run_id, now(), proven_match)
        evidence["recordPath"] = write_harness_record(tool.roots, record)
        current.detail = "Admitted Agent Zero %s (re-checked)." % version
    return record, evidence


def agent_zero_update(tool, run, target, step=None, now=utc_now, stop=None):
    """update agent-zero to the Portal-pinned image through the helper's
    `reconcile` (it snapshots the data volume and restores on failure); a
    failed check afterwards runs the helper's `rollback`."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": target}
    pinned = tool.spec["pinnedVersion"]
    with phase("installed", "Reading the installed version") as current:
        agent_zero_configured(tool)
        old_version = agent_zero_status(tool, evidence)
        if target not in ("recommended", "newestProven"):
            raise HarnessRefusal("HARNESS_SOURCE_UNVERIFIABLE", "This Portal installs only the Agent Zero image it pins (%s); "
                                 "nothing was changed." % pinned)
        if (tool.policy.get("newestProven") or {}).get("version") != pinned:
            raise HarnessRefusal("POLICY_INVALID", "The tool policy recommends an Agent Zero version other than the %s this "
                                 "Portal pins; nothing was changed." % pinned)
        refusal = harness_version_refusal(tool, pinned)
        if refusal:
            raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + ".")
        order = compare_versions(pinned, old_version)
        if order == 0:
            raise HarnessRefusal("HARNESS_ALREADY_CURRENT", "Agent Zero %s is already installed. Nothing to update." % pinned)
        if order < 0:
            raise HarnessRefusal("HARNESS_DOWNGRADE_REFUSED", "Agent Zero %s is older than the installed %s; the Portal does "
                                 "not downgrade tools." % (pinned, old_version))
        proven_match = agent_zero_proven_match(tool, pinned)
        evidence.update({"from": old_version, "to": pinned})
        current.detail = "Agent Zero %s is installed; %s is the target." % (old_version, pinned)
    if stop:
        raise NpmStopped()
    swap = {"kind": "agent-zero-helper", "fence": npm_fence_path(tool.roots, tool.tool_id), "from": old_version, "to": pinned,
            "state": "fencing"}
    with phase("swap", "Replacing the container (its data volume is snapshotted first)") as current:
        ensure_private_dir(os.path.dirname(swap["fence"]))
        run.status["swap"] = swap
        run.save()
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        swap["state"] = "installing"
        run.save()
        code, out, err = agent_zero_helper(tool, "reconcile", evidence, AGENT_ZERO_RECONCILE_TIMEOUT)
        if code != 0:
            blocker = _helper_blocker(err or out)
            # The helper may have replaced the container before it failed; its status says what runs now. Its
            # `rollback` is not run: it restores the latest recorded snapshot, which may be an earlier update's.
            try:
                running, problem = agent_zero_status(tool, evidence), None
            except NpmRefusal as refusal:
                running, problem = None, (refusal.detail or {}).get("blocker") or refusal.message
            if running == old_version:
                swap["state"] = "unchanged"
                run.save()
                _remove_fence(swap)
                raise HarnessRefusal("AGENT_ZERO_BLOCKED", "Agent Zero was not updated: %s" % blocker, {"blocker": blocker})
            swap.update(state="swap-back-failed", running=running)
            run.save()
            _remove_fence(swap)
            raise HarnessRefusal("HARNESS_SWAP_BACK_FAILED", "The Agent Zero helper failed (%s), and Agent Zero %s. %s" % (
                                     blocker.rstrip("."), "now reports %s, not %s" % (running, old_version) if running else
                                     "cannot be read (%s)" % problem.rstrip("."), recheck_recovery_advice(tool.label())),
                                 {"blocker": blocker, "running": running, "statusProblem": problem})
        swap["state"] = "swapped"
        run.save()
        current.detail = "The helper replaced the container and kept the previous one and a data snapshot for rollback."
    try:
        with phase("probe-installed", "Checking the new Agent Zero") as current:
            version = agent_zero_status(tool, evidence)
            if version != pinned:
                raise HarnessRefusal("HARNESS_TREE_CHANGED", "Agent Zero reports %s, not %s" % (version, pinned))
            current.detail = "Agent Zero %s is ready on its loopback port." % version
        with phase("commit", "Recording the admission") as current:
            record = agent_zero_record(tool, pinned, "run:%s" % run.run_id, now(), proven_match)
            swap["state"] = "committing"
            run.save()
            evidence["recordPath"] = write_harness_record(tool.roots, record)
            swap["state"] = "committed"
            run.save()
            current.detail = "Admitted Agent Zero %s." % pinned
    except HarnessRefusal as refusal:
        swap["state"] = "swapping-back"
        run.save()
        code, out, err = agent_zero_helper(tool, "rollback", evidence, AGENT_ZERO_RECONCILE_TIMEOUT)
        restored = code == 0
        swap["state"] = "swapped-back" if restored else "swap-back-failed"
        run.save()
        _remove_fence(swap)
        raise HarnessRefusal("HARNESS_SWAPPED_BACK" if restored else "HARNESS_SWAP_BACK_FAILED",
                             ("Agent Zero %s failed its check after the switch (%s); the previous container and data were "
                              "restored." % (pinned, refusal.message)) if restored else
                             ("Agent Zero %s failed its check after the switch (%s) and the helper could not restore the "
                              "previous container: %s. Recovery is required." % (pinned, refusal.message,
                                                                                   _helper_blocker(err or out))))
    _remove_fence(swap)
    with phase("cleanup", "Cleaning up") as current:
        current.detail = "The helper keeps the previous container and data snapshot until its next update."
    return record, evidence


def agent_zero_reconcile_run(roots, run, swap):
    """An interrupted helper run: committed → succeeded; otherwise the helper's
    own state decides, which a re-check reads (the helper's status)."""
    _remove_fence(swap)
    if _harness_committed(roots, run, swap):
        run.finish("succeeded", result={"action": "update", "from": swap["from"], "to": swap["to"],
                                        "reconciled": "committed before the interruption"})
    elif swap.get("state") in ("fencing", "unchanged"):
        run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE", "message": "The Agent Zero update was "
                                    "interrupted before it changed anything. Try again."})
    else:
        run.finish("recovery-required", error={"id": "HARNESS_LAUNCHER_UNKNOWN", "message": "The Agent Zero update was "
                                               "interrupted while its container was being replaced. %s"
                                               % recheck_recovery_advice(policy_label(roots, run.status.get("tool")))})


# -- Hermes (layout "venv-generation"): no release assets, so the source is the
# commit GitHub's tag names, its tarball and the helper's canonical tree digest
# (d.2 step 6). The alias is <bin>/hermes -> <root>/<version>/.venv/bin/hermes.

HERMES_SOURCE_MAX_BYTES = 96 * MIB  # installer/hermes-runtime.sh HERMES_SOURCE_MAX_BYTES
HERMES_SOURCE_MAX_EXPANDED_BYTES = 512 * MIB  # … HERMES_SOURCE_MAX_EXPANDED_BYTES
HERMES_SOURCE_MAX_ENTRIES = 60000  # … HERMES_SOURCE_MAX_ENTRIES (v0.22.5 has 22,045; the reason is there)
_GIT_SHA_RE = re.compile(r"\A[0-9a-f]{40}\Z")
_HERMES_DATE_TAG_RE = re.compile(r"\Av20[0-9]{2}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12][0-9]|3[01])\Z")
_SHA256_HEX_RE = re.compile(r"\A[0-9a-f]{64}\Z")


def hermes_source_tree_sha256(archive):
    """installer/hermes-runtime.sh `hermes_source_tree_sha256`, byte for byte (a lockstep test runs both
    on one fixture): sha256 over each regular file's path below the single root, mode & 0777, size and
    bytes, in path order. Anything the helper refuses raises HARNESS_ARCHIVE_UNEXPECTED."""
    def refuse(reason):
        raise HarnessRefusal("HARNESS_ARCHIVE_UNEXPECTED", "The Hermes source archive was refused: %s; nothing was "
                             "installed." % reason)
    required = {"pyproject.toml", "uv.lock", "hermes", "acp_adapter"}
    roots, seen, files, expanded = set(), set(), [], 0
    try:
        with tarfile.open(archive, "r:gz") as tf:
            members = tf.getmembers()
            if not members or len(members) > HERMES_SOURCE_MAX_ENTRIES:
                refuse("its entry count is outside the allowed range")
            for member in members:
                name = member.name
                if not name or "\x00" in name or "\\" in name or name.startswith("/"):
                    refuse("it contains an unsafe path")
                normalized = os.path.normpath(name)
                parts = tuple(part for part in normalized.split("/") if part)
                if normalized in (".", "..") or ".." in parts or len(parts) < 1:
                    refuse("it contains path traversal")
                if not (member.isfile() or member.isdir()):
                    refuse("it contains a non-regular entry")
                roots.add(parts[0])
                if normalized in seen:
                    refuse("it contains a duplicate path")
                seen.add(normalized)
                if member.isfile():
                    expanded += member.size
                    if member.size < 0 or expanded > HERMES_SOURCE_MAX_EXPANDED_BYTES:
                        refuse("its expanded size is outside the allowed range")
                    if len(parts) > 1:
                        files.append(("/".join(parts[1:]), member))
                if len(parts) > 1:
                    required.discard("/".join(parts[1:]))
            if len(roots) != 1:
                refuse("it must contain exactly one root directory")
            if {"pyproject.toml", "uv.lock", "hermes"} & required:
                refuse("it is missing required runtime files")
            if not any(path.startswith("acp_adapter/") for path, _member in files):
                refuse("it is missing its ACP adapter")
            digest = hashlib.sha256()
            for relative, member in sorted(files, key=lambda row: row[0]):
                for part in (relative.encode("utf-8"), oct(member.mode & 0o777).encode("ascii"),
                             str(member.size).encode("ascii")):
                    digest.update(part)
                    digest.update(b"\0")
                source = tf.extractfile(member)
                if source is None:
                    refuse("it contains an unreadable regular file")
                for chunk in iter(lambda: source.read(1 << 20), b""):
                    digest.update(chunk)
                digest.update(b"\0")
            return digest.hexdigest()
    except HarnessRefusal:
        raise
    except Exception as error:  # tarfile, gzip and zlib errors alike: not a readable archive
        refuse("it is not a readable gzip tar archive (%s)" % tail_text(str(error), 120))


def hermes_resolve_commit(tool, version):
    """GitHub's tag v<version> → the commit it names (one more hop for an annotated tag). Returns (sha, hops)."""
    repository, tag = harness_repository(tool), "v" + version
    missing = "%s has no tag %s." % (repository, tag)
    doc = _github_json(tool, "/repos/%s/git/ref/tags/%s" % (repository, tag), missing)
    target = doc.get("object") if isinstance(doc.get("object"), dict) else {}
    hops = [{"ref": doc.get("ref"), "type": target.get("type"), "sha": target.get("sha")}]
    if doc.get("ref") != "refs/tags/" + tag:
        raise HarnessRefusal("HARNESS_METADATA_INVALID", "GitHub answered for %r, not the tag %s." % (doc.get("ref"), tag))
    if target.get("type") == "tag" and isinstance(target.get("sha"), str) and _GIT_SHA_RE.fullmatch(target["sha"]):
        doc = _github_json(tool, "/repos/%s/git/tags/%s" % (repository, target["sha"]), missing)
        target = doc.get("object") if isinstance(doc.get("object"), dict) else {}
        hops.append({"tag": doc.get("tag"), "type": target.get("type"), "sha": target.get("sha")})
        if doc.get("tag") != tag:
            raise HarnessRefusal("HARNESS_METADATA_INVALID", "GitHub's annotated tag object is for %r, not %s."
                                 % (doc.get("tag"), tag))
    if target.get("type") != "commit" or not isinstance(target.get("sha"), str) or not _GIT_SHA_RE.fullmatch(target["sha"]):
        raise HarnessRefusal("HARNESS_METADATA_INVALID", "GitHub's tag %s of %s does not name a commit." % (tag, repository))
    return target["sha"], hops


def hermes_fetch_source(tool, version, commit):
    """The commit tarball (api.github.com → codeload.github.com) and its canonical tree digest, checked against a
    qualified newestProven's integrity (`sha256-tree:<hex>`)."""
    url = "%s/repos/%s/tarball/%s" % (GITHUB_API, harness_repository(tool), commit)
    archive = os.path.join(tool.work, "hermes-%s.tar.gz" % commit[:12])
    size = tool.fetch(url, archive, HERMES_SOURCE_MAX_BYTES)
    tree = hermes_source_tree_sha256(archive)
    proven_match = proven_digest_match(tool, version, "sha256-tree:" + tree, "the source tree",
                                       {"treeSha256": tree, "integrity": qualified_integrity(tool, version)})
    return archive, {"kind": "github-commit", "origin": url, "tag": "v" + version, "commit": commit, "treeSha256": tree,
                     "archiveBytes": size, "authority": "github-tag-commit", "provenDigestMatch": proven_match}


def hermes_read_attestation(path):
    """The generation's attestation (installer/hermes-runtime.sh hermes_attestation) as a dict, or None."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        data = os.read(fd, 4097) if stat.S_ISREG(info.st_mode) else b""
    finally:
        os.close(fd)
    if not data or len(data) > 4096:
        return None
    fields = {}
    for line in data.decode("utf-8", "replace").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            fields[key.strip()] = value.strip()
    return fields if fields.get("schema") == "bridgesllm-hermes-runtime-v1" else None


def hermes_installed(tool):
    """The alias → <root>/<version>/.venv/bin/hermes, root-owned, and the generation's attestation for that release."""
    try:
        info = os.lstat(tool.link)
    except FileNotFoundError:
        raise HarnessRefusal("HARNESS_TOOL_ABSENT", "%s is not installed on this server (%s is missing). %s"
                             % (tool.label(), tool.link, missing_tool_note(tool.tool_id)))
    if not stat.S_ISLNK(info.st_mode):
        raise HarnessRefusal("HARNESS_LAYOUT_UNMANAGED", "%s is not the Portal-managed launcher link, so the Portal does not "
                             "change it." % tool.link)
    target, resolved = os.readlink(tool.link), os.path.realpath(tool.link)
    runtime = harness_runtime_target(tool, target, resolved, tool.spec["entry"])
    if runtime is None:
        raise HarnessRefusal("HARNESS_LAYOUT_UNMANAGED", "%s points to %s, which is not a Portal-managed %s runtime under %s."
                             % (tool.link, resolved, tool.label(), tool.root))
    version, generation, legacy = runtime
    attestation_path = os.path.join(generation, tool.spec["attestation"])
    for path, directory in ((resolved, False), (generation, True), (attestation_path, False)):
        problem = _harness_owned_problem(path, tool.uid, directory) if path_present(path) else "is missing"
        if problem:
            raise HarnessRefusal("HARNESS_TREE_UNSAFE", "%s %s; nothing was changed." % (path, problem))
    fields = hermes_read_attestation(attestation_path) or {}
    # 5.0.x built Hermes from the upstream's date tags (v2026.9.7 for 0.21.1); later releases tag v<version>.
    tag = fields.get("upstream_tag", "")
    if fields.get("product_version") != version or not (tag == "v" + version or legacy and _HERMES_DATE_TAG_RE.fullmatch(tag)) \
            or not _GIT_SHA_RE.fullmatch(fields.get("upstream_commit", "")) \
            or not _SHA256_HEX_RE.fullmatch(fields.get("source_tree_sha256", "")):
        raise HarnessRefusal("HARNESS_LAYOUT_UNMANAGED", "%s has no valid Portal runtime attestation for %s, so the Portal "
                             "cannot tell which source it was built from." % (generation, tool.label(version)))
    return dict({"version": version, "binary": resolved, "linkTarget": target, "sha256": sha256_file(resolved),
                 "generation": generation, "attestationSha256": sha256_file(attestation_path),
                 "commit": fields["upstream_commit"], "treeSha256": fields["source_tree_sha256"]},
                **harness_legacy_facts(generation, legacy))


def harness_probe_acp_check(tool, executable):
    """C-ACP for Hermes: the installer's own `hermes acp --check` (it loads the ACP adapter, starts nothing)."""
    check = tool.spec["acpCheck"]
    record, out, _err = _sandboxed_probe(tool, "C-ACP", [executable] + check["args"], CLI_PROBE_TIMEOUT)
    if record["exitCode"] == 0 and out.strip() == check["expect"]:
        record["state"] = "passed"
    else:
        record.update(state="failed", reason="`%s` printed %r, not %r" % (" ".join(check["args"]), tail_text(out.strip(), 80),
                                                                           check["expect"]))
    return record


def hermes_record(tool, installed, source, probes, admitted_by, admitted_at):
    """The harness record plus what installer/hermes-runtime.sh hermes_admitted_identity checks."""
    record = build_harness_record(tool, installed, source, probes, admitted_by, admitted_at)
    record["attestationSha256"] = installed["attestationSha256"]
    return record


def hermes_requalify(tool, run_id, step=None, now=utc_now):
    """requalify hermes: installs and switches nothing; admits the installed generation only when GitHub's tag
    names the commit it was built from, that commit's tree has the digest it attests, and the probes pass."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run_id}
    with phase("installed", "Reading the installed version") as current:
        installed = hermes_installed(tool)
        version = installed["version"]
        evidence["installedVersion"] = tool.installed_version = version
        refusal = harness_version_refusal(tool, version)
        if refusal:
            raise HarnessRefusal("HARNESS_VERSION_NOT_ADMISSIBLE", refusal[0].upper() + refusal[1:] + "; update it instead.")
        current.detail = "%s is installed (commit %s)." % (tool.label(version), installed["commit"][:12])
    with phase("resolve", "Finding the official release") as current:
        commit, evidence["tagHops"] = hermes_resolve_commit(tool, version)
        if commit != installed["commit"]:
            raise HarnessRefusal("HARNESS_BINARY_DIFFERS", "The installed %s was built from commit %s, but GitHub's tag v%s "
                                 "names %s." % (tool.label(version), installed["commit"][:12], version, commit[:12]),
                                 {"installedCommit": installed["commit"], "tagCommit": commit})
        current.detail = "Tag v%s names commit %s." % (version, commit[:12])
    with phase("fetch", "Downloading the official source") as current:
        _archive, source = hermes_fetch_source(tool, version, commit)
        current.detail = "%d bytes." % source["archiveBytes"]
    with phase("compare", "Comparing the installed runtime with the official source") as current:
        if source["treeSha256"] != installed["treeSha256"]:
            raise HarnessRefusal("HARNESS_BINARY_DIFFERS", "The installed %s attests a source tree other than the official "
                                 "commit's." % tool.label(version), {"installedTree": installed["treeSha256"],
                                                                     "officialTree": source["treeSha256"]})
        current.detail = "The installed runtime was built from the official source tree."
    with phase("probe", "Checking the installed program") as current:
        probes, failed = harness_probe_set(tool, tool.link, version)
        evidence["probes"] = probes
        if failed:
            raise HarnessRefusal("CLI_PROBE_FAILED", "%s failed its %s check: %s." % (tool.label(version), failed["id"],
                                                                                    failed["reason"]), {"probe": failed})
        current.detail = _probe_summary(probes)
    with phase("commit", "Recording the admission") as current:
        again = hermes_installed(tool)
        if (again["binary"], again["sha256"], again["attestationSha256"]) != (
                installed["binary"], installed["sha256"], installed["attestationSha256"]):
            raise HarnessRefusal("HARNESS_TREE_CHANGED", "The installed %s changed while it was being checked; nothing was "
                                 "admitted." % tool.label(version))
        # The attestation was compared, not the bytes on disk: installer/hermes-runtime.sh keeps a
        # non-tested generation only for a record that verified its bytes (an update's stage).
        record = hermes_record(tool, installed, dict(source, bytesVerified=False), probes, "requalify:%s" % run_id, now())
        evidence["recordPath"] = write_harness_record(tool.roots, record)
        current.detail = "Admitted %s (re-checked)." % tool.label(version)
    return record, evidence


HERMES_STAGE_TIMEOUT = 1800  # the helper downloads the source, uv and Python, then builds the venv


def hermes_update(tool, run, target, step=None, now=utc_now, stop=None):
    """update hermes: the helper builds <root>/<version> in place (a venv is not relocatable) from the commit and tree
    toolctl verified; probe it; fence; switch the alias with one rename; then the versioned finish (probe-installed,
    commit, cleanup, or swap back). Before the switch any failure removes the new generation; the alias never moves."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": target}
    with phase("installed", "Reading the installed version") as current:
        installed = hermes_installed(tool)
        old_version = installed["version"]
        version = harness_resolve_target(tool, target, old_version)
        evidence.update({"from": old_version, "to": version})
        current.detail = "%s is installed; %s is the target." % (tool.label(old_version), version)
    with phase("resolve", "Finding the official release") as current:
        commit, evidence["tagHops"] = hermes_resolve_commit(tool, version)
        helper = vendor_helper(tool)
        current.detail = "Tag v%s names commit %s." % (version, commit[:12])
    with phase("fetch", "Downloading and verifying the official source") as current:
        _archive, source = hermes_fetch_source(tool, version, commit)
        current.detail = "%d bytes; source tree %s." % (source["archiveBytes"], source["treeSha256"][:12])
    ensure_harness_root(tool)  # the helper builds only inside an existing root
    prev_dir = os.path.join(tool.root, ".bridgesllm-prev")
    stage = os.path.join(tool.root, ".bridgesllm-stage-%s" % run.run_id)  # never created: the build is in place
    version_dir = os.path.join(tool.root, version)
    swap = {"kind": "versioned-symlink", "link": tool.link, "root": tool.root, "stage": stage,
            "staged": os.path.join(stage, version), "versionDir": version_dir,
            "toBinary": os.path.join(version_dir, *tool.spec["entry"]), "fromTarget": installed["linkTarget"],
            "fromBinary": installed["binary"], "displaced": os.path.join(prev_dir, "%s.%s" % (version, run.run_id)),
            "failed": os.path.join(prev_dir, "failed.%s" % run.run_id), "fence": npm_fence_path(tool.roots, tool.tool_id),
            "from": old_version, "to": version, "binarySha256": None, "source": dict(source, bytesVerified=True),
            "state": "staging", "legacyGeneration": installed["legacyGeneration"],
            "legacyIdentity": installed["legacyIdentity"]}
    try:
        with phase("stage", "Building the new version next to the installed one") as current:
            run.status["swap"] = swap  # recorded first: reconcile removes a half-built generation
            run.save()
            if path_present(version_dir):
                # A leftover of an earlier attempt (never the alias target: that version is the installed one).
                swap["state"] = "displacing"
                run.save()
                ensure_private_dir(prev_dir)
                os.rename(version_dir, swap["displaced"])
                swap["state"] = "staging"
                run.save()
            hermes_stage_generation(tool, helper, swap, commit, evidence, "%s is unchanged" % tool.label(old_version))
            swap["binarySha256"] = sha256_file(swap["toBinary"])
            run.save()
            current.detail = "%s was built at %s." % (tool.label(version), version_dir)
        with phase("probe-candidate", "Checking the new version before it is installed") as current:
            probes, failed = harness_probe_set(tool, swap["toBinary"], version)
            evidence["probes"] = [dict(probe, target="candidate") for probe in probes]
            if failed:
                raise HarnessRefusal("CLI_PROBE_FAILED", "%s failed its %s check before installation, so nothing was changed: "
                                     "%s." % (tool.label(version), failed["id"], failed["reason"]), {"probe": failed})
            current.detail = _probe_summary(probes) + " (candidate)"
        if stop:
            raise NpmStopped()
    except BaseException:
        versioned_swap_back(swap)  # the alias never moved: removes the new generation, puts a leftover back
        swap["state"] = "unchanged"
        run.save()
        raise
    with phase("swap", "Switching to the new version") as current:
        ensure_private_dir(os.path.dirname(swap["fence"]))
        atomic_write_json(swap["fence"], {"runId": run.run_id, "tool": tool.tool_id, "at": now()})
        swap["state"] = "linking"
        run.save()
        _replace_symlink(tool.link, swap["toBinary"], run.run_id)
        swap["state"] = "swapped"
        run.save()
        current.detail = "%s is now at %s; %s is kept for swap-back." % (tool.label(version), tool.link, old_version)
    return versioned_finish_swap(tool, run, swap, evidence, phase, now)


def hermes_stage_generation(tool, helper, swap, commit, evidence, unchanged):
    """The helper builds swap["versionDir"] in place (installer/hermes-runtime.sh `stage`) from the commit and tree
    toolctl verified; refused with `unchanged` (what is still true) when it fails."""
    version, version_dir, tree = swap["to"], swap["versionDir"], swap["source"]["treeSha256"]
    argv = ["/bin/bash", helper, "stage", version_dir, version, "v" + version, commit, tree]
    env = {"PATH": CLEAN_PATH, "LANG": "C.UTF-8", "HOME": "/root", "HERMES_RUNTIME_ROOT": tool.root,
           "HERMES_BIN_DIR": os.path.dirname(tool.link), "HERMES_STATE_DIR": harness_state_dir(tool)}
    try:
        code, out, err = tool.runner(argv, tool.work, env, HERMES_STAGE_TIMEOUT, CLI_PROBE_OUTPUT_LIMIT,
                                     os.path.join(tool.work, "helper.out"))
    except subprocess.TimeoutExpired:
        code, out, err = None, "", "did not finish within %d s" % HERMES_STAGE_TIMEOUT
    evidence["helper"] = {"argv": argv, "exitCode": code, "stdout": tail_text(redact_text(out), 800),
                          "stderr": tail_text(redact_text(err), 400)}
    if code != 0 or not path_present(swap["toBinary"]):
        raise HarnessRefusal("HARNESS_HELPER_FAILED", "The installer helper could not build %s (%s); %s." % (
            tool.label(version), tail_text((err or out).strip(), 200) or "exit %s" % code, unchanged))
    harness_publish(tool, version_dir)  # the helper builds under toolctl's umask; the probes run it as nobody


def hermes_install(tool, run, step=None, now=utc_now, stop=None):
    """install hermes: the launcher is missing. The same tag, commit and verified source as an update; the helper
    builds the generation in the managed root (a venv is not relocatable), the candidate is probed, the launcher
    created; then the versioned finish, or what this run added is removed again. The gateway is never touched."""
    phase = _phase_factory(step)
    evidence = {"tool": tool.tool_id, "runId": run.run_id, "target": "recommended", "from": None}
    with phase("installed", "Checking that it is not installed") as current:
        version = harness_install_check(tool)
        if path_present(os.path.join(tool.root, version)):
            raise HarnessRefusal("INSTALL_PATH_OCCUPIED", "%s already exists without a launcher, so the Portal does not "
                                 "replace it; nothing was changed." % os.path.join(tool.root, version))
        legacy = harness_legacy_only(tool)
        evidence["to"] = version
        current.detail = "%s is not installed; %s will be installed." % (tool.label(), version)
    with phase("resolve", "Finding the official release") as current:
        commit, evidence["tagHops"] = hermes_resolve_commit(tool, version)
        helper = vendor_helper(tool)
        current.detail = "Tag v%s names commit %s." % (version, commit[:12])
    with phase("fetch", "Downloading and verifying the official source") as current:
        _archive, source = hermes_fetch_source(tool, version, commit)
        current.detail = "%d bytes; source tree %s." % (source["archiveBytes"], source["treeSha256"][:12])
    ensure_harness_root(tool)  # the helper builds only inside an existing root
    swap = harness_install_swap(tool, run, version, os.path.join(tool.root, ".bridgesllm-stage-%s" % run.run_id), legacy,
                                binarySha256=None, source=dict(source, bytesVerified=True), state="staging")
    try:
        with phase("stage", "Building the new version") as current:
            run.status["swap"] = swap  # recorded first: reconcile removes a half-built generation
            run.save()
            hermes_stage_generation(tool, helper, swap, commit, evidence, "%s is still not installed" % tool.label())
            swap["binarySha256"] = sha256_file(swap["toBinary"])
            run.save()
            current.detail = "%s was built at %s." % (tool.label(version), swap["versionDir"])
        with phase("probe-candidate", "Checking the new version before it is installed") as current:
            probes, failed = harness_probe_set(tool, swap["toBinary"], version)
            evidence["probes"] = [dict(probe, target="candidate") for probe in probes]
            if failed:
                raise HarnessRefusal("CLI_PROBE_FAILED", "%s failed its %s check before installation, so nothing was changed: "
                                     "%s." % (tool.label(version), failed["id"], failed["reason"]), {"probe": failed})
            current.detail = _probe_summary(probes) + " (candidate)"
        if stop:
            raise NpmStopped()
    except BaseException:
        harness_install_remove(swap)  # nothing is linked yet: the half-built generation goes
        swap["state"] = "unchanged"
        run.save()
        raise
    with phase("swap", "Installing the new version") as current:
        harness_place_install(tool, run, swap, now)
        current.detail = "%s is now at %s." % (tool.label(version), tool.link)
    return versioned_finish_swap(tool, run, swap, evidence, phase, now)


def harness_reconcile_install(roots, run, swap, policy, runner, fetch, acp, uid, machine, now):
    """d.1 crash rules for an OpenCode or Hermes install, decided by re-reading the filesystem: committed; the launcher
    this run created is checked and committed (or removed); otherwise what this run added is removed."""
    tool_id = run.status.get("tool")
    tool_policy = policy_tool(policy, tool_id)
    label = (tool_policy or {}).get("label") or tool_id
    result = {"action": "install", "from": None, "to": swap.get("to")}
    linked = os.path.islink(swap["link"]) and os.readlink(swap["link"]) == swap["toBinary"] and \
        _same_directory(swap["versionDir"], swap.get("identity"))
    if _harness_committed(roots, run, swap):
        _remove_fence(swap)
        shutil.rmtree(swap["stage"], ignore_errors=True)
        harness_retire_legacy(swap)
        run.finish("succeeded", result=dict(result, reconciled="committed before the interruption"))
    elif linked and tool_policy is not None and swap.get("binarySha256"):
        work = os.path.join(roots.tmp_dir, run.run_id, tool_id)
        ensure_private_dir(os.path.dirname(work))
        ensure_private_dir(work)
        tool = HarnessTool(roots, tool_id, tool_policy, work, uid=uid, runner=runner, fetch=fetch, acp=acp, machine=machine)
        try:
            versioned_finish_swap(tool, run, swap, {"reconciled": True}, _phase_factory(None), now)
        except NpmRefusal as refusal:
            run.finish(RUN_REFUSAL_STATES.get(refusal.code, "recovery-required"),
                       error={"id": refusal.code, "message": refusal.message})
        else:
            run.finish("succeeded", result=dict(result, reconciled="checked and committed after the interruption"))
        finally:
            shutil.rmtree(work, ignore_errors=True)
    else:
        changed = swap.get("state") not in ("fencing", "staging", "unchanged")
        removed = harness_install_remove(swap)
        _remove_fence(swap)
        if removed and not changed:
            run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE", "message": "The %s installation was "
                                        "interrupted before it installed anything. Try again." % label})
        elif removed:
            run.finish("rolled-back", error={"id": "INSTALL_REMOVED", "message": "The %s installation was interrupted; "
                                             "what it had added was removed, so nothing is installed. Try again." % label})
        else:
            run.finish("recovery-required", error={"id": "INSTALL_REMOVE_FAILED", "message": "The %s installation was "
                                                   "interrupted, and what it added is not provably its own, so it was "
                                                   "left alone. %s" % (label, recheck_recovery_advice(label))})
    return {"runId": run.run_id, "state": run.status["state"]}


def harness_reconcile_run(roots, run, policy, runner=run_captured, fetch=https_fetch, acp=None, uid=0, machine=None,
                          now=utc_now):
    """d.1 crash rules for a harness switch, decided by re-reading the filesystem."""
    status = run.status
    swap = status.get("swap")
    settle = {"vendor-file": vendor_reconcile_run, "ollama-installer": ollama_reconcile_run,
              "agent-zero-helper": agent_zero_reconcile_run}.get(swap.get("kind")) if isinstance(swap, dict) else None
    if settle is not None:
        settle(roots, run, swap)
        return {"runId": run.run_id, "state": run.status["state"]}
    if isinstance(swap, dict) and swap.get("kind") == "versioned-install":
        return harness_reconcile_install(roots, run, swap, policy, runner, fetch, acp, uid, machine, now)
    if not isinstance(swap, dict) or swap.get("kind") != "versioned-symlink":
        return None
    tool_id = status.get("tool")
    tool_policy = policy_tool(policy, tool_id)
    if swap.get("state") == "committed":
        _remove_fence(swap)
        shutil.rmtree(swap["stage"], ignore_errors=True)
        harness_retire_legacy(swap)  # a 5.0.x generation the interrupted cleanup did not retire yet
        run.finish("succeeded", result={"action": "update", "from": swap["from"], "to": swap["to"],
                                        "reconciled": "committed before the interruption"})
    elif _links_to(swap["link"], swap["fromBinary"]):
        versioned_swap_back(swap)
        _remove_fence(swap)
        run.finish("failed", error={"id": "TOOLS_RUN_INTERRUPTED_BEFORE_CHANGE",
                                    "message": "The update was interrupted before it switched versions. Nothing was changed. Try again."})
    elif _links_to(swap["link"], swap["toBinary"]) and (tool_policy is None or tool_id not in HARNESS_SPECS):
        restored = versioned_swap_back(swap)
        _remove_fence(swap)
        run.finish("rolled-back" if restored else "recovery-required", error={
            "id": "HARNESS_SWAPPED_BACK" if restored else "HARNESS_SWAP_BACK_FAILED",
            "message": "The update was interrupted after the switch and could not be checked; %s." % (
                "the previous version was put back" if restored else "the previous version could not be put back")})
    elif _links_to(swap["link"], swap["toBinary"]):
        work = os.path.join(roots.tmp_dir, run.run_id, tool_id)
        ensure_private_dir(os.path.dirname(work))
        ensure_private_dir(work)
        tool = HarnessTool(roots, tool_id, tool_policy, work, uid=uid, runner=runner, fetch=fetch, acp=acp, machine=machine)
        try:
            versioned_finish_swap(tool, run, swap, {"reconciled": True}, _phase_factory(None), now)
        except NpmRefusal as refusal:
            run.finish("rolled-back" if refusal.code == "HARNESS_SWAPPED_BACK" else "recovery-required",
                       error={"id": refusal.code, "message": refusal.message})
        else:
            run.finish("succeeded", result={"action": "update", "from": swap["from"], "to": swap["to"],
                                            "reconciled": "checked and committed after the interruption"})
        finally:
            shutil.rmtree(work, ignore_errors=True)
    else:
        _remove_fence(swap)
        run.finish("recovery-required", error={"id": "HARNESS_LAUNCHER_UNKNOWN", "message": "The %s update was interrupted "
                                               "and %s points to neither version. %s" % (
                                                   tool_id, swap["link"],
                                                   recheck_recovery_advice((tool_policy or {}).get("label") or tool_id))})
    return {"runId": run.run_id, "state": run.status["state"]}


def validate_harness_request(request, run_id, policy):
    errors = []
    if request.get("schema") != SCHEMA_REQUEST:
        errors.append("schema must be %s" % SCHEMA_REQUEST)
    if request.get("runId") != run_id:
        errors.append("runId does not match the unit instance")
    if policy_tool(policy, request.get("tool")) is None:
        errors.append("tool is not in the policy")
    if request.get("action") not in HARNESS_ACTIONS:
        errors.append("%s supports only %s; %s is not available for it" % (
            request.get("tool"), ", ".join(HARNESS_ACTIONS), request.get("action")))
    if request.get("action") == "update":
        target = request.get("target")
        if target not in ("recommended", "newestProven", "newest") and not (
                isinstance(target, str) and _PLAIN_VERSION_RE.fullmatch(target)):
            errors.append("target must be recommended, newestProven, newest or an exact release version")
    if request.get("action") == "install" and request.get("target") not in INSTALL_TARGETS:
        errors.append("install installs the recommended version only")
    return errors


def execute_harness_run(roots, run, policy, request, stop=None, runner=run_captured, fetch=https_fetch, acp=None, uid=0,
                        machine=None, now=utc_now, local_get=None):
    """Run one harness action under the run lock; the gateway is never touched."""
    tool_id = request["tool"]
    tool_policy = policy_tool(policy, tool_id)
    result = {"action": request["action"], "from": None, "to": None}
    if tool_id not in HARNESS_SPECS:
        run.finish("refused", error={"id": "TOOLS_ACTION_UNSUPPORTED", "message": "%s cannot be updated or re-checked from "
                                     "Maintenance in this Portal build yet." % ((tool_policy or {}).get("label") or tool_id)},
                   result=result)
        return run.status
    if request["action"] == "update" and request.get("target") == "newest":
        # 5.2.0: only the npm CLIs update to the newest release (their candidate code runs only inside the probe
        # sandbox). A harness tool's helpers run the candidate as root outside it, so it updates only to the version
        # this Portal release qualified: refused before any release lookup or download.
        run.finish("refused", error={"id": "NEWEST_NOT_OFFERED", "message": NEWEST_NOT_OFFERED_MESSAGE}, result=result)
        return run.status
    work_parent = os.path.join(roots.tmp_dir, run.run_id)
    ensure_private_dir(work_parent)
    work = os.path.join(work_parent, tool_id)
    if path_present(work):
        shutil.rmtree(work)
    ensure_private_dir(work)
    evidence_name = "harness-%s.json" % request["action"]
    run.transition("verifying", "verifying")
    tool = None
    try:
        tool = HarnessTool(roots, tool_id, tool_policy, work, uid=uid, runner=runner, fetch=fetch, acp=acp, machine=machine,
                           local_get=local_get)
        if tool.machine is None:
            raise HarnessRefusal("UNSUPPORTED_PLATFORM", "This server is not an x86_64 or arm64 Linux host.")
        if tool.machine not in tool.spec.get("machines", (tool.machine,)):
            raise HarnessRefusal("UNSUPPORTED_PLATFORM", "%s is supported on x86_64 Linux only." % tool.label())
        update, requalify = {"vendor-file": (vendor_update, vendor_requalify),
                             "venv-generation": (hermes_update, hermes_requalify),
                             "service-restart": (ollama_update, ollama_requalify),
                             "managed-container": (agent_zero_update, agent_zero_requalify)}.get(
                                 tool.spec["layout"], (versioned_update, versioned_requalify))
        if request["action"] == "update":
            run.transition("running", "running")
            record, evidence = update(tool, run, request["target"], step=lambda i, l: _RunStep(run, i, l), now=now, stop=stop)
        elif request["action"] == "install":
            install = {"service-restart": ollama_install, "versioned-dir": versioned_install, "venv-generation":
                       hermes_install, "vendor-file": vendor_install}.get(tool.spec["layout"]) \
                if tool_id in INSTALL_TOOL_IDS else None
            if install is None:
                raise HarnessRefusal("TOOLS_ACTION_UNSUPPORTED", "%s cannot be installed from Maintenance in this Portal "
                                     "build. %s" % (tool.label(), MISSING_TOOL_NOTE))
            run.transition("running", "running")
            record, evidence = install(tool, run, step=lambda i, l: _RunStep(run, i, l), now=now, stop=stop)
        else:
            record, evidence = requalify(tool, run.run_id, step=lambda i, l: _RunStep(run, i, l), now=now)
    except NpmStopped:
        return stop_before_change(run, stop, result=result)
    except NpmRefusal as refusal:
        evidence_name = run.write_evidence(evidence_name, {"tool": tool_id, "error": refusal.code, "message": refusal.message,
                                                           "detail": refusal.detail})
        state = RUN_REFUSAL_STATES.get(refusal.code, "refused")
        # No harness flow installs the version it already has, so at or above the
        # recommended version the re-check is offered instead of a refused update.
        next_action = recheck_next_action(tool, tool.installed_version) if tool is not None and request["action"] == \
            "requalify" and refusal.code in ("HARNESS_BINARY_DIFFERS", "CLI_PROBE_FAILED") and \
            HARNESS_SPECS[tool_id]["layout"] != "vendor-file" else None
        # A refused re-check records the installed version it read: for a launcher
        # with no cheap version read it is the only known version. One the Portal
        # does not admit (below the floor, or refused) ends with the update to the
        # recommended version, never with another re-check.
        read = tool.installed_version if tool is not None and request["action"] == "requalify" and state == "refused" \
            and parse_version(tool.installed_version) else None
        if read and refusal.code == "HARNESS_VERSION_NOT_ADMISSIBLE":
            next_action = recheck_next_action(tool, read)
        run.finish(state, error={"id": refusal.code, "message": refusal.message, "nextAction": next_action,
                                 "detail": refusal.detail},
                   result=dict(result, evidence=evidence_name, **({"installedVersion": read} if read else {})))
        return run.status
    finally:
        shutil.rmtree(work, ignore_errors=True)
    evidence_name = run.write_evidence(evidence_name, evidence)
    run.finish("succeeded", result=dict(result, **{"from": evidence.get("from", record["version"]), "to": record["version"],
                                                    "admittedBy": record["admittedBy"], "evidence": evidence_name}))
    return run.status


# ==========================================================================
# Legacy host migration (DESIGN h.4) and the reconcile entry point. This
# section belongs to the installer lane. Nothing here starts, stops or
# restarts the OpenClaw gateway.
# ==========================================================================

SCHEMA_DROPIN_RETIREMENT = "bridgesllm.tools.dropin-retirement.v1"
LEGACY_GATEWAY_UNIT = "openclaw-gateway.service"
LEGACY_SYSTEM_UNIT_DIR_SUFFIX = "/etc/systemd/system"
# The system-unit fence pair (install.sh OPENCLAW_GATEWAY_AUTHORIZATION_FENCE_DROPIN
# and OPENCLAW_GATEWAY_MIGRATION_PERMIT_DROPIN), in that order.
LEGACY_GATEWAY_DROPINS = ("20-bridgesllm-authorization-fence.conf", "30-bridgesllm-migration-permit.conf")
LEGACY_FENCE_MARKER_DEFAULT = "/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1"
DROPIN_MAX_BYTES = 64 * 1024
RECONCILE_DEFERRED_MESSAGE = ("A Portal update, backup, restore, repair or AI tools run holds the operation lock; "
                              "reconcile runs again at the next Portal start or boot.")


def legacy_dropin_dir(roots):
    for directory in roots.systemd_unit_dirs:
        if directory == LEGACY_SYSTEM_UNIT_DIR_SUFFIX or directory.endswith(LEGACY_SYSTEM_UNIT_DIR_SUFFIX):
            return os.path.join(directory, LEGACY_GATEWAY_UNIT + ".d")
    return None


def legacy_dropin_problem(name, text):
    """None when the drop-in provably does nothing while the fence marker is absent.

    Only the directives the installer ever wrote are accepted: the marker
    condition, the reset of that condition, the marker-gated permit check
    (it exits 0 first when the marker is absent) and KillMode=control-group
    (the gateway then keeps OpenClaw's own KillMode). Anything else means the
    owner or another tool changed the file, and it is left in place.
    """
    marker = LEGACY_FENCE_MARKER_DEFAULT
    allowed = {"[Unit]", "[Service]", "KillMode=control-group"}
    if name == LEGACY_GATEWAY_DROPINS[0]:
        allowed.add("ConditionPathExists=!" + marker)
    else:
        allowed.add("ConditionPathExists=")
    gated_prefix = 'ExecCondition=/bin/sh -c "if [ ! -e %s ]; then exit 0; fi;' % marker
    exec_conditions = 0
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if name == LEGACY_GATEWAY_DROPINS[1] and line.startswith(gated_prefix):
            exec_conditions += 1
            continue
        if line not in allowed:
            return "it contains a setting the Portal never wrote (%s)" % line[:80]
    if exec_conditions > 1:
        return "it contains more than one start condition"
    return None


def _move_file(source, destination):
    """Rename, or copy + fsync + unlink across file systems. The source is never deleted before its copy is durable."""
    try:
        os.rename(source, destination)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        temporary = destination + ".partial"
        try:
            shutil.copyfile(source, temporary, follow_symlinks=False)
            fd = os.open(temporary, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0))
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            os.chmod(temporary, 0o600)
            os.rename(temporary, destination)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
        fsync_dir(os.path.dirname(destination))
        os.unlink(source)
    fsync_dir(os.path.dirname(source))
    fsync_dir(os.path.dirname(destination))


def retire_legacy_gateway_dropins(roots, runner=run_bounded, now=utc_now):
    """h.4: move the legacy system-unit gateway fence pair aside, once it is provably inert.

    Preconditions (all, or nothing moves): no legacy root and no Portal
    operation journal, no fence marker, no permit, and the gateway active.
    The drop-ins are moved (never deleted) into
    ``<state>/retired-dropins/<ts>/`` with a receipt, then systemd reloads.
    The gateway is never restarted: the drop-ins only gate starts. The root
    user-unit inhibitor (``ExecCondition=/usr/bin/false``, marker-independent)
    keeps a second, user-level gateway from starting, so it is not retired.
    """
    dropin_dir = legacy_dropin_dir(roots)
    if dropin_dir is None:
        return {"state": "refused", "reason": "The system unit directory is not configured, so the old gateway drop-ins cannot be found."}
    present = [name for name in LEGACY_GATEWAY_DROPINS if path_present(os.path.join(dropin_dir, name))]
    if not present:
        return {"state": "nothing-to-retire"}
    open_roots = [entry["id"] for entry in open_legacy_roots(roots)]
    if path_present(roots.gateway_fence_marker):
        return {"state": "refused", "reason": "The old gateway fence marker is present; recover the interrupted maintenance first (Maintenance page, Recover)."}
    if path_present(roots.gateway_fence_permit):
        return {"state": "refused", "reason": "An old gateway start permit is present; an installer operation may still be running."}
    if open_roots:
        return {"state": "refused", "reason": "An older maintenance transaction is still open (%s); recover it first." % ", ".join(open_roots)}
    journals = [jid for jid, path in portal_operation_journals(roots) if path_present(path)]
    if journals:
        return {"state": "refused", "reason": "A Portal update or uninstall did not finish (%s); the old gateway drop-ins stay until it is recovered." % ", ".join(journals)}
    try:
        code, out, _err = runner([roots.systemctl_bin, "is-active", LEGACY_GATEWAY_UNIT], timeout=SYSTEMCTL_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        return {"state": "refused", "reason": "The gateway state could not be read (%s)." % type(error).__name__}
    if code != 0 or out.strip() != "active":
        return {"state": "refused", "reason": "The OpenClaw gateway is not running (%s); the old drop-ins are retired once it is." % (out.strip() or "unknown")[:40]}
    files = []
    for name in present:
        path = os.path.join(dropin_dir, name)
        try:
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 and info.st_uid != os.geteuid():
                return {"state": "refused", "reason": "%s is not a root-owned regular file; it was left in place." % path}
            if info.st_size > DROPIN_MAX_BYTES:
                return {"state": "refused", "reason": "%s is unexpectedly large; it was left in place." % path}
            with open(path, "rb") as handle:
                data = handle.read(DROPIN_MAX_BYTES + 1)
        except OSError as error:
            return {"state": "refused", "reason": "%s could not be read (%s); it was left in place."
                    % (path, error.strerror or type(error).__name__)}
        problem = legacy_dropin_problem(name, data.decode("utf-8", "replace"))
        if problem:
            return {"state": "refused", "reason": "%s was left in place: %s." % (path, problem)}
        files.append({"name": name, "from": path, "sha256": hashlib.sha256(data).hexdigest()})
    retired_root = os.path.join(roots.state_root, "retired-dropins")
    ensure_state_dirs(roots)
    ensure_private_dir(retired_root)
    stamp = re.sub(r"[^0-9TZ]", "", now())
    target_dir = os.path.join(retired_root, stamp)
    suffix = 0
    while path_present(target_dir):
        suffix += 1
        target_dir = os.path.join(retired_root, "%s-%d" % (stamp, suffix))
    ensure_private_dir(target_dir)
    moved, move_error = [], None
    for entry in files:
        entry["to"] = os.path.join(target_dir, entry["name"])
        try:
            _move_file(entry["from"], entry["to"])
        except OSError as error:
            move_error = "%s could not be moved (%s)" % (entry["from"], error.strerror or type(error).__name__)
            break
        moved.append(entry)
    if not moved:
        return {"state": "failed", "reason": "Nothing was moved: %s." % move_error}
    try:
        reload_code, _out, reload_err = runner([roots.systemctl_bin, "daemon-reload"], timeout=SYSTEMCTL_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        reload_code, reload_err = None, type(error).__name__
    receipt = {
        "schema": SCHEMA_DROPIN_RETIREMENT,
        "retiredAt": now(),
        "unit": LEGACY_GATEWAY_UNIT,
        "files": moved,
        "gatewayRestarted": False,
        "daemonReload": "ok" if reload_code == 0 else "failed",
    }
    if reload_code != 0:
        receipt["daemonReloadError"] = tail_text(reload_err or "", 300)
    if move_error:
        receipt["incomplete"] = move_error
    receipt_path = os.path.join(target_dir, "receipt.json")
    atomic_write_json(receipt_path, receipt)
    result = {"state": "retired" if not move_error else "partial", "receipt": receipt_path,
              "files": [e["name"] for e in moved]}
    reasons = []
    if move_error:
        reasons.append("%s; the next reconcile tries again" % move_error)
    if reload_code != 0:
        reasons.append("systemd could not reload, so the moved drop-ins stop applying at the next reload or boot")
    if reasons:
        result["reason"] = "The old drop-ins were moved aside, but " + "; ".join(reasons) + "."
    return result


def cmd_reconcile_host(roots, stale_queued_seconds=STALE_QUEUED_SECONDS, runner=run_bounded, http_get=http_get_status,
                       settle=None):
    """The `reconcile` command: settle runs, then retire legacy drop-ins.

    It holds the installer operation lock while it works. When a Portal
    update (or another installer operation or a tools run) holds it,
    reconcile changes nothing and exits 0: the next Portal start or boot
    runs it again.
    """
    portal_lock = PortalOperationLock(roots.portal_operation_lock)
    try:
        portal_lock.acquire()
    except LockBusy:
        return {"settled": [], "deferred": RECONCILE_DEFERRED_MESSAGE}
    except OSError as error:
        # For example /run/lock not mounted yet early in boot: change
        # nothing; the Portal's start-up reconcile follows.
        return {"settled": [], "deferred": "The installer operation lock could not be opened (%s); nothing was changed."
                % (error.strerror or type(error).__name__)}
    try:
        ensure_state_dirs(roots)
        result = {"settled": cmd_reconcile(roots, stale_queued_seconds=stale_queued_seconds, runner=runner, http_get=http_get,
                                           settle=settle, portal_lock_held=True)}
        result["dropinRetirement"] = retire_legacy_gateway_dropins(roots, runner=runner)
        return result
    finally:
        portal_lock.release()


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(prog="bridgesllm-toolctl", description="BridgesLLM AI tools maintenance runner")
    for name, (env_name, _default) in DEFAULTS.items():
        parser.add_argument("--" + name.replace("_", "-"), dest=name, default=None,
                            help="override (env %s)" % env_name)
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("status")
    pre = sub.add_parser("preflight")
    pre.add_argument("tool", choices=["openclaw"])
    pre.add_argument("--target", default="recommended")
    pre.add_argument("--channel", choices=list(OPENCLAW_CHANNELS), default=None)
    pre.add_argument("--target-metadata", default=None, help="registry metadata fixture (npm view --json shape)")
    run = sub.add_parser("run")
    run.add_argument("run_id")
    run.add_argument("--target-metadata", default=None,
                     help="offline registry metadata (npm view --json shape); the unit never passes it")
    rec = sub.add_parser("reconcile")
    rec.add_argument("--stale-queued-seconds", type=int, default=STALE_QUEUED_SECONDS)
    sub.add_parser("validate-policy")
    return parser


def emit(obj):
    sys.stdout.write(json.dumps(redact(obj), indent=2, sort_keys=True) + "\n")
    sys.stdout.flush()


def main(argv=None):
    os.umask(0o077)
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_usage(sys.stderr)
        return EXIT_ERROR
    try:
        roots = Roots.resolve(args)
        if args.command == "status":
            emit(cmd_status(roots))
            return EXIT_OK
        if args.command == "validate-policy":
            policy, sha, errors = load_policy(roots)
            emit({"path": roots.policy_path, "sha256": sha, "valid": not errors, "errors": errors})
            return EXIT_OK if not errors else EXIT_FAILED
        if args.command == "preflight":
            policy, _sha, errors = load_policy(roots)
            if errors:
                emit({"schema": SCHEMA_PREFLIGHT, "ok": False, "refusals": [
                    {"id": "POLICY_INVALID", "check": "PF-0", "message": "This Portal's tool policy is invalid.",
                     "nextAction": None, "detail": {"errors": errors[:20]}}], "checks": [], "facts": {}})
                return EXIT_REFUSED
            if core_updates_later(policy):
                emit({"schema": SCHEMA_PREFLIGHT, "ok": False, "refusals": [later_release_refusal(policy)], "checks": [],
                      "facts": {"installedVersion": installed_openclaw_version(roots)}})
                return EXIT_REFUSED
            report = Preflight(roots, policy, target=args.target, channel=args.channel,
                               metadata_path=args.target_metadata).run()
            emit(report)
            return EXIT_OK if report["ok"] else EXIT_REFUSED
        if args.command == "run":
            status = cmd_run(roots, args.run_id, metadata_path=args.target_metadata)
            emit(status)
            return EXIT_BY_STATE.get(status.get("state"), EXIT_ERROR)
        if args.command == "reconcile":
            emit(cmd_reconcile_host(roots, stale_queued_seconds=args.stale_queued_seconds))
            return EXIT_OK
    except ToolctlError as error:
        sys.stderr.write("bridgesllm-toolctl: %s\n" % redact_text(str(error)))
        return EXIT_ERROR
    return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
