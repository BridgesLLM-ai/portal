import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { execSync, exec, spawn } from 'child_process';
import multer from 'multer';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { authenticateToken, browserAuthRedirect } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { prisma } from '../config/database';
import { getOpenClawApiUrl } from '../config/openclaw';
import { nanoid } from 'nanoid';
import { gatewayRpcCall, patchSessionModel, getSessionInfo, listGatewayModels, deleteSession } from '../utils/openclawGatewayRpc';
import { detectDeployType, allocatePort, startApp, stopApp, getAppStatus, getAppPort, listRunningApps } from '../services/app-process.service';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';
import extract from 'extract-zip';
import { getGatewayToken } from '../utils/gatewayToken';

/** Shell-escape a filename for safe use in execSync commands */
function shellEscape(s: string): string {
  // Replace single quotes with escaped version, then wrap in single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const router = Router();

// Multer for ZIP uploads
const ZIPS_DIR = '/portal/project-zips';
fs.mkdirSync(ZIPS_DIR, { recursive: true });
const zipStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ZIPS_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
});
const zipUpload = multer({
  storage: zipStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  },
});
// Multer for general file uploads to projects (any file type)
const UPLOAD_TEMP_DIR = '/portal/upload-temp';
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
const fileUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_TEMP_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
});
const fileUpload = multer({
  storage: fileUploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
});

const PROJECTS_DIR = path.join(process.env.PORTAL_ROOT || '/portal', 'projects');
const DEPLOY_DIR = process.env.APPS_ROOT || '/var/www/bridgesllm-apps';
fs.mkdirSync(PROJECTS_DIR, { recursive: true });
fs.mkdirSync(DEPLOY_DIR, { recursive: true });

function getUserProjectDir(userId: string) {
  const dir = path.join(PROJECTS_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getProjectPath(userId: string, projectName: string) {
  const userDir = getUserProjectDir(userId);
  const projectDir = path.join(userDir, projectName);
  const resolved = path.resolve(projectDir);
  if (!resolved.startsWith(path.resolve(userDir))) throw new Error('Path traversal');
  return resolved;
}

async function getScopedOwnerId(req: Request): Promise<string> {
  return getWorkspaceOwnerId(req.user!);
}

async function withScopedOwner<T>(req: Request, fn: (ownerId: string) => Promise<T>): Promise<T> {
  const ownerId = await getScopedOwnerId(req);
  return fn(ownerId);
}

async function getAssistantName(): Promise<string> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: 'appearance.assistantName' } });
    return row?.value?.trim() || 'Assistant';
  } catch {
    return 'Assistant';
  }
}
// Template definitions
const TEMPLATES: Record<string, { files: Record<string, string> }> = {
  'static-html': {
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My App</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="container">
    <h1>Hello <span>World</span></h1>
    <p>Edit this page to get started</p>
  </div>
  <script src="script.js"></script>
</body>
</html>`,
      'style.css': `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, sans-serif; background: #0a0e27; color: #f0f4f8; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.container { text-align: center; }
h1 { font-size: 3rem; margin-bottom: 1rem; }
h1 span { color: #10b981; }
p { color: #94a3b8; }`,
      'script.js': `console.log('Hello from BridgesLLM!');`,
      'README.md': '# My App\n\nA static HTML app created on BridgesLLM Portal.\n',
    },
  },
  'react': {
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>React App</title>
</head>
<body>
  <div id="root"></div>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script type="text/babel" src="app.jsx"></script>
</body>
</html>`,
      'app.jsx': `function App() {
  const [count, setCount] = React.useState(0);
  return (
    <div style={{ fontFamily: 'system-ui', background: '#0a0e27', color: '#f0f4f8', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <h1>React App</h1>
        <p>Count: {count}</p>
        <button onClick={() => setCount(c => c + 1)} style={{ padding: '8px 24px', background: '#10b981', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '16px' }}>
          Click me
        </button>
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<App />);`,
      'style.css': '',
      'README.md': '# React App\n\nA React app using CDN imports.\n',
    },
  },
  'node-api': {
    files: {
      'index.js': `const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Hello from Node.js API!', timestamp: new Date().toISOString() }));
});
server.listen(3000, () => console.log('Server running on port 3000'));`,
      'package.json': JSON.stringify({ name: 'node-api', version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2),
      'README.md': '# Node.js API\n\nRun with `npm start`\n',
    },
  },
  'python': {
    files: {
      'main.py': `print("Hello from BridgesLLM!")

name = input("What is your name? ")
print(f"Nice to meet you, {name}!")
`,
      'requirements.txt': `# Add your Python dependencies here
# e.g., requests
# e.g., flask
`,
      'README.md': '# Python Project\n\nRun with `python main.py`\n',
    },
  },
  'cpp': {
    files: {
      'main.cpp': `#include <iostream>

int main() {
    std::cout << "Hello from BridgesLLM!" << std::endl;
    return 0;
}
`,
      'Makefile': `CXX = g++
CFLAGS = -Wall -std=c++17

all: main

main: main.cpp
\t$(CXX) $(CFLAGS) -o main main.cpp

clean:
\trm -f main
`,
      'README.md': '# C++ Project\n\nBuild with `make` and run `./main`\n',
    },
  },
};

// GET /api/projects - list projects
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const userDir = getUserProjectDir(ownerId);
    const entries = fs.readdirSync(userDir, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const pDir = path.join(userDir, e.name);
        const stat = fs.statSync(pDir);
        const hasGit = fs.existsSync(path.join(pDir, '.git'));
        let currentBranch = '';
        let deployedUrl = '';
        
        if (hasGit) {
          try {
            currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: pDir, timeout: 5000, encoding: 'utf-8' }).trim();
          } catch {}
        }
        
        // Check if deployed
        const deployId = `${ownerId}-${e.name}`;
        const deployPath = path.join(DEPLOY_DIR, deployId);
        if (fs.existsSync(deployPath)) {
          deployedUrl = `/hosted/${deployId}/`;
        }
        
        return {
          name: e.name,
          hasGit,
          currentBranch,
          deployedUrl,
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
        };
      });
    res.json({ projects });
  } catch (error) {
    console.error('List projects error:', error);
    res.status(500).json({ error: 'Failed to list projects', detail: (error as any)?.message });
  }
});

// POST /api/projects - create from template
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name, template = 'static-html' } = req.body;
    if (!name) { res.status(400).json({ error: 'name required' }); return; }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const projectDir = getProjectPath(ownerId, safeName);

    if (fs.existsSync(projectDir)) {
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    fs.mkdirSync(projectDir, { recursive: true });

    const tmpl = TEMPLATES[template] || TEMPLATES['static-html'];
    for (const [fname, content] of Object.entries(tmpl.files)) {
      const filePath = path.join(projectDir, fname);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }

    // Init git
    try {
      execSync('git init && git add -A && git commit -m "Initial commit"', { cwd: projectDir, timeout: 10000 });
    } catch {}

    await prisma.activityLog.create({
      data: { userId: ownerId, action: 'PROJECT_CREATE', resource: 'project', severity: 'INFO' },
    });

    res.status(201).json({ name: safeName, template });
  } catch (error) {
    console.error('Create project error:', error);
    res.status(500).json({ error: 'Failed to create project', detail: (error as any)?.message });
  }
});

// POST /api/projects/clone - clone git repo
router.post('/clone', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { url, name } = req.body;
    if (!url) { res.status(400).json({ error: 'url required' }); return; }

    const safeName = (name || url.split('/').pop()?.replace('.git', '') || 'repo').replace(/[^a-zA-Z0-9_-]/g, '_');
    const projectDir = getProjectPath(ownerId, safeName);

    if (fs.existsSync(projectDir)) {
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    // Validate URL format to prevent command injection
    if (!/^https?:\/\/[^\s"'`$()]+$/.test(url) && !/^git@[^\s"'`$()]+$/.test(url)) {
      res.status(400).json({ error: 'Invalid repository URL format' });
      return;
    }

    execSync(`git clone --depth 1 "${url}" "${projectDir}"`, { timeout: 120000 });

    res.status(201).json({ name: safeName, clonedFrom: url });
  } catch (error: any) {
    console.error('Clone error:', error);
    res.status(500).json({ error: 'Failed to clone repository', detail: error.message });
  }
});

// GET /api/projects/models/available - List available models from gateway catalog
// NOTE: This MUST be defined BEFORE /:name routes to avoid matching "models" as a project name
router.get('/models/available', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const result = await listGatewayModels();
    
    if (result.ok && result.models) {
      const models = result.models.map((m: any) => ({
        id: m.id ? (m.provider ? `${m.provider}/${m.id}` : m.id) : m.model,
        name: m.name || m.id || m.model,
        provider: m.provider,
        reasoning: m.reasoning || false,
        contextWindow: m.contextWindow,
        cost: m.cost,
      }));
      res.json({ models });
    } else {
      res.json({ 
        models: [
          { id: 'anthropic/claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic' },
          { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
          { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (legacy)', provider: 'anthropic' },
          { id: 'anthropic/claude-opus-4-5-20251101', name: 'Claude Opus 4.5', provider: 'anthropic' },
        ],
        fallback: true,
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list models' });
  }
});

// GET /api/projects/:name/tree - file tree with git status
router.get('/:name/tree', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const subPath = (req.query.path as string) || '';
    const targetDir = path.join(projectDir, subPath);
    const resolved = path.resolve(targetDir);
    if (!resolved.startsWith(path.resolve(projectDir))) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (!fs.existsSync(resolved)) { res.status(404).json({ error: 'Path not found' }); return; }

    // Get git status for all files
    let gitStatusMap: Record<string, string> = {};
    const hasGit = fs.existsSync(path.join(projectDir, '.git'));
    if (hasGit) {
      try {
        const statusOutput = execSync('git status --porcelain -uall', { cwd: projectDir, timeout: 5000, encoding: 'utf-8' });
        for (const line of statusOutput.split('\n').filter(Boolean)) {
          const status = line.substring(0, 2).trim();
          const filePath = line.substring(3).trim();
          // Map git status codes
          let statusLabel = 'modified';
          if (status === '??' || status === 'A') statusLabel = 'untracked';
          else if (status === 'M' || status === 'MM') statusLabel = 'modified';
          else if (status === 'D') statusLabel = 'deleted';
          else if (status === 'R') statusLabel = 'renamed';
          else if (status === 'A') statusLabel = 'added';
          gitStatusMap[filePath] = statusLabel;
        }
      } catch {}
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const tree = entries
      .filter(e => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.agent-memory.md')
      .map(e => {
        const entryPath = subPath ? `${subPath}/${e.name}` : e.name;
        let gitStatus: string | undefined = undefined;

        if (e.isFile()) {
          gitStatus = gitStatusMap[entryPath];
        } else if (e.isDirectory()) {
          // Check if any file in this directory has changes
          const hasChanges = Object.keys(gitStatusMap).some(fp => fp.startsWith(entryPath + '/'));
          if (hasChanges) gitStatus = 'modified';
        }

        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
          path: entryPath,
          size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : undefined,
          gitStatus,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ tree, currentPath: subPath });
  } catch (error) {
    console.error('Tree error:', error);
    res.status(500).json({ error: 'Failed to get file tree' });
  }
});

// GET /api/projects/:name/raw - serve raw file with correct MIME type (for media preview)
// Cookies are sent automatically by browsers so <img>/<audio>/<video> elements work fine
router.get('/:name/raw', browserAuthRedirect, requireApproved, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const userId = ownerId;
    const projectDir = getProjectPath(userId, req.params.name);
    const filePath = req.query.path as string;
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

    const fullPath = path.join(projectDir, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(projectDir))) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 100 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 100MB)' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      // Images
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
      '.avif': 'image/avif',
      // Audio
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
      '.flac': 'audio/flac', '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma',
      // Video
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
      // Web
      '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
      '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/plain', '.xml': 'text/xml',
      // Documents
      '.pdf': 'application/pdf',
      // Fonts
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    };

    const mime = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, max-age=300');

    const stream = fs.createReadStream(resolved);
    stream.pipe(res);
  } catch (error) {
    console.error('Raw file error:', error);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

// GET /api/projects/:name/file - read file content
router.get('/:name/file', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    const filePath = req.query.path as string;
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

    const fullPath = path.join(projectDir, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(projectDir))) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 10 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large to edit (max 10MB)' });
      return;
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
      '.html': 'html', '.css': 'css', '.json': 'json', '.md': 'markdown',
      '.py': 'python', '.sh': 'shell', '.yml': 'yaml', '.yaml': 'yaml',
      '.xml': 'xml', '.sql': 'sql', '.rs': 'rust', '.go': 'go',
      '.rb': 'ruby', '.php': 'php', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
      '.h': 'c', '.hpp': 'cpp', '.vue': 'html', '.svelte': 'html',
      '.toml': 'toml', '.ini': 'ini', '.env': 'shell', '.dockerfile': 'dockerfile',
    };

    res.json({ content, language: langMap[ext] || 'plaintext', path: filePath, size: stat.size });
  } catch (error) {
    console.error('Read file error:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// PUT /api/projects/:name/file - write file content
router.put('/:name/file', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) { res.status(400).json({ error: 'path and content required' }); return; }

    const fullPath = path.join(projectDir, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(projectDir))) { res.status(403).json({ error: 'Forbidden' }); return; }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');

    res.json({ message: 'File saved', path: filePath });
  } catch (error) {
    console.error('Write file error:', error);
    res.status(500).json({ error: 'Failed to write file' });
  }
});

// POST /api/projects/:name/file - create new file
router.post('/:name/file', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    const { path: filePath, content = '' } = req.body;
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

    const fullPath = path.join(projectDir, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(projectDir))) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (fs.existsSync(resolved)) { res.status(409).json({ error: 'File already exists' }); return; }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    res.status(201).json({ message: 'File created', path: filePath });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create file' });
  }
});

