import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createHash, randomBytes } from 'crypto';
import { execFileSync, execSync } from 'child_process';
import {
  AUTH_PROFILES_PATH,
  invalidateOpenClawAuthStoreProfilesCache,
  readAuthProfiles,
  readAuthProfilesStrict,
  readAuthProfilesStrictAsync,
  readOpenClawAuthStoreProfiles,
  readOpenClawAuthStoreProfilesAsync,
  saveProviderToken,
} from './openclawConfigManager';
import { buildOpenClawCliEnv } from '../utils/openclawCli';
import {
  getNativeCliAuthStatus,
  getNativeCliAuthStatusAsync,
  invalidateNativeCliAuthStatus,
} from '../agents/nativeCliAuth';
import { buildNativeCliEnvironment, resolveNativeCliCredentialPaths } from '../agents/providers/native/NativeCliEnvironment';
import {
  __clearProviderCredentialLifecycleLedgerForTests,
  bindProviderCredentialLifecycle,
  claimProviderCredentialLifecycle,
  reconcileProviderCredentialLifecycleBeforeAdmission,
  markProviderCredentialLifecycle,
  releaseProviderCredentialLifecycle,
  type ClaimedProviderCredentialLifecycle,
} from './providerCredentialLifecycleLedger';

export type OAuthFlowStatus = 'starting' | 'awaiting_callback' | 'polling_device' | 'processing' | 'complete' | 'cancelled' | 'expired' | 'error';
export type OAuthCompletionResult = { success: boolean; error?: string };
type NativeCredentialProvider = 'CLAUDE_CODE' | 'CODEX' | 'GEMINI' | 'GROK';

export interface NativeCliCompletionDependencies {
  fetchImpl?: typeof globalThis.fetch;
  persistClaudeCredentials?: (payload: Record<string, unknown>) => void;
}

export interface NativeCredentialSnapshot {
  state: 'verified' | 'indeterminate';
  fingerprint?: string;
}

interface OAuthCompletionAttempt {
  kind: 'oauth_callback' | 'native_callback';
  inputFingerprint: string;
  promise: Promise<OAuthCompletionResult>;
}

export interface OAuthSession {
  id: string;
  provider: string;
  mode: 'oauth' | 'device_code';
  ownerId?: string;
  process: pty.IPty;
  authUrl: string | null;
  callbackHintUrl: string | null;
  deviceCode: string | null;
  verificationUrl: string | null;
  localPort: number | null;
  oauthState: string | null;
  status: OAuthFlowStatus;
  error: string | null;
  output: string;
  cleanOutput: string;
  createdAt: number;
  expiresAt?: number | null;
  completedAt: number | null;
  profileKeyBefore: string[];
  profileStateBefore?: Record<string, string>;
  expectedProfileId?: string | null;
  persistedProfileId?: string | null;
  sentInitialConfirm?: boolean;
  extraEnv?: Record<string, string>;
  capturedToken?: string | null;
  lastOutputAt?: number;
  processExited?: boolean;
  processExitCode?: number;
  processExitedAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  profileReconciliationPending?: boolean;
  profileReconciliationTimer?: ReturnType<typeof setTimeout>;
  profileReconciliationPromise?: Promise<'committed' | 'absent'>;
  profileReconciliationReadPromise?: Promise<string | null>;
  authStoreReadIndeterminate?: boolean;
  alreadyAuthenticated?: boolean;
  reauthSupported?: boolean;
  completionAttempt?: OAuthCompletionAttempt;
  completionAbortController?: AbortController;
  nativeCredentialProvider?: NativeCredentialProvider;
  nativeCredentialPaths?: string[];
  nativeCredentialSnapshotBefore?: NativeCredentialSnapshot;
  credentialResolution?: 'absent' | 'committed' | 'indeterminate';
  credentialLeaseNamespace?: string;
  finalizationPending?: boolean;
  finalizationWarning?: string | null;
  lifecycleGeneration?: number;
  credentialLifecycleMarker?: string;
}

const sessions = new Map<string, OAuthSession>();

interface CredentialLifecycleLease {
  namespace: string;
  ownerId: string;
  requestFingerprint: string;
  startPromise: Promise<unknown>;
  sessionId: string | null;
  finalized: boolean;
  durableClaim: ClaimedProviderCredentialLifecycle | null;
}

type CredentialLifecycleSessionBinder = ((session: OAuthSession) => void) & { leaseId: string };

const credentialLifecycleLeases = new Map<string, CredentialLifecycleLease>();

export class CredentialLifecycleConflictError extends Error {
  readonly statusCode = 409;
}

function credentialStartFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function credentialLeaseIsReleasable(lease: CredentialLifecycleLease): boolean {
  if (lease.finalized) return true;
  if (!lease.sessionId) return false;
  const session = sessions.get(lease.sessionId);
  if (!session) return true;
  return Boolean(session.processExited)
    && !session.finalizationPending
    && session.credentialResolution === 'absent';
}

function releaseCredentialLifecycleLease(session: OAuthSession, finalized = false): void {
  const namespace = session.credentialLeaseNamespace;
  if (!namespace) return;
  const lease = credentialLifecycleLeases.get(namespace);
  if (!lease || lease.sessionId !== session.id) return;
  if (finalized) lease.finalized = true;
  if (lease.durableClaim && session.credentialResolution === 'committed') {
    markProviderCredentialLifecycle(lease.durableClaim, 'committed');
  } else if (lease.durableClaim && session.credentialResolution === 'indeterminate') {
    markProviderCredentialLifecycle(lease.durableClaim, 'indeterminate');
  }
  if (credentialLeaseIsReleasable(lease)) {
    if (lease.durableClaim) releaseProviderCredentialLifecycle(lease.durableClaim);
    credentialLifecycleLeases.delete(namespace);
  }
}

async function runCredentialLifecycleStart<T extends { sessionId: string }>(
  namespace: string,
  ownerId: string | undefined,
  request: unknown,
  starter: (bindSession: CredentialLifecycleSessionBinder) => Promise<T>,
  durability: {
    baselineFingerprint?: string | null;
    reviewAfterMs?: number;
    lifecycleKind?: string;
    prepare?: () => Promise<{ baselineFingerprint?: string | null; reviewAfterMs?: number }>;
  } = {},
): Promise<T> {
  const normalizedOwner = ownerId || 'setup:pending';
  const requestFingerprint = credentialStartFingerprint(request);
  const existing = credentialLifecycleLeases.get(namespace);
  if (existing && credentialLeaseIsReleasable(existing)) {
    credentialLifecycleLeases.delete(namespace);
  }
  const active = credentialLifecycleLeases.get(namespace);
  if (active) {
    if (active.ownerId === normalizedOwner && active.requestFingerprint === requestFingerprint) {
      return active.startPromise as Promise<T>;
    }
    throw new CredentialLifecycleConflictError(
      'Another authorization lifecycle already owns this provider credential. Finish or cancel it before starting a different sign-in.',
    );
  }

  const lease = {} as CredentialLifecycleLease;
  const startPromise = Promise.resolve().then(async () => {
    const prepared = durability.prepare ? await durability.prepare() : {};
    const durableClaim = claimProviderCredentialLifecycle(
      namespace,
      normalizedOwner,
      requestFingerprint,
      {
        lifecycleKind: durability.lifecycleKind
          || (namespace.startsWith('native:') ? 'native-cli' : 'openclaw-oauth'),
        baselineFingerprint: prepared.baselineFingerprint ?? durability.baselineFingerprint,
        reviewAfterMs: prepared.reviewAfterMs ?? durability.reviewAfterMs ?? 15 * 60 * 1000,
      },
    );
    lease.durableClaim = durableClaim;
    const bindSession = ((session: OAuthSession) => {
      if (lease.sessionId && lease.sessionId !== session.id) {
        throw new Error('Provider authorization lifecycle attempted to bind more than one session.');
      }
      lease.sessionId = session.id;
      session.credentialLeaseNamespace = namespace;
      session.credentialLifecycleMarker = durableClaim.leaseId;
      if (session.process && typeof session.process.onExit === 'function' && !session.processExited) {
        // Install the minimal cleanup observer before the ledger fsync. If the
        // bind itself fails, failOAuthSessionStart can still await real exit
        // instead of abandoning a credential-mutating child with no handler.
        session.process.onExit(({ exitCode }: { exitCode: number }) => {
          if (!session.processExited) recordOAuthProcessExit(session, exitCode);
        });
      }
      const processPid = Number((session.process as any)?.pid || 0);
      bindProviderCredentialLifecycle(durableClaim, session.id, {
        binding: processPid > 1
          ? { kind: 'owned-child', processPid }
          : { kind: 'attested-processless' },
        reviewAfterMs: session.expiresAt
          ? Math.max(60_000, session.expiresAt - Date.now())
          : undefined,
      });
    }) as CredentialLifecycleSessionBinder;
    bindSession.leaseId = durableClaim.leaseId;
    return starter(bindSession);
  });
  Object.assign(lease, {
    namespace,
    ownerId: normalizedOwner,
    requestFingerprint,
    startPromise,
    sessionId: null,
    finalized: false,
    durableClaim: null,
  });
  credentialLifecycleLeases.set(namespace, lease);

  try {
    const result = await startPromise;
    const durableClaim = lease.durableClaim;
    if (!durableClaim) throw new Error('Provider authorization durable ownership was not established.');
    lease.sessionId = result.sessionId;
    const session = sessions.get(result.sessionId);
    if (session) {
      // The core binds synchronously as soon as the PTY-backed session exists.
      // Rebinding here only refreshes a device-code expiry learned from the
      // first output; it is not the crash-safety boundary.
      if (session.credentialLeaseNamespace !== namespace) {
        session.credentialLeaseNamespace = namespace;
      }
      const processPid = Number((session.process as any)?.pid || 0);
      bindProviderCredentialLifecycle(durableClaim, session.id, {
        binding: processPid > 1
          ? { kind: 'owned-child', processPid }
          : { kind: 'attested-processless' },
        reviewAfterMs: session.expiresAt
          ? Math.max(60_000, session.expiresAt - Date.now())
          : undefined,
      });
    } else {
      throw Object.assign(
        new Error('Provider authorization returned without its lifecycle-owned session.'),
        { sessionId: result.sessionId, oauthSessionId: result.sessionId, retainLifecycle: true },
      );
    }
    return result;
  } catch (caughtError: any) {
    let error = caughtError;
    const durableClaim = lease.durableClaim;
    if (!durableClaim) {
      if (credentialLifecycleLeases.get(namespace) === lease) credentialLifecycleLeases.delete(namespace);
      throw error;
    }
    const sessionId = String(error?.oauthSessionId || error?.sessionId || lease.sessionId || '').trim();
    if (sessionId) {
      lease.sessionId = sessionId;
      const session = sessions.get(sessionId);
      if (session) {
        session.credentialLeaseNamespace = namespace;
        if (!session.processExited && session.credentialResolution !== 'committed') {
          try {
            await failOAuthSessionStart(session, error);
          } catch (cleanupError: any) {
            error = cleanupError;
          }
        }
        releaseCredentialLifecycleLease(session);
      } else {
        markProviderCredentialLifecycle(durableClaim, 'indeterminate');
      }
    } else if (credentialLifecycleLeases.get(namespace) === lease) {
      if (error?.cleanupPending || error?.retainLifecycle
        || error?.credentialState === 'committed' || error?.credentialState === 'indeterminate') {
        markProviderCredentialLifecycle(
          durableClaim,
          error?.credentialState === 'committed' ? 'committed' : 'indeterminate',
        );
      } else {
        // No durable session means the failure happened before any credential-
        // mutating process or upstream attempt was admitted.
        releaseProviderCredentialLifecycle(durableClaim);
        credentialLifecycleLeases.delete(namespace);
      }
    }
    throw error;
  }
}

/** Test-only access for deterministic lifecycle race coverage. */
export function __setOAuthSessionForTests(session: OAuthSession): void {
  sessions.set(session.id, session);
}

/** Test-only cleanup paired with __setOAuthSessionForTests. */
export function __deleteOAuthSessionForTests(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (session?.credentialLeaseNamespace) {
    const lease = credentialLifecycleLeases.get(session.credentialLeaseNamespace);
    if (lease?.sessionId === sessionId) credentialLifecycleLeases.delete(session.credentialLeaseNamespace);
  }
}

export function __resetCredentialLifecycleLeasesForTests(): void {
  credentialLifecycleLeases.clear();
  __clearProviderCredentialLifecycleLedgerForTests();
}

