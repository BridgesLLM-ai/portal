import { randomUUID } from 'node:crypto';
import {
  OllamaBackendAuthorityError,
  resolveOllamaBackendAuthority,
  streamResolvedOllama,
  type OllamaBackendAuthority,
  type OllamaBackendAuthorityStreamResponse,
  type ResolvedOllamaBackendAuthority,
} from './ollamaBackendAuthority';
import {
  OllamaPullProgressAccumulator,
  OllamaPullProgressError,
  type OllamaPullPhase,
  type OllamaPullProgressSnapshot,
} from './ollamaPullProgress';
import { isValidOllamaModelName } from '../utils/ollamaRecommendations';
import { DEFAULT_LOCAL_OLLAMA_ENDPOINT } from '../utils/localOllamaEndpoint';

export const OLLAMA_PULL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const FINISHED_JOB_RETENTION_MS = 15 * 60 * 1000;
const MAX_RETAINED_JOBS = 50;
const MAX_ERROR_BYTES = 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type OllamaPullState =
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface OllamaPullAuthoritySnapshot {
  kind: OllamaBackendAuthority['kind'];
  generation: number | null;
  version: number | null;
  fingerprint: string;
}

export interface OllamaPullExpectedAuthority {
  kind: OllamaBackendAuthority['kind'];
  generation: number | null;
  version: number | null;
  fingerprint: string;
}

export interface OllamaPullSnapshot {
  id: string;
  operationId: string;
  model: string;
  room: string;
  state: OllamaPullState;
  phase: OllamaPullPhase;
  status: string;
  digest: string | null;
  totalBytes: number | null;
  completedBytes: number | null;
  percent: number | null;
  speedBytesPerSecond: number | null;
  etaSeconds: number | null;
  eventSeq: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error: string | null;
  canCancel: boolean;
  outputTruncated: false;
  authority?: OllamaPullAuthoritySnapshot;
}

export type OllamaPullOutput = {
  stream: 'stdout' | 'stderr';
  text: string;
  truncated?: boolean;
};

type PullCallbacks = {
  onOutput?: (output: OllamaPullOutput, job: OllamaPullSnapshot) => void;
  onProgress?: (job: OllamaPullSnapshot) => void;
  onDone?: (job: OllamaPullSnapshot) => void;
};

type CancellationReason = 'cancelled' | 'timed_out';

type InternalPullJob = OllamaPullSnapshot & {
  controller: AbortController;
  callbacks: PullCallbacks;
  timeout: NodeJS.Timeout;
  cancellationReason: CancellationReason | null;
  terminalSuccessLatched: boolean;
  requestPull: OllamaPullStreamRequest;
};

export class OllamaPullBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaPullBusyError';
  }
}

export type OllamaPullStreamRequest = (
  model: string,
  signal: AbortSignal,
  onChunk: (chunk: Buffer) => void | Promise<void>,
  onAuthority: (authority: OllamaBackendAuthority) => void,
) => Promise<OllamaBackendAuthorityStreamResponse>;

async function requestPullThroughConfiguredAuthority(
  model: string,
  signal: AbortSignal,
  onChunk: (chunk: Buffer) => void | Promise<void>,
  onAuthority: (authority: OllamaBackendAuthority) => void,
): Promise<OllamaBackendAuthorityStreamResponse> {
  const resolved = await resolveOllamaBackendAuthority();
  return requestPullThroughResolvedAuthority(
    resolved,
    model,
    signal,
    onChunk,
    onAuthority,
  );
}

async function requestPullThroughResolvedAuthority(
  resolved: ResolvedOllamaBackendAuthority,
  model: string,
  signal: AbortSignal,
  onChunk: (chunk: Buffer) => void | Promise<void>,
  onAuthority: (authority: OllamaBackendAuthority) => void,
): Promise<OllamaBackendAuthorityStreamResponse> {
  onAuthority(resolved.authority);
  return streamResolvedOllama(resolved, {
    path: '/api/pull',
    method: 'POST',
    json: {
      model,
      stream: true,
    },
    timeoutMs: OLLAMA_PULL_TIMEOUT_MS,
    maxResponseBytes: 64 * 1024 * 1024,
    signal,
  }, onChunk);
}

