import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ProjectSandboxExecutionContext, SenderIdentity } from '../agents/AgentProvider.interface';
import { AgentRegistry } from '../agents';
import {
  attestOnlyAgentZeroProjectIdentityRuntime,
  convergeAgentZeroProjectSandboxRuntime,
  qualifyAgentZeroProjectSandboxRuntime,
  type AgentZeroProjectRuntimeStatus,
} from '../agents/providers/agentZero/AgentZeroProjectSandbox';
import {
  normalizeAgentZeroProjectModelSelection,
  type AgentZeroProjectOAuthProviderId,
  type AgentZeroProjectModelSelection,
} from '../agents/providers/agentZero/AgentZeroProjectModelBridgeCredential';
import { config } from '../config/env';
import { deleteSession, getSessionInfo, patchSessionModel } from '../utils/openclawGatewayRpc';
import { normalizePortalModelId } from '../utils/openclawCli';
import {
  attestOnlyOpenClawProjectIdentityRuntime,
  attestOpenClawProjectContainer,
  buildOpenClawProjectSandboxPlan,
  deriveOpenClawProjectAgentId,
  deriveOpenClawProjectSessionKey,
  ensureOpenClawProjectSandbox,
  type OpenClawProjectSandboxInput,
  type OpenClawProjectSandboxResult,
} from './openclawProjectSandbox';
import {
  attestCurrentProjectEgressPlaneByImmutableIdentity,
  attestProjectEgressNetworkMembership,
  buildProjectEgressPlaneSpec,
  projectEgressCommandExecutor,
  type ProjectEgressCommandExecutor,
  type ProjectEgressPlaneConfig,
  type ProjectEgressPlaneSpec,
} from './projectEgressPlane';
import {
  CODEX_PROJECT_PROFILE_NAME,
  ensureCodexProjectQualifiedRuntime,
} from '../agents/providers/native/projectSandbox/CodexProjectSandbox';
import {
  attestOnlyCodexProjectIdentityRuntime,
  attestCodexProjectRuntimeContainer,
  buildCodexProjectDockerExecArgs,
  buildCodexProjectRuntimePlan,
  type CodexProjectEgressRuntimeHandle,
} from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import {
  CLAUDE_CODE_PROJECT_RUNTIME_PROFILE,
  ensureClaudeCodeProjectQualifiedRuntime,
} from '../agents/providers/native/projectSandbox/ClaudeCodeProjectSandbox';
import {
  ANTIGRAVITY_PROJECT_RUNTIME_PROFILE,
  ensureAntigravityProjectQualifiedRuntime,
} from '../agents/providers/native/projectSandbox/AntigravityProjectSandbox';
import {
  NativeProviderDiagnosticError,
} from '../agents/providers/native/NativeProviderDiagnostics';
import {
  attestOnlyNativeCliProjectIdentityRuntime,
  attestNativeCliProjectRuntimeContainer,
  buildNativeCliProjectRuntimePlan,
  type NativeCliProjectEgressRuntimeHandle,
  type NativeCliProjectRuntimeProfile,
} from '../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime';
import {
  QUALIFIABLE_PROJECT_PROVIDERS,
  getProjectChatProviderAdapter,
  getProjectChatProviderRuntimeDescriptor,
  projectChatProviderDisplayName,
  type NativeProjectProvider,
  type QualifiableProjectProvider,
} from './projectChatProviderRegistry';
import {
  agentZeroProjectModelBindingValue,
  resolveAllowedAgentZeroProjectModel,
} from './agentZeroProjectModel';
import {
  ollamaProjectModelBindingValue,
  resolveAllowedOllamaProjectModel,
  type OllamaProjectModelSelection,
} from './ollamaProjectModel';
import {
  OPENCLAW_PROJECT_EXECUTION_RUNTIME,
  clearOpenClawProjectModelRuntimeEligibility,
  clearOpenClawProjectModelRuntimeEligibilityForProject,
  isOpenClawProjectEmbeddedModel,
  readVerifiedOpenClawProjectExecutionBinding,
  registerOpenClawProjectModelRuntimeEligibility,
} from './openclawProjectModel';
import {
  qualifyOllamaProjectFoundation,
  type OllamaProjectQualificationEvidence,
} from '../agents/providers/ollama/OllamaProjectQualification';
import {
  OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
} from '../agents/providers/ollama/OllamaProjectModelBridge';
import { withOllamaAuthorityRunLease } from './ollamaAuthorityBarrier';

export const OPENCLAW_PROJECT_QUALIFICATION_VERSION = 'portal-openclaw-project-qualification-v2';
export const CODEX_PROJECT_QUALIFICATION_VERSION = 'portal-codex-project-qualification-v1';
export const CLAUDE_CODE_PROJECT_QUALIFICATION_VERSION = 'portal-claude-code-project-qualification-v1';
export const ANTIGRAVITY_PROJECT_QUALIFICATION_VERSION = 'portal-gemini-project-qualification-v1';
export const AGENT_ZERO_PROJECT_QUALIFICATION_VERSION = 'portal-agent-zero-project-qualification-v1';
export const OLLAMA_PROJECT_QUALIFICATION_VERSION = 'portal-ollama-project-qualification-v1';
export const OPENCLAW_PROJECT_QUALIFICATION_DEFAULT_TTL_MS = 12 * 60 * 60_000;
export const CODEX_PROJECT_QUALIFICATION_DEFAULT_TTL_MS = OPENCLAW_PROJECT_QUALIFICATION_DEFAULT_TTL_MS;
const MIN_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MODEL_PROBE_TIMEOUT_MS = 3 * 60_000;

/**
 * Providers with a live Project qualification lane. Evidence, MAC domains,
 * and grants are strictly per-provider: one provider's evidence can never
 * make another selectable.
 */
export { QUALIFIABLE_PROJECT_PROVIDERS };
export type { QualifiableProjectProvider };

export function projectQualificationVersionFor(provider: QualifiableProjectProvider): string {
  switch (provider) {
    case 'OPENCLAW': return OPENCLAW_PROJECT_QUALIFICATION_VERSION;
    case 'CODEX': return CODEX_PROJECT_QUALIFICATION_VERSION;
    case 'CLAUDE_CODE': return CLAUDE_CODE_PROJECT_QUALIFICATION_VERSION;
    case 'AGENT_ZERO': return AGENT_ZERO_PROJECT_QUALIFICATION_VERSION;
    case 'GEMINI': return ANTIGRAVITY_PROJECT_QUALIFICATION_VERSION;
    case 'OLLAMA': return OLLAMA_PROJECT_QUALIFICATION_VERSION;
  }
}

export function qualificationMacDomainFor(provider: QualifiableProjectProvider): string {
  return `${projectQualificationVersionFor(provider)}\0evidence\0`;
}

export type OpenClawProjectQualificationProbeId =
  | 'runtime_attestation'
  | 'public_dns_https'
  | 'https_git'
  | 'package_registry_install'
  | 'asset_download'
  | 'model_roundtrip'
  | 'model_runtime_tool_challenge'
  | 'deny_loopback'
  | 'deny_direct_proxy_bypass'
  | 'deny_host_docker_gateway'
  | 'deny_docker_peer'
  | 'deny_rfc1918'
  | 'deny_cgnat'
  | 'deny_link_local_metadata'
  | 'deny_ipv6_private_mapped'
  | 'deny_redirect_private'
  | 'deny_private_dns_answer'
  | 'deny_sibling_host_paths'
  | 'project_rw_write_read_unlink'
  | 'model_bridge_auth'
  | 'model_bridge_route_allowlist';

export type ProjectQualificationProbeId = OpenClawProjectQualificationProbeId;

export const PROJECT_QUALIFICATION_REQUIRED_PROBES: readonly ProjectQualificationProbeId[] = Object.freeze([
  'runtime_attestation',
  'public_dns_https',
  'https_git',
  'package_registry_install',
  'asset_download',
  'model_roundtrip',
  'deny_loopback',
  'deny_direct_proxy_bypass',
  'deny_host_docker_gateway',
  'deny_docker_peer',
  'deny_rfc1918',
  'deny_cgnat',
  'deny_link_local_metadata',
  'deny_ipv6_private_mapped',
  'deny_redirect_private',
  'deny_private_dns_answer',
  'deny_sibling_host_paths',
]);

const REQUIRED_PROBES = PROJECT_QUALIFICATION_REQUIRED_PROBES;

export const OPENCLAW_PROJECT_QUALIFICATION_REQUIRED_PROBES: readonly ProjectQualificationProbeId[] = Object.freeze([
  ...PROJECT_QUALIFICATION_REQUIRED_PROBES,
  'model_runtime_tool_challenge',
]);

export const OLLAMA_PROJECT_QUALIFICATION_REQUIRED_PROBES: readonly ProjectQualificationProbeId[] = Object.freeze([
  'runtime_attestation',
  'project_rw_write_read_unlink',
  'model_bridge_auth',
  'model_bridge_route_allowlist',
  'model_roundtrip',
  'deny_loopback',
  'deny_direct_proxy_bypass',
  'deny_host_docker_gateway',
  'deny_docker_peer',
  'deny_rfc1918',
  'deny_cgnat',
  'deny_link_local_metadata',
  'deny_ipv6_private_mapped',
  'deny_sibling_host_paths',
]);

function requiredProbesFor(provider: QualifiableProjectProvider): readonly ProjectQualificationProbeId[] {
  if (provider === 'OPENCLAW') return OPENCLAW_PROJECT_QUALIFICATION_REQUIRED_PROBES;
  return provider === 'OLLAMA' ? OLLAMA_PROJECT_QUALIFICATION_REQUIRED_PROBES : REQUIRED_PROBES;
}

export interface OpenClawProjectQualificationProbeResult {
  id: OpenClawProjectQualificationProbeId;
  passed: true;
  observedAt: string;
  evidenceSha256: string;
}

export type ProjectQualificationProbeResult = OpenClawProjectQualificationProbeResult;

export interface ProjectQualificationPayload {
  schema: 1;
  qualificationVersion: string;
  provider: QualifiableProjectProvider;
  actorIdentitySha256: string;
  workspaceOwnerIdentitySha256: string;
  projectIdentityId: string;
  projectNameSha256: string;
  canonicalRootSha256: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  runtimePolicyVersion: string;
  egressPolicyVersion: string;
  policyFingerprint: string;
  runtimeImageDigest: string;
  networkIsolation: 'proxy-egress' | 'network-none';
  proxyImageDigest: string | null;
  agentId: string;
  sessionKeySha256: string;
  containerName: string;
  runtimeContainerId: string;
  /**
   * Exact process generation proven at issuance. This closes qualification
   * races and records provenance; it is not a promise that evidence survives
   * a later administrator-initiated clean restart.
   */
  runtimeContainerStartedAt: string | null;
  proxyContainerName: string | null;
  proxyContainerId: string | null;
  internalNetworkName: string | null;
  internalNetworkId: string | null;
  publicNetworkName: string | null;
  publicNetworkId: string | null;
  configHash: string;
  runtimeFingerprint: string;
  egressPolicyFingerprint: string;
  modelId: string | null;
  modelProviderId?: string | null;
  modelDigest?: string | null;
  ollamaBackendKind?: 'LOCAL' | 'TAILNET' | null;
  ollamaBackendFingerprint?: string | null;
  ollamaBackendGeneration?: number | null;
  executionProviderId?: string | null;
  executionRuntimeKind?: string | null;
  modelToolChallengeSha256?: string | null;
  modelResponseSha256: string;
  probes: OpenClawProjectQualificationProbeResult[];
  qualifiedAt: string;
  expiresAt: string;
}


type OpenClawProjectQualificationPayload = ProjectQualificationPayload;

export interface ProjectQualificationEnvelope {
  payload: OpenClawProjectQualificationPayload;
  mac: string;
}

type OpenClawProjectQualificationEnvelope = ProjectQualificationEnvelope;

export interface OpenClawProjectQualificationStatus {
  provider: QualifiableProjectProvider;
  status: 'QUALIFIED' | 'UNQUALIFIED' | 'EXPIRED' | 'INVALID' | 'UNAVAILABLE';
  selectable: boolean;
  reason: string;
  qualifiedAt: string | null;
  expiresAt: string | null;
  evidenceFingerprint: string | null;
}

export type ProjectQualificationStatus = OpenClawProjectQualificationStatus;

export interface OpenClawProjectQualificationGrant {
  readonly provider: QualifiableProjectProvider;
  readonly actorUserId: string;
  readonly projectIdentityId: string;
  readonly policyFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly modelDigest: string | null;
  readonly ollamaBackendKind?: 'LOCAL' | 'TAILNET' | null;
  readonly ollamaBackendFingerprint?: string | null;
  readonly ollamaBackendGeneration?: number | null;
  readonly executionProviderId: string | null;
  readonly executionRuntimeKind: string | null;
  readonly reason: string;
}

export type ProjectQualificationGrant = OpenClawProjectQualificationGrant;

export interface ProjectQualificationSandboxResult {
  agentId: string;
  sessionKey: string;
  containerName: string;
  configHash: string;
  runtimeFingerprint: string;
  egressPolicyFingerprint: string;
  attestedAt: string;
}

export interface ProjectQualificationProbeBundle {
  sandbox: ProjectQualificationSandboxResult;
  spec: ProjectEgressPlaneSpec | null;
  runtimeContainerId: string;
  runtimeContainerStartedAt: string | null;
  proxyContainerId: string | null;
  internalNetworkId: string | null;
  publicNetworkId: string | null;
  modelId: string | null;
  modelProviderId: string | null;
  modelDigest: string | null;
  ollamaBackendKind?: 'LOCAL' | 'TAILNET' | null;
  ollamaBackendFingerprint?: string | null;
  ollamaBackendGeneration?: number | null;
  executionProviderId?: string | null;
  executionRuntimeKind?: string | null;
  modelToolChallengeSha256?: string | null;
  modelResponseSha256: string;
  probes: OpenClawProjectQualificationProbeResult[];
  opaqueRuntime?: unknown;
}

type ProbeBundle = ProjectQualificationProbeBundle;

export interface ProjectQualificationRuntimeAttestation extends Omit<
  ProbeBundle,
  'modelId' | 'modelProviderId' | 'modelDigest'
  | 'ollamaBackendKind' | 'ollamaBackendFingerprint' | 'ollamaBackendGeneration'
  | 'executionProviderId'
  | 'executionRuntimeKind' | 'modelToolChallengeSha256' | 'modelResponseSha256' | 'probes'
> {
  internalInspect?: any;
  publicInspect?: any;
  opaqueRuntime?: unknown;
}

type RuntimeAttestationBundle = ProjectQualificationRuntimeAttestation;

export interface QualifyOpenClawProjectInput {
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  sender: SenderIdentity;
  openClawHome?: string;
  /**
   * Canonical model the OpenClaw lane must pin on the probe session before the
   * live challenge. Without an explicit pin the ephemeral probe session
   * inherits the box-global default model, which may resolve to an external
   * CLI harness that can never produce observable embedded exec evidence.
   */
  openClawModel?: string;
  agentZeroModelSelection?: AgentZeroProjectModelSelection;
  ollamaModelSelection?: OllamaProjectModelSelection;
}

export type QualifyCodexProjectInput = Omit<QualifyOpenClawProjectInput, 'openClawHome'>;
export type QualifyNativeCliProjectInput = QualifyCodexProjectInput;

export interface ProjectQualificationLaneAdapter {
  readonly provider: QualifiableProjectProvider;
  readonly displayName: string;
  readonly qualificationVersion: string;
  buildContextBinding(
    context: ProjectSandboxExecutionContext,
    egress: ProjectEgressPlaneConfig,
    modelSelection?: AgentZeroProjectModelSelection | OllamaProjectModelSelection,
  ): ReturnType<typeof expectedContextBindingBase>;
  attestRuntime(input: {
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
    sender: SenderIdentity;
    openClawHome?: string;
    agentZeroModelSelection?: AgentZeroProjectModelSelection;
    ollamaModelSelection?: OllamaProjectModelSelection;
    dependencies: QualificationDependencies;
  }): Promise<RuntimeAttestationBundle>;
  modelProbe(input: {
    runtime: RuntimeAttestationBundle;
    context: ProjectSandboxExecutionContext;
    sender: SenderIdentity;
    nonce: string;
    openClawModel?: string;
    dependencies: QualificationDependencies;
  }): Promise<{
    modelId: string | null;
    modelProviderId?: string | null;
    modelDigest?: string | null;
    ollamaBackendKind?: 'LOCAL' | 'TAILNET' | null;
    ollamaBackendFingerprint?: string | null;
    ollamaBackendGeneration?: number | null;
    executionProviderId?: string | null;
    executionRuntimeKind?: string | null;
    toolChallengeSha256?: string | null;
    responseSha256: string;
  }>;
}

export interface ProjectQualificationDependencies {
  now(): Date;
  evidenceRoot: string;
  secret: string;
  ttlMs: number;
  executor: ProjectEgressCommandExecutor;
  attestEgressPlane: typeof attestCurrentProjectEgressPlaneByImmutableIdentity;
  attestOpenClawIdentityRuntime: typeof attestOnlyOpenClawProjectIdentityRuntime;
  attestCodexIdentityRuntime: typeof attestOnlyCodexProjectIdentityRuntime;
  attestNativeCliIdentityRuntime: typeof attestOnlyNativeCliProjectIdentityRuntime;
  attestAgentZeroIdentityRuntime: typeof attestOnlyAgentZeroProjectIdentityRuntime;
  ensureSandbox(input: OpenClawProjectSandboxInput): Promise<OpenClawProjectSandboxResult>;
  modelProbe(input: {
    sessionKey: string;
    context: ProjectSandboxExecutionContext;
    sender: SenderIdentity;
    nonce: string;
    model?: string;
    runtimeContainerId: string;
    runtimeContainerStartedAt: string;
    executor: ProjectEgressCommandExecutor;
  }): Promise<{
    modelId: string;
    executionProviderId: string;
    executionRuntimeKind: typeof OPENCLAW_PROJECT_EXECUTION_RUNTIME;
    toolChallengeSha256: string;
    responseSha256: string;
  }>;
  ensureCodexRuntime(input: {
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
  }): Promise<CodexProjectEgressRuntimeHandle>;
  codexModelProbe(input: {
    runtime: CodexProjectEgressRuntimeHandle;
    sender: SenderIdentity;
    nonce: string;
    executor: ProjectEgressCommandExecutor;
  }): Promise<{ modelId: string | null; responseSha256: string }>;
  ensureNativeCliRuntime(input: {
    provider: Extract<NativeProjectProvider, 'CLAUDE_CODE' | 'GEMINI'>;
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
  }): Promise<NativeCliProjectEgressRuntimeHandle>;
  nativeCliModelProbe(input: {
    provider: Extract<NativeProjectProvider, 'CLAUDE_CODE' | 'GEMINI'>;
    context: ProjectSandboxExecutionContext;
    runtime: NativeCliProjectEgressRuntimeHandle;
    sender: SenderIdentity;
    nonce: string;
  }): Promise<{ modelId: string | null; responseSha256: string }>;
  resolveAgentZeroModelSelection(
    value: unknown,
  ): Promise<AgentZeroProjectModelSelection>;
  convergeAgentZeroRuntime(input: {
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
    modelSelection: AgentZeroProjectModelSelection;
  }): Promise<AgentZeroProjectRuntimeStatus>;
  qualifyAgentZeroRuntime(input: {
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
    modelSelection: AgentZeroProjectModelSelection;
  }): Promise<AgentZeroProjectRuntimeStatus>;
  agentZeroModelProbe(input: {
    context: ProjectSandboxExecutionContext;
    sender: SenderIdentity;
    nonce: string;
    modelSelection: AgentZeroProjectModelSelection;
  }): Promise<{ modelId: string; modelProviderId: string; responseSha256: string }>;
  resolveOllamaModelSelection(value: unknown): Promise<OllamaProjectModelSelection>;
  qualifyOllamaRuntime(input: {
    context: ProjectSandboxExecutionContext;
    modelSelection: OllamaProjectModelSelection;
  }): Promise<OllamaProjectQualificationEvidence>;
  runProbes(input: {
    provider: QualifiableProjectProvider;
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
    sender: SenderIdentity;
    openClawHome?: string;
    openClawModel?: string;
    agentZeroModelSelection?: AgentZeroProjectModelSelection;
    ollamaModelSelection?: OllamaProjectModelSelection;
    dependencies: QualificationDependencies;
  }): Promise<ProbeBundle>;
  attestFinalEvidenceRuntime(input: {
    provider: QualifiableProjectProvider;
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
    openClawHome?: string;
    agentZeroModelSelection?: AgentZeroProjectModelSelection;
    bundle: ProbeBundle;
    dependencies: QualificationDependencies;
  }): Promise<void>;
}

