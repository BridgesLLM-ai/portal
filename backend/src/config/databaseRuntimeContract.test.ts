import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const backendRoot = path.resolve(__dirname, '../..');

function productionTypescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'tests') {
        files.push(...productionTypescriptFiles(absolute));
      }
      continue;
    }
    if (
      entry.isFile()
      && entry.name.endsWith('.ts')
      && !entry.name.endsWith('.test.ts')
      && !entry.name.endsWith('.spec.ts')
    ) {
      files.push(absolute);
    }
  }
  return files;
}

describe('Rust-free Prisma runtime contract', () => {
  it('pins one aligned Prisma release and the pg driver exactly', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'),
    );
    const dependencies = packageJson.dependencies;

    expect(dependencies['@prisma/client']).toBe('6.19.3');
    expect(dependencies['@prisma/adapter-pg']).toBe('6.19.3');
    expect(dependencies.prisma).toBe('6.19.3');
    expect(dependencies.pg).toBe('8.22.0');
  });

  it('generates the client engine and centralizes the sole PrismaClient', () => {
    const schema = fs.readFileSync(
      path.join(backendRoot, 'prisma/schema.prisma'),
      'utf8',
    );
    expect(schema).toMatch(/generator\s+client\s*\{[\s\S]*engineType\s*=\s*"client"[\s\S]*\}/);

    const occurrences = productionTypescriptFiles(path.join(backendRoot, 'src'))
      .flatMap((file) => {
        const count = (fs.readFileSync(file, 'utf8').match(/new\s+PrismaClient\s*\(/g) || []).length;
        return Array.from({ length: count }, () => path.relative(backendRoot, file));
      });
    expect(occurrences).toEqual(['src/config/database.ts']);

    const databaseSource = fs.readFileSync(
      path.join(backendRoot, 'src/config/database.ts'),
      'utf8',
    );
    expect(databaseSource).toContain('new PrismaPg(adapterConfig.pool');
    expect(databaseSource).toContain('assertRustFreePrismaEnvironment()');
    expect(databaseSource).toContain('buildPostgresAdapterConfig');
  });

  it('rejects native-pg selection before the adapter module can load', () => {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (
        key.startsWith('PG')
        || key.startsWith('PRISMA_')
        || key === 'NODE_PG_FORCE_NATIVE'
        || key === 'NODE_TLS_REJECT_UNAUTHORIZED'
      ) {
        delete environment[key];
      }
    }
    environment.DATABASE_URL =
      'postgresql://portal:validation@127.0.0.1:5432/portal?sslmode=disable';
    environment.NODE_PG_FORCE_NATIVE = '1';

    const result = spawnSync(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register/transpile-only'),
        '-e',
        "require('./src/config/database')",
      ],
      {
        cwd: backendRoot,
        env: environment,
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('NODE_PG_FORCE_NATIVE');
    expect(output).not.toContain('pg-native');
  });

  it.each([
    'src/services/app-process.service.ts',
    'src/templates/baseTemplate.ts',
  ])('%s uses the shared database singleton', (relativePath) => {
    const source = fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
    expect(source).toMatch(/import\s+\{\s*prisma\s*\}\s+from\s+['"].*config\/database['"]/);
    expect(source).not.toMatch(/new\s+PrismaClient\s*\(/);
  });

  it('declares plaintext explicitly for the private Docker database network', () => {
    const compose = fs.readFileSync(
      path.resolve(backendRoot, '../docker-compose.yml'),
      'utf8',
    );
    expect(compose).toContain(
      '@bridgesllm-db:5432/bridgesllm_portal?sslmode=disable',
    );
  });
});
