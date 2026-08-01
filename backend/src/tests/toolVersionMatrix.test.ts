import fs from 'fs';
import path from 'path';
import { getToolAdapter, SAFE_INSTALL_ALLOWLIST } from '../config/toolAdapters';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import { ANTIGRAVITY_PROJECT_CLI_VERSION } from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';

describe('Portal-tested native tool matrix', () => {
  test('uses exact install revisions and disables mutable self-updaters', () => {
    const codex = getToolAdapter('codex');
    const claude = getToolAdapter('claude-code');
    const antigravity = getToolAdapter('gemini');

    expect(codex?.install[0]?.command).toContain(`@openai/codex@${PORTAL_TOOL_VERSIONS.codexCli}`);
    expect(claude?.install[0]?.command).toContain(`@anthropic-ai/claude-code@${PORTAL_TOOL_VERSIONS.claudeCode}`);
    expect(antigravity?.install[0]?.command).toBe(
      'bash /opt/bridgesllm/portal/installer/antigravity-runtime.sh converge',
    );
    expect(antigravity?.detect?.command).toContain('AGY_CLI_DISABLE_AUTO_UPDATE=1');
    expect(antigravity?.commands.every((entry) => entry.command.includes('AGY_CLI_DISABLE_AUTO_UPDATE=1'))).toBe(true);
    expect(getToolAdapter('openclaw')?.install).toEqual([]);
    expect(ANTIGRAVITY_PROJECT_CLI_VERSION).toBe(PORTAL_TOOL_VERSIONS.antigravity);

    for (const command of [
      codex?.install[0]?.command,
      claude?.install[0]?.command,
      antigravity?.install[0]?.command,
    ]) {
      expect(command).toBeTruthy();
      expect(SAFE_INSTALL_ALLOWLIST.has(command as string)).toBe(true);
    }
  });

  test('keeps setup/admin install commands pinned to the same matrix', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'serverSetup.ts'), 'utf8');
    expect(source).toContain('@openai/codex@${PORTAL_TOOL_VERSIONS.codexCli}');
    expect(source).toContain('@anthropic-ai/claude-code@${PORTAL_TOOL_VERSIONS.claudeCode}');
    expect(source).toContain('/installer/antigravity-runtime.sh converge');
    expect(source).not.toMatch(/@latest|antigravity\.google\/cli\/install\.sh/);
  });

  test('does not retain obsolete Codex approval-mode flags', () => {
    const commands = getToolAdapter('codex')?.commands.map((entry) => entry.command).join('\n') || '';
    expect(commands).not.toContain('--approval-mode');
    expect(commands).toContain('--ask-for-approval on-request');
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
