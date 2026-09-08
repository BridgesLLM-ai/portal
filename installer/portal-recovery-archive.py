#!/usr/bin/env python3
"""Fail-closed archive admission and extraction for Portal offline restore."""

from __future__ import annotations

import argparse
import decimal
import fcntl
import hashlib
import hmac
import io
import json
import os
import pathlib
import posixpath
import re
import stat
import struct
import subprocess
import tarfile
import tempfile
from typing import Any

MAX_ARCHIVE_MEMBERS = 1_000_000
MAX_OUTER_MEMBERS = 4096
MAX_ARCHIVE_BYTES = 2 * 1024**4
MEMBER_STORAGE_OVERHEAD = 4096
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_MAC_BYTES = 4096
MAX_MEMBER_XATTRS = 1024
MAX_MEMBER_XATTR_BYTES = 16 * 1024 * 1024
MAX_XATTR_NAME_BYTES = 255
MAX_XATTR_VALUE_BYTES = 1024 * 1024
VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")
ENV_ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
COMPONENT_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
PAX_TIME_PATTERN = re.compile(r"-?[0-9]{1,12}(?:\.[0-9]{1,9})?")
METADATA_PROFILE = "linux-pax-mtime-xattrs-sparse-v1"
MAC_RECORD_NAME = "ARCHIVE-MAC.json"
MANIFEST_NAME = "MANIFEST.txt"
RECOVERY_SCHEMA_V2 = "bridgesllm.portal-recovery.v2"
RECOVERY_SCHEMA_V3 = "bridgesllm.portal-recovery.v3"
RECOVERY_SCHEMA_V4 = "bridgesllm.portal-recovery.v4"
SUPPORTED_RECOVERY_SCHEMAS = frozenset({
    RECOVERY_SCHEMA_V2,
    RECOVERY_SCHEMA_V3,
    RECOVERY_SCHEMA_V4,
})
RECOVERY_MANIFEST_FIELDS = frozenset({
    "schema",
    "backupType",
    "createdAt",
    "portalVersion",
    "installationProfile",
    "directoryConsistency",
    "metadataProfile",
    "databaseIdentity",
    "components",
})

CORE_RECOVERY_COMPONENTS = frozenset({
    "database",
    "portal-install",
    "portal-environment",
    "hosted-apps",
    "portal-app-sources",
    "portal-files",
    "upload-storage",
    "projects",
    "portal-backend-state",
    "portal-state",
    "portal-assets",
})

RECOVERY_COMPONENT_PAYLOADS = {
    "database": "database.dump",
    "portal-install": "portal-install.tar.gz",
    "portal-environment": "configs/portal-backend.env.production",
    "hosted-apps": "apps.tar.gz",
    "portal-app-sources": "portal-app-sources.tar.gz",
    "legacy-hosted-apps": "legacy-apps.tar.gz",
    "portal-files": "portal-files.tar.gz",
    "upload-storage": "uploads.tar.gz",
    "legacy-portal-files": "legacy-portal-files.tar.gz",
    "projects": "projects.tar.gz",
    "portal-backend-state": "portal-backend-state.tar.gz",
    "portal-state": "portal-state.tar.gz",
    "portal-assets": "portal-assets.tar.gz",
    "legacy-portal-runtime": "legacy-portal-runtime.tar.gz",
    "openclaw-state": "openclaw-state.tar.gz",
    "stalwart-data": "stalwart-data.tar.gz",
    "stalwart-mail-data": "stalwart-mail-data.tar.gz",
    "stalwart-install": "stalwart-install.tar.gz",
}


class RecoveryArchiveError(ValueError):
    pass


def fail(message: str) -> None:
    raise RecoveryArchiveError(message)


def bounded_members(
    handle: tarfile.TarFile,
    maximum: int,
) -> list[tarfile.TarInfo]:
    members: list[tarfile.TarInfo] = []
    for member in handle:
        members.append(member)
        if len(members) > maximum:
            fail("archive member count is unbounded")
    if not members:
        fail("archive member count is empty")
    return members


def canonical_absolute(value: str, *, label: str) -> pathlib.Path:
    if (
        not value
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
        or len(value.encode("utf-8")) >= 4096
        or not os.path.isabs(value)
        or os.path.normpath(value) != value
        or value == os.path.sep
    ):
        fail(f"{label} is not a bounded canonical absolute path")
    return pathlib.Path(value)


def normalized_member(member: tarfile.TarInfo) -> str:
    raw = member.name
    path = pathlib.PurePosixPath(raw)
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if raw.startswith("/") or ".." in parts:
        fail("archive contains an unsafe member path")
    if not parts:
        if member.isdir():
            return ""
        fail("archive contains an unsafe root member")
    if any(ord(char) < 32 or ord(char) == 127 for char in raw):
        fail("archive contains a control character in a member name")
    normalized = "/".join(parts)
    try:
        encoded = normalized.encode("utf-8")
        encoded_parts = [part.encode("utf-8") for part in parts]
    except UnicodeEncodeError:
        fail("archive contains a non-UTF-8 member name")
    if len(encoded) >= 4096 or any(len(part) > 255 for part in encoded_parts):
        fail("archive contains an overlong member name")
    return normalized


def validate_extraction_path(destination: pathlib.Path, normalized: str) -> None:
    probe = destination
    while not probe.exists():
        if probe == probe.parent:
            fail("archive extraction filesystem is unavailable")
        probe = probe.parent
    try:
        path_max = os.pathconf(probe, "PC_PATH_MAX")
        name_max = os.pathconf(probe, "PC_NAME_MAX")
    except (OSError, ValueError):
        fail("archive extraction path limits are unavailable")
    if path_max <= 0 or name_max <= 0:
        fail("archive extraction path limits are invalid")
    candidate = destination.joinpath(*pathlib.PurePosixPath(normalized).parts)
    if len(os.fsencode(candidate)) >= path_max:
        fail("archive member exceeds its extraction path limit")
    if any(
        len(os.fsencode(part)) > name_max
        for part in pathlib.PurePosixPath(normalized).parts
    ):
        fail("archive member exceeds its extraction name limit")


def normalized_hardlink_target(raw: str) -> str:
    path = pathlib.PurePosixPath(raw)
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if (
        not raw
        or raw.startswith("/")
        or not parts
        or ".." in parts
        or any(ord(char) < 32 or ord(char) == 127 for char in raw)
    ):
        fail("archive contains an unsafe hard-link target")
    try:
        encoded = raw.encode("utf-8")
        encoded_parts = [part.encode("utf-8") for part in parts]
    except UnicodeEncodeError:
        fail("archive contains a non-UTF-8 hard-link target")
    if len(encoded) >= 4096 or any(len(part) > 255 for part in encoded_parts):
        fail("archive contains an overlong hard-link target")
    return "/".join(parts)


def exact_mtime_ns(member: tarfile.TarInfo) -> int:
    raw = member.pax_headers.get("mtime")
    if raw is None:
        if (
            not isinstance(member.mtime, int)
            or isinstance(member.mtime, bool)
            or abs(member.mtime) > 10**12
        ):
            fail("archive member lacks an exact bounded modification time")
        return member.mtime * 1_000_000_000
    if not isinstance(raw, str) or not PAX_TIME_PATTERN.fullmatch(raw):
        fail("archive member lacks an exact bounded PAX modification time")
    try:
        nanoseconds = decimal.Decimal(raw) * decimal.Decimal(1_000_000_000)
    except decimal.InvalidOperation:
        fail("archive member has an invalid PAX modification time")
    integral = nanoseconds.to_integral_value()
    if nanoseconds != integral or abs(integral) > 10**21:
        fail("archive member has an invalid PAX modification time")
    return int(integral)


def decode_gnu_xattr_name(value: str) -> bytes:
    encoded = value.encode("utf-8", "surrogateescape")
    decoded = bytearray()
    offset = 0
    while offset < len(encoded):
        token = encoded[offset:offset + 3]
        if token == b"%3D":
            decoded.append(ord("="))
            offset += 3
        elif token == b"%25":
            decoded.append(ord("%"))
            offset += 3
        else:
            decoded.append(encoded[offset])
            offset += 1
    return bytes(decoded)


def member_xattrs(member: tarfile.TarInfo) -> tuple[tuple[bytes, bytes], ...]:
    values: list[tuple[bytes, bytes]] = []
    total = 0
    for key, raw_value in member.pax_headers.items():
        if (
            key.startswith("LIBARCHIVE.xattr.")
            or (key.startswith("RHT.") and key != "RHT.security.selinux")
            or (
                key.startswith("SCHILY.acl.")
                and key not in {"SCHILY.acl.access", "SCHILY.acl.default"}
            )
        ):
            fail("archive member uses unsupported security metadata")
        if key in {"SCHILY.acl.access", "SCHILY.acl.default"}:
            if not isinstance(raw_value, str):
                fail("archive member contains invalid ACL metadata")
            acl_value = raw_value.encode("utf-8", "surrogateescape")
            total += len(key.encode("ascii")) + len(acl_value)
            if len(acl_value) > MAX_XATTR_VALUE_BYTES:
                fail("archive member ACL metadata is unbounded")
        if not key.startswith("SCHILY.xattr."):
            continue
        name_text = key.removeprefix("SCHILY.xattr.")
        if not name_text or not isinstance(raw_value, str):
            fail("archive member contains invalid extended-attribute metadata")
        try:
            name = decode_gnu_xattr_name(name_text)
            value = raw_value.encode("utf-8", "surrogateescape")
        except UnicodeError:
            fail("archive member contains invalid extended-attribute metadata")
        if (
            not name
            or len(name) > MAX_XATTR_NAME_BYTES
            or b"\0" in name
            or b"." not in name
            or len(value) > MAX_XATTR_VALUE_BYTES
        ):
            fail("archive member contains unsafe extended-attribute metadata")
        total += len(name) + len(value)
        if (
            len(values) >= MAX_MEMBER_XATTRS
            or total > MAX_MEMBER_XATTR_BYTES
        ):
            fail("archive member extended-attribute metadata is unbounded")
        values.append((name, value))
    raw_selinux = member.pax_headers.get("RHT.security.selinux")
    if raw_selinux is not None:
        if not isinstance(raw_selinux, str):
            fail("archive member contains invalid SELinux metadata")
        selinux_text = raw_selinux.encode("utf-8", "surrogateescape")
        if (
            not selinux_text
            or len(selinux_text) > 4095
            or b"\0" in selinux_text
            or any(byte < 32 or byte > 126 for byte in selinux_text)
            or selinux_text.count(b":") < 2
        ):
            fail("archive member contains unsafe SELinux metadata")
        selinux_value = selinux_text + b"\0"
        existing = dict(values).get(b"security.selinux")
        if existing is not None and existing != selinux_value:
            fail("archive member contains contradictory SELinux metadata")
        if existing is None:
            values.append((b"security.selinux", selinux_value))
            total += len(b"security.selinux") + len(selinux_value)
            if (
                len(values) > MAX_MEMBER_XATTRS
                or total > MAX_MEMBER_XATTR_BYTES
            ):
                fail("archive member extended-attribute metadata is unbounded")
    values.sort()
    names = [name for name, _ in values]
    if len(names) != len(set(names)):
        fail("archive member contains duplicate extended-attribute metadata")
    if (
        "SCHILY.acl.access" in member.pax_headers
        and b"system.posix_acl_access" not in names
    ) or (
        # GNU tar emits an empty SCHILY.acl.default marker for an
        # access-ACL-bearing directory that has no default ACL. Only a
        # non-empty default ACL has an authoritative binary xattr.
        bool(member.pax_headers.get("SCHILY.acl.default"))
        and b"system.posix_acl_default" not in names
    ):
        fail("archive member ACL metadata lacks its authoritative binary xattr")
    return tuple(values)


