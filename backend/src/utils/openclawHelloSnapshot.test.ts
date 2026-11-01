import fs from 'fs';
import {
  buildOpenClawHelloSnapshot,
  OPENCLAW_HELLO_SNAPSHOT_SCHEMA,
  recordOpenClawHelloSnapshot,
  writeOpenClawHelloSnapshot,
  type HelloSnapshotFs,
} from './openclawHelloSnapshot';

const TARGET = '/state/var/lib/bridgesllm/openclaw-hello.v1.json';
const NOW = new Date('2026-10-31T06:10:00.123Z');
const HELLO = {
  protocol: 3,
  server: { version: ' 2026.10.9 ' },
  features: { methods: ['chat.send', 'chat.history', 'chat.send', 7], events: ['chat', 'agent'] },
};

type Call = [string, ...unknown[]];

function fakeFs(overrides: Partial<Record<'lstat' | 'rename' | 'open', (...args: any[]) => any>> = {}) {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const fake: HelloSnapshotFs = {
    lstat: async (target) => {
      calls.push(['lstat', target]);
      if (overrides.lstat) return overrides.lstat(target);
      return { isDirectory: () => true, uid: 0, mode: 0o40755 };
    },
    open: async (target, flags, mode) => {
      calls.push(['open', target, flags, mode]);
      if (overrides.open) overrides.open(target);
      return {
        writeFile: async (data: string) => { calls.push(['write', target]); files.set(target, data); },
        sync: async () => { calls.push(['sync', target]); },
        close: async () => { calls.push(['close', target]); },
      };
    },
    rename: async (from, to) => {
      calls.push(['rename', from, to]);
      if (overrides.rename) return overrides.rename(from, to);
      files.set(to, files.get(from) ?? '');
      files.delete(from);
    },
    unlink: async (target) => { calls.push(['unlink', target]); files.delete(target); },
  };
  return { fake, calls, files };
}

const options = (fake: HelloSnapshotFs, extra: Record<string, unknown> = {}) => ({
  fs: fake, path: TARGET, now: () => NOW, euid: () => 0, ...extra,
});

