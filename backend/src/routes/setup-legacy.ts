import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import { hashPassword } from '../utils/password';
import { generateAccessToken, generateRefreshToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config/env';
import { APPEARANCE_DEFAULTS, SECURITY_DEFAULTS } from '../config/settings.schema';
import multer from 'multer';
import { setAuthCookies } from '../utils/authCookies';

const router = Router();

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
});

const testEmailSchema = z.object({
  email: z.string().email('Invalid email'),
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
    const existing = await prisma.user.findUnique({ where: { username: candidate } });
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base}${suffix}`.slice(0, 30);
  }
}

function getDomain(req?: Request): string {
  // Try CORS_ORIGIN first (most reliable in production)
  const corsOrigin = process.env.CORS_ORIGIN || '';
  if (corsOrigin) {
    try {
      const url = new URL(corsOrigin.split(',')[0]);
      return url.hostname;
    } catch { /* fall through */ }
  }
  // Fall back to request hostname
  if (req?.hostname && req.hostname !== 'localhost') {
    return req.hostname;
  }
  return 'localhost';
}

/**
 * Guard middleware: block all setup routes except /status and /complete
 * if setup is already done (admin exists). Prevents unauthenticated
 * probing of mail-status, test-email, upload-logo, ollama-status.
 */
async function requireSetupPending(_req: Request, _res: Response, next: NextFunction) {
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

async function checkStalwartStatus(): Promise<{ available: boolean; configured: boolean }> {
  const stalwartUrl = process.env.STALWART_URL || 'http://127.0.0.1:8580';
  try {
    const response = await fetch(`${stalwartUrl}/.well-known/jmap`, {
      signal: AbortSignal.timeout(3000),
    });
    return { available: response.ok, configured: !!process.env.STALWART_ADMIN_PASS };
  } catch {
    return { available: false, configured: false };
  }
}

function generateDnsRecords(domain: string): Array<{ type: string; name: string; value: string; priority?: number }> {
  const publicIp = process.env.PUBLIC_IP || 'YOUR_SERVER_IP';
  const dkimSelector = 'default';

  // Try to read saved DKIM record file (safer than shelling out)
  let dkimValue = 'v=DKIM1; k=rsa; p=YOUR_DKIM_PUBLIC_KEY';
  const dkimRecordPath = path.join(process.env.PORTAL_ROOT || '/root/bridgesllm-product', 'stalwart/dkim-dns-record.txt');
  try {
    if (fs.existsSync(dkimRecordPath)) {
      const saved = fs.readFileSync(dkimRecordPath, 'utf-8').trim();
      if (saved.startsWith('v=DKIM1')) dkimValue = saved;
    }
  } catch { /* ignore */ }

  return [
    { type: 'A', name: `mail.${domain}`, value: publicIp },
    { type: 'MX', name: '@', value: `mail.${domain}`, priority: 10 },
    { type: 'TXT', name: '@', value: `v=spf1 mx a ip4:${publicIp} -all` },
    { type: 'TXT', name: `${dkimSelector}._domainkey`, value: dkimValue },
    { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}` },
  ];
}

// File upload for logo
const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.env.PORTAL_ROOT || '/root/bridgesllm-product', 'assets/branding');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `logo-${Date.now()}${ext}`;
    cb(null, name);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PNG, JPEG, GIF, SVG, WebP'));
    }
  },
});

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

/**
 * GET /api/setup/status
 * Check if setup is needed — always accessible (no auth, no guard)
 */
