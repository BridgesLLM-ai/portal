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

  test('keeps Portal Grok tooling status-only until native-artifact transactions ship', () => {
    const adapter = getToolAdapter('grok-build');
    expect(adapter).toBeDefined();
    expect(adapter?.install).toEqual([]);
    expect([...SAFE_INSTALL_ALLOWLIST].some((command) => command.includes('grok-build-runtime.sh'))).toBe(false);
    expect([...SAFE_INSTALL_ALLOWLIST].some((command) => command.includes('x.ai/cli/install.sh'))).toBe(false);
  });

  test('keeps maintenance detection non-executing while explaining supported host chats', () => {
    const adapter = getToolAdapter('grok-build');
    expect(adapter?.detect?.command).toBe("test -x /usr/local/bin/grok && printf '%s\\n' detected");
    expect(adapter?.commands).toEqual([]);
    expect(adapter?.description).toContain('Host Operator chats are supported');
    expect(adapter?.description).toContain('Project Sandbox execution is not available');
  });
});
