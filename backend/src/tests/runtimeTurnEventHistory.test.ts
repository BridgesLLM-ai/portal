import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __runtimeTurnEventHistoryTest,
  readRuntimeTurnEvents,
  recordRuntimeTurnEvent,
} from '../services/RuntimeTurnEventHistory';
import type { RuntimeTurnEvent } from '../services/RuntimeTurnEvents';

function runtimeEvent(
  sessionKey: string,
  runId: string,
  seq: number,
  type: RuntimeTurnEvent['type'],
  text?: string,
): RuntimeTurnEvent {
  const sourceEventType = type === 'tool_output'
    ? 'tool_end'
    : (type === 'turn_done' || type === 'turn_error' ? 'done' : 'text');
  return {
    schema: 'bridgesllm.runtime-turn-event.v1',
    type,
    sessionKey,
    runId,
    seq,
    ts: 1_780_000_000_000 + seq,
    visible: true,
    source: { transport: 'portal-stream-event-bus', eventType: sourceEventType },
    ...(text !== undefined ? { text } : {}),
  };
}

describe('runtime turn event history bounds', () => {
  const originalDir = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
  const originalMaxBytes = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_BYTES;
  const originalMaxReadBytes = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_READ_BYTES;
  const originalMaxAge = process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_AGE_MS;

  afterEach(() => {
    if (originalDir === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR;
    else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = originalDir;
    if (originalMaxBytes === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_BYTES;
    else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_BYTES = originalMaxBytes;
    if (originalMaxReadBytes === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_READ_BYTES;
    else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_READ_BYTES = originalMaxReadBytes;
    if (originalMaxAge === undefined) delete process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_AGE_MS;
    else process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_AGE_MS = originalMaxAge;
  });

  test('reads only the newest complete JSONL records from a bounded tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-tail-'));
    const filePath = path.join(dir, 'events.jsonl');
    const lines = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({ index, value: 'x'.repeat(40) }));
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

    const tail = __runtimeTurnEventHistoryTest.readJsonlTail(filePath, 5, 4096);
    expect(tail.map((line) => JSON.parse(line).index)).toEqual([4995, 4996, 4997, 4998, 4999]);
  });

  test('rotates at a run boundary and replays the rotated and active tails together', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-rotate-'));
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_DIR = dir;
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_BYTES = '1024';
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_READ_BYTES = String(1024 * 1024);
    process.env.PORTAL_RUNTIME_TURN_EVENT_HISTORY_MAX_AGE_MS = String(24 * 60 * 60 * 1000);

    const sessionKey = 'agent:main:bounded-runtime-history';
    for (let seq = 0; seq < 12; seq += 1) {
      recordRuntimeTurnEvent(sessionKey, runtimeEvent(sessionKey, 'run-one', seq, 'tool_output', `result-${seq}-${'y'.repeat(160)}`));
    }
    recordRuntimeTurnEvent(sessionKey, runtimeEvent(sessionKey, 'run-one', 12, 'turn_done'));

    const activePath = __runtimeTurnEventHistoryTest.historyPathForSession(sessionKey, dir);
    expect(fs.existsSync(`${activePath}.1`)).toBe(true);

    recordRuntimeTurnEvent(sessionKey, runtimeEvent(sessionKey, 'run-two', 13, 'assistant_delta', 'new run text'));
    const replayed = readRuntimeTurnEvents(sessionKey, 100);
    expect(replayed.some((event) => event.runId === 'run-one' && event.type === 'turn_done')).toBe(true);
    expect(replayed.some((event) => event.runId === 'run-two' && event.text === 'new run text')).toBe(true);
    expect(replayed.at(-1)?.runId).toBe('run-two');
  });
});