function boundedErrorMessage(error: unknown): string {
  let message = 'Ollama could not complete the model pull';
  if (error instanceof OllamaPullProgressError) {
    message = error.remoteMessage
      ? `Ollama pull failed: ${error.remoteMessage}`
      : error.message;
  } else if (error instanceof OllamaBackendAuthorityError) {
    message = error.message;
  }
  const normalized = message
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  let result = '';
  let bytes = 0;
  for (const character of normalized) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MAX_ERROR_BYTES) break;
    result += character;
    bytes += size;
  }
  return result || 'Ollama could not complete the model pull';
}

function authoritySnapshot(
  authority: OllamaBackendAuthority,
): OllamaPullAuthoritySnapshot {
  return Object.freeze({
    kind: authority.kind,
    generation: authority.generation,
    version: authority.version,
    fingerprint: authority.bindingFingerprint,
  });
}

function expectedAuthorityMatches(
  expected: OllamaPullExpectedAuthority,
  authority: OllamaBackendAuthority,
): boolean {
  return expected.kind === authority.kind
    && expected.generation === authority.generation
    && expected.version === authority.version
    && expected.fingerprint === authority.bindingFingerprint;
}

function normalizedExpectedAuthority(
  value: OllamaPullExpectedAuthority,
): OllamaPullExpectedAuthority {
  const fingerprint = String(value?.fingerprint || '').trim();
  if (
    (value?.kind !== 'LOCAL' && value?.kind !== 'TAILNET')
    || !/^[^\u0000-\u001f\u007f]{1,256}$/u.test(fingerprint)
    || (
      value.kind === 'LOCAL'
      && (value.generation !== null || value.version !== null)
    )
    || (
      value.kind === 'TAILNET'
      && (
        !Number.isSafeInteger(value.generation)
        || Number(value.generation) < 1
        || !Number.isSafeInteger(value.version)
        || Number(value.version) < 1
      )
    )
  ) {
    throw new OllamaBackendAuthorityError('BINDING_CHANGED', 409);
  }
  return Object.freeze({
    kind: value.kind,
    generation: value.generation,
    version: value.version,
    fingerprint,
  });
}

export class OllamaPullManager {
  private readonly jobs = new Map<string, InternalPullJob>();

  constructor(
    private readonly requestPull: OllamaPullStreamRequest =
      requestPullThroughConfiguredAuthority,
  ) {}

  start(model: string, callbacks: PullCallbacks = {}): OllamaPullSnapshot {
    return this.startPrepared(
      model,
      randomUUID(),
      callbacks,
      this.requestPull,
    );
  }

  async startBound(
    model: string,
    expectedAuthority: OllamaPullExpectedAuthority,
    operationId: string,
    callbacks: PullCallbacks = {},
  ): Promise<OllamaPullSnapshot> {
    const expected = normalizedExpectedAuthority(expectedAuthority);
    const resolved = await resolveOllamaBackendAuthority();
    if (!expectedAuthorityMatches(expected, resolved.authority)) {
      throw new OllamaBackendAuthorityError('BINDING_CHANGED', 409);
    }
    const requestPull: OllamaPullStreamRequest = (
      selectedModel,
      signal,
      onChunk,
      onAuthority,
    ) => requestPullThroughResolvedAuthority(
      resolved,
      selectedModel,
      signal,
      onChunk,
      onAuthority,
    );
    return this.startPrepared(
      model,
      operationId,
      callbacks,
      requestPull,
      resolved.authority,
    );
  }

