import Bowser from 'bowser';
import { Request } from 'express';
import net from 'net';
import { prisma } from '../config/database';

// ─── In-memory blocked IP set (loaded from DB on startup) ───
export const blockedIPs = new Set<string>();

// Load blocked IPs from DB
export async function loadBlockedIPs(): Promise<void> {
  try {
    const blocked = await prisma.activityLog.findMany({
      where: {
        action: 'IP_BLOCKED',
        metadata: { path: ['unblocked'], equals: false },
      },
      select: { ipAddress: true },
    });
    blocked.forEach((b) => {
      if (b.ipAddress) blockedIPs.add(b.ipAddress);
    });
    console.log(`🛡️  Loaded ${blockedIPs.size} blocked IPs`);
  } catch {
    // metadata JSON query may not work on older schemas — fallback
    try {
      const blocked = await prisma.activityLog.findMany({
        where: { action: 'IP_BLOCKED' },
        select: { ipAddress: true, metadata: true },
      });
      blocked.forEach((b) => {
        const meta = b.metadata as any;
        if (b.ipAddress && (!meta || meta.unblocked !== true)) {
          blockedIPs.add(b.ipAddress);
        }
      });
      console.log(`🛡️  Loaded ${blockedIPs.size} blocked IPs (fallback)`);
    } catch {
      console.warn('⚠️  Could not load blocked IPs');
    }
  }
}

// ─── Extract real IP ───
export function extractIP(req: Request): string {
  // Express is the single proxy-trust authority. Reading forwarding headers
  // again here would bypass that policy and let direct clients spoof the key
  // used by blocking, login throttling, and security activity records.
  const candidate = String(req.ip || req.socket.remoteAddress || '').trim();
  const normalized = candidate.replace(/^::ffff:/i, '');
  return net.isIP(normalized) ? normalized : 'unknown';
}

// ─── Parse user agent ───
export interface DeviceInfo {
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  device: string; // Desktop, Mobile, Tablet
  summary: string; // e.g. "Desktop - Chrome 131 on macOS"
}

export function parseUserAgent(ua?: string): DeviceInfo {
  if (!ua) return { browser: 'Unknown', browserVersion: '', os: 'Unknown', osVersion: '', device: 'Unknown', summary: 'Unknown device' };
  const parsed = Bowser.parse(ua);
  const browser = parsed.browser;
  const os = parsed.os;
  const platform = parsed.platform;

  const deviceType = platform.type
    ? platform.type.charAt(0).toUpperCase() + platform.type.slice(1)
    : 'Desktop';
  const browserName = browser.name || 'Unknown';
  const browserVer = browser.version?.split('.')[0] || '';
  const osName = os.name || 'Unknown';

  return {
    browser: browserName,
    browserVersion: browserVer,
    os: osName,
    osVersion: os.version || '',
    device: deviceType,
    summary: `${deviceType} - ${browserName}${browserVer ? ' ' + browserVer : ''} on ${osName}`,
  };
}

// ─── GeoIP lookup ───
export interface GeoInfo {
  city: string;
  region: string;
  country: string;
  summary: string; // e.g. "New York, NY, US"
}

function firstHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value || '').trim();
}

