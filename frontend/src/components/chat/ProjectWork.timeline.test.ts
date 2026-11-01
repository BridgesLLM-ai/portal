// @vitest-environment jsdom
import '../../test/setup';
import { describe, expect, it } from 'vitest';
import { mergeProjectWorkTimeline, type WorkCard } from './ProjectWork';

const card = (createdAt: string): WorkCard => ({
  id: 'work-1', originProvider: 'OPENCLAW', originSessionKey: 'agent:main:test',
  projectIdentityId: 'project-1', projectGeneration: 1, provider: 'OPENCLAW',
  prompt: 'Edit project', projectName: 'demo', model: null, createdAt, parentCardId: null,
  projectIdentity: { projectName: 'demo', generation: 1, lifecycleStatus: 'ACTIVE' },
  scopeValid: true, turn: { id: 'turn-1', status: 'RUNNING' },
});

describe('mixed chat and project-work chronology', () => {
  it('never reorders the authoritative transcript even when its timestamps run backward', () => {
    const messages = [
      { id: 'prompt', createdAt: new Date(120_000) },
      { id: 'response', createdAt: new Date(1_000) },
      { id: 'follow-up', createdAt: new Date(121_000) },
    ];
    const result = mergeProjectWorkTimeline(messages, []);
    expect(result.map(row => row.kind === 'message' ? row.message.id : row.kind))
      .toEqual(['prompt', 'response', 'follow-up']);
    expect(result[0].kind === 'message' && result[0].message).toBe(messages[0]);
  });

  it('inserts project work without sorting messages across a clock boundary', () => {
    const messages = [
      { id: 'first', createdAt: new Date(1_000) },
      { id: 'prompt', createdAt: new Date(3_000) },
      { id: 'response', createdAt: new Date(500) },
      { id: 'follow-up', createdAt: new Date(4_000) },
    ];
    const result = mergeProjectWorkTimeline(messages, [card(new Date(2_000).toISOString())]);
    expect(result.map(row => row.kind === 'message' ? row.message.id : row.kind))
      .toEqual(['first', 'work', 'prompt', 'response', 'follow-up']);
    expect(messages.map(row => row.id)).toEqual(['first', 'prompt', 'response', 'follow-up']);
  });

  it('retains transcript order and stable message-first ties with work at the same timestamp', () => {
    const messages = [
      { id: 'repeat-1', createdAt: new Date(1_000) },
      { id: 'repeat-2', createdAt: new Date(1_000) },
    ];
    const result = mergeProjectWorkTimeline(messages, [card(new Date(1_000).toISOString())]);
    expect(result.map(row => row.kind === 'message' ? row.message.id : row.kind))
      .toEqual(['repeat-1', 'repeat-2', 'work']);
  });
});
