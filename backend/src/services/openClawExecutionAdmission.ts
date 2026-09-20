import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import {
  OPENCLAW_GATEWAY_FENCE_MARKER,
  OPENCLAW_GATEWAY_FENCE_MARKER_CONTENT,
} from './openClawGatewayAuthorizationFence';
import {
  getOpenClawSetupReadiness,
  invalidateOpenClawSetupReadinessCache,
  promoteOpenClawSetupReadinessInFlight,
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

// A positive attestation describes the installed runtime tuple, which changes
// only through installs and updates. Every Portal-managed mutation already
// invalidates it immediately through the maintenance marker and host-mutation
// WAL below, so age alone is weak evidence. Re-collecting it every minute put a
// serialized chain of OpenClaw CLI processes (tens of CPU-seconds) on the chat
// request path, and its gateway RPC probe reported a merely busy gateway as
// unavailable. A positive result is therefore served while it is revalidated in
// the background; only a missing, expired, or negative result blocks a request.
const READINESS_ATTESTATION_REFRESH_AFTER_MS = 10 * 60_000;
const READINESS_ATTESTATION_MAX_AGE_MS = 30 * 60_000;
// Negative results stay short-lived so recovery is visible quickly, but never
// so short that re-collecting them becomes the load. A negative is served for
// at least twice as long as it took to collect, clamped between the floor and
// the one-minute interval earlier releases used. That holds request-driven
// collection to about a third of one core however often a caller asks.
const READINESS_NEGATIVE_ATTESTATION_TTL_MS = 15_000;
const READINESS_NEGATIVE_ATTESTATION_MAX_TTL_MS = 60_000;
const READINESS_NEGATIVE_TTL_COLLECTION_MULTIPLE = 2;
// One failed background revalidation is usually contention, not a changed
// runtime. A still-valid positive attestation is displaced only after this many
// consecutive background failures, retried no sooner than the retry interval.
const READINESS_BACKGROUND_RETRY_MS = 20_000;
const READINESS_BACKGROUND_NEGATIVES_TO_DISPLACE = 2;
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
  /**
   * Identity of the directories that hold the maintenance marker and the
   * host-mutation journals. It changes whenever an entry is created or removed
   * there, so a mutation that began and ended between two admissions is still
   * seen by the next one even though no marker is left to find.
   */
  readMutationEpoch(): string;
  getReadiness(force?: boolean): Promise<OpenClawSetupReadiness>;
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
  collectMs: number;
  readiness: OpenClawSetupReadiness | null;
  questionRuntime: OpenClawQuestionPluginReadiness | null;
}>;

type ReadinessPublishPolicy = 'direct' | 'debounced';

// `policy` is read when the collection settles, not when it starts: a forced
// recheck that joins a background revalidation upgrades it to `direct`, so the
// failure that caller is told about is also the state everyone else sees.
type ReadinessAttestationInFlight = {
  readonly generation: number;
  promise: Promise<ReadinessAttestation>;
  policy: ReadinessPublishPolicy;
};

let readinessAttestationGeneration = 0;
let readinessAttestationEpoch: string | null = null;

// A dispatch belongs to the attestation generation it was admitted under. The
// generation advances at every maintenance or host-mutation boundary, observed
// or not, so a turn that is still on its way to the gateway when one passes can
// be recognised at the socket even though no marker is left to find.
const admittedDispatchContext = new AsyncLocalStorage<Readonly<{ generation: number }>>();
let readinessAttestationCache: ReadinessAttestation | null = null;
let readinessAttestationInFlight: ReadinessAttestationInFlight | null = null;
let readinessBackgroundNegatives = 0;
let readinessBackgroundNextAttemptAt = 0;

function readinessAttestationIsPositive(attestation: ReadinessAttestation): boolean {
  return attestation.readiness?.ready === true && attestation.questionRuntime?.ready === true;
}

function usableCachedReadinessAttestation(now: number): ReadinessAttestation | null {
  const cached = readinessAttestationCache;
  if (!cached || cached.generation !== readinessAttestationGeneration) return null;
  const maximumAge = readinessAttestationIsPositive(cached)
    ? READINESS_ATTESTATION_MAX_AGE_MS
    : negativeReadinessAttestationTtlMs(cached.collectMs);
  return now - cached.at < maximumAge ? cached : null;
}

