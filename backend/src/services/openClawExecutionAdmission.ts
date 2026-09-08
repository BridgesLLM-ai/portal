import fs from 'fs';
import path from 'path';
import {
  OPENCLAW_GATEWAY_FENCE_MARKER,
  OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
} from './openClawGatewayAuthorizationFence';
import {
  getOpenClawSetupReadiness,
  type OpenClawSetupReadiness,
} from './openclawSetupReadiness';
import {
  getOpenClawQuestionPluginReadiness,
  type OpenClawQuestionPluginReadiness,
} from './openClawQuestionRuntimeReadiness';

export const OPENCLAW_MUTATION_MAINTENANCE_MARKER =
  '/var/lib/bridgesllm-installer/openclaw-mutation-maintenance-v1.json';
export const OPENCLAW_MUTATION_MAINTENANCE_MARKER_SCHEMA =
  'bridgesllm.openclaw-mutation-maintenance.v1';
export const OPENCLAW_HOST_MUTATION_ACTIVE_JOURNAL =
  '/var/lib/bridgesllm-installer/host-mutations/npm-cli-v1/active.json';
export const OPENCLAW_HOST_MUTATION_ACTIVE_JOURNALS = Object.freeze([
  '/var/lib/bridgesllm-installer/host-mutations/active-host-mutation.json',
  OPENCLAW_HOST_MUTATION_ACTIVE_JOURNAL,
  '/var/lib/bridgesllm-installer/host-mutations/native-binary-v1/active.json',
] as const);

const READINESS_ATTESTATION_TTL_MS = 60_000;
const MAX_MAINTENANCE_MARKER_BYTES = 2_048;
const MAX_HOST_MUTATION_JOURNAL_BYTES = 16 * 1024 * 1024;

export type OpenClawExecutionAdmissionState =
  | 'ready'
  | 'maintenance'
  | 'recovery-required'
  | 'unavailable';

export type OpenClawDurableEvidenceState = 'absent' | 'present' | 'unsafe';

export interface OpenClawDurableEvidence {
  state: OpenClawDurableEvidenceState;
  reason?: string;
}

export interface OpenClawExecutionAdmissionEvidence {
  authorizationFence: OpenClawDurableEvidenceState;
  maintenanceMarker: OpenClawDurableEvidenceState;
  hostMutationJournal: OpenClawDurableEvidenceState;
}

export interface OpenClawExecutionAdmission {
  state: OpenClawExecutionAdmissionState;
  ready: boolean;
  reason: string;
  checkedAt: string;
  evidence: OpenClawExecutionAdmissionEvidence;
  readinessBlockers: readonly string[];
}

export interface OpenClawExecutionAdmissionDependencies {
  inspectAuthorizationFence(): OpenClawDurableEvidence;
  inspectMaintenanceMarker(): OpenClawDurableEvidence;
  inspectHostMutationJournal(): OpenClawDurableEvidence;
  getReadiness(): Promise<OpenClawSetupReadiness>;
  getQuestionRuntimeReadiness(
    readiness: OpenClawSetupReadiness,
  ): Promise<OpenClawQuestionPluginReadiness>;
  now(): number;
}

export interface OpenClawExecutionAdmissionOptions {
  forceReadiness?: boolean;
  useSharedCache?: boolean;
}

type ReadinessAttestation = Readonly<{
  generation: number | null;
  at: number;
  readiness: OpenClawSetupReadiness | null;
  questionRuntime: OpenClawQuestionPluginReadiness | null;
}>;

type ReadinessAttestationInFlight = Readonly<{
  generation: number;
  promise: Promise<ReadinessAttestation>;
}>;

let readinessAttestationGeneration = 0;
let readinessAttestationCache: ReadinessAttestation | null = null;
let readinessAttestationInFlight: ReadinessAttestationInFlight | null = null;

function invalidateSharedReadinessAttestation(): void {
  readinessAttestationGeneration += 1;
  readinessAttestationCache = null;
  // A running probe cannot be cancelled, but detaching it here allows the
  // post-maintenance generation to start immediately. Its completion handler
  // is generation-bound and therefore cannot repopulate either shared slot.
  readinessAttestationInFlight = null;
}