// DELETE /api/projects/:name/file
router.delete('/:name/file', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    const filePath = req.query.path as string;
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }

    const fullPath = path.join(projectDir, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(projectDir))) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (!fs.existsSync(resolved)) { res.status(404).json({ error: 'Not found' }); return; }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      fs.rmSync(resolved, { recursive: true, force: true });
    } else {
      fs.unlinkSync(resolved);
    }
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// POST /api/projects/:name/git - git operations (enhanced)
router.post('/:name/git', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const { action, message, branch, file, remote } = req.body;

    let output = '';
    const opts = { cwd: projectDir, timeout: 30000, encoding: 'utf-8' as const };

    switch (action) {
      case 'status': {
        const raw = execSync('git status --porcelain -uall', opts);
        let branch = 'main';
        try { branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim(); } catch { /* no commits yet */ }
        let ahead = 0, behind = 0;
        try {
          const ab = execSync('git rev-list --left-right --count HEAD...@{upstream}', opts).trim();
          const parts = ab.split(/\s+/);
          ahead = parseInt(parts[0]) || 0;
          behind = parseInt(parts[1]) || 0;
        } catch {}
        
        const files = raw.split('\n').filter(Boolean).map(line => {
          const xy = line.substring(0, 2);
          const fp = line.substring(3).trim();
          let status = 'modified';
          if (xy === '??') status = 'untracked';
          else if (xy.includes('A')) status = 'added';
          else if (xy.includes('D')) status = 'deleted';
          else if (xy.includes('R')) status = 'renamed';
          else if (xy.includes('M')) status = 'modified';
          return { path: fp, status, raw: xy };
        });
        
        res.json({ branch, ahead, behind, files, clean: files.length === 0 });
        return;
      }
      
      case 'log': {
        const limit = req.body.limit || 50;
        const branchFilter = req.body.branch;
        const branchArg = branchFilter ? branchFilter : '--all';
        const raw = execSync(
          `git log ${branchArg} --format='{"hash":"%H","short":"%h","author":"%an","email":"%ae","date":"%aI","relativeDate":"%ar","message":"%s","refs":"%D","parent":"%P"}' -${limit}`,
          opts
        );
        const commits = raw.split('\n').filter(Boolean).map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        res.json({ commits });
        return;
      }
      
      case 'log-enhanced': {
        const limit = req.body.limit || 30;
        const branchFilter = req.body.branch;
        const branchArg = branchFilter ? branchFilter : '--all';
        // Get log with stats
        const raw = execSync(
          `git log ${branchArg} --format="COMMIT_START%n%H|%h|%an|%ae|%aI|%ar|%s|%D|%P" --stat -${limit}`,
          { ...opts, maxBuffer: 5 * 1024 * 1024 }
        );
        const blocks = raw.split('COMMIT_START\n').filter(Boolean);
        const enhancedCommits = blocks.map(block => {
          const lines = block.trim().split('\n');
          const headerLine = lines[0];
          const parts = headerLine.split('|');
          if (parts.length < 7) return null;
          const [hash, short, author, email, date, relativeDate, ...rest] = parts;
          // message and refs may contain | so rejoin carefully
          const remaining = rest.join('|');
          const refsMatch = remaining.match(/^(.*)\|([^|]*)\|([a-f0-9 ]*)$/);
          let message = remaining, refs = '', parent = '';
          if (refsMatch) {
            message = refsMatch[1];
            refs = refsMatch[2];
            parent = refsMatch[3];
          } else {
            // Simpler split from the end
            const lastPipe = remaining.lastIndexOf('|');
            if (lastPipe > 0) {
              parent = remaining.slice(lastPipe + 1);
              const secondLast = remaining.lastIndexOf('|', lastPipe - 1);
              if (secondLast > 0) {
                refs = remaining.slice(secondLast + 1, lastPipe);
                message = remaining.slice(0, secondLast);
              } else {
                message = remaining.slice(0, lastPipe);
              }
            }
          }
          
          // Parse --stat lines
          const statLines = lines.slice(1);
          const files: Array<{ path: string; additions: number; deletions: number }> = [];
          let totalInsertions = 0, totalDeletions = 0;
          
          for (const sl of statLines) {
            // Match file stat lines like: " file.txt | 5 ++--"
            const fileMatch = sl.match(/^\s+(.+?)\s+\|\s+(\d+)\s*([+-]*)\s*$/);
            if (fileMatch) {
              const filePath = fileMatch[1].trim();
              const plusCount = (fileMatch[3].match(/\+/g) || []).length;
              const minusCount = (fileMatch[3].match(/-/g) || []).length;
              const total = parseInt(fileMatch[2]);
              const totalPM = plusCount + minusCount;
              let additions = 0, deletions = 0;
              if (totalPM > 0) {
                additions = Math.round(total * plusCount / totalPM);
                deletions = total - additions;
              } else {
                additions = total;
              }
              files.push({ path: filePath, additions, deletions });
            }
            // Match binary file lines: " file.png | Bin 0 -> 1234 bytes"
            const binMatch = sl.match(/^\s+(.+?)\s+\|\s+Bin/);
            if (binMatch) {
              files.push({ path: binMatch[1].trim(), additions: 0, deletions: 0 });
            }
            // Match summary line: " 3 files changed, 47 insertions(+), 12 deletions(-)"
            const summaryMatch = sl.match(/(\d+) insertion/);
            const delMatch = sl.match(/(\d+) deletion/);
            if (summaryMatch) totalInsertions = parseInt(summaryMatch[1]);
            if (delMatch) totalDeletions = parseInt(delMatch[1]);
          }
          
          return {
            hash, short, author, email, date, relativeDate,
            message: message.trim(),
            refs: refs.trim(),
            parentHash: parent.trim(),
            stats: {
              filesChanged: files.length,
              insertions: totalInsertions || files.reduce((s, f) => s + f.additions, 0),
              deletions: totalDeletions || files.reduce((s, f) => s + f.deletions, 0),
              files,
            },
          };
        }).filter(Boolean);
        res.json({ commits: enhancedCommits });
        return;
      }
      
      case 'revert': {
        const hash = req.body.hash;
        if (!hash || !/^[a-f0-9]{7,40}$/.test(hash)) {
          res.status(400).json({ error: 'Valid commit hash required' });
          return;
        }
        try {
          // Verify commit exists
          execSync(`git cat-file -t ${hash}`, opts);
          // Get commit message for logging
          const commitMsg = execSync(`git log -1 --format="%s" ${hash}`, opts).trim();
          // Perform revert
          const result = execSync(`git revert ${hash} --no-edit`, opts);
          // Get the new commit hash
          const newHash = execSync('git rev-parse HEAD', opts).trim();
          
          // Log activity
          const app = await prisma.app.findFirst({ where: { userId: ownerId, name: req.params.name } });
          await prisma.activityLog.create({
            data: {
              userId: ownerId,
              action: 'PROJECT_GIT_REVERT',
              resource: 'project',
              resourceId: app?.id,
              severity: 'INFO',
              metadata: { projectName: req.params.name, revertedHash: hash, revertedMessage: commitMsg, newHash },
            },
          });
          
          res.json({ output: result.toString().trim(), newHash, revertedMessage: commitMsg });
        } catch (e: any) {
          const errorOutput = e.stdout?.toString() || e.stderr?.toString() || e.message;
          // Check for conflict
          if (errorOutput.includes('CONFLICT') || errorOutput.includes('conflict')) {
            // Abort the failed revert
            try { execSync('git revert --abort', opts); } catch {}
            res.status(409).json({ error: 'Revert failed due to conflicts. The revert has been aborted.', details: errorOutput });
          } else {
            res.status(500).json({ error: 'Revert failed', details: errorOutput });
          }
        }
        return;
      }
      
      case 'diff': {
        if (file) {
          output = execSync(`git diff -- "${file}"`, opts);
          if (!output.trim()) {
            output = execSync(`git diff --cached -- "${file}"`, opts);
          }
          if (!output.trim()) {
            // Untracked file - show full content as addition
            try {
              const content = fs.readFileSync(path.join(projectDir, file), 'utf-8');
              output = `--- /dev/null\n+++ b/${file}\n` + content.split('\n').map(l => `+${l}`).join('\n');
            } catch {}
          }
        } else {
          output = execSync('git diff', opts);
          const cached = execSync('git diff --cached', opts);
          if (cached.trim()) output += '\n' + cached;
        }
        break;
      }
      
      case 'diff-commit': {
        const hash = req.body.hash;
        if (!hash) { res.status(400).json({ error: 'hash required' }); return; }
        output = execSync(`git show ${hash} --format="" --stat`, opts);
        const fullDiff = execSync(`git show ${hash} --format=""`, opts);
        res.json({ output: output.trim(), diff: fullDiff.trim() });
        return;
      }
      
      case 'add':
        output = execSync('git add -A', opts);
        break;
        
      case 'commit': {
        execSync('git add -A', opts);
        const msg = (message || 'Update').replace(/"/g, '\\"');
        output = execSync(`git commit -m "${msg}"`, opts);
        const commitHash = execSync('git rev-parse --short HEAD', opts).trim();
        const commitBranch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
        // Get lines added/removed stats
        let linesAdded = 0, linesRemoved = 0, commitFilesChanged = 0;
        try {
          const statOutput = execSync('git diff HEAD~1 --shortstat', { ...opts, timeout: 5000 }).trim();
          const filesMatch = statOutput.match(/(\d+) file/);
          const addMatch = statOutput.match(/(\d+) insertion/);
          const delMatch = statOutput.match(/(\d+) deletion/);
          commitFilesChanged = filesMatch ? parseInt(filesMatch[1]) : 0;
          linesAdded = addMatch ? parseInt(addMatch[1]) : 0;
          linesRemoved = delMatch ? parseInt(delMatch[1]) : 0;
        } catch {}
        const app = await prisma.app.findFirst({ where: { userId: ownerId, name: req.params.name } });
        await prisma.activityLog.create({
          data: { userId: ownerId, action: 'PROJECT_GIT_COMMIT', resource: 'project', resourceId: app?.id, severity: 'INFO', metadata: { projectName: req.params.name, message: message || 'Update', hash: commitHash, branch: commitBranch, filesChanged: commitFilesChanged, linesAdded, linesRemoved } },
        });
        break;
      }
      
      case 'branches': {
        const local = execSync('git branch', opts).split('\n').filter(Boolean).map(b => ({
          name: b.replace('* ', '').trim(),
          current: b.startsWith('*'),
          remote: false,
        }));
        let remote: any[] = [];
        try {
          remote = execSync('git branch -r', opts).split('\n').filter(Boolean)
            .filter(b => !b.includes('HEAD'))
            .map(b => ({
              name: b.trim(),
              current: false,
              remote: true,
            }));
        } catch {}
        res.json({ branches: [...local, ...remote] });
        return;
      }
      
      case 'checkout':
        if (!branch) { res.status(400).json({ error: 'branch required' }); return; }
        output = execSync(`git checkout ${branch}`, opts);
        { const app = await prisma.app.findFirst({ where: { userId: ownerId, name: req.params.name } });
        await prisma.activityLog.create({
          data: { userId: ownerId, action: 'PROJECT_GIT_CHECKOUT', resource: 'project', resourceId: app?.id, severity: 'INFO', metadata: { projectName: req.params.name, branch } },
        }); }
        break;
        
      case 'checkout-new':
        if (!branch) { res.status(400).json({ error: 'branch required' }); return; }
        output = execSync(`git checkout -b ${branch}`, opts);
        { const app = await prisma.app.findFirst({ where: { userId: ownerId, name: req.params.name } });
        await prisma.activityLog.create({
          data: { userId: ownerId, action: 'PROJECT_GIT_BRANCH_CREATE', resource: 'project', resourceId: app?.id, severity: 'INFO', metadata: { projectName: req.params.name, branch } },
        }); }
        break;
        
      case 'pull':
        try {
          output = execSync('git pull', opts);
        } catch (e: any) {
          output = e.stdout?.toString() || e.stderr?.toString() || 'No remote configured';
        }
        { const app = await prisma.app.findFirst({ where: { userId: ownerId, name: req.params.name } });
        const pullBranch = (() => { try { return execSync('git rev-parse --abbrev-ref HEAD', opts).trim(); } catch { return 'unknown'; } })();
        await prisma.activityLog.create({
          data: { userId: ownerId, action: 'PROJECT_GIT_PULL', resource: 'project', resourceId: app?.id, severity: 'INFO', metadata: { projectName: req.params.name, branch: pullBranch } },
        }); }
        break;
        
      case 'push':
        try {
          output = execSync('git push', opts);
        } catch (e: any) {
          // Try setting upstream
          try {
            const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
            output = execSync(`git push -u origin ${currentBranch}`, opts);
          } catch (e2: any) {
            output = e2.stdout?.toString() || e2.stderr?.toString() || 'Push failed - no remote configured';
          }
        }
        { const app = await prisma.app.findFirst({ where: { userId: ownerId, name: req.params.name } });
        const pushBranch = (() => { try { return execSync('git rev-parse --abbrev-ref HEAD', opts).trim(); } catch { return 'unknown'; } })();
        await prisma.activityLog.create({
          data: { userId: ownerId, action: 'PROJECT_GIT_PUSH', resource: 'project', resourceId: app?.id, severity: 'INFO', metadata: { projectName: req.params.name, branch: pushBranch } },
        }); }
        break;
        
      case 'remote': {
        try {
          output = execSync('git remote -v', opts);
        } catch {
          output = 'No remotes configured';
        }
        break;
      }
      
      case 'remote-add': {
        const url = req.body.url;
        const remoteName = req.body.remote || 'origin';
        if (!url) { res.status(400).json({ error: 'url required' }); return; }
        try {
          execSync(`git remote remove ${remoteName}`, opts);
        } catch {}
        output = execSync(`git remote add ${remoteName} "${url}"`, opts);
        output = `Remote '${remoteName}' added: ${url}`;
        break;
      }
      
      case 'stash':
        output = execSync('git stash', opts);
        break;
        
      case 'stash-pop':
        output = execSync('git stash pop', opts);
        break;
        
      case 'reset-file': {
        if (!file) { res.status(400).json({ error: 'file required' }); return; }
        output = execSync(`git checkout -- "${file}"`, opts);
        output = `Reset: ${file}`;
        break;
      }

      default:
        res.status(400).json({ error: 'Unknown git action' });
        return;
    }

    res.json({ output: output.toString().trim() });
  } catch (error: any) {
    res.json({ output: error.stdout?.toString() || error.stderr?.toString() || error.message });
  }
});

// POST /api/projects/upload-zip - upload ZIP as project
router.post('/upload-zip', authenticateToken, zipUpload.single('file'), async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    if (!req.file) {
      res.status(400).json({ error: 'No zip file provided' });
      return;
    }

    const name = (req.body.name || path.basename(req.file.originalname, '.zip')).replace(/[^a-zA-Z0-9_-]/g, '_');
    const projectDir = getProjectPath(ownerId, name);

    if (fs.existsSync(projectDir)) {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    fs.mkdirSync(projectDir, { recursive: true });

    // Extract ZIP (pure JS — no system unzip dependency)
    await extract(req.file.path, { dir: path.resolve(projectDir) });

    // If there's a single subdirectory, move its contents up
    const entries = fs.readdirSync(projectDir);
    if (entries.length === 1 && fs.statSync(path.join(projectDir, entries[0])).isDirectory()) {
      const subDir = path.join(projectDir, entries[0]);
      const subEntries = fs.readdirSync(subDir);
      for (const entry of subEntries) {
        fs.renameSync(path.join(subDir, entry), path.join(projectDir, entry));
      }
      fs.rmdirSync(subDir);
    }

    // Auto-detect project type
    let detectedType = 'unknown';
    let suggestedCommand = '';
    const files = fs.readdirSync(projectDir);
    if (files.includes('package.json')) {
      detectedType = 'node';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
        suggestedCommand = pkg.scripts?.start ? 'npm start' : pkg.scripts?.dev ? 'npm run dev' : 'node index.js';
      } catch { suggestedCommand = 'npm start'; }
    } else if (files.includes('requirements.txt')) {
      detectedType = 'python';
      suggestedCommand = files.includes('app.py') ? 'python app.py' : 'python main.py';
    } else if (files.includes('Cargo.toml')) {
      detectedType = 'rust'; suggestedCommand = 'cargo run';
    } else if (files.includes('index.html')) {
      detectedType = 'static'; suggestedCommand = 'npx serve .';
    } else if (files.includes('go.mod')) {
      detectedType = 'go'; suggestedCommand = 'go run .';
    } else if (files.includes('Dockerfile')) {
      detectedType = 'docker'; suggestedCommand = 'docker build -t app .';
    }

    // Init git
    try {
      execSync('git init && git add -A && git commit -m "Initial commit from ZIP upload"', { cwd: projectDir, timeout: 10000 });
    } catch {}

    // Clean up zip file
    try { fs.unlinkSync(req.file.path); } catch {}

    await prisma.activityLog.create({
      data: { userId: ownerId, action: 'PROJECT_UPLOAD_ZIP', resource: 'project', severity: 'INFO' },
    });

    res.status(201).json({ name, detectedType, suggestedCommand });
  } catch (error: any) {
    console.error('ZIP upload error:', error);
    res.status(500).json({ error: 'Failed to upload ZIP: ' + (error.message || 'unknown error') });
  }
});

