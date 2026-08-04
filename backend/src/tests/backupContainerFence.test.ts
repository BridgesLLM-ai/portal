import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createAttestedBackupRoot } from './backupRunnerFixture';

const repositoryRoot = path.resolve(__dirname, '../../..');
const helper = path.join(repositoryRoot, 'installer', 'backup-container-fence.py');
const cleanupRoots: string[] = [];

function runHelper(
  docker: string,
  args: string[],
  input?: string,
) {
  return spawnSync('/usr/bin/python3', [helper, '--docker', docker, ...args], {
    encoding: 'utf8',
    input,
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('container PostgreSQL backup fence', () => {
  it('binds immutable container storage, fences through peer auth, and restores exact state', () => {
    const { cleanupRoot, fixtureRoot } = createAttestedBackupRoot('container-database-fence');
    cleanupRoots.push(cleanupRoot);
    const authorityDirectory = path.join(fixtureRoot, 'authority');
    fs.mkdirSync(authorityDirectory, { mode: 0o700 });
    const authority = path.join(authorityDirectory, 'database-container.json');
    const fakeDocker = path.join(fixtureRoot, 'docker');
    const fakeState = path.join(fixtureRoot, 'docker-state.json');
    const commandLog = path.join(fixtureRoot, 'docker-commands.jsonl');
    const containerId = 'a'.repeat(64);
    const imageId = `sha256:${'b'.repeat(64)}`;
    fs.writeFileSync(fakeState, JSON.stringify({
      containerRunning: true,
      imageId,
      portalRoleCanLogin: true,
      connectionLimit: -1,
      guardToken: '',
      targetClients: 2,
      portalRoleSessions: 2,
    }), { mode: 0o600 });

    fs.writeFileSync(fakeDocker, `#!/usr/bin/python3
import json
import re
import sys

STATE_PATH = ${JSON.stringify(fakeState)}
LOG_PATH = ${JSON.stringify(commandLog)}
CONTAINER_ID = ${JSON.stringify(containerId)}

def load_state():
    with open(STATE_PATH, 'r', encoding='utf-8') as handle:
        return json.load(handle)

def save_state(value):
    with open(STATE_PATH, 'w', encoding='utf-8') as handle:
        json.dump(value, handle, sort_keys=True)

args = sys.argv[1:]
with open(LOG_PATH, 'a', encoding='utf-8') as handle:
    handle.write(json.dumps(args) + '\\n')
state = load_state()

if args[:2] == ['container', 'ls']:
    print(CONTAINER_ID)
    raise SystemExit(0)

if args[:2] == ['container', 'inspect'] and args[2:] == [CONTAINER_ID]:
    print(json.dumps([{
        'Id': CONTAINER_ID,
        'Name': '/bridgesllm-product-db',
        'Image': state['imageId'],
        'Config': {
            'Image': 'postgres:16',
            'Env': ['PGDATA=/var/lib/postgresql/data'],
        },
        'HostConfig': {
            'PortBindings': {
                '5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5433'}],
            },
        },
        'State': {'Running': state['containerRunning']},
        'Mounts': [
            {
                'Type': 'tmpfs',
                'Source': '',
                'Destination': '/var/run/postgresql',
                'Driver': '',
                'Mode': '',
                'RW': True,
                'Propagation': '',
            },
            {
                'Type': 'volume',
                'Name': 'bridgesllm-product-db-data',
                'Source': '/var/lib/docker/volumes/bridgesllm-product-db-data/_data',
                'Destination': '/var/lib/postgresql/data',
                'Driver': 'local',
                'Mode': 'z',
                'RW': True,
                'Propagation': '',
            },
        ],
    }]))
    raise SystemExit(0)

if len(args) >= 7 and args[:2] == ['container', 'exec']:
    cursor = 2
    if args[cursor] == '--interactive':
        cursor += 1
    if args[cursor:cursor + 3] != ['--user', 'postgres', CONTAINER_ID]:
        raise SystemExit(90)
    cursor += 3
    executable = args[cursor]
    tool_args = args[cursor + 1:]
    if tool_args == ['--version']:
        name = 'psql' if executable.endswith('/psql') else 'pg_dump'
        print(f'{name} (PostgreSQL) 16.13')
        raise SystemExit(0)
    if executable.endswith('/pg_dump'):
        sys.stdout.buffer.write(b'PGDMP-CONTAINER-FENCE-TEST')
        raise SystemExit(0)
    command = next((item[len('--command='):] for item in tool_args if item.startswith('--command=')), '')
    if 'json_build_object(' in command:
        observed = {
            'schema': 'bridgesllm.backup-container-database-state.v1',
            'systemIdentifier': '7421923187000000000',
            'databaseName': 'bridgesllm',
            'databaseOid': 16384,
            'databaseOwnerOid': 16385,
            'portalRoleName': 'bridgesllm',
            'portalRoleOid': 16385,
            'portalRoleCanLogin': state['portalRoleCanLogin'],
            'portalRoleSuperuser': False,
            'portalRoleCreateDb': False,
            'portalRoleCreateRole': False,
            'portalRoleReplication': False,
            'portalRoleBypassRls': False,
            'portalRoleInherit': True,
            'portalRoleConnectionLimit': -1,
            'portalRoleValidUntilNull': True,
            'peerRoleName': 'postgres',
            'peerRoleOid': 10,
            'peerRoleSuperuser': True,
            'connectionLimit': state['connectionLimit'],
            'allowConnections': True,
            'guardToken': state['guardToken'],
            'serverVersionNum': 160013,
            'serverPort': 5432,
            'fsyncEnabled': True,
            'fullPageWritesEnabled': True,
            'targetClients': state['targetClients'],
            'portalRoleSessions': state['portalRoleSessions'],
            'memberLoginRoles': 0,
            'preparedTransactions': 0,
        }
        print(json.dumps(observed, separators=(',', ':')))
        raise SystemExit(0)
    if 'ALTER ROLE "bridgesllm" NOLOGIN;' in command:
        token = re.search(r"SET bridgesllm\\.exclusive_guard TO '([a-f0-9]{64})'", command)
        if token is None:
            raise SystemExit(91)
        state.update({
            'portalRoleCanLogin': False,
            'connectionLimit': 0,
            'guardToken': token.group(1),
            'targetClients': 0,
            'portalRoleSessions': 0,
        })
        save_state(state)
        raise SystemExit(0)
    if 'RESET bridgesllm.exclusive_guard;' in command:
        state.update({
            'portalRoleCanLogin': True,
            'connectionLimit': -1,
            'guardToken': '',
            'targetClients': 0,
            'portalRoleSessions': 0,
        })
        save_state(state)
        raise SystemExit(0)
    if 'pg_terminate_backend' in command or command.strip() == 'SELECT 1':
        raise SystemExit(0)
    if command.strip() == 'SELECT 42':
        print('42')
        raise SystemExit(0)

raise SystemExit(92)
`, { mode: 0o700 });
    fs.chmodSync(fakeDocker, 0o700);

    const databaseUrl = 'postgresql://bridgesllm:do-not-persist-this@127.0.0.1:5433/bridgesllm';
    const discovery = runHelper(fakeDocker, [
      'discover',
      '--database-url-fd', '0',
      '--operation', 'comprehensive-test',
      '--output', authority,
      '--expected-major', '16',
    ], databaseUrl);
    expect(discovery.status).toBe(0);
    expect(fs.statSync(authority).mode & 0o777).toBe(0o600);
    const authorityText = fs.readFileSync(authority, 'utf8');
    expect(authorityText).not.toContain('do-not-persist-this');
    expect(JSON.parse(authorityText)).toMatchObject({
      operationId: 'comprehensive-test',
      databaseName: 'bridgesllm',
      portalRoleName: 'bridgesllm',
      container: {
        id: containerId,
        imageId,
        hostAddress: '127.0.0.1',
        hostPort: 5433,
        containerPort: 5432,
        pgdata: '/var/lib/postgresql/data',
        dataMount: { type: 'volume', name: 'bridgesllm-product-db-data' },
      },
    });

    expect(runHelper(fakeDocker, ['probe', '--authority', authority]).status).toBe(0);
    expect(runHelper(fakeDocker, ['acquire', '--authority', authority]).status).toBe(0);
    expect(runHelper(fakeDocker, ['assert', '--authority', authority]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(fakeState, 'utf8'))).toMatchObject({
      portalRoleCanLogin: false,
      connectionLimit: 0,
      targetClients: 0,
      portalRoleSessions: 0,
    });

    const psql = runHelper(fakeDocker, [
      'psql', '--authority', authority, '--target', 'target', '--command=SELECT 42',
    ]);
    expect(psql.status).toBe(0);
    expect(psql.stdout.trim()).toBe('42');
    const dump = runHelper(fakeDocker, [
      'pg-dump', '--authority', authority, '--snapshot', '00000003-0000001B-1',
    ]);
    expect(dump.status).toBe(0);
    expect(dump.stdout).toBe('PGDMP-CONTAINER-FENCE-TEST');

    expect(runHelper(fakeDocker, ['release', '--authority', authority]).status).toBe(0);
    expect(runHelper(fakeDocker, ['probe', '--authority', authority]).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(fakeState, 'utf8'))).toMatchObject({
      portalRoleCanLogin: true,
      connectionLimit: -1,
      guardToken: '',
    });

    const commandRecords: string[][] = fs.readFileSync(commandLog, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const psqlRecord = commandRecords.find((record) => record.includes('--command=SELECT 42'));
    expect(psqlRecord).toEqual(expect.arrayContaining([
      '--interactive',
      '--user',
      'postgres',
      '--host=/var/run/postgresql',
      '--port=5432',
      '--username=postgres',
      '--dbname=bridgesllm',
    ]));
    const acquireCommand = commandRecords.flat()
      .find((argument) => argument.startsWith('--command=') && argument.includes('NOLOGIN;'));
    const releaseCommand = commandRecords.flat()
      .find((argument) => argument.startsWith('--command=') && argument.includes('RESET bridgesllm.exclusive_guard;'));
    expect(acquireCommand).toContain('FROM pg_db_role_setting setting');
    expect(acquireCommand).toContain('setting.setdatabase = 16384');
    expect(releaseCommand).toContain('FROM pg_db_role_setting setting');
    expect(releaseCommand).toContain('setting.setdatabase = d.oid');
    expect(releaseCommand).not.toContain("current_setting('bridgesllm.exclusive_guard'");
    expect(JSON.stringify(commandRecords)).not.toContain('do-not-persist-this');

    const stopped = JSON.parse(fs.readFileSync(fakeState, 'utf8'));
    stopped.containerRunning = false;
    fs.writeFileSync(fakeState, JSON.stringify(stopped), { mode: 0o600 });
    const lostIdentity = runHelper(fakeDocker, ['probe', '--authority', authority]);
    expect(lostIdentity.status).not.toBe(0);
    expect(lostIdentity.stderr).toContain('Docker database container is not running');
    expect(lostIdentity.stderr).not.toContain('do-not-persist-this');
  });
});