  private startPrepared(
    model: string,
    operationId: string,
    callbacks: PullCallbacks,
    requestPull: OllamaPullStreamRequest,
    authority?: OllamaBackendAuthority,
  ): OllamaPullSnapshot {
    this.pruneFinishedJobs();
    if (!isValidOllamaModelName(model)) {
      throw new Error('Invalid Ollama model name');
    }
    if (!UUID_PATTERN.test(operationId)) {
      throw new Error('Invalid Ollama pull operation ID');
    }
    const normalizedModel = model;
    if ([...this.jobs.values()].some(
      (job) => job.operationId === operationId,
    )) {
      throw new OllamaPullBusyError(
        'This Ollama pull operation was already accepted',
      );
    }
    const activeJobs = [...this.jobs.values()].filter(
      (job) => job.state === 'running' || job.state === 'cancelling',
    );
    if (activeJobs.some((job) => job.model === normalizedModel)) {
      throw new OllamaPullBusyError(
        `A pull for ${normalizedModel} is already running`,
      );
    }
    if (activeJobs.length >= 1) {
      throw new OllamaPullBusyError(
        `Another Ollama model pull is already running (${activeJobs[0].model})`,
      );
    }

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const job: InternalPullJob = {
      id,
      operationId,
      model: normalizedModel,
      room: `ollama-pull-${id}`,
      state: 'running',
      phase: 'preparing',
      status: 'Preparing model download…',
      digest: null,
      totalBytes: null,
      completedBytes: null,
      percent: null,
      speedBytesPerSecond: null,
      etaSeconds: null,
      eventSeq: 0,
      startedAt,
      updatedAt: startedAt,
      error: null,
      canCancel: true,
      outputTruncated: false,
      controller,
      callbacks,
      cancellationReason: null,
      terminalSuccessLatched: false,
      requestPull,
      timeout: setTimeout(
        () => this.requestCancellation(job, 'timed_out'),
        OLLAMA_PULL_TIMEOUT_MS,
      ),
    };
    if (authority) job.authority = authoritySnapshot(authority);
    job.timeout.unref?.();
    this.jobs.set(id, job);
    void this.run(job);
    return this.snapshot(job);
  }

  get(id: string): OllamaPullSnapshot | null {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : null;
  }

