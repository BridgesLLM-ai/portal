import {
  AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE,
  classifyAgentZeroError,
  safeAgentZeroErrorMessage,
  safeAgentZeroRuntimeEventMessage,
  safeAgentZeroStatusMessage,
} from '../agents/providers/agentZero/AgentZeroDiagnostics';
import { NativeProviderDiagnosticError } from '../agents/providers/native/NativeProviderDiagnostics';

describe('Agent Zero browser-safe diagnostics', () => {
  test('turns nested OpenRouter auth failures into one actionable message without raw JSON', () => {
    const raw = {
      heading: 'litellm.AuthenticationError',
      text: JSON.stringify({
        error: {
          message: 'OpenrouterException - No user or org id found in auth cookie',
          code: 401,
          cookie: 'session=private-cookie',
          api_key: 'sk-private-key',
        },
      }),
      meta: {
        traceback: 'Traceback: internal /root/.config/provider/credentials.json',
        authorization: 'Bearer private-token',
      },
    };

    const diagnostic = classifyAgentZeroError(raw);
    expect(diagnostic).toMatchObject({
      code: 'AUTH_REQUIRED',
      message: 'Agent Zero fell back to an OpenRouter default that is not connected instead of completing the selected OAuth-model request. Refresh the Agent Zero model list and reselect a model from a connected OAuth account, or reconnect the selected provider.',
    });
    const browserMessage = safeAgentZeroErrorMessage(raw);
    expect(browserMessage).toBe(diagnostic.message);
    expect(browserMessage).not.toMatch(/private|cookie=|api_key|traceback|\{|\}/i);
  });

  test('bounds and strips tracebacks from nonterminal status text', () => {
    const status = safeAgentZeroStatusMessage({
      heading: 'Retrying provider',
      text: `Temporary warning\nTraceback (most recent call last):\n${'secret-path '.repeat(500)}`,
      password: 'hidden-password',
    }, 160);

    expect(Buffer.byteLength(status, 'utf8')).toBeLessThanOrEqual(160);
    expect(status).toContain('Retrying provider');
    expect(status).not.toMatch(/traceback|secret-path|hidden-password/i);
  });

  test('turns provider exceptions mislabeled as utility events into safe actionable text', () => {
    const event = {
      heading: 'Memorize memories extension error',
      text: 'litellm.exceptions.APIConnectionError: OpenrouterException - OpenRouter API key is required. Set OPENROUTER_API_KEY environment variable.',
      meta: { traceback: '/a0/usr/private/path', authorization: 'Bearer private-token' },
    };

    const message = safeAgentZeroRuntimeEventMessage(event, 2_048);
    expect(message).toBe(AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE);
    expect(message).not.toMatch(/litellm|openrouterexception|OPENROUTER_API_KEY|traceback|private-token/i);
    expect(safeAgentZeroRuntimeEventMessage({ heading: 'Searching memories', text: 'Checking relevant context.' }))
      .toBe('Searching memories | Checking relevant context.');
  });

  test('preserves already-classified and already-safe actionable errors across gateway boundaries', () => {
    const classified = new NativeProviderDiagnosticError(
      'AUTH_REQUIRED',
      AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE,
      'stable-diagnostic-id',
    );

    expect(classifyAgentZeroError(classified)).toBe(classified);
    expect(safeAgentZeroErrorMessage(
      `Agent Zero run failed: ${AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE}`,
    )).toBe(AGENT_ZERO_OPENROUTER_FALLBACK_MESSAGE);
  });
});
