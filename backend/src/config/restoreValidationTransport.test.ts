import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { assertRustFreePrismaEnvironment, buildPostgresAdapterConfig } from './databaseAdapter';

// Execute the launcher's actual writer and feed its output to the application.
// Neither side is mocked into agreeing.
describe('offline restore validation transport', () => {
  it.each(['migration', 'candidate'])('generates an admitted %s database environment', (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-restore-adapter-'));
    try {
      const source = fs.readFileSync(path.resolve(__dirname, '../../../restore-full.sh'), 'utf8');
      const begin = 'prepare_restore_validation_environment() {';
      const end = 'prepare_restore_validation_database() {';
      expect(source.split(begin)).toHaveLength(2);
      expect(source.split(end)).toHaveLength(2);
      const writer = source.slice(source.indexOf(begin), source.indexOf(end));
      const operation = 'a'.repeat(32);
      const application = `bridgesllm-restore-${kind}-${operation}`;
      fs.mkdirSync(path.join(root, 'stage/configs'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(root, 'stage/configs/portal-backend.env.production'), [
        'DATABASE_URL=postgresql://fixture:unused@original.invalid/fixture?schema=public',
        'PGHOST=original.invalid',
        'PGAPPNAME=original-application',
        'OPENCLAW_GATEWAY_URL=http://original.invalid',
        'NODE_ENV=production',
        '',
      ].join('\n'), { mode: 0o600 });
      fs.writeFileSync(path.join(root, 'validation-database-authority.json'), JSON.stringify({
        socketDirectory: `/run/bridgesllm-restore-postgres-${operation}/socket`,
        applicationRole: 'validation_fixture',
        applicationPassword: 'unused-fixture-value',
        port: 5432,
        database: 'validation_fixture',
      }), { mode: 0o600 });
      const result = spawnSync('/bin/bash', ['-s', '--', root, application], {
        input: `set -Eeuo pipefail\n${writer}\nTRANSACTION_DIR="$1"\nprepare_restore_validation_environment "$2"\n`,
        encoding: 'utf8', timeout: 10000,
      });
      expect(result.status).toBe(0);
      const generated = fs.readFileSync(path.join(root, `${application}.env`), 'utf8');
      const environment = Object.fromEntries(generated.trim().split('\n').map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
      }));
      expect(() => assertRustFreePrismaEnvironment(environment)).not.toThrow();
      const configured = buildPostgresAdapterConfig(environment.DATABASE_URL);
      const url = new URL(configured.pool.connectionString);
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.port).toBe('5432');
      expect(url.searchParams.has('host')).toBe(false);
      expect(url.searchParams.get('application_name')).toBe(application);
      expect(configured.pool.max).toBe(1);
      expect(configured.schema).toBe('public');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