type QualificationDependencies = ProjectQualificationDependencies;

const qualificationGrants = new WeakSet<object>();

export class OpenClawProjectQualificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpenClawProjectQualificationError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OpenClawProjectQualificationError(code, message);
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableNormalize(entry)]));
  }
  return value;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function requireSecret(secretInput: string): Buffer {
  const secret = String(secretInput || '').trim();
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(secret)) {
    fail('SECRET_UNAVAILABLE', 'Project qualification signing material is unavailable');
  }
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length < 32) fail('SECRET_WEAK', 'Project qualification signing material is too short');
  return decoded;
}

function evidenceMac(payload: OpenClawProjectQualificationPayload, secret: string): string {
  // The MAC domain embeds the payload's provider, so evidence signed for one
  // provider can never validate for another even with an edited provider
  // field — the domain (and therefore the MAC) would no longer match.
  return crypto.createHmac('sha256', requireSecret(secret))
    .update(qualificationMacDomainFor(payload.provider))
    .update(stableSerialize(payload))
    .digest('base64url');
}

function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function defaultEvidenceRoot(provider: QualifiableProjectProvider = 'OPENCLAW'): string {
  const override = process.env.PORTAL_PROJECT_QUALIFICATION_ROOT;
  if (override) return path.join(override, provider.toLowerCase());
  // Release updates replace /opt/bridgesllm/portal. Qualification is durable
  // runtime state, not release content, so production evidence must live
  // outside that replaceable tree. Tests and development retain the
  // configurable Portal-root default unless a durable data root is supplied.
  if (process.env.PORTAL_DATA_ROOT) {
    return path.join(
      process.env.PORTAL_DATA_ROOT,
      '.data',
      'project-qualifications',
      provider.toLowerCase(),
    );
  }
  if (process.env.NODE_ENV === 'production') {
    return path.join('/var/lib/bridgesllm/project-qualifications', provider.toLowerCase());
  }
  const portalRoot = process.env.PORTAL_ROOT || '/opt/bridgesllm/portal';
  return path.join(portalRoot, '.data', 'project-qualifications', provider.toLowerCase());
}

function resolvedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TTL_MS || value > MAX_TTL_MS) {
    fail('TTL_INVALID', 'Project qualification evidence TTL is outside the supported range');
  }
  return value;
}

function evidenceFileName(context: ProjectSandboxExecutionContext): string {
  return `${sha256(`${context.userId}\0${context.projectId}`)}.json`;
}

function ensurePrivateEvidenceRoot(rootInput: string): string {
  const root = path.resolve(rootInput);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('EVIDENCE_ROOT', 'Project qualification evidence root is not a real directory');
  }
  fs.chmodSync(root, 0o700);
  const canonical = fs.realpathSync.native(root);
  if (canonical !== root || (stat.mode & 0o077) !== 0) {
    fail('EVIDENCE_ROOT', 'Project qualification evidence root is not private');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('EVIDENCE_ROOT_OWNER', 'Project qualification evidence root has an unexpected owner');
  }
  return canonical;
}

function evidencePath(context: ProjectSandboxExecutionContext, rootInput: string): string {
  return path.join(ensurePrivateEvidenceRoot(rootInput), evidenceFileName(context));
}

