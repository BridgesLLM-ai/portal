import fs from 'fs';
import path from 'path';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));

import { execFile } from 'child_process';
import { listAntigravityModelsFromCli } from '../agents/antigravityModels';
import { buildNativeCliEnvironment, buildNativeCliProbeEnvironment } from '../agents/providers/native/NativeCliEnvironment';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/**
 * F10 (TEST, 2026-10-31): /usr/local/bin/agy was rewritten by the vendor's self-update about 10 s after the first
 * Maintenance load, outside any Portal run. Every Portal probe of Antigravity (version, model-list, login-state and
 * help reads) runs with its self-update off; chat and login sessions keep the updater v2 rule (it may update itself;
 * Maintenance re-checks the new version).
 */
describe('Portal probes of Antigravity never let it replace itself (F10)', () => {
  test('the probe environment turns the vendor self-update off and changes nothing else', () => {
    const source = { HOME: '/root', PATH: '/usr/bin:/bin', DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x' };
    const probe = buildNativeCliProbeEnvironment('GEMINI', source);
    expect(probe.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
    const { AGY_CLI_DISABLE_AUTO_UPDATE: _off, ...rest } = probe;
    expect(rest).toEqual(buildNativeCliEnvironment('GEMINI', source));
    expect(probe.DATABASE_URL).toBeUndefined();
    // A session keeps the updater v2 rule; other CLIs keep their own guards.
    expect(buildNativeCliEnvironment('GEMINI', source).AGY_CLI_DISABLE_AUTO_UPDATE).toBeUndefined();
    expect(buildNativeCliProbeEnvironment('GROK', source).GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(buildNativeCliProbeEnvironment('CODEX', source)).toEqual(buildNativeCliEnvironment('CODEX', source));
  });

  test('the model-list probe runs agy with the self-update off', async () => {
    const mocked = execFile as unknown as jest.Mock;
    mocked.mockImplementation((_command: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, 'gemini-3-pro\n', '');
      return { stdin: { end: () => undefined } };
    });
    await listAntigravityModelsFromCli();
    expect(mocked).toHaveBeenCalledTimes(1);
    const [command, args, options] = mocked.mock.calls[0];
    expect([command, args]).toEqual(['agy', ['models']]);
    expect(options.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
  });

  test('every place the backend runs agy outside a chat or login session uses the probe environment', () => {
    const files = sourceFiles(SRC);
    const direct: string[] = [];
    const sessionEnv: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const relative = path.relative(SRC, file);
      // Direct executions of the Antigravity binary.
      for (const match of text.matchAll(/exec(?:File|FileSync)\(\s*(?:'agy'|antigravityBin)\s*,/g)) {
        const call = text.slice(match.index!, match.index! + 400);
        direct.push(`${relative}:${/env: buildNativeCliProbeEnvironment\('GEMINI'\)/.test(call) ? 'probe' : 'OTHER'}`);
      }
      for (const _match of text.matchAll(/buildNativeCliEnvironment\('GEMINI'\)/g)) sessionEnv.push(relative);
    }
    expect(direct.sort()).toEqual([
      'agents/antigravityModels.ts:probe',
      'agents/nativeCliAuth.ts:probe',
      'services/oauthFlowManager.ts:probe',
      'services/oauthFlowManager.ts:probe',
    ]);
    // The one session-environment use left is the interactive login PTY.
    expect(sessionEnv).toEqual(['services/oauthFlowManager.ts']);
    const login = fs.readFileSync(path.join(SRC, 'services/oauthFlowManager.ts'), 'utf8');
    expect(login).toMatch(/spawnCredentialGatedPty\(antigravityBin[\s\S]{0,400}\.\.\.buildNativeCliEnvironment\('GEMINI'\)/);
    // Version reads (provider availability) and readiness probes (agy models) go through the probe environment too.
    const availability = fs.readFileSync(path.join(SRC, 'agents/providerAvailability.ts'), 'utf8');
    expect(availability).toContain("if (command === 'agy') return buildNativeCliProbeEnvironment('GEMINI');");
    const readiness = fs.readFileSync(path.join(SRC, 'agents/nativeProviderReadiness.ts'), 'utf8');
    expect(readiness).toMatch(/function execFileBounded[\s\S]{0,500}: buildNativeCliProbeEnvironment\(provider\)/);
    expect(readiness).not.toMatch(/buildNativeCliEnvironment\(/);
  });
});