  list(): OllamaPullSnapshot[] {
    this.pruneFinishedJobs();
    return [...this.jobs.values()]
      .map((job) => this.snapshot(job))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  cancel(id: string): OllamaPullSnapshot | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state === 'running') this.requestCancellation(job, 'cancelled');
    return this.snapshot(job);
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) {
      if (job.state === 'running') this.requestCancellation(job, 'cancelled');
    }
  }

  private async run(job: InternalPullJob): Promise<void> {
    const accumulator = new OllamaPullProgressAccumulator();
    try {
      await job.requestPull(
        job.model,
        job.controller.signal,
        (chunk) => {
          for (const progress of accumulator.push(chunk)) {
            this.applyProgress(job, progress);
          }
        },
        (authority) => {
          if (job.state !== 'running') return;
          job.authority = authoritySnapshot(authority);
          job.updatedAt = new Date().toISOString();
          job.callbacks.onProgress?.(this.snapshot(job));
        },
      );
      const terminal = accumulator.finish();
      if (job.terminalSuccessLatched) {
        if (job.eventSeq < terminal.eventSeq) this.applyProgress(job, terminal);
        this.finalize(job, 'succeeded');
        return;
      }
      if (job.cancellationReason) {
        this.finalizeCancellation(job);
        return;
      }
      if (job.eventSeq < terminal.eventSeq) this.applyProgress(job, terminal);
      this.finalize(job, 'succeeded');
    } catch (error) {
      if (job.terminalSuccessLatched) {
        this.finalize(job, 'succeeded');
        return;
      }
      if (job.cancellationReason) {
        this.finalizeCancellation(job);
        return;
      }
      this.finalize(job, 'failed', boundedErrorMessage(error));
    }
  }

  private applyProgress(
    job: InternalPullJob,
    progress: OllamaPullProgressSnapshot,
  ): void {
    if (job.state !== 'running') return;
    const completed = progress.phase === 'complete';
    job.phase = progress.phase;
    job.status = progress.status;
    job.eventSeq = progress.eventSeq;
    job.updatedAt = progress.updatedAt;
    if (completed) {
      // Terminal success is authoritative. If it directly follows a layer,
      // finish that current layer at 100%. Status-only phases already cleared
      // prior-layer counters, so they remain honestly indeterminate here.
      if (job.totalBytes !== null) {
        job.completedBytes = job.totalBytes;
        job.percent = 100;
        job.speedBytesPerSecond = 0;
        job.etaSeconds = 0;
      }
      job.terminalSuccessLatched = true;
      job.cancellationReason = null;
      job.canCancel = false;
      clearTimeout(job.timeout);
      // Ollama's terminal success record is the protocol commit point. Close
      // the exact stream immediately so a peer cannot hold the authority lease
      // and single-pull lane forever by withholding HTTP EOF.
      job.controller.abort();
    } else {
      // These fields always describe the current Ollama layer. Status-only
      // phases such as verification and manifest writing must clear the prior
      // layer rather than relabeling stale counters as current progress.
      job.digest = progress.digest;
      job.totalBytes = progress.totalBytes;
      job.completedBytes = progress.completedBytes;
      job.percent = progress.percent;
      job.speedBytesPerSecond = progress.speedBytesPerSecond;
      job.etaSeconds = progress.etaSeconds;
    }
    const snapshot = this.snapshot(job);
    job.callbacks.onProgress?.(snapshot);
    job.callbacks.onOutput?.({
      stream: 'stdout',
      text: `${progress.status}\n`,
    }, snapshot);
  }

  private requestCancellation(
    job: InternalPullJob,
    reason: CancellationReason,
  ): void {
    if (job.state !== 'running' || job.terminalSuccessLatched) return;
    job.cancellationReason = reason;
    job.state = 'cancelling';
    job.status = reason === 'timed_out'
      ? 'Stopping a timed-out download…'
      : 'Cancelling download…';
    job.canCancel = false;
    job.updatedAt = new Date().toISOString();
    clearTimeout(job.timeout);
    job.controller.abort();
    job.callbacks.onProgress?.(this.snapshot(job));
  }

  private finalizeCancellation(job: InternalPullJob): void {
    const reason = job.cancellationReason ?? 'cancelled';
    this.finalize(
      job,
      reason,
      reason === 'timed_out'
        ? 'Ollama pull exceeded the two-hour limit'
        : null,
    );
  }

  private finalize(
    job: InternalPullJob,
    state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
    error: string | null = null,
  ): void {
    if (job.state !== 'running' && job.state !== 'cancelling') return;
    clearTimeout(job.timeout);
    job.state = state;
    job.canCancel = false;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    job.error = error;
    if (state === 'succeeded') {
      job.phase = 'complete';
      job.status = 'success';
    } else if (state === 'cancelled') {
      job.status = 'Download cancelled';
    } else if (state === 'timed_out') {
      job.status = 'Download timed out';
    } else {
      job.status = 'Download failed';
    }
    job.callbacks.onDone?.(this.snapshot(job));
  }

  private snapshot(job: InternalPullJob): OllamaPullSnapshot {
    return Object.freeze({
      id: job.id,
      operationId: job.operationId,
      model: job.model,
      room: job.room,
      state: job.state,
      phase: job.phase,
      status: job.status,
      digest: job.digest,
      totalBytes: job.totalBytes,
      completedBytes: job.completedBytes,
      percent: job.percent,
      speedBytesPerSecond: job.speedBytesPerSecond,
      etaSeconds: job.etaSeconds,
      eventSeq: job.eventSeq,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      error: job.error,
      canCancel: job.canCancel,
      outputTruncated: false as const,
      ...(job.authority ? { authority: { ...job.authority } } : {}),
    });
  }

  private pruneFinishedJobs(): void {
    const cutoff = Date.now() - FINISHED_JOB_RETENTION_MS;
    const finished = [...this.jobs.values()]
      .filter((job) => (
        job.state !== 'running' && job.state !== 'cancelling'
      ))
      .sort((left, right) => (
        (left.finishedAt || '').localeCompare(right.finishedAt || '')
      ));
    for (const job of finished) {
      if (
        (job.finishedAt && Date.parse(job.finishedAt) < cutoff)
        || this.jobs.size > MAX_RETAINED_JOBS
      ) {
        this.jobs.delete(job.id);
      }
    }
  }
}

export const ollamaPullManager = new OllamaPullManager();

export function localOllamaCliEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    // Ollama 0.32.3+ panics when $HOME is undefined; keep the CLI otherwise
    // isolated from inherited endpoints and proxy routing.
    HOME: process.env.HOME || '/root',
    LANG: 'C',
    LC_ALL: 'C',
    OLLAMA_HOST: DEFAULT_LOCAL_OLLAMA_ENDPOINT,
  };
}
