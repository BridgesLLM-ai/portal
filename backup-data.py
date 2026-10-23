#!/usr/bin/env python3
"""Portal data backups: database/settings + projects/files, not a VPS image.

create TYPE           Used by the existing UI and systemd schedules.
verify ARCHIVE        Read and verify an archive without changing installed data.
restore ARCHIVE --confirm
                      Offline data restore into an existing Portal installation.
                      The previous database and directories are retained.
policy show|set       Read or replace the backup retention/space settings (JSON on
                      stdin for set). Saving settings never deletes or runs anything.
cleanup preview       List exactly which backups the keep limits would delete.
cleanup run --plan TOKEN
                      Delete exactly the previewed backups, or refuse if anything
                      changed since the preview.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import hmac
import io
import json
import os
import pwd
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
from urllib.parse import parse_qsl, unquote, urlsplit

SCHEMA = "bridgesllm.portal-data.v1"
TYPES = ("daily", "weekly", "monthly", "comprehensive")
ROOT = Path(os.environ.get("PORTAL_ROOT", "/opt/bridgesllm/portal"))
STATE = Path(os.environ.get("BACKUP_STATE_DIR", ROOT / "backend/.data/backups"))
ENV_FILE = ROOT / "backend/.env.production"
TRUST = Path("/var/lib/bridgesllm/backup-trust")
CRYPTO_KEYS = ("JWT_SECRET", "JWT_REFRESH_SECRET", "PORTAL_ENCRYPTION_KEY")
PERSONALITY_FILES = ("AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "TOOLS.md")
UNITS = ("bridgesllm-product.service", "openclaw-gateway.service")
OPERATION_LOCK = Path("/run/lock/bridgesllm-portal-installer.lock")
MAINTENANCE_MARKERS = (Path("/var/lib/bridgesllm-restore/active-restore.json"),
                       Path("/var/lib/bridgesllm-installer/active-update.json"),
                       Path("/var/lib/bridgesllm-installer/uninstall/active-uninstall.json"))


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def private(path, directory=False, create=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path or any(ord(c) < 32 for c in str(path)):
        raise RuntimeError("Backup path must be canonical and cannot use symbolic links")
    if create:
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
        raise RuntimeError("Backup path must be root-owned and not writable by other users")
    if directory != stat.S_ISDIR(info.st_mode):
        raise RuntimeError("Unexpected backup path type")
    if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise RuntimeError("Expected a private regular file")
    for parent in path.parents:
        pi = parent.stat()
        if pi.st_uid != 0 or pi.st_mode & 0o022:
            raise RuntimeError("Backup storage has a writable parent")
    return path


def write_json(path, value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    fd, tmp = tempfile.mkstemp(prefix=".data-", dir=Path(path).parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        directory = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def environment():
    private(ENV_FILE)
    result = {}
    for line in ENV_FILE.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not re.fullmatch(r"[A-Z_][A-Z_0-9]*", key) or key in result:
            raise RuntimeError("Portal environment has an unsupported assignment")
        if value[:1] in ("'", '"') and value[-1:] == value[:1]:
            value = value[1:-1]
        result[key] = value
    return result


def data_roots(env):
    install = Path(env.get("INSTALL_ROOT", "/opt/bridgesllm"))
    data = Path(env.get("PORTAL_DATA_ROOT", ROOT))
    return {
        "projects": Path(env.get("PORTAL_PROJECTS_ROOT", data / "projects")),
        "files": Path(env.get("PORTAL_FILES_ROOT", "/var/portal-files")),
        "uploads": Path(env.get("UPLOAD_DIR", install / "uploads")),
        "app-sources": Path(env.get("PORTAL_APPS_ROOT", data / "apps")),
        "hosted-apps": Path(env.get("APPS_ROOT", install / "apps")),
        "assets": Path(env.get("PORTAL_ASSETS_ROOT", install / "assets")),
        "portal-state": data / ".data",
        "desktop-state": Path("/var/lib/bridgesllm/desktop-project-state"),
    }


# Keep the client security floor aligned with backup-full.sh. Older server
# patches remain backup-able so their upgrade can first obtain a recovery copy.
PG_CLIENT_FLOORS = {14: 23, 15: 18, 16: 14, 17: 10, 18: 4}
PG_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}


def postgresql_tools(major=None):
    for version in ([major] if major is not None else sorted(PG_CLIENT_FLOORS, reverse=True)):
        if version not in PG_CLIENT_FLOORS:
            break
        paths, versions = {}, []
        try:
            for name in ("psql", "pg_dump", "pg_restore"):
                path = private(Path("/usr/lib/postgresql") / str(version) / "bin" / name)
                info = path.stat()
                if info.st_gid != 0 or not info.st_mode & 0o100:
                    raise ValueError()
                result = subprocess.run([str(path), "--version"], stdin=subprocess.DEVNULL,
                                        capture_output=True, env=PG_ENV, timeout=10)
                match = re.fullmatch(rf"{name} \(PostgreSQL\) ([0-9]+)\.([0-9]+)(?:[^\n]*)\n?", result.stdout.decode("ascii"))
                if result.returncode or result.stderr or not match:
                    raise ValueError()
                found = tuple(map(int, match.groups()))
                if found[0] != version or found[1] < PG_CLIENT_FLOORS[version]:
                    raise ValueError()
                paths[name] = str(path)
                versions.append(found)
            if len(set(versions)) == 1:
                return paths
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            continue
    raise RuntimeError("Install matching trusted PostgreSQL clients at the supported security floor "
                       "(14.23, 15.18, 16.14, 17.10 or 18.4 or newer patches). No services were stopped.")


class Database:
    """One configured TCP authority for dumps, probes and every restore database.

    No peer/default-socket fallback: a published Docker database and a native
    cluster may coexist. Only the database name changes for restore staging.
    Passwords are delivered to libpq solely through an inherited anonymous fd.
    """
    def __init__(self, env):
        try:
            raw = env.get("DATABASE_URL", "")
            if (not raw or len(raw) > 128000 or "#" in raw
                    or re.search(r"%(?![0-9a-fA-F]{2})", raw)
                    or any(ord(c) < 32 or ord(c) == 127 for c in raw)):
                raise ValueError()
            url = urlsplit(raw)
            self.host = url.hostname
            self.port = str(url.port if url.port is not None else 5432)
            self.name = unquote(url.path[1:], errors="strict")
            self.user = unquote(url.username or "", errors="strict")
            self._password = unquote(url.password or "", errors="strict")
            if (url.scheme not in ("postgres", "postgresql")
                    or self.host not in ("localhost", "127.0.0.1", "::1")
                    or url.netloc.count("@") != 1 or not 1 <= int(self.port) <= 65535
                    or not url.path.startswith("/") or url.path.count("/") != 1
                    or not re.fullmatch(r"[a-zA-Z_][a-zA-Z_0-9-]{0,62}", self.name)
                    or not self.user or any(ord(c) < 32 or ord(c) == 127
                                           for v in (self.user, self._password) for c in v)):
                raise ValueError()
            self.sslmode = "prefer"
            seen = set()
            for key, value in parse_qsl(url.query, keep_blank_values=True, strict_parsing=True):
                if key in seen:
                    raise ValueError()
                seen.add(key)
                if key == "schema" and value == "public":
                    continue  # Prisma namespace, not a libpq connection parameter.
                if key == "sslmode" and value in ("disable", "allow", "prefer", "require", "verify-ca", "verify-full"):
                    self.sslmode = value
                else:
                    raise ValueError()
        except (ValueError, UnicodeError):
            raise RuntimeError("Unsupported DATABASE_URL. Configure one explicit loopback PostgreSQL "
                               "host, port, user and database; only schema=public and sslmode query options "
                               "are supported. No services were stopped.") from None
        self.tools = postgresql_tools()
        version = self.sql("SELECT current_setting('server_version_num')")
        if not re.fullmatch(r"[0-9]{6}", version):
            raise RuntimeError("Could not identify the configured PostgreSQL server version")
        self.tools = postgresql_tools(int(version) // 10000)

    def run(self, tool, args, *, db=None, stdin=None, stdout=subprocess.PIPE):
        name = self.name if db is None else db
        fd = None
        try:
            fd = os.memfd_create("portal-data-pgpass", os.MFD_CLOEXEC)
            os.fchmod(fd, 0o600)
            escape = lambda value: value.replace("\\", "\\\\").replace(":", "\\:")
            # An empty private passfile also prevents ambient ~/.pgpass fallback.
            if self._password:
                payload = (":".join(escape(v) for v in
                           (self.host, self.port, name, self.user, self._password)) + "\n").encode()
                with os.fdopen(os.dup(fd), "wb") as out:
                    out.write(payload)
                    out.flush()
                os.lseek(fd, 0, os.SEEK_SET)
            result = subprocess.run([self.tools[tool], "--no-password", "--host=" + self.host,
                                     "--port=" + self.port, "--username=" + self.user, "--dbname=" + name, *args],
                                    stdin=stdin, stdout=stdout, stderr=subprocess.PIPE, cwd="/",
                                    pass_fds=(fd,), env={**PG_ENV, "PGPASSFILE": f"/proc/self/fd/{fd}",
                                                        "PGSSLMODE": self.sslmode, "PGCONNECT_TIMEOUT": "10"}, timeout=1800)
            if result.returncode:
                raise RuntimeError(tool + " could not use the configured PostgreSQL database. Check its "
                                   "loopback endpoint, authentication and role permissions; no default socket "
                                   "was used. Existing backups and restore checkpoints are retained.")
            return result.stdout
        except (OSError, subprocess.SubprocessError):
            # libpq errors and TimeoutExpired can contain connection information.
            raise RuntimeError("PostgreSQL client or private credential descriptor unavailable; "
                               "check installed clients and the configured database connection") from None
        finally:
            if fd is not None:
                os.close(fd)

    def sql(self, statement, db=None):
        return self.run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-c", statement], db=db).decode().strip()

    def restore_owner(self):
        # Preflight all required authority before staging a DB or stopping writers.
        owner = self.sql("SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=" + literal(self.name), "postgres")
        allowed = self.sql("SELECT rolsuper OR (rolcreatedb AND pg_has_role(" + literal(owner) +
                           ", 'USAGE')) FROM pg_roles WHERE rolname=current_user", "postgres")
        if not owner or allowed != "t":
            raise RuntimeError("Data restore requires the configured PostgreSQL role to own the database "
                               "(or inherit its owner role) and have CREATEDB, or be a superuser. "
                               "No services were stopped; use an authorized database administrator for restore.")
        return owner


def database(env):
    return Database(env)


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


class Refusal(RuntimeError):
    """A user-facing refusal. Whatever raised it changed nothing it had not
    already reported."""
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@contextlib.contextmanager
def locks():
    private(STATE, directory=True, create=True)
    handles = []
    try:
        for name in (OPERATION_LOCK, STATE / "backup.lock"):
            fd = os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            handles.append(fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refusal("BUSY", "Another backup or Portal maintenance operation is running. "
                                      "Try again when it finishes.") from None
        for name in MAINTENANCE_MARKERS:
            if Path(name).exists():
                raise Refusal("MAINTENANCE", "Finish the pending Portal maintenance operation first")
        yield
    finally:
        for fd in reversed(handles):
            os.close(fd)


def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def base_directory(create=True):
    config = Path(os.environ.get("BACKUP_CONFIG_FILE", STATE / "backup-base-path"))
    base = Path(private(config).read_text().strip()) if config.exists() else Path("/root/backups")
    return private(base, directory=True, create=create)


def add_tree(archive, source, name):
    """Do not follow project symlinks or include live sockets/device files."""
    source = Path(source)
    def include(member):
        if member.islnk():
            member.type = tarfile.REGTYPE
            member.size = source.joinpath(*PurePosixPath(member.name).relative_to(name).parts).stat().st_size
            member.linkname = ''
        if not (member.isfile() or member.isdir() or member.issym()):
            return None
        member.mode &= 0o777  # No setuid/setgid artifacts.
        return member
    archive.add(source, arcname=name, recursive=True, filter=include)


def optional_agent_export(archive, scratch):
    included, warnings = [], []
    stage = scratch / "agent-export"
    stage.mkdir(mode=0o700)
    claw = Path("/root/.openclaw")
    roots = list(claw.glob("workspace*"))
    try:
        config = json.loads((claw / "openclaw.json").read_text())
        roots += [Path(row["workspace"]) for row in config.get("agents", {}).get("list", []) if row.get("workspace")]
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    for index, root in enumerate(dict.fromkeys(roots)):
        if not root.is_dir() or root.is_symlink():
            continue
        for name in PERSONALITY_FILES:
            source = root / name
            if not source.is_file() or source.is_symlink():
                continue
            target = stage / "personalities" / (str(index) + "-" + root.name) / name
            try:
                target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                shutil.copy2(source, target, follow_symlinks=False)
                included.append(root.name + "/" + name)
            except OSError:
                target.unlink(missing_ok=True)
                warnings.append("Some personality files were unavailable")
    native = Path(os.environ.get("PORTAL_NATIVE_AGENT_SESSIONS_DIR", claw / "portal-native-agent-sessions"))
    if native.is_dir() and not native.is_symlink():
        try:
            shutil.copytree(native, stage / "portal-conversations", symlinks=True)
            included.append("Portal native conversation history")
        except (OSError, shutil.Error):
            shutil.rmtree(stage / "portal-conversations", ignore_errors=True)
            warnings.append("Native conversation history was unavailable")
    # Stage optional source reads first. Missing harness context cannot leave
    # a half-written tar entry in a valid project backup.
    add_tree(archive, stage, "agent-export")
    return {"included": included, "warnings": sorted(set(warnings)),
            "notIncluded": ["Provider logins", "OpenClaw runtime database", "Provider-internal history"],
            "restore": "Reference export only; import selected context into a configured harness."}


def publish_receipt(archive, kind):
    private(TRUST, directory=True, create=True)
    key_file = TRUST / "archive-hmac.key"
    if not key_file.exists():
        fd = os.open(key_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(os.urandom(32))
    key = private(key_file).read_bytes()
    if len(key) != 32:
        raise RuntimeError("Backup signing key has an invalid length")
    info = archive.stat()
    checksum = digest(archive)
    fields = ["bridgesllm.backup-publication.v1", archive.name, kind, "complete",
              str(info.st_size), str(info.st_mtime_ns), checksum, "0"]
    signature = hmac.new(key, ("\0".join(fields) + "\0").encode(), hashlib.sha256).hexdigest()
    write_json(str(archive) + ".receipt.json", {
        "schema": fields[0], "archive": archive.name, "backupType": kind,
        "completeness": "complete", "archiveSize": info.st_size,
        "archiveMtimeNs": str(info.st_mtime_ns), "manifestHmac": checksum,
        "degradedComponents": [], "signature": signature,
    })


def verify_local_receipt(archive):
    record = json.loads(private(Path(str(archive) + '.receipt.json')).read_text())
    key = private(TRUST / 'archive-hmac.key').read_bytes()
    info = archive.stat()
    if (record.get('schema') != 'bridgesllm.backup-publication.v1'
            or record.get('archive') != archive.name
            or record.get('archiveSize') != info.st_size
            or record.get('archiveMtimeNs') != str(info.st_mtime_ns)
            or record.get('completeness') != 'complete'
            or record.get('degradedComponents') != []
            or record.get('manifestHmac') != digest(archive)):
        raise RuntimeError('Backup receipt does not match the archive')
    fields = [record['schema'], archive.name, record['backupType'], 'complete',
              str(info.st_size), str(info.st_mtime_ns), record['manifestHmac'], '0']
    expected = hmac.new(key, ('\0'.join(fields) + '\0').encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, str(record.get('signature', ''))):
        raise RuntimeError('Backup receipt authentication failed')


# Retention and space policy. This file is the only reader, validator and
# writer: the Portal backend delegates to the policy/cleanup commands, and the
# systemd timers run create() here, so no setting is honored by the UI alone.
POLICY_SCHEMA = "bridgesllm.backup-policy.v1"
KEEP_RANGE = (1, 100)
RESERVE_RANGE = (0, 1000)
GIB = 1024 ** 3
ARCHIVE_NAME = re.compile(r"portal-(daily|weekly|monthly|comprehensive)-[0-9]{8}-[0-9]{6}-data-[0-9a-f]{8}\.tar\.gz")
RECEIPT_KEYS = {"schema", "archive", "backupType", "completeness", "archiveSize", "archiveMtimeNs",
                "manifestHmac", "degradedComponents", "signature"}


def default_policy():
    # Missing settings reproduce the fixed behavior that predates them.
    return {"keep": {"daily": 7, "weekly": 4, "monthly": 3, "comprehensive": 3},
            "autoCleanup": False, "reserveGiB": 5}


def strict_json(raw):
    def pairs(items):
        if len({key for key, _ in items}) != len(items):
            raise ValueError("duplicate key")
        return dict(items)
    def constant(_):
        raise ValueError("non-finite number")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def normalize_policy(value, stored=True):
    def count(raw, low, high, message):
        if type(raw) is not int or not low <= raw <= high:
            raise Refusal("POLICY_INVALID", message)
        return raw
    expected = {"keep", "autoCleanup", "reserveGiB"} | ({"schema"} if stored else set())
    if not isinstance(value, dict) or set(value) != expected or (stored and value["schema"] != POLICY_SCHEMA):
        raise Refusal("POLICY_INVALID", "Backup settings must contain exactly keep, autoCleanup and reserveGiB")
    keep = value["keep"]
    if not isinstance(keep, dict) or set(keep) != set(TYPES):
        raise Refusal("POLICY_INVALID", "Keep limits must cover daily, weekly, monthly and comprehensive backups")
    if type(value["autoCleanup"]) is not bool:
        raise Refusal("POLICY_INVALID", "Automatic cleanup must be on or off")
    return {"keep": {kind: count(keep[kind], *KEEP_RANGE, "Keep limits must be whole numbers from 1 to 100")
                     for kind in TYPES},
            "autoCleanup": value["autoCleanup"],
            "reserveGiB": count(value["reserveGiB"], *RESERVE_RANGE,
                                "Free space to keep must be a whole number of GB from 0 to 1000")}


def load_policy():
    """(policy, source). A present but unreadable file is never guessed at:
    it returns no policy, and callers then delete nothing."""
    path = STATE / "policy.json"
    if not os.path.lexists(path):
        return default_policy(), "default"
    try:
        private(STATE, directory=True)
        data, _ = read_private(path, 4096)
        return normalize_policy(strict_json(data)), "saved"
    except (OSError, ValueError, RuntimeError):
        return None, "invalid"


def save_policy(raw):
    if len(raw) > 4096:
        raise Refusal("POLICY_INVALID", "Backup settings are too large")
    try:
        value = strict_json(raw)
    except ValueError:
        raise Refusal("POLICY_INVALID", "Backup settings must be a JSON object") from None
    policy = normalize_policy(value, stored=False)
    private(STATE, directory=True, create=True)
    write_json(STATE / "policy.json", {"schema": POLICY_SCHEMA, **policy})
    return policy


def read_private(path, limit, mode=None):
    """Read a small root:root single-link regular file without following links."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1
                or (info.st_mode & 0o777 != mode if mode is not None else info.st_mode & 0o022)
                or not 0 < info.st_size <= limit):
            raise OSError("unsafe private file")
        data = os.read(fd, limit + 1)
        if len(data) != info.st_size:
            raise OSError("private file changed while it was read")
        return data, info
    finally:
        os.close(fd)