function inspectSafeParentChain(filePath: string): 'safe' | 'absent' {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  const parent = path.dirname(absolute);
  const parts = parent.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (const part of parts) {
    current = path.join(current, part);
    let details: fs.Stats;
    try {
      details = fs.lstatSync(current);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return 'absent';
      throw error;
    }
    if (
      !details.isDirectory()
      || details.isSymbolicLink()
      || details.uid !== 0
      || details.gid !== 0
      || (details.mode & 0o022) !== 0
    ) {
      throw new Error('durable evidence parent directory is unsafe');
    }
  }
  return 'safe';
}

function inspectRootOwnedEvidenceFile(input: {
  filePath: string;
  label: string;
  expectedContent?: string;
  validateContent?: (content: string) => boolean;
  maximumBytes: number;
}): OpenClawDurableEvidence {
  try {
    if (inspectSafeParentChain(input.filePath) === 'absent') {
      return Object.freeze({ state: 'absent' });
    }

    let before: fs.Stats;
    try {
      before = fs.lstatSync(input.filePath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return Object.freeze({ state: 'absent' });
      throw error;
    }

    const expectedBytes = input.expectedContent === undefined
      ? null
      : Buffer.byteLength(input.expectedContent);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.uid !== 0
      || before.gid !== 0
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size < 0
      || before.size > input.maximumBytes
      || (expectedBytes !== null && before.size !== expectedBytes)
      || (input.validateContent !== undefined && before.size < 1)
    ) {
      throw new Error('durable evidence file is unsafe');
    }

    const descriptor = fs.openSync(
      input.filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        opened.dev !== before.dev
        || opened.ino !== before.ino
        || opened.nlink !== before.nlink
        || opened.size !== before.size
        || opened.mode !== before.mode
      ) {
        throw new Error('durable evidence file changed during attestation');
      }
      if (input.expectedContent !== undefined || input.validateContent !== undefined) {
        const content = fs.readFileSync(descriptor, 'utf8');
        if (
          (input.expectedContent !== undefined && content !== input.expectedContent)
          || (input.validateContent !== undefined && !input.validateContent(content))
        ) {
          throw new Error('durable evidence file content is invalid');
        }
      }
      const after = fs.fstatSync(descriptor);
      if (
        after.dev !== opened.dev
        || after.ino !== opened.ino
        || after.nlink !== opened.nlink
        || after.size !== opened.size
        || after.mode !== opened.mode
      ) {
        throw new Error('durable evidence file raced attestation');
      }
    } finally {
      fs.closeSync(descriptor);
    }
    return Object.freeze({ state: 'present' });
  } catch {
    return Object.freeze({
      state: 'unsafe',
      reason: `${input.label} could not be safely attested.`,
    });
  }
}

function aggregateDurableEvidence(
  inspections: readonly OpenClawDurableEvidence[],
): OpenClawDurableEvidence {
  const unsafe = inspections.find((inspection) => inspection.state === 'unsafe');
  if (unsafe) return unsafe;
  if (inspections.some((inspection) => inspection.state === 'present')) {
    return Object.freeze({ state: 'present' });
  }
  return Object.freeze({ state: 'absent' });
}

function inspectHostMutationJournals(): OpenClawDurableEvidence {
  return aggregateDurableEvidence(OPENCLAW_HOST_MUTATION_ACTIVE_JOURNALS.map((filePath) => (
    inspectRootOwnedEvidenceFile({
      filePath,
      label: 'OpenClaw host-mutation journal',
      maximumBytes: MAX_HOST_MUTATION_JOURNAL_BYTES,
    })
  )));
}

function isCanonicalMaintenanceTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length < 20
    || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  ) return false;
  return Number.isFinite(Date.parse(value));
}

function validateCanonicalMaintenanceMarker(content: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  if (
    !isCanonicalMaintenanceTimestamp(marker.createdAt)
    || !isCanonicalMaintenanceTimestamp(marker.updatedAt)
    || Date.parse(marker.updatedAt) < Date.parse(marker.createdAt)
    || typeof marker.operationId !== 'string'
    || !/^[a-f0-9]{32}$/.test(marker.operationId)
    || (marker.phase !== 'arming' && marker.phase !== 'maintenance')
    || marker.schema !== OPENCLAW_MUTATION_MAINTENANCE_MARKER_SCHEMA
    || typeof marker.systemDropInSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(marker.systemDropInSha256)
    || marker.unit !== 'openclaw-gateway.service'
  ) return false;

  // Installer helpers serialize durable records with sorted keys, compact
  // separators, ASCII data, and one terminal newline. Requiring those exact
  // bytes prevents duplicate keys or alternate encodings from changing the
  // meaning seen by another parser.
  const canonical = JSON.stringify({
    createdAt: marker.createdAt,
    operationId: marker.operationId,
    phase: marker.phase,
    schema: marker.schema,
    systemDropInSha256: marker.systemDropInSha256,
    unit: marker.unit,
    updatedAt: marker.updatedAt,
  }) + '\n';
  return content === canonical;
}