// POST /api/projects/create-from-upload - create project from a chunked-uploaded file
router.post('/create-from-upload', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name, filePath: uploadedFilePath } = req.body;
    if (!name || !uploadedFilePath) {
      res.status(400).json({ error: 'name and filePath required' });
      return;
    }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const projectDir = getProjectPath(ownerId, safeName);

    if (fs.existsSync(projectDir)) {
      res.status(409).json({ error: 'Project already exists' });
      return;
    }

    // Resolve the uploaded file (it's in the user's upload dir)
    const { getUserUploadDir } = require('./files');
    const userDir = getUserUploadDir(ownerId);
    const fullPath = path.join(userDir, path.basename(uploadedFilePath));

    console.log('[create-from-upload]', { uploadedFilePath, userDir, fullPath, exists: fs.existsSync(fullPath) });

    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: `Uploaded file not found at ${fullPath}` });
      return;
    }

    fs.mkdirSync(projectDir, { recursive: true });

    // Extract ZIP (pure JS — no system unzip dependency)
    await extract(fullPath, { dir: path.resolve(projectDir) });

    // If there's a single subdirectory, move its contents up
    const entries = fs.readdirSync(projectDir);
    if (entries.length === 1 && fs.statSync(path.join(projectDir, entries[0])).isDirectory()) {
      const subDir = path.join(projectDir, entries[0]);
      const subEntries = fs.readdirSync(subDir);
      for (const entry of subEntries) {
        fs.renameSync(path.join(subDir, entry), path.join(projectDir, entry));
      }
      fs.rmdirSync(subDir);
    }

    // Auto-detect project type
    let detectedType = 'unknown';
    let suggestedCommand = '';
    const files = fs.readdirSync(projectDir);
    if (files.includes('package.json')) {
      detectedType = 'node';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
        suggestedCommand = pkg.scripts?.start ? 'npm start' : pkg.scripts?.dev ? 'npm run dev' : 'node index.js';
      } catch { suggestedCommand = 'npm start'; }
    } else if (files.includes('requirements.txt')) {
      detectedType = 'python';
      suggestedCommand = files.includes('app.py') ? 'python app.py' : 'python main.py';
    } else if (files.includes('Cargo.toml')) {
      detectedType = 'rust'; suggestedCommand = 'cargo run';
    } else if (files.includes('index.html')) {
      detectedType = 'static'; suggestedCommand = 'npx serve .';
    } else if (files.includes('go.mod')) {
      detectedType = 'go'; suggestedCommand = 'go run .';
    } else if (files.includes('Dockerfile')) {
      detectedType = 'docker'; suggestedCommand = 'docker build -t app .';
    }

    // Init git
    try {
      execSync('git init && git add -A && git commit -m "Initial commit from ZIP upload"', { cwd: projectDir, timeout: 10000 });
    } catch {}

    // Clean up uploaded file
    try { fs.unlinkSync(fullPath); } catch {}

    await prisma.activityLog.create({
      data: { userId: ownerId, action: 'PROJECT_UPLOAD_ZIP', resource: 'project', severity: 'INFO' },
    });

    res.status(201).json({ name: safeName, detectedType, suggestedCommand });
  } catch (error: any) {
    console.error('Create from upload error:', error);
    res.status(500).json({ error: 'Failed to create project: ' + (error.message || 'unknown error') });
  }
});

// POST /api/projects/:name/upload - upload files to existing project
router.post('/:name/upload', authenticateToken, fileUpload.array('files', 50), async (req: Request, res: Response) => {
  const uploadedFiles = req.files as Express.Multer.File[];
  try {
    const ownerId = await getScopedOwnerId(req);
    const userId = ownerId;
    const projectDir = getProjectPath(userId, req.params.name);
    if (!fs.existsSync(projectDir)) {
      // Clean up temp files
      if (uploadedFiles) uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    if (!uploadedFiles || uploadedFiles.length === 0) {
      res.status(400).json({ error: 'No files provided' });
      return;
    }

    // Target subdirectory within the project (default to root)
    const targetSubPath = (req.query.path as string) || '';
    const targetDir = path.join(projectDir, targetSubPath);
    const resolvedTarget = path.resolve(targetDir);
    if (!resolvedTarget.startsWith(path.resolve(projectDir))) {
      uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
      res.status(403).json({ error: 'Path traversal detected' });
      return;
    }

    // Ensure target directory exists
    fs.mkdirSync(resolvedTarget, { recursive: true });

    const results: Array<{ name: string; path: string; size: number }> = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of uploadedFiles) {
      try {
        const destPath = path.join(resolvedTarget, file.originalname);
        const resolvedDest = path.resolve(destPath);
        // Verify no path traversal in filename
        if (!resolvedDest.startsWith(path.resolve(projectDir))) {
          errors.push({ name: file.originalname, error: 'Invalid filename' });
          continue;
        }
        // Create parent dirs if needed (for filenames with subdirectory structure)
        fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
        // Move from temp to project
        fs.copyFileSync(file.path, resolvedDest);
        fs.unlinkSync(file.path);
        const relativePath = targetSubPath ? `${targetSubPath}/${file.originalname}` : file.originalname;
        results.push({ name: file.originalname, path: relativePath, size: file.size });
      } catch (err: any) {
        errors.push({ name: file.originalname, error: err.message || 'Failed to copy' });
        // Clean up temp file
        try { fs.unlinkSync(file.path); } catch {}
      }
    }

    // Log activity
    const app = await prisma.app.findFirst({ where: { userId, name: req.params.name } });
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'PROJECT_FILE_UPLOAD',
        resource: 'project',
        resourceId: app?.id,
        severity: 'INFO',
        metadata: {
          projectName: req.params.name,
          targetPath: targetSubPath || '/',
          fileCount: results.length,
          totalSize: results.reduce((s, f) => s + f.size, 0),
          fileNames: results.map(f => f.name),
        },
      },
    });

    res.json({
      message: `Uploaded ${results.length} file(s)`,
      uploaded: results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: any) {
    console.error('File upload error:', error);
    // Clean up any remaining temp files
    if (uploadedFiles) uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    res.status(500).json({ error: 'Failed to upload files', detail: error.message });
  }
});