/** Simulate only process-memory loss while retaining the restart ledger. */
export function __resetCredentialLifecycleMemoryForTests(): void {
  credentialLifecycleLeases.clear();
}
const OPENCLAW_BIN = 'openclaw';
export const GROK_BUILD_DEVICE_LOGIN_ARGS = ['--no-auto-update', 'login', '--device-auth'] as const;
const ANSI_REGEX = /\x1B\[[0-9;?]*[ -\/]*[@-~]|\x1B[@-_]/g;
const SCREEN_CONTROL_FRAGMENT_REGEX = /\[[0-9;?]*[ -\/]*[@-~]/g;
const MAX_NATIVE_CREDENTIAL_FILES = 1_024;
const MAX_NATIVE_CREDENTIAL_BYTES = 16 * 1024 * 1024;
const NATIVE_CLAUDE_TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

function createSessionId() {
  return `oauth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildPkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

function safeReadJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function walkNativeCredentialPath(
  rootPath: string,
  currentPath: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
  budget: { files: number; bytes: number },
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(currentPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      hash.update(`missing\0${rootPath}\0${relativePath}\0`);
      return true;
    }
    return false;
  }

  if (stat.isSymbolicLink()) {
    // An attested root path that is itself a symlink stays fail-closed: the
    // credential file was swapped for a link to somewhere else, and Portal
    // will not sign that off as a known state.
    //
    // A symlink *inside* an attested directory is different. Some providers
    // attest a CLI's whole state directory, and those directories legitimately
    // contain links — the Antigravity CLI rewrites
    // ~/.gemini/antigravity-cli/cli.log as a symlink to the current log file on
    // every run, which made every Google Gemini sign-in fail before it even
    // started. Record the link by its target string and never follow it, so the
    // walk still cannot escape the tree and a changed target still changes the
    // fingerprint.
    if (!relativePath) return false;
    let linkTarget: string;
    try {
      linkTarget = fs.readlinkSync(currentPath);
    } catch {
      return false;
    }
    hash.update(`symlink\0${rootPath}\0${relativePath}\0${linkTarget}\0`);
    return true;
  }
  if (stat.isFile()) {
    budget.files += 1;
    budget.bytes += stat.size;
    if (budget.files > MAX_NATIVE_CREDENTIAL_FILES || budget.bytes > MAX_NATIVE_CREDENTIAL_BYTES) return false;
    try {
      const contents = fs.readFileSync(currentPath);
      hash.update(`file\0${rootPath}\0${relativePath}\0${stat.mode}\0${contents.length}\0`);
      hash.update(contents);
      return true;
    } catch {
      return false;
    }
  }

  if (stat.isDirectory()) {
    hash.update(`directory\0${rootPath}\0${relativePath}\0${stat.mode}\0`);
    let entries: string[];
    try {
      entries = fs.readdirSync(currentPath).sort();
    } catch {
      return false;
    }
    for (const entry of entries) {
      const childRelative = relativePath ? path.join(relativePath, entry) : entry;
      if (!walkNativeCredentialPath(rootPath, path.join(currentPath, entry), childRelative, hash, budget)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

export function captureNativeCredentialSnapshot(paths: string[]): NativeCredentialSnapshot {
  const normalizedPaths = [...new Set(paths.map((value) => path.resolve(value)))].sort();
  const hash = createHash('sha256');
  const budget = { files: 0, bytes: 0 };
  for (const credentialPath of normalizedPaths) {
    if (!walkNativeCredentialPath(credentialPath, credentialPath, '', hash, budget)) {
      return { state: 'indeterminate' };
    }
  }
  return { state: 'verified', fingerprint: hash.digest('hex') };
}

function configureNativeCredentialAttestation(
  session: OAuthSession,
  provider: NativeCredentialProvider,
  paths = resolveNativeCliCredentialPaths(provider),
): void {
  session.nativeCredentialProvider = provider;
  session.nativeCredentialPaths = [...paths];
  session.nativeCredentialSnapshotBefore = captureNativeCredentialSnapshot(paths);
}

function nativeCredentialMutationState(session: OAuthSession): 'unchanged' | 'committed' | 'indeterminate' | 'not_applicable' {
  if (!session.nativeCredentialPaths?.length || !session.nativeCredentialSnapshotBefore) return 'not_applicable';
  const after = captureNativeCredentialSnapshot(session.nativeCredentialPaths);
  if (session.nativeCredentialSnapshotBefore.state !== 'verified' || after.state !== 'verified') return 'indeterminate';
  return session.nativeCredentialSnapshotBefore.fingerprint === after.fingerprint ? 'unchanged' : 'committed';
}

function completionInputFingerprint(kind: OAuthCompletionAttempt['kind'], value: string): string {
  return createHash('sha256').update(kind).update('\0').update(value).digest('hex');
}

function stripAnsi(value: string) {
  return value.replace(ANSI_REGEX, '');
}

export function normalizeTerminalScreenText(value: string): string {
  return stripAnsi(value)
    .replace(SCREEN_CONTROL_FRAGMENT_REGEX, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function squashPromptText(value: string): string {
  return normalizeTerminalScreenText(value)
    .toLowerCase()
    .replace(/[^a-z0-9:/?._-]+/g, '');
}

export function extractClaudeSetupToken(text: string): string | null {
  const compact = normalizeTerminalScreenText(text).replace(/[\r\n\t ]+/g, '');
  const match = compact.match(/(sk-ant-oat01-[A-Za-z0-9_\-/.+=]{20,})/);
  return match?.[1]?.trim() || null;
}

export function extractClaudeAuthUrl(text: string): string | null {
  const lines = normalizeTerminalScreenText(text).split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const currentLine = lines[i];
    const startIndex = currentLine.indexOf('https://claude.');
    if (startIndex === -1) continue;

    let candidate = currentLine.slice(startIndex).trim();

    for (let j = i + 1; j < lines.length; j += 1) {
      const nextLine = lines[j].trim();
      if (!nextLine) break;
      if (/^Paste\s*code\s*here/i.test(nextLine) || /^Pastecodehereifprompted>?$/i.test(nextLine)) break;
      if (!/^[A-Za-z0-9%&=_\-./+:?#]+$/.test(nextLine)) break;
      candidate += nextLine;
    }

    const match = candidate.match(/^https:\/\/claude\.(?:ai|com)\/[A-Za-z0-9%&=_\-./+:?#]+/);
    if (!match) continue;

    return match[0];
  }

  return null;
}

export function outputLooksLikeClaudeCliAuthImportSuccess(text: string): boolean {
  const normalizedOutput = normalizeTerminalScreenText(stripAnsi(text));
  return /auth profile:|default model available:|claude cli auth detected/i.test(normalizedOutput);
}

export function maybeCaptureClaudeSetupToken(session: OAuthSession) {
  if (session.provider !== 'anthropic') return null;
  if (session.status === 'cancelled' || session.status === 'expired' || session.status === 'error') return null;
  const token = extractClaudeSetupToken(session.cleanOutput);
  if (!token) return null;
  if (session.capturedToken !== token) {
    session.capturedToken = token;
    session.status = 'complete';
    session.completedAt = Date.now();
    console.log(`[Claude] Setup token detected in PTY output (${token.length} chars; value redacted)`);
  }
  return token;
}

export function completeClaudeSetupTokenProcessExit(
  session: OAuthSession,
  exitCode: number,
  _persistToken?: (token: string) => unknown,
): string | null {
  recordOAuthProcessExit(session, exitCode);

  // Cancellation/expiry/error is terminal. PTY shutdown can flush one final
  // output chunk containing a token; that late output must never resurrect the
  // session or write a credential after Portal confirmed cancellation.
  if (session.status === 'cancelled' || session.status === 'expired' || session.status === 'error') {
    return null;
  }

  const setupToken = exitCode === 0
    ? (session.capturedToken || extractClaudeSetupToken(session.cleanOutput))
    : null;
  if (setupToken) {
    session.capturedToken = setupToken;
    session.status = 'complete';
    session.completedAt = Date.now();
    // PTY exit is evidence capture only. The joinable /claude/complete
    // lifecycle owns the sole credential write after exit and attestation.
    return setupToken;
  }

  if (exitCode === 0) {
    // A clean process exit is not credential proof. Completion remains
    // unsuccessful unless the owned setup-token session actually emitted its
    // reusable token.
    session.status = 'complete';
    session.completedAt = Date.now();
  } else if (!session.error) {
    session.status = 'error';
    session.error = `Claude setup-token exited with code ${exitCode}`;
  }
  return null;
}

function recordOAuthProcessExit(session: OAuthSession, exitCode: number): void {
  session.processExited = true;
  session.processExitCode = exitCode;
  session.processExitedAt = Date.now();
}

function isTerminalOAuthStop(session: Pick<OAuthSession, 'status'>): boolean {
  return session.status === 'cancelled' || session.status === 'expired' || session.status === 'error';
}

function isCompletedOAuthSession(session: Pick<OAuthSession, 'status'>): boolean {
  return session.status === 'complete';
}

function terminalOAuthMutationError(
  session: Pick<OAuthSession, 'status' | 'processExited'>,
  operation: string,
): string | null {
  if (isTerminalOAuthStop(session)) {
    return `OAuth session is ${session.status}. Start a fresh sign-in before ${operation}.`;
  }
  if (session.status === 'complete') {
    return `OAuth session is already complete and cannot accept ${operation}.`;
  }
  if (session.processExited) {
    return `Provider login process exited before ${operation}. Start the sign-in again.`;
  }
  return null;
}

function readProviderProfileIds(provider: string) {
  const authProfiles = readAuthProfiles();
  const aliases = getOAuthProfileProviderAliases(provider);
  return Object.keys(authProfiles.profiles || {}).filter((profileId) => aliases.has(authProfiles.profiles?.[profileId]?.provider));
}

export function authProfileStateFingerprint(profile: any): string {
  const state = {
    provider: String(profile?.provider || ''),
    type: String(profile?.type || ''),
    key: typeof profile?.key === 'string' ? profile.key : null,
    token: typeof profile?.token === 'string' ? profile.token : null,
    access: typeof profile?.access === 'string' ? profile.access : null,
    refresh: typeof profile?.refresh === 'string' ? profile.refresh : null,
    expires: typeof profile?.expires === 'number' ? profile.expires : null,
    email: typeof profile?.email === 'string' ? profile.email : null,
    accountId: typeof profile?.accountId === 'string' ? profile.accountId : null,
    managedBy: typeof profile?.managedBy === 'string' ? profile.managedBy : null,
  };
  const hasCredentialMaterial = Boolean(state.key || state.token || state.access || state.refresh);
  const digest = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  return `${hasCredentialMaterial ? 'complete' : 'opaque'}:${digest}`;
}

function readProviderProfileState(provider: string): Record<string, string> {
  const authProfiles = readAuthProfilesStrict();
  const aliases = getOAuthProfileProviderAliases(provider);
  return Object.fromEntries(
    Object.entries(authProfiles.profiles || {})
      .filter(([, profile]) => aliases.has(profile?.provider))
      .map(([profileId, profile]) => [profileId, authProfileStateFingerprint(profile)]),
  );
}

async function readProviderProfileStateAsync(provider: string): Promise<Record<string, string>> {
  const authProfiles = await readAuthProfilesStrictAsync();
  const aliases = getOAuthProfileProviderAliases(provider);
  return Object.fromEntries(
    Object.entries(authProfiles.profiles || {})
      .filter(([, profile]) => aliases.has(profile?.provider))
      .map(([profileId, profile]) => [profileId, authProfileStateFingerprint(profile)]),
  );
}

function profileStateLifecycleFingerprint(profileState: Record<string, string>): string {
  return credentialStartFingerprint(
    Object.entries(profileState).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * The CLI each native provider signs in through, so a failure can name the
 * tool the operator actually has to install rather than talking about an
 * "inventory" nobody outside this file has heard of.
 */
const NATIVE_PROVIDER_CLI: Record<NativeCredentialProvider, { command: string; label: string }> = {
  CLAUDE_CODE: { command: 'claude', label: 'Claude Code' },
  CODEX: { command: 'codex', label: 'the Codex CLI' },
  GEMINI: { command: 'agy', label: 'the Antigravity CLI' },
  GROK: { command: 'grok', label: 'the Grok CLI' },
};

function nativeCliIsInstalled(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Explain an indeterminate credential snapshot in terms the operator can act
 * on. A missing CLI is by far the most common cause and used to surface as an
 * opaque attestation error with no hint that anything needed installing.
 */
function describeNativeCredentialAttestationFailure(provider: NativeCredentialProvider): string {
  const cli = NATIVE_PROVIDER_CLI[provider];
  if (cli && !nativeCliIsInstalled(cli.command)) {
    return `${cli.label} is not installed on this server, so its sign-in cannot run. Install it from Setup → AI tools (or run \`${cli.command}\` on the server), then connect this provider again.`;
  }

  const unreadable: string[] = [];
  for (const credentialPath of resolveNativeCliCredentialPaths(provider)) {
    if (captureNativeCredentialSnapshot([credentialPath]).state !== 'verified') {
      unreadable.push(credentialPath);
    }
  }
  if (unreadable.length > 0) {
    return `Portal could not read this provider's credential files, so it will not start a sign-in that it cannot verify. Check permissions on: ${unreadable.join(', ')}.`;
  }

  return `Portal could not verify ${cli ? cli.label : 'this provider'}'s credential files, so the sign-in was stopped before it started. Retry, and if it keeps failing check the server logs for this provider.`;
}

async function readNativeCredentialLifecycleProof(
  provider: NativeCredentialProvider,
): Promise<{ fingerprint: string; absent: boolean }> {
  invalidateNativeCliAuthStatus(provider);
  const [snapshot, status] = await Promise.all([
    Promise.resolve(captureNativeCredentialSnapshot(resolveNativeCliCredentialPaths(provider))),
    getNativeCliAuthStatusAsync(provider),
  ]);
  if (snapshot.state !== 'verified' || !snapshot.fingerprint) {
    throw new Error(describeNativeCredentialAttestationFailure(provider));
  }
  return {
    fingerprint: credentialStartFingerprint(snapshot),
    absent: status.status === 'needs_login' || status.status === 'not_applicable',
  };
}

interface CredentialLifecycleDomain {
  key: string;
  openClawProvider: string | null;
  nativeProvider: NativeCredentialProvider | null;
}

function credentialLifecycleDomainForOpenClaw(provider: string): CredentialLifecycleDomain {
  const authProvider = getOpenClawOAuthProviderId(provider);
  if (authProvider === 'anthropic') {
    return { key: 'anthropic', openClawProvider: 'anthropic', nativeProvider: 'CLAUDE_CODE' };
  }
  if (authProvider === 'openai') {
    return { key: 'openai', openClawProvider: 'openai-codex', nativeProvider: 'CODEX' };
  }
  if (authProvider === 'google-gemini-cli') {
    return { key: 'google', openClawProvider: 'google-gemini-cli', nativeProvider: 'GEMINI' };
  }
  if (authProvider === 'xai') {
    return { key: 'xai', openClawProvider: 'xai', nativeProvider: 'GROK' };
  }
  return { key: `openclaw:${authProvider}`, openClawProvider: provider, nativeProvider: null };
}

function credentialLifecycleDomainForNative(
  provider: 'claude-code' | 'codex' | 'gemini' | 'grok',
): CredentialLifecycleDomain {
  if (provider === 'claude-code') {
    return { key: 'anthropic', openClawProvider: 'anthropic', nativeProvider: 'CLAUDE_CODE' };
  }
  if (provider === 'codex') {
    return { key: 'openai', openClawProvider: 'openai-codex', nativeProvider: 'CODEX' };
  }
  if (provider === 'gemini') {
    return { key: 'google', openClawProvider: 'google-gemini-cli', nativeProvider: 'GEMINI' };
  }
  return { key: 'xai', openClawProvider: 'xai', nativeProvider: 'GROK' };
}

export function getCredentialLifecycleNamespaceForOpenClawProvider(provider: string): string {
  return `credential-domain:${credentialLifecycleDomainForOpenClaw(provider).key}`;
}

export function getCredentialLifecycleNamespaceForNativeProvider(
  provider: 'claude-code' | 'codex' | 'gemini' | 'grok',
): string {
  return `credential-domain:${credentialLifecycleDomainForNative(provider).key}`;
}

async function readCredentialLifecycleDomainProof(
  domain: CredentialLifecycleDomain,
): Promise<{ fingerprint: string; absent: boolean }> {
  const openClawState = domain.openClawProvider
    ? await readProviderProfileStateAsync(domain.openClawProvider)
    : null;
  const nativeProof = domain.nativeProvider
    ? await readNativeCredentialLifecycleProof(domain.nativeProvider)
    : null;
  return {
    fingerprint: credentialStartFingerprint({
      openClaw: openClawState === null ? null : profileStateLifecycleFingerprint(openClawState),
      native: nativeProof?.fingerprint || null,
    }),
    absent: (openClawState === null || Object.keys(openClawState).length === 0)
      && (nativeProof === null || nativeProof.absent),
  };
}

export function readCredentialLifecycleDomainProofForOpenClawProvider(
  provider: string,
): Promise<{ fingerprint: string; absent: boolean }> {
  return readCredentialLifecycleDomainProof(credentialLifecycleDomainForOpenClaw(provider));
}

export function readXaiOAuthPreflightState(
  expectedProfileId: string,
  reader: typeof readOpenClawAuthStoreProfiles = readOpenClawAuthStoreProfiles,
): Record<string, string> {
  const profiles = reader('xai', { strict: true });
  if (profiles[expectedProfileId]) {
    throw new Error('The generated xAI OAuth profile already exists. Start a fresh sign-in.');
  }
  return Object.fromEntries(
    Object.entries(profiles).map(([profileId, profile]) => [profileId, authProfileStateFingerprint(profile)]),
  );
}

export async function readXaiOAuthPreflightStateAsync(
  expectedProfileId: string,
  reader: typeof readOpenClawAuthStoreProfilesAsync = readOpenClawAuthStoreProfilesAsync,
): Promise<Record<string, string>> {
  const profiles = await reader('xai', { strict: true });
  if (profiles[expectedProfileId]) {
    throw new Error('The generated xAI OAuth profile already exists. Start a fresh sign-in.');
  }
  return Object.fromEntries(
    Object.entries(profiles).map(([profileId, profile]) => [profileId, authProfileStateFingerprint(profile)]),
  );
}

export function readExpectedXaiOAuthProfile(
  expectedProfileId: string,
  reader: typeof readOpenClawAuthStoreProfiles = readOpenClawAuthStoreProfiles,
): string | null {
  const exact = reader('xai', { strict: true })[expectedProfileId];
  return exact?.provider === 'xai' && exact.type === 'oauth' ? expectedProfileId : null;
}

function findChangedProviderProfileId(session: OAuthSession): string | null {
  const aliases = getOAuthProfileProviderAliases(session.provider);

  if (session.provider === 'xai') {
    const expectedProfileId = session.expectedProfileId;
    if (!expectedProfileId) return null;
    // xAI credentials are authoritative only in OpenClaw's locked per-agent
    // SQLite store. Never accept a legacy/config declaration as proof that the
    // OAuth credential was committed.
    try {
      const profileId = readExpectedXaiOAuthProfile(expectedProfileId);
      session.authStoreReadIndeterminate = false;
      return profileId;
    } catch (error) {
      session.authStoreReadIndeterminate = true;
      throw error;
    }
  }

  let authProfiles: ReturnType<typeof readAuthProfilesStrict>;
  try {
    authProfiles = readAuthProfilesStrict();
    session.authStoreReadIndeterminate = false;
  } catch (error) {
    session.authStoreReadIndeterminate = true;
    throw error;
  }
  const before = session.profileStateBefore || Object.fromEntries(session.profileKeyBefore.map((profileId) => [profileId, '']));
  const entries = Object.entries(authProfiles.profiles || {})
    .filter(([, profile]) => aliases.has(profile?.provider));

  if (session.persistedProfileId) {
    const exact = authProfiles.profiles?.[session.persistedProfileId];
    const exactType = String(exact?.type || '').trim();
    if (exact && aliases.has(exact.provider) && (session.provider !== 'xai' || exactType === 'oauth')) {
      return session.persistedProfileId;
    }
  }

  const changed = entries.find(([profileId, profile]) => (
    before[profileId] === undefined
    || before[profileId] !== authProfileStateFingerprint(profile)
  ));
  if (!changed) {
    // OpenClaw's metadata-only inventory deliberately omits credential bytes.
    // An unchanged opaque row cannot distinguish "nothing happened" from an
    // in-place credential rotation, so it is never evidence of absence.
    if (Object.values(before).some((fingerprint) => fingerprint.startsWith('opaque:'))) {
      session.authStoreReadIndeterminate = true;
      throw new Error('OpenClaw cannot prove whether an existing credential changed in place.');
    }
    session.authStoreReadIndeterminate = false;
    return null;
  }
  session.authStoreReadIndeterminate = false;
  return changed[0];
}

async function findChangedProviderProfileIdAsync(session: OAuthSession): Promise<string | null> {
  // Cancellation and background reconciliation can be reached from request
  // handlers. Coalesce each session's authoritative store probe so a slow
  // OpenClaw control plane cannot overlap commands or block the Node event loop.
  if (session.profileReconciliationReadPromise) {
    return session.profileReconciliationReadPromise;
  }

  const read = (async () => {
    const aliases = getOAuthProfileProviderAliases(session.provider);
    let authProfiles: Awaited<ReturnType<typeof readAuthProfilesStrictAsync>>;

    try {
      if (session.provider === 'xai') {
        const expectedProfileId = session.expectedProfileId;
        if (!expectedProfileId) {
          session.authStoreReadIndeterminate = false;
          return null;
        }
        const profiles = await readOpenClawAuthStoreProfilesAsync('xai', { strict: true });
        const exact = profiles[expectedProfileId];
        const before = session.profileStateBefore || {};
        const current = Object.fromEntries(
          Object.entries(profiles).map(([profileId, profile]) => [profileId, authProfileStateFingerprint(profile)]),
        );
        const baselineIds = Object.keys(before).sort();
        const currentUnownedIds = Object.keys(current)
          .filter((profileId) => profileId !== expectedProfileId)
          .sort();
        const baselineChanged = baselineIds.length !== currentUnownedIds.length
          || baselineIds.some((profileId, index) => (
            currentUnownedIds[index] !== profileId || current[profileId] !== before[profileId]
          ));
        if (baselineChanged) {
          session.authStoreReadIndeterminate = true;
          throw new Error('The xAI credential inventory changed outside this Portal-owned OAuth profile.');
        }
        if (exact && (exact.provider !== 'xai' || exact.type !== 'oauth')) {
          session.authStoreReadIndeterminate = true;
          throw new Error('The Portal-owned xAI OAuth profile has unexpected metadata.');
        }
        session.authStoreReadIndeterminate = false;
        return exact ? expectedProfileId : null;
      }

      authProfiles = await readAuthProfilesStrictAsync();
      session.authStoreReadIndeterminate = false;
    } catch (error) {
      session.authStoreReadIndeterminate = true;
      throw error;
    }

    const before = session.profileStateBefore
      || Object.fromEntries(session.profileKeyBefore.map((profileId) => [profileId, '']));
    const entries = Object.entries(authProfiles.profiles || {})
      .filter(([, profile]) => aliases.has(profile?.provider));

    if (session.persistedProfileId) {
      const exact = authProfiles.profiles?.[session.persistedProfileId];
      if (exact && aliases.has(exact.provider)) return session.persistedProfileId;
    }

    const changed = entries.find(([profileId, profile]) => (
      before[profileId] === undefined
      || before[profileId] !== authProfileStateFingerprint(profile)
    ));
    if (changed) {
      session.authStoreReadIndeterminate = false;
      return changed[0];
    }

    if (Object.values(before).some((fingerprint) => fingerprint.startsWith('opaque:'))) {
      session.authStoreReadIndeterminate = true;
      throw new Error('OpenClaw cannot prove whether an existing credential changed in place.');
    }
    session.authStoreReadIndeterminate = false;
    return null;
  })();

  session.profileReconciliationReadPromise = read;
  try {
    return await read;
  } finally {
    if (session.profileReconciliationReadPromise === read) {
      session.profileReconciliationReadPromise = undefined;
    }
  }
}

export function googleGeminiCliProfileHasUsableCredential(profile: any): boolean {
  if (!profile || typeof profile !== 'object') return false;
  const type = String(profile.type || profile.mode || 'oauth').trim();
  if ((type === 'api_key' || type === 'token') && typeof profile.key === 'string' && profile.key.trim()) {
    return true;
  }
  if (type === 'oauth') {
    return typeof profile.access === 'string'
      && profile.access.trim().length > 0
      && typeof profile.refresh === 'string'
      && profile.refresh.trim().length > 0
      && typeof profile.expires === 'number'
      && Number.isFinite(profile.expires);
  }
  return false;
}

function getProviderProfile(provider: string, profileId: string | null | undefined): any | null {
  if (!profileId) return null;
  const authProfiles = provider === 'xai'
    ? { profiles: readOpenClawAuthStoreProfiles('xai') }
    : readAuthProfiles();
  const profile = authProfiles.profiles?.[profileId];
  if (!profile) return null;
  const aliases = getOAuthProfileProviderAliases(provider);
  return aliases.has(profile.provider) ? profile : null;
}

function validateCompletedProviderProfile(session: OAuthSession): string | null {
  if (session.provider !== 'google-gemini-cli') return null;
  const profileIds = readProviderProfileIds(session.provider);
  const createdProfileId = profileIds.find((profileId) => !session.profileKeyBefore.includes(profileId))
    || profileIds[0]
    || null;
  const profile = getProviderProfile(session.provider, createdProfileId);
  if (googleGeminiCliProfileHasUsableCredential(profile)) return null;
  return 'Google Gemini CLI sign-in did not produce reusable credential material. Re-run the sign-in, or configure GEMINI_API_KEY/Application Default Credentials for the server runtime.';
}

export function getOpenClawOAuthProviderId(provider: string): string {
  return provider === 'openai-codex' ? 'openai' : provider;
}

function getOAuthProfileProviderAliases(provider: string): Set<string> {
  if (provider === 'anthropic') return new Set(['anthropic', 'claude-cli']);
  if (provider === 'openai-codex' || provider === 'codex') return new Set(['openai', 'codex', 'openai-codex']);
  return new Set([provider]);
}

function rewriteStoredAuthProfileProvider(profileId: string | null | undefined, provider: string) {
  if (!profileId) return;
  const authProfiles = readAuthProfiles();
  const existing = authProfiles.profiles?.[profileId];
  if (!existing || existing.provider === provider) return;
  authProfiles.profiles[profileId] = {
    ...existing,
    provider,
  };
  fs.mkdirSync(path.dirname(AUTH_PROFILES_PATH), { recursive: true });
  fs.writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(authProfiles, null, 2));
}

function buildPortalOAuthEnv(extraEnv?: Record<string, string>) {
  return {
    ...buildOpenClawCliEnv(),
    ...extraEnv,
    BROWSER: '/bin/false',
    DISPLAY: '',
    WAYLAND_DISPLAY: '',
    SSH_CONNECTION: extraEnv?.SSH_CONNECTION || process.env.SSH_CONNECTION || 'bridgesllm-portal-oauth 127.0.0.1 127.0.0.1 0',
  } as Record<string, string>;
}

export function buildXaiOAuthProfileId(sessionId: string): string {
  const safeSessionId = String(sessionId || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!safeSessionId) throw new Error('A valid OAuth session id is required.');
  return `xai:portal-oauth-${safeSessionId}`;
}

export function buildOAuthLoginArgs(provider: string, profileId?: string | null): string[] {
  const authProvider = getOpenClawOAuthProviderId(provider);
  const args = ['models', 'auth'];
  if (provider === 'xai') args.push('--agent', 'main');
  args.push('login', '--provider', authProvider);
  if (provider === 'openai-codex' || provider === 'xai') {
    args.push('--method', 'oauth');
  }
  if (provider === 'xai') {
    if (!profileId) throw new Error('xAI OAuth requires a unique Portal profile id.');
    args.push('--profile-id', profileId);
  }
  return args;
}

function isTrustedXaiDeviceUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (hostname === 'x.ai' || hostname.endsWith('.x.ai'));
  } catch {
    return false;
  }
}