def storage(path):
    info = os.statvfs(path)
    return {"freeBytes": info.f_bavail * info.f_frsize, "totalBytes": info.f_blocks * info.f_frsize}


def human(size):
    # Same 1024-based units the Backups list shows.
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024


def receipt_key():
    # Held to the backend's contract; without it nothing authenticates, so
    # nothing is eligible for cleanup.
    try:
        info = os.lstat(TRUST)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
                or info.st_mode & 0o077 or os.path.realpath(TRUST) != str(TRUST)):
            return None
        key, _ = read_private(TRUST / "archive-hmac.key", 32, 0o600)
        return key if len(key) == 32 else None
    except OSError:
        return None


def receipt_identity(archive, kind, info, key):
    """The backend's signed-receipt check for a complete archive, without
    re-hashing it. Returns the receipt's (dev, ino) only when it authenticates
    this exact file."""
    if key is None:
        return None
    try:
        data, receipt = read_private(Path(str(archive) + ".receipt.json"), 16 * 1024, 0o600)
        record = json.loads(data)
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or set(record) != RECEIPT_KEYS:
        return None
    size, mtime = record["archiveSize"], record["archiveMtimeNs"]
    manifest, signature = record["manifestHmac"], record["signature"]
    if (record["schema"] != "bridgesllm.backup-publication.v1" or record["archive"] != archive.name
            or record["backupType"] != kind or record["completeness"] != "complete"
            or record["degradedComponents"] != [] or type(size) is not int or size != info.st_size
            or not isinstance(mtime, str) or not re.fullmatch(r"[0-9]{1,32}", mtime)
            or int(mtime) != info.st_mtime_ns
            or not isinstance(manifest, str) or not re.fullmatch(r"[0-9a-f]{64}", manifest)
            or not isinstance(signature, str) or not re.fullmatch(r"[0-9a-f]{64}", signature)):
        return None
    fields = [record["schema"], archive.name, kind, "complete", str(size), mtime, manifest, "0"]
    expected = hmac.new(key, ("\0".join(fields) + "\0").encode(), hashlib.sha256).hexdigest()
    return (receipt.st_dev, receipt.st_ino) if hmac.compare_digest(expected, signature) else None