// GET /api/projects/:name/activity - project activity feed
router.get('/:name/activity', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const limit = parseInt(req.query.limit as string) || 20;
    // Get app record for this project
    const app = await prisma.app.findFirst({
      where: { userId: ownerId, name: req.params.name },
    });

    const logs = await prisma.activityLog.findMany({
      where: {
        userId: ownerId,
        OR: [
          { resourceId: app?.id || 'none' },
          { action: { in: ['PROJECT_CREATE', 'PROJECT_DEPLOY', 'PROJECT_UPLOAD_ZIP', 'PROJECT_FILE_UPLOAD'] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// DELETE /api/projects/:name - delete project
router.delete('/:name', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    fs.rmSync(projectDir, { recursive: true, force: true });
    
    // Also remove deployment if exists
    const deployId = `${ownerId}-${req.params.name}`;
    const deployPath = path.join(DEPLOY_DIR, deployId);
    if (fs.existsSync(deployPath)) {
      fs.rmSync(deployPath, { recursive: true, force: true });
    }
    
    // Log activity
    await prisma.activityLog.create({
      data: {
        userId: ownerId,
        action: 'PROJECT_DELETE',
        resource: 'project',
        severity: 'INFO',
        metadata: { projectName: req.params.name },
      },
    });
    
    res.json({ message: 'Project deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// PATCH /api/projects/:name/rename - rename a project
router.patch('/:name/rename', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { newName } = req.body;
    if (!newName || typeof newName !== 'string') { res.status(400).json({ error: 'newName is required' }); return; }

    const sanitized = newName.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!sanitized || sanitized === '.' || sanitized === '..') { res.status(400).json({ error: 'Invalid project name' }); return; }

    const oldDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(oldDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const newDir = getProjectPath(ownerId, sanitized);
    if (fs.existsSync(newDir)) { res.status(409).json({ error: 'A project with that name already exists' }); return; }

    fs.renameSync(oldDir, newDir);

    // Update App DB record if one exists
    const app = await prisma.app.findFirst({ where: { userId: ownerId, name: req.params.name } });
    if (app) {
      await prisma.app.update({ where: { id: app.id }, data: { name: sanitized } });
    }

    // Rename deployment dir if it exists
    const oldDeployId = `${ownerId}-${req.params.name}`;
    const newDeployId = `${ownerId}-${sanitized}`;
    const oldDeployPath = path.join(DEPLOY_DIR, oldDeployId);
    const newDeployPath = path.join(DEPLOY_DIR, newDeployId);
    if (fs.existsSync(oldDeployPath)) {
      fs.renameSync(oldDeployPath, newDeployPath);
    }

    await prisma.activityLog.create({
      data: {
        userId: ownerId,
        action: 'PROJECT_RENAME',
        resource: 'project',
        resourceId: app?.id,
        severity: 'INFO',
        metadata: { oldName: req.params.name, newName: sanitized },
      },
    });

    res.json({ name: sanitized });
  } catch (error) {
    res.status(500).json({ error: 'Failed to rename project' });
  }
});

// POST /api/projects/:name/check - syntax/compile check for runtime projects
router.post('/:name/check', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const files = fs.readdirSync(projectDir);
    let language = 'unknown';
    let checkCommand = '';
    let output = '';
    const errors: string[] = [];

    // Detect project type and set check command
    if (files.includes('main.py') || files.includes('requirements.txt')) {
      language = 'python';
      // Find all .py files and check them
      const pyFiles = files.filter(f => f.endsWith('.py'));
      if (pyFiles.length > 0) {
        checkCommand = `python3 -m py_compile ${pyFiles.map(shellEscape).join(' ')} 2>&1`;
      }
    } else if (files.includes('main.cpp') || (files.includes('Makefile') && !files.includes('package.json'))) {
      language = 'cpp';
      const cppFiles = files.filter(f => f.endsWith('.cpp') || f.endsWith('.c'));
      if (cppFiles.length > 0) {
        checkCommand = `g++ -fsyntax-only -Wall ${cppFiles.map(shellEscape).join(' ')} 2>&1`;
      }
    } else if (files.includes('package.json')) {
      language = 'node';
      // Find main JS file
      let mainFile = 'index.js';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
        if (pkg.main) mainFile = pkg.main;
      } catch {}
      if (files.includes(mainFile)) {
        checkCommand = `node --check ${shellEscape(mainFile)} 2>&1`;
      }
    } else if (files.includes('index.html')) {
      language = 'html';
      // HTML doesn't need compile check
      res.json({ ok: true, language: 'html', output: 'HTML files do not require syntax checking.', errors: [] });
      return;
    }

    if (!checkCommand) {
      res.json({ ok: true, language, output: 'No checkable files found.', errors: [] });
      return;
    }

    try {
      output = execSync(checkCommand, { 
        cwd: projectDir, 
        timeout: 15000, 
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // If we get here without error, syntax check passed
      res.json({ ok: true, language, output: output || 'No syntax errors found.', errors: [] });
    } catch (e: any) {
      // Command failed - parse stderr for error messages
      const errorOutput = e.stderr?.toString() || e.stdout?.toString() || e.message || 'Unknown error';
      
      // Parse error lines
      const lines = errorOutput.split('\n').filter((l: string) => l.trim());
      for (const line of lines) {
        if (line.includes('error') || line.includes('Error') || line.includes('SyntaxError') || line.includes('warning')) {
          errors.push(line.trim());
        }
      }
      
      if (errors.length === 0 && errorOutput.trim()) {
        errors.push(errorOutput.trim());
      }
      
      res.json({ ok: false, language, output: errorOutput, errors });
    }
  } catch (error: any) {
    console.error('Check error:', error);
    res.status(500).json({ error: 'Failed to check project', detail: error.message });
  }
});

// ─── Dependency Detection & Installation ─────────────────────────────────────

// Common Python module → pip package mappings
const COMMON_PIP_MAPPINGS: Record<string, string> = {
  'cv2': 'opencv-python',
  'PIL': 'Pillow',
  'sklearn': 'scikit-learn',
  'skimage': 'scikit-image',
  'yaml': 'pyyaml',
  'bs4': 'beautifulsoup4',
  'dotenv': 'python-dotenv',
  'jwt': 'pyjwt',
  'serial': 'pyserial',
  'usb': 'pyusb',
  'dateutil': 'python-dateutil',
  'magic': 'python-magic',
  'gi': 'pygobject',
  'MySQLdb': 'mysqlclient',
  'psycopg2': 'psycopg2-binary',
  'cv': 'opencv-python',
  'faiss': 'faiss-cpu',
  'telegram': 'python-telegram-bot',
  'discord': 'discord.py',
  'aiohttp': 'aiohttp',
  'websockets': 'websockets',
  'pygame': 'pygame',
  'numpy': 'numpy',
  'pandas': 'pandas',
  'matplotlib': 'matplotlib',
  'seaborn': 'seaborn',
  'requests': 'requests',
  'flask': 'flask',
  'django': 'django',
  'fastapi': 'fastapi',
  'uvicorn': 'uvicorn',
  'sqlalchemy': 'sqlalchemy',
  'transformers': 'transformers',
  'torch': 'torch',
  'tensorflow': 'tensorflow',
  'keras': 'keras',
  'scipy': 'scipy',
  'nltk': 'nltk',
  'spacy': 'spacy',
  'openai': 'openai',
  'anthropic': 'anthropic',
  'langchain': 'langchain',
  'gradio': 'gradio',
  'streamlit': 'streamlit',
  'plotly': 'plotly',
  'bokeh': 'bokeh',
  'httpx': 'httpx',
  'pydantic': 'pydantic',
  'cryptography': 'cryptography',
  'bcrypt': 'bcrypt',
  'redis': 'redis',
  'celery': 'celery',
  'boto3': 'boto3',
  'google': 'google-cloud-core',
};

// Common C++ includes → apt package mappings
const COMMON_APT_MAPPINGS: Record<string, string> = {
  'SDL2/SDL.h': 'libsdl2-dev',
  'SDL.h': 'libsdl2-dev',
  'SDL2/SDL_image.h': 'libsdl2-image-dev',
  'SDL2/SDL_ttf.h': 'libsdl2-ttf-dev',
  'SDL2/SDL_mixer.h': 'libsdl2-mixer-dev',
  'ncurses.h': 'libncurses-dev',
  'curses.h': 'libncurses-dev',
  'GL/gl.h': 'libgl1-mesa-dev',
  'GL/glut.h': 'freeglut3-dev',
  'GLFW/glfw3.h': 'libglfw3-dev',
  'opencv2/opencv.hpp': 'libopencv-dev',
  'opencv2/core.hpp': 'libopencv-dev',
  'boost/': 'libboost-all-dev',
  'pthread.h': 'libc6-dev',
  'curl/curl.h': 'libcurl4-openssl-dev',
  'openssl/ssl.h': 'libssl-dev',
  'sqlite3.h': 'libsqlite3-dev',
  'mysql/mysql.h': 'libmysqlclient-dev',
  'pq-fe.h': 'libpq-dev',
  'json/json.h': 'libjsoncpp-dev',
  'zlib.h': 'zlib1g-dev',
  'png.h': 'libpng-dev',
  'jpeglib.h': 'libjpeg-dev',
  'portaudio.h': 'portaudio19-dev',
};

// Standard library modules that don't need installation
const PYTHON_STDLIB = new Set([
  'os', 'sys', 're', 'json', 'time', 'datetime', 'math', 'random', 'collections',
  'itertools', 'functools', 'pathlib', 'typing', 'dataclasses', 'enum', 'abc',
  'io', 'struct', 'copy', 'pickle', 'shelve', 'csv', 'configparser', 'argparse',
  'logging', 'warnings', 'traceback', 'unittest', 'doctest', 'pdb', 'profile',
  'timeit', 'threading', 'multiprocessing', 'subprocess', 'socket', 'http',
  'urllib', 'email', 'html', 'xml', 'hashlib', 'hmac', 'base64', 'binascii',
  'codecs', 'unicodedata', 'locale', 'gettext', 'textwrap', 'difflib', 'ast',
  'dis', 'inspect', 'importlib', 'pkgutil', 'modulefinder', 'platform', 'errno',
  'ctypes', 'contextlib', 'decimal', 'fractions', 'statistics', 'cmath', 'array',
  'bisect', 'heapq', 'queue', 'weakref', 'types', 'operator', 'string', 'shutil',
  'glob', 'fnmatch', 'linecache', 'tempfile', 'gzip', 'bz2', 'lzma', 'zipfile',
  'tarfile', 'getpass', 'netrc', 'pty', 'tty', 'termios', 'curses', 'select',
  'selectors', 'asyncio', 'concurrent', 'sched', 'signal', 'mmap', 'readline',
  'rlcompleter', 'code', 'codeop', 'zipimport', 'runpy', 'token', 'keyword',
  'tokenize', 'tabnanny', 'pyclbr', 'formatter', 'ssl', 'ftplib', 'poplib',
  'imaplib', 'smtplib', 'uuid', 'socketserver', 'xmlrpc', 'ipaddress', 'cgi',
  'cgitb', 'wsgiref', 'webbrowser', 'turtle', 'cmd', 'pprint', '__future__',
  'builtins', '_thread', 'gc', 'site', 'secrets', 'graphlib', 'zoneinfo',
]);

// Standard C++ headers that don't need apt packages
const CPP_STDLIB = new Set([
  'iostream', 'fstream', 'sstream', 'string', 'vector', 'map', 'set', 'list',
  'queue', 'stack', 'deque', 'array', 'unordered_map', 'unordered_set', 'algorithm',
  'cmath', 'cstdlib', 'cstdio', 'cstring', 'ctime', 'cctype', 'climits', 'cfloat',
  'cassert', 'cerrno', 'clocale', 'csignal', 'csetjmp', 'cstdarg', 'cstddef',
  'memory', 'functional', 'utility', 'tuple', 'type_traits', 'chrono', 'thread',
  'mutex', 'condition_variable', 'future', 'atomic', 'random', 'regex', 'iterator',
  'stdexcept', 'exception', 'limits', 'numeric', 'iomanip', 'bitset', 'complex',
  'valarray', 'ratio', 'initializer_list', 'any', 'optional', 'variant', 'filesystem',
  'span', 'ranges', 'concepts', 'coroutine', 'source_location', 'compare', 'version',
  'new', 'typeinfo', 'typeindex', 'format', 'charconv', 'bit', 'numbers',
  'stdio.h', 'stdlib.h', 'string.h', 'math.h', 'time.h', 'ctype.h', 'limits.h',
  'float.h', 'assert.h', 'errno.h', 'locale.h', 'signal.h', 'setjmp.h', 'stdarg.h',
  'stddef.h', 'stdint.h', 'inttypes.h', 'stdbool.h', 'stdnoreturn.h',
]);

interface DependencyCheckResult {
  needsInstall: boolean;
  language: 'python' | 'cpp' | 'node' | null;
  packages: string[];
  installedPackages?: string[];
  command?: string;
}

async function detectDependencies(projectDir: string): Promise<DependencyCheckResult> {
  const files = fs.readdirSync(projectDir);
  
  // Check for Python project
  if (files.some(f => f.endsWith('.py')) || files.includes('requirements.txt')) {
    return await detectPythonDeps(projectDir, files);
  }
  
  // Check for C++ project
  if (files.some(f => f.endsWith('.cpp') || f.endsWith('.c') || f.endsWith('.h') || f.endsWith('.hpp'))) {
    return detectCppDeps(projectDir, files);
  }
  
  // Check for Node.js project
  if (files.includes('package.json')) {
    return detectNodeDeps(projectDir);
  }
  
  return { needsInstall: false, language: null, packages: [] };
}

async function detectPythonDeps(projectDir: string, files: string[]): Promise<DependencyCheckResult> {
  const requiredPackages = new Set<string>();
  
  // Check requirements.txt first
  const reqFile = path.join(projectDir, 'requirements.txt');
  if (fs.existsSync(reqFile)) {
    const content = fs.readFileSync(reqFile, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-')) {
        // Extract package name (before ==, >=, <=, ~=, etc.)
        const pkgName = trimmed.split(/[=<>~!]/)[0].trim().toLowerCase();
        if (pkgName) requiredPackages.add(pkgName);
      }
    }
  } else {
    // Scan Python files for imports
    for (const file of files) {
      if (!file.endsWith('.py')) continue;
      try {
        const content = fs.readFileSync(path.join(projectDir, file), 'utf-8');
        // Match: import X, from X import Y
        const importRegex = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const module = match[1];
          if (!PYTHON_STDLIB.has(module)) {
            // Map to pip package name
            const pipPkg = COMMON_PIP_MAPPINGS[module] || module.toLowerCase();
            requiredPackages.add(pipPkg);
          }
        }
      } catch (e) {
        // Ignore read errors
      }
    }
  }
  
  if (requiredPackages.size === 0) {
    return { needsInstall: false, language: 'python', packages: [] };
  }
  
  // Check which packages are already installed (check venv first, then system)
  const installedPackages: string[] = [];
  const missingPackages: string[] = [];
  const venvPip = path.join(projectDir, '.venv', 'bin', 'pip');
  const pipCmd = fs.existsSync(venvPip) ? venvPip : 'pip3';
  
  for (const pkg of requiredPackages) {
    try {
      execSync(`${shellEscape(pipCmd)} show ${shellEscape(pkg)} 2>/dev/null`, { encoding: 'utf-8' });
      installedPackages.push(pkg);
    } catch {
      missingPackages.push(pkg);
    }
  }
  
  return {
    needsInstall: missingPackages.length > 0,
    language: 'python',
    packages: missingPackages,
    installedPackages,
    command: missingPackages.length > 0 ? `pip install ${missingPackages.join(' ')}` : undefined,
  };
}

function detectCppDeps(projectDir: string, files: string[]): DependencyCheckResult {
  const requiredPackages = new Set<string>();
  
  // Check if g++ is installed
  try {
    execSync('which g++', { encoding: 'utf-8' });
  } catch {
    requiredPackages.add('g++');
  }
  
  // Scan C++ files for includes
  for (const file of files) {
    if (!file.endsWith('.cpp') && !file.endsWith('.c') && !file.endsWith('.h') && !file.endsWith('.hpp')) continue;
    try {
      const content = fs.readFileSync(path.join(projectDir, file), 'utf-8');
      // Match: #include <...> or #include "..."
      const includeRegex = /#include\s*[<"]([^>"]+)[>"]/g;
      let match;
      while ((match = includeRegex.exec(content)) !== null) {
        const header = match[1];
        // Check if it's a standard header
        const baseName = path.basename(header);
        if (!CPP_STDLIB.has(header) && !CPP_STDLIB.has(baseName)) {
          // Try to map to apt package
          for (const [pattern, pkg] of Object.entries(COMMON_APT_MAPPINGS)) {
            if (header.startsWith(pattern) || header === pattern) {
              requiredPackages.add(pkg);
              break;
            }
          }
        }
      }
    } catch (e) {
      // Ignore read errors
    }
  }
  
  if (requiredPackages.size === 0) {
    return { needsInstall: false, language: 'cpp', packages: [] };
  }
  
  const packages = Array.from(requiredPackages);
  return {
    needsInstall: true,
    language: 'cpp',
    packages,
    command: `sudo apt-get install -y ${packages.join(' ')}`,
  };
}

function detectNodeDeps(projectDir: string): DependencyCheckResult {
  const pkgJsonPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    return { needsInstall: false, language: 'node', packages: [] };
  }
  
  const nodeModulesPath = path.join(projectDir, 'node_modules');
  const lockPath = path.join(projectDir, 'package-lock.json');
  
  // Check if node_modules exists
  if (!fs.existsSync(nodeModulesPath)) {
    return {
      needsInstall: true,
      language: 'node',
      packages: ['(npm install)'],
      command: 'npm install',
    };
  }
  
  // Check if package-lock.json is newer than node_modules
  if (fs.existsSync(lockPath)) {
    const lockStat = fs.statSync(lockPath);
    const nmStat = fs.statSync(nodeModulesPath);
    if (lockStat.mtimeMs > nmStat.mtimeMs) {
      return {
        needsInstall: true,
        language: 'node',
        packages: ['(npm install - lock file updated)'],
        command: 'npm install',
      };
    }
  }
  
  return { needsInstall: false, language: 'node', packages: [] };
}

// Hash dependencies for caching
function hashDependencies(packages: string[]): string {
  const sorted = [...packages].sort().join(',');
  const crypto = require('crypto');
  return crypto.createHash('md5').update(sorted).digest('hex');
}

// Check if dependencies are already installed (cached)
function checkDepsCache(projectDir: string, packages: string[]): boolean {
  const markerPath = path.join(projectDir, '.deps-installed');
  if (!fs.existsSync(markerPath)) return false;
  
  try {
    const cached = fs.readFileSync(markerPath, 'utf-8').trim();
    const currentHash = hashDependencies(packages);
    return cached === currentHash;
  } catch {
    return false;
  }
}

// Write deps cache marker
function writeDepsCache(projectDir: string, packages: string[]): void {
  const markerPath = path.join(projectDir, '.deps-installed');
  const hash = hashDependencies(packages);
  fs.writeFileSync(markerPath, hash, 'utf-8');
}

// GET /api/projects/:name/check-deps - check dependencies without installing
router.get('/:name/check-deps', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    
    const result = await detectDependencies(projectDir);
    
    // Check cache
    if (result.needsInstall && result.packages.length > 0) {
      if (checkDepsCache(projectDir, result.packages)) {
        res.json({ ...result, needsInstall: false, cached: true });
        return;
      }
    }
    
    res.json(result);
  } catch (error: any) {
    console.error('Check deps error:', error);
    res.status(500).json({ error: 'Failed to check dependencies', detail: error.message });
  }
});

// POST /api/projects/:name/install-deps - install dependencies with SSE streaming
router.post('/:name/install-deps', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    
    const result = await detectDependencies(projectDir);
    
    if (!result.needsInstall || !result.command || result.packages.length === 0) {
      res.json({ success: true, message: 'No dependencies to install', packages: [] });
      return;
    }
    
    // Check cache
    if (checkDepsCache(projectDir, result.packages)) {
      res.json({ success: true, message: 'Dependencies already installed (cached)', packages: result.packages, cached: true });
      return;
    }
    
    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    
    sendEvent('start', { 
      language: result.language, 
      packages: result.packages,
      command: result.command,
    });
    
    // Run installation
    let installProcess: ReturnType<typeof spawn>;
    
    if (result.language === 'python') {
      // Install Python packages in a virtual environment
      const venvDir = path.join(projectDir, '.venv');
      const pipPath = path.join(venvDir, 'bin', 'pip');
      if (!fs.existsSync(pipPath)) {
        // Create or recreate venv (handles missing dir AND broken venvs without pip)
        if (fs.existsSync(venvDir)) {
          sendEvent('log', { text: 'Broken virtual environment detected, recreating...', type: 'stdout' });
          fs.rmSync(venvDir, { recursive: true, force: true });
        }
        sendEvent('log', { text: 'Creating virtual environment...', type: 'stdout' });
        try {
          execSync(`python3 -m venv ${shellEscape(venvDir)}`, { timeout: 30000 });
        } catch (venvErr: any) {
          // python3-venv may not be installed
          sendEvent('log', { text: 'Installing python3-venv...', type: 'stdout' });
          execSync('sudo apt-get install -y python3-venv', { timeout: 60000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
          execSync(`python3 -m venv ${shellEscape(venvDir)}`, { timeout: 30000 });
        }
      }
      installProcess = spawn(pipPath, ['install', ...result.packages], {
        cwd: projectDir,
        env: { ...process.env },
      });
    } else if (result.language === 'cpp') {
      // Install apt packages (requires sudo)
      installProcess = spawn('sudo', ['apt-get', 'install', '-y', ...result.packages], {
        cwd: projectDir,
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      });
    } else if (result.language === 'node') {
      // Run npm install
      installProcess = spawn('npm', ['install'], {
        cwd: projectDir,
        env: { ...process.env },
      });
    } else {
      sendEvent('error', { message: 'Unknown language' });
      res.end();
      return;
    }
    
    let outputBuffer = '';
    const totalPackages = result.packages.length;
    let installedCount = 0;
    
    installProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputBuffer += text;
      
      // Try to estimate progress for Python
      if (result.language === 'python') {
        const successMatches = outputBuffer.match(/Successfully installed/gi);
        if (successMatches) {
          installedCount = Math.min(successMatches.length, totalPackages);
        }
      }
      
      const progress = totalPackages > 0 ? Math.min(90, (installedCount / totalPackages) * 90) : 50;
      sendEvent('progress', { 
        text: text.trim(),
        progress: Math.round(progress),
        installed: installedCount,
        total: totalPackages,
      });
    });
    
    installProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      // Some warnings come through stderr but aren't errors
      sendEvent('log', { text: text.trim(), type: 'stderr' });
    });
    
    installProcess.on('close', (code) => {
      if (code === 0) {
        // Write cache marker
        writeDepsCache(projectDir, result.packages);
        sendEvent('complete', { 
          success: true, 
          message: 'Dependencies installed successfully',
          packages: result.packages,
        });
      } else {
        sendEvent('error', { 
          success: false, 
          message: `Installation failed with code ${code}`,
          output: outputBuffer,
        });
      }
      res.end();
    });
    
    installProcess.on('error', (err) => {
      sendEvent('error', { 
        success: false, 
        message: err.message,
      });
      res.end();
    });
    
    // Handle client disconnect
    req.on('close', () => {
      if (installProcess && !installProcess.killed) {
        installProcess.kill('SIGTERM');
      }
    });
    
  } catch (error: any) {
    console.error('Install deps error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to install dependencies', detail: error.message });
    } else {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      res.end();
    }
  }
});

