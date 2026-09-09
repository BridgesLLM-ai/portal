#!/usr/bin/env python3
"""Durable outer transaction for the Portal-owned OpenClaw 2026.9.1 migration."""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import tarfile
import tempfile


SCHEMA = "bridgesllm-openclaw-2026.9.1-migration-transaction-v2"
DECISION_SCHEMA = "bridgesllm-openclaw-tested-pair-commit-v5"
GENERATION = re.compile(r"^[a-f0-9]{32}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
NPM_INTEGRITY = re.compile(r"^sha512-[A-Za-z0-9+/]+={0,2}$")
SHA512 = re.compile(r"^[a-f0-9]{128}$")
PACKAGE_VERSION = re.compile(r"^[0-9]{4}\.[0-9]+\.[0-9]+(?:-[0-9]+)?$")
SYSTEMD_INVOCATION_ID = re.compile(r"^[A-Fa-f0-9]{32}$")
BOOT_ID = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
)
GATEWAY_FENCE_CONTENT = (
    b'{"schema":"bridgesllm.openclaw-gateway-authorization-fence.v1",'
    b'"unit":"openclaw-gateway.service"}\n'
)
PHASES = {
    "created",
    "core-converge-pending",
    "core-converged",
    "gateway-provision-pending",
    "gateway-provisioned",
    "upgrade-prepare-pending",
    "upgrade-prepared",
    "migration-prepare-pending",
    "migration-prepared",
    "commit-pending",
    "commit-applying",
    "recovery-pending",
    "migration-restored",
    "upgrade-restored",
    "core-rollback-pending",
    "core-restored",
    "core-remove-pending",
    "core-removed",
    "restored-cleanup",
    "committed-cleanup",
}
TRANSITIONS = {
    ("core-converge-pending", "core-converged"),
    ("gateway-provisioned", "upgrade-prepare-pending"),
    ("core-converged", "upgrade-prepare-pending"),
    ("created", "upgrade-prepare-pending"),
    ("upgrade-prepare-pending", "upgrade-prepared"),
    ("upgrade-prepared", "migration-prepare-pending"),
    ("migration-prepare-pending", "migration-prepared"),
    ("migration-prepared", "commit-pending"),
    ("commit-pending", "commit-applying"),
    ("commit-applying", "committed-cleanup"),
    ("recovery-pending", "migration-restored"),
    ("migration-restored", "upgrade-restored"),
    ("upgrade-restored", "core-rollback-pending"),
    ("upgrade-restored", "core-remove-pending"),
    ("upgrade-restored", "restored-cleanup"),
    ("core-rollback-pending", "core-restored"),
    ("core-restored", "restored-cleanup"),
    ("core-remove-pending", "core-removed"),
    ("core-removed", "restored-cleanup"),
}
CODEX_PHASES = {
    "unarmed", "preparing", "rollback-ready", "install-pending",
    "forward-record-installed", "forward-attested", "recovery-pending",
    "rollback-tree-restored", "rollback-attested",
}
CODEX_TRANSITIONS = {
    ("preparing", "rollback-ready"),
    ("preparing", "forward-record-installed"),
    ("rollback-ready", "install-pending"),
    ("install-pending", "forward-record-installed"),
    ("forward-record-installed", "forward-attested"),
    ("recovery-pending", "rollback-tree-restored"),
    ("rollback-tree-restored", "rollback-attested"),
}
GATEWAY_IDENTITY_SCHEMA = "bridgesllm-openclaw-gateway-unit-identity-v1"
GATEWAY_IDENTITY_FIELDS = {
    "schema", "unit", "names", "active", "activeState", "subState", "loadState",
    "unitFileState", "needDaemonReload", "fragmentPath", "sourcePath",
    "dropInPaths", "definitionSha256", "execStart", "controlGroup", "mainPid",
    "processStartTicks", "invocationId", "execMainStartTimestampMonotonic",
}
GATEWAY_DEFINITION_FIELDS = {
    "schema", "unit", "names", "loadState", "unitFileState",
    "needDaemonReload", "fragmentPath", "sourcePath", "dropInPaths",
    "definitionSha256",
}
GATEWAY_PROVISION_PHASES = {
    "armed", "unit-published", "daemon-reloaded",
}
GATEWAY_ACTION_PURPOSES = {"forward", "baseline-restore"}
GATEWAY_UNIT_REMOVAL_PHASES = {
    "upgrade-restored", "core-restored", "core-remove-pending",
}


class ContractError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ContractError(message)


def fault(point: str) -> None:
    if (
        os.environ.get("BRIDGESLLM_INSTALLER_SOURCE_ONLY") == "1"
        and os.environ.get("PORTAL_OPENCLAW_MIGRATION_FAULT") == point
    ):
        os.kill(os.getpid(), signal.SIGKILL)


def sha256_file(target: Path) -> str:
    digest = hashlib.sha256()
    with target.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha512_file(target: Path) -> str:
    digest = hashlib.sha512()
    with target.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def duplicate_rejecting_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(target: Path, maximum: int = 4 * 1024 * 1024, *, mode: int = 0o600):
    info = safe_file(target, mode=mode, maximum=maximum)
    if info.st_size <= 0:
        fail(f"empty transaction file: {target}")
    try:
        return json.loads(
            target.read_text(encoding="utf-8"),
            object_pairs_hook=duplicate_rejecting_object,
        )
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid transaction JSON at {target}: {error}")


def safe_directory(target: Path, *, exact_mode: int | None = None):
    info = os.lstat(target)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or (exact_mode is not None and stat.S_IMODE(info.st_mode) != exact_mode)
        or (exact_mode is None and info.st_mode & 0o022)
        or target.resolve() != target
    ):
        fail(f"unsafe transaction directory: {target}")
    return info


def safe_file(target: Path, *, mode: int | None = 0o600, maximum: int = 16 * 1024 * 1024):
    info = os.lstat(target)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or (mode is not None and stat.S_IMODE(info.st_mode) != mode)
        or info.st_size > maximum
    ):
        fail(f"unsafe transaction file: {target}")
    return info