def repair_pins(connection):
    """Archives a live Project dependency repair may still restore from. Same
    predicate as the backend's delete guard, matched by path or by inode so a
    pinned file is kept even if its size or timestamps no longer agree."""
    try:
        rows = json.loads(connection.sql(
            'SELECT COALESCE(json_agg(json_build_array("backupPath", "backupDevice", "backupInode")), '
            "'[]'::json) FROM \"ProjectDependencyRepairOperation\" WHERE \"status\" = 'PROMOTING'"))
        paths, inodes = set(), set()
        for path, device, inode in rows:
            paths.add(str(path))
            if re.fullmatch(r"[0-9]{1,20}", str(device)) and re.fullmatch(r"[0-9]{1,20}", str(inode)):
                inodes.add((int(device), int(inode)))
        return paths, inodes
    except (RuntimeError, ValueError, TypeError):
        raise Refusal("PINS_UNAVAILABLE", "Project repair pins could not be read from the Portal database, "
                                          "so no backups were deleted.") from None


def inventory(base, pins):
    """Own, authenticated, complete portal-data archives. Legacy, partial,
    degraded, linked or unverifiable files are never candidates."""
    key = receipt_key()
    archives, unverified = [], 0
    for kind in TYPES:
        directory = base / kind
        if not os.path.lexists(directory):
            continue
        private(directory, directory=True)
        for name in sorted(os.listdir(directory)):
            match = ARCHIVE_NAME.fullmatch(name)
            if not match or match.group(1) != kind:
                continue
            path = directory / name
            try:
                info = os.lstat(path)
            except FileNotFoundError:
                continue
            receipt = None
            if (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                    and info.st_nlink == 1 and not info.st_mode & 0o022):
                receipt = receipt_identity(path, kind, info, key)
            if receipt is None:
                unverified += 1
                continue
            archives.append({"path": path, "name": name, "kind": kind, "size": info.st_size,
                             "blocks": info.st_blocks * 512, "mtime": info.st_mtime_ns,
                             "dev": info.st_dev, "ino": info.st_ino, "receipt": receipt,
                             "locked": os.path.lexists(str(path) + ".locked"),
                             "pinned": str(path) in pins[0] or (info.st_dev, info.st_ino) in pins[1]})
    newest = max(archives, key=lambda a: (a["mtime"], a["name"]), default=None)
    for archive in archives:
        # One global recovery point, not one per type: that could exceed a small disk.
        archive["protected"] = ("newest" if archive is newest else "locked" if archive["locked"]
                                else "pinned" if archive["pinned"] else None)
    return archives, unverified


