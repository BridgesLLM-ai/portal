// E3: where the Portal reads a user turn's chat.send idempotency key. Real
// OpenClaw 10.6 history (TEST receipt native/chat-history-after-ui.json, 14 of
// 14 user messages) carries it both top-level and under __openclaw, and never
// under `metadata`; 10.9 keeps the message's own key and attaches __openclaw
// (static reading). The signed response-preference envelope projects back to
// the authored text only through those two locations.
jest.mock('../config/env', () => ({ config: { nodeEnv: 'test', openclawApiUrl: 'http://localhost:18789', jwtSecret: 'e3-regression-secret' } }));
jest.mock('../config/database', () => ({ prisma: {} }));

import fs from 'fs';
import path from 'path';
import { __gatewayHistoryTest } from '../routes/gateway';
import { __openClawProviderTest } from '../agents/providers/OpenClawProvider';
import { signPortalResponseContext } from '../services/portalResponseContext';

const KEY = 'portal-direct-3c9f:client:message-7';
const AUTHORED = 'Build me a counter widget';
const SIGNED = signPortalResponseContext(AUTHORED, `[Portal response preference]\nPrefer a widget.\n\n${AUTHORED}`, KEY);

function userMessage(keys: Record<string, unknown>): Record<string, unknown> {
  return { role: 'user', content: [{ type: 'text', text: SIGNED }], timestamp: 1_761_800_000_000, ...keys };
}

const projectors: Array<[string, (message: any) => string | null]> = [
  ['gateway history route', (message) => {
    const projected = __gatewayHistoryTest.projectOpenClawGatewayHistoryMessage(message);
    return typeof projected?.content === 'string' ? projected.content : null;
  }],
  ['OpenClaw provider history', (message) => {
    const projected = __openClawProviderTest.projectGatewayHistoryMessage(message, 0);
    return typeof projected?.content === 'string' ? projected.content : null;
  }],
];

describe.each(projectors)('E3 idempotency key location (%s)', (_label, project) => {
  test('the real 10.6 shape: top-level and __openclaw, no metadata', () => {
    expect(project(userMessage({ idempotencyKey: KEY, __openclaw: { id: 'm-1', idempotencyKey: KEY } }))).toBe(AUTHORED);
  });

  test('either location alone is enough', () => {
    expect(project(userMessage({ idempotencyKey: KEY }))).toBe(AUTHORED);
    expect(project(userMessage({ __openclaw: { id: 'm-1', idempotencyKey: KEY } }))).toBe(AUTHORED);
    // OpenClaw echoes the user turn under `<send key>:user`.
    expect(project(userMessage({ __openclaw: { id: 'm-1', idempotencyKey: `${KEY}:user` } }))).toBe(AUTHORED);
  });

  test('no speculative fallback: metadata or a foreign run key shows the turn as sent', () => {
    for (const keys of [
      { metadata: { idempotencyKey: KEY } },
      { __openclaw: { id: 'm-1', idempotencyKey: 'run-0f2a:user' } },
      {},
    ]) {
      const shown = project(userMessage(keys));
      expect(shown).not.toBe(AUTHORED);
      expect(shown).toContain('Portal response context v1');
    }
  });
});

test('the live session.message path reads the same two locations', () => {
  // PersistentGatewayWs publishes live user echoes from an internal handler;
  // pin its read expression so the three sites cannot drift apart.
  const source = fs.readFileSync(path.join(__dirname, '../agents/providers/PersistentGatewayWs.ts'), 'utf8');
  expect(source).toContain('message?.idempotencyKey ?? message?.__openclaw?.idempotencyKey');
});
