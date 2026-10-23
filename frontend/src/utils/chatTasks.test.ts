import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '../contexts/ChatStateProvider';
import { latestChatPlan } from './chatTasks';

const message = (toolCalls: ToolCall[]): ChatMessage => ({ id: 'm1', role: 'assistant', content: '', createdAt: new Date(0), toolCalls });
const call = (name: string, args: unknown, status: ToolCall['status'] = 'done'): ToolCall => ({ id: `${name}-1`, name, arguments: args, status, startedAt: 1 });

describe('latest chat plan reported by any harness', () => {
  it('reads Codex and ACP update_plan, Claude TodoWrite and Gemini write_todos', () => {
    expect(latestChatPlan([message([call('update_plan', { plan: [{ step: 'Reproduce', status: 'completed' }, { step: 'Fix', status: 'in_progress' }] })])])
      .map((task) => [task.name, task.status])).toEqual([['Reproduce', 'done'], ['Fix', 'running']]);
    expect(latestChatPlan([message([call('TodoWrite', { todos: [{ content: 'Ship', status: 'pending' }] })])])
      .map((task) => task.name)).toEqual(['Ship']);
    expect(latestChatPlan([message([call('write_todos', { todos: [{ description: 'Test', status: 'completed' }] })])])
      .map((task) => [task.name, task.status])).toEqual([['Test', 'done']]);
  });

  it('uses the newest successful plan', () => {
    const older = message([call('update_plan', { plan: [{ step: 'Old', status: 'pending' }] })]);
    const failed = message([call('update_plan', { plan: [{ step: 'Broken', status: 'pending' }] }, 'error')]);
    expect(latestChatPlan([older, failed]).map((task) => task.name)).toEqual(['Old']);
  });
});
