import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const SETUP_STATE_KEY = 'system.setupState';
export const SETUP_STATE_COMPLETE = 'complete';

export const SETUP_BOOTSTRAP_HEADER = 'x-setup-bootstrap';
export const SETUP_HANDOFF_HEADER = 'x-setup-handoff';
export const SETUP_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const SETUP_HANDOFF_TTL_SECONDS = 5 * 60;

export type SetupTransportKind = 'https' | 'loopback' | 'blocked';

export type SetupTransportResult = {
  allowed: boolean;
  kind: SetupTransportKind;
  origin?: string;
  reason?: string;
};

export type SetupTransportInput = {
  protocol: string;
  host: string;
  requestIp?: string | null;
  remoteAddress?: string | null;
};

function normalizeProtocol(value: string): string {
  return value.trim().toLowerCase().replace(/:$/, '');
}

function normalizeIpAddress(value: string | null | undefined): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.startsWith('::ffff:')) return normalized.slice('::ffff:'.length);
  return normalized.replace(/^\[|\]$/g, '');
}

export function isLoopbackSetupHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function isLoopbackSetupAddress(address: string | null | undefined): boolean {
  const normalized = normalizeIpAddress(address);
  return normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Sensitive setup traffic is accepted only through a browser-verified HTTPS
 * origin or through the Portal's real loopback socket. A public HTTP request
 * stays blocked even when a reverse proxy reaches Express from 127.0.0.1.
 */
export function classifySetupTransport(input: SetupTransportInput): SetupTransportResult {
  const protocol = normalizeProtocol(input.protocol);
  if (protocol !== 'http' && protocol !== 'https') {
    return { allowed: false, kind: 'blocked', reason: 'Setup requires HTTPS or a loopback connection.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(`${protocol}://${input.host}`);
  } catch {
    return { allowed: false, kind: 'blocked', reason: 'Setup request host is invalid.' };
  }

  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { allowed: false, kind: 'blocked', reason: 'Setup request host is invalid.' };
  }

  if (protocol === 'https') {
    return { allowed: true, kind: 'https', origin: parsed.origin };
  }

  if (
    isLoopbackSetupHost(parsed.hostname)
    && isLoopbackSetupAddress(input.requestIp)
    && isLoopbackSetupAddress(input.remoteAddress)
  ) {
    return { allowed: true, kind: 'loopback', origin: parsed.origin };
  }

  return {
    allowed: false,
    kind: 'blocked',
    reason: 'Plain HTTP setup is allowed only on loopback. Use the installer SSH tunnel or verified HTTPS.',
  };
}

export function setupBrowserContextMatches(input: {
  transport: SetupTransportResult;
  method: string;
  originHeader?: string | null;
  fetchSiteHeader?: string | null;
}): boolean {
  if (!input.transport.allowed || !input.transport.origin) return false;

  const method = input.method.trim().toUpperCase();
  const fetchSite = String(input.fetchSiteHeader || '').trim().toLowerCase();
  const suppliedOrigin = String(input.originHeader || '').trim();
  let originMatches = false;
  if (suppliedOrigin) {
    try {
      originMatches = new URL(suppliedOrigin).origin === input.transport.origin;
    } catch {
      return false;
    }
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return originMatches && (!fetchSite || fetchSite === 'same-origin');
  }

  if (originMatches) return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
  return fetchSite === 'same-origin' || fetchSite === 'none';
}

export function hashSetupCredential(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeStringEqual(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return providedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(providedBytes, expectedBytes);
}

function parseExpiry(value: string | null | undefined): number | null {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export type SetupCredentialValidation =
  | { ok: true; expiresAt: number }
  | { ok: false; code: 'missing' | 'invalid' | 'expired' | 'replayed' | 'origin' | 'misconfigured' };

export function validateSetupBootstrapCredential(input: {
  providedToken?: string | null;
  expectedToken?: string | null;
  expiresAt?: string | null;
  usedAt?: string | null;
  nowEpochSeconds?: number;
}): SetupCredentialValidation {
  const provided = String(input.providedToken || '');
  const expected = String(input.expectedToken || '');
  if (!provided) return { ok: false, code: 'missing' };
  if (!expected) return { ok: false, code: 'misconfigured' };
  if (!constantTimeStringEqual(provided, expected)) return { ok: false, code: 'invalid' };

  const expiresAt = parseExpiry(input.expiresAt);
  if (!expiresAt) return { ok: false, code: 'misconfigured' };
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (now >= expiresAt) return { ok: false, code: 'expired' };
  if (String(input.usedAt || '').trim()) return { ok: false, code: 'replayed' };
  return { ok: true, expiresAt };
}

export function validateSetupSessionCredential(input: {
  providedToken?: string | null;
  expectedTokenHash?: string | null;
  expectedOrigin?: string | null;
  requestOrigin?: string | null;
  expiresAt?: string | null;
  nowEpochSeconds?: number;
}): SetupCredentialValidation {
  const provided = String(input.providedToken || '');
  if (!provided) return { ok: false, code: 'missing' };
  const expectedHash = String(input.expectedTokenHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) return { ok: false, code: 'misconfigured' };
  if (!constantTimeStringEqual(hashSetupCredential(provided), expectedHash)) {
    return { ok: false, code: 'invalid' };
  }

  const expectedOrigin = String(input.expectedOrigin || '').trim();
  const requestOrigin = String(input.requestOrigin || '').trim();
  if (!expectedOrigin || !requestOrigin || expectedOrigin !== requestOrigin) {
    return { ok: false, code: 'origin' };
  }

  const expiresAt = parseExpiry(input.expiresAt);
  if (!expiresAt) return { ok: false, code: 'misconfigured' };
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  if (now >= expiresAt) return { ok: false, code: 'expired' };
  return { ok: true, expiresAt };
}

export type SetupProgress = {
  needsSetup: boolean;
  isReinstall: boolean;
  setupComplete: boolean;
};

/**
 * A retained setup token must never reopen password recovery after a completed
 * setup. The database marker is committed in the same transaction as the
 * owner, settings, and initial session, so it is the authoritative boundary.
 */
export function classifySetupProgress(input: {
  ownerCount: number;
  setupState?: string | null;
  hasSetupToken: boolean;
}): SetupProgress {
  const needsSetup = input.ownerCount === 0;
  const setupComplete = input.ownerCount > 0 && input.setupState === SETUP_STATE_COMPLETE;
  const isReinstall = input.ownerCount > 0 && input.hasSetupToken && !setupComplete;
  return { needsSetup, isReinstall, setupComplete };
}

const SETUP_LOGO_URL = /^\/static-assets\/branding\/(portal-logo-[0-9a-f-]+\.png)$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Resolve only server-generated, normalized PNG logos. This deliberately does
 * not accept arbitrary same-origin paths, remote URLs, data URLs, SVG, or a
 * client-selected extension.
 */
export function validateSetupLogoUrl(
  logoUrl: string | null | undefined,
  brandingDir: string,
): string {
  const normalized = String(logoUrl || '').trim();
  if (!normalized) return '';

  const match = SETUP_LOGO_URL.exec(normalized);
  if (!match) {
    throw new Error('Setup logo must be a Portal-normalized PNG upload.');
  }

  const candidate = path.join(brandingDir, match[1]);
  const relative = path.relative(path.resolve(brandingDir), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Setup logo path is invalid.');
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < PNG_SIGNATURE.length || stat.size > 4 * 1024 * 1024) {
      throw new Error('Setup logo file is invalid.');
    }
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    fs.readSync(fd, signature, 0, signature.length, 0);
    if (!signature.equals(PNG_SIGNATURE)) {
      throw new Error('Setup logo is not a normalized PNG.');
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
      throw new Error('Setup logo upload was not found. Upload it again.');
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  return `/static-assets/branding/${match[1]}`;
}