describe('OpenClaw hello snapshot', () => {
  test('keeps the server version, unique method and event names, and when the hello arrived', () => {
    expect(buildOpenClawHelloSnapshot(HELLO, NOW)).toEqual({
      schema: OPENCLAW_HELLO_SNAPSHOT_SCHEMA,
      serverVersion: '2026.10.9',
      methods: ['chat.send', 'chat.history'],
      events: ['chat', 'agent'],
      receivedAt: '2026-10-31T06:10:00.123Z',
    });
    expect(buildOpenClawHelloSnapshot({ features: { methods: ['chat.send'] } }, NOW)).toBeNull();
    expect(buildOpenClawHelloSnapshot({ server: { version: '2026.10.9' }, features: { methods: ['x'.repeat(201)] } }, NOW))
      .toBeNull();
    // A hello without a method list is recorded as offering none (OC-HELLO then names what is missing).
    expect(buildOpenClawHelloSnapshot({ server: { version: '2026.10.9' } }, NOW)?.methods).toEqual([]);
  });

  test('writes a 0600 temporary file in the same directory, syncs it, renames it and syncs the directory', async () => {
    const { fake, calls, files } = fakeFs();
    await expect(writeOpenClawHelloSnapshot(HELLO, options(fake))).resolves.toEqual({ ok: true, path: TARGET });
    const temporary = calls[1][1] as string;
    expect(temporary.startsWith('/state/var/lib/bridgesllm/.openclaw-hello.v1.json.')).toBe(true);
    const flags = calls[1][2] as number;
    for (const flag of [fs.constants.O_CREAT, fs.constants.O_EXCL, fs.constants.O_NOFOLLOW, fs.constants.O_WRONLY]) {
      expect(flags & flag).toBe(flag);
    }
    expect(calls.map((call) => call[0])).toEqual(['lstat', 'open', 'write', 'sync', 'close', 'rename', 'open', 'sync', 'close']);
    expect(calls[1][3]).toBe(0o600);
    expect(calls[5]).toEqual(['rename', temporary, TARGET]);
    expect(calls[6][1]).toBe('/state/var/lib/bridgesllm');
    expect(JSON.parse(files.get(TARGET)!)).toEqual(buildOpenClawHelloSnapshot(HELLO, NOW));
  });

  test('a write failure resolves with the reason, removes its temporary file and never throws', async () => {
    const { fake, calls } = fakeFs({ rename: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
    await expect(writeOpenClawHelloSnapshot(HELLO, options(fake))).resolves.toEqual({ ok: false, reason: 'EACCES' });
    expect(calls.filter((call) => call[0] === 'unlink').map((call) => call[1])).toEqual([calls[1][1]]);

    const thrown = fakeFs({ lstat: () => { throw new Error('boom'); } });
    await expect(writeOpenClawHelloSnapshot(HELLO, options(thrown.fake))).resolves.toEqual({ ok: false, reason: 'boom' });
  });

  test('refuses an unsafe parent, a non-root backend and an oversized hello before writing anything', async () => {
    for (const parent of [{ uid: 1000, mode: 0o40755 }, { uid: 0, mode: 0o40775 }, { uid: 0, mode: 0o40757 }]) {
      const { fake, calls } = fakeFs({ lstat: () => ({ isDirectory: () => true, ...parent }) });
      const outcome = await writeOpenClawHelloSnapshot(HELLO, options(fake));
      expect(outcome.ok).toBe(false);
      expect(calls.map((call) => call[0])).toEqual(['lstat']);
    }
    const symlinked = fakeFs({ lstat: () => ({ isDirectory: () => false, uid: 0, mode: 0o120777 }) });
    expect((await writeOpenClawHelloSnapshot(HELLO, options(symlinked.fake))).ok).toBe(false);
    expect(symlinked.calls.map((call) => call[0])).toEqual(['lstat']);

    const notRoot = fakeFs();
    expect(await writeOpenClawHelloSnapshot(HELLO, options(notRoot.fake, { euid: () => 1000 })))
      .toEqual({ ok: false, reason: 'the Portal backend is not running as root' });
    expect(notRoot.calls).toEqual([]);

    const huge = { server: { version: '2026.10.9' }, features: { methods: Array.from({ length: 3000 }, (_v, i) => `m.${i}.${'x'.repeat(90)}`) } };
    const oversized = fakeFs();
    const outcome = await writeOpenClawHelloSnapshot(huge, options(oversized.fake));
    expect(outcome).toEqual({ ok: false, reason: 'the hello is larger than 262144 bytes' });
    expect(oversized.calls).toEqual([]);
  });

  test('recording returns at once, writes in hello order and logs a failure once until a write succeeds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let fail = true;
      const { fake, files } = fakeFs({ open: (target: string) => {
        if (fail && target.endsWith('.tmp')) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      } });
      expect(() => recordOpenClawHelloSnapshot(HELLO, options(fake))).not.toThrow();
      await recordOpenClawHelloSnapshot(HELLO, options(fake));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('EROFS');

      fail = false;
      const later = new Date('2026-10-31T06:11:00.000Z');
      void recordOpenClawHelloSnapshot(HELLO, options(fake, { now: () => NOW }));
      await recordOpenClawHelloSnapshot({ ...HELLO, server: { version: '2026.10.10' } }, options(fake, { now: () => later }));
      expect(JSON.parse(files.get(TARGET)!)).toMatchObject({ serverVersion: '2026.10.10', receivedAt: later.toISOString() });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('under jest nothing is written without an explicit test path', async () => {
    const { fake, calls } = fakeFs();
    const previous = process.env.BRIDGESLLM_OPENCLAW_HELLO_SNAPSHOT;
    delete process.env.BRIDGESLLM_OPENCLAW_HELLO_SNAPSHOT;
    try {
      await recordOpenClawHelloSnapshot(HELLO, { fs: fake, euid: () => 0 });
      expect(calls).toEqual([]);
      expect(await writeOpenClawHelloSnapshot(HELLO, { fs: fake, euid: () => 0, path: 'relative/hello.json' }))
        .toEqual({ ok: false, reason: 'no snapshot path in this environment' });
    } finally {
      if (previous !== undefined) process.env.BRIDGESLLM_OPENCLAW_HELLO_SNAPSHOT = previous;
    }
  });
});
