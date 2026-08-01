import { TextDecoder } from 'node:util';

export const OLLAMA_PULL_MAX_LINE_BYTES = 64 * 1024;
export const OLLAMA_PULL_MAX_RECORDS = 100_000;
export const OLLAMA_PULL_MAX_DIGESTS = 4_096;

const MAX_STATUS_BYTES = 512;
const MAX_REMOTE_ERROR_BYTES = 1_024;
const MAX_JSON_NODES_PER_RECORD = 8_192;
const UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

export type OllamaPullProgressErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_CHUNK'
  | 'LINE_TOO_LARGE'
  | 'TOO_MANY_RECORDS'
  | 'INVALID_UTF8'
  | 'MALFORMED_JSON'
  | 'INVALID_RECORD'
  | 'UNSAFE_NUMBER'
  | 'REMOTE_ERROR'
  | 'PROGRESS_REGRESSION'
  | 'AFTER_SUCCESS'
  | 'EOF_BEFORE_SUCCESS'
  | 'ALREADY_FINISHED'
  | 'INVALID_TIME';

export class OllamaPullProgressError extends Error {
  constructor(
    public readonly code: OllamaPullProgressErrorCode,
    message: string,
    public readonly remoteMessage: string | null = null,
  ) {
    super(message);
    this.name = 'OllamaPullProgressError';
  }
}

export type OllamaPullPhase =
  | 'preparing'
  | 'manifest'
  | 'downloading'
  | 'verifying'
  | 'writing'
  | 'cleanup'
  | 'complete';

export interface OllamaPullProgressSnapshot {
  readonly phase: OllamaPullPhase;
  readonly status: string;
  readonly digest: string | null;
  readonly totalBytes: number | null;
  readonly completedBytes: number | null;
  readonly percent: number | null;
  readonly speedBytesPerSecond: number | null;
  readonly etaSeconds: number | null;
  readonly eventSeq: number;
  readonly updatedAt: string;
}

export interface OllamaPullProgressOptions {
  /**
   * Epoch milliseconds. Injectable so callers can use the same trusted clock
   * as their retained job snapshots and tests can prove rate calculations.
   */
  readonly now?: () => number;
  /**
   * Callers may lower, but never raise, the global safety ceilings.
   */
  readonly maxLineBytes?: number;
  readonly maxRecords?: number;
}

interface DigestProgress {
  readonly totalBytes: number | null;
  readonly completedBytes: number | null;
  readonly sampleCompletedBytes: number | null;
  readonly sampleAtMs: number | null;
  readonly speedBytesPerSecond: number | null;
}

type JsonRecord = Record<string, unknown>;

function configurationInteger(
  value: unknown,
  fallback: number,
  ceiling: number,
  label: string,
): number {
  const normalized = value === undefined ? fallback : value;
  if (
    typeof normalized !== 'number'
    || !Number.isSafeInteger(normalized)
    || normalized <= 0
    || normalized > ceiling
  ) {
    throw new OllamaPullProgressError(
      'INVALID_CONFIGURATION',
      `Invalid Ollama pull ${label}`,
    );
  }
  return normalized;
}

function hasOwn(
  value: JsonRecord,
  property: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function phaseFor(status: string, digest: string | null): OllamaPullPhase {
  if (status === 'success') return 'complete';
  const normalized = status.toLowerCase();
  if (normalized.includes('pulling manifest')) return 'manifest';
  if (normalized.includes('verifying')) return 'verifying';
  if (normalized.includes('writing manifest')) return 'writing';
  if (
    normalized.includes('removing any unused layers')
    || normalized.includes('cleaning')
  ) {
    return 'cleanup';
  }
  if (
    digest !== null
    || normalized.startsWith('pulling ')
    || normalized.startsWith('downloading ')
  ) {
    return 'downloading';
  }
  return 'preparing';
}

function boundedRemoteMessage(value: string): string | null {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return null;

  let result = '';
  let bytes = 0;
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > MAX_REMOTE_ERROR_BYTES) break;
    result += character;
    bytes += characterBytes;
  }
  return result || null;
}

/**
 * Incrementally parses Ollama /api/pull NDJSON and retains only bounded,
 * primitive progress state. The accumulator latches its first parse failure:
 * callers cannot skip an unsafe frame and continue treating the stream as
 * authoritative.
 */
export class OllamaPullProgressAccumulator {
  private readonly now: () => number;
  private readonly maxLineBytes: number;
  private readonly maxRecords: number;
  private readonly pendingParts: Buffer[] = [];
  private readonly digests = new Map<string, DigestProgress>();

