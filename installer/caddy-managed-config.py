#!/usr/bin/env python3
"""Safely converge only BridgesLLM-owned Caddy configuration.

The installer calls this helper before the Portal backend is guaranteed to be
runnable. Keep it dependency-free and compatible with the system Python
shipped by every supported Ubuntu/Debian release.
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


PORTAL_BEGIN = "# BEGIN BridgesLLM Portal — managed block"
PORTAL_END = "# END BridgesLLM Portal — managed block"
APP_BEGIN = "# BEGIN BridgesLLM App Content — managed block"
APP_END = "# END BridgesLLM App Content — managed block"
LEGACY_PORTAL_HEADERS = {
    "# BridgesLLM Portal — managed by setup wizard",
    "# BridgesLLM Portal — managed by installer",
}
MAX_CADDYFILE_BYTES = 4 * 1024 * 1024
MAX_MANAGED_BLOCK_BYTES = 256 * 1024


class ManagedConfigError(RuntimeError):
    """Expected fail-closed configuration error."""


@dataclass(frozen=True)
class TextRange:
    start: int
    end: int


@dataclass(frozen=True)
class TextLine(TextRange):
    text: str


@dataclass(frozen=True)
class CaddyBlock:
    header: str
    body: TextRange


@dataclass(frozen=True)
class FileMetadata:
    mode: int
    uid: int
    gid: int
    atime_ns: int
    mtime_ns: int
    xattrs: tuple[tuple[str, bytes], ...]


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class ExistingFile:
    exists: bool
    content: str
    metadata: Optional[FileMetadata]
    identity: Optional[FileIdentity]


class CommandRunner:
    """Production Caddy validator/activator."""

    def validate(self, candidate_path: str) -> None:
        subprocess.run(
            ["caddy", "validate", "--config", candidate_path, "--adapter", "caddyfile"],
            check=True,
            timeout=20,
        )

    def activate(self) -> None:
        subprocess.run(
            ["systemctl", "reload-or-restart", "caddy"],
            check=True,
            timeout=30,
        )


def _text_lines(content: str) -> list[TextLine]:
    lines: list[TextLine] = []
    cursor = 0
    while cursor < len(content):
        newline = content.find("\n", cursor)
        end = len(content) if newline == -1 else newline + 1
        raw = content[cursor:] if newline == -1 else content[cursor:newline]
        if raw.endswith("\r"):
            raw = raw[:-1]
        lines.append(TextLine(cursor, end, raw))
        cursor = end
    return lines


def _exact_lines(content: str, marker: str) -> list[TextLine]:
    return [line for line in _text_lines(content) if line.text.strip() == marker]


def _marked_range(content: str, begin: str, end: str) -> Optional[TextRange]:
    begins = _exact_lines(content, begin)
    ends = _exact_lines(content, end)
    if not begins and not ends:
        return None
    if len(begins) != 1 or len(ends) != 1 or ends[0].start < begins[0].end:
        raise ManagedConfigError("Caddyfile contains malformed or duplicate managed markers.")
    return TextRange(begins[0].start, ends[0].end)


def _following_line_ending(content: str, end: int) -> int:
    if content.startswith("\r\n", end):
        return end + 2
    if end < len(content) and content[end] == "\n":
        return end + 1
    return end


def _next_caddy_block(content: str, start: int) -> Optional[TextRange]:
    opened = -1
    depth = 0
    quote: Optional[str] = None
    escaped = False
    in_comment = False

    for index in range(start, len(content)):
        char = content[index]
        if in_comment:
            if char == "\n":
                in_comment = False
            continue
        if quote is not None:
            if escaped:
                escaped = False
            elif char == "\\" and quote != "`":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char == "#":
            in_comment = True
            continue
        if char in {'"', "'", "`"}:
            quote = char
            continue
        if char == "{":
            if opened == -1:
                opened = index
            depth += 1
            continue
        if char == "}" and opened != -1:
            depth -= 1
            if depth == 0:
                return TextRange(opened, index + 1)
            if depth < 0:
                return None
    return None


def _without_comments_and_strings(content: str) -> str:
    sanitized: list[str] = []
    quote: Optional[str] = None
    escaped = False
    in_comment = False
    for char in content:
        if in_comment:
            if char == "\n":
                in_comment = False
                sanitized.append("\n")
            else:
                sanitized.append(" ")
            continue
        if quote is not None:
            if escaped:
                escaped = False
            elif char == "\\" and quote != "`":
                escaped = True
            elif char == quote:
                quote = None
            sanitized.append("\n" if char == "\n" else " ")
            continue
        if char == "#":
            in_comment = True
            sanitized.append(" ")
            continue
        if char in {'"', "'", "`"}:
            quote = char
            sanitized.append(" ")
            continue
        sanitized.append(char)
    return "".join(sanitized)


def _has_portal_proxy(content: str, block: TextRange) -> bool:
    return re.search(
        r"(?m)^\s*reverse_proxy\s+127\.0\.0\.1:4001(?:\s|$)",
        _without_comments_and_strings(content[block.start:block.end]),
    ) is not None


def _top_level_caddy_blocks(content: str) -> list[CaddyBlock]:
    """Return top-level blocks whose labels are on the opening-brace line.

    Caddy site labels are line-oriented.  Keeping this parser deliberately
    narrower than Caddy's full grammar lets the installer recognize an
    operator-owned Portal site without ever claiming or rewriting it.  Braces
    inside comments and quoted strings are ignored.
    """

    sanitized = _without_comments_and_strings(content)
    blocks: list[CaddyBlock] = []
    depth = 0
    opened = -1
    header = ""
    for index, character in enumerate(sanitized):
        if character == "{":
            if depth == 0:
                line_start = sanitized.rfind("\n", 0, index) + 1
                header = sanitized[line_start:index].strip()
                opened = index
            depth += 1
            continue
        if character != "}" or depth == 0:
            continue
        depth -= 1
        if depth == 0 and opened >= 0:
            blocks.append(CaddyBlock(header, TextRange(opened, index + 1)))
            opened = -1
            header = ""
    return blocks


def _header_mentions_domain(header: str, domain: str) -> bool:
    return re.search(
        rf"(?i)(?<![a-z0-9.-])(?:www\.)?{re.escape(domain)}(?=[:/,\s]|$)",
        header,
    ) is not None


def _has_operator_owned_portal_block(content: str, domain: str) -> bool:
    """Recognize, but never adopt, one existing operator-owned Portal site.

    Older installations can have a hand-maintained Portal site block with
    custom routes and no BridgesLLM ownership marker.  Adding a second block
    for the same hostname makes Caddy reject the entire configuration.  A
    single exact hostname collision is safe to preserve only when that block
    already proxies to the Portal backend.  Every ambiguous case fails closed.
    """

    matches = [
        block
        for block in _top_level_caddy_blocks(content)
        if _header_mentions_domain(block.header, domain)
    ]
    if not matches:
        return False
    if len(matches) != 1:
        raise ManagedConfigError(
            "Caddyfile contains multiple operator-owned blocks for the Portal domain."
        )
    if not _has_portal_proxy(content, matches[0].body):
        raise ManagedConfigError(
            "The Portal domain is already used by an operator-owned Caddy block that does not proxy to Portal."
        )
    return True


def _legacy_portal_range(content: str) -> Optional[TextRange]:
    headers = [
        line
        for line in _text_lines(content)
        if line.text.strip() in LEGACY_PORTAL_HEADERS
    ]
    if not headers:
        return None
    if len(headers) != 1:
        raise ManagedConfigError("Caddyfile contains ambiguous legacy Portal ownership.")

    header = headers[0]
    primary = _next_caddy_block(content, header.end)
    if primary is None or not _has_portal_proxy(content, primary):
        raise ManagedConfigError("Legacy Portal Caddy configuration is incomplete.")
    end = _following_line_ending(content, primary.end)

    next_line = next(
        (
            line
            for line in _text_lines(content)
            if line.start >= end and line.text.strip()
        ),
        None,
    )
    if next_line and next_line.text.strip().startswith(
        "# Keep IP access alive during setup"
    ):
        setup_block = _next_caddy_block(content, next_line.end)
        setup_header = (
            content[next_line.end:setup_block.start].strip()
            if setup_block is not None
            else ""
        )
        if (
            setup_block is None
            or re.fullmatch(r"http://\d{1,3}(?:\.\d{1,3}){3}", setup_header)
            is None
            or not _has_portal_proxy(content, setup_block)
        ):
            raise ManagedConfigError("Legacy Portal setup access is incomplete.")
        end = _following_line_ending(content, setup_block.end)
    return TextRange(header.start, end)


def _portal_owned_range(content: str) -> Optional[TextRange]:
    managed = _marked_range(content, PORTAL_BEGIN, PORTAL_END)
    legacy = _legacy_portal_range(content)
    if managed is not None and legacy is not None:
        raise ManagedConfigError("Caddyfile contains multiple Portal-owned blocks.")
    return managed or legacy


def _owned_ranges(content: str) -> tuple[Optional[TextRange], Optional[TextRange]]:
    portal = _portal_owned_range(content)
    app = _marked_range(content, APP_BEGIN, APP_END)
    if (
        portal is not None
        and app is not None
        and portal.start < app.end
        and app.start < portal.end
    ):
        raise ManagedConfigError("Portal and app-content ownership blocks overlap.")
    return portal, app


def _normalize_managed_block(content: str, begin: str, end: str) -> str:
    if len(content.encode("utf-8")) > MAX_MANAGED_BLOCK_BYTES:
        raise ManagedConfigError("Managed Caddy block is unexpectedly large.")
    block_range = _marked_range(content, begin, end)
    if (
        block_range is None
        or content[:block_range.start].strip()
        or content[block_range.end:].strip()
    ):
        raise ManagedConfigError("Refusing an unmarked managed Caddy block.")
    block = content[block_range.start:block_range.end]
    return block if block.endswith("\n") else f"{block}\n"


def _site_header_addresses(header: str) -> set[str]:
    cleaned = _without_comments_and_strings(header).strip()
    # Snippets and named matchers are not site definitions and cannot collide.
    if not cleaned or cleaned.startswith("("):
        return set()
    addresses: set[str] = set()
    for token in re.split(r"[,\s]+", cleaned):
        if not token:
            continue
        candidate = token
        for scheme in ("http://", "https://"):
            if candidate.lower().startswith(scheme):
                candidate = candidate[len(scheme):]
                break
        # A port-only listener such as :8443 claims no hostname.
        if candidate.startswith(":"):
            continue
        if not candidate.endswith("]"):
            candidate = re.sub(r":\d+$", "", candidate)
        candidate = candidate.strip().rstrip(".").lower()
        if candidate:
            addresses.add(candidate)
    return addresses


def _top_level_sites(content: str) -> list[tuple[set[str], TextRange]]:
    sites: list[tuple[set[str], TextRange]] = []
    cursor = 0
    while cursor < len(content):
        block = _next_caddy_block(content, cursor)
        if block is None:
            break
        addresses = _site_header_addresses(content[cursor:block.start])
        if addresses:
            sites.append((addresses, TextRange(cursor, block.end)))
        cursor = block.end
    return sites


def _managed_site_addresses(block: str) -> set[str]:
    claimed: set[str] = set()
    for addresses, _ in _top_level_sites(block):
        claimed |= addresses
    return claimed


def _unowned_site_claiming(
    existing: str,
    claimed: set[str],
    owned: tuple[Optional[TextRange], ...],
) -> Optional[TextRange]:
    """Find a site block, outside every managed range, that already claims one of
    the hostnames a managed block is about to define. Appending a second
    definition for the same hostname makes Caddy reject the whole file with
    'ambiguous site definition', so this has to be detected before we write."""
    if not claimed:
        return None
    matches = [
        span
        for addresses, span in _top_level_sites(existing)
        if addresses & claimed
        and not any(
            range_ is not None and span.start < range_.end and range_.start < span.end
            for range_ in owned
        )
    ]
    if len(matches) > 1:
        raise ManagedConfigError(
            "Caddyfile defines the same hostname in more than one site block; "
            "resolve the duplicate definition before updating."
        )
    return matches[0] if matches else None


def _replace_portal(existing: str, block: str) -> str:
    owned, app_owned = _owned_ranges(existing)
    if owned is not None:
        return f"{existing[:owned.start]}{block}{existing[owned.end:]}"
    domain = recover_owned_domain(block)
    if domain and _has_operator_owned_portal_block(existing, domain):
        return existing
    if not existing:
        return block
    conflict = _unowned_site_claiming(
        existing, _managed_site_addresses(block), (owned, app_owned)
    )
    if conflict is not None:
        # An operator-customised Portal vhost is common: hand-written routes for
        # voice, webhooks, static assets, or CSP live alongside the Portal proxy.
        # Replacing it would silently destroy that work, and appending beside it
        # breaks Caddy outright, so adopt it in place and say so.
        if not _has_portal_proxy(existing, conflict):
            raise ManagedConfigError(
                "The Portal hostname is already served by a site block that does not "
                "proxy the Portal on 127.0.0.1:4001. Point that site at the Portal, "
                "or remove it, then retry."
            )
        print(
            "Existing operator-managed Portal site kept as-is; BridgesLLM will not "
            "rewrite Portal routing on this host.",
            file=sys.stderr,
        )
        return existing
    separator = "" if existing.endswith("\n\n") else "\n" if existing.endswith("\n") else "\n\n"
    return f"{existing}{separator}{block}"


def _replace_app(existing: str, block: str) -> str:
    portal_owned, owned = _owned_ranges(existing)
    if owned is not None:
        return f"{existing[:owned.start]}{block}{existing[owned.end:]}"
    if not existing:
        return block
    conflict = _unowned_site_claiming(
        existing, _managed_site_addresses(block), (portal_owned, owned)
    )
    if conflict is not None:
        raise ManagedConfigError(
            "The isolated app-content hostname is already defined by another site "
            "block. Choose a different --app-content-domain, or remove that site, "
            "then retry."
        )
    separator = "" if existing.endswith("\n") else "\n"
    return f"{existing}{separator}{block}"


def _normalize_hostname(value: str, *, strip_www: bool) -> str:
    candidate = value.strip().rstrip(".").lower()
    if strip_www and candidate.startswith("www."):
        candidate = candidate[4:]
    if not candidate or len(candidate) > 253 or "." not in candidate:
        raise ManagedConfigError("Portal domain is not a canonical hostname.")
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        pass
    else:
        raise ManagedConfigError("Portal domain must not be an IP address.")
    labels = candidate.split(".")
    label_pattern = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
    if any(label_pattern.fullmatch(label) is None for label in labels):
        raise ManagedConfigError("Portal domain contains an invalid DNS label.")
    return candidate


def normalize_domain(value: str) -> str:
    return _normalize_hostname(value, strip_www=True)


def _normalize_app_domain(value: str) -> str:
    return _normalize_hostname(value, strip_www=False)


def _normalize_public_ip(value: str) -> str:
    try:
        parsed = ipaddress.IPv4Address(value.strip())
    except ipaddress.AddressValueError as error:
        raise ManagedConfigError("Public address is not a valid IPv4 address.") from error
    return str(parsed)


def render_portal_block(domain: str, public_ip: str) -> str:
    normalized_domain = normalize_domain(domain) if domain.strip() else ""
    if normalized_domain:
        route = f"""{normalized_domain}, www.{normalized_domain} {{
  reverse_proxy 127.0.0.1:4001 {{
    flush_interval -1
  }}
}}"""
    else:
        normalized_ip = _normalize_public_ip(public_ip)
        if normalized_ip != "0.0.0.0":
            route = f"""# No TLS identity exists yet. Never proxy Portal setup or credentials over