def validated_sparse_map(
    member: tarfile.TarInfo,
) -> tuple[tuple[int, int], ...] | None:
    if member.sparse is None:
        return None
    if (
        member.pax_headers.get("GNU.sparse.major") != "1"
        or member.pax_headers.get("GNU.sparse.minor") != "0"
        or member.pax_headers.get("GNU.sparse.realsize") != str(member.size)
    ):
        fail("archive member uses an unsupported sparse-file encoding")
    extents: list[tuple[int, int]] = []
    previous_end = 0
    saw_terminal = False
    for raw_offset, raw_length in member.sparse:
        if (
            not isinstance(raw_offset, int)
            or isinstance(raw_offset, bool)
            or not isinstance(raw_length, int)
            or isinstance(raw_length, bool)
            or raw_offset < previous_end
            or raw_length < 0
            or raw_offset > member.size
            or raw_length > member.size - raw_offset
        ):
            fail("archive member contains an invalid sparse-file map")
        if raw_length == 0:
            if raw_offset != member.size or saw_terminal:
                fail("archive member contains an invalid sparse-file terminator")
            saw_terminal = True
            continue
        if saw_terminal:
            fail("archive member contains data after its sparse-file terminator")
        extents.append((raw_offset, raw_length))
        previous_end = raw_offset + raw_length
    if not saw_terminal:
        fail("archive member sparse-file map is incomplete")
    return tuple(extents)


def validate_exact_member_metadata(member: tarfile.TarInfo) -> int:
    exact_mtime_ns(member)
    xattrs = member_xattrs(member)
    sparse = validated_sparse_map(member) if member.isfile() else None
    if not member.isfile() and member.sparse is not None:
        fail("archive non-file member claims sparse-file metadata")
    if member.islnk() and xattrs:
        fail("archive hard link contains independent extended attributes")
    textual_acl_bytes = sum(
        len(key.encode("ascii"))
        + len(value.encode("utf-8", "surrogateescape"))
        for key, value in member.pax_headers.items()
        if key in {"SCHILY.acl.access", "SCHILY.acl.default"}
    )
    sparse_overhead = 0 if sparse is None else len(sparse) * 16
    return (
        sum(len(name) + len(value) for name, value in xattrs)
        + textual_acl_bytes
        + sparse_overhead
    )


def reject_privileged_file_metadata(member: tarfile.TarInfo) -> None:
    if member.mode & (stat.S_ISUID | stat.S_ISGID):
        fail("executable recovery component contains setuid or setgid metadata")
    if b"security.capability" in dict(member_xattrs(member)):
        fail("executable recovery component contains file capabilities")


def resolve_hardlink_target(
    member_name: str,
    members: dict[str, tarfile.TarInfo],
    *,
    require_exact_metadata: bool = False,
) -> str:
    root = member_name.split("/", 1)[0]
    current = member_name
    visited: set[str] = set()
    links: list[tarfile.TarInfo] = []
    while True:
        if current in visited:
            fail("archive contains a hard-link cycle")
        visited.add(current)
        member = members.get(current)
        if member is None:
            fail("archive hard link targets a missing member")
        if member.isfile():
            for link in links:
                if (
                    link.uid != member.uid
                    or link.gid != member.gid
                    or (link.mode & (0o7777 if require_exact_metadata else 0o777))
                        != (member.mode & (0o7777 if require_exact_metadata else 0o777))
                    or (
                        require_exact_metadata
                        and exact_mtime_ns(link) != exact_mtime_ns(member)
                    )
                ):
                    fail("archive hard-link metadata is contradictory")
            return current
        if not member.islnk():
            fail("archive hard link does not resolve to a regular file")
        links.append(member)
        current = normalized_hardlink_target(member.linkname)
        if current.split("/", 1)[0] != root:
            fail("archive hard link escapes its captured component")


def admitted_absolute_symlink(
    resolved: str,
    roots: tuple[str, ...],
    *,
    allow_project_interpreter_symlinks: bool = False,
) -> bool:
    if any(resolved == root or resolved.startswith(root + "/") for root in roots):
        return True
    return bool(
        allow_project_interpreter_symlinks
        and re.fullmatch(
            r"/(?:usr/bin|usr/local/bin)/python3(?:\.[0-9]+)?",
            resolved,
        )
    )


def validate_members(
    members: list[tarfile.TarInfo],
    *,
    require: set[str] | None = None,
    allow_relative_symlinks: bool = False,
    allow_hardlinks: bool = False,
    absolute_symlink_roots: tuple[str, ...] = (),
    allow_project_interpreter_symlinks: bool = False,
    expected_top_level: str | None = None,
    extraction_root: pathlib.Path | None = None,
    require_exact_metadata: bool = False,
    reject_privileged_metadata: bool = False,
) -> tuple[dict[str, tarfile.TarInfo], int]:
    if not members or len(members) > MAX_ARCHIVE_MEMBERS:
        fail("archive member count is empty or unbounded")
    by_name: dict[str, tarfile.TarInfo] = {}
    total = 0
    for member in members:
        normalized = normalized_member(member)
        if not normalized:
            continue
        if extraction_root is not None:
            validate_extraction_path(extraction_root, normalized)
        if normalized in by_name:
            fail("archive contains duplicate normalized members")
        if not (
            member.isfile()
            or member.isdir()
            or (allow_relative_symlinks and member.issym())
            or (allow_hardlinks and member.islnk())
        ):
            fail("archive contains an unsafe link, device, socket, or FIFO")
        if (
            member.uid < 0
            or member.uid > 2_147_483_647
            or member.gid < 0
            or member.gid > 2_147_483_647
            or member.mode < 0
            or member.mode & ~(0o7777 if require_exact_metadata else 0o777)
        ):
            fail("archive contains unsafe ownership or mode metadata")
        total += MEMBER_STORAGE_OVERHEAD
        if require_exact_metadata:
            total += validate_exact_member_metadata(member)
        if reject_privileged_metadata:
            reject_privileged_file_metadata(member)
        if total > MAX_ARCHIVE_BYTES:
            fail("archive expanded size is unbounded")
        if member.isfile():
            if member.size < 0:
                fail("archive contains an invalid member size")
            total += member.size
            if total > MAX_ARCHIVE_BYTES:
                fail("archive expanded size is unbounded")
        elif member.issym():
            link = member.linkname
            if (
                not link
                or len(link.encode("utf-8")) >= 4096
                or any(ord(char) < 32 or ord(char) == 127 for char in link)
            ):
                fail("archive contains an unsafe symbolic-link target")
            if link.startswith("/"):
                resolved = posixpath.normpath(link)
                if not admitted_absolute_symlink(
                    resolved,
                    absolute_symlink_roots,
                    allow_project_interpreter_symlinks=allow_project_interpreter_symlinks,
                ):
                    fail("archive symbolic link escapes its admitted absolute roots")
            else:
                resolved = posixpath.normpath(
                    posixpath.join(posixpath.dirname(normalized), link)
                )
                member_root = normalized.split("/", 1)[0]
                if (
                    resolved in {"", ".", ".."}
                    or resolved.startswith("../")
                    or resolved.split("/", 1)[0] != member_root
                ):
                    fail("archive symbolic link escapes its captured component")
        by_name[normalized] = member
    for normalized in by_name:
        parent = pathlib.PurePosixPath(normalized).parent
        if str(parent) != ".":
            parent_member = by_name.get(str(parent))
            if parent_member is None or not parent_member.isdir():
                fail("archive omits an explicit parent directory")
    if expected_top_level is not None:
        roots = {name.split("/", 1)[0] for name in by_name}
        root_member = by_name.get(expected_top_level)
        if (
            roots != {expected_top_level}
            or root_member is None
            or not root_member.isdir()
        ):
            fail("archive top-level directory does not match its admitted target")
        if require_exact_metadata and (
            root_member.uid != 0
            or root_member.gid != 0
            or root_member.mode & 0o022
        ):
            fail("archive top-level directory is not root-owned and write-safe")
    for normalized, member in by_name.items():
        if member.islnk():
            resolve_hardlink_target(
                normalized,
                by_name,
                require_exact_metadata=require_exact_metadata,
            )
    if require and not require.issubset(by_name):
        fail("archive is missing required recovery members")
    return by_name, total


def validate_nested_stream(
    handle: tarfile.TarFile,
    *,
    absolute_symlink_roots: tuple[str, ...],
    allow_project_interpreter_symlinks: bool,
    expected_top_level: str,
    extraction_roots: tuple[pathlib.Path, ...],
    reject_privileged_metadata: bool = False,
) -> tuple[int, int]:
    records: dict[str, tuple[str, int, int, int, int, str]] = {}
    total = 0
    count = 0
    for member in handle:
        count += 1
        if count > MAX_ARCHIVE_MEMBERS:
            fail("archive member count is unbounded")
        # Stream-mode TarFile retains every TarInfo by default. Compact
        # metadata below is sufficient for duplicate/hard-link validation.
        handle.members.clear()
        normalized = normalized_member(member)
        if not normalized:
            continue
        for extraction_root in extraction_roots:
            validate_extraction_path(extraction_root, normalized)
        if normalized in records:
            fail("archive contains duplicate normalized members")
        if not (
            member.isfile()
            or member.isdir()
            or member.issym()
            or member.islnk()
        ):
            fail("archive contains an unsafe link, device, socket, or FIFO")
        if (
            member.uid < 0
            or member.uid > 2_147_483_647
            or member.gid < 0
            or member.gid > 2_147_483_647
            or member.mode < 0
            or member.mode & ~0o7777
        ):
            fail("archive contains unsafe ownership or mode metadata")
        total += MEMBER_STORAGE_OVERHEAD
        total += validate_exact_member_metadata(member)
        if reject_privileged_metadata:
            reject_privileged_file_metadata(member)
        if member.isfile():
            if member.size < 0:
                fail("archive contains an invalid member size")
            total += member.size
            kind = "file"
            link = ""
        elif member.isdir():
            kind = "directory"
            link = ""
        elif member.issym():
            kind = "symlink"
            link = member.linkname
            if (
                not link
                or len(link.encode("utf-8")) >= 4096
                or any(ord(char) < 32 or ord(char) == 127 for char in link)
            ):
                fail("archive contains an unsafe symbolic-link target")
            if link.startswith("/"):
                resolved = posixpath.normpath(link)
                if not admitted_absolute_symlink(
                    resolved,
                    absolute_symlink_roots,
                    allow_project_interpreter_symlinks=allow_project_interpreter_symlinks,
                ):
                    fail("archive symbolic link escapes its admitted absolute roots")
            else:
                resolved = posixpath.normpath(
                    posixpath.join(posixpath.dirname(normalized), link)
                )
                member_root = normalized.split("/", 1)[0]
                if (
                    resolved in {"", ".", ".."}
                    or resolved.startswith("../")
                    or resolved.split("/", 1)[0] != member_root
                ):
                    fail("archive symbolic link escapes its captured component")
        else:
            kind = "hardlink"
            link = normalized_hardlink_target(member.linkname)
        if total > MAX_ARCHIVE_BYTES:
            fail("archive expanded size is unbounded")
        records[normalized] = (
            kind,
            member.uid,
            member.gid,
            member.mode & 0o7777,
            exact_mtime_ns(member),
            link,
        )
    if count == 0:
        fail("archive member count is empty")

    roots = {name.split("/", 1)[0] for name in records}
    root_record = records.get(expected_top_level)
    if (
        roots != {expected_top_level}
        or root_record is None
        or root_record[0] != "directory"
    ):
        fail("archive top-level directory does not match its admitted target")
    if (
        root_record[1] != 0
        or root_record[2] != 0
        or root_record[3] & 0o022
    ):
        fail("archive top-level directory is not root-owned and write-safe")
    for member_name in records:
        parent = pathlib.PurePosixPath(member_name).parent
        if str(parent) != ".":
            parent_record = records.get(str(parent))
            if parent_record is None or parent_record[0] != "directory":
                fail("archive omits an explicit parent directory")

    for member_name, record in records.items():
        if record[0] != "hardlink":
            continue
        root = member_name.split("/", 1)[0]
        current = member_name
        visited: set[str] = set()
        links: list[tuple[str, int, int, int, int, str]] = []
        while True:
            if current in visited:
                fail("archive contains a hard-link cycle")
            visited.add(current)
            current_record = records.get(current)
            if current_record is None:
                fail("archive hard link targets a missing member")
            if current_record[0] == "file":
                for link_record in links:
                    if link_record[1:5] != current_record[1:5]:
                        fail("archive hard-link metadata is contradictory")
                break
            if current_record[0] != "hardlink":
                fail("archive hard link does not resolve to a regular file")
            links.append(current_record)
            current = current_record[5]
            if current.split("/", 1)[0] != root:
                fail("archive hard link escapes its captured component")
    return total, count