function negativeReadinessAttestationTtlMs(collectMs: number): number {
  const scaled = Number.isFinite(collectMs) && collectMs > 0
    ? collectMs * READINESS_NEGATIVE_TTL_COLLECTION_MULTIPLE
    : 0;
  return Math.min(
    READINESS_NEGATIVE_ATTESTATION_MAX_TTL_MS,
    Math.max(READINESS_NEGATIVE_ATTESTATION_TTL_MS, scaled),
  );
}

function invalidateSharedReadinessAttestation(): void {
  readinessAttestationGeneration += 1;
  readinessAttestationCache = null;
  readinessBackgroundNegatives = 0;
  readinessBackgroundNextAttemptAt = 0;
  // The setup-readiness layer now also retains positive results well past the
  // length of a maintenance window, so it must cross this boundary with us.
  invalidateOpenClawSetupReadinessCache();
  // A running probe cannot be cancelled, but detaching it here allows the
  // post-maintenance generation to start immediately. Its completion handler
  // is generation-bound and therefore cannot repopulate either shared slot.
  readinessAttestationInFlight = null;
}

const OPENCLAW_MUTATION_EPOCH_DIRECTORIES: readonly string[] = Object.freeze([...new Set([
  OPENCLAW_MUTATION_MAINTENANCE_MARKER,
  ...OPENCLAW_HOST_MUTATION_ACTIVE_JOURNALS,
].map((filePath) => path.dirname(filePath)))]);

