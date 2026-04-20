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
import { getGatewayToken, hasGatewayToken } from '../utils/gatewayToken';
import dns from 'dns/promises';
import { prisma } from '../config/database';
import { hashPassword, validatePasswordStrength } from '../utils/password';
import { PORTAL_VERSION } from '../version';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config/env';
import { APPEARANCE_DEFAULTS, SECURITY_DEFAULTS } from '../config/settings.schema';
import multer from 'multer';
import { clearAuthCookies, setAuthCookies } from '../utils/authCookies';
import { provisionUserMailbox } from '../services/userMailService';
import {
  buildIpFallbackCaddyConfig,
  configureDomainAndHttps,
  getCodingToolsStatus,
  getPublicIp,
  installCodingTool,
  updateEnvFile,
} from '../utils/serverSetup';
import { getOllamaRecommendationsByRam } from '../utils/ollamaRecommendations';
import { isReservedSystemMailboxUsername } from '../utils/reservedMailboxUsernames';

const router = Router();

const PORTAL_ROOT = process.env.PORTAL_ROOT || '/opt/bridgesllm/portal';
const INSTALL_ROOT = path.dirname(PORTAL_ROOT);

// ═══════════════════════════════════════════════════════════════
// Schemas
// ═══════════════════════════════════════════════════════════════

const completeSetupSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100).transform(n => n.trim()),
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  portalName: z.string().min(2).max(120).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accentColor must be a hex color').optional(),
  logoUrl: z.string().max(2000).optional(),
  registrationMode: z.enum(['open', 'approval', 'closed']).optional(),
  allowTelemetry: z.boolean().optional(),
  searchEngineVisibility: z.enum(['visible', 'hidden']).optional(),
});

