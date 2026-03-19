import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { getAppPort } from '../services/app-process.service';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync, execSync } from 'child_process';
import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import { authenticateToken } from '../middleware/auth';
import { scanFile } from '../services/virusScan';
import { prisma } from '../config/database';
import { config } from '../config/env';

const router = Router();

const APPS_DIR = '/portal/apps';
const ZIPS_DIR = '/portal/app-zips';

fs.mkdirSync(APPS_DIR, { recursive: true });
fs.mkdirSync(ZIPS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ZIPS_DIR),
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  },
});

// POST /api/apps - upload and extract
router.post('/', authenticateToken, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No zip file provided' });
      return;
    }

    // Virus scan the uploaded zip
    const scanResult = await scanFile(req.file.path);
    if (!scanResult.clean) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ error: `File rejected: malware detected (${scanResult.threat})` });
      return;
    }

    const name = (req.body.name || path.basename(req.file.originalname, '.zip')).replace(/[^a-zA-Z0-9_-]/g, '_');
    const description = req.body.description || '';
    const appDir = path.join(APPS_DIR, `${req.user!.userId}-${name}-${Date.now()}`);

    fs.mkdirSync(appDir, { recursive: true });
    // Use -j to prevent path traversal (zip slip), then verify extracted paths
    execFileSync('unzip', ['-o', req.file.path, '-d', appDir], { timeout: 30000 });

    // Post-extract: verify no files escaped the target directory
    try {
      const files = execFileSync('find', [appDir, '-type', 'f'], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n');
      for (const f of files) {
        const resolved = path.resolve(f);
        if (!resolved.startsWith(path.resolve(appDir))) {
          // Zip slip detected — nuke the directory
          execFileSync('rm', ['-rf', appDir], { timeout: 5000 });
          fs.unlinkSync(req.file.path);
          res.status(400).json({ error: 'Malicious zip detected: path traversal attempt blocked' });
          return;
        }
      }
    } catch {}


    // Auto-detect project type
    let detectedType = 'unknown';
    let suggestedCommand = '';
    const checkDir = fs.readdirSync(appDir);
    // If there's a single subdirectory, look inside it
    let projectRoot = appDir;
    if (checkDir.length === 1 && fs.statSync(path.join(appDir, checkDir[0])).isDirectory()) {
      projectRoot = path.join(appDir, checkDir[0]);
    }
    const files = fs.readdirSync(projectRoot);
    if (files.includes('package.json')) {
      detectedType = 'node';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
        suggestedCommand = pkg.scripts?.start ? 'npm start' : pkg.scripts?.dev ? 'npm run dev' : 'node index.js';
      } catch { suggestedCommand = 'npm start'; }
    } else if (files.includes('requirements.txt')) {
      detectedType = 'python';
      suggestedCommand = files.includes('app.py') ? 'python app.py' : files.includes('main.py') ? 'python main.py' : 'python -m flask run';
    } else if (files.includes('Cargo.toml')) {
      detectedType = 'rust';
      suggestedCommand = 'cargo run';
    } else if (files.includes('Makefile') || files.includes('makefile')) {
      detectedType = 'make';
      suggestedCommand = 'make';
    } else if (files.includes('Dockerfile') || files.includes('docker-compose.yml')) {
      detectedType = 'docker';
      suggestedCommand = files.includes('docker-compose.yml') ? 'docker compose up -d' : 'docker build -t app . && docker run -d app';
    } else if (files.includes('index.html')) {
      detectedType = 'static';
      suggestedCommand = 'npx serve .';
    } else if (files.includes('go.mod')) {
      detectedType = 'go';
      suggestedCommand = 'go run .';
    }

    const app = await prisma.app.create({
      data: {
        userId: req.user!.userId,
        name,
        description: description || `${detectedType} project`,
        zipPath: appDir,
      },
    });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'APP_UPLOAD',
        resource: 'app',
        resourceId: app.id,
        severity: 'INFO',
      },
    });

    res.status(201).json({ ...app, detectedType, suggestedCommand });
  } catch (error) {
    console.error('App upload error:', error);
    res.status(500).json({ error: 'Failed to upload app' });
  }
});

