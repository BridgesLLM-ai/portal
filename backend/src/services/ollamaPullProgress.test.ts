import {
  OLLAMA_PULL_MAX_LINE_BYTES,
  OLLAMA_PULL_MAX_RECORDS,
  OllamaPullProgressAccumulator,
  OllamaPullProgressError,
  type OllamaPullProgressErrorCode,
  type OllamaPullProgressSnapshot,
} from './ollamaPullProgress';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const BASE_TIME = Date.parse('2026-07-26T12:00:00.000Z');

function line(value: unknown, ending = '\n'): Buffer {
  return Buffer.from(`${JSON.stringify(value)}${ending}`, 'utf8');
}

function expectProgressError(
  action: () => unknown,
  code: OllamaPullProgressErrorCode,
): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(OllamaPullProgressError);
    expect(error).toMatchObject({ code });
  }
}

function progressRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: `pulling ${DIGEST_A}`,
    digest: DIGEST_A,
    total: 100,
    completed: 10,
    ...overrides,
  };
}

test('parses arbitrary byte, UTF-8, CRLF, and final-line boundaries', () => {
  const times = [BASE_TIME, BASE_TIME + 1_000, BASE_TIME + 2_000];
  const accumulator = new OllamaPullProgressAccumulator({
    now: () => times.shift()!,
  });
  const payload = Buffer.concat([
    line({ status: 'pulling manifest' }, '\r\n'),
    line({
      status: 'pulling café 😀',
      digest: DIGEST_A.toUpperCase(),
      total: 12,
      completed: 3,
    }),
    line({ status: 'success' }, ''),
  ]);
  const snapshots: OllamaPullProgressSnapshot[] = [];

  for (let index = 0; index < payload.byteLength; index += 1) {
    snapshots.push(...accumulator.push(payload.subarray(index, index + 1)));
  }
  const terminal = accumulator.finish();

  expect(snapshots).toHaveLength(2);
  expect(snapshots[0]).toEqual({
    phase: 'manifest',
    status: 'pulling manifest',
    digest: null,
    totalBytes: null,
    completedBytes: null,
    percent: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
    eventSeq: 1,
    updatedAt: '2026-07-26T12:00:00.000Z',
  });
  expect(snapshots[1]).toMatchObject({
    phase: 'downloading',
    status: 'pulling café 😀',
    digest: DIGEST_A,
    totalBytes: 12,
    completedBytes: 3,
    percent: 25,
    speedBytesPerSecond: null,
    etaSeconds: null,
    eventSeq: 2,
  });
  expect(terminal).toMatchObject({
    phase: 'complete',
    status: 'success',
    digest: null,
    totalBytes: null,
    completedBytes: null,
    percent: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
    eventSeq: 3,
  });
  expect(accumulator.recordCount).toBe(3);
  expect(accumulator.isTerminal).toBe(true);
  expect(accumulator.snapshot()).toBe(terminal);
});

test('returns every record in a multi-line chunk as immutable JSON-safe snapshots', () => {
  let now = BASE_TIME;
  const accumulator = new OllamaPullProgressAccumulator({
    now: () => now++,
  });
  const snapshots = accumulator.push(Buffer.concat([
    line({ status: 'pulling manifest' }),
    line({ status: 'verifying sha256 digest' }),
    line({ status: 'writing manifest' }),
    line({ status: 'removing any unused layers' }),
    line({ status: 'success' }),
  ]));

  expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
    'manifest',
    'verifying',
    'writing',
    'cleanup',
    'complete',
  ]);
  expect(snapshots.map((snapshot) => snapshot.eventSeq)).toEqual([1, 2, 3, 4, 5]);
  expect(Object.isFrozen(snapshots)).toBe(true);
  for (const snapshot of snapshots) {
    expect(Object.isFrozen(snapshot)).toBe(true);
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain('undefined');
    expect(JSON.parse(encoded)).toEqual(snapshot);
  }
  expect(accumulator.finish()).toBe(snapshots[4]);
  expect(accumulator.finish()).toBe(snapshots[4]);
});

