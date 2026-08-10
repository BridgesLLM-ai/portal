import { createHash } from 'crypto';
import { isIP } from 'net';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { configuredAppContentOrigin, configuredPortalOrigin } from '../utils/appContentSecurity';

export const EMBED_SECURITY_POLICY_SETTING_KEY = 'security.embedOrigins.v1';
export const EMBED_SECURITY_POLICY_VERSION = 1 as const;
export const MAX_CUSTOM_EMBED_ORIGINS = 32;
export const MAX_EMBED_ORIGIN_BYTES = 512;
export const MAX_EMBED_SECURITY_POLICY_BYTES = 8192;

export const DEFAULT_EMBED_SECURITY_POLICY_ENTRIES = Object.freeze([
  Object.freeze({ origin: 'https://www.youtube.com', camera: false, microphone: false }),
  Object.freeze({ origin: 'https://www.youtube-nocookie.com', camera: false, microphone: false }),
]);

// Keep non-public namespaces out of browser framing and feature delegation.
// `arpa` covers home.arpa plus the other IANA special-use infrastructure
// names; `alt` and `example` are reserved pseudo-TLDs. The remaining suffixes
// are common local/private namespaces that browsers or local resolvers may
// treat specially.
const BLOCKED_EMBED_HOST_SUFFIXES = Object.freeze([
  'alt',
  'arpa',
  'example',
  'home',
  'internal',
  'invalid',
  'lan',
  'local',
  'localdomain',
  'localhost',
  'onion',
  'test',
]);

export type EmbedSecurityPolicyEntry = {
  origin: string;
  camera: boolean;
  microphone: boolean;
};

export type EmbedSecurityPolicyState = {
  version: typeof EMBED_SECURITY_POLICY_VERSION;
  revision: string;
  status: 'ready' | 'invalid';
  entries: EmbedSecurityPolicyEntry[];
  defaultOrigins: readonly string[];
  /** Compatibility for a previously served Settings bundle. No origins are immutable. */
  builtInOrigins: readonly string[];
  limits: {
    maxOrigins: number;
    maxOriginBytes: number;
    maxPolicyBytes: number;
  };
  updatedAt: string | null;
  warning?: string;
};

type StoredPolicy = {
  version: typeof EMBED_SECURITY_POLICY_VERSION;
  entries: EmbedSecurityPolicyEntry[];
};

type StoredPolicyRow = {
  value: string;
  updatedAt: Date;
};

type SystemSettingReader = {
  systemSetting: {
    findUnique(args: unknown): Promise<StoredPolicyRow | null>;
  };
};

const INVALID_POLICY_WARNING =
  'The saved embed-origin policy is invalid. Third-party origins are disabled until the Owner replaces it.';

export class EmbedSecurityPolicyValidationError extends Error {}

export class EmbedSecurityPolicyRevisionConflictError extends Error {
  constructor() {
    super('The embed-origin policy changed in another session. Reload it before saving.');
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function normalizeEmbedOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    throw new EmbedSecurityPolicyValidationError('Each embed origin must be a URL.');
  }
  const candidate = value.trim();
  if (!candidate || utf8Bytes(candidate) > MAX_EMBED_ORIGIN_BYTES) {
    throw new EmbedSecurityPolicyValidationError(
      `Embed origins must be between 1 and ${MAX_EMBED_ORIGIN_BYTES} UTF-8 bytes.`,
    );
  }
  if (!/^https:\/\//i.test(candidate)) {
    throw new EmbedSecurityPolicyValidationError('Embed origins must use HTTPS.');
  }
  if (/[\u0000-\u0020\u007f\\]/.test(candidate)) {
    throw new EmbedSecurityPolicyValidationError(
      'Embed origins cannot contain spaces, control characters, or backslashes.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new EmbedSecurityPolicyValidationError('Enter a valid HTTPS origin, such as https://video.example.com.');
  }

  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.origin === 'null') {
    throw new EmbedSecurityPolicyValidationError('Embed origins must use HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new EmbedSecurityPolicyValidationError('Embed origins cannot contain a username or password.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new EmbedSecurityPolicyValidationError('Enter only the origin, without a path, query, or fragment.');
  }
  if (parsed.hostname.includes('*')) {
    throw new EmbedSecurityPolicyValidationError('Wildcard embed origins are not allowed. Add each exact origin.');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.port) {
    throw new EmbedSecurityPolicyValidationError('Embed origins must use the standard HTTPS port.');
  }
  if (isIP(hostname.replace(/^\[|\]$/g, '')) || hostname.endsWith('.')) {
    throw new EmbedSecurityPolicyValidationError('Embed origins must use a DNS hostname, not an IP address.');
  }
  const labels = hostname.split('.');
  if (hostname.length > 253
      || labels.length < 2
      || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new EmbedSecurityPolicyValidationError('Embed origins must use a valid DNS hostname.');
  }
  if (BLOCKED_EMBED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  )) {
    throw new EmbedSecurityPolicyValidationError(
      'Private and special-use hostnames cannot be used as embed origins.',
    );
  }

