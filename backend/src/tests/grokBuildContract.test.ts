import fs from 'fs';
import path from 'path';
import { getToolAdapter, SAFE_INSTALL_ALLOWLIST } from '../config/toolAdapters';

describe('Grok Build operator tooling contract', () => {
  test('terminal metadata stamps the exact native provider identity', () => {
    // The provider hard-constructs its broker, so the terminal-metadata
    // projection is asserted as a source contract in the style of the other
    // Grok tooling checks. The broker suite separately proves agentVersion and
    // numeric protocolVersion flow through a real prompt result.
    const source = fs.readFileSync(
      path.join(__dirname, '../agents/providers/GrokProvider.ts'),
      'utf8',
    );
    expect(source).toMatch(/provider:\s*'grok-build-cli'/);
    expect(source).toMatch(/transport:\s*'acp-stdio'/);
    expect(source).toMatch(/agentVersion:\s*result\.agentVersion/);
    expect(source).toMatch(/protocolVersion:\s*result\.protocolVersion/);
    expect(source).toMatch(/grokAcpAgentVersion:\s*result\.agentVersion/);
    expect(source).toMatch(/grokAcpProtocolVersion:\s*result\.protocolVersion/);
  });

  test('uses only the checksum-verified Portal lifecycle helper for installation', () => {
    const adapter = getToolAdapter('grok-build');
    expect(adapter).toBeDefined();
    expect(adapter?.install).toEqual([
      expect.objectContaining({
        command: 'bash /opt/bridgesllm/portal/installer/grok-build-runtime.sh converge',
      }),
    ]);
    expect(SAFE_INSTALL_ALLOWLIST).toContain(adapter?.install[0]?.command);
    expect([...SAFE_INSTALL_ALLOWLIST].some((command) => command.includes('x.ai/cli/install.sh'))).toBe(false);
  });

  test('suppresses self-updates in every Portal-owned Grok command', () => {
    const adapter = getToolAdapter('grok-build');
    const commands = [adapter?.detect?.command, ...(adapter?.commands.map((entry) => entry.command) || [])];
    expect(commands.length).toBeGreaterThan(1);
    for (const command of commands) {
      expect(command).toMatch(/^GROK_DISABLE_AUTOUPDATER=1 grok --no-auto-update(?:\s|$)/);
    }
  });
});