function writeEvidenceAtomic(
  context: ProjectSandboxExecutionContext,
  rootInput: string,
  envelope: OpenClawProjectQualificationEnvelope,
): void {
  const destination = evidencePath(context, rootInput);
  if (fs.existsSync(destination)) {
    const existing = fs.lstatSync(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      fail('EVIDENCE_PATH', 'Project qualification evidence path is unsafe');
    }
  }
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    const serialized = `${stableSerialize(envelope)}\n`;
    if (Buffer.byteLength(serialized) > MAX_EVIDENCE_BYTES) {
      fail('EVIDENCE_SIZE', 'Project qualification evidence exceeded the size limit');
    }
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, destination);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readEvidence(
  context: ProjectSandboxExecutionContext,
  rootInput: string,
): OpenClawProjectQualificationEnvelope | null {
  const destination = evidencePath(context, rootInput);
  if (!fs.existsSync(destination)) return null;
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    fail('EVIDENCE_PATH', 'Project qualification evidence is not a private regular file');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('EVIDENCE_OWNER', 'Project qualification evidence has an unexpected owner');
  }
  if (stat.size < 2 || stat.size > MAX_EVIDENCE_BYTES) {
    fail('EVIDENCE_SIZE', 'Project qualification evidence size is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(destination, 'utf8'));
  } catch {
    fail('EVIDENCE_PARSE', 'Project qualification evidence is malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('EVIDENCE_SHAPE', 'Project qualification evidence has an invalid shape');
  }
  const envelope = parsed as OpenClawProjectQualificationEnvelope;
  if (!envelope.payload || typeof envelope.mac !== 'string') {
    fail('EVIDENCE_SHAPE', 'Project qualification evidence is incomplete');
  }
  return envelope;
}

function expectedContextBindingBase(
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
  identity: { agentId: string; sessionKey: string },
): Pick<OpenClawProjectQualificationPayload,
  | 'actorIdentitySha256'
  | 'workspaceOwnerIdentitySha256'
  | 'projectIdentityId'
  | 'projectNameSha256'
  | 'canonicalRootSha256'
  | 'rootDevice'
  | 'rootInode'
  | 'rootBirthtimeNs'
  | 'runtimePolicyVersion'
  | 'egressPolicyVersion'
  | 'policyFingerprint'
  | 'runtimeImageDigest'
  | 'networkIsolation'
  | 'proxyImageDigest'
  | 'agentId'
  | 'sessionKeySha256'
  | 'egressPolicyFingerprint'> {
  const spec = buildProjectEgressPlaneSpec(egress);
  return {
    actorIdentitySha256: sha256(context.userId),
    workspaceOwnerIdentitySha256: sha256(context.workspaceOwnerId),
    projectIdentityId: context.projectId,
    projectNameSha256: sha256(context.projectName),
    canonicalRootSha256: sha256(context.canonicalRoot),
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
    runtimePolicyVersion: context.runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    policyFingerprint: context.policyFingerprint,
    runtimeImageDigest: context.runtimeImageDigest.toLowerCase(),
    networkIsolation: 'proxy-egress' as const,
    proxyImageDigest: egress.proxyImage.toLowerCase(),
    agentId: identity.agentId,
    sessionKeySha256: sha256(identity.sessionKey),
    egressPolicyFingerprint: spec.policyFingerprint,
  };
}

function openClawContextBinding(
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
): ReturnType<typeof expectedContextBindingBase> {
  return expectedContextBindingBase(context, egress, {
    agentId: deriveOpenClawProjectAgentId(context),
    sessionKey: deriveOpenClawProjectSessionKey(context),
  });
}

function codexQualificationIdentity(context: ProjectSandboxExecutionContext): {
  agentId: string;
  sessionKey: string;
} {
  const digest = sha256(stableSerialize({
    provider: 'CODEX',
    actorUserId: context.userId,
    projectIdentityId: context.projectId,
    policyFingerprint: context.policyFingerprint,
  }));
  return {
    agentId: `p4cx-${digest.slice(0, 40)}`,
    sessionKey: `portal-codex-project-qualification:${digest}`,
  };
}

function codexContextBinding(
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
): ReturnType<typeof expectedContextBindingBase> {
  return expectedContextBindingBase(context, egress, codexQualificationIdentity(context));
}

function nativeCliQualificationIdentity(
  provider: Extract<NativeProjectProvider, 'CLAUDE_CODE' | 'GEMINI'>,
  context: ProjectSandboxExecutionContext,
): { agentId: string; sessionKey: string } {
  const digest = sha256(stableSerialize({
    provider,
    actorUserId: context.userId,
    projectIdentityId: context.projectId,
    policyFingerprint: context.policyFingerprint,
  }));
  const prefix = provider === 'CLAUDE_CODE' ? 'p4cc' : 'p4ag';
  return {
    agentId: `${prefix}-${digest.slice(0, 40)}`,
    sessionKey: `portal-${provider.toLowerCase()}-project-qualification:${digest}`,
  };
}

function nativeCliContextBinding(
  provider: Extract<NativeProjectProvider, 'CLAUDE_CODE' | 'GEMINI'>,
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
): ReturnType<typeof expectedContextBindingBase> {
  return expectedContextBindingBase(context, egress, nativeCliQualificationIdentity(provider, context));
}

function agentZeroQualificationIdentity(
  context: ProjectSandboxExecutionContext,
  selectionInput: AgentZeroProjectModelSelection | undefined,
): { agentId: string; sessionKey: string } {
  if (!selectionInput) {
    fail('MODEL_SELECTION', 'Agent Zero Project qualification requires an exact OAuth provider/model selection');
  }
  const selection = (() => {
    try {
      return {
        providerId: String(selectionInput.providerId || ''),
        model: String(selectionInput.model || ''),
      };
    } catch {
      return fail('MODEL_SELECTION', 'Agent Zero Project qualification model selection is invalid');
    }
  })();
  const digest = sha256(stableSerialize({
    provider: 'AGENT_ZERO',
    actorUserId: context.userId,
    projectIdentityId: context.projectId,
    policyFingerprint: context.policyFingerprint,
    oauthProviderId: selection.providerId,
    model: selection.model,
  }));
  return {
    agentId: `p4a0-${digest.slice(0, 40)}`,
    sessionKey: `portal-agent-zero-project-qualification:${digest}`,
  };
}

function agentZeroContextBinding(
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
  selection: AgentZeroProjectModelSelection | undefined,
): ReturnType<typeof expectedContextBindingBase> {
  return expectedContextBindingBase(context, egress, agentZeroQualificationIdentity(context, selection));
}

function ollamaQualificationIdentity(
  context: ProjectSandboxExecutionContext,
  selectionInput: OllamaProjectModelSelection | undefined,
): { agentId: string; sessionKey: string } {
  if (!selectionInput) {
    fail('MODEL_SELECTION', 'Ollama Project qualification requires an exact installed model selection');
  }
  let binding: string;
  try {
    binding = ollamaProjectModelBindingValue(selectionInput);
  } catch {
    return fail('MODEL_SELECTION', 'Ollama Project qualification model selection is invalid');
  }
  const digest = sha256(stableSerialize({
    provider: 'OLLAMA',
    actorUserId: context.userId,
    projectIdentityId: context.projectId,
    policyFingerprint: context.policyFingerprint,
    modelBinding: binding,
  }));
  return {
    agentId: `p4ol-${digest.slice(0, 40)}`,
    sessionKey: `portal-ollama-project-qualification:${digest}`,
  };
}

function ollamaContextBinding(
  context: ProjectSandboxExecutionContext,
  _egress: ProjectEgressPlaneConfig,
  selectionInput?: AgentZeroProjectModelSelection | OllamaProjectModelSelection,
): ReturnType<typeof expectedContextBindingBase> {
  const selection = selectionInput as OllamaProjectModelSelection | undefined;
  const identity = ollamaQualificationIdentity(context, selection);
  return {
    actorIdentitySha256: sha256(context.userId),
    workspaceOwnerIdentitySha256: sha256(context.workspaceOwnerId),
    projectIdentityId: context.projectId,
    projectNameSha256: sha256(context.projectName),
    canonicalRootSha256: sha256(context.canonicalRoot),
    rootDevice: context.rootDevice,
    rootInode: context.rootInode,
    rootBirthtimeNs: context.rootBirthtimeNs,
    runtimePolicyVersion: context.runtimePolicyVersion,
    egressPolicyVersion: context.egressPolicyVersion,
    policyFingerprint: context.policyFingerprint,
    runtimeImageDigest: context.runtimeImageDigest.toLowerCase(),
    networkIsolation: 'network-none',
    proxyImageDigest: null,
    agentId: identity.agentId,
    sessionKeySha256: sha256(identity.sessionKey),
    egressPolicyFingerprint: sha256(stableSerialize({
      provider: 'OLLAMA',
      network: 'none',
      bridgePolicy: OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
      actorUserId: context.userId,
      projectIdentityId: context.projectId,
      policyFingerprint: context.policyFingerprint,
    })),
  };
}

const PROJECT_QUALIFICATION_LANES: Readonly<Record<QualifiableProjectProvider, ProjectQualificationLaneAdapter>> = Object.freeze({
  OPENCLAW: Object.freeze({
    provider: 'OPENCLAW' as const,
    displayName: 'OpenClaw',
    qualificationVersion: OPENCLAW_PROJECT_QUALIFICATION_VERSION,
    buildContextBinding: openClawContextBinding,
    attestRuntime: attestOpenClawQualificationRuntime,
    modelProbe: async ({ runtime, context, sender, nonce, openClawModel, dependencies }) => dependencies.modelProbe({
      sessionKey: runtime.sandbox.sessionKey,
      context,
      sender,
      nonce,
      model: openClawModel,
      runtimeContainerId: runtime.runtimeContainerId,
      runtimeContainerStartedAt: runtime.runtimeContainerStartedAt
        || fail('RUNTIME_ATTESTATION', 'OpenClaw Project runtime start identity was unavailable'),
      executor: dependencies.executor,
    }),
  }),
  CODEX: Object.freeze({
    provider: 'CODEX' as const,
    displayName: 'Codex',
    qualificationVersion: CODEX_PROJECT_QUALIFICATION_VERSION,
    buildContextBinding: codexContextBinding,
    attestRuntime: attestCodexQualificationRuntime,
    modelProbe: async ({ runtime, sender, nonce, dependencies }) => {
      const handle = runtime.opaqueRuntime as CodexProjectEgressRuntimeHandle | undefined;
      if (!handle) fail('RUNTIME_ATTESTATION', 'Codex Project runtime handle is unavailable');
      return dependencies.codexModelProbe({
        runtime: handle,
        sender,
        nonce,
        executor: dependencies.executor,
      });
    },
  }),
  CLAUDE_CODE: Object.freeze({
    provider: 'CLAUDE_CODE' as const,
    displayName: 'Claude Code',
    qualificationVersion: CLAUDE_CODE_PROJECT_QUALIFICATION_VERSION,
    buildContextBinding: (context, egress) => nativeCliContextBinding('CLAUDE_CODE', context, egress),
    attestRuntime: (input) => attestNativeCliQualificationRuntime({
      ...input,
      provider: 'CLAUDE_CODE',
      profile: CLAUDE_CODE_PROJECT_RUNTIME_PROFILE,
    }),
    modelProbe: async ({ runtime, context, sender, nonce, dependencies }) => {
      const handle = runtime.opaqueRuntime as NativeCliProjectEgressRuntimeHandle | undefined;
      if (!handle) fail('RUNTIME_ATTESTATION', 'Claude Code Project runtime handle is unavailable');
      return dependencies.nativeCliModelProbe({
        provider: 'CLAUDE_CODE',
        context,
        runtime: handle,
        sender,
        nonce,
      });
    },
  }),
  AGENT_ZERO: Object.freeze({
    provider: 'AGENT_ZERO' as const,
    displayName: 'Agent Zero',
    qualificationVersion: AGENT_ZERO_PROJECT_QUALIFICATION_VERSION,
    buildContextBinding: agentZeroContextBinding,
    attestRuntime: attestAgentZeroQualificationRuntime,
    modelProbe: async ({ runtime, context, sender, nonce, dependencies }) => {
      const opaque = runtime.opaqueRuntime as {
        status?: AgentZeroProjectRuntimeStatus;
        modelSelection?: AgentZeroProjectModelSelection;
      } | undefined;
      if (!opaque?.status?.selectable || !opaque.modelSelection) {
        fail('RUNTIME_ATTESTATION', 'Agent Zero Project runtime handle is unavailable');
      }
      return dependencies.agentZeroModelProbe({
        context,
        sender,
        nonce,
        modelSelection: opaque.modelSelection,
      });
    },
  }),
  GEMINI: Object.freeze({
    provider: 'GEMINI' as const,
    displayName: 'Google Antigravity',
    qualificationVersion: ANTIGRAVITY_PROJECT_QUALIFICATION_VERSION,
    buildContextBinding: (context, egress) => nativeCliContextBinding('GEMINI', context, egress),
    attestRuntime: (input) => attestNativeCliQualificationRuntime({
      ...input,
      provider: 'GEMINI',
      profile: ANTIGRAVITY_PROJECT_RUNTIME_PROFILE,
    }),
    modelProbe: async ({ runtime, context, sender, nonce, dependencies }) => {
      const handle = runtime.opaqueRuntime as NativeCliProjectEgressRuntimeHandle | undefined;
      if (!handle) fail('RUNTIME_ATTESTATION', 'Antigravity Project runtime handle is unavailable');
      return dependencies.nativeCliModelProbe({
        provider: 'GEMINI',
        context,
        runtime: handle,
        sender,
        nonce,
      });
    },
  }),
  OLLAMA: Object.freeze({
    provider: 'OLLAMA' as const,
    displayName: 'Ollama',
    qualificationVersion: OLLAMA_PROJECT_QUALIFICATION_VERSION,
    buildContextBinding: ollamaContextBinding,
    attestRuntime: attestOllamaQualificationRuntime,
    modelProbe: async ({ runtime }) => {
      const evidence = runtime.opaqueRuntime as OllamaProjectQualificationEvidence | undefined;
      if (!evidence?.modelToolProbe || !evidence.modelCapabilities.includes('tools')) {
        fail('MODEL_PROBE_RUNTIME', 'Ollama Project model qualification evidence is unavailable');
      }
      return {
        modelId: evidence.model,
        modelDigest: evidence.modelDigest,
        ollamaBackendKind: evidence.backendKind,
        ollamaBackendFingerprint: evidence.backendFingerprint,
        ollamaBackendGeneration: evidence.backendGeneration,
        responseSha256: sha256(stableSerialize({
          model: evidence.model,
          digest: evidence.modelDigest,
          backendKind: evidence.backendKind,
          backendFingerprint: evidence.backendFingerprint,
          backendGeneration: evidence.backendGeneration,
          capabilities: evidence.modelCapabilities,
          toolProbe: evidence.modelToolProbe,
        })),
      };
    },
  }),
});

export function getProjectQualificationLane(
  providerInput: QualifiableProjectProvider,
): ProjectQualificationLaneAdapter {
  const provider = String(providerInput || '').trim().toUpperCase() as QualifiableProjectProvider;
  if (!Object.prototype.hasOwnProperty.call(PROJECT_QUALIFICATION_LANES, provider)) {
    fail('PROVIDER_UNSUPPORTED', 'Project qualification provider is unsupported');
  }
  const lane = PROJECT_QUALIFICATION_LANES[provider];
  if (!lane) fail('PROVIDER_UNSUPPORTED', 'Project qualification provider is unsupported');
  return lane;
}

export function listProjectQualificationLanes(): Array<{
  provider: QualifiableProjectProvider;
  displayName: string;
  qualificationVersion: string;
}> {
  return QUALIFIABLE_PROJECT_PROVIDERS.map((provider) => {
    const lane = getProjectQualificationLane(provider);
    return {
      provider: lane.provider,
      displayName: lane.displayName,
      qualificationVersion: lane.qualificationVersion,
    };
  });
}

function expectedContextBinding(
  provider: QualifiableProjectProvider,
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
  modelSelection?: AgentZeroProjectModelSelection | OllamaProjectModelSelection,
): ReturnType<typeof expectedContextBindingBase> {
  return getProjectQualificationLane(provider).buildContextBinding(
    context,
    egress,
    modelSelection,
  );
}

function evidencedOllamaBackendIdentity(
  payload: Pick<
    ProjectQualificationPayload,
    'ollamaBackendKind' | 'ollamaBackendFingerprint' | 'ollamaBackendGeneration'
  >,
): Pick<
  OllamaProjectModelSelection,
  'backendKind' | 'backendFingerprint' | 'backendGeneration'
> | null {
  if (
    payload.ollamaBackendKind === undefined
    && payload.ollamaBackendFingerprint === undefined
    && payload.ollamaBackendGeneration === undefined
  ) {
    return Object.freeze({
      backendKind: 'LOCAL' as const,
      backendFingerprint: 'local-ollama-v1:127.0.0.1:11434',
      backendGeneration: null,
    });
  }
  if (
    payload.ollamaBackendKind === 'LOCAL'
    && payload.ollamaBackendFingerprint === 'local-ollama-v1:127.0.0.1:11434'
    && payload.ollamaBackendGeneration === null
  ) {
    return Object.freeze({
      backendKind: 'LOCAL' as const,
      backendFingerprint: payload.ollamaBackendFingerprint,
      backendGeneration: null,
    });
  }
  if (
    payload.ollamaBackendKind === 'TAILNET'
    && typeof payload.ollamaBackendFingerprint === 'string'
    && /^[^\u0000-\u001f\u007f]{1,256}$/.test(payload.ollamaBackendFingerprint)
    && Number.isSafeInteger(payload.ollamaBackendGeneration)
    && Number(payload.ollamaBackendGeneration) > 0
  ) {
    return Object.freeze({
      backendKind: 'TAILNET' as const,
      backendFingerprint: payload.ollamaBackendFingerprint,
      backendGeneration: payload.ollamaBackendGeneration as number,
    });
  }
  return null;
}

function validatePayload(
  provider: QualifiableProjectProvider,
  context: ProjectSandboxExecutionContext,
  egress: ProjectEgressPlaneConfig,
  envelope: OpenClawProjectQualificationEnvelope,
  secret: string,
  now: Date,
  agentZeroModelSelection?: AgentZeroProjectModelSelection,
  ollamaModelSelection?: OllamaProjectModelSelection,
): { payload: OpenClawProjectQualificationPayload; evidenceFingerprint: string } {
  const { payload } = envelope;
  if (
    payload.schema !== 1
    || payload.qualificationVersion !== projectQualificationVersionFor(provider)
    || payload.provider !== provider
  ) {
    fail('EVIDENCE_VERSION', 'Project qualification evidence version is unsupported');
  }
  if (!timingSafeEqualText(envelope.mac, evidenceMac(payload, secret))) {
    fail('EVIDENCE_MAC', 'Project qualification evidence authentication failed');
  }
  // Classify an authenticated, structurally current envelope as expired before
  // comparing it with today's sandbox/runtime policy. Portal updates can
  // legitimately change that policy after the evidence has already expired;
  // reporting the old envelope as corrupt leaves the user with a scary dead
  // end instead of the correct recovery action: prepare the provider again.
  // The MAC and qualification version are verified first, so an attacker
  // cannot forge timestamps to downgrade an invalid envelope into EXPIRED.
  const qualifiedAt = Date.parse(payload.qualifiedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(qualifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= qualifiedAt) {
    fail('EVIDENCE_TIME', 'Project qualification evidence timestamps are invalid');
  }
  if (qualifiedAt > now.getTime() + 60_000) {
    fail('EVIDENCE_FUTURE', 'Project qualification evidence was issued in the future');
  }
  if (expiresAt <= now.getTime()) {
    fail('EVIDENCE_EXPIRED', 'Project qualification evidence has expired');
  }
  // Ollama evidence carries the exact model tag and immutable digest proved by
  // the authenticated loopback bridge. Read-only capability/status checks do
  // not query Ollama, so reconstruct that selection only after the evidence
  // MAC has been authenticated. Mutating session admission independently
  // resolves the live catalog again and supplies an explicit selection below,
  // which catches a removed model or an in-place tag/digest replacement.
  const evidencedOllamaBackend = evidencedOllamaBackendIdentity(payload);
  const evidencedOllamaModelSelection: OllamaProjectModelSelection | undefined = provider === 'OLLAMA'
    && typeof payload.modelId === 'string'
    && typeof payload.modelDigest === 'string'
    && evidencedOllamaBackend
    ? Object.freeze({
        model: payload.modelId,
        digest: payload.modelDigest as `sha256:${string}`,
        capabilities: Object.freeze(['tools']),
        ...evidencedOllamaBackend,
      })
    : undefined;
  const evidencedAgentZeroModelSelection: AgentZeroProjectModelSelection | undefined = provider === 'AGENT_ZERO'
    && typeof payload.modelProviderId === 'string'
    && typeof payload.modelId === 'string'
    ? (() => {
        try {
          return normalizeAgentZeroProjectModelSelection({
            providerId: payload.modelProviderId as AgentZeroProjectOAuthProviderId,
            model: payload.modelId,
          });
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const effectiveAgentZeroModelSelection = agentZeroModelSelection
    || evidencedAgentZeroModelSelection;
  const effectiveOllamaModelSelection = ollamaModelSelection || evidencedOllamaModelSelection;
  if (provider === 'AGENT_ZERO') {
    if (!effectiveAgentZeroModelSelection) {
      fail('MODEL_SELECTION', 'Agent Zero qualification evidence requires an exact OAuth provider/model selection');
    }
    try {
      agentZeroProjectModelBindingValue(effectiveAgentZeroModelSelection);
    } catch {
      fail('MODEL_SELECTION', 'Agent Zero qualification model selection is invalid');
    }
    if (payload.modelProviderId !== effectiveAgentZeroModelSelection.providerId
      || payload.modelId !== effectiveAgentZeroModelSelection.model) {
      fail('EVIDENCE_MODEL_DRIFT', 'Agent Zero qualification evidence no longer matches the selected OAuth model');
    }
  }
  if (provider === 'OLLAMA') {
    if (!effectiveOllamaModelSelection) {
      fail('MODEL_SELECTION', 'Ollama qualification evidence requires an exact installed model selection');
    }
    let binding: string;
    try {
      binding = ollamaProjectModelBindingValue(effectiveOllamaModelSelection);
    } catch {
      return fail('MODEL_SELECTION', 'Ollama qualification model selection is invalid');
    }
    if (payload.modelId !== effectiveOllamaModelSelection.model
      || payload.modelDigest !== effectiveOllamaModelSelection.digest
      || evidencedOllamaBackend?.backendKind !== effectiveOllamaModelSelection.backendKind
      || evidencedOllamaBackend?.backendFingerprint !== effectiveOllamaModelSelection.backendFingerprint
      || evidencedOllamaBackend?.backendGeneration !== effectiveOllamaModelSelection.backendGeneration
      || binding !== ollamaProjectModelBindingValue(effectiveOllamaModelSelection)) {
      fail('EVIDENCE_MODEL_DRIFT', 'Ollama qualification evidence no longer matches the installed model digest');
    }
  }
  if (provider === 'OPENCLAW') {
    if (typeof payload.modelId !== 'string'
      || !isOpenClawProjectEmbeddedModel(payload.modelId)
      || typeof payload.executionProviderId !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(payload.executionProviderId)
      || payload.executionRuntimeKind !== OPENCLAW_PROJECT_EXECUTION_RUNTIME
      || typeof payload.modelToolChallengeSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(payload.modelToolChallengeSha256)) {
      fail('MODEL_RUNTIME_UNSAFE', 'OpenClaw qualification evidence lacks an exact embedded model/runtime proof');
    }
    try {
      const execution = readVerifiedOpenClawProjectExecutionBinding({
        modelProvider: payload.executionProviderId,
        model: payload.modelId,
        agentHarnessId: null,
      });
      if (execution.model !== payload.modelId
        || execution.executionProviderId !== payload.executionProviderId
        || execution.executionRuntimeKind !== payload.executionRuntimeKind) {
        fail('MODEL_RUNTIME_UNSAFE', 'OpenClaw qualification model/runtime evidence is internally inconsistent');
      }
    } catch {
      fail('MODEL_RUNTIME_UNSAFE', 'OpenClaw qualification evidence names an external or unknown runtime');
    }
  }
  const expected = expectedContextBinding(
    provider,
    context,
    egress,
    provider === 'OLLAMA' ? effectiveOllamaModelSelection : effectiveAgentZeroModelSelection,
  );
  for (const [key, value] of Object.entries(expected)) {
    if (payload[key as keyof OpenClawProjectQualificationPayload] !== value) {
      fail('EVIDENCE_CONTEXT_DRIFT', 'Project qualification evidence no longer matches the current sandbox policy');
    }
  }
  const requiredProbes = requiredProbesFor(provider);
  if (!Array.isArray(payload.probes) || payload.probes.length !== requiredProbes.length) {
    fail('EVIDENCE_PROBES', 'Project qualification evidence does not contain the complete probe matrix');
  }
  const probeMap = new Map(payload.probes.map((probe) => [probe.id, probe]));
  if (probeMap.size !== requiredProbes.length || requiredProbes.some((id) => {
    const probe = probeMap.get(id);
    return !probe || probe.passed !== true || !/^[a-f0-9]{64}$/.test(probe.evidenceSha256);
  })) {
    fail('EVIDENCE_PROBES', 'Project qualification evidence contains an invalid probe result');
  }
  if (provider === 'OLLAMA') {
    if (payload.networkIsolation !== 'network-none'
      || payload.runtimeContainerStartedAt !== null
      || payload.proxyImageDigest !== null
      || payload.proxyContainerName !== null
      || payload.proxyContainerId !== null
      || payload.internalNetworkName !== null
      || payload.internalNetworkId !== null
      || payload.publicNetworkName !== null
      || payload.publicNetworkId !== null) {
      fail('EVIDENCE_NETWORK', 'Ollama Project qualification must remain structurally networkless');
    }
  } else if (payload.networkIsolation !== 'proxy-egress') {
    fail('EVIDENCE_NETWORK', 'Project qualification egress mode is invalid');
  } else if (typeof payload.runtimeContainerStartedAt !== 'string'
    || !Number.isFinite(Date.parse(payload.runtimeContainerStartedAt))) {
    fail('EVIDENCE_RUNTIME_ID', 'Project qualification runtime start identity is invalid');
  }
  const runtimeIds = provider === 'OLLAMA'
    ? [payload.runtimeContainerId]
    : [payload.runtimeContainerId, payload.proxyContainerId, payload.internalNetworkId, payload.publicNetworkId];
  for (const value of runtimeIds) {
    if (typeof value !== 'string') {
      fail('EVIDENCE_RUNTIME_ID', 'Project qualification runtime identity is missing');
    }
    if (!/^[a-f0-9]{64}$/.test(value)) {
      fail('EVIDENCE_RUNTIME_ID', 'Project qualification runtime identity is invalid');
    }
  }
  for (const value of [
    payload.configHash,
    payload.runtimeFingerprint,
    payload.egressPolicyFingerprint,
    payload.modelResponseSha256,
    ...(provider === 'OPENCLAW' ? [payload.modelToolChallengeSha256] : []),
  ]) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
      fail('EVIDENCE_FINGERPRINT', 'Project qualification evidence fingerprint is invalid');
    }
  }
  return { payload, evidenceFingerprint: sha256(stableSerialize(payload)) };
}

function providerDisplayName(provider: QualifiableProjectProvider): string {
  return projectChatProviderDisplayName(provider);
}

function qualifiedReason(provider: QualifiableProjectProvider, expiresAt: string): string {
  return `Live ${providerDisplayName(provider)} Project qualification is valid until ${expiresAt}.`;
}

function statusForError(
  provider: QualifiableProjectProvider,
  error: unknown,
): OpenClawProjectQualificationStatus {
  const expired = error instanceof OpenClawProjectQualificationError && error.code === 'EVIDENCE_EXPIRED';
  const displayName = providerDisplayName(provider);
  return {
    provider,
    status: expired ? 'EXPIRED' : 'INVALID',
    selectable: false,
    reason: expired
      ? `${displayName} qualification expired. Run the project qualification again.`
      : `${displayName} qualification evidence is invalid or no longer matches this project.`,
    qualifiedAt: null,
    expiresAt: null,
    evidenceFingerprint: null,
  };
}

function qualificationDefaults(
  provider: QualifiableProjectProvider,
  overrides: Partial<QualificationDependencies> = {},
): QualificationDependencies {
  const configuredTtl = Number(process.env.PROJECT_QUALIFICATION_TTL_MS)
    || (provider === 'CODEX'
      ? CODEX_PROJECT_QUALIFICATION_DEFAULT_TTL_MS
      : OPENCLAW_PROJECT_QUALIFICATION_DEFAULT_TTL_MS);
  return {
    now: () => new Date(),
    evidenceRoot: defaultEvidenceRoot(provider),
    secret: config.projectEgressTokenSecret,
    ttlMs: configuredTtl,
    executor: projectEgressCommandExecutor,
    attestEgressPlane: attestCurrentProjectEgressPlaneByImmutableIdentity,
    attestOpenClawIdentityRuntime: attestOnlyOpenClawProjectIdentityRuntime,
    attestCodexIdentityRuntime: attestOnlyCodexProjectIdentityRuntime,
    attestNativeCliIdentityRuntime: attestOnlyNativeCliProjectIdentityRuntime,
    attestAgentZeroIdentityRuntime: attestOnlyAgentZeroProjectIdentityRuntime,
    ensureSandbox: (input) => ensureOpenClawProjectSandbox(input),
    modelProbe: runDefaultModelProbe,
    ensureCodexRuntime: (input) => ensureCodexProjectQualifiedRuntime(input),
    codexModelProbe: runDefaultCodexModelProbe,
    ensureNativeCliRuntime: runDefaultEnsureNativeCliRuntime,
    nativeCliModelProbe: runDefaultNativeCliModelProbe,
    resolveAgentZeroModelSelection: (value) => resolveAllowedAgentZeroProjectModel(value),
    convergeAgentZeroRuntime: (input) => convergeAgentZeroProjectSandboxRuntime(input.context, {
      egress: input.egress,
      modelSelection: input.modelSelection,
    }),
    qualifyAgentZeroRuntime: (input) => qualifyAgentZeroProjectSandboxRuntime(input.context, {
      egress: input.egress,
      modelSelection: input.modelSelection,
    }),
    agentZeroModelProbe: runDefaultAgentZeroModelProbe,
    resolveOllamaModelSelection: async (value) => {
      const requested = value as OllamaProjectModelSelection | undefined;
      const selected = await resolveAllowedOllamaProjectModel([], requested?.model || null);
      if (requested && (
        selected.digest !== requested.digest
        || selected.backendKind !== requested.backendKind
        || selected.backendFingerprint !== requested.backendFingerprint
        || selected.backendGeneration !== requested.backendGeneration
        || !requested.capabilities.includes('tools')
      )) {
        fail('MODEL_SELECTION', 'The installed Ollama model digest changed since selection');
      }
      return selected;
    },
    qualifyOllamaRuntime: ({ context, modelSelection }) => qualifyOllamaProjectFoundation({
      context,
      modelSelection,
    }),
    runProbes: runLiveQualificationProbes,
    attestFinalEvidenceRuntime,
    ...overrides,
  };
}

function issueGrant(
  provider: QualifiableProjectProvider,
  context: ProjectSandboxExecutionContext,
  evidenceFingerprint: string,
  expiresAt: string,
  agentZeroModelSelection?: AgentZeroProjectModelSelection,
  ollamaModelSelection?: OllamaProjectModelSelection,
  evidencedPayload?: Pick<OpenClawProjectQualificationPayload,
    'modelId' | 'executionProviderId' | 'executionRuntimeKind'>,
): OpenClawProjectQualificationGrant {
  const grant = Object.freeze({
    provider,
    actorUserId: context.userId,
    projectIdentityId: context.projectId,
    policyFingerprint: context.policyFingerprint,
    evidenceFingerprint,
    modelProviderId: agentZeroModelSelection?.providerId || null,
    modelId: agentZeroModelSelection?.model || ollamaModelSelection?.model || evidencedPayload?.modelId || null,
    modelDigest: ollamaModelSelection?.digest || null,
    ollamaBackendKind: ollamaModelSelection?.backendKind || null,
    ollamaBackendFingerprint: ollamaModelSelection?.backendFingerprint || null,
    ollamaBackendGeneration: ollamaModelSelection?.backendGeneration ?? null,
    executionProviderId: evidencedPayload?.executionProviderId || null,
    executionRuntimeKind: evidencedPayload?.executionRuntimeKind || null,
    reason: qualifiedReason(provider, expiresAt),
  });
  qualificationGrants.add(grant);
  return grant;
}

export function assertProjectQualificationGrant(
  provider: QualifiableProjectProvider,
  value: OpenClawProjectQualificationGrant | null | undefined,
  context: ProjectSandboxExecutionContext,
  modelSelection?: AgentZeroProjectModelSelection | OllamaProjectModelSelection,
): OpenClawProjectQualificationGrant {
  if (
    !value
    || !qualificationGrants.has(value)
    || value.provider !== provider
    || value.actorUserId !== context.userId
    || value.projectIdentityId !== context.projectId
    || value.policyFingerprint !== context.policyFingerprint
    || (provider === 'AGENT_ZERO' && (
      !modelSelection
      || !('providerId' in modelSelection)
      || value.modelProviderId !== modelSelection.providerId
      || value.modelId !== modelSelection.model
    ))
    || (provider === 'OLLAMA' && (
      !modelSelection
      || !('digest' in modelSelection)
      || value.modelId !== modelSelection.model
      || value.modelDigest !== modelSelection.digest
      || value.ollamaBackendKind !== modelSelection.backendKind
      || value.ollamaBackendFingerprint !== modelSelection.backendFingerprint
      || value.ollamaBackendGeneration !== modelSelection.backendGeneration
    ))
  ) {
    fail('QUALIFICATION_GRANT', `A current server-verified ${providerDisplayName(provider)} Project qualification grant is required`);
  }
  return value;
}

export function assertOpenClawProjectQualificationGrant(
  value: OpenClawProjectQualificationGrant | null | undefined,
  context: ProjectSandboxExecutionContext,
): OpenClawProjectQualificationGrant {
  return assertProjectQualificationGrant('OPENCLAW', value, context);
}

export function assertCodexProjectQualificationGrant(
  value: OpenClawProjectQualificationGrant | null | undefined,
  context: ProjectSandboxExecutionContext,
): OpenClawProjectQualificationGrant {
  return assertProjectQualificationGrant('CODEX', value, context);
}

export function getProjectQualificationStatus(
  provider: QualifiableProjectProvider,
  input: {
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
    agentZeroModelSelection?: AgentZeroProjectModelSelection;
    ollamaModelSelection?: OllamaProjectModelSelection;
  },
  overrides: Partial<QualificationDependencies> = {},
): OpenClawProjectQualificationStatus {
  const dependencies = qualificationDefaults(provider, overrides);
  let envelope: OpenClawProjectQualificationEnvelope | null;
  try {
    envelope = readEvidence(input.context, dependencies.evidenceRoot);
  } catch (error) {
    return statusForError(provider, error);
  }
  if (!envelope) {
    return {
      provider,
      status: 'UNQUALIFIED',
      selectable: false,
      reason: `${providerDisplayName(provider)} has not completed live qualification for this user and immutable project.`,
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
  }
  try {
    const validated = validatePayload(
      provider,
      input.context,
      input.egress,
      envelope,
      dependencies.secret,
      dependencies.now(),
      input.agentZeroModelSelection,
      input.ollamaModelSelection,
    );
    return {
      provider,
      status: 'QUALIFIED',
      selectable: true,
      reason: qualifiedReason(provider, validated.payload.expiresAt),
      qualifiedAt: validated.payload.qualifiedAt,
      expiresAt: validated.payload.expiresAt,
      evidenceFingerprint: validated.evidenceFingerprint,
    };
  } catch (error) {
    return statusForError(provider, error);
  }
}

export function getOpenClawProjectQualificationStatus(
  input: { context: ProjectSandboxExecutionContext; egress: ProjectEgressPlaneConfig },
  overrides: Partial<QualificationDependencies> = {},
): OpenClawProjectQualificationStatus {
  return getProjectQualificationStatus('OPENCLAW', input, overrides);
}

export function getCodexProjectQualificationStatus(
  input: { context: ProjectSandboxExecutionContext; egress: ProjectEgressPlaneConfig },
  overrides: Partial<QualificationDependencies> = {},
): OpenClawProjectQualificationStatus {
  return getProjectQualificationStatus('CODEX', input, overrides);
}

export function requireProjectQualification(
  provider: QualifiableProjectProvider,
  input: {
    context: ProjectSandboxExecutionContext;
    egress: ProjectEgressPlaneConfig;
    agentZeroModelSelection?: AgentZeroProjectModelSelection;
    ollamaModelSelection?: OllamaProjectModelSelection;
  },
  overrides: Partial<QualificationDependencies> = {},
): OpenClawProjectQualificationGrant {
  const dependencies = qualificationDefaults(provider, overrides);
  const envelope = readEvidence(input.context, dependencies.evidenceRoot);
  if (!envelope) {
    fail('EVIDENCE_MISSING', `${providerDisplayName(provider)} has not completed live qualification for this project`);
  }
  const validated = validatePayload(
    provider,
    input.context,
    input.egress,
    envelope,
    dependencies.secret,
    dependencies.now(),
    input.agentZeroModelSelection,
    input.ollamaModelSelection,
  );
  const evidencedOllamaBackend = evidencedOllamaBackendIdentity(validated.payload);
  const evidencedOllamaModelSelection: OllamaProjectModelSelection | undefined = provider === 'OLLAMA'
    && typeof validated.payload.modelId === 'string'
    && typeof validated.payload.modelDigest === 'string'
    && evidencedOllamaBackend
    ? Object.freeze({
        model: validated.payload.modelId,
        digest: validated.payload.modelDigest as `sha256:${string}`,
        capabilities: Object.freeze(['tools']),
        ...evidencedOllamaBackend,
      })
    : undefined;
  const evidencedAgentZeroModelSelection: AgentZeroProjectModelSelection | undefined = provider === 'AGENT_ZERO'
    && typeof validated.payload.modelProviderId === 'string'
    && typeof validated.payload.modelId === 'string'
    ? normalizeAgentZeroProjectModelSelection({
        providerId: validated.payload.modelProviderId as AgentZeroProjectOAuthProviderId,
        model: validated.payload.modelId,
      })
    : undefined;
  const grant = issueGrant(
    provider,
    input.context,
    validated.evidenceFingerprint,
    validated.payload.expiresAt,
    input.agentZeroModelSelection || evidencedAgentZeroModelSelection,
    input.ollamaModelSelection || evidencedOllamaModelSelection,
    validated.payload,
  );
  if (provider === 'OPENCLAW') {
    registerOpenClawProjectModelRuntimeEligibility({
      sessionKey: deriveOpenClawProjectSessionKey(input.context),
      projectIdentityId: input.context.projectId,
      model: String(validated.payload.modelId || ''),
      executionProviderId: String(validated.payload.executionProviderId || ''),
      executionRuntimeKind: validated.payload.executionRuntimeKind as typeof OPENCLAW_PROJECT_EXECUTION_RUNTIME,
      evidenceFingerprint: validated.evidenceFingerprint,
      revoke: () => removeProjectQualificationEvidence('OPENCLAW', input.context, {
        evidenceRoot: dependencies.evidenceRoot,
      }),
    });
  }
  return grant;
}


export function requireOpenClawProjectQualification(
  input: { context: ProjectSandboxExecutionContext; egress: ProjectEgressPlaneConfig },
  overrides: Partial<QualificationDependencies> = {},
): OpenClawProjectQualificationGrant {
  return requireProjectQualification('OPENCLAW', input, overrides);
}

export function requireCodexProjectQualification(
  input: { context: ProjectSandboxExecutionContext; egress: ProjectEgressPlaneConfig },
  overrides: Partial<QualificationDependencies> = {},
): OpenClawProjectQualificationGrant {
  return requireProjectQualification('CODEX', input, overrides);
}

function parseInspect<T>(output: string, label: string): T {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { fail('DOCKER_INSPECT', `${label} returned invalid JSON`); }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') {
    fail('DOCKER_INSPECT', `${label} returned an invalid shape`);
  }
  return parsed[0] as T;
}

function requireRuntimeStartedAt(value: unknown, label: string): string {
  const startedAt = String(value || '').trim();
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) {
    fail('RUNTIME_ATTESTATION', `${label} did not expose a valid immutable start identity`);
  }
  return startedAt;
}

function commandEvidence(command: string, args: readonly string[], exitCode: number, stdout: string, stderr: string): string {
  return sha256(stableSerialize({ command, args, exitCode, stdout: sha256(stdout), stderr: sha256(stderr) }));
}

function probeResult(
  id: OpenClawProjectQualificationProbeId,
  observedAt: Date,
  evidence: string,
): OpenClawProjectQualificationProbeResult {
  return { id, passed: true, observedAt: observedAt.toISOString(), evidenceSha256: sha256(evidence) };
}

async function dockerCommand(
  executor: ProjectEgressCommandExecutor,
  args: readonly string[],
  allowExitCodes: readonly number[] = [0],
) {
  return executor.run('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { allowExitCodes });
}

async function inspectExactRuntimeGeneration(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  expectedStartedAt: string;
  label: string;
}): Promise<any> {
  const containerId = String(input.containerId || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    fail('RUNTIME_ATTESTATION', `${input.label} immutable container identity was invalid`);
  }
  const expectedStartedAt = requireRuntimeStartedAt(
    input.expectedStartedAt,
    `${input.label} expected start identity`,
  );
  const result = await dockerCommand(
    input.executor,
    ['container', 'inspect', containerId],
  );
  const inspect = parseInspect<any>(result.stdout, `${input.label} immutable inspection`);
  if (String(inspect.Id || '').trim().toLowerCase() !== containerId
    || inspect.State?.Running !== true
    || requireRuntimeStartedAt(inspect.State?.StartedAt, input.label) !== expectedStartedAt) {
    fail('RUNTIME_IDENTITY_RACE', `${input.label} immutable process identity changed`);
  }
  return inspect;
}

async function runContainerCommand(input: {
  executor: ProjectEgressCommandExecutor;
  containerId: string;
  args: readonly string[];
  expectSuccess: boolean;
  id: OpenClawProjectQualificationProbeId;
  now: Date;
  displayName: string;
}): Promise<OpenClawProjectQualificationProbeResult> {
  const result = await dockerCommand(
    input.executor,
    ['container', 'exec', input.containerId, ...input.args],
    Array.from({ length: 256 }, (_entry, index) => index),
  );
  if ((result.exitCode === 0) !== input.expectSuccess) {
    // Bounded stderr/stdout excerpt: a bare probe id is insufficient for
    // deployment diagnosis, and these fixed commands do not emit secrets.
    const combined = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
    console.error(
      `[${input.displayName} Project Qualification] probe ${input.id} output (exit ${result.exitCode}):\n${combined.slice(-4000)}`,
    );
    const excerpt = combined.slice(-300);
    fail(
      'PROBE_FAILED',
      `${input.displayName} Project qualification probe ${input.id} failed (exit ${result.exitCode})${excerpt ? `: ${excerpt}` : ''}`,
    );
  }
  return probeResult(
    input.id,
    input.now,
    commandEvidence(
      'docker exec',
      [input.containerId, ...input.args],
      result.exitCode,
      result.stdout,
      result.stderr,
    ),
  );
}

interface OpenClawQualificationToolEvent {
  type: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolCallId?: string;
  status?: string;
  exitCode?: number;
}

function qualificationChallengeArtifact(
  context: ProjectSandboxExecutionContext,
  nonce: string,
): { fileName: string; destination: string } {
  if (!/^[A-Za-z0-9_-]{18,64}$/.test(nonce)) {
    fail('MODEL_PROBE_NONCE', 'OpenClaw qualification challenge nonce was invalid');
  }
  const canonicalRoot = fs.realpathSync.native(context.canonicalRoot);
  if (canonicalRoot !== context.canonicalRoot) {
    fail('MODEL_PROBE_ARTIFACT', 'OpenClaw qualification project root identity changed');
  }
  const fileName = `.portal-openclaw-qualification-${nonce}`;
  return { fileName, destination: path.join(canonicalRoot, fileName) };
}

function cleanupQualificationChallengeArtifact(destination: string): void {
  if (!fs.existsSync(destination)) return;
  const entry = fs.lstatSync(destination);
  if (entry.isDirectory() && !entry.isSymbolicLink()) fs.rmdirSync(destination);
  else fs.unlinkSync(destination);
  if (fs.existsSync(destination)) {
    fail('MODEL_PROBE_CLEANUP', 'OpenClaw qualification challenge artifact cleanup was not confirmed');
  }
}

function commandFromToolArgs(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return commandFromToolArgs(parsed);
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const input = value as Record<string, unknown>;
  return typeof input.command === 'string'
    ? input.command
    : typeof input.cmd === 'string'
      ? input.cmd
      : '';
}

function verifyOpenClawModelToolChallenge(input: {
  context: ProjectSandboxExecutionContext;
  nonce: string;
  expectedCommand: string;
  expectedMarker: string;
  events: readonly OpenClawQualificationToolEvent[];
}): string {
  const { destination } = qualificationChallengeArtifact(input.context, input.nonce);
  const starts = input.events.filter((event) => event.type === 'tool_start');
  const ends = input.events.filter((event) => event.type === 'tool_end');
  const toolEvents = input.events.filter((event) => event.type.startsWith('tool_'));
  if (starts.length !== 1 || ends.length !== 1
    || toolEvents.some((event) => String(event.toolName || '').trim().toLowerCase() !== 'exec')) {
    fail('MODEL_PROBE_TOOL', 'OpenClaw qualification required exactly one observable exec tool call');
  }
  const start = starts[0];
  const end = ends[0];
  if (commandFromToolArgs(start.toolArgs) !== input.expectedCommand) {
    fail('MODEL_PROBE_TOOL', 'OpenClaw qualification exec command did not match the server challenge');
  }
  if (start.toolCallId && end.toolCallId && start.toolCallId !== end.toolCallId) {
    fail('MODEL_PROBE_TOOL', 'OpenClaw qualification tool event identity changed');
  }
  if (String(end.status || '').toLowerCase() === 'error'
    || (typeof end.exitCode === 'number' && end.exitCode !== 0)
    || !String(end.toolResult || '').includes(input.expectedMarker)) {
    fail('MODEL_PROBE_TOOL', 'OpenClaw qualification exec tool did not complete successfully');
  }

  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      destination,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor);
    const expected = Buffer.from(input.nonce, 'utf8');
    if (!stat.isFile() || stat.uid !== 1000 || stat.gid !== 1000 || stat.size !== expected.length) {
      fail('MODEL_PROBE_ARTIFACT', 'OpenClaw qualification artifact owner, type, or size did not match');
    }
    const content = fs.readFileSync(descriptor);
    if (!content.equals(expected)) {
      fail('MODEL_PROBE_ARTIFACT', 'OpenClaw qualification artifact content did not match its nonce');
    }
    fs.closeSync(descriptor);
    descriptor = null;
    fs.unlinkSync(destination);
    if (fs.existsSync(destination)) {
      fail('MODEL_PROBE_CLEANUP', 'OpenClaw qualification artifact cleanup was not confirmed');
    }
    return sha256(stableSerialize({
      nonceSha256: sha256(input.nonce),
      commandSha256: sha256(input.expectedCommand),
      markerSha256: sha256(input.expectedMarker),
      toolCallId: start.toolCallId || null,
      toolResultSha256: sha256(String(end.toolResult || '')),
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      contentSha256: sha256(content),
      cleanupConfirmed: true,
    }));
  } catch (error) {
    if (error instanceof OpenClawProjectQualificationError) throw error;
    return fail('MODEL_PROBE_ARTIFACT', 'OpenClaw qualification did not create the canonical project artifact');
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function openClawRuntimeChallengeMarkerPath(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{18,64}$/.test(nonce)) {
    fail('MODEL_PROBE_NONCE', 'OpenClaw runtime challenge nonce was invalid');
  }
  return `/tmp/.portal-openclaw-runtime-${nonce}`;
}

async function stageOpenClawRuntimeChallengeMarker(input: {
  executor: ProjectEgressCommandExecutor;
  runtimeContainerId: string;
  runtimeContainerStartedAt: string;
  nonce: string;
  marker: string;
}): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(input.marker)) {
    fail('MODEL_PROBE_ARTIFACT', 'OpenClaw runtime challenge marker was invalid');
  }
  const markerPath = openClawRuntimeChallengeMarkerPath(input.nonce);
  await inspectExactRuntimeGeneration({
    executor: input.executor,
    containerId: input.runtimeContainerId,
    expectedStartedAt: input.runtimeContainerStartedAt,
    label: 'OpenClaw Project runtime before model challenge',
  });
  try {
    await dockerCommand(input.executor, [
      'container', 'exec',
      '--user', '1000:1000',
      input.runtimeContainerId,
      'python3', '-c',
      [
        'import os,sys',
        'path=sys.argv[1]',
        'value=sys.argv[2].encode("ascii")',
        'flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0)',
        'descriptor=os.open(path,flags,0o600)',
        'os.write(descriptor,value)',
        'os.fsync(descriptor)',
        'os.close(descriptor)',
      ].join(';'),
      markerPath,
      input.marker,
    ]);
  } catch {
    fail('MODEL_PROBE_ARTIFACT', 'OpenClaw could not stage its private runtime challenge');
  }
  await inspectExactRuntimeGeneration({
    executor: input.executor,
    containerId: input.runtimeContainerId,
    expectedStartedAt: input.runtimeContainerStartedAt,
    label: 'OpenClaw Project runtime after model challenge staging',
  });
  return markerPath;
}

