import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const backendRoot = path.resolve(__dirname, '../..');
const loader = require.resolve('@prisma/config');
const configFile = path.join(backendRoot, 'prisma.config.ts');
const script = `
const { loadConfigFromFile } = require(process.argv[1]);
loadConfigFromFile({ configFile: process.argv[2] }).then(result => {
  if (result.error || !result.config) throw new Error('CLI configuration failed to load');
  console.log(JSON.stringify({ url: result.config.datasource.url, env: process.env.DATABASE_URL ?? null }));
}).catch(error => { console.error(error); process.exitCode = 1; });
`;

test.each([undefined, 'postgresql://injected:fixture@127.0.0.1:5432/fixture?sslmode=disable'])(
  'Prisma CLI config keeps the explicitly supplied URL and never restores it from .env (%s)', supplied => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cli-config-'));
    try {
      fs.writeFileSync(path.join(directory, '.env'), 'DATABASE_URL=postgresql://stripped:fixture@invalid.example/forbidden\n');
      const env = { ...process.env };
      if (supplied === undefined) delete env.DATABASE_URL;
      else env.DATABASE_URL = supplied;
      const result = spawnSync(process.execPath, ['-e', script, loader, configFile], {
        cwd: directory, env, encoding: 'utf8', timeout: 15_000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ url: supplied ?? '', env: supplied ?? null });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  },
);