const defaultDependencies: OpenClawExecutionAdmissionDependencies = Object.freeze({
  inspectAuthorizationFence: () => inspectRootOwnedEvidenceFile({
    filePath: OPENCLAW_GATEWAY_FENCE_MARKER,
    label: 'OpenClaw authorization transition',
    expectedContent: OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
    maximumBytes: Buffer.byteLength(OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT),
  }),
  inspectMaintenanceMarker: () => inspectRootOwnedEvidenceFile({
    filePath: OPENCLAW_MUTATION_MAINTENANCE_MARKER,
    label: 'OpenClaw maintenance marker',
    validateContent: validateCanonicalMaintenanceMarker,
    maximumBytes: MAX_MAINTENANCE_MARKER_BYTES,
  }),
  inspectHostMutationJournal: inspectHostMutationJournals,
  getReadiness: () => getOpenClawSetupReadiness(),
  getQuestionRuntimeReadiness: (readiness) => getOpenClawQuestionPluginReadiness(readiness),
  now: () => Date.now(),
});

function usesSharedCache(
  overrides: Partial<OpenClawExecutionAdmissionDependencies>,
  options: OpenClawExecutionAdmissionOptions,
): boolean {
  return Object.keys(overrides).length === 0 || options.useSharedCache === true;
}

function evidenceSnapshot(
  dependencies: OpenClawExecutionAdmissionDependencies,
): {
  evidence: OpenClawExecutionAdmissionEvidence;
  authorizationFence: OpenClawDurableEvidence;
  maintenanceMarker: OpenClawDurableEvidence;
  hostMutationJournal: OpenClawDurableEvidence;
} {
  const authorizationFence = dependencies.inspectAuthorizationFence();
  const maintenanceMarker = dependencies.inspectMaintenanceMarker();
  const hostMutationJournal = dependencies.inspectHostMutationJournal();
  return {
    evidence: Object.freeze({
      authorizationFence: authorizationFence.state,
      maintenanceMarker: maintenanceMarker.state,
      hostMutationJournal: hostMutationJournal.state,
    }),
    authorizationFence,
    maintenanceMarker,
    hostMutationJournal,
  };
}

function invalidateReadinessForRuntimeMutationEvidence(
  snapshot: ReturnType<typeof evidenceSnapshot>,
  shared: boolean,
): void {
  if (!shared) return;
  // Authorization retirement does not change the installed runtime tuple.
  // Installer maintenance and every host-mutation WAL can. Unsafe evidence is
  // treated the same as present evidence: an old positive attestation must not
  // survive a boundary whose state could not be proved.
  if (
    snapshot.maintenanceMarker.state !== 'absent'
    || snapshot.hostMutationJournal.state !== 'absent'
  ) {
    invalidateSharedReadinessAttestation();
  }
}

function admission(
  state: OpenClawExecutionAdmissionState,
  reason: string,
  checkedAt: number,
  evidence: OpenClawExecutionAdmissionEvidence,
  readinessBlockers: readonly string[] = [],
): OpenClawExecutionAdmission {
  return Object.freeze({
    state,
    ready: state === 'ready',
    reason,
    checkedAt: new Date(checkedAt).toISOString(),
    evidence,
    readinessBlockers: Object.freeze([...readinessBlockers]),
  });
}

function durableAdmission(
  snapshot: ReturnType<typeof evidenceSnapshot>,
  checkedAt: number,
): OpenClawExecutionAdmission | null {
  const unsafe = [
    snapshot.authorizationFence,
    snapshot.maintenanceMarker,
    snapshot.hostMutationJournal,
  ].find((candidate) => candidate.state === 'unsafe');
  if (unsafe) {
    return admission(
      'unavailable',
      unsafe.reason || 'OpenClaw durable execution evidence is unsafe.',
      checkedAt,
      snapshot.evidence,
    );
  }
  if (snapshot.hostMutationJournal.state === 'present') {
    return admission(
      'recovery-required',
      'An interrupted managed host mutation must be recovered before OpenClaw can execute another turn.',
      checkedAt,
      snapshot.evidence,
    );
  }
  if (snapshot.maintenanceMarker.state === 'present') {
    return admission(
      'maintenance',
      'OpenClaw execution is paused while supervised host maintenance is active.',
      checkedAt,
      snapshot.evidence,
    );
  }
  if (snapshot.authorizationFence.state === 'present') {
    return admission(
      'unavailable',
      'OpenClaw execution is unavailable while an authorization transition is durably fenced.',
      checkedAt,
      snapshot.evidence,
    );
  }
  return null;
}