test('accepts exactly 64 KiB per line, including a split CRLF delimiter', () => {
  const prefix = '{"status":"pulling manifest","padding":"';
  const suffix = '"}';
  const padding = 'x'.repeat(
    OLLAMA_PULL_MAX_LINE_BYTES
      - Buffer.byteLength(prefix)
      - Buffer.byteLength(suffix),
  );
  const exactLine = Buffer.from(`${prefix}${padding}${suffix}`, 'utf8');
  expect(exactLine.byteLength).toBe(OLLAMA_PULL_MAX_LINE_BYTES);

  const accumulator = new OllamaPullProgressAccumulator();
  expect(accumulator.push(Buffer.concat([exactLine, Buffer.from('\r')]))).toEqual([]);
  expect(accumulator.push(Buffer.from('\n'))).toHaveLength(1);
  accumulator.push(line({ status: 'success' }));
  expect(accumulator.finish().status).toBe('success');
});

test('rejects a line above 64 KiB before retaining unbounded input', () => {
  const prefix = '{"status":"pulling manifest","padding":"';
  const suffix = '"}';
  const padding = 'x'.repeat(
    OLLAMA_PULL_MAX_LINE_BYTES
      - Buffer.byteLength(prefix)
      - Buffer.byteLength(suffix)
      + 1,
  );
  const accumulator = new OllamaPullProgressAccumulator();

  expectProgressError(
    () => accumulator.push(Buffer.from(`${prefix}${padding}${suffix}\n`)),
    'LINE_TOO_LARGE',
  );
  expectProgressError(() => accumulator.finish(), 'LINE_TOO_LARGE');
});

test('enforces a bounded record count across chunks', () => {
  const accumulator = new OllamaPullProgressAccumulator({ maxRecords: 2 });
  accumulator.push(line({ status: 'pulling manifest' }));
  accumulator.push(line({ status: 'verifying sha256 digest' }));

  expectProgressError(
    () => accumulator.push(line({ status: 'writing manifest' })),
    'TOO_MANY_RECORDS',
  );
  expect(accumulator.recordCount).toBe(2);
});

test.each([
  {
    name: 'invalid UTF-8',
    bytes: Buffer.from([0xff, 0x0a]),
    code: 'INVALID_UTF8' as const,
  },
  {
    name: 'malformed JSON',
    bytes: Buffer.from('{"status":}\n'),
    code: 'MALFORMED_JSON' as const,
  },
  {
    name: 'array root',
    bytes: line([]),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'null root',
    bytes: line(null),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'scalar root',
    bytes: line('pulling manifest'),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'missing status',
    bytes: line({ digest: DIGEST_A }),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'numeric status',
    bytes: line({ status: 1 }),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'blank status',
    bytes: line({ status: '   ' }),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'control-bearing status',
    bytes: line({ status: 'pulling\u0000manifest' }),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'invalid digest',
    bytes: line({ status: 'pulling layer', digest: 'sha256:nope' }),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'numeric counters without digest',
    bytes: line({ status: 'pulling layer', total: 10, completed: 1 }),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'string total',
    bytes: line(progressRecord({ total: '100' })),
    code: 'UNSAFE_NUMBER' as const,
  },
  {
    name: 'fractional completed',
    bytes: line(progressRecord({ completed: 1.5 })),
    code: 'UNSAFE_NUMBER' as const,
  },
  {
    name: 'negative total',
    bytes: line(progressRecord({ total: -1 })),
    code: 'UNSAFE_NUMBER' as const,
  },
  {
    name: 'negative zero completed',
    bytes: Buffer.from(`{"status":"pulling layer","digest":"${DIGEST_A}","total":1,"completed":-0}\n`),
    code: 'UNSAFE_NUMBER' as const,
  },
  {
    name: 'unsafe integer',
    bytes: Buffer.from(`{"status":"pulling layer","digest":"${DIGEST_A}","total":9007199254740992}\n`),
    code: 'UNSAFE_NUMBER' as const,
  },
  {
    name: 'overflowing exponent',
    bytes: Buffer.from('{"status":"pulling manifest","metadata":1e400}\n'),
    code: 'UNSAFE_NUMBER' as const,
  },
  {
    name: 'unsafe number in unknown nested metadata',
    bytes: Buffer.from('{"status":"pulling manifest","metadata":{"count":9007199254740992}}\n'),
    code: 'UNSAFE_NUMBER' as const,
  },
  {
    name: 'completed exceeds total',
    bytes: line(progressRecord({ total: 9, completed: 10 })),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'progress-bearing success',
    bytes: line({
      status: 'success',
      digest: DIGEST_A,
      total: 1,
      completed: 1,
    }),
    code: 'INVALID_RECORD' as const,
  },
  {
    name: 'non-string error',
    bytes: line({ error: { message: 'failed' } }),
    code: 'INVALID_RECORD' as const,
  },
])('rejects $name and latches the failure', ({ bytes, code }) => {
  const accumulator = new OllamaPullProgressAccumulator();
  expectProgressError(() => accumulator.push(bytes), code);
  expectProgressError(
    () => accumulator.push(line({ status: 'success' })),
    code,
  );
});

