import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProjectChatProviderName } from '../../api/endpoints';
import {
  ProjectReplayContractError,
  resolveProjectReplayBatch,
} from './ProjectChatPanel';

function replaySnapshot(
  provider: ProjectChatProviderName,
  events: Array<{ seq: number; type: string; content?: string }>,
  lineCount: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    provider,
    sessionKey: `${provider.toLowerCase()}-session`,
    stateVersion: 7,
    lineCount,
    events,
    active: true,
    complete: false,
    ...overrides,
  };
}

function resolve(
  provider: ProjectChatProviderName,
  snapshot: ReturnType<typeof replaySnapshot>,
  afterSeq = 0,
  turnId: string | null = null,
) {
  return resolveProjectReplayBatch(snapshot, {
    provider,
    sessionKey: `${provider.toLowerCase()}-session`,
    minimumStateVersion: 7,
    afterSeq,
    turnId,
  });
}

describe('Project Chat durable replay transport', () => {
  it.each<ProjectChatProviderName>(['OPENCLAW', 'CODEX'])(
    'uses the same ordered, duplicate-free replay contract for %s',
    (provider) => {
      const batch = resolve(provider, replaySnapshot(provider, [
        { seq: 12, type: 'text', content: 'world' },
        { seq: 11, type: 'thinking', content: 'working' },
        { seq: 11, type: 'thinking', content: 'duplicate' },
        { seq: 10, type: 'text', content: 'overlap' },
      ], 12), 10);

      expect(batch.events.map((event) => event.seq)).toEqual([11, 12]);
      expect(batch.events[0].content).toBe('working');
      expect(batch.nextCursor).toBe(12);
    },
  );

  it('pages a replay beyond the 1,000-event server limit without skipping to lineCount', () => {
    const firstPage = resolve('OPENCLAW', replaySnapshot(
      'OPENCLAW',
      Array.from({ length: 1_000 }, (_, index) => ({ seq: index + 1, type: 'thinking' })),
      1_500,
    ));

    expect(firstPage.events).toHaveLength(1_000);
    expect(firstPage.nextCursor).toBe(1_000);

    const secondPage = resolve('OPENCLAW', replaySnapshot(
      'OPENCLAW',
      Array.from({ length: 500 }, (_, index) => ({ seq: index + 1_001, type: 'text' })),
      1_500,
    ), firstPage.nextCursor);

    expect(secondPage.events).toHaveLength(500);
    expect(secondPage.nextCursor).toBe(1_500);
  });

  it('fails closed on provider or verified-session mismatches', () => {
    expect(() => resolve('OPENCLAW', replaySnapshot('CODEX', [], 0))).toThrow(
      ProjectReplayContractError,
    );
    expect(() => resolve('OPENCLAW', replaySnapshot('OPENCLAW', [], 0, {
      sessionKey: 'different-session',
    }))).toThrow(/verified provider session/i);
  });

  it('allows a Codex session rekey only inside the exact verified durable turn', () => {
    const rekeyed = replaySnapshot('CODEX', [
      { seq: 1, type: 'status', content: 'working' },
    ], 1, {
      sessionKey: 'resolved-codex-thread',
      runId: 'turn-123',
    });

    expect(resolve('CODEX', rekeyed, 0, 'turn-123').sessionKey).toBe('resolved-codex-thread');
    expect(() => resolve('CODEX', rekeyed, 0, 'different-turn')).toThrow(/verified active turn/i);
  });

  it('rejects stale coordination state and replay sequence gaps', () => {
    expect(() => resolve('OPENCLAW', replaySnapshot('OPENCLAW', [], 0, {
      stateVersion: 6,
    }))).toThrow(/coordination version/i);
    expect(() => resolve('OPENCLAW', replaySnapshot('OPENCLAW', [
      { seq: 1, type: 'thinking' },
      { seq: 3, type: 'text' },
    ], 3))).toThrow(/sequence gap/i);
    expect(() => resolve('OPENCLAW', replaySnapshot('OPENCLAW', [], 1))).toThrow(
      /omitted events/i,
    );
  });

  it('contains no privileged Project Chat WebSocket or gateway history fallback', () => {
    const source = readFileSync(new URL('./ProjectChatPanel.tsx', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\bnew WebSocket\b/);
    expect(source).not.toContain('wsRef');
    expect(source).not.toContain('/gateway/ws');
    expect(source).not.toContain('/gateway/history');
    expect(source).not.toContain('/gateway/stream-status');
    expect(source).not.toContain("selectedProvider === 'OPENCLAW' || !sessionReady || !isRunning");
    expect(source).toContain('projectsAPI.agentPoll');
    expect(source).toContain("headers.get('retry-after')");
    expect(source).toContain('pollBlockedUntil - Date.now()');
    expect(source).toContain('Portal replay is rate limited');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('aria-atomic="true"');
    expect(source).toContain('projectsAPI.agentAbort(projectName, provider, stateVersion)');
  });

  it('owns replay retry cadence instead of multiplying 429s in the shared API client', () => {
    const endpointSource = readFileSync(new URL('../../api/endpoints.ts', import.meta.url), 'utf8');
    const clientSource = readFileSync(new URL('../../api/client.ts', import.meta.url), 'utf8');
    const pollStart = endpointSource.indexOf('agentPoll: async (');
    const abortStart = endpointSource.indexOf('agentAbort: async (', pollStart);
    const pollEndpoint = endpointSource.slice(pollStart, abortStart);

    expect(pollStart).toBeGreaterThan(-1);
    expect(abortStart).toBeGreaterThan(pollStart);
    expect(pollEndpoint).toContain('_skipNetworkRetry: true');
    expect(pollEndpoint).toContain('_silent: true');
    expect(clientSource).toContain('!originalRequest._skipNetworkRetry');
  });

  it('encodes the project as one path segment for resume, ensure, and reset', () => {
    const source = readFileSync(new URL('./ProjectChatPanel.tsx', import.meta.url), 'utf8');

    expect(source).toContain('`/projects/${encodeURIComponent(projectName)}/assistant/resume-session`');
    expect(source).toContain('`/projects/${encodeURIComponent(projectName)}/assistant/ensure-session`');
    expect(source).toContain('`/projects/${encodeURIComponent(projectName)}/assistant/reset`');
    expect(source).not.toMatch(/`\/projects\/\$\{projectName\}\/assistant\//);
  });

  it('keeps Project Chat attachments inside the project sandbox contract', () => {
    const source = readFileSync(new URL('./ProjectChatPanel.tsx', import.meta.url), 'utf8');

    expect(source).toContain('/assistant/attachments');
    expect(source).toContain('projectPath');
    expect(source).toContain('project_path:');
    expect(source).not.toContain('/api/files/');
    expect(source).not.toMatch(/\b(?:diskPath|originalDiskPath|serverPath|toolUrl)\b/);
    expect(source).not.toMatch(/(?:server_path|tool_url|portal_url):/);
  });
});