export function extractDeviceCodeInstructions(provider: string, text: string): { verificationUrl: string | null; deviceCode: string | null } {
  const normalizedText = normalizeTerminalScreenText(text);
  const urls = normalizedText.match(/https?:\/\/[^\s)"'>]+/g) || [];
  const verificationUrl = urls.find((url) => {
    if (/github\.com\/login\/device/i.test(url)) return true;
    if (/auth\.openai\.com\/codex\/device/i.test(url)) return true;
    return (provider === 'xai' || provider === 'grok') && isTrustedXaiDeviceUrl(url);
  }) || null;

  const deviceCodePatterns = [
    /one-time code[^]*?\n\s+([A-Z0-9-]{6,})/i,
    /Code:\s*([A-Z0-9-]{6,})/i,
    /enter (?:the )?code[:\s]+([A-Z0-9-]{6,})/i,
    /confirm this code in your browser:\s*([A-Z0-9-]{6,})/i,
  ];
  let deviceCode: string | null = null;
  for (const pattern of deviceCodePatterns) {
    const match = normalizedText.match(pattern);
    if (!match?.[1]) continue;
    deviceCode = match[1];
    break;
  }

  if (!deviceCode && verificationUrl) {
    try {
      const userCode = new URL(verificationUrl).searchParams.get('user_code');
      if (userCode && /^[A-Z0-9-]{6,}$/i.test(userCode)) deviceCode = userCode.toUpperCase();
    } catch {
      // The URL was already filtered; leave the code absent if parsing fails.
    }
  }

  return { verificationUrl, deviceCode };
}

export function extractDeviceCodeExpiry(text: string, now = Date.now()): number | null {
  const normalizedText = normalizeTerminalScreenText(text);
  const match = normalizedText.match(/(?:code\s+)?expires?\s+in\s*:?[\s]+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m)\b/i)
    || normalizedText.match(/\bexpires_in\b["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i);
  if (!match?.[1]) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = String(match[2] || 'seconds').toLowerCase();
  const seconds = unit.startsWith('m') ? amount * 60 : amount;
  // A device code should be short-lived. Ignore implausible terminal output
  // instead of extending a Portal session indefinitely.
  if (seconds > 24 * 60 * 60) return null;

  return now + Math.ceil(seconds * 1000);
}

function clearOAuthSessionExpiryTimer(session: OAuthSession) {
  if (!session.expiryTimer) return;
  clearTimeout(session.expiryTimer);
  session.expiryTimer = undefined;
}

function scheduleOAuthSessionExpiry(session: OAuthSession) {
  if (!session.expiresAt || session.expiryTimer) return;
  const delayMs = Math.max(0, session.expiresAt - Date.now());
  session.expiryTimer = setTimeout(() => {
    session.expiryTimer = undefined;
    expireOAuthSessionRecord(session);
  }, delayMs);
  session.expiryTimer.unref?.();
}

function isProviderAuthUrl(provider: string, url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    switch (provider) {
      case 'openai-codex':
      case 'openai':
      case 'codex':
        return host === 'auth.openai.com';
      case 'google-gemini-cli':
      case 'gemini':
        return host === 'accounts.google.com' || host === 'accounts.googleusercontent.com';
      case 'anthropic':
      case 'claude-code':
        return host === 'claude.com' || host === 'claude.ai' || host.endsWith('.claude.com') || host.endsWith('.claude.ai');
      default:
        return true;
    }
  } catch {
    return false;
  }
}

function spawnOpenClawPty(args: string[], extraEnv?: Record<string, string>) {
  return pty.spawn(OPENCLAW_BIN, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: {
      ...buildOpenClawCliEnv(),
      // Force OpenClaw's remote/manual OAuth path for portal-managed auth sessions.
      // The portal UI expects a paste-the-redirect flow; letting the CLI drift into
      // local desktop callback mode on a server is brittle and provider-specific.
      SSH_CONNECTION: process.env.SSH_CONNECTION || 'portal-oauth 0 0 0',
      ...extraEnv,
    } as Record<string, string>,
  });
}

type CredentialGatedPty = pty.IPty & {
  releaseCredentialGate: () => void;
};

function spawnCredentialGatedPty(
  executable: string,
  args: string[],
  options: pty.IPtyForkOptions,
): CredentialGatedPty {
  // The shell blocks on one line from the PTY master before exec. A Portal
  // crash closes the master and produces EOF, so the credential-mutating
  // executable never starts. exec preserves the durably bound PID/start ticks.
  const child = pty.spawn('/bin/sh', [
    '-c',
    'IFS= read -r _portal_credential_gate || exit 125; exec "$@"',
    'portal-credential-gate',
    executable,
    ...args,
  ], options) as CredentialGatedPty;
  let released = false;
  child.releaseCredentialGate = () => {
    if (released) return;
    released = true;
    child.write('\n');
  };
  return child;
}

function releaseCredentialGate(processHandle: pty.IPty | null | undefined): void {
  const gated = processHandle as CredentialGatedPty | null | undefined;
  if (!gated || typeof gated.releaseCredentialGate !== 'function') {
    throw new Error('Credential-mutating child is missing its durable execution gate.');
  }
  gated.releaseCredentialGate();
}

function spawnGatedOpenClawPty(
  args: string[],
  lifecycleMarker: string,
  extraEnv?: Record<string, string>,
) {
  return spawnCredentialGatedPty(OPENCLAW_BIN, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: {
      ...buildOpenClawCliEnv(),
      SSH_CONNECTION: process.env.SSH_CONNECTION || 'portal-oauth 0 0 0',
      PORTAL_CREDENTIAL_LIFECYCLE_MARKER: lifecycleMarker,
      ...extraEnv,
    } as Record<string, string>,
  });
}

function spawnPortalOAuthPty(
  args: string[],
  lifecycleMarker: string,
  extraEnv?: Record<string, string>,
) {
  return spawnCredentialGatedPty(OPENCLAW_BIN, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: {
      ...buildPortalOAuthEnv(extraEnv),
      PORTAL_CREDENTIAL_LIFECYCLE_MARKER: lifecycleMarker,
    },
  });
}

function shellEscape(arg: string): string {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function runOpenClawViaScript(args: string[], timeoutMs: number, extraEnv?: Record<string, string>): string {
  const command = [OPENCLAW_BIN, ...args].map(shellEscape).join(' ');
  try {
    return execSync(`script -qefc ${shellEscape(command)} /dev/null`, {
      cwd: process.cwd(),
      env: {
        ...buildOpenClawCliEnv(),
        ...extraEnv,
      },
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 8,
    }) as string;
  } catch (error: any) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : error?.stdout?.toString?.('utf8') || '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : error?.stderr?.toString?.('utf8') || '';
    const combined = `${stdout}\n${stderr}`.trim();
    throw new Error(combined || error?.message || 'script-wrapped OpenClaw command failed');
  }
}

function checkForNewProviderProfile(session: OAuthSession): boolean {
  if (session.status === 'cancelled' || session.status === 'expired' || session.status === 'error') return false;
  invalidateOpenClawAuthStoreProfilesCache();
  let changedProfile: string | null;
  try {
    changedProfile = findChangedProviderProfileId(session);
  } catch {
    return false;
  }
  if (!changedProfile) return false;
  session.persistedProfileId = changedProfile;
  if (session.provider === 'xai') {
    clearOAuthSessionExpiryTimer(session);
    session.expiresAt = null;
    if (!session.processExited) {
      session.status = 'processing';
      return false;
    }
    if (session.processExitCode !== 0) {
      session.status = 'error';
      session.error = 'OpenClaw committed the xAI credential, but the login process did not finish cleanly. Remove xAI before starting another sign-in.';
      session.completedAt = Date.now();
      return false;
    }
  }
  session.status = 'complete';
  session.completedAt = Date.now();
  clearOAuthSessionExpiryTimer(session);
  invalidateOpenClawAuthStoreProfilesCache();
  return true;
}

export async function waitForChangedProviderProfile(
  session: OAuthSession,
  timeoutMs = 3_000,
  reader: (value: OAuthSession) => string | null | Promise<string | null> = findChangedProviderProfileIdAsync,
  delay: (milliseconds: number) => Promise<unknown> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let stableEmptyReads = 0;
  do {
    invalidateOpenClawAuthStoreProfilesCache();
    let profileId: string | null = null;
    try {
      profileId = await reader(session);
    } catch {
      // A failed locked-store read is indeterminate, never proof of absence.
      stableEmptyReads = 0;
    }
    if (profileId) return profileId;
    if (session.authStoreReadIndeterminate) {
      stableEmptyReads = 0;
    } else {
      stableEmptyReads += 1;
    }
    if (Date.now() >= deadline
      && (session.authStoreReadIndeterminate || stableEmptyReads >= 2)) return null;
    await delay(150);
  } while (true);
}

export function scheduleXaiExitProfileReconciliation(
  session: OAuthSession,
  exitCode: number,
): Promise<'committed' | 'absent'> {
  if (session.profileReconciliationPromise) return session.profileReconciliationPromise;
  if (session.status === 'complete' && session.credentialResolution === 'committed') {
    return Promise.resolve('committed');
  }
  const statusAtExit = session.status;
  const errorAtExit = session.error;
  const deadline = Date.now() + 10_000;
  let stableEmptyReads = 0;
  let failureBackoffMs = 1_000;
  let attemptRunning = false;
  let finished = false;
  session.profileReconciliationPending = true;

  let settle!: (resolution: 'committed' | 'absent') => void;
  const reconciliation = new Promise<'committed' | 'absent'>((resolve) => {
    settle = resolve;
  });
  session.profileReconciliationPromise = reconciliation;

  const finish = (resolution: 'committed' | 'absent') => {
    if (finished) return;
    finished = true;
    session.profileReconciliationPending = false;
    session.profileReconciliationTimer = undefined;
    settle(resolution);
  };

  function scheduleAttempt(delayMs: number) {
    if (finished) return;
    session.profileReconciliationTimer = setTimeout(() => {
      void attempt();
    }, delayMs);
    session.profileReconciliationTimer.unref?.();
  }

  async function attempt() {
    if (finished || attemptRunning) return;
    attemptRunning = true;
    invalidateOpenClawAuthStoreProfilesCache();
    let committedProfileId: string | null = null;
    let readFailed = false;
    try {
      committedProfileId = await findChangedProviderProfileIdAsync(session);
    } catch {
      // Retain the plugin lease and exact session binding until the authoritative
      // SQLite control plane becomes readable again.
      session.credentialResolution = 'indeterminate';
      stableEmptyReads = 0;
      readFailed = true;
    } finally {
      attemptRunning = false;
    }
    if (committedProfileId) {
      session.credentialResolution = 'committed';
      session.authStoreReadIndeterminate = false;
      session.persistedProfileId = committedProfileId;
      session.completedAt = Date.now();
      if (statusAtExit === 'cancelled' || statusAtExit === 'expired') {
        session.status = 'error';
        session.error = 'The xAI credential committed while this sign-in was being stopped. Remove xAI before starting another sign-in.';
      } else if (exitCode === 0 && statusAtExit !== 'error') {
        session.status = 'complete';
        session.error = null;
      } else {
        session.status = 'error';
        session.error = errorAtExit || 'OpenClaw committed the xAI credential, but the login process did not finish cleanly. Remove xAI before retrying.';
      }
      clearOAuthSessionExpiryTimer(session);
      finish('committed');
      return;
    }

    if (Date.now() >= deadline && !session.authStoreReadIndeterminate) {
      stableEmptyReads += 1;
      if (stableEmptyReads < 2) {
        scheduleAttempt(250);
        return;
      }
      session.credentialResolution = 'absent';
      if (statusAtExit !== 'cancelled' && statusAtExit !== 'expired' && statusAtExit !== 'error') {
        session.status = 'error';
        session.error = exitCode === 0
          ? 'xAI sign-in exited successfully, but OpenClaw did not confirm a committed OAuth profile.'
          : `Provider login process exited with code ${exitCode}`;
        session.completedAt = Date.now();
      }
      finish('absent');
      return;
    }

    if (readFailed || session.authStoreReadIndeterminate) {
      scheduleAttempt(failureBackoffMs);
      failureBackoffMs = Math.min(failureBackoffMs * 2, 10_000);
      return;
    }
    failureBackoffMs = 1_000;
    scheduleAttempt(500);
  }

  void attempt();
  return reconciliation;
}

/**
 * Cancel kills the sign-in process, but the exit callback that sets
 * `processExited` lands on a later tick. Judging the credential before then
 * always answered "indeterminate", which failed the cancel with HTTP 409 and
 * left the operation gate held — so the next attempt was refused as "already
 * running" and the operator had no way out of the loop. Give the exit a bounded
 * moment to arrive before deciding.
 */
async function waitForProcessExit(session: OAuthSession, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!session.processExited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Boolean(session.processExited);
}

