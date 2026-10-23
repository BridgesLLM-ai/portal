const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const plugin = require('./index.js');
const realRequest = http.request;
afterEach(() => { http.request = realRequest; });
function setup() {
  const hooks = {}, tools = {};
  plugin.register({ pluginConfig: { agentIds: ['alpha'] }, on: (name, fn) => hooks[name] = fn,
    registerTool: (factory, options) => tools[options.name] = factory });
  return { hooks, tools };
}
const caller = { agentId: 'alpha', sessionKey: 'agent:alpha:portal-owned', runId: 'run-1', toolCallId: 'call-1' };
const event = { toolName: 'browser', params: { action: 'snapshot', target: 'host', profile: 'portal-shared' } };
function mockBroker(accepted, seen) {
  http.request = (options, callback) => {
    assert.equal(options.socketPath, '/run/bridges-shared-browser/broker.sock'); assert.equal(options.host, undefined);
    const request = new EventEmitter(); request.setTimeout = () => {}; request.destroy = error => request.emit('error', error);
    request.end = text => { seen.push(JSON.parse(text)); const response = new EventEmitter(); response.statusCode = accepted ? 200 : 409;
      callback(response); queueMicrotask(() => { response.emit('data', JSON.stringify({ ok: accepted, error: 'Human control' })); response.emit('end'); }); };
    return request;
  };
}
test('explicit target and trusted caller reach broker; params cannot replace caller; after-call finishes', async () => {
  const { hooks } = setup(), seen = []; mockBroker(true, seen);
  const result = await hooks.before_tool_call({ ...event, params: { ...event.params, sessionKey: 'forged', agentId: 'forged' } }, caller);
  assert.equal(result.block, undefined); assert.equal(result.params.target, 'host');
  assert.deepEqual(seen[0], { action: 'begin', caller });
  await hooks.after_tool_call(event, caller); assert.equal(seen[1].action, 'finish');
});
test('missing identity, ungranted agent, node, borrowed profile, import and lifecycle mutation are denied before transport', async () => {
  const { hooks } = setup(); http.request = () => { throw new Error('must not reach transport'); };
  for (const context of [{}, { ...caller, sessionKey: undefined }, { ...caller, agentId: 'other' }, { ...caller, toolCallId: undefined }]) assert.equal((await hooks.before_tool_call(event, context)).block, true);
  for (const params of [{ target: undefined }, { target: 'node' }, { profile: 'user' }, { node: 'rdp' }, { action: 'importprofile' }, { action: 'stop' }]) assert.equal((await hooks.before_tool_call({ ...event, params: { ...event.params, ...params } }, caller)).block, true);
  assert.equal(await hooks.before_tool_call({ toolName: 'project_app_browser' }, caller), undefined);
});
test('human lease and unavailable broker fail closed, with no automatic fallback', async () => {
  const { hooks } = setup(); mockBroker(false, []); assert.equal((await hooks.before_tool_call(event, caller)).blockReason, 'Human control');
  http.request = () => { throw new Error('offline'); }; assert.equal((await hooks.before_tool_call(event, caller)).blockReason, 'offline');
});
test('select/handover tools are agent-granted and caller identity never comes from tool arguments', async () => {
  const { tools } = setup(), seen = []; mockBroker(true, seen);
  assert.equal(tools.shared_browser_select({ agentId: 'other' }), null);
  const tool = tools.shared_browser_handover(caller);
  assert.equal((await tool.execute('ignored', { sessionKey: 'forged' })).details.ok, true);
  assert.deepEqual(seen[0], { action: 'handover', caller });
});
