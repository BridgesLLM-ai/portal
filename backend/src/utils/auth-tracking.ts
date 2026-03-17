import Bowser from 'bowser';
import geoip from 'geoip-lite';
import { Request } from 'express';
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
  } catch (e) {
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
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
    return first;
  }
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return Array.isArray(cfIp) ? cfIp[0] : cfIp;
  return req.ip || req.socket.remoteAddress || 'unknown';
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

export function lookupGeo(ip: string): GeoInfo {
  const empty: GeoInfo = { city: '', region: '', country: '', summary: '' };
  if (!ip || ip === 'unknown' || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { ...empty, summary: 'Local Network' };
  }
  const geo = geoip.lookup(ip);
  if (!geo) return { ...empty, summary: 'Unknown location' };
  const parts = [geo.city, geo.region, geo.country].filter(Boolean);
  return {
    city: geo.city || '',
    region: geo.region || '',
    country: geo.country || '',
    summary: parts.join(', ') || 'Unknown location',
  };
}

// ─── Failed login tracking ───
const failedAttempts = new Map<string, { count: number; lastAttempt: number }>();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 min
const MAX_FAILED_ATTEMPTS = 10;

export function recordFailedAttempt(ip: string, maxFailedAttempts = MAX_FAILED_ATTEMPTS): { blocked: boolean; attempts: number } {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (entry && (now - entry.lastAttempt) > RATE_LIMIT_WINDOW) {
    failedAttempts.delete(ip);
  }
  const current = failedAttempts.get(ip) || { count: 0, lastAttempt: now };
  current.count++;
  current.lastAttempt = now;
  failedAttempts.set(ip, current);
  return { blocked: current.count >= maxFailedAttempts, attempts: current.count };
}

export function clearFailedAttempts(ip: string): void {
  failedAttempts.delete(ip);
}

export function isRateLimited(ip: string, maxFailedAttempts = MAX_FAILED_ATTEMPTS): boolean {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if ((Date.now() - entry.lastAttempt) > RATE_LIMIT_WINDOW) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= maxFailedAttempts;
}

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
  const geo = lookupGeo(ip);
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
