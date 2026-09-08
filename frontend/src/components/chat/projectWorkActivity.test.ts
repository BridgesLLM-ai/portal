import { describe, it, expect } from 'vitest';
import { projectWorkActivity } from './projectWorkActivity';
import type { RuntimeTurnEvent } from '../../utils/runtimeTurnEvents';
const created = '2026-09-07T10:00:00Z';
const event = (seq: number, extra: Partial<RuntimeTurnEvent>): RuntimeTurnEvent => ({ schema: 'bridgesllm.runtime-turn-event.v1', type: 'assistant_delta', runId: 'run', sessionKey: 'work', seq, ts: seq * 100, visible: true, ...extra });
describe('conversational project activity', () => {
  it('keeps notes, real tool arguments/results and exact response whitespace in order', () => {
    const items = projectWorkActivity([
      event(1, { type: 'assistant_reasoning', text: 'Checking ' }), event(2, { type: 'assistant_reasoning', text: 'the form.' }),
      event(3, { type: 'tool_started', tool: { id: 't', name: 'read', status: 'running', arguments: { path: 'index.html' } } }),
      event(4, { type: 'tool_output', tool: { id: 't', name: 'read', status: 'done', result: '<h1>Studio</h1>' } }),
      event(5, { text: 'All ' }), event(6, { text: 'done.' }), event(7, { type: 'assistant_final', text: 'All done.' }),
      event(8, { visible: false, text: 'not public' }),
    ], '', created);
    expect(items.map(i => i.kind)).toEqual(['reasoning', 'tool', 'text']);
    expect(items[0].content).toBe('Checking the form.');
    expect(items[1].tool).toMatchObject({ arguments: { path: 'index.html' }, result: '<h1>Studio</h1>', status: 'done' });
    expect(items[2].content).toBe('All done.');
    expect(JSON.stringify(items)).not.toContain('not public');
  });
  it('replaces cumulative notes and does not repeat commentary in a cumulative final reply', () => {
    const items = projectWorkActivity([
      event(1, { type: 'assistant_reasoning', text: 'First', replace: true }), event(2, { type: 'assistant_reasoning', text: 'Second', replace: true }),
      event(3, { text: 'I will inspect.\n' }), event(4, { type: 'tool_started', tool: { id: 't', name: 'read' } }),
      event(5, { text: 'Done.' }), event(6, { type: 'assistant_final', text: 'I will inspect.\nDone.' }),
    ], '', created);
    expect(items[0].content).toBe('Second');
    expect(items.filter(i => i.kind === 'text').map(i => i.content).join('')).toBe('I will inspect.\nDone.');
  });
  it('uses the persisted response for older cards without fabricating tools', () => {
    const items = projectWorkActivity([{ name: 'read' } as any], 'Saved answer', created);
    expect(items).toHaveLength(1); expect(items[0].kind).toBe('text');
    expect(items[0].content).toBe('Saved answer'); expect(Number.isFinite(items[0].at)).toBe(true);
  });
});