def over_limit(archives, keep, kinds=TYPES):
    plan = []
    for kind in kinds:
        ranked = sorted((a for a in archives if a["kind"] == kind),
                        key=lambda a: (a["mtime"], a["name"]), reverse=True)
        plan += [a for a in ranked[keep[kind]:] if not a["protected"]]
    return sorted(plan, key=lambda a: (a["mtime"], a["name"]))


def protected_counts(archives):
    counts = {"newest": 0, "locked": 0, "pinned": 0}
    for archive in archives:
        if archive["protected"]:
            counts[archive["protected"]] += 1
    return counts


def protected_text(archives):
    counts = protected_counts(archives)
    parts = ["your newest complete backup"] if counts["newest"] else []
    parts += [f"{counts['locked']} locked"] if counts["locked"] else []
    parts += [f"{counts['pinned']} in use by a Project repair"] if counts["pinned"] else []
    return "Kept: " + ", ".join(parts) + "." if parts else "No backups are protected."


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def remove_archive(archive):
    """Delete one inventoried archive and its receipt; refuse on any drift."""
    path, receipt = archive["path"], Path(str(archive["path"]) + ".receipt.json")
    def unchanged():
        info = os.lstat(path)
        return (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and info.st_nlink == 1
                and not info.st_mode & 0o022 and (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
                == (archive["dev"], archive["ino"], archive["size"], archive["mtime"]))
    changed = Refusal("CHANGED", archive["name"] + " changed or was locked, so it was kept.")
    try:
        if not unchanged() or os.path.lexists(str(path) + ".locked"):
            raise changed
        info = os.lstat(receipt)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_dev, info.st_ino) != archive["receipt"]:
            raise changed
        # Receipt first: a crash can leave an unclassified archive, never a stale
        # authenticated receipt that could bind to a later file of the same name.
        os.unlink(receipt)
        fsync_directory(path.parent)
        if not unchanged():
            raise changed
        os.unlink(path)
    except FileNotFoundError:
        raise changed from None
    fsync_directory(path.parent)


def database_bytes(connection):
    value = connection.sql("SELECT pg_database_size(current_database())")
    if not re.fullmatch(r"[0-9]{1,20}", value):
        raise RuntimeError("Could not measure the Portal database for the backup space check")
    return int(value)


