import { describe, expect, it, vi } from 'vitest';
import {
  createLocalSlashCommandCoordinator,
  type LocalSlashCommandEvent,
} from './localSlashCommandClaim';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function testEvent() {
  let defaultPrevented = false;
  let propagationStopped = false;
  const event: LocalSlashCommandEvent = {
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {
      propagationStopped = true;
    },
  };
  return {
    event,
    get defaultPrevented() {
      return defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
  };
}

describe.each(['Enter', 'Send click'])('%s Portal slash-command claim', () => {
  it('claims advertised export before async paging without duplicates or draft loss', async () => {
    const coordinator = createLocalSlashCommandCoordinator();
    const history = deferred();
    const execute = vi.fn(async () => {
      await history.promise;
    });
    const providerSend = vi.fn();
    const internalSend = vi.fn(() => providerSend());
    let composerValue = '/export';

    const dispatch = () => {
      const boundary = testEvent();
      const claimed = coordinator.claim({
        rawValue: composerValue,
        provider: 'OPENCLAW',
        providerSlashCommands: [{ command: '/export' }],
        event: boundary.event,
        clearComposer: () => {
          composerValue = '';
        },
        execute,
      });
      if (!boundary.defaultPrevented) internalSend();
      return { boundary, claimed };
    };

    const first = dispatch();
    expect(first.claimed).toBe(true);
    expect(first.boundary.defaultPrevented).toBe(true);
    expect(first.boundary.propagationStopped).toBe(true);
    expect(composerValue).toBe('');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(internalSend).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();

    const repeated = dispatch();
    expect(repeated.claimed).toBe(true);
    expect(repeated.boundary.defaultPrevented).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(internalSend).not.toHaveBeenCalled();
    expect(providerSend).not.toHaveBeenCalled();

    composerValue = 'draft typed while export is paging';
    history.resolve();
    await history.promise;
    await Promise.resolve();

    expect(composerValue).toBe('draft typed while export is paging');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(providerSend).not.toHaveBeenCalled();
  });
});

describe('Portal slash-command ownership', () => {
  it('retains provider-native behavior for advertised OpenClaw collisions other than export', () => {
    const coordinator = createLocalSlashCommandCoordinator();
    const boundary = testEvent();
    const clearComposer = vi.fn();
    const execute = vi.fn();

    expect(coordinator.claim({
      rawValue: '/status',
      provider: 'OPENCLAW',
      providerSlashCommands: [{ command: '/status' }],
      event: boundary.event,
      clearComposer,
      execute,
    })).toBe(false);
    expect(boundary.defaultPrevented).toBe(false);
    expect(clearComposer).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
