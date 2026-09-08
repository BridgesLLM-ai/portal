#!/usr/bin/env python3
"""Durable exact-tree transaction for the Portal-qualified native CLI bundle.

This helper deliberately does not invoke npm.  It materializes only the exact
archives and full-tree identities carried by Portal's signed admission catalog,
then atomically swaps the three global package roots and their executable links.
The fixed transaction root is also the execution-admission fence used by Portal.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform as host_platform
import re
import shutil
import signal
import stat
import subprocess
import tarfile
import tempfile
from typing import Any
import urllib.parse
import urllib.request


SCHEMA = "bridgesllm-native-cli-bundle-transaction-v1"
BINDING_SCHEMA = "bridgesllm-native-cli-bundle-binding-v1"
DECISION_SCHEMA = "bridgesllm-openclaw-tested-pair-commit-v5"
TERMINAL_SCHEMA = "bridgesllm-native-cli-bundle-terminal-intent-v1"
CATALOG_SCHEMA = "bridgesllm.native-host-cli-admission-catalog.v1"
DEFAULT_ROOT = Path("/var/lib/bridgesllm-installer/native-cli-bundle-v1")
TOOL_ORDER = ("codex", "claude-code", "clawhub")
PHASES = {
    "prepared",
    "applying",
    "target-verified",
    "commit-pending",
    "committed-cleanup",
    "rollback-pending",
    "rolled-back",
}
GENERATION = re.compile(r"^[a-f0-9]{32}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
VERSION = re.compile(r"^[0-9]+(?:\.[0-9A-Za-z-]+){1,4}$")
SOURCE_ONLY = os.environ.get("BRIDGESLLM_INSTALLER_SOURCE_ONLY") == "1"
EXPECTED_UID = os.geteuid() if SOURCE_ONLY else 0
EXPECTED_GID = os.getegid() if SOURCE_ONLY else 0


class ContractError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ContractError(message)


def fault(point: str) -> None:
    if SOURCE_ONLY and os.environ.get("PORTAL_NATIVE_CLI_BUNDLE_FAULT") == point:
        os.kill(os.getpid(), signal.SIGKILL)


def duplicate_rejecting_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha512_file(path: Path) -> str:
    digest = hashlib.sha512()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return base64.b64encode(digest.digest()).decode()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def safe_directory(path: Path, *, exact_mode: int | None = None) -> os.stat_result:
    info = os.lstat(path)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != EXPECTED_UID
        or info.st_gid != EXPECTED_GID
        or (exact_mode is None and info.st_mode & 0o022)
        or (exact_mode is not None and stat.S_IMODE(info.st_mode) != exact_mode)
        or path.resolve() != path
    ):
        fail(f"unsafe directory: {path}")
    return info


def safe_file(path: Path, *, maximum: int = 16 * 1024 * 1024) -> os.stat_result:
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != EXPECTED_UID
        or info.st_gid != EXPECTED_GID
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or info.st_size <= 0
        or info.st_size > maximum
    ):
        fail(f"unsafe file: {path}")
    return info


def read_json(path: Path, *, maximum: int = 16 * 1024 * 1024, canonical: bool = False):
    safe_file(path, maximum=maximum)
    raw = path.read_bytes()
    try:
        value = json.loads(raw, object_pairs_hook=duplicate_rejecting_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid JSON at {path}: {error}")
    if canonical and raw != canonical_json(value):
        fail(f"non-canonical JSON at {path}")
    return value


def atomic_json(path: Path, value: Any) -> None:
    safe_directory(path.parent, exact_mode=0o700)
    descriptor, raw_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(raw_name)
    try:
        os.fchown(descriptor, EXPECTED_UID, EXPECTED_GID)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(canonical_json(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        fsync_directory(path.parent)
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def durable_copy(
    source: Path,
    destination: Path,
    maximum: int = 32 * 1024 * 1024,
) -> None:
    safe_file(source, maximum=maximum)
    descriptor, raw_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    temporary = Path(raw_name)
    try:
        os.fchown(descriptor, EXPECTED_UID, EXPECTED_GID)
        os.fchmod(descriptor, 0o600)
        with source.open("rb") as incoming, os.fdopen(descriptor, "wb") as outgoing:
            shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        os.replace(temporary, destination)
        temporary = None
        fsync_directory(destination.parent)
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def identity(path: Path) -> dict[str, int]:
    info = os.lstat(path)
    return {
        "device": info.st_dev,
        "inode": info.st_ino,
        "mode": stat.S_IMODE(info.st_mode),
        "uid": info.st_uid,
        "gid": info.st_gid,
    }


def identity_matches(path: Path, expected: dict[str, int], kind: str) -> bool:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    if kind == "directory" and (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
        return False
    if kind == "symlink" and not stat.S_ISLNK(info.st_mode):
        return False
    return identity(path) == expected


def mapped_path(prefix: Path, absolute: str) -> Path:
    candidate = Path(absolute)
    if not candidate.is_absolute() or str(candidate) != os.path.normpath(str(candidate)):
        fail(f"catalog path is not canonical and absolute: {absolute}")
    return candidate if prefix == Path("/") else prefix / str(candidate).lstrip("/")


def ensure_secure_state_parent(root: Path) -> None:
    parent = root.parent
    if not parent.exists():
        parent.mkdir(parents=True, mode=0o700)
        os.chown(parent, EXPECTED_UID, EXPECTED_GID)
        os.chmod(parent, 0o700)
        fsync_directory(parent.parent)
    safe_directory(parent, exact_mode=0o700)


def secure_parent(path: Path) -> os.stat_result:
    return safe_directory(path.parent)


def platform_key() -> str:
    machine = host_platform.machine().lower()
    if machine in {"x86_64", "amd64"}:
        return "linux-x64-gnu"
    if machine in {"aarch64", "arm64"}:
        return "linux-arm64-gnu"
    fail(f"unsupported native CLI architecture: {machine}")


def validate_limits(value: Any) -> dict[str, int]:
    if not isinstance(value, dict) or set(value) != {
        "maxDepth", "maxEntries", "maxFileBytes", "maxTotalBytes"
    }:
        fail("native CLI catalog limits are malformed")
    result = {}
    for key, limit in value.items():
        if not isinstance(limit, int) or limit <= 0 or limit > 4 * 1024 * 1024 * 1024:
            fail("native CLI catalog limit is invalid")
        result[key] = limit
    return result


def load_catalog(path: Path) -> dict[str, Any]:
    value = read_json(path, maximum=32 * 1024 * 1024)
    if not isinstance(value, dict) or value.get("schema") != CATALOG_SCHEMA:
        fail("native CLI admission catalog schema mismatch")
    validate_limits(value.get("limits"))
    tools = value.get("tools")
    if not isinstance(tools, dict) or any(tool not in tools for tool in TOOL_ORDER):
        fail("native CLI admission catalog tool set is incomplete")
    return value


def validate_url(raw: str) -> None:
    parsed = urllib.parse.urlsplit(raw)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "registry.npmjs.org"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.endswith(".tgz")
    ):
        fail(f"unapproved native CLI archive URL: {raw}")


def verify_archive(source: dict[str, Any], archive: Path, maximum: int) -> None:
    info = safe_file(archive, maximum=maximum)
    if info.st_size > maximum or sha256_file(archive) != source.get("sha256"):
        fail(f"native CLI archive SHA-256 mismatch: {source.get('tarball')}")
    integrity = source.get("integrity")
    if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
        fail("native CLI archive SRI is malformed")
    if sha512_file(archive) != integrity.removeprefix("sha512-"):
        fail(f"native CLI archive SRI mismatch: {source.get('tarball')}")


def acquire_archive(source: dict[str, Any], directory: Path, cache: Path | None, maximum: int) -> Path:
    for field in ("packageName", "version", "placement", "sha256", "integrity", "tarball"):
        if not isinstance(source.get(field), str) or "\x00" in source[field]:
            fail(f"native CLI source field is malformed: {field}")
    if not SHA256.fullmatch(source["sha256"]):
        fail("native CLI archive digest is malformed")
    validate_url(source["tarball"])
    destination = directory / f"{source['sha256']}.tgz"
    if cache is not None:
        cached = cache / destination.name
        verify_archive(source, cached, maximum)
        durable_copy(cached, destination, maximum=maximum)
        verify_archive(source, destination, maximum)
        return destination
    if SOURCE_ONLY:
        fail("source-only native CLI preparation requires an exact archive cache")
    request = urllib.request.Request(source["tarball"], headers={"User-Agent": "BridgesLLM-Portal/4.1"})
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with urllib.request.urlopen(request, timeout=120) as response, os.fdopen(descriptor, "wb") as stream:
            validate_url(response.geturl())
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > maximum:
                    fail("native CLI archive exceeded its signed extraction bound")
                stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        try:
            destination.unlink()
        except FileNotFoundError:
            pass
        raise
    fsync_directory(directory)
    verify_archive(source, destination, maximum)
    return destination


def safe_member_name(name: str, max_depth: int) -> str:
    if not name.startswith("package/"):
        fail(f"npm archive member is outside package/: {name}")
    relative = name.removeprefix("package/").rstrip("/")
    candidate = PurePosixPath(relative)
    if (
        not relative
        or candidate.is_absolute()
        or "." in candidate.parts
        or ".." in candidate.parts
        or len(candidate.parts) > max_depth
        or any("\x00" in part for part in candidate.parts)
    ):
        fail(f"npm archive member path is invalid: {name}")
    return candidate.as_posix()


def mkdir_chain(path: Path, boundary: Path) -> None:
    missing = []
    current = path
    while current != boundary and not current.exists():
        missing.append(current)
        current = current.parent
    if current != boundary and not str(current).startswith(str(boundary) + os.sep):
        fail("native CLI extraction escaped its target")
    for directory in reversed(missing):
        directory.mkdir(mode=0o755)
        # mkdir's mode is masked by the installer umask (077). These package
        # directories have an exact signed mode, inside a private staging root.
        directory.chmod(0o755)


def materialize_archive(archive: Path, destination: Path, limits: dict[str, int]) -> None:
    destination.mkdir(parents=True, exist_ok=True, mode=0o755)
    os.chmod(destination, 0o755)
    seen: set[str] = set()
    total_bytes = 0
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if not members or len(members) > limits["maxEntries"]:
            fail("native CLI archive member count exceeds the signed bound")
        validated = []
        for member in members:
            relative = safe_member_name(member.name, limits["maxDepth"])
            if relative in seen:
                fail(f"native CLI archive contains duplicate member: {relative}")
            seen.add(relative)
            if member.uid != 0 or member.gid != 0 or member.mode & 0o7022:
                fail(f"native CLI archive member authority is unsafe: {relative}")
            if member.isfile():
                if member.size < 0 or member.size > limits["maxFileBytes"]:
                    fail(f"native CLI archive file exceeds the signed bound: {relative}")
                total_bytes += member.size
                if total_bytes > limits["maxTotalBytes"]:
                    fail("native CLI archive expansion exceeds the signed bound")
            elif not member.isdir():
                fail(f"native CLI archive contains unsupported member: {relative}")
            validated.append((member, relative))
        for member, relative in validated:
            target = destination.joinpath(*PurePosixPath(relative).parts)
            if member.isdir():
                mkdir_chain(target, destination)
                target.mkdir(exist_ok=True, mode=member.mode & 0o777)
                os.chmod(target, member.mode & 0o777)
                continue
            mkdir_chain(target.parent, destination)
            if os.path.lexists(target):
                fail(f"native CLI archive member collides: {relative}")
            incoming = bundle.extractfile(member)
            if incoming is None:
                fail(f"native CLI archive member cannot be read: {relative}")
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, member.mode & 0o777)
            with incoming, os.fdopen(descriptor, "wb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
                outgoing.flush()
                os.fsync(outgoing.fileno())
            os.chmod(target, member.mode & 0o777)


def package_json(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    if not raw or len(raw) > 1024 * 1024 or b"\x00" in raw:
        fail(f"package metadata is not bounded: {path}")
    try:
        value = json.loads(raw, object_pairs_hook=duplicate_rejecting_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"invalid package metadata at {path}: {error}")
    if not isinstance(value, dict):
        fail(f"invalid package metadata at {path}")
    return value


def create_dependency_bin_links(root: Path, sources: list[dict[str, Any]]) -> None:
    bin_root = root / "node_modules/.bin"
    for source in sources:
        placement = source["placement"]
        if not placement.startswith("node_modules/"):
            continue
        dependency_root = root / placement
        metadata = package_json(dependency_root / "package.json")
        raw_bin = metadata.get("bin", {})
        if isinstance(raw_bin, str):
            raw_bin = {metadata.get("name"): raw_bin}
        if not isinstance(raw_bin, dict):
            fail(f"package bin mapping is invalid: {placement}")
        for name, relative in raw_bin.items():
            if (
                not isinstance(name, str)
                or not name
                or name in {".", ".."}
                or "/" in name
                or "\\" in name
                or not isinstance(relative, str)
                or not relative
            ):
                fail(f"package bin mapping is invalid: {placement}")
            relative_path = PurePosixPath(relative)
            if relative_path.is_absolute() or "." in relative_path.parts or ".." in relative_path.parts:
                fail(f"package bin target escapes its package: {placement}/{relative}")
            target = dependency_root.joinpath(*relative_path.parts)
            if not target.is_file() or target.is_symlink():
                fail(f"package bin target is missing: {placement}/{relative}")
            target.chmod(target.stat().st_mode | 0o111)
            bin_root.mkdir(parents=True, exist_ok=True, mode=0o755)
            os.chmod(bin_root, 0o755)
            link = bin_root / name
            relative_target = os.path.relpath(target, bin_root)
            if os.path.lexists(link):
                if not link.is_symlink() or os.readlink(link) != relative_target:
                    fail(f"package bin alias collides: {name}")
            else:
                link.symlink_to(relative_target)


def apply_hardlink_groups(root: Path, groups: Any, critical_files: Any) -> None:
    if not isinstance(groups, list) or not isinstance(critical_files, dict):
        fail("native CLI hardlink contract is malformed")
    for group in groups:
        if not isinstance(group, list) or len(group) < 2 or any(not isinstance(x, str) for x in group):
            fail("native CLI hardlink group is malformed")
        relatives = [PurePosixPath(item) for item in group]
        if any(
            relative.is_absolute()
            or "." in relative.parts
            or ".." in relative.parts
            or relative.as_posix() != raw
            for raw, relative in zip(group, relatives)
        ):
            fail("native CLI hardlink path is unsafe")
        expected_hashes = {critical_files.get(item) for item in group}
        if len(expected_hashes) != 1:
            fail("native CLI hardlink group lacks one signed content identity")
        expected_hash = next(iter(expected_hashes))
        if not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
            fail("native CLI hardlink content identity is malformed")
        paths = [root.joinpath(*relative.parts) for relative in relatives]
        candidates = []
        for candidate in paths:
            if not candidate.is_file() or candidate.is_symlink():
                fail("native CLI hardlink member is missing")
            if sha256_file(candidate) == expected_hash:
                candidates.append(candidate)
        if not candidates:
            fail("native CLI hardlink group cannot be reconstructed from signed package bytes")
        source = candidates[0]
        for target in paths:
            if target == source:
                continue
            target.unlink()
            os.link(source, target)


def tree_digest(root: Path, limits: dict[str, int]) -> tuple[str, dict[str, dict[str, Any]]]:
    safe_directory(root)
    entries = sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix().encode())
    if len(entries) > limits["maxEntries"]:
        fail(f"native CLI package exceeds its entry bound: {root}")
    records = []
    observed: dict[str, dict[str, Any]] = {}
    inode_counts: dict[tuple[int, int], int] = {}
    inode_links: dict[tuple[int, int], int] = {}
    total = 0
    for item in entries:
        relative = item.relative_to(root).as_posix()
        if len(PurePosixPath(relative).parts) > limits["maxDepth"]:
            fail(f"native CLI package exceeds its depth bound: {relative}")
        info = os.lstat(item)
        mode = stat.S_IMODE(info.st_mode)
        if info.st_uid != EXPECTED_UID or info.st_gid != EXPECTED_GID:
            fail(f"native CLI package ownership is unsafe: {relative}")
        if stat.S_ISDIR(info.st_mode):
            if mode & 0o022:
                fail(f"native CLI package directory is writable: {relative}")
            record = f"d\0{relative}\0{mode:o}"
            observed[relative] = {"kind": "directory", "mode": mode}
        elif stat.S_ISLNK(info.st_mode):
            target = os.readlink(item)
            resolved = (item.parent / target).resolve()
            if resolved == root.resolve() or not str(resolved).startswith(str(root.resolve()) + os.sep):
                fail(f"native CLI package symlink escapes: {relative}")
            record = f"l\0{relative}\0{target}"
            observed[relative] = {"kind": "symlink", "mode": mode, "target": target}
        elif stat.S_ISREG(info.st_mode):
            if mode & 0o022 or info.st_size > limits["maxFileBytes"]:
                fail(f"native CLI package file is unsafe: {relative}")
            inode = (info.st_dev, info.st_ino)
            inode_counts[inode] = inode_counts.get(inode, 0) + 1
            inode_links[inode] = info.st_nlink
            if inode_counts[inode] == 1:
                total += info.st_size
                if total > limits["maxTotalBytes"]:
                    fail("native CLI package exceeds its byte bound")
            digest = sha256_file(item)
            record = f"f\0{relative}\0{mode:o}\0{info.st_size}\0{digest}"
            observed[relative] = {"kind": "file", "mode": mode, "size": info.st_size, "sha256": digest}
        else:
            fail(f"native CLI package contains a special file: {relative}")
        records.append(record.encode() + b"\n")
    for inode, count in inode_counts.items():
        if inode_links[inode] != count:
            fail("native CLI package has a hardlink outside its admitted tree")
    return hashlib.sha256(b"".join(records)).hexdigest(), observed


def verify_target_tree(root: Path, tool: dict[str, Any], version: str, platform: dict[str, Any], limits: dict[str, int]) -> str:
    digest, observed = tree_digest(root, limits)
    if digest != platform.get("treeSha256"):
        fail(f"native CLI target tree mismatch: {tool.get('packageName')}@{version}")
    metadata = package_json(root / "package.json")
    if metadata.get("name") != tool.get("packageName") or metadata.get("version") != version:
        fail("native CLI target package identity mismatch")
    critical = platform.get("criticalFiles")
    if not isinstance(critical, dict) or any(
        observed.get(path, {}).get("sha256") != digest_value
        for path, digest_value in critical.items()
    ):
        fail("native CLI critical-file contract mismatch")
    actual_groups = []
    inode_paths: dict[tuple[int, int], list[str]] = {}
    for relative, entry in observed.items():
        if entry["kind"] != "file":
            continue
        info = os.lstat(root / relative)
        if info.st_nlink > 1:
            inode_paths.setdefault((info.st_dev, info.st_ino), []).append(relative)
    actual_groups = sorted(sorted(paths) for paths in inode_paths.values())
    expected_groups = sorted(sorted(group) for group in platform.get("hardlinkGroups", []))
    if actual_groups != expected_groups:
        fail("native CLI hardlink layout mismatch")
    platform_relative = platform.get("platformPackageRelative")
    if platform_relative is not None:
        platform_metadata = package_json(root / platform_relative / "package.json")
        if (
            platform_metadata.get("name") != platform.get("platformPackageName")
            or platform_metadata.get("version") != platform.get("platformPackageVersion")
        ):
            fail("native CLI platform package identity mismatch")
    return digest


def snapshot_package(path: Path, package_name: str, limits: dict[str, int]) -> dict[str, Any]:
    if not os.path.lexists(path):
        return {"exists": False}
    safe_directory(path)
    metadata = package_json(path / "package.json")
    version = metadata.get("version")
    if metadata.get("name") != package_name or not isinstance(version, str) or not VERSION.fullmatch(version):
        fail(f"foreign package occupies managed native CLI root: {path}")
    digest, _ = tree_digest(path, limits)
    return {"exists": True, "identity": identity(path), "treeSha256": digest, "version": version}


def snapshot_link(path: Path, expected_target: str) -> dict[str, Any]:
    if not os.path.lexists(path):
        return {"exists": False}
    info = os.lstat(path)
    if (
        not stat.S_ISLNK(info.st_mode)
        or info.st_uid != EXPECTED_UID
        or info.st_gid != EXPECTED_GID
        or os.readlink(path) != expected_target
    ):
        fail(f"foreign executable occupies managed native CLI link: {path}")
    return {"exists": True, "identity": identity(path), "target": expected_target}


def fsync_tree(root: Path) -> None:
    directories = [root]
    for item in sorted(root.rglob("*"), key=lambda value: len(value.parts), reverse=True):
        info = os.lstat(item)
        if stat.S_ISREG(info.st_mode):
            descriptor = os.open(item, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        elif stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
            directories.append(item)
    for directory in sorted(directories, key=lambda value: len(value.parts), reverse=True):
        fsync_directory(directory)


def ledger_path(root: Path) -> Path:
    return root / "transaction.json"


def load_ledger(root: Path) -> dict[str, Any]:
    safe_directory(root, exact_mode=0o700)
    value = read_json(ledger_path(root), canonical=True)
    if (
        not isinstance(value, dict)
        or value.get("schema") != SCHEMA
        or value.get("phase") not in PHASES
        or not GENERATION.fullmatch(str(value.get("generation", "")))
        or value.get("root") != str(root)
        or not isinstance(value.get("binding"), dict)
    ):
        fail("native CLI transaction ledger is malformed")
    helper = root / "native-cli-bundle-transaction.py"
    catalog = root / "native-host-cli-admission-catalog.v1.json"
    safe_file(helper, maximum=32 * 1024 * 1024)
    safe_file(catalog, maximum=32 * 1024 * 1024)
    if sha256_file(helper) != value.get("helperSha256") or sha256_file(catalog) != value.get("catalogSha256"):
        fail("native CLI transaction recovery authority changed")
    if value["binding"].get("schema") != BINDING_SCHEMA or value["binding"].get("generation") != value["generation"]:
        fail("native CLI transaction binding is malformed")
    return value


def save_ledger(root: Path, value: dict[str, Any]) -> None:
    atomic_json(ledger_path(root), value)


def set_phase(root: Path, value: dict[str, Any], expected: set[str], phase: str) -> None:
    if value.get("phase") not in expected or phase not in PHASES:
        fail(f"invalid native CLI transaction transition: {value.get('phase')} -> {phase}")
    fault(f"before-phase-{phase}")
    value["phase"] = phase
    save_ledger(root, value)
    fault(f"after-phase-{phase}")


def verify_clawhub_launch(root: Path, tool: dict[str, Any], version: str) -> None:
    # Only run after exact signed tree verification. No registry resolver,
    # inherited NODE_PATH/NODE_OPTIONS, user profile, or global module fallback.
    if tool.get("packageName") != "clawhub":
        return
    with tempfile.TemporaryDirectory(prefix="clawhub-launch-", dir=root.parent) as home:
        try:
            result = subprocess.run(
                ["/usr/bin/node", "--no-global-search-paths", str(root / tool["binRelative"]), "--cli-version"],
                cwd=home,
                env={"PATH": "/usr/bin:/bin", "HOME": home, "XDG_CONFIG_HOME": home,
                     "XDG_CACHE_HOME": home, "NO_COLOR": "1"},
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=30, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            fail("verified ClawHub package could not launch before native bundle publication")
        if result.returncode != 0 or result.stdout.strip() != version.encode("ascii"):
            fail("verified ClawHub package failed its isolated CLI version check")


def build_target(preparation: Path, tool_id: str, tool: dict[str, Any], version: str, platform_name: str, catalog: dict[str, Any], cache: Path | None) -> dict[str, Any]:
    versions = tool.get("versions")
    entry = versions.get(version) if isinstance(versions, dict) else None
    platform = entry.get("platforms", {}).get(platform_name) if isinstance(entry, dict) else None
    if not isinstance(entry, dict) or entry.get("admission") != "full" or not isinstance(platform, dict):
        fail(f"target native CLI version is not fully admitted: {tool_id}@{version}/{platform_name}")
    limits = validate_limits(catalog["limits"])
    target = preparation / "staged/packages" / tool_id
    target.mkdir(parents=True, mode=0o755)
    archives = preparation / "archives"
    archives.mkdir(exist_ok=True, mode=0o700)
    sources = platform.get("sources")
    if not isinstance(sources, list) or not sources or sources[0].get("placement") != "":
        fail("native CLI source closure is malformed")
    for source in sources:
        placement = source.get("placement")
        if not isinstance(placement, str):
            fail("native CLI source placement is malformed")
        relative = PurePosixPath(placement)
        if relative.is_absolute() or "." in relative.parts or ".." in relative.parts:
            fail("native CLI source placement escapes the package root")
        archive = acquire_archive(source, archives, cache, limits["maxFileBytes"])
        destination = target.joinpath(*relative.parts)
        if placement:
            mkdir_chain(destination.parent, target)
        materialize_archive(archive, destination, limits)
        metadata = package_json(destination / "package.json")
        if metadata.get("name") != source.get("packageName") or metadata.get("version") != source.get("version"):
            fail("native CLI archive package identity mismatch")
    create_dependency_bin_links(target, sources)
    apply_hardlink_groups(
        target,
        platform.get("hardlinkGroups", []),
        platform.get("criticalFiles", {}),
    )
    digest = verify_target_tree(target, tool, version, platform, limits)
    verify_clawhub_launch(target, tool, version)
    # The read-only launch must leave the complete signed tree unchanged.
    verify_target_tree(target, tool, version, platform, limits)
    fsync_tree(target)
    return {
        "identity": identity(target),
        "treeSha256": digest,
        "version": version,
    }


def prepare(args) -> None:
    root = args.root
    prefix = args.prefix
    if not SOURCE_ONLY and (root != DEFAULT_ROOT or prefix != Path("/") or args.archive_cache is not None):
        fail("production native CLI transaction paths are fixed")
    if os.geteuid() != EXPECTED_UID:
        fail("native CLI transaction must run under its expected owner")
    ensure_secure_state_parent(root)
    if os.path.lexists(root) or os.path.lexists(args.tombstone) or os.path.lexists(args.intent):
        fail("a native CLI bundle transaction already exists")
    safe_directory(prefix, exact_mode=None)
    catalog = load_catalog(args.catalog)
    requested = {
        "codex": args.codex_version,
        "claude-code": args.claude_version,
        "clawhub": args.clawhub_version,
    }
    if any(not VERSION.fullmatch(value) for value in requested.values()):
        fail("native CLI target version is malformed")
    generation = os.urandom(16).hex()
    preparation = root.parent / f".{root.name}.prepare.{generation}"
    preparation.mkdir(mode=0o700)
    os.chown(preparation, EXPECTED_UID, EXPECTED_GID)
    try:
        for relative in ("staged/packages", "staged/links", "baseline/packages", "baseline/links", "discard/packages", "discard/links"):
            (preparation / relative).mkdir(parents=True, mode=0o700)
        helper_copy = preparation / "native-cli-bundle-transaction.py"
        catalog_copy = preparation / "native-host-cli-admission-catalog.v1.json"
        durable_copy(Path(__file__).resolve(), helper_copy)
        durable_copy(args.catalog, catalog_copy)
        selected_platform = args.platform or platform_key()
        tools = []
        binding_targets = []
        limits = validate_limits(catalog["limits"])
        for tool_id in TOOL_ORDER:
            tool = catalog["tools"].get(tool_id)
            if not isinstance(tool, dict):
                fail(f"native CLI catalog entry is missing: {tool_id}")
            package_name = tool.get("packageName")
            package_root_raw = tool.get("packageRoot")
            executables = tool.get("executables")
            if not isinstance(package_name, str) or not isinstance(package_root_raw, str) or not isinstance(executables, dict) or not executables:
                fail(f"native CLI catalog tool is malformed: {tool_id}")
            live_root = mapped_path(prefix, package_root_raw)
            global_node_modules = mapped_path(prefix, "/usr/lib/node_modules")
            parent_existed = os.path.lexists(live_root.parent)
            if parent_existed:
                parent_identity = identity(live_root.parent)
                safe_directory(live_root.parent)
            else:
                if live_root.parent.parent != global_node_modules:
                    fail(f"only an absent scoped npm parent may be provisioned: {live_root.parent}")
                safe_directory(global_node_modules)
                parent_identity = None
            baseline = snapshot_package(live_root, package_name, limits)
            target = build_target(preparation, tool_id, tool, requested[tool_id], selected_platform, catalog, args.archive_cache)
            link_entries = []
            for executable_raw, expected_target in sorted(executables.items()):
                if not isinstance(expected_target, str) or not expected_target or "\x00" in expected_target:
                    fail("native CLI executable target is malformed")
                executable = mapped_path(prefix, executable_raw)
                secure_parent(executable)
                baseline_link = snapshot_link(executable, expected_target)
                staged_link = preparation / "staged/links" / tool_id / executable.name
                staged_link.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                staged_link.symlink_to(expected_target)
                link_entries.append({
                    "path": str(executable),
                    "catalogPath": executable_raw,
                    "targetText": expected_target,
                    "baseline": baseline_link,
                    "targetIdentity": identity(staged_link),
                    "stagedPath": str(root / "staged/links" / tool_id / executable.name),
                    "baselinePath": str(root / "baseline/links" / tool_id / executable.name),
                    "discardPath": str(root / "discard/links" / tool_id / executable.name),
                })
            tools.append({
                "id": tool_id,
                "packageName": package_name,
                "packageRoot": str(live_root),
                "catalogPackageRoot": package_root_raw,
                "packageParent": str(live_root.parent),
                "packageParentBaseline": {"exists": parent_existed, "identity": parent_identity},
                "baseline": baseline,
                "baselinePath": str(root / "baseline/packages" / tool_id),
                "discardPath": str(root / "discard/packages" / tool_id),
                "stagedPath": str(root / "staged/packages" / tool_id),
                "target": target,
                "executables": link_entries,
            })
            binding_targets.append({
                "toolId": tool_id,
                "version": requested[tool_id],
                "treeSha256": target["treeSha256"],
                "packageRoot": package_root_raw,
                "executables": dict(sorted(executables.items())),
            })
        binding = {
            "schema": BINDING_SCHEMA,
            "generation": generation,
            "root": str(root),
            "catalogSha256": sha256_file(catalog_copy),
            "helperSha256": sha256_file(helper_copy),
            "platform": selected_platform,
            "targets": binding_targets,
        }
        value = {
            "schema": SCHEMA,
            "generation": generation,
            "phase": "prepared",
            "root": str(root),
            "prefix": str(prefix),
            "catalogSha256": binding["catalogSha256"],
            "helperSha256": binding["helperSha256"],
            "binding": binding,
            "limits": limits,
            "tools": tools,
        }
        atomic_json(preparation / "transaction.json", value)
        fsync_tree(preparation)
        os.replace(preparation, root)
        preparation = None
        fsync_directory(root.parent)
        fault("after-publish")
        print(canonical_json(binding).decode(), end="")
    finally:
        if preparation is not None and preparation.exists():
            remove_tree(preparation)


def classify_package(path: Path, tool: dict[str, Any], value: dict[str, Any]) -> str:
    if not os.path.lexists(path):
        return "absent"
    if identity_matches(path, tool["target"]["identity"], "directory"):
        verify_target_tool(path, tool, value)
        return "target"
    baseline = tool["baseline"]
    if baseline.get("exists") and identity_matches(path, baseline["identity"], "directory"):
        digest, _ = tree_digest(path, value["limits"])
        if digest != baseline["treeSha256"]:
            fail(f"native CLI baseline package drifted: {tool['id']}")
        return "baseline"
    fail(f"foreign package drift at {path}")


def classify_link(path: Path, entry: dict[str, Any]) -> str:
    if not os.path.lexists(path):
        return "absent"
    if identity_matches(path, entry["targetIdentity"], "symlink") and os.readlink(path) == entry["targetText"]:
        return "target"
    baseline = entry["baseline"]
    if baseline.get("exists") and identity_matches(path, baseline["identity"], "symlink") and os.readlink(path) == baseline["target"]:
        return "baseline"
    fail(f"foreign executable-link drift at {path}")


def durable_rename(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.replace(source, destination)
    fsync_directory(source.parent)
    if destination.parent != source.parent:
        fsync_directory(destination.parent)


def ensure_package_parent(tool: dict[str, Any], value: dict[str, Any]) -> None:
    parent = Path(tool["packageParent"])
    baseline = tool["packageParentBaseline"]
    if baseline["exists"]:
        if not identity_matches(parent, baseline["identity"], "directory"):
            fail(f"native CLI package parent drifted: {parent}")
        safe_directory(parent)
        return
    if not os.path.lexists(parent):
        fault(f"before-parent-create-{tool['id']}")
        parent.mkdir(mode=0o755)
        os.chown(parent, EXPECTED_UID, EXPECTED_GID)
        fsync_directory(parent.parent)
        tool["createdParentIdentity"] = identity(parent)
        save_ledger(Path(value["root"]), value)
        fault(f"after-parent-create-{tool['id']}")
        return
    safe_directory(parent)
    recorded = tool.get("createdParentIdentity")
    if recorded is None:
        if any(parent.iterdir()):
            fail(f"unowned package parent appeared during transaction: {parent}")
        tool["createdParentIdentity"] = identity(parent)
        save_ledger(Path(value["root"]), value)
    elif not identity_matches(parent, recorded, "directory"):
        fail(f"created native CLI package parent drifted: {parent}")


def verify_target_tool(path: Path, tool: dict[str, Any], value: dict[str, Any]) -> None:
    catalog = load_catalog(Path(value["root"]) / "native-host-cli-admission-catalog.v1.json")
    definition = catalog["tools"][tool["id"]]
    version = tool["target"]["version"]
    platform = definition["versions"][version]["platforms"][value["binding"]["platform"]]
    digest = verify_target_tree(path, definition, version, platform, value["limits"])
    if digest != tool["target"]["treeSha256"]:
        fail(f"native CLI target changed after staging: {tool['id']}")


def apply_transaction(root: Path, value: dict[str, Any]) -> None:
    if value["phase"] == "prepared":
        set_phase(root, value, {"prepared"}, "applying")
    if value["phase"] not in {"applying", "target-verified", "commit-pending", "committed-cleanup"}:
        fail(f"native CLI transaction cannot apply from phase {value['phase']}")
    if value["phase"] in {"target-verified", "commit-pending", "committed-cleanup"}:
        verify_all_targets(value)
        return
    for tool in value["tools"]:
        ensure_package_parent(tool, value)
        live = Path(tool["packageRoot"])
        baseline_path = Path(tool["baselinePath"])
        staged = Path(tool["stagedPath"])
        live_state = classify_package(live, tool, value)
        baseline_state = classify_package(baseline_path, tool, value)
        staged_state = classify_package(staged, tool, value)
        if tool["baseline"]["exists"]:
            if baseline_state == "absent" and live_state == "baseline":
                fault(f"before-package-baseline-move-{tool['id']}")
                durable_rename(live, baseline_path)
                fault(f"after-package-baseline-move-{tool['id']}")
                live_state, baseline_state = "absent", "baseline"
            if baseline_state != "baseline":
                fail(f"native CLI package baseline is not recoverable: {tool['id']}")
        elif baseline_state != "absent":
            fail(f"unexpected native CLI package baseline: {tool['id']}")
        if live_state == "absent" and staged_state == "target":
            fault(f"before-package-target-move-{tool['id']}")
            durable_rename(staged, live)
            fault(f"after-package-target-move-{tool['id']}")
        elif live_state != "target":
            fail(f"native CLI target package cannot be published: {tool['id']}")
    for tool in value["tools"]:
        for entry in tool["executables"]:
            live = Path(entry["path"])
            baseline_path = Path(entry["baselinePath"])
            staged = Path(entry["stagedPath"])
            live_state = classify_link(live, entry)
            baseline_state = classify_link(baseline_path, entry)
            staged_state = classify_link(staged, entry)
            if entry["baseline"]["exists"]:
                if baseline_state == "absent" and live_state == "baseline":
                    fault(f"before-link-baseline-move-{tool['id']}-{live.name}")
                    durable_rename(live, baseline_path)
                    fault(f"after-link-baseline-move-{tool['id']}-{live.name}")
                    live_state, baseline_state = "absent", "baseline"
                if baseline_state != "baseline":
                    fail(f"native CLI executable baseline is not recoverable: {live}")
            elif baseline_state != "absent":
                fail(f"unexpected native CLI executable baseline: {live}")
            if live_state == "absent" and staged_state == "target":
                fault(f"before-link-target-move-{tool['id']}-{live.name}")
                durable_rename(staged, live)
                fault(f"after-link-target-move-{tool['id']}-{live.name}")
            elif live_state != "target":
                fail(f"native CLI target executable cannot be published: {live}")
    verify_all_targets(value)
    set_phase(root, value, {"applying"}, "target-verified")


def verify_all_targets(value: dict[str, Any]) -> None:
    for tool in value["tools"]:
        live = Path(tool["packageRoot"])
        if classify_package(live, tool, value) != "target":
            fail(f"native CLI target package is not live: {tool['id']}")
        for entry in tool["executables"]:
            if classify_link(Path(entry["path"]), entry) != "target":
                fail(f"native CLI target executable is not live: {entry['path']}")


def verify_all_baselines(value: dict[str, Any]) -> None:
    for tool in value["tools"]:
        live = Path(tool["packageRoot"])
        state = classify_package(live, tool, value)
        expected = "baseline" if tool["baseline"]["exists"] else "absent"
        if state != expected:
            fail(f"native CLI package baseline was not restored: {tool['id']}")
        for entry in tool["executables"]:
            state = classify_link(Path(entry["path"]), entry)
            expected = "baseline" if entry["baseline"]["exists"] else "absent"
            if state != expected:
                fail(f"native CLI executable baseline was not restored: {entry['path']}")


def rollback_transaction(root: Path, value: dict[str, Any], args) -> None:
    if value["phase"] not in {"rollback-pending", "rolled-back"}:
        set_phase(root, value, {"prepared", "applying", "target-verified", "commit-pending"}, "rollback-pending")
    if value["phase"] == "rolled-back":
        verify_all_baselines(value)
        terminalize(root, value, args)
        return
    for tool in reversed(value["tools"]):
        for entry in reversed(tool["executables"]):
            live = Path(entry["path"])
            staged = Path(entry["stagedPath"])
            discard = Path(entry["discardPath"])
            live_state = classify_link(live, entry)
            staged_state = classify_link(staged, entry)
            discard_state = classify_link(discard, entry)
            if live_state == "target" and discard_state == "absent":
                fault(f"before-link-target-remove-{tool['id']}-{live.name}")
                durable_rename(live, discard)
                fault(f"after-link-target-remove-{tool['id']}-{live.name}")
                live_state, discard_state = "absent", "target"
            if live_state == "absent" and entry["baseline"]["exists"]:
                baseline_path = Path(entry["baselinePath"])
                if classify_link(baseline_path, entry) != "baseline":
                    fail(f"native CLI executable rollback authority is missing: {live}")
                fault(f"before-link-baseline-restore-{tool['id']}-{live.name}")
                durable_rename(baseline_path, live)
                fault(f"after-link-baseline-restore-{tool['id']}-{live.name}")
            elif not entry["baseline"]["exists"] and live_state != "absent":
                fail(f"native CLI executable absence could not be restored: {live}")
    for tool in reversed(value["tools"]):
        live = Path(tool["packageRoot"])
        staged = Path(tool["stagedPath"])
        discard = Path(tool["discardPath"])
        live_state = classify_package(live, tool, value)
        staged_state = classify_package(staged, tool, value)
        discard_state = classify_package(discard, tool, value)
        if live_state == "target" and discard_state == "absent":
            fault(f"before-package-target-remove-{tool['id']}")
            durable_rename(live, discard)
            fault(f"after-package-target-remove-{tool['id']}")
            live_state, discard_state = "absent", "target"
        if live_state == "absent" and tool["baseline"]["exists"]:
            baseline_path = Path(tool["baselinePath"])
            if classify_package(baseline_path, tool, value) != "baseline":
                fail(f"native CLI package rollback authority is missing: {tool['id']}")
            fault(f"before-package-baseline-restore-{tool['id']}")
            durable_rename(baseline_path, live)
            fault(f"after-package-baseline-restore-{tool['id']}")
        elif not tool["baseline"]["exists"] and live_state != "absent":
            fail(f"native CLI package absence could not be restored: {tool['id']}")
        parent_baseline = tool["packageParentBaseline"]
        parent = Path(tool["packageParent"])
        if not parent_baseline["exists"] and os.path.lexists(parent):
            recorded = tool.get("createdParentIdentity")
            if recorded is None or not identity_matches(parent, recorded, "directory") or any(parent.iterdir()):
                fail(f"native CLI created package parent cannot be removed safely: {parent}")
            parent.rmdir()
            fsync_directory(parent.parent)
    verify_all_baselines(value)
    set_phase(root, value, {"rollback-pending"}, "rolled-back")
    terminalize(root, value, args)


def decision_binding(decision: Path) -> dict[str, Any]:
    info = safe_file(decision, maximum=4 * 1024 * 1024)
    if stat.S_IMODE(info.st_mode) != 0o600:
        fail("tested-pair decision permissions are unsafe")
    value = read_json(decision, maximum=4 * 1024 * 1024, canonical=True)
    if not isinstance(value, dict) or value.get("schema") != DECISION_SCHEMA:
        fail("tested-pair decision schema mismatch")
    binding = value.get("nativeCliBundle")
    if not isinstance(binding, dict):
        fail("tested-pair decision lacks native CLI bundle authority")
    return binding


def decision_matches(value: dict[str, Any], decision: Path) -> None:
    if decision_binding(decision) != value["binding"]:
        fail("tested-pair decision does not bind this native CLI generation")


def commit_transaction(root: Path, value: dict[str, Any], decision: Path) -> None:
    decision_matches(value, decision)
    apply_transaction(root, value)
    verify_all_targets(value)
    if value["phase"] == "target-verified":
        set_phase(root, value, {"target-verified"}, "commit-pending")
    if value["phase"] == "commit-pending":
        decision_matches(value, decision)
        verify_all_targets(value)
        set_phase(root, value, {"commit-pending"}, "committed-cleanup")
    if value["phase"] != "committed-cleanup":
        fail("native CLI transaction did not reach committed cleanup")


def remove_tree(path: Path) -> None:
    if not os.path.lexists(path):
        return
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail(f"refusing to recursively remove non-directory: {path}")
    for entry in os.scandir(path):
        child = Path(entry.path)
        child_info = os.lstat(child)
        if stat.S_ISDIR(child_info.st_mode) and not stat.S_ISLNK(child_info.st_mode):
            remove_tree(child)
        else:
            child.unlink()
    path.rmdir()


def terminalize(root: Path, value: dict[str, Any], args) -> None:
    phase = value["phase"]
    if phase not in {"committed-cleanup", "rolled-back"}:
        fail("native CLI transaction is not terminal")
    if phase == "committed-cleanup":
        verify_all_targets(value)
    else:
        verify_all_baselines(value)
    intent = {
        "schema": TERMINAL_SCHEMA,
        "generation": value["generation"],
        "phase": phase,
        "binding": value["binding"],
        "activeRoot": str(root),
        "tombstone": str(args.tombstone),
        "rootIdentity": identity(root),
    }
    if not os.path.lexists(args.intent):
        atomic_json(args.intent, intent)
    elif read_json(args.intent, canonical=True) != intent:
        fail("native CLI terminal intent does not match the active generation")
    fault("after-terminal-intent")
    if os.path.lexists(root):
        if os.path.lexists(args.tombstone):
            fail("native CLI terminal tombstone collision")
        if not identity_matches(root, intent["rootIdentity"], "directory"):
            fail("native CLI transaction root changed before terminal rename")
        os.replace(root, args.tombstone)
        fsync_directory(root.parent)
    fault("after-terminal-rename")
    sweep_terminal(args)


def sweep_terminal(args) -> None:
    if not os.path.lexists(args.intent):
        if os.path.lexists(args.tombstone):
            fail("native CLI tombstone exists without durable deletion intent")
        return
    intent = read_json(args.intent, maximum=4 * 1024 * 1024, canonical=True)
    if (
        not isinstance(intent, dict)
        or intent.get("schema") != TERMINAL_SCHEMA
        or intent.get("activeRoot") != str(args.root)
        or intent.get("tombstone") != str(args.tombstone)
        or intent.get("phase") not in {"committed-cleanup", "rolled-back"}
    ):
        fail("native CLI terminal intent is malformed")
    if os.path.lexists(args.root):
        value = load_ledger(args.root)
        if value["phase"] != intent["phase"] or value["binding"] != intent["binding"]:
            fail("native CLI active root does not match terminal intent")
        if not identity_matches(args.root, intent["rootIdentity"], "directory"):
            fail("native CLI active root identity changed")
        if os.path.lexists(args.tombstone):
            fail("native CLI active root and tombstone both exist")
        os.replace(args.root, args.tombstone)
        fsync_directory(args.root.parent)
    if os.path.lexists(args.tombstone):
        if not identity_matches(args.tombstone, intent["rootIdentity"], "directory"):
            fail("native CLI terminal tombstone identity changed")
        fault("before-terminal-delete")
        remove_tree(args.tombstone)
        fsync_directory(args.tombstone.parent)
        fault("after-terminal-delete")
    else:
        fsync_directory(args.tombstone.parent)
    args.intent.unlink()
    fsync_directory(args.intent.parent)


def reconcile(args) -> None:
    sweep_terminal(args)
    if not os.path.lexists(args.root):
        return
    value = load_ledger(args.root)
    phase = value["phase"]
    decision_exists = os.path.lexists(args.decision)
    if phase == "committed-cleanup":
        verify_all_targets(value)
        if decision_exists:
            decision_matches(value, args.decision)
        else:
            terminalize(args.root, value, args)
        return
    if phase in {"rollback-pending", "rolled-back"}:
        rollback_transaction(args.root, value, args)
        return
    if decision_exists:
        decision_matches(value, args.decision)
        commit_transaction(args.root, value, args.decision)
    else:
        rollback_transaction(args.root, value, args)


def parse_path(raw: str) -> Path:
    path = Path(raw)
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        raise argparse.ArgumentTypeError("path must be canonical and absolute")
    return path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=parse_path, default=DEFAULT_ROOT)
    parser.add_argument("--prefix", type=parse_path, default=Path("/"))
    parser.add_argument("--decision", type=parse_path, default=Path("/root/.openclaw/.bridgesllm-tested-pair-commit-v5.json"))
    parser.add_argument("--tombstone", type=parse_path)
    parser.add_argument("--intent", type=parse_path)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_command = commands.add_parser("prepare")
    prepare_command.add_argument("--catalog", type=parse_path, required=True)
    prepare_command.add_argument("--codex-version", required=True)
    prepare_command.add_argument("--claude-version", required=True)
    prepare_command.add_argument("--clawhub-version", required=True)
    prepare_command.add_argument("--platform")
    prepare_command.add_argument("--archive-cache", type=parse_path)
    commands.add_parser("apply")
    commands.add_parser("verify")
    commands.add_parser("binding")
    commands.add_parser("matches-decision")
    commands.add_parser("commit")
    commands.add_parser("cleanup")
    commands.add_parser("reconcile")
    commands.add_parser("status")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.root = args.root.resolve(strict=False)
    args.prefix = args.prefix.resolve(strict=False)
    args.decision = args.decision.resolve(strict=False)
    args.tombstone = (args.tombstone or args.root.with_name(args.root.name + ".terminal")).resolve(strict=False)
    args.intent = (args.intent or args.root.with_name(args.root.name + ".terminal-intent.json")).resolve(strict=False)
    if args.tombstone.parent != args.root.parent or args.intent.parent != args.root.parent:
        fail("native CLI terminal paths must share the fixed transaction parent")
    if args.command == "prepare":
        args.catalog = args.catalog.resolve()
        if args.archive_cache is not None:
            args.archive_cache = args.archive_cache.resolve()
            safe_directory(args.archive_cache)
        prepare(args)
        return 0
    if args.command == "reconcile":
        reconcile(args)
        return 0
    if args.command == "status":
        sweep_terminal(args)
        if not os.path.lexists(args.root):
            print("absent")
        else:
            print(load_ledger(args.root)["phase"])
        return 0
    sweep_terminal(args)
    if args.command == "cleanup" and not os.path.lexists(args.root):
        if os.path.lexists(args.decision):
            fail("native CLI cleanup requires a retired tested-pair decision")
        return 0
    value = load_ledger(args.root)
    if args.command == "apply":
        apply_transaction(args.root, value)
    elif args.command == "verify":
        verify_all_targets(value)
    elif args.command == "binding":
        if value["phase"] not in {"target-verified", "commit-pending", "committed-cleanup"}:
            fail("native CLI bundle is not ready to bind")
        verify_all_targets(value)
        print(canonical_json(value["binding"]).decode(), end="")
    elif args.command == "matches-decision":
        decision_matches(value, args.decision)
        verify_all_targets(value)
    elif args.command == "commit":
        commit_transaction(args.root, value, args.decision)
    elif args.command == "cleanup":
        if value["phase"] != "committed-cleanup" or os.path.lexists(args.decision):
            fail("native CLI cleanup requires committed state and a retired tested-pair decision")
        terminalize(args.root, value, args)
    else:
        fail(f"unsupported native CLI transaction command: {args.command}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ContractError, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"native-cli-bundle-transaction: FAIL: {error}", file=os.sys.stderr)
        raise SystemExit(1)
