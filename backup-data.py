#!/usr/bin/env python3
"""Portal data backups: database/settings + projects/files, not a VPS image.

create TYPE           Used by the existing UI and systemd schedules.
verify ARCHIVE        Read and verify an archive without changing installed data.
restore ARCHIVE --confirm
                      Offline data restore into an existing Portal installation.
                      The previous database and directories are retained.
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
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid
from urllib.parse import unquote, urlparse

SCHEMA = "bridgesllm.portal-data.v1"
TYPES = ("daily", "weekly", "monthly", "comprehensive")
ROOT = Path(os.environ.get("PORTAL_ROOT", "/opt/bridgesllm/portal"))
STATE = Path(os.environ.get("BACKUP_STATE_DIR", ROOT / "backend/.data/backups"))
ENV_FILE = ROOT / "backend/.env.production"
TRUST = Path("/var/lib/bridgesllm/backup-trust")
CRYPTO_KEYS = ("JWT_SECRET", "JWT_REFRESH_SECRET", "PORTAL_ENCRYPTION_KEY")
PERSONALITY_FILES = ("AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "TOOLS.md")
UNITS = ("bridgesllm-product.service", "openclaw-gateway.service")


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
        if not sep or not re.fullmatch(r"[A-Z_][A-Z_0-9]*", key):
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
    }


def database(env):
    url = urlparse(env.get("DATABASE_URL", ""))
    name = unquote(url.path.lstrip("/"))
    if url.hostname not in ("localhost", "127.0.0.1", "::1") or not re.fullmatch(r"[a-zA-Z_][a-zA-Z_0-9-]{0,62}", name):
        raise RuntimeError("Data restore currently supports the installed local PostgreSQL database")
    return name


def peer(tool, args, *, stdin=None, stdout=subprocess.PIPE):
    account = pwd.getpwnam("postgres")
    def drop():
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    # Root opens the archive first; PostgreSQL reads the inherited stdin.
    # Never reopen a root-only path after switching accounts.
    result = subprocess.run(["/usr/bin/" + tool, *args], stdin=stdin, stdout=stdout,
                            stderr=subprocess.PIPE, cwd="/", preexec_fn=drop,
                            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, timeout=1800)
    if result.returncode:
        raise RuntimeError(tool + " failed; the existing backup and restore checkpoint are retained")
    return result.stdout


def sql(db, statement):
    return peer("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-d", db, "-c", statement]).decode().strip()


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


@contextlib.contextmanager
def locks():
    private(STATE, directory=True, create=True)
    handles = []
    try:
        for name in ("/run/lock/bridgesllm-portal-installer.lock", STATE / "backup.lock"):
            fd = os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            handles.append(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in ("/var/lib/bridgesllm-restore/active-restore.json",
                     "/var/lib/bridgesllm-installer/active-update.json",
                     "/var/lib/bridgesllm-installer/uninstall/active-uninstall.json"):
            if Path(name).exists():
                raise RuntimeError("Finish the pending Portal maintenance operation first")
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


def base_directory():
    config = Path(os.environ.get("BACKUP_CONFIG_FILE", STATE / "backup-base-path"))
    base = Path(private(config).read_text().strip()) if config.exists() else Path("/root/backups")
    return private(base, directory=True, create=True)


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
            with tempfile.TemporaryDirectory(prefix=".portal-data-", dir=base) as work:
                work = Path(work)
                dump = work / "database.dump"
                with dump.open("xb") as out:
                    peer("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--schema=public", "-d", database(env)], stdout=out)
                manifest = {
                    "schema": SCHEMA, "createdAt": now(), "type": kind,
                    "portalVersion": json.loads((ROOT / "backend/package.json").read_text())["version"],
                    "databaseSha256": digest(dump), "components": {},
                    "consistency": "PostgreSQL snapshot with live file copy. Pause project edits for a cross-file checkpoint.",
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
                run.update(status="completed", completedAt=now(), archivePath=str(target), exitCode=0)
                write_json(STATE / "status.json", run)
                print(json.dumps({"complete": True, "archive": str(target), "scope": "Portal data", "agentExport": manifest.get("agentExport")}))
            # Retain only this format's own old archives; locked and legacy files stay.
            keep = {"daily": 7, "weekly": 4, "monthly": 3, "comprehensive": 3}[kind]
            old = sorted(destination.glob("portal-" + kind + "-*-data-*.tar.gz"), key=lambda p: p.stat().st_mtime, reverse=True)
            for candidate in old[keep:]:
                if not Path(str(candidate) + ".locked").exists():
                    private(candidate).unlink()
                    Path(str(candidate) + ".receipt.json").unlink(missing_ok=True)
        except Exception as error:
            run.update(status="failed", completedAt=now(), error=str(error)[:900], exitCode=1)
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


def restore(archive, confirmed):
    if not confirmed:
        raise RuntimeError("Restore replaces Portal data. Run with --confirm after saving your current work.")
    with locks():
        env = environment()
        db = database(env)
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
            keys = json.loads((work / "portal-keys.json").read_text())
            if any(key not in CRYPTO_KEYS or not isinstance(value, str) or "\n" in value or "\r" in value for key, value in keys.items()):
                raise RuntimeError("Portal key record is invalid")
            candidate = "portal_restore_" + uuid.uuid4().hex[:16]
            previous = "portal_before_" + uuid.uuid4().hex[:16]
            owner = sql("postgres", "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=" + literal(db))
            peer("createdb", ["--owner=" + owner, candidate])
            activated = False
            moved = []
            was_active = [unit for unit in UNITS if service("is-active", unit).returncode == 0]
            state = {"phase": "prepared", "originalDatabase": db, "candidateDatabase": candidate,
                     "previousDatabase": previous, "components": components, "previousFiles": str(before),
                     "activeServices": was_active}
            write_json(checkpoint, state)
            fences = []
            try:
                with (work / "database.dump").open("rb") as dump:
                    peer("pg_restore", ["--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl", "--role=" + owner, "-d", candidate], stdin=dump)
                # Files are newly materialized: bind active project identities to
                # their restored inode and invalidate pre-restore execution grants.
                rows = sql(candidate, "SELECT COALESCE(json_agg(row_to_json(p)), '[]'::json) FROM (SELECT id, \"canonicalRoot\", generation FROM \"ProjectIdentity\" WHERE \"lifecycleStatus\"='ACTIVE') p")
                for row in json.loads(rows):
                    relative = Path(row["canonicalRoot"]).relative_to(roots["projects"])
                    staged = work / "data/projects" / relative
                    if not staged.is_dir() or staged.is_symlink():
                        raise RuntimeError("A restored project root is missing")
                    info = json.loads(subprocess.check_output(["/usr/bin/node", "-e",
                        "const s=require('fs').lstatSync(process.argv[1],{bigint:true});process.stdout.write(JSON.stringify([s.dev.toString(),s.ino.toString(),s.birthtimeNs.toString()]));",
                        str(staged)], text=True))
                    sql(candidate, 'UPDATE "ProjectIdentity" SET "rootDevice"=' + literal(info[0]) +
                        ', "rootInode"=' + literal(info[1]) + ', "rootBirthtimeNs"=' + literal(info[2]) +
                        ', generation=generation+1 WHERE id=' + literal(row["id"]))
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
                sql("postgres", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=" + literal(db) + " AND pid<>pg_backend_pid()")
                sql("postgres", "ALTER DATABASE " + ident(db) + " RENAME TO " + ident(previous) +
                    "; ALTER DATABASE " + ident(candidate) + " RENAME TO " + ident(db))
                activated = True
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
                    if activated:
                        sql("postgres", "ALTER DATABASE " + ident(db) + " RENAME TO " + ident(candidate) +
                            "; ALTER DATABASE " + ident(previous) + " RENAME TO " + ident(db))
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
                if not activated:
                    peer("dropdb", ["--if-exists", candidate])
            print(json.dumps({"restored": True, "previousData": str(before), "previousDatabase": previous,
                              "agentExport": "Optional harness context remains in the archive for selective import."}))


if __name__ == "__main__":
    os.umask(0o077)
    if os.geteuid() != 0:
        sys.exit("Portal data backup must run as root")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("create", "verify", "restore"))
    parser.add_argument("target")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--require-receipt", action="store_true")
    args = parser.parse_args()
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
