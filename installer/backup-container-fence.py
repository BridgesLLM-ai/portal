#!/usr/bin/env python3
"""Crash-recoverable PostgreSQL fence for a loopback-published Docker database.

The backup runner uses this only after its existing local peer-socket fence has
failed admission.  No database password is accepted or persisted: privileged
operations and the dump run through the PostgreSQL peer socket inside the
immutable container identity recorded in the authority file.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import pathlib
import re
import secrets
import stat
import subprocess
import sys
from typing import Any, NoReturn
from urllib.parse import unquote, urlsplit


SCHEMA = "bridgesllm.backup-container-database-fence.v1"
STATE_SCHEMA = "bridgesllm.backup-container-database-state.v1"
PSQL = "/usr/local/bin/psql"
PG_DUMP = "/usr/local/bin/pg_dump"
SOCKET_DIRECTORY = "/var/run/postgresql"
MAX_COMMAND_OUTPUT = 2 * 1024 * 1024


class FenceError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise FenceError(message)


def safe_regular_executable(raw: str) -> pathlib.Path:
    path = pathlib.Path(raw)
    if not path.is_absolute() or os.path.normpath(str(path)) != str(path):
        fail("Docker command authority is not absolute")
    current = pathlib.Path("/")
    for part in path.parts[1:-1]:
        current /= part
        info = os.lstat(current)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or info.st_gid != 0
            or info.st_mode & 0o022
        ):
            fail("Docker command authority crosses an unsafe directory")
    info = os.lstat(path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or info.st_mode & 0o022
        or not info.st_mode & 0o100
    ):
        fail("Docker command authority is unsafe")
    return path


def command_environment() -> dict[str, str]:
    return {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"}


def run_command(
    executable: pathlib.Path,
    arguments: list[str],
    *,
    input_bytes: bytes | None = None,
    timeout: int = 60,
) -> bytes:
    try:
        result = subprocess.run(
            [str(executable), *arguments],
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
            env=command_environment(),
        )
    except (OSError, subprocess.TimeoutExpired):
        fail("Docker database command could not be executed")
    if (
        result.returncode != 0
        or len(result.stdout) > MAX_COMMAND_OUTPUT
        or len(result.stderr) > MAX_COMMAND_OUTPUT
    ):
        fail(f"Docker database command failed with exit code {result.returncode}")
    return result.stdout


def docker_json(docker: pathlib.Path, arguments: list[str]) -> Any:
    raw = run_command(docker, arguments)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Docker returned malformed inspection data")


def safe_text(value: Any, maximum: int = 1024) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and len(value.encode("utf-8")) <= maximum
        and all(ord(character) >= 32 and ord(character) != 127 for character in value)
    )


def parse_database_url(raw: str) -> tuple[str, int, str, str]:
    try:
        parsed = urlsplit(raw)
        host = unquote(parsed.hostname or "", errors="strict")
        port = parsed.port or 5432
        database = unquote((parsed.path or "").lstrip("/"), errors="strict")
        role = unquote(parsed.username or "", errors="strict")
        address = ipaddress.ip_address(host)
    except (UnicodeDecodeError, ValueError):
        fail("Configured database endpoint is not a valid PostgreSQL URL")
    if (
        parsed.scheme not in {"postgres", "postgresql"}
        or parsed.fragment
        or not address.is_loopback
        or not 1 <= port <= 65535
        or not safe_text(database, 256)
        or not safe_text(role, 256)
    ):
        fail("Container fencing requires a literal loopback PostgreSQL endpoint")
    return str(address), port, database, role


def normalized_mount(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        fail("Docker database mount is malformed")
    record = {
        "type": raw.get("Type"),
        "name": raw.get("Name") or "",
        "source": raw.get("Source"),
        "destination": raw.get("Destination"),
        "driver": raw.get("Driver") or "",
        "mode": raw.get("Mode") or "",
        "rw": raw.get("RW"),
        "propagation": raw.get("Propagation") or "",
    }
    if (
        record["type"] not in {"bind", "volume"}
        or not safe_text(record["source"], 4096)
        or not os.path.isabs(record["source"])
        or not safe_text(record["destination"], 4096)
        or not os.path.isabs(record["destination"])
        or record["rw"] is not True
        or any(not isinstance(record[key], str) for key in ("name", "driver", "mode", "propagation"))
    ):
        fail("Docker database storage is not a writable bind or volume mount")
    return record


def inspect_fingerprint(
    container: Any,
    *,
    host: str,
    host_port: int,
) -> dict[str, Any] | None:
    if not isinstance(container, dict):
        fail("Docker database inspection is malformed")
    identifier = container.get("Id")
    name = str(container.get("Name") or "").lstrip("/")
    image_id = container.get("Image")
    config = container.get("Config") or {}
    host_config = container.get("HostConfig") or {}
    state = container.get("State") or {}
    if (
        not isinstance(config, dict)
        or not isinstance(host_config, dict)
        or not isinstance(state, dict)
        or not isinstance(identifier, str)
        or not re.fullmatch(r"[a-f0-9]{64}", identifier)
        or not safe_text(name, 255)
        or not isinstance(image_id, str)
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id)
        or not safe_text(config.get("Image"), 1024)
    ):
        fail("Docker database identity is malformed")

    matches: list[tuple[int, str]] = []
    bindings = host_config.get("PortBindings") or {}
    if not isinstance(bindings, dict):
        fail("Docker database port bindings are malformed")
    for key, entries in bindings.items():
        match = re.fullmatch(r"([1-9][0-9]{0,4})/tcp", str(key))
        if match is None or not isinstance(entries, list):
            continue
        container_port = int(match.group(1))
        if not 1 <= container_port <= 65535:
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                fail("Docker database port binding is malformed")
            try:
                bound_host = str(ipaddress.ip_address(str(entry.get("HostIp") or "")))
                bound_port = int(str(entry.get("HostPort") or ""))
            except ValueError:
                continue
            if bound_host == host and bound_port == host_port:
                matches.append((container_port, bound_host))
    if not matches:
        return None
    if len(matches) != 1:
        fail("Docker database endpoint maps ambiguously inside a container")
    container_port, bound_host = matches[0]
    if state.get("Running") is not True:
        fail("Docker database container is not running")

    env_values: dict[str, str] = {}
    raw_env = config.get("Env") or []
    if not isinstance(raw_env, list):
        fail("Docker database environment is malformed")
    for item in raw_env:
        if not isinstance(item, str) or "=" not in item:
            fail("Docker database environment is malformed")
        key, value = item.split("=", 1)
        if key in env_values:
            fail("Docker database environment is ambiguous")
        env_values[key] = value
    pgdata = env_values.get("PGDATA", "/var/lib/postgresql/data")
    if not safe_text(pgdata, 4096) or not os.path.isabs(pgdata) or os.path.normpath(pgdata) != pgdata:
        fail("Docker database PGDATA is unsafe")

    candidates: list[dict[str, Any]] = []
    mounts = container.get("Mounts") or []
    if not isinstance(mounts, list):
        fail("Docker database mount inventory is malformed")
    for raw_mount in mounts:
        if not isinstance(raw_mount, dict):
            fail("Docker database mount inventory is malformed")
        raw_destination = raw_mount.get("Destination")
        if (
            not safe_text(raw_destination, 4096)
            or not os.path.isabs(raw_destination)
            or os.path.normpath(raw_destination) != raw_destination
        ):
            fail("Docker database mount destination is unsafe")
        destination = raw_destination.rstrip("/") or "/"
        if pgdata == destination or pgdata.startswith(destination.rstrip("/") + "/"):
            candidates.append(normalized_mount(raw_mount))
    if not candidates:
        fail("Docker database PGDATA is not on persistent writable storage")
    candidates.sort(key=lambda item: len(item["destination"]), reverse=True)
    if len(candidates) > 1 and len(candidates[0]["destination"]) == len(candidates[1]["destination"]):
        fail("Docker database PGDATA mount is ambiguous")

    return {
        "id": identifier,
        "name": name,
        "imageId": image_id,
        "imageReference": config["Image"],
        "pgdata": pgdata,
        "hostAddress": bound_host,
        "hostPort": host_port,
        "containerPort": container_port,
        "dataMount": candidates[0],
    }


def inspect_container(docker: pathlib.Path, identifier: str) -> dict[str, Any]:
    payload = docker_json(docker, ["container", "inspect", identifier])
    if not isinstance(payload, list) or len(payload) != 1:
        fail("Docker database inspection is ambiguous")
    return payload[0]


def docker_exec_arguments(authority: dict[str, Any], executable: str, arguments: list[str], *, interactive: bool) -> list[str]:
    command = ["container", "exec"]
    if interactive:
        command.append("--interactive")
    command.extend([
        "--user", "postgres",
        authority["container"]["id"],
        executable,
        *arguments,
    ])
    return command


def run_container_tool(
    docker: pathlib.Path,
    authority: dict[str, Any],
    executable: str,
    arguments: list[str],
    *,
    input_bytes: bytes | None = None,
    timeout: int = 60,
) -> bytes:
    return run_command(
        docker,
        docker_exec_arguments(authority, executable, arguments, interactive=input_bytes is not None),
        input_bytes=input_bytes,
        timeout=timeout,
    )


def psql_arguments(authority: dict[str, Any], target: str) -> list[str]:
    database = authority["databaseName"] if target == "target" else "postgres"
    if target not in {"target", "control"}:
        fail("Invalid Docker database connection target")
    return [
        f"--host={SOCKET_DIRECTORY}",
        f"--port={authority['container']['containerPort']}",
        "--username=postgres",
        f"--dbname={database}",
        "--no-psqlrc",
        "--set=ON_ERROR_STOP=1",
        "-qAt",
    ]


def query_state(docker: pathlib.Path, authority: dict[str, Any]) -> dict[str, Any]:
    role_literal = sql_literal(authority["portalRoleName"])
    sql = f"""
