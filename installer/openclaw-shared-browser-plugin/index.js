const http = require('node:http');
const SOCKET = '/run/bridges-shared-browser/broker.sock';
const PROFILE = 'portal-shared';
function callerFrom(ctx, event = {}) {
  return { agentId: ctx?.agentId, sessionKey: ctx?.sessionKey,
    runId: ctx?.runId || event.runId, toolCallId: ctx?.toolCallId || event.toolCallId };
}
function broker(action, caller) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: SOCKET, path: '/v1/browser', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; if (raw.length > 4096) request.destroy(new Error('Broker response too large')); });
      response.on('end', () => {
        try { const result = JSON.parse(raw); if (response.statusCode !== 200 || result.ok !== true) throw new Error(result.error || 'Browser admission denied'); resolve(result); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('Shared browser broker unavailable')));
    request.on('error', reject); request.end(JSON.stringify({ action, caller }));
  });
}
function register(api) {
  const allowed = new Set(api.pluginConfig?.agentIds || []);
  // A configured opt-in host browser is intentionally one explicit target.
  // Unknown/missing identity, node routing and system profile borrowing fail closed.
  const before = async (event, ctx) => {
    if (event.toolName !== 'browser') return;
    const caller = callerFrom(ctx, event);
    const params = event.params || {};
    if (!allowed.has(caller.agentId) || !caller.sessionKey || !caller.runId || !caller.toolCallId) {
      return { block: true, blockReason: 'This agent/session is not authorized for the shared browser' };
    }
    if (params.target !== 'host' || params.profile !== PROFILE || params.node !== undefined
      || ['importprofile', 'stop', 'doctor', 'profiles'].includes(params.action)) {
      return { block: true, blockReason: 'Select portal-shared explicitly with target host; node/system/other profiles are not shared browser capabilities' };
    }
    try { await broker('begin', caller); return { params: { ...params, target: 'host', profile: PROFILE } }; }
    catch (error) { return { block: true, blockReason: error.message || 'Shared browser admission unavailable' }; }
  };
  api.on('before_tool_call', before, { priority: 1000 });
  api.on('after_tool_call', async (event, ctx) => {
    if (event.toolName !== 'browser') return;
    try { await broker('finish', callerFrom(ctx, event)); } catch { /* Lost completion leaves control closed, never grants human input. */ }
  });
  for (const [name, action, description] of [
    ['shared_browser_select', 'select', 'Check this session’s Portal shared browser selection. Use browser with target host and profile portal-shared.'],
    ['shared_browser_handover', 'handover', 'Request human takeover in Portal Remote Desktop. Does not automatically grant human input or resume agent work.'],
  ]) api.registerTool(ctx => {
    if (!allowed.has(ctx?.agentId)) return null;
    return { name, label: name, description, parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() {
        try { await broker(action, callerFrom(ctx)); return { content: [{ type: 'text', text: action === 'select'
          ? 'This session is selected. Browser target: host; profile: portal-shared. Human control may hold the lease.'
          : 'Take control / Return to agent / Decline are available to the selecting user in Portal Remote Desktop.' }], details: { ok: true, target: 'host', profile: PROFILE } }; }
        catch (error) { return { content: [{ type: 'text', text: error.message || 'Shared browser unavailable' }], details: { ok: false } }; }
      } };
  }, { name, optional: true });
}
module.exports = { id: 'bridgesllm-shared-browser', register, __test: { callerFrom, broker } };