async function cleanupOpenClawRuntimeChallengeMarker(input: {
  executor: ProjectEgressCommandExecutor;
  runtimeContainerId: string;
  runtimeContainerStartedAt: string;
  markerPath: string;
}): Promise<void> {
  try {
    await dockerCommand(input.executor, [
      'container', 'exec',
      '--user', '1000:1000',
      input.runtimeContainerId,
      'python3', '-c',
      'import os,sys; path=sys.argv[1]; os.unlink(path) if os.path.lexists(path) else None; assert not os.path.lexists(path)',
      input.markerPath,
    ]);
    await inspectExactRuntimeGeneration({
      executor: input.executor,
      containerId: input.runtimeContainerId,
      expectedStartedAt: input.runtimeContainerStartedAt,
      label: 'OpenClaw Project runtime after model challenge cleanup',
    });
  } catch {
    fail('MODEL_PROBE_CLEANUP', 'OpenClaw private runtime challenge cleanup was not confirmed');
  }
}

async function runDefaultModelProbe(input: {
  sessionKey: string;
  context: ProjectSandboxExecutionContext;
  sender: SenderIdentity;
  nonce: string;
  model?: string;
  runtimeContainerId: string;
  runtimeContainerStartedAt: string;
  executor: ProjectEgressCommandExecutor;
}): Promise<{
  modelId: string;
  executionProviderId: string;
  executionRuntimeKind: typeof OPENCLAW_PROJECT_EXECUTION_RUNTIME;
  toolChallengeSha256: string;
  responseSha256: string;
}> {
  const expected = `PORTAL_PROJECT_QUALIFICATION_${input.nonce}`;
  const runtimeMarker = crypto.randomBytes(32).toString('hex');
  const runtimeMarkerPath = openClawRuntimeChallengeMarkerPath(input.nonce);
  let runtimeMarkerStageAttempted = false;
  const { fileName, destination } = qualificationChallengeArtifact(input.context, input.nonce);
  if (fs.existsSync(destination)) {
    fail('MODEL_PROBE_ARTIFACT', 'OpenClaw qualification challenge destination already existed');
  }
  // The probe session is ephemeral (deleted after every qualification), so it
  // would otherwise inherit the box-global default model. That default may
  // route through an external CLI harness (for example a Claude CLI
  // subscription), which executes outside the attested sandbox and can never
  // produce observable embedded exec evidence. Pin the resolved Project model
  // and reject non-embedded runtimes before spending a model turn.
  const pinnedModel = normalizePortalModelId(input.model || '');
  if (!pinnedModel || !isOpenClawProjectEmbeddedModel(pinnedModel)) {
    fail('MODEL_RUNTIME_UNSAFE', 'OpenClaw qualification requires an explicit embedded-runtime model selection');
  }
  const pinned = await patchSessionModel(input.sessionKey, pinnedModel);
  if (!pinned.ok) {
    fail('MODEL_RUNTIME_UNSAFE', `OpenClaw did not accept the qualification model ${pinnedModel}: ${String(pinned.error || 'session model patch failed')}`);
  }
  const pinnedRuntimeId = String(pinned.resolved?.agentRuntime?.id || '').trim().toLowerCase();
  if (pinnedRuntimeId && pinnedRuntimeId !== 'openclaw') {
    fail(
      'MODEL_RUNTIME_UNSAFE',
      `OpenClaw routes ${pinnedModel} through the ${pinnedRuntimeId} harness, which cannot execute inside the project sandbox. Choose a model with a direct API route.`,
    );
  }
  const command = [
    'set -eu',
    'test "$(pwd -P)" = "/workspace/project"',
    'test "$(id -u)" = "1000"',
    'test "$(id -g)" = "1000"',
    'test ! -e /root/.openclaw',
    'test ! -e /opt/bridgesllm',
    `test -f '${runtimeMarkerPath}'`,
    `test ! -L '${runtimeMarkerPath}'`,
    `test "$(stat -c '%u:%g:%a' '${runtimeMarkerPath}')" = '1000:1000:600'`,
    `runtime_marker="$(cat '${runtimeMarkerPath}')"`,
    'test "${#runtime_marker}" = "64"',
    'umask 077',
    `printf '%s' '${input.nonce}' > './${fileName}'`,
    `test "$(cat './${fileName}')" = '${input.nonce}'`,
    'printf \'%s\\n\' "$runtime_marker"',
  ].join('; ');
  const prompt = [
    'This is a confined OpenClaw Project sandbox qualification challenge.',
    'Call the exec tool exactly once and do not call any other tool.',
    `Use exactly this JSON argument: ${JSON.stringify({ command })}`,
    `Only after it succeeds, reply with exactly ${expected} and no other text.`,
  ].join('\n');
  const events: OpenClawQualificationToolEvent[] = [];
  const provider = AgentRegistry.get('OPENCLAW');
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    runtimeMarkerStageAttempted = true;
    await stageOpenClawRuntimeChallengeMarker({
      executor: input.executor,
      runtimeContainerId: input.runtimeContainerId,
      runtimeContainerStartedAt: input.runtimeContainerStartedAt,
      nonce: input.nonce,
      marker: runtimeMarker,
    });
    const result = await Promise.race([
      provider.sendMessage(
        input.sessionKey,
        prompt,
        undefined,
        (event) => events.push(event as OpenClawQualificationToolEvent),
        () => undefined,
        { ...input.sender, requestId: `project-qualification-${input.nonce}` },
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('OpenClaw qualification model roundtrip timed out')), MODEL_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (String(result.fullText || '').trim() !== expected) {
      fail('MODEL_PROBE_RESPONSE', 'OpenClaw qualification model response did not match its challenge');
    }
    // Verify the runtime binding before the tool-event challenge: a turn that
    // ran on an external CLI harness produces zero observable exec events, and
    // the honest failure is the runtime, not the tool count.
    const session = await getSessionInfo(input.sessionKey);
    if (!session.ok || session.data?.stale) {
      fail('MODEL_RUNTIME_UNSAFE', 'OpenClaw did not expose current post-turn provider/runtime evidence');
    }
    let execution;
    try {
      execution = readVerifiedOpenClawProjectExecutionBinding(session.data);
    } catch (bindingError) {
      fail(
        'MODEL_RUNTIME_UNSAFE',
        `OpenClaw Project qualification used an external or unknown model runtime: ${String(bindingError instanceof Error ? bindingError.message : bindingError)}`,
      );
    }
    if (execution.model !== pinnedModel) {
      fail(
        'MODEL_RUNTIME_UNSAFE',
        `OpenClaw executed the qualification turn on ${execution.model} instead of the pinned ${pinnedModel}`,
      );
    }
    const toolChallengeSha256 = verifyOpenClawModelToolChallenge({
      context: input.context,
      nonce: input.nonce,
      expectedCommand: command,
      expectedMarker: runtimeMarker,
      events,
    });
    return {
      modelId: execution.model,
      executionProviderId: execution.executionProviderId,
      executionRuntimeKind: execution.executionRuntimeKind,
      toolChallengeSha256,
      responseSha256: sha256(result.fullText.trim()),
    };
  } catch (error) {
    await provider.abortActiveRun?.(input.sessionKey).catch(() => false);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    let cleanupFailed = false;
    if (runtimeMarkerStageAttempted) {
      try {
        await cleanupOpenClawRuntimeChallengeMarker({
          executor: input.executor,
          runtimeContainerId: input.runtimeContainerId,
          runtimeContainerStartedAt: input.runtimeContainerStartedAt,
          markerPath: runtimeMarkerPath,
        });
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      cleanupQualificationChallengeArtifact(destination);
    } catch {
      cleanupFailed = true;
    }
    try {
      const deleted = await deleteSession(input.sessionKey);
      if (!deleted.ok) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      fail('MODEL_PROBE_CLEANUP', 'OpenClaw qualification challenge cleanup was not fully confirmed');
    }
  }
}

async function runDefaultCodexModelProbe(input: {
  runtime: CodexProjectEgressRuntimeHandle;
  sender: SenderIdentity;
  nonce: string;
  executor: ProjectEgressCommandExecutor;
}): Promise<{ modelId: string | null; responseSha256: string }> {
  const expected = `PORTAL_CODEX_PROJECT_QUALIFICATION_${input.nonce}`;
  const prompt = `This is a confined Project qualification challenge. Reply with exactly ${expected} and no other text. Do not use tools or modify files.`;
  const globalArgs = [
    '--ask-for-approval', 'never',
    '--profile', CODEX_PROJECT_PROFILE_NAME,
    '--strict-config',
    '--sandbox', 'read-only',
    '--cd', '/tmp',
  ];
  const invocationArgs = buildCodexProjectDockerExecArgs({
    runtime: input.runtime,
    command: '/usr/bin/timeout',
    args: [
      '--signal=KILL', '190',
      '/usr/bin/codex',
      ...globalArgs,
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-rules',
      '--color', 'never',
      '--json',
      '--', prompt,
    ],
  });

  let threadId: string | null = null;
  let response = '';
  let modelId: string | null = null;
  let sawTool = false;
  let result;
  try {
    result = await input.executor.run('docker', invocationArgs);
  } catch {
    fail('MODEL_PROBE_RUNTIME', 'Codex qualification model roundtrip failed');
  }
  for (const line of String(result.stdout || '').split(/\r?\n/).filter(Boolean)) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      fail('MODEL_PROBE_OUTPUT', 'Codex qualification model response was not valid JSONL');
    }
    if (event?.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id.trim() || null;
    }
    if (
      (event?.type === 'item.started' || event?.type === 'item.completed')
      && event?.item?.type === 'command_execution'
    ) {
      sawTool = true;
    }
    if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
      const text = typeof event.item.text === 'string' ? event.item.text.trim() : '';
      if (text) response = text;
    }
    const candidateModel = typeof event?.model === 'string'
      ? event.model
      : typeof event?.model_id === 'string'
        ? event.model_id
        : null;
    if (candidateModel && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(candidateModel)) {
      modelId = candidateModel;
    }
    if (event?.type === 'error' || event?.type === 'turn.failed') {
      fail('MODEL_PROBE_RUNTIME', 'Codex qualification model roundtrip failed');
    }
  }
  if (!threadId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(threadId)) {
    fail('MODEL_PROBE_SESSION', 'Codex qualification model session identity was not confirmed');
  }
  if (sawTool) {
    fail('MODEL_PROBE_TOOL', 'Codex qualification model challenge attempted to use a tool');
  }
  if (response !== expected) {
    fail('MODEL_PROBE_RESPONSE', 'Codex qualification model response did not match its challenge');
  }
  return { modelId, responseSha256: sha256(response) };
}