async function waitForXaiExitProfileReconciliation(
  session: OAuthSession,
  timeoutMs = 11_000,
): Promise<'committed' | 'absent' | 'indeterminate'> {
  if (session.provider !== 'xai') return 'indeterminate';
  if (!session.processExited && !(await waitForProcessExit(session))) return 'indeterminate';
  if (session.credentialResolution === 'committed') return 'committed';
  if (session.credentialResolution === 'absent' && !session.profileReconciliationPending) return 'absent';

  const reconciliation = scheduleXaiExitProfileReconciliation(session, session.processExitCode ?? 1);
  let timeout: NodeJS.Timeout | undefined;
  const bounded = new Promise<'indeterminate'>((resolve) => {
    timeout = setTimeout(() => resolve('indeterminate'), timeoutMs);
    timeout.unref?.();
  });
  const resolution = await Promise.race([reconciliation, bounded]);
  if (timeout) clearTimeout(timeout);
  if (resolution === 'indeterminate') {
    session.credentialResolution = 'indeterminate';
  }
  return resolution;
}

function validateOAuthCallbackForSession(session: OAuthSession, callbackUrl: string): string | null {
  try {
    const parsed = new URL(callbackUrl);
    const state = parsed.searchParams.get('state');
    if (session.oauthState && state && state !== session.oauthState) {
      return 'That redirect URL belongs to a different sign-in attempt. Start the sign-in again and paste the newest callback URL.';
    }
  } catch {
    return 'Invalid callback URL.';
  }
  return null;
}

export function textContainsCallbackPastePrompt(text: string): boolean {
  const normalizedText = normalizeTerminalScreenText(text);
  const squashedText = squashPromptText(text);

  return Boolean(
    /Paste the authorization code/i.test(normalizedText)
    || /Paste the redirect URL here/i.test(normalizedText)
    || /Paste the callback URL here/i.test(normalizedText)
    || /Paste the full redirect url/i.test(normalizedText)
    || /Waiting for you to paste the callback URL/i.test(normalizedText)
    || /Enter the authorization code:/i.test(normalizedText)
    || squashedText.includes('waitingforyoutopastethecallbackurl')
    || squashedText.includes('entertheauthorizationcode')
    || squashedText.includes('pastetheauthorizationcode')
    || squashedText.includes('pastetheredirecturlhere')
    || squashedText.includes('pastethecallbackurlhere')
    || squashedText.includes('pastethefullredirecturl')
  );
}

function hasCallbackPastePrompt(session: OAuthSession): boolean {
  return textContainsCallbackPastePrompt(session.cleanOutput);
}

function waitForCallbackPastePrompt(session: OAuthSession, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (session.status === 'complete') {
        clearInterval(timer);
        resolve();
        return;
      }

      if (session.status === 'cancelled' || session.status === 'expired') {
        clearInterval(timer);
        reject(new Error(`OAuth session is ${session.status}. Start a fresh sign-in.`));
        return;
      }

      if (session.error || session.status === 'error') {
        clearInterval(timer);
        reject(new Error(session.error || 'Provider login failed before the callback prompt appeared.'));
        return;
      }

      if (session.processExited) {
        clearInterval(timer);
        reject(new Error('Provider login process exited before the callback prompt was ready. Start the sign-in again.'));
        return;
      }

      if (hasCallbackPastePrompt(session)) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for the callback prompt. Start the sign-in again.'));
      }
    }, 200);
  });
}

function updateSessionFromOutput(session: OAuthSession) {
  if (session.status === 'cancelled' || session.status === 'expired' || session.status === 'error') return;
  const text = session.cleanOutput;
  const normalizedText = normalizeTerminalScreenText(text);
  const squashedText = squashPromptText(text);

  if (session.provider === 'google-gemini-cli') {
    const sawTrustPrompt = squashedText.includes('doyoutrustthefilesinthisfolder?') || squashedText.includes('doyoutrustthefilesinthisfolder');
    const sawOauthPrompt = squashedText.includes('continuewithgooglegeminiclioauth?') || squashedText.includes('continuewithgooglegeminiclioauth');

    // Auto-confirm trust folder prompt (option 1 = "Trust folder")
    if (!(session as any).__trustFolderConfirmed && sawTrustPrompt) {
      (session as any).__trustFolderConfirmed = true;
      session.sentInitialConfirm = true;
      console.log('[NativeCLI] Gemini trust-folder prompt detected, auto-confirming...');
      setTimeout(() => {
        session.process.write('\r');  // Press enter to select default (option 1)
      }, 500);
    }

    // Auto-confirm the Google OAuth caution prompt.
    // Gemini can now surface this prompt even when the trust-folder prompt never appears,
    // and newer TTY renders can draw the prompt as one glyph per line.
    if (sawOauthPrompt && !(session as any).__oauthConfirmed) {
      (session as any).__oauthConfirmed = true;
      session.sentInitialConfirm = true;
      console.log('[NativeCLI] Google OAuth caution prompt detected, auto-confirming...');
      setTimeout(() => {
        session.process.write('\u001b[D');  // left-arrow to select "Yes"
        setTimeout(() => {
          session.process.write('\r');
        }, 300);
      }, 500);
    }
  }

  const urls = normalizedText.match(/https?:\/\/[^\s)"'>]+/g) || [];
  for (const url of urls) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = '';
    }

    const isLocalCallbackUrl = hostname === '127.0.0.1' || hostname === 'localhost';
    const isGithubDeviceUrl = /github\.com\/login\/device/i.test(url);
    const isOpenAIDeviceUrl = /auth\.openai\.com\/codex\/device/i.test(url);
    const isXaiDeviceUrl = (session.provider === 'xai' || session.provider === 'grok') && isTrustedXaiDeviceUrl(url);

    if (!session.verificationUrl && (isGithubDeviceUrl || isOpenAIDeviceUrl || isXaiDeviceUrl)) {
      session.verificationUrl = url;
    }
    // For Claude native CLI, extract local callback port from the local server URL
    if (isLocalCallbackUrl && !session.localPort) {
      try {
        const localUrl = new URL(url);
        session.localPort = parseInt(localUrl.port, 10) || null;
      } catch { /* ignore */ }
    }
    if (!session.authUrl && !isLocalCallbackUrl && !isGithubDeviceUrl && !isOpenAIDeviceUrl && !isXaiDeviceUrl && isProviderAuthUrl(session.provider, url)) {
      session.authUrl = url;
      // Extract OAuth state parameter for local callback relay
      try {
        const parsed = new URL(url);
        const state = parsed.searchParams.get('state');
        if (state) session.oauthState = state;
      } catch { /* ignore */ }
    }
    if (!session.callbackHintUrl && isLocalCallbackUrl) {
      session.callbackHintUrl = url;
    }
  }

  const deviceInstructions = extractDeviceCodeInstructions(session.provider, normalizedText);
  if (!session.verificationUrl && deviceInstructions.verificationUrl) session.verificationUrl = deviceInstructions.verificationUrl;
  if (deviceInstructions.deviceCode) session.deviceCode = deviceInstructions.deviceCode;
  if (session.mode === 'device_code' && !session.expiresAt) {
    session.expiresAt = extractDeviceCodeExpiry(normalizedText);
    scheduleOAuthSessionExpiry(session);
  }

  if (session.mode === 'device_code' && (session.deviceCode || session.verificationUrl || /waiting for github authorization/i.test(normalizedText))) {
    if (session.status !== 'complete') {
      session.status = 'polling_device';
    }
  }

  if (session.mode === 'oauth') {
    const needsCallback =
      /paste.*redirect url/i.test(normalizedText)
      || /paste.*callback url/i.test(normalizedText)
      || /paste the authorization code/i.test(normalizedText)
      || /paste the full redirect url/i.test(normalizedText)
      || textContainsCallbackPastePrompt(text)
      || /localhost/i.test(normalizedText)
      || /127\.0\.0\.1/i.test(normalizedText)
      || Boolean(session.authUrl);

    if (needsCallback && session.status !== 'complete') {
      session.status = 'awaiting_callback';
    }
  }

  if (session.provider === 'xai') {
    const persistedProfile = normalizedText.match(/Auth profile:\s*([^\s(]+)\s*\(xai\/oauth\)/i)?.[1]?.trim();
    if (persistedProfile) {
      if (!session.expectedProfileId || persistedProfile !== session.expectedProfileId) {
        session.status = 'error';
        session.error = 'OpenClaw saved xAI OAuth under an unexpected profile. The Portal will not attach that credential to this sign-in.';
        return;
      }
      session.persistedProfileId = persistedProfile;
      if (checkForNewProviderProfile(session)) return;
      clearOAuthSessionExpiryTimer(session);
      session.expiresAt = null;
      session.status = 'processing';
      return;
    }
    if (/oauth complete/i.test(normalizedText)) {
      // xAI prints this before OpenClaw commits the credential. Do not expose a
      // completed Portal state until the later Auth profile line/SQLite read.
      clearOAuthSessionExpiryTimer(session);
      session.expiresAt = null;
      session.status = 'processing';
      return;
    }
  }

  if (/successfully logged in|login complete|authentication complete|oauth complete|provider added|saved profile|setup.token.*generated|token.*saved|successfully authenticated|auth profile:|default model available:/i.test(normalizedText)) {
    session.status = 'complete';
    session.completedAt = Date.now();
    clearOAuthSessionExpiryTimer(session);
    invalidateOpenClawAuthStoreProfilesCache();
  }
}

function waitForInitialOutput(session: OAuthSession, timeoutMs: number) {
  return new Promise<OAuthSession>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (session.error) {
        clearInterval(timer);
        reject(new Error(session.error));
        return;
      }

      const text = session.cleanOutput;
      const normalizedText = normalizeTerminalScreenText(text);
      if (session.status === 'complete') {
        clearInterval(timer);
        resolve(session);
        return;
      }
      const oauthReady = session.mode === 'oauth' && (
        Boolean(session.authUrl)
        || /Open this URL in your LOCAL browser:/i.test(normalizedText)
        || /Paste the authorization code/i.test(normalizedText)
        || /Paste the redirect URL here/i.test(normalizedText)
        || /Waiting for you to paste the callback URL/i.test(normalizedText)
        || textContainsCallbackPastePrompt(text)
        || /browser didn't open, visit:/i.test(normalizedText)
        || /Enter the authorization code:/i.test(normalizedText)  // Gemini headless OAuth
      );

      const deviceReady = session.mode === 'device_code' && (
        Boolean(session.deviceCode)
        || Boolean(session.verificationUrl)
        || /github\.com\/login\/device/i.test(normalizedText)
        || /auth\.openai\.com\/codex\/device/i.test(normalizedText)
      );

      if (oauthReady || deviceReady) {
        updateSessionFromOutput(session);
        clearInterval(timer);
        resolve(session);
        return;
      }

      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for provider login instructions.'));
      }
    }, 200);
  });
}

function attachPtyParsing(session: OAuthSession) {
  session.process.onData((chunk: string) => {
    session.output += chunk;
    session.cleanOutput += stripAnsi(chunk);
    session.lastOutputAt = Date.now();
    session.processExited = false;
    maybeCaptureClaudeSetupToken(session);
    updateSessionFromOutput(session);
  });

  session.process.onExit(({ exitCode }) => {
    session.processExited = true;
    session.processExitCode = exitCode;
    session.processExitedAt = Date.now();
    console.log(`[OAuth] PTY exited: provider=${session.provider} code=${exitCode} status=${session.status} hasAuthUrl=${Boolean(session.authUrl)} outputLen=${session.cleanOutput.length}`);
    invalidateOpenClawAuthStoreProfilesCache();
    if (session.provider === 'xai') {
      scheduleXaiExitProfileReconciliation(session, exitCode);
      return;
    }
    if (session.status === 'cancelled' || session.status === 'expired') return;
    if (session.status === 'complete') return;
    if (checkForNewProviderProfile(session)) return;
    if (session.authUrl && session.status === 'awaiting_callback') {
      console.log('[OAuth] Process exited after delivering auth URL; portal may respawn a fresh PTY when the callback arrives.');
      return;
    }
    if (exitCode === 0) {
      session.status = 'error';
      session.error = 'Provider login process exited before authentication finished. Start the sign-in again.';
      return;
    }
    if (!session.error) {
      session.status = 'error';
      session.error = `Provider login process exited with code ${exitCode}`;
    }
  });
}