// POST /api/projects/:name/deploy - deploy with build support (static + fullstack + runtime)
router.post('/:name/deploy', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const appName = req.params.name;
    const deployId = `${ownerId}-${appName}`;
    const deployPath = path.join(DEPLOY_DIR, deployId);
    
    // Detect deploy type
    const deployType = detectDeployType(projectDir);
    let buildOutput = '';
    let sourceDir = projectDir;
    
    // For static apps: build if needed, copy dist
    if (deployType === 'static') {
      const hasPackageJson = fs.existsSync(path.join(projectDir, 'package.json'));
      if (hasPackageJson) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
          if (pkg.scripts?.build) {
            buildOutput += execSync('npm install --production=false 2>&1', { cwd: projectDir, timeout: 120000, encoding: 'utf-8' });
            buildOutput += '\n' + execSync('npm run build 2>&1', { cwd: projectDir, timeout: 120000, encoding: 'utf-8' });
            
            const buildDirs = ['dist', 'build', 'out', 'public', '.next/static'];
            for (const dir of buildDirs) {
              const buildDir = path.join(projectDir, dir);
              if (fs.existsSync(buildDir) && fs.existsSync(path.join(buildDir, 'index.html'))) {
                sourceDir = buildDir;
                break;
              }
            }
          }
        } catch (e: any) {
          buildOutput += '\nBuild warning: ' + (e.message || 'unknown error');
        }
      }

      // Copy to deploy directory
      if (fs.existsSync(deployPath)) fs.rmSync(deployPath, { recursive: true, force: true });
      execSync(`cp -r "${sourceDir}" "${deployPath}"`, { timeout: 30000 });
      
      const nmPath = path.join(deployPath, 'node_modules');
      const gitPath = path.join(deployPath, '.git');
      if (fs.existsSync(nmPath)) fs.rmSync(nmPath, { recursive: true, force: true });
      if (fs.existsSync(gitPath)) fs.rmSync(gitPath, { recursive: true, force: true });
    }
    
    // For fullstack apps: copy everything, assign port, start process
    if (deployType === 'fullstack') {
      if (fs.existsSync(deployPath)) fs.rmSync(deployPath, { recursive: true, force: true });
      execSync(`rsync -a --exclude=node_modules --exclude=.git "${projectDir}/" "${deployPath}/"`, { timeout: 60000 });
      
      const gitPath = path.join(deployPath, '.git');
      if (fs.existsSync(gitPath)) fs.rmSync(gitPath, { recursive: true, force: true });
    }
    
    // For runtime apps: copy to bridgesrd user's projects directory and launch in xterm
    if (deployType === 'runtime') {
      const safeAppName = appName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const runtimeDir = `/home/bridgesrd/projects/${safeAppName}`;
      const files = fs.readdirSync(projectDir);
      
      // Create runtime directory
      execSync(`mkdir -p ${shellEscape(runtimeDir)}`, { timeout: 5000 });
      execSync(`chown bridgesrd:bridgesrd /home/bridgesrd/projects`, { timeout: 5000 });
      
      // Copy project files
      execSync(`rsync -a --exclude=node_modules --exclude=.git ${shellEscape(projectDir + '/')} ${shellEscape(runtimeDir + '/')}`, { timeout: 60000 });
      execSync(`chown -R bridgesrd:bridgesrd ${shellEscape(runtimeDir)}`, { timeout: 5000 });
      
      // Determine project type and run command
      let runCommand = '';
      let installCommand = '';
      
      if (files.includes('main.py') || files.includes('requirements.txt')) {
        // Python project — always use venv (PEP 668 on Ubuntu 24.04 blocks system pip)
        const runtimeVenv = path.join(runtimeDir, '.venv');
        const runtimeVenvPython = path.join(runtimeVenv, 'bin', 'python');
        const runtimeVenvPip = path.join(runtimeVenv, 'bin', 'pip');
        // Create venv in runtime dir if missing or broken (owned by bridgesrd)
        if (!fs.existsSync(runtimeVenvPip)) {
          if (fs.existsSync(runtimeVenv)) {
            // Broken venv (no pip) — remove and recreate
            try { execSync(`rm -rf ${shellEscape(runtimeVenv)}`, { timeout: 5000 }); } catch {}
          }
          try {
            execSync(`su - bridgesrd -c ${shellEscape(`python3 -m venv '${runtimeVenv}'`)}`, { timeout: 30000 });
          } catch (e: any) {
            buildOutput += `\nWarning: failed to create venv: ${e.message}`;
          }
        }
        const usePython = fs.existsSync(runtimeVenvPython) ? runtimeVenvPython : 'python3';
        const usePip = fs.existsSync(runtimeVenvPip) ? runtimeVenvPip : 'pip3';
        if (files.includes('requirements.txt')) {
          installCommand = `${shellEscape(usePip)} install -r requirements.txt 2>&1`;
        }
        const mainFile = files.includes('main.py') ? 'main.py' : files.find(f => f.endsWith('.py')) || 'main.py';
        runCommand = `${shellEscape(usePython)} ${shellEscape(mainFile)}`;
        buildOutput += '\nDetected: Python project';
      } else if (files.includes('main.cpp') || files.includes('Makefile')) {
        // C++ project
        if (files.includes('Makefile')) {
          installCommand = `make 2>&1`;
        } else {
          installCommand = `g++ -o main main.cpp 2>&1`;
        }
        runCommand = './main';
        buildOutput += '\nDetected: C++ project';
      } else if (files.includes('package.json')) {
        // Node CLI project
        installCommand = `npm install 2>&1`;
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
        const mainFile = pkg.main || 'index.js';
        runCommand = `node ${shellEscape(mainFile)}`;
        buildOutput += '\nDetected: Node.js CLI project';
      }
      
      // Run install/build as bridgesrd user
      if (installCommand) {
        try {
          const installOutput = execSync(`su - bridgesrd -c ${shellEscape(`cd '${runtimeDir}' && ${installCommand}`)}`, { 
            timeout: 120000, 
            encoding: 'utf-8' 
          });
          buildOutput += '\nDependencies installed';
        } catch (e: any) {
          buildOutput += `\nInstall warning: ${e.message}`;
        }
      }
      
      // Kill any existing xterm for this project
      try {
        execSync(`pkill -f "xterm -title '${safeAppName}'" 2>/dev/null || true`, { timeout: 3000 });
        // Brief pause for cleanup
        await new Promise(r => setTimeout(r, 500));
      } catch {}
      
      // Launch in xterm on the VNC desktop (fully detached via setsid so execSync returns immediately)
      if (runCommand) {
        try {
          const innerCmd = `DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/bridges-rd-runtime PULSE_SERVER=unix:/tmp/bridges-rd-runtime/pulse/native SDL_AUDIODRIVER=pulseaudio xterm -title ${shellEscape(safeAppName)} -fa Monospace -fs 12 -e "bash -c ${shellEscape(`${runCommand}; echo; echo Press Enter to close...; read`)}"`;
          const xtermCmd = `setsid su - bridgesrd -c ${shellEscape(innerCmd)} </dev/null >/dev/null 2>&1 &`;
          execSync(xtermCmd, { timeout: 5000 });
          buildOutput += `\nRunning on Remote Desktop`;
        } catch (e: any) {
          buildOutput += `\nFailed to launch xterm: ${e.message}`;
        }
      }
      
      // Create or update App record for runtime
      let app = await prisma.app.findFirst({
        where: { userId: ownerId, name: appName },
      });

      if (app) {
        app = await prisma.app.update({
          where: { id: app.id },
          data: { 
            zipPath: runtimeDir, 
            isActive: true, 
            deployType: 'runtime',
            port: null,
            processStatus: 'running',
            updatedAt: new Date(),
          },
        });
      } else {
        app = await prisma.app.create({
          data: {
            userId: ownerId,
            name: appName,
            description: `Runtime project ${appName}`,
            zipPath: runtimeDir,
            isActive: true,
            deployType: 'runtime',
            port: null,
            processStatus: 'running',
          },
        });
      }

      await prisma.activityLog.create({
        data: { userId: ownerId, action: 'PROJECT_DEPLOY', resource: 'project', resourceId: app.id, severity: 'INFO', metadata: { deployType: 'runtime' } },
      });

      res.json({ 
        message: 'Running on Remote Desktop', 
        appId: app.id, 
        name: appName, 
        deployType: 'runtime',
        buildOutput: buildOutput || undefined,
      });
      return;
    }

    // Create or update App record (for static/fullstack)
    let app = await prisma.app.findFirst({
      where: { userId: ownerId, name: appName },
    });

    let port: number | null = null;
    if (deployType === 'fullstack') {
      // Reuse existing port or allocate new one
      port = app?.port || await allocatePort();
    }

    if (app) {
      app = await prisma.app.update({
        where: { id: app.id },
        data: { 
          zipPath: deployPath, 
          isActive: true, 
          deployType,
          port,
          processStatus: deployType === 'fullstack' ? 'starting' : 'stopped',
          updatedAt: new Date(),
        },
      });
    } else {
      app = await prisma.app.create({
        data: {
          userId: ownerId,
          name: appName,
          description: `Deployed from project ${appName}`,
          zipPath: deployPath,
          isActive: true,
          deployType,
          port,
          processStatus: deployType === 'fullstack' ? 'starting' : 'stopped',
        },
      });
    }

    // Start the process for fullstack apps
    if (deployType === 'fullstack' && port) {
      try {
        // Force-kill any stale process on the port
        try { require("child_process").execSync(`kill $(lsof -ti:${port} -sTCP:LISTEN) 2>/dev/null || true`); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        await startApp(app.id, deployId, deployPath, port);
        buildOutput += `\nFullstack app started on internal port ${port}`;
      } catch (e: any) {
        buildOutput += `\nProcess start failed: ${e.message}`;
        await prisma.app.update({ where: { id: app.id }, data: { processStatus: 'error' } });
      }
    }

    await prisma.activityLog.create({
      data: { userId: ownerId, action: 'PROJECT_DEPLOY', resource: 'project', resourceId: app.id, severity: 'INFO' },
    });

    const hostedUrl = `/hosted/${deployId}/`;
    res.json({ 
      message: 'Deployed', 
      appId: app.id, 
      name: appName, 
      url: hostedUrl,
      deployType,
      port: port || undefined,
      buildOutput: buildOutput || undefined,
    });
  } catch (error: any) {
    console.error('Deploy error:', error);
    res.status(500).json({ error: 'Failed to deploy', details: error.message });
  }
});

// POST /api/projects/:name/app-process — manage fullstack app process (start/stop/status/logs)
router.post('/:name/app-process', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const appName = req.params.name;
    const deployId = `${ownerId}-${appName}`;
    const { action } = req.body; // 'start' | 'stop' | 'status' | 'logs'
    
    const app = await prisma.app.findFirst({
      where: { userId: ownerId, name: appName, deployType: 'fullstack' },
    });
    
    if (!app) {
      res.status(404).json({ error: 'Fullstack app not found' });
      return;
    }
    
    if (action === 'stop') {
      await stopApp(deployId);
      res.json({ message: 'Stopped', status: 'stopped' });
      return;
    }
    
    if (action === 'start') {
      if (!app.port || !app.zipPath) {
        res.status(400).json({ error: 'App not properly configured (missing port or path)' });
        return;
      }
      try {
        await startApp(app.id, deployId, app.zipPath, app.port);
        res.json({ message: 'Starting', status: 'starting', port: app.port });
      } catch (e: any) {
        res.status(500).json({ error: 'Failed to start', details: e.message });
      }
      return;
    }
    
    if (action === 'status' || action === 'logs') {
      const status = getAppStatus(deployId);
      res.json(status || { status: 'stopped', logs: [], restartCount: 0 });
      return;
    }
    
    res.status(400).json({ error: 'Invalid action. Use: start, stop, status, logs' });
  } catch (error: any) {
    console.error('App process error:', error);
    res.status(500).json({ error: error.message });
  }
});
// POST /api/projects/:name/doc-update - auto-update documentation
router.post('/:name/doc-update', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const { type, description, details } = req.body;
    // type: 'fix' | 'feature' | 'deployment' | 'note'
    
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `\n## ${type === 'fix' ? '🔧 Fix' : type === 'feature' ? '✨ Feature' : type === 'deployment' ? '🚀 Deployment' : '📝 Note'} - ${timestamp}\n\n${description}\n${details ? `\n${details}\n` : ''}`;
    
    // Update NOTES.md
    const notesPath = path.join(projectDir, 'NOTES.md');
    let notesContent = '';
    if (fs.existsSync(notesPath)) {
      notesContent = fs.readFileSync(notesPath, 'utf-8');
    } else {
      notesContent = `# ${req.params.name} - Development Notes\n`;
    }
    notesContent += entry;
    fs.writeFileSync(notesPath, notesContent, 'utf-8');
    
    // Update README.md changelog section if exists
    const readmePath = path.join(projectDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      let readmeContent = fs.readFileSync(readmePath, 'utf-8');
      const changelogHeader = '## Changelog';
      if (!readmeContent.includes(changelogHeader)) {
        readmeContent += `\n\n${changelogHeader}\n`;
      }
      const changelogLine = `\n- **${timestamp}** - ${type}: ${description}`;
      readmeContent = readmeContent.replace(changelogHeader, changelogHeader + changelogLine);
      fs.writeFileSync(readmePath, readmeContent, 'utf-8');
    }
    
    // Auto-commit the doc changes
    const hasGit = fs.existsSync(path.join(projectDir, '.git'));
    if (hasGit) {
      try {
        execSync('git add NOTES.md README.md', { cwd: projectDir, timeout: 5000 });
        execSync(`git commit -m "docs: ${type} - ${description.substring(0, 50)}"`, { cwd: projectDir, timeout: 5000 });
      } catch {}
    }
    
    res.json({ message: 'Documentation updated' });
  } catch (error) {
    console.error('Doc update error:', error);
    res.status(500).json({ error: 'Failed to update documentation' });
  }
});

// POST /api/projects/:name/share - create share link for project
router.post('/:name/share', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    // Ensure deployed
    const deployId = `${ownerId}-${req.params.name}`;
    const deployPath = path.join(DEPLOY_DIR, deployId);
    if (!fs.existsSync(deployPath)) {
      res.status(400).json({ error: 'Deploy the project first before sharing' });
      return;
    }

    // Find or create App record
    let app = await prisma.app.findFirst({
      where: { userId: ownerId, name: req.params.name },
    });

    if (!app) {
      app = await prisma.app.create({
        data: {
          userId: ownerId,
          name: req.params.name,
          description: `Project ${req.params.name}`,
          zipPath: deployPath,
          isActive: true,
        },
      });
    }

    const token = nanoid(21);
    const isPublic = req.body.isPublic !== false; // default true
    const password = req.body.password;

    // Validate password if password-protected
    let passwordHash: string | null = null;
    if (!isPublic && password) {
      if (password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters' });
        return;
      }
      passwordHash = await bcrypt.hash(password, 12);
    } else if (!isPublic && !password) {
      res.status(400).json({ error: 'Password required for password-protected links' });
      return;
    }

    const shareLink = await prisma.appShareLink.create({
      data: {
        appId: app.id,
        userId: ownerId,
        token,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
        maxUses: req.body.maxUses || null,
        isPublic,
        passwordHash,
      },
    });

    // Don't leak passwordHash to frontend
    const { passwordHash: _, ...safeLinkData } = shareLink;

    res.status(201).json({ 
      shareLink: safeLinkData, 
      url: `/share/${token}`,
      hostedUrl: `/hosted/${deployId}/`,
    });
  } catch (error) {
    console.error('Create share link error:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// GET /api/projects/:name/shares - list share links
router.get('/:name/shares', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const app = await prisma.app.findFirst({
      where: { userId: ownerId, name: req.params.name },
      include: { shareLinks: { orderBy: { createdAt: 'desc' } } },
    });

    // Strip passwordHash from response
    const shares = (app?.shareLinks || []).map(({ passwordHash, ...rest }) => rest);
    res.json({ shares });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list shares' });
  }
});

// PATCH /api/projects/:name/share/:linkId - update share link (public ↔ secure, active toggle)
router.patch('/:name/share/:linkId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { isPublic, password, isActive } = req.body;
    const updateData: any = {};

    if (typeof isActive === 'boolean') {
      updateData.isActive = isActive;
    }

    if (isPublic === true) {
      updateData.isPublic = true;
      updateData.passwordHash = null;
    } else if (isPublic === false) {
      if (!password || password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters' });
        return;
      }
      updateData.isPublic = false;
      updateData.passwordHash = await bcrypt.hash(password, 12);
    }

    const link = await prisma.appShareLink.update({
      where: { id: req.params.linkId },
      data: updateData,
    });

    const { passwordHash: _, ...safeLink } = link;
    res.json({ shareLink: safeLink });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update share link' });
  }
});

// DELETE /api/projects/:name/share/:linkId - delete share link permanently
router.delete('/:name/share/:linkId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { permanent } = req.query;
    if (permanent === 'true') {
      await prisma.appShareLink.delete({
        where: { id: req.params.linkId },
      });
      res.json({ message: 'Share link deleted permanently' });
    } else {
      await prisma.appShareLink.update({
        where: { id: req.params.linkId },
        data: { isActive: false },
      });
      res.json({ message: 'Share link revoked' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete share link' });
  }
});

// POST /api/projects/:name/share/:linkId/email - send share link via email
router.post('/:name/share/:linkId/email', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { recipientEmail, password } = req.body;
    if (!recipientEmail || typeof recipientEmail !== 'string') {
      res.status(400).json({ error: 'recipientEmail is required' }); return;
    }
    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      res.status(400).json({ error: 'Invalid email address' }); return;
    }

    const link = await prisma.appShareLink.findUnique({ where: { id: req.params.linkId } });
    if (!link || !link.isActive) {
      res.status(404).json({ error: 'Share link not found or inactive' }); return;
    }

    const siteUrl = process.env.PORTAL_URL || 'https://localhost';
    const shareUrl = `${siteUrl}/share/${link.token}`;

    const senderEmail = req.user!.email;
    const senderUser = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { username: true },
    });
    const senderUsername = senderUser?.username?.trim() || 'Portal User';

    const { sendShareLinkEmail } = await import('../services/notificationService');
    const { getUserMailCredentials } = await import('../services/userMailService');
    const mailCreds = await getUserMailCredentials(ownerId);
    await sendShareLinkEmail(
      {
        senderName: senderUsername,
        senderEmail,
        recipientEmail,
        appName: req.params.name,
        shareUrl,
        isPasswordProtected: !link.isPublic,
        password: typeof password === 'string' && password.length > 0 ? password : undefined,
      },
      mailCreds,
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Share link email error:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// POST /api/projects/:name/rename-file - rename/move file
router.post('/:name/rename-file', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) { res.status(400).json({ error: 'oldPath and newPath required' }); return; }

    const resolvedOld = path.resolve(path.join(projectDir, oldPath));
    const resolvedNew = path.resolve(path.join(projectDir, newPath));
    if (!resolvedOld.startsWith(path.resolve(projectDir)) || !resolvedNew.startsWith(path.resolve(projectDir))) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }

    if (!fs.existsSync(resolvedOld)) { res.status(404).json({ error: 'Source not found' }); return; }
    
    fs.mkdirSync(path.dirname(resolvedNew), { recursive: true });
    fs.renameSync(resolvedOld, resolvedNew);
    res.json({ message: 'Renamed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to rename' });
  }
});

// --- OpenClaw TUI Chat Persistence Routes ---

// GET /api/projects/:name/chat/history - Load persisted chat messages for this project+user
router.get('/:name/chat/history', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const userId = ownerId;
    const sessionKey = `portal-${userId}-${name}`;
    
    const messages = await prisma.projectChatMessage.findMany({
      where: { userId, sessionKey },
      orderBy: { timestamp: 'asc' },
      take: 500, // Limit to last 500 messages
    });
    
    // Get session status
    const session = await prisma.projectChatSession.findUnique({
      where: { sessionKey },
    });
    
    res.json({ 
      messages: messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
        messageId: m.messageId,
      })),
      session: session ? {
        status: session.status,
        model: session.model,
        lastActivity: session.lastActivity.toISOString(),
      } : null,
    });
  } catch (error: any) {
    console.error('[Chat History] Error:', error.message);
    res.status(500).json({ error: 'Failed to load chat history' });
  }
});