def make_room(base, destination, kind, policy, connection):
    """Opt-in pre-clean: free room for the new archive before writing it, or
    refuse having deleted nothing. The newest good backup always survives."""
    archives, _ = inventory(base, repair_pins(connection))
    newest = lambda items: max(items, key=lambda a: (a["mtime"], a["name"]), default=None)
    basis = [a["size"] for a in (newest([a for a in archives if a["kind"] == kind]), newest(archives)) if a]
    if not basis:
        return None  # Nothing to estimate from, and nothing that could be deleted.
    device = os.stat(destination).st_dev
    if os.stat(base).st_dev != device:
        return "Automatic cleanup was skipped because the backup folders are on different disks."
    # Archive estimate: the larger recent archive plus 10%. The database dump is
    # staged beside it, so its live size is added; then the reserve.
    estimate = (max(basis) * 11 + 9) // 10 + database_bytes(connection)
    needed = estimate + policy["reserveGiB"] * GIB
    free = storage(destination)["freeBytes"]
    if free >= needed:
        return None
    plan, reachable = [], free
    for archive in sorted(archives, key=lambda a: (a["mtime"], a["name"])):
        if reachable >= needed:
            break
        if not archive["protected"] and archive["dev"] == device:
            plan.append(archive)
            reachable += archive["blocks"]
    if reachable < needed:
        raise Refusal("SPACE", f"Not enough backup space. This backup needs about {human(needed)} free "
                               f"({human(estimate)} estimated plus {policy['reserveGiB']} GB kept free); "
                               f"{human(free)} is free and deleting every unprotected backup would only reach "
                               f"{human(reachable)}. {protected_text(archives)} Nothing was deleted. Lower the "
                               "free-space setting, unlock old backups, or add storage.")
    for index, archive in enumerate(plan):
        try:
            remove_archive(archive)
        except Exception as error:
            raise Refusal("CLEANUP_STOPPED", f"Automatic cleanup stopped after deleting {index} of {len(plan)} "
                                             f"old backups: {str(error)[:200]} The backup was not started.") from None
    after = storage(destination)["freeBytes"]
    note = f"Deleted {len(plan)} old backup{'s' if len(plan) != 1 else ''} to make room ({human(max(0, after - free))} freed)."
    if after < needed:
        raise Refusal("SPACE_HELD", note + f" Only {human(after)} is free now; an open download may still hold "
                                           "the space. Try again later.")
    return note


def apply_retention(base, kind, policy, connection):
    archives, _ = inventory(base, repair_pins(connection))
    plan = over_limit(archives, policy["keep"], (kind,))
    for archive in plan:
        remove_archive(archive)
    return (f"Removed {len(plan)} {kind} backup{'s' if len(plan) != 1 else ''} over the keep limit."
            if plan else None)


def cleanup_plan(connection):
    policy, source = load_policy()
    if policy is None:
        raise Refusal("POLICY_INVALID", "Backup settings could not be read. Save them again before cleaning up.")
    base = base_directory(create=False)
    archives, unverified = inventory(base, repair_pins(connection))
    plan = over_limit(archives, policy["keep"])
    # The token binds the confirmation to these exact files and settings.
    token = hashlib.sha256(json.dumps({"policy": policy, "delete": [
        [a["name"], a["dev"], a["ino"], a["size"], a["mtime"], list(a["receipt"])] for a in plan]},
        sort_keys=True).encode()).hexdigest()
    return {"policy": policy, "source": source, "base": base, "archives": archives,
            "unverified": unverified, "plan": plan, "token": token}


def cleanup_preview():
    current = cleanup_plan(database(environment()))
    return {"token": current["token"], "policySource": current["source"],
            "archives": [{"name": a["name"], "type": a["kind"], "sizeBytes": a["size"],
                          "created": dt.datetime.fromtimestamp(a["mtime"] / 1e9, dt.timezone.utc)
                          .isoformat(timespec="seconds").replace("+00:00", "Z")} for a in current["plan"]],
            "count": len(current["plan"]), "totalBytes": sum(a["size"] for a in current["plan"]),
            "protected": protected_counts(current["archives"]),
            "kept": len(current["archives"]) - len(current["plan"]),
            "unverified": current["unverified"], "storage": storage(current["base"])}


def cleanup_run(token):
    if not re.fullmatch(r"[0-9a-f]{64}", token or ""):
        raise Refusal("STALE", "Review the cleanup before deleting backups.")
    with locks():
        current = cleanup_plan(database(environment()))
        if not hmac.compare_digest(current["token"], token):
            raise Refusal("STALE", "Backups changed since you reviewed them. Nothing was deleted; "
                                   "review the cleanup again.")
        before = storage(current["base"])["freeBytes"]
        deleted = []
        for archive in current["plan"]:
            try:
                remove_archive(archive)
            except (OSError, Refusal) as error:
                raise Refusal("PARTIAL", f"Deleted {len(deleted)} of {len(current['plan'])} backups, then "
                                         f"stopped: {error if isinstance(error, Refusal) else 'a file could not be removed'}. "
                                         "Review the cleanup again.") from None
            deleted.append(archive)
        after = storage(current["base"])
        # Report what the filesystem actually released; unlinked files that are
        # still open (for example a running download) keep their space.
        expected = sum(a["blocks"] for a in deleted)
        freed = max(0, after["freeBytes"] - before)
        return {"deleted": [a["name"] for a in deleted], "deletedCount": len(deleted),
                "deletedBytes": sum(a["size"] for a in deleted), "freedBytes": freed,
                "heldBytes": max(0, expected - freed), "storage": after}


def policy_report():
    policy, source = load_policy()
    try:
        space = storage(base_directory(create=False))
    except (OSError, RuntimeError):
        space = None
    return {"policy": policy, "source": source, "defaults": default_policy(),
            "limits": {"keep": list(KEEP_RANGE), "reserveGiB": list(RESERVE_RANGE)}, "storage": space}


def manage(action, target, plan):
    if (action, target) == ("policy", "show"):
        return policy_report()
    if (action, target) == ("policy", "set"):
        save_policy(sys.stdin.buffer.read(4097))
        return policy_report()
    if (action, target) == ("cleanup", "preview"):
        return cleanup_preview()
    if (action, target) == ("cleanup", "run"):
        return cleanup_run(plan)
    raise Refusal("USAGE", "Unknown backup management command")


