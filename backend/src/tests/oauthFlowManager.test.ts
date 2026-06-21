import {
  extractClaudeAuthUrl,
  extractClaudeSetupToken,
  getOpenClawOAuthProviderId,
  googleGeminiCliProfileHasUsableCredential,
  normalizeTerminalScreenText,
  outputLooksLikeClaudeCliAuthImportSuccess,
  squashPromptText,
  textContainsCallbackPastePrompt,
} from '../services/oauthFlowManager';

describe('oauthFlowManager terminal parsing', () => {
  test('squashes screen-control fragments that render prompts one glyph per line', () => {
    const raw = 'P\r[2m\na\r[2m\ns\r[2m\nt\r[2m\ne\r[2m\n';
    expect(normalizeTerminalScreenText(raw)).toContain('P');
    expect(squashPromptText(raw)).toBe('paste');
  });

  test('detects OpenClaw Codex callback prompts rendered one glyph per line', () => {
    const raw = [
      'P', 'a', 's', 't', 'e', ' ', 't', 'h', 'e', ' ',
      'a', 'u', 't', 'h', 'o', 'r', 'i', 'z', 'a', 't', 'i', 'o', 'n', ' ',
      'c', 'o', 'd', 'e', ' ', '(', 'o', 'r', ' ', 'f', 'u', 'l', 'l', ' ',
      'r', 'e', 'd', 'i', 'r', 'e', 'c', 't', ' ', 'U', 'R', 'L', ')', ':',
    ].join('\n');

    expect(textContainsCallbackPastePrompt(raw)).toBe(true);
  });

  test('extracts Claude setup tokens from screen-normalized PTY output', () => {
    const fakeToken = ['sk', 'ant', 'oat01', 'abcdefghijklmnopqrstuvwxyz1234567890+/='].join('-');
    const raw = `Done!\r\nsetup token:\r\n${fakeToken}\r\n`;
    expect(extractClaudeSetupToken(raw)).toBe(fakeToken);
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

  test('maps Portal Codex setup to OpenClaw 2026.6 auth provider id', () => {
    expect(getOpenClawOAuthProviderId('openai-codex')).toBe('openai');
    expect(getOpenClawOAuthProviderId('google-gemini-cli')).toBe('google-gemini-cli');
  });

  test('requires reusable credential material for Gemini CLI OAuth profiles', () => {
    expect(googleGeminiCliProfileHasUsableCredential({ type: 'oauth' })).toBe(false);
    expect(googleGeminiCliProfileHasUsableCredential({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3600_000,
    })).toBe(true);
    expect(googleGeminiCliProfileHasUsableCredential({ type: 'api_key', key: 'AIza-test' })).toBe(true);
  });

  test('accepts Claude CLI auth import output even when wrapper exits non-zero', () => {
    const raw = [
      'Updated config: ~/.openclaw/openclaw.json',
      'Auth profile: anthropic:claude-cli (claude-cli/oauth)',
      'Default model available: anthropic/claude-opus-4-8 (use --set-default to apply)',
      'Claude CLI auth detected; kept Anthropic model refs and selected the local Claude CLI runtime.',
    ].join('\n');

    expect(outputLooksLikeClaudeCliAuthImportSuccess(raw)).toBe(true);
  });
});