async function failOAuthSessionStart(session: OAuthSession, cause: unknown): Promise<never> {
  const detail = cause instanceof Error && cause.message
    ? cause.message
    : 'Provider login did not produce sign-in instructions.';
  clearOAuthSessionExpiryTimer(session);
  session.completionAbortController?.abort();
  if (!isCompletedOAuthSession(session)) {
    session.status = 'cancelled';
    session.error = null;
    session.completedAt = Date.now();
  }

  if (session.process && typeof session.process.kill === 'function') {
    try {
      session.process.kill();
    } catch {
      // The bounded exit wait and credential attestation below remain authoritative.
    }
  } else {
    session.processExited = true;
    session.processExitedAt = Date.now();
  }

  const exitDeadline = Date.now() + 5_000;
  while (!session.processExited && Date.now() < exitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const startError: any = new Error(detail);
  startError.oauthSessionId = session.id;
  startError.sessionId = session.id;

  if (!session.processExited) {
    session.credentialResolution = 'indeterminate';
    startError.cleanupPending = true;
    startError.credentialState = 'indeterminate';
    startError.message = `${detail} Portal is still stopping and reconciling this login process.`;
    throw startError;
  }

  const nativeState = nativeCredentialMutationState(session);
  if (nativeState === 'committed') {
    session.credentialResolution = 'committed';
    session.status = 'error';
    session.error = 'A native CLI credential changed while Portal was stopping an unresponsive sign-in. Remove or re-verify that provider before retrying.';
    session.completedAt = Date.now();
    startError.credentialCommitted = true;
    startError.credentialState = 'committed';
    startError.message = `${detail} A native CLI credential changed during cleanup; remove or re-verify it before retrying.`;
    throw startError;
  }
  if (nativeState === 'indeterminate') {
    session.credentialResolution = 'indeterminate';
    session.status = 'error';
    session.error = 'Portal could not verify the native CLI credential store after stopping the sign-in.';
    session.completedAt = Date.now();
    startError.cleanupPending = true;
    startError.credentialState = 'indeterminate';
    startError.message = `${detail} Portal cannot prove whether the native CLI credential store changed.`;
    throw startError;
  }

  if (nativeState === 'not_applicable') {
    if (session.provider === 'xai') {
      const xaiResolution = await waitForXaiExitProfileReconciliation(session);
      if (xaiResolution === 'committed') {
        session.credentialResolution = 'committed';
        session.status = 'error';
        session.error = 'The xAI credential committed while Portal was stopping an unresponsive sign-in. Disconnect xAI before retrying.';
        session.completedAt = Date.now();
        startError.credentialCommitted = true;
        startError.credentialState = 'committed';
        startError.message = `${detail} The xAI credential committed during cleanup; disconnect it before retrying.`;
        throw startError;
      }
      if (xaiResolution === 'indeterminate') {
        session.credentialResolution = 'indeterminate';
        session.status = 'error';
        session.error = 'Portal is still reconciling the xAI credential after stopping the sign-in.';
        session.completedAt = Date.now();
        startError.cleanupPending = true;
        startError.credentialState = 'indeterminate';
        startError.message = `${detail} Portal cannot yet prove whether the xAI credential committed.`;
        throw startError;
      }
    }

    invalidateOpenClawAuthStoreProfilesCache();
    let committedProfileId: string | null = null;
    if (session.provider !== 'xai') {
      try {
        committedProfileId = await waitForChangedProviderProfile(session);
      } catch {
        session.authStoreReadIndeterminate = true;
      }
    }

    if (committedProfileId) {
      session.credentialResolution = 'committed';
      session.persistedProfileId = committedProfileId;
      session.status = 'error';
      session.error = 'The provider credential committed while Portal was stopping an unresponsive sign-in. Use server credential maintenance before retrying.';
      session.completedAt = Date.now();
      startError.credentialCommitted = true;
      startError.credentialState = 'committed';
      startError.message = `${detail} A provider credential was committed during cleanup; use server credential maintenance before retrying.`;
      throw startError;
    }
    if (session.authStoreReadIndeterminate) {
      session.credentialResolution = 'indeterminate';
      session.status = 'error';
      session.error = 'Portal could not verify whether the provider committed a credential because its auth store is unavailable.';
      session.completedAt = Date.now();
      startError.cleanupPending = true;
      startError.credentialState = 'indeterminate';
      startError.message = `${detail} Portal cannot yet prove whether a provider credential was committed.`;
      throw startError;
    }
  }

  session.status = 'error';
  session.error = detail;
  session.completedAt = Date.now();
  session.credentialResolution = 'absent';
  startError.credentialCommitted = false;
  startError.credentialState = 'absent';
  throw startError;
}

async function startOAuthFlowCore(
  provider: string,
  options: { googleProjectId?: string; ownerId?: string } | undefined,
  bindSession: CredentialLifecycleSessionBinder,
) {
  const extraEnv: Record<string, string> = {};
  if (provider === 'google-gemini-cli' && options?.googleProjectId) {
    extraEnv.GOOGLE_CLOUD_PROJECT = options.googleProjectId;
    console.log(`[OAuth] Setting GOOGLE_CLOUD_PROJECT=${options.googleProjectId}`);
  }

  const id = createSessionId();
  const expectedProfileId = provider === 'xai' ? buildXaiOAuthProfileId(id) : null;
  invalidateOpenClawAuthStoreProfilesCache();
  // Fail before spawning a credential-mutating PTY if the authoritative xAI
  // store cannot be read or the unique target id already exists.
  const profileStateBefore = expectedProfileId
    ? await readXaiOAuthPreflightStateAsync(expectedProfileId)
    : readProviderProfileState(provider);
  const loginArgs = buildOAuthLoginArgs(provider, expectedProfileId);
  const session: OAuthSession = {
    id,
    provider,
    mode: provider === 'xai' ? 'device_code' : 'oauth',
    ownerId: options?.ownerId,
    process: spawnPortalOAuthPty(loginArgs, bindSession.leaseId, extraEnv),
    authUrl: null,
    callbackHintUrl: null,
    deviceCode: null,
    verificationUrl: null,
    localPort: null,
    oauthState: null,
    status: 'starting',
    error: null,
    output: '',
    cleanOutput: '',
    createdAt: Date.now(),
    expiresAt: null,
    completedAt: null,
    profileKeyBefore: Object.keys(profileStateBefore),
    profileStateBefore,
    expectedProfileId,
    persistedProfileId: null,
    sentInitialConfirm: false,
    extraEnv: Object.keys(extraEnv).length ? extraEnv : undefined,
    capturedToken: null,
    lastOutputAt: Date.now(),
  };

  sessions.set(id, session);
  bindSession(session);
  attachPtyParsing(session);
  releaseCredentialGate(session.process);
  // Google needs extra time for the auto-confirm step
  const timeout = provider === 'google-gemini-cli' ? 30000 : 20000;
  try {
    await waitForInitialOutput(session, timeout);
  } catch (error: any) {
    await failOAuthSessionStart(session, error);
  }
  return {
    sessionId: session.id,
    mode: session.mode,
    status: session.status,
    authUrl: session.authUrl,
    callbackHintUrl: session.callbackHintUrl,
    verificationUrl: session.verificationUrl,
    deviceCode: session.deviceCode,
    expiresAt: session.expiresAt || null,
  };
}

export async function startOAuthFlow(provider: string, options?: { googleProjectId?: string; ownerId?: string }) {
  const domain = credentialLifecycleDomainForOpenClaw(provider);
  const namespace = `credential-domain:${domain.key}`;
  const readFingerprint = () => readCredentialLifecycleDomainProof(domain);
  return runCredentialLifecycleStart(
    namespace,
    options?.ownerId,
    { provider, googleProjectId: options?.googleProjectId || null },
    (bindSession) => startOAuthFlowCore(provider, options, bindSession),
    {
      reviewAfterMs: 15 * 60 * 1000,
      lifecycleKind: 'openclaw-oauth',
      prepare: async () => {
        await reconcileProviderCredentialLifecycleBeforeAdmission(namespace, readFingerprint);
        return { baselineFingerprint: (await readFingerprint()).fingerprint };
      },
    },
  );
}

async function startDeviceCodeFlowCore(
  provider: 'github-copilot',
  ownerId: string | undefined,
  bindSession: CredentialLifecycleSessionBinder,
) {
  const id = createSessionId();
  const profileStateBefore = readProviderProfileState('github-copilot');
  const session: OAuthSession = {
    id,
    provider,
    mode: 'device_code',
    ownerId,
    process: spawnGatedOpenClawPty(
      ['models', 'auth', 'login-github-copilot', '--yes'],
      bindSession.leaseId,
    ),
    authUrl: null,
    callbackHintUrl: null,
    deviceCode: null,
    verificationUrl: null,
    localPort: null,
    oauthState: null,
    status: 'starting',
    error: null,
    output: '',
    cleanOutput: '',
    createdAt: Date.now(),
    expiresAt: null,
    completedAt: null,
    profileKeyBefore: Object.keys(profileStateBefore),
    profileStateBefore,
    sentInitialConfirm: false,
    capturedToken: null,
    lastOutputAt: Date.now(),
  };

  sessions.set(id, session);
  bindSession(session);
  attachPtyParsing(session);
  releaseCredentialGate(session.process);
  try {
    await waitForInitialOutput(session, 20000);
  } catch (error) {
    await failOAuthSessionStart(session, error);
  }
  return {
    sessionId: session.id,
    verificationUrl: session.verificationUrl || session.authUrl,
    deviceCode: session.deviceCode,
    expiresAt: session.expiresAt || null,
  };
}

export async function startDeviceCodeFlow(provider: 'github-copilot', ownerId?: string) {
  const domain = credentialLifecycleDomainForOpenClaw(provider);
  const namespace = `credential-domain:${domain.key}`;
  const readFingerprint = () => readCredentialLifecycleDomainProof(domain);
  return runCredentialLifecycleStart(
    namespace,
    ownerId,
    { provider },
    (bindSession) => startDeviceCodeFlowCore(provider, ownerId, bindSession),
    {
      reviewAfterMs: 20 * 60 * 1000,
      lifecycleKind: 'openclaw-device',
      prepare: async () => {
        await reconcileProviderCredentialLifecycleBeforeAdmission(namespace, readFingerprint);
        return { baselineFingerprint: (await readFingerprint()).fingerprint };
      },
    },
  );
}

export async function importClaudeCliAuthProfile(timeoutMs = 30000) {
  const profileKeyBefore = readProviderProfileIds('anthropic');

  const finalizeSuccess = (rawOutput: string) => {
    const profileIds = readProviderProfileIds('anthropic');
    const createdProfileId = profileIds.find((profileId) => !profileKeyBefore.includes(profileId))
      || profileIds.find((profileId) => profileId === 'anthropic:claude-cli')
      || profileIds[0]
      || null;

    if (createdProfileId === 'anthropic:claude-cli') {
      rewriteStoredAuthProfileProvider(createdProfileId, 'anthropic');
    }

    const normalizedOutput = normalizeTerminalScreenText(stripAnsi(rawOutput));
    const looksSuccessful = Boolean(createdProfileId)
      && outputLooksLikeClaudeCliAuthImportSuccess(normalizedOutput);

    if (!looksSuccessful) {
      const lastOutput = normalizedOutput.trim().split(/\n+/).slice(-12).join('\n').trim();
      throw new Error(lastOutput || 'Claude CLI auth import finished without producing a reusable Anthropic profile.');
    }

    return { success: true as const, profileId: createdProfileId, output: normalizedOutput };
  };

  try {
    const rawOutput = runOpenClawViaScript(['models', 'auth', 'login', '--provider', 'anthropic', '--method', 'cli'], timeoutMs);
    return finalizeSuccess(rawOutput);
  } catch (scriptError: any) {
    const message = String(scriptError?.message || scriptError || '');
    if (outputLooksLikeClaudeCliAuthImportSuccess(message)) {
      return finalizeSuccess(message);
    }
    if (!/\b(script: not found|ENOENT|Timed out waiting)\b/i.test(message)) {
      throw scriptError;
    }
  }

  const process = spawnOpenClawPty(['models', 'auth', 'login', '--provider', 'anthropic', '--method', 'cli']);
  let cleanOutput = '';

  return await new Promise<{ success: true; profileId: string | null; output: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        process.kill();
      } catch {}
      reject(new Error('Timed out waiting for Claude CLI auth import to finish.'));
    }, timeoutMs);

    process.onData((chunk: string) => {
      cleanOutput += chunk;
    });

    process.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try {
        const result = finalizeSuccess(cleanOutput);
        if (exitCode === 0) {
          resolve(result);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }

      const normalizedOutput = normalizeTerminalScreenText(stripAnsi(cleanOutput));
      const lastOutput = normalizedOutput.trim().split(/\n+/).slice(-12).join('\n').trim();
      reject(new Error(lastOutput || `Claude CLI auth import exited with code ${exitCode}`));
    });
  });
}

export async function completeClaudeCliImportForSession(
  session: OAuthSession,
  importer: (timeoutMs: number) => Promise<unknown> = importClaudeCliAuthProfile,
): Promise<boolean> {
  if (isTerminalOAuthStop(session)) return false;
  await importer(30_000);
  // The import command can finish after the owner has cancelled the Portal
  // session. Cancellation remains terminal even if the subprocess completed
  // successfully, and cancelOAuthFlow will reconcile any profile it committed.
  if (isTerminalOAuthStop(session)) return false;
  session.status = 'complete';
  session.completedAt = Date.now();
  return true;
}

export function completeOAuthFlow(sessionId: string, callbackUrl: string, ownerId?: string): Promise<OAuthCompletionResult> {
  const session = sessions.get(sessionId);
  if (!session || (session.ownerId && session.ownerId !== ownerId)) {
    return Promise.reject(new Error('OAuth session not found'));
  }
  if (session.mode !== 'oauth') {
    return Promise.reject(new Error('Session is not waiting for a callback URL'));
  }

  if (isCompletedOAuthSession(session) || checkForNewProviderProfile(session)) {
    const validationError = validateCompletedProviderProfile(session);
    if (validationError) {
      session.status = 'error';
      session.error = validationError;
      return Promise.resolve({ success: false, error: validationError });
    }
    return Promise.resolve({ success: true });
  }

  const inputFingerprint = completionInputFingerprint('oauth_callback', callbackUrl);
  const inFlight = session.completionAttempt;
  if (inFlight) {
    if (inFlight.kind === 'oauth_callback' && inFlight.inputFingerprint === inputFingerprint) {
      return inFlight.promise;
    }
    return Promise.resolve({
      success: false,
      error: 'This OAuth session is already processing a callback. Wait for that attempt to finish before retrying.',
    });
  }
  if (session.status === 'processing') {
    return Promise.resolve({
      success: false,
      error: 'This OAuth session is already processing a callback. Check its status instead of submitting it again.',
    });
  }

  const execution = runOAuthCallbackCompletion(session, callbackUrl);
  const shared = execution.finally(() => {
    if (session.completionAttempt?.promise === shared) session.completionAttempt = undefined;
  });
  session.completionAttempt = {
    kind: 'oauth_callback',
    inputFingerprint,
    promise: shared,
  };
  return shared;
}

async function runOAuthCallbackCompletion(session: OAuthSession, callbackUrl: string): Promise<OAuthCompletionResult> {

  const entryError = terminalOAuthMutationError(session, 'submitting a callback');
  if (entryError && session.status !== 'complete') return { success: false, error: entryError };

  if (session.status === 'complete' || checkForNewProviderProfile(session)) {
    const validationError = validateCompletedProviderProfile(session);
    if (validationError) {
      session.status = 'error';
      session.error = validationError;
      return { success: false, error: validationError };
    }
    return { success: true };
  }

  const callbackValidationError = validateOAuthCallbackForSession(session, callbackUrl);
  if (callbackValidationError) {
    return { success: false, error: callbackValidationError };
  }

  if (session.processExited) {
    return {
      success: false,
      error: 'Provider login process exited before the callback URL could be entered. Start the sign-in again.',
    };
  }

  if (session.error || session.status === 'error') {
    return {
      success: false,
      error: session.error || 'Provider login process exited before the callback URL could be entered. Start the sign-in again.',
    };
  }

  if (!hasCallbackPastePrompt(session)) {
    try {
      await waitForCallbackPastePrompt(session, session.provider === 'google-gemini-cli' ? 30000 : 15000);
      console.log(`[OAuth] Callback prompt confirmed for provider=${session.provider}; submitting callback URL...`);
    } catch (err: any) {
      if (!isTerminalOAuthStop(session)) {
        console.error(`[OAuth] Callback prompt did not become ready for provider=${session.provider}:`, err.message);
      }
      return { success: false, error: err.message || 'Provider login was not ready to accept the callback URL.' };
    }
  }

  // No await may separate this final guard from the state transition. A
  // concurrent cancellation must remain terminal and must never be rewritten
  // back to processing.
  const transitionError = terminalOAuthMutationError(session, 'submitting a callback');
  if (transitionError) {
    if (isCompletedOAuthSession(session)) {
      const validationError = validateCompletedProviderProfile(session);
      return validationError ? { success: false, error: validationError } : { success: true };
    }
    return { success: false, error: transitionError };
  }
  session.status = 'processing';
  session.error = null;

  const callbackInput = callbackUrl;

  try {
    const callbackWriteError = terminalOAuthMutationError(session, 'writing the callback to the provider');
    if (callbackWriteError) return { success: false, error: callbackWriteError };
    console.log(`[OAuth] Writing callback input for provider=${session.provider} (${callbackInput.length} chars)`);
    session.process.write(callbackInput);
    const submitDelayMs = session.provider === 'google-gemini-cli' ? 250 : 100;
    await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    const submitWriteError = terminalOAuthMutationError(session, 'submitting the callback to the provider');
    if (submitWriteError) {
      if (isCompletedOAuthSession(session)) return { success: true };
      return { success: false, error: submitWriteError };
    }
    session.process.write('\r');
  } catch {
    if (isTerminalOAuthStop(session)) {
      return { success: false, error: `OAuth session is ${session.status}. Start a fresh sign-in.` };
    }
    session.status = 'error';
    session.error = 'Provider login process exited before the callback URL could be entered. Start the sign-in again.';
    return { success: false, error: session.error };
  }

  const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (session.status === 'complete') {
        clearInterval(timer);
        resolve({ success: true });
        return;
      }
      if (session.status === 'cancelled' || session.status === 'expired') {
        clearInterval(timer);
        resolve({ success: false, error: `OAuth session is ${session.status}. Start a fresh sign-in.` });
        return;
      }
      if (session.error || session.status === 'error') {
        clearInterval(timer);
        resolve({ success: false, error: session.error || 'Provider login failed' });
        return;
      }
      if (checkForNewProviderProfile(session)) {
        clearInterval(timer);
        resolve({ success: true });
        return;
      }
      const timeoutMs = session.provider === 'google-gemini-cli' ? 90000 : 60000;
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve({ success: false, error: 'Timed out waiting for provider login to finish.' });
      }
    }, 250);
  });

  if (result.success) {
    const validationError = validateCompletedProviderProfile(session);
    if (validationError) {
      session.status = 'error';
      session.error = validationError;
      return { success: false, error: validationError };
    }
  }

  return result;
}

export function cancelOAuthSessionRecord(session: OAuthSession, ownerId?: string): boolean {
  if (session.ownerId && session.ownerId !== ownerId) return false;
  if (session.provider === 'xai' && session.status === 'processing') return false;
  if (['cancelled', 'expired', 'error'].includes(session.status)) return false;
  // A provider/PTY completion marker is not credential proof. Until the
  // authoritative lifecycle records a committed credential, cancellation must
  // still stop and attest the flow rather than fabricating success.
  if (session.status === 'complete' && session.credentialResolution === 'committed') return false;

  session.status = 'cancelled';
  session.lifecycleGeneration = (session.lifecycleGeneration || 0) + 1;
  session.finalizationPending = false;
  session.error = null;
  session.completedAt = Date.now();
  clearOAuthSessionExpiryTimer(session);
  session.completionAbortController?.abort();
  if (session.process && typeof session.process.kill === 'function') {
    try {
      session.process.kill();
    } catch {
      // The PTY may already have exited; the bounded reconciliation below will
      // decide whether cancellation is complete.
    }
  } else {
    // Manual callback flows own no PTY. Mark that absence explicitly so the
    // cancellation endpoint can reconcile immediately instead of reporting an
    // eternal cleanup-pending state.
    session.processExited = true;
    session.processExitedAt = Date.now();
  }

  return true;
}

export function isOAuthSessionCleanupPending(session: Pick<OAuthSession, 'status' | 'processExited' | 'profileReconciliationPending' | 'authStoreReadIndeterminate' | 'credentialResolution'>): boolean {
  const terminalNeedsCredentialProof = ['cancelled', 'expired', 'error'].includes(session.status)
    && session.credentialResolution !== 'absent'
    && session.credentialResolution !== 'committed';
  return Boolean(session.profileReconciliationPending)
    || Boolean(session.authStoreReadIndeterminate)
    || session.credentialResolution === 'indeterminate'
    || terminalNeedsCredentialProof
    || (['cancelled', 'expired', 'error'].includes(session.status) && !session.processExited);
}

export async function cancelOAuthFlow(sessionId: string, ownerId?: string): Promise<
  | { success: true; status: 'cancelled' }
  | { success: false; status: OAuthFlowStatus; error: string; cleanupPending?: boolean; credentialState?: 'committed' | 'indeterminate' }
  | null