# public HTTP; the installer prints an explicit SSH loopback tunnel instead.
http://{normalized_ip} {{
  respond "BridgesLLM Portal requires HTTPS. Use the installer SSH tunnel to finish setup." 403
}}"""
        else:
            route = """# No TLS identity exists yet. Setup remains loopback-only.
:80 {
  respond "BridgesLLM Portal requires HTTPS. Use the installer SSH tunnel to finish setup." 403
}"""
    return f"""{PORTAL_BEGIN}
# Managed by BridgesLLM Portal. Changes inside this block may be replaced.
{route}
{PORTAL_END}
"""


def render_app_block(domain: str) -> str:
    normalized_domain = _normalize_app_domain(domain)
    return f"""{APP_BEGIN}
# Active user apps are isolated from Portal cookies and authenticated routes.
{normalized_domain} {{
  @bridgesllm_app_content path /share /share/* /hosted /hosted/*
  handle @bridgesllm_app_content {{
    reverse_proxy 127.0.0.1:4001 {{
      flush_interval -1
    }}
  }}
  respond "Not found" 404
}}
{APP_END}
"""


def recover_owned_domain(content: str) -> str:
    owned, _ = _owned_ranges(content)
    if owned is None:
        return ""
    owned_content = content[owned.start:owned.end]
    recovered: set[str] = set()
    address_pattern = re.compile(
        r"^([A-Za-z0-9.-]+)(?:\s*,\s*([A-Za-z0-9.-]+))?\s*\{$"
    )
    for line in _text_lines(owned_content):
        match = address_pattern.fullmatch(line.text.strip())
        if match is None:
            continue
        block = _next_caddy_block(owned_content, line.start)
        if block is None or not _has_portal_proxy(owned_content, block):
            continue
        addresses = [item for item in match.groups() if item]
        try:
            bases = {normalize_domain(address) for address in addresses}
        except ManagedConfigError as error:
            raise ManagedConfigError(
                "Portal-owned Caddy block contains an invalid hostname."
            ) from error
        if len(bases) != 1:
            raise ManagedConfigError("Portal-owned Caddy block has ambiguous hostnames.")
        base = next(iter(bases))
        expected = {base, f"www.{base}"}
        if not set(address.lower().rstrip(".") for address in addresses).issubset(
            expected
        ):
            raise ManagedConfigError("Portal-owned Caddy block has ambiguous hostnames.")
        recovered.add(base)
    if len(recovered) > 1:
        raise ManagedConfigError("Portal-owned Caddy block has multiple domains.")
    return next(iter(recovered), "")


def _canonical_portal_block(content: str) -> str:
    normalized = _normalize_managed_block(content, PORTAL_BEGIN, PORTAL_END)
    recovered = recover_owned_domain(normalized)
    if recovered:
        expected = render_portal_block(recovered, "0.0.0.0")
    else:
        ip_match = re.search(r"(?m)^http://(\d{1,3}(?:\.\d{1,3}){3}) \{$", normalized)
        expected = render_portal_block(
            "",
            ip_match.group(1) if ip_match is not None else "0.0.0.0",
        )
    if normalized != expected:
        raise ManagedConfigError("Refusing a non-canonical Portal Caddy block.")
    return normalized


def _canonical_app_block(content: str) -> str:
    normalized = _normalize_managed_block(content, APP_BEGIN, APP_END)
    match = re.search(r"(?m)^([A-Za-z0-9.-]+) \{$", normalized)
    if match is None:
        raise ManagedConfigError("App-content Caddy block has no canonical hostname.")
    expected = render_app_block(match.group(1))
    if normalized != expected:
        raise ManagedConfigError("Refusing a non-canonical app-content Caddy block.")
    return normalized


def build_managed_content(existing: str, portal_block: str, app_block: str) -> str:
    return _replace_app(
        _replace_portal(existing, _canonical_portal_block(portal_block)),
        _canonical_app_block(app_block),
    )


def _read_existing(path: str) -> ExistingFile:
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return ExistingFile(False, "", None, None)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_nlink != 1
    ):
        raise ManagedConfigError("Caddyfile must be one regular, singly linked file.")
    if metadata.st_size > MAX_CADDYFILE_BYTES:
        raise ManagedConfigError("Caddyfile is unexpectedly large.")
    try:
        content = Path(path).read_bytes().decode("utf-8", errors="strict")
    except (OSError, UnicodeError) as error:
        raise ManagedConfigError("Caddyfile could not be read safely.") from error
    if any(ord(character) < 32 and character not in "\t\n\r" for character in content) \
        or "\x7f" in content:
        raise ManagedConfigError("Caddyfile contains invalid control bytes.")
    try:
        xattrs = tuple(
            (name, os.getxattr(path, name, follow_symlinks=False))
            for name in sorted(os.listxattr(path, follow_symlinks=False))
        )
    except OSError as error:
        raise ManagedConfigError("Caddyfile metadata could not be read safely.") from error
    return ExistingFile(
        True,
        content,
        FileMetadata(
            stat.S_IMODE(metadata.st_mode),
            metadata.st_uid,
            metadata.st_gid,
            metadata.st_atime_ns,
            metadata.st_mtime_ns,
            xattrs,
        ),
        FileIdentity(
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_size,
            metadata.st_mtime_ns,
        ),
    )


def _write_sibling(
    path: str,
    content: str,
    metadata: Optional[FileMetadata],
    *,
    restore_times: bool = False,
) -> str:
    parent = os.path.dirname(path) or "."
    try:
        parent_metadata = os.lstat(parent)
    except FileNotFoundError as error:
        raise ManagedConfigError("Caddyfile parent directory does not exist.") from error
    if not stat.S_ISDIR(parent_metadata.st_mode) or stat.S_ISLNK(parent_metadata.st_mode):
        raise ManagedConfigError("Caddyfile parent must be a real directory.")
    descriptor, candidate = tempfile.mkstemp(
        prefix=f".{os.path.basename(path)}.bridgesllm-",
        suffix=".tmp",
        dir=parent,
    )
    try:
        mode = metadata.mode if metadata is not None else 0o644
        if metadata is not None:
            os.fchown(descriptor, metadata.uid, metadata.gid)
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(content.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        if metadata is not None:
            for name, value in metadata.xattrs:
                os.setxattr(candidate, name, value, follow_symlinks=False)
            if restore_times:
                os.utime(
                    candidate,
                    ns=(metadata.atime_ns, metadata.mtime_ns),
                    follow_symlinks=False,
                )
        return candidate
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise


def _fsync_parent(path: str) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(os.path.dirname(path) or ".", flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _restore(path: str, original: ExistingFile) -> None:
    if not original.exists:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        _fsync_parent(path)
        return
    rollback = _write_sibling(
        path,
        original.content,
        original.metadata,
        restore_times=True,
    )
    try:
        os.replace(rollback, path)
        _fsync_parent(path)
    except Exception:
        try:
            os.unlink(rollback)
        except FileNotFoundError:
            pass
        raise


def _target_matches_original(path: str, original: ExistingFile) -> bool:
    try:
        current = _read_existing(path)
    except ManagedConfigError:
        return False
    if current.exists != original.exists:
        return False
    if not original.exists:
        return True
    assert current.metadata is not None
    assert original.metadata is not None
    return (
        current.content == original.content
        and _metadata_contract_matches(current.metadata, original.metadata)
        and current.metadata.mtime_ns == original.metadata.mtime_ns
        and current.identity == original.identity
    )


def _metadata_contract_matches(current: FileMetadata, expected: FileMetadata) -> bool:
    return (
        current.mode == expected.mode
        and current.uid == expected.uid
        and current.gid == expected.gid
        and current.xattrs == expected.xattrs
    )


def _snapshot_equivalent(current: ExistingFile, expected: ExistingFile) -> bool:
    if current.exists != expected.exists:
        return False
    if not current.exists:
        return True
    assert current.metadata is not None
    assert expected.metadata is not None
    return (
        current.content == expected.content
        and _metadata_contract_matches(current.metadata, expected.metadata)
        and current.metadata.mtime_ns == expected.metadata.mtime_ns
    )


def _persist_external_snapshot(path: str, snapshot: ExistingFile) -> None:
    if not snapshot.exists or snapshot.metadata is None:
        raise ManagedConfigError("Cannot persist an absent Caddy transaction snapshot.")
    existing = _read_existing(path)
    if existing.exists:
        if _snapshot_equivalent(existing, snapshot):
            return
        raise ManagedConfigError(
            "Caddy transaction snapshot path already contains different bytes."
        )
    candidate = _write_sibling(
        path,
        snapshot.content,
        snapshot.metadata,
        restore_times=True,
    )
    try:
        os.replace(candidate, path)
        _fsync_parent(path)
    except Exception as error:
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise ManagedConfigError(
            "Could not durably preserve the Caddy transaction candidate."
        ) from error
    persisted = _read_existing(path)
    if not _snapshot_equivalent(persisted, snapshot):
        raise ManagedConfigError(
            "The persisted Caddy transaction candidate failed verification."
        )


def restore_managed_config_snapshot(
    caddy_path: str,
    snapshot_path: str,
    expected_current_path: str,
    runner: Optional[CommandRunner] = None,
) -> bool:
    """Restore an exact pre-transaction Caddy snapshot with CAS and rollback.

    ``expected_current_path`` is a root-owned copy captured immediately after
    the transaction's managed-block update.  Refusing any third state preserves
    an operator's concurrent edit instead of overwriting it during Portal
    rollback.
    """

    command_runner = runner or CommandRunner()
    snapshot = _read_existing(snapshot_path)
    expected_current = _read_existing(expected_current_path)
    if not snapshot.exists or not expected_current.exists:
        raise ManagedConfigError(
            "Caddy recovery requires both original and transaction snapshots."
        )
    current = _read_existing(caddy_path)
    if _snapshot_equivalent(current, snapshot):
        return False
    if not _snapshot_equivalent(current, expected_current):
        raise ManagedConfigError(
            "Caddyfile changed after the Portal update; the operator's newer configuration was left untouched."
        )

    candidate = _write_sibling(
        caddy_path,
        snapshot.content,
        snapshot.metadata,
        restore_times=True,
    )
    candidate_snapshot = _read_existing(candidate)
    try:
        command_runner.validate(candidate)
    except Exception as error:
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise ManagedConfigError(
            "The preserved pre-update Caddy configuration no longer validates."
        ) from error
    if not _target_matches_original(candidate, candidate_snapshot):
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise ManagedConfigError(
            "Caddy validator changed the preserved recovery candidate."
        )
    if not _snapshot_equivalent(_read_existing(caddy_path), expected_current):
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise ManagedConfigError(
            "Caddyfile changed during recovery validation; the newer configuration was left untouched."
        )

    os.replace(candidate, caddy_path)
    _fsync_parent(caddy_path)
    installed_snapshot = _read_existing(caddy_path)
    try:
        command_runner.activate()
    except Exception as activation_error:
        if not _target_matches_original(caddy_path, installed_snapshot):
            raise ManagedConfigError(
                "Caddy recovery activation failed after another actor changed the file; the newer configuration was left untouched."
            ) from activation_error
        rollback = _write_sibling(
            caddy_path,
            expected_current.content,
            expected_current.metadata,
            restore_times=True,
        )
        try:
            os.replace(rollback, caddy_path)
            _fsync_parent(caddy_path)
        except Exception as rollback_error:
            try:
                os.unlink(rollback)
            except FileNotFoundError:
                pass
            raise ManagedConfigError(
                "Caddy recovery activation failed and the transaction configuration could not be restored."
            ) from rollback_error
        try:
            command_runner.activate()
        except Exception as reactivation_error:
            raise ManagedConfigError(
                "Caddy recovery activation failed; transaction bytes were restored, but Caddy could not be reactivated."
            ) from reactivation_error
        raise ManagedConfigError(
            "Caddy recovery activation failed; the transaction configuration was restored and reactivated."
        ) from activation_error
    return True


def apply_managed_config(
    caddy_path: str,
    portal_block: str,
    app_block: str,
    runner: Optional[CommandRunner] = None,
    installed_snapshot_path: Optional[str] = None,
) -> bool:
    command_runner = runner or CommandRunner()
    original = _read_existing(caddy_path)
    updated = build_managed_content(
        original.content,
        portal_block,
        app_block,
    )
    if updated == original.content:
        if installed_snapshot_path is not None:
            _persist_external_snapshot(installed_snapshot_path, original)
        return False

    candidate = _write_sibling(caddy_path, updated, original.metadata)
    candidate_snapshot = _read_existing(candidate)
    if (
        original.metadata is not None
        and (
            candidate_snapshot.metadata is None
            or not _metadata_contract_matches(
                candidate_snapshot.metadata,
                original.metadata,
            )
        )
    ):
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise ManagedConfigError(
            "Caddy candidate could not preserve the existing file metadata."
        )
    try:
        command_runner.validate(candidate)
    except Exception as error:
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise ManagedConfigError(
            "Caddy validation failed; the existing configuration was unchanged."
        ) from error
    if not _target_matches_original(candidate, candidate_snapshot):
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise ManagedConfigError(
            "Caddy validator changed the candidate; refusing to install it."
        )
    if installed_snapshot_path is not None:
        _persist_external_snapshot(installed_snapshot_path, candidate_snapshot)

    if not _target_matches_original(caddy_path, original):
        try:
            os.unlink(candidate)
        except FileNotFoundError:
            pass
        raise ManagedConfigError(
            "Caddyfile changed during validation; refusing to overwrite the newer configuration."
        )

    installed = False
    try:
        os.replace(candidate, caddy_path)
        installed = True
        _fsync_parent(caddy_path)
    except Exception as error:
        if installed:
            if not _target_matches_original(caddy_path, candidate_snapshot):
                raise ManagedConfigError(
                    "Caddyfile changed concurrently after candidate installation; the newer configuration was left untouched."
                ) from error
            try:
                _restore(caddy_path, original)
            except Exception as rollback_error:
                raise ManagedConfigError(
                    "Caddy candidate was installed but durable rollback failed."
                ) from rollback_error
        else:
            try:
                os.unlink(candidate)
            except FileNotFoundError:
                pass
        raise ManagedConfigError(
            "Could not atomically install the Caddy candidate."
        ) from error

    try:
        command_runner.activate()
    except Exception as activation_error:
        if not _target_matches_original(caddy_path, candidate_snapshot):
            raise ManagedConfigError(
                "Caddy activation failed after another actor changed the Caddyfile; the newer configuration was left untouched."
            ) from activation_error
        restored = False
        try:
            _restore(caddy_path, original)
            restored = True
        except Exception:
            restored = False
        if restored:
            try:
                command_runner.activate()
            except Exception as recovery_error:
                raise ManagedConfigError(
                    "Caddy activation failed; the previous configuration bytes and metadata were restored, but Caddy could not be reactivated."
                ) from recovery_error
            raise ManagedConfigError(
                "Caddy activation failed; the previous configuration bytes and metadata were restored and reactivated."
            ) from activation_error
        raise ManagedConfigError(
            "Caddy activation failed and automatic rollback could not be completed."
        ) from activation_error
    return True


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    recover = subparsers.add_parser("recover-domain")
    recover.add_argument("--caddy-path", required=True)

    normalize = subparsers.add_parser("normalize-domain")
    normalize.add_argument("--value", required=True)

    apply_parser = subparsers.add_parser("apply")
    apply_parser.add_argument("--caddy-path", required=True)
    apply_parser.add_argument("--domain", default="")
    apply_parser.add_argument("--public-ip", required=True)
    apply_parser.add_argument("--app-domain", required=True)
    apply_parser.add_argument("--installed-snapshot-path")
    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("--caddy-path", required=True)
    restore_parser.add_argument("--snapshot-path", required=True)
    restore_parser.add_argument("--expected-current-path", required=True)
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if args.command == "recover-domain":
            existing = _read_existing(args.caddy_path)
            print(recover_owned_domain(existing.content))
            return 0
        if args.command == "normalize-domain":
            print(normalize_domain(args.value))
            return 0
        if args.command == "restore":
            changed = restore_managed_config_snapshot(
                args.caddy_path,
                args.snapshot_path,
                args.expected_current_path,
            )
            print("changed" if changed else "unchanged")
            return 0
        changed = apply_managed_config(
            args.caddy_path,
            render_portal_block(args.domain, args.public_ip),
            render_app_block(args.app_domain),
            installed_snapshot_path=args.installed_snapshot_path,
        )
        print("changed" if changed else "unchanged")
        return 0
    except ManagedConfigError as error:
        print(f"BridgesLLM Caddy convergence failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