// POST /api/projects/:name/chat/message - Save a chat message
router.post('/:name/chat/message', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const userId = ownerId;
    const sessionKey = `portal-${userId}-${name}`;
    const { role, content, messageId } = req.body;
    
    if (!role || !content) {
      res.status(400).json({ error: 'role and content required' });
      return;
    }
    
    const message = await prisma.projectChatMessage.create({
      data: {
        projectId: name,
        userId,
        sessionKey,
        role,
        content,
        messageId: messageId || null,
      },
    });
    
    // Upsert session record
    await prisma.projectChatSession.upsert({
      where: { sessionKey },
      update: { 
        status: 'active',
        lastActivity: new Date(),
      },
      create: {
        userId,
        projectId: name,
        sessionKey,
        status: 'active',
      },
    });
    
    res.json({ id: message.id, timestamp: message.timestamp.toISOString() });
  } catch (error: any) {
    console.error('[Chat Message] Error:', error.message);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// POST /api/projects/:name/chat/messages - Batch save multiple messages
router.post('/:name/chat/messages', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const userId = ownerId;
    const sessionKey = `portal-${userId}-${name}`;
    const { messages } = req.body;
    
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages array required' });
      return;
    }
    
    const created = await prisma.projectChatMessage.createMany({
      data: messages.map((m: any) => ({
        projectId: name,
        userId,
        sessionKey,
        role: m.role,
        content: m.content,
        messageId: m.messageId || null,
        timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
      })),
    });
    
    res.json({ count: created.count });
  } catch (error: any) {
    console.error('[Chat Messages Batch] Error:', error.message);
    res.status(500).json({ error: 'Failed to save messages' });
  }
});

// DELETE /api/projects/:name/chat/history - Clear chat history for this project
router.delete('/:name/chat/history', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const userId = ownerId;
    const sessionKey = `portal-${userId}-${name}`;
    
    await prisma.projectChatMessage.deleteMany({
      where: { userId, sessionKey },
    });
    
    // Reset session
    await prisma.projectChatSession.upsert({
      where: { sessionKey },
      update: { status: 'expired', lastActivity: new Date() },
      create: { userId, projectId: name, sessionKey, status: 'expired' },
    });
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// GET /api/projects/:name/chat/session-status - Check if gateway session is still active
router.get('/:name/chat/session-status', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const userId = ownerId;
    // FIX BUG-5: Normalize project name for case-insensitive session keys
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const sessionId = `portal-${userId}-${normalizedName}`;
    const projectAgentId = `portal-${userId.slice(0, 8)}-${normalizedName}`.slice(0, 64);
    // Try project-specific agent first, then legacy
    let sessionKey = `agent:${projectAgentId}:${sessionId}`;
    let result = await getSessionInfo(sessionKey);
    if (!result.ok) {
      sessionKey = `agent:portal:${sessionId}`;
      result = await getSessionInfo(sessionKey);
    }
    
    const dbSession = await prisma.projectChatSession.findUnique({
      where: { sessionKey: sessionId },
    });
    
    const gatewayActive = result.ok && !!result.data;
    
    // Update DB session status based on gateway
    if (dbSession) {
      const newStatus = gatewayActive ? 'active' : 'expired';
      if (dbSession.status !== newStatus) {
        await prisma.projectChatSession.update({
          where: { sessionKey: sessionId },
          data: { status: newStatus },
        });
      }
    }
    
    res.json({
      active: gatewayActive,
      model: result.data ? `${result.data.modelProvider || 'anthropic'}/${result.data.model || 'claude-sonnet-4-6'}` : null,
      dbStatus: dbSession?.status || 'none',
    });
  } catch (error: any) {
    res.json({ active: false, error: error.message });
  }
});

// --- Assistant Chat Routes ---

// Helper: detect project type
function detectProjectType(projectDir: string): string {
  const hasPackageJson = fs.existsSync(path.join(projectDir, 'package.json'));
  const hasIndexHtml = fs.existsSync(path.join(projectDir, 'index.html'));
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
      if (pkg.dependencies?.react || pkg.devDependencies?.react) return 'React';
      if (pkg.dependencies?.vue) return 'Vue';
      if (pkg.dependencies?.next) return 'Next.js';
      if (pkg.dependencies?.svelte) return 'Svelte';
      return 'Node.js';
    } catch {}
  }
  if (fs.existsSync(path.join(projectDir, 'requirements.txt'))) return 'Python';
  if (fs.existsSync(path.join(projectDir, 'Cargo.toml'))) return 'Rust';
  if (fs.existsSync(path.join(projectDir, 'go.mod'))) return 'Go';
  if (hasIndexHtml) return 'Static HTML';
  return 'Unknown';
}

// --- Assistant model mapping (frontend ID → Anthropic API model ID) ---
const MARCUS_MODEL_MAP: Record<string, string> = {
  'anthropic/claude-haiku-4-5': 'claude-haiku-4-5',
  'anthropic/claude-sonnet-4-6': 'claude-sonnet-4-6',
  'anthropic/claude-sonnet-4-5': 'claude-sonnet-4-6',  // upgrade 4.5 → 4.6
  'anthropic/claude-opus-4-6': 'claude-opus-4-6',
  // Legacy aliases
  'anthropic/claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'anthropic/claude-opus-4-5-20251101': 'claude-opus-4-6',
  'anthropic/claude-opus-4-5': 'claude-opus-4-6',
};

function resolveAnthropicModel(frontendModel: string): string {
  // If it's already a bare Anthropic model ID, use it
  if (!frontendModel.startsWith('anthropic/')) return frontendModel;
  return MARCUS_MODEL_MAP[frontendModel] || 'claude-sonnet-4-6';
}

