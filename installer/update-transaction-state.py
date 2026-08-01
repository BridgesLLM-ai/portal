#!/usr/bin/env python3
"""Durable, fail-closed state for BridgesLLM Portal update transactions.

The updater runs this helper before the Portal runtime can be trusted. Keep it
dependency-free and compatible with the system Python included with every
supported Ubuntu/Debian release.

Production paths are intentionally fixed. Tests may opt into three explicit
private roots with the ``--test-*-root`` arguments. The journal contains only
bounded recovery metadata; credentials, database URLs, tokens, command output,
and free-form error text have no representation in the schema.

The helper serializes each metadata operation, but it is not the transaction
lease. The installer must hold its exclusive lifetime lock from admission
through terminal receipt removal. In particular, cutover and recovery re-fence
moves intentionally preserve phase and generation, so stale callers must be
excluded by that outer lock.
"""

from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import errno
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Optional


SCHEMA = "bridgesllm-update-transaction-v1"
PRODUCTION_METADATA_ROOT = "/var/lib/bridgesllm-installer"
PRODUCTION_TRANSACTION_ROOT = "/var/lib/bridgesllm-installer/transactions"
PRODUCTION_BACKUP_ROOT = "/opt/bridgesllm/backups/update-transactions"
PRODUCTION_STAGE_ROOT = "/opt/bridgesllm/update-staging"
ACTIVE_RECEIPT_NAME = "active-update.json"
CUTOVER_RECEIPT_NAME = "cutover-update.json"
REOPEN_INTENT_NAME = "reopen-update.json"
MAX_JOURNAL_BYTES = 16 * 1024
MAX_GENERATION = 1_000_000

TRANSACTION_ID_RE = re.compile(r"^[a-f0-9]{32}$")
VERSION_RE = re.compile(
    r"^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}"
    r"(?:[-+][A-Za-z0-9](?:[A-Za-z0-9.-]{0,62}))?$"
)
TIMESTAMP_RE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T"
    r"[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$"
)
TRANSACTION_DIR_RE = re.compile(r"^[a-f0-9]{32}$")
PAYLOAD_DIR_RE = re.compile(r"^update-[a-f0-9]{32}$")
BOOT_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
TEMP_NAME_RE = re.compile(
    r"^\.update-receipt\.tmp\.[1-9][0-9]{0,19}\.[a-f0-9]{16}\."
    r"(?P<previous>none|[a-f0-9]{64})\.(?P<candidate>[a-f0-9]{64})$"
)
LEGACY_TEMP_NAME_RE = re.compile(
    r"^\.update-receipt\.tmp\.[1-9][0-9]{0,19}\.[a-f0-9]{16}$"
)
REMOVE_NAME_RE = re.compile(
    r"^\.cutover-update\.json\.remove\.[1-9][0-9]{0,19}\.[a-f0-9]{16}$"
)
CONFLICT_NAME_RE = re.compile(
    r"^\.update-receipt\.conflict\.[1-9][0-9]{0,19}\.[a-f0-9]{16}$"
)
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# Every forward operation has an explicit write-ahead phase. Optional work is
# represented by advancing through the same pending/completed pair as a proven
# no-op; phases may never be skipped.
FORWARD_PHASES = (
    "prepared",
    "boot_block_pending",
    "boot_blocked",
    "portal_quiesce_pending",
    "portal_quiesced",
    "runtime_snapshot_pending",
    "runtime_snapshot_complete",
    "database_snapshot_pending",
    "database_snapshot_complete",
    "caddy_snapshot_pending",
    "caddy_snapshot_complete",
    "openclaw_snapshot_pending",
    "openclaw_snapshot_complete",
    "node_modules_move_pending",
    "node_modules_moved",
    "runtime_overlay_pending",
    "runtime_overlaid",
    "environment_update_pending",
    "environment_updated",
    "caddy_update_pending",
    "caddy_updated",
    "dependencies_update_pending",
    "dependencies_updated",
    "database_migration_pending",
    "database_migrated",
    "openclaw_update_pending",
    "openclaw_updated",
    "candidate_start_pending",
    "candidate_started",
    "candidate_verification_pending",
    "candidate_verified",
    "provenance_commit_pending",
    "provenance_committed",
    "cutover_pending",
    "canonical_start_pending",
    "canonical_started",
    "canonical_verification_pending",
    "canonical_verified",
    "boot_state_restore_pending",
    "boot_state_restored",
    "committed",
)

# Recovery phases are also write-ahead and resumable. There is intentionally no
# "failed" terminal: a failed recovery leaves the last pending phase in place
# so a later invocation has authoritative, idempotent work to resume.
RECOVERY_PHASES = (
    "recovery_pending",
    "recovery_quiesce_pending",
    "recovery_quiesced",
    "recovery_openclaw_restore_pending",
    "recovery_openclaw_restored",
    "recovery_database_restore_pending",
    "recovery_database_restored",
    "recovery_caddy_restore_pending",
    "recovery_caddy_restored",
    "recovery_environment_restore_pending",
    "recovery_environment_restored",
    "recovery_runtime_restore_pending",
    "recovery_runtime_restored",
    "recovery_dependencies_restore_pending",
    "recovery_dependencies_restored",
    "recovery_provenance_restore_pending",
    "recovery_provenance_restored",
    "recovery_cutover_pending",
    "recovery_service_restore_pending",
    "recovery_service_restored",
    "recovery_verify_pending",
    "recovered",
)

ALL_PHASES = frozenset((*FORWARD_PHASES, *RECOVERY_PHASES))
TERMINAL_PHASES = frozenset({"committed", "recovered"})
RECOVERY_REFENCE_PHASES = tuple(
    phase
    for phase in RECOVERY_PHASES[
        RECOVERY_PHASES.index("recovery_cutover_pending") :
    ]
    if phase != "recovered"
)

FIELD_ORDER = (
    "schema",
    "transaction_id",
    "generation",
    "phase",
    "recovery_from_phase",
    "created_at",
    "updated_at",
    "transaction_dir",
    "backup_dir",
    "stage_dir",
    "previous_version",
    "target_version",
    "release_artifact_sha256",
    "release_manifest_sha256",
    "database_system_identifier",
    "database_topology_sha256",
    "previous_main_pid",
    "baseline_boot_id",
    "previous_main_start_time",
    "portal_was_active",
    "portal_was_enabled",
    "deploy_stamp_preexisted",
    "caddy_snapshot_required",
    "node_modules_preexisted",
    "repair_reinstall",
    "openclaw_package_preexisted",
    "openclaw_package_version",
    "openclaw_runtime_version",
    "openclaw_state_preexisted",
    "openclaw_gateway_was_active",
    "openclaw_gateway_was_enabled",
    "openclaw_codex_plugin_preexisted",
    "openclaw_codex_plugin_version",
    "integrity_sha256",
)
FIELD_SET = frozenset(FIELD_ORDER)

BOOLEAN_FIELDS = frozenset(
    {
        "portal_was_active",
        "portal_was_enabled",
        "deploy_stamp_preexisted",
        "caddy_snapshot_required",
        "node_modules_preexisted",
        "repair_reinstall",
        "openclaw_package_preexisted",
        "openclaw_state_preexisted",
        "openclaw_gateway_was_active",
        "openclaw_gateway_was_enabled",
        "openclaw_codex_plugin_preexisted",
    }
)
NULLABLE_VERSION_FIELDS = frozenset(
    {
        "openclaw_package_version",
        "openclaw_runtime_version",
        "openclaw_codex_plugin_version",
    }
)

CREATE_INPUT_FIELDS = frozenset(
    {
        "transaction_id",
        "previous_version",
        "target_version",
        "release_artifact_sha256",
        "release_manifest_sha256",
        "database_system_identifier",
        "database_topology_sha256",
        "previous_main_pid",
        "baseline_boot_id",
        "previous_main_start_time",
        *BOOLEAN_FIELDS,
        *NULLABLE_VERSION_FIELDS,
    }
)

RENAME_NOREPLACE = 1
RENAME_EXCHANGE = 2


class TransactionStateError(RuntimeError):
    """Expected fail-closed journal error."""


def _load_renameat2() -> Any:
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    if function is None:
        raise TransactionStateError(
            "The host kernel/libc does not provide the required atomic rename primitive."
        )
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    function.restype = ctypes.c_int
    return function


def _renameat2(
    source_dir_fd: int,
    source_name: str,
    target_dir_fd: int,
    target_name: str,
    flags: int,
) -> None:
    function = _load_renameat2()
    result = function(
        source_dir_fd,
        os.fsencode(source_name),
        target_dir_fd,
        os.fsencode(target_name),
        flags,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))


