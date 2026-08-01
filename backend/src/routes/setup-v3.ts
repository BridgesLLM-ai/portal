/**
 * Setup Wizard v3 — Backend Routes
 * 
 * Handles the browser-based setup wizard that runs after the CLI installer.
 * Zero terminal interaction — everything configurable happens here.
 * 
 * All routes (except /status) are guarded by requireSetupPending,
 * which blocks access once an OWNER account exists.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { recycleStalwartContainerPreservingData } from '../services/stalwartRecovery';
import dns from 'dns/promises';
import { prisma } from '../config/database';
import { hashPassword, validatePasswordStrength } from '../utils/password';
import { PORTAL_VERSION } from '../version';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';
import { APPEARANCE_DEFAULTS, SECURITY_DEFAULTS } from '../config/settings.schema';
import multer from 'multer';
import { clearAuthCookies, setAuthCookies } from '../utils/authCookies';
import { provisionUserMailbox } from '../services/userMailService';
import {
  configureDomainAndHttps,
  getCodingToolsStatus,
  getPublicIp,
  installCodingTool,
  removePortalSetupIpAccess,
  updateEnvFile,
} from '../utils/serverSetup';
import { getOllamaRecommendationsByRam, isValidOllamaModelName, readAvailableMemoryBytes } from '../utils/ollamaRecommendations';
import { isReservedSystemMailboxUsername } from '../utils/reservedMailboxUsernames';
import crypto from 'crypto';
import {
  BRANDING_DIR,
  UnsafeImageUploadError,
  cleanupBasenamePrefixVariants,
  normalizeBrandingLogoToPng,
} from '../services/imageAssets';
import {
  SETUP_BOOTSTRAP_HEADER,
  SETUP_HANDOFF_HEADER,
  SETUP_HANDOFF_TTL_SECONDS,
  SETUP_SESSION_TTL_SECONDS,
  SETUP_STATE_COMPLETE,
  SETUP_STATE_KEY,
  classifySetupTransport,
  classifySetupProgress,
  hashSetupCredential,
  setupBrowserContextMatches,
  validateSetupBootstrapCredential,
  validateSetupLogoUrl,
  validateSetupSessionCredential,
} from '../services/setupHardening';
import {
  getStalwartDkimSigningConfig,
  provisionStalwartDkim,
  readStoredStalwartDkimRecords,
  type StalwartDkimDnsRecord,
} from '../services/stalwartDkim';
import { getOpenClawSetupReadiness } from '../services/openclawSetupReadiness';
import { digestAuthToken } from '../utils/authSecrets';
import { canonicalEmail } from '../utils/identity';
import {
  OllamaPullBusyError,
  type OllamaPullSnapshot,
} from '../services/ollamaPullManager';
import { setupLocalOllamaPullManager } from '../services/setupLocalOllamaPullManager';
import { DEFAULT_LOCAL_OLLAMA_ENDPOINT } from '../utils/localOllamaEndpoint';
import { requestLocalOllamaJson } from '../services/localOllamaTransport';
import {
  OLLAMA_TAILNET_ONBOARDING_KEY,
  OLLAMA_TAILNET_ONBOARDING_PHASE,
  normalizeOllamaTailnetOnboardingPhase,
} from '../services/ollamaTailnetOnboarding';
import {
  configuredPortalOriginMode,
  getPortalFeatureCapabilities,
  portalFeatureUnavailableResponse,
} from '../utils/portalFeatureCapabilities';
import { assertNoProjectAuthorizationTransitionActive } from '../services/projectAuthorizationTransition';
import { publishAuthorizationChanged } from '../services/authorizationChangeBus';

const router = Router();

const PORTAL_ROOT = process.env.PORTAL_ROOT || '/opt/bridgesllm/portal';
const INSTALL_ROOT = path.dirname(PORTAL_ROOT);
const SETUP_COMPLETION_LOCK_ID = '743825119402031';
const SETUP_ENV_KEYS = [
  'SETUP_TOKEN',
  'SETUP_TOKEN_EXPIRES_AT',
  'SETUP_TOKEN_USED_AT',
  'SETUP_SESSION_TOKEN_HASH',
  'SETUP_SESSION_ORIGIN',
  'SETUP_SESSION_EXPIRES_AT',
  'SETUP_HANDOFF_TOKEN_HASH',
  'SETUP_HANDOFF_ORIGIN',
  'SETUP_HANDOFF_EXPIRES_AT',
] as const;
type SetupEnvKey = typeof SETUP_ENV_KEYS[number];

// ═══════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════

const completeSetupSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100).transform(n => n.trim()),
  email: z.string().email('Invalid email').transform(canonicalEmail),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  portalName: z.string().min(2).max(120).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accentColor must be a hex color').optional(),
  logoUrl: z.string().max(240).optional(),
  registrationMode: z.enum(['open', 'approval', 'closed']).optional(),
  allowTelemetry: z.boolean().optional(),
  searchEngineVisibility: z.enum(['visible', 'hidden']).optional(),
  tailnetRequested: z.boolean().optional().default(false),
});

const testEmailSchema = z.object({
  email: z.string().email('Invalid email'),
});

const tailnetOnboardingSchema = z.object({
  requested: z.boolean(),
});

const configureDomainSchema = z.object({
  domain: z.string()
    .min(3)
    .max(253)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Invalid domain format'),
});

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════


async function createUniqueUsername(
  baseName: string,
  email: string,
  db: Pick<typeof prisma, 'user'> = prisma,
): Promise<string> {
  const fromName = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const fromEmail = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const base = fromName || fromEmail || 'admin';

  let candidate = base;
  let suffix = 1;
  while (true) {
    if (!isReservedSystemMailboxUsername(candidate)) {
      const existing = await db.user.findUnique({ where: { username: candidate } });
      if (!existing) return candidate;
    }
    suffix += 1;
    candidate = `${base}${suffix}`.slice(0, 30);
  }
}

function getDomain(req?: Request): string {
  // A private ts.net machine name is an access origin, not a public mail
  // domain. Never let CORS/request-host inference promote it into MX authority.
  if (configuredPortalOriginMode() === 'tailnet') return '';
  const corsOrigin = process.env.CORS_ORIGIN || '';
  if (corsOrigin) {
    try {
      const url = new URL(corsOrigin.split(',')[0]);
      if (url.hostname !== getPublicIp() && url.hostname !== 'localhost') {
        return url.hostname;
      }
    } catch { /* fall through */ }
  }
  if (req?.hostname && req.hostname !== 'localhost' && req.hostname !== getPublicIp()) {
    return req.hostname;
  }
  return '';
}



async function waitForStalwartJmap(timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:8580/.well-known/jmap', { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return false;
}