def create(kind):
    with locks():
        base = base_directory()
        destination = private(base / kind, directory=True, create=True)
        requests = private(STATE / "requests", directory=True, create=True)
        pending = list(requests.glob(kind + ".request-*.pending.json"))
        if len(pending) > 1:
            raise RuntimeError("Another backup request is pending")
        claimed = None
        run = {"id": "data-" + uuid.uuid4().hex, "type": kind, "startedAt": now()}
        if pending:
            request = json.loads(private(pending[0]).read_text())
            if request.get("schema") != "bridgesllm.backup-request.v1" or request.get("type") != kind:
                raise RuntimeError("Backup request is invalid")
            claimed = pending[0].with_name(pending[0].name.replace(".pending.", ".claimed."))
            if claimed.exists():
                raise RuntimeError("Backup request was already claimed")
            os.rename(pending[0], claimed)
            run.update(id=request["id"], startedAt=request["requestedAt"])
        run.update(status="running", pid=os.getpid(), phase="database", phaseLabel="Saving Portal settings and database", phaseIndex=1, phaseTotal=3)
        write_json(STATE / "status.json", run)
        partial = None
        notes = []
        try:
            env = environment()
            roots = data_roots(env)
            if not roots["projects"].is_dir():
                raise RuntimeError("The Portal projects directory is missing")
            for root in roots.values():
                if root.exists() and (root.is_symlink() or root.resolve() != root):
                    raise RuntimeError("Portal data roots must be canonical directories")
                if base.is_relative_to(root):
                    raise RuntimeError("Backup storage cannot be inside the data being backed up")
            policy, source = load_policy()
            if policy is None:
                notes.append("Backup settings could not be read, so no old backups were removed.")
            connection = database(env)
            if policy and policy["autoCleanup"]:
                run.update(phase="space", phaseLabel="Making room for the new backup")
                write_json(STATE / "status.json", run)
                try:
                    notes.append(make_room(base, destination, kind, policy, connection))
                except Refusal:
                    raise
                except Exception as error:
                    raise RuntimeError("Automatic cleanup could not check the backup folders safely, so nothing "
                                       "was deleted and the backup was not started: " + str(error)[:300]) from None
                run.update(phase="database", phaseLabel="Saving Portal settings and database")
                write_json(STATE / "status.json", run)
            with tempfile.TemporaryDirectory(prefix=".portal-data-", dir=base) as work:
                work = Path(work)
                dump = work / "database.dump"
                with dump.open("xb") as out:
                    connection.run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--schema=public"], stdout=out)
                manifest = {
                    "schema": SCHEMA, "createdAt": now(), "type": kind,
                    "portalVersion": json.loads((ROOT / "backend/package.json").read_text())["version"],
                    "databaseSha256": digest(dump), "components": {},
                    "consistency": "PostgreSQL snapshot with live file copy. Pause project edits and Desktop app writes for a cross-file checkpoint.",
                    "excluded": ["Portal installation", "OS and services", "Mail", "Containers and model downloads", "Provider logins"],
                }
                secrets = {key: env[key] for key in CRYPTO_KEYS if key in env}
                crypto = work / "portal-keys.json"
                write_json(crypto, secrets)
                filename = "portal-" + kind + "-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S") + "-data-" + uuid.uuid4().hex[:8] + ".tar.gz"
                target = destination / filename
                partial = destination / ("." + filename + ".partial")
                run.update(phase="files", phaseLabel="Saving projects and files", phaseIndex=2)
                write_json(STATE / "status.json", run)
                with tarfile.open(partial, "x:gz", compresslevel=1, dereference=False) as archive:
                    archive.add(dump, arcname="database.dump")
                    archive.add(crypto, arcname="portal-keys.json")
                    for name, root in roots.items():
                        if root.is_dir():
                            manifest["components"][name] = str(root)
                            add_tree(archive, root, "data/" + name)
                    if kind == "comprehensive":
                        manifest["agentExport"] = optional_agent_export(archive, work)
                    payload = json.dumps(manifest).encode()
                    member = tarfile.TarInfo("portal-data.json")
                    member.size, member.mode = len(payload), 0o600
                    archive.addfile(member, io.BytesIO(payload))
                run.update(phase="verify", phaseLabel="Verifying the saved archive", phaseIndex=3)
                write_json(STATE / "status.json", run)
                verify(partial)
                with partial.open("rb") as stream:
                    os.fsync(stream.fileno())
                os.rename(partial, target)
                partial = None
                publish_receipt(target, kind)
            # Keep limits for this type. Only authenticated own archives count or
            # go; locked, repair-pinned, legacy and unverified files stay. A
            # published backup never turns into a failure here.
            if policy:
                try:
                    notes.append(apply_retention(base, kind, policy, connection))
                except Exception as error:
                    notes.append("Old backups were kept: " + str(error)[:200])
            summary = " ".join(note for note in notes if note)
            run.update(status="completed", completedAt=now(), archivePath=str(target), exitCode=0)
            if summary:
                run["cleanupSummary"] = re.sub(r"[^\x20-\x7e]", " ", summary)[:600]
            write_json(STATE / "status.json", run)
            print(json.dumps({"complete": True, "archive": str(target), "scope": "Portal data",
                              "agentExport": manifest.get("agentExport"), "cleanup": summary or None}))
        except Exception as error:
            run.update(status="failed", completedAt=now(), error=str(error)[:900], exitCode=1)
            summary = " ".join(note for note in notes if note)
            if summary:
                run["cleanupSummary"] = re.sub(r"[^\x20-\x7e]", " ", summary)[:600]
            write_json(STATE / "status.json", run)
            raise
        finally:
            if partial:
                partial.unlink(missing_ok=True)
            if claimed:
                claimed.unlink(missing_ok=True)


def verify(archive, extract=None):
    private(archive)
    expanded = 0
    names = set()
    symlinks = set()
    manifest = None
    dump_hash = None
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or member.name in names:
                raise RuntimeError("Archive contains an unsafe or duplicate path")
            names.add(member.name)
            allowed = member.name in ("portal-data.json", "portal-keys.json", "database.dump") or member.name.startswith(("data/", "agent-export/")) or (member.name == "agent-export" and member.isdir())
            if not allowed or not (member.isfile() or member.isdir() or member.issym()):
                raise RuntimeError("Archive contains an unsupported entry")
            # No entry may be written through another archive entry's symlink.
            if any(str(parent) in symlinks for parent in name.parents):
                raise RuntimeError("Archive entry traverses a symbolic link")
            if member.issym():
                symlinks.add(member.name)
            if member.name == "portal-data.json":
                if member.size > 1024 * 1024:
                    raise RuntimeError("Backup manifest is too large")
                manifest = json.load(source.extractfile(member))
            if member.name == "database.dump":
                value = hashlib.sha256()
                stream = source.extractfile(member)
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    value.update(chunk)
                dump_hash = value.hexdigest()
            if extract:
                expanded += member.size
                if member.size > shutil.disk_usage(extract).free - 256 * 1024 * 1024:
                    raise RuntimeError("Insufficient disk space to stage the restore")
                target = Path(extract).joinpath(*name.parts)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if member.isdir():
                    target.mkdir(exist_ok=True, mode=0o700)
                    os.chmod(target, member.mode & 0o777)
                elif member.issym():
                    # Links are preserved as links; extraction never follows them.
                    target.symlink_to(member.linkname)
                else:
                    with target.open("xb") as out:
                        shutil.copyfileobj(source.extractfile(member), out, 1024 * 1024)
                    os.chmod(target, member.mode & 0o777)
    if not manifest or manifest.get("schema") != SCHEMA or manifest.get("databaseSha256") != dump_hash:
        raise RuntimeError("Portal data archive verification failed")
    if not {"portal-keys.json", "database.dump", "data/projects"}.issubset(names):
        raise RuntimeError("Portal data archive is incomplete")
    return manifest


