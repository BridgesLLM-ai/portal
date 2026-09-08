import fs from 'fs';
import path from 'path';
import { getToolAdapter, SAFE_INSTALL_ALLOWLIST } from '../config/toolAdapters';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import { ANTIGRAVITY_PROJECT_CLI_VERSION } from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';

describe('Portal-tested native tool matrix', () => {
  test('keeps native host acquisition unavailable and disables mutable self-updaters', () => {
    const codex = getToolAdapter('codex');
    const claude = getToolAdapter('claude-code');
    const antigravity = getToolAdapter('gemini');

    expect(codex).toMatchObject({ install: [], commands: [] });
    expect(claude).toMatchObject({ install: [], commands: [] });
    expect(codex).not.toHaveProperty('managedInstall');
    expect(claude).not.toHaveProperty('managedInstall');
    expect(antigravity?.install).toEqual([]);
    expect(antigravity?.detect?.command).toBe("test -x /usr/local/bin/agy && printf '%s\\n' detected");
    expect(antigravity?.commands).toEqual([]);
    expect(antigravity?.description).toContain('detection-only');
    expect(getToolAdapter('openclaw')?.install).toEqual([]);
    expect(ANTIGRAVITY_PROJECT_CLI_VERSION).toBe(PORTAL_TOOL_VERSIONS.antigravity);

    expect([...SAFE_INSTALL_ALLOWLIST].some((command) => command.includes('antigravity-runtime.sh'))).toBe(false);
  });

  test('keeps admitted host identities in the immutable catalog and raw browser install commands absent', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'serverSetup.ts'), 'utf8');
    const adapters = fs.readFileSync(path.join(__dirname, '..', 'config', 'toolAdapters.ts'), 'utf8');
    const catalog = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'config', 'nativeHostCliAdmissionCatalog.v1.json'),
      'utf8',
    ));
    const catalogTools = catalog.tools;
    expect(catalogTools.codex.versions[PORTAL_TOOL_VERSIONS.codexCli].admission).toBe('full');
    expect(catalogTools['claude-code'].versions[PORTAL_TOOL_VERSIONS.claudeCode].admission).toBe('full');
    expect(catalogTools.clawhub.versions[PORTAL_TOOL_VERSIONS.clawhub].admission).toBe('full');
    expect(catalogTools.codex.versions['0.145.0'].admission).toBe('full');
    expect(catalogTools['claude-code'].versions['2.1.220'].admission).toBe('full');
    expect(catalogTools.clawhub.versions['0.23.1'].admission).toBe('status-only');
    expect(`${source}\n${adapters}`).not.toMatch(/npm install[^\n]*(?:@openai\/codex|@anthropic-ai\/claude-code)/);
    expect(source).not.toContain('/installer/antigravity-runtime.sh converge');
    expect(adapters).not.toContain('/installer/antigravity-runtime.sh converge');
    expect(source).not.toMatch(/@latest|antigravity\.google\/cli\/install\.sh/);
  });

  test('does not retain obsolete Codex approval-mode flags', () => {
    const commands = getToolAdapter('codex')?.commands.map((entry) => entry.command).join('\n') || '';
    expect(commands).not.toContain('--approval-mode');
    expect(commands).toBe('');
  });

  test('keeps automatic Ollama detection and local commands off inherited proxy authority', () => {
    const ollama = getToolAdapter('ollama');
    expect(ollama?.description).toContain('Owner-only Tailnet wizard');
    expect(ollama?.detect?.command).toContain('/usr/bin/env -i');
    expect(ollama?.detect?.command).toContain('OLLAMA_HOST=http://127.0.0.1:11434');
    expect(ollama?.detect?.command).toContain('timeout 2s ollama --version');

    for (const command of ollama?.commands || []) {
      expect(command.command).toContain('OLLAMA_HOST=http://127.0.0.1:11434');
      expect(command.command).toContain('-u HTTP_PROXY');
      expect(command.command).toContain('NO_PROXY="*"');
    }
  });

  test('offers a bounded repair adapter for the shared animated GIF media tools', () => {
    const ffmpeg = getToolAdapter('ffmpeg');
    expect(ffmpeg?.name).toBe('Media Processing (FFmpeg)');
    expect(ffmpeg?.detect?.command).toContain('ffmpeg -version');
    expect(ffmpeg?.detect?.command).toContain('ffprobe -version');
    expect(ffmpeg?.install).toHaveLength(1);
    expect(ffmpeg?.install[0]?.command).toContain('install -y -qq ffmpeg');
    expect(SAFE_INSTALL_ALLOWLIST).toContain(ffmpeg?.install[0]?.command);
  });
});
