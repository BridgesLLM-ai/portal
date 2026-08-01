import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_SCHEMA =
  'bridgesllm.agent-zero-project-model-bridge-credential.v1';
export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION =
  'agent-zero-project-model-bridge-v1';
export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT = 18_991;
export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_DEFAULT_ROOT =
  '/var/lib/bridgesllm/agent-zero-project-model-bridge/credentials';
export const AGENT_ZERO_PROJECT_MODEL_BRIDGE_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60_000;

export const AGENT_ZERO_PROJECT_OAUTH_PROVIDER_IDS = [
  'codex_oauth',
  'github_copilot_oauth',
  'gemini_api_oauth',
  'xai_grok_oauth',
] as const;

export type AgentZeroProjectOAuthProviderId =
  typeof AGENT_ZERO_PROJECT_OAUTH_PROVIDER_IDS[number];

export interface AgentZeroProjectModelSelection {
  providerId: AgentZeroProjectOAuthProviderId;
  model: string;
}

export interface AgentZeroProjectModelBridgeCredentialRecord {
  schema: typeof AGENT_ZERO_PROJECT_MODEL_BRIDGE_SCHEMA;
  policyVersion: typeof AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION;
  projectKey: string;
  actorUserId: string;
  projectIdentityId: string;
  providerId: AgentZeroProjectOAuthProviderId;
  model: string;
  tokenHash: string;
  generation: string;
  issuedAt: string;
  expiresAt: string;
}

export interface AgentZeroProjectModelBridgeCredential {
  token: string;
  record: AgentZeroProjectModelBridgeCredentialRecord;
}

export interface AgentZeroProjectModelBridgeCredentialIdentity {
  projectKey: string;
  actorUserId: string;
  projectIdentityId: string;
}

export interface AgentZeroProjectModelBridgeCredentialOptions {
  credentialRoot?: string;
  now?: () => number;
  tokenFactory?: () => string;
  generationFactory?: () => string;
  ttlMs?: number;
  expectedOwnerUid?: number;
}

const PROJECT_KEY_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^a0p_([a-f0-9]{64})_([A-Za-z0-9_-]{43})$/;
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/;
const GENERATION_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPAQUE_ID_RE = /^[^\u0000-\u001f\u007f]{1,512}$/;
const MODEL_RE = /^[^\u0000-\u001f\u007f\s][^\u0000-\u001f\u007f]{0,199}$/;

function expectedOwnerUid(options: AgentZeroProjectModelBridgeCredentialOptions): number {
  return Number.isSafeInteger(options.expectedOwnerUid)
    ? Number(options.expectedOwnerUid)
    : 0;
}

function requireProjectKey(value: unknown): string {
  const projectKey = String(value || '').trim().toLowerCase();
  if (!PROJECT_KEY_RE.test(projectKey)) throw new Error('Agent Zero model bridge project key is invalid.');
  return projectKey;
}

function requireOpaqueId(value: unknown, label: string): string {
  const normalized = String(value || '').trim();
  if (!OPAQUE_ID_RE.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function requireModel(value: unknown): string {
  const model = String(value || '').trim();
  if (!MODEL_RE.test(model) || model.includes('..')) {
    throw new Error('Agent Zero Project model is invalid.');
  }
  return model;
}

export function normalizeAgentZeroProjectModelSelection(
  value: AgentZeroProjectModelSelection,
): AgentZeroProjectModelSelection {
  const providerId = String(value?.providerId || '').trim() as AgentZeroProjectOAuthProviderId;
  if (!AGENT_ZERO_PROJECT_OAUTH_PROVIDER_IDS.includes(providerId)) {
    throw new Error('Agent Zero Project OAuth provider is unavailable.');
  }
  return Object.freeze({ providerId, model: requireModel(value?.model) });
}

export function agentZeroProjectModelBridgeProviderPath(
  providerId: AgentZeroProjectOAuthProviderId,
): string {
  switch (normalizeAgentZeroProjectModelSelection({ providerId, model: 'validation' }).providerId) {
    case 'codex_oauth': return '/oauth/codex/v1';
    case 'github_copilot_oauth': return '/oauth/github-copilot/v1';
    case 'gemini_api_oauth': return '/oauth/gemini-api/v1';
    case 'xai_grok_oauth': return '/oauth/xai-grok/v1';
  }
}

export function agentZeroProjectModelBridgeApiKeyEnvironmentName(
  providerId: AgentZeroProjectOAuthProviderId,
): string {
  return `API_KEY_${normalizeAgentZeroProjectModelSelection({ providerId, model: 'validation' })
    .providerId.toUpperCase()}`;
}

export function buildAgentZeroProjectModelBridgeBaseUrl(
  bridgeGatewayIpv4: string,
  providerId: AgentZeroProjectOAuthProviderId,
  port = AGENT_ZERO_PROJECT_MODEL_BRIDGE_PORT,
): string {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bridgeGatewayIpv4)
    || bridgeGatewayIpv4.split('.').some((part) => Number(part) > 255)
    || !Number.isSafeInteger(port)
    || port < 1024
    || port > 65_535) {
    throw new Error('Agent Zero Project model bridge endpoint is invalid.');
  }
  return `http://${bridgeGatewayIpv4}:${port}${agentZeroProjectModelBridgeProviderPath(providerId)}`;
}