async function collectReadinessAttestation(
  dependencies: OpenClawExecutionAdmissionDependencies,
  shared: boolean,
  force: boolean,
): Promise<ReadinessAttestation> {
  const now = dependencies.now();
  if (
    shared
    && !force
    && readinessAttestationCache
    && readinessAttestationCache.generation === readinessAttestationGeneration
    && now - readinessAttestationCache.at < READINESS_ATTESTATION_TTL_MS
  ) {
    return readinessAttestationCache;
  }
  if (
    shared
    && readinessAttestationInFlight?.generation === readinessAttestationGeneration
  ) return readinessAttestationInFlight.promise;

  const generation = shared ? readinessAttestationGeneration : null;

  const collect = (async (): Promise<ReadinessAttestation> => {
    try {
      const readiness = await dependencies.getReadiness();
      // A maintenance/WAL observation in another admission can invalidate this
      // probe while the setup-readiness subprocess is still running. Do not
      // continue into a question-authority probe against a possibly replaced
      // runtime family.
      if (generation !== null && generation !== readinessAttestationGeneration) {
        return Object.freeze({
          generation,
          at: dependencies.now(),
          readiness: null,
          questionRuntime: null,
        });
      }
      let questionRuntime: OpenClawQuestionPluginReadiness | null = null;
      if (readiness.ready) {
        try {
          questionRuntime = await dependencies.getQuestionRuntimeReadiness(readiness);
        } catch {
          // A runtime-inspection failure is an unavailable attestation below.
        }
      }
      return Object.freeze({
        generation,
        at: dependencies.now(),
        readiness,
        questionRuntime,
      });
    } catch {
      return Object.freeze({
        generation,
        at: dependencies.now(),
        readiness: null,
        questionRuntime: null,
      });
    }
  })();
  if (!shared) return collect;

  let flight: ReadinessAttestationInFlight | null = null;
  const promise = collect.then((result) => {
    if (generation === readinessAttestationGeneration) {
      readinessAttestationCache = result;
    }
    return result;
  }).finally(() => {
    if (flight && readinessAttestationInFlight === flight) {
      readinessAttestationInFlight = null;
    }
  });
  flight = Object.freeze({ generation: generation!, promise });
  readinessAttestationInFlight = flight;
  return promise;
}

function readinessAdmission(
  attestation: ReadinessAttestation | null,
  checkedAt: number,
  evidence: OpenClawExecutionAdmissionEvidence,
): OpenClawExecutionAdmission {
  if (!attestation?.readiness) {
    return admission(
      'unavailable',
      'OpenClaw tested-runtime readiness could not be attested.',
      checkedAt,
      evidence,
    );
  }
  if (!attestation.readiness.ready) {
    const blockers = attestation.readiness.blockers.map((blocker) => blocker.code);
    return admission(
      'unavailable',
      attestation.readiness.blockers[0]?.message
        || 'OpenClaw did not pass its tested-runtime readiness contract.',
      checkedAt,
      evidence,
      blockers,
    );
  }
  if (!attestation.questionRuntime?.ready) {
    return admission(
      'unavailable',
      attestation.questionRuntime?.issue
        || 'OpenClaw question-runtime readiness could not be attested.',
      checkedAt,
      evidence,
      ['ask-user-plugin-mismatch'],
    );
  }
  return admission(
    'ready',
    'OpenClaw passed durable execution admission, tested-runtime readiness, and exact question-authority attestation.',
    checkedAt,
    evidence,
  );
}