def read_member(handle: tarfile.TarFile, member: tarfile.TarInfo, maximum: int) -> bytes:
    if not member.isfile() or member.size <= 0 or member.size > maximum:
        fail("recovery metadata member is empty or oversized")
    stream = handle.extractfile(member)
    if stream is None:
        fail("recovery metadata member could not be read")
    payload = stream.read(maximum + 1)
    if len(payload) != member.size or len(payload) > maximum:
        fail("recovery metadata member changed or exceeded its bound")
    return payload


def read_hmac_key(path: pathlib.Path) -> bytes:
    if (
        not path.is_absolute()
        or os.path.normpath(str(path)) != str(path)
        or path.name != "archive-hmac.key"
        or len(path.parts) < 3
    ):
        fail("backup trust key path is invalid")
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    file_flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    FS_IOC_GETFLAGS = (
        (2 << 30)
        | (struct.calcsize("@L") << 16)
        | (ord("f") << 8)
        | 1
    )
    forbidden_flags = 0x00000010 | 0x00000020

    def assert_mutable(descriptor: int) -> None:
        encoded = bytearray(struct.calcsize("@L"))
        try:
            fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, encoded, True)
        except OSError:
            fail("backup trust inode flags could not be attested")
        if struct.unpack("@L", encoded)[0] & forbidden_flags:
            fail("backup trust inode is immutable or append-only")

    directory = os.open("/", directory_flags)
    descriptor = -1
    try:
        parts = path.parts[1:]
        for index, part in enumerate(parts[:-1]):
            child = os.open(part, directory_flags, dir_fd=directory)
            info = os.fstat(child)
            if (
                not stat.S_ISDIR(info.st_mode)
                or info.st_uid != 0
                or info.st_gid != 0
                or (
                    stat.S_IMODE(info.st_mode) != 0o700
                    if index == len(parts) - 2
                    else bool(info.st_mode & 0o022)
                )
            ):
                os.close(child)
                fail("backup trust key ancestor is unsafe")
            os.close(directory)
            directory = child
        assert_mutable(directory)
        descriptor = os.open(parts[-1], file_flags, dir_fd=directory)
        info = os.fstat(descriptor)
        payload = os.read(descriptor, 33)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size != 32
            or len(payload) != 32
        ):
            fail("backup trust key is unsafe")
        assert_mutable(descriptor)
        return payload
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory)


def parse_checksum_manifest(payload: bytes) -> dict[str, str]:
    if not payload or len(payload) > MAX_MANIFEST_BYTES:
        fail("backup checksum manifest is empty or oversized")
    try:
        lines = payload.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail("backup checksum manifest is not UTF-8")
    markers = [index for index, line in enumerate(lines) if line == "Checksums:"]
    if len(markers) != 1 or markers[0] + 1 >= len(lines):
        fail("backup checksum manifest has no exact inventory")
    entries: dict[str, str] = {}
    pattern = re.compile(r"([0-9a-f]{64})  \./([A-Za-z0-9][A-Za-z0-9._@/-]{0,4094})")
    for line in lines[markers[0] + 1:]:
        match = pattern.fullmatch(line)
        if match is None:
            fail("backup checksum manifest inventory is malformed")
        digest, name = match.groups()
        path = pathlib.PurePosixPath(name)
        if (
            name in {MANIFEST_NAME, MAC_RECORD_NAME}
            or name.startswith("/")
            or ".." in path.parts
            or "." in path.parts
            or name in entries
        ):
            fail("backup checksum manifest inventory is unsafe")
        entries[name] = digest
    return entries


def authenticate_open_archive(
    handle: tarfile.TarFile,
    key: bytes,
) -> tuple[dict[str, tarfile.TarInfo], int]:
    members = bounded_members(handle, MAX_OUTER_MEMBERS)
    by_name: dict[str, tarfile.TarInfo] = {}
    total = 0
    root_members = 0
    for member in members:
        normalized = normalized_member(member)
        if not (member.isfile() or member.isdir()):
            fail("backup archive contains a non-regular outer member")
        if (
            member.uid != 0
            or member.gid != 0
            or member.mtime != 0
            or member.uname not in {"", "root"}
            or member.gname not in {"", "root"}
            or member.linkname
            or member.pax_headers
            or member.devmajor != 0
            or member.devminor != 0
            or member.size < 0
            or stat.S_IMODE(member.mode) != (
                0o600 if member.isfile() else 0o700
            )
        ):
            fail("backup archive outer metadata is not canonical")
        total += MEMBER_STORAGE_OVERHEAD
        if member.isfile():
            total += member.size
        if total > MAX_ARCHIVE_BYTES:
            fail("backup archive is unbounded")
        if not normalized:
            if member.name not in {".", "./"} or not member.isdir():
                fail("backup archive root member is unsafe")
            root_members += 1
            continue
        if normalized in by_name:
            fail("backup archive contains duplicate members")
        by_name[normalized] = member
    directories = {
        name for name, member in by_name.items() if member.isdir()
    }
    if root_members != 1 or directories != {"configs", "systemd"}:
        fail("backup archive directory inventory is not exact")
    if MANIFEST_NAME not in by_name or MAC_RECORD_NAME not in by_name:
        fail("backup is unsigned; legacy plaintext-SQL backups are unsupported")
    manifest_member = by_name[MANIFEST_NAME]
    mac_member = by_name[MAC_RECORD_NAME]
    manifest = read_member(handle, manifest_member, MAX_MANIFEST_BYTES)
    mac_raw = read_member(handle, mac_member, MAX_MAC_BYTES)
    if (
        manifest_member.uid != 0
        or manifest_member.gid != 0
        or stat.S_IMODE(manifest_member.mode) != 0o600
        or mac_member.uid != 0
        or mac_member.gid != 0
        or stat.S_IMODE(mac_member.mode) != 0o600
    ):
        fail("backup authentication metadata is unsafe")
    try:
        def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for name, value in pairs:
                if name in result:
                    fail("backup MAC record contains duplicate keys")
                result[name] = value
            return result

        record = json.loads(
            mac_raw,
            object_pairs_hook=reject_duplicate_keys,
        )
    except json.JSONDecodeError as error:
        raise RecoveryArchiveError("backup MAC record is invalid JSON") from error
    try:
        canonical_mac = (
            json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode("ascii")
    except (TypeError, UnicodeEncodeError) as error:
        raise RecoveryArchiveError("backup MAC record is not canonical") from error
    if mac_raw != canonical_mac:
        fail("backup MAC record is not canonical")
    required = {
        "schema",
        "algorithm",
        "keyId",
        "manifest",
        "manifestHmac",
    }
    key_id = hashlib.sha256(key).hexdigest()
    expected_mac = hmac.new(key, manifest, hashlib.sha256).hexdigest()
    if (
        not isinstance(record, dict)
        or set(record) != required
        or record.get("schema") != "bridgesllm.archive-mac.v1"
        or record.get("algorithm") != "hmac-sha256"
        or record.get("manifest") != MANIFEST_NAME
        or record.get("keyId") != key_id
        or not isinstance(record.get("manifestHmac"), str)
        or not hmac.compare_digest(record["manifestHmac"], expected_mac)
    ):
        fail("backup authentication failed")
    expected = parse_checksum_manifest(manifest)
    regular = {
        name
        for name, member in by_name.items()
        if member.isfile() and name not in {MANIFEST_NAME, MAC_RECORD_NAME}
    }
    if regular != set(expected):
        fail("authenticated checksum inventory does not exactly match archive payloads")
    for name in sorted(regular):
        stream = handle.extractfile(by_name[name])
        if stream is None:
            fail("authenticated archive payload could not be read")
        digest = hashlib.sha256()
        remaining = by_name[name].size
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                fail("authenticated archive payload ended early")
            digest.update(chunk)
            remaining -= len(chunk)
        if not hmac.compare_digest(digest.hexdigest(), expected[name]):
            fail("authenticated archive payload checksum differs")
    return by_name, total


def authenticate_archive(
    archive: pathlib.Path,
    key_path: pathlib.Path,
) -> dict[str, int | str]:
    key = read_hmac_key(key_path)
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(archive, flags)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o022
            or info.st_size <= 0
            or info.st_size > MAX_ARCHIVE_BYTES
        ):
            fail("recovery archive is unsafe")
        with os.fdopen(os.dup(descriptor), "rb", closefd=True) as stream:
            with tarfile.open(fileobj=stream, mode="r:gz") as handle:
                authenticate_open_archive(handle, key)
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        final_info = os.fstat(descriptor)
        if (
            final_info.st_dev,
            final_info.st_ino,
            final_info.st_size,
            final_info.st_mtime_ns,
            final_info.st_ctime_ns,
        ) != (
            info.st_dev,
            info.st_ino,
            info.st_size,
            info.st_mtime_ns,
            info.st_ctime_ns,
        ):
            fail("recovery archive changed during authentication")
        return {
            "schema": "bridgesllm.authenticated-archive.v1",
            "dev": info.st_dev,
            "ino": info.st_ino,
            "size": info.st_size,
            "mtimeNs": info.st_mtime_ns,
            "ctimeNs": info.st_ctime_ns,
            "sha256": digest.hexdigest(),
        }
    finally:
        os.close(descriptor)