async function runDefaultEnsureNativeCliRuntime(input: {
  provider: Extract<NativeProjectProvider, 'CLAUDE_CODE' | 'GEMINI'>;
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
}): Promise<NativeCliProjectEgressRuntimeHandle> {
  if (input.provider === 'CLAUDE_CODE') {
    return ensureClaudeCodeProjectQualifiedRuntime({
      executionContext: input.context,
      egress: input.egress,
    });
  }
  return ensureAntigravityProjectQualifiedRuntime({
    executionContext: input.context,
    egress: input.egress,
  });
}

async function runDefaultNativeCliModelProbe(input: {
  provider: Extract<NativeProjectProvider, 'CLAUDE_CODE' | 'GEMINI'>;
  context: ProjectSandboxExecutionContext;
  runtime: NativeCliProjectEgressRuntimeHandle;
  sender: SenderIdentity;
  nonce: string;
}): Promise<{ modelId: string | null; responseSha256: string }> {
  const descriptor = getProjectChatProviderRuntimeDescriptor(input.provider);
  if (input.runtime.provider !== input.provider) {
    fail('MODEL_PROBE_RUNTIME', `${descriptor.displayName} qualification runtime identity did not match`);
  }
  const expected = `PORTAL_${input.provider}_PROJECT_QUALIFICATION_${input.nonce}`;
  const provider = AgentRegistry.get(input.provider);
  let sessionId: string | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let attemptedTool = false;
  try {
    sessionId = await provider.startSession(input.context.userId, {
      executionContext: input.context,
      metadata: {
        qualification: true,
        projectRuntime: descriptor.runtime,
      },
    });
    const result = await Promise.race([
      provider.sendMessage(
        sessionId,
        `This is a confined Project qualification challenge. Reply with exactly ${expected} and no other text. Do not use tools or modify files.`,
        undefined,
        (event) => {
          if (event?.type === 'tool_start' || event?.type === 'tool_update' || event?.type === 'tool_end') {
            attemptedTool = true;
          }
        },
        () => undefined,
        { ...input.sender, requestId: `project-qualification-${input.provider.toLowerCase()}-${input.nonce}` },
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${descriptor.displayName} qualification model roundtrip timed out`)),
          MODEL_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    if (attemptedTool) {
      fail('MODEL_PROBE_TOOL', `${descriptor.displayName} qualification model challenge attempted to use a tool`);
    }
    if (String(result.fullText || '').trim() !== expected) {
      fail('MODEL_PROBE_RESPONSE', `${descriptor.displayName} qualification model response did not match its challenge`);
    }
    return {
      modelId: typeof result.metadata?.model === 'string' ? result.metadata.model : null,
      responseSha256: sha256(expected),
    };
  } catch (error) {
    if (sessionId) await provider.abortActiveRun?.(sessionId).catch(() => false);
    if (error instanceof OpenClawProjectQualificationError) throw error;
    if (error instanceof NativeProviderDiagnosticError) {
      const safeCode = {
        AUTH_REQUIRED: 'MODEL_PROBE_AUTH',
        MODEL_REJECTED: 'MODEL_PROBE_MODEL',
        RATE_LIMITED: 'MODEL_PROBE_RATE_LIMIT',
        TIMED_OUT: 'MODEL_PROBE_TIMEOUT',
        PERMISSION_DENIED: 'MODEL_PROBE_PERMISSION',
        RUNTIME_UNAVAILABLE: 'MODEL_PROBE_RUNTIME',
        PROVIDER_FAILED: 'MODEL_PROBE_RUNTIME',
      }[error.code];
      return fail(safeCode, error.message);
    }
    return fail('MODEL_PROBE_RUNTIME', `${descriptor.displayName} qualification model roundtrip failed`);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (sessionId) {
      try {
        await provider.terminateSession(sessionId);
      } catch {
        fail('MODEL_PROBE_CLEANUP', `${descriptor.displayName} qualification model session cleanup was not confirmed`);
      }
    }
  }
}

async function runDefaultAgentZeroModelProbe(input: {
  context: ProjectSandboxExecutionContext;
  sender: SenderIdentity;
  nonce: string;
  modelSelection: AgentZeroProjectModelSelection;
}): Promise<{ modelId: string; modelProviderId: string; responseSha256: string }> {
  const expected = `PORTAL_AGENT_ZERO_PROJECT_QUALIFICATION_${input.nonce}`;
  const provider = getProjectChatProviderAdapter('AGENT_ZERO');
  let sessionId: string | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let attemptedTool = false;
  try {
    sessionId = await provider.startSession(input.context.userId, {
      executionContext: input.context,
      model: input.modelSelection.model,
      metadata: {
        qualification: true,
        projectRuntime: getProjectChatProviderRuntimeDescriptor('AGENT_ZERO').runtime,
        agentZeroOAuthProviderId: input.modelSelection.providerId,
      },
    });
    const result = await Promise.race([
      provider.sendMessage(
        sessionId,
        `This is a confined Project qualification challenge. Reply with exactly ${expected} and no other text. Do not use tools or modify files.`,
        undefined,
        (event) => {
          if (event?.type === 'tool_start' || event?.type === 'tool_update' || event?.type === 'tool_end') {
            attemptedTool = true;
          }
        },
        () => undefined,
        { ...input.sender, requestId: `project-qualification-agent-zero-${input.nonce}` },
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Agent Zero qualification model roundtrip timed out')),
          MODEL_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    if (attemptedTool) {
      fail('MODEL_PROBE_TOOL', 'Agent Zero qualification model challenge attempted to use a tool');
    }
    if (String(result.fullText || '').trim() !== expected
      || result.metadata?.oauthProviderId !== input.modelSelection.providerId
      || result.metadata?.model !== input.modelSelection.model) {
      fail('MODEL_PROBE_RESPONSE', 'Agent Zero qualification model response did not match its exact OAuth challenge');
    }
    return {
      modelId: input.modelSelection.model,
      modelProviderId: input.modelSelection.providerId,
      responseSha256: sha256(expected),
    };
  } catch (error) {
    if (sessionId) await provider.abortActiveRun?.(sessionId).catch(() => false);
    if (error instanceof OpenClawProjectQualificationError) throw error;
    return fail('MODEL_PROBE_RUNTIME', 'Agent Zero qualification model roundtrip failed');
  } finally {
    if (timeout) clearTimeout(timeout);
    if (sessionId) {
      try {
        await provider.terminateSession(sessionId);
      } catch {
        fail('MODEL_PROBE_CLEANUP', 'Agent Zero qualification model session cleanup was not confirmed');
      }
    }
  }
}

async function attestOpenClawQualificationRuntime(input: {
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  sender: SenderIdentity;
  openClawHome?: string;
  agentZeroModelSelection?: AgentZeroProjectModelSelection;
  dependencies: QualificationDependencies;
}): Promise<RuntimeAttestationBundle> {
  const agentId = deriveOpenClawProjectAgentId(input.context);
  const sessionKey = deriveOpenClawProjectSessionKey(input.context);
  const sandbox = await input.dependencies.ensureSandbox({
    context: input.context,
    agentId,
    sessionKey,
    openClawHome: input.openClawHome,
    egress: input.egress,
  });
  const runtimeContainerStartedAt = requireRuntimeStartedAt(
    sandbox.containerStartedAt,
    'OpenClaw Project runtime handle',
  );
  const spec = buildProjectEgressPlaneSpec(input.egress);
  const initialPlane = await input.dependencies.attestEgressPlane(
    input.dependencies.executor,
    spec,
  );
  const proxyUrl = `http://portal:${encodeURIComponent(spec.token)}@${spec.proxyAlias}:${spec.proxyPort}`;
  const handle = {
    policyVersion: input.context.egressPolicyVersion,
    policyFingerprint: spec.policyFingerprint,
    internalNetworkName: spec.internalNetworkName,
    internalNetworkId: initialPlane.internalNetworkId,
    publicNetworkName: spec.publicNetworkName,
    proxyContainerName: spec.proxyContainerName,
    proxyUrl,
    proxyEnvironment: Object.freeze({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: '',
      no_proxy: '',
    }),
  };
  const plan = buildOpenClawProjectSandboxPlan({
    context: input.context,
    agentId,
    sessionKey,
    openClawHome: input.openClawHome,
    egressSpec: spec,
    egressHandle: handle,
  });
  await input.dependencies.attestOpenClawIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: sandbox.containerId,
    plan,
    spec,
  });
  const finalPlane = await input.dependencies.attestEgressPlane(
    input.dependencies.executor,
    spec,
  );
  if (finalPlane.internalNetworkId !== initialPlane.internalNetworkId
    || finalPlane.publicNetworkId !== initialPlane.publicNetworkId
    || finalPlane.proxyContainerId !== initialPlane.proxyContainerId) {
    fail('PLANE_IDENTITY_RACE', 'OpenClaw Project egress identities changed during qualification');
  }
  await input.dependencies.attestOpenClawIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: sandbox.containerId,
    plan,
    spec,
  });
  const runtimeResult = await dockerCommand(
    input.dependencies.executor,
    ['container', 'inspect', sandbox.containerId],
  );
  const runtimeInspect = parseInspect<any>(runtimeResult.stdout, 'OpenClaw Project runtime inspection');
  if (requireRuntimeStartedAt(runtimeInspect.State?.StartedAt, 'OpenClaw Project runtime')
    !== runtimeContainerStartedAt) {
    fail('RUNTIME_IDENTITY_RACE', 'OpenClaw Project runtime restarted during qualification');
  }
  attestOpenClawProjectContainer({ plan, spec, inspect: runtimeInspect, requireRunning: true });
  await input.dependencies.attestOpenClawIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: sandbox.containerId,
    plan,
    spec,
  });
  const internalInspect = finalPlane.internalNetwork;
  const publicInspect = finalPlane.publicNetwork;
  const proxyInspect = finalPlane.proxyContainer;
  attestProjectEgressNetworkMembership({
    network: internalInspect,
    expectedNames: [spec.proxyContainerName, sandbox.containerName],
    role: 'internal',
  });
  attestProjectEgressNetworkMembership({
    network: publicInspect,
    expectedNames: [spec.proxyContainerName],
    role: 'proxy-public',
  });
  if (
    runtimeInspect.Image !== input.context.runtimeImageDigest
    || proxyInspect.Image !== input.egress.proxyImage
    || sandbox.configHash !== plan.configHash
    || sandbox.runtimeFingerprint !== plan.runtimeFingerprint
    || sandbox.egressPolicyFingerprint !== spec.policyFingerprint
  ) {
    fail('RUNTIME_FINGERPRINT', 'OpenClaw Project qualification runtime fingerprints did not match');
  }
  return {
    sandbox,
    spec,
    runtimeContainerId: String(runtimeInspect.Id || ''),
    runtimeContainerStartedAt,
    proxyContainerId: finalPlane.proxyContainerId,
    internalNetworkId: finalPlane.internalNetworkId,
    publicNetworkId: finalPlane.publicNetworkId,
    internalInspect,
    publicInspect,
  };
}