// GET /api/apps - list
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const apps = await prisma.app.findMany({
      where: { userId: req.user!.userId },
      include: { shareLinks: { where: { isActive: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ apps });
  } catch (error) {
    console.error('List apps error:', error);
    res.status(500).json({ error: 'Failed to list apps' });
  }
});

// DELETE /api/apps/:id
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const app = await prisma.app.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });

    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return;
    }

    // Remove extracted directory
    if (fs.existsSync(app.zipPath)) {
      fs.rmSync(app.zipPath, { recursive: true, force: true });
    }

    await prisma.app.delete({ where: { id: app.id } });

    await prisma.activityLog.create({
      data: {
        userId: req.user!.userId,
        action: 'APP_DELETE',
        resource: 'app',
        resourceId: app.id,
        severity: 'INFO',
      },
    });

    res.json({ message: 'App deleted' });
  } catch (error) {
    console.error('Delete app error:', error);
    res.status(500).json({ error: 'Failed to delete app' });
  }
});

// POST /api/apps/:id/share - create share link
router.post('/:id/share', authenticateToken, async (req: Request, res: Response) => {
  try {
    const app = await prisma.app.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });

    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return;
    }

    const token = nanoid(21);
    const shareLink = await prisma.appShareLink.create({
      data: {
        appId: app.id,
        userId: req.user!.userId,
        token,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
        maxUses: req.body.maxUses || null,
      },
    });

    res.status(201).json({ shareLink, url: `/share/${token}` });
  } catch (error) {
    console.error('Create share link error:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// Shared app routes (NO AUTH) - mounted at /share
export const shareRouter = Router();

// Rate limiter for password attempts
const passwordAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, token: string): { allowed: boolean; retryAfter?: number } {
  const key = `${ip}:${token}`;
  const now = Date.now();
  const record = passwordAttempts.get(key);

  if (!record || now > record.resetAt) {
    passwordAttempts.set(key, { count: 1, resetAt: now + 60000 });
    return { allowed: true };
  }

  if (record.count >= 5) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  record.count++;
  return { allowed: true };
}

// Session-based access grants stored in HMAC-signed cookies
function signShareAccessPayload(payloadBase64: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(payloadBase64).digest('hex');
}

function hasSessionAccess(req: Request, token: string): boolean {
  try {
    const cookie = req.cookies?.[`share_access_${token}`];
    if (!cookie) return false;
    const [payloadBase64, signature] = String(cookie).split('.');
    if (!payloadBase64 || !signature) return false;

    const expected = signShareAccessPayload(payloadBase64);
    const provided = Buffer.from(signature, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (provided.length !== expectedBuf.length || !crypto.timingSafeEqual(provided, expectedBuf)) {
      return false;
    }

    const parsed = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
    return parsed.token === token && parsed.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function grantSessionAccess(res: Response, token: string) {
  const payload = { token, expiresAt: Date.now() + 3600000 }; // 1 hour
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = signShareAccessPayload(payloadBase64);
  const encoded = `${payloadBase64}.${signature}`;
  res.cookie(`share_access_${token}`, encoded, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 3600000, // 1 hour
    path: `/share/${token}`,
  });
}

async function findShareLink(token: string) {
  return prisma.appShareLink.findFirst({
    where: {
      token,
      isActive: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    include: { app: true },
  });
}

async function enforceShareAccessWindow(link: { id: string; maxUses: number | null; currentUses: number; app: { isActive: boolean } }, res: Response): Promise<boolean> {
  if (!link.app.isActive) {
    res.status(404).send('App not found or link expired');
    return false;
  }

  if (link.maxUses && link.currentUses >= link.maxUses) {
    res.status(404).send('Link expired (max uses reached)');
    return false;
  }

  return true;
}

function shouldCountShareUse(requestedPath?: string): boolean {
  if (!requestedPath) return true;
  return !/\.(css|js|mjs|jsx|ts|tsx|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|avif|mp4|webm|ogg|mp3|wav|pdf)$/i.test(requestedPath);
}

async function recordShareUse(linkId: string): Promise<void> {
  await prisma.appShareLink.update({
    where: { id: linkId },
    data: { currentUses: { increment: 1 } },
  });
}

function renderPasswordLandingPage(token: string, projectName?: string): string {
  const name = projectName || 'Shared Project';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Required - ${name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0A0E27;
      color: #f0f4f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: rgba(255,255,255,0.03);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 1.25rem;
      padding: 2.5rem;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
    }
    .lock-icon {
      width: 48px; height: 48px; margin: 0 auto 1rem;
      display: flex; align-items: center; justify-content: center;
      background: rgba(16,185,129,0.1);
      border-radius: 50%;
    }
    .lock-icon svg { width: 24px; height: 24px; color: #10b981; }
    h1 { font-size: 1.5rem; font-weight: 700; text-align: center; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; text-align: center; margin-bottom: 1.5rem; font-size: 0.9rem; }
    .project-name { color: #818cf8; font-weight: 600; }
    input[type="password"] {
      width: 100%; padding: 0.85rem 1rem; border-radius: 0.75rem;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
      color: white; font-size: 0.95rem; outline: none;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus { border-color: rgba(16,185,129,0.5); }
    input[type="password"]::placeholder { color: #475569; }
    .btn {
      width: 100%; padding: 0.85rem; border-radius: 0.75rem;
      background: #10b981; color: white; border: none;
      font-size: 0.95rem; font-weight: 600; cursor: pointer;
      margin-top: 1rem; transition: background 0.2s, opacity 0.2s;
    }
    .btn:hover { background: #059669; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .error {
      background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.15);
      border-radius: 0.5rem; padding: 0.75rem; margin-top: 0.75rem;
      color: #f87171; font-size: 0.85rem; display: none; text-align: center;
    }
    .error.show { display: block; }
    .spinner { display: none; animation: spin 0.8s linear infinite; }
    .btn.loading .spinner { display: inline-block; }
    .btn.loading .btn-text { display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="lock-icon">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
    </div>
    <h1>Password Required</h1>
    <p class="subtitle">Access <span class="project-name">${name}</span></p>
    <form id="authForm">
      <input type="password" id="password" placeholder="Enter password" autofocus autocomplete="off" />
      <div class="error" id="error"></div>
      <button type="submit" class="btn" id="submitBtn">
        <span class="btn-text">Access Project</span>
        <span class="spinner">⟳</span>
      </button>
    </form>
  </div>
  <script>
    const form = document.getElementById('authForm');
    const pw = document.getElementById('password');
    const err = document.getElementById('error');
    const btn = document.getElementById('submitBtn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!pw.value) return;
      btn.classList.add('loading');
      btn.disabled = true;
      err.classList.remove('show');
      try {
        const res = await fetch('/share/${token}/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value })
        });
        if (res.ok) {
          window.location.reload();
        } else {
          const data = await res.json();
          err.textContent = data.error || 'Authentication failed';
          err.classList.add('show');
          pw.value = '';
          pw.focus();
        }
      } catch {
        err.textContent = 'Connection error. Please try again.';
        err.classList.add('show');
      } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

async function serveAppFile(app: { zipPath: string }, requestedPath: string, res: Response, token?: string): Promise<boolean> {
  try {
    const appDir = app.zipPath;
    const resolvedAppDir = path.resolve(appDir);

    if (!fs.existsSync(resolvedAppDir)) {
      console.error(`[Share] App directory not found: ${resolvedAppDir}`);
      return false;
    }

    // Prefer built artifacts when app root contains source + dist/ output.
    // Some shared apps are stored as full project folders (root index.html points to /src/main.tsx),
    // which white-screens when served by the portal runtime.
    const distDir = path.join(resolvedAppDir, 'dist');
    const contentRoot = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : resolvedAppDir;

    if (contentRoot !== resolvedAppDir) {
      console.log(`[Share] Using dist content root: ${contentRoot} (from ${resolvedAppDir})`);
    } else {
      // Guard: if no dist/ and root index.html contains Vite dev markers, refuse to serve it
      const guardIndex = path.join(resolvedAppDir, 'index.html');
      if (fs.existsSync(guardIndex)) {
        const guardHtml = fs.readFileSync(guardIndex, 'utf-8');
        if (guardHtml.includes('/src/main.tsx') || guardHtml.includes('/src/main.ts') || guardHtml.includes('/src/main.jsx')) {
          console.error(`[Share] BLOCKED: ${resolvedAppDir}/index.html contains Vite dev entry. Build artifacts (dist/) missing.`);
          res.status(500).send('<html><body style="font-family:sans-serif;padding:2rem;background:#0A0E27;color:#f0f4f8;"><h1>App Not Built</h1><p>This shared app has not been built for production. Please contact the app owner.</p></body></html>');
          return true;
        }
      }
    }

    // Determine file to serve
    const filePath = requestedPath || 'index.html';
    const fullPath = path.join(contentRoot, filePath);
    const resolvedPath = path.resolve(fullPath);

    // Directory traversal protection
    if (!resolvedPath.startsWith(contentRoot)) {
      console.error(`[Share] Directory traversal attempt: ${resolvedPath}`);
      res.status(403).send('Forbidden');
      return true;
    }

    // Serve file if it exists and is not a directory
    if (fs.existsSync(resolvedPath)) {
      const stats = fs.statSync(resolvedPath);

      if (!stats.isDirectory()) {
        // Special handling for HTML files - inject <base> tag so relative assets resolve correctly
        if (token && resolvedPath.endsWith('.html')) {
          const html = fs.readFileSync(resolvedPath, 'utf-8');
          const baseTag = `<base href="/share/${token}/">`;
          let modifiedHtml;
          if (html.includes('<head>')) {
            modifiedHtml = html.replace('<head>', `<head>\n    ${baseTag}`);
          } else if (html.includes('<HEAD>')) {
            modifiedHtml = html.replace('<HEAD>', `<HEAD>\n    ${baseTag}`);
          } else {
            modifiedHtml = baseTag + '\n' + html;
          }
          console.log(`[Share] Serving HTML with <base> tag: ${resolvedPath} (token: ${token})`);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(modifiedHtml);
        } else {
          console.log(`[Share] Serving file: ${resolvedPath}`);
          res.sendFile(resolvedPath);
        }
        return true;
      } else {
        // If it's a directory, try serving index.html from it
        const indexPath = path.join(resolvedPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          return serveAppFile(app, path.join(requestedPath || '', 'index.html'), res, token);
        }
      }
    }

    // SPA fallback - serve root index.html for client-side routing (non-file paths)
    const rootIndex = path.join(contentRoot, 'index.html');
    if (fs.existsSync(rootIndex) && requestedPath && !requestedPath.includes('.')) {
      console.log(`[Share] SPA fallback: ${rootIndex}`);
      return serveAppFile(app, '', res, token);
    }

    console.error(`[Share] File not found: ${resolvedPath}`);
    return false;
  } catch (error) {
    console.error('[Share] serveAppFile error:', error);
    res.status(500).send('Server error');
    return true;
  }
}

// Share-scoped API proxy.
// Supports apps that call relative "api/..." under /share/:token/.
// Uses streaming proxy semantics (no redirect) so methods/bodies/query are preserved.
shareRouter.all('/:token/api/*', async (req: Request, res: Response) => {
  const { token } = req.params;
  const proxiedPath = req.params[0] || '';
  const qsIndex = req.originalUrl.indexOf('?');
  const query = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';

  try {
    const link = await findShareLink(token);
    if (!link) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (!(await enforceShareAccessWindow(link, res))) {
      return;
    }

    // If password-protected, require established share session.
    if (!link.isPublic && link.passwordHash) {
      if (!hasSessionAccess(req, token)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    // Default target: portal API
    const target = "/api/" + proxiedPath + query;

    // Resolve backend target via env-var convention: APP_API_TARGET_{NAMESPACE}
    // e.g. APP_API_TARGET_MY_APP=http://127.0.0.1:5005
    // Fallback: managed app port -> portal self-proxy.
    const namespace = proxiedPath.includes('/') ? proxiedPath.split('/')[0] : proxiedPath;
    const envKey = 'APP_API_TARGET_' + namespace.toUpperCase().replace(/-/g, '_');
    let targetUrl = process.env[envKey]
      ? process.env[envKey] + target
      : req.protocol + "://" + req.get('host') + target;

    // Check managed fullstack app port as secondary
    if (!process.env[envKey]) {
      const appPort = getAppPort(link.appId);
      if (appPort) {
        targetUrl = `http://127.0.0.1:${appPort}${target}`;
      }
    }

    const incomingHeaders = req.headers as Record<string, string | string[] | undefined>;
    const upstreamHeaderAllowlist = new Set([
      'accept',
      'accept-language',
      'content-type',
      'if-match',
      'if-none-match',
      'if-modified-since',
      'if-unmodified-since',
      'range',
      'x-requested-with',
    ]);
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(incomingHeaders)) {
      if (!v) continue;
      const key = k.toLowerCase();
      if (!upstreamHeaderAllowlist.has(key)) continue;
      forwardHeaders[key] = Array.isArray(v) ? v.join(', ') : v;
    }

    // Always pass share token context; downstream can choose to honor it.
    forwardHeaders['x-share-token'] = token;
    forwardHeaders['x-portal-proxy'] = 'share-app-api';

    // Optional internal marker for selected share API prefixes.
    const internalPrefixes = (process.env.SHARE_INTERNAL_API_PREFIXES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (internalPrefixes.some((p) => proxiedPath === p || proxiedPath.startsWith(p + '/'))) {
      forwardHeaders['x-internal-service'] = 'share-proxy';
    }

    const method = req.method.toUpperCase();
    const shouldSendBody = !['GET', 'HEAD'].includes(method);
    // For multipart/form-data uploads, use the raw body buffer captured before
    // express.json() consumed the stream. For JSON, serialize as before.
    let body: any = undefined;
    if (shouldSendBody) {
      const incomingCt = (req as any).headers['content-type'] || '';
      if (incomingCt.includes('multipart/form-data') && (req as any).rawBody) {
        body = (req as any).rawBody;
      } else {
        body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      }
    }

    const upstream = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
      redirect: 'manual',
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-encoding') return;
      res.setHeader(key, value);
    });

    // Use arrayBuffer for binary-safe response forwarding (e.g., PDF downloads)
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } else {
      const responseText = await upstream.text();
      res.send(responseText);
    }

    console.log('[ShareAPI] ' + method + ' /share/' + token + '/api/' + proxiedPath + ' -> ' + target + ' (' + upstream.status + ')');
  } catch (error) {
    console.error('[ShareAPI] proxy error:', error);
    res.status(502).json({ error: 'Share API proxy error' });
  }
});

// GET /share/:token/progress - Load saved progress
shareRouter.get('/:token/progress', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const link = await findShareLink(token);
    if (!link) { res.status(404).json({ error: 'Not found' }); return; }
    if (!(await enforceShareAccessWindow(link, res))) { return; }

    // Check password session if protected
    if (!link.isPublic && link.passwordHash) {
      if (!hasSessionAccess(req, token)) {
        res.status(401).json({ error: 'Unauthorized' }); return;
      }
    }

    res.json({ data: link.progressData || null });
  } catch (error) {
    console.error('Load progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /share/:token/progress - Save progress
shareRouter.put('/:token/progress', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const link = await findShareLink(token);
    if (!link) { res.status(404).json({ error: 'Not found' }); return; }
    if (!(await enforceShareAccessWindow(link, res))) { return; }

    // Check password session if protected
    if (!link.isPublic && link.passwordHash) {
      if (!hasSessionAccess(req, token)) {
        res.status(401).json({ error: 'Unauthorized' }); return;
      }
    }

    // Validate payload size (max 1MB)
    const body = JSON.stringify(req.body);
    if (body.length > 1048576) {
      res.status(413).json({ error: 'Progress data too large' }); return;
    }

    await prisma.appShareLink.update({
      where: { id: link.id },
      data: { progressData: req.body as any },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Save progress error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /share/:token/auth - Validate password
shareRouter.post('/:token/auth', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    const rl = checkRateLimit(ip, token);
    if (!rl.allowed) {
      res.status(429).json({ error: `Too many attempts. Try again in ${rl.retryAfter} seconds.` });
      return;
    }

    if (!password) {
      res.status(400).json({ error: 'Password required' });
      return;
    }

    const link = await findShareLink(token);
    if (!link || !link.passwordHash) {
      res.status(404).json({ error: 'Link not found' });
      return;
    }

    const valid = await bcrypt.compare(password, link.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }

    grantSessionAccess(res, token);
    res.json({ success: true });
  } catch (error) {
    console.error('Share auth error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

shareRouter.get('/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const shareLink = await findShareLink(token);

    if (!shareLink) {
      res.status(404).send('App not found or link expired');
      return;
    }

    if (!(await enforceShareAccessWindow(shareLink, res))) {
      return;
    }

    // If password-protected, check session access
    if (!shareLink.isPublic && shareLink.passwordHash) {
      if (!hasSessionAccess(req, token)) {
        res.setHeader('Content-Type', 'text/html');
        res.send(renderPasswordLandingPage(token, shareLink.app.name));
        return;
      }
    }

    await recordShareUse(shareLink.id);

    // Serve index.html
    if (await serveAppFile(shareLink.app, 'index.html', res, token)) return;
    res.status(404).send('No index.html found');
  } catch (error) {
    console.error('Serve shared app error:', error);
    res.status(500).send('Server error');
  }
});

shareRouter.get('/:token/*', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const shareLink = await findShareLink(token);

    if (!shareLink) {
      res.status(404).send('Not found');
      return;
    }

    if (!(await enforceShareAccessWindow(shareLink, res))) {
      return;
    }

    // If password-protected, check session access
    if (!shareLink.isPublic && shareLink.passwordHash) {
      if (!hasSessionAccess(req, token)) {
        const requestedPath = req.params[0];
        // For non-HTML asset requests, return 401 instead of the landing page
        // This prevents browsers from caching HTML as CSS/JS
        if (requestedPath && /\.(css|js|mjs|jsx|ts|tsx|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|avif|mp4|webm|ogg|mp3|wav)$/i.test(requestedPath)) {
          res.status(401).send('Unauthorized');
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(renderPasswordLandingPage(token, shareLink.app.name));
        return;
      }
    }

    const requestedPath = req.params[0];
    if (shouldCountShareUse(requestedPath)) {
      await recordShareUse(shareLink.id);
    }
    console.log(`[Share] Wildcard route: token=${token}, path=${requestedPath}, zipPath=${shareLink.app.zipPath}`);
    if (await serveAppFile(shareLink.app, requestedPath, res, token)) return;
    res.status(404).send('Not found');
  } catch (error) {
    console.error('Serve shared asset error:', error);
    res.status(500).send('Server error');
  }
});

export default router;