SET search_path TO pg_catalog;
SELECT json_build_object(
  'schema', '{STATE_SCHEMA}',
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'databaseName', d.datname,
  'databaseOid', d.oid::bigint,
  'databaseOwnerOid', d.datdba::bigint,
  'portalRoleName', owner.rolname,
  'portalRoleOid', owner.oid::bigint,
  'portalRoleCanLogin', owner.rolcanlogin,
  'portalRoleSuperuser', owner.rolsuper,
  'portalRoleCreateDb', owner.rolcreatedb,
  'portalRoleCreateRole', owner.rolcreaterole,
  'portalRoleReplication', owner.rolreplication,
  'portalRoleBypassRls', owner.rolbypassrls,
  'portalRoleInherit', owner.rolinherit,
  'portalRoleConnectionLimit', owner.rolconnlimit,
  'portalRoleValidUntilNull', owner.rolvaliduntil IS NULL,
  'peerRoleName', session_user,
  'peerRoleOid', peer.oid::bigint,
  'peerRoleSuperuser', peer.rolsuper,
  'connectionLimit', d.datconnlimit,
  'allowConnections', d.datallowconn,
  'guardToken', COALESCE(current_setting('bridgesllm.exclusive_guard', true), ''),
  'serverVersionNum', current_setting('server_version_num')::integer,
  'serverPort', current_setting('port')::integer,
  'fsyncEnabled', current_setting('fsync') = 'on',
  'fullPageWritesEnabled', current_setting('full_page_writes') = 'on',
  'targetClients', (SELECT count(*) FROM pg_stat_activity
                    WHERE datid = d.oid AND backend_type = 'client backend'
                      AND pid <> pg_backend_pid()),
  'portalRoleSessions', (SELECT count(*) FROM pg_stat_activity
                         WHERE usesysid = owner.oid AND pid <> pg_backend_pid()),
  'memberLoginRoles', (SELECT count(*) FROM pg_roles role
                       WHERE role.oid <> owner.oid AND role.rolcanlogin
                         AND NOT role.rolsuper
                         AND pg_has_role(role.oid, owner.oid, 'MEMBER')),
  'preparedTransactions', (SELECT count(*) FROM pg_prepared_xacts
                           WHERE database = d.datname OR owner = {role_literal})
)::text
FROM pg_database d
JOIN pg_authid owner ON owner.oid = d.datdba
JOIN pg_roles peer ON peer.rolname = session_user
WHERE d.datname = current_database() AND owner.rolname = {role_literal};
"""
    raw = run_container_tool(
        docker,
        authority,
        PSQL,
        [*psql_arguments(authority, "target"), f"--command={sql}"],
    )
    try:
        lines = raw.decode("utf-8").splitlines()
        if len(lines) != 1:
            fail("Docker database state query returned an unexpected result")
        value = json.loads(lines[0])
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("Docker database state query returned malformed data")
    if not isinstance(value, dict):
        fail("Docker database state query returned malformed data")
    return value


def sql_identifier(value: str) -> str:
    if not safe_text(value, 256):
        fail("Database identifier is unsafe")
    return '"' + value.replace('"', '""') + '"'


def sql_literal(value: str) -> str:
    if not safe_text(value, 1024):
        fail("Database literal is unsafe")
    return "'" + value.replace("'", "''") + "'"


def digest(document: Any) -> str:
    return hashlib.sha256(
        json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def write_authority(path: pathlib.Path, document: dict[str, Any]) -> None:
    parent = path.parent
    parent_info = os.lstat(parent)
    if (
        not path.is_absolute()
        or os.path.normpath(str(path)) != str(path)
        or path.exists()
        or path.is_symlink()
        or not stat.S_ISDIR(parent_info.st_mode)
        or stat.S_ISLNK(parent_info.st_mode)
        or parent_info.st_uid != 0
        or parent_info.st_gid != 0
        or stat.S_IMODE(parent_info.st_mode) != 0o700
    ):
        fail("Container database fence authority boundary is unsafe")
    encoded = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW,
        0o600,
    )
    try:
        if os.write(descriptor, encoded) != len(encoded):
            fail("Container database fence authority write was incomplete")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_descriptor = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | os.O_NOFOLLOW)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def read_authority(path: pathlib.Path, docker: pathlib.Path) -> dict[str, Any]:
    info = os.lstat(path)
    if (
        not path.is_absolute()
        or os.path.normpath(str(path)) != str(path)
        or not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or info.st_nlink != 1
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_size <= 0
        or info.st_size > 128 * 1024
    ):
        fail("Container database fence authority is unsafe")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail("Container database fence authority is malformed")
    required = {
        "schema", "operationId", "guardToken", "container", "containerSha256",
        "databaseName", "portalRoleName", "postgresMajor", "postgresMinor",
        "databaseState", "databaseStateSha256",
    }
    if (
        not isinstance(document, dict)
        or set(document) != required
        or document.get("schema") != SCHEMA
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", str(document.get("operationId", "")))
        or not re.fullmatch(r"[a-f0-9]{64}", str(document.get("guardToken", "")))
        or not isinstance(document.get("container"), dict)
        or document.get("containerSha256") != digest(document["container"])
        or not safe_text(document.get("databaseName"), 256)
        or not safe_text(document.get("portalRoleName"), 256)
        or not isinstance(document.get("postgresMajor"), int)
        or not isinstance(document.get("postgresMinor"), int)
        or not isinstance(document.get("databaseState"), dict)
        or document.get("databaseStateSha256") != digest(document["databaseState"])
    ):
        fail("Container database fence authority contract is invalid")
    current = inspect_container(docker, document["container"]["id"])
    fingerprint = inspect_fingerprint(
        current,
        host=document["container"]["hostAddress"],
        host_port=document["container"]["hostPort"],
    )
    if fingerprint != document["container"]:
        fail("Docker database container identity changed")
    return document


def validate_common_state(authority: dict[str, Any], observed: dict[str, Any]) -> None:
    baseline = authority["databaseState"]
    fixed = {
        "schema": STATE_SCHEMA,
        "systemIdentifier": baseline["systemIdentifier"],
        "databaseName": authority["databaseName"],
        "databaseOid": baseline["databaseOid"],
        "databaseOwnerOid": baseline["portalRoleOid"],
        "portalRoleName": authority["portalRoleName"],
        "portalRoleOid": baseline["portalRoleOid"],
        "portalRoleSuperuser": False,
        "portalRoleCreateDb": False,
        "portalRoleCreateRole": False,
        "portalRoleReplication": False,
        "portalRoleBypassRls": False,
        "portalRoleInherit": True,
        "portalRoleConnectionLimit": -1,
        "portalRoleValidUntilNull": True,
        "peerRoleName": "postgres",
        "peerRoleOid": baseline["peerRoleOid"],
        "peerRoleSuperuser": True,
        "allowConnections": True,
        "serverVersionNum": baseline["serverVersionNum"],
        "serverPort": authority["container"]["containerPort"],
        "fsyncEnabled": True,
        "fullPageWritesEnabled": True,
        "memberLoginRoles": 0,
        "preparedTransactions": 0,
    }
    if any(observed.get(key) != value for key, value in fixed.items()):
        fail("Docker database identity or safety contract changed")


def classify_state(authority: dict[str, Any], observed: dict[str, Any]) -> str:
    validate_common_state(authority, observed)
    baseline = authority["databaseState"]
    released = (
        observed.get("portalRoleCanLogin") is True
        and observed.get("connectionLimit") == baseline["connectionLimit"]
        and observed.get("guardToken") in {"", None}
    )
    held = (
        observed.get("portalRoleCanLogin") is False
        and observed.get("connectionLimit") == 0
        and observed.get("guardToken") == authority["guardToken"]
        and observed.get("targetClients") == 0
        and observed.get("portalRoleSessions") == 0
    )
    if released:
        return "released"
    if held:
        return "held"
    fail("Docker database fence is in an unexpected state")


def discover(args: argparse.Namespace) -> None:
    docker = safe_regular_executable(args.docker)
    try:
        raw_url = os.read(args.database_url_fd, 131073)
    except OSError:
        fail("Configured database authority could not be read")
    if len(raw_url) > 131072:
        fail("Configured database authority is too large")
    try:
        database_url = raw_url.decode("utf-8")
    except UnicodeDecodeError:
        fail("Configured database authority is not UTF-8")
    host, host_port, database, portal_role = parse_database_url(database_url)
    raw_ids = run_command(
        docker,
        ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"],
    )
    try:
        identifiers = raw_ids.decode("ascii").splitlines()
    except UnicodeDecodeError:
        fail("Docker container inventory is malformed")
    if len(identifiers) > 100_000:
        fail("Docker container inventory is unbounded")
    candidates: list[dict[str, Any]] = []
    for identifier in identifiers:
        if not re.fullmatch(r"[a-f0-9]{64}", identifier):
            fail("Docker container inventory contains an invalid identity")
        fingerprint = inspect_fingerprint(
            inspect_container(docker, identifier),
            host=host,
            host_port=host_port,
        )
        if fingerprint is not None:
            candidates.append(fingerprint)
    if len(candidates) != 1:
        fail("Configured loopback PostgreSQL endpoint does not map to exactly one Docker container")
    container = candidates[0]
    initial: dict[str, Any] = {
        "schema": SCHEMA,
        "operationId": args.operation,
        "guardToken": secrets.token_hex(32),
        "container": container,
        "containerSha256": digest(container),
        "databaseName": database,
        "portalRoleName": portal_role,
        "postgresMajor": args.expected_major,
        "postgresMinor": 0,
        "databaseState": {},
        "databaseStateSha256": digest({}),
    }
    versions: dict[str, tuple[int, int]] = {}
    for name, executable in (("psql", PSQL), ("pg_dump", PG_DUMP)):
        raw = run_container_tool(docker, initial, executable, ["--version"])
        try:
            line = raw.decode("ascii").strip()
        except UnicodeDecodeError:
            fail("Docker PostgreSQL client version is malformed")
        match = re.fullmatch(rf"{name} \(PostgreSQL\) ([0-9]+)\.([0-9]+)(?:[ \t][ -~]*)?", line)
        if match is None:
            fail("Docker PostgreSQL client version is malformed")
        versions[name] = (int(match.group(1)), int(match.group(2)))
    if len(set(versions.values())) != 1 or versions["psql"][0] != args.expected_major:
        fail("Docker PostgreSQL client major does not match the admitted server")
    initial["postgresMinor"] = versions["psql"][1]
    observed = query_state(docker, initial)
    if (
        observed.get("portalRoleCanLogin") is not True
        or observed.get("guardToken") not in {"", None}
        or not isinstance(observed.get("connectionLimit"), int)
        or isinstance(observed.get("connectionLimit"), bool)
        or not -1 <= observed["connectionLimit"] <= 2_147_483_647
        or observed.get("serverVersionNum", 0) // 10000 != args.expected_major
    ):
        fail("Docker database is not in the managed released state")
    initial["databaseState"] = observed
    initial["databaseStateSha256"] = digest(observed)
    validate_common_state(initial, observed)
    write_authority(pathlib.Path(args.output), initial)


def run_sql(docker: pathlib.Path, authority: dict[str, Any], target: str, sql: str, *, timeout: int = 60) -> None:
    run_container_tool(
        docker,
        authority,
        PSQL,
        [*psql_arguments(authority, target), f"--command={sql}"],
        timeout=timeout,
    )


def settle_clients(docker: pathlib.Path, authority: dict[str, Any]) -> None:
    baseline = authority["databaseState"]
    database_oid = int(baseline["databaseOid"])
    role_oid = int(baseline["portalRoleOid"])
    token = sql_literal(authority["guardToken"])
    sql = f"""