async function attestCodexQualificationRuntime(input: {
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  sender: SenderIdentity;
  dependencies: QualificationDependencies;
}): Promise<RuntimeAttestationBundle> {
  const runtime = await input.dependencies.ensureCodexRuntime({
    context: input.context,
    egress: input.egress,
  });
  const runtimeContainerStartedAt = requireRuntimeStartedAt(
    runtime.startedAt,
    'Codex Project runtime handle',
  );
  const spec = buildProjectEgressPlaneSpec(input.egress);
  const initialPlane = await input.dependencies.attestEgressPlane(
    input.dependencies.executor,
    spec,
  );
  const plan = buildCodexProjectRuntimePlan({
    context: input.context,
    spec,
    proxyAddress: runtime.proxyAddress,
    internalNetworkId: initialPlane.internalNetworkId,
  });
  await input.dependencies.attestCodexIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: runtime.containerId,
    plan,
    spec,
  });
  const finalPlane = await input.dependencies.attestEgressPlane(
    input.dependencies.executor,
    spec,
  );
  if (finalPlane.internalNetworkId !== initialPlane.internalNetworkId
    || finalPlane.publicNetworkId !== initialPlane.publicNetworkId
    || finalPlane.proxyContainerId !== initialPlane.proxyContainerId) {
    fail('PLANE_IDENTITY_RACE', 'Codex Project egress identities changed during qualification');
  }
  await input.dependencies.attestCodexIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: runtime.containerId,
    plan,
    spec,
  });
  const runtimeResult = await dockerCommand(
    input.dependencies.executor,
    ['container', 'inspect', runtime.containerId],
  );
  const runtimeInspect = parseInspect<any>(runtimeResult.stdout, 'Codex Project runtime inspection');
  if (requireRuntimeStartedAt(runtimeInspect.State?.StartedAt, 'Codex Project runtime')
    !== runtimeContainerStartedAt) {
    fail('RUNTIME_IDENTITY_RACE', 'Codex Project runtime restarted during qualification');
  }
  const attested = attestCodexProjectRuntimeContainer({
    inspect: runtimeInspect,
    plan,
    spec,
    requireRunning: true,
  });
  await input.dependencies.attestCodexIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: runtime.containerId,
    plan,
    spec,
  });
  const internalInspect = finalPlane.internalNetwork;
  const publicInspect = finalPlane.publicNetwork;
  const proxyInspect = finalPlane.proxyContainer;
  attestProjectEgressNetworkMembership({
    network: internalInspect,
    expectedNames: [spec.proxyContainerName, runtime.containerName],
    role: 'internal',
  });
  attestProjectEgressNetworkMembership({
    network: publicInspect,
    expectedNames: [spec.proxyContainerName],
    role: 'proxy-public',
  });
  if (
    attested.containerId !== runtime.containerId
    || attested.startedAt !== runtimeContainerStartedAt
    || runtime.runtimeFingerprint !== plan.runtimeFingerprint
    || runtime.egressPolicyFingerprint !== spec.policyFingerprint
    || String(runtimeInspect.Image || '').toLowerCase() !== input.context.runtimeImageDigest.toLowerCase()
    || String(proxyInspect.Image || '').toLowerCase() !== input.egress.proxyImage.toLowerCase()
  ) {
    fail('RUNTIME_FINGERPRINT', 'Codex Project qualification runtime fingerprints did not match');
  }
  const identity = codexQualificationIdentity(input.context);
  const sandbox: ProjectQualificationSandboxResult = {
    ...identity,
    containerName: runtime.containerName,
    configHash: sha256(stableSerialize({
      containerName: plan.containerName,
      createArgs: plan.createArgs,
      expectedLabels: plan.expectedLabels,
    })),
    runtimeFingerprint: runtime.runtimeFingerprint,
    egressPolicyFingerprint: runtime.egressPolicyFingerprint,
    attestedAt: input.dependencies.now().toISOString(),
  };
  return {
    sandbox,
    spec,
    runtimeContainerId: String(runtimeInspect.Id || ''),
    runtimeContainerStartedAt,
    proxyContainerId: finalPlane.proxyContainerId,
    internalNetworkId: finalPlane.internalNetworkId,
    publicNetworkId: finalPlane.publicNetworkId,
    internalInspect,
    publicInspect,
    opaqueRuntime: runtime,
  };
}

async function attestNativeCliQualificationRuntime(input: {
  provider: Extract<NativeProjectProvider, 'CLAUDE_CODE' | 'GEMINI'>;
  profile: NativeCliProjectRuntimeProfile;
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  sender: SenderIdentity;
  dependencies: QualificationDependencies;
}): Promise<RuntimeAttestationBundle> {
  if (input.profile.provider !== input.provider) {
    fail('RUNTIME_ATTESTATION', 'Native CLI Project qualification profile identity did not match');
  }
  const runtime = await input.dependencies.ensureNativeCliRuntime({
    provider: input.provider,
    context: input.context,
    egress: input.egress,
  });
  const runtimeContainerStartedAt = requireRuntimeStartedAt(
    runtime.startedAt,
    `${input.profile.displayName} Project runtime handle`,
  );
  const spec = buildProjectEgressPlaneSpec(input.egress);
  const initialPlane = await input.dependencies.attestEgressPlane(
    input.dependencies.executor,
    spec,
  );
  const plan = buildNativeCliProjectRuntimePlan({
    context: input.context,
    profile: input.profile,
    spec,
    proxyAddress: runtime.proxyAddress,
    internalNetworkId: initialPlane.internalNetworkId,
  });
  await input.dependencies.attestNativeCliIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: runtime.containerId,
    plan,
    spec,
  });
  const finalPlane = await input.dependencies.attestEgressPlane(
    input.dependencies.executor,
    spec,
  );
  if (finalPlane.internalNetworkId !== initialPlane.internalNetworkId
    || finalPlane.publicNetworkId !== initialPlane.publicNetworkId
    || finalPlane.proxyContainerId !== initialPlane.proxyContainerId) {
    fail(
      'PLANE_IDENTITY_RACE',
      `${input.profile.displayName} Project egress identities changed during qualification`,
    );
  }
  await input.dependencies.attestNativeCliIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: runtime.containerId,
    plan,
    spec,
  });
  const runtimeResult = await dockerCommand(
    input.dependencies.executor,
    ['container', 'inspect', runtime.containerId],
  );
  const runtimeInspect = parseInspect<any>(runtimeResult.stdout, `${input.profile.displayName} Project runtime inspection`);
  if (requireRuntimeStartedAt(
    runtimeInspect.State?.StartedAt,
    `${input.profile.displayName} Project runtime`,
  ) !== runtimeContainerStartedAt) {
    fail(
      'RUNTIME_IDENTITY_RACE',
      `${input.profile.displayName} Project runtime restarted during qualification`,
    );
  }
  const attested = attestNativeCliProjectRuntimeContainer({
    inspect: runtimeInspect,
    plan,
    spec,
    requireRunning: true,
  });
  await input.dependencies.attestNativeCliIdentityRuntime({
    executor: input.dependencies.executor,
    containerId: runtime.containerId,
    plan,
    spec,
  });
  const internalInspect = finalPlane.internalNetwork;
  const publicInspect = finalPlane.publicNetwork;
  const proxyInspect = finalPlane.proxyContainer;
  attestProjectEgressNetworkMembership({
    network: internalInspect,
    expectedNames: [spec.proxyContainerName, runtime.containerName],
    role: 'internal',
  });
  attestProjectEgressNetworkMembership({
    network: publicInspect,
    expectedNames: [spec.proxyContainerName],
    role: 'proxy-public',
  });
  if (
    attested.containerId !== runtime.containerId
    || attested.startedAt !== runtimeContainerStartedAt
    || runtime.provider !== input.provider
    || runtime.runtimeFingerprint !== plan.runtimeFingerprint
    || runtime.egressPolicyFingerprint !== spec.policyFingerprint
    || String(runtimeInspect.Image || '').toLowerCase() !== input.context.runtimeImageDigest.toLowerCase()
    || String(proxyInspect.Image || '').toLowerCase() !== input.egress.proxyImage.toLowerCase()
  ) {
    fail('RUNTIME_FINGERPRINT', `${input.profile.displayName} Project qualification runtime fingerprints did not match`);
  }
  const identity = nativeCliQualificationIdentity(input.provider, input.context);
  const sandbox: ProjectQualificationSandboxResult = {
    ...identity,
    containerName: runtime.containerName,
    configHash: sha256(stableSerialize({
      containerName: plan.containerName,
      createArgs: plan.createArgs,
      expectedLabels: plan.expectedLabels,
    })),
    runtimeFingerprint: runtime.runtimeFingerprint,
    egressPolicyFingerprint: runtime.egressPolicyFingerprint,
    attestedAt: input.dependencies.now().toISOString(),
  };
  return {
    sandbox,
    spec,
    runtimeContainerId: String(runtimeInspect.Id || ''),
    runtimeContainerStartedAt,
    proxyContainerId: finalPlane.proxyContainerId,
    internalNetworkId: finalPlane.internalNetworkId,
    publicNetworkId: finalPlane.publicNetworkId,
    internalInspect,
    publicInspect,
    opaqueRuntime: runtime,
  };
}

async function attestAgentZeroQualificationRuntime(input: {
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  sender: SenderIdentity;
  agentZeroModelSelection?: AgentZeroProjectModelSelection;
  dependencies: QualificationDependencies;
}): Promise<RuntimeAttestationBundle> {
  if (!input.agentZeroModelSelection) {
    fail('MODEL_SELECTION', 'Agent Zero Project qualification requires an exact OAuth provider/model selection');
  }
  const selection = await input.dependencies.resolveAgentZeroModelSelection(
    input.agentZeroModelSelection,
  );
  const converged = await input.dependencies.convergeAgentZeroRuntime({
    context: input.context,
    egress: input.egress,
    modelSelection: selection,
  });
  if (!converged.ready
    || converged.descriptor.actorUserId !== input.context.userId
    || converged.descriptor.projectIdentityId !== input.context.projectId
    || converged.descriptor.canonicalProjectRoot !== input.context.canonicalRoot
    || converged.imageRef?.toLowerCase() !== input.context.runtimeImageDigest.toLowerCase()
    || JSON.stringify(converged.modelSelection) !== JSON.stringify(selection)) {
    fail('RUNTIME_ATTESTATION', 'Agent Zero Project runtime convergence did not match its immutable context');
  }
  const qualified = await input.dependencies.qualifyAgentZeroRuntime({
    context: input.context,
    egress: input.egress,
    modelSelection: selection,
  });
  if (!qualified.ready
    || !qualified.selectable
    || !qualified.qualificationCurrent
    || !qualified.containerId
    || !qualified.runtimeFingerprint
    || !qualified.egressPolicyFingerprint
    || qualified.containerId !== converged.containerId
    || qualified.runtimeFingerprint !== converged.runtimeFingerprint
    || qualified.imageRef?.toLowerCase() !== input.context.runtimeImageDigest.toLowerCase()
    || JSON.stringify(qualified.modelSelection) !== JSON.stringify(selection)) {
    fail('RUNTIME_ATTESTATION', 'Agent Zero Project runtime did not remain exact through live qualification');
  }

  const spec = buildProjectEgressPlaneSpec(input.egress);
  const initialPlane = await input.dependencies.attestEgressPlane(
    input.dependencies.executor,
    spec,
  );
  const identityAttestation = {
    context: input.context,
    descriptor: qualified.descriptor,
    expectedContainerId: qualified.containerId,
    expectedContainerStartedAt: qualified.containerStartedAt,
    imageRef: qualified.imageRef,
    spec,
    expectedRuntimeFingerprint: qualified.runtimeFingerprint,
    bridgeGatewayIpv4: qualified.bridgeGatewayIpv4,
    runtimeIpv4: qualified.runtimeIpv4,
    expectedInternalNetworkId: initialPlane.internalNetworkId,
    modelSelection: selection,
  };
  if (!identityAttestation.imageRef
    || !identityAttestation.expectedContainerStartedAt
    || !identityAttestation.expectedRuntimeFingerprint
    || !identityAttestation.bridgeGatewayIpv4
    || !identityAttestation.runtimeIpv4) {
    fail('RUNTIME_ATTESTATION', 'Agent Zero Project runtime identity inputs are incomplete');
  }
  input.dependencies.attestAgentZeroIdentityRuntime({
    ...identityAttestation,
    imageRef: identityAttestation.imageRef,
    expectedContainerStartedAt: identityAttestation.expectedContainerStartedAt,
    expectedRuntimeFingerprint: identityAttestation.expectedRuntimeFingerprint,
    bridgeGatewayIpv4: identityAttestation.bridgeGatewayIpv4,
    runtimeIpv4: identityAttestation.runtimeIpv4,
  });
  const finalPlane = await input.dependencies.attestEgressPlane(
    input.dependencies.executor,
    spec,
  );
  if (finalPlane.internalNetworkId !== initialPlane.internalNetworkId
    || finalPlane.publicNetworkId !== initialPlane.publicNetworkId
    || finalPlane.proxyContainerId !== initialPlane.proxyContainerId) {
    fail('PLANE_IDENTITY_RACE', 'Agent Zero Project egress identities changed during qualification');
  }
  input.dependencies.attestAgentZeroIdentityRuntime({
    ...identityAttestation,
    imageRef: identityAttestation.imageRef,
    expectedContainerStartedAt: identityAttestation.expectedContainerStartedAt,
    expectedRuntimeFingerprint: identityAttestation.expectedRuntimeFingerprint,
    bridgeGatewayIpv4: identityAttestation.bridgeGatewayIpv4,
    runtimeIpv4: identityAttestation.runtimeIpv4,
    expectedInternalNetworkId: finalPlane.internalNetworkId,
  });
  const runtimeResult = await dockerCommand(
    input.dependencies.executor,
    ['container', 'inspect', qualified.containerId],
  );
  const runtimeInspect = parseInspect<any>(runtimeResult.stdout, 'Agent Zero Project runtime inspection');
  const runtimeContainerStartedAt = requireRuntimeStartedAt(
    runtimeInspect.State?.StartedAt,
    'Agent Zero Project runtime',
  );
  if (runtimeContainerStartedAt !== identityAttestation.expectedContainerStartedAt) {
    fail('RUNTIME_IDENTITY_RACE', 'Agent Zero Project runtime restarted during qualification');
  }
  input.dependencies.attestAgentZeroIdentityRuntime({
    ...identityAttestation,
    imageRef: identityAttestation.imageRef,
    expectedContainerStartedAt: identityAttestation.expectedContainerStartedAt,
    expectedRuntimeFingerprint: identityAttestation.expectedRuntimeFingerprint,
    bridgeGatewayIpv4: identityAttestation.bridgeGatewayIpv4,
    runtimeIpv4: identityAttestation.runtimeIpv4,
    expectedInternalNetworkId: finalPlane.internalNetworkId,
  });
  const internalInspect = finalPlane.internalNetwork;
  const publicInspect = finalPlane.publicNetwork;
  const proxyInspect = finalPlane.proxyContainer;
  attestProjectEgressNetworkMembership({
    network: internalInspect,
    expectedNames: [spec.proxyContainerName, qualified.descriptor.containerName],
    role: 'internal',
  });
  attestProjectEgressNetworkMembership({
    network: publicInspect,
    expectedNames: [spec.proxyContainerName],
    role: 'proxy-public',
  });
  if (
    String(runtimeInspect.Id || '') !== qualified.containerId
    || String(runtimeInspect.Image || '').toLowerCase() !== input.context.runtimeImageDigest.toLowerCase()
    || String(proxyInspect.Image || '').toLowerCase() !== input.egress.proxyImage.toLowerCase()
  ) {
    fail('RUNTIME_FINGERPRINT', 'Agent Zero Project qualification runtime fingerprints did not match');
  }
  const identity = agentZeroQualificationIdentity(input.context, selection);
  const sandbox: ProjectQualificationSandboxResult = {
    ...identity,
    containerName: qualified.descriptor.containerName,
    configHash: sha256(stableSerialize({
      runtime: getProjectChatProviderRuntimeDescriptor('AGENT_ZERO').runtime,
      policyVersion: input.context.runtimePolicyVersion,
      descriptorKey: qualified.descriptor.key,
      containerId: qualified.containerId,
      imageRef: qualified.imageRef,
      modelSelection: selection,
      modelPresetName: qualified.modelPresetName,
    })),
    runtimeFingerprint: qualified.runtimeFingerprint,
    egressPolicyFingerprint: qualified.egressPolicyFingerprint,
    attestedAt: input.dependencies.now().toISOString(),
  };
  return {
    sandbox,
    spec,
    runtimeContainerId: qualified.containerId,
    runtimeContainerStartedAt,
    proxyContainerId: finalPlane.proxyContainerId,
    internalNetworkId: finalPlane.internalNetworkId,
    publicNetworkId: finalPlane.publicNetworkId,
    internalInspect,
    publicInspect,
    opaqueRuntime: { status: qualified, modelSelection: selection },
  };
}

