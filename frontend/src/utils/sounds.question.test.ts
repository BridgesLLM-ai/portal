// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const contexts: FakeContext[] = [];
class FakeContext {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  starts: number[] = [];
  resolveResume!: () => void;
  promise = new Promise<void>((resolve) => { this.resolveResume = resolve; });
  resume = vi.fn(() => this.promise);
  constructor() { contexts.push(this); }
  createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  createOscillator() {
    return { type: '', frequency: { value: 0 }, connect() {}, start: (at: number) => this.starts.push(at), stop() {} };
  }
}

describe('question audio playback', () => {
  beforeEach(() => { vi.resetModules(); contexts.length = 0; localStorage.clear(); vi.stubGlobal('AudioContext', FakeContext); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('unlocks silently on interaction and schedules the alert only after audio actually resumes', async () => {
    const { default: sounds } = await import('./sounds');
    sounds.unlock();
    const current = contexts[contexts.length - 1];
    expect(current.resume).toHaveBeenCalled();
    expect(current.starts).toEqual([]);
    sounds.question();
    expect(current.starts).toEqual([]);
    current.currentTime = 12;
    current.state = 'running';
    current.resolveResume();
    await current.promise;
    expect(current.starts).toHaveLength(4);
    expect(current.starts[0]).toBe(12);
    expect(current.starts.every((at) => at >= 12)).toBe(true);
  });

  it('plays on an already running context without awaiting another gesture', async () => {
    const { default: sounds } = await import('./sounds');
    sounds.unlock();
    const current = contexts[contexts.length - 1];
    current.state = 'running'; current.currentTime = 3;
    sounds.question();
    expect(current.starts).toHaveLength(4);
    expect(current.starts[0]).toBe(3);
  });

  it('respects an intentional sound mute applied before pending playback resumes', async () => {
    const { default: sounds } = await import('./sounds');
    sounds.question(); sounds.setEnabled(false);
    const current = contexts[contexts.length - 1];
    current.state = 'running'; current.resolveResume();
    await current.promise;
    expect(current.starts).toEqual([]);
  });
});
