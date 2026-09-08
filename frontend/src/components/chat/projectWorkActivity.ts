import type { RuntimeTurnEvent, RuntimeTurnEventTool } from '../../utils/runtimeTurnEvents';

export interface WorkActivity {
  id: string;
  kind: 'text' | 'reasoning' | 'tool';
  at: number;
  content: string;
  subject?: string;
  tool?: RuntimeTurnEventTool;
}

/** Rebuild from exact-run server snapshots. Never guess tools from prose. */
export function projectWorkActivity(events: RuntimeTurnEvent[], fallback: string, createdAt: string): WorkActivity[] {
  const items: WorkActivity[] = [];
  const tools = new Map<string, WorkActivity>();
  for (const event of events) {
    if (event.schema !== 'bridgesllm.runtime-turn-event.v1' || !event.visible) continue;
    const id = `${event.runId}:${event.seq}`;
    const at = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : Date.parse(createdAt) + items.length + 1;
    if (event.type === 'tool_started' || event.type === 'tool_output') {
      if (!event.tool) continue;
      const toolId = event.tool.id || id;
      const previous = tools.get(toolId);
      if (previous) previous.tool = { ...previous.tool!, ...event.tool };
      else {
        const item: WorkActivity = { id, kind: 'tool', at, content: '', tool: event.tool };
        items.push(item); tools.set(toolId, item);
      }
    } else if (event.type === 'assistant_reasoning' || event.type === 'assistant_delta') {
      const kind = event.type === 'assistant_reasoning' ? 'reasoning' : 'text';
      const last = items[items.length - 1];
      if (last?.kind === kind) {
        const prefix = kind === 'text' ? items.filter(item => item.kind === 'text' && item !== last).map(item => item.content).join('') : '';
        const text = event.text || '';
        last.content = event.replace ? (prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text) : last.content + text;
        if (event.subject) last.subject = event.subject;
      } else items.push({ id, kind, at, content: event.text || '', subject: event.subject });
    } else if (event.type === 'assistant_final' && event.text) {
      const last = items[items.length - 1];
      const combined = items.filter(item => item.kind === 'text').map(item => item.content).join('');
      if (event.text === combined) continue;
      if (event.text.startsWith(combined) && combined) {
        const remainder = event.text.slice(combined.length);
        if (last?.kind === 'text') last.content += remainder;
        else items.push({ id, kind: 'text', at, content: remainder });
      } else if (last?.kind === 'text') last.content = event.text;
      else items.push({ id, kind: 'text', at, content: event.text });
    }
  }
  if (!items.some(item => item.kind === 'text') && fallback) {
    items.push({ id: 'response', kind: 'text', at: Date.parse(createdAt) + 1, content: fallback });
  }
  return items;
}