// Execute an assistant tool call within the project sandbox
async function executeAssistantTool(toolName: string, input: any, projectDir: string): Promise<string> {
  const resolvePath = (p: string) => {
    const resolved = path.resolve(projectDir, p);
    if (!resolved.startsWith(path.resolve(projectDir))) throw new Error('Path traversal blocked');
    return resolved;
  };

  try {
    switch (toolName) {
      case 'read': {
        const filePath = resolvePath(input.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${input.path}`;
        const stat = fs.statSync(filePath);
        if (stat.size > 512 * 1024) return `Error: File too large (${(stat.size / 1024).toFixed(0)}KB). Max 512KB.`;
        return fs.readFileSync(filePath, 'utf-8');
      }
      case 'write': {
        const filePath = resolvePath(input.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content, 'utf-8');
        return `Written ${input.content.length} bytes to ${input.path}`;
      }
      case 'edit': {
        const filePath = resolvePath(input.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${input.path}`;
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.includes(input.old_string)) return `Error: old_string not found in ${input.path}`;
        const newContent = content.replace(input.old_string, input.new_string);
        fs.writeFileSync(filePath, newContent, 'utf-8');
        return `Edited ${input.path}`;
      }
      case 'exec': {
        const cmd = `cd ${JSON.stringify(projectDir)} && ${input.command}`;
        const result = execSync(cmd, { timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf-8' });
        return result.slice(0, 10000);
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}

// Auto-commit helper: commits any changes in project dir after assistant edits files
function getModelDisplayName(model: string): string {
  const names: Record<string, string> = {
    'anthropic/claude-opus-4-5-20251101': 'Claude Opus 4.5',
    'anthropic/claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'anthropic/claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'anthropic/claude-haiku-4-1': 'Claude Haiku 4.1',
    'anthropic/claude-haiku-4-20250514': 'Claude Haiku 4',
    'ollama/qwen2.5-coder:3b': 'Qwen Coder 3B',
    'ollama/qwen2.5-coder:7b': 'Qwen Coder 7B',
    'ollama/qwen3:8b': 'Qwen3 8B',
    'openai-codex/gpt-5.1': 'GPT-5.1',
    'openai-codex/gpt-5.2': 'GPT-5.2',
    'openai-codex/gpt-5.3-codex': 'Codex (5.3)',
    'openai-codex/gpt-5.4': 'Codex (5.4)',
  };
  return names[model] || model.replace(/^(anthropic|ollama|openai-codex)\//, '');
}

async function autoCommitProjectChanges(projectDir: string, userId: string, projectName: string, summary?: string, model?: string) {
  try {
    const opts = { cwd: projectDir, timeout: 15000, encoding: 'utf-8' as const };
    // Ensure git repo exists
    try { execSync('git rev-parse --git-dir', opts); } catch {
      execSync('git init', opts);
      execSync(`git config user.email "${process.env.GIT_AUTHOR_EMAIL || 'admin@localhost'}"`, opts);
      execSync('git config user.name "Assistant AI"', opts);
    }
    // Check for changes
    const status = execSync('git status --porcelain', opts).trim();
    if (!status) return null; // nothing to commit
    
    // Build commit message from changed files
    const changedFiles = status.split('\n').map(l => l.substring(3).trim()).filter(Boolean);
    
    // Generate descriptive commit message if no summary provided
    let commitMsg = summary ? `Assistant: ${summary}` : '';
    
    if (!summary) {
      // Analyze diff to generate better commit message
      try {
        const diff = execSync('git diff --cached --stat', { ...opts, timeout: 5000 }).trim();
        const diffLines = diff.split('\n').filter(Boolean);
        
        // Parse file changes and stats
        const fileChanges: { file: string; added: number; removed: number }[] = [];
        for (const line of diffLines) {
          const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)/);
          if (match) {
            const [, file, changes, plusMinus] = match;
            const added = (plusMinus.match(/\+/g) || []).length;
            const removed = (plusMinus.match(/-/g) || []).length;
            fileChanges.push({ file: file.trim(), added, removed });
          }
        }
        
        // Generate descriptive message
        if (fileChanges.length === 1) {
          const fc = fileChanges[0];
          const action = fc.added > 0 && fc.removed === 0 ? 'Added' : fc.removed > 0 && fc.added === 0 ? 'Removed' : 'Updated';
          commitMsg = `Assistant: ${action} ${fc.file}`;
        } else if (fileChanges.length <= 3) {
          const fileList = fileChanges.map(fc => fc.file).join(', ');
          commitMsg = `Assistant: Updated ${fileList}`;
        } else {
          const totalAdded = fileChanges.reduce((sum, fc) => sum + fc.added, 0);
          const totalRemoved = fileChanges.reduce((sum, fc) => sum + fc.removed, 0);
          commitMsg = `Assistant: Updated ${fileChanges.length} files (+${totalAdded}/-${totalRemoved})`;
        }
      } catch {
        // Fallback to simple file list
        commitMsg = `Assistant update: ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : ''}`;
      }
    }
    
    // Use model-attributed author name
    const authorName = model ? `Assistant AI (${getModelDisplayName(model)})` : 'Assistant AI';
    const authorArg = `--author="${authorName} <${process.env.GIT_AUTHOR_EMAIL || "admin@localhost"}>"`;
    
    execSync('git add .', opts);
    execSync(`git commit ${authorArg} -m ${JSON.stringify(commitMsg)}`, opts);
    const hash = execSync('git rev-parse --short HEAD', opts).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
    // Get lines added/removed
    let linesAdded = 0, linesRemoved = 0;
    try {
      const statLine = execSync('git diff HEAD~1 --shortstat', { ...opts, timeout: 5000 }).trim();
      const addM = statLine.match(/(\d+) insertion/);
      const delM = statLine.match(/(\d+) deletion/);
      linesAdded = addM ? parseInt(addM[1]) : 0;
      linesRemoved = delM ? parseInt(delM[1]) : 0;
    } catch {}
    console.log(`[Agent] Auto-commit ${hash}: ${commitMsg}`);
    
    // Log activity
    try {
      const app = await prisma.app.findFirst({ where: { userId, name: projectName } });
      await prisma.activityLog.create({
        data: {
          userId,
          action: 'PROJECT_GIT_COMMIT',
          resource: 'project',
          resourceId: app?.id,
          severity: 'INFO',
          metadata: { projectName, hash, message: commitMsg, filesChanged: changedFiles.length, branch, linesAdded, linesRemoved },
        },
      });
    } catch {}
    
    return { hash, message: commitMsg, filesChanged: changedFiles.length };
  } catch (err: any) {
    console.error('[Agent] Auto-commit error:', err.message);
    return null;
  }
}

// ========================================
// Session Management (rotation to prevent 200K token overflow)
// ========================================

interface SessionMeta {
  initialized?: boolean;
  model?: string;
  lastActivity?: string;
}

/**
 * Phase 2: Ensure a dedicated OpenClaw agent exists for this project.
 * Creates agent on-demand via config.patch if it doesn't exist yet.
 * Each project gets its own Docker sandbox with only that project's files mounted.
 */
// Cache of known agent IDs to avoid repeated config.get calls
const knownAgentIds = new Set<string>();

async function ensureProjectAgent(
  userId: string,
  normalizedName: string,
  projectDirName: string, // actual directory name on disk (may differ from normalizedName)
): Promise<{ agentId: string; created: boolean }> {
  // Agent ID format: portal-{userId8}-{normalizedName}, max 64 chars
  const agentId = `portal-${userId.slice(0, 8)}-${normalizedName}`.slice(0, 64);
  
  // Fast path: already known from this process lifetime
  if (knownAgentIds.has(agentId)) {
    return { agentId, created: false };
  }
  
  // Check config for existing agent
  const configResult = await gatewayRpcCall('config.get', {});
  if (!configResult.ok) {
    console.error('[ensureProjectAgent] config.get failed:', configResult.error);
    // Fall back to generic portal agent
    knownAgentIds.add('portal');
    return { agentId: 'portal', created: false };
  }
  
  const config = configResult.data?.config || configResult.data?.parsed || {};
  const agents: any[] = config?.agents?.list || [];
  
  if (agents.some((a: any) => a.id === agentId)) {
    knownAgentIds.add(agentId);
    return { agentId, created: false };
  }
  
  // Agent doesn't exist — create it via config.patch
  console.log(`[ensureProjectAgent] Creating agent: ${agentId} for project dir: ${projectDirName}`);
  
  // Create a minimal project-specific AGENTS.md for the sandbox workspace
  const agentWorkspaceDir = `/root/.openclaw/sandboxes/${agentId}-workspace`;
  if (!fs.existsSync(agentWorkspaceDir)) {
    fs.mkdirSync(agentWorkspaceDir, { recursive: true });
  }
  const projectAgentsMd = `# AGENTS.md — Project Agent

You are a coding assistant sandboxed to a specific project.

## Your project files are at: /home/user/project/

**ALWAYS start by exploring /home/user/project/ to understand the project.**

Do NOT look at /work/SOUL.md, /work/USER.md, or other files in /work — those are irrelevant system files.
Your workspace is /work but your PROJECT is at /home/user/project/.

## On first interaction:
1. Run \`ls -la /home/user/project/\` to see the project structure
2. Read key files (README, package.json, index.html, etc.)
3. Read \`.agent-memory.md\` in the project dir for past context
4. Then respond to the user's request

## Tools available:
- Read, Write, Edit — file operations
- exec — shell commands (git, npm, node, etc.)
- web_search, web_fetch — internet research
- image — analyze images

## Memory:
- Update \`/home/user/project/.agent-memory.md\` with important findings
`;
  fs.writeFileSync(path.join(agentWorkspaceDir, 'AGENTS.md'), projectAgentsMd, 'utf-8');
  
  const newAgent = {
    id: agentId,
    workspace: agentWorkspaceDir,
    sandbox: {
      mode: "all",
      workspaceAccess: "none",
      scope: "session",
      docker: {
        image: "openclaw-sandbox:bookworm-slim",
        workdir: "/work",
        network: "bridge",
        dangerouslyAllowExternalBindSources: true,
        binds: [
          `${PROJECTS_DIR}/${userId}/${projectDirName}:/home/user/project:rw`
        ]
      }
    },
    tools: {
      allow: ["group:fs", "group:runtime", "web_search", "web_fetch", "image"],
      deny: ["browser", "canvas", "nodes", "message", "tts", "cron", "gateway"],
      elevated: { enabled: false },
      exec: { security: "full" }
    }
  };
  
  const updatedList = [...agents, newAgent];
  
  const baseHash = configResult.data?.hash || '';
  const patchResult = await gatewayRpcCall('config.patch', {
    raw: JSON.stringify({ agents: { list: updatedList } }),
    baseHash,
  }, 15000);
  
  if (!patchResult.ok) {
    console.error(`[ensureProjectAgent] config.patch failed: ${patchResult.error}`);
    // Fall back to generic portal agent
    return { agentId: 'portal', created: false };
  }
  
  console.log(`[ensureProjectAgent] Agent ${agentId} created successfully. Waiting for gateway reload...`);
  // Gateway restarts after config.patch — poll until ready instead of fixed sleep
  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      const check = await gatewayRpcCall('sessions.list', { agentId }, 5000);
      if (check.ok) {
        console.log(`[ensureProjectAgent] Gateway ready after ${(i + 1) * 2}s`);
        break;
      }
    } catch {}
  }
  
  knownAgentIds.add(agentId);
  return { agentId, created: true };
}

/**
 * Get or create a portal assistant session.
 * No rotation — OpenClaw's native compaction handles context management.
 * Only re-initializes if: (1) never initialized, or (2) gateway lost the session (restart).
 */
async function getOrCreateSession(
  projectDir: string,
  userId: string,
  projectName: string,
  normalizedName: string
): Promise<{ sessionKey: string; agentId: string; needsInit: boolean }> {
  // Phase 2: Get or create a dedicated agent for this project
  const projectDirName = path.basename(projectDir);
  const { agentId } = await ensureProjectAgent(userId, normalizedName, projectDirName);
  
  const sessionId = `portal-${userId}-${normalizedName}`;
  const sessionKey = `agent:${agentId}:${sessionId}`;
  
  // Auto-migrate legacy .assistant-* files to .agent-*
  migrateAssistantFiles(projectDir);
  
  // Check local state
  const sessionStatePath = path.join(projectDir, '.agent-session.json');
  let localInitialized = false;
  try {
    if (fs.existsSync(sessionStatePath)) {
      const meta = JSON.parse(fs.readFileSync(sessionStatePath, 'utf-8'));
      localInitialized = meta.initialized === true;
    }
  } catch {}
  
  // Check if gateway actually has this session (handles gateway restarts)
  let gatewayHasSession = false;
  try {
    const result = await getSessionInfo(sessionKey);
    gatewayHasSession = result.ok && !!result.data;
  } catch {}
  
  const needsInit = !localInitialized || !gatewayHasSession;
  
  return { sessionKey, agentId, needsInit };
}


// --- Legacy backward-compat: .assistant-* → .agent-* ---
// Also auto-migrate .assistant-* files to .agent-* on first access.
function migrateAssistantFiles(projectDir: string) {
  const migrations = [
    ['.assistant-memory.md', '.agent-memory.md'],
    ['.assistant-session.json', '.agent-session.json'],
    ['.assistant-history.json', '.agent-history.json'],
  ];
  for (const [oldName, newName] of migrations) {
    const oldPath = path.join(projectDir, oldName);
    const newPath = path.join(projectDir, newName);
    try {
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
      }
    } catch {}
  }
}
router.use(authenticateToken, requireApproved);

// POST /api/projects/:name/assistant/ensure-session - Create/verify agent + session, return keys for WS chat
router.post('/:name/assistant/ensure-session', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const projectDir = getProjectPath(ownerId, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const normalizedName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const userId = ownerId;

    // Get or create session (reuses existing functions)
    const { sessionKey, agentId, needsInit } = await getOrCreateSession(
      projectDir, userId, name, normalizedName
    );

    // If session needs init, send the project context as the first message via gateway RPC
    if (needsInit) {
      const assistantName = await getAssistantName();
      const projectType = detectProjectType(projectDir);
      const sandboxProjectDir = agentId === 'portal' ? `/home/user/projects/${name}/` : `/home/user/project/`;

      // Initialize project memory if missing
      const memoryPath = path.join(projectDir, '.agent-memory.md');
      if (!fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, `# Project Memory — ${name}\n\n## Overview\n(Describe what this project does)\n`, 'utf-8');
      }

      const initMessage = `[PORTAL PROJECT CONTEXT]
You are ${assistantName}, an AI coding assistant working on the project "${name}".
Project Type: ${projectType}
Project Directory (inside sandbox): ${sandboxProjectDir}

**CRITICAL: You are sandboxed to this project directory. You have full tool access within the sandbox:**

**File Operations:**
- Use Read tool with file_path to read files. For large files (>1MB), use offset (line number) and limit (max lines) to read in chunks.
- Use Write tool to create/overwrite files.
- Use Edit tool for surgical find-and-replace edits.
- All paths should be absolute: ${sandboxProjectDir}filename.ext

**Commands:**
- Use exec tool to run shell commands (git, npm, node, ls, grep, find, etc.)
- Set workdir to ${sandboxProjectDir} or cd there first
- Examples: exec git status, exec npm install, exec ls -la

**Internet:**
- Use web_search for research
- Use web_fetch to download documentation or resources

**Project Memory:**
- Read .agent-memory.md to learn project context
- Update .agent-memory.md when you learn important patterns or decisions

**Security:** Do not try to access files outside ${sandboxProjectDir} - the sandbox prevents this anyway.

[END CONTEXT]

Hello! I'm ready to help with this project. What would you like to work on?`;

      // Send init via gateway chat completions (fire-and-forget, same as assistant/send)
      const gatewayToken = getGatewayToken();
      const gatewayUrl = `${getOpenClawApiUrl()}/v1/chat/completions`;

      const sandboxSystemMessage = {
        role: 'system' as const,
        content: `You are ${assistantName}, an AI coding assistant sandboxed to ${sandboxProjectDir}. You have full tool access (Read, Write, Edit, exec, web_search, web_fetch). The sandbox is enforced at the container level - you cannot escape it. Use tools to explore files intelligently instead of having everything embedded in prompts.`
      };

      // Fire-and-forget init
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      fetch(gatewayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken}`,
          'x-openclaw-session-key': sessionKey,
        },
        body: JSON.stringify({
          messages: [sandboxSystemMessage, { role: 'user', content: initMessage }],
        }),
        signal: controller.signal,
      }).then(() => clearTimeout(timeoutId)).catch(() => clearTimeout(timeoutId));

      // Mark session as initialized
      const sessionStatePath = path.join(projectDir, '.agent-session.json');
      fs.writeFileSync(sessionStatePath, JSON.stringify({ initialized: true, lastActivity: new Date().toISOString() }, null, 2), 'utf-8');
    }

    // Determine default model
    const selectedModel = req.body?.model || 'anthropic/claude-opus-4-6';

    // Patch model if provided
    if (req.body?.model) {
      try { await patchSessionModel(sessionKey, req.body.model); } catch {}
    }

    res.json({
      sessionKey,
      agentId,
      model: selectedModel,
      initialized: !needsInit,
    });
  } catch (error: any) {
    console.error('[ensure-session] Error:', error.message);
    res.status(500).json({ error: 'Failed to ensure session', detail: error.message });
  }
});

// GET /api/projects/:name/assistant/history - Load chat history
router.get('/:name/assistant/history', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const historyPath = path.join(projectDir, '.agent-history.json');
    if (!fs.existsSync(historyPath)) {
      res.json({ messages: [], model: '' });
      return;
    }

    const data = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    res.json(data);
  } catch (error) {
    res.json({ messages: [], model: '' });
  }
});

// POST /api/projects/:name/assistant/history - Save chat history
router.post('/:name/assistant/history', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const { messages, model } = req.body;
    const historyPath = path.join(projectDir, '.agent-history.json');
    fs.writeFileSync(historyPath, JSON.stringify({ messages: messages || [], model: model || '' }, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save history' });
  }
});

// GET /api/projects/:name/assistant/active-model - Get the ACTUAL active model for this project's session
router.get('/:name/assistant/active-model', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    // FIX BUG-5: Normalize project name for case-insensitive session keys
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const userId = ownerId;
    const sessionId = `portal-${userId}-${normalizedName}`;
    const projectAgentId = `portal-${userId.slice(0, 8)}-${normalizedName}`.slice(0, 64);
    // Try project-specific agent first, then legacy
    let sessionKey = `agent:${projectAgentId}:${sessionId}`;
    let result = await getSessionInfo(sessionKey);
    if (!result.ok) {
      sessionKey = `agent:portal:${sessionId}`;
      result = await getSessionInfo(sessionKey);
    }
    
    if (result.ok && result.data) {
      const session = result.data;
      // sessions.list returns the resolved model (already merged with override)
      const provider = session.modelProvider || 'anthropic';
      const model = session.model || 'claude-sonnet-4-5';
      const activeModel = `${provider}/${model}`;
      const isDefault = model === 'claude-sonnet-4-5'; // default model for portal agent
      
      res.json({ 
        activeModel,
        modelProvider: provider,
        model,
        isOverridden: !isDefault,
        sessionKey,
      });
    } else {
      // Session might not exist yet - return default
      res.json({ 
        activeModel: 'anthropic/claude-sonnet-4-5',
        modelProvider: 'anthropic',
        model: 'claude-sonnet-4-5',
        isOverridden: false,
        sessionKey,
        note: 'Session not yet created - showing default model',
      });
    }
  } catch (error: any) {
    console.error('[Agent] Active model check error:', error.message);
    res.json({ 
      activeModel: 'unknown',
      error: error.message,
    });
  }
});

// GET /api/projects/:name/assistant/memory - Load project memory
router.get('/:name/assistant/memory', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const memoryPath = path.join(projectDir, '.agent-memory.md');
    const content = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : '';
    res.json({ content });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load memory' });
  }
});

// POST /api/projects/:name/assistant/reset - Reset assistant session (for clear chat)
router.post('/:name/assistant/reset', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    // Delete the gateway session (both project-specific and legacy)
    const normalizedName = req.params.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const userId = ownerId;
    const sessionId = `portal-${userId}-${normalizedName}`;
    const projectAgentId = `portal-${userId.slice(0, 8)}-${normalizedName}`.slice(0, 64);
    
    // Delete project-specific agent session
    try {
      await deleteSession(`agent:${projectAgentId}:${sessionId}`);
      console.log(`[Agent Reset] Deleted project session: agent:${projectAgentId}:${sessionId}`);
    } catch {}
    
    // Delete legacy portal agent session
    try {
      await deleteSession(`agent:portal:${sessionId}`);
      console.log(`[Agent Reset] Deleted legacy session: agent:portal:${sessionId}`);
    } catch {}
    
    // Also clean up any legacy versioned sessions
    for (let v = 1; v <= 10; v++) {
      try {
        await deleteSession(`agent:portal:${sessionId}-v${v}`);
      } catch {}
    }
    
    // Reset session state
    const sessionStatePath = path.join(projectDir, '.agent-session.json');
    fs.writeFileSync(sessionStatePath, JSON.stringify({ initialized: false }, null, 2), 'utf-8');
    
    // Clear history file
    const historyPath = path.join(projectDir, '.agent-history.json');
    if (fs.existsSync(historyPath)) {
      fs.writeFileSync(historyPath, JSON.stringify({ messages: [], model: '' }), 'utf-8');
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Agent Reset] Error:', error);
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

// POST /api/projects/:name/assistant/memory - Save project memory
router.post('/:name/assistant/memory', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const { content } = req.body;
    const memoryPath = path.join(projectDir, '.agent-memory.md');
    fs.writeFileSync(memoryPath, content || '', 'utf-8');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save memory' });
  }
});

// Rate limiter for assistant poll endpoint (prevent aggressive polling)
const assistantPollLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // Max 300 requests per minute (allows 3-4 tabs + normal usage with headroom)
  message: 'Too many polling requests. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/projects/:name/assistant/poll - Poll for new messages from gateway session JSONL
// This replaces SSE streaming for long-running sessions (Cloudflare-compatible)
router.get('/:name/assistant/poll', authenticateToken, assistantPollLimiter, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const userId = ownerId;
    const afterLine = parseInt(req.query.after as string) || 0;
    const projectDir = getProjectPath(userId, name);
    
    // Phase 2: Derive agent ID and session key for this project
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const projectAgentId = `portal-${userId.slice(0, 8)}-${normalizedName}`.slice(0, 64);
    const sessionId = `portal-${userId}-${normalizedName}`;
    // Try project-specific agent first, then fall back to generic portal
    const sessionKeyProject = `agent:${projectAgentId}:${sessionId}`;
    const sessionKeyLegacy = `agent:portal:${sessionId}`;

    // Find the JSONL session file — search project-specific agent dir first, then legacy dirs
    const agentDirs = [projectAgentId, 'portal', 'portal-opus', 'portal-sonnet', 'portal-haiku'];
    let jsonlPath: string | null = null;
    let foundSessionId: string | null = null;
    let activeSessionKey = sessionKeyProject; // track which session key matched

    for (const agentDir of agentDirs) {
      const sessionsFile = path.join(process.env.HOME || '/root', `.openclaw/agents/${agentDir}/sessions/sessions.json`);
      if (!fs.existsSync(sessionsFile)) continue;
      try {
        const sessionsData = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
        // Try project-specific key first, then legacy key
        const keysToTry = agentDir === projectAgentId ? [sessionKeyProject] : [sessionKeyLegacy];
        for (const tryKey of keysToTry) {
          const entry = sessionsData[tryKey];
          if (entry?.sessionId) {
            const candidate = path.join(path.dirname(sessionsFile), `${entry.sessionId}.jsonl`);
            if (fs.existsSync(candidate)) {
              jsonlPath = candidate;
              foundSessionId = entry.sessionId;
              activeSessionKey = tryKey;
              break;
            }
          }
        }
        if (jsonlPath) break;
      } catch {}
    }

    const sessionKey = activeSessionKey;

    if (!jsonlPath) {
      res.json({ messages: [], lineCount: 0, sessionActive: false, complete: false });
      return;
    }

    // Read JSONL and extract user/assistant messages
    // JSONL FORMAT (from actual OpenClaw analysis 2026-02-17):
    //   type:"message" role:"assistant" stopReason:"toolUse"  → agent wants to call a tool (NOT done)
    //   type:"message" role:"toolResult"                       → tool response
    //   type:"message" role:"assistant" stopReason:"stop"      → agent finished this turn (DONE)
    //   type:"message" role:"user"                             → new user message (new turn)
    //   type:"compaction"                                      → context compaction
    //   type:"result"                                          → explicit turn result (rare)
    // NOTE: There are NO type:"tool_call" or type:"tool_result" entries.
    //       Tools appear as content blocks (tool_use) inside assistant messages
    //       and as separate role:"toolResult" messages.

    const allLines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(l => l.trim());
    const messages: Array<{ id: string; role: string; content: string; timestamp: string; lineIndex: number; toolCalls?: string[] }> = [];
    let lastActivityTs = '';
    const recentTools: Array<{ name: string; timestamp: string; active: boolean }> = [];

    // Track the last entry's state to determine completion.
    // Only the LAST relevant entry matters — not any historical one.
    let lastEntryState: 'idle' | 'user_waiting' | 'tool_running' | 'agent_done' = 'idle';
    let currentToolName = '';

    // CRITICAL: Read ALL lines for state determination, but only emit messages from afterLine.
    // Without this, incremental polls (afterLine=N where N=lineCount) see zero lines
    // and return idle state even when the agent is between API calls.
    for (let i = 0; i < allLines.length; i++) {
      // Skip message extraction for already-seen lines, but still track state
      const emitMessages = i >= afterLine;
      try {
        const entry = JSON.parse(allLines[i]);
        if (entry.timestamp) lastActivityTs = entry.timestamp;

        if (entry.type === 'message' && entry.message) {
          const role = entry.message.role;
          const stopReason = entry.message.stopReason || entry.message.stop_reason || '';

          if (role === 'user') {
            // New user message → new turn begins
            lastEntryState = 'user_waiting';
            recentTools.length = 0; // Clear tool history for new turn

            let text = '';
            if (typeof entry.message.content === 'string') {
              text = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
              for (const block of entry.message.content) {
                if (block.type === 'text') text += (text ? '\n' : '') + block.text;
              }
            }
            if (text && emitMessages) {
              // Strip portal context injection — show only the user's actual message
              const contextEnd = text.indexOf('[END CONTEXT]\n\n');
              const displayText = contextEnd >= 0 ? text.substring(contextEnd + 15) : text;
              // Also strip model-switch notes
              const modelNote = displayText.match(/^\[Note: Model switched to [^\]]+\]\n\n/);
              const cleanText = modelNote ? displayText.substring(modelNote[0].length) : displayText;
              if (cleanText.trim()) {
                messages.push({
                  id: entry.id, role, content: cleanText,
                  timestamp: entry.timestamp, lineIndex: i,
                });
              }
            }
          } else if (role === 'assistant') {
            // Extract text, thinking, and tool_use/toolCall blocks from content
            let text = '';
            const toolCalls: string[] = [];
            if (typeof entry.message.content === 'string') {
              text = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
              for (const block of entry.message.content) {
                if (block.type === 'text') text += (text ? '\n' : '') + block.text;
                if (block.type === 'tool_use' || block.type === 'toolCall') {
                  const toolName = block.name || 'tool';
                  toolCalls.push(toolName);
                  currentToolName = toolName;
                  recentTools.push({ name: toolName, timestamp: entry.timestamp || lastActivityTs, active: true });
                }
              }
            }

            // Emit assistant message if it has text content
            if (text && emitMessages) {
              messages.push({
                id: entry.id, role, content: text,
                timestamp: entry.timestamp, lineIndex: i,
                ...(toolCalls.length > 0 ? { toolCalls } : {}),
              });
            }
            // Also emit tool-only messages (no text, just tool calls) so UI shows activity
            if (!text && toolCalls.length > 0 && emitMessages) {
              messages.push({
                id: entry.id, role, content: `🔧 Using ${toolCalls.join(', ')}...`,
                timestamp: entry.timestamp, lineIndex: i,
                toolCalls,
              });
            }

            // Determine state from stopReason
            if (stopReason === 'stop' || stopReason === 'end_turn') {
              lastEntryState = 'agent_done';
            } else if (stopReason === 'toolUse' || stopReason === 'tool_use') {
              lastEntryState = 'tool_running';
            }
          } else if (role === 'toolResult') {
            // Tool finished — mark it complete, but agent is still working
            const tool = [...recentTools].reverse().find(t => t.active);
            if (tool) tool.active = false;
            currentToolName = '';
            lastEntryState = 'tool_running'; // Keep as processing until next assistant msg
          }
        }

        // Explicit result entry (rare but handle it)
        if (entry.type === 'result') {
          lastEntryState = 'agent_done';
        }
      } catch {}
    }

    // sessionActive: derived from JSONL presence (no WS RPC needed — avoids 1/sec flood)
    const sessionActive = allLines.length > 0;

    const lastActivity = lastActivityTs ? new Date(lastActivityTs) : null;
    const idleMs = lastActivity ? Date.now() - lastActivity.getTime() : Infinity;

    // Completion is simple: the last entry state says "agent_done"
    const sessionComplete = lastEntryState === 'agent_done';

    // Processing: anything that's not done and not idle
    const isProcessing = !sessionComplete && lastEntryState !== 'idle';

    // Active tool: only if state is tool_running and we have a current tool
    const activeToolCall = (lastEntryState === 'tool_running' && currentToolName) ? currentToolName :
      recentTools.find(t => t.active)?.name || null;

    res.json({
      messages,
      lineCount: allLines.length,
      sessionActive,
      complete: sessionComplete,
      isProcessing,
      activeToolCall: activeToolCall || null,
      recentTools: recentTools.slice(-50),
      lastActivity: lastActivityTs || null,
      idleMs: Math.round(idleMs),
    });
  } catch (error: any) {
    console.error('[Agent Poll] Error:', error.message);
    res.json({ messages: [], lineCount: 0, sessionActive: false, complete: false, error: error.message });
  }
});

// POST /api/projects/:name/assistant/send - Fire-and-forget message send (non-streaming)
// Returns immediately after dispatching to gateway. Frontend polls for response.
router.post('/:name/assistant/send', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const { message, model } = req.body;
    if (!message) { res.status(400).json({ error: 'message required' }); return; }

    const projectDir = getProjectPath(ownerId, name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const selectedModel = model || 'anthropic/claude-opus-4-6';
    // FIX BUG-5: Normalize project name for case-insensitive session keys
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    
    // Get or create session (Phase 2: per-project agent isolation)
    const { sessionKey, agentId, needsInit } = await getOrCreateSession(
      projectDir, ownerId, name, normalizedName
    );
    
    const gatewayToken = getGatewayToken();
    const gatewayUrl = `${getOpenClawApiUrl()}/v1/chat/completions`;

    // Patch model if needed
    if (selectedModel) {
      try {
        await patchSessionModel(sessionKey, selectedModel);
      } catch {}
    }

    // Check if model changed from last message
    const sessionStatePath = path.join(projectDir, '.agent-session.json');
    let previousModel = '';
    try {
      if (fs.existsSync(sessionStatePath)) {
        const meta = JSON.parse(fs.readFileSync(sessionStatePath, 'utf-8'));
        previousModel = meta.model || '';
      }
    } catch {}
    const modelChanged = previousModel && previousModel !== selectedModel;
    
    // Phase 2: project-specific agents mount to /home/user/project/, legacy to /home/user/projects/{name}/
    const sandboxProjectDir = agentId === 'portal' ? `/home/user/projects/${name}/` : `/home/user/project/`;
    let fullMessage = message;
    const assistantName = await getAssistantName();

    if (needsInit) {
      // Initialize project memory if missing
      const memoryPath = path.join(projectDir, '.agent-memory.md');
      if (!fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, `# Project Memory — ${name}\n\n## Overview\n(Describe what this project does)\n`, 'utf-8');
      }
      const projectType = detectProjectType(projectDir);

      fullMessage = `[PORTAL PROJECT CONTEXT]
You are ${assistantName}, an AI coding assistant working on the project "${name}".
Project Type: ${projectType}
Project Directory (inside sandbox): ${sandboxProjectDir}

**CRITICAL: You are sandboxed to this project directory. You have full tool access within the sandbox:**

**File Operations:**
- Use Read tool with file_path to read files. For large files (>1MB), use offset (line number) and limit (max lines) to read in chunks.
- Use Write tool to create/overwrite files.
- Use Edit tool for surgical find-and-replace edits.
- All paths should be absolute: ${sandboxProjectDir}filename.ext

**Commands:**
- Use exec tool to run shell commands (git, npm, node, ls, grep, find, etc.)
- Set workdir to ${sandboxProjectDir} or cd there first
- Examples: exec git status, exec npm install, exec ls -la

**Internet:**
- Use web_search for research
- Use web_fetch to download documentation or resources

**Project Memory:**
- Read .agent-memory.md to learn project context
- Update .agent-memory.md when you learn important patterns or decisions

**Security:** Do not try to access files outside ${sandboxProjectDir} - the sandbox prevents this anyway.

[END CONTEXT]

${message}`;
    } else if (modelChanged) {
      fullMessage = `[Note: Model switched to ${selectedModel}]\n\n${message}`;
    }

    const sandboxSystemMessage = {
      role: 'system' as const,
      content: `You are ${assistantName}, an AI coding assistant sandboxed to ${sandboxProjectDir}. You have full tool access (Read, Write, Edit, exec, web_search, web_fetch). The sandbox is enforced at the container level - you cannot escape it. Use tools to explore files intelligently instead of having everything embedded in prompts. Running as model: ${selectedModel}`
    };

    // Save user message to DB immediately (before sending)
    // Extract sessionId from key format: "agent:{agentId}:{sessionId}"
    const sessionId = sessionKey.split(':').slice(2).join(':');
    (async () => {
      try {
        await prisma.projectChatSession.upsert({
          where: { sessionKey: sessionId },
          update: { lastActivity: new Date(), model: selectedModel, status: 'active' },
          create: { userId: ownerId, projectId: name, sessionKey: sessionId, model: selectedModel, status: 'active' },
        });
        await prisma.projectChatMessage.create({
          data: { projectId: name, userId: ownerId, sessionKey: sessionId, role: 'user', content: message },
        });
      } catch (dbErr: any) {
        console.warn('[Agent Send] DB user message save failed (non-fatal):', dbErr.message);
      }
    })();

    // Fire-and-forget: send to gateway without waiting for full response
    // Use a background request with long timeout
    const controller = new AbortController();
    const timeoutMs = selectedModel.includes('ollama') ? 300000 : 600000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
        'x-openclaw-session-key': sessionKey,
      },
      body: JSON.stringify({
        messages: [sandboxSystemMessage, { role: 'user', content: fullMessage }],
      }),
      signal: controller.signal,
    }).then(async (response) => {
      clearTimeout(timeoutId);
      
      // Extract assistant response and save to DB
      if (response.ok) {
        try {
          const data: any = await response.json();
          const assistantText = data.choices?.[0]?.message?.content;
          if (assistantText) {
            await prisma.projectChatMessage.create({
              data: { 
                projectId: name, 
                userId: ownerId, 
                sessionKey: sessionId, 
                role: 'assistant', 
                content: assistantText.substring(0, 50000) 
              },
            });
          }
        } catch (dbErr: any) {
          console.warn('[Agent Send] DB assistant message save failed (non-fatal):', dbErr.message);
        }
      }
      
      // Auto-commit after response completes
      autoCommitProjectChanges(projectDir, ownerId, name, undefined, selectedModel).catch(() => {});
    }).catch((err) => {
      clearTimeout(timeoutId);
      if (err.name !== 'AbortError') {
        console.error(`[Agent Send] Background request failed: ${err.message}`);
      }
    });

    // Update session state
    const updatedMeta: SessionMeta = {
      initialized: true,
      model: selectedModel,
      lastActivity: new Date().toISOString(),
    };
    fs.writeFileSync(sessionStatePath, JSON.stringify(updatedMeta, null, 2), 'utf-8');

    // Return immediately - frontend will poll for response
    res.json({ sent: true, sessionKey });
  } catch (error: any) {
    console.error('[Agent Send] Error:', error.message);
    res.status(500).json({ error: 'Failed to send message', detail: error.message });
  }
});