> {
  const session = sessions.get(sessionId);
  if (!session || (session.ownerId && session.ownerId !== ownerId)) return null;
  const cancellationStarted = cancelOAuthSessionRecord(session, ownerId);
  if (!cancellationStarted) {
    if (session.credentialResolution === 'committed') {
      return {
        success: false,
        status: 'error',
        credentialState: 'committed',
        error: session.error || 'A provider credential was committed before cancellation completed. Re-verify it and use server credential maintenance before retrying.',
      };
    }
    if (session.status === 'complete') {
      session.credentialResolution = 'committed';
      return {
        success: false,
        status: 'complete',
        credentialState: 'committed',
        error: 'Authorization already completed. Use server credential maintenance for the saved credential instead of retrying this sign-in.',
      };
    }
    if (session.credentialResolution === 'absent') {
      session.status = 'cancelled';
      session.error = null;
      session.completedAt = Date.now();
      releaseCredentialLifecycleLease(session);
      return { success: true, status: 'cancelled' };
    }
    // An earlier read may have been indeterminate. Re-run the same bounded
    // process/credential attestation instead of making the session permanently
    // impossible to reconcile.
    const terminalNeedsAttestation = ['cancelled', 'expired', 'error'].includes(session.status)
      && session.credentialResolution === undefined;
    if (session.credentialResolution === 'indeterminate' || terminalNeedsAttestation) {
      session.authStoreReadIndeterminate = false;
    } else {
      const cleanupPending = isOAuthSessionCleanupPending(session);
      return {
        success: false,
        status: session.status,
        ...(cleanupPending ? { cleanupPending: true } : {}),
        error: `OAuth session is already ${session.status} and cannot be cancelled.`,
      };
    }

    // Terminal status describes the interaction, not credential absence. A
    // PTY can still be alive after emitting an error/expiry, so stop it before
    // performing the same post-exit proof used by an ordinary cancellation.
    clearOAuthSessionExpiryTimer(session);
    session.completionAbortController?.abort();
    if (!session.processExited && session.process && typeof session.process.kill === 'function') {
      try {
        session.process.kill();
      } catch {
        // The bounded exit/credential proof below remains authoritative.
      }
    }
  }

  // Killing a PTY and committing its SQLite auth result can cross by a few
  // milliseconds. Wait briefly for process exit and reconcile the non-secret
  // profile metadata so Portal never reports a clean cancellation when the
  // credential actually won the race.
  const deadline = Date.now() + 2_000;
  while (!session.processExited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!session.processExited) {
    session.credentialResolution = 'indeterminate';
    return {
      success: false,
      status: 'cancelled',
      cleanupPending: true,
      error: 'The provider login process is still stopping. Keep this window open while Portal verifies that no credential was committed.',
    };
  }

  const nativeState = nativeCredentialMutationState(session);
  if (nativeState === 'committed') {
    session.credentialResolution = 'committed';
    session.status = 'error';
    session.error = 'A native CLI credential changed before cancellation reached the provider. Remove or re-verify that provider before retrying.';
    session.completedAt = Date.now();
    return {
      success: false,
      status: 'error',
      credentialState: 'committed',
      error: session.error,
    };
  }
  if (nativeState === 'indeterminate') {
    session.credentialResolution = 'indeterminate';
    session.status = 'error';
    session.error = 'Portal could not prove whether the native CLI credential store changed while this sign-in was stopping.';
    session.completedAt = Date.now();
    return {
      success: false,
      status: 'error',
      cleanupPending: true,
      credentialState: 'indeterminate',
      error: session.error,
    };
  }
  // Claude setup-token writes its captured token to OpenClaw rather than the
  // native Claude credential file. Reconcile both stores before reporting a
  // clean cancellation for that flow.
  if (nativeState === 'unchanged' && session.provider !== 'anthropic') {
    session.credentialResolution = 'absent';
    session.status = 'cancelled';
    session.error = null;
    session.completedAt = Date.now();
    releaseCredentialLifecycleLease(session);
    return { success: true, status: 'cancelled' };
  }

  if (session.provider === 'xai') {
    const xaiResolution = await waitForXaiExitProfileReconciliation(session);
    if (xaiResolution === 'committed') {
      session.credentialResolution = 'committed';
      session.status = 'error';
      session.error = 'Authorization completed before cancellation reached xAI. Use server credential maintenance for the saved credential.';
      session.completedAt = Date.now();
      return {
        success: false,
        status: 'error',
        credentialState: 'committed',
        error: session.error,
      };
    }
    if (xaiResolution === 'indeterminate') {
      session.credentialResolution = 'indeterminate';
      session.status = 'error';
      session.error = 'Portal is still reconciling the xAI credential after stopping the sign-in.';
      session.completedAt = Date.now();
      return {
        success: false,
        status: 'error',
        cleanupPending: true,
        credentialState: 'indeterminate',
        error: session.error,
      };
    }

    session.credentialResolution = 'absent';
    session.status = 'cancelled';
    session.error = null;
    session.completedAt = Date.now();
    releaseCredentialLifecycleLease(session);
    return { success: true, status: 'cancelled' };
  }

  invalidateOpenClawAuthStoreProfilesCache();
  session.authStoreReadIndeterminate = false;
  let committedProfileId: string | null = null;
  try {
    committedProfileId = await waitForChangedProviderProfile(session);
  } catch {
    session.authStoreReadIndeterminate = true;
  }
  if (session.authStoreReadIndeterminate) {
    session.credentialResolution = 'indeterminate';
    session.status = 'error';
    session.error = 'Portal could not verify whether the provider committed a credential because its auth store is unavailable.';
    session.completedAt = Date.now();
    return {
      success: false,
      status: 'error',
      cleanupPending: true,
      credentialState: 'indeterminate',
      error: session.error,
    };
  }
  if (committedProfileId) {
    session.credentialResolution = 'committed';
    session.persistedProfileId = committedProfileId;
    session.status = 'error';
    session.error = 'Authorization completed before cancellation reached the provider. Use server credential maintenance for the saved credential.';
    session.completedAt = Date.now();
    return { success: false, status: 'error', credentialState: 'committed', error: session.error };
  }

  session.credentialResolution = 'absent';
  session.status = 'cancelled';
  session.error = null;
  session.completedAt = Date.now();
  releaseCredentialLifecycleLease(session);
  return { success: true, status: 'cancelled' };
}

export function expireOAuthSessionRecord(session: OAuthSession, now = Date.now()): boolean {
  const terminalStatuses: OAuthFlowStatus[] = ['complete', 'cancelled', 'expired', 'error'];
  if (terminalStatuses.includes(session.status)
    || (session.provider === 'xai' && session.status === 'processing')
    || !session.expiresAt
    || session.expiresAt > now) return false;

  session.status = 'expired';
  session.error = 'This device authorization code expired. Start a fresh sign-in to get a new code.';
  session.completedAt = now;
  clearOAuthSessionExpiryTimer(session);
  try {
    session.process.kill();
  } catch {
    // The PTY may already have exited. Expiry still remains authoritative.
  }
  return true;
}

export function getOAuthFlowStatus(sessionId: string, ownerId?: string) {
  const session = sessions.get(sessionId);
  if (!session || (session.ownerId && session.ownerId !== ownerId)) return null;

  const xaiCommitted = session.provider === 'xai' && session.credentialResolution === 'committed';
  if (session.expiresAt && session.expiresAt <= Date.now()
    && !xaiCommitted
    && (session.provider === 'xai' || !checkForNewProviderProfile(session))) {
    expireOAuthSessionRecord(session);
  }

  // Bypass the normal status cache while OpenClaw is committing the profile.
  if (session.provider !== 'xai'
    && (session.status === 'complete' || session.status === 'processing' || session.processExited)) {
    invalidateOpenClawAuthStoreProfilesCache();
    checkForNewProviderProfile(session);
  }
  if (session.provider === 'xai') {
    // Status is latency-sensitive and is also called by the route's lifecycle
    // monitor. Never execute a synchronous OpenClaw auth-store command here.
    // PTY exit owns one shared asynchronous reconciliation; status exposes the
    // last durable result while that proof is pending.
    if (session.processExited
      && session.credentialResolution !== 'committed'
      && session.credentialResolution !== 'absent') {
      scheduleXaiExitProfileReconciliation(session, session.processExitCode ?? 1);
    }
    const createdProfileId = session.credentialResolution === 'committed'
      ? (session.persistedProfileId || null)
      : null;
    return buildOAuthFlowStatusPayload(session, createdProfileId);
  }

  const authProfiles = readAuthProfiles();
  const providerAliases = getOAuthProfileProviderAliases(session.provider);
  const providerProfileIds = Object.keys(authProfiles.profiles || {})
    .filter((profileId) => providerAliases.has(authProfiles.profiles?.[profileId]?.provider));
  const createdProfileId = selectCompletedProviderProfileId(
    session.provider,
    providerProfileIds,
    session.profileKeyBefore,
    authProfiles.profiles || {},
  );

  return buildOAuthFlowStatusPayload(session, createdProfileId);
}

/**
 * A Claude setup start owns the provider until its PTY is gone and credential
 * outcome is authoritative. The route uses this to resume the same live
 * session instead of spawning a second credential-mutating process after the
 * authorization URL response has already returned.
 */
export function isClaudeSetupTokenLeaseReleasable(sessionId: string, ownerId?: string): boolean {
  const session = sessions.get(sessionId);
  // The ordinary reaper retains unresolved sessions. A missing record in the
  // same process can therefore only be a previously reconciled/reaped record.
  if (!session) return true;
  if (session.provider !== 'anthropic') return false;
  if (session.ownerId && session.ownerId !== ownerId) return false;
  return Boolean(session.processExited)
    && !session.finalizationPending
    && session.credentialResolution === 'absent';
}

export function markClaudeSetupTokenCredentialCommitted(sessionId: string, ownerId?: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.provider !== 'anthropic' || (session.ownerId && session.ownerId !== ownerId)) {
    return false;
  }
  session.credentialResolution = 'committed';
  session.authStoreReadIndeterminate = false;
  session.finalizationPending = false;
  return true;
}

export function beginClaudeSetupTokenFinalization(sessionId: string, ownerId?: string): number | null {
  const session = sessions.get(sessionId);
  if (!session || session.provider !== 'anthropic' || (session.ownerId && session.ownerId !== ownerId)) {
    return null;
  }
  if (isTerminalOAuthStop(session)) return null;
  session.lifecycleGeneration = (session.lifecycleGeneration || 0) + 1;
  session.finalizationPending = true;
  return session.lifecycleGeneration;
}

export function finishClaudeSetupTokenFinalization(
  sessionId: string,
  generation: number,
  ownerId?: string,
): void {
  const session = sessions.get(sessionId);
  if (!session || (session.ownerId && session.ownerId !== ownerId)) return;
  if (session.lifecycleGeneration !== generation) return;
  session.finalizationPending = false;
  releaseCredentialLifecycleLease(session);
}

export function commitClaudeSetupTokenCredential(
  sessionId: string,
  token: string,
  generation: number,
  ownerId?: string,
): { success: boolean; error?: string } {
  const session = sessions.get(sessionId);
  if (!session || session.provider !== 'anthropic' || (session.ownerId && session.ownerId !== ownerId)) {
    return { success: false, error: 'Claude setup session not found.' };
  }
  if (session.lifecycleGeneration !== generation || !session.finalizationPending || isTerminalOAuthStop(session)) {
    return { success: false, error: 'Claude setup completion no longer owns this authorization session.' };
  }
  if (!session.processExited) {
    return { success: false, error: 'Claude setup-token process has not finished shutting down.' };
  }
  try {
    saveProviderToken('anthropic', token);
    session.credentialResolution = 'committed';
    session.authStoreReadIndeterminate = false;
    session.finalizationPending = false;
    console.log(`[Claude] Token saved by the owned setup lifecycle (${token.length} chars; value redacted)`);
    return { success: true };
  } catch (error: any) {
    session.credentialResolution = 'indeterminate';
    session.error = 'Portal could not verify the Claude credential write.';
    return { success: false, error: `Failed to save Claude token: ${error?.message || error}` };
  }
}

export function markOAuthFlowFinalizationError(sessionId: string, detail: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.status = 'error';
  session.error = `The provider credential was saved, but Portal finalization failed: ${String(detail || 'unknown error').slice(0, 600)}`;
  session.completedAt = Date.now();
  clearOAuthSessionExpiryTimer(session);
  return true;
}

export function markOAuthFlowFinalized(sessionId: string, ownerId?: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || (ownerId !== undefined && session.ownerId && session.ownerId !== ownerId)) return false;
  session.credentialResolution = 'committed';
  session.finalizationPending = false;
  releaseCredentialLifecycleLease(session, true);
  return true;
}

export function markOAuthFlowFinalizationPending(sessionId: string, pending: boolean): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.finalizationPending = pending;
  return true;
}

// Non-fatal finalization notice (e.g. an inconclusive live model probe). The
// setup completes and the user can pick a default model; the warning explains
// a possible use-time caveat without blocking a committed, otherwise-valid
// credential.
export function markOAuthFlowFinalizationWarning(sessionId: string, warning: string | null): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.finalizationWarning = warning ? String(warning).slice(0, 600) : null;
  return true;
}

export function selectCompletedProviderProfileId(
  provider: string,
  providerProfileIds: string[],
  profileIdsBefore: string[],
  profiles: Record<string, any>,
): string | null {
  if (provider === 'xai') {
    return providerProfileIds.find((profileId) => (
      !profileIdsBefore.includes(profileId)
      && String(profiles?.[profileId]?.type || profiles?.[profileId]?.mode || '').trim() === 'oauth'
    )) || null;
  }
  return providerProfileIds.find((profileId) => !profileIdsBefore.includes(profileId))
    || providerProfileIds[0]
    || null;
}

export function buildOAuthFlowStatusPayload(session: OAuthSession, createdProfileId: string | null) {
  return {
    id: session.id,
    provider: session.provider,
    authProvider: getOpenClawOAuthProviderId(session.provider),
    mode: session.mode,
    status: session.status,
    authUrl: session.authUrl,
    callbackHintUrl: session.callbackHintUrl,
    deviceCode: session.deviceCode,
    verificationUrl: session.verificationUrl,
    expiresAt: session.expiresAt || null,
    error: session.error,
    finalizationWarning: session.finalizationWarning ?? null,
    createdProfileId,
    cleanupPending: isOAuthSessionCleanupPending(session),
    credentialState: session.credentialResolution ?? null,
    alreadyAuthenticated: Boolean(session.alreadyAuthenticated),
    reauthSupported: session.reauthSupported ?? null,
  };
}

// ── Claude setup-token flow ──────────────────────────────────────────
// Runs `claude setup-token` in a PTY, captures the auth URL and waits
// for the token to be printed after the user completes browser sign-in.

function findClaudeBin(): string {
  
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim() || 'claude';
  } catch {
    return 'claude';
  }
}

interface ClaudeSetupTokenProcessIdentity {
  pid: number;
  ppid: number;
  ageSeconds: number;
  startTicks: string | null;
  portalMarker: string | null;
}

export interface ClaudeOrphanCleanupDependencies {
  listProcesses?: () => ClaudeSetupTokenProcessIdentity[];
  signalProcess?: (processIdentity: ClaudeSetupTokenProcessIdentity, signal: NodeJS.Signals) => void;
  processStillAlive?: (processIdentity: ClaudeSetupTokenProcessIdentity) => boolean;
  readInventoryProof?: () => Promise<{ fingerprint: string; absent: boolean }>;
  delay?: (milliseconds: number) => Promise<unknown>;
  termWaitMs?: number;
  killWaitMs?: number;
  stableReads?: number;
  stableReadIntervalMs?: number;
}

export class ClaudeOrphanLifecycleError extends Error {
  readonly statusCode = 409;
  readonly retainLifecycle = true;
  readonly cleanupPending: boolean;
  readonly credentialState: 'committed' | 'indeterminate';

  constructor(message: string, credentialState: 'committed' | 'indeterminate', cleanupPending: boolean) {
    super(message);
    this.name = 'ClaudeOrphanLifecycleError';
    this.credentialState = credentialState;
    this.cleanupPending = cleanupPending;
  }
}

function readProcStartTicks(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = raw.lastIndexOf(')');
    if (commandEnd < 0) return null;
    const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] || '') ? fields[19] : null;
  } catch {
    return null;
  }
}