def service(action, unit):
    return subprocess.run(["/usr/bin/systemctl", action] + ([unit] if unit else []), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=90)


def require_desktop_apps_stopped(root):
    """A restored state tree must not race an existing native Desktop writer."""
    if not root.exists():
        return
    for project in root.iterdir():
        # Project deletion quarantines state through this server-private entry.
        if project.name == ".bridgesllm-lifecycle-quarantine":
            continue
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", project.name):
            raise RuntimeError("Desktop state has an invalid project identity")
        result = subprocess.run(["/usr/bin/systemctl", "show", "bridgesllm-project-" + project.name + ".service",
                                 "--property=LoadState,ActiveState,MainPID"], capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError("Could not verify Desktop app state before restore")
        properties = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if properties.get("LoadState") == "not-found":
            continue
        if properties.get("ActiveState") not in ("inactive", "failed") or properties.get("MainPID") != "0":
            raise RuntimeError("Stop all Desktop apps in Projects before restoring Desktop data. No Desktop process was stopped by this restore preflight.")


def restore_desktop_state_ownership(staged):
    """Give staged Desktop app data and logs to the current Desktop account.

    Extraction runs as root, and archived numeric owners are never trusted.
    Each Project's control records (promotion journal, stop marker, retained
    evidence) stay root-owned; only its data/ and logs/ trees belong to the
    current bridgesrd account. Links and special files refuse activation.
    """
    if not staged.is_dir() or staged.is_symlink():
        return
    for directory, dirs, files in os.walk(staged):
        for name in dirs + files:
            info = os.lstat(os.path.join(directory, name))
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise RuntimeError("Desktop state contains a link or special file; restore was not activated")
    projects = [project for project in staged.iterdir() if project.name != ".bridgesllm-lifecycle-quarantine"]
    if any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", project.name) or not project.is_dir() for project in projects):
        raise RuntimeError("Desktop state has an invalid project identity")
    try:
        account = pwd.getpwnam("bridgesrd")
    except KeyError:
        account = None
    for directory, dirs, files in os.walk(staged):
        for name in [directory, *(os.path.join(directory, child) for child in dirs + files)]:
            mode = stat.S_IMODE(os.lstat(name).st_mode)
            os.chown(name, 0, 0, follow_symlinks=False)
            os.chmod(name, mode & ~0o7022)
    for project in projects:
        os.chmod(project, 0o755)
        if account is None:
            continue  # No Desktop account: app trees stay root-only until it exists.
        for tree in ("data", "logs"):
            root = project / tree
            if not root.exists():
                continue
            for directory, dirs, files in os.walk(root):
                os.chown(directory, account.pw_uid, account.pw_gid, follow_symlinks=False)
                os.chmod(directory, 0o700)
                for name in files:
                    path = os.path.join(directory, name)
                    mode = stat.S_IMODE(os.lstat(path).st_mode)
                    os.chown(path, account.pw_uid, account.pw_gid, follow_symlinks=False)
                    os.chmod(path, mode & 0o700)


def restore(archive, confirmed):
    if not confirmed:
        raise RuntimeError("Restore replaces Portal data. Run with --confirm after saving your current work.")
    with locks():
        env = environment()
        connection = database(env)
        db = connection.name
        owner = connection.restore_owner()
        roots = data_roots(env)
        base = base_directory()
        before = private(base / ("before-data-restore-" + uuid.uuid4().hex[:12]), directory=True, create=True)
        checkpoint = before / "restore.json"
        with tempfile.TemporaryDirectory(prefix=".restore-data-", dir=base) as work:
            work = Path(work)
            manifest = verify(archive, work)
            if manifest.get("portalVersion") != json.loads((ROOT / "backend/package.json").read_text())["version"]:
                raise RuntimeError("Install the backup's Portal version before restoring its data")
            components = manifest.get("components", {})
            if any(key not in roots or str(roots[key]) != value for key, value in components.items()):
                raise RuntimeError("This archive uses a different data layout; extract projects for a selective import")
            for name in components:
                target = roots[name]
                if target.resolve() != target or target.is_symlink():
                    raise RuntimeError("Restore data root cannot be a symbolic link")
                if target.parent.stat().st_dev != work.stat().st_dev:
                    raise RuntimeError("Restore staging and Portal data must be on the same filesystem")
            if "desktop-state" in components:
                require_desktop_apps_stopped(roots["desktop-state"])
                restore_desktop_state_ownership(work / "data" / "desktop-state")
            keys = json.loads((work / "portal-keys.json").read_text())
            if any(key not in CRYPTO_KEYS or not isinstance(value, str) or "\n" in value or "\r" in value for key, value in keys.items()):
                raise RuntimeError("Portal key record is invalid")
            candidate = "portal_restore_" + uuid.uuid4().hex[:16]
            previous = "portal_before_" + uuid.uuid4().hex[:16]
            connection.sql("CREATE DATABASE " + ident(candidate) + " OWNER " + ident(owner), "postgres")
            activated = False
            swap_pending = False
            moved = []
            was_active = [unit for unit in UNITS if service("is-active", unit).returncode == 0]
            state = {"phase": "prepared", "originalDatabase": db, "candidateDatabase": candidate,
                     "previousDatabase": previous, "components": components, "previousFiles": str(before),
                     "activeServices": was_active, "databaseSwap": "not-started"}
            write_json(checkpoint, state)
            fences = []
            try:
                with (work / "database.dump").open("rb") as dump:
                    connection.run("pg_restore", ["--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl", "--role=" + owner], db=candidate, stdin=dump)
                # Files are newly materialized: bind active project identities to
                # their restored inode and invalidate pre-restore execution grants.
                rows = connection.sql("SELECT COALESCE(json_agg(row_to_json(p)), '[]'::json) FROM (SELECT id, \"canonicalRoot\", generation FROM \"ProjectIdentity\" WHERE \"lifecycleStatus\"='ACTIVE') p", candidate)
                for row in json.loads(rows):
                    relative = Path(row["canonicalRoot"]).relative_to(roots["projects"])
                    staged = work / "data/projects" / relative
                    if not staged.is_dir() or staged.is_symlink():
                        raise RuntimeError("A restored project root is missing")
                    info = json.loads(subprocess.check_output(["/usr/bin/node", "-e",
                        "const s=require('fs').lstatSync(process.argv[1],{bigint:true});process.stdout.write(JSON.stringify([s.dev.toString(),s.ino.toString(),s.birthtimeNs.toString()]));",
                        str(staged)], text=True))
                    connection.sql('UPDATE "ProjectIdentity" SET "rootDevice"=' + literal(info[0]) +
                        ', "rootInode"=' + literal(info[1]) + ', "rootBirthtimeNs"=' + literal(info[2]) +
                        ', generation=generation+1 WHERE id=' + literal(row["id"]), candidate)
                shutil.copy2(ENV_FILE, before / "environment.previous")
                private(before / "environment.previous")
                marker = before / "pending"
                marker.write_text("Portal data restore in progress\n")
                for unit in UNITS:
                    directory = Path("/etc/systemd/system") / (unit + ".d")
                    directory.mkdir(mode=0o755, exist_ok=True)
                    fence = directory / "35-portal-data-restore.conf"
                    with fence.open("x") as out:
                        out.write("[Unit]\nConditionPathExists=!" + str(marker) + "\n")
                    fences.append(fence)
                service("daemon-reload", "")
                for unit in was_active:
                    if service("stop", unit).returncode:
                        raise RuntimeError("Could not stop a Portal data writer")
                state["phase"] = "switching"
                write_json(checkpoint, state)
                for name in components:
                    target = roots[name]
                    old = before / name
                    existed = target.exists()
                    if existed:
                        os.rename(target, old)
                    moved.append((name, existed))
                    os.rename(work / "data" / name, target)
                connection.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=" + literal(db) + " AND pid<>pg_backend_pid()", "postgres")
                # A client error cannot tell us whether PostgreSQL committed.
                # Persist intent first; unknown outcomes must stay fenced.
                state.update(phase="swap-pending", databaseSwap="forward-pending")
                write_json(checkpoint, state)
                swap_pending = True
                connection.sql("ALTER DATABASE " + ident(db) + " RENAME TO " + ident(previous) +
                    "; ALTER DATABASE " + ident(candidate) + " RENAME TO " + ident(db), "postgres")
                activated = True
                swap_pending = False
                state["databaseSwap"] = "forward-confirmed"
                lines = ENV_FILE.read_text().splitlines()
                lines = [line for line in lines if line.partition("=")[0] not in keys]
                lines += [key + "=" + json.dumps(value) for key, value in keys.items()]
                fd, temporary = tempfile.mkstemp(dir=ENV_FILE.parent, prefix=".restore-env-")
                with os.fdopen(fd, "w") as out:
                    out.write("\n".join(lines) + "\n")
                os.replace(temporary, ENV_FILE)
                state["phase"] = "complete"
                write_json(checkpoint, state)
            except Exception:
                try:
                    if swap_pending:
                        raise RuntimeError("Database swap outcome is unknown")
                    if activated:
                        state.update(phase="rollback-swap-pending", databaseSwap="reverse-pending")
                        write_json(checkpoint, state)
                        swap_pending = True
                        connection.sql("ALTER DATABASE " + ident(db) + " RENAME TO " + ident(candidate) +
                            "; ALTER DATABASE " + ident(previous) + " RENAME TO " + ident(db), "postgres")
                        swap_pending = False
                        state["databaseSwap"] = "reverse-confirmed"
                    for name, existed in reversed(moved):
                        target = roots[name]
                        if target.exists():
                            os.rename(target, before / ("failed-" + name))
                        if existed:
                            os.rename(before / name, target)
                    if (before / "environment.previous").exists():
                        shutil.copy2(before / "environment.previous", ENV_FILE)
                    state["phase"] = "rolled-back"
                    write_json(checkpoint, state)
                except Exception:
                    state["phase"] = "recovery-needed"
                    write_json(checkpoint, state)
                    raise RuntimeError("Restore needs recovery. Services remain stopped; use checkpoint " + str(checkpoint))
                raise
            finally:
                if state["phase"] in ("complete", "rolled-back"):
                    (before / "pending").unlink(missing_ok=True)
                    for fence in fences:
                        fence.unlink()
                    service("daemon-reload", "")
                    unavailable = []
                    for unit in reversed(was_active):
                        if service("start", unit).returncode or service("is-active", unit).returncode:
                            unavailable.append(unit)
                    if unavailable:
                        state["phase"] = "data-restored-services-unavailable" if activated else "rolled-back-services-unavailable"
                        state["unavailableServices"] = unavailable
                        write_json(checkpoint, state)
                        raise RuntimeError("Data is restored but service startup needs attention. Checkpoint: " + str(checkpoint))
                if not activated and state["phase"] in ("rolled-back", "rolled-back-services-unavailable"):
                    connection.sql("DROP DATABASE IF EXISTS " + ident(candidate), "postgres")
            print(json.dumps({"restored": True, "previousData": str(before), "previousDatabase": previous,
                              "agentExport": "Optional harness context remains in the archive for selective import."}))


if __name__ == "__main__":
    os.umask(0o077)
    if os.geteuid() != 0:
        sys.exit("Portal data backup must run as root")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("create", "verify", "restore", "policy", "cleanup"))
    parser.add_argument("target")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--require-receipt", action="store_true")
    parser.add_argument("--plan", default="")
    args = parser.parse_args()
    if args.action in ("policy", "cleanup"):
        # Structured results for the Portal backend: exit 3 is a safe refusal.
        try:
            print(json.dumps(manage(args.action, args.target, args.plan)))
        except Refusal as refusal:
            print(json.dumps({"code": refusal.code, "error": str(refusal)}))
            sys.exit(3)
        except Exception as error:
            print("Portal data backup: " + str(error)[:300], file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    try:
        if args.action == "create":
            if args.target not in TYPES:
                raise RuntimeError("Unknown backup schedule")
            create(args.target)
        elif args.action == "verify":
            if args.require_receipt:
                verify_local_receipt(private(Path(args.target)))
            print(json.dumps({"verified": True, "manifest": verify(Path(args.target))}))
        else:
            restore(private(Path(args.target)), args.confirm)
    except Exception as error:
        print("Portal data backup: " + str(error), file=sys.stderr)
        sys.exit(1)
