import { extractClaudeAuthUrl, extractClaudeSetupToken, normalizeTerminalScreenText, squashPromptText } from '../services/oauthFlowManager';

describe('oauthFlowManager terminal parsing', () => {
  test('squashes screen-control fragments that render prompts one glyph per line', () => {
    const raw = 'P\r[2m\na\r[2m\ns\r[2m\nt\r[2m\ne\r[2m\n';
    expect(normalizeTerminalScreenText(raw)).toContain('P');
    expect(squashPromptText(raw)).toBe('paste');
  });

  test('extracts Claude setup tokens from screen-normalized PTY output', () => {
    const raw = 'Done!\r\nsetup token:\r\nsk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890+/=\r\n';
    expect(extractClaudeSetupToken(raw)).toBe('sk-ant-oat01-abcdefghijklmnopqrstuvwxyz1234567890+/=');
  });

  test('extracts wrapped Claude auth URLs from PTY output', () => {
    const raw = [
      'Open this URL in your browser:',
      'https://claude.ai/oauth/authorize?code=true&',
      'state=abc123',
      'Paste code here if prompted >',
    ].join('\r\n');

    expect(extractClaudeAuthUrl(raw)).toBe('https://claude.ai/oauth/authorize?code=true&state=abc123');
  });
});