def fsync_directory(target: Path) -> None:
    descriptor = os.open(
        target,
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_absence_namespace(target: Path) -> None:
    """Force the nearest existing parent that makes target absence durable."""
    parent = target.parent
    while not os.path.lexists(parent):
        if parent == parent.parent:
            fail(f"no durable parent exists for absent path: {target}")
        parent = parent.parent
    safe_directory(parent)
    fsync_directory(parent)


def current_boot_id() -> str:
    value = None
    if os.environ.get("BRIDGESLLM_INSTALLER_SOURCE_ONLY") == "1":
        value = os.environ.get("PORTAL_OPENCLAW_MIGRATION_TEST_BOOT_ID")
    if value is None:
        try:
            value = Path("/proc/sys/kernel/random/boot_id").read_text(
                encoding="ascii",
            ).strip()
        except (OSError, UnicodeError):
            fail("current boot identity is unavailable")
    if not BOOT_ID.fullmatch(value):
        fail("current boot identity is invalid")
    return value


def attest_gateway_fence_marker(path_value: str) -> None:
    marker = Path(path_value)
    if not marker.is_absolute() or Path(os.path.normpath(marker)) != marker:
        fail("gateway fence marker path is not canonical and absolute")
    if os.environ.get("BRIDGESLLM_INSTALLER_SOURCE_ONLY") == "1":
        expected = os.environ.get("PORTAL_OPENCLAW_GATEWAY_FENCE_TEST_MARKER")
        if expected is None or marker != Path(expected):
            fail("source-only gateway fence marker is not the bound fixture")
    elif marker != Path(
        "/var/lib/bridgesllm/openclaw-gateway-authorization-fence.v1"
    ):
        fail("gateway fence marker escaped the fixed runtime authority")
    safe_file(marker, mode=0o600, maximum=4096)
    if marker.read_bytes() != GATEWAY_FENCE_CONTENT:
        fail("gateway fence marker content changed")


def atomic_json(target: Path, value) -> None:
    safe_directory(target.parent, exact_mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        temporary = None
        fsync_directory(target.parent)
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def durable_copy(source: Path, target: Path, *, maximum: int = 16 * 1024 * 1024) -> None:
    safe_file(source, mode=None, maximum=maximum)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, 0o600)
        with source.open("rb") as source_stream, os.fdopen(descriptor, "wb") as output:
            shutil.copyfileobj(source_stream, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        temporary = None
        fsync_directory(target.parent)
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def validate_gateway_unit_identity(identity, *, label: str) -> None:
    if not isinstance(identity, dict) or set(identity) != GATEWAY_IDENTITY_FIELDS:
        fail(f"{label} fields mismatch")
    bounded_strings = {
        "unit": 256,
        "names": 4096,
        "activeState": 64,
        "subState": 64,
        "loadState": 64,
        "unitFileState": 128,
        "fragmentPath": 4096,
        "sourcePath": 4096,
        "dropInPaths": 16384,
        "definitionSha256": 64,
        "execStart": 65536,
        "controlGroup": 4096,
        "invocationId": 256,
    }
    for field, maximum in bounded_strings.items():
        value = identity.get(field)
        if not isinstance(value, str) or len(value) > maximum \
                or "\x00" in value or "\n" in value or "\r" in value:
            fail(f"{label} {field} is malformed")
    if identity.get("schema") != GATEWAY_IDENTITY_SCHEMA \
            or identity["unit"] != "openclaw-gateway.service" \
            or "openclaw-gateway.service" not in identity["names"].split() \
            or identity["loadState"] != "loaded" \
            or not identity["unitFileState"] \
            or identity["needDaemonReload"] is not False \
            or not SHA256.fullmatch(identity["definitionSha256"]) \
            or not identity["execStart"] \
            or not Path(identity["fragmentPath"]).is_absolute() \
            or (identity["sourcePath"] and not Path(identity["sourcePath"]).is_absolute()) \
            or not isinstance(identity.get("active"), bool) \
            or not isinstance(identity.get("needDaemonReload"), bool) \
            or not isinstance(identity.get("mainPid"), int) \
            or identity["mainPid"] < 0 \
            or not isinstance(identity.get("processStartTicks"), int) \
            or identity["processStartTicks"] < 0 \
            or not isinstance(identity.get("execMainStartTimestampMonotonic"), int) \
            or identity["execMainStartTimestampMonotonic"] < 0:
        fail(f"{label} is malformed")
    if identity["active"]:
        if identity["activeState"] != "active" or identity["subState"] != "running" \
                or identity["mainPid"] <= 0 or identity["processStartTicks"] <= 0 \
                or identity["execMainStartTimestampMonotonic"] <= 0 \
                or not SYSTEMD_INVOCATION_ID.fullmatch(identity["invocationId"]) \
                or not identity["controlGroup"].startswith("/"):
            fail(f"{label} active process identity mismatch")
    elif identity["activeState"] not in {"inactive", "failed"} \
            or identity["mainPid"] != 0 or identity["processStartTicks"] != 0 \
            or (
                identity["invocationId"]
                and not SYSTEMD_INVOCATION_ID.fullmatch(identity["invocationId"])
            ):
        fail(f"{label} inactive process identity mismatch")


def same_gateway_unit_definition(left, right) -> bool:
    return all(left.get(field) == right.get(field) for field in GATEWAY_DEFINITION_FIELDS)


def same_gateway_unit_definition_ignoring_enablement(left, right) -> bool:
    return all(
        left.get(field) == right.get(field)
        for field in GATEWAY_DEFINITION_FIELDS - {"unitFileState"}
    )


def canonical_json_sha256(value) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_codex_binding(value, ledger: Path) -> None:
    codex = value.get("codex")
    if not isinstance(codex, dict) or set(codex) != {
        "phase", "preexisted", "mutationRequired", "target", "baseline",
        "gateway", "journal", "recoveryFrom",
    } or codex.get("phase") not in CODEX_PHASES:
        fail("Codex rollback binding mismatch")
    if codex["phase"] == "unarmed":
        if any(codex[field] is not None for field in (
            "preexisted", "mutationRequired", "target", "baseline", "gateway",
            "journal", "recoveryFrom",
        )):
            fail("unarmed Codex rollback contains authority")
        return
    target = codex.get("target")
    if not isinstance(codex.get("preexisted"), bool) \
            or not isinstance(codex.get("mutationRequired"), bool) \
            or not isinstance(target, dict) \
            or set(target) != {"package", "version", "spec", "integrity"} \
            or target.get("package") != "@openclaw/codex" \
            or not PACKAGE_VERSION.fullmatch(str(target.get("version", ""))) \
            or target.get("spec") != f"@openclaw/codex@{target.get('version')}" \
            or not NPM_INTEGRITY.fullmatch(str(target.get("integrity", ""))):
        fail("Codex target identity mismatch")
    baseline = codex.get("baseline")
    baseline_fields = {
        "packageName", "pluginVersion", "pluginSource", "pluginRoot", "installSource",
        "spec", "installPath", "installVersion", "resolvedName", "resolvedVersion",
        "resolvedSpec", "integrity",
    }
    absence_fields = {
        "kind", "pluginId", "packageName", "origin", "installedIndexAbsent",
    }
    if codex["preexisted"]:
        if not isinstance(baseline, dict) or set(baseline) != baseline_fields \
                or baseline.get("packageName") != "@openclaw/codex" \
                or baseline.get("installSource") != "npm" \
                or baseline.get("resolvedName") != "@openclaw/codex" \
                or not PACKAGE_VERSION.fullmatch(str(baseline.get("pluginVersion", ""))) \
                or any(baseline.get(field) != baseline.get("pluginVersion") for field in (
                    "installVersion", "resolvedVersion",
                )) \
                or baseline.get("resolvedSpec") \
                    != f"@openclaw/codex@{baseline.get('pluginVersion')}" \
                or baseline.get("spec") not in {
                    "@openclaw/codex", baseline.get("resolvedSpec"),
                } \
                or not NPM_INTEGRITY.fullmatch(str(baseline.get("integrity", ""))):
            fail("Codex baseline identity mismatch")
    else:
        if not isinstance(baseline, dict) or set(baseline) != absence_fields \
                or baseline != {
                    "kind": "bundled-absence",
                    "pluginId": "codex",
                    "packageName": "@openclaw/codex",
                    "origin": "bundled",
                    "installedIndexAbsent": True,
                }:
            fail("Codex bundled-absence baseline mismatch")

    gateway = codex.get("gateway")
    if not isinstance(gateway, dict) or set(gateway) != {
        "wasActive", "mainPid", "invocationId", "startMonotonic",
        "baselineUnitIdentity", "forwardStartUnitIdentity",
        "forwardUnitIdentity", "rollbackStartUnitIdentity", "rollbackUnitIdentity",
        "baselineUnitIdentitySha256", "forwardStartUnitIdentitySha256",
        "forwardUnitIdentitySha256", "rollbackStartUnitIdentitySha256",
        "rollbackUnitIdentitySha256",
        "attestedMainPid", "attestedInvocationId", "attestedStartMonotonic",
        "proofSha256",
    } or not isinstance(gateway.get("wasActive"), bool) \
            or not isinstance(gateway.get("mainPid"), int) \
            or gateway["mainPid"] < 0 \
            or not isinstance(gateway.get("invocationId"), str) \
            or len(gateway["invocationId"]) > 256 \
            or not isinstance(gateway.get("startMonotonic"), int) \
            or gateway["startMonotonic"] < 0:
        fail("Codex gateway baseline mismatch")
    if gateway["wasActive"] != (
        gateway["mainPid"] > 0
        and bool(gateway["invocationId"])
        and gateway["startMonotonic"] > 0
    ):
        fail("Codex gateway activity tuple mismatch")
    baseline_identity = gateway.get("baselineUnitIdentity")
    validate_gateway_unit_identity(
        baseline_identity, label="Codex gateway baseline identity",
    )
    if gateway.get("baselineUnitIdentitySha256") \
            != canonical_json_sha256(baseline_identity):
        fail("Codex gateway baseline identity digest mismatch")
    if baseline_identity["active"] != gateway["wasActive"] \
            or baseline_identity["mainPid"] != gateway["mainPid"] \
            or (baseline_identity["invocationId"] if gateway["wasActive"] else "") \
                != gateway["invocationId"] \
            or (
                baseline_identity["execMainStartTimestampMonotonic"]
                if gateway["wasActive"] else 0
            ) != gateway["startMonotonic"]:
        fail("Codex gateway baseline tuple and unit identity disagree")
    role_identities = {
        "forward": gateway.get("forwardUnitIdentity"),
        "rollback": gateway.get("rollbackUnitIdentity"),
    }
    start_identities = {
        "forward": gateway.get("forwardStartUnitIdentity"),
        "rollback": gateway.get("rollbackStartUnitIdentity"),
    }
    for role, identity in start_identities.items():
        identity_digest = gateway.get(f"{role}StartUnitIdentitySha256")
        if identity is None:
            if identity_digest is not None:
                fail(f"Codex gateway {role} start digest has no identity")
            continue
        validate_gateway_unit_identity(
            identity, label=f"Codex gateway {role} pre-start identity",
        )
        if identity_digest != canonical_json_sha256(identity) \
                or identity["active"] \
                or not same_gateway_unit_definition(baseline_identity, identity) \
                or not gateway["wasActive"]:
            fail(f"Codex gateway {role} pre-start authority mismatch")
    for role, identity in role_identities.items():
        identity_digest = gateway.get(f"{role}UnitIdentitySha256")
        if identity is None:
            if identity_digest is not None:
                fail(f"Codex gateway {role} identity digest has no identity")
            continue
        validate_gateway_unit_identity(
            identity, label=f"Codex gateway {role} identity",
        )
        if identity_digest != canonical_json_sha256(identity):
            fail(f"Codex gateway {role} identity digest mismatch")
        if identity["active"] != gateway["wasActive"] \
                or not same_gateway_unit_definition(baseline_identity, identity):
            fail(f"Codex gateway {role} identity changed unit definition")
        if gateway["wasActive"]:
            if start_identities[role] is None \
                    or identity["controlGroup"] != baseline_identity["controlGroup"] \
                    or identity["mainPid"] == baseline_identity["mainPid"] \
                    or identity["invocationId"] == baseline_identity["invocationId"] \
                    or identity["processStartTicks"] == baseline_identity["processStartTicks"] \
                    or identity["execMainStartTimestampMonotonic"] \
                        <= baseline_identity["execMainStartTimestampMonotonic"]:
                fail(f"Codex gateway {role} identity is not a new generation")
    forward_identity = role_identities["forward"]
    rollback_identity = role_identities["rollback"]
    if start_identities["forward"] is not None \
            and codex["phase"] in {"preparing", "rollback-ready", "install-pending"}:
        fail("Codex forward start authority appeared before disk convergence")
    if start_identities["rollback"] is not None \
            and codex["phase"] not in {"rollback-tree-restored", "rollback-attested"}:
        fail("Codex rollback start authority appeared before tree restoration")
    if codex["phase"] == "forward-attested" and forward_identity is None:
        fail("Codex forward gateway identity is missing")
    if rollback_identity is not None:
        if codex["phase"] not in {"rollback-tree-restored", "rollback-attested"}:
            fail("Codex rollback gateway identity appeared before tree restoration")
        if gateway["wasActive"] and forward_identity is not None:
            if rollback_identity["mainPid"] == forward_identity["mainPid"] \
                    or rollback_identity["invocationId"] == forward_identity["invocationId"] \
                    or rollback_identity["processStartTicks"] \
                        == forward_identity["processStartTicks"] \
                    or rollback_identity["execMainStartTimestampMonotonic"] \
                        <= forward_identity["execMainStartTimestampMonotonic"]:
                fail("Codex rollback gateway identity reused the forward generation")
    if codex["phase"] == "rollback-attested" and rollback_identity is None:
        fail("Codex rollback gateway identity is missing")
    if codex["recoveryFrom"] is not None \
            and codex["recoveryFrom"] not in CODEX_PHASES - {
                "unarmed", "recovery-pending", "rollback-tree-restored",
                "rollback-attested",
            }:
        fail("Codex recovery origin mismatch")
    attested = codex["phase"] in {"forward-attested", "rollback-attested"}
    for field in (
        "attestedMainPid", "attestedInvocationId", "attestedStartMonotonic",
        "proofSha256",
    ):
        if (gateway[field] is not None) != attested:
            fail("Codex gateway attestation phase mismatch")
    if attested:
        if not isinstance(gateway["attestedMainPid"], int) \
                or gateway["attestedMainPid"] < 0 \
                or not isinstance(gateway["attestedInvocationId"], str) \
                or not isinstance(gateway["attestedStartMonotonic"], int) \
                or gateway["attestedStartMonotonic"] < 0 \
                or not SHA256.fullmatch(str(gateway["proofSha256"])):
            fail("Codex gateway attestation is malformed")
        if gateway["wasActive"]:
            if (gateway["attestedMainPid"] <= 0
                    or not gateway["attestedInvocationId"]
                    or gateway["attestedStartMonotonic"] <= gateway["startMonotonic"]
                    or gateway["attestedMainPid"] == gateway["mainPid"]
                    or gateway["attestedInvocationId"] == gateway["invocationId"]):
                fail("Codex gateway attestation did not bind a new generation")
        elif (gateway["attestedMainPid"] != 0
                or gateway["attestedInvocationId"]
                or gateway["attestedStartMonotonic"] != 0):
                fail("inactive Codex gateway was unexpectedly activated")
        attested_identity = (
            forward_identity
            if codex["phase"] == "forward-attested"
            else rollback_identity
        )
        if attested_identity is None \
                or gateway["attestedMainPid"] != attested_identity["mainPid"] \
                or gateway["attestedInvocationId"] != (
                    attested_identity["invocationId"] if gateway["wasActive"] else ""
                ) \
                or gateway["attestedStartMonotonic"] != (
                    attested_identity["execMainStartTimestampMonotonic"]
                    if gateway["wasActive"] else 0
                ):
            fail("Codex gateway proof does not match its persisted unit identity")
        proof_name = (
            "codex-forward-gateway-proof.json"
            if codex["phase"] == "forward-attested"
            else "codex-rollback-gateway-proof.json"
        )
        proof_path = ledger.parent / proof_name
        safe_file(proof_path, mode=0o600, maximum=16 * 1024 * 1024)
        if sha256_file(proof_path) != gateway["proofSha256"]:
            fail("Codex gateway proof drift")

    journal = codex.get("journal")
    if not codex["mutationRequired"]:
        if not codex["preexisted"] or journal is not None \
                or baseline.get("pluginVersion") != target["version"] \
                or baseline.get("integrity") != target["integrity"] \
                or codex["phase"] not in {
                    "preparing", "forward-record-installed", "forward-attested",
                    "recovery-pending", "rollback-tree-restored", "rollback-attested",
                }:
            fail("Codex proof-only transaction mismatch")
        return
    journal_fields = {
        "helperPath", "helperSha256", "stateRoot", "activePath", "retiredPath",
        "managedRoot", "databasePath", "configMode", "binding",
    }
    helper = Path(value["paths"]["stablePluginsHelper"])
    codex_root = Path(value["paths"]["codexRoot"])
    state_root = codex_root / "openclaw-stable-plugins"
    if not isinstance(journal, dict) or set(journal) != journal_fields \
            or Path(str(journal.get("helperPath", ""))) != helper \
            or journal.get("helperSha256") != value["prepared"]["stablePluginsHelperSha256"] \
            or Path(str(journal.get("stateRoot", ""))) != state_root \
            or Path(str(journal.get("activePath", ""))) != state_root / "active" \
            or Path(str(journal.get("retiredPath", ""))) != state_root / "retired" \
            or journal.get("managedRoot") != "/root/.openclaw/npm" \
            or journal.get("databasePath") != "/root/.openclaw/state/openclaw.sqlite" \
            or journal.get("configMode") not in {"codex-projection", "portal-projection"}:
        fail("Codex held-journal binding mismatch")
    binding = journal.get("binding")
    if codex["phase"] == "preparing" or (
        codex["phase"] in {"recovery-pending", "rollback-tree-restored", "rollback-attested"}
        and codex["recoveryFrom"] == "preparing"
        and binding is None
    ):
        if binding is not None:
            fail("unpublished Codex journal unexpectedly contains rollback authority")
        return
    binding_fields = {
        "manifestSha512", "expectedSha512", "managedInventorySha512",
        "installedIndexSha512", "configBaselineSha512", "targetArchiveSha512",
        "baselineArchiveSha512",
    }
    if not isinstance(binding, dict) or set(binding) != binding_fields \
            or any(not SHA512.fullmatch(str(binding.get(field, ""))) for field in (
                "manifestSha512", "expectedSha512", "managedInventorySha512",
                "installedIndexSha512", "configBaselineSha512", "targetArchiveSha512",
            )) \
            or (
                codex["preexisted"]
                and not SHA512.fullmatch(str(binding.get("baselineArchiveSha512", "")))
            ) \
            or (not codex["preexisted"] and binding.get("baselineArchiveSha512") is not None):
        fail("Codex rollback-ready receipt mismatch")
    candidates = [Path(journal["activePath"]), Path(journal["retiredPath"])]
    existing = [path for path in candidates if os.path.lexists(path)]
    if len(existing) > 1:
        fail("Codex active and retired journals coexist")
    cleanup_intent = state_root / "cleanup-intent"
    if os.path.lexists(cleanup_intent):
        safe_file(cleanup_intent, mode=0o600, maximum=16 * 1024)
        intent = read_json(cleanup_intent, maximum=16 * 1024)
        if not isinstance(intent, dict) or set(intent) != {
            "schema", "decision", "transactionDevice", "transactionInode",
            "manifestSha512",
        } or intent.get("schema") \
                != "bridgesllm-openclaw-stable-plugin-cleanup-intent-v1" \
                or intent.get("decision") not in {"commit", "rolled-back"} \
                or not isinstance(intent.get("transactionDevice"), int) \
                or not isinstance(intent.get("transactionInode"), int) \
                or not SHA512.fullmatch(str(intent.get("manifestSha512", ""))) \
                or codex["phase"] not in {
                    "forward-attested", "recovery-pending",
                    "rollback-tree-restored", "rollback-attested",
                }:
            fail("Codex terminal cleanup intent mismatch")
        if intent["decision"] == "commit" and codex["phase"] != "forward-attested":
            fail("Codex commit cleanup intent appeared outside forward attestation")
        if intent["decision"] == "rolled-back" and codex["phase"] == "forward-attested":
            fail("Codex rollback cleanup intent appeared before recovery")
        if existing:
            journal_info = safe_directory(existing[0], exact_mode=0o700)
            if (journal_info.st_dev, journal_info.st_ino) != (
                intent["transactionDevice"], intent["transactionInode"],
            ):
                fail("Codex terminal cleanup journal inode changed")
        return
    if not existing:
        if codex["phase"] not in {
            "recovery-pending", "rollback-tree-restored", "rollback-attested",
            "forward-attested",
        } or value["phase"] not in {
            "commit-applying", "committed-cleanup", "recovery-pending",
            "migration-restored", "upgrade-restored", "core-rollback-pending",
            "core-restored", "core-remove-pending", "core-removed",
            "restored-cleanup",
        }:
            fail("Codex held journal disappeared before a terminal decision")
        return
    journal_dir = existing[0]
    safe_directory(journal_dir, exact_mode=0o700)
    expected_files = {
        "manifest": binding["manifestSha512"],
        "expected": binding["expectedSha512"],
        "managed-npm.previous.inventory": binding["managedInventorySha512"],
        "installed-index.previous.json": binding["installedIndexSha512"],
        "openclaw.json.previous": binding["configBaselineSha512"],
        "desired-codex.tgz": binding["targetArchiveSha512"],
    }
    if codex["preexisted"]:
        expected_files["baseline-codex.tgz"] = binding["baselineArchiveSha512"]
    for name, digest in expected_files.items():
        target_path = journal_dir / name
        safe_file(target_path, mode=None, maximum=512 * 1024 * 1024)
        if sha512_file(target_path) != digest:
            fail(f"Codex held-journal artifact drift: {name}")


def expected_paths(ledger: Path):
    root = ledger.parent
    return {
        "root": str(root),
        "ledger": str(ledger),
        "upgradeStateManifest": str(root / "upgrade-state.json"),
        "migrationManifest": str(root / "migration.json"),
        "coreRollbackPackage": str(root / "openclaw-core-rollback.tgz"),
        "gatewayUnitCandidate": str(root / "openclaw-gateway.service"),
        "migrationHelper": str(root / "migrate-openclaw-2026.9.1.mjs"),
        "transactionHelper": str(root / "openclaw-migration-transaction.py"),
        "stablePluginsHelper": str(root / "openclaw-stable-plugins.sh"),
        "codexRoot": str(root / "codex-plugin"),
        "codexForwardProof": str(root / "codex-forward-gateway-proof.json"),
        "codexRollbackProof": str(root / "codex-rollback-gateway-proof.json"),
    }


def expected_gateway_unit_path() -> Path:
    test_root = os.environ.get("PORTAL_OPENCLAW_MIGRATION_TEST_ROOT")
    if (
        os.environ.get("BRIDGESLLM_INSTALLER_SOURCE_ONLY") == "1"
        and test_root
    ):
        return Path(test_root).resolve() / "systemd" / "openclaw-gateway.service"
    return Path("/etc/systemd/system/openclaw-gateway.service")


def expected_gateway_enablement_path() -> Path:
    target = expected_gateway_unit_path()
    return target.parent / "multi-user.target.wants" / target.name


def gateway_enablement_present() -> bool:
    link = expected_gateway_enablement_path()
    if not os.path.lexists(link):
        return False
    details = os.lstat(link)
    if not stat.S_ISLNK(details.st_mode) \
            or details.st_uid != 0 or details.st_gid != 0:
        fail("gateway enablement path is not an owned symlink")
    if os.readlink(link) != str(expected_gateway_unit_path()):
        fail("gateway enablement symlink target changed")
    return True


def gateway_identity_enabled(identity) -> bool:
    return identity["unitFileState"] in {
        "enabled", "enabled-runtime", "linked", "linked-runtime", "alias",
    }


def load_ledger(ledger: Path):
    if not ledger.is_absolute() or Path(os.path.normpath(ledger)) != ledger:
        fail("transaction ledger path must be canonical and absolute")
    safe_directory(ledger.parent, exact_mode=0o700)
    value = read_json(ledger)
    if not isinstance(value, dict) or set(value) != {
        "schema", "generation", "phase", "paths", "prepared", "core", "codex", "commit",
        "createdBootId", "recoveryFrom",
    }:
        fail("transaction ledger shape mismatch")
    if value.get("schema") != SCHEMA or not GENERATION.fullmatch(str(value.get("generation", ""))):
        fail("transaction ledger identity mismatch")
    if not BOOT_ID.fullmatch(str(value.get("createdBootId", ""))):
        fail("transaction creation boot identity mismatch")
    if value.get("phase") not in PHASES:
        fail("transaction ledger phase mismatch")
    if value.get("paths") != expected_paths(ledger):
        fail("transaction path binding mismatch")
    prepared = value.get("prepared")
    core = value.get("core")
    codex = value.get("codex")
    commit = value.get("commit")
    if not isinstance(prepared, dict) or set(prepared) != {
        "upgradeStateSha256", "migrationSha256", "migrationPackageDir",
        "migrationHelperSha256", "transactionHelperSha256",
        "stablePluginsHelperSha256",
    }:
        fail("prepared fingerprint binding mismatch")
    if not isinstance(core, dict) or set(core) != {
        "packageVersion", "runtimeVersion", "rollbackSha256",
        "gatewayWasActive", "gatewayWasEnabled", "packagePreexisted",
        "stateRootPreexisted", "statePreexisted", "stateConfigPreexisted",
        "gatewayUnitPreexisted", "gatewayCommittedActive",
        "gatewayCommittedEnabled",
        "gatewayBaselineUnitIdentity", "gatewayBaselineUnitIdentitySha256",
        "gatewayProvisionUnitSha256", "gatewayProvisionPending",
        "gatewayProvisionedUnitIdentity", "gatewayProvisionedUnitIdentitySha256",
        "gatewayCurrentUnitIdentity", "gatewayCurrentUnitIdentitySha256",
        "gatewayPendingAction", "gatewayUnitAbsenceRestored",
    }:
        fail("core rollback binding mismatch")
    for field in ("packageVersion", "runtimeVersion"):
        version = core[field]
        if version is not None and not PACKAGE_VERSION.fullmatch(str(version)):
            fail(f"invalid core version binding: {field}")
    if core["rollbackSha256"] is not None \
            and not SHA256.fullmatch(str(core["rollbackSha256"])):
        fail("invalid core rollback fingerprint")
    for field in (
        "gatewayWasActive", "gatewayWasEnabled", "packagePreexisted",
        "stateRootPreexisted", "statePreexisted", "stateConfigPreexisted",
        "gatewayUnitPreexisted", "gatewayCommittedActive",
        "gatewayCommittedEnabled", "gatewayUnitAbsenceRestored",
    ):
        if not isinstance(core[field], bool):
            fail(f"invalid core gateway binding: {field}")
    baseline_gateway = core.get("gatewayBaselineUnitIdentity")
    baseline_digest = core.get("gatewayBaselineUnitIdentitySha256")
    provisioned_gateway = core.get("gatewayProvisionedUnitIdentity")
    provisioned_digest = core.get("gatewayProvisionedUnitIdentitySha256")
    current_gateway = core.get("gatewayCurrentUnitIdentity")
    current_digest = core.get("gatewayCurrentUnitIdentitySha256")
    if core["gatewayUnitPreexisted"]:
        validate_gateway_unit_identity(
            baseline_gateway, label="core gateway baseline identity",
        )
        if baseline_digest != canonical_json_sha256(baseline_gateway) \
                or baseline_gateway["active"] != core["gatewayWasActive"] \
                or gateway_identity_enabled(baseline_gateway) \
                    != core["gatewayWasEnabled"] \
                or core["gatewayCommittedActive"] != core["gatewayWasActive"] \
                or core["gatewayCommittedEnabled"] != core["gatewayWasEnabled"]:
            fail("core gateway baseline identity binding mismatch")
    elif baseline_gateway is not None or baseline_digest is not None \
            or core["gatewayWasActive"] or core["gatewayWasEnabled"] \
            or not core["gatewayCommittedActive"] \
            or not core["gatewayCommittedEnabled"]:
        fail("fresh core gateway absence binding mismatch")

    provision_sha256 = core.get("gatewayProvisionUnitSha256")
    if provision_sha256 is not None and not SHA256.fullmatch(str(provision_sha256)):
        fail("core gateway provision fingerprint mismatch")
    provision = core.get("gatewayProvisionPending")
    if provision is not None:
        if not isinstance(provision, dict) or set(provision) != {
            "phase", "unitPath", "unitSha256", "committedActive",
            "committedEnabled", "enablementPath", "enablementTarget",
            "reloadedUnitIdentity",
            "reloadedUnitIdentitySha256",
        } or provision.get("phase") not in GATEWAY_PROVISION_PHASES \
                or provision.get("unitPath") != str(expected_gateway_unit_path()) \
                or provision.get("enablementPath") \
                    != str(expected_gateway_enablement_path()) \
                or provision.get("enablementTarget") \
                    != str(expected_gateway_unit_path()) \
                or provision.get("unitSha256") != provision_sha256 \
                or provision.get("committedActive") != core["gatewayCommittedActive"] \
                or provision.get("committedEnabled") != core["gatewayCommittedEnabled"] \
                or core["gatewayUnitPreexisted"]:
            fail("core gateway provision authority mismatch")
        reloaded_identity = provision.get("reloadedUnitIdentity")
        reloaded_digest = provision.get("reloadedUnitIdentitySha256")
        if reloaded_identity is None:
            if reloaded_digest is not None \
                    or provision["phase"] == "daemon-reloaded":
                fail("core gateway reload proof is missing")
        else:
            validate_gateway_unit_identity(
                reloaded_identity, label="core gateway reloaded identity",
            )
            if reloaded_digest != canonical_json_sha256(reloaded_identity) \
                    or provision["phase"] != "daemon-reloaded" \
                    or reloaded_identity["active"] \
                    or reloaded_identity["fragmentPath"] \
                        != str(expected_gateway_unit_path()) \
                    or gateway_identity_enabled(reloaded_identity):
                fail("core gateway reload proof mismatch")
    if core["gatewayUnitPreexisted"]:
        if provision_sha256 is not None or provision is not None \
                or provisioned_gateway is not None or provisioned_digest is not None \
                or core["gatewayUnitAbsenceRestored"]:
            fail("preexisting gateway contains fresh provision authority")
    elif provisioned_gateway is not None:
        validate_gateway_unit_identity(
            provisioned_gateway, label="core gateway provisioned identity",
        )
        if provisioned_digest != canonical_json_sha256(provisioned_gateway) \
                or provisioned_gateway["active"] \
                or provisioned_gateway["fragmentPath"] \
                    != str(expected_gateway_unit_path()) \
                or gateway_identity_enabled(provisioned_gateway) \
                    != core["gatewayCommittedEnabled"]:
            fail("core gateway provisioned identity binding mismatch")
    elif provisioned_digest is not None:
        fail("core gateway provisioned digest has no identity")

    definition_authority = provisioned_gateway or baseline_gateway
    if current_gateway is None:
        if current_digest is not None or core["gatewayUnitPreexisted"] \
                or (provisioned_gateway is not None \
                    and not core["gatewayUnitAbsenceRestored"]):
            fail("core gateway current identity is unexpectedly absent")
    else:
        validate_gateway_unit_identity(
            current_gateway, label="core gateway current identity",
        )
        rollback_disabled_identity = (
            not core["gatewayUnitPreexisted"]
            and value["phase"] in GATEWAY_UNIT_REMOVAL_PHASES
            and not current_gateway["active"]
            and not gateway_identity_enabled(current_gateway)
            and not gateway_enablement_present()
            and definition_authority is not None
            and same_gateway_unit_definition_ignoring_enablement(
                definition_authority, current_gateway,
            )
        )
        if current_digest != canonical_json_sha256(current_gateway) \
                or definition_authority is None \
                or not (
                    same_gateway_unit_definition(definition_authority, current_gateway)
                    or rollback_disabled_identity
                ):
            fail("core gateway current identity binding mismatch")
    if core["gatewayUnitAbsenceRestored"]:
        if core["gatewayUnitPreexisted"] or current_gateway is not None \
                or provision is not None \
                or value["phase"] not in {
                    "upgrade-restored", "core-restored", "core-remove-pending",
                    "core-removed", "restored-cleanup",
                }:
            fail("core gateway restored absence binding mismatch")
    if value["phase"] == "gateway-provision-pending" \
            and (provision is None or provisioned_gateway is not None):
        fail("gateway provision-pending phase has no unique pending authority")
    if value["phase"] == "gateway-provisioned" \
            and (provision is not None or provisioned_gateway is None):
        fail("gateway provisioned phase has no exact installed identity")
    if core["gatewayUnitPreexisted"] \
            and value["phase"] in {"gateway-provision-pending", "gateway-provisioned"}:
        fail("preexisting gateway entered the fresh provision phase")
    pending_gateway = core.get("gatewayPendingAction")
    if pending_gateway is not None:
        if not isinstance(pending_gateway, dict) or set(pending_gateway) != {
            "action", "purpose", "before", "beforeSha256", "expectedActive",
        } or pending_gateway.get("action") not in {"start", "stop"} \
                or pending_gateway.get("purpose") not in GATEWAY_ACTION_PURPOSES \
                or not isinstance(pending_gateway.get("expectedActive"), bool):
            fail("core gateway pending action mismatch")
        pending_before = pending_gateway.get("before")
        validate_gateway_unit_identity(
            pending_before, label="core gateway pending identity",
        )
        if pending_gateway.get("beforeSha256") \
                != canonical_json_sha256(pending_before) \
            or pending_before != current_gateway \
                or pending_gateway["expectedActive"] \
                    != (pending_gateway["action"] == "start") \
                or pending_before["active"] \
                    != (pending_gateway["action"] == "stop"):
            fail("core gateway pending action authority mismatch")
        desired_active = (
            core["gatewayCommittedActive"]
            if pending_gateway["purpose"] == "forward"
            else core["gatewayWasActive"]
        )
        if pending_gateway["action"] == "start" and not desired_active:
            fail("core gateway start conflicts with its activation purpose")
        recovery_phases = {
            "recovery-pending", "migration-restored", "upgrade-restored",
            "core-rollback-pending", "core-restored", "core-remove-pending",
            "core-removed", "restored-cleanup",
        }
        if (pending_gateway["purpose"] == "baseline-restore") \
                != (value["phase"] in recovery_phases):
            fail("core gateway action purpose is not admitted in this phase")
    if core["statePreexisted"] and not core["stateRootPreexisted"]:
        fail("preexisting OpenClaw state requires a preexisting state root")
    if core["stateConfigPreexisted"] and not core["statePreexisted"]:
        fail("a preexisting OpenClaw config requires a preexisting state footprint")
    core_package_values = tuple(
        core[field] for field in ("packageVersion", "runtimeVersion", "rollbackSha256")
    )
    if any(item is None for item in core_package_values) \
            and any(item is not None for item in core_package_values):
        fail("partial core rollback binding")
    if not isinstance(commit, dict) or set(commit) != {"pendingLedgerSha256", "decisionSha256"}:
        fail("commit binding mismatch")
    validate_codex_binding(value, ledger)
    for field, digest in prepared.items():
        if field == "migrationPackageDir":
            if digest is not None and (
                not isinstance(digest, str)
                or not Path(digest).is_absolute()
                or Path(os.path.normpath(digest)) != Path(digest)
            ):
                fail("invalid prepared package-directory binding")
            continue
        if digest is not None and not SHA256.fullmatch(str(digest)):
            fail(f"invalid prepared fingerprint: {field}")
    for field, digest in commit.items():
        if digest is not None and not SHA256.fullmatch(str(digest)):
            fail(f"invalid commit fingerprint: {field}")
    if value.get("recoveryFrom") is not None and value["recoveryFrom"] not in PHASES:
        fail("invalid recovery origin")
    migration_helper = Path(value["paths"]["migrationHelper"])
    transaction_helper = Path(value["paths"]["transactionHelper"])
    stable_plugins_helper = Path(value["paths"]["stablePluginsHelper"])
    safe_file(transaction_helper)
    if sha256_file(transaction_helper) != prepared["transactionHelperSha256"]:
        fail("durable transaction helper drift")
    if os.path.lexists(stable_plugins_helper):
        safe_file(stable_plugins_helper)
        if sha256_file(stable_plugins_helper) != prepared["stablePluginsHelperSha256"]:
            fail("durable stable-plugin helper drift")
    elif value["phase"] not in {"restored-cleanup", "committed-cleanup"}:
        fail("durable stable-plugin helper is missing before terminal cleanup")
    if os.path.lexists(migration_helper):
        safe_file(migration_helper)
        if sha256_file(migration_helper) != prepared["migrationHelperSha256"]:
            fail("durable migration helper drift")
    elif value["phase"] not in {"restored-cleanup", "committed-cleanup"}:
        fail("durable migration helper is missing before terminal cleanup")
    rollback = Path(value["paths"]["coreRollbackPackage"])
    if core["rollbackSha256"] is not None and os.path.lexists(rollback):
        safe_file(rollback, maximum=512 * 1024 * 1024)
        if sha256_file(rollback) != core["rollbackSha256"]:
            fail("durable core rollback package drift")
    elif core["rollbackSha256"] is not None \
            and value["phase"] not in {"restored-cleanup", "committed-cleanup"}:
        fail("durable core rollback package is missing before terminal cleanup")
    candidate = Path(value["paths"]["gatewayUnitCandidate"])
    if provision_sha256 is not None and os.path.lexists(candidate):
        safe_file(candidate, mode=0o600, maximum=64 * 1024)
        if sha256_file(candidate) != provision_sha256:
            fail("durable gateway unit candidate drift")
    elif provision_sha256 is not None \
            and value["phase"] not in {"restored-cleanup", "committed-cleanup"}:
        fail("durable gateway unit candidate is missing before terminal cleanup")
    unit_path = expected_gateway_unit_path()
    enablement_path = expected_gateway_enablement_path()
    if core["gatewayUnitAbsenceRestored"] \
            and (os.path.lexists(unit_path) or os.path.lexists(enablement_path)):
        fail("installer-created gateway unit reappeared after absence restoration")
    if not core["gatewayUnitPreexisted"]:
        enablement_present = gateway_enablement_present()
        if provision is not None:
            if provision["phase"] in {"armed", "unit-published"} \
                    and enablement_present:
                fail("gateway enablement appeared before daemon-reload authority")
            if provision["phase"] == "daemon-reloaded" \
                    and enablement_present \
                    and not provision["committedEnabled"]:
                fail("gateway enablement conflicts with committed intent")
        elif provisioned_gateway is None and enablement_present:
            fail("gateway enablement exists without provision authority")
        elif provisioned_gateway is not None \
                and value["phase"] not in GATEWAY_UNIT_REMOVAL_PHASES \
                and not core["gatewayUnitAbsenceRestored"] \
                and enablement_present != core["gatewayCommittedEnabled"]:
            fail("gateway enablement symlink drift")
    if provision is not None \
            and provision["phase"] in {"unit-published", "daemon-reloaded"} \
            and value["phase"] not in GATEWAY_UNIT_REMOVAL_PHASES:
        safe_file(unit_path, mode=0o644, maximum=64 * 1024)
        if sha256_file(unit_path) != provision_sha256:
            fail("published gateway unit drift")
    if provisioned_gateway is not None \
            and not core["gatewayUnitAbsenceRestored"] \
            and value["phase"] not in GATEWAY_UNIT_REMOVAL_PHASES:
        safe_file(unit_path, mode=0o644, maximum=64 * 1024)
        if sha256_file(unit_path) != provision_sha256:
            fail("provisioned gateway unit drift")
    return value


def create(args) -> None:
    ledger = Path(args.ledger)
    root = Path(args.root)
    if ledger != root / "transaction.json" or not root.is_absolute() or Path(os.path.normpath(root)) != root:
        fail("transaction root binding mismatch")
    safe_directory(root.parent)
    if os.path.lexists(root):
        fail("a migration transaction already exists")
    os.mkdir(root, 0o700)
    os.chown(root, 0, 0)
    fsync_directory(root.parent)
    try:
        migration_helper = root / "migrate-openclaw-2026.9.1.mjs"
        transaction_helper = root / "openclaw-migration-transaction.py"
        stable_plugins_helper = root / "openclaw-stable-plugins.sh"
        durable_copy(Path(args.migration_helper_source), migration_helper)
        durable_copy(Path(args.transaction_helper_source), transaction_helper)
        durable_copy(Path(args.stable_plugins_helper_source), stable_plugins_helper)
        boot_id = current_boot_id()
        gateway_identity = json_argument(
            args.gateway_unit_identity_json, "core gateway unit identity",
        )
        gateway_unit_preexisted = bool_argument(args.gateway_unit_preexisted)
        gateway_was_active = bool_argument(args.gateway_was_active)
        gateway_was_enabled = bool_argument(args.gateway_was_enabled)
        gateway_committed_active = bool_argument(args.gateway_committed_active)
        gateway_committed_enabled = bool_argument(args.gateway_committed_enabled)
        package_preexisted = bool_argument(args.package_preexisted)
        if not package_preexisted and gateway_unit_preexisted:
            fail("fresh package installation requires attested gateway unit absence")
        if gateway_unit_preexisted:
            validate_gateway_unit_identity(
                gateway_identity, label="core gateway baseline identity",
            )
            if gateway_identity["active"] != gateway_was_active \
                    or gateway_identity_enabled(gateway_identity) \
                        != gateway_was_enabled \
                    or gateway_committed_active != gateway_was_active \
                    or gateway_committed_enabled != gateway_was_enabled:
                fail("core gateway baseline and committed identity disagree")
        elif gateway_identity is not None or gateway_was_active \
                or gateway_was_enabled or not gateway_committed_active \
                or not gateway_committed_enabled:
            fail("fresh core gateway absence was not attested exactly")
        if not gateway_unit_preexisted and gateway_enablement_present():
            fail("fresh core gateway enablement absence was not attested")
        value = {
            "schema": SCHEMA,
            "generation": os.urandom(16).hex(),
            "phase": "created",
            "paths": expected_paths(ledger),
            "prepared": {
                "upgradeStateSha256": None,
                "migrationSha256": None,
                "migrationPackageDir": None,
                "migrationHelperSha256": sha256_file(migration_helper),
                "transactionHelperSha256": sha256_file(transaction_helper),
                "stablePluginsHelperSha256": sha256_file(stable_plugins_helper),
            },
            "core": {
                "packageVersion": None,
                "runtimeVersion": None,
                "rollbackSha256": None,
                "gatewayWasActive": gateway_was_active,
                "gatewayWasEnabled": gateway_was_enabled,
                "packagePreexisted": package_preexisted,
                "stateRootPreexisted": bool_argument(args.state_root_preexisted),
                "statePreexisted": bool_argument(args.state_preexisted),
                "stateConfigPreexisted": bool_argument(args.state_config_preexisted),
                "gatewayUnitPreexisted": gateway_unit_preexisted,
                "gatewayCommittedActive": gateway_committed_active,
                "gatewayCommittedEnabled": gateway_committed_enabled,
                "gatewayBaselineUnitIdentity": gateway_identity,
                "gatewayBaselineUnitIdentitySha256": (
                    canonical_json_sha256(gateway_identity)
                    if gateway_identity is not None else None
                ),
                "gatewayProvisionUnitSha256": None,
                "gatewayProvisionPending": None,
                "gatewayProvisionedUnitIdentity": None,
                "gatewayProvisionedUnitIdentitySha256": None,
                "gatewayCurrentUnitIdentity": gateway_identity,
                "gatewayCurrentUnitIdentitySha256": (
                    canonical_json_sha256(gateway_identity)
                    if gateway_identity is not None else None
                ),
                "gatewayPendingAction": None,
                "gatewayUnitAbsenceRestored": False,
            },
            "codex": {
                "phase": "unarmed",
                "preexisted": None,
                "mutationRequired": None,
                "target": None,
                "baseline": None,
                "gateway": None,
                "journal": None,
                "recoveryFrom": None,
            },
            "commit": {"pendingLedgerSha256": None, "decisionSha256": None},
            "createdBootId": boot_id,
            "recoveryFrom": None,
        }
        atomic_json(ledger, value)
        print(f"{value['generation']}\t{value['phase']}")
    except BaseException:
        # No live authority has been touched before create returns. Cleanup of
        # a failed root publication is therefore safe and leaves no false owner.
        shutil.rmtree(root)
        fsync_directory(root.parent)
        raise


def bool_argument(value: str) -> bool:
    if value not in {"true", "false"}:
        fail("boolean argument must be true or false")
    return value == "true"


def json_argument(raw: str, label: str):
    try:
        return json.loads(raw, object_pairs_hook=duplicate_rejecting_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid {label} JSON: {error}")


def begin_codex(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    if value["phase"] != "migration-prepared" or value["codex"]["phase"] != "unarmed":
        fail("Codex preparation is not admitted at this migration boundary")
    baseline = json_argument(args.baseline_json, "Codex baseline")
    gateway_identity = json_argument(
        args.gateway_unit_identity_json, "Codex gateway unit identity",
    )
    validate_gateway_unit_identity(
        gateway_identity, label="Codex gateway baseline identity",
    )
    preexisted = bool_argument(args.preexisted)
    mutation_required = bool_argument(args.mutation_required)
    if not mutation_required and not preexisted:
        fail("a proof-only Codex transaction requires an installed exact baseline")
    main_pid = int(args.gateway_main_pid)
    start_monotonic = int(args.gateway_start_monotonic)
    if main_pid < 0:
        fail("Codex gateway baseline PID is invalid")
    gateway_was_active = bool_argument(args.gateway_was_active)
    if gateway_was_active != (
        main_pid > 0 and bool(args.gateway_invocation_id) and start_monotonic > 0
    ):
        fail("Codex gateway activity and PID disagree")
    if gateway_identity["active"] != gateway_was_active \
            or gateway_identity["mainPid"] != main_pid \
            or (gateway_identity["invocationId"] if gateway_was_active else "") \
                != args.gateway_invocation_id \
            or (
                gateway_identity["execMainStartTimestampMonotonic"]
                if gateway_was_active else 0
            ) != start_monotonic:
        fail("Codex gateway tuple does not match its exact unit identity")
    root = Path(value["paths"]["codexRoot"])
    state_root = root / "openclaw-stable-plugins"
    value["codex"] = {
        "phase": "preparing",
        "preexisted": preexisted,
        "mutationRequired": mutation_required,
        "target": {
            "package": "@openclaw/codex",
            "version": args.target_version,
            "spec": f"@openclaw/codex@{args.target_version}",
            "integrity": args.target_integrity,
        },
        "baseline": baseline,
        "gateway": {
            "wasActive": gateway_was_active,
            "mainPid": main_pid,
            "invocationId": args.gateway_invocation_id,
            "startMonotonic": start_monotonic,
            "baselineUnitIdentity": gateway_identity,
            "forwardStartUnitIdentity": None,
            "baselineUnitIdentitySha256": canonical_json_sha256(gateway_identity),
            "forwardStartUnitIdentitySha256": None,
            "forwardUnitIdentity": None,
            "forwardUnitIdentitySha256": None,
            "rollbackStartUnitIdentity": None,
            "rollbackStartUnitIdentitySha256": None,
            "rollbackUnitIdentity": None,
            "rollbackUnitIdentitySha256": None,
            "attestedMainPid": None,
            "attestedInvocationId": None,
            "attestedStartMonotonic": None,
            "proofSha256": None,
        },
        "journal": ({
            "helperPath": value["paths"]["stablePluginsHelper"],
            "helperSha256": value["prepared"]["stablePluginsHelperSha256"],
            "stateRoot": str(state_root),
            "activePath": str(state_root / "active"),
            "retiredPath": str(state_root / "retired"),
            "managedRoot": "/root/.openclaw/npm",
            "databasePath": "/root/.openclaw/state/openclaw.sqlite",
            "configMode": f"{args.plugin_catalog}-projection",
            "binding": None,
        } if mutation_required else None),
        "recoveryFrom": None,
    }
    validate_codex_binding(value, ledger)
    atomic_json(ledger, value)
    print(f"{value['generation']}\t{value['codex']['phase']}")


def record_codex_gateway_identity(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    codex = value["codex"]
    role = args.role
    required_phase = {
        "forward": "forward-record-installed",
        "rollback": "rollback-tree-restored",
    }[role]
    if codex["phase"] != required_phase:
        fail(f"Codex {role} gateway identity is not admitted in phase {codex['phase']}")
    identity = json_argument(
        args.identity_json, f"Codex {role} gateway unit identity",
    )
    validate_gateway_unit_identity(
        identity, label=f"Codex gateway {role} identity",
    )
    gateway = codex["gateway"]
    baseline = gateway["baselineUnitIdentity"]
    start_identity = gateway[f"{role}StartUnitIdentity"]
    if identity["active"] != gateway["wasActive"] \
            or not same_gateway_unit_definition(baseline, identity) \
            or (identity["active"] and identity["controlGroup"] != baseline["controlGroup"]):
        fail(f"Codex {role} gateway identity changed unit authority")
    if gateway["wasActive"] and start_identity is None:
        fail(f"Codex {role} gateway started without recorded pre-start authority")
    if not gateway["wasActive"] and start_identity is not None:
        fail(f"inactive Codex {role} gateway has start authority")
    field = f"{role}UnitIdentity"
    if gateway[field] is not None and gateway[field] != identity:
        fail(f"Codex {role} gateway identity changed after publication")
    gateway[field] = identity
    gateway[f"{role}UnitIdentitySha256"] = canonical_json_sha256(identity)
    validate_codex_binding(value, ledger)
    atomic_json(ledger, value)
    print(json.dumps(identity, sort_keys=True, separators=(",", ":")))


def record_codex_gateway_start(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    codex = value["codex"]
    role = args.role
    required_phase = {
        "forward": "forward-record-installed",
        "rollback": "rollback-tree-restored",
    }[role]
    if codex["phase"] != required_phase:
        fail(f"Codex {role} start authority is not admitted in phase {codex['phase']}")
    identity = json_argument(
        args.identity_json, f"Codex {role} gateway pre-start identity",
    )
    validate_gateway_unit_identity(
        identity, label=f"Codex gateway {role} pre-start identity",
    )
    gateway = codex["gateway"]
    baseline = gateway["baselineUnitIdentity"]
    if not gateway["wasActive"] or identity["active"] \
            or not same_gateway_unit_definition(baseline, identity):
        fail(f"Codex {role} pre-start identity changed unit authority")
    field = f"{role}StartUnitIdentity"
    if gateway[f"{role}UnitIdentity"] is not None:
        fail(f"Codex {role} result identity already exists")
    if gateway[field] is not None and gateway[field] != identity:
        fail(f"Codex {role} pre-start identity changed after publication")
    gateway[field] = identity
    gateway[f"{role}StartUnitIdentitySha256"] = canonical_json_sha256(identity)
    validate_codex_binding(value, ledger)
    atomic_json(ledger, value)
    print(json.dumps(identity, sort_keys=True, separators=(",", ":")))


def core_gateway_known_identity(value, identity) -> bool:
    core = value["core"]
    if identity == core["gatewayCurrentUnitIdentity"]:
        return True
    codex = value["codex"]
    if codex["phase"] == "unarmed":
        return False
    gateway = codex["gateway"]
    return any(identity == gateway.get(field) for field in (
        "baselineUnitIdentity", "forwardStartUnitIdentity", "forwardUnitIdentity",
        "rollbackStartUnitIdentity", "rollbackUnitIdentity",
    ))


def arm_core_gateway_action(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    if value["phase"] in {"restored-cleanup", "committed-cleanup"} \
            and args.action == "stop":
        fail("terminal migration state cannot arm another gateway stop")
    if core["gatewayPendingAction"] is not None:
        fail("a core gateway action is already pending")
    identity = json_argument(args.identity_json, "core gateway action identity")
    validate_gateway_unit_identity(identity, label="core gateway action identity")
    definition_authority = (
        core["gatewayProvisionedUnitIdentity"]
        or core["gatewayBaselineUnitIdentity"]
    )
    recovery_phases = {
        "recovery-pending", "migration-restored", "upgrade-restored",
        "core-rollback-pending", "core-restored", "core-remove-pending",
        "core-removed", "restored-cleanup",
    }
    purpose_is_recovery = args.purpose == "baseline-restore"
    desired_active = (
        core["gatewayWasActive"]
        if purpose_is_recovery else core["gatewayCommittedActive"]
    )
    if not core_gateway_known_identity(value, identity) \
            or definition_authority is None \
            or not same_gateway_unit_definition(definition_authority, identity) \
            or identity["active"] != (args.action == "stop") \
            or (args.action == "start" and not desired_active) \
            or purpose_is_recovery != (value["phase"] in recovery_phases):
        fail("core gateway action does not own the observed unit generation")
    core["gatewayCurrentUnitIdentity"] = identity
    core["gatewayCurrentUnitIdentitySha256"] = canonical_json_sha256(identity)
    core["gatewayPendingAction"] = {
        "action": args.action,
        "purpose": args.purpose,
        "before": identity,
        "beforeSha256": canonical_json_sha256(identity),
        "expectedActive": args.action == "start",
    }
    atomic_json(ledger, value)
    print(json.dumps(core["gatewayPendingAction"], sort_keys=True, separators=(",", ":")))


def record_core_gateway_result(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    pending = core["gatewayPendingAction"]
    if pending is None:
        fail("no core gateway action is pending")
    identity = json_argument(args.identity_json, "core gateway action result")
    validate_gateway_unit_identity(identity, label="core gateway action result")
    before = pending["before"]
    if identity["active"] != pending["expectedActive"] \
            or not same_gateway_unit_definition(before, identity):
        fail("core gateway action result changed unit authority")
    if pending["action"] == "start" and (
        identity["mainPid"] == before["mainPid"]
        or identity["processStartTicks"] == before["processStartTicks"]
        or identity["invocationId"] == before["invocationId"]
        or identity["execMainStartTimestampMonotonic"]
            <= before["execMainStartTimestampMonotonic"]
    ):
        fail("core gateway start did not create a new process generation")
    core["gatewayCurrentUnitIdentity"] = identity
    core["gatewayCurrentUnitIdentitySha256"] = canonical_json_sha256(identity)
    core["gatewayPendingAction"] = None
    atomic_json(ledger, value)
    print(json.dumps(identity, sort_keys=True, separators=(",", ":")))


def owned_gateway_generation_exited(current) -> bool:
    """Read kernel identity, never infer process death from a systemd status alone."""
    try:
        raw = Path(f"/proc/{current['mainPid']}/stat").read_text(encoding="ascii")
    except FileNotFoundError:
        pass
    except (OSError, UnicodeError):
        return False
    else:
        try:
            fields = raw.rsplit(")", 1)[1].split()
            if int(fields[19]) == current["processStartTicks"] and fields[0] != "Z":
                return False
        except (IndexError, ValueError):
            return False
    # The leader can exit while children remain. A nonempty original cgroup is
    # not an inactive generation, even if MainPID has already become zero.
    group = current["controlGroup"]
    if not group.startswith("/") or ".." in Path(group).parts:
        return False
    try:
        members = (Path("/sys/fs/cgroup") / group.lstrip("/") / "cgroup.procs").read_text(encoding="ascii")
        if members.strip():
            return False
    except FileNotFoundError:
        pass
    except (OSError, UnicodeError):
        return False
    return True


def adopt_core_gateway_identity(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    if core["gatewayPendingAction"] is not None:
        fail("cannot adopt a gateway identity while an action is pending")
    identity = json_argument(args.identity_json, "core gateway adopted identity")
    validate_gateway_unit_identity(identity, label="core gateway adopted identity")
    definition_authority = (
        core["gatewayProvisionedUnitIdentity"]
        or core["gatewayBaselineUnitIdentity"]
    )
    known_identity = core_gateway_known_identity(value, identity)
    current = core["gatewayCurrentUnitIdentity"]
    # daemon-reload resets only ExecStart's historical invocation telemetry.
    # Both units must already be inactive; PID and definition authority remain
    # exact, and the durable fence must still prevent an unowned start.
    inactive_reload_rebase = (
        not known_identity and current is not None
        and not current["active"] and not identity["active"]
        and all(current[field] == identity[field]
                for field in GATEWAY_IDENTITY_FIELDS - {"execStart"})
    )
    if inactive_reload_rebase:
        attest_gateway_fence_marker(args.fence_marker)
    baseline = core["gatewayBaselineUnitIdentity"]
    owned_exit_rebase = (
        not known_identity and current is not None and current["active"]
        and not identity["active"] and identity["controlGroup"] == ""
        and value["phase"] not in {"restored-cleanup", "committed-cleanup"}
        and value["createdBootId"] == current_boot_id()
        and (baseline is None or all(current[field] != baseline[field] for field in (
            "mainPid", "processStartTicks", "invocationId",
        )))
        and identity["invocationId"] in {"", current["invocationId"]}
        and identity["execMainStartTimestampMonotonic"] in {
            0, current["execMainStartTimestampMonotonic"],
        }
        and same_gateway_unit_definition(current, identity)
        and owned_gateway_generation_exited(current)
    )
    if owned_exit_rebase:
        # An attested start can fail before readiness. The fence must remain
        # durable, the owned process and children must be gone, and the unit
        # definition/enablement must still match. Never adopt a foreign start.
        attest_gateway_fence_marker(args.fence_marker)
    terminal_replay = value["phase"] in {"restored-cleanup", "committed-cleanup"}
    target_active = (
        core["gatewayCommittedActive"]
        if value["phase"] == "committed-cleanup"
        else core["gatewayWasActive"]
    )
    target_enabled = (
        core["gatewayCommittedEnabled"]
        if value["phase"] == "committed-cleanup"
        else core["gatewayWasEnabled"]
    )
    postboot_inactive_rebase = (
        not known_identity
        and not identity["active"]
        and value["createdBootId"] != current_boot_id()
    )
    if postboot_inactive_rebase:
        # The durable fence prevents systemd from creating a process on the new
        # boot.  That exact inactive definition is the only safe bridge from a
        # pre-reboot PID/invocation tuple to a new purpose-scoped start.
        attest_gateway_fence_marker(args.fence_marker)
    rollback_disable_rebase = (
        not known_identity
        and not core["gatewayUnitPreexisted"]
        and value["phase"] in GATEWAY_UNIT_REMOVAL_PHASES
        and not identity["active"]
        and not gateway_identity_enabled(identity)
        and not gateway_enablement_present()
        and core["gatewayCurrentUnitIdentity"] is not None
        and same_gateway_unit_definition_ignoring_enablement(
            core["gatewayCurrentUnitIdentity"], identity,
        )
    )
    if rollback_disable_rebase:
        attest_gateway_fence_marker(args.fence_marker)
    if definition_authority is None \
            or not (
                same_gateway_unit_definition(definition_authority, identity)
                or rollback_disable_rebase
            ) \
            or (not known_identity and not (
                postboot_inactive_rebase
                or inactive_reload_rebase
                or owned_exit_rebase
                or rollback_disable_rebase
                or (
                    terminal_replay
                    and identity["active"] == target_active
                    and gateway_identity_enabled(identity) == target_enabled
                )
            )):
        changed = sorted(field for field in GATEWAY_IDENTITY_FIELDS
                         if current is None or current[field] != identity[field])
        fail("core gateway adoption is not backed by durable authority; changed fields: "
             + ",".join(changed))
    core["gatewayCurrentUnitIdentity"] = identity
    core["gatewayCurrentUnitIdentitySha256"] = canonical_json_sha256(identity)
    atomic_json(ledger, value)
    print(json.dumps(identity, sort_keys=True, separators=(",", ":")))


def core_gateway_authority(args) -> None:
    value = load_ledger(Path(args.ledger))
    core = value["core"]
    print(json.dumps({
        "wasActive": core["gatewayWasActive"],
        "wasEnabled": core["gatewayWasEnabled"],
        "unitPreexisted": core["gatewayUnitPreexisted"],
        "committedActive": core["gatewayCommittedActive"],
        "committedEnabled": core["gatewayCommittedEnabled"],
        "baseline": core["gatewayBaselineUnitIdentity"],
        "provisioned": core["gatewayProvisionedUnitIdentity"],
        "current": core["gatewayCurrentUnitIdentity"],
        "pending": core["gatewayPendingAction"],
    }, sort_keys=True, separators=(",", ":")))


def codex_transition(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    codex = value["codex"]
    before = codex["phase"]
    after = args.to
    if before != args.expected:
        fail(f"Codex phase changed: expected {args.expected}, found {before}")
    if after == "recovery-pending":
        if before in {
            "unarmed", "recovery-pending", "rollback-tree-restored", "rollback-attested",
        }:
            fail("invalid Codex recovery transition")
        codex["recoveryFrom"] = before
        codex["gateway"]["attestedMainPid"] = None
        codex["gateway"]["attestedInvocationId"] = None
        codex["gateway"]["attestedStartMonotonic"] = None
        codex["gateway"]["proofSha256"] = None
    elif (before, after) not in CODEX_TRANSITIONS:
        fail(f"invalid Codex transition: {before} -> {after}")
    if after == "rollback-ready":
        binding = json_argument(args.journal_binding or "", "Codex journal binding")
        codex["journal"]["binding"] = binding
    elif args.journal_binding is not None:
        fail("Codex journal binding is only accepted at rollback-ready")
    if after in {"forward-attested", "rollback-attested"}:
        if args.gateway_main_pid is None or args.gateway_invocation_id is None \
                or args.gateway_start_monotonic is None \
                or args.proof_sha256 is None:
            fail("Codex gateway attestation is incomplete")
        codex["gateway"]["attestedMainPid"] = int(args.gateway_main_pid)
        codex["gateway"]["attestedInvocationId"] = args.gateway_invocation_id
        codex["gateway"]["attestedStartMonotonic"] = int(args.gateway_start_monotonic)
        codex["gateway"]["proofSha256"] = args.proof_sha256
    elif any(item is not None for item in (
        args.gateway_main_pid, args.gateway_invocation_id,
        args.gateway_start_monotonic, args.proof_sha256,
    )):
        fail("Codex gateway proof is only accepted at an attestation boundary")
    codex["phase"] = after
    validate_codex_binding(value, ledger)
    atomic_json(ledger, value)
    print(f"{value['generation']}\t{codex['phase']}")


def codex_authority(args) -> None:
    value = load_ledger(Path(args.ledger))
    print(json.dumps(value["codex"], sort_keys=True, separators=(",", ":")))


def codex_helper(args) -> None:
    value = load_ledger(Path(args.ledger))
    print("\t".join((
        value["paths"]["stablePluginsHelper"],
        value["prepared"]["stablePluginsHelperSha256"],
        "portal" if (value["codex"].get("journal") or {}).get("configMode") == "portal-projection" else "codex",
    )))


def codex_commit_config(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    record = Path(args.decision_record)
    if value["phase"] != "commit-applying" or not decision_matches(value, ledger, record):
        fail("plugin commit has no matching composite decision")
    document = read_json(record)
    entry = document.get("askUser", {})
    _, config = expected_state_paths()
    safe_file(config, mode=0o600, maximum=16 * 1024 * 1024)
    if entry.get("configPath") != str(config) or entry.get("configSha256") != sha256_file(config):
        fail("plugin final config differs from the tested-pair decision")
    print(hashlib.sha512(config.read_bytes()).hexdigest())


def package_version_from_archive(target: Path) -> str:
    safe_file(target, maximum=512 * 1024 * 1024)
    try:
        with tarfile.open(target, mode="r:gz") as archive:
            members = archive.getmembers()
            package_members = [member for member in members if member.name == "package/package.json"]
            if len(package_members) != 1 or not package_members[0].isfile():
                fail("core rollback archive has no unique package identity")
            member = package_members[0]
            if member.size <= 0 or member.size > 1024 * 1024:
                fail("core rollback package identity has an invalid size")
            stream = archive.extractfile(member)
            if stream is None:
                fail("core rollback package identity is unreadable")
            document = json.loads(
                stream.read().decode("utf-8"),
                object_pairs_hook=duplicate_rejecting_object,
            )
    except (tarfile.TarError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid core rollback archive: {error}")
    if not isinstance(document, dict) or document.get("name") != "openclaw" \
            or not isinstance(document.get("version"), str):
        fail("core rollback archive is not an OpenClaw package")
    return document["version"]


def seal_core(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    if not value["core"]["packagePreexisted"] \
            or value["phase"] != "created" or any(
        value["core"][field] is not None
        for field in ("packageVersion", "runtimeVersion", "rollbackSha256")
    ):
        fail("core convergence can only be armed from an empty created transaction")
    gateway_was_active = bool_argument(args.gateway_was_active)
    gateway_was_enabled = bool_argument(args.gateway_was_enabled)
    if (
        gateway_was_active != value["core"]["gatewayWasActive"]
        or gateway_was_enabled != value["core"]["gatewayWasEnabled"]
    ):
        fail("core convergence gateway state changed after transaction creation")
    source = Path(args.rollback_package)
    if not source.is_absolute() or Path(os.path.normpath(source)) != source:
        fail("core rollback source path must be canonical and absolute")
    if package_version_from_archive(source) != args.package_version:
        fail("core rollback archive version does not match the captured package")
    target = Path(value["paths"]["coreRollbackPackage"])
    if os.path.lexists(target):
        fail("core rollback target already exists")
    durable_copy(source, target, maximum=512 * 1024 * 1024)
    previous_core = value["core"]
    value["core"] = {
        "packageVersion": args.package_version,
        "runtimeVersion": args.runtime_version,
        "rollbackSha256": sha256_file(target),
        "gatewayWasActive": gateway_was_active,
        "gatewayWasEnabled": gateway_was_enabled,
        "packagePreexisted": previous_core["packagePreexisted"],
        "stateRootPreexisted": previous_core["stateRootPreexisted"],
        "statePreexisted": previous_core["statePreexisted"],
        "stateConfigPreexisted": previous_core["stateConfigPreexisted"],
        "gatewayUnitPreexisted": previous_core["gatewayUnitPreexisted"],
        "gatewayCommittedActive": previous_core["gatewayCommittedActive"],
        "gatewayCommittedEnabled": previous_core["gatewayCommittedEnabled"],
        "gatewayBaselineUnitIdentity": previous_core["gatewayBaselineUnitIdentity"],
        "gatewayBaselineUnitIdentitySha256": previous_core["gatewayBaselineUnitIdentitySha256"],
        "gatewayProvisionUnitSha256": previous_core["gatewayProvisionUnitSha256"],
        "gatewayProvisionPending": previous_core["gatewayProvisionPending"],
        "gatewayProvisionedUnitIdentity": previous_core["gatewayProvisionedUnitIdentity"],
        "gatewayProvisionedUnitIdentitySha256": previous_core["gatewayProvisionedUnitIdentitySha256"],
        "gatewayCurrentUnitIdentity": previous_core["gatewayCurrentUnitIdentity"],
        "gatewayCurrentUnitIdentitySha256": previous_core["gatewayCurrentUnitIdentitySha256"],
        "gatewayPendingAction": previous_core["gatewayPendingAction"],
        "gatewayUnitAbsenceRestored": previous_core["gatewayUnitAbsenceRestored"],
    }
    value["phase"] = "core-converge-pending"
    atomic_json(ledger, value)
    print(f"{value['generation']}\t{value['phase']}")


def arm_fresh_core(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    if (
        value["phase"] != "created"
        or value["core"]["packagePreexisted"]
        or any(
            value["core"][field] is not None
            for field in ("packageVersion", "runtimeVersion", "rollbackSha256")
        )
    ):
        fail("fresh core convergence requires a package-absence generation")
    value["phase"] = "core-converge-pending"
    atomic_json(ledger, value)
    print(f"{value['generation']}\t{value['phase']}")


def adopt_current_core(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    if value["phase"] != "created" or not value["core"]["packagePreexisted"] \
            or any(value["core"][field] is not None for field in (
                "packageVersion", "runtimeVersion", "rollbackSha256",
            )) \
            or not PACKAGE_VERSION.fullmatch(args.package_version) \
            or not PACKAGE_VERSION.fullmatch(args.runtime_version):
        fail("current core adoption requires an exact package-preserving generation")
    value["phase"] = "core-converged"
    atomic_json(ledger, value)
    print(f"{value['generation']}\t{value['phase']}")


def arm_gateway_provision(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    source = Path(args.unit_source)
    target = expected_gateway_unit_path()
    candidate = Path(value["paths"]["gatewayUnitCandidate"])
    if value["phase"] != "core-converged" \
            or core["gatewayUnitPreexisted"] \
            or core["gatewayBaselineUnitIdentity"] is not None \
            or core["gatewayCurrentUnitIdentity"] is not None \
            or core["gatewayProvisionPending"] is not None \
            or core["gatewayProvisionedUnitIdentity"] is not None \
            or core["gatewayProvisionUnitSha256"] is not None \
            or core["gatewayUnitAbsenceRestored"] \
            or os.path.lexists(target) or os.path.lexists(candidate):
        fail("fresh gateway provision does not begin from attested unit absence")
    if not source.is_absolute() or Path(os.path.normpath(source)) != source:
        fail("gateway unit source path must be canonical and absolute")
    durable_copy(source, candidate, maximum=64 * 1024)
    unit_sha256 = sha256_file(candidate)
    core["gatewayProvisionUnitSha256"] = unit_sha256
    core["gatewayProvisionPending"] = {
        "phase": "armed",
        "unitPath": str(target),
        "unitSha256": unit_sha256,
        "committedActive": core["gatewayCommittedActive"],
        "committedEnabled": core["gatewayCommittedEnabled"],
        "enablementPath": str(expected_gateway_enablement_path()),
        "enablementTarget": str(target),
        "reloadedUnitIdentity": None,
        "reloadedUnitIdentitySha256": None,
    }
    value["phase"] = "gateway-provision-pending"
    atomic_json(ledger, value)
    print(json.dumps(core["gatewayProvisionPending"], sort_keys=True, separators=(",", ":")))


def publish_gateway_unit(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    provision = core["gatewayProvisionPending"]
    if value["phase"] != "gateway-provision-pending" \
            or provision is None \
            or provision["phase"] not in {"armed", "unit-published"}:
        fail("gateway unit publication is not admitted in this phase")
    source = Path(value["paths"]["gatewayUnitCandidate"])
    target = expected_gateway_unit_path()
    safe_file(source, mode=0o600, maximum=64 * 1024)
    if sha256_file(source) != provision["unitSha256"]:
        fail("gateway unit candidate changed before publication")
    safe_directory(target.parent)
    if os.path.lexists(target):
        safe_file(target, mode=0o644, maximum=64 * 1024)
        if sha256_file(target) != provision["unitSha256"]:
            fail("a foreign gateway unit occupies the provision target")
        # Replay may be observing the rename after process death but before the
        # original directory fsync.  Force it before publishing journal state.
        fsync_directory(target.parent)
    else:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.portal-provision-", dir=target.parent,
        )
        temporary = Path(temporary_name)
        try:
            os.fchown(descriptor, 0, 0)
            os.fchmod(descriptor, 0o644)
            with source.open("rb") as input_stream, os.fdopen(descriptor, "wb") as output:
                descriptor = -1
                shutil.copyfileobj(input_stream, output)
                output.flush()
                os.fsync(output.fileno())
            fault("gateway-provision-before-unit-publication")
            libc = ctypes.CDLL(None, use_errno=True)
            renameat2 = getattr(libc, "renameat2", None)
            if renameat2 is None:
                fail("renameat2 is required for no-replace gateway publication")
            renameat2.argtypes = [
                ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                ctypes.c_char_p, ctypes.c_uint,
            ]
            renameat2.restype = ctypes.c_int
            directory_fd = os.open(
                target.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                result = renameat2(
                    directory_fd, os.fsencode(temporary.name), directory_fd,
                    os.fsencode(target.name), 1,
                )
                if result != 0:
                    error = ctypes.get_errno()
                    if error != errno.EEXIST:
                        raise OSError(error, os.strerror(error))
                    safe_file(target, mode=0o644, maximum=64 * 1024)
                    if sha256_file(target) != provision["unitSha256"]:
                        fail("gateway provision target changed during publication")
                else:
                    temporary = None
                fault("gateway-provision-after-unit-publication")
                fsync_directory(target.parent)
                fault("gateway-provision-after-unit-publication-fsync")
            finally:
                os.close(directory_fd)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    safe_file(target, mode=0o644, maximum=64 * 1024)
    if sha256_file(target) != provision["unitSha256"]:
        fail("published gateway unit does not match its durable candidate")
    provision["phase"] = "unit-published"
    atomic_json(ledger, value)
    fault("gateway-provision-after-unit-publication-record")
    print(str(target))


def record_gateway_daemon_reload(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    provision = core["gatewayProvisionPending"]
    if value["phase"] != "gateway-provision-pending" \
            or provision is None \
            or provision["phase"] not in {"unit-published", "daemon-reloaded"}:
        fail("gateway daemon-reload proof is not admitted in this phase")
    identity = json_argument(args.identity_json, "gateway daemon-reload identity")
    validate_gateway_unit_identity(identity, label="gateway daemon-reload identity")
    target = expected_gateway_unit_path()
    safe_file(target, mode=0o644, maximum=64 * 1024)
    if sha256_file(target) != provision["unitSha256"] \
            or identity["active"] \
            or identity["fragmentPath"] != str(target) \
            or gateway_identity_enabled(identity) \
            or gateway_enablement_present():
        fail("gateway daemon-reload proof does not describe the staged inactive unit")
    previous = provision.get("reloadedUnitIdentity")
    if previous is not None and previous != identity:
        fail("gateway daemon-reload identity changed after publication")
    provision["reloadedUnitIdentity"] = identity
    provision["reloadedUnitIdentitySha256"] = canonical_json_sha256(identity)
    provision["phase"] = "daemon-reloaded"
    atomic_json(ledger, value)
    fault("gateway-provision-after-daemon-reload-record")
    print(json.dumps(identity, sort_keys=True, separators=(",", ":")))


def record_gateway_provision(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    provision = core["gatewayProvisionPending"]
    if value["phase"] != "gateway-provision-pending" \
            or provision is None or provision["phase"] != "daemon-reloaded":
        fail("gateway provision result is not admitted in this phase")
    identity = json_argument(args.identity_json, "gateway provisioned identity")
    validate_gateway_unit_identity(identity, label="gateway provisioned identity")
    reloaded = provision["reloadedUnitIdentity"]
    target = expected_gateway_unit_path()
    safe_file(target, mode=0o644, maximum=64 * 1024)
    comparable_fields = GATEWAY_DEFINITION_FIELDS - {"unitFileState"}
    if sha256_file(target) != provision["unitSha256"] \
            or identity["active"] \
            or identity["fragmentPath"] != str(target) \
            or gateway_identity_enabled(identity) \
                != core["gatewayCommittedEnabled"] \
            or gateway_enablement_present() \
                != core["gatewayCommittedEnabled"] \
            or any(identity.get(field) != reloaded.get(field) for field in comparable_fields):
        fail("gateway provision result changed the admitted unit definition")
    core["gatewayProvisionedUnitIdentity"] = identity
    core["gatewayProvisionedUnitIdentitySha256"] = canonical_json_sha256(identity)
    core["gatewayCurrentUnitIdentity"] = identity
    core["gatewayCurrentUnitIdentitySha256"] = canonical_json_sha256(identity)
    core["gatewayProvisionPending"] = None
    value["phase"] = "gateway-provisioned"
    atomic_json(ledger, value)
    fault("gateway-provision-after-result-record")
    print(json.dumps(identity, sort_keys=True, separators=(",", ":")))


def gateway_provision_authority(args) -> None:
    value = load_ledger(Path(args.ledger))
    core = value["core"]
    print(json.dumps({
        "unitPath": str(expected_gateway_unit_path()),
        "enablementPath": str(expected_gateway_enablement_path()),
        "enablementTarget": str(expected_gateway_unit_path()),
        "unitPreexisted": core["gatewayUnitPreexisted"],
        "committedActive": core["gatewayCommittedActive"],
        "committedEnabled": core["gatewayCommittedEnabled"],
        "unitSha256": core["gatewayProvisionUnitSha256"],
        "pending": core["gatewayProvisionPending"],
        "provisioned": core["gatewayProvisionedUnitIdentity"],
        "current": core["gatewayCurrentUnitIdentity"],
        "absenceRestored": core["gatewayUnitAbsenceRestored"],
    }, sort_keys=True, separators=(",", ":")))


def remove_gateway_unit(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    target = expected_gateway_unit_path()
    if value["phase"] not in GATEWAY_UNIT_REMOVAL_PHASES \
            or core["gatewayUnitPreexisted"] \
            or core["gatewayProvisionUnitSha256"] is None \
            or core["gatewayPendingAction"] is not None:
        fail("fresh gateway unit removal is not admitted in this phase")
    if not os.path.lexists(target):
        # A replay after SIGKILL may observe the unlink before its directory
        # entry was forced to stable storage.  Never let a later absence
        # record outrun that missing fsync.
        fsync_absence_namespace(target)
        return
    safe_file(target, mode=0o644, maximum=64 * 1024)
    if sha256_file(target) != core["gatewayProvisionUnitSha256"]:
        fail("foreign gateway unit refused during fresh rollback")
    if core["gatewayCurrentUnitIdentity"] is not None \
            and core["gatewayCurrentUnitIdentity"]["active"]:
        fail("active gateway unit cannot be removed")
    if gateway_enablement_present():
        fail("enabled gateway unit cannot be removed")
    fault("gateway-remove-before-unit-delete")
    target.unlink()
    fault("gateway-remove-after-unit-delete")
    fsync_directory(target.parent)
    fault("gateway-remove-after-unit-delete-fsync")


def record_gateway_absence(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    core = value["core"]
    target = expected_gateway_unit_path()
    if value["phase"] not in GATEWAY_UNIT_REMOVAL_PHASES \
            or core["gatewayUnitPreexisted"] \
            or core["gatewayPendingAction"] is not None \
            or os.path.lexists(target) \
            or gateway_enablement_present():
        fail("fresh gateway absence is not proven at the rollback boundary")
    # Seal both filesystem namespaces before publishing durable absence.  This
    # also closes replay after systemctl disable returned but its wants-link
    # deletion had not yet reached stable storage.
    fsync_absence_namespace(target)
    fsync_absence_namespace(expected_gateway_enablement_path())
    core["gatewayCurrentUnitIdentity"] = None
    core["gatewayCurrentUnitIdentitySha256"] = None
    core["gatewayProvisionPending"] = None
    core["gatewayUnitAbsenceRestored"] = True
    atomic_json(ledger, value)
    fault("gateway-remove-after-absence-record")
    print("absent")


def core_rollback(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    if value["phase"] not in {
        "core-rollback-pending", "core-restored", "restored-cleanup",
    }:
        fail("core rollback is not admitted in this phase")
    rollback = Path(value["paths"]["coreRollbackPackage"])
    if package_version_from_archive(rollback) != value["core"]["packageVersion"]:
        fail("core rollback archive package identity drift")
    print("\t".join((
        str(rollback),
        value["core"]["packageVersion"],
        value["core"]["runtimeVersion"],
        "true" if value["core"]["gatewayWasActive"] else "false",
        "true" if value["core"]["gatewayWasEnabled"] else "false",
    )))


def core_present(args) -> None:
    value = load_ledger(Path(args.ledger))
    if value["core"]["rollbackSha256"] is None:
        raise SystemExit(1)


def core_removal_required(args) -> None:
    value = load_ledger(Path(args.ledger))
    if value["core"]["packagePreexisted"]:
        raise SystemExit(1)


def fresh_core_removal(args) -> None:
    value = load_ledger(Path(args.ledger))
    if value["phase"] != "core-remove-pending" or value["core"]["packagePreexisted"]:
        fail("fresh core removal is not admitted in this phase")
    print("\t".join((
        "false",
        "true" if value["core"]["stateRootPreexisted"] else "false",
        "true" if value["core"]["statePreexisted"] else "false",
        "true" if value["core"]["stateConfigPreexisted"] else "false",
    )))


def restore_state_absence(args) -> None:
    value = load_ledger(Path(args.ledger))
    if value["phase"] not in {
        "upgrade-restored", "core-rollback-pending", "core-remove-pending",
    }:
        fail("state-absence restoration is not admitted in this phase")
    state_root, config_path = expected_state_paths()
    root_preexisted = value["core"]["stateRootPreexisted"]
    state_preexisted = value["core"]["statePreexisted"]
    config_preexisted = value["core"]["stateConfigPreexisted"]

    # Config/session migration already restored a real pre-install footprint,
    # but an installer-created config can coexist with older session authority
    # that had no config file. Remove only that new leaf in this case.
    if state_preexisted:
        if config_preexisted or not os.path.lexists(config_path):
            return
        safe_directory(state_root)
        safe_file(config_path, mode=None, maximum=1024 * 1024)
        fault("state-absence-before-config-delete")
        config_path.unlink()
        fault("state-absence-after-config-delete")
        fsync_directory(state_root)
        fault("state-absence-after-config-fsync")
        return

    if not root_preexisted:
        if not os.path.lexists(state_root):
            return
        safe_directory(state_root)
        validate_snapshot_tree(state_root)
        fault("state-absence-before-root-delete")
        shutil.rmtree(state_root)
        fault("state-absence-after-root-delete")
        fsync_directory(state_root.parent)
        fault("state-absence-after-parent-fsync")
        return

    # A preexisting media-only/empty root is not OpenClaw authority. Preserve
    # its media cache, but retire every non-media entry created by this failed
    # install. Repeated cleanup after SIGKILL sees only the remaining entries.
    safe_directory(state_root)
    if config_preexisted:
        fail("state-absence generation unexpectedly contains a preexisting config")
    for entry in sorted(state_root.iterdir(), key=lambda item: item.name):
        if entry.name == "media":
            continue
        # Validate only what is being deleted. The preserved media cache may
        # contain independently managed content and is outside this rollback.
        tree_sha256(entry)
        fault("state-absence-before-entry-delete")
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        fault("state-absence-after-entry-delete")
        fsync_directory(state_root)
        fault("state-absence-after-entry-fsync")
    fsync_directory(state_root)


def gateway_status(args) -> None:
    value = load_ledger(Path(args.ledger))
    core = value["core"]
    if args.purpose == "forward":
        active = core["gatewayCommittedActive"]
        enabled = core["gatewayCommittedEnabled"]
    else:
        active = core["gatewayWasActive"]
        enabled = core["gatewayWasEnabled"]
    print("\t".join((
        "true" if active else "false",
        "true" if enabled else "false",
    )))


def validate_gateway_terminal_activation(value, *, committed: bool) -> None:
    core = value["core"]
    if core["gatewayPendingAction"] is not None \
            or core["gatewayProvisionPending"] is not None:
        fail("gateway still has a pending terminal action")
    current = core["gatewayCurrentUnitIdentity"]
    if committed:
        if current is None \
                or current["active"] != core["gatewayCommittedActive"] \
                or gateway_identity_enabled(current) \
                    != core["gatewayCommittedEnabled"] \
                or core["gatewayUnitAbsenceRestored"] \
                or (not core["gatewayUnitPreexisted"] \
                    and core["gatewayProvisionedUnitIdentity"] is None):
            fail("gateway has not reached committed terminal activation")
        return
    if core["gatewayUnitPreexisted"]:
        if current is None \
                or current["active"] != core["gatewayWasActive"] \
                or gateway_identity_enabled(current) != core["gatewayWasEnabled"]:
            fail("preexisting gateway baseline activation was not restored")
    elif current is not None or not core["gatewayUnitAbsenceRestored"]:
        fail("fresh gateway unit absence was not restored")


def validate_prepared_file(value, field: str, path_field: str, *, required: bool) -> None:
    digest = value["prepared"][field]
    target = Path(value["paths"][path_field])
    if digest is None:
        if required:
            fail(f"missing prepared fingerprint: {field}")
        return
    safe_file(target)
    if sha256_file(target) != digest:
        fail(f"prepared artifact drift: {target}")


def expected_state_paths():
    if (
        os.environ.get("BRIDGESLLM_INSTALLER_SOURCE_ONLY") == "1"
        and os.environ.get("PORTAL_OPENCLAW_MIGRATION_TEST_ROOT")
    ):
        state = Path(os.environ["PORTAL_OPENCLAW_MIGRATION_TEST_ROOT"]).resolve() / "state"
    else:
        state = Path("/root/.openclaw")
    return state, state / "openclaw.json"


def expected_upgrade_state_paths():
    if (
        os.environ.get("BRIDGESLLM_INSTALLER_SOURCE_ONLY") == "1"
        and os.environ.get("PORTAL_OPENCLAW_MIGRATION_TEST_ROOT")
    ):
        home = Path(os.environ["PORTAL_OPENCLAW_MIGRATION_TEST_ROOT"]).resolve()
    else:
        home = Path("/root")
    return home / ".clawdbot", home / ".openclaw" / "plugins" / "installs.json"


def validate_upgrade_manifest_constraints(value):
    target = Path(value["paths"]["upgradeStateManifest"])
    document = read_json(target, maximum=1024 * 1024)
    if (
        not isinstance(document, dict)
        or document.get("contractVersion") != 1
        or document.get("state") not in {"preparing", "prepared", "restored"}
        or not isinstance(document.get("phase"), str)
        or not isinstance(document.get("preparation"), dict)
    ):
        fail("upgrade-state journal contract mismatch")
    recovery = document.get("recoveryPreparation")
    if recovery is not None and not isinstance(recovery, dict):
        fail("upgrade-state recovery snapshot mismatch")
    return document


def validate_migration_manifest_constraints(value):
    target = Path(value["paths"]["migrationManifest"])
    document = read_json(target)
    state_dir, config_path = expected_state_paths()
    package_dir = Path(str(document.get("packageDir", "")))
    config_backup = Path(str(document.get("configBackupPath", "")))
    snapshot = document.get("authoritySnapshot")
    if (
        document.get("contractVersion") != 2
        or document.get("packageName") != "openclaw"
        or document.get("packageVersion") not in {"2026.9.1", "2026.9.3"}
        or Path(str(document.get("manifestPath", ""))) != target
        or Path(str(document.get("stateDir", ""))) != state_dir
        or Path(str(document.get("configPath", ""))) != config_path
        or config_backup != Path(f"{target}.openclaw.json.before")
        or not package_dir.is_absolute()
        or Path(os.path.normpath(package_dir)) != package_dir
        or not isinstance(snapshot, dict)
        or Path(str(snapshot.get("backupRoot", ""))) != Path(f"{target}.authority-before")
    ):
        fail("migration manifest authority binding mismatch")
    # A pre-package snapshot restores data without executing the package. The
    # target may still be the predecessor or a partially replaced npm tree.
    # Every prepared/committed migration retains exact successor admission.
    if document.get("phase") not in {"snapshot-complete", "restore-armed", "authority-restored", "config-restored", "restored"}:
        safe_directory(package_dir)
        package_json = package_dir / "package.json"
        # Upstream package metadata is public code, not private journal state.
        # Match the stock verifier while retaining root ownership/link/size checks.
        package = read_json(package_json, maximum=1024 * 1024, mode=0o644)
        if package.get("name") != "openclaw" or package.get("version") != document["packageVersion"]:
            fail("migration package does not match its exact supported manifest version")
    entries = snapshot.get("entries")
    if not isinstance(entries, list):
        fail("migration authority snapshot entries are invalid")
    authority_root = Path(f"{target}.authority-before")
    for entry in entries:
        if not isinstance(entry, dict):
            fail("migration authority snapshot entry is invalid")
        if entry.get("kind") == "file":
            backup = Path(str(entry.get("backupPath", "")))
            if backup.parent != authority_root / "files":
                fail("migration authority backup escaped the fixed transaction")
    boot = document.get("bootMetadata")
    if boot is not None:
        if not isinstance(boot, dict) or not isinstance(boot.get("entries"), list) \
                or Path(str(boot.get("backupRoot", ""))) != authority_root / "boot-files":
            fail("migration boot metadata backup binding is invalid")
        for entry in boot["entries"]:
            if not isinstance(entry, dict):
                fail("migration boot metadata entry is invalid")
            if entry.get("before") is not None and Path(str(entry.get("backupPath", ""))).parent != authority_root / "boot-files":
                fail("migration boot metadata backup escaped the fixed transaction")
    cron_root = Path(f"{target}.cron-before")
    cron_files = document.get("cronAuthorityFiles")
    if not isinstance(cron_files, list):
        fail("migration cron authority binding is invalid")
    for entry in cron_files:
        if not isinstance(entry, dict):
            fail("migration cron authority entry is invalid")
        source = Path(str(entry.get("sourcePath", "")))
        backup = Path(str(entry.get("backupPath", "")))
        if (
            source != state_dir
            and state_dir not in source.parents
            or backup.parent != cron_root
        ):
            fail("migration cron authority escaped the fixed transaction")
    return document


def advance(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    before = value["phase"]
    after = args.to
    if before != args.expected:
        fail(f"transaction phase changed: expected {args.expected}, found {before}")
    if after == "recovery-pending":
        if before in {
            "recovery-pending", "migration-restored", "upgrade-restored",
            "core-rollback-pending", "core-restored", "core-remove-pending",
            "core-removed", "restored-cleanup",
            "committed-cleanup",
        }:
            fail("invalid recovery transition")
        value["recoveryFrom"] = before
    elif (before, after) not in TRANSITIONS:
        fail(f"invalid transaction transition: {before} -> {after}")

    if after == "core-converged":
        if value["core"]["packagePreexisted"]:
            if value["core"]["rollbackSha256"] is None:
                fail("core convergence has no sealed rollback package")
            rollback = Path(value["paths"]["coreRollbackPackage"])
            if package_version_from_archive(rollback) != value["core"]["packageVersion"]:
                fail("core rollback archive changed during convergence")
        elif any(
            value["core"][field] is not None
            for field in ("packageVersion", "runtimeVersion", "rollbackSha256")
        ):
            fail("fresh core convergence contains a rollback package binding")
    elif after == "upgrade-prepared":
        target = Path(value["paths"]["upgradeStateManifest"])
        safe_file(target)
        validate_upgrade_manifest_constraints(value)
        value["prepared"]["upgradeStateSha256"] = sha256_file(target)
    elif after == "migration-prepared":
        validate_prepared_file(value, "upgradeStateSha256", "upgradeStateManifest", required=True)
        target = Path(value["paths"]["migrationManifest"])
        safe_file(target)
        migration = validate_migration_manifest_constraints(value)
        value["prepared"]["migrationSha256"] = sha256_file(target)
        value["prepared"]["migrationPackageDir"] = migration["packageDir"]
    elif after == "commit-pending":
        validate_prepared_file(value, "upgradeStateSha256", "upgradeStateManifest", required=True)
        validate_prepared_file(value, "migrationSha256", "migrationManifest", required=True)
        migration = validate_migration_manifest_constraints(value)
        if migration["packageDir"] != value["prepared"]["migrationPackageDir"]:
            fail("migration package directory changed after preparation")
        if value["codex"]["phase"] != "forward-attested":
            fail("Codex transaction has not reached its loaded commit boundary")
        core = value["core"]
        current = core["gatewayCurrentUnitIdentity"]
        if core["gatewayPendingAction"] is not None \
                or core["gatewayProvisionPending"] is not None \
                or current is None \
                or current["active"] != core["gatewayCommittedActive"] \
                or gateway_identity_enabled(current) \
                    != core["gatewayCommittedEnabled"] \
                or (not core["gatewayUnitPreexisted"] \
                    and core["gatewayProvisionedUnitIdentity"] is None):
            fail("gateway has not reached its committed activation boundary")
    elif after == "recovery-pending":
        if os.path.lexists(value["paths"]["upgradeStateManifest"]):
            validate_upgrade_manifest_constraints(value)
        if value["prepared"]["upgradeStateSha256"] is not None:
            validate_prepared_file(value, "upgradeStateSha256", "upgradeStateManifest", required=True)
        if os.path.lexists(value["paths"]["migrationManifest"]):
            migration = validate_migration_manifest_constraints(value)
            if value["prepared"]["migrationPackageDir"] is not None \
                    and migration["packageDir"] != value["prepared"]["migrationPackageDir"]:
                fail("migration recovery package directory changed")
        if value["prepared"]["migrationSha256"] is not None:
            validate_prepared_file(value, "migrationSha256", "migrationManifest", required=True)
    elif after == "core-removed":
        core = value["core"]
        if not core["gatewayUnitPreexisted"] \
                and not core["gatewayUnitAbsenceRestored"]:
            fail("fresh core removal has not restored gateway unit absence")
    elif after == "restored-cleanup":
        validate_gateway_terminal_activation(value, committed=False)
    elif after == "commit-applying":
        decision = Path(args.decision_record or "")
        if not decision.is_absolute():
            fail("commit transition requires an absolute decision record")
        if not decision_matches(value, ledger, decision, allow_committed=False):
            fail("commit decision does not bind this migration generation")
        value["commit"]["pendingLedgerSha256"] = sha256_file(ledger)
        value["commit"]["decisionSha256"] = sha256_file(decision)
    elif after == "committed-cleanup":
        decision = Path(args.decision_record or "")
        if not decision.is_absolute() or not decision_matches(value, ledger, decision):
            fail("commit-applying decision chain is invalid")
    value["phase"] = after
    atomic_json(ledger, value)
    print(f"{value['generation']}\t{value['phase']}")


def decision_binding(value, ledger: Path):
    if value["phase"] != "commit-pending":
        fail("migration transaction is not at the commit boundary")
    validate_prepared_file(value, "upgradeStateSha256", "upgradeStateManifest", required=True)
    validate_prepared_file(value, "migrationSha256", "migrationManifest", required=True)
    if value["codex"]["phase"] != "forward-attested":
        fail("Codex transaction is not at its commit boundary")
    return {
        "transactionRoot": value["paths"]["root"],
        "ledgerPath": str(ledger),
        "generation": value["generation"],
        "commitPhase": "commit-pending",
        "commitPendingLedgerSha256": sha256_file(ledger),
        "upgradeStateManifestPath": value["paths"]["upgradeStateManifest"],
        "upgradeStateManifestSha256": value["prepared"]["upgradeStateSha256"],
        "migrationManifestPath": value["paths"]["migrationManifest"],
        "migrationManifestSha256": value["prepared"]["migrationSha256"],
        "migrationPackageDir": value["prepared"]["migrationPackageDir"],
        "migrationHelperPath": value["paths"]["migrationHelper"],
        "migrationHelperSha256": value["prepared"]["migrationHelperSha256"],
        "transactionHelperPath": value["paths"]["transactionHelper"],
        "transactionHelperSha256": value["prepared"]["transactionHelperSha256"],
        "coreRollbackPackagePath": value["paths"]["coreRollbackPackage"],
        "coreRollbackPackageSha256": value["core"]["rollbackSha256"],
        "preupdatePackageVersion": value["core"]["packageVersion"],
        "preupdateRuntimeVersion": value["core"]["runtimeVersion"],
        "gatewayWasActive": value["core"]["gatewayWasActive"],
        "gatewayWasEnabled": value["core"]["gatewayWasEnabled"],
        "gatewayUnitPreexisted": value["core"]["gatewayUnitPreexisted"],
        "gatewayCommittedActive": value["core"]["gatewayCommittedActive"],
        "gatewayCommittedEnabled": value["core"]["gatewayCommittedEnabled"],
        "gatewayProvisionUnitSha256": value["core"]["gatewayProvisionUnitSha256"],
        "gatewayProvisionedUnitIdentity": value["core"]["gatewayProvisionedUnitIdentity"],
        "gatewayProvisionedUnitIdentitySha256": value["core"]["gatewayProvisionedUnitIdentitySha256"],
        "packagePreexisted": value["core"]["packagePreexisted"],
        "stateRootPreexisted": value["core"]["stateRootPreexisted"],
        "statePreexisted": value["core"]["statePreexisted"],
        "stateConfigPreexisted": value["core"]["stateConfigPreexisted"],
        "codex": value["codex"],
    }


def binding(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    print(json.dumps(decision_binding(value, ledger), sort_keys=True, separators=(",", ":")))


def decision_matches(value, ledger: Path, record: Path, *, allow_committed: bool = True) -> bool:
    try:
        safe_file(record)
        document = read_json(record)
        if document.get("schema") != DECISION_SCHEMA or not isinstance(document.get("migration"), dict):
            return False
        expected = document["migration"]
        if value["phase"] == "commit-pending":
            return expected == decision_binding(value, ledger)
        if not allow_committed or value["phase"] not in {"commit-applying", "committed-cleanup"}:
            return False
        return (
            expected.get("transactionRoot") == value["paths"]["root"]
            and expected.get("ledgerPath") == str(ledger)
            and expected.get("generation") == value["generation"]
            and expected.get("commitPhase") == "commit-pending"
            and expected.get("commitPendingLedgerSha256") == value["commit"]["pendingLedgerSha256"]
            and sha256_file(record) == value["commit"]["decisionSha256"]
            and expected.get("upgradeStateManifestPath") == value["paths"]["upgradeStateManifest"]
            and expected.get("upgradeStateManifestSha256") == value["prepared"]["upgradeStateSha256"]
            and expected.get("migrationManifestPath") == value["paths"]["migrationManifest"]
            and expected.get("migrationManifestSha256") == value["prepared"]["migrationSha256"]
            and expected.get("migrationPackageDir") == value["prepared"]["migrationPackageDir"]
            and expected.get("migrationHelperPath") == value["paths"]["migrationHelper"]
            and expected.get("migrationHelperSha256") == value["prepared"]["migrationHelperSha256"]
            and expected.get("transactionHelperPath") == value["paths"]["transactionHelper"]
            and expected.get("transactionHelperSha256") == value["prepared"]["transactionHelperSha256"]
            and expected.get("coreRollbackPackagePath") == value["paths"]["coreRollbackPackage"]
            and expected.get("coreRollbackPackageSha256") == value["core"]["rollbackSha256"]
            and expected.get("preupdatePackageVersion") == value["core"]["packageVersion"]
            and expected.get("preupdateRuntimeVersion") == value["core"]["runtimeVersion"]
            and expected.get("gatewayWasActive") == value["core"]["gatewayWasActive"]
            and expected.get("gatewayWasEnabled") == value["core"]["gatewayWasEnabled"]
            and expected.get("gatewayUnitPreexisted") == value["core"]["gatewayUnitPreexisted"]
            and expected.get("gatewayCommittedActive") == value["core"]["gatewayCommittedActive"]
            and expected.get("gatewayCommittedEnabled") == value["core"]["gatewayCommittedEnabled"]
            and expected.get("gatewayProvisionUnitSha256") == value["core"]["gatewayProvisionUnitSha256"]
            and expected.get("gatewayProvisionedUnitIdentity") == value["core"]["gatewayProvisionedUnitIdentity"]
            and expected.get("gatewayProvisionedUnitIdentitySha256") == value["core"]["gatewayProvisionedUnitIdentitySha256"]
            and expected.get("packagePreexisted") == value["core"]["packagePreexisted"]
            and expected.get("stateRootPreexisted") == value["core"]["stateRootPreexisted"]
            and expected.get("statePreexisted") == value["core"]["statePreexisted"]
            and expected.get("stateConfigPreexisted") == value["core"]["stateConfigPreexisted"]
            and expected.get("codex") == value["codex"]
        )
    except (ContractError, OSError, KeyError, TypeError, AttributeError):
        return False


def matches(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    if not decision_matches(value, ledger, Path(args.decision_record)):
        fail("decision record mismatch")


def tree_sha256(root: Path) -> str:
    entries = []

    def walk(target: Path, relative: str) -> None:
        info = os.lstat(target)
        mode = stat.S_IMODE(info.st_mode)
        if info.st_uid != 0 or info.st_gid != 0 or mode & 0o022:
            fail(f"unsafe legacy-state entry: {target}")
        if stat.S_ISLNK(info.st_mode):
            fail(f"unsupported legacy-state link: {target}")
        if stat.S_ISDIR(info.st_mode):
            entries.append(f"d\0{relative}\0{mode}\0")
            for child in sorted(target.iterdir(), key=lambda item: item.name):
                walk(child, str(Path(relative) / child.name) if relative else child.name)
            return
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail(f"unsupported legacy-state entry: {target}")
        entries.append(f"f\0{relative}\0{mode}\0{info.st_size}\0{sha256_file(target)}\0")

    walk(root, "")
    return hashlib.sha256("\n".join(entries).encode()).hexdigest()


def exact_sibling_backup(target: Path, candidate: str, prefix: str) -> Path:
    backup = Path(candidate)
    if (
        not backup.is_absolute()
        or Path(os.path.normpath(backup)) != backup
        or backup.parent != target.parent
        or not backup.name.startswith(target.name + prefix)
        or backup.name in {target.name + prefix, target.name + prefix + "."}
    ):
        fail(f"unexpected recovery backup path: {backup}")
    return backup


def atomic_copy_file(source: Path, target: Path, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.portal-restore-", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, mode)
        with source.open("rb") as input_stream, os.fdopen(descriptor, "wb") as output:
            shutil.copyfileobj(input_stream, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
        temporary = None
        fsync_directory(target.parent)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def restore_upgrade(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    if value["phase"] not in {"recovery-pending", "migration-restored"}:
        fail("upgrade-state recovery is not admitted in this phase")
    manifest = Path(value["paths"]["upgradeStateManifest"])
    if not os.path.lexists(manifest):
        return
    document = validate_upgrade_manifest_constraints(value)
    if not isinstance(document, dict) or document.get("contractVersion") != 1:
        fail("upgrade-state journal contract mismatch")
    recovery = document.get("recoveryPreparation")
    if recovery is None:
        return
    if not isinstance(recovery, dict):
        fail("upgrade-state recovery snapshot mismatch")

    legacy_target, plugin_target = expected_upgrade_state_paths()
    if recovery.get("legacyStateAction") == "quarantined":
        expected = recovery.get("legacyStateTreeSha256")
        if not SHA256.fullmatch(str(expected or "")):
            fail("legacy-state recovery fingerprint missing")
        backup = exact_sibling_backup(
            legacy_target,
            str(recovery.get("legacyStateBackupPath", "")),
            ".portal-backup-",
        )
        if not os.path.lexists(backup):
            if not os.path.lexists(legacy_target) or tree_sha256(legacy_target) != expected:
                fail("legacy-state backup is absent and the pre-mutation target is not intact")
            backup = None
        elif tree_sha256(backup) != expected:
            fail("legacy-state backup drift")
        if os.path.lexists(legacy_target):
            if tree_sha256(legacy_target) != expected:
                fail("legacy-state target drift")
        elif backup is not None:
            temporary = legacy_target.parent / f".{legacy_target.name}.portal-restore-{os.getpid()}"
            if os.path.lexists(temporary):
                fail("legacy-state recovery temporary path collision")
            shutil.copytree(backup, temporary, symlinks=True)
            if tree_sha256(temporary) != expected:
                fail("legacy-state recovery copy mismatch")
            os.replace(temporary, legacy_target)
            fsync_directory(legacy_target.parent)

    plugin_action = recovery.get("legacyPluginIndexAction")
    if plugin_action in {"pruned", "quarantined-redundant"}:
        backup = exact_sibling_backup(
            plugin_target,
            str(recovery.get("legacyPluginIndexBackupPath", "")),
            ".portal-backup-",
        )
        expected_backup = recovery.get("legacyPluginIndexBackupSha256")
        if not SHA256.fullmatch(str(expected_backup or "")):
            fail("plugin-index recovery fingerprint missing")
        if not os.path.lexists(backup):
            if not os.path.lexists(plugin_target):
                fail("plugin-index backup and target are both absent")
            safe_file(plugin_target, mode=None, maximum=1024 * 1024)
            if sha256_file(plugin_target) != expected_backup:
                fail("plugin-index backup is absent and the pre-mutation target is not intact")
            backup = None
        else:
            safe_file(backup, mode=None, maximum=1024 * 1024)
            if sha256_file(backup) != expected_backup:
                fail("plugin-index backup drift")
        if os.path.lexists(plugin_target):
            safe_file(plugin_target, mode=None, maximum=1024 * 1024)
            accepted = {expected_backup}
            after = recovery.get("legacyPluginIndexAfterSha256")
            if after is not None:
                if not SHA256.fullmatch(str(after)):
                    fail("plugin-index post-mutation fingerprint mismatch")
                accepted.add(after)
            if sha256_file(plugin_target) not in accepted:
                fail("plugin-index target drift")
        if backup is not None:
            atomic_copy_file(backup, plugin_target, stat.S_IMODE(os.lstat(backup).st_mode))


def inspect(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    phase = value["phase"]
    upgrade_exists = os.path.lexists(value["paths"]["upgradeStateManifest"])
    migration_exists = os.path.lexists(value["paths"]["migrationManifest"])
    if upgrade_exists:
        validate_upgrade_manifest_constraints(value)
    if migration_exists:
        migration = validate_migration_manifest_constraints(value)
        if value["prepared"]["migrationPackageDir"] is not None \
                and migration["packageDir"] != value["prepared"]["migrationPackageDir"]:
            fail("migration package directory does not match the sealed generation")
    if phase not in {
        "recovery-pending", "migration-restored", "upgrade-restored",
        "restored-cleanup", "commit-applying", "committed-cleanup",
    }:
        if value["prepared"]["upgradeStateSha256"] is not None:
            validate_prepared_file(value, "upgradeStateSha256", "upgradeStateManifest", required=True)
        if value["prepared"]["migrationSha256"] is not None:
            validate_prepared_file(value, "migrationSha256", "migrationManifest", required=True)
    print(f"{value['generation']}\t{value['phase']}\t{value.get('recoveryFrom') or '-'}")


def remove_upgrade_state_backups(value, terminal_phase: str) -> None:
    journal = Path(value["paths"]["upgradeStateManifest"])
    if not os.path.lexists(journal):
        return
    document = read_json(journal, maximum=1024 * 1024)
    recovery = document.get("recoveryPreparation")
    if recovery is None:
        return
    if not isinstance(recovery, dict):
        fail("upgrade-state cleanup snapshot mismatch")
    restored = terminal_phase == "restored-cleanup"

    if recovery.get("legacyStateAction") == "quarantined":
        target, plugin_target = expected_upgrade_state_paths()
        backup = exact_sibling_backup(
            target, str(recovery.get("legacyStateBackupPath", "")), ".portal-backup-"
        )
        expected = recovery.get("legacyStateTreeSha256")
        if not SHA256.fullmatch(str(expected or "")):
            fail("legacy-state cleanup fingerprint missing")
        if not os.path.lexists(backup):
            if restored and os.path.lexists(target) and tree_sha256(target) == expected:
                backup = None
            elif not restored and not os.path.lexists(target):
                backup = None
            else:
                fail("legacy-state cleanup backup is missing")
        elif tree_sha256(backup) != expected:
            fail("legacy-state cleanup backup drift")
        if restored:
            if not os.path.lexists(target) or tree_sha256(target) != expected:
                fail("legacy-state restored target drift")
        elif os.path.lexists(target):
            fail("legacy-state target reappeared before commit cleanup")
        if backup is not None:
            fault("cleanup-before-legacy-state-backup-delete")
            shutil.rmtree(backup)
            fault("cleanup-after-legacy-state-backup-delete")
            fsync_directory(backup.parent)
            fault("cleanup-after-legacy-state-parent-fsync")

    if recovery.get("legacyPluginIndexAction") in {"pruned", "quarantined-redundant"}:
        _, target = expected_upgrade_state_paths()
        backup = exact_sibling_backup(
            target, str(recovery.get("legacyPluginIndexBackupPath", "")), ".portal-backup-"
        )
        expected = recovery.get("legacyPluginIndexBackupSha256")
        if not SHA256.fullmatch(str(expected or "")):
            fail("plugin-index cleanup fingerprint missing")
        if not os.path.lexists(backup):
            if restored and os.path.lexists(target):
                safe_file(target, mode=None, maximum=1024 * 1024)
                if sha256_file(target) == expected:
                    backup = None
                else:
                    fail("plugin-index restored target drift")
            elif not restored and recovery.get("legacyPluginIndexAction") == "quarantined-redundant" \
                    and not os.path.lexists(target):
                backup = None
            elif not restored and recovery.get("legacyPluginIndexAction") == "pruned" \
                    and os.path.lexists(target):
                after = recovery.get("legacyPluginIndexAfterSha256")
                if not SHA256.fullmatch(str(after or "")):
                    fail("plugin-index committed fingerprint missing")
                safe_file(target, mode=None, maximum=1024 * 1024)
                if sha256_file(target) != after:
                    fail("plugin-index committed target drift")
                backup = None
            else:
                fail("plugin-index cleanup backup is missing")
        else:
            safe_file(backup, mode=None, maximum=1024 * 1024)
        if backup is not None and sha256_file(backup) != expected:
            fail("plugin-index cleanup backup drift")
        if restored:
            safe_file(target, mode=None, maximum=1024 * 1024)
            if sha256_file(target) != expected:
                fail("plugin-index restored target drift")
        elif recovery.get("legacyPluginIndexAction") == "quarantined-redundant":
            if os.path.lexists(target):
                fail("quarantined plugin index reappeared before commit cleanup")
        else:
            after = recovery.get("legacyPluginIndexAfterSha256")
            if not SHA256.fullmatch(str(after or "")):
                fail("plugin-index committed fingerprint missing")
            safe_file(target, mode=None, maximum=1024 * 1024)
            if sha256_file(target) != after:
                fail("plugin-index committed target drift")
        if backup is not None:
            fault("cleanup-before-plugin-index-backup-delete")
            backup.unlink()
            fault("cleanup-after-plugin-index-backup-delete")
            fsync_directory(backup.parent)
            fault("cleanup-after-plugin-index-parent-fsync")


def validate_snapshot_tree(root: Path) -> None:
    safe_directory(root)
    for entry in root.rglob("*"):
        info = os.lstat(entry)
        if info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            fail(f"unsafe migration snapshot artifact: {entry}")
        if not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            fail(f"unsupported migration snapshot artifact: {entry}")


def terminal_intent_path(tombstone: Path) -> Path:
    return tombstone.with_name(tombstone.name + ".intent")


def publish_terminal_intent(root: Path, tombstone: Path, value, ledger: Path):
    intent = terminal_intent_path(tombstone)
    root_info = safe_directory(root, exact_mode=0o700)
    document = {
        "schema": "bridgesllm-openclaw-migration-terminal-intent-v1",
        "root": str(root),
        "tombstone": str(tombstone),
        "rootDevice": root_info.st_dev,
        "rootInode": root_info.st_ino,
        "terminalPhase": value["phase"],
        "ledgerSha256": sha256_file(ledger),
    }
    if os.path.lexists(intent):
        safe_file(intent, mode=0o600, maximum=16 * 1024)
        if read_json(intent, maximum=16 * 1024) != document:
            fail("terminal migration intent changed after publication")
        return intent, document
    fault("cleanup-before-terminal-intent")
    atomic_json(intent, document)
    fault("cleanup-after-terminal-intent")
    return intent, document


def load_terminal_intent(root: Path, tombstone: Path):
    intent = terminal_intent_path(tombstone)
    safe_file(intent, mode=0o600, maximum=16 * 1024)
    document = read_json(intent, maximum=16 * 1024)
    if not isinstance(document, dict) or set(document) != {
        "schema", "root", "tombstone", "rootDevice", "rootInode",
        "terminalPhase", "ledgerSha256",
    } or document.get("schema") \
            != "bridgesllm-openclaw-migration-terminal-intent-v1" \
            or document.get("root") != str(root) \
            or document.get("tombstone") != str(tombstone) \
            or document.get("terminalPhase") not in {
                "restored-cleanup", "committed-cleanup",
            } \
            or not isinstance(document.get("rootDevice"), int) \
            or not isinstance(document.get("rootInode"), int) \
            or not SHA256.fullmatch(str(document.get("ledgerSha256", ""))):
        fail("terminal migration intent is malformed")
    return intent, document


def retain_runtime_bookkeeping(root: Path, migration_manifest: Path) -> None:
    receipt_path = root / "migration.json.runtime-bookkeeping.json"
    if os.path.lexists(receipt_path):
        migration = read_json(migration_manifest)
        if migration.get("state") != "restored" or migration.get("phase") != "restored":
            fail("runtime bookkeeping evidence requires a completed rollback")
        safe_file(receipt_path, mode=0o600, maximum=16 * 1024 * 1024)
        if migration.get("generatedReceiptPath") != str(receipt_path) \
                or not SHA256.fullmatch(str(migration.get("generatedReceiptSha256", ""))) \
                or sha256_file(receipt_path) != migration["generatedReceiptSha256"]:
            fail("runtime bookkeeping evidence differs from the restore receipt")
        safe_file(receipt_path, mode=0o600, maximum=16 * 1024 * 1024)
        # Retain generated config-observation history after successful rollback
        # retires its transaction, without including it in command output.
        retained = root.parent / (root.name + ".runtime-bookkeeping-" + migration["generatedReceiptSha256"] + ".json")
        if os.path.lexists(retained):
            safe_file(retained, mode=0o600, maximum=16 * 1024 * 1024)
            if sha256_file(retained) != migration["generatedReceiptSha256"]:
                fail("retained runtime bookkeeping evidence changed")
        else:
            atomic_copy_file(receipt_path, retained, 0o600)


def cleanup(args) -> None:
    ledger = Path(args.ledger)
    value = load_ledger(ledger)
    if value["phase"] != args.expected or value["phase"] not in {"restored-cleanup", "committed-cleanup"}:
        fail("transaction is not at a terminal cleanup phase")
    validate_gateway_terminal_activation(
        value, committed=value["phase"] == "committed-cleanup",
    )
    required_codex_phase = (
        {"unarmed", "rollback-attested"}
        if value["phase"] == "restored-cleanup"
        else {"forward-attested"}
    )
    if value["codex"]["phase"] not in required_codex_phase:
        fail("Codex journal is not at the matching terminal boundary")
    root = ledger.parent
    migration_manifest = Path(value["paths"]["migrationManifest"])
    required_migration_state = "restored" if value["phase"] == "restored-cleanup" else "committed"
    if os.path.lexists(migration_manifest):
        migration = read_json(migration_manifest)
        if (
            migration.get("state") != required_migration_state
            or Path(str(migration.get("manifestPath", ""))).resolve() != migration_manifest
        ):
            fail("migration manifest is not at the matching terminal state")
    elif value["phase"] != "restored-cleanup" or value["prepared"]["migrationSha256"] is not None:
        fail("migration manifest is missing at terminal cleanup")
    retain_runtime_bookkeeping(root, migration_manifest)
    remove_upgrade_state_backups(value, value["phase"])
    allowed = {
        "transaction.json", "upgrade-state.json", "migration.json",
        "migrate-openclaw-2026.9.1.mjs", "openclaw-migration-transaction.py",
        "openclaw-stable-plugins.sh", "codex-plugin",
        "codex-forward-gateway-proof.json", "codex-rollback-gateway-proof.json",
        "openclaw-core-rollback.tgz", "openclaw-gateway.service",
        "migration.json.openclaw.json.before", "migration.json.authority-before",
        "migration.json.cron-before", "migration.json.runtime-bookkeeping.json",
    }
    for entry in root.iterdir():
        if entry.name not in allowed:
            fail(f"unknown migration transaction artifact: {entry}")
        if entry.is_symlink():
            fail(f"unsafe migration transaction artifact: {entry}")
        if entry.is_dir():
            validate_snapshot_tree(entry)
        else:
            maximum = 512 * 1024 * 1024 \
                if entry.name == "openclaw-core-rollback.tgz" \
                else 16 * 1024 * 1024
            safe_file(entry, mode=None, maximum=maximum)
    tombstone = Path(args.tombstone)
    if (
        not tombstone.is_absolute()
        or Path(os.path.normpath(tombstone)) != tombstone
        or tombstone.parent != root.parent
        or tombstone.name != root.name + ".terminal"
    ):
        fail("terminal migration tombstone path is unsafe or occupied")
    intent, intent_document = publish_terminal_intent(root, tombstone, value, ledger)
    if os.path.lexists(tombstone):
        fail("active migration root and terminal tombstone are both present")
    fault("cleanup-before-terminal-rename")
    os.replace(root, tombstone)
    fault("cleanup-after-terminal-rename")
    fsync_directory(root.parent)
    fault("cleanup-after-terminal-parent-fsync")
    retire_tombstone(root, tombstone, intent, intent_document)


def retire_tombstone(root: Path, tombstone: Path, intent: Path, document) -> None:
    if os.path.lexists(root):
        fail("active migration root and terminal tombstone are both present")
    if not os.path.lexists(tombstone):
        fault("tombstone-before-intent-delete")
        intent.unlink()
        fault("tombstone-after-intent-delete")
        fsync_directory(intent.parent)
        fault("tombstone-after-intent-parent-fsync")
        return
    safe_directory(tombstone, exact_mode=0o700)
    tombstone_info = os.lstat(tombstone)
    if (tombstone_info.st_dev, tombstone_info.st_ino) != (
        document["rootDevice"], document["rootInode"],
    ):
        fail("terminal migration tombstone inode changed")
    allowed = {
        "transaction.json", "upgrade-state.json", "migration.json",
        "migrate-openclaw-2026.9.1.mjs", "openclaw-migration-transaction.py",
        "openclaw-stable-plugins.sh", "codex-plugin",
        "codex-forward-gateway-proof.json", "codex-rollback-gateway-proof.json",
        "openclaw-core-rollback.tgz", "openclaw-gateway.service",
        "migration.json.openclaw.json.before", "migration.json.authority-before",
        "migration.json.cron-before", "migration.json.runtime-bookkeeping.json",
    }
    entries = sorted(tombstone.iterdir(), key=lambda item: item.name)
    for entry in entries:
        if entry.name not in allowed or entry.is_symlink():
            fail(f"unsafe terminal migration tombstone artifact: {entry}")
        if entry.is_dir():
            validate_snapshot_tree(entry)
        else:
            safe_file(
                entry, mode=None,
                maximum=(512 * 1024 * 1024
                         if entry.name == "openclaw-core-rollback.tgz"
                         else 16 * 1024 * 1024),
            )
    for entry in entries:
        fault(f"cleanup-before-artifact-delete-{entry.name}")
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        fault(f"cleanup-after-artifact-delete-{entry.name}")
        fsync_directory(tombstone)
        fault(f"cleanup-after-artifact-fsync-{entry.name}")
    fault("tombstone-before-directory-remove")
    tombstone.rmdir()
    fault("tombstone-after-directory-remove")
    fsync_directory(tombstone.parent)
    fault("tombstone-after-parent-fsync")
    fault("tombstone-before-intent-delete")
    intent.unlink()
    fault("tombstone-after-intent-delete")
    fsync_directory(intent.parent)
    fault("tombstone-after-intent-parent-fsync")


def sweep_terminal(args) -> None:
    root = Path(args.root)
    tombstone = Path(args.tombstone)
    if (
        not root.is_absolute()
        or Path(os.path.normpath(root)) != root
        or not tombstone.is_absolute()
        or Path(os.path.normpath(tombstone)) != tombstone
        or tombstone.parent != root.parent
        or tombstone.name != root.name + ".terminal"
    ):
        fail("terminal migration tombstone binding mismatch")
    safe_directory(root.parent, exact_mode=0o700)
    intent, document = load_terminal_intent(root, tombstone)
    retire_tombstone(root, tombstone, intent, document)


def build_parser():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    create_parser = subparsers.add_parser("create")
    create_parser.add_argument("--root", required=True)
    create_parser.add_argument("--ledger", required=True)
    create_parser.add_argument("--migration-helper-source", required=True)
    create_parser.add_argument("--transaction-helper-source", required=True)
    create_parser.add_argument("--stable-plugins-helper-source", required=True)
    create_parser.add_argument("--gateway-was-active", required=True)
    create_parser.add_argument("--gateway-unit-identity-json", required=True)
    create_parser.add_argument("--gateway-was-enabled", required=True)
    create_parser.add_argument("--gateway-unit-preexisted", required=True)
    create_parser.add_argument("--gateway-committed-active", required=True)
    create_parser.add_argument("--gateway-committed-enabled", required=True)
    create_parser.add_argument("--package-preexisted", required=True)
    create_parser.add_argument("--state-root-preexisted", required=True)
    create_parser.add_argument("--state-preexisted", required=True)
    create_parser.add_argument("--state-config-preexisted", required=True)
    create_parser.set_defaults(handler=create)
    arm_fresh_core_parser = subparsers.add_parser("arm-fresh-core")
    arm_fresh_core_parser.add_argument("--ledger", required=True)
    arm_fresh_core_parser.set_defaults(handler=arm_fresh_core)
    adopt_core_parser = subparsers.add_parser("adopt-current-core")
    adopt_core_parser.add_argument("--ledger", required=True)
    adopt_core_parser.add_argument("--package-version", required=True)
    adopt_core_parser.add_argument("--runtime-version", required=True)
    adopt_core_parser.set_defaults(handler=adopt_current_core)
    gateway_provision_arm_parser = subparsers.add_parser("arm-gateway-provision")
    gateway_provision_arm_parser.add_argument("--ledger", required=True)
    gateway_provision_arm_parser.add_argument("--unit-source", required=True)
    gateway_provision_arm_parser.set_defaults(handler=arm_gateway_provision)
    gateway_publish_parser = subparsers.add_parser("publish-gateway-unit")
    gateway_publish_parser.add_argument("--ledger", required=True)
    gateway_publish_parser.set_defaults(handler=publish_gateway_unit)
    gateway_reload_parser = subparsers.add_parser("record-gateway-daemon-reload")
    gateway_reload_parser.add_argument("--ledger", required=True)
    gateway_reload_parser.add_argument("--identity-json", required=True)
    gateway_reload_parser.set_defaults(handler=record_gateway_daemon_reload)
    gateway_provision_result_parser = subparsers.add_parser("record-gateway-provision")
    gateway_provision_result_parser.add_argument("--ledger", required=True)
    gateway_provision_result_parser.add_argument("--identity-json", required=True)
    gateway_provision_result_parser.set_defaults(handler=record_gateway_provision)
    gateway_remove_parser = subparsers.add_parser("remove-gateway-unit")
    gateway_remove_parser.add_argument("--ledger", required=True)
    gateway_remove_parser.set_defaults(handler=remove_gateway_unit)
    gateway_absence_parser = subparsers.add_parser("record-gateway-absence")
    gateway_absence_parser.add_argument("--ledger", required=True)
    gateway_absence_parser.set_defaults(handler=record_gateway_absence)
    seal_core_parser = subparsers.add_parser("seal-core")
    seal_core_parser.add_argument("--ledger", required=True)
    seal_core_parser.add_argument("--rollback-package", required=True)
    seal_core_parser.add_argument("--package-version", required=True)
    seal_core_parser.add_argument("--runtime-version", required=True)
    seal_core_parser.add_argument("--gateway-was-active", required=True)
    seal_core_parser.add_argument("--gateway-was-enabled", required=True)
    seal_core_parser.set_defaults(handler=seal_core)
    begin_codex_parser = subparsers.add_parser("begin-codex")
    begin_codex_parser.add_argument("--ledger", required=True)
    begin_codex_parser.add_argument("--plugin-catalog", choices=("codex", "portal"), default="codex")
    begin_codex_parser.add_argument("--preexisted", required=True)
    begin_codex_parser.add_argument("--mutation-required", required=True)
    begin_codex_parser.add_argument("--baseline-json", required=True)
    begin_codex_parser.add_argument("--target-version", required=True)
    begin_codex_parser.add_argument("--target-integrity", required=True)
    begin_codex_parser.add_argument("--gateway-was-active", required=True)
    begin_codex_parser.add_argument("--gateway-main-pid", required=True)
    begin_codex_parser.add_argument("--gateway-invocation-id", required=True)
    begin_codex_parser.add_argument("--gateway-start-monotonic", required=True)
    begin_codex_parser.add_argument("--gateway-unit-identity-json", required=True)
    begin_codex_parser.set_defaults(handler=begin_codex)
    record_codex_gateway_parser = subparsers.add_parser("record-codex-gateway")
    record_codex_gateway_parser.add_argument("--ledger", required=True)
    record_codex_gateway_parser.add_argument(
        "--role", required=True, choices=("forward", "rollback"),
    )
    record_codex_gateway_parser.add_argument("--identity-json", required=True)
    record_codex_gateway_parser.set_defaults(handler=record_codex_gateway_identity)
    record_codex_start_parser = subparsers.add_parser("record-codex-gateway-start")
    record_codex_start_parser.add_argument("--ledger", required=True)
    record_codex_start_parser.add_argument(
        "--role", required=True, choices=("forward", "rollback"),
    )
    record_codex_start_parser.add_argument("--identity-json", required=True)
    record_codex_start_parser.set_defaults(handler=record_codex_gateway_start)
    core_gateway_arm_parser = subparsers.add_parser("arm-core-gateway-action")
    core_gateway_arm_parser.add_argument("--ledger", required=True)
    core_gateway_arm_parser.add_argument(
        "--action", required=True, choices=("start", "stop"),
    )
    core_gateway_arm_parser.add_argument(
        "--purpose", required=True, choices=sorted(GATEWAY_ACTION_PURPOSES),
    )
    core_gateway_arm_parser.add_argument("--identity-json", required=True)
    core_gateway_arm_parser.set_defaults(handler=arm_core_gateway_action)
    core_gateway_result_parser = subparsers.add_parser("record-core-gateway-result")
    core_gateway_result_parser.add_argument("--ledger", required=True)
    core_gateway_result_parser.add_argument("--identity-json", required=True)
    core_gateway_result_parser.set_defaults(handler=record_core_gateway_result)
    core_gateway_adopt_parser = subparsers.add_parser("adopt-core-gateway-identity")
    core_gateway_adopt_parser.add_argument("--ledger", required=True)
    core_gateway_adopt_parser.add_argument("--identity-json", required=True)
    core_gateway_adopt_parser.add_argument("--fence-marker", required=True)
    core_gateway_adopt_parser.set_defaults(handler=adopt_core_gateway_identity)
    codex_transition_parser = subparsers.add_parser("codex-transition")
    codex_transition_parser.add_argument("--ledger", required=True)
    codex_transition_parser.add_argument("--expected", required=True, choices=sorted(CODEX_PHASES))
    codex_transition_parser.add_argument("--to", required=True, choices=sorted(CODEX_PHASES))
    codex_transition_parser.add_argument("--journal-binding")
    codex_transition_parser.add_argument("--gateway-main-pid")
    codex_transition_parser.add_argument("--gateway-invocation-id")
    codex_transition_parser.add_argument("--gateway-start-monotonic")
    codex_transition_parser.add_argument("--proof-sha256")
    codex_transition_parser.set_defaults(handler=codex_transition)
    core_rollback_parser = subparsers.add_parser("core-rollback")
    core_rollback_parser.add_argument("--ledger", required=True)
    core_rollback_parser.set_defaults(handler=core_rollback)
    for command, handler in (
        ("inspect", inspect),
        ("binding", binding),
        ("restore-upgrade", restore_upgrade),
        ("core-present", core_present),
        ("core-removal-required", core_removal_required),
        ("fresh-core-removal", fresh_core_removal),
        ("restore-state-absence", restore_state_absence),
        ("gateway-status", gateway_status),
        ("gateway-provision-authority", gateway_provision_authority),
        ("codex-authority", codex_authority),
        ("codex-helper", codex_helper),
        ("core-gateway-authority", core_gateway_authority),
    ):
        child = subparsers.add_parser(command)
        child.add_argument("--ledger", required=True)
        if command == "gateway-status":
            child.add_argument(
                "--purpose", required=True, choices=sorted(GATEWAY_ACTION_PURPOSES),
            )
        child.set_defaults(handler=handler)
    advance_parser = subparsers.add_parser("advance")
    advance_parser.add_argument("--ledger", required=True)
    advance_parser.add_argument("--expected", required=True, choices=sorted(PHASES))
    advance_parser.add_argument("--to", required=True, choices=sorted(PHASES))
    advance_parser.add_argument("--decision-record")
    advance_parser.set_defaults(handler=advance)
    commit_config_parser = subparsers.add_parser("codex-commit-config")
    commit_config_parser.add_argument("--ledger", required=True)
    commit_config_parser.add_argument("--decision-record", required=True)
    commit_config_parser.set_defaults(handler=codex_commit_config)
    matches_parser = subparsers.add_parser("matches-decision")
    matches_parser.add_argument("--ledger", required=True)
    matches_parser.add_argument("--decision-record", required=True)
    matches_parser.set_defaults(handler=matches)
    cleanup_parser = subparsers.add_parser("cleanup")
    cleanup_parser.add_argument("--ledger", required=True)
    cleanup_parser.add_argument("--expected", required=True, choices=["restored-cleanup", "committed-cleanup"])
    cleanup_parser.add_argument("--tombstone", required=True)
    cleanup_parser.set_defaults(handler=cleanup)
    sweep_parser = subparsers.add_parser("sweep-terminal")
    sweep_parser.add_argument("--root", required=True)
    sweep_parser.add_argument("--tombstone", required=True)
    sweep_parser.set_defaults(handler=sweep_terminal)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    try:
        main()
    except (ContractError, OSError, KeyError, TypeError, ValueError) as error:
        print(f"openclaw migration transaction: {error}", file=os.sys.stderr)
        raise SystemExit(1)