// POST /api/projects/:name/assistant/read-file - Read a project file (for assistant context)
router.post('/:name/assistant/read-file', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const projectDir = getProjectPath(ownerId, req.params.name);
    if (!fs.existsSync(projectDir)) { res.status(404).json({ error: 'Project not found' }); return; }

    const { filePath } = req.body;
    if (!filePath) { res.status(400).json({ error: 'filePath required' }); return; }

    const fullPath = path.join(projectDir, filePath);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(projectDir))) { res.status(403).json({ error: 'Forbidden' }); return; }
    if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 10 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 10MB)' });
      return;
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    res.json({ content, path: filePath, size: stat.size });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// GET /api/projects/:name/download - Download project as ZIP
router.get('/:name/download', authenticateToken, async (req: Request, res: Response) => {
  try {
    const ownerId = await getScopedOwnerId(req);
    const { name } = req.params;
    const mode = (req.query.mode as string) || 'clean'; // full | clean | stripped
    
    const projectDir = getProjectPath(ownerId, name);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Files to always exclude
    const alwaysExclude = [
      '.assistant-*',
      '.git/**',
      'node_modules/**',
      '.venv/**',
      '.deps-installed',
      '.env',
      '.env.local',
      '.env.*.local',
      '__pycache__/**',
      '*.pyc',
      '.pytest_cache/**',
      '.DS_Store',
      'Thumbs.db',
      '.cache/**',
      '.turbo/**',
    ];

    // Additional excludes for clean modes (clean & stripped - not full)
    const cleanExclude = [
      ...alwaysExclude,
      'dist/**',
      'build/**',
      '.next/**',
      '.nuxt/**',
      'coverage/**',
      '.vscode/**',
      '.idea/**',
      'Agent.md',           // Agent documentation
      'agent.md',           // Lowercase variant
      'README.md',          // Markdown readme
      'readme.md',          // Lowercase markdown readme
      'Readme.md',          // Mixed case variant
      // Note: readme.txt is NOT excluded (kept in clean exports)
    ];

    const excludePatterns = (mode === 'full') ? alwaysExclude : cleanExclude;
    const stripComments = (mode === 'stripped');

    // Set response headers
    const filename = `${name}-${mode}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Import archiver
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err: Error) => {
      console.error('[Download] Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      }
    });

    // Pipe archive to response
    archive.pipe(res);

    // Helper: Strip comments from text files (safe regex approach)
    function stripCommentsFromCode(content: string, filePath: string): string {
      const ext = path.extname(filePath).toLowerCase();
      
      // JavaScript/TypeScript
      if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        // Remove single-line comments (but not URLs like http://example.com)
        content = content.replace(/([^:])\/\/.*/g, '$1');
        // Remove multi-line comments (but preserve JSDoc if it has @)
        content = content.replace(/\/\*(?![\s\S]*?@)[\s\S]*?\*\//g, '');
      }
      
      // CSS
      if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
        content = content.replace(/\/\*[\s\S]*?\*\//g, '');
      }
      
      // HTML
      if (['.html', '.htm'].includes(ext)) {
        content = content.replace(/<!--[\s\S]*?-->/g, '');
      }
      
      // Python
      if (ext === '.py') {
        // Remove single-line comments
        content = content.replace(/^\s*#.*/gm, '');
        // Remove docstrings (but keep first one if at top of file)
        const lines = content.split('\n');
        let inDocstring = false;
        let docstringChar = '';
        let firstDocstringSeen = false;
        const result: string[] = [];
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          
          if (!inDocstring) {
            if ((trimmed.startsWith('"""') || trimmed.startsWith("'''")) && !firstDocstringSeen) {
              // Keep first docstring
              result.push(line);
              firstDocstringSeen = true;
              if (!trimmed.endsWith('"""') && !trimmed.endsWith("'''")) {
                inDocstring = true;
                docstringChar = trimmed.startsWith('"""') ? '"""' : "'''";
              }
            } else if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
              // Remove subsequent docstrings
              docstringChar = trimmed.startsWith('"""') ? '"""' : "'''";
              if (!trimmed.endsWith(docstringChar) || trimmed.length <= 3) {
                inDocstring = true;
              }
            } else {
              result.push(line);
            }
          } else {
            if (!firstDocstringSeen) {
              result.push(line);
              if (trimmed.endsWith(docstringChar)) {
                inDocstring = false;
                firstDocstringSeen = true;
              }
            } else {
              if (trimmed.endsWith(docstringChar)) {
                inDocstring = false;
              }
            }
          }
        }
        content = result.join('\n');
      }
      
      return content;
    }

    // Walk directory and add files
    function addDirectory(dirPath: string, zipPath: string = '') {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        
        // Check if excluded
        let isExcluded = false;
        for (const pattern of excludePatterns) {
          const patternPath = pattern.replace(/\/\*\*$/, '');
          const entryName = path.basename(relPath);
          if (relPath === patternPath || 
              relPath.startsWith(patternPath + '/') ||
              (pattern.includes('**') && relPath.includes(patternPath.replace('/**', ''))) ||
              (pattern.endsWith('*') && !pattern.includes('/') && entryName.startsWith(pattern.slice(0, -1)))) {
            isExcluded = true;
            break;
          }
        }
        
        if (isExcluded) continue;
        
        if (entry.isDirectory()) {
          addDirectory(fullPath, relPath);
        } else {
          const stat = fs.statSync(fullPath);
          
          // Detect if file is text or binary
          const ext = path.extname(entry.name).toLowerCase();
          const textExtensions = [
            '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.scss', '.sass', '.less',
            '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.rb', '.php',
            '.md', '.txt', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf',
            '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
          ];
          
          const isBinary = !textExtensions.includes(ext);
          
          if (stripComments && !isBinary && stat.size < 5 * 1024 * 1024) {
            // Text file < 5MB: strip comments
            try {
              let content = fs.readFileSync(fullPath, 'utf-8');
              content = stripCommentsFromCode(content, entry.name);
              archive.append(content, { name: relPath });
            } catch (err) {
              // If UTF-8 read fails, treat as binary
              archive.file(fullPath, { name: relPath });
            }
          } else {
            // Binary file or large file: add as-is
            archive.file(fullPath, { name: relPath });
          }
        }
      }
    }

    addDirectory(projectDir);

    await archive.finalize();
    
    console.log(`[Download] ${name} (${mode}) → ${archive.pointer()} bytes`);
  } catch (error: any) {
    console.error('[Download] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed: ' + error.message });
    }
  }
});


export default router;