async function attestOllamaQualificationRuntime(input: {
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  sender: SenderIdentity;
  ollamaModelSelection?: OllamaProjectModelSelection;
  dependencies: QualificationDependencies;
}): Promise<RuntimeAttestationBundle> {
  if (!input.ollamaModelSelection) {
    fail('MODEL_SELECTION', 'Ollama Project qualification requires an exact installed model selection');
  }
  const selection = await input.dependencies.resolveOllamaModelSelection(input.ollamaModelSelection);
  const qualified = await input.dependencies.qualifyOllamaRuntime({
    context: input.context,
    modelSelection: selection,
  });
  if (
    qualified.actorUserId !== input.context.userId
    || qualified.projectIdentityId !== input.context.projectId
    || qualified.policyFingerprint !== input.context.policyFingerprint
    || qualified.runtimeImage.toLowerCase() !== input.context.runtimeImageDigest.toLowerCase()
    || qualified.containerNetwork !== 'none'
    || qualified.exactProjectRwBind !== true
    || qualified.runtimeAccessProof.runtimeUid !== 1000
    || qualified.runtimeAccessProof.runtimeGid !== 1000
    || qualified.runtimeAccessProof.projectRwWriteReadUnlink !== true
    || !/^[a-f0-9]{64}$/.test(qualified.runtimeAccessProof.evidenceSha256)
    || qualified.modelBridgeLoopbackOnly !== true
    || qualified.modelBridgeAuthenticated !== true
    || qualified.modelBridgeBoundaryProof.unauthenticatedStatus !== 401
    || qualified.modelBridgeBoundaryProof.scopeMismatchStatus !== 403
    || qualified.modelBridgeBoundaryProof.disallowedRouteStatus !== 404
    || !/^[a-f0-9]{64}$/.test(qualified.modelBridgeBoundaryProof.evidenceSha256)
    || qualified.model !== selection.model
    || qualified.modelDigest !== selection.digest
    || qualified.backendKind !== selection.backendKind
    || qualified.backendFingerprint !== selection.backendFingerprint
    || qualified.backendGeneration !== selection.backendGeneration
    || !qualified.modelCapabilities.includes('tools')
    || qualified.modelToolProbe !== true
  ) {
    fail('RUNTIME_ATTESTATION', 'Ollama Project runtime/model foundation did not match its immutable qualification context');
  }
  const binding = ollamaContextBinding(input.context, input.egress, selection);
  const identity = ollamaQualificationIdentity(input.context, selection);
  return {
    sandbox: {
      ...identity,
      containerName: qualified.containerName,
      configHash: sha256(stableSerialize({
        runtimePolicyVersion: qualified.runtimePolicyVersion,
        runtimeImage: qualified.runtimeImage,
        runtimeFingerprint: qualified.runtimeFingerprint,
        containerNetwork: qualified.containerNetwork,
        exactProjectRwBind: qualified.exactProjectRwBind,
        nonRootReadOnlyCapDrop: qualified.nonRootReadOnlyCapDrop,
        modelBridgePolicy: OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
        modelBinding: ollamaProjectModelBindingValue(selection),
      })),
      runtimeFingerprint: qualified.runtimeFingerprint,
      egressPolicyFingerprint: binding.egressPolicyFingerprint,
      attestedAt: input.dependencies.now().toISOString(),
    },
    spec: null,
    runtimeContainerId: qualified.containerId,
    runtimeContainerStartedAt: null,
    proxyContainerId: null,
    internalNetworkId: null,
    publicNetworkId: null,
    opaqueRuntime: qualified,
  };
}

async function runOllamaLiveQualificationProbes(input: {
  provider: 'OLLAMA';
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  sender: SenderIdentity;
  ollamaModelSelection?: OllamaProjectModelSelection;
  dependencies: QualificationDependencies;
}): Promise<ProbeBundle> {
  const lane = getProjectQualificationLane('OLLAMA');
  const runtime = await lane.attestRuntime(input);
  const foundation = runtime.opaqueRuntime as OllamaProjectQualificationEvidence | undefined;
  if (!foundation) fail('RUNTIME_ATTESTATION', 'Ollama Project foundation evidence is unavailable');
  const now = input.dependencies.now();
  const probes: OpenClawProjectQualificationProbeResult[] = [
    probeResult('runtime_attestation', now, stableSerialize({
      runtime: runtime.runtimeContainerId,
      configHash: runtime.sandbox.configHash,
      runtimeFingerprint: runtime.sandbox.runtimeFingerprint,
      network: 'none',
    })),
    probeResult('project_rw_write_read_unlink', now, foundation.runtimeAccessProof.evidenceSha256),
    probeResult('model_bridge_auth', now, stableSerialize({
      unauthenticatedStatus: foundation.modelBridgeBoundaryProof.unauthenticatedStatus,
      scopeMismatchStatus: foundation.modelBridgeBoundaryProof.scopeMismatchStatus,
      evidence: foundation.modelBridgeBoundaryProof.evidenceSha256,
    })),
    probeResult('model_bridge_route_allowlist', now, stableSerialize({
      disallowedRouteStatus: foundation.modelBridgeBoundaryProof.disallowedRouteStatus,
      policy: OLLAMA_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
      evidence: foundation.modelBridgeBoundaryProof.evidenceSha256,
    })),
  ];
  const run = (id: OpenClawProjectQualificationProbeId, host: string, port: number) => runContainerCommand({
    executor: input.dependencies.executor,
    containerId: runtime.runtimeContainerId,
    args: ['python3', '-c', 'import socket,sys; s=socket.socket(socket.AF_INET6 if ":" in sys.argv[1] else socket.AF_INET,socket.SOCK_STREAM); s.settimeout(1.5); r=s.connect_ex((sys.argv[1],int(sys.argv[2]))); s.close(); raise SystemExit(41 if r == 0 else 0)', host, String(port)],
    expectSuccess: true,
    id,
    now: input.dependencies.now(),
    displayName: lane.displayName,
  });
  probes.push(await run('deny_loopback', '127.0.0.1', 11434));
  probes.push(await run('deny_direct_proxy_bypass', '1.1.1.1', 443));
  probes.push(await run('deny_host_docker_gateway', '172.17.0.1', 80));
  probes.push(probeResult('deny_docker_peer', input.dependencies.now(), stableSerialize({ network: 'none', peers: [] })));
  probes.push(await run('deny_rfc1918', '10.0.0.1', 80));
  probes.push(await run('deny_cgnat', '100.64.0.1', 80));
  probes.push(await run('deny_link_local_metadata', '169.254.169.254', 80));
  probes.push(await run('deny_ipv6_private_mapped', '::ffff:127.0.0.1', 80));
  probes.push(await runContainerCommand({
    executor: input.dependencies.executor,
    containerId: runtime.runtimeContainerId,
    args: ['sh', '-lc', 'test ! -e /var/run/docker.sock && test ! -e /root/.openclaw && test ! -e /opt/bridgesllm && test ! -e /workspace/projects && test ! -e /proc/1/root/opt/bridgesllm'],
    expectSuccess: true,
    id: 'deny_sibling_host_paths',
    now: input.dependencies.now(),
    displayName: lane.displayName,
  }));
  const model = await lane.modelProbe({
    runtime,
    context: input.context,
    sender: input.sender,
    nonce: crypto.randomBytes(18).toString('base64url'),
    dependencies: input.dependencies,
  });
  probes.push(probeResult('model_roundtrip', input.dependencies.now(), stableSerialize({
    modelId: model.modelId,
    modelDigest: model.modelDigest,
    ollamaBackendKind: model.ollamaBackendKind,
    ollamaBackendFingerprint: model.ollamaBackendFingerprint,
    ollamaBackendGeneration: model.ollamaBackendGeneration,
    responseSha256: model.responseSha256,
  })));
  return {
    sandbox: runtime.sandbox,
    spec: null,
    runtimeContainerId: runtime.runtimeContainerId,
    runtimeContainerStartedAt: null,
    proxyContainerId: null,
    internalNetworkId: null,
    publicNetworkId: null,
    modelId: model.modelId,
    modelProviderId: null,
    modelDigest: model.modelDigest || null,
    ollamaBackendKind: model.ollamaBackendKind || null,
    ollamaBackendFingerprint: model.ollamaBackendFingerprint || null,
    ollamaBackendGeneration: model.ollamaBackendGeneration ?? null,
    modelResponseSha256: model.responseSha256,
    probes,
    opaqueRuntime: runtime.opaqueRuntime,
  };
}

async function runLiveQualificationProbes(input: {
  provider: QualifiableProjectProvider;
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  sender: SenderIdentity;
  openClawHome?: string;
  openClawModel?: string;
  agentZeroModelSelection?: AgentZeroProjectModelSelection;
  ollamaModelSelection?: OllamaProjectModelSelection;
  dependencies: QualificationDependencies;
}): Promise<ProbeBundle> {
  if (input.provider === 'OLLAMA') {
    return runOllamaLiveQualificationProbes({ ...input, provider: 'OLLAMA' });
  }
  const lane = getProjectQualificationLane(input.provider);
  const runtime = await lane.attestRuntime(input);
  const { sandbox, spec, internalInspect, publicInspect } = runtime;

  const now = input.dependencies.now();
  const probes: OpenClawProjectQualificationProbeResult[] = [
    probeResult('runtime_attestation', now, stableSerialize({
      runtime: runtime.runtimeContainerId,
      proxy: runtime.proxyContainerId,
      internal: runtime.internalNetworkId,
      public: runtime.publicNetworkId,
      configHash: sandbox.configHash,
      runtimeFingerprint: sandbox.runtimeFingerprint,
      egressPolicyFingerprint: spec!.policyFingerprint,
    })),
  ];
  const run = (id: OpenClawProjectQualificationProbeId, args: readonly string[], expectSuccess: boolean) => (
    runContainerCommand({
      executor: input.dependencies.executor,
      containerId: runtime.runtimeContainerId,
      args,
      expectSuccess,
      id,
      now: input.dependencies.now(),
      displayName: lane.displayName,
    })
  );
  probes.push(await run('public_dns_https', [
    'curl', '-fsSL', '--max-time', '25', '--proto', '=https', 'https://example.com/',
  ], true));
  probes.push(await run('https_git', [
    'timeout', '45', 'git', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=20',
    'ls-remote', 'https://github.com/git/git.git', 'HEAD',
  ], true));
  probes.push(await run('package_registry_install', [
    'sh', '-lc',
    // The node -e payload must ride in single quotes: double quotes nested
    // inside this double-quoted shell word cancel out and node would see
    // bare `require(is-number)`.
    'set -eu; d=/tmp/portal-qualification-npm; rm -rf "$d"; mkdir -p "$d"; cd "$d"; npm --cache "$d/cache" --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund install --package-lock=false is-number@7.0.0 >/dev/null; node -e \'if(require("is-number")(7)!==true)process.exit(9)\'',
  ], true));
  probes.push(await run('asset_download', [
    'sh', '-lc',
    'set -eu; curl -fsSL --max-time 25 --proto "=https" --max-filesize 1048576 https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore -o /tmp/portal-qualification-asset; test -s /tmp/portal-qualification-asset; grep -q node_modules /tmp/portal-qualification-asset',
  ], true));

  if (input.provider === 'AGENT_ZERO') {
    // Agent Zero legitimately serves its own authenticated connector on the
    // container loopback interface. Its dedicated qualification has already
    // proven that no host launcher gateway is attached and that Docker-host
    // service ports are unreachable; encode that stronger provider-specific
    // evidence instead of falsely requiring its own connector to be absent.
    probes.push(probeResult('deny_loopback', input.dependencies.now(), stableSerialize({
      provider: input.provider,
      runtimeFingerprint: sandbox.runtimeFingerprint,
      connectorLoopbackIsProviderLocal: true,
      hostGatewayDisconnected: true,
    })));
  } else {
    probes.push(await run('deny_loopback', [
      'curl', '-fsS', '--max-time', '8', 'http://127.0.0.1/',
    ], false));
  }
  probes.push(await run('deny_direct_proxy_bypass', [
    'curl', '-fsS', '--noproxy', '*', '--max-time', '8', 'https://example.com/',
  ], false));
  const gateway = String(internalInspect?.IPAM?.Config?.[0]?.Gateway || '').trim();
  if (!gateway) fail('NETWORK_GATEWAY', `${lane.displayName} Project internal network gateway was not reported`);
  probes.push(await run('deny_host_docker_gateway', [
    'curl', '-fsS', '--noproxy', '*', '--max-time', '5', `http://${gateway}:80/`,
  ], false));
  probes.push(probeResult('deny_docker_peer', input.dependencies.now(), stableSerialize({
    internalMembers: Object.values(internalInspect.Containers || {}).map((entry: any) => entry.Name).sort(),
    publicMembers: Object.values(publicInspect.Containers || {}).map((entry: any) => entry.Name).sort(),
  })));
  probes.push(await run('deny_rfc1918', [
    'sh', '-lc',
    'for u in http://10.0.0.1/ http://172.16.0.1/ http://192.168.0.1/; do if curl -fsS --max-time 4 "$u" >/dev/null 2>&1; then exit 31; fi; done',
  ], true));
  probes.push(await run('deny_cgnat', [
    'sh', '-lc',
    'if curl -fsS --max-time 4 http://100.64.0.1/ >/dev/null 2>&1; then exit 32; fi',
  ], true));
  probes.push(await run('deny_link_local_metadata', [
    'sh', '-lc',
    'for u in http://169.254.169.254/latest/meta-data/ http://169.254.170.2/; do if curl -fsS --max-time 4 "$u" >/dev/null 2>&1; then exit 33; fi; done',
  ], true));
  probes.push(await run('deny_ipv6_private_mapped', [
    'sh', '-lc',
    'for u in "http://[::1]/" "http://[fd00::1]/" "http://[::ffff:127.0.0.1]/"; do if curl -g -fsS --max-time 4 "$u" >/dev/null 2>&1; then exit 34; fi; done',
  ], true));
  probes.push(await run('deny_redirect_private', [
    'curl', '-fsSL', '--max-time', '15', '--max-redirs', '3',
    'https://httpbin.org/redirect-to?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F',
  ], false));
  probes.push(await run('deny_private_dns_answer', [
    'curl', '-fsS', '--max-time', '8', 'http://127.0.0.1.nip.io/',
  ], false));
  probes.push(await run('deny_sibling_host_paths', [
    'sh', '-lc',
    'test ! -e /var/run/docker.sock && test ! -e /root/.openclaw && test ! -e /opt/bridgesllm && test ! -e /workspace/projects && test ! -e /proc/1/root/opt/bridgesllm',
  ], true));

  const nonce = crypto.randomBytes(18).toString('base64url');
  const model = await lane.modelProbe({
    runtime,
    context: input.context,
    sender: input.sender,
    nonce,
    openClawModel: input.openClawModel,
    dependencies: input.dependencies,
  });
  probes.push(probeResult('model_roundtrip', input.dependencies.now(), stableSerialize({
    nonceSha256: sha256(nonce),
    responseSha256: model.responseSha256,
    modelId: model.modelId,
    modelProviderId: model.modelProviderId || null,
    modelDigest: model.modelDigest || null,
    executionProviderId: model.executionProviderId || null,
    executionRuntimeKind: model.executionRuntimeKind || null,
  })));
  if (input.provider === 'OPENCLAW') {
    if (!model.modelId
      || !model.executionProviderId
      || model.executionRuntimeKind !== OPENCLAW_PROJECT_EXECUTION_RUNTIME
      || !model.toolChallengeSha256) {
      fail('MODEL_RUNTIME_UNSAFE', 'OpenClaw qualification did not prove its exact embedded execution runtime');
    }
    probes.push(probeResult(
      'model_runtime_tool_challenge',
      input.dependencies.now(),
      stableSerialize({
        modelId: model.modelId,
        executionProviderId: model.executionProviderId,
        executionRuntimeKind: model.executionRuntimeKind,
        toolChallengeSha256: model.toolChallengeSha256,
      }),
    ));
  }

  return {
    sandbox,
    spec,
    runtimeContainerId: runtime.runtimeContainerId,
    runtimeContainerStartedAt: runtime.runtimeContainerStartedAt,
    proxyContainerId: runtime.proxyContainerId,
    internalNetworkId: runtime.internalNetworkId,
    publicNetworkId: runtime.publicNetworkId,
    modelId: model.modelId,
    modelProviderId: model.modelProviderId || null,
    modelDigest: model.modelDigest || null,
    executionProviderId: model.executionProviderId || null,
    executionRuntimeKind: model.executionRuntimeKind || null,
    modelToolChallengeSha256: model.toolChallengeSha256 || null,
    modelResponseSha256: model.responseSha256,
    probes,
    opaqueRuntime: runtime.opaqueRuntime,
  };
}

function requireQualificationDockerId(value: unknown, label: string): string {
  const containerId = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    fail('RUNTIME_ATTESTATION', `${label} immutable Docker identity was invalid`);
  }
  return containerId;
}