async function checkStalwartHealth(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:8580/.well-known/jmap', { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

function recycleStalwartForRecovery(mailDir: string): void {
  console.warn('[setup/install-mail] Recycling the Stalwart container while preserving stored mail');
  recycleStalwartContainerPreservingData(mailDir);
}

/**
 * Register a domain in Stalwart's internal directory.
 * This MUST be called before creating any accounts for that domain.
 * Stalwart returns "notFound: <domain>" on account creation if the domain doesn't exist.
 */
async function ensureStalwartDomain(domain: string, adminPass: string): Promise<{ ok: boolean; error?: string }> {
  const authHeader = `Basic ${Buffer.from(`admin:${adminPass}`).toString('base64')}`;

  // Check if domain already exists
  try {
    const check = await fetch(`http://127.0.0.1:8580/api/principal/${encodeURIComponent(domain)}`, {
      headers: { 'Authorization': authHeader },
      signal: AbortSignal.timeout(5000),
    });
    if (check.ok) {
      const data: any = await check.json().catch(() => null);
      if (data?.data?.type === 'domain') return { ok: true }; // Already exists
    }
  } catch {}

  // Create the domain principal
  try {
    const response = await fetch('http://127.0.0.1:8580/api/principal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({ type: 'domain', name: domain, description: 'BridgesLLM Portal' }),
      signal: AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    if (!response.ok && response.status !== 409) { // 409 = already exists
      return { ok: false, error: `Failed to create domain: ${body?.error || raw || response.status}` };
    }
    if (body && typeof body === 'object' && body.error && body.error !== 'alreadyExists') {
      return { ok: false, error: `Domain creation error: ${body.error}` };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: `Domain creation request failed: ${error?.message}` };
  }
}

async function createStalwartAccount(domain: string, adminPass: string, name: string, pass: string): Promise<{ ok: boolean; error?: string; body?: any }> {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(`admin:${adminPass}`).toString('base64')}`,
  };
  try {
    const response = await fetch('http://127.0.0.1:8580/api/principal', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'individual',
        name,
        secrets: [pass],
        emails: [`${name}@${domain}`],
        roles: ['user'],
        description: name === 'noreply' ? 'System Alerts' : name === 'support' ? 'Support' : name,
        quota: 1024 * 1024 * 1024, // 1 GB
      }),
      signal: AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    const alreadyExists = response.status === 409
      || (body && typeof body === 'object' && body.error === 'fieldAlreadyExists');
    if (alreadyExists) {
      // Idempotent setup: converge a pre-existing account to the requested
      // credentials/address instead of failing the mail installation.
      const patch = await fetch(`http://127.0.0.1:8580/api/principal/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify([
          { action: 'set', field: 'secrets', value: [pass] },
          { action: 'set', field: 'emails', value: [`${name}@${domain}`] },
        ]),
        signal: AbortSignal.timeout(10000),
      });
      const patchRaw = await patch.text();
      let patchBody: any = null;
      try { patchBody = patchRaw ? JSON.parse(patchRaw) : null; } catch { patchBody = patchRaw; }
      if (!patch.ok || (patchBody && typeof patchBody === 'object' && patchBody.error)) {
        return { ok: false, error: `existing account update failed: ${patchBody && typeof patchBody === 'object' && patchBody.error ? String(patchBody.error) : `HTTP ${patch.status}`}`, body: patchBody };
      }
      return { ok: true, body: patchBody };
    }

    if (!response.ok) {
      return { ok: false, error: typeof body === 'object' && body?.error ? String(body.error) : raw || `HTTP ${response.status}`, body };
    }
    if (body && typeof body === 'object' && 'error' in body && body.error) {
      return { ok: false, error: String(body.error) + (body.item ? `: ${body.item}` : ''), body };
    }
    return { ok: true, body };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Request failed' };
  }
}
/**
 * Guard: block all routes except /status when setup is done.
 */
export async function requireSetupPending(_req: Request, _res: Response, next: NextFunction) {
  try {
    const ownerCount = await prisma.user.count({ where: { role: 'OWNER' as any } });
    if (ownerCount > 0) {
      throw new AppError(403, 'Setup already completed');
    }
    next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    next(error);
  }
}

function setupTransportForRequest(req: Request) {
  return classifySetupTransport({
    protocol: req.protocol,
    host: req.get('host') || '',
    requestIp: req.ip,
    remoteAddress: req.socket.remoteAddress,
  });
}

function assertSecureSetupBrowserRequest(req: Request, options: { httpsOnly?: boolean } = {}) {
  const transport = setupTransportForRequest(req);
  if (!transport.allowed || (options.httpsOnly && transport.kind !== 'https')) {
    throw new AppError(426, options.httpsOnly
      ? 'This setup handoff must be completed on the verified HTTPS domain.'
      : transport.reason || 'Sensitive setup is allowed only through verified HTTPS or the installer SSH tunnel.');
  }
  if (!setupBrowserContextMatches({
    transport,
    method: req.method,
    originHeader: req.get('origin'),
    fetchSiteHeader: req.get('sec-fetch-site'),
  })) {
    throw new AppError(403, 'Setup request origin could not be verified. Open setup from the installer link in the same browser origin.');
  }
  return transport;
}

function bearerSetupToken(req: Request): string {
  const authorization = String(req.headers.authorization || '');
  const match = /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(authorization);
  return match?.[1] || '';
}

function setupCredentialError(code: string, subject: string): AppError {
  if (code === 'expired') {
    return new AppError(410, `${subject} expired. Re-run the installer with --reinstall to mint a new protected setup link.`);
  }
  if (code === 'replayed') {
    return new AppError(409, `${subject} was already exchanged. Resume this browser tab or re-run the installer with --reinstall.`);
  }
  if (code === 'misconfigured') {
    return new AppError(503, `${subject} is unavailable. Re-run the installer to resume setup safely.`);
  }
  if (code === 'origin') {
    return new AppError(403, `${subject} belongs to a different setup origin.`);
  }
  return new AppError(403, `Invalid or missing ${subject.toLowerCase()}. Use the protected link printed by the installer.`);
}

/**
 * Guard: validate the short-lived setup bearer minted by /bootstrap. The raw
 * installer bootstrap secret is never accepted here, in query parameters, or
 * from a public HTTP origin.
 */
export function requireSetupToken(req: Request, res: Response, next: NextFunction) {
  try {
    const transport = assertSecureSetupBrowserRequest(req);
    const validation = validateSetupSessionCredential({
      providedToken: bearerSetupToken(req),
      expectedTokenHash: process.env.SETUP_SESSION_TOKEN_HASH,
      expectedOrigin: process.env.SETUP_SESSION_ORIGIN,
      requestOrigin: transport.origin,
      expiresAt: process.env.SETUP_SESSION_EXPIRES_AT,
    });
    if (!validation.ok) throw setupCredentialError(validation.code, 'Setup session');
    noStoreSetupResponse(res);
    next();
  } catch (error) {
    next(error);
  }
}

function persistSetupEnvironment(updates: Partial<Record<SetupEnvKey, string | undefined>>): void {
  const envPath = path.join(PORTAL_ROOT, 'backend', '.env.production');
  if (!fs.existsSync(envPath)) {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError(503, 'Setup state file is unavailable. Re-run the installer.');
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return;
  }

  let content = fs.readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    if (!(SETUP_ENV_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Refusing unsupported setup environment key: ${key}`);
    }
    const linePattern = new RegExp(`^${key}=.*(?:\\n|$)`, 'gm');
    content = content.replace(linePattern, '');
    if (value !== undefined) {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${key}=${value}\n`;
    }
  }

  const stagedPath = `${envPath}.setup-state-${process.pid}-${crypto.randomUUID()}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(stagedPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const stagedFd = fs.openSync(stagedPath, 'r');
    try { fs.fsyncSync(stagedFd); } finally { fs.closeSync(stagedFd); }
    fs.renameSync(stagedPath, envPath);
    renamed = true;
    // Once rename succeeds, the in-memory replay boundary must advance even
    // if a later chmod/directory-fsync diagnostic fails.
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.chmodSync(envPath, 0o600);
    const directoryFd = fs.openSync(path.dirname(envPath), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(stagedPath); } catch {}
    }
  }

}

function noStoreSetupResponse(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function assertSetupBootstrapOpen(): Promise<void> {
  const [ownerCount, setupStateRow] = await Promise.all([
    prisma.user.count({ where: { role: 'OWNER' as any } }),
    prisma.systemSetting.findUnique({ where: { key: SETUP_STATE_KEY } }),
  ]);
  const progress = classifySetupProgress({
    ownerCount,
    setupState: setupStateRow?.value,
    hasSetupToken: !!process.env.SETUP_TOKEN,
  });
  if (progress.setupComplete || (!progress.needsSetup && !progress.isReinstall)) {
    throw new AppError(403, 'Initial setup is already complete.');
  }
}

/**
 * Stage removal of SETUP_TOKEN before the database commit. The final rename is
 * atomic and happens only after the owner/settings/session transaction commits;
 * a database rollback aborts the staged file and leaves setup resumable.
 */
function prepareSetupTokenRemoval(): { commit: () => void; abort: () => void } {
  const envPath = path.join(PORTAL_ROOT, 'backend', '.env.production');
  if (!fs.existsSync(envPath)) {
    return {
      commit: () => {
        for (const key of SETUP_ENV_KEYS) delete process.env[key];
      },
      abort: () => undefined,
    };
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  let sanitized = content.replace(/^# One-time setup token.*\n?/m, '');
  for (const key of SETUP_ENV_KEYS) {
    sanitized = sanitized.replace(new RegExp(`^${key}=.*\\n?`, 'm'), '');
  }
  const stagedPath = `${envPath}.setup-${process.pid}-${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(stagedPath, sanitized, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  const stagedFd = fs.openSync(stagedPath, 'r');
  try {
    fs.fsyncSync(stagedFd);
  } finally {
    fs.closeSync(stagedFd);
  }

  let settled = false;
  return {
    commit: () => {
      if (settled) return;
      fs.renameSync(stagedPath, envPath);
      fs.chmodSync(envPath, 0o600);
      for (const key of SETUP_ENV_KEYS) delete process.env[key];
      settled = true;
    },
    abort: () => {
      if (settled) return;
      try { fs.unlinkSync(stagedPath); } catch {}
      settled = true;
    },
  };
}

const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, parts: 6 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new AppError(400, 'Only PNG, JPEG, WebP, and GIF raster logos are supported.'));
    }
    cb(null, true);
  },
});


// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

function maskOwnerHint(email?: string | null, username?: string | null): string | undefined {
  const trimmedEmail = (email || '').trim();
  if (trimmedEmail.includes('@')) {
    const [localPart, domainPart] = trimmedEmail.split('@');
    if (localPart && domainPart) {
      const visibleLocal = localPart.length <= 2
        ? `${localPart[0] || ''}*`
        : `${localPart.slice(0, 2)}${'*'.repeat(Math.max(1, localPart.length - 2))}`;
      return `${visibleLocal}@${domainPart}`;
    }
  }

  const trimmedUsername = (username || '').trim();
  if (trimmedUsername) {
    if (trimmedUsername.length <= 2) return `${trimmedUsername[0] || ''}*`;
    return `${trimmedUsername.slice(0, 2)}${'*'.repeat(Math.max(1, trimmedUsername.length - 2))}`;
  }

  return undefined;
}

/**
 * POST /api/setup/bootstrap
 * Exchange the installer fragment secret once for a short-lived, origin-bound
 * bearer. The secret never appears in an HTTP request URL or remains reusable.
 */
router.post('/bootstrap', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const transport = assertSecureSetupBrowserRequest(req);
    const providedToken = String(req.get(SETUP_BOOTSTRAP_HEADER) || '');
    let validation = validateSetupBootstrapCredential({
      providedToken,
      expectedToken: process.env.SETUP_TOKEN,
      expiresAt: process.env.SETUP_TOKEN_EXPIRES_AT,
      usedAt: process.env.SETUP_TOKEN_USED_AT,
    });
    if (!validation.ok) throw setupCredentialError(validation.code, 'Setup bootstrap');

    await assertSetupBootstrapOpen();

    // Re-check immediately before the synchronous atomic state transition so
    // two concurrent exchanges cannot both consume the same bootstrap secret.
    validation = validateSetupBootstrapCredential({
      providedToken,
      expectedToken: process.env.SETUP_TOKEN,
      expiresAt: process.env.SETUP_TOKEN_EXPIRES_AT,
      usedAt: process.env.SETUP_TOKEN_USED_AT,
    });
    if (!validation.ok) throw setupCredentialError(validation.code, 'Setup bootstrap');

    const now = Math.floor(Date.now() / 1000);
    const sessionExpiresAt = Math.min(validation.expiresAt, now + SETUP_SESSION_TTL_SECONDS);
    const setupToken = crypto.randomBytes(32).toString('base64url');
    persistSetupEnvironment({
      SETUP_TOKEN_USED_AT: String(now),
      SETUP_SESSION_TOKEN_HASH: hashSetupCredential(setupToken),
      SETUP_SESSION_ORIGIN: transport.origin,
      SETUP_SESSION_EXPIRES_AT: String(sessionExpiresAt),
      SETUP_HANDOFF_TOKEN_HASH: undefined,
      SETUP_HANDOFF_ORIGIN: undefined,
      SETUP_HANDOFF_EXPIRES_AT: undefined,
    });

    noStoreSetupResponse(res);
    res.json({
      success: true,
      setupToken,
      origin: transport.origin,
      expiresAt: new Date(sessionExpiresAt * 1000).toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/bootstrap/handoff
 * Consume the one-time domain handoff only after the browser has reached the
 * exact HTTPS origin proven by configure-domain.
 */
router.post('/bootstrap/handoff', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const transport = assertSecureSetupBrowserRequest(req, { httpsOnly: true });
    await assertSetupBootstrapOpen();

    const validation = validateSetupSessionCredential({
      providedToken: req.get(SETUP_HANDOFF_HEADER),
      expectedTokenHash: process.env.SETUP_HANDOFF_TOKEN_HASH,
      expectedOrigin: process.env.SETUP_HANDOFF_ORIGIN,
      requestOrigin: transport.origin,
      expiresAt: process.env.SETUP_HANDOFF_EXPIRES_AT,
    });
    if (!validation.ok) throw setupCredentialError(validation.code, 'HTTPS setup handoff');

    const now = Math.floor(Date.now() / 1000);
    const bootstrapExpiry = Number.parseInt(String(process.env.SETUP_TOKEN_EXPIRES_AT || ''), 10);
    if (!Number.isSafeInteger(bootstrapExpiry) || now >= bootstrapExpiry) {
      throw setupCredentialError('expired', 'Setup bootstrap');
    }
    const sessionExpiresAt = Math.min(bootstrapExpiry, now + SETUP_SESSION_TTL_SECONDS);
    const setupToken = crypto.randomBytes(32).toString('base64url');
    persistSetupEnvironment({
      SETUP_SESSION_TOKEN_HASH: hashSetupCredential(setupToken),
      SETUP_SESSION_ORIGIN: transport.origin,
      SETUP_SESSION_EXPIRES_AT: String(sessionExpiresAt),
      SETUP_HANDOFF_TOKEN_HASH: undefined,
      SETUP_HANDOFF_ORIGIN: undefined,
      SETUP_HANDOFF_EXPIRES_AT: undefined,
    });

    noStoreSetupResponse(res);
    res.json({
      success: true,
      setupToken,
      origin: transport.origin,
      expiresAt: new Date(sessionExpiresAt * 1000).toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/setup/status
 * Always accessible — checks if setup is needed.
 */
router.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [ownerCount, setupStateRow, tailnetOnboardingRow] = await Promise.all([
      prisma.user.count({ where: { role: 'OWNER' as any } }),
      prisma.systemSetting.findUnique({ where: { key: SETUP_STATE_KEY } }),
      prisma.systemSetting.findUnique({
        where: { key: OLLAMA_TAILNET_ONBOARDING_KEY },
      }),
    ]);
    const { needsSetup, isReinstall, setupComplete } = classifySetupProgress({
      ownerCount,
      setupState: setupStateRow?.value,
      hasSetupToken: !!process.env.SETUP_TOKEN,
    });

    let ownerHint: string | undefined;
    if (isReinstall) {
      const owner = await prisma.user.findFirst({ where: { role: 'OWNER' as any }, select: { email: true, username: true } });
      ownerHint = maskOwnerHint((owner as any)?.email, (owner as any)?.username);
    }

    const setupTransport = setupTransportForRequest(req);
    noStoreSetupResponse(res);
    res.json({
      needsSetup,
      setupState: setupComplete ? SETUP_STATE_COMPLETE : isReinstall ? 'recovery' : 'pending',
      setupTransport: {
        allowed: setupTransport.allowed,
        kind: setupTransport.kind,
        reason: setupTransport.reason,
      },
      version: PORTAL_VERSION,
      incompleteSteps: needsSetup ? ['adminAccount', 'portalIdentity', 'security', 'domain', 'email', 'ai'] : [],
      tailnetOnboarding: {
        phase: normalizeOllamaTailnetOnboardingPhase(
          tailnetOnboardingRow?.value,
        ),
      },
      ...(isReinstall && { isReinstall: true, ownerHint }),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/tailnet-onboarding
 * Persist the non-secret external-GPU handoff choice while setup is pending.
 * The completion transaction writes the same snapshot again so a lost browser
 * response cannot strand the Owner between initial setup and Settings.
 */
router.post(
  '/tailnet-onboarding',
  requireSetupPending,
  requireSetupToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { requested } = tailnetOnboardingSchema.parse(req.body);
      const phase = requested
        ? OLLAMA_TAILNET_ONBOARDING_PHASE.REQUESTED
        : OLLAMA_TAILNET_ONBOARDING_PHASE.NOT_REQUESTED;
      await prisma.systemSetting.upsert({
        where: { key: OLLAMA_TAILNET_ONBOARDING_KEY },
        update: { value: phase },
        create: {
          key: OLLAMA_TAILNET_ONBOARDING_KEY,
          value: phase,
        },
      });
      noStoreSetupResponse(res);
      res.json({ phase });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/setup/reinstall-reset
 * Reset the OWNER's password during a reinstall (preserved database).
 * Only available when SETUP_TOKEN is present (fresh install detected existing DB).
 * After reset, clears the SETUP_TOKEN so the portal operates normally.
 */
router.post('/reinstall-reset', requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  let tokenRemoval: ReturnType<typeof prepareSetupTokenRemoval> | undefined;
  try {
    const { password } = req.body;
    if (!password || typeof password !== 'string') {
      throw new AppError(400, 'Password is required.');
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      throw new AppError(400, strength.errors.join('. '));
    }

    const passwordHash = await hashPassword(password);
    tokenRemoval = prepareSetupTokenRemoval();
    const owner = await prisma.$transaction(async (tx) => {
      // pg_advisory_xact_lock returns void, which Prisma cannot deserialize; the
      // text cast keeps the lock while giving the driver a readable column.
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(${SETUP_COMPLETION_LOCK_ID}::bigint)::text`);
      await assertNoProjectAuthorizationTransitionActive(tx);
      const [currentOwner, setupState] = await Promise.all([
        tx.user.findFirst({ where: { role: 'OWNER' as any } }),
        tx.systemSetting.findUnique({ where: { key: SETUP_STATE_KEY } }),
      ]);
      if (!currentOwner) {
        throw new AppError(400, 'No owner account found. Use normal setup instead.');
      }
      if (setupState?.value === SETUP_STATE_COMPLETE) {
        throw new AppError(403, 'Setup recovery is closed because initial setup already completed.');
      }

      const updatedOwner = await tx.user.update({
        where: { id: currentOwner.id },
        data: {
          passwordHash,
          // Deleting refresh sessions is insufficient for already-issued access
          // tokens. Advance the durable generation so every old token and
          // generation-bound host runtime fails closed immediately.
          authorizationVersion: { increment: 1 },
        },
      });
      // Reinstall recovery must revoke any preserved browser/device sessions.
      await tx.session.deleteMany({ where: { userId: currentOwner.id } });
      await tx.systemSetting.upsert({
        where: { key: SETUP_STATE_KEY },
        update: { value: SETUP_STATE_COMPLETE },
        create: { key: SETUP_STATE_KEY, value: SETUP_STATE_COMPLETE },
      });
      return updatedOwner;
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });

    publishAuthorizationChanged({
      type: 'authorization_changed',
      userId: owner.id,
      authorizationVersion: Number((owner as any).authorizationVersion),
      reasons: ['credential_recovery'],
    });
    tokenRemoval.commit();

    // Clear any stale auth cookies carried by the current browser so the user
    // lands on a clean sign-in flow with the new password.
    clearAuthCookies(req, res);

    res.json({
      ok: true,
      message: 'Password reset successfully. You can now log in.',
      username: (owner as any).username,
      email: (owner as any).email,
    });
  } catch (error) {
    tokenRemoval?.abort();
    next(error);
  }
});

/**
 * GET /api/setup/system-info
 * Show what's installed and server capabilities.
 * Helps the wizard explain what happened during installation.
 */
router.get('/system-info', requireSetupPending, requireSetupToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const os = require('os');
    const ramGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
    
    let diskGb = 0;
    try {
      const df = execSync("df -BG / | awk 'NR==2 {gsub(\"G\",\"\"); print $4}'", { encoding: 'utf-8', timeout: 3000 });
      diskGb = parseInt(df.trim()) || 0;
    } catch {}

    let osName = 'Linux';
    try {
      const release = fs.readFileSync('/etc/os-release', 'utf-8');
      const match = release.match(/PRETTY_NAME="(.+?)"/);
      if (match) osName = match[1];
    } catch {}

    // Check installed components
    const checkCmd = (cmd: string): boolean => {
      try { execSync(`command -v ${cmd}`, { timeout: 2000, stdio: 'ignore' }); return true; } catch { return false; }
    };

    const checkService = (name: string): boolean => {
      try { return execSync(`systemctl is-active ${name} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 }).trim() === 'active'; } catch { return false; }
    };

    const components = {
      nodejs: { installed: checkCmd('node'), version: '' },
      postgresql: { installed: checkCmd('psql'), running: checkService('postgresql') },
      caddy: { installed: checkCmd('caddy'), running: checkService('caddy') },
      docker: { installed: checkCmd('docker'), running: checkService('docker') },
      clamav: { installed: checkCmd('clamscan') },
      ollama: { installed: checkCmd('ollama'), running: checkService('ollama') },
      openclaw: { installed: checkCmd('openclaw') },
    };

    try {
      components.nodejs.version = execSync('node -v', { encoding: 'utf-8', timeout: 2000 }).trim();
    } catch {}

    res.json({
      publicIp: getPublicIp(),
      ramGb,
      diskGb,
      cpus: os.cpus().length,
      osName,
      components,
      currentDomain: getDomain(),
      installProfile: process.env.INSTALL_PROFILE || 'server',
      originMode: configuredPortalOriginMode(),
      featureCapabilities: getPortalFeatureCapabilities(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/check-dns
 * Check if a domain's A record points to this server.
 */
router.post('/check-dns', requireSetupPending, requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { domain } = configureDomainSchema.parse(req.body);
    const publicIp = getPublicIp();

    let resolvedIps: string[] = [];
    let resolves = false;
    let pointsToUs = false;

    try {
      resolvedIps = await dns.resolve4(domain);
      resolves = resolvedIps.length > 0;
      pointsToUs = resolvedIps.includes(publicIp);
    } catch {
      // DNS lookup failed — domain doesn't resolve
    }

    res.json({
      domain,
      resolves,
      pointsToUs,
      resolvedIps,
      expectedIp: publicIp,
      message: !resolves
        ? `${domain} doesn't resolve yet. Add an A record pointing to ${publicIp}.`
        : pointsToUs
          ? `${domain} is pointed at this server. Ready for HTTPS!`
          : `${domain} resolves to ${resolvedIps.join(', ')} but this server is ${publicIp}.`,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/configure-domain
 * Set up domain + HTTPS via Caddy.
 */
router.post('/configure-domain', requireSetupPending, requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { domain } = configureDomainSchema.parse(req.body);
    const result = await configureDomainAndHttps(domain);

    // The wizard entered through the loopback tunnel, so public-IP HTTP is not
    // needed for continuity. Remove the temporary proxy block before offering
    // any domain handoff; a failed removal leaves the wizard on loopback.
    removePortalSetupIpAccess();
    updateEnvFile({
      DOMAIN: domain,
      CORS_ORIGIN: `http://localhost:4001,http://127.0.0.1:4001,https://${domain},https://www.${domain}`,
    });

    if (!result.httpsReady) {
      noStoreSetupResponse(res);
      res.json({
        ...result,
        url: '',
        message: 'Domain configured, but a trusted HTTPS certificate is not ready yet. Stay on the SSH tunnel and retry HTTPS setup.',
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const currentSessionExpiry = Number.parseInt(String(process.env.SETUP_SESSION_EXPIRES_AT || ''), 10);
    if (!Number.isSafeInteger(currentSessionExpiry) || now >= currentSessionExpiry) {
      throw setupCredentialError('expired', 'Setup session');
    }
    const handoffExpiresAt = Math.min(currentSessionExpiry, now + SETUP_HANDOFF_TTL_SECONDS);
    const handoffToken = crypto.randomBytes(32).toString('base64url');
    const targetOrigin = `https://${domain}`;
    persistSetupEnvironment({
      SETUP_HANDOFF_TOKEN_HASH: hashSetupCredential(handoffToken),
      SETUP_HANDOFF_ORIGIN: targetOrigin,
      SETUP_HANDOFF_EXPIRES_AT: String(handoffExpiresAt),
    });

    noStoreSetupResponse(res);
    res.json({
      ...result,
      handoffToken,
      handoffExpiresAt: new Date(handoffExpiresAt * 1000).toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/setup/mail-status
 * Check if mail server is available.
 */
router.get('/mail-status', requireSetupPending, requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      res.json({
        available: false,
        configured: false,
        canSend: false,
        dkimConfigured: false,
        dnsRecords: [],
        domain: '',
        hasDomain: false,
        supported: false,
        reason: unavailable.error,
      });
      return;
    }
    const domain = getDomain(req);
    const stalwartUrl = process.env.STALWART_URL || 'http://127.0.0.1:8580';

    let available = false;
    let configured = false;
    let canSend = false;
    const mailDir = path.join(INSTALL_ROOT, 'stalwart');
    const dkimRecords = domain ? readStoredStalwartDkimRecords(mailDir, domain) : [];
    const dkimConfigured = dkimRecords.length === 2;

    try {
      const response = await fetch(`${stalwartUrl}/.well-known/jmap`, { signal: AbortSignal.timeout(3000) });
      available = response.ok;
      configured = !!process.env.STALWART_ADMIN_PASS && dkimConfigured;
    } catch {}

    if (available && configured) {
      try {
        const net = require('net');
        await new Promise<void>((resolve, reject) => {
          const socket = new net.Socket();
          socket.setTimeout(2000);
          socket.connect(587, '127.0.0.1', () => { canSend = true; socket.destroy(); resolve(); });
          socket.on('error', () => { socket.destroy(); reject(); });
          socket.on('timeout', () => { socket.destroy(); reject(); });
        });
      } catch {}
    }

    const dnsRecords = domain ? generateDnsRecords(domain, dkimRecords) : [];

    res.json({ available, configured, canSend, dkimConfigured, dnsRecords, domain, hasDomain: !!domain });
  } catch (error) {
    next(error);
  }
});

function generateDnsRecords(
  domain: string,
  suppliedDkimRecords?: StalwartDkimDnsRecord[],
): Array<{ type: string; name: string; value: string; priority?: number; description: string }> {
  const mailDir = path.join(INSTALL_ROOT, 'stalwart');
  const dkimRecords = suppliedDkimRecords || readStoredStalwartDkimRecords(mailDir, domain);

  // Only return DKIM + DMARC here — mail A, MX, and SPF are already shown
  // in the domain setup step so we don't ask users to add them twice.
  return [
    ...dkimRecords.map(record => ({
      type: 'TXT',
      name: record.name,
      value: record.value,
      description: `${record.algorithm.toUpperCase()} DKIM signature — verifies emails are really from you`,
    })),
    { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, description: 'Policy for handling suspicious emails' },
  ];
}

/**
 * GET /api/setup/mail-preflight
 * Check if this server can send email (port 25 outbound, Docker available).
 * Detects VPS provider and gives provider-specific instructions if blocked.
 */
router.get('/mail-preflight', requireSetupPending, requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      res.json({
        provider: 'unsupported',
        providerName: 'Private Tailnet mode',
        dockerOk: false,
        port25Open: false,
        smtpBlocked: false,
        providerInstructions: unavailable.error,
        providerLink: null,
        canSelfHost: false,
        supported: false,
        reason: unavailable.error,
      });
      return;
    }
    const net = require('net');

    // Detect VPS provider from metadata endpoints or hostname patterns
    let provider = 'unknown';
    try {
      // DigitalOcean
      const doResp = await fetch('http://169.254.169.254/metadata/v1/id', { signal: AbortSignal.timeout(1500) });
      if (doResp.ok) provider = 'digitalocean';
    } catch {}
    if (provider === 'unknown') {
      try {
        // AWS / Lightsail
        const awsResp = await fetch('http://169.254.169.254/latest/meta-data/instance-id', { signal: AbortSignal.timeout(1500) });
        if (awsResp.ok) provider = 'aws';
      } catch {}
    }
    if (provider === 'unknown') {
      try {
        // Hetzner
        const hzResp = await fetch('http://169.254.169.254/hetzner/v1/metadata', { signal: AbortSignal.timeout(1500) });
        if (hzResp.ok) provider = 'hetzner';
      } catch {}
    }
    if (provider === 'unknown') {
      try {
        // Vultr
        const vuResp = await fetch('http://169.254.169.254/v1/instanceid', { signal: AbortSignal.timeout(1500) });
        if (vuResp.ok) provider = 'vultr';
      } catch {}
    }
    if (provider === 'unknown') {
      try {
        const hostname = execSync('hostname -f 2>/dev/null || hostname', { timeout: 2000 }).toString().trim().toLowerCase();
        if (hostname.includes('hostinger') || hostname.includes('hstgr')) provider = 'hostinger';
        else if (hostname.includes('linode') || hostname.includes('akamai')) provider = 'linode';
        else if (hostname.includes('ovh')) provider = 'ovh';
      } catch {}
    }

    // Check Docker
    let dockerOk = false;
    try {
      execSync('docker info', { timeout: 5000, stdio: 'ignore' });
      dockerOk = true;
    } catch {}

    // Test outbound port 25 by trying to connect to a well-known SMTP server
    let port25Open = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.connect(25, 'smtp.google.com', () => {
          port25Open = true;
          socket.destroy();
          resolve();
        });
        socket.on('error', () => { socket.destroy(); reject(); });
        socket.on('timeout', () => { socket.destroy(); reject(); });
      });
    } catch {}

    // Provider-specific unblock instructions
    const providerInfo: Record<string, { name: string; blocked: boolean; instructions: string; link?: string }> = {
      digitalocean: {
        name: 'DigitalOcean',
        blocked: true,
        instructions: 'DigitalOcean blocks SMTP (port 25) on all new accounts. Submit a support ticket to request removal — they usually approve it within 1 business day.',
        link: 'https://cloud.digitalocean.com/support/tickets/new',
      },
      aws: {
        name: 'AWS',
        blocked: true,
        instructions: 'AWS blocks outbound port 25 by default. Request removal via the EC2 SMTP Unblock form in your AWS console.',
        link: 'https://aws.amazon.com/premiumsupport/knowledge-center/ec2-port-25-throttle/',
      },
      hetzner: {
        name: 'Hetzner',
        blocked: true,
        instructions: 'Hetzner blocks port 25 on new accounts. It\'s usually auto-unblocked after a few weeks, or you can contact support to expedite.',
        link: 'https://docs.hetzner.com/cloud/servers/faq/#why-can-my-server-not-send-mails',
      },
      vultr: {
        name: 'Vultr',
        blocked: true,
        instructions: 'Vultr blocks SMTP on new accounts. Open a support ticket to request unblocking — include your use case.',
        link: 'https://my.vultr.com/support/',
      },
      linode: {
        name: 'Linode / Akamai',
        blocked: false,
        instructions: 'Linode generally allows outbound SMTP. If you still see issues, check your firewall rules.',
      },
      hostinger: {
        name: 'Hostinger',
        blocked: false,
        instructions: 'Hostinger VPS usually allows outbound SMTP. If blocked, check their VPS firewall settings.',
      },
      ovh: {
        name: 'OVH',
        blocked: false,
        instructions: 'OVH generally allows outbound SMTP. Ensure your anti-spam policy is configured.',
      },
    };

    const info = providerInfo[provider] || null;
    const smtpBlocked = !port25Open;

    res.json({
      provider,
      providerName: info?.name || 'Unknown',
      dockerOk,
      port25Open,
      smtpBlocked,
      providerInstructions: smtpBlocked && info ? info.instructions : null,
      providerLink: smtpBlocked && info ? info.link : null,
      canSelfHost: dockerOk && port25Open,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/install-mail
 * Install Stalwart mail server via Docker.
 * This is a long-running operation.
 */
router.post('/install-mail', requireSetupPending, requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      res.status(409).json(unavailable);
      return;
    }
    const domain = getDomain(req);
    if (!domain) {
      throw new AppError(400, 'A domain must be configured before setting up email. Complete the Domain step first.');
    }

    try {
      execSync('docker info', { timeout: 5000, stdio: 'ignore' });
    } catch {
      throw new AppError(500, 'Docker is not running. Email requires Docker for the mail server.');
    }

    let stalwartAlreadyRunning = false;
    try {
      const containers = execSync('docker ps --filter name=stalwart-mail --format "{{.Names}}"', { timeout: 5000 }).toString().trim();
      if (containers.includes('stalwart-mail')) {
        stalwartAlreadyRunning = true;
      }
    } catch {}

    if (!stalwartAlreadyRunning) {
      const portCheck = (port: number): boolean => {
        try {
          execSync(`ss -tlnp sport = :${port} 2>/dev/null | grep -q ':${port}'`, { timeout: 3000, shell: '/bin/bash' });
          return true;
        } catch {
          return false;
        }
      };
      if (portCheck(25) || portCheck(587) || portCheck(993)) {
        const busy = [25, 587, 993].filter(portCheck).join(', ');
        throw new AppError(409, `Mail ports ${busy} are already in use by another service. Stop the existing mail server first, or skip email setup.`);
      }
    }

    const mailDir = path.join(INSTALL_ROOT, 'stalwart');
    fs.mkdirSync(path.join(mailDir, 'data'), { recursive: true });

    const randPass = (len: number) => {
      return require('crypto').randomBytes(len).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, len);
    };

    let adminPass = randPass(16);
    let supportPass = randPass(24);
    let noreplyPass = randPass(24);
    const envProdPath = path.join(PORTAL_ROOT, 'backend', '.env.production');
    if (fs.existsSync(envProdPath)) {
      const envContent = fs.readFileSync(envProdPath, 'utf-8');
      const existingAdmin = envContent.match(/STALWART_ADMIN_PASS=(.+)/)?.[1]?.trim();
      const existingSupport = envContent.match(/STALWART_SUPPORT_PASS=(.+)/)?.[1]?.trim();
      const existingNoreply = envContent.match(/STALWART_NOREPLY_PASS=(.+)/)?.[1]?.trim();
      if (existingAdmin) adminPass = existingAdmin;
      if (existingSupport) supportPass = existingSupport;
      if (existingNoreply) noreplyPass = existingNoreply;
    }

    const writeStalwartConfig = () => {
      // Pin Stalwart: v0.16 removed the legacy admin API endpoints this installer uses
      // for domain/account provisioning. Do not use `latest` here.
      const composeContent = `version: '3.8'
services:
  stalwart:
    image: stalwartlabs/stalwart:v0.15.5
    container_name: stalwart-mail
    restart: unless-stopped
    ports:
      - "25:25"
      - "587:587"
      - "993:993"
      - "127.0.0.1:8580:8080"
    volumes:
      - ./data:/opt/stalwart
`;
      fs.writeFileSync(path.join(mailDir, 'docker-compose.yml'), composeContent);

      const dataDir = path.join(mailDir, 'data');
      const etcDir = path.join(dataDir, 'etc');
      fs.mkdirSync(etcDir, { recursive: true });

      const configToml = `# Stalwart Mail Server — BridgesLLM Portal
[lookup.default]
hostname = "mail.${domain}"

# Listeners
[server.listener.smtp]
bind = "[::]:25"
protocol = "smtp"

[server.listener.submission]
bind = "[::]:587"
protocol = "smtp"
tls.implicit = false

[server.listener.imaptls]
bind = "[::]:993"
protocol = "imap"
tls.implicit = true

[server.listener.http]
protocol = "http"
bind = "[::]:8080"

# Storage
[storage]
data = "rocksdb"
fts = "rocksdb"
blob = "rocksdb"
lookup = "rocksdb"
directory = "internal"

[store.rocksdb]
type = "rocksdb"
path = "/opt/stalwart/data"
compression = "lz4"

[directory.internal]
type = "internal"
store = "rocksdb"

# Logging
[tracer.log]
type = "log"
level = "info"
path = "/opt/stalwart/logs"
prefix = "stalwart.log"
rotate = "daily"
ansi = false
enable = true

# DKIM signing — sign outbound mail from local domains
${getStalwartDkimSigningConfig()}

# Admin credentials
[authentication.fallback-admin]
user = "admin"
secret = "${adminPass}"
`;
      fs.writeFileSync(path.join(etcDir, 'config.toml'), configToml);
    };

    const startFreshStalwart = async () => {
      writeStalwartConfig();
      try {
        execSync('docker compose pull', { cwd: mailDir, timeout: 180000, stdio: 'pipe' });
      } catch (err: any) {
        const stderr = err.stderr?.toString()?.slice(-200) || '';
        throw new AppError(500, `Failed to pull mail server image. ${stderr}`.trim());
      }

      try {
        execSync('docker compose up -d', { cwd: mailDir, timeout: 120000, stdio: 'pipe' });
      } catch (err: any) {
        const stderr = err.stderr?.toString()?.slice(-200) || '';
        throw new AppError(500, `Failed to start mail server container. ${stderr}`.trim());
      }

      const ready = await waitForStalwartJmap();
      if (!ready) {
        throw new AppError(500, 'Mail server started but didn\'t respond within 45 seconds.');
      }
    };

    let recreated = false;
    if (stalwartAlreadyRunning) {
      const healthy = await checkStalwartHealth();
      if (!healthy) {
        recycleStalwartForRecovery(mailDir);
        stalwartAlreadyRunning = false;
        recreated = true;
      }
    }

    if (!stalwartAlreadyRunning) {
      await startFreshStalwart();
    }

    // Register the domain in Stalwart BEFORE creating accounts.
    // Without this, account creation returns "notFound: <domain>".
    const domainResult = await ensureStalwartDomain(domain, adminPass);
    if (!domainResult.ok) {
      // If domain creation fails, retry once with the same persistent mail store.
      if (!recreated) {
        console.warn('[setup/install-mail] Domain creation failed; retrying with a data-preserving container recycle:', domainResult.error);
        recycleStalwartForRecovery(mailDir);
        await startFreshStalwart();
        recreated = true;
        const retryDomain = await ensureStalwartDomain(domain, adminPass);
        if (!retryDomain.ok) {
          throw new AppError(500, `Failed to register domain in mail server: ${retryDomain.error}`);
        }
      } else {
        throw new AppError(500, `Failed to register domain in mail server: ${domainResult.error}`);
      }
    }

    let supportResult = await createStalwartAccount(domain, adminPass, 'support', supportPass);
    let noreplyResult = await createStalwartAccount(domain, adminPass, 'noreply', noreplyPass);

    if ((!supportResult.ok || !noreplyResult.ok) && !recreated) {
      console.warn('[setup/install-mail] Account creation failed; retrying with a data-preserving container recycle', supportResult, noreplyResult);
      recycleStalwartForRecovery(mailDir);
      await startFreshStalwart();
      recreated = true;
      const retryDomain2 = await ensureStalwartDomain(domain, adminPass);
      if (!retryDomain2.ok) {
        throw new AppError(500, `Failed to register domain after recreating mail server: ${retryDomain2.error}`);
      }
      supportResult = await createStalwartAccount(domain, adminPass, 'support', supportPass);
      noreplyResult = await createStalwartAccount(domain, adminPass, 'noreply', noreplyPass);
    }

    if (!supportResult.ok || !noreplyResult.ok) {
      const detail = supportResult.ok ? noreplyResult.error : supportResult.error;
      throw new AppError(500, `Failed to create Stalwart accounts: ${detail || 'unknown error'}`);
    }

    const dkimRecords = await provisionStalwartDkim({
      domain,
      adminPass,
      mailDir,
      baseUrl: 'http://127.0.0.1:8580',
    });

    updateEnvFile({
      STALWART_URL: 'http://127.0.0.1:8580',
      STALWART_ADMIN_PASS: adminPass,
      STALWART_SUPPORT_USER: 'support',
      STALWART_SUPPORT_PASS: supportPass,
      STALWART_NOREPLY_USER: 'noreply',
      STALWART_NOREPLY_PASS: noreplyPass,
      MAIL_DOMAIN: domain,
    });
    process.env.STALWART_URL = 'http://127.0.0.1:8580';
    process.env.STALWART_ADMIN_PASS = adminPass;
    process.env.STALWART_SUPPORT_USER = 'support';
    process.env.STALWART_SUPPORT_PASS = supportPass;
    process.env.STALWART_NOREPLY_USER = 'noreply';
    process.env.STALWART_NOREPLY_PASS = noreplyPass;
    process.env.MAIL_DOMAIN = domain;

    try {
      execSync('ufw allow 25/tcp 2>/dev/null; ufw allow 587/tcp 2>/dev/null; ufw allow 993/tcp 2>/dev/null', { timeout: 5000, shell: '/bin/bash' });
    } catch {}

    const dnsRecords = generateDnsRecords(domain, dkimRecords);

    res.json({
      success: true,
      domain,
      dnsRecords,
      message: 'Mail server installed! Add the DNS records below to complete setup.',
      features: [
        'Two-factor authentication codes',
        'Password reset links',
        'Login alerts from new devices',
        'Welcome emails for new users',
      ],
      recreated,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/test-email
 */
router.post('/test-email', requireSetupPending, requireSetupToken, async (req: Request, res: Response) => {
  try {
    const unavailable = portalFeatureUnavailableResponse('mail');
    if (unavailable) {
      res.status(409).json(unavailable);
      return;
    }
    const { email } = testEmailSchema.parse(req.body);
    const domain = getDomain(req);

    // Try mailService first, fallback to nodemailer
    try {
      const { sendEmail } = await import('../services/mailService');
      await sendEmail({
        to: [{ email }],
        subject: 'Test Email — Portal Setup',
        textBody: 'This test email confirms your mail server is properly configured.',
        htmlBody: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#111827;color:#e2e8f0;border-radius:12px;">
          <h2 style="color:#10b981;margin:0 0 12px;">&#10003; Mail Server Working</h2>
          <p style="margin:0 0 8px;">Your mail server is configured and can send email. Security features like two-factor authentication and login alerts are now available.</p>
          <p style="color:#94a3b8;font-size:14px;margin:0;">Sent during portal setup</p>
        </div>`,
      });
    } catch {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: '127.0.0.1',
        port: 587,
        secure: false,
        auth: {
          user: process.env.STALWART_NOREPLY_USER || 'noreply',
          pass: process.env.STALWART_NOREPLY_PASS,
        },
        tls: { rejectUnauthorized: false },
      });
      await transporter.sendMail({
        from: `Portal Setup <noreply@${domain || 'localhost'}>`,
        to: email,
        subject: 'Test Email — Portal Setup',
        text: 'This test email confirms your mail server is configured correctly.',
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    }

    res.json({ success: true, message: 'Test email sent — check your inbox.' });
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, `Failed to send test email: ${error.message}`);
  }
});

/**
 * POST /api/setup/upload-logo
 */
router.post('/upload-logo', requireSetupPending, requireSetupToken, uploadLogo.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError(400, 'No file uploaded');
    const filename = `portal-logo-${crypto.randomUUID()}.png`;
    await normalizeBrandingLogoToPng(req.file.buffer, path.join(BRANDING_DIR, filename), 512);
    cleanupBasenamePrefixVariants(BRANDING_DIR, 'portal-logo-', filename);
    const url = `/static-assets/branding/${filename}`;
    res.json({ success: true, url });
  } catch (error) {
    if (error instanceof UnsafeImageUploadError) {
      return next(new AppError(400, error.message));
    }
    next(error);
  }
});

/**
 * GET /api/setup/ollama-status
 * Check Ollama status with RAM-based recommendations.
 */
router.get('/ollama-status', requireSetupPending, requireSetupToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let running = false;
    let models: string[] = [];

    try {
      const data = await requestLocalOllamaJson<any>({
        path: '/api/tags',
        method: 'GET',
        timeoutMs: 3_000,
        maxResponseBytes: 2 * 1024 * 1024,
      });
      running = true;
      models = Array.isArray(data?.models)
        ? data.models.slice(0, 1_000).flatMap((entry: any) => {
          const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
          return isValidOllamaModelName(name) ? [name] : [];
        })
        : [];
    } catch {}

    const os = require('os');
    const totalRam = os.totalmem();
    const ramGb = Math.round((totalRam / (1024 ** 3)) * 10) / 10;
    const availableRam = readAvailableMemoryBytes(totalRam);
    const { ramTier, availableRamGb, reservedHeadroomGb, warning, recommendedModels } = getOllamaRecommendationsByRam(totalRam, availableRam);

    res.json({ running, endpoint: DEFAULT_LOCAL_OLLAMA_ENDPOINT, models, ramGb, availableRamGb, reservedHeadroomGb, ramTier, warning, recommendedModels });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/ollama-pull
 * Pull an Ollama model (non-streaming, guarded).
 */
router.post('/ollama-pull', requireSetupPending, requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { model } = req.body;
    if (!isValidOllamaModelName(model)) {
      throw new AppError(400, 'Invalid model name');
    }

    let resolveCompletion: (job: OllamaPullSnapshot) => void = () => undefined;
    const completion = new Promise<OllamaPullSnapshot>((resolve) => {
      resolveCompletion = resolve;
    });
    const job = setupLocalOllamaPullManager.start(model, { onDone: resolveCompletion });
    const cancelDisconnectedPull = () => {
      if (!res.writableEnded) setupLocalOllamaPullManager.cancel(job.id);
    };
    req.once('aborted', cancelDisconnectedPull);
    res.once('close', cancelDisconnectedPull);
    const completed = await completion;
    req.off('aborted', cancelDisconnectedPull);
    res.off('close', cancelDisconnectedPull);

    if (completed.state !== 'succeeded') {
      throw new AppError(502, `Ollama pull ${completed.state.replace('_', ' ')}`);
    }

    res.json({ success: true, model });
  } catch (error) {
    if (error instanceof OllamaPullBusyError) {
      next(new AppError(409, error.message));
      return;
    }
    next(error);
  }
});

/**
 * GET /api/setup/openclaw-status
 * Check OpenClaw gateway connectivity.
 */
router.get('/openclaw-status', requireSetupPending, requireSetupToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getOpenClawSetupReadiness());
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/install-rd
 * Setup-token protected Remote Desktop auto-setup.
 * Calls the same logic as the admin /api/remote-desktop/auto-setup endpoint.
 */
router.post('/install-rd', requireSetupPending, requireSetupToken, async (_req: Request, res: Response) => {
  try {
    const { runRemoteDesktopAutoSetup } = await import('./remote-desktop');
    const result = await runRemoteDesktopAutoSetup();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err: any) {
    res.status(500).json({ ok: false, steps: [], message: err?.message || 'Remote Desktop setup failed' });
  }
});

router.get('/coding-tools-status', requireSetupPending, requireSetupToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getCodingToolsStatus());
  } catch (err) {
    next(err);
  }
});

router.post('/install-coding-tool', requireSetupPending, requireSetupToken, async (req: Request, res: Response) => {
  try {
    const toolId = z.object({ toolId: z.string().min(1) }).parse(req.body).toolId;
    installCodingTool(toolId);
    res.json({ success: true, toolId });
  } catch (err: any) {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err?.message ? `Failed to install: ${String(err.message).substring(0, 200)}` : 'Failed to install coding tool' });
  }
});

/**
 * POST /api/setup/complete
 * Create admin account and save all settings. Final step.
 */
router.post('/complete', requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  let tokenRemoval: ReturnType<typeof prepareSetupTokenRemoval> | undefined;
  let transactionCommitted = false;
  try {
    const body = completeSetupSchema.parse(req.body);
    const strength = validatePasswordStrength(body.password);
    if (!strength.valid) {
      throw new AppError(400, strength.errors.join('. '));
    }

    let logoUrl: string;
    try {
      logoUrl = validateSetupLogoUrl(body.logoUrl, BRANDING_DIR) || APPEARANCE_DEFAULTS.logoUrl;
    } catch (error: any) {
      throw new AppError(400, error?.message || 'The setup logo is invalid.');
    }

    const ownerId = crypto.randomUUID();
    const passwordHash = await hashPassword(body.password);
    const refreshToken = generateRefreshToken({ userId: ownerId });
    const refreshTokenHash = digestAuthToken('refresh', refreshToken);

    const nameParts = body.name.split(/\s+/);
    const firstName = nameParts[0] || body.name;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

    const settingsToUpsert: Record<string, string> = {
      'appearance.portalName': body.portalName ?? APPEARANCE_DEFAULTS.portalName,
      'appearance.theme': body.theme ?? APPEARANCE_DEFAULTS.theme,
      'appearance.accentColor': body.accentColor ?? APPEARANCE_DEFAULTS.accentColor,
      'appearance.logoUrl': logoUrl,
      'security.registrationMode': body.registrationMode ?? SECURITY_DEFAULTS.registrationMode,
      'security.sandboxDefaultEnabled': 'true',
      'system.allowTelemetry': body.allowTelemetry === false ? 'false' : 'true',
      'system.searchEngineVisibility': body.searchEngineVisibility === 'visible' ? 'visible' : 'hidden',
      [OLLAMA_TAILNET_ONBOARDING_KEY]: body.tailnetRequested
        ? OLLAMA_TAILNET_ONBOARDING_PHASE.REQUESTED
        : OLLAMA_TAILNET_ONBOARDING_PHASE.NOT_REQUESTED,
    };

    // Confirm the setup token can be removed before committing any owner row.
    tokenRemoval = prepareSetupTokenRemoval();
    const user = await prisma.$transaction(async (tx) => {
      // A database-scoped lock prevents concurrent requests/processes from
      // creating two owners. Serializable isolation closes the remaining race.
      // pg_advisory_xact_lock returns void, which Prisma cannot deserialize; the
      // text cast keeps the lock while giving the driver a readable column.
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(${SETUP_COMPLETION_LOCK_ID}::bigint)::text`);
      await assertNoProjectAuthorizationTransitionActive(tx);
      const existingOwner = await tx.user.findFirst({ where: { role: 'OWNER' as any } });
      if (existingOwner) {
        throw new AppError(409, 'Setup already completed. An owner account exists.');
      }

      const username = await createUniqueUsername(body.name, body.email, tx);
      const createdUser = await tx.user.create({
        data: {
          id: ownerId,
          email: body.email,
          username,
          passwordHash,
          firstName,
          lastName,
          role: 'OWNER' as any,
          accountStatus: 'ACTIVE',
          isActive: true,
          sandboxEnabled: false,
        },
      } as any);

      for (const [key, value] of Object.entries(settingsToUpsert)) {
        await tx.systemSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        });
      }

      await tx.session.create({
        data: {
          userId: createdUser.id,
          refreshTokenHash,
          ipAddress: req.ip || 'unknown',
          userAgent: req.headers['user-agent'] || 'unknown',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      await tx.activityLog.create({
        data: {
          userId: createdUser.id,
          action: 'SETUP_COMPLETE',
          resource: 'system',
          severity: 'INFO',
          ipAddress: req.ip || 'unknown',
          userAgent: req.headers['user-agent'] || 'unknown',
          translatedMessage: `Initial setup completed — admin: ${createdUser.email}`,
          metadata: {
            portalName: settingsToUpsert['appearance.portalName'],
            registrationMode: settingsToUpsert['security.registrationMode'],
          },
        },
      });

      // Written last: this marker proves the owner/settings/session transaction
      // reached its durable terminal state.
      await tx.systemSetting.upsert({
        where: { key: SETUP_STATE_KEY },
        update: { value: SETUP_STATE_COMPLETE },
        create: { key: SETUP_STATE_KEY, value: SETUP_STATE_COMPLETE },
      });
      return createdUser;
    }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 30_000 });
    transactionCommitted = true;

    try {
      tokenRemoval.commit();
    } catch (error) {
      // The committed database marker keeps all setup/recovery endpoints closed
      // even if the atomic env rename is interrupted. Disable the in-memory
      // token now and leave a loud diagnostic for operator cleanup.
      for (const key of SETUP_ENV_KEYS) delete process.env[key];
      tokenRemoval.abort();
      console.error('[setup] Initial setup committed, but SETUP_TOKEN could not be removed from .env.production:', error);
    }

    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      authorizationVersion: Number((user as any).authorizationVersion ?? 1),
    });
    setAuthCookies(req, res, accessToken, refreshToken, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);

    // Mail is an optional external side effect. It runs only after the atomic
    // Portal commit and cannot roll setup back or strand the wizard.
    if (getPortalFeatureCapabilities().mail.available && process.env.STALWART_ADMIN_PASS) {
      let mailProvisioned = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await provisionUserMailbox(user.username, user.id, { makePrimary: true });
          mailProvisioned = true;
          console.log(`[setup] Owner mailbox provisioned on attempt ${attempt}`);
          break;
        } catch (err: any) {
          console.warn(`[setup] Mail provisioning attempt ${attempt}/3 failed: ${err.message}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
        }
      }
      if (!mailProvisioned) {
        console.error('[setup] Owner mailbox provisioning failed after 3 attempts — user can re-provision from Settings');
      }
    }

    // Clean up: strip the temporary http://<IP> origin that was kept alive for
    // the HTTP→HTTPS wizard handoff. Only the domain origins should remain.
    try {
      const envPath = path.join(PORTAL_ROOT, 'backend', '.env.production');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf-8');
        envContent = envContent.replace(
          /^(CORS_ORIGIN=.+?),http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/m,
          '$1'
        );
        fs.writeFileSync(envPath, envContent, { mode: 0o600 });
      }
    } catch (error) {
      console.warn('[setup] Setup committed, but temporary IP CORS cleanup failed:', error);
    }

    // Remove only the temporary Portal-owned IP block. The shared helper
    // validates a same-directory candidate before atomically replacing the
    // Caddyfile and restores the exact prior file if reload fails.
    try {
      removePortalSetupIpAccess();
    } catch (error: any) {
      console.warn(`[setup] Could not remove temporary Caddy IP access safely: ${error?.message || error}`);
    }

    // Schedule a service restart so CORS_ORIGIN, Secure cookie flag, and other
    // .env.production changes (from configure-domain etc.) take effect.
    try {
      const child = spawn('bash', ['-lc', 'sleep 3; systemctl restart bridgesllm-product >/dev/null 2>&1 || true'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch {}

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error: any) {
    if (!transactionCommitted) tokenRemoval?.abort();
    if (error?.code === 'P2034' || error?.code === 'P2002') {
      return next(new AppError(409, 'Setup changed while this request was running. Check setup status and retry.'));
    }
    next(error);
  }
});

export default router;
