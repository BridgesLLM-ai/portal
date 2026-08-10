import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stateSource = readFileSync(new URL('./ChatStateProvider.tsx', import.meta.url), 'utf8');
const interfaceSource = readFileSync(new URL('../components/chat/ChatInterface.tsx', import.meta.url), 'utf8');

describe('Agent Chat transport and cancellation contract', () => {
  it('owns SSE as a distinct abortable transport and performs token-scoped WS handoff', () => {
    expect(stateSource).toContain("type ChatStreamTransport = 'portal' | 'direct' | 'sse'");
    expect(stateSource).toContain('signal: activeSse.controller.signal');
    expect(stateSource).toContain('streamClientId: activeSse.streamClientId');
    expect(stateSource).toContain("stopActiveSseTransportRef.current('handoff')");
    expect(stateSource).toContain('!activeSse.sessionResolved');
    expect(stateSource).toContain('sessionRef.current = evt.sessionId');
    expect(stateSource).toContain("streamTransportRef.current = 'portal'");
  });

  it('waits for correlated WS abort acknowledgement and preserves UI without confirmation', () => {
    expect(stateSource).toContain('const requestId = nextAbortRequestId()');
    expect(stateSource).toContain("if (data?.type === 'abort_result')");
    expect(stateSource).toContain('pending.resolve(data.ok === true)');
    expect(stateSource).toContain('WS_ABORT_RESULT_TIMEOUT_MS');
    expect(stateSource).toContain("if (!confirmed) {");
    expect(stateSource).toContain('Stop was not confirmed; preserving the active turn UI');
    expect(stateSource).toContain('settleCancelledTurn(runId, currentSession)');
  });

  it('treats session navigation as a transport detach, never an implicit run abort', () => {
    const selectSessionStart = stateSource.indexOf('const selectSession = useCallback');
    const selectSessionEnd = stateSource.indexOf('// Refresh: reload history', selectSessionStart);
    const selectSessionSource = stateSource.slice(selectSessionStart, selectSessionEnd);
    expect(selectSessionSource).toContain("await stopActiveSseTransportRef.current('handoff')");
    expect(selectSessionSource).not.toContain('cancelStream');
    expect(selectSessionSource).not.toContain("type: 'abort'");

    const startNewSessionStart = interfaceSource.indexOf('const startNewSession = useCallback');
    const startNewSessionEnd = interfaceSource.indexOf('// Model change handler', startNewSessionStart);
    const startNewSessionSource = interfaceSource.slice(startNewSessionStart, startNewSessionEnd);
    expect(startNewSessionSource).toContain('await chatState.selectSession(resolvedSessionKey)');
    expect(startNewSessionSource).not.toContain('cancelRunning');
    expect(startNewSessionSource).not.toContain('cancelStream');
  });

  it('routes aborted done and failed SSE tools through shared settlement helpers', () => {
    expect(stateSource).toContain('if (isAbortedDoneEvent(data))');
    expect(stateSource).toContain('if (isAbortedDoneEvent(evt))');
    expect(stateSource).toContain('status: resolveToolCompletionStatus(evt)');
    expect(stateSource).toContain('selectSnapshotReasoningEvents(snapshotTurnEvents, snapshotRunId)');
  });

  it('keeps Ollama stoppable while hiding Stop for Agent Zero', () => {
    expect(interfaceSource).toContain('isRunning && supportsAgentChatStop(provider)');
  });

  it('routes blank model selections through the session-model contract instead of short-circuiting reset', () => {
    expect(stateSource).toContain('applyAgentChatSessionModel({');
    expect(stateSource).toContain('patchSessionModel: gatewayAPI.patchSessionModel');
    expect(stateSource).not.toContain("if (!m) return { deferred: false }");
  });

  it('moves only typed launch-bound model changes to a clean new session', () => {
    expect(interfaceSource).toContain('if (isAgentChatLaunchBoundModelError(err))');
    expect(interfaceSource).toContain('await startNewSession();');
    expect(interfaceSource).toContain('setModelSelectionNotice(`${providerLabel} applies model changes when a session starts.');
  });

  it('reconciles every bus-backed native provider after terminal or watchdog recovery', () => {
    expect(stateSource).toContain('if (providerRef.current !== \'OPENCLAW\') return 2 * 60_000;');
    expect(stateSource).toContain('if (providerUsesPortalStreamBus(targetProvider))');
    expect(stateSource).toContain('const shouldReloadHistoryIfIdle = Boolean(streamingAssistantIdRef.current)');
    expect(stateSource).toContain('if (providerUsesPortalStreamBus(providerRef.current)');
  });
});
