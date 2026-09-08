import fs from 'node:fs';
import path from 'node:path';

function source(relative: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

function routeSlice(raw: string, marker: string, nextMarker: string): string {
  const start = raw.indexOf(marker);
  const end = raw.indexOf(nextMarker, start + marker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return raw.slice(start, end);
}

describe('native host CLI route checkpoint', () => {
  test('Owner maintenance route is a fixed unavailable response with no installer dispatch', () => {
    const route = routeSlice(
      source('routes/admin.ts'),
      "router.post('/install-coding-tool'",
      "router.get('/domain-status'",
    );
    expect(route).toContain('sendHostNativeRuntimeMutationUnavailable');
    expect(route).not.toMatch(/safeParse|confirmationForToolInstall|installCodingTool|execSync/);
  });

  test('in-setup route retains setup guards and returns the same fixed unavailable response', () => {
    const route = routeSlice(
      source('routes/setup-v3.ts'),
      "'/install-coding-tool',",
      "router.post('/complete'",
    );
    expect(route).toMatch(/requireSetupPending[\s\S]*requireSetupToken[\s\S]*sendHostNativeRuntimeMutationUnavailable/);
    expect(route).not.toMatch(/safeParse|installCodingTool|execSync/);
  });

  test('production sources contain no raw native CLI status/help/PATH probes', () => {
    const roots = [
      path.join(__dirname, '..', 'config'),
      path.join(__dirname, '..', 'routes'),
      path.join(__dirname, '..', 'services'),
      path.join(__dirname, '..', 'utils'),
    ];
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(target);
      }
    };
    roots.forEach(walk);
    const raw = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(raw).not.toMatch(/(?:codex|claude)(?:\.js)?\s+--(?:version|help)\b/i);
    expect(raw).not.toMatch(/(?:which|command\s+-v)\s+(?:codex|claude)\b/i);
    expect(raw).not.toMatch(/codex\s+login\s+status\b/i);
  });

  test('Anthropic setup-token save ends at credential readback without a live model probe', () => {
    const route = routeSlice(
      source('routes/ai-setup.ts'),
      "router.post('/save-setup-token'",
      "router.post('/set-default-model'",
    );
    expect(route).toContain('expectedProviderCredentialPresent');
    expect(route).not.toContain('runAdvisoryAuthProbe');
    expect(route).not.toMatch(/models[\s\S]{0,80}status[\s\S]{0,80}--probe/);
  });
});