export function resolveAgentZeroProjectModelBridgeCredentialRoot(override?: string): string {
  const root = path.resolve(
    String(override || process.env.AGENT_ZERO_PROJECT_MODEL_BRIDGE_CREDENTIAL_ROOT
      || AGENT_ZERO_PROJECT_MODEL_BRIDGE_DEFAULT_ROOT).trim(),
  );
  if (!path.isAbsolute(root) || root === path.parse(root).root) {
    throw new Error('Agent Zero Project model bridge credential root is unsafe.');
  }
  return root;
}

export function agentZeroProjectModelBridgeCredentialPath(
  projectKeyInput: string,
  credentialRoot?: string,
): string {
  return path.join(
    resolveAgentZeroProjectModelBridgeCredentialRoot(credentialRoot),
    `${requireProjectKey(projectKeyInput)}.json`,
  );
}

function requireProtectedDirectory(
  directory: string,
  options: AgentZeroProjectModelBridgeCredentialOptions,
  create: boolean,
): void {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== expectedOwnerUid(options)
    || (stat.mode & 0o027) !== 0) {
    throw new Error('Agent Zero Project model bridge credential directory is not protected.');
  }
}

function requireProtectedRecordFile(
  filePath: string,
  options: AgentZeroProjectModelBridgeCredentialOptions,
): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== expectedOwnerUid(options)
    || (stat.mode & 0o037) !== 0) {
    throw new Error('Agent Zero Project model bridge credential record is not protected.');
  }
  return stat;
}

function writeProtectedRecordAtomic(
  filePath: string,
  value: AgentZeroProjectModelBridgeCredentialRecord,
  options: AgentZeroProjectModelBridgeCredentialOptions,
): void {
  const directory = path.dirname(filePath);
  requireProtectedDirectory(directory, options, true);
  const temp = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const descriptor = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o640);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temp, 0o640);
  fs.renameSync(temp, filePath);
  const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

export function hashAgentZeroProjectModelBridgeToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseAgentZeroProjectModelBridgeToken(tokenInput: unknown): {
  token: string;
  projectKey: string;
  tokenHash: string;
} {
  const token = String(tokenInput || '').trim();
  const match = token.match(TOKEN_RE);
  if (!match) throw new Error('Agent Zero Project model bridge credential is invalid.');
  return {
    token,
    projectKey: requireProjectKey(match[1]),
    tokenHash: hashAgentZeroProjectModelBridgeToken(token),
  };
}

function validateRecord(
  value: unknown,
  projectKeyInput: string,
): AgentZeroProjectModelBridgeCredentialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent Zero Project model bridge credential record is malformed.');
  }
  const record = value as Record<string, unknown>;
  const projectKey = requireProjectKey(projectKeyInput);
  const selection = normalizeAgentZeroProjectModelSelection({
    providerId: record.providerId as AgentZeroProjectOAuthProviderId,
    model: String(record.model || ''),
  });
  const tokenHash = String(record.tokenHash || '').trim().toLowerCase();
  const generation = String(record.generation || '').trim();
  const issuedAt = String(record.issuedAt || '');
  const expiresAt = String(record.expiresAt || '');
  if (record.schema !== AGENT_ZERO_PROJECT_MODEL_BRIDGE_SCHEMA
    || record.policyVersion !== AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION
    || requireProjectKey(record.projectKey) !== projectKey
    || !TOKEN_HASH_RE.test(tokenHash)
    || !GENERATION_RE.test(generation)
    || !Number.isFinite(Date.parse(issuedAt))
    || !Number.isFinite(Date.parse(expiresAt))
    || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error('Agent Zero Project model bridge credential record failed validation.');
  }
  return Object.freeze({
    schema: AGENT_ZERO_PROJECT_MODEL_BRIDGE_SCHEMA,
    policyVersion: AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
    projectKey,
    actorUserId: requireOpaqueId(record.actorUserId, 'Agent Zero model bridge actor'),
    projectIdentityId: requireOpaqueId(record.projectIdentityId, 'Agent Zero model bridge project'),
    providerId: selection.providerId,
    model: selection.model,
    tokenHash,
    generation,
    issuedAt,
    expiresAt,
  });
}