def validate_pg_dump_custom(
    handle: tarfile.TarFile,
    member: tarfile.TarInfo,
    pg_restore: pathlib.Path,
    postgres_major: int,
    transaction_dir: pathlib.Path,
) -> None:
    if not member.isfile() or member.size <= 5:
        fail("database custom recovery payload is empty or unsafe")
    command_info = os.lstat(pg_restore)
    if (
        not pg_restore.is_absolute()
        or not stat.S_ISREG(command_info.st_mode)
        or stat.S_ISLNK(command_info.st_mode)
        or command_info.st_uid != 0
        or command_info.st_gid != 0
        or command_info.st_nlink != 1
        or command_info.st_mode & 0o022
        or not command_info.st_mode & stat.S_IXUSR
    ):
        fail("trusted pg_restore executable is unsafe")
    floors = {14: 23, 15: 18, 16: 14, 17: 10, 18: 4}
    if postgres_major not in floors:
        fail("target PostgreSQL major is unsupported")
    environment = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C",
        "LC_ALL": "C",
    }
    try:
        version_result = subprocess.run(
            [str(pg_restore), "--version"],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail("trusted pg_restore version could not be read")
    if (
        version_result.returncode != 0
        or version_result.stderr
        or len(version_result.stdout) > 4096
    ):
        fail("trusted pg_restore version output is unsafe")
    try:
        version_lines = version_result.stdout.decode("ascii").splitlines()
    except UnicodeDecodeError:
        fail("trusted pg_restore version output is unsafe")
    if len(version_lines) != 1:
        fail("trusted pg_restore version output is unsafe")
    match = re.fullmatch(
        r"pg_restore \(PostgreSQL\) ([0-9]+)\.([0-9]+)(?:[ \t][ -~]*)?",
        version_lines[0],
    )
    if match is None:
        fail("trusted pg_restore version output is unsafe")
    client_major, client_minor = map(int, match.groups())
    if (
        client_major != postgres_major
        or client_minor < floors[client_major]
    ):
        fail("trusted pg_restore is below the supported security floor")
    source = handle.extractfile(member)
    if source is None:
        fail("database custom recovery payload could not be opened")
    with tempfile.TemporaryFile(dir=transaction_dir) as dump_file:
        descriptor = dump_file.fileno()
        os.fchmod(descriptor, 0o600)
        remaining = member.size
        prefix = b""
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                fail("database custom recovery payload ended early")
            if len(prefix) < 5:
                prefix += chunk[:5 - len(prefix)]
            view = memoryview(chunk)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    fail("database custom recovery payload made no progress")
                view = view[written:]
            remaining -= len(chunk)
        if prefix != b"PGDMP":
            fail("database recovery payload is not pg_dump custom format")
        os.fsync(descriptor)
        source_path = f"/proc/self/fd/{descriptor}"
        with tempfile.TemporaryFile(dir=transaction_dir) as list_file:
            list_descriptor = list_file.fileno()
            os.fchmod(list_descriptor, 0o600)
            os.lseek(descriptor, 0, os.SEEK_SET)
            list_result = subprocess.run(
                [str(pg_restore), "--list", source_path],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=list_descriptor,
                stderr=subprocess.DEVNULL,
                timeout=300,
                env=environment,
                pass_fds=(descriptor,),
            )
            os.fsync(list_descriptor)
            list_info = os.fstat(list_descriptor)
            if (
                list_result.returncode != 0
                or list_info.st_size <= 0
                or list_info.st_size > 64 * 1024 * 1024
            ):
                fail("database custom recovery inventory is unsafe")
            os.lseek(list_descriptor, 0, os.SEEK_SET)
            header = os.read(list_descriptor, min(list_info.st_size, 1024 * 1024))
            try:
                header_text = header.decode("utf-8")
            except UnicodeDecodeError:
                fail("database custom recovery inventory is unsafe")
            source_matches = re.findall(
                r"^;[ \t]+Dumped from database version: "
                r"([0-9]+)\.([0-9]+)(?:\.[0-9]+)?(?:[ \t][^\r\n]*)?$",
                header_text,
                flags=re.MULTILINE,
            )
            producer_matches = re.findall(
                r"^;[ \t]+Dumped by pg_dump version: "
                r"([0-9]+)\.([0-9]+)(?:\.[0-9]+)?(?:[ \t][^\r\n]*)?$",
                header_text,
                flags=re.MULTILINE,
            )
            if len(source_matches) != 1 or len(producer_matches) != 1:
                fail("database custom recovery provenance is missing")
            source_major, source_minor = map(int, source_matches[0])
            producer_major, producer_minor = map(int, producer_matches[0])
            if (
                source_major != postgres_major
                or producer_major != postgres_major
                or producer_minor < floors[producer_major]
            ):
                fail("database custom recovery provenance is unsupported")
        os.lseek(descriptor, 0, os.SEEK_SET)
        result = subprocess.run(
            [
                str(pg_restore),
                "--format=custom",
                "--file=/dev/null",
                source_path,
            ],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=300,
            env=environment,
            pass_fds=(descriptor,),
        )
        if result.returncode != 0:
            fail("database custom recovery payload failed trusted pg_restore parsing")


def parse_environment(payload: bytes) -> dict[str, str]:
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        fail("Portal environment is not UTF-8")
    if "\x00" in text or "\r" in text:
        fail("Portal environment contains unsupported control bytes")
    values: dict[str, str] = {}
    for line_number, raw in enumerate(text.split("\n"), start=1):
        if not raw or raw.lstrip().startswith(("#", ";")):
            continue
        match = ENV_ASSIGNMENT.fullmatch(raw)
        if match is None:
            fail(f"Portal environment has unsupported syntax on line {line_number}")
        name, value = match.groups()
        if name in values:
            fail(f"Portal environment assigns {name} more than once")
        if "\\" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            fail(f"Portal environment has an unsupported value on line {line_number}")
        if value[:1] in {"'", '"'}:
            quote = value[0]
            if len(value) < 2 or value[-1] != quote or quote in value[1:-1]:
                fail(f"Portal environment has unsupported quoting on line {line_number}")
            value = value[1:-1]
        elif any(char in value for char in "\"'") or value != value.strip(" \t"):
            fail(f"Portal environment has an unsupported unquoted value on line {line_number}")
        values[name] = value
    return values


def is_openclaw_environment_name(name: str) -> bool:
    upper_name = name.upper()
    return "OPENCLAW" in upper_name or "CLAWDBOT" in upper_name


def environment_assignment_lines(payload: bytes) -> list[tuple[str, str]]:
    parse_environment(payload)
    text = payload.decode("utf-8")
    result = []
    for raw in text.split("\n"):
        match = ENV_ASSIGNMENT.fullmatch(raw)
        if match is not None:
            result.append((match.group(1), raw))
    return result


def filtered_v3_environment(payload: bytes) -> bytes:
    lines = [
        raw
        for name, raw in environment_assignment_lines(payload)
        if not is_openclaw_environment_name(name)
    ]
    return ("\n".join(lines) + "\n").encode("utf-8")


def validate_v3_environment(payload: bytes) -> dict[str, str]:
    values = parse_environment(payload)
    forbidden = sorted(name for name in values if is_openclaw_environment_name(name))
    if forbidden:
        fail("v3 Portal environment contains OpenClaw authority")
    if payload != filtered_v3_environment(payload):
        fail("v3 Portal environment is not canonical assignment-only data")
    return values


def merge_v3_environment(archived_payload: bytes, current_payload: bytes) -> bytes:
    archived_values = validate_v3_environment(archived_payload)
    current_values = parse_environment(current_payload)
    current_openclaw_lines = [
        (name, raw)
        for name, raw in environment_assignment_lines(current_payload)
        if is_openclaw_environment_name(name)
    ]
    current_openclaw_names = {name for name, _ in current_openclaw_lines}
    merged_lines = [
        raw for _, raw in environment_assignment_lines(archived_payload)
    ] + [raw for _, raw in current_openclaw_lines]
    merged = ("\n".join(merged_lines) + "\n").encode("utf-8")
    if len(merged) > MAX_MANIFEST_BYTES:
        fail("merged Portal environment is oversized")
    verified_values = parse_environment(merged)
    if any(
        verified_values.get(name) != value
        for name, value in archived_values.items()
    ) or any(
        verified_values.get(name) != current_values[name]
        for name in current_openclaw_names
    ):
        fail("merged Portal environment changed recovery authority")
    return merged


def read_safe_regular_payload(
    path: pathlib.Path,
    *,
    label: str,
    maximum: int,
    exact_mode: int | None = None,
) -> bytes:
    """Read one immutable-looking root authority through its opened descriptor."""
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as error:
        raise RecoveryArchiveError(f"{label} is unavailable") from error
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != 0
            or before.st_gid != 0
            or before.st_nlink != 1
            or before.st_mode & 0o022
            or (
                exact_mode is not None
                and stat.S_IMODE(before.st_mode) != exact_mode
            )
            or before.st_size <= 0
            or before.st_size > maximum
        ):
            fail(f"{label} is unsafe")
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                fail(f"{label} ended unexpectedly")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            fail(f"{label} grew during inspection")
        after = os.fstat(descriptor)
        if any(
            getattr(before, field) != getattr(after, field)
            for field in (
                "st_dev", "st_ino", "st_mode", "st_uid", "st_gid",
                "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns",
            )
        ):
            fail(f"{label} changed during inspection")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def current_environment(path: pathlib.Path) -> tuple[bytes, dict[str, str]]:
    payload = read_safe_regular_payload(
        path,
        label="sealed current Portal environment",
        maximum=MAX_MANIFEST_BYTES,
        exact_mode=0o600,
    )
    return payload, parse_environment(payload)