def _now() -> str:
    return (
        dt.datetime.now(dt.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    )


def _parse_boolean(value: str) -> bool:
    if value == "true":
        return True
    if value == "false":
        return False
    raise argparse.ArgumentTypeError("expected exactly true or false")


def _validate_bounded_text(
    value: Any,
    *,
    field: str,
    maximum: int,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        raise TransactionStateError(f"{field} has the wrong type.")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise TransactionStateError(f"{field} is not valid UTF-8 text.") from error
    if (not value and not allow_empty) or len(encoded) > maximum:
        raise TransactionStateError(f"{field} is outside its allowed size.")
    if CONTROL_RE.search(value):
        raise TransactionStateError(f"{field} contains forbidden control characters.")
    return value


def _validate_version(value: Any, *, field: str) -> str:
    text = _validate_bounded_text(value, field=field, maximum=80)
    if VERSION_RE.fullmatch(text) is None:
        raise TransactionStateError(f"{field} is not a supported version identifier.")
    return text


def _canonical_absolute_path(value: Any, *, field: str) -> str:
    path = _validate_bounded_text(value, field=field, maximum=512)
    if not os.path.isabs(path) or path != os.path.normpath(path) or path == os.path.sep:
        raise TransactionStateError(f"{field} must be a canonical absolute path.")
    return path


def _assert_no_symlink_components(path: str, *, final_required: bool = True) -> None:
    current = os.path.sep
    parts = path.strip(os.path.sep).split(os.path.sep)
    for index, component in enumerate(parts):
        current = os.path.join(current, component)
        try:
            details = os.lstat(current)
        except FileNotFoundError:
            if final_required or index != len(parts) - 1:
                raise TransactionStateError("A required journal path does not exist.")
            return
        if stat.S_ISLNK(details.st_mode):
            raise TransactionStateError("A journal path crosses a symbolic link.")
        if index != len(parts) - 1 and not stat.S_ISDIR(details.st_mode):
            raise TransactionStateError("A journal path crosses a non-directory.")


def _validate_secure_directory(
    path: str,
    *,
    expected_uid: int,
    field: str,
) -> os.stat_result:
    _assert_no_symlink_components(path)
    details = os.lstat(path)
    if not stat.S_ISDIR(details.st_mode):
        raise TransactionStateError(f"{field} is not a directory.")
    if details.st_uid != expected_uid:
        raise TransactionStateError(f"{field} has an unsafe owner.")
    if stat.S_IMODE(details.st_mode) != 0o700:
        raise TransactionStateError(f"{field} must have mode 0700.")
    return details


def _fsync_secure_directory(
    path: str,
    *,
    expected_uid: int,
    field: str,
) -> None:
    expected = _validate_secure_directory(
        path, expected_uid=expected_uid, field=field
    )
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
    directory_fd = os.open(path, flags)
    try:
        opened = os.fstat(directory_fd)
        current = os.lstat(path)
        if (
            opened.st_dev != expected.st_dev
            or opened.st_ino != expected.st_ino
            or current.st_dev != opened.st_dev
            or current.st_ino != opened.st_ino
            or opened.st_uid != expected_uid
            or stat.S_IMODE(opened.st_mode) != 0o700
        ):
            raise TransactionStateError(
                f"{field} changed during durability validation."
            )
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


@dataclass(frozen=True)
class StoreConfig:
    metadata_root: str
    transaction_root: str
    backup_root: str
    stage_root: str
    expected_uid: int
    production: bool

    def validate(self) -> None:
        metadata_root = _canonical_absolute_path(
            self.metadata_root, field="metadata_root"
        )
        transaction_root = _canonical_absolute_path(
            self.transaction_root, field="transaction_root"
        )
        backup_root = _canonical_absolute_path(
            self.backup_root, field="backup_root"
        )
        stage_root = _canonical_absolute_path(self.stage_root, field="stage_root")
        if len({metadata_root, transaction_root, backup_root, stage_root}) != 4:
            raise TransactionStateError("Journal roots must be distinct.")
        _validate_secure_directory(
            metadata_root, expected_uid=self.expected_uid, field="metadata_root"
        )
        _validate_secure_directory(
            transaction_root,
            expected_uid=self.expected_uid,
            field="transaction_root",
        )
        _validate_secure_directory(
            backup_root, expected_uid=self.expected_uid, field="backup_root"
        )
        _validate_secure_directory(
            stage_root, expected_uid=self.expected_uid, field="stage_root"
        )
        if self.production:
            if os.geteuid() != 0 or self.expected_uid != 0:
                raise TransactionStateError(
                    "Production update journals require effective root."
                )
            if (
                metadata_root != PRODUCTION_METADATA_ROOT
                or transaction_root != PRODUCTION_TRANSACTION_ROOT
                or backup_root != PRODUCTION_BACKUP_ROOT
                or stage_root != PRODUCTION_STAGE_ROOT
            ):
                raise TransactionStateError("Production journal roots are fixed.")


@dataclass(frozen=True)
class SecureFile:
    content: bytes
    device: int
    inode: int
    size: int
    mtime_ns: int


def _secure_file_at(
    directory_fd: int,
    name: str,
    *,
    expected_uid: int,
) -> SecureFile:
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        file_fd = os.open(name, flags, dir_fd=directory_fd)
    except FileNotFoundError:
        raise
    except OSError as error:
        raise TransactionStateError("Journal file could not be opened safely.") from error
    try:
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode):
            raise TransactionStateError("Journal file is not regular.")
        if before.st_uid != expected_uid:
            raise TransactionStateError("Journal file has an unsafe owner.")
        if stat.S_IMODE(before.st_mode) != 0o600:
            raise TransactionStateError("Journal file must have mode 0600.")
        if before.st_nlink != 1:
            raise TransactionStateError("Journal file must have exactly one link.")
        if before.st_size < 1 or before.st_size > MAX_JOURNAL_BYTES:
            raise TransactionStateError("Journal file is outside its allowed size.")

        chunks: list[bytes] = []
        remaining = MAX_JOURNAL_BYTES + 1
        while remaining > 0:
            chunk = os.read(file_fd, min(4096, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        after = os.fstat(file_fd)
        if len(content) > MAX_JOURNAL_BYTES:
            raise TransactionStateError("Journal file is outside its allowed size.")
        if (
            before.st_dev != after.st_dev
            or before.st_ino != after.st_ino
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or len(content) != after.st_size
        ):
            raise TransactionStateError("Journal file changed while it was read.")
        return SecureFile(
            content=content,
            device=after.st_dev,
            inode=after.st_ino,
            size=after.st_size,
            mtime_ns=after.st_mtime_ns,
        )
    finally:
        os.close(file_fd)


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise TransactionStateError("Journal JSON contains duplicate fields.")
        result[key] = value
    return result


def _payload_for_integrity(record: dict[str, Any]) -> bytes:
    unsigned = {key: value for key, value in record.items() if key != "integrity_sha256"}
    return json.dumps(
        unsigned,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("ascii")


def _integrity_digest(record: dict[str, Any]) -> str:
    return hashlib.sha256(_payload_for_integrity(record)).hexdigest()


def _canonical_record_bytes(record: dict[str, Any]) -> bytes:
    return (
        json.dumps(
            record,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("ascii")
        + b"\n"
    )


def _validate_derived_directory(
    value: Any,
    *,
    root: str,
    expected_uid: int,
    field: str,
    transaction_id: str,
    payload_prefix: bool,
    allow_absent: bool = False,
) -> str:
    path = _canonical_absolute_path(value, field=field)
    root_path = _canonical_absolute_path(root, field=f"{field}_root")
    if os.path.dirname(path) != root_path:
        raise TransactionStateError(f"{field} is outside its allowlisted root.")
    basename = os.path.basename(path)
    expected_basename = (
        f"update-{transaction_id}" if payload_prefix else transaction_id
    )
    pattern = PAYLOAD_DIR_RE if payload_prefix else TRANSACTION_DIR_RE
    if pattern.fullmatch(basename) is None or basename != expected_basename:
        raise TransactionStateError(f"{field} is not bound to this transaction.")
    if allow_absent:
        # Terminal cleanup removes secret-bearing payload directories while
        # the receipt still exists, so an absent payload directory is a
        # legitimate post-cleanup state. A present one must still pass the
        # full secure-directory contract.
        _assert_no_symlink_components(path, final_required=False)
        try:
            os.lstat(path)
        except FileNotFoundError:
            return path
    _validate_secure_directory(path, expected_uid=expected_uid, field=field)
    return path


def _derived_paths(
    config: StoreConfig, transaction_id: str
) -> tuple[str, str, str]:
    return (
        os.path.join(config.transaction_root, transaction_id),
        os.path.join(config.backup_root, f"update-{transaction_id}"),
        os.path.join(config.stage_root, f"update-{transaction_id}"),
    )


def _validate_record(
    record: Any,
    *,
    config: StoreConfig,
    expected_raw: Optional[bytes] = None,
) -> dict[str, Any]:
    if not isinstance(record, dict) or set(record) != FIELD_SET:
        raise TransactionStateError("Journal schema fields do not match the fixed contract.")
    if record["schema"] != SCHEMA:
        raise TransactionStateError("Journal schema is unsupported.")

    transaction_id = _validate_bounded_text(
        record["transaction_id"], field="transaction_id", maximum=32
    )
    if TRANSACTION_ID_RE.fullmatch(transaction_id) is None:
        raise TransactionStateError("Transaction identifier is invalid.")

    generation = record["generation"]
    if (
        isinstance(generation, bool)
        or not isinstance(generation, int)
        or generation < 1
        or generation > MAX_GENERATION
    ):
        raise TransactionStateError("Journal generation is invalid.")

    phase = _validate_bounded_text(record["phase"], field="phase", maximum=64)
    if phase not in ALL_PHASES:
        raise TransactionStateError("Journal phase is unsupported.")
    recovery_from_phase = record["recovery_from_phase"]
    if phase in FORWARD_PHASES:
        if recovery_from_phase is not None:
            raise TransactionStateError(
                "Forward journal phases cannot carry recovery authority."
            )
        expected_generation = FORWARD_PHASES.index(phase) + 1
    else:
        if (
            not isinstance(recovery_from_phase, str)
            or recovery_from_phase not in FORWARD_PHASES
            or recovery_from_phase == "committed"
        ):
            raise TransactionStateError(
                "Recovery journal is missing its immutable forward origin."
            )
        expected_generation = (
            FORWARD_PHASES.index(recovery_from_phase)
            + 2
            + RECOVERY_PHASES.index(phase)
        )
    if generation != expected_generation:
        raise TransactionStateError(
            "Journal generation does not match its monotonic phase history."
        )

    created_at = _validate_bounded_text(
        record["created_at"], field="created_at", maximum=32
    )
    updated_at = _validate_bounded_text(
        record["updated_at"], field="updated_at", maximum=32
    )
    try:
        created_timestamp = dt.datetime.strptime(
            created_at, "%Y-%m-%dT%H:%M:%S.%fZ"
        )
        updated_timestamp = dt.datetime.strptime(
            updated_at, "%Y-%m-%dT%H:%M:%S.%fZ"
        )
    except ValueError as error:
        raise TransactionStateError("Journal timestamps are invalid.") from error
    if (
        TIMESTAMP_RE.fullmatch(created_at) is None
        or TIMESTAMP_RE.fullmatch(updated_at) is None
        or updated_timestamp < created_timestamp
    ):
        raise TransactionStateError("Journal timestamps are invalid.")

    for field in BOOLEAN_FIELDS:
        if not isinstance(record[field], bool):
            raise TransactionStateError(f"{field} has the wrong type.")

    _validate_version(record["previous_version"], field="previous_version")
    _validate_version(record["target_version"], field="target_version")
    for field in ("release_artifact_sha256", "release_manifest_sha256"):
        digest_value = _validate_bounded_text(
            record[field], field=field, maximum=64
        )
        if re.fullmatch(r"[a-f0-9]{64}", digest_value) is None:
            raise TransactionStateError(f"{field} is invalid.")
    database_system_identifier = _validate_bounded_text(
        record["database_system_identifier"],
        field="database_system_identifier",
        maximum=32,
    )
    if (
        re.fullmatch(r"[1-9][0-9]{0,31}", database_system_identifier) is None
    ):
        raise TransactionStateError("database_system_identifier is invalid.")
    database_topology_sha256 = _validate_bounded_text(
        record["database_topology_sha256"],
        field="database_topology_sha256",
        maximum=64,
    )
    if re.fullmatch(r"[a-f0-9]{64}", database_topology_sha256) is None:
        raise TransactionStateError("database_topology_sha256 is invalid.")
    previous_main_pid = record["previous_main_pid"]
    if (
        isinstance(previous_main_pid, bool)
        or not isinstance(previous_main_pid, int)
        or previous_main_pid < 0
        or previous_main_pid > 2_147_483_647
    ):
        raise TransactionStateError("previous_main_pid is invalid.")
    baseline_boot_id = _validate_bounded_text(
        record["baseline_boot_id"], field="baseline_boot_id", maximum=36
    )
    if BOOT_ID_RE.fullmatch(baseline_boot_id) is None:
        raise TransactionStateError("baseline_boot_id is invalid.")
    previous_main_start_time = record["previous_main_start_time"]
    if (
        isinstance(previous_main_start_time, bool)
        or not isinstance(previous_main_start_time, int)
        or previous_main_start_time < 0
        or previous_main_start_time > 9_223_372_036_854_775_807
    ):
        raise TransactionStateError("previous_main_start_time is invalid.")
    if (previous_main_start_time > 0) != (previous_main_pid > 0):
        raise TransactionStateError(
            "previous_main_start_time and previous_main_pid are inconsistent."
        )
    for field in NULLABLE_VERSION_FIELDS:
        value = record[field]
        if value is not None:
            _validate_version(value, field=field)

    if record["openclaw_package_preexisted"]:
        if (
            record["openclaw_package_version"] is None
            or record["openclaw_runtime_version"] is None
        ):
            raise TransactionStateError(
                "Pre-existing OpenClaw package/runtime versions are required."
            )
    elif (
        record["openclaw_package_version"] is not None
        or record["openclaw_runtime_version"] is not None
    ):
        raise TransactionStateError(
            "OpenClaw versions cannot be recorded for an absent package."
        )
    if not record["openclaw_package_preexisted"] and (
        record["openclaw_gateway_was_active"]
        or record["openclaw_gateway_was_enabled"]
        or record["openclaw_codex_plugin_preexisted"]
    ):
        raise TransactionStateError(
            "OpenClaw service/plugin state cannot exist without the package."
        )

    if record["openclaw_codex_plugin_preexisted"]:
        if record["openclaw_codex_plugin_version"] is None:
            raise TransactionStateError(
                "Pre-existing OpenClaw Codex plugin version is required."
            )
    elif record["openclaw_codex_plugin_version"] is not None:
        raise TransactionStateError(
            "OpenClaw Codex plugin version cannot be recorded when absent."
        )

    if record["portal_was_active"] != (record["previous_main_pid"] > 0):
        raise TransactionStateError(
            "Portal active state and previous main PID are inconsistent."
        )

    transaction_dir, backup_dir, stage_dir = _derived_paths(config, transaction_id)
    if (
        record["transaction_dir"] != transaction_dir
        or record["backup_dir"] != backup_dir
        or record["stage_dir"] != stage_dir
    ):
        raise TransactionStateError(
            "Journal paths do not match the fixed transaction layout."
        )
    _validate_derived_directory(
        record["transaction_dir"],
        root=config.transaction_root,
        expected_uid=config.expected_uid,
        field="transaction_dir",
        transaction_id=transaction_id,
        payload_prefix=False,
    )
    _validate_derived_directory(
        record["backup_dir"],
        root=config.backup_root,
        expected_uid=config.expected_uid,
        field="backup_dir",
        transaction_id=transaction_id,
        payload_prefix=True,
        allow_absent=True,
    )
    _validate_derived_directory(
        record["stage_dir"],
        root=config.stage_root,
        expected_uid=config.expected_uid,
        field="stage_dir",
        transaction_id=transaction_id,
        payload_prefix=True,
        allow_absent=True,
    )

    digest = _validate_bounded_text(
        record["integrity_sha256"], field="integrity_sha256", maximum=64
    )
    if re.fullmatch(r"[a-f0-9]{64}", digest) is None or not hmac.compare_digest(
        digest, _integrity_digest(record)
    ):
        raise TransactionStateError("Journal integrity check failed.")

    canonical = _canonical_record_bytes(record)
    if expected_raw is not None and not hmac.compare_digest(canonical, expected_raw):
        raise TransactionStateError("Journal encoding is not canonical.")
    return record


def _decode_record(raw: bytes, *, config: StoreConfig) -> dict[str, Any]:
    try:
        text = raw.decode("ascii")
        record = json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except TransactionStateError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TransactionStateError("Journal JSON is invalid.") from error
    return _validate_record(record, config=config, expected_raw=raw)


def _target_phase_is_valid(target_file: str, phase: str) -> bool:
    cutover_index = FORWARD_PHASES.index("cutover_pending")
    if target_file == "active":
        if phase in FORWARD_PHASES:
            return FORWARD_PHASES.index(phase) <= cutover_index
        if phase in RECOVERY_PHASES:
            return phase != "recovered"
        return False
    if target_file == "cutover":
        if phase in FORWARD_PHASES:
            return FORWARD_PHASES.index(phase) >= cutover_index
        if phase in RECOVERY_PHASES:
            return (
                RECOVERY_PHASES.index(phase)
                >= RECOVERY_PHASES.index("recovery_cutover_pending")
            )
        return False
    return False


def _next_phase_allowed(target_file: str, current: str, target: str) -> bool:
    if current in TERMINAL_PHASES or current == target:
        return False
    if current in FORWARD_PHASES:
        current_index = FORWARD_PHASES.index(current)
        if target == "recovery_pending" and current != "committed":
            return target_file == "active"
        adjacent = (
            current_index + 1 < len(FORWARD_PHASES)
            and FORWARD_PHASES[current_index + 1] == target
        )
        return (
            adjacent
            and _target_phase_is_valid(target_file, current)
            and _target_phase_is_valid(target_file, target)
        )
    if current in RECOVERY_PHASES:
        if current == "recovery_provenance_restored":
            return (
                target_file == "active"
                and target == "recovery_cutover_pending"
            )
        if current == "recovery_cutover_pending":
            return (
                target_file == "cutover"
                and target == "recovery_service_restore_pending"
            )
        current_index = RECOVERY_PHASES.index(current)
        adjacent = (
            current_index + 1 < len(RECOVERY_PHASES)
            and RECOVERY_PHASES[current_index + 1] == target
        )
        cutover_index = RECOVERY_PHASES.index("recovery_cutover_pending")
        required_target = "active" if current_index < cutover_index else "cutover"
        return (
            adjacent
            and target_file == required_target
            and _target_phase_is_valid(target_file, current)
            and _target_phase_is_valid(target_file, target)
        )
    return False


def _scalar_text(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _transaction_id_matches(recorded: str, provided: Any) -> bool:
    if (
        not isinstance(provided, str)
        or TRANSACTION_ID_RE.fullmatch(provided) is None
    ):
        raise TransactionStateError("Transaction identifier is invalid.")
    return hmac.compare_digest(recorded, provided)


class TransactionStateStore:
    """Atomic transaction journal store."""

    def __init__(self, config: StoreConfig) -> None:
        self.config = config

    def _before_atomic_exchange(self) -> None:
        """Test seam for proving compare-and-swap replacement behavior."""

    def _after_atomic_exchange(self) -> None:
        """Test seam for a replacement racing after an atomic exchange."""

    def _before_create_publish(self) -> None:
        """Test seam for a derived-directory race before receipt publication."""

    @staticmethod
    def _same_secure_file(left: SecureFile, right: SecureFile) -> bool:
        return (
            left.device == right.device
            and left.inode == right.inode
            and hmac.compare_digest(left.content, right.content)
        )

    @staticmethod
    def _receipt_name(target: str) -> str:
        if target == "active":
            return ACTIVE_RECEIPT_NAME
        if target == "cutover":
            return CUTOVER_RECEIPT_NAME
        raise TransactionStateError("Receipt target is unsupported.")

    @contextmanager
    def _locked_directory(self) -> Iterator[int]:
        self.config.validate()
        flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
        try:
            directory_fd = os.open(self.config.metadata_root, flags)
        except OSError as error:
            raise TransactionStateError(
                "Journal state directory could not be opened safely."
            ) from error
        try:
            details = os.fstat(directory_fd)
            if (
                not stat.S_ISDIR(details.st_mode)
                or details.st_uid != self.config.expected_uid
                or stat.S_IMODE(details.st_mode) != 0o700
            ):
                raise TransactionStateError("Journal state directory is unsafe.")
            fcntl.flock(directory_fd, fcntl.LOCK_EX)
            current = os.lstat(self.config.metadata_root)
            if current.st_dev != details.st_dev or current.st_ino != details.st_ino:
                raise TransactionStateError(
                    "Journal state directory changed while it was opened."
                )
            self._recover_remove_residue(directory_fd)
            self._recover_reopen_residue(directory_fd)
            self._assert_receipt_cardinality(directory_fd)
            self._cleanup_temp_residue(directory_fd)
            self._reject_conflict_residue(directory_fd)
            self._assert_receipt_cardinality(directory_fd)
            yield directory_fd
        finally:
            try:
                fcntl.flock(directory_fd, fcntl.LOCK_UN)
            finally:
                os.close(directory_fd)

    def _names_with_prefix(self, directory_fd: int, prefix: str) -> list[str]:
        return sorted(name for name in os.listdir(directory_fd) if name.startswith(prefix))

    def _cleanup_temp_residue(self, directory_fd: int) -> None:
        changed = False
        for name in self._names_with_prefix(directory_fd, ".update-receipt.tmp."):
            match = TEMP_NAME_RE.fullmatch(name)
            legacy = LEGACY_TEMP_NAME_RE.fullmatch(name) is not None
            if match is None and not legacy:
                raise TransactionStateError("Unsafe journal temporary residue exists.")
            temporary = _secure_file_at(
                directory_fd, name, expected_uid=self.config.expected_uid
            )
            if legacy:
                try:
                    _decode_record(temporary.content, config=self.config)
                except TransactionStateError:
                    os.unlink(name, dir_fd=directory_fd)
                    changed = True
                    continue
                self._preserve_conflict(directory_fd, name)
                changed = True
                continue

            if match is None:
                raise TransactionStateError("Journal temporary residue is invalid.")
            previous_digest = match.group("previous")
            candidate_digest = match.group("candidate")
            temporary_digest = hashlib.sha256(temporary.content).hexdigest()
            try:
                _decode_record(temporary.content, config=self.config)
                temporary_is_valid_record = True
            except TransactionStateError:
                temporary_is_valid_record = False
            receipt_names = [
                receipt_name
                for receipt_name in (
                    ACTIVE_RECEIPT_NAME,
                    CUTOVER_RECEIPT_NAME,
                )
                if self._exists_at(directory_fd, receipt_name)
            ]
            receipt_digest = None
            if len(receipt_names) == 1:
                receipt = _secure_file_at(
                    directory_fd,
                    receipt_names[0],
                    expected_uid=self.config.expected_uid,
                )
                receipt_digest = hashlib.sha256(receipt.content).hexdigest()

            safe_to_remove = False
            if previous_digest == "none":
                safe_to_remove = (
                    temporary_digest == candidate_digest
                    or not temporary_is_valid_record
                )
            elif temporary_digest == candidate_digest:
                safe_to_remove = receipt_digest is not None
            elif temporary_digest == previous_digest:
                safe_to_remove = receipt_digest == candidate_digest
            elif not temporary_is_valid_record:
                safe_to_remove = receipt_digest == previous_digest
            if not safe_to_remove:
                self._preserve_conflict(directory_fd, name)
                changed = True
                continue
            os.unlink(name, dir_fd=directory_fd)
            changed = True
        if changed:
            os.fsync(directory_fd)

    def _reject_conflict_residue(self, directory_fd: int) -> None:
        conflicts = self._names_with_prefix(
            directory_fd, ".update-receipt.conflict."
        )
        for name in conflicts:
            if CONFLICT_NAME_RE.fullmatch(name) is None:
                raise TransactionStateError(
                    "Unsafe update receipt conflict residue exists."
                )
            _secure_file_at(
                directory_fd, name, expected_uid=self.config.expected_uid
            )
        if conflicts:
            raise TransactionStateError(
                "Concurrent update receipt authorities were preserved; "
                "manual recovery is required."
            )

    def _preserve_conflict(
        self, directory_fd: int, candidate_name: str
    ) -> None:
        if not self._exists_at(directory_fd, candidate_name):
            return
        conflict_name = (
            f".update-receipt.conflict.{os.getpid()}.{secrets.token_hex(8)}"
        )
        _renameat2(
            directory_fd,
            candidate_name,
            directory_fd,
            conflict_name,
            RENAME_NOREPLACE,
        )
        os.fsync(directory_fd)

    def _rollback_exchange_or_preserve_conflict(
        self,
        directory_fd: int,
        receipt_name: str,
        candidate_name: str,
        new_receipt: SecureFile,
    ) -> bool:
        """Restore a pre-exchange receipt without deleting a later authority.

        Returns True only when the exact candidate installed by this update was
        still in the receipt slot and the prior candidate-slot authority was
        restored. Any ambiguity preserves the second authority under a durable
        conflict name and leaves the receipt slot untouched.
        """

        try:
            source = _secure_file_at(
                directory_fd,
                candidate_name,
                expected_uid=self.config.expected_uid,
            )
            installed = _secure_file_at(
                directory_fd,
                receipt_name,
                expected_uid=self.config.expected_uid,
            )
        except (OSError, TransactionStateError):
            self._preserve_conflict(directory_fd, candidate_name)
            return False
        if not self._same_secure_file(installed, new_receipt):
            self._preserve_conflict(directory_fd, candidate_name)
            return False

        _renameat2(
            directory_fd,
            candidate_name,
            directory_fd,
            receipt_name,
            RENAME_EXCHANGE,
        )
        captured = _secure_file_at(
            directory_fd,
            candidate_name,
            expected_uid=self.config.expected_uid,
        )
        restored = _secure_file_at(
            directory_fd,
            receipt_name,
            expected_uid=self.config.expected_uid,
        )
        if self._same_secure_file(captured, new_receipt) and self._same_secure_file(
            restored, source
        ):
            os.fsync(directory_fd)
            os.unlink(candidate_name, dir_fd=directory_fd)
            os.fsync(directory_fd)
            return True

        # The receipt changed between the positive check and exchange. Reverse
        # only if our source is still in the receipt slot; otherwise preserve
        # both names exactly as found.
        if self._same_secure_file(restored, source):
            _renameat2(
                directory_fd,
                candidate_name,
                directory_fd,
                receipt_name,
                RENAME_EXCHANGE,
            )
            os.fsync(directory_fd)
        self._preserve_conflict(directory_fd, candidate_name)
        return False

    def _recover_remove_residue(self, directory_fd: int) -> None:
        residues = self._names_with_prefix(
            directory_fd, ".cutover-update.json.remove."
        )
        if not residues:
            return
        if len(residues) != 1 or REMOVE_NAME_RE.fullmatch(residues[0]) is None:
            raise TransactionStateError("Ambiguous journal removal residue exists.")
        residue_name = residues[0]
        active_exists = self._exists_at(directory_fd, ACTIVE_RECEIPT_NAME)
        cutover_exists = self._exists_at(directory_fd, CUTOVER_RECEIPT_NAME)
        if not active_exists and not cutover_exists:
            residue = _secure_file_at(
                directory_fd,
                residue_name,
                expected_uid=self.config.expected_uid,
            )
            record = _decode_record(residue.content, config=self.config)
            if not _target_phase_is_valid("cutover", record["phase"]):
                raise TransactionStateError(
                    "Removal residue has an invalid cutover phase."
                )
            if record["phase"] in TERMINAL_PHASES:
                os.unlink(residue_name, dir_fd=directory_fd)
            else:
                _renameat2(
                    directory_fd,
                    residue_name,
                    directory_fd,
                    CUTOVER_RECEIPT_NAME,
                    RENAME_NOREPLACE,
                )
            os.fsync(directory_fd)
            return
        raise TransactionStateError(
            "Journal and removal residue coexist; refusing ambiguous cleanup."
        )

    @staticmethod
    def _reopen_pair_is_valid(
        old_record: dict[str, Any], recovery_record: dict[str, Any]
    ) -> bool:
        if (
            old_record["phase"] not in FORWARD_PHASES
            or FORWARD_PHASES.index(old_record["phase"])
            < FORWARD_PHASES.index("cutover_pending")
            or old_record["phase"] == "committed"
            or recovery_record["phase"] != "recovery_pending"
            or recovery_record["recovery_from_phase"] != old_record["phase"]
            or recovery_record["generation"] != old_record["generation"] + 1
            or recovery_record["created_at"] != old_record["created_at"]
            or recovery_record["updated_at"] < old_record["updated_at"]
        ):
            return False
        ignored = {
            "generation",
            "phase",
            "recovery_from_phase",
            "updated_at",
            "integrity_sha256",
        }
        return all(
            old_record[field] == recovery_record[field]
            for field in FIELD_ORDER
            if field not in ignored
        )

    def _recover_reopen_residue(self, directory_fd: int) -> None:
        if not self._exists_at(directory_fd, REOPEN_INTENT_NAME):
            return
        intent_secure = _secure_file_at(
            directory_fd,
            REOPEN_INTENT_NAME,
            expected_uid=self.config.expected_uid,
        )
        intent_record = _decode_record(intent_secure.content, config=self.config)
        active_exists = self._exists_at(directory_fd, ACTIVE_RECEIPT_NAME)
        cutover_exists = self._exists_at(directory_fd, CUTOVER_RECEIPT_NAME)
        if active_exists and cutover_exists:
            raise TransactionStateError(
                "Reopen residue coexists with both receipt slots."
            )
        if not active_exists and not cutover_exists:
            raise TransactionStateError(
                "Reopen residue exists without a transaction receipt."
            )

        if cutover_exists:
            old_secure = _secure_file_at(
                directory_fd,
                CUTOVER_RECEIPT_NAME,
                expected_uid=self.config.expected_uid,
            )
            old_record = _decode_record(old_secure.content, config=self.config)
            if not self._reopen_pair_is_valid(old_record, intent_record):
                raise TransactionStateError(
                    "Reopen intent does not match the cutover receipt."
                )
            _renameat2(
                directory_fd,
                CUTOVER_RECEIPT_NAME,
                directory_fd,
                ACTIVE_RECEIPT_NAME,
                RENAME_NOREPLACE,
            )
            os.fsync(directory_fd)
            active_exists = True
            cutover_exists = False

        active_secure = _secure_file_at(
            directory_fd,
            ACTIVE_RECEIPT_NAME,
            expected_uid=self.config.expected_uid,
        )
        active_record = _decode_record(active_secure.content, config=self.config)

        # A crash after the exchange leaves the old cutover receipt in the
        # intent slot and the recovery-pending record in the active slot.
        if self._reopen_pair_is_valid(intent_record, active_record):
            os.unlink(REOPEN_INTENT_NAME, dir_fd=directory_fd)
            os.fsync(directory_fd)
            return

        if not self._reopen_pair_is_valid(active_record, intent_record):
            raise TransactionStateError(
                "Active receipt and reopen intent do not form a valid CAS pair."
            )
        _renameat2(
            directory_fd,
            REOPEN_INTENT_NAME,
            directory_fd,
            ACTIVE_RECEIPT_NAME,
            RENAME_EXCHANGE,
        )
        exchanged = _secure_file_at(
            directory_fd,
            REOPEN_INTENT_NAME,
            expected_uid=self.config.expected_uid,
        )
        if not hmac.compare_digest(exchanged.content, active_secure.content):
            _renameat2(
                directory_fd,
                REOPEN_INTENT_NAME,
                directory_fd,
                ACTIVE_RECEIPT_NAME,
                RENAME_EXCHANGE,
            )
            os.fsync(directory_fd)
            raise TransactionStateError(
                "Active receipt changed during reopen compare-and-swap."
            )
        os.fsync(directory_fd)
        os.unlink(REOPEN_INTENT_NAME, dir_fd=directory_fd)
        os.fsync(directory_fd)

    @staticmethod
    def _exists_at(directory_fd: int, name: str) -> bool:
        try:
            os.lstat(name, dir_fd=directory_fd)
            return True
        except FileNotFoundError:
            return False

    def _assert_receipt_cardinality(self, directory_fd: int) -> None:
        if self._exists_at(
            directory_fd, ACTIVE_RECEIPT_NAME
        ) and self._exists_at(directory_fd, CUTOVER_RECEIPT_NAME):
            raise TransactionStateError(
                "Active and cutover update receipts coexist."
            )

    def _read_at(
        self, directory_fd: int, target: str
    ) -> tuple[dict[str, Any], SecureFile]:
        name = self._receipt_name(target)
        try:
            secure = _secure_file_at(
                directory_fd, name, expected_uid=self.config.expected_uid
            )
        except FileNotFoundError as error:
            raise TransactionStateError("No update transaction journal exists.") from error
        record = _decode_record(secure.content, config=self.config)
        if not _target_phase_is_valid(target, record["phase"]):
            raise TransactionStateError(
                "Receipt target and journal phase are inconsistent."
            )
        return record, secure

    def _write_candidate(
        self,
        directory_fd: int,
        content: bytes,
        *,
        previous: Optional[SecureFile] = None,
    ) -> str:
        if len(content) > MAX_JOURNAL_BYTES:
            raise TransactionStateError("Candidate journal is outside its allowed size.")
        previous_digest = (
            hashlib.sha256(previous.content).hexdigest()
            if previous is not None
            else "none"
        )
        candidate_digest = hashlib.sha256(content).hexdigest()
        name = (
            f".update-receipt.tmp.{os.getpid()}.{secrets.token_hex(8)}."
            f"{previous_digest}.{candidate_digest}"
        )
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_CLOEXEC
            | os.O_NOFOLLOW
        )
        file_fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
        try:
            details = os.fstat(file_fd)
            if (
                not stat.S_ISREG(details.st_mode)
                or details.st_uid != self.config.expected_uid
                or details.st_nlink != 1
                or stat.S_IMODE(details.st_mode) != 0o600
            ):
                raise TransactionStateError("Candidate journal file is unsafe.")
            offset = 0
            while offset < len(content):
                written = os.write(file_fd, content[offset:])
                if written <= 0:
                    raise TransactionStateError("Candidate journal write was incomplete.")
                offset += written
            os.fsync(file_fd)
        except BaseException:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except OSError:
                pass
            raise
        finally:
            os.close(file_fd)
        return name

    def create(self, fields: dict[str, Any]) -> dict[str, Any]:
        if set(fields) != CREATE_INPUT_FIELDS:
            raise TransactionStateError(
                "Create fields do not match the fixed journal input contract."
            )
        transaction_id = fields.get("transaction_id")
        if (
            not isinstance(transaction_id, str)
            or TRANSACTION_ID_RE.fullmatch(transaction_id) is None
        ):
            raise TransactionStateError("Transaction identifier is invalid.")
        transaction_dir, backup_dir, stage_dir = _derived_paths(
            self.config, transaction_id
        )
        timestamp = _now()
        record = {
            "schema": SCHEMA,
            "transaction_id": transaction_id,
            "generation": 1,
            "phase": "prepared",
            "recovery_from_phase": None,
            "created_at": timestamp,
            "updated_at": timestamp,
            "transaction_dir": transaction_dir,
            "backup_dir": backup_dir,
            "stage_dir": stage_dir,
            "previous_version": fields.get("previous_version"),
            "target_version": fields.get("target_version"),
            "release_artifact_sha256": fields.get("release_artifact_sha256"),
            "release_manifest_sha256": fields.get("release_manifest_sha256"),
            "database_system_identifier": fields.get(
                "database_system_identifier"
            ),
            "database_topology_sha256": fields.get(
                "database_topology_sha256"
            ),
            "previous_main_pid": fields.get("previous_main_pid"),
            "baseline_boot_id": fields.get("baseline_boot_id"),
            "previous_main_start_time": fields.get("previous_main_start_time"),
            "portal_was_active": fields.get("portal_was_active"),
            "portal_was_enabled": fields.get("portal_was_enabled"),
            "deploy_stamp_preexisted": fields.get("deploy_stamp_preexisted"),
            "caddy_snapshot_required": fields.get("caddy_snapshot_required"),
            "node_modules_preexisted": fields.get("node_modules_preexisted"),
            "repair_reinstall": fields.get("repair_reinstall"),
            "openclaw_package_preexisted": fields.get(
                "openclaw_package_preexisted"
            ),
            "openclaw_package_version": fields.get("openclaw_package_version"),
            "openclaw_runtime_version": fields.get("openclaw_runtime_version"),
            "openclaw_state_preexisted": fields.get(
                "openclaw_state_preexisted"
            ),
            "openclaw_gateway_was_active": fields.get(
                "openclaw_gateway_was_active"
            ),
            "openclaw_gateway_was_enabled": fields.get(
                "openclaw_gateway_was_enabled"
            ),
            "openclaw_codex_plugin_preexisted": fields.get(
                "openclaw_codex_plugin_preexisted"
            ),
            "openclaw_codex_plugin_version": fields.get(
                "openclaw_codex_plugin_version"
            ),
        }
        record["integrity_sha256"] = _integrity_digest(record)
        record = _validate_record(record, config=self.config)
        content = _canonical_record_bytes(record)

        with self._locked_directory() as directory_fd:
            self._before_create_publish()
            record = _validate_record(record, config=self.config)
            for path, field in (
                (record["transaction_dir"], "transaction_dir"),
                (record["backup_dir"], "backup_dir"),
                (record["stage_dir"], "stage_dir"),
                (self.config.transaction_root, "transaction_root"),
                (self.config.backup_root, "backup_root"),
                (self.config.stage_root, "stage_root"),
            ):
                _fsync_secure_directory(
                    path,
                    expected_uid=self.config.expected_uid,
                    field=field,
                )
            if self._exists_at(
                directory_fd, ACTIVE_RECEIPT_NAME
            ) or self._exists_at(directory_fd, CUTOVER_RECEIPT_NAME):
                raise TransactionStateError(
                    "An update transaction journal already exists."
                )
            candidate = self._write_candidate(directory_fd, content)
            try:
                _renameat2(
                    directory_fd,
                    candidate,
                    directory_fd,
                    ACTIVE_RECEIPT_NAME,
                    RENAME_NOREPLACE,
                )
                os.fsync(directory_fd)
            except BaseException:
                try:
                    os.unlink(candidate, dir_fd=directory_fd)
                except OSError:
                    pass
                raise
        return record

    def read(self, *, target: str) -> dict[str, Any]:
        with self._locked_directory() as directory_fd:
            record, _ = self._read_at(directory_fd, target)
            return record

    def update(
        self,
        *,
        target_file: str,
        transaction_id: str,
        expected_generation: int,
        expected_phase: str,
        phase: str,
    ) -> dict[str, Any]:
        with self._locked_directory() as directory_fd:
            receipt_name = self._receipt_name(target_file)
            current, secure = self._read_at(directory_fd, target_file)
            if not _transaction_id_matches(
                current["transaction_id"], transaction_id
            ):
                raise TransactionStateError("Transaction identifier mismatch.")
            if current["generation"] != expected_generation:
                raise TransactionStateError("Journal generation mismatch.")
            if current["phase"] != expected_phase:
                raise TransactionStateError("Journal phase mismatch.")
            if phase not in ALL_PHASES:
                raise TransactionStateError("Target journal phase is unsupported.")
            if not _next_phase_allowed(target_file, current["phase"], phase):
                raise TransactionStateError(
                    "Journal phase transition is not the next allowed transition."
                )
            if current["generation"] >= MAX_GENERATION:
                raise TransactionStateError("Journal generation limit reached.")

            updated = dict(current)
            updated["generation"] = current["generation"] + 1
            updated["phase"] = phase
            if phase == "recovery_pending":
                updated["recovery_from_phase"] = current["phase"]
            updated["updated_at"] = max(_now(), current["updated_at"])
            updated["integrity_sha256"] = _integrity_digest(updated)
            updated = _validate_record(updated, config=self.config)
            candidate_content = _canonical_record_bytes(updated)
            candidate = self._write_candidate(
                directory_fd,
                candidate_content,
                previous=secure,
            )
            new_receipt = _secure_file_at(
                directory_fd,
                candidate,
                expected_uid=self.config.expected_uid,
            )
            exchanged_slots = False
            try:
                self._before_atomic_exchange()
                _renameat2(
                    directory_fd,
                    candidate,
                    directory_fd,
                    receipt_name,
                    RENAME_EXCHANGE,
                )
                exchanged_slots = True
                self._after_atomic_exchange()
                exchanged = _secure_file_at(
                    directory_fd,
                    candidate,
                    expected_uid=self.config.expected_uid,
                )
                if (
                    exchanged.device != secure.device
                    or exchanged.inode != secure.inode
                    or not hmac.compare_digest(exchanged.content, secure.content)
                ):
                    raise TransactionStateError(
                        "Journal changed during compare-and-swap."
                    )
                os.fsync(directory_fd)
                os.unlink(candidate, dir_fd=directory_fd)
                exchanged_slots = False
                os.fsync(directory_fd)
            except BaseException as original_error:
                if exchanged_slots:
                    try:
                        restored = self._rollback_exchange_or_preserve_conflict(
                            directory_fd,
                            receipt_name,
                            candidate,
                            new_receipt,
                        )
                    except BaseException as rollback_error:
                        raise TransactionStateError(
                            "Journal update failed and receipt authorities "
                            "could not be safely reconciled."
                        ) from rollback_error
                    if not restored:
                        raise TransactionStateError(
                            "Concurrent receipt replacement was preserved; "
                            "manual recovery is required."
                        ) from original_error
                else:
                    try:
                        os.unlink(candidate, dir_fd=directory_fd)
                    except OSError:
                        pass
                    try:
                        os.fsync(directory_fd)
                    except OSError:
                        pass
                raise
        return updated

    def cutover(
        self,
        *,
        transaction_id: str,
        expected_generation: int,
        expected_phase: str,
    ) -> dict[str, Any]:
        if expected_phase != "cutover_pending" and (
            expected_phase not in RECOVERY_REFENCE_PHASES
        ):
            raise TransactionStateError(
                "Cutover requires an explicit cutover-pending phase."
            )
        with self._locked_directory() as directory_fd:
            if self._exists_at(directory_fd, CUTOVER_RECEIPT_NAME):
                raise TransactionStateError("A cutover receipt already exists.")
            current, secure = self._read_at(directory_fd, "active")
            if not _transaction_id_matches(
                current["transaction_id"], transaction_id
            ):
                raise TransactionStateError("Transaction identifier mismatch.")
            if current["generation"] != expected_generation:
                raise TransactionStateError("Journal generation mismatch.")
            if current["phase"] != expected_phase:
                raise TransactionStateError("Journal phase mismatch.")

            self._before_atomic_exchange()
            moved_to_cutover = False
            try:
                _renameat2(
                    directory_fd,
                    ACTIVE_RECEIPT_NAME,
                    directory_fd,
                    CUTOVER_RECEIPT_NAME,
                    RENAME_NOREPLACE,
                )
                moved_to_cutover = True
                moved = _secure_file_at(
                    directory_fd,
                    CUTOVER_RECEIPT_NAME,
                    expected_uid=self.config.expected_uid,
                )
                if (
                    moved.device != secure.device
                    or moved.inode != secure.inode
                    or not hmac.compare_digest(moved.content, secure.content)
                ):
                    raise TransactionStateError(
                        "Journal changed during cutover compare-and-swap."
                    )
                os.fsync(directory_fd)
                moved_to_cutover = False
            except BaseException as original_error:
                if moved_to_cutover:
                    try:
                        _renameat2(
                            directory_fd,
                            CUTOVER_RECEIPT_NAME,
                            directory_fd,
                            ACTIVE_RECEIPT_NAME,
                            RENAME_NOREPLACE,
                        )
                        os.fsync(directory_fd)
                    except BaseException as rollback_error:
                        raise TransactionStateError(
                            "Cutover failed and the active boot-fence receipt "
                            "could not be restored."
                        ) from rollback_error
                raise
        return current

    def reopen(
        self,
        *,
        transaction_id: str,
        expected_generation: int,
        expected_phase: str,
    ) -> dict[str, Any]:
        forward_reopen = expected_phase in FORWARD_PHASES and (
            FORWARD_PHASES.index(expected_phase)
            >= FORWARD_PHASES.index("cutover_pending")
            and expected_phase != "committed"
        )
        recovery_refence = expected_phase in RECOVERY_REFENCE_PHASES
        if not forward_reopen and not recovery_refence:
            raise TransactionStateError(
                "Reopen requires a nonterminal cutover or recovery phase."
            )
        with self._locked_directory() as directory_fd:
            if self._exists_at(directory_fd, ACTIVE_RECEIPT_NAME):
                raise TransactionStateError("An active receipt already exists.")
            current, secure = self._read_at(directory_fd, "cutover")
            if not _transaction_id_matches(
                current["transaction_id"], transaction_id
            ):
                raise TransactionStateError("Transaction identifier mismatch.")
            if current["generation"] != expected_generation:
                raise TransactionStateError("Journal generation mismatch.")
            if current["phase"] != expected_phase:
                raise TransactionStateError("Journal phase mismatch.")
            if recovery_refence:
                self._before_atomic_exchange()
                _renameat2(
                    directory_fd,
                    CUTOVER_RECEIPT_NAME,
                    directory_fd,
                    ACTIVE_RECEIPT_NAME,
                    RENAME_NOREPLACE,
                )
                try:
                    moved = _secure_file_at(
                        directory_fd,
                        ACTIVE_RECEIPT_NAME,
                        expected_uid=self.config.expected_uid,
                    )
                except BaseException:
                    # The active slot is the safer place to leave uncertain
                    # recovery authority: its presence keeps canonical Portal
                    # boot-fenced, and the next invocation re-validates it.
                    try:
                        os.fsync(directory_fd)
                    except OSError:
                        pass
                    raise
                if (
                    moved.device != secure.device
                    or moved.inode != secure.inode
                    or not hmac.compare_digest(moved.content, secure.content)
                ):
                    _renameat2(
                        directory_fd,
                        ACTIVE_RECEIPT_NAME,
                        directory_fd,
                        CUTOVER_RECEIPT_NAME,
                        RENAME_NOREPLACE,
                    )
                    os.fsync(directory_fd)
                    raise TransactionStateError(
                        "Recovery receipt changed during boot re-fence."
                    )
                os.fsync(directory_fd)
                return current
            if current["generation"] >= MAX_GENERATION:
                raise TransactionStateError("Journal generation limit reached.")

            recovery = dict(current)
            recovery["generation"] = current["generation"] + 1
            recovery["phase"] = "recovery_pending"
            recovery["recovery_from_phase"] = current["phase"]
            recovery["updated_at"] = max(_now(), current["updated_at"])
            recovery["integrity_sha256"] = _integrity_digest(recovery)
            recovery = _validate_record(recovery, config=self.config)
            candidate = self._write_candidate(
                directory_fd,
                _canonical_record_bytes(recovery),
                previous=secure,
            )
            try:
                _renameat2(
                    directory_fd,
                    candidate,
                    directory_fd,
                    REOPEN_INTENT_NAME,
                    RENAME_NOREPLACE,
                )
                os.fsync(directory_fd)
            except BaseException:
                try:
                    os.unlink(candidate, dir_fd=directory_fd)
                except OSError:
                    pass
                raise

            self._before_atomic_exchange()
            try:
                observed = _secure_file_at(
                    directory_fd,
                    CUTOVER_RECEIPT_NAME,
                    expected_uid=self.config.expected_uid,
                )
                if (
                    observed.device != secure.device
                    or observed.inode != secure.inode
                    or not hmac.compare_digest(observed.content, secure.content)
                ):
                    raise TransactionStateError(
                        "Cutover receipt changed during reopen compare-and-swap."
                    )
            except BaseException:
                if (
                    not self._exists_at(directory_fd, ACTIVE_RECEIPT_NAME)
                    and self._exists_at(directory_fd, REOPEN_INTENT_NAME)
                ):
                    os.unlink(REOPEN_INTENT_NAME, dir_fd=directory_fd)
                    os.fsync(directory_fd)
                raise

            self._recover_reopen_residue(directory_fd)
            reopened, _ = self._read_at(directory_fd, "active")
            return reopened

    def remove(
        self,
        *,
        target_file: str,
        transaction_id: str,
        expected_generation: int,
        expected_phase: str,
    ) -> dict[str, Any]:
        with self._locked_directory() as directory_fd:
            receipt_name = self._receipt_name(target_file)
            current, secure = self._read_at(directory_fd, target_file)
            if not _transaction_id_matches(
                current["transaction_id"], transaction_id
            ):
                raise TransactionStateError("Transaction identifier mismatch.")
            if current["generation"] != expected_generation:
                raise TransactionStateError("Journal generation mismatch.")
            if current["phase"] != expected_phase:
                raise TransactionStateError("Journal phase mismatch.")
            if current["phase"] not in TERMINAL_PHASES:
                raise TransactionStateError(
                    "Only a terminal transaction receipt may be removed."
                )
            if target_file != "cutover":
                raise TransactionStateError(
                    "A terminal receipt must remain in the cutover slot."
                )

            residue = (
                f".cutover-update.json.remove.{os.getpid()}.{secrets.token_hex(8)}"
            )
            moved_to_residue = False
            try:
                _renameat2(
                    directory_fd,
                    receipt_name,
                    directory_fd,
                    residue,
                    RENAME_NOREPLACE,
                )
                moved_to_residue = True
                moved = _secure_file_at(
                    directory_fd, residue, expected_uid=self.config.expected_uid
                )
                if (
                    moved.device != secure.device
                    or moved.inode != secure.inode
                    or not hmac.compare_digest(moved.content, secure.content)
                ):
                    raise TransactionStateError(
                        "Journal changed during terminal receipt removal."
                    )
                if self._exists_at(directory_fd, receipt_name):
                    raise TransactionStateError(
                        "A new receipt appeared during terminal receipt removal."
                    )
                os.fsync(directory_fd)
                os.unlink(residue, dir_fd=directory_fd)
                moved_to_residue = False
                os.fsync(directory_fd)
            except BaseException as original_error:
                if moved_to_residue:
                    try:
                        _renameat2(
                            directory_fd,
                            residue,
                            directory_fd,
                            receipt_name,
                            RENAME_NOREPLACE,
                        )
                        os.fsync(directory_fd)
                    except BaseException as rollback_error:
                        raise TransactionStateError(
                            "Terminal receipt removal failed and the receipt "
                            "could not be restored."
                        ) from rollback_error
                raise
        return {
            "removed": True,
            "schema": SCHEMA,
            "transaction_id": transaction_id,
            "generation": expected_generation,
            "phase": expected_phase,
        }


def _config_from_arguments(arguments: argparse.Namespace) -> StoreConfig:
    if arguments.test_root is not None:
        test_root = _canonical_absolute_path(
            arguments.test_root, field="test_root"
        )
        if test_root == os.path.sep:
            raise TransactionStateError("The explicit test root cannot be the filesystem root.")
        return StoreConfig(
            metadata_root=os.path.join(
                test_root, "var", "lib", "bridgesllm-installer"
            ),
            transaction_root=os.path.join(
                test_root,
                "var",
                "lib",
                "bridgesllm-installer",
                "transactions",
            ),
            backup_root=os.path.join(
                test_root,
                "opt",
                "bridgesllm",
                "backups",
                "update-transactions",
            ),
            stage_root=os.path.join(
                test_root, "opt", "bridgesllm", "update-staging"
            ),
            expected_uid=os.geteuid(),
            production=False,
        )
    return StoreConfig(
        metadata_root=PRODUCTION_METADATA_ROOT,
        transaction_root=PRODUCTION_TRANSACTION_ROOT,
        backup_root=PRODUCTION_BACKUP_ROOT,
        stage_root=PRODUCTION_STAGE_ROOT,
        expected_uid=0,
        production=True,
    )


def _add_boolean_argument(parser: argparse.ArgumentParser, name: str) -> None:
    parser.add_argument(f"--{name.replace('_', '-')}", type=_parse_boolean, required=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manage the durable BridgesLLM Portal update journal."
    )
    parser.add_argument("--test-root", help=argparse.SUPPRESS)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("--transaction-id", required=True)
    create.add_argument("--previous-version", required=True)
    create.add_argument("--target-version", required=True)
    create.add_argument("--release-artifact-sha256", required=True)
    create.add_argument("--release-manifest-sha256", required=True)
    create.add_argument("--database-system-identifier", required=True)
    create.add_argument("--database-topology-sha256", required=True)
    create.add_argument("--previous-main-pid", type=int, required=True)
    create.add_argument("--baseline-boot-id", required=True)
    create.add_argument("--previous-main-start-time", type=int, required=True)
    for field in (
        "portal_was_active",
        "portal_was_enabled",
        "deploy_stamp_preexisted",
        "caddy_snapshot_required",
        "node_modules_preexisted",
        "repair_reinstall",
        "openclaw_package_preexisted",
        "openclaw_state_preexisted",
        "openclaw_gateway_was_active",
        "openclaw_gateway_was_enabled",
        "openclaw_codex_plugin_preexisted",
    ):
        _add_boolean_argument(create, field)
    create.add_argument("--openclaw-package-version")
    create.add_argument("--openclaw-runtime-version")
    create.add_argument("--openclaw-codex-plugin-version")

    read = subparsers.add_parser("read")
    read.add_argument("--target", choices=("active", "cutover"), required=True)
    read.add_argument("--format", choices=("json", "nul"), default="json")
    read.add_argument("--field", choices=FIELD_ORDER)

    update = subparsers.add_parser("update")
    update.add_argument("--target", choices=("active", "cutover"), required=True)
    update.add_argument("--transaction-id", required=True)
    update.add_argument("--expected-generation", type=int, required=True)
    update.add_argument("--expected-phase", choices=tuple(sorted(ALL_PHASES)), required=True)
    update.add_argument("--phase", choices=tuple(sorted(ALL_PHASES)), required=True)

    cutover = subparsers.add_parser("cutover")
    cutover.add_argument("--transaction-id", required=True)
    cutover.add_argument("--expected-generation", type=int, required=True)
    cutover.add_argument(
        "--expected-phase",
        choices=("cutover_pending", *RECOVERY_REFENCE_PHASES),
        required=True,
    )

    reopen = subparsers.add_parser("reopen")
    reopen.add_argument("--transaction-id", required=True)
    reopen.add_argument("--expected-generation", type=int, required=True)
    reopen.add_argument(
        "--expected-phase",
        choices=tuple(
            phase
            for phase in FORWARD_PHASES
            if FORWARD_PHASES.index(phase)
            >= FORWARD_PHASES.index("cutover_pending")
            and phase != "committed"
        )
        + RECOVERY_REFENCE_PHASES,
        required=True,
    )

    remove = subparsers.add_parser("remove")
    remove.add_argument("--target", choices=("active", "cutover"), required=True)
    remove.add_argument("--transaction-id", required=True)
    remove.add_argument("--expected-generation", type=int, required=True)
    remove.add_argument("--expected-phase", choices=tuple(sorted(TERMINAL_PHASES)), required=True)
    return parser


def _creation_fields(arguments: argparse.Namespace) -> dict[str, Any]:
    return {
        "transaction_id": arguments.transaction_id,
        "previous_version": arguments.previous_version,
        "target_version": arguments.target_version,
        "release_artifact_sha256": arguments.release_artifact_sha256,
        "release_manifest_sha256": arguments.release_manifest_sha256,
        "database_system_identifier": arguments.database_system_identifier,
        "database_topology_sha256": arguments.database_topology_sha256,
        "previous_main_pid": arguments.previous_main_pid,
        "baseline_boot_id": arguments.baseline_boot_id,
        "previous_main_start_time": arguments.previous_main_start_time,
        "portal_was_active": arguments.portal_was_active,
        "portal_was_enabled": arguments.portal_was_enabled,
        "deploy_stamp_preexisted": arguments.deploy_stamp_preexisted,
        "caddy_snapshot_required": arguments.caddy_snapshot_required,
        "node_modules_preexisted": arguments.node_modules_preexisted,
        "repair_reinstall": arguments.repair_reinstall,
        "openclaw_package_preexisted": arguments.openclaw_package_preexisted,
        "openclaw_package_version": arguments.openclaw_package_version,
        "openclaw_runtime_version": arguments.openclaw_runtime_version,
        "openclaw_state_preexisted": arguments.openclaw_state_preexisted,
        "openclaw_gateway_was_active": arguments.openclaw_gateway_was_active,
        "openclaw_gateway_was_enabled": arguments.openclaw_gateway_was_enabled,
        "openclaw_codex_plugin_preexisted": (
            arguments.openclaw_codex_plugin_preexisted
        ),
        "openclaw_codex_plugin_version": arguments.openclaw_codex_plugin_version,
    }


def _print_record(
    record: dict[str, Any],
    *,
    output_format: str = "json",
    field: Optional[str] = None,
) -> None:
    if field is not None:
        print(_scalar_text(record[field]))
        return
    if output_format == "nul":
        output = bytearray()
        for name in FIELD_ORDER:
            output.extend(name.encode("ascii"))
            output.append(0)
            output.extend(_scalar_text(record[name]).encode("utf-8"))
            output.append(0)
        sys.stdout.buffer.write(bytes(output))
        sys.stdout.buffer.flush()
        return
    print(_canonical_record_bytes(record).decode("ascii"), end="")


def main(argv: Optional[list[str]] = None) -> int:
    parser = _build_parser()
    arguments = parser.parse_args(argv)
    try:
        store = TransactionStateStore(_config_from_arguments(arguments))
        if arguments.command == "create":
            _print_record(store.create(_creation_fields(arguments)))
        elif arguments.command == "read":
            _print_record(
                store.read(target=arguments.target),
                output_format=arguments.format,
                field=arguments.field,
            )
        elif arguments.command == "update":
            _print_record(
                store.update(
                    target_file=arguments.target,
                    transaction_id=arguments.transaction_id,
                    expected_generation=arguments.expected_generation,
                    expected_phase=arguments.expected_phase,
                    phase=arguments.phase,
                )
            )
        elif arguments.command == "cutover":
            _print_record(
                store.cutover(
                    transaction_id=arguments.transaction_id,
                    expected_generation=arguments.expected_generation,
                    expected_phase=arguments.expected_phase,
                )
            )
        elif arguments.command == "reopen":
            _print_record(
                store.reopen(
                    transaction_id=arguments.transaction_id,
                    expected_generation=arguments.expected_generation,
                    expected_phase=arguments.expected_phase,
                )
            )
        elif arguments.command == "remove":
            print(
                json.dumps(
                    store.remove(
                        target_file=arguments.target,
                        transaction_id=arguments.transaction_id,
                        expected_generation=arguments.expected_generation,
                        expected_phase=arguments.expected_phase,
                    ),
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
        else:  # pragma: no cover - argparse makes this unreachable.
            raise TransactionStateError("Unsupported journal command.")
        return 0
    except (TransactionStateError, OSError) as error:
        print(f"update-transaction-state: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