SET search_path TO pg_catalog;
DO $bridgesllm$
DECLARE deadline timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_database d JOIN pg_roles owner ON owner.oid = d.datdba
    WHERE d.oid = {database_oid} AND NOT owner.rolcanlogin
      AND d.datconnlimit = 0
      AND EXISTS (
        SELECT 1 FROM pg_db_role_setting setting
        CROSS JOIN LATERAL unnest(setting.setconfig) item
        WHERE setting.setdatabase = d.oid AND setting.setrole = 0
          AND item = 'bridgesllm.exclusive_guard=' || {token}
      )
  ) THEN RAISE EXCEPTION 'database fence identity changed'; END IF;
  LOOP
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE (usesysid = {role_oid} OR (datid = {database_oid} AND backend_type = 'client backend'))
      AND pid <> pg_backend_pid();
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE (usesysid = {role_oid} OR (datid = {database_oid} AND backend_type = 'client backend'))
        AND pid <> pg_backend_pid()
    );
    IF clock_timestamp() >= deadline THEN RAISE EXCEPTION 'database clients did not settle'; END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$bridgesllm$;
"""
    run_sql(docker, authority, "control", sql, timeout=45)


def acquire(docker: pathlib.Path, authority: dict[str, Any]) -> None:
    observed = query_state(docker, authority)
    disposition = classify_state(authority, observed)
    if disposition == "released":
        baseline = authority["databaseState"]
        database_identifier = sql_identifier(authority["databaseName"])
        role_identifier = sql_identifier(authority["portalRoleName"])
        system_identifier = sql_literal(str(baseline["systemIdentifier"]))
        token = sql_literal(authority["guardToken"])
        sql = f"""
