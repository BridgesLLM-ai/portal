import { refuseDurablyBlockedExecutionRpc } from '../utils/openclawGatewayRpc';
import {
  OPENCLAW_EXECUTION_CAPABLE_GATEWAY_METHODS,
  isOpenClawExecutionCapableGatewayCall,
  isOpenClawExecutionCapableGatewayMethod,
} from '../services/openClawExecutionCapableMethods';

describe('one-shot gateway RPC execution guard', () => {
  const maintenance = () => {
    throw Object.assign(new Error('OPENCLAW_EXECUTION_MAINTENANCE: paused'), { code: 'OPENCLAW_EXECUTION_MAINTENANCE' });
  };

  it('refuses an automation run, and an enabling mutation, while maintenance is recorded', () => {
    for (const method of ['cron.run', 'cron.add', 'cron.update', 'chat.send', 'bridgesllm.ask_user.dismiss']) {
      expect(refuseDurablyBlockedExecutionRpc(method, {}, null, maintenance)).toEqual({
        error: 'OPENCLAW_EXECUTION_MAINTENANCE: paused',
        errorCode: 'OPENCLAW_EXECUTION_MAINTENANCE',
        errorMessage: 'OPENCLAW_EXECUTION_MAINTENANCE: paused',
      });
    }
  });

  it('fails closed when the evidence cannot be read at all', () => {
    expect(refuseDurablyBlockedExecutionRpc('cron.run', {}, null, () => { throw new Error('EIO'); })).toMatchObject({
      errorCode: 'OPENCLAW_EXECUTION_UNAVAILABLE',
    });
  });

  it('lets execution through when nothing is recorded, and never inspects for reads or aborts', () => {
    let inspected = 0;
    expect(refuseDurablyBlockedExecutionRpc('cron.run', {}, null, () => { inspected += 1; })).toBeNull();
    expect(inspected).toBe(1);
    for (const method of ['chat.abort', 'chat.history', 'cron.list', 'cron.remove', 'cron.status', 'sessions.list']) {
      expect(refuseDurablyBlockedExecutionRpc(method, {}, null, maintenance)).toBeNull();
    }
  });

  it('keeps cleanup of an inert automation available during maintenance, and nothing more', () => {
    // Explicitly ends up disabled: repair or cleanup of something that cannot run.
    expect(refuseDurablyBlockedExecutionRpc('cron.update', { id: 'job', patch: { enabled: false } }, null, maintenance)).toBeNull();
    expect(refuseDurablyBlockedExecutionRpc('cron.update', { id: 'job', patch: { enabled: false, name: 'x' } }, null, maintenance)).toBeNull();
    expect(refuseDurablyBlockedExecutionRpc('cron.add', { name: 'x', enabled: false }, null, maintenance)).toBeNull();
    // Anything that enables, or does not say, is execution-capable.
    for (const params of [{ id: 'job', patch: { enabled: true } }, { id: 'job', patch: { name: 'x' } }, { id: 'job' }, null, []]) {
      expect(refuseDurablyBlockedExecutionRpc('cron.update', params, null, maintenance)).not.toBeNull();
    }
    expect(refuseDurablyBlockedExecutionRpc('cron.add', { name: 'x' }, null, maintenance)).not.toBeNull();
    expect(isOpenClawExecutionCapableGatewayCall('cron.run', { patch: { enabled: false } })).toBe(true);
    expect(isOpenClawExecutionCapableGatewayCall('bridgesllm.ask_user.dismiss', {})).toBe(true);
  });

  it('uses the real durable evidence when no guard is injected', () => {
    // No maintenance is recorded on a build or test host, so the real check
    // loads through the lazy import and admits the call.
    expect(refuseDurablyBlockedExecutionRpc('cron.run', {}, null)).toBeNull();
  });

  it('never lists a method that stops or merely observes a run', () => {
    for (const method of ['chat.abort', 'chat.history', 'sessions.list', 'cron.list', 'cron.remove']) {
      expect(isOpenClawExecutionCapableGatewayMethod(method)).toBe(false);
    }
    expect([...OPENCLAW_EXECUTION_CAPABLE_GATEWAY_METHODS]).toEqual(expect.arrayContaining(['chat.send', 'cron.run']));
  });
});