  const authorityRemainder = candidate.slice('https://'.length).replace(/^[^/?#]*/i, '');
  if (authorityRemainder !== '' && authorityRemainder !== '/') {
    throw new EmbedSecurityPolicyValidationError('Enter only the origin, without a path, query, or fragment.');
  }
  if (utf8Bytes(parsed.origin) > MAX_EMBED_ORIGIN_BYTES) {
    throw new EmbedSecurityPolicyValidationError(
      `Embed origins must be no more than ${MAX_EMBED_ORIGIN_BYTES} UTF-8 bytes.`,
    );
  }
  const canonicalOrigin = parsed.origin;
  if (canonicalOrigin === configuredPortalOrigin() || canonicalOrigin === configuredAppContentOrigin()) {
    throw new EmbedSecurityPolicyValidationError('Portal-owned origins cannot be added as third-party embed origins.');
  }
  return canonicalOrigin;
}

export function normalizeEmbedSecurityPolicyEntries(value: unknown): EmbedSecurityPolicyEntry[] {
  if (!Array.isArray(value)) {
    throw new EmbedSecurityPolicyValidationError('Embed origins must be an array.');
  }
  if (value.length > MAX_CUSTOM_EMBED_ORIGINS) {
    throw new EmbedSecurityPolicyValidationError(
      `No more than ${MAX_CUSTOM_EMBED_ORIGINS} embed origins are allowed.`,
    );
  }

  const seen = new Set<string>();
  const entries = value.map((raw): EmbedSecurityPolicyEntry => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new EmbedSecurityPolicyValidationError('Each embed-origin entry must be an object.');
    }
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'camera,microphone,origin') {
      throw new EmbedSecurityPolicyValidationError('Embed-origin entries contain unsupported fields.');
    }
    if (typeof record.camera !== 'boolean' || typeof record.microphone !== 'boolean') {
      throw new EmbedSecurityPolicyValidationError('Camera and microphone permissions must be true or false.');
    }
    const origin = normalizeEmbedOrigin(record.origin);
    if (seen.has(origin)) {
      throw new EmbedSecurityPolicyValidationError(`${origin} is listed more than once.`);
    }
    seen.add(origin);
    return {
      origin,
      camera: record.camera,
      microphone: record.microphone,
    };
  });

  return entries.sort((left, right) => left.origin.localeCompare(right.origin));
}

export function serializeEmbedSecurityPolicy(entries: EmbedSecurityPolicyEntry[]): string {
  const stored: StoredPolicy = {
    version: EMBED_SECURITY_POLICY_VERSION,
    entries: normalizeEmbedSecurityPolicyEntries(entries),
  };
  const serialized = JSON.stringify(stored);
  if (utf8Bytes(serialized) > MAX_EMBED_SECURITY_POLICY_BYTES) {
    throw new EmbedSecurityPolicyValidationError(
      `The complete embed-origin policy must be no more than ${MAX_EMBED_SECURITY_POLICY_BYTES} UTF-8 bytes.`,
    );
  }
  return serialized;
}

