import fs from 'fs';
import path from 'path';

describe('mail setup Stalwart image pin', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const setupSource = fs.readFileSync(path.join(repoRoot, 'backend/src/routes/setup-v3.ts'), 'utf8');
  const adminSource = fs.readFileSync(path.join(repoRoot, 'backend/src/routes/admin.ts'), 'utf8');

  test('setup wizard pins a Stalwart release with the legacy admin API', () => {
    expect(setupSource).toContain('stalwartlabs/stalwart:v0.15.5');
    expect(setupSource).not.toContain('stalwartlabs/stalwart:latest');
    expect(setupSource).not.toContain('stalwartlabs/mail-server:v0.11.8');
  });

  test('admin mail installer uses the same pinned Stalwart image', () => {
    expect(adminSource).toContain('stalwartlabs/stalwart:v0.15.5');
    expect(adminSource).not.toContain('stalwartlabs/stalwart:latest');
    expect(adminSource).not.toContain('stalwartlabs/mail-server:v0.11.8');
  });

  test('automatic mail recovery cannot delete the persistent Stalwart store', () => {
    for (const source of [setupSource, adminSource]) {
      expect(source).not.toContain('docker compose down -v');
      expect(source).not.toContain('rm -rf /opt/bridgesllm/stalwart/data');
    }
  });
});