SET search_path TO pg_catalog;
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '60s';
SET LOCAL synchronous_commit = on;
DO $bridgesllm$
BEGIN
  IF (pg_control_system()).system_identifier::text <> {system_identifier}
     OR NOT EXISTS (
       SELECT 1 FROM pg_database d JOIN pg_roles owner ON owner.oid = d.datdba
       WHERE d.oid = {int(baseline['databaseOid'])}
         AND owner.oid = {int(baseline['portalRoleOid'])}
         AND owner.rolcanlogin AND NOT owner.rolsuper AND d.datallowconn
         AND d.datconnlimit = {int(baseline['connectionLimit'])}
     )
     OR EXISTS (
       SELECT 1 FROM pg_db_role_setting setting
       CROSS JOIN LATERAL unnest(setting.setconfig) item
       WHERE setting.setdatabase = {int(baseline['databaseOid'])}
         AND setting.setrole = 0
         AND item LIKE 'bridgesllm.exclusive_guard=%'
     )
     OR EXISTS (SELECT 1 FROM pg_prepared_xacts
                WHERE database = {sql_literal(authority['databaseName'])}
                   OR owner = {sql_literal(authority['portalRoleName'])})
  THEN RAISE EXCEPTION 'database fence admission changed'; END IF;
END
$bridgesllm$;
ALTER ROLE {role_identifier} NOLOGIN;
ALTER DATABASE {database_identifier} CONNECTION LIMIT 0;
ALTER DATABASE {database_identifier} SET bridgesllm.exclusive_guard TO {token};
COMMIT;
CHECKPOINT;
"""
        run_sql(docker, authority, "control", sql)
    settle_clients(docker, authority)
    if classify_state(authority, query_state(docker, authority)) != "held":
        fail("Docker database fence did not settle")


def release(docker: pathlib.Path, authority: dict[str, Any]) -> None:
    observed = query_state(docker, authority)
    disposition = classify_state(authority, observed)
    if disposition == "released":
        return
    settle_clients(docker, authority)
    baseline = authority["databaseState"]
    database_identifier = sql_identifier(authority["databaseName"])
    role_identifier = sql_identifier(authority["portalRoleName"])
    token = sql_literal(authority["guardToken"])
    sql = f"""