export async function getOpenClawExecutionAdmission(
  overrides: Partial<OpenClawExecutionAdmissionDependencies> = {},
  options: OpenClawExecutionAdmissionOptions = {},
): Promise<OpenClawExecutionAdmission> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const shared = usesSharedCache(overrides, options);
  // One retry lets a request whose pre-maintenance probe was invalidated join
  // (or create) the exact post-maintenance generation. A second invalidation
  // fails closed instead of allowing an unbounded request during churn.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = evidenceSnapshot(dependencies);
    invalidateReadinessForRuntimeMutationEvidence(before, shared);
    const beforeAdmission = durableAdmission(before, dependencies.now());
    if (beforeAdmission) return beforeAdmission;

    const attestation = await collectReadinessAttestation(
      dependencies,
      shared,
      options.forceReadiness === true,
    );

    // The readiness probe can take time. Re-attest every durable boundary after
    // it settles so maintenance or recovery cannot race the positive result.
    const after = evidenceSnapshot(dependencies);
    invalidateReadinessForRuntimeMutationEvidence(after, shared);
    const afterAdmission = durableAdmission(after, dependencies.now());
    if (afterAdmission) return afterAdmission;
    if (
      !shared
      || attestation.generation === readinessAttestationGeneration
    ) {
      return readinessAdmission(attestation, dependencies.now(), after.evidence);
    }
  }

  const finalSnapshot = evidenceSnapshot(dependencies);
  invalidateReadinessForRuntimeMutationEvidence(finalSnapshot, shared);
  const finalDurableAdmission = durableAdmission(finalSnapshot, dependencies.now());
  if (finalDurableAdmission) return finalDurableAdmission;
  return admission(
    'unavailable',
    'OpenClaw runtime readiness changed repeatedly during execution admission.',
    dependencies.now(),
    finalSnapshot.evidence,
  );
}

export function getCachedOpenClawExecutionAdmission(
  overrides: Partial<OpenClawExecutionAdmissionDependencies> = {},
): OpenClawExecutionAdmission {
  const dependencies = { ...defaultDependencies, ...overrides };
  const snapshot = evidenceSnapshot(dependencies);
  invalidateReadinessForRuntimeMutationEvidence(snapshot, true);
  const checkedAt = dependencies.now();
  const durable = durableAdmission(snapshot, checkedAt);
  if (durable) return durable;

  const cached = readinessAttestationCache;
  if (
    !cached
    || cached.generation !== readinessAttestationGeneration
    || checkedAt - cached.at >= READINESS_ATTESTATION_TTL_MS
  ) {
    return admission(
      'unavailable',
      'A current OpenClaw tested-runtime readiness attestation is not cached.',
      checkedAt,
      snapshot.evidence,
    );
  }
  return readinessAdmission(cached, checkedAt, snapshot.evidence);
}

const ERROR_CONTRACT = Object.freeze({
  maintenance: Object.freeze({
    code: 'OPENCLAW_EXECUTION_MAINTENANCE',
    retryable: true,
  }),
  'recovery-required': Object.freeze({
    code: 'OPENCLAW_EXECUTION_RECOVERY_REQUIRED',
    retryable: false,
  }),
  unavailable: Object.freeze({
    code: 'OPENCLAW_EXECUTION_UNAVAILABLE',
    retryable: false,
  }),
});

export class OpenClawExecutionAdmissionError extends Error {
  readonly statusCode = 503;
  readonly code: string;
  readonly retryable: boolean;
  readonly state: Exclude<OpenClawExecutionAdmissionState, 'ready'>;

  constructor(readonly admission: OpenClawExecutionAdmission) {
    if (admission.state === 'ready') {
      throw new TypeError('A ready OpenClaw admission cannot produce an error');
    }
    const state = admission.state;
    const contract = ERROR_CONTRACT[state];
    super(`${contract.code}: ${admission.reason}`);
    this.name = 'OpenClawExecutionAdmissionError';
    this.code = contract.code;
    this.retryable = contract.retryable;
    this.state = state;
  }
}

export async function assertOpenClawExecutionAdmitted(): Promise<OpenClawExecutionAdmission> {
  const current = await getOpenClawExecutionAdmission();
  if (!current.ready) throw new OpenClawExecutionAdmissionError(current);
  return current;
}

export function assertCachedOpenClawExecutionAdmitted(): OpenClawExecutionAdmission {
  const current = getCachedOpenClawExecutionAdmission();
  if (!current.ready) throw new OpenClawExecutionAdmissionError(current);
  return current;
}

export function __resetOpenClawExecutionAdmissionForTests(): void {
  invalidateSharedReadinessAttestation();
}

export const __openClawExecutionAdmissionTest = Object.freeze({
  READINESS_ATTESTATION_TTL_MS,
  MAX_HOST_MUTATION_JOURNAL_BYTES,
  MAX_MAINTENANCE_MARKER_BYTES,
  aggregateDurableEvidence,
  inspectRootOwnedEvidenceFile,
  validateCanonicalMaintenanceMarker,
});