router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ownerCount = await prisma.user.count({ where: { role: 'OWNER' as any } });
    const needsSetup = ownerCount === 0;
    res.json({
      needsSetup,
      incompleteSteps: needsSetup ? ['adminAccount', 'portalIdentity', 'registrationMode'] : [],
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/setup/mail-status
 * Check mail server status and return DNS records.
 * Only available during setup (no admin exists yet).
 */
router.get('/mail-status', requireSetupPending, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = getDomain(req);
    const { available, configured } = await checkStalwartStatus();

    // Test if SMTP is listening
    let canSend = false;
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
      } catch { /* not available */ }
    }

    const dnsRecords = available ? generateDnsRecords(domain) : [];
    res.json({ available, configured, canSend, dnsRecords, domain });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/test-email
 * Send a test email to verify configuration.
 * Only available during setup.
 */
router.post('/test-email', requireSetupPending, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = testEmailSchema.parse(req.body);

    const { available, configured } = await checkStalwartStatus();
    if (!available || !configured) {
      throw new AppError(503, 'Mail server is not available');
    }

    // Use existing mail service if available, fall back to nodemailer
    try {
      const { sendEmail } = await import('../services/mailService');
      await sendEmail({
        to: [{ email }],
        subject: 'Test Email — BridgesLLM Portal Setup',
        textBody: 'This is a test email to verify your mail configuration is working correctly.',
        htmlBody: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#111827;color:#e2e8f0;border-radius:12px;">
          <h2 style="color:#10b981;margin:0 0 12px;">&#10003; Mail Configuration Working</h2>
          <p style="margin:0 0 8px;">This test email confirms your Stalwart mail server is properly configured and can send outbound email.</p>
          <p style="color:#94a3b8;font-size:14px;margin:0;">Sent during BridgesLLM Portal setup</p>
        </div>`,
      });
    } catch {
      // Fallback to direct nodemailer if mailService isn't configured yet
      const nodemailer = require('nodemailer');
      const domain = getDomain(req);
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
        from: `BridgesLLM Portal <noreply@${domain}>`,
        to: email,
        subject: 'Test Email — BridgesLLM Portal Setup',
        text: 'This is a test email to verify your mail configuration.',
      });
    }

    res.json({ success: true, message: 'Test email sent' });
  } catch (error: any) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, `Failed to send test email: ${error.message}`);
  }
});

/**
 * POST /api/setup/upload-logo
 * Upload a logo image. Only available during setup.
 */
router.post('/upload-logo', requireSetupPending, uploadLogo.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      throw new AppError(400, 'No file uploaded');
    }
    const url = `/static-assets/branding/${req.file.filename}`;
    res.json({ success: true, url });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/complete
 * Complete setup wizard — creates admin account + saves settings.
 * Has its own guard (existingAdmin check) since this is the critical path.
 */
router.post('/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existingOwner = await prisma.user.findFirst({ where: { role: 'OWNER' as any } });
    if (existingOwner) {
      throw new AppError(409, 'Setup already completed. An owner account exists.');
    }

    const body = completeSetupSchema.parse(req.body);
    const username = await createUniqueUsername(body.name, body.email);
    const passwordHash = await hashPassword(body.password);

    // Split name into first/last for the User model
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

    // Save all setup settings
    const settingsToUpsert: Record<string, string> = {
      'appearance.portalName': body.portalName ?? APPEARANCE_DEFAULTS.portalName,
      'appearance.theme': body.theme ?? APPEARANCE_DEFAULTS.theme,
      'appearance.accentColor': body.accentColor ?? APPEARANCE_DEFAULTS.accentColor,
      'appearance.logoUrl': body.logoUrl ?? APPEARANCE_DEFAULTS.logoUrl,
      'security.registrationMode': body.registrationMode ?? SECURITY_DEFAULTS.registrationMode,
      'security.sandboxDefaultEnabled': 'true',
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

    // Set portal auth cookies with the shared auth-cookie policy.
    setAuthCookies(req, res, accessToken, refreshToken, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);

    // Log the setup completion
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

/**
 * GET /api/setup/ollama-status
 * Check Ollama status and get RAM-based recommendations.
 * Only available during setup.
 */
router.get('/ollama-status', requireSetupPending, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ollamaUrl = process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434';

    let running = false;
    let models: string[] = [];

    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        running = true;
        const data = await response.json() as any;
        models = (data?.models || []).map((m: any) => m.name);
      }
    } catch { /* Ollama not running */ }

    // RAM-based recommendations
    const os = require('os');
    const ramGb = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;

    let ramTier = '<4GB';
    let warning: string | null = 'Low-memory system. Stick to tiny models.';
    let recommendedModels = ['phi3:mini', 'tinyllama'];

    if (ramGb >= 16) {
      ramTier = '16GB+';
      warning = null;
      recommendedModels = ['llama3.1:8b', 'qwen2.5-coder:7b', 'mistral:7b'];
    } else if (ramGb >= 8) {
      ramTier = '8-16GB';
      warning = null;
      recommendedModels = ['llama3.2:3b', 'qwen2.5-coder:3b', 'mistral:7b'];
    } else if (ramGb >= 4) {
      ramTier = '4-8GB';
      warning = 'Limited RAM — smaller models recommended.';
      recommendedModels = ['llama3.2:3b', 'phi3:mini'];
    }

    res.json({ running, endpoint: ollamaUrl, models, ramGb, ramTier, warning, recommendedModels });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/setup/ollama-pull
 * Pull an Ollama model during setup (no auth required, guarded by requireSetupPending).
 */
router.post('/ollama-pull', requireSetupPending, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { model } = req.body;
    if (!model || typeof model !== 'string' || model.length > 200) {
      throw new AppError(400, 'Invalid model name');
    }

    // Whitelist: only allow pulling from Ollama registry (alphanumeric, colons, dots, slashes, dashes)
    if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) {
      throw new AppError(400, 'Invalid model name format');
    }

    const ollamaUrl = process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434';

    // Start the pull via Ollama API (non-streaming for simplicity during setup)
    const response = await fetch(`${ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: false }),
      signal: AbortSignal.timeout(300000), // 5 min timeout for large models
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

export default router;