const testEmailSchema = z.object({
  email: z.string().email('Invalid email'),
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


async function createUniqueUsername(baseName: string, email: string): Promise<string> {
  const fromName = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const fromEmail = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const base = fromName || fromEmail || 'admin';

  let candidate = base;
  let suffix = 1;
  while (true) {
    if (!isReservedSystemMailboxUsername(candidate)) {
      const existing = await prisma.user.findUnique({ where: { username: candidate } });
      if (!existing) return candidate;
    }
    suffix += 1;
    candidate = `${base}${suffix}`.slice(0, 30);
  }
}

function getDomain(req?: Request): string {
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

function teardownStalwart(mailDir: string): void {
  console.warn('[setup/install-mail] Stalwart jmap health check failed; tearing down and recreating container');
  execSync('cd /opt/bridgesllm/stalwart && docker compose down -v 2>/dev/null; docker rm -f stalwart-mail 2>/dev/null; rm -rf /opt/bridgesllm/stalwart/data', { timeout: 120000, shell: '/bin/bash' });
  fs.mkdirSync(path.join(mailDir, 'data'), { recursive: true });
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
  try {
    const response = await fetch('http://127.0.0.1:8580/api/principal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`admin:${adminPass}`).toString('base64')}`,
      },
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
function generateDkimKey(mailDir: string): string {
  const keyPath = path.join(mailDir, 'dkim.key');
  try {
    execSync(`openssl genrsa -out "${keyPath}" 2048 2>/dev/null`, { timeout: 10000 });
    const pubkey = execSync(`openssl rsa -in "${keyPath}" -pubout -outform DER 2>/dev/null | base64 -w0`, {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();
    const record = `v=DKIM1; k=rsa; p=${pubkey}`;
    fs.writeFileSync(path.join(mailDir, 'dkim-dns-record.txt'), record);
    return record;
  } catch {
    return 'v=DKIM1; k=rsa; p=YOUR_DKIM_PUBLIC_KEY';
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

/**
 * Guard: validate one-time setup token.
 * Token comes from query param (?token=...) or Authorization header (Bearer ...).
 * If SETUP_TOKEN is not set in env, skip validation (dev mode / already cleared).
 */
export function requireSetupToken(req: Request, _res: Response, next: NextFunction) {
  const expectedToken = process.env.SETUP_TOKEN;

  // No token configured — allow access (dev mode or token already cleared post-setup)
  if (!expectedToken) return next();

  const providedToken =
    (req.query.token as string) ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '') ||
    (req.headers['x-setup-token'] as string);

  if (!providedToken || providedToken !== expectedToken) {
    return next(new AppError(403, 'Invalid or missing setup token. Use the URL from your terminal.'));
  }

  next();
}

/**
 * Clear SETUP_TOKEN from .env.production after setup completes.
 */
function clearSetupToken(): void {
  const envPath = path.join(PORTAL_ROOT, 'backend', '.env.production');
  try {
    if (!fs.existsSync(envPath)) return;
    let content = fs.readFileSync(envPath, 'utf-8');
    // Remove the SETUP_TOKEN line entirely
    content = content.replace(/^SETUP_TOKEN=.*\n?/m, '');
    // Also remove the comment line above it if present
    content = content.replace(/^# One-time setup token.*\n?/m, '');
    fs.writeFileSync(envPath, content, { mode: 0o600 });
    // Clear from current process memory
    delete process.env.SETUP_TOKEN;
  } catch { /* best-effort */ }
}

// File upload for logo
const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(INSTALL_ROOT, 'assets', 'branding');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo-${Date.now()}${ext}`);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — logos can be large PNGs/SVGs
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
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
 * GET /api/setup/status
 * Always accessible — checks if setup is needed.
 */
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerCount = await prisma.user.count({ where: { role: 'OWNER' as any } });
    const needsSetup = ownerCount === 0;

    // Reinstall detection: OWNER exists but SETUP_TOKEN is present in env
    // This means the installer ran fresh on a preserved database.
    // The user needs to reset their password to regain access.
    const isReinstall = ownerCount > 0 && !!process.env.SETUP_TOKEN;

    let ownerHint: string | undefined;
    if (isReinstall) {
      const owner = await prisma.user.findFirst({ where: { role: 'OWNER' as any }, select: { email: true, username: true } });
      ownerHint = maskOwnerHint((owner as any)?.email, (owner as any)?.username);
    }

    res.json({
      needsSetup,
      version: PORTAL_VERSION,
      incompleteSteps: needsSetup ? ['adminAccount', 'portalIdentity', 'security', 'domain', 'email', 'ai'] : [],
      ...(isReinstall && { isReinstall: true, ownerHint }),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/reinstall-reset
 * Reset the OWNER's password during a reinstall (preserved database).
 * Only available when SETUP_TOKEN is present (fresh install detected existing DB).
 * After reset, clears the SETUP_TOKEN so the portal operates normally.
 */
router.post('/reinstall-reset', requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Only allowed during reinstall — OWNER exists + SETUP_TOKEN present
    const owner = await prisma.user.findFirst({ where: { role: 'OWNER' as any } });
    if (!owner) {
      throw new AppError(400, 'No owner account found. Use normal setup instead.');
    }
    if (!process.env.SETUP_TOKEN) {
      throw new AppError(403, 'Not in reinstall mode.');
    }

    const { password } = req.body;
    if (!password || typeof password !== 'string') {
      throw new AppError(400, 'Password is required.');
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      throw new AppError(400, strength.errors.join('. '));
    }

    const passwordHash = await hashPassword(password);
    await prisma.user.update({
      where: { id: owner.id },
      data: { passwordHash },
    });

    // Reinstall recovery must revoke any preserved browser/device sessions.
    // Otherwise an old refresh token can survive the password reset and keep
    // access to the preserved portal state.
    await prisma.session.deleteMany({
      where: { userId: owner.id },
    });

    // Clear any stale auth cookies carried by the current browser so the user
    // lands on a clean sign-in flow with the new password.
    clearAuthCookies(req, res);

    // Clear the setup token — reinstall recovery is complete
    clearSetupToken();

    res.json({
      ok: true,
      message: 'Password reset successfully. You can now log in.',
      username: (owner as any).username,
      email: (owner as any).email,
    });
  } catch (error) {
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
    } catch (err: any) {
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
    res.json(result);
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
    const domain = getDomain(req);
    const stalwartUrl = process.env.STALWART_URL || 'http://127.0.0.1:8580';

    let available = false;
    let configured = false;
    let canSend = false;

    try {
      const response = await fetch(`${stalwartUrl}/.well-known/jmap`, { signal: AbortSignal.timeout(3000) });
      available = response.ok;
      configured = !!process.env.STALWART_ADMIN_PASS;
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

    const dnsRecords = domain ? generateDnsRecords(domain) : [];

    res.json({ available, configured, canSend, dnsRecords, domain, hasDomain: !!domain });
  } catch (error) {
    next(error);
  }
});

function generateDnsRecords(domain: string): Array<{ type: string; name: string; value: string; priority?: number; description: string }> {
  const publicIp = getPublicIp();
  const mailDir = path.join(INSTALL_ROOT, 'stalwart');
  
  let dkimValue = 'v=DKIM1; k=rsa; p=YOUR_DKIM_PUBLIC_KEY';
  const dkimPath = path.join(mailDir, 'dkim-dns-record.txt');
  try {
    if (fs.existsSync(dkimPath)) {
      const saved = fs.readFileSync(dkimPath, 'utf-8').trim();
      if (saved.startsWith('v=DKIM1')) dkimValue = saved;
    }
  } catch {}

  // Only return DKIM + DMARC here — mail A, MX, and SPF are already shown
  // in the domain setup step so we don't ask users to add them twice.
  return [
    { type: 'TXT', name: 'default._domainkey', value: dkimValue, description: 'Cryptographic email signature — verifies emails are really from you' },
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
      const composeContent = `version: '3.8'
services:
  stalwart:
    image: stalwartlabs/stalwart:latest
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
[auth.dkim.sign]
"0.if" = "is_local_domain(sender_domain)"
"0.then" = '["rsa-" + sender_domain, "ed25519-" + sender_domain]'
"1.else" = "false"

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
        teardownStalwart(mailDir);
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
      // If domain creation fails, try teardown + recreate once
      if (!recreated) {
        console.warn('[setup/install-mail] Domain creation failed; tearing down Stalwart:', domainResult.error);
        teardownStalwart(mailDir);
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
      console.warn('[setup/install-mail] Account creation failed; tearing down and recreating Stalwart', supportResult, noreplyResult);
      teardownStalwart(mailDir);
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

    const dkimRecord = generateDkimKey(mailDir);

    updateEnvFile({
      STALWART_URL: 'http://127.0.0.1:8580',
      STALWART_ADMIN_PASS: adminPass,
      STALWART_SUPPORT_USER: 'support',
      STALWART_SUPPORT_PASS: supportPass,
      STALWART_NOREPLY_USER: 'noreply',
      STALWART_NOREPLY_PASS: noreplyPass,
      MAIL_DOMAIN: domain,
    });

    try {
      execSync('ufw allow 25/tcp 2>/dev/null; ufw allow 587/tcp 2>/dev/null; ufw allow 993/tcp 2>/dev/null', { timeout: 5000, shell: '/bin/bash' });
    } catch {}

    const dnsRecords = generateDnsRecords(domain);

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
router.post('/test-email', requireSetupPending, requireSetupToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
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
    const url = `/static-assets/branding/${req.file.filename}`;
    res.json({ success: true, url });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/setup/ollama-status
 * Check Ollama status with RAM-based recommendations.
 */
router.get('/ollama-status', requireSetupPending, requireSetupToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ollamaUrl = process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434';

    let running = false;
    let models: string[] = [];

    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        running = true;
        const data = await response.json() as any;
        models = (data?.models || []).map((m: any) => m.name);
      }
    } catch {}

    const os = require('os');
    const totalRam = os.totalmem();
    const ramGb = Math.round((totalRam / (1024 ** 3)) * 10) / 10;
    const { ramTier, warning, recommendedModels } = getOllamaRecommendationsByRam(totalRam);

    res.json({ running, endpoint: ollamaUrl, models, ramGb, ramTier, warning, recommendedModels });
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
    if (!model || typeof model !== 'string' || model.length > 200) {
      throw new AppError(400, 'Invalid model name');
    }
    if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) {
      throw new AppError(400, 'Invalid model name format');
    }

    const ollamaUrl = process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434';

    const response = await fetch(`${ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false }),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new AppError(502, `Ollama pull failed: ${text}`);
    }

    res.json({ success: true, model });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/setup/openclaw-status
 * Check OpenClaw gateway connectivity.
 */
router.get('/openclaw-status', requireSetupPending, requireSetupToken, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const gatewayUrl = process.env.OPENCLAW_API_URL || 'http://127.0.0.1:18789';
    const token = getGatewayToken();

    let installed = false;
    let version = '';
    let gatewayRunning = false;

    try {
      execSync('command -v openclaw', { timeout: 2000, stdio: 'ignore' });
      installed = true;
      version = execSync('openclaw --version 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0] || '';
    } catch {}

    if (installed) {
      try {
        const r = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(3000) });
        gatewayRunning = r.ok;
      } catch {}
    }

    res.json({
      installed,
      version,
      gatewayRunning,
      gatewayUrl,
      hasToken: !!token,
      description: 'OpenClaw is the AI agent framework that powers intelligent features like code generation, chat, and automation.',
    });
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
  try {
    const existingOwner = await prisma.user.findFirst({ where: { role: 'OWNER' as any } });
    if (existingOwner) {
      throw new AppError(409, 'Setup already completed. An owner account exists.');
    }

    const body = completeSetupSchema.parse(req.body);
    const strength = validatePasswordStrength(body.password);
    if (!strength.valid) {
      throw new AppError(400, strength.errors.join('. '));
    }

    const username = await createUniqueUsername(body.name, body.email);
    const passwordHash = await hashPassword(body.password);

    const nameParts = body.name.split(/\s+/);
    const firstName = nameParts[0] || body.name;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

    const user = await prisma.user.create({
      data: {
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

    // Provision mail account for owner — retry up to 3 times with delay
    // (Stalwart may still be starting after the email setup step)
    if (process.env.STALWART_ADMIN_PASS) {
      let mailProvisioned = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await provisionUserMailbox(username, user.id, { makePrimary: true });
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

    // Save settings
    const settingsToUpsert: Record<string, string> = {
      'appearance.portalName': body.portalName ?? APPEARANCE_DEFAULTS.portalName,
      'appearance.theme': body.theme ?? APPEARANCE_DEFAULTS.theme,
      'appearance.accentColor': body.accentColor ?? APPEARANCE_DEFAULTS.accentColor,
      'appearance.logoUrl': body.logoUrl ?? APPEARANCE_DEFAULTS.logoUrl,
      'security.registrationMode': body.registrationMode ?? SECURITY_DEFAULTS.registrationMode,
      'security.sandboxDefaultEnabled': 'true',
      'system.allowTelemetry': body.allowTelemetry === false ? 'false' : 'true',
      'system.searchEngineVisibility': body.searchEngineVisibility === 'visible' ? 'visible' : 'hidden',
    };

    await Promise.all(
      Object.entries(settingsToUpsert).map(([key, value]) =>
        prisma.systemSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
      )
    );

    // Generate auth tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });
    const refreshToken = generateRefreshToken({ userId: user.id });
    const refreshTokenHash = await hashPassword(refreshToken);

    await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash,
        ipAddress: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    setAuthCookies(req, res, accessToken, refreshToken, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: 'SETUP_COMPLETE',
        resource: 'system',
        severity: 'INFO',
        ipAddress: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
        translatedMessage: `Initial setup completed — admin: ${user.email}`,
        metadata: {
          portalName: settingsToUpsert['appearance.portalName'],
          registrationMode: settingsToUpsert['security.registrationMode'],
        },
      },
    }).catch(() => {});

    // Clear the one-time setup token — wizard is complete, endpoint is permanently locked
    clearSetupToken();

    // Clean up: strip the temporary http://<IP> origin that was kept alive for
    // the HTTP→HTTPS wizard handoff. Only the domain origins should remain.
    const envPath = path.join(PORTAL_ROOT, 'backend', '.env.production');
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf-8');
      // Remove ,http://<ip> patterns from CORS_ORIGIN
      envContent = envContent.replace(
        /^(CORS_ORIGIN=.+?),http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/m,
        '$1'
      );
      fs.writeFileSync(envPath, envContent);
    }

    // Also remove the IP-only Caddy block now that setup is complete
    try {
      const caddyPath = '/etc/caddy/Caddyfile';
      if (fs.existsSync(caddyPath)) {
        let caddyContent = fs.readFileSync(caddyPath, 'utf-8');
        // Remove the "http://<IP>" server block that was kept for setup
        // The block has nested braces (reverse_proxy { ... }), so [^}]*\} only
        // matches the inner brace. Use [\s\S]*? to match across the full block.
        caddyContent = caddyContent.replace(
          /\n*# Keep IP access alive during setup[^\n]*\nhttp:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\s*\{[\s\S]*?\n\}\n*/g,
          '\n'
        );
        fs.writeFileSync(caddyPath, caddyContent.trim() + '\n');
        execSync('systemctl reload caddy', { timeout: 5000, stdio: 'ignore' });
      }
    } catch {}

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
  } catch (error) {
    next(error);
  }
});

export default router;