async function attestFinalEvidenceRuntime(input: {
  provider: QualifiableProjectProvider;
  context: ProjectSandboxExecutionContext;
  egress: ProjectEgressPlaneConfig;
  openClawHome?: string;
  agentZeroModelSelection?: AgentZeroProjectModelSelection;
  bundle: ProbeBundle;
  dependencies: QualificationDependencies;
}): Promise<void> {
  if (input.provider === 'OLLAMA') return;
  const spec = buildProjectEgressPlaneSpec(input.egress);
  const runtimeContainerId = requireQualificationDockerId(
    input.bundle.runtimeContainerId,
    `${providerDisplayName(input.provider)} Project runtime`,
  );
  const runtimeContainerStartedAt = requireRuntimeStartedAt(
    input.bundle.runtimeContainerStartedAt,
    `${providerDisplayName(input.provider)} Project runtime evidence`,
  );
  const internalNetworkId = requireQualificationDockerId(
    input.bundle.internalNetworkId,
    `${providerDisplayName(input.provider)} Project internal network`,
  );
  const publicNetworkId = requireQualificationDockerId(
    input.bundle.publicNetworkId,
    `${providerDisplayName(input.provider)} Project public network`,
  );
  const proxyContainerId = requireQualificationDockerId(
    input.bundle.proxyContainerId,
    `${providerDisplayName(input.provider)} Project proxy`,
  );
  if (!input.bundle.spec
    || input.bundle.spec.policyFingerprint !== spec.policyFingerprint
    || input.bundle.spec.internalNetworkName !== spec.internalNetworkName
    || input.bundle.spec.publicNetworkName !== spec.publicNetworkName
    || input.bundle.spec.proxyContainerName !== spec.proxyContainerName
    || input.bundle.sandbox.egressPolicyFingerprint !== spec.policyFingerprint) {
    fail('PLANE_IDENTITY_RACE', `${providerDisplayName(input.provider)} Project egress specification changed`);
  }

  const attestPlane = async (): Promise<void> => {
    const plane = await input.dependencies.attestEgressPlane(
      input.dependencies.executor,
      spec,
    );
    if (plane.internalNetworkId !== internalNetworkId
      || plane.publicNetworkId !== publicNetworkId
      || plane.proxyContainerId !== proxyContainerId
      || String(plane.proxyContainer.Image || '').toLowerCase()
        !== input.egress.proxyImage.toLowerCase()) {
      fail(
        'PLANE_IDENTITY_RACE',
        `${providerDisplayName(input.provider)} Project egress identities changed before evidence persistence`,
      );
    }
    attestProjectEgressNetworkMembership({
      network: plane.internalNetwork,
      expectedNames: [spec.proxyContainerName, input.bundle.sandbox.containerName],
      role: 'internal',
    });
    attestProjectEgressNetworkMembership({
      network: plane.publicNetwork,
      expectedNames: [spec.proxyContainerName],
      role: 'proxy-public',
    });
  };

  const inspectGeneration = async (): Promise<any> => {
    const inspect = await inspectExactRuntimeGeneration({
      executor: input.dependencies.executor,
      containerId: runtimeContainerId,
      expectedStartedAt: runtimeContainerStartedAt,
      label: `${providerDisplayName(input.provider)} Project runtime before evidence persistence`,
    });
    if (String(inspect.Image || '').toLowerCase() !== input.context.runtimeImageDigest.toLowerCase()) {
      fail(
        'RUNTIME_FINGERPRINT',
        `${providerDisplayName(input.provider)} Project runtime image changed before evidence persistence`,
      );
    }
    return inspect;
  };

  const attestProviderRuntime = async (): Promise<void> => {
    const initialInspect = await inspectGeneration();
    if (input.provider === 'OPENCLAW') {
      const agentId = deriveOpenClawProjectAgentId(input.context);
      const sessionKey = deriveOpenClawProjectSessionKey(input.context);
      const proxyUrl = `http://portal:${encodeURIComponent(spec.token)}@${spec.proxyAlias}:${spec.proxyPort}`;
      const plan = buildOpenClawProjectSandboxPlan({
        context: input.context,
        agentId,
        sessionKey,
        openClawHome: input.openClawHome,
        egressSpec: spec,
        egressHandle: {
          policyVersion: input.context.egressPolicyVersion,
          policyFingerprint: spec.policyFingerprint,
          internalNetworkName: spec.internalNetworkName,
          internalNetworkId,
          publicNetworkName: spec.publicNetworkName,
          proxyContainerName: spec.proxyContainerName,
          proxyUrl,
          proxyEnvironment: Object.freeze({
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            https_proxy: proxyUrl,
            NO_PROXY: '',
            no_proxy: '',
          }),
        },
      });
      if (input.bundle.sandbox.agentId !== agentId
        || input.bundle.sandbox.sessionKey !== sessionKey
        || input.bundle.sandbox.containerName !== plan.containerName
        || input.bundle.sandbox.configHash !== plan.configHash
        || input.bundle.sandbox.runtimeFingerprint !== plan.runtimeFingerprint) {
        fail('RUNTIME_FINGERPRINT', 'OpenClaw Project runtime evidence changed before persistence');
      }
      await input.dependencies.attestOpenClawIdentityRuntime({
        executor: input.dependencies.executor,
        containerId: runtimeContainerId,
        plan,
        spec,
      });
      const attested = attestOpenClawProjectContainer({
        plan,
        spec,
        inspect: initialInspect,
        requireRunning: true,
      });
      if (attested.containerId.toLowerCase() !== runtimeContainerId) {
        fail('RUNTIME_IDENTITY_RACE', 'OpenClaw Project runtime immutable identity changed');
      }
    } else if (input.provider === 'CODEX') {
      const runtime = input.bundle.opaqueRuntime as CodexProjectEgressRuntimeHandle | undefined;
      if (!runtime
        || runtime.containerId.toLowerCase() !== runtimeContainerId
        || runtime.startedAt !== runtimeContainerStartedAt) {
        fail('RUNTIME_ATTESTATION', 'Codex Project runtime handle changed before evidence persistence');
      }
      const plan = buildCodexProjectRuntimePlan({
        context: input.context,
        spec,
        proxyAddress: runtime.proxyAddress,
        internalNetworkId,
      });
      await input.dependencies.attestCodexIdentityRuntime({
        executor: input.dependencies.executor,
        containerId: runtimeContainerId,
        plan,
        spec,
      });
      const attested = attestCodexProjectRuntimeContainer({
        inspect: initialInspect,
        plan,
        spec,
        requireRunning: true,
      });
      if (attested.containerId.toLowerCase() !== runtimeContainerId
        || attested.startedAt !== runtimeContainerStartedAt
        || input.bundle.sandbox.containerName !== plan.containerName
        || input.bundle.sandbox.runtimeFingerprint !== plan.runtimeFingerprint) {
        fail('RUNTIME_IDENTITY_RACE', 'Codex Project runtime generation changed before evidence persistence');
      }
    } else if (input.provider === 'CLAUDE_CODE' || input.provider === 'GEMINI') {
      const runtime = input.bundle.opaqueRuntime as NativeCliProjectEgressRuntimeHandle | undefined;
      const profile = input.provider === 'CLAUDE_CODE'
        ? CLAUDE_CODE_PROJECT_RUNTIME_PROFILE
        : ANTIGRAVITY_PROJECT_RUNTIME_PROFILE;
      if (!runtime
        || runtime.provider !== input.provider
        || runtime.containerId.toLowerCase() !== runtimeContainerId
        || runtime.startedAt !== runtimeContainerStartedAt) {
        fail(
          'RUNTIME_ATTESTATION',
          `${profile.displayName} Project runtime handle changed before evidence persistence`,
        );
      }
      const plan = buildNativeCliProjectRuntimePlan({
        context: input.context,
        profile,
        spec,
        proxyAddress: runtime.proxyAddress,
        internalNetworkId,
      });
      await input.dependencies.attestNativeCliIdentityRuntime({
        executor: input.dependencies.executor,
        containerId: runtimeContainerId,
        plan,
        spec,
      });
      const attested = attestNativeCliProjectRuntimeContainer({
        inspect: initialInspect,
        plan,
        spec,
        requireRunning: true,
      });
      if (attested.containerId.toLowerCase() !== runtimeContainerId
        || attested.startedAt !== runtimeContainerStartedAt
        || input.bundle.sandbox.containerName !== plan.containerName
        || input.bundle.sandbox.runtimeFingerprint !== plan.runtimeFingerprint) {
        fail(
          'RUNTIME_IDENTITY_RACE',
          `${profile.displayName} Project runtime generation changed before evidence persistence`,
        );
      }
    } else if (input.provider === 'AGENT_ZERO') {
      const opaque = input.bundle.opaqueRuntime as {
        status?: AgentZeroProjectRuntimeStatus;
        modelSelection?: AgentZeroProjectModelSelection;
      } | undefined;
      const status = opaque?.status;
      const selection = opaque?.modelSelection;
      if (!status?.selectable
        || !selection
        || !input.agentZeroModelSelection
        || JSON.stringify(selection) !== JSON.stringify(input.agentZeroModelSelection)
        || status.containerId?.toLowerCase() !== runtimeContainerId
        || status.containerStartedAt !== runtimeContainerStartedAt
        || !status.imageRef
        || !status.runtimeFingerprint
        || !status.bridgeGatewayIpv4
        || !status.runtimeIpv4
        || input.bundle.sandbox.containerName !== status.descriptor.containerName
        || input.bundle.sandbox.runtimeFingerprint !== status.runtimeFingerprint
        || input.bundle.sandbox.egressPolicyFingerprint !== status.egressPolicyFingerprint) {
        fail('RUNTIME_ATTESTATION', 'Agent Zero Project runtime handle changed before evidence persistence');
      }
      input.dependencies.attestAgentZeroIdentityRuntime({
        context: input.context,
        descriptor: status.descriptor,
        expectedContainerId: runtimeContainerId,
        expectedContainerStartedAt: runtimeContainerStartedAt,
        imageRef: status.imageRef,
        spec,
        expectedRuntimeFingerprint: status.runtimeFingerprint,
        bridgeGatewayIpv4: status.bridgeGatewayIpv4,
        runtimeIpv4: status.runtimeIpv4,
        expectedInternalNetworkId: internalNetworkId,
        modelSelection: selection,
      });
    }
    await inspectGeneration();
  };

  // This is deliberately a read-only plane/runtime/plane/runtime sandwich.
  // No network, model, or mutable-name operation may occur after it and before
  // the signed evidence is written.
  await attestPlane();
  await attestProviderRuntime();
  await attestPlane();
  await attestProviderRuntime();
}

export async function qualifyProjectProvider(
  provider: QualifiableProjectProvider,
  input: QualifyOpenClawProjectInput,
  overrides: Partial<QualificationDependencies> = {},
): Promise<OpenClawProjectQualificationStatus> {
  if (provider === 'OLLAMA') {
    return withOllamaAuthorityRunLease(
      () => qualifyProjectProviderWithAuthorityLease(provider, input, overrides),
    );
  }
  return qualifyProjectProviderWithAuthorityLease(provider, input, overrides);
}

async function qualifyProjectProviderWithAuthorityLease(
  provider: QualifiableProjectProvider,
  input: QualifyOpenClawProjectInput,
  overrides: Partial<QualificationDependencies>,
): Promise<OpenClawProjectQualificationStatus> {
  if (
    input.context.scope !== 'PROJECT_SANDBOX'
    || input.context.source !== 'PORTAL_SERVER'
    || input.egress.identity.actorId !== input.context.userId
    || input.egress.identity.projectId !== input.context.projectId
    || String(input.egress.identity.provider).toUpperCase() !== provider
    || input.sender.userId !== input.context.userId
  ) {
    fail('QUALIFICATION_IDENTITY', `${providerDisplayName(provider)} Project qualification identity did not match`);
  }
  const dependencies = qualificationDefaults(provider, overrides);
  const ttlMs = resolvedTtl(dependencies.ttlMs);
  // A failed explicit requalification is new negative evidence. Revoke any
  // prior grant before touching the runtime so an old, still-unexpired file
  // cannot keep the provider selectable after a probe exposes drift.
  requireSecret(dependencies.secret);
  removeProjectQualificationEvidence(provider, input.context, {
    evidenceRoot: dependencies.evidenceRoot,
  });
  const agentZeroModelSelection = provider === 'AGENT_ZERO'
    ? await dependencies.resolveAgentZeroModelSelection(input.agentZeroModelSelection)
    : undefined;
  const ollamaModelSelection = provider === 'OLLAMA'
    ? await dependencies.resolveOllamaModelSelection(input.ollamaModelSelection)
    : undefined;
  const bundle = await dependencies.runProbes({
    provider,
    ...input,
    agentZeroModelSelection,
    ollamaModelSelection,
    dependencies,
  });
  if (provider === 'AGENT_ZERO' && (
    bundle.modelProviderId !== agentZeroModelSelection?.providerId
    || bundle.modelId !== agentZeroModelSelection.model
  )) {
    fail('MODEL_PROBE_RESPONSE', 'Agent Zero qualification did not retain its exact OAuth provider/model binding');
  }
  if (provider === 'OLLAMA' && (
    bundle.modelId !== ollamaModelSelection?.model
    || bundle.modelDigest !== ollamaModelSelection.digest
    || bundle.ollamaBackendKind !== ollamaModelSelection.backendKind
    || bundle.ollamaBackendFingerprint !== ollamaModelSelection.backendFingerprint
    || bundle.ollamaBackendGeneration !== ollamaModelSelection.backendGeneration
  )) {
    fail('MODEL_PROBE_RESPONSE', 'Ollama qualification did not retain its exact backend and installed model digest');
  }
  await dependencies.attestFinalEvidenceRuntime({
    provider,
    context: input.context,
    egress: input.egress,
    openClawHome: input.openClawHome,
    agentZeroModelSelection,
    bundle,
    dependencies,
  });
  const qualifiedAt = dependencies.now();
  const expiresAt = new Date(qualifiedAt.getTime() + ttlMs);
  const binding = expectedContextBinding(
    provider,
    input.context,
    input.egress,
    provider === 'OLLAMA' ? ollamaModelSelection : agentZeroModelSelection,
  );
  const payload: OpenClawProjectQualificationPayload = {
    schema: 1,
    qualificationVersion: projectQualificationVersionFor(provider),
    provider,
    ...binding,
    containerName: bundle.sandbox.containerName,
    runtimeContainerId: bundle.runtimeContainerId,
    runtimeContainerStartedAt: bundle.runtimeContainerStartedAt,
    proxyContainerName: bundle.spec?.proxyContainerName || null,
    proxyContainerId: bundle.proxyContainerId,
    internalNetworkName: bundle.spec?.internalNetworkName || null,
    internalNetworkId: bundle.internalNetworkId,
    publicNetworkName: bundle.spec?.publicNetworkName || null,
    publicNetworkId: bundle.publicNetworkId,
    configHash: bundle.sandbox.configHash,
    runtimeFingerprint: bundle.sandbox.runtimeFingerprint,
    modelId: bundle.modelId,
    modelProviderId: bundle.modelProviderId,
    modelDigest: bundle.modelDigest,
    ollamaBackendKind: bundle.ollamaBackendKind || null,
    ollamaBackendFingerprint: bundle.ollamaBackendFingerprint || null,
    ollamaBackendGeneration: bundle.ollamaBackendGeneration ?? null,
    executionProviderId: bundle.executionProviderId || null,
    executionRuntimeKind: bundle.executionRuntimeKind || null,
    modelToolChallengeSha256: bundle.modelToolChallengeSha256 || null,
    modelResponseSha256: bundle.modelResponseSha256,
    probes: [...bundle.probes].sort((left, right) => left.id.localeCompare(right.id)),
    qualifiedAt: qualifiedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  validatePayload(provider, input.context, input.egress, {
    payload,
    mac: evidenceMac(payload, dependencies.secret),
  }, dependencies.secret, qualifiedAt, agentZeroModelSelection, ollamaModelSelection);
  writeEvidenceAtomic(input.context, dependencies.evidenceRoot, {
    payload,
    mac: evidenceMac(payload, dependencies.secret),
  });
  return {
    provider,
    status: 'QUALIFIED',
    selectable: true,
    reason: qualifiedReason(provider, payload.expiresAt),
    qualifiedAt: payload.qualifiedAt,
    expiresAt: payload.expiresAt,
    evidenceFingerprint: sha256(stableSerialize(payload)),
  };
}

export async function qualifyOpenClawProject(
  input: QualifyOpenClawProjectInput,
  overrides: Partial<QualificationDependencies> = {},
): Promise<OpenClawProjectQualificationStatus> {
  return qualifyProjectProvider('OPENCLAW', input, overrides);
}

export async function qualifyCodexProject(
  input: QualifyCodexProjectInput,
  overrides: Partial<QualificationDependencies> = {},
): Promise<OpenClawProjectQualificationStatus> {
  return qualifyProjectProvider('CODEX', input, overrides);
}

export function removeProjectQualificationEvidence(
  provider: QualifiableProjectProvider,
  context: ProjectSandboxExecutionContext,
  overrides: Pick<Partial<QualificationDependencies>, 'evidenceRoot'> = {},
): void {
  if (provider === 'OPENCLAW') {
    clearOpenClawProjectModelRuntimeEligibility(deriveOpenClawProjectSessionKey(context));
  }
  const root = overrides.evidenceRoot || defaultEvidenceRoot(provider);
  const destination = evidencePath(context, root);
  if (!fs.existsSync(destination)) return;
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('EVIDENCE_PATH', 'Project qualification evidence path is unsafe');
  }
  fs.unlinkSync(destination);
}

export function removeOpenClawProjectQualificationEvidence(
  context: ProjectSandboxExecutionContext,
  overrides: Pick<Partial<QualificationDependencies>, 'evidenceRoot'> = {},
): void {
  removeProjectQualificationEvidence('OPENCLAW', context, overrides);
}

export function removeCodexProjectQualificationEvidence(
  context: ProjectSandboxExecutionContext,
  overrides: Pick<Partial<QualificationDependencies>, 'evidenceRoot'> = {},
): void {
  removeProjectQualificationEvidence('CODEX', context, overrides);
}

/**
 * Remove every actor-specific qualification grant for one immutable project.
 * Project deletion cannot derive every historical actor filename after its
 * durable bindings have been cleaned, so this scans the root-owned evidence
 * directory and matches only the server-owned ProjectIdentity UUID stored in
 * otherwise well-formed envelopes. Malformed evidence already fails closed
 * during admission and is deliberately left for operator inspection.
 */
export function removeProjectQualificationEvidenceForProject(
  provider: QualifiableProjectProvider,
  projectIdentityIdInput: string,
  overrides: Pick<Partial<QualificationDependencies>, 'evidenceRoot'> = {},
): number {
  const projectIdentityId = String(projectIdentityIdInput || '').trim();
  if (!projectIdentityId || projectIdentityId.includes('\0')) {
    fail('QUALIFICATION_IDENTITY', 'Immutable project identity is required for evidence cleanup');
  }
  if (provider === 'OPENCLAW') {
    clearOpenClawProjectModelRuntimeEligibilityForProject(projectIdentityId);
  }
  const requestedRoot = path.resolve(overrides.evidenceRoot || defaultEvidenceRoot(provider));
  if (!fs.existsSync(requestedRoot)) return 0;
  const root = ensurePrivateEvidenceRoot(requestedRoot);
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const destination = path.join(root, entry.name);
    const stat = fs.lstatSync(destination);
    if (
      entry.isSymbolicLink()
      || stat.isSymbolicLink()
      || !entry.isFile()
      || !stat.isFile()
      || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || stat.size < 2
      || stat.size > MAX_EVIDENCE_BYTES
    ) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(destination, 'utf8'));
    } catch {
      continue;
    }
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || (parsed as OpenClawProjectQualificationEnvelope).payload?.projectIdentityId !== projectIdentityId
    ) {
      continue;
    }
    fs.unlinkSync(destination);
    removed += 1;
  }
  return removed;
}


export function removeOpenClawProjectQualificationEvidenceForProject(
  projectIdentityIdInput: string,
  overrides: Pick<Partial<QualificationDependencies>, 'evidenceRoot'> = {},
): number {
  return removeProjectQualificationEvidenceForProject('OPENCLAW', projectIdentityIdInput, overrides);
}

export function removeCodexProjectQualificationEvidenceForProject(
  projectIdentityIdInput: string,
  overrides: Pick<Partial<QualificationDependencies>, 'evidenceRoot'> = {},
): number {
  return removeProjectQualificationEvidenceForProject('CODEX', projectIdentityIdInput, overrides);
}

export const __projectQualificationRegistryTest = {
  REQUIRED_PROBES,
  PROJECT_QUALIFICATION_LANES,
  requiredProbesFor,
  codexQualificationIdentity,
  defaultEvidenceRoot,
  evidenceMac,
  evidencePath,
  agentZeroQualificationIdentity,
  nativeCliQualificationIdentity,
  qualificationDefaults,
  attestFinalEvidenceRuntime,
  readEvidence,
  runContainerCommand,
  runDefaultCodexModelProbe,
  runDefaultAgentZeroModelProbe,
  runDefaultNativeCliModelProbe,
  stableSerialize,
  validatePayload,
};

export const __openClawProjectQualificationTest = {
  REQUIRED_PROBES: OPENCLAW_PROJECT_QUALIFICATION_REQUIRED_PROBES,
  evidenceMac,
  evidencePath,
  readEvidence,
  runContainerCommand,
  runDefaultModelProbe,
  stageOpenClawRuntimeChallengeMarker,
  stableSerialize,
  verifyOpenClawModelToolChallenge,
  validatePayload: (
    context: ProjectSandboxExecutionContext,
    egress: ProjectEgressPlaneConfig,
    envelope: OpenClawProjectQualificationEnvelope,
    secret: string,
    now: Date,
  ) => validatePayload('OPENCLAW', context, egress, envelope, secret, now),
};