function cleanGeoHeader(value: string | string[] | undefined, maxLength: number): string {
  const raw = firstHeader(value);
  if (!raw || raw.length > maxLength * 3) return '';
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  return decoded
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isLocalAddress(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized === 'localhost') return true;
  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match172 = normalized.match(/^172\.(\d{1,3})\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

/**
 * Uses reverse-proxy metadata already supplied by Cloudflare instead of a
 * bundled, stale GeoIP database. Location is display-only and never feeds an
 * authorization or blocking decision.
 */
export function lookupGeo(ip: string, headers?: Request['headers']): GeoInfo {
  const empty: GeoInfo = { city: '', region: '', country: '', summary: '' };
  if (!ip || ip === 'unknown' || isLocalAddress(ip)) {
    return { ...empty, summary: 'Local Network' };
  }

  const hasCloudflareContext = Boolean(firstHeader(headers?.['cf-ray']) || firstHeader(headers?.['cf-connecting-ip']));
  if (!headers || !hasCloudflareContext) return { ...empty, summary: 'Unknown location' };

  const city = cleanGeoHeader(headers['cf-ipcity'], 100);
  const region = cleanGeoHeader(headers['cf-region-code'] || headers['cf-region'], 100);
  const rawCountry = cleanGeoHeader(headers['cf-ipcountry'], 2).toUpperCase();
  const country = /^[A-Z]{2}$/.test(rawCountry) && !['XX', 'T1'].includes(rawCountry) ? rawCountry : '';
  const parts = [city, region, country].filter(Boolean);
  return {
    city,
    region,
    country,
    summary: parts.join(', ') || 'Unknown location',
  };
}

// ─── Failed login tracking ───
// One entry per source IP; it expires 15 minutes after that source's last
// failed attempt. The table is also bounded, so a sign-in flood from many
// distinct addresses cannot grow it without limit. Thresholds and the window
// are unchanged.
const failedAttempts = new Map<string, { count: number; lastAttempt: number; limit: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 min
const MAX_FAILED_ATTEMPTS = 10;
export const MAX_TRACKED_FAILED_LOGIN_SOURCES = 50_000;
const EVICTION_SCAN_LIMIT = 1_000;

function isExpired(entry: { lastAttempt: number }, now: number): boolean {
  return (now - entry.lastAttempt) > RATE_LIMIT_WINDOW;
}

/** Entries are re-inserted on every attempt, so the map stays in last-attempt
 * order and expired entries sit at its head. */
function sweepExpiredFailedAttempts(now: number): void {
  for (const [ip, entry] of failedAttempts) {
    if (!isExpired(entry, now)) return;
    failedAttempts.delete(ip);
  }
}

/** Make room for one new source. A currently blocked source is released only
 * if none of the oldest EVICTION_SCAN_LIMIT entries is unblocked. */
function evictForNewSource(): void {
  let oldest: string | undefined;
  let scanned = 0;
  for (const [ip, entry] of failedAttempts) {
    oldest ??= ip;
    if (entry.count < entry.limit) {
      failedAttempts.delete(ip);
      return;
    }
    if (++scanned >= EVICTION_SCAN_LIMIT) break;
  }
  if (oldest !== undefined) failedAttempts.delete(oldest);
}

export function recordFailedAttempt(ip: string, maxFailedAttempts = MAX_FAILED_ATTEMPTS): { blocked: boolean; attempts: number } {
  const now = Date.now();
  sweepExpiredFailedAttempts(now);
  const existing = failedAttempts.get(ip);
  const entry = existing && !isExpired(existing, now) ? existing : undefined;
  if (existing && !entry) failedAttempts.delete(ip);
  if (!entry && failedAttempts.size >= MAX_TRACKED_FAILED_LOGIN_SOURCES) evictForNewSource();
  const current = { count: (entry?.count || 0) + 1, lastAttempt: now, limit: maxFailedAttempts };
  failedAttempts.delete(ip);
  failedAttempts.set(ip, current);
  return { blocked: current.count >= maxFailedAttempts, attempts: current.count };
}

export function clearFailedAttempts(ip: string): void {
  failedAttempts.delete(ip);
}

export function isRateLimited(ip: string, maxFailedAttempts = MAX_FAILED_ATTEMPTS): boolean {
  const now = Date.now();
  sweepExpiredFailedAttempts(now);
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (isExpired(entry, now)) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= maxFailedAttempts;
}

export const __failedLoginTrackingTest = Object.freeze({
  size: () => failedAttempts.size,
  reset: () => failedAttempts.clear(),
});

// ─── Build rich metadata from request ───
export interface TrackingMetadata {
  ip: string;
  device: Record<string, string>;
  geo: Record<string, string>;
  rawUserAgent: string;
}

export function extractTrackingMetadata(req: Request): TrackingMetadata {
  const ip = extractIP(req);
  const ua = req.get('user-agent') || '';
  const device = parseUserAgent(ua);
  const geo = lookupGeo(ip, req.headers);
  return {
    ip,
    device: { ...device },
    geo: { ...geo },
    rawUserAgent: ua,
  };
}

// ─── Format activity message ───
export function formatLoginMessage(email: string, meta: TrackingMetadata, success: boolean, reason?: string): string {
  if (success) {
    return `✅ Login Success\nUser: ${email}\nIP: ${meta.ip} (${meta.geo.summary})\nDevice: ${meta.device.summary}`;
  }
  return `❌ Login Failed\nUser: ${email}\nIP: ${meta.ip} (${meta.geo.summary})\nDevice: ${meta.device.summary}\nReason: ${reason || 'Unknown'}`;
}

export function formatHoneypotMessage(email: string, meta: TrackingMetadata): string {
  return `🍯 Signup Honeypot Triggered\nAttempted Email: ${email}\nIP: ${meta.ip} (${meta.geo.summary})\nDevice: ${meta.device.summary}\n⛔ IP has been blocked`;
}