test('allows bounded unknown JSON metadata with safe fractional numbers', () => {
  const accumulator = new OllamaPullProgressAccumulator();
  const [snapshot] = accumulator.push(line({
    status: 'pulling manifest',
    metadata: {
      ratio: 0.5,
      flags: [true, false, null],
    },
  }));
  expect(snapshot.status).toBe('pulling manifest');
  accumulator.push(line({ status: 'success' }));
  expect(accumulator.finish().phase).toBe('complete');
});

test('recognizes and safely bounds an Ollama error frame', () => {
  const accumulator = new OllamaPullProgressAccumulator();
  const remote = `  failed\u0000\nbecause ${'é'.repeat(2_000)}  `;

  try {
    accumulator.push(line({ error: remote }));
    throw new Error('Expected remote failure');
  } catch (error) {
    expect(error).toBeInstanceOf(OllamaPullProgressError);
    const progressError = error as OllamaPullProgressError;
    expect(progressError.code).toBe('REMOTE_ERROR');
    expect(progressError.remoteMessage).toMatch(/^failed because /);
    expect(Buffer.byteLength(progressError.remoteMessage!, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(progressError.remoteMessage).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(progressError.message).toBe(`Ollama pull failed: ${progressError.remoteMessage}`);
  }
});

test('distinguishes clean EOF before success from a malformed final record', () => {
  const empty = new OllamaPullProgressAccumulator();
  expectProgressError(() => empty.finish(), 'EOF_BEFORE_SUCCESS');

  const validButIncomplete = new OllamaPullProgressAccumulator();
  validButIncomplete.push(line({ status: 'pulling manifest' }));
  expectProgressError(
    () => validButIncomplete.finish(),
    'EOF_BEFORE_SUCCESS',
  );

  const malformedFinal = new OllamaPullProgressAccumulator();
  malformedFinal.push(Buffer.from('{"status":'));
  expectProgressError(() => malformedFinal.finish(), 'MALFORMED_JSON');
});

test('requires success to be terminal and rejects later records or bytes', () => {
  const sameChunk = new OllamaPullProgressAccumulator();
  expectProgressError(
    () => sameChunk.push(Buffer.concat([
      line({ status: 'success' }),
      line({ status: 'pulling manifest' }),
    ])),
    'AFTER_SUCCESS',
  );

  const laterChunk = new OllamaPullProgressAccumulator();
  laterChunk.push(line({ status: 'success' }));
  expectProgressError(
    () => laterChunk.push(Buffer.from('x')),
    'AFTER_SUCCESS',
  );

  const finished = new OllamaPullProgressAccumulator();
  finished.push(line({ status: 'success' }));
  finished.finish();
  expectProgressError(
    () => finished.push(Buffer.alloc(0)),
    'ALREADY_FINISHED',
  );
});

test('maintains monotonic counters independently for each digest', () => {
  let now = BASE_TIME;
  const accumulator = new OllamaPullProgressAccumulator({ now: () => now });

  const [aFirst] = accumulator.push(line(progressRecord()));
  expect(aFirst).toMatchObject({
    digest: DIGEST_A,
    totalBytes: 100,
    completedBytes: 10,
    percent: 10,
    speedBytesPerSecond: null,
    etaSeconds: null,
  });

  now += 1_000;
  const [aSecond] = accumulator.push(line(progressRecord({
    total: undefined,
    completed: 40,
  })));
  expect(aSecond).toMatchObject({
    totalBytes: 100,
    completedBytes: 40,
    percent: 40,
    speedBytesPerSecond: 30,
    etaSeconds: 2,
  });

  now += 1_000;
  const [verifying] = accumulator.push(line({ status: 'verifying sha256 digest' }));
  expect(verifying).toMatchObject({
    phase: 'verifying',
    digest: null,
    totalBytes: null,
    completedBytes: null,
    percent: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
  });

  now += 1_000;
  const [bFirst] = accumulator.push(line({
    status: `pulling ${DIGEST_B}`,
    digest: DIGEST_B,
    total: 200,
    completed: 20,
  }));
  expect(bFirst).toMatchObject({
    digest: DIGEST_B,
    totalBytes: 200,
    completedBytes: 20,
    speedBytesPerSecond: null,
  });

  now += 1_000;
  const [aRestored] = accumulator.push(line({
    status: `pulling ${DIGEST_A}`,
    digest: DIGEST_A,
  }));
  expect(aRestored).toMatchObject({
    totalBytes: 100,
    completedBytes: 40,
    percent: 40,
    speedBytesPerSecond: 30,
    etaSeconds: 2,
  });

  accumulator.push(line({ status: 'success' }));
  accumulator.finish();
});

test.each([
  {
    name: 'completed byte regression',
    first: progressRecord({ completed: 50 }),
    second: progressRecord({ completed: 49 }),
    code: 'PROGRESS_REGRESSION' as const,
  },
  {
    name: 'total byte regression',
    first: progressRecord({ total: 100, completed: 10 }),
    second: progressRecord({ total: 99, completed: 10 }),
    code: 'PROGRESS_REGRESSION' as const,
  },
  {
    name: 'new total below retained completion',
    first: progressRecord({ total: undefined, completed: 50 }),
    second: progressRecord({ total: 49, completed: undefined }),
    code: 'INVALID_RECORD' as const,
  },
])('rejects per-digest $name', ({ first, second, code }) => {
  const accumulator = new OllamaPullProgressAccumulator();
  accumulator.push(line(first));
  expectProgressError(() => accumulator.push(line(second)), code);
});

test('never fabricates determinate progress or ETA without an observed total', () => {
  let now = BASE_TIME;
  const noTotal = new OllamaPullProgressAccumulator({ now: () => now });
  const [first] = noTotal.push(line(progressRecord({
    total: undefined,
    completed: 5,
  })));
  expect(first).toMatchObject({
    totalBytes: null,
    completedBytes: 5,
    percent: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
  });

  now += 1_000;
  const [second] = noTotal.push(line(progressRecord({
    total: undefined,
    completed: 15,
  })));
  expect(second).toMatchObject({
    totalBytes: null,
    completedBytes: 15,
    percent: null,
    speedBytesPerSecond: 10,
    etaSeconds: null,
  });

  const noCompleted = new OllamaPullProgressAccumulator();
  const [third] = noCompleted.push(line(progressRecord({
    completed: undefined,
  })));
  expect(third).toMatchObject({
    totalBytes: 100,
    completedBytes: null,
    percent: null,
    speedBytesPerSecond: null,
    etaSeconds: null,
  });

  const zeroTotal = new OllamaPullProgressAccumulator();
  const [fourth] = zeroTotal.push(line(progressRecord({
    total: 0,
    completed: 0,
  })));
  expect(fourth).toMatchObject({
    totalBytes: 0,
    completedBytes: 0,
    percent: null,
    etaSeconds: 0,
  });
});

test('reports zero speed for an observed stall and zero ETA at observed completion', () => {
  let now = BASE_TIME;
  const stalled = new OllamaPullProgressAccumulator({ now: () => now });
  stalled.push(line(progressRecord({ completed: 10 })));
  now += 2_000;
  const [snapshot] = stalled.push(line(progressRecord({ completed: 10 })));
  expect(snapshot).toMatchObject({
    speedBytesPerSecond: 0,
    etaSeconds: null,
  });

  const complete = new OllamaPullProgressAccumulator();
  const [completeSnapshot] = complete.push(line(progressRecord({
    total: 100,
    completed: 100,
  })));
  expect(completeSnapshot).toMatchObject({
    percent: 100,
    speedBytesPerSecond: null,
    etaSeconds: 0,
  });
});

test('rejects invalid configuration, chunk types, and clocks', () => {
  expect(() => new OllamaPullProgressAccumulator({
    maxLineBytes: OLLAMA_PULL_MAX_LINE_BYTES + 1,
  })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  expect(() => new OllamaPullProgressAccumulator({
    maxRecords: OLLAMA_PULL_MAX_RECORDS + 1,
  })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));

  const invalidChunk = new OllamaPullProgressAccumulator();
  expectProgressError(
    () => invalidChunk.push('not bytes' as unknown as Buffer),
    'INVALID_CHUNK',
  );

  const invalidClock = new OllamaPullProgressAccumulator({
    now: () => Number.POSITIVE_INFINITY,
  });
  expectProgressError(
    () => invalidClock.push(line({ status: 'pulling manifest' })),
    'INVALID_TIME',
  );
});