def write_private_payload(path: pathlib.Path, payload: bytes) -> None:
    if (
        not path.is_absolute()
        or os.path.normpath(str(path)) != str(path)
        or os.path.lexists(path)
        or not payload
        or len(payload) > MAX_MANIFEST_BYTES
    ):
        fail("private recovery payload target is unsafe")
    parent_info = os.lstat(path.parent)
    if (
        not stat.S_ISDIR(parent_info.st_mode)
        or stat.S_ISLNK(parent_info.st_mode)
        or parent_info.st_uid != 0
        or parent_info.st_gid != 0
        or parent_info.st_mode & 0o022
    ):
        fail("private recovery payload directory is unsafe")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
        ):
            fail("private recovery payload inode is unsafe")
        os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(payload):
            count = os.write(descriptor, payload[written:])
            if count <= 0:
                raise OSError("short private recovery payload write")
            written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_descriptor = os.open(
        path.parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def assert_environment_authority(
    admission_path: pathlib.Path,
    sealed_current_path: pathlib.Path,
    staged_path: pathlib.Path,
    merged_path: pathlib.Path,
    live_path: pathlib.Path,
    phase: str,
) -> None:
    admission_raw = read_safe_regular_payload(
        admission_path,
        label="restore admission",
        maximum=MAX_MANIFEST_BYTES,
        exact_mode=0o600,
    )
    try:
        document = json.loads(admission_raw)
    except json.JSONDecodeError as error:
        raise RecoveryArchiveError("restore admission is invalid JSON") from error
    authority = document.get("environmentAuthority")
    recovery_schema = document.get("recoverySchema")
    expected_policy = {
        RECOVERY_SCHEMA_V2: "exact-v2",
        RECOVERY_SCHEMA_V3: "portal-only-preserve-openclaw-v3",
        RECOVERY_SCHEMA_V4: "exact-full-v4",
    }.get(recovery_schema)
    digest_names = ("archivedSha256", "currentSha256", "mergedSha256")
    if (
        document.get("schema") != "bridgesllm.restore-admission.v2"
        or not isinstance(authority, dict)
        or set(authority) != {
            "schema", "policy", *digest_names,
        }
        or authority.get("schema")
            != "bridgesllm.portal-environment-authority.v1"
        or expected_policy is None
        or authority.get("policy") != expected_policy
        or any(
            re.fullmatch(r"[a-f0-9]{64}", str(authority.get(name, ""))) is None
            for name in digest_names
        )
        or phase not in {"pre-files", "files-restored", "rollback", "commit"}
    ):
        fail("Portal environment authority is invalid")

    sealed_raw, _ = current_environment(sealed_current_path)
    if hashlib.sha256(sealed_raw).hexdigest() != authority["currentSha256"]:
        fail("sealed current Portal environment changed")
    staged_raw, _ = current_environment(staged_path)
    if hashlib.sha256(staged_raw).hexdigest() != authority["archivedSha256"]:
        fail("staged archived Portal environment changed")
    merged_raw, _ = current_environment(merged_path)
    if hashlib.sha256(merged_raw).hexdigest() != authority["mergedSha256"]:
        fail("prepared merged Portal environment changed")

    if phase == "pre-files":
        live_raw, _ = current_environment(live_path)
        expected = ((live_raw, authority["currentSha256"]),)
    elif phase in {"files-restored", "commit"}:
        live_raw, _ = current_environment(live_path)
        expected = ((live_raw, authority["mergedSha256"]),)
    else:
        live_raw, _ = current_environment(live_path)
        expected = ((live_raw, authority["currentSha256"]),)
    if any(
        hashlib.sha256(payload).hexdigest() != digest
        for payload, digest in expected
    ):
        fail(f"Portal environment changed during {phase}")


def component_map(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    components = document.get("components")
    if not isinstance(components, list) or not 1 <= len(components) <= 128:
        fail("recovery component inventory is invalid")
    result: dict[str, dict[str, Any]] = {}
    for entry in components:
        if not isinstance(entry, dict):
            fail("recovery component entry is invalid")
        component_id = entry.get("id")
        if not isinstance(component_id, str) or not COMPONENT_PATTERN.fullmatch(component_id):
            fail("recovery component identity is invalid")
        if component_id in result:
            fail("recovery component identity is duplicated")
        if entry.get("requirement") not in {"required", "optional"}:
            fail("recovery component requirement is invalid")
        if entry.get("status") not in {"captured", "not-configured"}:
            fail("recovery component status is invalid")
        result[component_id] = entry
    return result


def recovery_manifest_schema(document: Any) -> str:
    if not isinstance(document, dict) or set(document) != RECOVERY_MANIFEST_FIELDS:
        fail("recovery manifest schema is unsupported")
    recovery_schema = document.get("schema")
    if recovery_schema not in SUPPORTED_RECOVERY_SCHEMAS:
        fail("recovery manifest schema is unsupported")
    return recovery_schema


def expected_recovery_component_ids(
    recovery_schema: str,
    targets: dict[str, pathlib.Path],
) -> frozenset[str]:
    if recovery_schema not in SUPPORTED_RECOVERY_SCHEMAS:
        fail("recovery manifest schema is unsupported")
    expected = set(CORE_RECOVERY_COMPONENTS)
    expected.update({
        "stalwart-data",
        "stalwart-mail-data",
        "stalwart-install",
    })
    # V2 is the read-only legacy full-host contract. V4 is its explicit
    # successor for the live-member reconciliation writer and also carries
    # whole-OpenClaw restore authority. V3 is the distinct Portal-only contract
    # and deliberately never mutates /root/.openclaw.
    if recovery_schema in {RECOVERY_SCHEMA_V2, RECOVERY_SCHEMA_V4}:
        expected.add("openclaw-state")
    if targets["legacy-hosted-apps"] != targets["hosted-apps"]:
        expected.add("legacy-hosted-apps")
    if targets["legacy-portal-files"] not in {
        targets["portal-files"],
        targets["upload-storage"],
    }:
        expected.add("legacy-portal-files")
    if targets["legacy-portal-runtime"] != targets["projects"]:
        expected.add("legacy-portal-runtime")
    return frozenset(expected)


def validate_v3_systemd_metadata(
    members: dict[str, tarfile.TarInfo],
) -> None:
    for name, member in members.items():
        if name == "systemd":
            if not member.isdir():
                fail("v3 recovery archive systemd root is not a directory")
            continue
        if not name.startswith("systemd/"):
            continue
        fail("v3 recovery archive contains unsupported systemd metadata")
    if {
        name for name in members if name.startswith("configs/")
    } != {"configs/portal-backend.env.production"}:
        fail("v3 recovery archive configuration inventory is not minimal")


def v3_portal_member_mentions_environment(
    normalized: str,
    member: tarfile.TarInfo,
) -> bool:
    """Reject every embedded environment member and every link alias to one."""
    names = [normalized]
    if member.issym() or member.islnk():
        names.append(member.linkname)
    for name in names:
        try:
            parts = pathlib.PurePosixPath(name).parts
        except (TypeError, ValueError):
            return True
        if any(part.casefold().startswith(".env") for part in parts):
            return True
    return False


def validate_recovery_component_inventory(
    recovery_schema: str,
    components: dict[str, dict[str, Any]],
    targets: dict[str, pathlib.Path],
) -> frozenset[str]:
    expected = expected_recovery_component_ids(recovery_schema, targets)
    if recovery_schema == RECOVERY_SCHEMA_V3 and any(
        "openclaw" in component_id for component_id in components
    ):
        fail("v3 recovery archive contains an OpenClaw component")
    if set(components) != expected:
        fail("recovery archive component inventory is incomplete or contradictory")
    return expected


def validate_comprehensive_component_capture(
    recovery_schema: str,
    component_id: str,
    entry: dict[str, Any],
) -> None:
    """Bind every restorable component to the quiesced schema contract."""
    if recovery_schema not in SUPPORTED_RECOVERY_SCHEMAS:
        fail("recovery manifest schema is unsupported")
    if "liveReconciliation" in entry:
        fail("comprehensive recovery component contains live reconciliation evidence")
    status = entry.get("status")
    if status == "not-configured":
        if entry.get("captureMethod") is not None:
            fail("absent recovery component contract is invalid")
        return
    if status != "captured":
        fail("recovery component state is invalid")
    if component_id == "database":
        expected_method = "pg-dump-custom"
    elif component_id == "portal-environment":
        expected_method = (
            "v3-sanitized-environment"
            if recovery_schema == RECOVERY_SCHEMA_V3
            else "file-copy"
        )
    else:
        expected_method = "service-quiesced-tar"
    if entry.get("captureMethod") != expected_method:
        fail("recovery component capture method conflicts with its schema")


def validate_database_identity(
    value: Any,
    postgres_major: int,
) -> dict[str, Any]:
    required = {
        "schema",
        "postgresMajor",
        "encoding",
        "lcCollate",
        "lcCtype",
        "localeProvider",
        "providerLocale",
        "icuRules",
        "collationVersion",
        "collationActualVersion",
    }

    def safe_text(candidate: Any, maximum: int) -> bool:
        return (
            isinstance(candidate, str)
            and bool(candidate)
            and len(candidate.encode("utf-8")) <= maximum
            and all(
                ord(character) >= 32 and ord(character) != 127
                for character in candidate
            )
        )

    if not isinstance(value, dict) or set(value) != required:
        fail("database identity contract is invalid")
    provider = value.get("localeProvider")
    if (
        value.get("schema") != "bridgesllm.postgresql-database-identity.v1"
        or value.get("postgresMajor") != postgres_major
        or value.get("encoding") != "UTF8"
        or not safe_text(value.get("lcCollate"), 256)
        or not safe_text(value.get("lcCtype"), 256)
        or provider not in {"libc", "icu", "builtin"}
        or (provider == "libc" and value.get("providerLocale") is not None)
        or (
            provider in {"icu", "builtin"}
            and not safe_text(value.get("providerLocale"), 1024)
        )
        or (
            value.get("icuRules") is not None
            and (
                provider != "icu"
                or not safe_text(value["icuRules"], 4096)
            )
        )
        or (
            value.get("collationVersion") is not None
            and not safe_text(value["collationVersion"], 256)
        )
        or (
            value.get("collationActualVersion") is not None
            and not safe_text(value["collationActualVersion"], 256)
        )
        or value.get("collationVersion")
        != value.get("collationActualVersion")
    ):
        fail("database identity contract is invalid")
    return dict(value)


def validated_test_root(raw: str | None) -> pathlib.Path | None:
    if raw is None:
        return None
    root = pathlib.Path(raw)
    if (
        not re.fullmatch(
            r"(?:/root/bridgesllm-installer-data-test-[A-Za-z0-9._-]+/"
            r"restore-fixture|/4[A-Za-z0-9]{3})",
            raw,
        )
        or not root.is_absolute()
        or os.path.normpath(raw) != raw
        or os.path.realpath(raw) != raw
    ):
        fail("restore test root is not an attested validator fixture")
    info = os.lstat(root)
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        fail("restore test root metadata is unsafe")
    return root


def environment_target_map(
    values: dict[str, str],
    test_root: pathlib.Path | None = None,
) -> dict[str, pathlib.Path]:
    install_root = canonical_absolute(values.get("INSTALL_ROOT", "/opt/bridgesllm"), label="INSTALL_ROOT")
    portal_root = canonical_absolute(
        values.get("PORTAL_ROOT", str(install_root / "portal")),
        label="PORTAL_ROOT",
    )
    data_root = canonical_absolute(values.get("PORTAL_DATA_ROOT", str(portal_root)), label="PORTAL_DATA_ROOT")
    projects = canonical_absolute(
        values.get("PORTAL_PROJECTS_ROOT") or values.get("PROJECTS_ROOT") or str(data_root / "projects"),
        label="PORTAL_PROJECTS_ROOT",
    )
    apps = canonical_absolute(values.get("APPS_ROOT", str(install_root / "apps")), label="APPS_ROOT")
    portal_app_sources = canonical_absolute(
        values.get("PORTAL_APPS_ROOT", str(data_root / "apps")),
        label="PORTAL_APPS_ROOT",
    )
    uploads = canonical_absolute(
        values.get("UPLOAD_DIR") or values.get("UPLOADS_ROOT") or str(install_root / "uploads"),
        label="UPLOAD_DIR",
    )
    portal_files = canonical_absolute(
        values.get("PORTAL_FILES_ROOT", "/var/portal-files"),
        label="PORTAL_FILES_ROOT",
    )
    assets = canonical_absolute(
        values.get("PORTAL_ASSETS_ROOT", str(install_root / "assets")),
        label="PORTAL_ASSETS_ROOT",
    )
    expected_portal = install_root / "portal"
    if portal_root != expected_portal:
        fail("installed Portal root is outside its exact installation boundary")
    fixed_root = test_root or pathlib.Path("/")
    legacy_runtime = fixed_root / "portal"
    if paths_overlap(portal_app_sources, apps):
        fail("standalone App source target overlaps hosted Apps")
    if (
        paths_overlap(portal_app_sources, portal_root)
        and portal_app_sources != portal_root / "apps"
    ):
        fail("standalone App source target overlaps the Portal runtime")
    if (
        paths_overlap(portal_app_sources, legacy_runtime)
        and portal_app_sources != legacy_runtime / "apps"
    ):
        fail("standalone App source target overlaps the legacy Portal runtime")
    for protected in (
        projects,
        uploads,
        portal_files,
        assets,
        portal_root / "backend" / ".data",
        portal_root / ".data",
        install_root / "stalwart",
        fixed_root / "var/www/bridgesllm-apps",
        fixed_root / "portal/files",
        fixed_root / "root/.openclaw",
        fixed_root / "var/stalwart",
        fixed_root / "var/stalwart-mail",
    ):
        if paths_overlap(portal_app_sources, protected):
            fail("standalone App source target overlaps another recovery domain")
    result = {
        "portal-install": portal_root,
        "portal-environment": portal_root / "backend" / ".env.production",
        "hosted-apps": apps,
        "portal-app-sources": portal_app_sources,
        "portal-files": portal_files,
        "upload-storage": uploads,
        "projects": projects,
        "portal-backend-state": portal_root / "backend" / ".data",
        "portal-state": portal_root / ".data",
        "portal-assets": assets,
        "openclaw-state": fixed_root / "root/.openclaw",
        "stalwart-data": fixed_root / "var/stalwart",
        "stalwart-mail-data": fixed_root / "var/stalwart-mail",
        "stalwart-install": install_root / "stalwart",
        "legacy-hosted-apps": fixed_root / "var/www/bridgesllm-apps",
        "legacy-portal-files": fixed_root / "portal/files",
        "legacy-portal-runtime": legacy_runtime,
    }
    openclaw_root = result["openclaw-state"]
    for component_id, target in result.items():
        if component_id != "openclaw-state" and paths_overlap(
            target,
            openclaw_root,
        ):
            fail(
                "Portal recovery target overlaps the preserved OpenClaw root"
            )
    return result


def validate_environment_target_equivalence(
    archived_values: dict[str, str],
    current_values: dict[str, str],
    test_root: pathlib.Path | None,
) -> dict[str, pathlib.Path]:
    current_targets = environment_target_map(current_values, test_root)
    archived_targets = environment_target_map(archived_values, test_root)
    if archived_targets != current_targets:
        fail("recovery environment redirects a Portal recovery target")
    return current_targets


def paths_overlap(left: pathlib.Path, right: pathlib.Path) -> bool:
    return (
        left == right
        or left.is_relative_to(right)
        or right.is_relative_to(left)
    )


def validate_target_topology(
    components: list[dict[str, Any]],
    protected_control_paths: tuple[pathlib.Path, ...],
    protected_authority_paths: tuple[pathlib.Path, ...],
) -> None:
    broad = {
        pathlib.Path(value)
        for value in (
            "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64",
            "/media", "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv",
            "/sys", "/tmp", "/usr", "/var",
        )
    }
    for component in components:
        target = pathlib.Path(component["target"])
        kind = component["kind"]
        if target in broad:
            fail("restore target is an unsafe broad path")
        if any(paths_overlap(target, protected) for protected in protected_control_paths):
            fail("restore target overlaps the restore control plane")
        authority_overlaps = [
            protected
            for protected in protected_authority_paths
            if paths_overlap(target, protected)
        ]
        if authority_overlaps:
            component_id = component.get("id")
            if component_id == "portal-install":
                pass
            elif (
                component_id == "portal-environment"
                and len(authority_overlaps) == 1
                and target == authority_overlaps[0]
            ):
                pass
            else:
                fail("restore target overlaps the sealed recovery authority")
        current = pathlib.Path("/")
        for part in target.parts[1:-1]:
            current /= part
            if not os.path.lexists(current):
                break
            info = os.lstat(current)
            if (
                stat.S_ISLNK(info.st_mode)
                or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != 0
                or info.st_gid != 0
            ):
                fail("restore target crosses an unsafe ownership boundary")
            if info.st_mode & 0o022:
                fail("restore target crosses a writable ownership boundary")
        if os.path.lexists(target):
            info = os.lstat(target)
            expected_type = (
                stat.S_ISDIR(info.st_mode)
                if kind == "directory"
                else stat.S_ISREG(info.st_mode)
                if kind == "file"
                else stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
            )
            if (
                stat.S_ISLNK(info.st_mode)
                or not expected_type
                or info.st_uid != 0
                or info.st_gid != 0
                or info.st_mode & 0o022
            ):
                fail("restore target is linked or special")

    try:
        mount_lines = pathlib.Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines()
    except OSError:
        fail("restore target mount topology is unavailable")
    mountpoints = []
    for line in mount_lines:
        fields = line.split()
        if len(fields) >= 5:
            mountpoints.append(
                fields[4].replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")
            )
    for component in components:
        target = pathlib.Path(component["target"])
        target_value = str(target)
        for mountpoint in mountpoints:
            if mountpoint == target_value or mountpoint.startswith(target_value + os.sep):
                fail("restore target contains a mount or bind-mount boundary")


def nested_size(
    handle: tarfile.TarFile,
    member: tarfile.TarInfo,
    absolute_symlink_roots: tuple[str, ...],
    expected_top_level: str,
    extraction_roots: tuple[pathlib.Path, ...],
    allow_project_interpreter_symlinks: bool = False,
    reject_privileged_metadata: bool = False,
) -> tuple[int, int]:
    stream = handle.extractfile(member)
    if stream is None:
        fail("nested recovery archive could not be opened")
    # Inspect the compressed member as a forward-only stream. Admission must
    # not spool attacker-controlled archive bytes onto /tmp before it has
    # calculated and enforced the restore disk budget.
    try:
        with tarfile.open(fileobj=stream, mode="r|gz") as nested:
            total, count = validate_nested_stream(
                nested,
                absolute_symlink_roots=absolute_symlink_roots,
                allow_project_interpreter_symlinks=allow_project_interpreter_symlinks,
                expected_top_level=expected_top_level,
                extraction_roots=extraction_roots,
                reject_privileged_metadata=reject_privileged_metadata,
            )
    except tarfile.TarError as error:
        raise RecoveryArchiveError("nested recovery archive is invalid") from error
    return total, count


def validate_recovery_authority(
    handle: tarfile.TarFile,
    member: tarfile.TarInfo,
    expected_top_level: str,
    portal_root: pathlib.Path,
    recovery_schema: str,
    current_environment_payload: bytes,
) -> dict[str, str]:
    relative_paths = [
        "restore-full.sh",
        "backup-full.sh",
        "installer/install.sh",
        "installer/portal-recovery-archive.py",
    ]
    if recovery_schema not in SUPPORTED_RECOVERY_SCHEMAS:
        fail("recovery manifest schema is unsupported")
    expected: dict[str, tuple[str, int, int, int]] = {}
    for relative in relative_paths:
        source = portal_root / relative
        try:
            info = os.lstat(source)
        except OSError:
            fail("installed restore authority is unavailable")
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_nlink != 1
            or info.st_mode & 0o022
            or info.st_size <= 0
            or info.st_size > 32 * 1024 * 1024
        ):
            fail("installed restore authority is unsafe")
        expected[f"{expected_top_level}/{relative}"] = (
            sha256_file(source),
            stat.S_IMODE(info.st_mode),
            info.st_uid,
            info.st_gid,
        )
    if recovery_schema in {RECOVERY_SCHEMA_V2, RECOVERY_SCHEMA_V4}:
        expected[f"{expected_top_level}/backend/.env.production"] = (
            hashlib.sha256(current_environment_payload).hexdigest(),
            0o600,
            0,
            0,
        )

    stream = handle.extractfile(member)
    if stream is None:
        fail("portal recovery authority archive could not be opened")
    found: dict[str, str] = {}
    try:
        with tarfile.open(fileobj=stream, mode="r|gz") as nested:
            for item in nested:
                normalized = normalized_member(item)
                if (
                    recovery_schema == RECOVERY_SCHEMA_V3
                    and v3_portal_member_mentions_environment(normalized, item)
                ):
                    fail("v3 Portal archive contains embedded environment metadata")
                authority = expected.get(normalized)
                if authority is None:
                    continue
                if (
                    not item.isfile()
                    or item.size <= 0
                    or item.size > 32 * 1024 * 1024
                    or stat.S_IMODE(item.mode) != authority[1]
                    or item.uid != authority[2]
                    or item.gid != authority[3]
                ):
                    fail("archived restore authority metadata differs from the running restore")
                payload = nested.extractfile(item)
                if payload is None:
                    fail("archived restore authority could not be read")
                digest = hashlib.sha256()
                remaining = item.size
                while remaining:
                    chunk = payload.read(min(1024 * 1024, remaining))
                    if not chunk:
                        fail("archived restore authority ended unexpectedly")
                    digest.update(chunk)
                    remaining -= len(chunk)
                actual = digest.hexdigest()
                if actual != authority[0]:
                    fail("archived restore authority differs from the running restore")
                if normalized in found:
                    fail("archived restore authority is duplicated")
                found[normalized] = actual
    except tarfile.TarError as error:
        raise RecoveryArchiveError(
            "portal recovery authority archive is invalid"
        ) from error
    if set(found) != set(expected):
        fail("portal archive omits required restore authority")
    return {
        normalized.removeprefix(expected_top_level + "/"): digest
        for normalized, digest in sorted(found.items())
    }


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def inspect_archive(
    archive: pathlib.Path,
    hmac_key_path: pathlib.Path,
    pg_restore: pathlib.Path,
    postgres_major: int,
    expected_version: str,
    current_env_authority_path: pathlib.Path,
    current_env_target_path: pathlib.Path,
    transaction_dir: pathlib.Path,
    test_root: pathlib.Path | None = None,
    protected_control_paths: tuple[pathlib.Path, ...] = (),
    protected_authority_paths: tuple[pathlib.Path, ...] = (),
) -> dict[str, Any]:
    archive_info = os.lstat(archive)
    if (
        not stat.S_ISREG(archive_info.st_mode)
        or stat.S_ISLNK(archive_info.st_mode)
        or archive_info.st_uid != 0
        or archive_info.st_nlink != 1
        or archive_info.st_mode & 0o022
        or archive_info.st_size <= 0
    ):
        fail("recovery archive is unsafe")
    current_raw, current_values = current_environment(
        current_env_authority_path
    )
    key = read_hmac_key(hmac_key_path)
    try:
        with tarfile.open(archive, mode="r:gz") as handle:
            authenticated_members, authenticated_bytes = authenticate_open_archive(
                handle,
                key,
            )
            members, validated_outer_bytes = validate_members(
                list(authenticated_members.values()),
                require={
                    MANIFEST_NAME,
                    MAC_RECORD_NAME,
                    "RECOVERY-MANIFEST.json",
                    "database.dump",
                    "configs/portal-backend.env.production",
                },
                extraction_root=transaction_dir / "stage",
            )
            if validated_outer_bytes > authenticated_bytes:
                fail("authenticated archive size accounting changed")
            outer_bytes = authenticated_bytes
            recovery_raw = read_member(
                handle,
                members["RECOVERY-MANIFEST.json"],
                MAX_MANIFEST_BYTES,
            )
            archived_env_raw = read_member(
                handle,
                members["configs/portal-backend.env.production"],
                MAX_MANIFEST_BYTES,
            )
            validate_pg_dump_custom(
                handle,
                members["database.dump"],
                pg_restore,
                postgres_major,
                transaction_dir,
            )
            try:
                document = json.loads(recovery_raw)
            except json.JSONDecodeError as error:
                raise RecoveryArchiveError("recovery manifest is invalid JSON") from error
            recovery_schema = recovery_manifest_schema(document)
            archived_values = (
                validate_v3_environment(archived_env_raw)
                if recovery_schema == RECOVERY_SCHEMA_V3
                else parse_environment(archived_env_raw)
            )
            merged_env_raw = (
                merge_v3_environment(archived_env_raw, current_raw)
                if recovery_schema == RECOVERY_SCHEMA_V3
                else archived_env_raw
            )
            environment_policy = {
                RECOVERY_SCHEMA_V2: "exact-v2",
                RECOVERY_SCHEMA_V3: "portal-only-preserve-openclaw-v3",
                RECOVERY_SCHEMA_V4: "exact-full-v4",
            }.get(recovery_schema)
            if environment_policy is None:
                fail("recovery manifest schema is unsupported")
            environment_authority = {
                "schema": "bridgesllm.portal-environment-authority.v1",
                "policy": environment_policy,
                "archivedSha256": hashlib.sha256(archived_env_raw).hexdigest(),
                "currentSha256": hashlib.sha256(current_raw).hexdigest(),
                "mergedSha256": hashlib.sha256(merged_env_raw).hexdigest(),
            }
            if recovery_schema == RECOVERY_SCHEMA_V3:
                validate_v3_systemd_metadata(members)
            source_database_identity = validate_database_identity(
                document.get("databaseIdentity"),
                postgres_major,
            )
            if document.get("metadataProfile") != METADATA_PROFILE:
                fail("recovery archive does not provide exact Linux metadata")
            if document.get("backupType") != "comprehensive":
                fail("offline restore requires a comprehensive archive")
            if document.get("directoryConsistency") != "service-database-quiesced-v2":
                fail("offline restore requires service and database quiescence")
            portal_version = document.get("portalVersion")
            if (
                not isinstance(portal_version, str)
                or not VERSION_PATTERN.fullmatch(portal_version)
                or portal_version != expected_version
            ):
                fail("recovery archive version is not exactly compatible with this restore runtime")
            profile = document.get("installationProfile")
            if profile not in {"server", "local"}:
                fail("recovery archive installation profile is unsupported")
            if current_values.get("INSTALL_PROFILE", "server") != profile:
                fail("recovery archive installation profile does not match the installed target")
            if current_values.get("DATABASE_URL") != archived_values.get("DATABASE_URL"):
                fail("recovery archive database authority does not match the installed target")
            if not current_values.get("DATABASE_URL"):
                fail("installed database authority is missing")
            # V2 and V4 restore their whole OpenClaw authority and therefore
            # require exact environment bytes. V3 archives only Portal-owned
            # assignments; current OpenClaw authority is merged into the staged
            # environment after authenticated extraction.
            if (
                recovery_schema in {RECOVERY_SCHEMA_V2, RECOVERY_SCHEMA_V4}
                and current_raw != archived_env_raw
            ):
                fail("recovery archive environment differs from the installed target")
            archived_env = members["configs/portal-backend.env.production"]
            if (
                archived_env.uid != 0
                or archived_env.gid != 0
                or stat.S_IMODE(archived_env.mode) != 0o600
                or archived_env.size != len(archived_env_raw)
            ):
                fail("recovery archive environment metadata is not exact")

            components = component_map(document)
            targets = validate_environment_target_equivalence(
                archived_values,
                current_values,
                test_root,
            )
            if current_env_target_path != targets["portal-environment"]:
                fail(
                    "supplied current Portal environment target differs from its map"
                )
            if test_root is not None:
                for target in targets.values():
                    if target != test_root and not target.is_relative_to(test_root):
                        fail("restore test target escaped its fixture root")
            required_ids = set(CORE_RECOVERY_COMPONENTS)
            if not required_ids.issubset(components):
                fail("recovery archive lacks required core components")
            expected_payloads = RECOVERY_COMPONENT_PAYLOADS
            validate_recovery_component_inventory(
                recovery_schema,
                components,
                targets,
            )
            for component_id, entry in components.items():
                validate_comprehensive_component_capture(
                    recovery_schema,
                    component_id,
                    entry,
                )
            unsupported = set(components) - set(expected_payloads)
            if unsupported:
                fail("recovery archive contains an unsupported component")
            for component_id in required_ids:
                entry = components[component_id]
                if (
                    entry.get("requirement") != "required"
                    or entry.get("status") != "captured"
                    or entry.get("payload") != expected_payloads[component_id]
                ):
                    fail("required recovery component contract is invalid")
            if components["database"].get("captureMethod") != "pg-dump-custom":
                fail("database recovery component is not custom pg_dump format")
            database_logical_bytes = components["database"].get("logicalBytes")
            database_relation_count = components["database"].get("relationCount")
            database_contract_variant = components["database"].get(
                "databaseContractVariant"
            )
            if (
                not isinstance(database_logical_bytes, int)
                or isinstance(database_logical_bytes, bool)
                or database_logical_bytes <= 0
                or database_logical_bytes > MAX_ARCHIVE_BYTES
                or not isinstance(database_relation_count, int)
                or isinstance(database_relation_count, bool)
                or database_relation_count <= 0
                or database_relation_count > 100_000_000
                or database_contract_variant not in {
                    "owner-null",
                    "pg-database-owner-default",
                }
            ):
                fail("database recovery storage metadata is invalid")
            for component_id, entry in components.items():
                if component_id != "database" and (
                    entry.get("logicalBytes") is not None
                    or entry.get("relationCount") is not None
                    or entry.get("databaseContractVariant") is not None
                ):
                    fail("non-database recovery component claims database storage metadata")
            admitted: list[dict[str, Any]] = []
            nested_bytes = 0
            nested_inodes = 0
            recovery_authority: dict[str, str] | None = None
            for component_id, entry in sorted(components.items()):
                status = entry.get("status")
                requirement = entry.get("requirement")
                if status == "not-configured":
                    if (
                        requirement != "optional"
                        or entry.get("payload") is not None
                        or entry.get("captureMethod") is not None
                    ):
                        fail("absent recovery component contract is invalid")
                    target = targets.get(component_id)
                    if target is None:
                        fail("absent recovery component target is unsupported")
                    if entry.get("source") != str(target):
                        fail("absent recovery source authority does not match target")
                    admitted.append({
                        "id": component_id,
                        "payload": "-",
                        "target": str(target),
                        "kind": "absent",
                    })
                    continue
                if status != "captured":
                    fail("recovery component state is invalid")
                payload = entry.get("payload")
                if (
                    not isinstance(payload, str)
                    or payload != expected_payloads.get(component_id)
                    or payload not in members
                ):
                    fail("captured recovery payload is absent from the archive")
                target = targets.get(component_id)
                if component_id == "database":
                    if payload != "database.dump":
                        fail("database recovery payload is invalid")
                    continue
                if component_id == "portal-environment":
                    if payload != "configs/portal-backend.env.production":
                        fail("Portal environment recovery payload is invalid")
                    expected_method = (
                        "v3-sanitized-environment"
                        if recovery_schema == RECOVERY_SCHEMA_V3
                        else "file-copy"
                    )
                    if entry.get("captureMethod") != expected_method:
                        fail("Portal environment capture method is invalid")
                    if entry.get("source") != str(targets[component_id]):
                        fail("Portal environment source authority does not match target")
                    admitted.append({
                        "id": component_id,
                        "payload": payload,
                        "target": str(targets[component_id]),
                        "kind": "file",
                    })
                    continue
                if target is None:
                    fail("recovery archive contains an unsupported captured component")
                if component_id in {
                    "openclaw-state",
                    "stalwart-data",
                    "stalwart-mail-data",
                    "stalwart-install",
                } and requirement != "required":
                    fail("captured installed feature is not recovery-required")
                source = entry.get("source")
                if source != str(target):
                    fail(f"recovery source authority does not match target: {component_id}")
                if not payload.endswith(".tar.gz"):
                    fail("directory recovery component is not a nested archive")
                allowed_symlink_roots = [str(target)]
                if component_id == "openclaw-state":
                    allowed_symlink_roots.append("/usr/lib/node_modules/openclaw")
                component_bytes, component_inodes = nested_size(
                    handle,
                    members[payload],
                    tuple(allowed_symlink_roots),
                    target.name,
                    (
                        transaction_dir / "components" / component_id,
                        target.parent,
                    ),
                    allow_project_interpreter_symlinks=component_id == "projects",
                    reject_privileged_metadata=component_id == "portal-install",
                )
                if component_id == "portal-install":
                    recovery_authority = validate_recovery_authority(
                        handle,
                        members[payload],
                        target.name,
                        current_env_target_path.parent.parent,
                        recovery_schema,
                        current_raw,
                    )
                nested_bytes += component_bytes
                nested_inodes += component_inodes
                admitted.append({
                    "id": component_id,
                    "payload": payload,
                    "target": str(target),
                    "kind": "directory",
                    "expandedBytes": component_bytes,
                    "expandedInodes": component_inodes,
                })
            admitted_targets = [pathlib.Path(item["target"]) for item in admitted]
            if len(admitted_targets) != len(set(admitted_targets)):
                fail("recovery components resolve to a duplicate target")
            validate_target_topology(
                sorted(admitted, key=lambda item: item["target"]),
                protected_control_paths,
                protected_authority_paths,
            )
            if recovery_authority is None:
                fail("restore authority was not bound to the portal payload")
            portal_target = targets["portal-install"]
            if any(
                not protected.is_relative_to(portal_target)
                for protected in protected_authority_paths
            ):
                fail("sealed recovery authority is outside the portal target")
            return {
                "schema": "bridgesllm.restore-admission.v2",
                "recoverySchema": recovery_schema,
                "environmentAuthority": environment_authority,
                "archive": str(archive),
                "archiveSha256": sha256_file(archive),
                "portalVersion": portal_version,
                "installationProfile": profile,
                "metadataProfile": METADATA_PROFILE,
                "outerExpandedBytes": outer_bytes,
                "outerExpandedInodes": len(members),
                "nestedExpandedBytes": nested_bytes,
                "nestedExpandedInodes": nested_inodes,
                "databaseDumpBytes": members["database.dump"].size,
                "databaseLogicalBytes": database_logical_bytes,
                "databaseRelationCount": database_relation_count,
                "databaseContractVariant": database_contract_variant,
                "sourceDatabaseIdentity": source_database_identity,
                "recoveryAuthority": recovery_authority,
                "components": admitted,
            }
    except tarfile.TarError as error:
        raise RecoveryArchiveError("recovery archive could not be parsed") from error


def listed_xattrs(
    target: pathlib.Path,
    *,
    descriptor: int | None = None,
    follow_symlinks: bool = True,
) -> dict[bytes, bytes]:
    if descriptor is not None:
        raw_names = os.listxattr(descriptor)
    else:
        raw_names = os.listxattr(target, follow_symlinks=follow_symlinks)
    names = [
        value if isinstance(value, bytes) else value.encode("utf-8", "surrogateescape")
        for value in raw_names
    ]
    result: dict[bytes, bytes] = {}
    for name in names:
        if descriptor is not None:
            result[name] = os.getxattr(descriptor, name)
        else:
            result[name] = os.getxattr(
                target,
                name,
                follow_symlinks=follow_symlinks,
            )
    return result


def apply_member_xattrs(
    target: pathlib.Path,
    member: tarfile.TarInfo,
    *,
    descriptor: int | None = None,
    follow_symlinks: bool = True,
) -> None:
    expected = dict(member_xattrs(member))
    current = listed_xattrs(
        target,
        descriptor=descriptor,
        follow_symlinks=follow_symlinks,
    )
    for name in sorted(set(current) - set(expected)):
        if descriptor is not None:
            os.removexattr(descriptor, name)
        else:
            os.removexattr(target, name, follow_symlinks=follow_symlinks)
    for name, value in sorted(expected.items()):
        if descriptor is not None:
            os.setxattr(descriptor, name, value)
        else:
            os.setxattr(
                target,
                name,
                value,
                follow_symlinks=follow_symlinks,
            )
    if listed_xattrs(
        target,
        descriptor=descriptor,
        follow_symlinks=follow_symlinks,
    ) != expected:
        fail("archive member extended attributes were not restored exactly")


def apply_exact_member_metadata(
    target: pathlib.Path,
    member: tarfile.TarInfo,
    *,
    descriptor: int | None = None,
    symlink: bool = False,
) -> None:
    mtime_ns = exact_mtime_ns(member)
    if descriptor is not None:
        os.fchown(descriptor, member.uid, member.gid)
        os.fchmod(descriptor, member.mode & 0o7777)
        apply_member_xattrs(target, member, descriptor=descriptor)
        current = os.fstat(descriptor)
        os.utime(descriptor, ns=(current.st_atime_ns, mtime_ns))
        os.fsync(descriptor)
        restored = os.fstat(descriptor)
    else:
        if symlink:
            os.lchown(target, member.uid, member.gid)
        else:
            os.chown(target, member.uid, member.gid, follow_symlinks=False)
            os.chmod(target, member.mode & 0o7777, follow_symlinks=False)
        apply_member_xattrs(
            target,
            member,
            follow_symlinks=not symlink,
        )
        current = os.lstat(target)
        os.utime(
            target,
            ns=(current.st_atime_ns, mtime_ns),
            follow_symlinks=not symlink,
        )
        restored = os.lstat(target)
    if (
        restored.st_uid != member.uid
        or restored.st_gid != member.gid
        or (not symlink and stat.S_IMODE(restored.st_mode) != (member.mode & 0o7777))
        or restored.st_mtime_ns != mtime_ns
    ):
        fail("archive member metadata was not restored exactly")


def extract_regular_payload(
    handle: tarfile.TarFile,
    member: tarfile.TarInfo,
    descriptor: int,
) -> None:
    source = handle.extractfile(member)
    if source is None:
        fail("archive member could not be extracted")

    def copy_bytes(length: int) -> None:
        remaining = length
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                fail("archive member ended early")
            view = memoryview(chunk)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    fail("archive extraction made no progress")
                view = view[written:]
            remaining -= len(chunk)

    sparse = validated_sparse_map(member)
    if sparse is None:
        copy_bytes(member.size)
    else:
        for offset, length in sparse:
            source.seek(offset)
            os.lseek(descriptor, offset, os.SEEK_SET)
            copy_bytes(length)
        os.ftruncate(descriptor, member.size)


def safe_extract(
    archive: pathlib.Path | Any,
    destination: pathlib.Path,
    *,
    allow_relative_symlinks: bool = False,
    allow_hardlinks: bool = False,
    absolute_symlink_roots: tuple[str, ...] = (),
    allow_project_interpreter_symlinks: bool = False,
    expected_top_level: str | None = None,
    preserve_exact_metadata: bool = False,
    reject_privileged_metadata: bool = False,
) -> None:
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    if isinstance(archive, pathlib.Path):
        opened = tarfile.open(archive, mode="r:gz")
    else:
        opened = tarfile.open(fileobj=archive, mode="r:gz")
    with opened as handle:
        maximum = (
            MAX_ARCHIVE_MEMBERS
            if allow_relative_symlinks or allow_hardlinks
            else MAX_OUTER_MEMBERS
        )
        members, _ = validate_members(
            bounded_members(handle, maximum),
            allow_relative_symlinks=allow_relative_symlinks,
            allow_hardlinks=allow_hardlinks,
            absolute_symlink_roots=absolute_symlink_roots,
            allow_project_interpreter_symlinks=allow_project_interpreter_symlinks,
            expected_top_level=expected_top_level,
            extraction_root=destination,
            require_exact_metadata=preserve_exact_metadata,
            reject_privileged_metadata=reject_privileged_metadata,
        )
        deferred_hardlinks: list[tuple[str, tarfile.TarInfo]] = []
        deferred_directories: list[tuple[pathlib.Path, tarfile.TarInfo]] = []
        for normalized, member in sorted(
            members.items(),
            key=lambda item: (len(pathlib.PurePosixPath(item[0]).parts), item[0]),
        ):
            target = destination.joinpath(*pathlib.PurePosixPath(normalized).parts)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            resolved_parent = os.path.realpath(target.parent)
            if resolved_parent != str(target.parent):
                fail("archive extraction crossed a symbolic-link boundary")
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=False)
                if preserve_exact_metadata:
                    deferred_directories.append((target, member))
                else:
                    os.chmod(target, member.mode & 0o777)
                    os.chown(target, member.uid, member.gid)
                continue
            if member.issym():
                # Admission already proved that the lexical target remains
                # under this component's single top-level root. Refuse to
                # create through any earlier link and never follow the new
                # link while applying metadata.
                os.symlink(member.linkname, target)
                if preserve_exact_metadata:
                    apply_exact_member_metadata(target, member, symlink=True)
                else:
                    os.lchown(target, member.uid, member.gid)
                continue
            if member.islnk():
                deferred_hardlinks.append((normalized, member))
                continue
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(target, flags, 0o600)
            try:
                extract_regular_payload(handle, member, descriptor)
                if preserve_exact_metadata:
                    apply_exact_member_metadata(
                        target,
                        member,
                        descriptor=descriptor,
                    )
                else:
                    os.fchown(descriptor, member.uid, member.gid)
                    os.fchmod(descriptor, member.mode & 0o777)
                    os.fsync(descriptor)
            finally:
                os.close(descriptor)
        for normalized, member in deferred_hardlinks:
            target = destination.joinpath(
                *pathlib.PurePosixPath(normalized).parts)
            source_name = resolve_hardlink_target(
                normalized,
                members,
                require_exact_metadata=preserve_exact_metadata,
            )
            source = destination.joinpath(
                *pathlib.PurePosixPath(source_name).parts)
            source_member = members[source_name]
            if (
                os.path.realpath(target.parent) != str(target.parent)
                or os.path.realpath(source.parent) != str(source.parent)
            ):
                fail("archive hard-link extraction crossed a symbolic-link boundary")
            source_info = os.lstat(source)
            if (
                not stat.S_ISREG(source_info.st_mode)
                or stat.S_ISLNK(source_info.st_mode)
                or source_info.st_uid != member.uid
                or source_info.st_gid != member.gid
                or stat.S_IMODE(source_info.st_mode)
                    != (member.mode & (0o7777 if preserve_exact_metadata else 0o777))
                or (
                    preserve_exact_metadata
                    and source_info.st_mtime_ns != exact_mtime_ns(source_member)
                )
            ):
                fail("archive hard-link source changed after admission")
            if preserve_exact_metadata and listed_xattrs(source) != dict(
                member_xattrs(source_member)
            ):
                fail("archive hard-link source metadata changed after admission")
            os.link(source, target, follow_symlinks=False)
        for target, member in sorted(
            deferred_directories,
            key=lambda item: (
                -len(item[0].parts),
                str(item[0]),
            ),
        ):
            descriptor = os.open(
                target,
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                apply_exact_member_metadata(
                    target,
                    member,
                    descriptor=descriptor,
                )
            finally:
                os.close(descriptor)
    # A journal phase may make this tree authoritative immediately after the
    # helper returns. Commit both file data and every created directory entry
    # before that phase can advance.
    directories: list[pathlib.Path] = []
    for directory, _, filenames in os.walk(destination, topdown=False, followlinks=False):
        current = pathlib.Path(directory)
        directories.append(current)
        for name in filenames:
            path = current / name
            info = os.lstat(path)
            if stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
    for directory in directories:
        descriptor = os.open(
            directory,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    parent_descriptor = os.open(
        destination.parent,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
    )
    try:
        os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)


def atomic_json(path: pathlib.Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = ""
        os.chmod(path, 0o600)
        directory_descriptor = os.open(
            path.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    authenticate_parser = subparsers.add_parser("authenticate")
    authenticate_parser.add_argument("--archive", required=True)
    authenticate_parser.add_argument("--hmac-key", required=True)
    inspect_parser = subparsers.add_parser("inspect")
    inspect_parser.add_argument("--archive", required=True)
    inspect_parser.add_argument("--hmac-key", required=True)
    inspect_parser.add_argument("--pg-restore", required=True)
    inspect_parser.add_argument("--postgres-major", required=True, type=int)
    inspect_parser.add_argument("--expected-version", required=True)
    inspect_parser.add_argument("--current-env", required=True)
    inspect_parser.add_argument("--current-env-target", required=True)
    inspect_parser.add_argument("--output", required=True)
    inspect_parser.add_argument("--test-root")
    inspect_parser.add_argument(
        "--protected-control-path",
        action="append",
        default=[],
    )
    inspect_parser.add_argument(
        "--protected-authority-path",
        action="append",
        default=[],
    )
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--archive", required=True)
    extract_parser.add_argument("--hmac-key", required=True)
    extract_parser.add_argument("--destination", required=True)
    merge_environment_parser = subparsers.add_parser("merge-environment")
    merge_environment_parser.add_argument("--archived", required=True)
    merge_environment_parser.add_argument("--current", required=True)
    merge_environment_parser.add_argument("--output", required=True)
    merge_environment_parser.add_argument("--expected-archived-sha256", required=True)
    merge_environment_parser.add_argument("--expected-current-sha256", required=True)
    merge_environment_parser.add_argument("--expected-output-sha256", required=True)
    assert_environment_parser = subparsers.add_parser("assert-environment")
    assert_environment_parser.add_argument("--admission", required=True)
    assert_environment_parser.add_argument("--sealed-current", required=True)
    assert_environment_parser.add_argument("--staged", required=True)
    assert_environment_parser.add_argument("--merged", required=True)
    assert_environment_parser.add_argument("--live", required=True)
    assert_environment_parser.add_argument(
        "--phase",
        required=True,
        choices=("pre-files", "files-restored", "rollback", "commit"),
    )
    component_parser = subparsers.add_parser("extract-component")
    component_parser.add_argument("--archive", required=True)
    component_parser.add_argument("--destination", required=True)
    component_parser.add_argument("--target", required=True)
    component_parser.add_argument("--component", required=True)
    args = parser.parse_args()

    if args.command == "authenticate":
        identity = authenticate_archive(
            canonical_absolute(args.archive, label="archive"),
            canonical_absolute(args.hmac_key, label="backup trust key"),
        )
        print(json.dumps(identity, sort_keys=True, separators=(",", ":")))
        return 0
    if args.command == "inspect":
        expected_version = args.expected_version
        if not VERSION_PATTERN.fullmatch(expected_version):
            fail("expected restore version is invalid")
        output = canonical_absolute(args.output, label="admission output")
        admission = inspect_archive(
            canonical_absolute(args.archive, label="archive"),
            canonical_absolute(args.hmac_key, label="backup trust key"),
            canonical_absolute(args.pg_restore, label="pg_restore"),
            args.postgres_major,
            expected_version,
            canonical_absolute(args.current_env, label="current environment"),
            canonical_absolute(
                args.current_env_target,
                label="current environment target",
            ),
            output.parent,
            validated_test_root(args.test_root),
            tuple(
                canonical_absolute(value, label="protected control path")
                for value in args.protected_control_path
            ),
            tuple(
                canonical_absolute(value, label="protected authority path")
                for value in args.protected_authority_path
            ),
        )
        atomic_json(output, admission)
        return 0
    if args.command == "extract":
        archive = canonical_absolute(args.archive, label="archive")
        hmac_key = canonical_absolute(args.hmac_key, label="backup trust key")
        authenticate_archive(archive, hmac_key)
        safe_extract(
            archive,
            canonical_absolute(args.destination, label="destination"),
        )
        return 0
    if args.command == "merge-environment":
        archived_raw, _ = current_environment(
            canonical_absolute(args.archived, label="archived Portal environment")
        )
        current_raw, _ = current_environment(
            canonical_absolute(args.current, label="current Portal environment")
        )
        expected_digests = (
            args.expected_archived_sha256,
            args.expected_current_sha256,
            args.expected_output_sha256,
        )
        if any(re.fullmatch(r"[a-f0-9]{64}", value) is None for value in expected_digests):
            fail("Portal environment digest authority is invalid")
        merged = merge_v3_environment(archived_raw, current_raw)
        observed_digests = (
            hashlib.sha256(archived_raw).hexdigest(),
            hashlib.sha256(current_raw).hexdigest(),
            hashlib.sha256(merged).hexdigest(),
        )
        if observed_digests != expected_digests:
            fail("Portal environment digest authority changed")
        write_private_payload(
            canonical_absolute(args.output, label="merged Portal environment"),
            merged,
        )
        return 0
    if args.command == "assert-environment":
        assert_environment_authority(
            canonical_absolute(args.admission, label="restore admission"),
            canonical_absolute(
                args.sealed_current,
                label="sealed current Portal environment",
            ),
            canonical_absolute(args.staged, label="staged Portal environment"),
            canonical_absolute(args.merged, label="merged Portal environment"),
            canonical_absolute(args.live, label="live Portal environment"),
            args.phase,
        )
        return 0
    if args.command == "extract-component":
        if not COMPONENT_PATTERN.fullmatch(args.component):
            fail("nested component identity is unsafe")
        target = canonical_absolute(args.target, label="target")
        safe_extract(
            canonical_absolute(args.archive, label="archive"),
            canonical_absolute(args.destination, label="destination"),
            allow_relative_symlinks=True,
            allow_hardlinks=True,
            absolute_symlink_roots=(
                (str(target), "/usr/lib/node_modules/openclaw")
                if args.component == "openclaw-state"
                else (str(target),)
            ),
            allow_project_interpreter_symlinks=args.component == "projects",
            expected_top_level=target.name,
            preserve_exact_metadata=True,
            reject_privileged_metadata=args.component == "portal-install",
        )
        return 0
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RecoveryArchiveError, json.JSONDecodeError) as error:
        print(f"Portal recovery archive rejected: {error}", file=os.sys.stderr)
        raise SystemExit(1)