export function parseStoredEmbedSecurityPolicy(value: string): EmbedSecurityPolicyEntry[] {
  if (utf8Bytes(value) > MAX_EMBED_SECURITY_POLICY_BYTES) {
    throw new EmbedSecurityPolicyValidationError('The stored embed-origin policy is too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new EmbedSecurityPolicyValidationError('The stored embed-origin policy is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EmbedSecurityPolicyValidationError('The stored embed-origin policy is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'entries,version'
      || record.version !== EMBED_SECURITY_POLICY_VERSION) {
    throw new EmbedSecurityPolicyValidationError('The stored embed-origin policy version is unsupported.');
  }
  return normalizeEmbedSecurityPolicyEntries(record.entries);
}

function revisionForRow(row: StoredPolicyRow | null): string {
  const digest = createHash('sha256');
  if (!row) return digest.update('embed-security-policy:absent:v1').digest('hex');
  return digest
    .update('embed-security-policy:present:v1\0')
    .update(row.updatedAt.toISOString())
    .update('\0')
    .update(row.value)
    .digest('hex');
}

function stateForRow(row: StoredPolicyRow | null): EmbedSecurityPolicyState {
  let entries: EmbedSecurityPolicyEntry[] = row
    ? []
    : DEFAULT_EMBED_SECURITY_POLICY_ENTRIES.map((entry) => ({ ...entry }));
  let status: EmbedSecurityPolicyState['status'] = 'ready';
  let warning: string | undefined;
  if (row) {
    try {
      entries = parseStoredEmbedSecurityPolicy(row.value);
    } catch {
      status = 'invalid';
      warning = INVALID_POLICY_WARNING;
    }
  }
  return {
    version: EMBED_SECURITY_POLICY_VERSION,
    revision: revisionForRow(row),
    status,
    entries,
    defaultOrigins: DEFAULT_EMBED_SECURITY_POLICY_ENTRIES.map((entry) => entry.origin),
    builtInOrigins: [],
    limits: {
      maxOrigins: MAX_CUSTOM_EMBED_ORIGINS,
      maxOriginBytes: MAX_EMBED_ORIGIN_BYTES,
      maxPolicyBytes: MAX_EMBED_SECURITY_POLICY_BYTES,
    },
    updatedAt: row?.updatedAt.toISOString() ?? null,
    ...(warning ? { warning } : {}),
  };
}

export async function readEmbedSecurityPolicyState(
  database: SystemSettingReader = prisma as unknown as SystemSettingReader,
): Promise<EmbedSecurityPolicyState> {
  const row = await database.systemSetting.findUnique({
    where: { key: EMBED_SECURITY_POLICY_SETTING_KEY },
    select: { value: true, updatedAt: true },
  });
  return stateForRow(row);
}

export function buildPortalContentSecurityPolicyDirectives(
  customFrameOrigins: readonly string[] = [],
): Record<string, string[] | null> {
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.jsdelivr.net', 'https://cdn.sheetjs.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
    fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
    connectSrc: ["'self'", 'wss:', 'ws:'],
    mediaSrc: ["'self'", 'blob:', 'data:'],
    workerSrc: ["'self'", 'blob:'],
    frameSrc: ["'self'", 'blob:', 'data:', ...customFrameOrigins],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    upgradeInsecureRequests: process.env.CORS_ORIGIN?.startsWith('https') ? [] : null,
  };
}

export function buildAppContentPermissionsPolicy(entries: readonly EmbedSecurityPolicyEntry[]): string {
  const allowlist = (permission: 'camera' | 'microphone'): string => {
    const origins = entries
      .filter((entry) => entry[permission])
      .map((entry) => `"${entry.origin}"`);
    return origins.length > 0 ? `(${origins.join(' ')})` : '()';
  };
  return [
    `camera=${allowlist('camera')}`,
    `microphone=${allowlist('microphone')}`,
    'geolocation=()',
    'payment=()',
    'usb=()',
  ].join(', ');
}

let runtimeEntries: EmbedSecurityPolicyEntry[] = [];
let runtimePermissionsPolicy = buildAppContentPermissionsPolicy(runtimeEntries);
let runtimeCspMiddleware = helmet.contentSecurityPolicy({
  directives: buildPortalContentSecurityPolicyDirectives() as any,
});

function installRuntimeEntries(entries: readonly EmbedSecurityPolicyEntry[]): void {
  runtimeEntries = entries.map((entry) => ({ ...entry }));
  runtimePermissionsPolicy = buildAppContentPermissionsPolicy(runtimeEntries);
  runtimeCspMiddleware = helmet.contentSecurityPolicy({
    directives: buildPortalContentSecurityPolicyDirectives(
      runtimeEntries.map((entry) => entry.origin),
    ) as any,
  });
}

export function installRuntimeEmbedSecurityPolicy(entries: readonly EmbedSecurityPolicyEntry[]): void {
  installRuntimeEntries(normalizeEmbedSecurityPolicyEntries(entries));
}

export function getRuntimeEmbedSecurityPolicy(): EmbedSecurityPolicyEntry[] {
  return runtimeEntries.map((entry) => ({ ...entry }));
}

export async function initializeEmbedSecurityPolicy(): Promise<EmbedSecurityPolicyState> {
  const state = await readEmbedSecurityPolicyState();
  installRuntimeEntries(state.status === 'ready' ? state.entries : []);
  if (state.status === 'invalid') {
    console.warn('[Embed Security] Saved policy is invalid; third-party origins are disabled until the Owner replaces it.');
  }
  return state;
}

export function applyAppContentEmbedSecurityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  runtimeCspMiddleware(req, res, (error?: Error) => {
    if (error) {
      next(error);
      return;
    }
    res.setHeader('Permissions-Policy', runtimePermissionsPolicy);
    next();
  });
}