function readMutationEvidenceEpoch(
  directories: readonly string[] = OPENCLAW_MUTATION_EPOCH_DIRECTORIES,
): string {
  // Creating or removing an entry updates its directory's mtime and ctime, so
  // these stamps outlive the marker or journal that caused them. Nothing else
  // writes entries here during normal operation.
  return directories.map((directory) => {
    try {
      const details = fs.lstatSync(directory, { bigint: true });
      return `${details.dev}:${details.ino}:${details.mtimeNs}:${details.ctimeNs}`;
    } catch (error: any) {
      return error?.code === 'ENOENT' ? 'absent' : `unreadable:${String(error?.code || 'error')}`;
    }
  }).join('|');
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
  readMutationEpoch: () => readMutationEvidenceEpoch(),
  // An attestation now outlives the setup-readiness cache by design, so it is
  // always built from a fresh collection rather than from a cached one. A
  // forced recheck forces that layer too, so both publish the same answer.
  getReadiness: (force) => getOpenClawSetupReadiness({}, force ? { force: true } : { fresh: true }),
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
  dependencies: OpenClawExecutionAdmissionDependencies,
): void {
  if (!shared) return;
  // Authorization retirement does not change the installed runtime tuple.
  // Installer maintenance and every host-mutation WAL can. Unsafe evidence is
  // treated the same as present evidence: an old positive attestation must not
  // survive a boundary whose state could not be proved.
  //
  // A boundary nobody watched counts as well. Maintenance that started and
  // finished between two admissions leaves no marker behind, but it does leave
  // a different epoch, and every shared attestation, in-flight probe, and
  // setup-readiness result belongs to the epoch it was collected under.
  const epoch = dependencies.readMutationEpoch();
  const crossedUnobservedBoundary = readinessAttestationEpoch !== null
    && epoch !== readinessAttestationEpoch;
  readinessAttestationEpoch = epoch;
  if (
    crossedUnobservedBoundary
    || snapshot.maintenanceMarker.state !== 'absent'
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
  if (shared && !force) {
    const cached = usableCachedReadinessAttestation(now);
    if (cached) {
      if (
        readinessAttestationIsPositive(cached)
        && now - cached.at >= READINESS_ATTESTATION_REFRESH_AFTER_MS
      ) {
        revalidateReadinessAttestationInBackground(dependencies, now);
      }
      return cached;
    }
  }
  return startReadinessAttestationCollection(dependencies, shared, force ? 'direct' : 'debounced');
}

function revalidateReadinessAttestationInBackground(
  dependencies: OpenClawExecutionAdmissionDependencies,
  now: number,
): void {
  if (readinessAttestationInFlight?.generation === readinessAttestationGeneration) return;
  if (now < readinessBackgroundNextAttemptAt) return;
  // Never awaited by a request. The collection itself cannot reject; the catch
  // only guarantees a background probe can never surface as an unhandled
  // rejection in the Portal process.
  void startReadinessAttestationCollection(dependencies, true, 'debounced').catch(() => undefined);
}

function publishReadinessAttestation(
  result: ReadinessAttestation,
  policy: ReadinessPublishPolicy,
  now: number,
): void {
  if (readinessAttestationIsPositive(result)) {
    readinessAttestationCache = result;
    readinessBackgroundNegatives = 0;
    readinessBackgroundNextAttemptAt = 0;
    return;
  }
  const retained = policy === 'debounced' ? usableCachedReadinessAttestation(now) : null;
  if (retained && readinessAttestationIsPositive(retained)) {
    // Spacing is enforced here, for every collection path: a second failure
    // inside the retry interval is the same contention, not new evidence.
    if (now < readinessBackgroundNextAttemptAt) return;
    readinessBackgroundNegatives += 1;
    if (readinessBackgroundNegatives < READINESS_BACKGROUND_NEGATIVES_TO_DISPLACE) {
      readinessBackgroundNextAttemptAt = now + READINESS_BACKGROUND_RETRY_MS;
      return;
    }
  }
  readinessAttestationCache = result;
  readinessBackgroundNegatives = 0;
  readinessBackgroundNextAttemptAt = 0;
}

function startReadinessAttestationCollection(
  dependencies: OpenClawExecutionAdmissionDependencies,
  shared: boolean,
  publishPolicy: ReadinessPublishPolicy,
): Promise<ReadinessAttestation> {
  if (
    shared
    && readinessAttestationInFlight?.generation === readinessAttestationGeneration
  ) {
    if (publishPolicy === 'direct' && readinessAttestationInFlight.policy !== 'direct') {
      readinessAttestationInFlight.policy = 'direct';
      // The joined probe may already be inside a debounced setup-readiness
      // collection; that layer has to publish this result directly as well.
      promoteOpenClawSetupReadinessInFlight();
    }
    return readinessAttestationInFlight.promise;
  }

  const generation = shared ? readinessAttestationGeneration : null;
  const startedAt = dependencies.now();
  const settled = (
    readiness: OpenClawSetupReadiness | null,
    questionRuntime: OpenClawQuestionPluginReadiness | null,
  ): ReadinessAttestation => {
    const at = dependencies.now();
    return Object.freeze({
      generation,
      at,
      collectMs: Math.max(0, at - startedAt),
      readiness,
      questionRuntime,
    });
  };

  const collect = (async (): Promise<ReadinessAttestation> => {
    try {
      const readiness = await dependencies.getReadiness(publishPolicy === 'direct');
      // A maintenance/WAL observation in another admission can invalidate this
      // probe while the setup-readiness subprocess is still running. Do not
      // continue into a question-authority probe against a possibly replaced
      // runtime family.
      if (generation !== null && generation !== readinessAttestationGeneration) {
        return settled(null, null);
      }
      let questionRuntime: OpenClawQuestionPluginReadiness | null = null;
      if (readiness.ready) {
        try {
          questionRuntime = await dependencies.getQuestionRuntimeReadiness(readiness);
        } catch {
          // A runtime-inspection failure is an unavailable attestation below.
        }
      }
      return settled(readiness, questionRuntime);
    } catch {
      return settled(null, null);
    }
  })();
  if (!shared) return collect;

  const flight: ReadinessAttestationInFlight = {
    generation: generation!,
    policy: publishPolicy,
    promise: collect,
  };
  flight.promise = collect.then((result) => {
    if (generation === readinessAttestationGeneration) {
      publishReadinessAttestation(result, flight.policy, dependencies.now());
    }
    return result;
  }).finally(() => {
    if (readinessAttestationInFlight === flight) readinessAttestationInFlight = null;
  });
  readinessAttestationInFlight = flight;
  return flight.promise;
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
    invalidateReadinessForRuntimeMutationEvidence(before, shared, dependencies);
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
    invalidateReadinessForRuntimeMutationEvidence(after, shared, dependencies);
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
  invalidateReadinessForRuntimeMutationEvidence(finalSnapshot, shared, dependencies);
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
  invalidateReadinessForRuntimeMutationEvidence(snapshot, true, dependencies);
  const checkedAt = dependencies.now();
  const durable = durableAdmission(snapshot, checkedAt);
  if (durable) return durable;

  // This seam stays free of probes and of background scheduling: it only
  // consumes an attestation that route admission already established.
  const cached = usableCachedReadinessAttestation(checkedAt);
  if (!cached) {
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

/**
 * Last look before a chat turn is written to the gateway socket. Route
 * admission and the send seam both run before work that can take a while
 * (host-run journaling, a websocket reconnect of up to 15 s), and maintenance
 * can begin in that gap. This reads only the durable evidence — marker,
 * journals, fence — so it can refuse a turn but can never report OpenClaw as
 * unavailable on cache state alone, and it never probes or schedules anything.
 */
export type OpenClawAdmittedDispatchBinding = Readonly<{ generation: number }>;

/**
 * The binding of the dispatch that is running now, if any. A transport whose
 * socket write happens inside an event callback captures it on entry and hands
 * it back to the guard, rather than relying on context propagation through the
 * socket.
 */
export function captureAdmittedOpenClawDispatchBinding(): OpenClawAdmittedDispatchBinding | undefined {
  return admittedDispatchContext.getStore();
}

export function assertOpenClawDispatchNotDurablyBlocked(
  overrides: Partial<OpenClawExecutionAdmissionDependencies> = {},
  options: Pick<OpenClawExecutionAdmissionOptions, 'useSharedCache'> & {
    binding?: OpenClawAdmittedDispatchBinding | null;
  } = {},
): void {
  const dependencies = { ...defaultDependencies, ...overrides };
  const shared = usesSharedCache(overrides, options);
  const snapshot = evidenceSnapshot(dependencies);
  invalidateReadinessForRuntimeMutationEvidence(snapshot, shared, dependencies);
  const checkedAt = dependencies.now();
  const durable = durableAdmission(snapshot, checkedAt);
  if (durable) throw new OpenClawExecutionAdmissionError(durable);

  // Nothing is recorded now, but the read above may just have discovered that
  // something was. A turn admitted before that boundary was admitted against a
  // runtime that may since have been replaced: it is refused, retryably, and
  // the retry goes through a fresh admission.
  const admitted = options.binding === undefined
    ? admittedDispatchContext.getStore()
    : options.binding;
  if (shared && admitted && admitted.generation !== readinessAttestationGeneration) {
    throw new OpenClawExecutionAdmissionError(admission(
      'maintenance',
      'OpenClaw was updated while this turn was being sent. Send it again.',
      checkedAt,
      snapshot.evidence,
    ));
  }
}

/**
 * Custody of an admitted turn. Call it directly after the synchronous final
 * seam (`assertCachedOpenClawExecutionAdmitted`): `dispatch` and everything it
 * awaits run bound to the attestation generation that seam just admitted, and
 * the transport compares it again at the socket write.
 */
export function bindAdmittedOpenClawDispatch<T>(dispatch: () => T): T {
  return admittedDispatchContext.run(
    Object.freeze({ generation: readinessAttestationGeneration }),
    dispatch,
  );
}

export function __resetOpenClawExecutionAdmissionForTests(): void {
  invalidateSharedReadinessAttestation();
  readinessAttestationEpoch = null;
}

export const __openClawExecutionAdmissionTest = Object.freeze({
  READINESS_ATTESTATION_REFRESH_AFTER_MS,
  READINESS_ATTESTATION_MAX_AGE_MS,
  READINESS_NEGATIVE_ATTESTATION_TTL_MS,
  READINESS_NEGATIVE_ATTESTATION_MAX_TTL_MS,
  READINESS_NEGATIVE_TTL_COLLECTION_MULTIPLE,
  READINESS_BACKGROUND_RETRY_MS,
  READINESS_BACKGROUND_NEGATIVES_TO_DISPLACE,
  MAX_HOST_MUTATION_JOURNAL_BYTES,
  MAX_MAINTENANCE_MARKER_BYTES,
  aggregateDurableEvidence,
  inspectRootOwnedEvidenceFile,
  negativeReadinessAttestationTtlMs,
  readMutationEvidenceEpoch,
  validateCanonicalMaintenanceMarker,
});