SET search_path TO pg_catalog;
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '60s';
SET LOCAL synchronous_commit = on;
DO $bridgesllm$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_database d JOIN pg_roles owner ON owner.oid = d.datdba
    WHERE d.oid = {int(baseline['databaseOid'])}
      AND owner.oid = {int(baseline['portalRoleOid'])}
      AND NOT owner.rolcanlogin AND d.datconnlimit = 0
      AND EXISTS (
        SELECT 1 FROM pg_db_role_setting setting
        CROSS JOIN LATERAL unnest(setting.setconfig) item
        WHERE setting.setdatabase = d.oid AND setting.setrole = 0
          AND item = 'bridgesllm.exclusive_guard=' || {token}
      )
  ) THEN RAISE EXCEPTION 'database fence changed before release'; END IF;
END
$bridgesllm$;
ALTER DATABASE {database_identifier} RESET bridgesllm.exclusive_guard;
ALTER DATABASE {database_identifier} CONNECTION LIMIT {int(baseline['connectionLimit'])};
ALTER ROLE {role_identifier} LOGIN;
COMMIT;
CHECKPOINT;
"""
    run_sql(docker, authority, "control", sql)
    if classify_state(authority, query_state(docker, authority)) != "released":
        fail("Docker database fence did not restore its original state")


def exec_validated(docker: pathlib.Path, arguments: list[str]) -> NoReturn:
    os.execve(str(docker), [str(docker), *arguments], command_environment())
    raise AssertionError("unreachable")


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--docker", required=True)
    subparsers = parser.add_subparsers(dest="action", required=True)

    discover_parser = subparsers.add_parser("discover")
    discover_parser.add_argument("--database-url-fd", type=int, required=True)
    discover_parser.add_argument("--operation", required=True)
    discover_parser.add_argument("--output", required=True)
    discover_parser.add_argument("--expected-major", type=int, required=True)

    for action in ("probe", "acquire", "assert", "release", "role-sql"):
        child = subparsers.add_parser(action)
        child.add_argument("--authority", required=True)

    psql_parser = subparsers.add_parser("psql")
    psql_parser.add_argument("--authority", required=True)
    psql_parser.add_argument("--target", choices=("target", "control"), default="target")
    psql_parser.add_argument("arguments", nargs=argparse.REMAINDER)

    dump_parser = subparsers.add_parser("pg-dump")
    dump_parser.add_argument("--authority", required=True)
    dump_parser.add_argument("--snapshot", required=True)

    args = parser.parse_args()
    if args.action == "discover":
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", args.operation):
            fail("Container database operation identity is invalid")
        if args.expected_major not in {14, 15, 16, 17, 18}:
            fail("Container database PostgreSQL major is unsupported")
        discover(args)
        return 0

    docker = safe_regular_executable(args.docker)
    authority = read_authority(pathlib.Path(args.authority), docker)
    if args.action == "probe":
        if classify_state(authority, query_state(docker, authority)) != "released":
            fail("Docker database did not pass released-state admission")
    elif args.action == "acquire":
        acquire(docker, authority)
    elif args.action == "assert":
        if classify_state(authority, query_state(docker, authority)) != "held":
            fail("Docker database fence is not held")
    elif args.action == "release":
        release(docker, authority)
    elif args.action == "role-sql":
        print(f"SET ROLE {sql_identifier(authority['portalRoleName'])};")
    elif args.action == "psql":
        forbidden = ("--host", "--port", "--username", "--dbname", "--file")
        if any(
            not safe_text(argument, 131072)
            or argument.startswith(forbidden)
            for argument in args.arguments
        ):
            fail("Docker psql arguments attempted to replace sealed connection authority")
        exec_validated(
            docker,
            docker_exec_arguments(
                authority,
                PSQL,
                [*psql_arguments(authority, args.target), *args.arguments],
                interactive=True,
            ),
        )
    elif args.action == "pg-dump":
        if not re.fullmatch(r"[A-Za-z0-9._:-]{1,256}", args.snapshot):
            fail("Docker pg_dump snapshot identifier is invalid")
        exec_validated(
            docker,
            docker_exec_arguments(
                authority,
                PG_DUMP,
                [
                    f"--host={SOCKET_DIRECTORY}",
                    f"--port={authority['container']['containerPort']}",
                    "--username=postgres",
                    f"--dbname={authority['databaseName']}",
                    f"--role={authority['portalRoleName']}",
                    "--no-owner",
                    "--no-privileges",
                    "--no-tablespaces",
                    "--format=custom",
                    "--compress=0",
                    f"--snapshot={args.snapshot}",
                ],
                interactive=False,
            ),
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FenceError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        # This helper runs inside a root-owned backup unit. Keep unexpected
        # diagnostics fail-closed and free of connection strings or paths.
        print("ERROR: Container database fence encountered an unexpected internal failure", file=sys.stderr)
        raise SystemExit(1)
