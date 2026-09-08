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
  const fixtureRoot = path.join(cleanupRoot, 'restore-fixture');
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
    postgresServerVersion?: string;
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
  const postgresServerVersion = options.postgresServerVersion || '16.14';
  const postgresServerMatch = postgresServerVersion.match(/^([0-9]+)\.([0-9]+)$/u);
  if (!postgresServerMatch) throw new Error('Invalid PostgreSQL server fixture version');
  const postgresServerVersionNum = `${postgresServerMatch[1]}${postgresServerMatch[2].padStart(4, '0')}`;

  for (const directory of [
    commandsRoot,
    path.join(commandsRoot, 'state'),
    systemdRoot,
    recoveryRoot,
    trustRoot,
    restoreStateRoot,
    installerStateRoot,
    path.dirname(operationLock),
    path.join(testRoot, 'tmp'),
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
  for (const script of ['restore-full.sh', 'backup-full.sh']) {
    fs.copyFileSync(path.join(repositoryRoot, script), path.join(portalRoot, script));
    fs.chmodSync(path.join(portalRoot, script), 0o700);
  }
  for (const command of ['systemd-run', 'initdb', 'postgres', 'npx']) {
    writeSealedCommand(path.join(commandsRoot, command), '#!/bin/sh\nexit 1\n');
  }
  fs.copyFileSync(
    path.join(repositoryRoot, 'installer', 'portal-recovery-archive.py'),
    path.join(portalRoot, 'installer', 'portal-recovery-archive.py'),
  );
  fs.writeFileSync(path.join(portalRoot, 'backend', 'package.json'),
    JSON.stringify({ name: 'portal-backup-fixture', version: '4.0.0' }), { mode: 0o600 });
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

  writeSealedCommand(commands.systemctl, `#!/bin/sh
case "$*" in
  *--property=LoadState*) printf '%s\\n' not-found ;;
  *--property=ActiveState*) printf '%s\\n' inactive ;;
  *daemon-reload*) exit 0 ;;
  *) exit 1 ;;
esac
`);
  writeSealedCommand(commands.docker, `#!/bin/sh
case "$*" in
  *"container ls"*|"ps "*|ps) exit 0 ;;
  *) printf '%s\\n' 'No such container' >&2; exit 1 ;;
esac
`);
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
    print(";     Dumped from database version: ${postgresServerVersion}")
    print(";     Dumped by pg_dump version: 16.14")
    print(";")
    print("1; 0 0 TABLE public fixture_state portal")
    raise SystemExit(0)
if "--file=/dev/null" in arguments:
    raise SystemExit(0)
raise SystemExit(1)
`);
  // Reuse the executing recovery fixture's PostgreSQL fence model, including
  // role admission, guarded snapshot, and exact restoration of connection state.
  const recoveryFixture = fs.readFileSync(
    path.join(repositoryRoot, 'scripts/validation/restore-full-static.sh'), 'utf8',
  );
  const psqlMarker = 'cat > "${commands_root}/psql" <<\'PY\'\n';
  const psqlStart = recoveryFixture.indexOf(psqlMarker);
  if (psqlStart < 0) throw new Error('Recovery fixture PostgreSQL model is missing');
  const psqlEnd = recoveryFixture.indexOf('\nPY\n', psqlStart + psqlMarker.length);
  if (psqlEnd < 0) throw new Error('Recovery fixture PostgreSQL model is unterminated');
  writeSealedCommand(commands.psql, recoveryFixture
    .slice(psqlStart + psqlMarker.length, psqlEnd)
    .replace('print("160014")', `print("${postgresServerVersionNum}")`));
  fs.mkdirSync(path.join(testRoot, 'postgres', 'pg_wal'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(testRoot, 'database-guard.json'), JSON.stringify({
    connectionLimit: -1, portalCanLogin: true, token: '',
  }), { mode: 0o600 });


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
