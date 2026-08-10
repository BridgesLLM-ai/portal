#!/usr/bin/env python3
"""Atomic, observer-only state for Portal Dashboard self-updates.

This helper deliberately does not participate in update recovery decisions.
The installer's transaction journal remains the only recovery authority.  This
file gives the Dashboard a small, durable progress record that survives the
Portal process being replaced and cannot claim terminal success before
systemd's ``ExecStopPost`` has observed the updater service's exact clean exit.

Production storage is fixed at::

    /var/lib/bridgesllm-installer/
      dashboard-update-progress.py
      dashboard-updates/
        current
        <32-lowercase-hex-operation-id>.json

Tests may relocate the fixed tree with
``BRIDGESLLM_DASHBOARD_UPDATE_TEST_ROOT`` only while
``BRIDGESLLM_INSTALLER_SOURCE_ONLY=1``.  Production and fixture stores require
effective root, a root-owned 0700 directory, and root-owned 0600 files.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import secrets
import stat
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Mapping, Optional


SCHEMA = 1
PRODUCTION_METADATA_ROOT = "/var/lib/bridgesllm-installer"
PRODUCTION_STATE_ROOT = "/var/lib/bridgesllm-installer/dashboard-updates"
PRODUCTION_LOG_ROOT = "/opt/bridgesllm/logs"
PRODUCTION_PORTAL_ROOT = "/opt/bridgesllm/portal"
TEST_ROOT_ENV = "BRIDGESLLM_DASHBOARD_UPDATE_TEST_ROOT"
SOURCE_ONLY_ENV = "BRIDGESLLM_INSTALLER_SOURCE_ONLY"
STATE_DIRECTORY_NAME = "dashboard-updates"
STABLE_HELPER_NAME = "dashboard-update-progress.py"
CURRENT_POINTER_NAME = "current"
ACTIVE_JOURNAL_NAME = "active-update.json"
CUTOVER_JOURNAL_NAME = "cutover-update.json"
ATTENTION_ACKNOWLEDGEMENT = "I HAVE REPAIRED AND VERIFIED THIS PORTAL UPDATE"
MAX_STATE_BYTES = 64 * 1024
MAX_POINTER_BYTES = 64
MAX_HELPER_BYTES = 256 * 1024
MAX_EVENTS = 12

SYSTEMD_SERVICE_RESULTS = frozenset(
    {
        "success",
        "protocol",
        "timeout",
        "exit-code",
        "signal",
        "core-dump",
        "watchdog",
        "exec-condition",
        "oom-kill",
        "start-limit-hit",
        "resources",
    }
)
SYSTEMD_EXIT_CODES = frozenset({"exited", "killed", "dumped"})
SYSTEMD_SIGNAL_STATUSES = frozenset(
    {
        "ABRT",
        "ALRM",
        "BUS",
        "CHLD",
        "CONT",
        "FPE",
        "HUP",
        "ILL",
        "INT",
        "IO",
        "KILL",
        "PIPE",
        "POLL",
        "PROF",
        "PWR",
        "QUIT",
        "SEGV",
        "STKFLT",
        "STOP",
        "SYS",
        "TERM",
        "TRAP",
        "TSTP",
        "TTIN",
        "TTOU",
        "URG",
        "USR1",
        "USR2",
        "VTALRM",
        "WINCH",
        "XCPU",
        "XFSZ",
    }
)

OPERATION_ID_RE = re.compile(r"^[a-f0-9]{32}$")
VERSION_RE = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$"
)
TIMESTAMP_RE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
)
LOG_BASENAME_RE = re.compile(
    r"^self-update-[0-9]{4}-[0-9]{2}-[0-9]{2}T"
    r"[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.log$"
)
STATE_NAME_RE = re.compile(r"^(?P<operation>[a-f0-9]{32})\.json$")
TEMP_NAME_RE = re.compile(
    r"^\.dashboard-update-progress\.tmp\.[1-9][0-9]{0,19}\.[a-f0-9]{16}$"
)
BOOTSTRAP_TEMP_NAME_RE = re.compile(
    r"^\.dashboard-update-progress\.bootstrap\.tmp\."
    r"[1-9][0-9]{0,19}\.[a-f0-9]{16}$"
)
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

NONTERMINAL_STATUSES = frozenset({"starting", "running", "recovering"})
TERMINAL_STATUSES = frozenset(
    {
        "succeeded",
        "failed",
        "rolled_back",
        "updated_with_errors",
        "recovery_required",
    }
)
BLOCKING_TERMINAL_STATUSES = frozenset(
    {"updated_with_errors", "recovery_required"}
)
PENDING_OUTCOMES = frozenset(
    {"rolled_back", "updated_with_errors", "recovery_required"}
)
UPDATE_STATUSES = frozenset({"running", "recovering", *PENDING_OUTCOMES})
EVENT_STATUSES = UPDATE_STATUSES

# These are protocol identifiers, not console prose.  Adding a new installer
# checkpoint requires an explicit review here, so an untrusted caller cannot
# make the owner UI invent arbitrary phases.
FORWARD_PHASES = frozenset(
    {
        "admitted",
        "launch",
        "installer-download",
        "host-safety",
        "portal-preflight",
        "capacity-preflight",
        "signed-release",
        "runtime-preparation",
        "portal-transaction",
        "portal-quiesced",
        "rollback-snapshots",
        "runtime-install",
        "database-migration",
        "candidate-verification",
        "cutover-preparation",
        "portal-cutover",
        "portal-restarting",
        "portal-committed",
        "postflight",
        "failure",
    }
)
RECOVERY_PHASES = frozenset({"recovery"})
PENDING_PHASES = {
    "rolled_back": frozenset({"rolled-back"}),
    "updated_with_errors": frozenset({"updated-with-errors", "final-health"}),
    "recovery_required": frozenset({"recovery-required"}),
}
ALL_PHASES = frozenset(
    {
        *FORWARD_PHASES,
        *RECOVERY_PHASES,
        *(phase for phases in PENDING_PHASES.values() for phase in phases),
        "complete",
    }
)

STATE_FIELDS = frozenset(
    {
        "schema",
        "operationId",
        "previousVersion",
        "expectedVersion",
        "status",
        "pendingOutcome",
        "phase",
        "percent",
        "label",
        "detail",
        "startedAt",
        "updatedAt",
        "finishedAt",
        "events",
        "logFile",
        "logAvailable",
    }
)
EVENT_FIELDS = frozenset({"status", "phase", "percent", "label", "detail", "at"})


class ProgressStateError(RuntimeError):
    """The progress store or requested transition failed closed."""


class ProgressBusyError(ProgressStateError):
    """A different nonterminal Dashboard update already owns the store."""


class ProgressAttentionError(ProgressStateError):
    """Durable recovery or operator attention blocks a new update."""


class ProgressNoCurrentError(ProgressStateError):
    """No durable Dashboard update is currently addressable."""


@dataclass(frozen=True)
class StoreConfig:
    metadata_root: str
    state_root: str
    log_root: str
    portal_root: str
    expected_uid: int = 0


@dataclass(frozen=True)
class SecureFile:
    content: bytes
    device: int
    inode: int
    size: int
    mtime_ns: int


def _canonical_absolute_path(value: str, *, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or CONTROL_RE.search(value) is not None
        or not os.path.isabs(value)
        or os.path.normpath(value) != value
    ):
        raise ProgressStateError(f"{field} is not a canonical absolute path.")
    return value


def _assert_no_symlink_components(path: str, *, final_required: bool = True) -> None:
    canonical = _canonical_absolute_path(path, field="path")
    current = os.path.sep
    components = [component for component in canonical.split(os.path.sep) if component]
    for index, component in enumerate(components):
        current = os.path.join(current, component)
        try:
            details = os.lstat(current)
        except FileNotFoundError:
            if index == len(components) - 1 and not final_required:
                return
            raise ProgressStateError("A required progress path is missing.") from None
        if stat.S_ISLNK(details.st_mode):
            raise ProgressStateError("A progress path contains a symbolic link.")
        if index < len(components) - 1 and not stat.S_ISDIR(details.st_mode):
            raise ProgressStateError("A progress path ancestor is not a directory.")


def _validate_directory(
    path: str,
    *,
    expected_uid: int,
    exact_mode: Optional[int] = None,
    field: str,
) -> os.stat_result:
    _assert_no_symlink_components(path)
    details = os.lstat(path)
    if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode):
        raise ProgressStateError(f"{field} is not a regular directory.")
    if details.st_uid != expected_uid:
        raise ProgressStateError(f"{field} has an unsafe owner.")
    mode = stat.S_IMODE(details.st_mode)
    if exact_mode is not None and mode != exact_mode:
        raise ProgressStateError(f"{field} must have mode {exact_mode:04o}.")
    if exact_mode is None and mode & 0o022:
        raise ProgressStateError(f"{field} is writable by an unsafe principal.")
    return details


def _config_from_environment() -> StoreConfig:
    if os.geteuid() != 0:
        raise ProgressStateError("Dashboard update progress requires effective root.")
    source_only = os.environ.get(SOURCE_ONLY_ENV, "0")
    if source_only not in {"0", "1"}:
        raise ProgressStateError("The installer source-only gate is invalid.")

    if TEST_ROOT_ENV in os.environ:
        if source_only != "1":
            raise ProgressStateError("The Dashboard update fixture root is test-only.")
        test_root = _canonical_absolute_path(
            os.environ.get(TEST_ROOT_ENV, ""), field="fixture root"
        )
        if test_root == os.path.sep:
            raise ProgressStateError("The Dashboard update fixture root cannot be /.")
        _validate_directory(
            test_root, expected_uid=0, exact_mode=0o700, field="fixture root"
        )
        metadata_root = os.path.join(test_root, "var", "lib", "bridgesllm-installer")
        return StoreConfig(
            metadata_root=metadata_root,
            state_root=os.path.join(metadata_root, STATE_DIRECTORY_NAME),
            log_root=os.path.join(test_root, "opt", "bridgesllm", "logs"),
            portal_root=os.path.join(test_root, "opt", "bridgesllm", "portal"),
        )

    if source_only == "1":
        raise ProgressStateError("Source-only mode requires an explicit fixture root.")
    return StoreConfig(
        metadata_root=PRODUCTION_METADATA_ROOT,
        state_root=PRODUCTION_STATE_ROOT,
        log_root=PRODUCTION_LOG_ROOT,
        portal_root=PRODUCTION_PORTAL_ROOT,
    )


def _validate_operation_id(value: str) -> str:
    if not isinstance(value, str) or OPERATION_ID_RE.fullmatch(value) is None:
        raise ProgressStateError("The Dashboard update operation identifier is invalid.")
    return value


def _validate_version(value: str, *, field: str) -> str:
    if not isinstance(value, str) or VERSION_RE.fullmatch(value) is None:
        raise ProgressStateError(f"{field} is not an exact release version.")
    return value


def _validate_text(value: Any, *, field: str, maximum: int, allow_empty: bool) -> str:
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or len(value.encode("utf-8")) > maximum
        or CONTROL_RE.search(value) is not None
        or (not allow_empty and not value.strip())
    ):
        raise ProgressStateError(f"{field} is outside its bounded text contract.")
    return value


def _validate_timestamp(value: Any, *, field: str) -> dt.datetime:
    if not isinstance(value, str) or TIMESTAMP_RE.fullmatch(value) is None:
        raise ProgressStateError(f"{field} is not a UTC progress timestamp.")
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError as error:
        raise ProgressStateError(f"{field} is not a UTC progress timestamp.") from error


def _utc_now(not_before: Optional[str] = None) -> str:
    current = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    if not_before is not None:
        floor = _validate_timestamp(not_before, field="prior updatedAt")
        if current < floor:
            current = floor
    return current.strftime("%Y-%m-%dT%H:%M:%SZ")


def _validate_phase_for_status(status_value: str, phase: str) -> None:
    if status_value == "running" and phase in FORWARD_PHASES:
        return
    if status_value == "recovering" and phase in RECOVERY_PHASES:
        return
    if status_value in PENDING_PHASES and phase in PENDING_PHASES[status_value]:
        return
    raise ProgressStateError("The progress phase is not allowed for this status.")


def _systemd_finish_result(environment: Mapping[str, str]) -> str:
    service_result = environment.get("SERVICE_RESULT")
    if service_result is None or service_result == "":
        raise ProgressStateError(
            "systemd did not provide SERVICE_RESULT to finalization."
        )
    if service_result not in SYSTEMD_SERVICE_RESULTS:
        raise ProgressStateError("systemd provided an unknown SERVICE_RESULT.")

    # SERVICE_RESULT is the manager's authoritative outcome. No non-success
    # result may be promoted merely because a main process happened to exit 0,
    # and systemd may omit or partially populate main-process fields when the
    # service fails before/around exec.
    if service_result != "success":
        return "failed"

    values: dict[str, str] = {}
    for name in ("EXIT_CODE", "EXIT_STATUS"):
        value = environment.get(name)
        if value is not None and value != "":
            values[name] = value

    # Success remains deliberately stricter than failure: systemd must identify
    # a normally exited main process with status zero.
    if not values:
        raise ProgressStateError(
            "systemd did not provide EXIT_CODE or EXIT_STATUS to finalization."
        )
    for name in ("EXIT_CODE", "EXIT_STATUS"):
        if name not in values:
            raise ProgressStateError(f"systemd did not provide {name} to finalization.")

    exit_code = values["EXIT_CODE"]
    exit_status = values["EXIT_STATUS"]
    if exit_code not in SYSTEMD_EXIT_CODES:
        raise ProgressStateError("systemd provided an unknown EXIT_CODE.")
    if exit_code == "exited":
        if re.fullmatch(r"0|[1-9][0-9]{0,2}", exit_status) is None or int(
            exit_status
        ) > 255:
            raise ProgressStateError("systemd provided an unknown EXIT_STATUS.")
    elif exit_status not in SYSTEMD_SIGNAL_STATUSES:
        raise ProgressStateError("systemd provided an unknown EXIT_STATUS.")

    return (
        "succeeded"
        if (service_result, exit_code, exit_status) == ("success", "exited", "0")
        else "failed"
    )


def _validate_log_path_lexical(log_file: Any, config: StoreConfig) -> str:
    if not isinstance(log_file, str):
        raise ProgressStateError("logFile is invalid.")
    value = _canonical_absolute_path(log_file, field="logFile")
    if os.path.dirname(value) != config.log_root:
        raise ProgressStateError("logFile is outside the fixed updater log root.")
    if LOG_BASENAME_RE.fullmatch(os.path.basename(value)) is None:
        raise ProgressStateError("logFile does not have an updater-owned name.")
    return value


def _validate_log_file(log_file: str, config: StoreConfig) -> bool:
    value = _validate_log_path_lexical(log_file, config)
    _validate_directory(
        config.log_root,
        expected_uid=config.expected_uid,
        exact_mode=None,
        field="updater log root",
    )
    _assert_no_symlink_components(value, final_required=False)
    try:
        os.lstat(value)
    except FileNotFoundError:
        return False

    root_fd = os.open(
        config.log_root,
        os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            file_fd = os.open(os.path.basename(value), flags, dir_fd=root_fd)
        except OSError as error:
            raise ProgressStateError("The updater log could not be opened safely.") from error
        try:
            opened = os.fstat(file_fd)
            named = os.lstat(os.path.basename(value), dir_fd=root_fd)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_uid != config.expected_uid
                or stat.S_IMODE(opened.st_mode) != 0o600
                or opened.st_nlink != 1
                or opened.st_dev != named.st_dev
                or opened.st_ino != named.st_ino
            ):
                raise ProgressStateError("The updater log failed its file contract.")
        finally:
            os.close(file_fd)
    finally:
        os.close(root_fd)
    return True


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProgressStateError("Progress JSON contains duplicate fields.")
        result[key] = value
    return result


def _canonical_json(record: dict[str, Any]) -> bytes:
    return (
        json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
            "ascii"
        )
        + b"\n"
    )


def _read_secure_file_at(
    directory_fd: int,
    name: str,
    *,
    expected_uid: int,
    maximum: int,
) -> SecureFile:
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        file_fd = os.open(name, flags, dir_fd=directory_fd)
    except FileNotFoundError:
        raise
    except OSError as error:
        raise ProgressStateError("A progress file could not be opened safely.") from error
    try:
        before = os.fstat(file_fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != expected_uid
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_nlink != 1
            or before.st_size < 1
            or before.st_size > maximum
        ):
            raise ProgressStateError("A progress file failed its file contract.")
        chunks: list[bytes] = []
        remaining = maximum + 1
        while remaining > 0:
            chunk = os.read(file_fd, min(4096, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        after = os.fstat(file_fd)
        try:
            named = os.lstat(name, dir_fd=directory_fd)
        except FileNotFoundError:
            raise ProgressStateError("A progress file disappeared while it was read.") from None
        if (
            len(content) > maximum
            or len(content) != after.st_size
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or named.st_dev != after.st_dev
            or named.st_ino != after.st_ino
        ):
            raise ProgressStateError("A progress file changed while it was read.")
        return SecureFile(
            content=content,
            device=after.st_dev,
            inode=after.st_ino,
            size=after.st_size,
            mtime_ns=after.st_mtime_ns,
        )
    finally:
        os.close(file_fd)


def _read_source_helper(expected_uid: int) -> bytes:
    """Read this signed helper without following or racing a filesystem alias."""

    source_path = os.path.abspath(__file__)
    source_parent = os.path.dirname(source_path)
    _validate_directory(
        source_parent,
        expected_uid=expected_uid,
        exact_mode=None,
        field="progress helper source directory",
    )
    _assert_no_symlink_components(source_path)
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        source_fd = os.open(source_path, flags)
    except OSError as error:
        raise ProgressStateError("The progress helper source could not be opened safely.") from error
    try:
        before = os.fstat(source_fd)
        source_mode = stat.S_IMODE(before.st_mode)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != expected_uid
            or before.st_nlink != 1
            or before.st_size < 1
            or before.st_size > MAX_HELPER_BYTES
            or source_mode & 0o7022
        ):
            raise ProgressStateError("The progress helper source failed its file contract.")

        chunks: list[bytes] = []
        remaining = MAX_HELPER_BYTES + 1
        while remaining > 0:
            chunk = os.read(source_fd, min(16384, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        after = os.fstat(source_fd)
        try:
            named = os.lstat(source_path)
        except FileNotFoundError:
            raise ProgressStateError(
                "The progress helper source disappeared while it was read."
            ) from None
        if (
            len(content) > MAX_HELPER_BYTES
            or len(content) != after.st_size
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or named.st_dev != after.st_dev
            or named.st_ino != after.st_ino
        ):
            raise ProgressStateError("The progress helper source changed while it was read.")
        return content
    finally:
        os.close(source_fd)


def _open_attested_directory_at(
    parent_fd: int, name: str, *, expected_uid: int
) -> int:
    if not name or "/" in name or name in {".", ".."}:
        raise ProgressStateError("An installed Portal directory name is invalid.")
    try:
        directory_fd = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=parent_fd,
        )
    except OSError as error:
        raise ProgressStateError(
            "An installed Portal directory could not be opened safely."
        ) from error
    try:
        opened = os.fstat(directory_fd)
        named = os.lstat(name, dir_fd=parent_fd)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != expected_uid
            or stat.S_IMODE(opened.st_mode) & 0o022
            or opened.st_dev != named.st_dev
            or opened.st_ino != named.st_ino
        ):
            raise ProgressStateError("An installed Portal directory is unsafe.")
        return directory_fd
    except BaseException:
        os.close(directory_fd)
        raise


def _read_attested_text_file_at(
    directory_fd: int,
    name: str,
    *,
    expected_uid: int,
    maximum: int,
) -> str:
    if not name or "/" in name or name in {".", ".."}:
        raise ProgressStateError("An installed Portal file name is invalid.")
    try:
        file_fd = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=directory_fd,
        )
    except OSError as error:
        raise ProgressStateError(
            "An installed Portal version file could not be opened safely."
        ) from error
    try:
        before = os.fstat(file_fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != expected_uid
            or stat.S_IMODE(before.st_mode) & 0o7022
            or before.st_nlink != 1
            or before.st_size < 1
            or before.st_size > maximum
        ):
            raise ProgressStateError("An installed Portal version file is unsafe.")
        chunks: list[bytes] = []
        remaining = maximum + 1
        while remaining > 0:
            chunk = os.read(file_fd, min(16384, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(file_fd)
        try:
            named = os.lstat(name, dir_fd=directory_fd)
        except FileNotFoundError:
            raise ProgressStateError(
                "An installed Portal version file disappeared while it was read."
            ) from None
        if (
            len(raw) > maximum
            or len(raw) != after.st_size
            or before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or named.st_dev != after.st_dev
            or named.st_ino != after.st_ino
            or b"\x00" in raw
        ):
            raise ProgressStateError(
                "An installed Portal version file changed while it was read."
            )
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ProgressStateError(
                "An installed Portal version file is not UTF-8 text."
            ) from error
    finally:
        os.close(file_fd)


def _attest_installed_portal_version(config: StoreConfig) -> str:
    _validate_directory(
        config.portal_root,
        expected_uid=config.expected_uid,
        exact_mode=None,
        field="installed Portal root",
    )
    try:
        portal_fd = os.open(
            config.portal_root,
            os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
    except OSError as error:
        raise ProgressStateError("The installed Portal could not be opened safely.") from error
    backend_fd: Optional[int] = None
    dist_fd: Optional[int] = None
    frontend_fd: Optional[int] = None
    installer_fd: Optional[int] = None
    try:
        portal_opened = os.fstat(portal_fd)
        portal_named = os.lstat(config.portal_root)
        if (
            not stat.S_ISDIR(portal_opened.st_mode)
            or portal_opened.st_uid != config.expected_uid
            or stat.S_IMODE(portal_opened.st_mode) & 0o022
            or portal_opened.st_dev != portal_named.st_dev
            or portal_opened.st_ino != portal_named.st_ino
        ):
            raise ProgressStateError("The installed Portal root is unsafe.")

        backend_fd = _open_attested_directory_at(
            portal_fd, "backend", expected_uid=config.expected_uid
        )
        dist_fd = _open_attested_directory_at(
            backend_fd, "dist", expected_uid=config.expected_uid
        )
        frontend_fd = _open_attested_directory_at(
            portal_fd, "frontend", expected_uid=config.expected_uid
        )
        installer_fd = _open_attested_directory_at(
            portal_fd, "installer", expected_uid=config.expected_uid
        )

        backend_package_text = _read_attested_text_file_at(
            backend_fd,
            "package.json",
            expected_uid=config.expected_uid,
            maximum=1024 * 1024,
        )
        frontend_package_text = _read_attested_text_file_at(
            frontend_fd,
            "package.json",
            expected_uid=config.expected_uid,
            maximum=1024 * 1024,
        )
        compiled_text = _read_attested_text_file_at(
            dist_fd,
            "version.js",
            expected_uid=config.expected_uid,
            maximum=1024 * 1024,
        )
        installed_text = _read_attested_text_file_at(
            installer_fd,
            "install.sh",
            expected_uid=config.expected_uid,
            maximum=4 * 1024 * 1024,
        )
        try:
            backend_package = json.loads(
                backend_package_text, object_pairs_hook=_reject_duplicate_keys
            )
            frontend_package = json.loads(
                frontend_package_text, object_pairs_hook=_reject_duplicate_keys
            )
        except json.JSONDecodeError as error:
            raise ProgressStateError(
                "An installed Portal package version is malformed."
            ) from error
        if not isinstance(backend_package, dict) or not isinstance(frontend_package, dict):
            raise ProgressStateError("An installed Portal package version is malformed.")

        compiled_matches = re.findall(
            r"\bPORTAL_VERSION\s*=\s*['\"]([^'\"]+)['\"]", compiled_text
        )
        installer_matches = re.findall(
            r"\breadonly\s+VERSION\s*=\s*['\"]([^'\"]+)['\"]", installed_text
        )
        versions = [
            backend_package.get("version"),
            frontend_package.get("version"),
            compiled_matches[0] if len(compiled_matches) == 1 else None,
            installer_matches[0] if len(installer_matches) == 1 else None,
        ]
        if (
            not all(isinstance(value, str) for value in versions)
            or len(set(versions)) != 1
            or VERSION_RE.fullmatch(versions[0]) is None
        ):
            raise ProgressStateError(
                "The installed Portal version sources do not agree exactly."
            )
        return versions[0]
    finally:
        for opened_fd in (installer_fd, frontend_fd, dist_fd, backend_fd):
            if opened_fd is not None:
                os.close(opened_fd)
        os.close(portal_fd)


def _validate_event(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != EVENT_FIELDS:
        raise ProgressStateError("A progress event has unexpected fields.")
    status_value = value["status"]
    phase = value["phase"]
    percent = value["percent"]
    if (
        not isinstance(status_value, str)
        or not isinstance(phase, str)
        or status_value not in EVENT_STATUSES
        or phase not in ALL_PHASES
    ):
        raise ProgressStateError("A progress event status or phase is unsupported.")
    _validate_phase_for_status(status_value, phase)
    if isinstance(percent, bool) or not isinstance(percent, int) or not 0 <= percent <= 99:
        raise ProgressStateError("A progress event percentage is invalid.")
    _validate_text(value["label"], field="event label", maximum=160, allow_empty=False)
    _validate_text(value["detail"], field="event detail", maximum=800, allow_empty=True)
    _validate_timestamp(value["at"], field="event timestamp")
    return value


def _validate_record(record: Any, config: StoreConfig) -> dict[str, Any]:
    if not isinstance(record, dict) or set(record) != STATE_FIELDS:
        raise ProgressStateError("Progress state fields do not match schema 1.")
    if type(record["schema"]) is not int or record["schema"] != SCHEMA:
        raise ProgressStateError("Progress state schema is unsupported.")
    _validate_operation_id(record["operationId"])
    _validate_version(record["previousVersion"], field="previousVersion")
    _validate_version(record["expectedVersion"], field="expectedVersion")

    status_value = record["status"]
    pending = record["pendingOutcome"]
    phase = record["phase"]
    percent = record["percent"]
    if (
        not isinstance(status_value, str)
        or status_value not in NONTERMINAL_STATUSES | TERMINAL_STATUSES
    ):
        raise ProgressStateError("Progress status is unsupported.")
    if pending is not None and (
        not isinstance(pending, str) or pending not in PENDING_OUTCOMES
    ):
        raise ProgressStateError("pendingOutcome is unsupported.")
    if not isinstance(phase, str) or phase not in ALL_PHASES:
        raise ProgressStateError("Progress phase is unsupported.")
    if isinstance(percent, bool) or not isinstance(percent, int) or not 0 <= percent <= 100:
        raise ProgressStateError("Progress percentage is invalid.")
    _validate_text(record["label"], field="label", maximum=160, allow_empty=False)
    _validate_text(record["detail"], field="detail", maximum=800, allow_empty=True)
    started = _validate_timestamp(record["startedAt"], field="startedAt")
    updated = _validate_timestamp(record["updatedAt"], field="updatedAt")
    if updated < started:
        raise ProgressStateError("Progress timestamps regress.")

    finished_value = record["finishedAt"]
    finished: Optional[dt.datetime] = None
    if finished_value is not None:
        finished = _validate_timestamp(finished_value, field="finishedAt")
        if finished < updated:
            raise ProgressStateError("finishedAt predates updatedAt.")

    if not isinstance(record["events"], list) or not 1 <= len(record["events"]) <= MAX_EVENTS:
        raise ProgressStateError("Progress events are outside their bounded history.")
    previous_percent = -1
    previous_time = started
    events: list[dict[str, Any]] = []
    for event_value in record["events"]:
        event = _validate_event(event_value)
        event_time = _validate_timestamp(event["at"], field="event timestamp")
        if event["percent"] < previous_percent or event_time < previous_time or event_time > updated:
            raise ProgressStateError("Progress event history is not monotonic.")
        previous_percent = event["percent"]
        previous_time = event_time
        events.append(event)

    log_file = _validate_log_path_lexical(record["logFile"], config)
    if not isinstance(record["logAvailable"], bool):
        raise ProgressStateError("logAvailable must be boolean.")

    last = events[-1]
    if status_value in NONTERMINAL_STATUSES:
        if finished is not None or percent > 99:
            raise ProgressStateError("Nonterminal progress carries terminal fields.")
        expected_public_status = (
            "running"
            if pending == "updated_with_errors"
            else "recovering"
            if pending in {"rolled_back", "recovery_required"}
            else status_value
        )
        if status_value != expected_public_status:
            raise ProgressStateError("pendingOutcome disagrees with public status.")
        if pending is not None and last["status"] != pending:
            raise ProgressStateError("pendingOutcome is not the latest durable event.")
        if pending is None:
            if status_value == "starting":
                if last["status"] != "running" or last["phase"] != "admitted":
                    raise ProgressStateError("Starting progress has an invalid admission event.")
            elif last["status"] != status_value:
                raise ProgressStateError("Public progress status disagrees with its latest event.")
        for field in ("phase", "percent", "label", "detail"):
            if record[field] != last[field]:
                raise ProgressStateError("Public progress fields disagree with the latest event.")
    else:
        if finished is None:
            raise ProgressStateError("Terminal progress is missing finishedAt.")
        if status_value == "succeeded":
            if pending is not None or phase != "complete" or percent != 100:
                raise ProgressStateError("Successful progress is not an exact terminal receipt.")
        elif status_value == "failed":
            if pending is not None:
                raise ProgressStateError("Generic failure cannot carry pendingOutcome.")
        elif pending != status_value:
            raise ProgressStateError("Terminal attention status lost its pendingOutcome.")
        if status_value != "succeeded":
            for field in ("phase", "percent", "label", "detail"):
                if record[field] != last[field]:
                    raise ProgressStateError("Failed progress lost its final event copy.")

    # Return a shallowly normalized record without ever trusting alternate keys.
    normalized = dict(record)
    normalized["events"] = events
    normalized["logFile"] = log_file
    return normalized


def _state_name(operation_id: str) -> str:
    return f"{_validate_operation_id(operation_id)}.json"


class ProgressStore:
    def __init__(
        self,
        config: StoreConfig,
        metadata_fd: int,
        metadata_identity: os.stat_result,
        directory_fd: int,
        directory_identity: os.stat_result,
    ) -> None:
        self.config = config
        self.metadata_fd = metadata_fd
        self.metadata_identity = metadata_identity
        self.directory_fd = directory_fd
        self.directory_identity = directory_identity

    def assert_identity(self) -> None:
        metadata_opened = os.fstat(self.metadata_fd)
        metadata_named = os.lstat(self.config.metadata_root)
        if (
            metadata_opened.st_dev != self.metadata_identity.st_dev
            or metadata_opened.st_ino != self.metadata_identity.st_ino
            or metadata_named.st_dev != metadata_opened.st_dev
            or metadata_named.st_ino != metadata_opened.st_ino
            or not stat.S_ISDIR(metadata_opened.st_mode)
            or metadata_opened.st_uid != self.config.expected_uid
            or stat.S_IMODE(metadata_opened.st_mode) != 0o700
        ):
            raise ProgressStateError("The installer metadata directory changed during the operation.")

        opened = os.fstat(self.directory_fd)
        named = os.lstat(STATE_DIRECTORY_NAME, dir_fd=self.metadata_fd)
        if (
            opened.st_dev != self.directory_identity.st_dev
            or opened.st_ino != self.directory_identity.st_ino
            or named.st_dev != opened.st_dev
            or named.st_ino != opened.st_ino
            or not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != self.config.expected_uid
            or stat.S_IMODE(opened.st_mode) != 0o700
        ):
            raise ProgressStateError("The progress directory changed during the operation.")

    @contextmanager
    def _locked_metadata(self) -> Iterator[None]:
        fcntl.flock(self.metadata_fd, fcntl.LOCK_EX)
        try:
            self.assert_identity()
            yield
            self.assert_identity()
        finally:
            fcntl.flock(self.metadata_fd, fcntl.LOCK_UN)

    def _transaction_journal_present(self) -> bool:
        for name in (ACTIVE_JOURNAL_NAME, CUTOVER_JOURNAL_NAME):
            try:
                os.lstat(name, dir_fd=self.metadata_fd)
            except FileNotFoundError:
                continue
            except OSError:
                return True
            return True
        return False

    def _read_file(self, name: str, maximum: int) -> SecureFile:
        return _read_secure_file_at(
            self.directory_fd,
            name,
            expected_uid=self.config.expected_uid,
            maximum=maximum,
        )

    def _read_record_file(self, operation_id: str) -> tuple[dict[str, Any], SecureFile]:
        secure = self._read_file(_state_name(operation_id), MAX_STATE_BYTES)
        try:
            parsed = json.loads(
                secure.content.decode("ascii"), object_pairs_hook=_reject_duplicate_keys
            )
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProgressStateError("Progress state JSON is malformed.") from error
        record = _validate_record(parsed, self.config)
        if record["operationId"] != operation_id or _canonical_json(record) != secure.content:
            raise ProgressStateError("Progress state is not canonical for its filename.")
        return record, secure

    def _read_pointer(self) -> tuple[Optional[str], Optional[SecureFile]]:
        try:
            secure = self._read_file(CURRENT_POINTER_NAME, MAX_POINTER_BYTES)
        except FileNotFoundError:
            return None, None
        try:
            content = secure.content.decode("ascii")
        except UnicodeDecodeError as error:
            raise ProgressStateError("The current progress pointer is malformed.") from error
        operation_id = content[:-1] if content.endswith("\n") else ""
        if content != f"{operation_id}\n" or OPERATION_ID_RE.fullmatch(operation_id) is None:
            raise ProgressStateError("The current progress pointer is malformed.")
        return operation_id, secure

    def _assert_expected_target(
        self, name: str, expected: Optional[SecureFile], *, require_absent: bool
    ) -> None:
        try:
            named = os.lstat(name, dir_fd=self.directory_fd)
        except FileNotFoundError:
            if require_absent:
                return
            raise ProgressStateError("A progress target disappeared before replacement.") from None
        if require_absent or expected is None:
            raise ProgressStateError("A progress target appeared unexpectedly.")
        if (
            not stat.S_ISREG(named.st_mode)
            or named.st_uid != self.config.expected_uid
            or stat.S_IMODE(named.st_mode) != 0o600
            or named.st_nlink != 1
            or named.st_dev != expected.device
            or named.st_ino != expected.inode
            or named.st_size != expected.size
            or named.st_mtime_ns != expected.mtime_ns
        ):
            raise ProgressStateError("A progress target changed before replacement.")

    def _atomic_replace(
        self,
        name: str,
        payload: bytes,
        *,
        expected: Optional[SecureFile],
        require_absent: bool,
    ) -> None:
        if not payload or len(payload) > MAX_STATE_BYTES:
            raise ProgressStateError("A progress payload is outside its size contract.")
        temp_name = f".dashboard-update-progress.tmp.{os.getpid()}.{secrets.token_hex(8)}"
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_CLOEXEC
            | os.O_NOFOLLOW
        )
        temp_identity: Optional[tuple[int, int]] = None
        try:
            file_fd = os.open(temp_name, flags, 0o600, dir_fd=self.directory_fd)
            try:
                os.fchmod(file_fd, 0o600)
                offset = 0
                while offset < len(payload):
                    written = os.write(file_fd, payload[offset:])
                    if written <= 0:
                        raise ProgressStateError("A progress payload could not be written.")
                    offset += written
                os.fsync(file_fd)
                details = os.fstat(file_fd)
                temp_identity = (details.st_dev, details.st_ino)
                if (
                    not stat.S_ISREG(details.st_mode)
                    or details.st_uid != self.config.expected_uid
                    or stat.S_IMODE(details.st_mode) != 0o600
                    or details.st_nlink != 1
                    or details.st_size != len(payload)
                ):
                    raise ProgressStateError("The temporary progress file is unsafe.")
            finally:
                os.close(file_fd)

            self._assert_expected_target(name, expected, require_absent=require_absent)
            os.replace(
                temp_name,
                name,
                src_dir_fd=self.directory_fd,
                dst_dir_fd=self.directory_fd,
            )
            temp_identity = None
            os.fsync(self.directory_fd)
            self.assert_identity()
        finally:
            if temp_identity is not None:
                try:
                    named = os.lstat(temp_name, dir_fd=self.directory_fd)
                    if (named.st_dev, named.st_ino) == temp_identity:
                        os.unlink(temp_name, dir_fd=self.directory_fd)
                        os.fsync(self.directory_fd)
                except FileNotFoundError:
                    pass

    def _read_stable_helper(self) -> SecureFile:
        return _read_secure_file_at(
            self.metadata_fd,
            STABLE_HELPER_NAME,
            expected_uid=self.config.expected_uid,
            maximum=MAX_HELPER_BYTES,
        )

    def _assert_expected_stable_helper(
        self, expected: Optional[SecureFile], *, require_absent: bool
    ) -> None:
        try:
            named = os.lstat(STABLE_HELPER_NAME, dir_fd=self.metadata_fd)
        except FileNotFoundError:
            if require_absent:
                return
            raise ProgressStateError(
                "The stable progress helper disappeared before replacement."
            ) from None
        if require_absent or expected is None:
            raise ProgressStateError("A stable progress helper appeared unexpectedly.")
        if (
            not stat.S_ISREG(named.st_mode)
            or named.st_uid != self.config.expected_uid
            or stat.S_IMODE(named.st_mode) != 0o600
            or named.st_nlink != 1
            or named.st_dev != expected.device
            or named.st_ino != expected.inode
            or named.st_size != expected.size
            or named.st_mtime_ns != expected.mtime_ns
        ):
            raise ProgressStateError("The stable progress helper changed before replacement.")

    def _cleanup_interrupted_bootstrap_temps(self) -> None:
        removed = False
        for name in os.listdir(self.metadata_fd):
            if BOOTSTRAP_TEMP_NAME_RE.fullmatch(name) is None:
                continue
            try:
                file_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=self.metadata_fd,
                )
            except OSError as error:
                raise ProgressStateError(
                    "An interrupted stable-helper temporary is unsafe."
                ) from error
            try:
                details = os.fstat(file_fd)
                named = os.lstat(name, dir_fd=self.metadata_fd)
                if (
                    not stat.S_ISREG(details.st_mode)
                    or details.st_uid != self.config.expected_uid
                    or stat.S_IMODE(details.st_mode) != 0o600
                    or details.st_nlink != 1
                    or details.st_size > MAX_HELPER_BYTES
                    or details.st_dev != named.st_dev
                    or details.st_ino != named.st_ino
                ):
                    raise ProgressStateError(
                        "An interrupted stable-helper temporary is unsafe."
                    )
            finally:
                os.close(file_fd)
            os.unlink(name, dir_fd=self.metadata_fd)
            removed = True
        if removed:
            os.fsync(self.metadata_fd)

    def _bootstrap_stable_helper(self) -> None:
        source = _read_source_helper(self.config.expected_uid)
        self._cleanup_interrupted_bootstrap_temps()
        try:
            expected = self._read_stable_helper()
            require_absent = False
        except FileNotFoundError:
            expected = None
            require_absent = True

        temp_name = (
            f".dashboard-update-progress.bootstrap.tmp.{os.getpid()}."
            f"{secrets.token_hex(8)}"
        )
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_CLOEXEC
            | os.O_NOFOLLOW
        )
        temp_identity: Optional[tuple[int, int]] = None
        try:
            file_fd = os.open(temp_name, flags, 0o600, dir_fd=self.metadata_fd)
            try:
                os.fchmod(file_fd, 0o600)
                offset = 0
                while offset < len(source):
                    written = os.write(file_fd, source[offset:])
                    if written <= 0:
                        raise ProgressStateError(
                            "The stable progress helper could not be written."
                        )
                    offset += written
                os.fsync(file_fd)
                details = os.fstat(file_fd)
                temp_identity = (details.st_dev, details.st_ino)
                if (
                    not stat.S_ISREG(details.st_mode)
                    or details.st_uid != self.config.expected_uid
                    or stat.S_IMODE(details.st_mode) != 0o600
                    or details.st_nlink != 1
                    or details.st_size != len(source)
                ):
                    raise ProgressStateError(
                        "The temporary stable progress helper is unsafe."
                    )
            finally:
                os.close(file_fd)

            self._assert_expected_stable_helper(
                expected, require_absent=require_absent
            )
            os.replace(
                temp_name,
                STABLE_HELPER_NAME,
                src_dir_fd=self.metadata_fd,
                dst_dir_fd=self.metadata_fd,
            )
            temp_identity = None
            os.fsync(self.metadata_fd)
            self.assert_identity()
            installed = self._read_stable_helper()
            if installed.content != source:
                raise ProgressStateError(
                    "The stable progress helper does not match its signed source."
                )
        finally:
            if temp_identity is not None:
                try:
                    named = os.lstat(temp_name, dir_fd=self.metadata_fd)
                    if (named.st_dev, named.st_ino) == temp_identity:
                        os.unlink(temp_name, dir_fd=self.metadata_fd)
                        os.fsync(self.metadata_fd)
                except FileNotFoundError:
                    pass

    def _verify_stable_helper(self) -> None:
        source = _read_source_helper(self.config.expected_uid)
        try:
            installed = self._read_stable_helper()
        except FileNotFoundError:
            raise ProgressStateError("The stable progress helper is missing.") from None
        if installed.content != source:
            raise ProgressStateError(
                "The stable progress helper does not match its signed source."
            )

    def _write_record(
        self,
        record: dict[str, Any],
        *,
        expected: Optional[SecureFile],
        require_absent: bool,
    ) -> None:
        validated = _validate_record(record, self.config)
        self._atomic_replace(
            _state_name(validated["operationId"]),
            _canonical_json(validated),
            expected=expected,
            require_absent=require_absent,
        )

    def _write_pointer(
        self,
        operation_id: str,
        *,
        expected: Optional[SecureFile],
        require_absent: bool,
    ) -> None:
        operation_id = _validate_operation_id(operation_id)
        self._atomic_replace(
            CURRENT_POINTER_NAME,
            f"{operation_id}\n".encode("ascii"),
            expected=expected,
            require_absent=require_absent,
        )

    def _cleanup_interrupted_temps(self) -> None:
        removed = False
        for name in os.listdir(self.directory_fd):
            if TEMP_NAME_RE.fullmatch(name) is None:
                continue
            try:
                file_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=self.directory_fd,
                )
            except OSError as error:
                raise ProgressStateError("An interrupted progress temporary is unsafe.") from error
            try:
                details = os.fstat(file_fd)
                named = os.lstat(name, dir_fd=self.directory_fd)
                if (
                    not stat.S_ISREG(details.st_mode)
                    or details.st_uid != self.config.expected_uid
                    or stat.S_IMODE(details.st_mode) != 0o600
                    or details.st_nlink != 1
                    or details.st_size > MAX_STATE_BYTES
                    or details.st_dev != named.st_dev
                    or details.st_ino != named.st_ino
                ):
                    raise ProgressStateError("An interrupted progress temporary is unsafe.")
            finally:
                os.close(file_fd)
            os.unlink(name, dir_fd=self.directory_fd)
            removed = True
        if removed:
            os.fsync(self.directory_fd)

    def _scan_records(self) -> dict[str, tuple[dict[str, Any], SecureFile]]:
        self._cleanup_interrupted_temps()
        records: dict[str, tuple[dict[str, Any], SecureFile]] = {}
        for name in os.listdir(self.directory_fd):
            if name == CURRENT_POINTER_NAME:
                continue
            match = STATE_NAME_RE.fullmatch(name)
            if match is None:
                raise ProgressStateError("The progress directory contains an unknown entry.")
            operation_id = match.group("operation")
            records[operation_id] = self._read_record_file(operation_id)
        return records

    def reconcile_current(
        self,
    ) -> tuple[Optional[str], Optional[dict[str, Any]], Optional[SecureFile], dict[str, tuple[dict[str, Any], SecureFile]]]:
        pointer_id, pointer_file = self._read_pointer()
        records = self._scan_records()
        if pointer_id is not None and pointer_id not in records:
            raise ProgressStateError("The current progress pointer is stale.")

        nonterminal = [
            operation_id
            for operation_id, (record, _) in records.items()
            if record["status"] in NONTERMINAL_STATUSES
        ]
        if len(nonterminal) > 1:
            raise ProgressStateError("Multiple nonterminal Dashboard updates exist.")

        if nonterminal:
            active_id = nonterminal[0]
            if pointer_id != active_id:
                # The state file is written before the pointer.  Repair only
                # this one provable interrupted-create shape; a pointer to a
                # missing record was rejected above rather than guessed away.
                self._write_pointer(
                    active_id,
                    expected=pointer_file,
                    require_absent=pointer_file is None,
                )
                pointer_id = active_id
                _, pointer_file = self._read_pointer()

        current_record = records[pointer_id][0] if pointer_id is not None else None
        return pointer_id, current_record, pointer_file, records

    def current_operation(self) -> str:
        """Return the exact current operation, repairing only provable pointer loss.

        Every helper command already holds the progress-directory flock.  The
        metadata lock also serializes this pointer repair with admission and
        finalization before anything is written to stdout.
        """

        with self._locked_metadata():
            pointer_id, current_record, _, _ = self.reconcile_current()
            if pointer_id is None or current_record is None:
                raise ProgressNoCurrentError(
                    "No current Dashboard update operation exists."
                )
            return pointer_id

    def create(
        self,
        *,
        operation_id: str,
        previous_version: str,
        target_version: str,
        log_file: str,
    ) -> None:
        with self._locked_metadata():
            if self._transaction_journal_present():
                raise ProgressAttentionError(
                    "A durable Portal update transaction requires recovery."
                )
            self._create_locked(
                operation_id=operation_id,
                previous_version=previous_version,
                target_version=target_version,
                log_file=log_file,
            )

    def _create_locked(
        self,
        *,
        operation_id: str,
        previous_version: str,
        target_version: str,
        log_file: str,
    ) -> None:
        operation_id = _validate_operation_id(operation_id)
        previous_version = _validate_version(previous_version, field="previousVersion")
        expected_version = _validate_version(target_version, field="targetVersion")
        log_file = _validate_log_path_lexical(log_file, self.config)
        log_available = _validate_log_file(log_file, self.config)

        pointer_id, current_record, pointer_file, records = self.reconcile_current()
        if (
            current_record is not None
            and current_record["status"] in BLOCKING_TERMINAL_STATUSES
        ):
            raise ProgressAttentionError(
                f"Dashboard update {pointer_id} requires operator resolution."
            )
        if current_record is not None and current_record["status"] in NONTERMINAL_STATUSES:
            if pointer_id == operation_id:
                if (
                    current_record["previousVersion"] == previous_version
                    and current_record["expectedVersion"] == expected_version
                    and current_record["logFile"] == log_file
                ):
                    self._verify_stable_helper()
                    return
                raise ProgressStateError("Idempotent create arguments changed.")
            raise ProgressBusyError(f"Dashboard update {pointer_id} is already active.")

        if operation_id in records:
            existing = records[operation_id][0]
            if (
                existing["previousVersion"] == previous_version
                and existing["expectedVersion"] == expected_version
                and existing["logFile"] == log_file
            ):
                self._verify_stable_helper()
                return
            raise ProgressStateError("The operation identifier is already bound to other data.")

        # The Portal overlay is replaced during this operation.  Install the
        # helper first so every later wrapper/installer invocation uses a
        # fixed root-only path that survives that replacement.  A failed
        # bootstrap cannot leave an accepted operation behind.
        self._bootstrap_stable_helper()

        now = _utc_now()
        event = {
            "status": "running",
            "phase": "admitted",
            "percent": 2,
            "label": "Update accepted",
            "detail": "The server owns this update operation and is preparing the signed updater.",
            "at": now,
        }
        record = {
            "schema": SCHEMA,
            "operationId": operation_id,
            "previousVersion": previous_version,
            "expectedVersion": expected_version,
            "status": "starting",
            "pendingOutcome": None,
            "phase": event["phase"],
            "percent": event["percent"],
            "label": event["label"],
            "detail": event["detail"],
            "startedAt": now,
            "updatedAt": now,
            "finishedAt": None,
            "events": [event],
            "logFile": log_file,
            "logAvailable": log_available,
        }
        self._write_record(record, expected=None, require_absent=True)
        self._write_pointer(
            operation_id,
            expected=pointer_file,
            require_absent=pointer_file is None,
        )

    def update(
        self,
        *,
        operation_id: str,
        status_value: str,
        phase: str,
        percent: int,
        label: str,
        detail: str,
    ) -> None:
        operation_id = _validate_operation_id(operation_id)
        if status_value not in UPDATE_STATUSES:
            raise ProgressStateError("The requested progress status is unsupported.")
        if not isinstance(phase, str) or phase not in ALL_PHASES:
            raise ProgressStateError("The requested progress phase is unsupported.")
        _validate_phase_for_status(status_value, phase)
        if isinstance(percent, bool) or not isinstance(percent, int) or not 0 <= percent <= 99:
            raise ProgressStateError("The requested progress percentage is invalid.")
        label = _validate_text(label, field="label", maximum=160, allow_empty=False)
        detail = _validate_text(detail, field="detail", maximum=800, allow_empty=True)

        pointer_id, current_record, _, records = self.reconcile_current()
        if pointer_id != operation_id or current_record is None:
            raise ProgressStateError("The requested operation is not current.")
        record, secure = records[operation_id]
        if record["status"] not in NONTERMINAL_STATUSES:
            raise ProgressStateError("Terminal progress cannot be updated.")
        if percent < record["percent"]:
            raise ProgressStateError("Progress percentage cannot regress.")
        if record["status"] == "recovering" and status_value not in {
            "recovering",
            "rolled_back",
            "updated_with_errors",
            "recovery_required",
        }:
            raise ProgressStateError("Recovery progress cannot return to forward execution.")

        latest = record["events"][-1]
        requested_copy = {
            "status": status_value,
            "phase": phase,
            "percent": percent,
            "label": label,
            "detail": detail,
        }
        if all(latest[field] == value for field, value in requested_copy.items()):
            return
        if record["pendingOutcome"] is not None:
            raise ProgressStateError("A pending terminal outcome cannot be replaced.")

        now = _utc_now(record["updatedAt"])
        event = {**requested_copy, "at": now}
        pending = status_value if status_value in PENDING_OUTCOMES else None
        public_status = (
            "running"
            if status_value in {"running", "updated_with_errors"}
            else "recovering"
        )
        next_record = {
            **record,
            "status": public_status,
            "pendingOutcome": pending,
            "phase": phase,
            "percent": percent,
            "label": label,
            "detail": detail,
            "updatedAt": now,
            "events": [*record["events"], event][-MAX_EVENTS:],
            "logAvailable": _validate_log_file(record["logFile"], self.config),
        }
        self._write_record(next_record, expected=secure, require_absent=False)

    def finish(self, *, operation_id: str, result: str) -> None:
        operation_id = _validate_operation_id(operation_id)
        if result not in {"succeeded", "failed"}:
            raise ProgressStateError("The wrapper result is unsupported.")
        pointer_id, current_record, _, records = self.reconcile_current()
        if pointer_id != operation_id or current_record is None:
            raise ProgressStateError("The requested operation is not current.")
        record, secure = records[operation_id]

        if record["status"] in TERMINAL_STATUSES:
            prior_result = "succeeded" if record["status"] == "succeeded" else "failed"
            if prior_result == result:
                return
            raise ProgressStateError("A terminal wrapper result cannot be changed.")

        pending = record["pendingOutcome"]
        if result == "succeeded" and pending is not None:
            raise ProgressStateError("Success contradicts a pending terminal failure.")
        if result == "succeeded" and (
            record["status"] != "running"
            or record["phase"] != "postflight"
            or record["percent"] != 99
        ):
            raise ProgressStateError(
                "Success requires the completed postflight checkpoint at 99 percent."
            )
        now = _utc_now(record["updatedAt"])
        if result == "succeeded":
            next_record = {
                **record,
                "status": "succeeded",
                "pendingOutcome": None,
                "phase": "complete",
                "percent": 100,
                "label": "Update complete",
                "detail": (
                    f"Portal v{record['expectedVersion']} finished the signed update, "
                    "exact-version health proof, and postflight work."
                ),
                "updatedAt": now,
                "finishedAt": now,
                "logAvailable": _validate_log_file(record["logFile"], self.config),
            }
        else:
            generic_failure = pending is None and record["phase"] != "failure"
            failure_label = "Updater service stopped before completion"
            failure_detail = (
                "The protected updater service ended without a completed Portal "
                "update or surviving recovery journal. Review the bounded installer log."
            )
            failure_event = {
                "status": "running",
                "phase": "failure",
                "percent": record["percent"],
                "label": failure_label,
                "detail": failure_detail,
                "at": now,
            }
            next_record = {
                **record,
                "status": pending or "failed",
                "phase": "failure" if generic_failure else record["phase"],
                "label": failure_label if generic_failure else record["label"],
                "detail": failure_detail if generic_failure else record["detail"],
                "updatedAt": now,
                "finishedAt": now,
                "events": (
                    [*record["events"], failure_event][-MAX_EVENTS:]
                    if generic_failure
                    else record["events"]
                ),
                "logAvailable": _validate_log_file(record["logFile"], self.config),
            }
        self._write_record(next_record, expected=secure, require_absent=False)

    def finalize_service(
        self, *, operation_id: str, environment: Mapping[str, str]
    ) -> None:
        operation_id = _validate_operation_id(operation_id)
        wrapper_result = _systemd_finish_result(environment)
        with self._locked_metadata():
            self._finalize_service_locked(
                operation_id=operation_id,
                wrapper_result=wrapper_result,
            )

    def _finalize_service_locked(
        self, *, operation_id: str, wrapper_result: str
    ) -> None:
        pointer_id, current_record, _, records = self.reconcile_current()
        if pointer_id != operation_id or current_record is None:
            raise ProgressStateError("The requested operation is not current.")
        record = records[operation_id][0]
        if record["status"] in TERMINAL_STATUSES:
            terminal_result = (
                wrapper_result if record["status"] == "succeeded" else "failed"
            )
            self.finish(operation_id=operation_id, result=terminal_result)
            return

        if record["pendingOutcome"] is not None:
            self.finish(operation_id=operation_id, result="failed")
            return

        pending_status: Optional[str] = None
        pending_label = ""
        pending_detail = ""
        if self._transaction_journal_present():
            pending_status = "recovery_required"
            pending_label = "Automatic recovery needs attention"
            pending_detail = (
                "The updater service stopped while a durable transaction journal "
                "still exists."
            )
            installed_version: Optional[str] = None
        else:
            try:
                installed_version = _attest_installed_portal_version(self.config)
            except ProgressStateError:
                installed_version = None

            if installed_version == record["expectedVersion"]:
                if wrapper_result == "succeeded" and (
                    record["status"] != "running"
                    or record["phase"] != "postflight"
                    or record["percent"] != 99
                ):
                    pending_status = "recovery_required"
                    pending_label = "Automatic recovery needs attention"
                    pending_detail = (
                        "The updater service exited cleanly without the exact final "
                        "postflight checkpoint."
                    )
                elif wrapper_result != "succeeded":
                    pending_status = "updated_with_errors"
                    pending_label = "Portal updated with follow-up errors"
                    pending_detail = (
                        "The target Portal is installed, but the updater service did "
                        "not complete all follow-up work."
                    )
            elif installed_version == record["previousVersion"]:
                pending_status = None
                wrapper_result = "failed"
            else:
                pending_status = "recovery_required"
                pending_label = "Automatic recovery needs attention"
                pending_detail = (
                    "The updater service stopped and the installed Portal version "
                    "could not be proven safe."
                )

        if pending_status is not None:
            pending_phase = (
                "updated-with-errors"
                if pending_status == "updated_with_errors"
                else "recovery-required"
            )
            self.update(
                operation_id=operation_id,
                status_value=pending_status,
                phase=pending_phase,
                percent=record["percent"],
                label=pending_label,
                detail=pending_detail,
            )
            self.finish(operation_id=operation_id, result="failed")
            return

        self.finish(operation_id=operation_id, result=wrapper_result)

    def fail_launch(self, *, operation_id: str) -> None:
        operation_id = _validate_operation_id(operation_id)
        with self._locked_metadata():
            pointer_id, current_record, _, records = self.reconcile_current()
            if pointer_id != operation_id or current_record is None:
                raise ProgressStateError("The requested operation is not current.")
            record = records[operation_id][0]
            latest = record["events"][-1]
            if (
                record["status"] != "starting"
                or record["pendingOutcome"] is not None
                or record["phase"] != "admitted"
                or record["percent"] != 2
                or latest["status"] != "running"
                or latest["phase"] != "admitted"
                or latest["percent"] != 2
            ):
                raise ProgressStateError(
                    "Launch failure can finalize only an unchanged admitted operation."
                )
            self.update(
                operation_id=operation_id,
                status_value="running",
                phase="failure",
                percent=2,
                label="Updater could not start",
                detail=(
                    "The durable operation was created, but its protected system "
                    "service could not be registered."
                ),
            )
            self._finalize_service_locked(
                operation_id=operation_id,
                wrapper_result="failed",
            )

    def reconcile_orphan(self, *, operation_id: str) -> None:
        operation_id = _validate_operation_id(operation_id)
        with self._locked_metadata():
            pointer_id, current_record, _, _ = self.reconcile_current()
            if pointer_id != operation_id or current_record is None:
                raise ProgressStateError("The requested operation is not current.")
            if current_record["status"] == "succeeded":
                raise ProgressStateError(
                    "A successful receipt cannot be orphan-reconciled."
                )
            if current_record["status"] in TERMINAL_STATUSES:
                # A retry after the first durable reconciliation is a strict
                # no-op. Attention resolution may subsequently remove current;
                # this command never recreates that pointer.
                self.finish(operation_id=operation_id, result="failed")
                return
            self._finalize_service_locked(
                operation_id=operation_id,
                wrapper_result="failed",
            )

    def resolve_attention(
        self, *, operation_id: str, acknowledgement: str
    ) -> None:
        operation_id = _validate_operation_id(operation_id)
        if acknowledgement != ATTENTION_ACKNOWLEDGEMENT:
            raise ProgressStateError("The operator acknowledgement phrase is not exact.")

        with self._locked_metadata():
            pointer_id, current_record, pointer_file, records = self.reconcile_current()
            if (
                pointer_id != operation_id
                or current_record is None
                or pointer_file is None
                or current_record["status"] not in BLOCKING_TERMINAL_STATUSES
            ):
                raise ProgressStateError(
                    "The requested operation is not the current attention state."
                )
            if self._transaction_journal_present():
                raise ProgressStateError(
                    "A durable Portal update transaction must be recovered first."
                )

            installed_version = _attest_installed_portal_version(self.config)
            permitted_versions = (
                {current_record["expectedVersion"]}
                if current_record["status"] == "updated_with_errors"
                else {
                    current_record["previousVersion"],
                    current_record["expectedVersion"],
                }
            )
            if installed_version not in permitted_versions:
                raise ProgressStateError(
                    "The installed Portal version does not permit attention resolution."
                )

            historical = records[operation_id][1]
            self._assert_expected_target(
                CURRENT_POINTER_NAME, pointer_file, require_absent=False
            )
            os.unlink(CURRENT_POINTER_NAME, dir_fd=self.directory_fd)
            os.fsync(self.directory_fd)
            self.assert_identity()
            pointer_after, _ = self._read_pointer()
            _, historical_after = self._read_record_file(operation_id)
            if (
                pointer_after is not None
                or historical_after.device != historical.device
                or historical_after.inode != historical.inode
                or historical_after.size != historical.size
                or historical_after.mtime_ns != historical.mtime_ns
            ):
                raise ProgressStateError(
                    "Attention resolution did not preserve its historical receipt."
                )


@contextmanager
def _open_store(config: StoreConfig, *, allow_create: bool) -> Iterator[ProgressStore]:
    _validate_directory(
        config.log_root,
        expected_uid=config.expected_uid,
        exact_mode=None,
        field="updater log root",
    )

    metadata_parent = os.path.dirname(config.metadata_root)
    metadata_name = os.path.basename(config.metadata_root)
    if os.path.join(metadata_parent, metadata_name) != config.metadata_root:
        raise ProgressStateError("The installer metadata path is not canonical.")
    _validate_directory(
        metadata_parent,
        expected_uid=config.expected_uid,
        exact_mode=None,
        field="installer metadata parent",
    )
    parent_fd: Optional[int] = None
    metadata_fd: Optional[int] = None
    directory_fd: Optional[int] = None
    try:
        parent_fd = os.open(
            metadata_parent,
            os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
        parent_opened = os.fstat(parent_fd)
        parent_named = os.lstat(metadata_parent)
        if (
            not stat.S_ISDIR(parent_opened.st_mode)
            or parent_opened.st_uid != config.expected_uid
            or stat.S_IMODE(parent_opened.st_mode) & 0o022
            or parent_opened.st_dev != parent_named.st_dev
            or parent_opened.st_ino != parent_named.st_ino
        ):
            raise ProgressStateError("The installer metadata parent is unsafe.")

        fcntl.flock(parent_fd, fcntl.LOCK_EX)
        try:
            metadata_created = False
            if allow_create:
                try:
                    os.mkdir(metadata_name, 0o700, dir_fd=parent_fd)
                    metadata_created = True
                except FileExistsError:
                    pass
            metadata_fd = os.open(
                metadata_name,
                os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
            if metadata_created:
                os.fchmod(metadata_fd, 0o700)
                os.fsync(metadata_fd)
                os.fsync(parent_fd)
            metadata_identity = os.fstat(metadata_fd)
            metadata_named = os.lstat(metadata_name, dir_fd=parent_fd)
            if (
                not stat.S_ISDIR(metadata_identity.st_mode)
                or metadata_identity.st_uid != config.expected_uid
                or stat.S_IMODE(metadata_identity.st_mode) != 0o700
                or metadata_identity.st_dev != metadata_named.st_dev
                or metadata_identity.st_ino != metadata_named.st_ino
            ):
                raise ProgressStateError("The installer metadata root is unsafe.")
        finally:
            fcntl.flock(parent_fd, fcntl.LOCK_UN)

        fcntl.flock(metadata_fd, fcntl.LOCK_EX)
        try:
            created = False
            if allow_create:
                try:
                    os.mkdir(STATE_DIRECTORY_NAME, 0o700, dir_fd=metadata_fd)
                    created = True
                except FileExistsError:
                    pass
            directory_fd = os.open(
                STATE_DIRECTORY_NAME,
                os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=metadata_fd,
            )
            if created:
                os.fchmod(directory_fd, 0o700)
                os.fsync(directory_fd)
                os.fsync(metadata_fd)
            identity = os.fstat(directory_fd)
            named = os.lstat(STATE_DIRECTORY_NAME, dir_fd=metadata_fd)
            if (
                not stat.S_ISDIR(identity.st_mode)
                or identity.st_uid != config.expected_uid
                or stat.S_IMODE(identity.st_mode) != 0o700
                or identity.st_dev != named.st_dev
                or identity.st_ino != named.st_ino
            ):
                raise ProgressStateError("The Dashboard update state directory is unsafe.")
        finally:
            fcntl.flock(metadata_fd, fcntl.LOCK_UN)

        fcntl.flock(directory_fd, fcntl.LOCK_EX)
        store = ProgressStore(
            config,
            metadata_fd,
            metadata_identity,
            directory_fd,
            identity,
        )
        store.assert_identity()
        try:
            yield store
            store.assert_identity()
        finally:
            fcntl.flock(directory_fd, fcntl.LOCK_UN)
    except OSError as error:
        raise ProgressStateError("The Dashboard update store failed safely.") from error
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        if metadata_fd is not None:
            os.close(metadata_fd)
        if parent_fd is not None:
            os.close(parent_fd)


def _store_is_provably_absent(config: StoreConfig) -> bool:
    """Distinguish a clean first-run store absence from unsafe path state."""

    _validate_directory(
        config.log_root,
        expected_uid=config.expected_uid,
        exact_mode=None,
        field="updater log root",
    )
    metadata_parent = os.path.dirname(config.metadata_root)
    _validate_directory(
        metadata_parent,
        expected_uid=config.expected_uid,
        exact_mode=None,
        field="installer metadata parent",
    )
    _assert_no_symlink_components(config.metadata_root, final_required=False)
    try:
        _validate_directory(
            config.metadata_root,
            expected_uid=config.expected_uid,
            exact_mode=0o700,
            field="installer metadata root",
        )
    except ProgressStateError:
        # Only a genuinely absent final component is a benign no-current state.
        # Any symlink, mode, owner, type, or ancestor failure remains fatal.
        try:
            os.lstat(config.metadata_root)
        except FileNotFoundError:
            return True
        raise

    _assert_no_symlink_components(config.state_root, final_required=False)
    try:
        _validate_directory(
            config.state_root,
            expected_uid=config.expected_uid,
            exact_mode=0o700,
            field="Dashboard update state directory",
        )
    except ProgressStateError:
        try:
            os.lstat(config.state_root)
        except FileNotFoundError:
            return True
        raise
    return False


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Write root-only Dashboard update progress.", allow_abbrev=False
    )
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create", allow_abbrev=False)
    create.add_argument("--operation-id", required=True)
    create.add_argument("--previous-version", required=True)
    create.add_argument("--target-version", required=True)
    create.add_argument("--log-file", required=True)

    update = commands.add_parser("update", allow_abbrev=False)
    update.add_argument("--operation-id", required=True)
    update.add_argument("--status", required=True)
    update.add_argument("--phase", required=True)
    update.add_argument("--percent", required=True, type=int)
    update.add_argument("--label", required=True)
    update.add_argument("--detail", required=True)

    finalize_service = commands.add_parser("finalize-service", allow_abbrev=False)
    finalize_service.add_argument("--operation-id", required=True)

    fail_launch = commands.add_parser("fail-launch", allow_abbrev=False)
    fail_launch.add_argument("--operation-id", required=True)

    reconcile_orphan = commands.add_parser("reconcile-orphan", allow_abbrev=False)
    reconcile_orphan.add_argument("--operation-id", required=True)

    resolve_attention = commands.add_parser("resolve-attention", allow_abbrev=False)
    resolve_attention.add_argument("--operation-id", required=True)
    resolve_attention.add_argument("--acknowledgement", required=True)

    commands.add_parser("current-operation", allow_abbrev=False)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    os.umask(0o077)
    arguments = _parser().parse_args(argv)
    try:
        config = _config_from_environment()
        if arguments.command == "current-operation" and _store_is_provably_absent(config):
            raise ProgressNoCurrentError(
                "No current Dashboard update operation exists."
            )
        with _open_store(config, allow_create=arguments.command == "create") as store:
            if arguments.command == "create":
                store.create(
                    operation_id=arguments.operation_id,
                    previous_version=arguments.previous_version,
                    target_version=arguments.target_version,
                    log_file=arguments.log_file,
                )
            elif arguments.command == "update":
                store.update(
                    operation_id=arguments.operation_id,
                    status_value=arguments.status,
                    phase=arguments.phase,
                    percent=arguments.percent,
                    label=arguments.label,
                    detail=arguments.detail,
                )
            elif arguments.command == "finalize-service":
                store.finalize_service(
                    operation_id=arguments.operation_id,
                    environment=os.environ,
                )
            elif arguments.command == "fail-launch":
                store.fail_launch(operation_id=arguments.operation_id)
            elif arguments.command == "reconcile-orphan":
                store.reconcile_orphan(operation_id=arguments.operation_id)
            elif arguments.command == "resolve-attention":
                store.resolve_attention(
                    operation_id=arguments.operation_id,
                    acknowledgement=arguments.acknowledgement,
                )
            elif arguments.command == "current-operation":
                print(store.current_operation())
            else:  # pragma: no cover - argparse owns this boundary.
                raise ProgressStateError("The progress command is unsupported.")
    except ProgressAttentionError as error:
        print(f"dashboard-update-progress: {error}", file=sys.stderr)
        return 4
    except ProgressBusyError as error:
        print(f"dashboard-update-progress: {error}", file=sys.stderr)
        return 2
    except ProgressNoCurrentError as error:
        print(f"dashboard-update-progress: {error}", file=sys.stderr)
        return 3
    except ProgressStateError as error:
        print(f"dashboard-update-progress: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
