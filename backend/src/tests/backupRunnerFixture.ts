import fs from 'fs';
import path from 'path';

const repositoryRoot = path.resolve(__dirname, '../../..');

export interface AttestedBackupRoot {
  cleanupRoot: string;
  fixtureRoot: string;
}

export interface BackupRunnerFixture {
  backupRoot: string;
  commands: {
    curl: string;
    docker: string;
    pgDump: string;
    pgRestore: string;
    psql: string;
    systemctl: string;
  };
  commandsRoot: string;
  env: Record<string, string>;
  portalRoot: string;
  requiredSources: Record<string, string>;
  stateDir: string;
}

export function createAttestedBackupRoot(prefix: string): AttestedBackupRoot {
  const safePrefix = prefix.replace(/[^A-Za-z0-9._-]/gu, '-');
  const cleanupRoot = fs.mkdtempSync(
    path.join('/root', `bridgesllm-installer-data-test-${safePrefix}-`),
  );
  fs.chmodSync(cleanupRoot, 0o700);
  const fixtureRoot = path.join(cleanupRoot, 'backup-fixture');
  fs.mkdirSync(fixtureRoot, { mode: 0o700 });
  return { cleanupRoot, fixtureRoot };
}

function writeSealedCommand(target: string, source: string): void {
  fs.writeFileSync(target, source, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
}

export function createBackupRunnerFixture(
  testRoot: string,
  options: {
    backupRoot?: string;
    databaseUrl?: string;
    portalRoot?: string;
    stateDir?: string;
  } = {},
): BackupRunnerFixture {
  const portalRoot = options.portalRoot || path.join(testRoot, 'portal');
  const stateDir = options.stateDir
    || path.join(portalRoot, 'backend', '.data', 'backups');
  const backupRoot = options.backupRoot
    || path.join(testRoot, 'configured-backups');
  const commandsRoot = path.join(testRoot, 'commands');
  const systemdRoot = path.join(testRoot, 'etc', 'systemd', 'system');
  const recoveryRoot = path.join(testRoot, 'backup-recovery');
  const trustRoot = path.join(testRoot, 'backup-trust');
  const restoreStateRoot = path.join(testRoot, 'restore-state');
  const installerStateRoot = path.join(testRoot, 'installer-state');
  const operationLock = path.join(testRoot, 'run', 'lock', 'portal-operation.lock');
  const installRoot = path.join(testRoot, 'install-root');

  for (const directory of [
    commandsRoot,
    path.join(commandsRoot, 'state'),
    systemdRoot,
    recoveryRoot,
    trustRoot,
    restoreStateRoot,
    installerStateRoot,
    path.dirname(operationLock),
    installRoot,
    stateDir,
    path.join(backupRoot, 'daily'),
    path.join(backupRoot, 'weekly'),
    path.join(backupRoot, 'monthly'),
    path.join(backupRoot, 'comprehensive'),
    path.join(portalRoot, 'backend'),
    path.join(portalRoot, 'installer'),
    // Standalone App sources are their own required recovery domain. The
    // runner resolves this root from the Portal environment authority rather
    // than a process override, so the fixture has to materialize the exact
    // default path the installer guarantees.
    path.join(portalRoot, 'apps'),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  const requiredSources = {
    APPS_ROOT: path.join(testRoot, 'hosted-apps'),
    PORTAL_FILES_DIR: path.join(testRoot, 'portal-files'),
    UPLOADS_ROOT: path.join(testRoot, 'uploads'),
    PROJECTS_ROOT: path.join(portalRoot, 'projects'),
    PORTAL_BACKEND_STATE_DIR: path.join(portalRoot, 'backend', '.data'),
    PORTAL_STATE_DIR: path.join(portalRoot, '.data'),
    PORTAL_ASSETS_DIR: path.join(testRoot, 'assets'),
  };
  for (const directory of Object.values(requiredSources)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  fs.copyFileSync(
    path.join(repositoryRoot, 'installer', 'install.sh'),
    path.join(portalRoot, 'installer', 'install.sh'),
  );
  fs.chmodSync(path.join(portalRoot, 'installer', 'install.sh'), 0o700);
  fs.writeFileSync(
    path.join(portalRoot, 'backend', '.env.production'),
    `DATABASE_URL=${options.databaseUrl || 'postgresql://portal:test@127.0.0.1:5432/portal'}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(stateDir, 'backup-base-path'),
    `${backupRoot}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(portalRoot, 'marker.txt'), 'portal fixture\n', {
    mode: 0o600,
  });

  const commands = {
    curl: path.join(commandsRoot, 'curl'),
    docker: path.join(commandsRoot, 'docker'),
    pgDump: path.join(commandsRoot, 'pg_dump'),
    pgRestore: path.join(commandsRoot, 'pg_restore'),
    psql: path.join(commandsRoot, 'psql'),
    systemctl: path.join(commandsRoot, 'systemctl'),
  };

  writeSealedCommand(commands.systemctl, '#!/bin/sh\nexit 1\n');
  writeSealedCommand(commands.docker, '#!/bin/sh\nexit 1\n');
  writeSealedCommand(commands.curl, '#!/bin/sh\nexit 1\n');
  writeSealedCommand(commands.pgDump, `#!/usr/bin/env python3
import sys

if sys.argv[1:] == ["--version"]:
    print("pg_dump (PostgreSQL) 16.14")
    raise SystemExit(0)
sys.stdout.buffer.write(b"PGDMPBRIDGESLLM-TEST-V1\\n")
`);
  writeSealedCommand(commands.pgRestore, `#!/usr/bin/env python3
import pathlib
import sys

arguments = sys.argv[1:]
if arguments == ["--version"]:
    print("pg_restore (PostgreSQL) 16.14")
    raise SystemExit(0)
if not arguments:
    raise SystemExit(1)
source = pathlib.Path(arguments[-1])
try:
    payload = source.read_bytes()
except OSError:
    raise SystemExit(1)
if not payload.startswith(b"PGDMP"):
    raise SystemExit(1)
if "--list" in arguments:
    print(";")
    print(";     Dumped from database version: 16.14")
    print(";     Dumped by pg_dump version: 16.14")
    print(";")
    print("1; 0 0 TABLE public fixture_state portal")
    raise SystemExit(0)
if "--file=/dev/null" in arguments:
    raise SystemExit(0)
raise SystemExit(1)
`);
  writeSealedCommand(commands.psql, `#!/usr/bin/env python3
import json
import sys

if sys.argv[1:] == ["--version"]:
    print("psql (PostgreSQL) 16.14")
    raise SystemExit(0)

command = next(
    (
        argument.partition("=")[2]
        for argument in sys.argv[1:]
        if argument.startswith("--command=")
    ),
    None,
)
if command is not None:
    if "current_setting('server_version_num')" in command:
        print("160014")
    elif "pg_database_size(current_database())" in command:
        if "FROM pg_class" in command and "relkind IN" in command:
            print("1048576|64")
        else:
            print("1048576")
    elif "FROM pg_class" in command and "relkind IN" in command:
        print("64")
    else:
        print("0")
    raise SystemExit(0)

first = sys.stdin.buffer.readline()
statements = []
if first.startswith(b"BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;"):
    statements.append(first)
    while not any(
        b"current_setting('temp_tablespaces')" in line
        for line in statements
    ):
        line = sys.stdin.buffer.readline()
        if not line:
            raise SystemExit(1)
        statements.append(line)
    identity = json.dumps({
        "schema": "bridgesllm.postgresql-database-identity.v1",
        "postgresMajor": 16,
        "encoding": "UTF8",
        "lcCollate": "C",
        "lcCtype": "C",
        "localeProvider": "libc",
        "providerLocale": None,
        "icuRules": None,
        "collationVersion": None,
        "collationActualVersion": None,
    }, separators=(",", ":"))
    print("BRIDGESLLM_BACKUP_SNAPSHOT_V1", flush=True)
    print("00000003-0000001B-1", flush=True)
    print("1048576", flush=True)
    print("64", flush=True)
    print(identity, flush=True)
    print("0|owner-null", flush=True)
    print("0", flush=True)
    for line in sys.stdin.buffer:
        if b"BRIDGESLLM_BACKUP_IDENTITY_END_V1" in line:
            print(identity, flush=True)
            print("BRIDGESLLM_BACKUP_IDENTITY_END_V1", flush=True)
        if line.strip() == b"\\\\q":
            break
    raise SystemExit(0)
raise SystemExit(1)
`);

  const env: Record<string, string> = {
    PORTAL_ROOT: portalRoot,
    INSTALL_ROOT: installRoot,
    PORTAL_DATA_ROOT: portalRoot,
    ...requiredSources,
    LEGACY_APP_FILES_DIR: path.join(testRoot, 'missing-legacy-apps'),
    LEGACY_PORTAL_FILES_DIR: path.join(testRoot, 'missing-legacy-portal-files'),
    RUNTIME_ROOT: path.join(testRoot, 'missing-runtime'),
    OPENCLAW_DIR: path.join(testRoot, 'missing-openclaw'),
    STALWART_DIR: path.join(testRoot, 'missing-stalwart'),
    STALWART_MAIL_DIR: path.join(testRoot, 'missing-stalwart-mail'),
    STALWART_INSTALL_DIR: path.join(testRoot, 'missing-stalwart-install'),
    SYSTEMD_DIR: systemdRoot,
    CADDY_CONF: path.join(testRoot, 'missing-Caddyfile'),
    BACKUP_BASE: backupRoot,
    BACKUP_STATE_DIR: stateDir,
    BACKUP_CONFIG_FILE: path.join(stateDir, 'backup-base-path'),
    PORTAL_OPERATION_LOCK_FILE: operationLock,
    BRIDGESLLM_BACKUP_RECOVERY_STATE_DIR: recoveryRoot,
    BRIDGESLLM_BACKUP_TRUST_ROOT: trustRoot,
    BRIDGESLLM_BACKUP_RESTORE_STATE_ROOT: restoreStateRoot,
    BRIDGESLLM_BACKUP_INSTALLER_STATE_ROOT: installerStateRoot,
    BRIDGESLLM_BACKUP_TEST_ROOT: testRoot,
    BRIDGESLLM_BACKUP_SYSTEMCTL_BIN: commands.systemctl,
    BRIDGESLLM_BACKUP_DOCKER_BIN: commands.docker,
    BRIDGESLLM_BACKUP_PG_DUMP_BIN: commands.pgDump,
    BRIDGESLLM_BACKUP_PG_RESTORE_BIN: commands.pgRestore,
    BRIDGESLLM_BACKUP_PSQL_BIN: commands.psql,
    BRIDGESLLM_BACKUP_CURL_BIN: commands.curl,
    OPENCLAW_BACKUP_POLICY: 'absent',
    STALWART_BACKUP_POLICY: 'absent',
    BACKUP_RECOVERY_RESERVE_BYTES: '67108864',
  };

  return {
    backupRoot,
    commands,
    commandsRoot,
    env,
    portalRoot,
    requiredSources,
    stateDir,
  };
}
