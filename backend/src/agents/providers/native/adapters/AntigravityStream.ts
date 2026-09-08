import { validateNativeHostSessionId, type NativeCliTurnContext } from '../types';

/** Antigravity 1.1.17 stream-json. Only native events, never inferred prose. */
export function handleAntigravityStreamLine(line: string, ctx: NativeCliTurnContext): void {
  let event: any;
  try { event = JSON.parse(line); } catch { return; }
  if (!event || typeof event !== 'object') return;
  const body = event.event === 'step_update' ? event.step_update
    : event.event === 'result' ? event.result : event;
  if (!body || typeof body !== 'object') return;
  if (body.conversation_id) {
    let nativeSessionId: string | null;
    try { nativeSessionId = validateNativeHostSessionId(body.conversation_id, true); } catch { return; }
    ctx.state.nativeSessionId = nativeSessionId;
    ctx.updateSessionMetadata({ nativeSessionId });
  }
  if (event.event === 'result') {
    ctx.state.antigravityResultStatus = String(body.status || 'UNKNOWN');
    ctx.state.antigravityDeniedActions = Array.isArray(body.denied_actions) ? body.denied_actions : [];
    if (typeof body.response === 'string') {
      // The result repeats the final text already delivered in text_delta.
      if (body.response.startsWith(ctx.fullText)) {
        const tail = body.response.slice(ctx.fullText.length);
        if (tail) ctx.emitChunk(tail);
      }
      ctx.setFullText(body.response);
    }
    return;
  }
  if (event.event !== 'step_update' || !Number.isSafeInteger(body.step_index)) return;
  const key = String(body.step_index);
  const steps: Record<string, string> = ctx.state.antigravitySteps ||= {};
  if (steps[key] === 'DONE' || steps[key] === 'ERROR') return;
  if (body.step_type === 'agent_response') {
    if (typeof body.text_delta === 'string' && body.text_delta) {
      ctx.appendFullText(body.text_delta);
      ctx.emitChunk(body.text_delta);
    }
  } else if (body.step_type === 'tool') {
    const info = body.tool_info || {};
    const toolName = String(body.tool_name || info.name || 'antigravity_tool');
    const toolCallId = `antigravity:${ctx.state.nativeSessionId || ctx.originalSessionId}:${key}`;
    if (!steps[key]) ctx.emitStatus(`Antigravity: ${toolName}`, {
      type: 'tool_start', toolName, toolCallId, toolArgs: info.parameters || {},
    });
    if (body.state === 'DONE' || body.state === 'ERROR') {
      const isError = body.state === 'ERROR' || Boolean(info.error);
      const result = info.error?.message ?? info.output ?? '';
      const toolResult = typeof result === 'string' ? result : JSON.stringify(result);
      ctx.emitStatus(isError ? `${toolName} failed` : `${toolName} completed`, {
        type: 'tool_end', toolName, toolCallId, toolResult, isError,
      });
    }
  }
  steps[key] = String(body.state || 'ACTIVE');
}