export function readAgentZeroProjectModelBridgeCredentialRecord(
  projectKeyInput: string,
  options: AgentZeroProjectModelBridgeCredentialOptions = {},
): AgentZeroProjectModelBridgeCredentialRecord | null {
  const projectKey = requireProjectKey(projectKeyInput);
  const root = resolveAgentZeroProjectModelBridgeCredentialRoot(options.credentialRoot);
  if (!fs.existsSync(root)) return null;
  requireProtectedDirectory(root, options, false);
  const filePath = agentZeroProjectModelBridgeCredentialPath(projectKey, root);
  if (!fs.existsSync(filePath)) return null;
  requireProtectedRecordFile(filePath, options);
  try {
    return validateRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')), projectKey);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Agent Zero Project model bridge credential record is malformed.');
    }
    throw error;
  }
}

export function issueAgentZeroProjectModelBridgeCredential(
  identityInput: AgentZeroProjectModelBridgeCredentialIdentity,
  selectionInput: AgentZeroProjectModelSelection,
  options: AgentZeroProjectModelBridgeCredentialOptions = {},
): AgentZeroProjectModelBridgeCredential {
  const identity = {
    projectKey: requireProjectKey(identityInput.projectKey),
    actorUserId: requireOpaqueId(identityInput.actorUserId, 'Agent Zero model bridge actor'),
    projectIdentityId: requireOpaqueId(identityInput.projectIdentityId, 'Agent Zero model bridge project'),
  };
  const selection = normalizeAgentZeroProjectModelSelection(selectionInput);
  const random = String(options.tokenFactory?.() || crypto.randomBytes(32).toString('base64url'));
  if (!/^[A-Za-z0-9_-]{43}$/.test(random)) {
    throw new Error('Agent Zero Project model bridge token factory returned unsafe entropy.');
  }
  const token = `a0p_${identity.projectKey}_${random}`;
  const tokenHash = hashAgentZeroProjectModelBridgeToken(token);
  const now = (options.now || Date.now)();
  const ttlMs = options.ttlMs || AGENT_ZERO_PROJECT_MODEL_BRIDGE_CREDENTIAL_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 365 * 24 * 60 * 60_000) {
    throw new Error('Agent Zero Project model bridge credential TTL is invalid.');
  }
  const generation = String(options.generationFactory?.() || crypto.randomUUID());
  if (!GENERATION_RE.test(generation)) {
    throw new Error('Agent Zero Project model bridge generation is invalid.');
  }
  const record: AgentZeroProjectModelBridgeCredentialRecord = Object.freeze({
    schema: AGENT_ZERO_PROJECT_MODEL_BRIDGE_SCHEMA,
    policyVersion: AGENT_ZERO_PROJECT_MODEL_BRIDGE_POLICY_VERSION,
    ...identity,
    providerId: selection.providerId,
    model: selection.model,
    tokenHash,
    generation,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
  writeProtectedRecordAtomic(
    agentZeroProjectModelBridgeCredentialPath(identity.projectKey, options.credentialRoot),
    record,
    options,
  );
  return Object.freeze({ token, record });
}

function timingSafeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length === 32
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function authenticateAgentZeroProjectModelBridgeCredential(
  tokenInput: unknown,
  providerIdInput: AgentZeroProjectOAuthProviderId,
  options: AgentZeroProjectModelBridgeCredentialOptions = {},
): AgentZeroProjectModelBridgeCredentialRecord | null {
  let parsed: ReturnType<typeof parseAgentZeroProjectModelBridgeToken>;
  let selection: AgentZeroProjectModelSelection;
  try {
    parsed = parseAgentZeroProjectModelBridgeToken(tokenInput);
    selection = normalizeAgentZeroProjectModelSelection({ providerId: providerIdInput, model: 'validation' });
  } catch {
    return null;
  }
  const record = readAgentZeroProjectModelBridgeCredentialRecord(parsed.projectKey, options);
  const now = (options.now || Date.now)();
  return record
    && record.providerId === selection.providerId
    && Date.parse(record.issuedAt) <= now
    && Date.parse(record.expiresAt) > now
    && timingSafeHashEqual(record.tokenHash, parsed.tokenHash)
      ? record
      : null;
}

export function revokeAgentZeroProjectModelBridgeCredential(
  projectKeyInput: string,
  options: AgentZeroProjectModelBridgeCredentialOptions = {},
): boolean {
  const projectKey = requireProjectKey(projectKeyInput);
  const filePath = agentZeroProjectModelBridgeCredentialPath(projectKey, options.credentialRoot);
  if (!fs.existsSync(filePath)) return false;
  readAgentZeroProjectModelBridgeCredentialRecord(projectKey, options);
  fs.unlinkSync(filePath);
  return true;
}

export const __agentZeroProjectModelBridgeCredentialTest = {
  TOKEN_RE,
  validateRecord,
};
