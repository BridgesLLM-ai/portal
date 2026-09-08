import type { ChatMessage } from '../contexts/ChatStateProvider';

export interface ChatTask {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';
  detail?: string | null;
  parentSession?: string | null;
  sessionKey?: string | null;
}

function taskStatus(value: unknown): ChatTask['status'] {
  const status = String(value || '').toLowerCase().replace(/[- ]/g, '_');
  if (['completed', 'complete', 'done'].includes(status)) return 'done';
  if (['in_progress', 'running', 'active'].includes(status)) return 'running';
  if (['pending', 'queued', 'todo', 'not_started'].includes(status)) return 'pending';
  if (['error', 'failed'].includes(status)) return 'failed';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  return 'unknown';
}

/** Native plans are snapshots reported by the harness, not inferred from prose. */
export function latestChatPlan(messages: ChatMessage[]): ChatTask[] {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const calls = messages[m].toolCalls || [];
    for (let t = calls.length - 1; t >= 0; t -= 1) {
      const call = calls[t];
      if (call.status === 'error') continue;
      const name = call.name.toLowerCase().replace(/^.*[./:]/, '').replace(/_/g, '');
      if (!['updateplan', 'todowrite', 'writeplan', 'plan'].includes(name)) continue;
      let args = call.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
      const items = args?.plan ?? args?.todos ?? args?.entries;
      if (!Array.isArray(items)) continue;
      return items.slice(0, 100).flatMap((item, i) => {
        const name = item?.step ?? item?.content ?? item?.title ?? item?.description;
        if (typeof name !== 'string' || !name.trim()) return [];
        return [{ id: String(item.id || call.id + ':' + i), name: name.slice(0, 500), status: taskStatus(item.status) }];
      });
    }
  }
  return [];
}

export function sessionTasks(tasks: ChatTask[], session: string): ChatTask[] {
  return tasks.filter(task => task.parentSession === session || task.sessionKey === session);
}

export function taskCounts(tasks: ChatTask[]) {
  return {
    total: tasks.length,
    done: tasks.filter(t => t.status === 'done').length,
    outstanding: tasks.filter(t => t.status === 'running' || t.status === 'pending').length,
  };
}