export function preserveAppContentSecurityHeadersOnProxy(
  upstreamHeaders: Record<string, string | string[] | number | undefined>,
  response: Pick<Response, 'getHeader'>,
): void {
  const portalCsp = response.getHeader('Content-Security-Policy');
  if (portalCsp) {
    const upstreamCsp = upstreamHeaders['content-security-policy'];
    const policies = [portalCsp, upstreamCsp]
      .flat()
      .filter((value): value is string | number => value !== undefined)
      .map(String);
    upstreamHeaders['content-security-policy'] = policies;
  }
  const permissionsPolicy = response.getHeader('Permissions-Policy');
  if (permissionsPolicy) {
    upstreamHeaders['permissions-policy'] = String(permissionsPolicy);
  }
}

type UpdateEmbedSecurityPolicyInput = {
  expectedRevision: string;
  entries: EmbedSecurityPolicyEntry[];
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

function entryMap(entries: readonly EmbedSecurityPolicyEntry[]): Map<string, EmbedSecurityPolicyEntry> {
  return new Map(entries.map((entry) => [entry.origin, entry]));
}

function auditDiff(before: readonly EmbedSecurityPolicyEntry[], after: readonly EmbedSecurityPolicyEntry[]) {
  const prior = entryMap(before);
  const next = entryMap(after);
  const added = after.filter((entry) => !prior.has(entry.origin));
  const removed = before.filter((entry) => !next.has(entry.origin));
  const changed = after.filter((entry) => {
    const old = prior.get(entry.origin);
    return old && (old.camera !== entry.camera || old.microphone !== entry.microphone);
  });
  return { added, removed, changed };
}

let embedPolicyMutationTail: Promise<void> = Promise.resolve();

async function withEmbedPolicyMutationFence<T>(operation: () => Promise<T>): Promise<T> {
  const previous = embedPolicyMutationTail;
  let release!: () => void;
  embedPolicyMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function updateEmbedSecurityPolicy(
  input: UpdateEmbedSecurityPolicyInput,
): Promise<EmbedSecurityPolicyState> {
  return withEmbedPolicyMutationFence(async () => {
    const entries = normalizeEmbedSecurityPolicyEntries(input.entries);
    const serialized = serializeEmbedSecurityPolicy(entries);
    try {
      const outcome = await prisma.$transaction(async (transaction) => {
        const currentRow = await transaction.systemSetting.findUnique({
          where: { key: EMBED_SECURITY_POLICY_SETTING_KEY },
          select: { value: true, updatedAt: true },
        });
        const currentState = stateForRow(currentRow);
        if (currentState.revision !== input.expectedRevision) {
          throw new EmbedSecurityPolicyRevisionConflictError();
        }
        if (currentState.status === 'ready' && currentRow?.value === serialized) {
          return { state: currentState, changed: false };
        }

        const storedRow = await transaction.systemSetting.upsert({
          where: { key: EMBED_SECURITY_POLICY_SETTING_KEY },
          update: { value: serialized },
          create: { key: EMBED_SECURITY_POLICY_SETTING_KEY, value: serialized },
          select: { value: true, updatedAt: true },
        });
        const diff = auditDiff(currentState.status === 'ready' ? currentState.entries : [], entries);
        await transaction.activityLog.create({
          data: {
            userId: input.actorUserId,
            action: 'EMBED_SECURITY_POLICY_UPDATED',
            resource: 'security',
            resourceId: EMBED_SECURITY_POLICY_SETTING_KEY,
            severity: 'INFO',
            ipAddress: input.ipAddress || null,
            userAgent: input.userAgent || null,
            translatedMessage: 'Owner updated hosted-app embed origins',
            metadata: {
              recoveredInvalidPolicy: currentState.status === 'invalid',
              added: diff.added,
              removed: diff.removed,
              changed: diff.changed,
            },
          },
        });
        return { state: stateForRow(storedRow), changed: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      installRuntimeEntries(outcome.state.entries);
      return outcome.state;
    } catch (error: any) {
      if (error instanceof EmbedSecurityPolicyRevisionConflictError) throw error;
      if (error?.code === 'P2002' || error?.code === 'P2034') {
        throw new EmbedSecurityPolicyRevisionConflictError();
      }
      throw error;
    }
  });
}