function listStaleClaudeSetupTokenProcesses(): ClaudeSetupTokenProcessIdentity[] {
  const processes: ClaudeSetupTokenProcessIdentity[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch (error: any) {
    throw new Error(`Portal could not enumerate Claude setup processes: ${error?.message || error}`);
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    let argv: string[];
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`)
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`Portal could not attest process ${pid} while enumerating Claude setup: ${error?.message || error}`);
    }
    const directClaude = path.basename(argv[0] || '') === 'claude' && argv[1] === 'setup-token';
    const nodeClaude = path.basename(argv[0] || '').startsWith('node')
      && path.basename(argv[1] || '') === 'claude'
      && argv[2] === 'setup-token';
    if (!directClaude && !nodeClaude) continue;

    let portalMarker: string | null = null;
    let ppid = 0;
    let startTicks: string | null = null;
    try {
      const environment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const marker = environment.find((item) => item.startsWith('PORTAL_CREDENTIAL_LIFECYCLE_MARKER='));
      const markerValue = marker?.slice('PORTAL_CREDENTIAL_LIFECYCLE_MARKER='.length) || '';
      portalMarker = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(markerValue)
        ? markerValue
        : null;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(')');
      const fields = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/) : [];
      ppid = /^\d+$/.test(fields[1] || '') ? Number(fields[1]) : 0;
      startTicks = /^\d+$/.test(fields[19] || '') ? fields[19] : null;
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`Portal could not attest Claude setup process ${pid}: ${error?.message || error}`);
    }
    processes.push({ pid, ppid, ageSeconds: 0, startTicks, portalMarker });
  }
  return processes;
}

function claudeProcessIdentityAlive(identity: ClaudeSetupTokenProcessIdentity): boolean {
  if (!identity.startTicks || readProcStartTicks(identity.pid) !== identity.startTicks) return false;
  try {
    process.kill(identity.pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM' && readProcStartTicks(identity.pid) === identity.startTicks;
  }
}

function signalClaudeProcess(identity: ClaudeSetupTokenProcessIdentity, signal: NodeJS.Signals): void {
  if (!identity.startTicks || readProcStartTicks(identity.pid) !== identity.startTicks) return;
  process.kill(identity.pid, signal);
}

async function readClaudeCredentialAbsenceProof(): Promise<{ fingerprint: string; absent: boolean }> {
  return readCredentialLifecycleDomainProof(
    credentialLifecycleDomainForOpenClaw('anthropic'),
  );
}

export async function cleanupStaleClaudeSetupTokenProcesses(
  dependencies: ClaudeOrphanCleanupDependencies = {},
): Promise<number> {
  const listProcesses = dependencies.listProcesses || listStaleClaudeSetupTokenProcesses;
  const signalProcess = dependencies.signalProcess || signalClaudeProcess;
  const processStillAlive = dependencies.processStillAlive || claudeProcessIdentityAlive;
  const readInventoryProof = dependencies.readInventoryProof || readClaudeCredentialAbsenceProof;
  const delay = dependencies.delay || ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const processes = listProcesses();
  if (!processes.length) return 0;

  for (const identity of processes) {
    if (!identity.startTicks || !identity.portalMarker) {
      throw new ClaudeOrphanLifecycleError(
        'Portal found a Claude setup process without exact Portal lifecycle ownership. It was preserved and replacement remains blocked.',
        'indeterminate',
        true,
      );
    }
    if (!processStillAlive(identity)) continue;
    try { signalProcess(identity, 'SIGTERM'); } catch {}
  }

  const waitForExit = async (timeoutMs: number): Promise<ClaudeSetupTokenProcessIdentity[]> => {
    const deadline = Date.now() + timeoutMs;
    let alive = processes.filter(processStillAlive);
    while (alive.length && Date.now() < deadline) {
      await delay(50);
      alive = processes.filter(processStillAlive);
    }
    return alive;
  };

  let alive = await waitForExit(dependencies.termWaitMs ?? 3_000);
  for (const identity of alive) {
    try { signalProcess(identity, 'SIGKILL'); } catch {}
  }
  alive = await waitForExit(dependencies.killWaitMs ?? 2_000);
  if (alive.length) {
    throw new ClaudeOrphanLifecycleError(
      'Portal could not confirm that the stale Claude setup process stopped.',
      'indeterminate',
      true,
    );
  }
  const stableReads = Math.max(2, dependencies.stableReads ?? 3);
  let previous: string | null = null;
  for (let index = 0; index < stableReads; index += 1) {
    let current: string;
    let absent = false;
    try {
      const proof = await readInventoryProof();
      current = proof.fingerprint;
      absent = proof.absent;
    } catch {
      throw new ClaudeOrphanLifecycleError(
        'Portal stopped the stale Claude setup process but could not verify the credential stores afterward.',
        'indeterminate',
        true,
      );
    }
    if (!absent) {
      throw new ClaudeOrphanLifecycleError(
        'The stale Claude setup process left credential material behind. Remove or verify Claude before retrying.',
        'committed',
        false,
      );
    }
    if (previous !== null && current !== previous) {
      throw new ClaudeOrphanLifecycleError(
        'The Claude credential inventory was unstable after the stale setup process stopped.',
        'indeterminate',
        true,
      );
    }
    previous = current;
    if (index + 1 < stableReads) await delay(dependencies.stableReadIntervalMs ?? 150);
  }
  return processes.length;
}

async function startClaudeSetupTokenFlowCore(
  ownerId: string | undefined,
  bindSession: CredentialLifecycleSessionBinder,
) {
  const id = createSessionId();
  const claudeBin = findClaudeBin();
  const profileStateBefore = readProviderProfileState('anthropic');
  const nativeCredentialPaths = resolveNativeCliCredentialPaths('CLAUDE_CODE');
  const nativeCredentialSnapshotBefore = captureNativeCredentialSnapshot(nativeCredentialPaths);
  console.log(`[Claude] Starting setup-token flow, binary=${claudeBin}`);

  const proc = spawnCredentialGatedPty(claudeBin, ['setup-token'], {
    name: 'xterm-256color',
    cols: 500,  // Wide enough to prevent URL line-wrapping
    rows: 40,
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORTAL_CREDENTIAL_LIFECYCLE_MARKER: bindSession.leaseId,
    } as Record<string, string>,
  });

  const session: OAuthSession = {
    id,
    provider: 'anthropic',
    mode: 'oauth',
    ownerId,
    process: proc,
    authUrl: null,
    callbackHintUrl: null,
    deviceCode: null,
    verificationUrl: null,
    localPort: null,
    oauthState: null,
    status: 'starting',
    error: null,
    output: '',
    cleanOutput: '',
    createdAt: Date.now(),
    completedAt: null,
    profileKeyBefore: Object.keys(profileStateBefore),
    profileStateBefore,
    sentInitialConfirm: false,
    capturedToken: null,
    lastOutputAt: Date.now(),
    nativeCredentialProvider: 'CLAUDE_CODE',
    nativeCredentialPaths,
    nativeCredentialSnapshotBefore,
  };

  sessions.set(id, session);
  bindSession(session);

  // Attach parsing — look for the Claude OAuth URL specifically
  proc.onData((chunk: string) => {
    session.output += chunk;
    session.cleanOutput += stripAnsi(chunk);
    session.lastOutputAt = Date.now();
    session.processExited = false;
    maybeCaptureClaudeSetupToken(session);

    // Check for Claude auth URL
    const firstUrl = extractClaudeAuthUrl(session.cleanOutput);
    if (firstUrl && !session.authUrl) {
      session.authUrl = firstUrl;
      session.status = 'awaiting_callback';
      console.log('[Claude] Auth URL captured (value redacted)');
    }
  });

  const tokenPromise = new Promise<string | null>((resolve) => {
    proc.onExit(({ exitCode }) => {
      console.log(`[Claude] PTY exited: code=${exitCode} status=${session.status} outputLen=${session.cleanOutput.length}`);
      const setupToken = completeClaudeSetupTokenProcessExit(session, exitCode);
      if (setupToken) console.log(`[Claude] Setup token captured on exit (${setupToken.length} chars; value redacted)`);
      resolve(setupToken);
    });
  });

  // Store the token promise on the session for later retrieval
  (session as any)._tokenPromise = tokenPromise;
  releaseCredentialGate(proc);

  // Wait for the auth URL to appear (up to 30s)
  try {
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (session.authUrl) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (session.error || session.status === 'error') {
          clearInterval(timer);
          reject(new Error(session.error || 'Claude setup-token failed'));
          return;
        }
        if (Date.now() - started > 30000) {
          clearInterval(timer);
          reject(new Error('Timed out waiting for Claude auth URL. Is Claude Code installed?'));
        }
      }, 200);
    });
  } catch (error) {
    await failOAuthSessionStart(session, error);
  }

  return {
    sessionId: session.id,
    authUrl: session.authUrl,
  };
}

export interface ClaudeSetupTokenStartDependencies {
  cleanupOrphans?: () => Promise<number>;
  readInventoryFingerprint?: () => Promise<string>;
}

export async function startClaudeSetupTokenFlow(
  ownerId?: string,
  dependencies: ClaudeSetupTokenStartDependencies = {},
) {
  const namespace = getCredentialLifecycleNamespaceForOpenClawProvider('anthropic');
  const request = { provider: 'anthropic', method: 'setup-token' };
  const normalizedOwner = ownerId || 'setup:pending';
  const readInventoryProof = dependencies.readInventoryFingerprint
    ? async () => ({
      fingerprint: await dependencies.readInventoryFingerprint!(),
      // Test/custom readers that supply only a fingerprint cannot establish
      // the stronger, provider-specific absence contract.
      absent: false,
    })
    : readClaudeCredentialAbsenceProof;
  return runCredentialLifecycleStart(
    namespace,
    ownerId,
    request,
    (bindSession) => startClaudeSetupTokenFlowCore(ownerId, bindSession),
    {
      reviewAfterMs: 15 * 60 * 1000,
      lifecycleKind: 'claude-setup-token',
      prepare: async () => {
        // Durable ownership is authoritative. In particular, do not let the
        // orphan scanner signal an old but still-live PTY recorded by another
        // backend process merely because it crossed the stale-age threshold.
        await reconcileProviderCredentialLifecycleBeforeAdmission(namespace, readInventoryProof);
        try {
          await (dependencies.cleanupOrphans || cleanupStaleClaudeSetupTokenProcesses)();
        } catch (error: any) {
          if (error instanceof ClaudeOrphanLifecycleError) {
            try {
              const quarantine = claimProviderCredentialLifecycle(
                namespace,
                normalizedOwner,
                credentialStartFingerprint(request),
                {
                  lifecycleKind: 'claude-setup-token-orphan',
                  reviewAfterMs: 15 * 60 * 1000,
                  // A process discovered after restart has no trustworthy
                  // pre-start baseline. It may be released only by the
                  // explicit combined-store removal proof below.
                  baselineFingerprint: null,
                },
              );
              markProviderCredentialLifecycle(
                quarantine,
                error.credentialState,
              );
            } catch {
              // A concurrent process may have established ownership first.
              // Its durable record already prevents replacement; never
              // rewrite ownership that this request did not claim.
            }
          }
          throw error;
        }
        return { baselineFingerprint: (await readInventoryProof()).fingerprint };
      },
    },
  );
}

export async function pasteCodeToClaudeSession(sessionId: string, code: string, ownerId?: string): Promise<{ success: boolean; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session || (session.ownerId && session.ownerId !== ownerId)) return { success: false, error: 'Session not found' };
  if (session.provider !== 'anthropic') return { success: false, error: 'Not a Claude session' };

  const entryError = terminalOAuthMutationError(session, 'submitting a Claude authorization code');
  if (entryError) return { success: false, error: entryError };
  if (session.status === 'processing') {
    return { success: false, error: 'Claude setup-token is already processing an authorization code.' };
  }

  const trimmedCode = code.trim();
  console.log(`[Claude] Pasting auth code (${trimmedCode.length} chars) to PTY...`);

  try {
    const writeError = terminalOAuthMutationError(session, 'writing the Claude authorization code');
    if (writeError) return { success: false, error: writeError };
    session.status = 'processing';
    session.error = null;
    session.process.write(`${trimmedCode}\r\n`);
  } catch (err: any) {
    if (isTerminalOAuthStop(session)) {
      return { success: false, error: `Claude setup-token session is ${session.status}. Start a fresh sign-in.` };
    }
    session.status = 'error';
    session.error = `PTY write failed: ${err.message}`;
    return { success: false, error: session.error };
  }

  // Give Claude a brief moment to reject obviously bad state, but do not block
  // the request on full token generation. The frontend completes that via /claude/complete.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (isTerminalOAuthStop(session)) {
    return { success: false, error: `Claude setup-token session is ${session.status}. Start a fresh sign-in.` };
  }
  if (session.processExited && !isCompletedOAuthSession(session)) {
    return { success: false, error: 'Claude setup-token process exited before the authorization code completed.' };
  }
  maybeCaptureClaudeSetupToken(session);

  if (session.error) {
    return { success: false, error: session.error || 'Claude setup failed' };
  }

  return { success: true };
}

export async function getClaudeSetupToken(sessionId: string, ownerId?: string): Promise<{ success: boolean; token?: string; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session || (session.ownerId && session.ownerId !== ownerId)) return { success: false, error: 'Session not found' };
  if (session.provider !== 'anthropic') return { success: false, error: 'Not a Claude session' };

  const tokenPromise = (session as any)._tokenPromise as Promise<string | null> | undefined;
  if (!tokenPromise) return { success: false, error: 'No token promise found' };

  const deadline = Date.now() + 180_000;
  let capturedToken = session.capturedToken || null;
  let terminationRequested = false;

  while (Date.now() < deadline) {
    if (session.status === 'cancelled' || session.status === 'expired' || session.status === 'error') {
      return { success: false, error: `Claude setup-token session is ${session.status}.` };
    }
    capturedToken = capturedToken || session.capturedToken || extractClaudeSetupToken(session.cleanOutput);
    if (capturedToken) session.capturedToken = capturedToken;

    // A token is only evidence until the PTY has exited. Stop a CLI that keeps
    // running after emitting it, then attest its native credential store before
    // the lifecycle-owned OpenClaw write is allowed.
    if (capturedToken && !session.processExited && !terminationRequested) {
      terminationRequested = true;
      try {
        session.process.kill();
      } catch {
        // The exit callback/attestation below is authoritative.
      }
    }

    if (session.processExited) {
      const nativeState = nativeCredentialMutationState(session);
      if (nativeState === 'committed') {
        session.credentialResolution = 'committed';
        session.status = 'error';
        session.error = 'Claude setup-token changed the native Claude credential store. Remove or re-verify Claude before retrying.';
        return { success: false, error: session.error };
      }
      if (nativeState === 'indeterminate') {
        session.credentialResolution = 'indeterminate';
        session.status = 'error';
        session.error = 'Portal could not attest the Claude credential store after the setup-token process exited.';
        return { success: false, error: session.error };
      }
      session.credentialResolution = 'absent';
      if (capturedToken) return { success: true, token: capturedToken };
      return { success: false, error: 'Claude completed but the token could not be extracted from the output.' };
    }

    const token = await Promise.race([
      tokenPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    if (token) {
      capturedToken = token;
      session.capturedToken = token;
    }
  }

  if (!session.processExited) {
    try { session.process.kill(); } catch { /* exit proof below */ }
    const exitDeadline = Date.now() + 5_000;
    while (!session.processExited && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!session.processExited) {
    session.credentialResolution = 'indeterminate';
    return { success: false, error: 'Claude setup-token timed out and Portal could not verify that its process stopped.' };
  }
  return { success: false, error: 'Timed out waiting for Claude browser sign-in.' };
}

export async function saveClaudeToken(token: string) {
  try {
    // Write directly to auth-profiles.json, openclaw.json, and models.json.
    // The 'openclaw models auth paste-token' CLI is unreliable on fresh installs.
    saveProviderToken('anthropic', token);
    console.log(`[Claude] Token saved directly to auth files (${token.length} chars)`);
    return { success: true };
  } catch (err: any) {
    console.error('[Claude] Failed to save token:', err.message);
    return { success: false, error: `Failed to save token: ${err.message}` };
  }
}

// ── Native CLI OAuth flows ──────────────────────────────────────────
// Spawn native CLI binaries (claude, codex, grok, agy) in PTY to authenticate
// their own credential stores separate from OpenClaw auth profiles.

const HOME_DIR = process.env.HOME || '/root';
const CODEX_AUTH_PATH = path.join(HOME_DIR, '.codex', 'auth.json');

function nativeClaudeCredentialsPath(): string {
  return resolveNativeCliCredentialPaths('CLAUDE_CODE')[0]
    || path.join(process.env.CLAUDE_CONFIG_DIR || HOME_DIR, '.credentials.json');
}

function findCliBin(command: string): string {
  
  try {
    return execSync(`which ${command}`, { encoding: 'utf-8' }).trim() || command;
  } catch {
    return command;
  }
}

function checkCredentialFile(filePath: string, requiredKeys: string[]): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return requiredKeys.every((key) => {
      const parts = key.split('.');
      let current = content;
      for (const part of parts) {
        if (!current || typeof current !== 'object' || !(part in current)) return false;
        current = current[part];
      }
      return Boolean(current);
    });
  } catch {
    return false;
  }
}

function checkAntigravityCredentials(): boolean {
  try {
    execFileSync('agy', ['models'], {
      encoding: 'utf8',
      env: buildNativeCliEnvironment('GEMINI'),
      timeout: 8000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function persistNativeClaudeCredentials(data: Record<string, any>): void {
  const credentialsPath = nativeClaudeCredentialsPath();
  const existing = safeReadJson(credentialsPath) || {};
  existing.claudeAiOauth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + ((data.expires_in || 0) * 1000),
    scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [],
    subscriptionType: existing.claudeAiOauth?.subscriptionType ?? null,
    rateLimitTier: existing.claudeAiOauth?.rateLimitTier ?? null,
  };
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(existing, null, 2));
}

/**
 * Return only an explicitly advertised, non-destructive Antigravity re-auth
 * command. Older `agy` releases authenticate implicitly and expose no such
 * command; inventing one would create a fake browser flow.
 */
export function parseAntigravityReauthArgs(helpOutput: string): string[] | null {
  const help = stripAnsi(String(helpOutput || ''));
  if (/(?:^|\s)--reauthenticate(?:\s|,|$)/i.test(help)) return ['--reauthenticate'];
  if (/(?:^|\s)--reauth(?:\s|,|$)/i.test(help)) return ['--reauth'];

  let inCommands = false;
  for (const line of help.split(/\r?\n/)) {
    if (/^\s*(?:available\s+subcommands|commands)\s*:\s*$/i.test(line)) {
      inCommands = true;
      continue;
    }
    if (inCommands && /^\s*[A-Za-z][A-Za-z /-]*\s*:\s*$/.test(line)) {
      inCommands = false;
    }
    if (!inCommands) continue;
    const commandColumn = line.trim().split(/\s{2,}/)[0]?.trim() || '';
    if (/^login(?:\s+\[[^\]]+\])?$/.test(commandColumn)) return ['login'];
  }
  return null;
}

function getAntigravityReauthArgs(antigravityBin: string): string[] | null {
  try {
    const help = execFileSync(antigravityBin, ['--help'], {
      encoding: 'utf8',
      env: buildNativeCliEnvironment('GEMINI'),
      timeout: 5000,
      maxBuffer: 512 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseAntigravityReauthArgs(help);
  } catch {
    return null;
  }
}

function checkGrokCredentials(): boolean {
  return getNativeCliAuthStatus('GROK').status === 'authenticated';
}

async function startNativeCliFlowCore(
  provider: 'claude-code' | 'codex' | 'gemini' | 'grok',
  bindSession: CredentialLifecycleSessionBinder,
  options: { forceReauth?: boolean; ownerId?: string } = {},
) {
  const id = createSessionId();
  let session: OAuthSession;

  switch (provider) {
    case 'claude-code': {
      // Claude headless login uses a manual PKCE flow. Do it directly instead of
      // trying to puppet the CLI's internal auth UI.
      const codeVerifier = base64Url(randomBytes(32));
      const codeChallenge = buildPkceChallenge(codeVerifier);
      const state = base64Url(randomBytes(32));
      const scopes = [
        'org:create_api_key',
        'user:profile',
        'user:inference',
        'user:sessions:claude_code',
        'user:mcp_servers',
        'user:file_upload',
      ];
      const authUrl = new URL('https://claude.com/cai/oauth/authorize');
      authUrl.searchParams.append('code', 'true');
      authUrl.searchParams.append('client_id', '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      authUrl.searchParams.append('response_type', 'code');
      authUrl.searchParams.append('redirect_uri', 'https://platform.claude.com/oauth/code/callback');
      authUrl.searchParams.append('scope', scopes.join(' '));
      authUrl.searchParams.append('code_challenge', codeChallenge);
      authUrl.searchParams.append('code_challenge_method', 'S256');
      authUrl.searchParams.append('state', state);

      session = {
        id,
        provider: 'claude-code',
        mode: 'oauth',
        ownerId: options.ownerId,
        process: null as any,
        authUrl: authUrl.toString(),
        callbackHintUrl: null,
        deviceCode: null,
        verificationUrl: null,
        localPort: null,
        oauthState: state,
        status: 'awaiting_callback',
        error: null,
        output: '',
        cleanOutput: '',
        createdAt: Date.now(),
        completedAt: null,
        profileKeyBefore: [],
        sentInitialConfirm: false,
        extraEnv: { codeVerifier },
        processExited: true,
        processExitedAt: Date.now(),
      };

      configureNativeCredentialAttestation(session, 'CLAUDE_CODE');
      sessions.set(id, session);
      bindSession(session);
      console.log('[NativeCLI] Claude manual auth URL prepared (value redacted)');
      break;
    }

    case 'codex': {
      const codexBin = findCliBin('codex');
      const nativeCredentialPaths = resolveNativeCliCredentialPaths('CODEX');
      const nativeCredentialSnapshotBefore = captureNativeCredentialSnapshot(nativeCredentialPaths);
      console.log(`[NativeCLI] Starting Codex login, binary=${codexBin}`);
      
      const proc = spawnCredentialGatedPty(codexBin, ['login', '--device-auth'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: {
          ...process.env,
          BROWSER: '/bin/false',
          PORTAL_CREDENTIAL_LIFECYCLE_MARKER: bindSession.leaseId,
        } as Record<string, string>,
      });

      session = {
        id,
        provider: 'codex',
        mode: 'device_code',
        ownerId: options.ownerId,
        process: proc,
        authUrl: null,
        callbackHintUrl: null,
        deviceCode: null,
        verificationUrl: null,
        localPort: null,
        oauthState: null,
        status: 'starting',
        error: null,
        output: '',
        cleanOutput: '',
        createdAt: Date.now(),
        completedAt: null,
        profileKeyBefore: [],
        sentInitialConfirm: false,
        nativeCredentialProvider: 'CODEX',
        nativeCredentialPaths,
        nativeCredentialSnapshotBefore,
      };

      sessions.set(id, session);
      bindSession(session);

      proc.onData((chunk: string) => {
        session.output += chunk;
        session.cleanOutput += stripAnsi(chunk);
        updateSessionFromOutput(session);
      });

      proc.onExit(({ exitCode }) => {
        recordOAuthProcessExit(session, exitCode);
        console.log(`[NativeCLI] Codex PTY exited: code=${exitCode} status=${session.status}`);
        if (isTerminalOAuthStop(session)) return;
        if (checkCredentialFile(CODEX_AUTH_PATH, ['tokens.access_token'])) {
          session.status = 'complete';
          session.completedAt = Date.now();
          console.log('[NativeCLI] Codex credentials verified');
        } else if (session.status !== 'complete' && !session.error) {
          session.status = 'error';
          session.error = `Codex CLI exited with code ${exitCode}`;
        }
      });

      releaseCredentialGate(proc);

      try {
        await waitForInitialOutput(session, 20000);
      } catch (error) {
        await failOAuthSessionStart(session, error);
      }
      break;
    }

    case 'grok': {
      const grokBin = findCliBin('grok');
      const nativeCredentialPaths = resolveNativeCliCredentialPaths('GROK');
      const nativeCredentialSnapshotBefore = captureNativeCredentialSnapshot(nativeCredentialPaths);
      console.log(`[NativeCLI] Starting Grok Build device login, binary=${grokBin}`);

      const proc = spawnCredentialGatedPty(grokBin, [...GROK_BUILD_DEVICE_LOGIN_ARGS], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: {
          ...process.env,
          BROWSER: '/bin/false',
          NO_COLOR: '1',
          GROK_DISABLE_AUTOUPDATER: '1',
          PORTAL_CREDENTIAL_LIFECYCLE_MARKER: bindSession.leaseId,
        } as Record<string, string>,
      });

      session = {
        id,
        provider: 'grok',
        mode: 'device_code',
        ownerId: options.ownerId,
        process: proc,
        authUrl: null,
        callbackHintUrl: null,
        deviceCode: null,
        verificationUrl: null,
        localPort: null,
        oauthState: null,
        status: 'starting',
        error: null,
        output: '',
        cleanOutput: '',
        createdAt: Date.now(),
        completedAt: null,
        profileKeyBefore: [],
        sentInitialConfirm: false,
        nativeCredentialProvider: 'GROK',
        nativeCredentialPaths,
        nativeCredentialSnapshotBefore,
      };

      sessions.set(id, session);
      bindSession(session);
      proc.onData((chunk: string) => {
        session.output += chunk;
        session.cleanOutput += stripAnsi(chunk);
        updateSessionFromOutput(session);
      });
      proc.onExit(({ exitCode }) => {
        recordOAuthProcessExit(session, exitCode);
        console.log(`[NativeCLI] Grok Build PTY exited: code=${exitCode} status=${session.status}`);
        if (isTerminalOAuthStop(session)) return;
        if (checkGrokCredentials()) {
          session.status = 'complete';
          session.completedAt = Date.now();
          console.log('[NativeCLI] Grok Build credentials verified');
        } else if (session.status !== 'complete' && !session.error) {
          session.status = 'error';
          session.error = `Grok Build CLI exited with code ${exitCode}`;
        }
      });

      releaseCredentialGate(proc);

      try {
        await waitForInitialOutput(session, 20000);
      } catch (error) {
        await failOAuthSessionStart(session, error);
      }
      break;
    }

    case 'gemini': {
      const antigravityBin = findCliBin('agy');
      console.log(`[NativeCLI] Starting Antigravity login, binary=${antigravityBin}`);

      const alreadyAuthenticated = checkAntigravityCredentials();
      const reauthArgs = alreadyAuthenticated && options.forceReauth
        ? getAntigravityReauthArgs(antigravityBin)
        : null;

      if (alreadyAuthenticated && (!options.forceReauth || !reauthArgs)) {
        session = {
          id,
          provider: 'gemini',
          mode: 'oauth',
          ownerId: options.ownerId,
          process: null as any,
          authUrl: null,
          callbackHintUrl: null,
          deviceCode: null,
          verificationUrl: null,
          localPort: null,
          oauthState: null,
          status: 'complete',
          error: null,
          output: '',
          cleanOutput: '',
          createdAt: Date.now(),
          completedAt: Date.now(),
          profileKeyBefore: [],
          sentInitialConfirm: false,
          alreadyAuthenticated: true,
          reauthSupported: false,
          processExited: true,
          processExitedAt: Date.now(),
        };
        sessions.set(id, session);
        bindSession(session);
        console.log('[NativeCLI] Antigravity login is already usable; this installed CLI has no supported re-auth command.');
        break;
      }

      const nativeCredentialPaths = resolveNativeCliCredentialPaths('GEMINI');
      const nativeCredentialSnapshotBefore = captureNativeCredentialSnapshot(nativeCredentialPaths);

      const proc = spawnCredentialGatedPty(antigravityBin, reauthArgs || ['--print', 'Authentication setup complete. Reply exactly AUTH_OK.', '--print-timeout', '5m', '--sandbox'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: '/tmp',
        env: {
          ...buildNativeCliEnvironment('GEMINI'),
          NO_BROWSER: 'true',
          PORTAL_CREDENTIAL_LIFECYCLE_MARKER: bindSession.leaseId,
        } as Record<string, string>,
      });

      session = {
        id,
        provider: 'gemini',
        mode: 'oauth',
        ownerId: options.ownerId,
        process: proc,
        authUrl: null,
        callbackHintUrl: null,
        deviceCode: null,
        verificationUrl: null,
        localPort: null,
        oauthState: null,
        status: 'starting',
        error: null,
        output: '',
        cleanOutput: '',
        createdAt: Date.now(),
        completedAt: null,
        profileKeyBefore: [],
        sentInitialConfirm: false,
        alreadyAuthenticated,
        reauthSupported: Boolean(reauthArgs),
        nativeCredentialProvider: 'GEMINI',
        nativeCredentialPaths,
        nativeCredentialSnapshotBefore,
      };

      sessions.set(id, session);
      bindSession(session);

      // Configure auth selection only after the child PID/start ticks are
      // durable. The gated child cannot observe or mutate credentials yet.
      const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity-cli');
      const antigravitySettingsPath = path.join(antigravityDir, 'settings.json');
      try {
        fs.mkdirSync(antigravityDir, { recursive: true });
        let existingSettings: any = {};
        try {
          existingSettings = JSON.parse(fs.readFileSync(antigravitySettingsPath, 'utf-8'));
        } catch { /* file doesn't exist yet */ }
        if (!existingSettings.security?.auth?.selectedType) {
          existingSettings.security = existingSettings.security || {};
          existingSettings.security.auth = existingSettings.security.auth || {};
          existingSettings.security.auth.selectedType = 'oauth-personal';
          fs.writeFileSync(antigravitySettingsPath, JSON.stringify(existingSettings, null, 2));
          console.log('[NativeCLI] Pre-configured Antigravity auth type to oauth-personal');
        }
      } catch (err: any) {
        console.log(`[NativeCLI] Warning: could not pre-configure Antigravity settings: ${err.message}`);
      }

      proc.onData((chunk: string) => {
        session.output += chunk;
        session.cleanOutput += stripAnsi(chunk);
        updateSessionFromOutput(session);
      });

      proc.onExit(({ exitCode }) => {
        recordOAuthProcessExit(session, exitCode);
        console.log(`[NativeCLI] Antigravity PTY exited: code=${exitCode} status=${session.status}`);
        if (isTerminalOAuthStop(session)) return;
        if (checkAntigravityCredentials()) {
          session.status = 'complete';
          session.completedAt = Date.now();
          console.log('[NativeCLI] Antigravity credentials verified');
        } else if (session.status !== 'complete' && !session.error) {
          session.status = 'error';
          session.error = `Antigravity CLI exited with code ${exitCode}`;
        }
      });

      releaseCredentialGate(proc);

      // Antigravity can take a few seconds before it prints the Google authorization URL.
      try {
        await waitForInitialOutput(session, 45000);
      } catch (error) {
        await failOAuthSessionStart(session, error);
      }
      break;
    }
  }

  return {
    sessionId: session.id,
    authUrl: session.authUrl,
    callbackHintUrl: session.callbackHintUrl,
    deviceCode: session.deviceCode,
    verificationUrl: session.verificationUrl,
    status: session.status,
    alreadyAuthenticated: Boolean(session.alreadyAuthenticated),
    reauthSupported: session.reauthSupported ?? null,
  };
}

export async function startNativeCliFlow(
  provider: 'claude-code' | 'codex' | 'gemini' | 'grok',
  options: { forceReauth?: boolean; ownerId?: string } = {},
) {
  const domain = credentialLifecycleDomainForNative(provider);
  const namespace = `credential-domain:${domain.key}`;
  const readFingerprint = () => readCredentialLifecycleDomainProof(domain);
  return runCredentialLifecycleStart(
    namespace,
    options.ownerId,
    { provider, forceReauth: options.forceReauth === true },
    (bindSession) => startNativeCliFlowCore(provider, bindSession, options),
    {
      reviewAfterMs: 15 * 60 * 1000,
      lifecycleKind: 'native-cli',
      prepare: async () => {
        await reconcileProviderCredentialLifecycleBeforeAdmission(namespace, readFingerprint);
        return { baselineFingerprint: (await readFingerprint()).fingerprint };
      },
    },
  );
}

export function completeNativeCliFlow(
  sessionId: string,
  callbackValue: string,
  ownerId?: string,
  dependencies: NativeCliCompletionDependencies = {},
): Promise<OAuthCompletionResult> {
  const session = sessions.get(sessionId);
  if (!session || (session.ownerId && session.ownerId !== ownerId)) {
    return Promise.reject(new Error('Native CLI session not found'));
  }
  if (!['claude-code', 'gemini', 'google-gemini-cli'].includes(session.provider)) {
    return Promise.reject(new Error('Session is not a callback-based native CLI flow'));
  }
  if (isCompletedOAuthSession(session)) return Promise.resolve({ success: true });
  if (isTerminalOAuthStop(session)) {
    return Promise.resolve({ success: false, error: `Native CLI session is ${session.status}. Start a fresh sign-in.` });
  }

  const inputFingerprint = completionInputFingerprint('native_callback', callbackValue);
  const inFlight = session.completionAttempt;
  if (inFlight) {
    if (inFlight.kind === 'native_callback' && inFlight.inputFingerprint === inputFingerprint) {
      return inFlight.promise;
    }
    return Promise.resolve({
      success: false,
      error: 'This native CLI session is already processing a callback. Wait for that attempt to finish before retrying.',
    });
  }
  if (session.status === 'processing') {
    return Promise.resolve({
      success: false,
      error: 'This native CLI session is already processing a callback. Check its status instead of submitting it again.',
    });
  }

  const execution = runNativeCliCallbackCompletion(session, callbackValue, dependencies);
  const shared = execution.finally(() => {
    if (session.completionAttempt?.promise === shared) session.completionAttempt = undefined;
  });
  session.completionAttempt = {
    kind: 'native_callback',
    inputFingerprint,
    promise: shared,
  };
  return shared;
}

async function runNativeCliCallbackCompletion(
  session: OAuthSession,
  callbackValue: string,
  dependencies: NativeCliCompletionDependencies,
): Promise<OAuthCompletionResult> {

  if (session.provider === 'claude-code') {
    // Claude headless flow returns a manual auth code in the form code#fragment.
    // The actual token exchange only uses the code plus the PKCE verifier + state we stored.
    if (!session.oauthState || !session.extraEnv?.codeVerifier) {
      return { success: false, error: 'Claude login session is missing OAuth state. Try restarting the flow.' };
    }

    const pasted = callbackValue.trim();
    const code = pasted.split('#')[0]?.trim();
    if (!code) {
      return { success: false, error: 'Invalid authorization code.' };
    }

    session.status = 'processing';
    session.error = null;

    try {
      const controller = new AbortController();
      session.completionAbortController = controller;
      let timeout: NodeJS.Timeout | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error('Claude token exchange was cancelled or timed out.'));
        }, { once: true });
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Claude token exchange timed out.'));
        }, NATIVE_CLAUDE_TOKEN_EXCHANGE_TIMEOUT_MS);
        timeout.unref?.();
      });
      const exchange = (async () => {
        const resp = await (dependencies.fetchImpl || globalThis.fetch)('https://platform.claude.com/v1/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri: 'https://platform.claude.com/oauth/code/callback',
            client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
            code_verifier: session.extraEnv!.codeVerifier,
            state: session.oauthState,
          }),
          signal: controller.signal,
        });
        const data: any = await resp.json().catch(() => ({}));
        return { resp, data };
      })();
      let response: { resp: Response; data: any };
      try {
        response = await Promise.race([exchange, aborted, deadline]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (session.completionAbortController === controller) session.completionAbortController = undefined;
      }
      const { resp, data } = response;
      if (isTerminalOAuthStop(session)) {
        return { success: false, error: `Native CLI session is ${session.status}. No credential was saved.` };
      }
      if (!resp.ok) {
        const detail = data?.error_description || data?.error || data?.message || `HTTP ${resp.status}`;
        session.status = 'error';
        session.error = `Claude token exchange failed: ${detail}`;
        return { success: false, error: session.error };
      }

      (dependencies.persistClaudeCredentials || persistNativeClaudeCredentials)(data);
      console.log('[NativeCLI] Claude OAuth tokens written to credentials file');
    } catch (err: any) {
      if (isTerminalOAuthStop(session)) {
        return { success: false, error: `Native CLI session is ${session.status}. No credential was saved.` };
      }
      session.status = 'error';
      session.error = `Claude token exchange failed: ${err.message}`;
      return { success: false, error: session.error };
    }
  } else if (session.provider === 'gemini' || session.provider === 'google-gemini-cli') {
    session.status = 'processing';
    session.error = null;
    // Antigravity: write the auth code to PTY stdin (readline is waiting for it)
    let ptyAlive = false;
    try {
      session.process.write('');
      ptyAlive = true;
    } catch {
      ptyAlive = false;
    }

    if (!ptyAlive) {
      return { success: false, error: 'Antigravity CLI process is no longer running. Try restarting the flow.' };
    }

    const code = callbackValue.trim();
    console.log(`[NativeCLI] Writing auth code to Antigravity stdin (${code.length} chars)`);
    session.process.write(`${code}\r`);
  }

  // Poll for credential files
  const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (isTerminalOAuthStop(session)) {
        clearInterval(timer);
        resolve({ success: false, error: `Native CLI session is ${session.status}.` });
        return;
      }
      const credCheck = session.provider === 'claude-code'
        ? checkCredentialFile(nativeClaudeCredentialsPath(), ['claudeAiOauth.accessToken'])
        : checkAntigravityCredentials();

      if (credCheck || session.status === 'complete') {
        clearInterval(timer);
        session.status = 'complete';
        session.completedAt = Date.now();
        resolve({ success: true });
        return;
      }

      if (session.error || session.status === 'error') {
        clearInterval(timer);
        resolve({ success: false, error: session.error || 'Native CLI login failed' });
        return;
      }

      // Check for failure messages in output
      if (/Login failed/i.test(session.cleanOutput) && Date.now() - started > 3000) {
        clearInterval(timer);
        session.status = 'error';
        session.error = 'Login failed — the authorization code may be invalid or expired.';
        resolve({ success: false, error: session.error });
        return;
      }

      if (Date.now() - started > 45000) {
        clearInterval(timer);
        resolve({ success: false, error: 'Timed out waiting for native CLI login to finish.' });
      }
    }, 250);
  });

  return result;
}

setInterval(() => {
  for (const [id, session] of sessions.entries()) {
    if (Date.now() - session.createdAt > 10 * 60 * 1000) {
      if (!['complete', 'cancelled', 'expired', 'error'].includes(session.status)) {
        session.status = 'expired';
        session.error = `This ${session.provider === 'xai' ? 'xAI ' : ''}sign-in expired before it completed.`;
        session.completedAt = Date.now();
        session.credentialResolution = 'indeterminate';
        clearOAuthSessionExpiryTimer(session);
        session.completionAbortController?.abort();
        try {
          session.process.kill();
        } catch {}
        continue;
      }
      // Never erase the only in-process proof while credential absence is
      // unresolved. A restart still becomes an explicit review-required 404,
      // but the ordinary reaper must not manufacture that ambiguity itself.
      if (isOAuthSessionCleanupPending(session)) continue;
      if (!session.processExited && session.status !== 'complete') continue;
      if (session.completedAt && Date.now() - session.completedAt < 2 * 60 * 1000) continue;
      if (session.profileReconciliationTimer) clearTimeout(session.profileReconciliationTimer);
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();