  private pendingBytes = 0;
  private records = 0;
  private sequence = 0;
  private latest: OllamaPullProgressSnapshot | null = null;
  private terminalSeen = false;
  private finished = false;
  private failure: OllamaPullProgressError | null = null;

  constructor(options: OllamaPullProgressOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxLineBytes = configurationInteger(
      options.maxLineBytes,
      OLLAMA_PULL_MAX_LINE_BYTES,
      OLLAMA_PULL_MAX_LINE_BYTES,
      'line limit',
    );
    this.maxRecords = configurationInteger(
      options.maxRecords,
      OLLAMA_PULL_MAX_RECORDS,
      OLLAMA_PULL_MAX_RECORDS,
      'record limit',
    );
  }

  get recordCount(): number {
    return this.records;
  }

  get isTerminal(): boolean {
    return this.terminalSeen;
  }

  snapshot(): OllamaPullProgressSnapshot | null {
    return this.latest;
  }

  /**
   * Accepts arbitrary byte boundaries and returns one immutable snapshot for
   * each complete record accepted from this chunk.
   */
  push(chunk: Buffer | Uint8Array): readonly OllamaPullProgressSnapshot[] {
    this.assertAvailable();
    if (!(chunk instanceof Uint8Array)) {
      return this.reject('INVALID_CHUNK', 'Invalid Ollama pull response chunk');
    }
    if (chunk.byteLength === 0) return Object.freeze([]);
    if (this.terminalSeen) {
      return this.reject(
        'AFTER_SUCCESS',
        'Ollama returned data after the terminal success record',
      );
    }

    const snapshots: OllamaPullProgressSnapshot[] = [];
    let offset = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.append(chunk.subarray(offset, index));
      snapshots.push(this.consumePendingLine());
      offset = index + 1;
      if (this.terminalSeen && offset < chunk.byteLength) {
        return this.reject(
          'AFTER_SUCCESS',
          'Ollama returned data after the terminal success record',
        );
      }
    }
    if (offset < chunk.byteLength) {
      if (this.terminalSeen) {
        return this.reject(
          'AFTER_SUCCESS',
          'Ollama returned data after the terminal success record',
        );
      }
      this.append(chunk.subarray(offset));
    }
    return Object.freeze(snapshots);
  }

  /**
   * Completes the stream. A final record need not end in LF, but a successful
   * HTTP EOF is not accepted until an exact status:"success" frame was parsed.
   */
  finish(): OllamaPullProgressSnapshot {
    if (this.failure) throw this.failure;
    if (this.finished) {
      if (!this.latest) {
        throw new OllamaPullProgressError(
          'EOF_BEFORE_SUCCESS',
          'Ollama pull ended before a terminal success record',
        );
      }
      return this.latest;
    }
    if (this.pendingBytes > 0) this.consumePendingLine();
    if (!this.terminalSeen || !this.latest) {
      return this.reject(
        'EOF_BEFORE_SUCCESS',
        'Ollama pull ended before a terminal success record',
      );
    }
    this.finished = true;
    return this.latest;
  }

  private assertAvailable(): void {
    if (this.failure) throw this.failure;
    if (this.finished) {
      throw new OllamaPullProgressError(
        'ALREADY_FINISHED',
        'Ollama pull progress stream is already finished',
      );
    }
  }

  private reject(
    code: OllamaPullProgressErrorCode,
    message: string,
    remoteMessage: string | null = null,
  ): never {
    const error = new OllamaPullProgressError(code, message, remoteMessage);
    this.failure = error;
    this.clearPending();
    throw error;
  }

  private clearPending(): void {
    for (const part of this.pendingParts) part.fill(0);
    this.pendingParts.length = 0;
    this.pendingBytes = 0;
  }

  private append(segment: Uint8Array): void {
    if (segment.byteLength === 0) return;
    const nextBytes = this.pendingBytes + segment.byteLength;
    if (nextBytes > this.maxLineBytes + 1) {
      return this.reject(
        'LINE_TOO_LARGE',
        'Ollama pull progress line exceeded 64 KiB',
      );
    }
    const finalByte = segment[segment.byteLength - 1];
    if (nextBytes === this.maxLineBytes + 1 && finalByte !== 0x0d) {
      return this.reject(
        'LINE_TOO_LARGE',
        'Ollama pull progress line exceeded 64 KiB',
      );
    }
    const copy = Buffer.from(segment);
    this.pendingParts.push(copy);
    this.pendingBytes = nextBytes;
  }

  private consumePendingLine(): OllamaPullProgressSnapshot {
    const parts = this.pendingParts.splice(0);
    const totalBytes = this.pendingBytes;
    this.pendingBytes = 0;
    const line = Buffer.concat(parts, totalBytes);
    for (const part of parts) part.fill(0);

    try {
      let content = line;
      if (content.byteLength > 0 && content[content.byteLength - 1] === 0x0d) {
        content = content.subarray(0, content.byteLength - 1);
      }
      if (content.byteLength === 0) {
        return this.reject(
          'MALFORMED_JSON',
          'Ollama returned an empty NDJSON record',
        );
      }
      if (content.byteLength > this.maxLineBytes) {
        return this.reject(
          'LINE_TOO_LARGE',
          'Ollama pull progress line exceeded 64 KiB',
        );
      }
      if (this.records >= this.maxRecords) {
        return this.reject(
          'TOO_MANY_RECORDS',
          'Ollama pull returned too many progress records',
        );
      }
      this.records += 1;

      let text: string;
      try {
        text = UTF8_DECODER.decode(content);
      } catch {
        return this.reject(
          'INVALID_UTF8',
          'Ollama pull progress was not valid UTF-8',
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return this.reject(
          'MALFORMED_JSON',
          'Ollama returned malformed pull progress JSON',
        );
      }
      if (
        parsed === null
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
      ) {
        return this.reject(
          'INVALID_RECORD',
          'Ollama pull progress record must be an object',
        );
      }
      const record = parsed as JsonRecord;
      this.assertJsonNumbersSafe(record);

      if (hasOwn(record, 'error')) {
        if (typeof record.error !== 'string') {
          return this.reject(
            'INVALID_RECORD',
            'Ollama pull error record had an invalid error field',
          );
        }
        const remoteMessage = boundedRemoteMessage(record.error);
        if (!remoteMessage) {
          return this.reject(
            'INVALID_RECORD',
            'Ollama pull error record had an invalid error field',
          );
        }
        return this.reject(
          'REMOTE_ERROR',
          `Ollama pull failed: ${remoteMessage}`,
          remoteMessage,
        );
      }

      const status = this.status(record.status);
      const digest = hasOwn(record, 'digest')
        ? this.digest(record.digest)
        : null;
      const hasTotal = hasOwn(record, 'total');
      const hasCompleted = hasOwn(record, 'completed');
      const total = hasTotal
        ? this.byteCount(record.total, 'total')
        : null;
      const completed = hasCompleted
        ? this.byteCount(record.completed, 'completed')
        : null;

      if ((hasTotal || hasCompleted) && digest === null) {
        return this.reject(
          'INVALID_RECORD',
          'Ollama pull byte counters require a digest',
        );
      }
      if (
        status === 'success'
        && (digest !== null || hasTotal || hasCompleted)
      ) {
        return this.reject(
          'INVALID_RECORD',
          'Ollama terminal success record had progress fields',
        );
      }

      return this.acceptRecord({
        status,
        digest,
        hasTotal,
        total,
        hasCompleted,
        completed,
      });
    } finally {
      line.fill(0);
    }
  }

  private assertJsonNumbersSafe(root: unknown): void {
    const pending: unknown[] = [root];
    let visited = 0;
    while (pending.length > 0) {
      const value = pending.pop();
      visited += 1;
      if (visited > MAX_JSON_NODES_PER_RECORD) {
        return this.reject(
          'INVALID_RECORD',
          'Ollama pull progress record was too complex',
        );
      }
      if (typeof value === 'number') {
        if (
          !Number.isFinite(value)
          || Math.abs(value) > Number.MAX_SAFE_INTEGER
          || Object.is(value, -0)
        ) {
          return this.reject(
            'UNSAFE_NUMBER',
            'Ollama pull progress contained an unsafe number',
          );
        }
        continue;
      }
      if (value !== null && typeof value === 'object') {
        pending.push(...Object.values(value as Record<string, unknown>));
      }
    }
  }

  private status(value: unknown): string {
    if (typeof value !== 'string') {
      return this.reject(
        'INVALID_RECORD',
        'Ollama pull progress record had an invalid status',
      );
    }
    const normalized = value.trim();
    if (
      !normalized
      || normalized !== value
      || Buffer.byteLength(normalized, 'utf8') > MAX_STATUS_BYTES
      || /[\u0000-\u001f\u007f]/u.test(normalized)
    ) {
      return this.reject(
        'INVALID_RECORD',
        'Ollama pull progress record had an invalid status',
      );
    }
    return normalized;
  }

  private digest(value: unknown): string {
    if (typeof value !== 'string') {
      return this.reject(
        'INVALID_RECORD',
        'Ollama pull progress record had an invalid digest',
      );
    }
    const match = /^(?:sha256:)?([a-f0-9]{64})$/iu.exec(value);
    if (!match) {
      return this.reject(
        'INVALID_RECORD',
        'Ollama pull progress record had an invalid digest',
      );
    }
    return `sha256:${match[1].toLowerCase()}`;
  }

  private byteCount(value: unknown, label: 'total' | 'completed'): number {
    if (
      typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < 0
      || Object.is(value, -0)
    ) {
      return this.reject(
        'UNSAFE_NUMBER',
        `Ollama pull progress had an unsafe ${label} byte count`,
      );
    }
    return value;
  }

  private currentTime(): number {
    const value = this.now();
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || Math.abs(value) > 8.64e15
    ) {
      return this.reject(
        'INVALID_TIME',
        'Ollama pull progress clock returned an invalid time',
      );
    }
    return value;
  }

  private acceptRecord(input: {
    status: string;
    digest: string | null;
    hasTotal: boolean;
    total: number | null;
    hasCompleted: boolean;
    completed: number | null;
  }): OllamaPullProgressSnapshot {
    const nowMs = this.currentTime();
    let totalBytes: number | null = null;
    let completedBytes: number | null = null;
    let speedBytesPerSecond: number | null = null;

    if (input.digest !== null) {
      const previous = this.digests.get(input.digest);
      if (
        input.hasTotal
        && previous?.totalBytes !== null
        && previous?.totalBytes !== undefined
        && input.total! < previous.totalBytes
      ) {
        return this.reject(
          'PROGRESS_REGRESSION',
          'Ollama pull total byte count regressed for a digest',
        );
      }
      if (
        input.hasCompleted
        && previous?.completedBytes !== null
        && previous?.completedBytes !== undefined
        && input.completed! < previous.completedBytes
      ) {
        return this.reject(
          'PROGRESS_REGRESSION',
          'Ollama pull completed byte count regressed for a digest',
        );
      }

      totalBytes = input.hasTotal
        ? input.total
        : previous?.totalBytes ?? null;
      completedBytes = input.hasCompleted
        ? input.completed
        : previous?.completedBytes ?? null;
      if (
        totalBytes !== null
        && completedBytes !== null
        && completedBytes > totalBytes
      ) {
        return this.reject(
          'INVALID_RECORD',
          'Ollama pull completed bytes exceeded total bytes',
        );
      }

      let sampleCompletedBytes = previous?.sampleCompletedBytes ?? null;
      let sampleAtMs = previous?.sampleAtMs ?? null;
      speedBytesPerSecond = previous?.speedBytesPerSecond ?? null;
      if (input.hasCompleted) {
        if (
          sampleCompletedBytes !== null
          && sampleAtMs !== null
          && nowMs > sampleAtMs
        ) {
          const elapsedMs = nowMs - sampleAtMs;
          speedBytesPerSecond = (
            (input.completed! - sampleCompletedBytes) / elapsedMs
          ) * 1_000;
          if (!Number.isFinite(speedBytesPerSecond)) {
            speedBytesPerSecond = null;
          }
        } else {
          speedBytesPerSecond = null;
        }
        sampleCompletedBytes = input.completed;
        sampleAtMs = nowMs;
      }

      if (!previous && this.digests.size >= OLLAMA_PULL_MAX_DIGESTS) {
        return this.reject(
          'INVALID_RECORD',
          'Ollama pull referenced too many digests',
        );
      }
      this.digests.set(input.digest, Object.freeze({
        totalBytes,
        completedBytes,
        sampleCompletedBytes,
        sampleAtMs,
        speedBytesPerSecond,
      }));
    }

    const percent = (
      totalBytes !== null
      && totalBytes > 0
      && completedBytes !== null
    )
      ? (completedBytes / totalBytes) * 100
      : null;
    let etaSeconds: number | null = null;
    if (
      totalBytes !== null
      && completedBytes !== null
      && completedBytes === totalBytes
    ) {
      etaSeconds = 0;
    } else if (
      totalBytes !== null
      && completedBytes !== null
      && speedBytesPerSecond !== null
      && speedBytesPerSecond > 0
    ) {
      const estimate = (totalBytes - completedBytes) / speedBytesPerSecond;
      etaSeconds = Number.isFinite(estimate) && estimate >= 0
        ? estimate
        : null;
    }

    this.sequence += 1;
    const snapshot: OllamaPullProgressSnapshot = Object.freeze({
      phase: phaseFor(input.status, input.digest),
      status: input.status,
      digest: input.digest,
      totalBytes,
      completedBytes,
      percent,
      speedBytesPerSecond,
      etaSeconds,
      eventSeq: this.sequence,
      updatedAt: new Date(nowMs).toISOString(),
    });
    this.latest = snapshot;
    if (input.status === 'success') this.terminalSeen = true;
    return snapshot;
  }
}
