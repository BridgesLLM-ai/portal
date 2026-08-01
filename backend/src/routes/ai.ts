import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { aiPathSandbox } from '../middleware/pathSandbox';
import { config } from '../config/env';
import { prisma } from '../config/database';
import { resolveContainedPath } from '../services/containedPath';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';
import { resolveFilePath } from './files';
import { z } from 'zod';
import { isValidOllamaModelName } from '../utils/ollamaRecommendations';
import { admitWorkspaceAuthorizationRead } from '../services/workspaceAuthorizationBarrier';
import { isOwnerRole } from '../utils/authz';
import {
  OllamaBackendAuthorityError,
  requestConfiguredOllamaJson,
  requestResolvedOllamaJson,
  resolveOllamaBackendAuthority,
  type OllamaBackendAuthority,
} from '../services/ollamaBackendAuthority';

const router = Router();
const PROJECTS_DIR = path.resolve(
  process.env.PORTAL_PROJECTS_ROOT
    || path.join(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal', 'projects'),
);
const MAX_AI_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_ANALYSIS_PROMPT = 'Analyze this code and provide suggestions for improvement.';

function admitOwnerScopedAiRead(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !admitWorkspaceAuthorizationRead(req, res, req.user.userId)) return;
  next();
}

const analyzeFileSchema = z.object({
  filePath: z.string().min(1).max(4_096),
  projectName: z.string().trim().min(1).max(255).optional(),
  prompt: z.string().trim().min(1).max(32_768).optional(),
}).strict();

const chatSchema = z.object({
  message: z.string().trim().min(1).max(32_768),
  context: z.string().max(262_144).optional(),
}).strict();

const analyzeCodeSchema = z.object({
  code: z.string().min(1).max(1_048_576),
  language: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_+#.-]+$/).optional(),
  model: z.string().trim().min(1).max(255).refine(isValidOllamaModelName, 'Invalid Ollama model name').optional(),
}).strict();

function isTimeoutError(error: unknown): boolean {
  const value = error as { code?: string; name?: string; message?: string } | null;
  return value?.code === 'TIMEOUT'
    || value?.code === 'TIMED_OUT'
    || value?.name === 'AbortError'
    || value?.name === 'TimeoutError'
    || Boolean(value?.message?.toLowerCase().includes('timeout'));
}

async function requestOllama(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{
  response: { ok: true; status: 200 };
  data: any;
  model: string;
  authority: OllamaBackendAuthority;
}> {
  const resolved = await resolveOllamaBackendAuthority();
  const requestedModel = String(body.model || '').trim();
  const model = resolved.authority.kind === 'TAILNET'
    ? String(resolved.authority.selectedModel || '')
    : requestedModel;
  if (!isValidOllamaModelName(model)) {
    throw new OllamaBackendAuthorityError('MODEL_MISMATCH', 409);
  }
  const result = await requestResolvedOllamaJson<any>(resolved, {
    path: '/api/generate',
    method: 'POST',
    json: { ...body, model },
    timeoutMs,
    maxResponseBytes: MAX_AI_RESPONSE_BYTES,
  });
  return {
    response: { ok: true, status: 200 },
    data: result.value,
    model,
    authority: result.authority,
  };
}

function resolveAiTargetPath(userId: string, filePath?: string, projectName?: string): string | null {
  if (!filePath || typeof filePath !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(userId)) return null;

  if (projectName && typeof projectName === 'string' && projectName.trim()) {
    try {
      const ownerRoot = resolveContainedPath(PROJECTS_DIR, userId, { mustExist: true, kind: 'directory' });
      const projectDir = resolveContainedPath(ownerRoot, projectName.trim(), { mustExist: true, kind: 'directory' });
      return resolveContainedPath(projectDir, filePath, { mustExist: true, kind: 'file' });
    } catch {
      return null;
    }
  }

  return resolveFilePath(userId, filePath);
}

// POST /api/ai/analyze - Analyze a file with Ollama
router.post('/analyze', authenticateToken, requireApproved, aiPathSandbox, admitOwnerScopedAiRead, async (req: Request, res: Response) => {
  try {
    const { filePath, projectName, prompt = DEFAULT_ANALYSIS_PROMPT } = analyzeFileSchema.parse(req.body);
    
    let content = '';
    const ownerId = await getWorkspaceOwnerId(req.user!);
    const resolvedPath = resolveAiTargetPath(ownerId, filePath, projectName);

    if (!resolvedPath) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    if (!fs.existsSync(resolvedPath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stat = fs.statSync(resolvedPath);
    if (stat.size > 1024 * 1024) {
      res.status(413).json({ error: 'File too large for analysis (max 1MB)' });
      return;
    }

    content = fs.readFileSync(resolvedPath, 'utf-8');

    const fullPrompt = `${prompt}\n\nFile: ${path.basename(resolvedPath)}\n\n\`\`\`\n${content}\n\`\`\``;

    // Try Ollama
    try {
      const { response, data, model } = await requestOllama({
        model: config.ollamaModel,
        prompt: fullPrompt,
        stream: false,
      }, 120_000);

      if (response.ok) {
        const analysis = typeof data.response === 'string' ? data.response : '';
        res.json({ analysis, model, source: 'ollama' });
        return;
      }
    } catch {
      // Ollama not available, fall through
    }

    // Fallback: basic analysis
    const lines = content.split('\n');
    const analysis = [
      `## File Analysis: ${path.basename(resolvedPath)}`,
      `- **Lines**: ${lines.length}`,
      `- **Size**: ${(stat.size / 1024).toFixed(1)} KB`,
      `- **Type**: ${path.extname(resolvedPath)}`,
      '',
      '### Structure',
      `- Functions/methods: ${(content.match(/function\s+\w+|const\s+\w+\s*=.*=>/g) || []).length}`,
      `- Imports: ${(content.match(/import\s+/g) || []).length}`,
      `- Comments: ${(content.match(/\/\/|\/\*|\#\s/g) || []).length}`,
      '',
      '*Note: The configured Ollama backend is unavailable.*',
    ].join('\n');

    res.json({ analysis, model: 'fallback', source: 'basic' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0]?.message || 'Invalid analysis request' });
      return;
    }
    console.error('AI analysis error:', error);
    if (isTimeoutError(error)) {
      res.status(504).json({ error: 'Analysis timed out' });
    } else if (
      error instanceof OllamaBackendAuthorityError
      && error.code === 'RESPONSE_TOO_LARGE'
    ) {
      res.status(502).json({ error: 'Ollama returned an oversized response' });
    } else {
      res.status(500).json({ error: 'Analysis failed' });
    }
  }
});

// POST /api/ai/chat - Chat about code
router.post('/chat', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const { message, context } = chatSchema.parse(req.body);

    const fullPrompt = context 
      ? `Context:\n\`\`\`\n${context}\n\`\`\`\n\nQuestion: ${message}`
      : message;

    try {
      const { response, data, model } = await requestOllama({
        model: config.ollamaModel,
        prompt: fullPrompt,
        stream: false,
      }, 120_000);

      if (response.ok) {
        res.json({ response: typeof data.response === 'string' ? data.response : '', model });
        return;
      }
    } catch (error) {
      if (isTimeoutError(error)) {
        res.status(504).json({ error: 'Chat request timed out' });
        return;
      }
      if (
        error instanceof OllamaBackendAuthorityError
        && error.code === 'RESPONSE_TOO_LARGE'
      ) {
        res.status(502).json({ error: 'Ollama returned an oversized response' });
        return;
      }
    }

    res.json({ response: 'The configured Ollama backend is unavailable.', model: 'unavailable' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0]?.message || 'Invalid chat request' });
    } else {
      res.status(500).json({ error: 'Chat failed' });
    }
  }
});

// GET /api/ai/file-content - Read file for assistant/Claude access
router.get('/file-content', authenticateToken, requireApproved, aiPathSandbox, admitOwnerScopedAiRead, async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    const projectName = req.query.project as string;

    const ownerId = await getWorkspaceOwnerId(req.user!);
    const resolved = resolveAiTargetPath(ownerId, filePath, projectName);
    if (!resolved) {
      res.status(403).json({ error: 'Invalid file path' });
      return;
    }

    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const stat = fs.statSync(resolved);
    if (stat.size > 5 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large' });
      return;
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    res.json({ content, path: filePath, size: stat.size });
  } catch {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// GET /api/ai/ollama-status - Check Ollama availability and models
router.get(
  '/ollama-status',
  authenticateToken,
  requireApproved,
  async (req: Request, res: Response) => {
    try {
      const { authority, value: data } = await requestConfiguredOllamaJson<any>({
        path: '/api/tags',
        method: 'GET',
        timeoutMs: 10_000,
        maxResponseBytes: MAX_AI_RESPONSE_BYTES,
      });
      const installedModels = Array.isArray(data.models)
        ? data.models.slice(0, 1_000).flatMap((entry: any) => {
          const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
          return isValidOllamaModelName(name) ? [name] : [];
        })
        : [];
      const defaultModel = authority.kind === 'TAILNET'
        ? authority.selectedModel
        : config.ollamaModel;
      const owner = Boolean(req.user && isOwnerRole(req.user.role));
      const callableModels = authority.kind === 'TAILNET'
        ? installedModels.filter((model) => model === defaultModel).slice(0, 1)
        : installedModels;
      const models = owner
        ? callableModels
        : callableModels.filter((model) => model === defaultModel).slice(0, 1);
      res.json({
        available: true,
        models,
        defaultModel,
        ...(owner
          ? {
            backend: authority.kind.toLowerCase(),
            generation: authority.generation,
          }
          : {}),
      });
    } catch {
      res.json({ available: false, models: [], defaultModel: config.ollamaModel });
    }
  },
);

// POST /api/ai/analyze-code - Analyze code content with Ollama (structured issues)
router.post('/analyze-code', authenticateToken, requireApproved, async (req: Request, res: Response) => {
  try {
    const { code, language, model } = analyzeCodeSchema.parse(req.body);

    const defaultModelSetting = await prisma.systemSetting.findUnique({ where: { key: 'ollama.defaultModel' } });
    const useModel = model || defaultModelSetting?.value || config.ollamaModel;

    const prompt = `Find up to 10 critical issues in this ${language || 'code'}. Return JSON: {"issues":[{"line":1,"endLine":1,"severity":"error","message":"desc","suggestion":"explanation of fix","code":"corrected code for those lines"}]}
Severity: error/warning/info. "code" must contain the corrected replacement code for lines line..endLine. If the fix spans one line, endLine equals line. If none, return {"issues":[]}.

\`\`\`${language || 'javascript'}
${code}
\`\`\``;

    if (!isValidOllamaModelName(useModel)) {
      res.status(400).json({ error: 'Configured Ollama model is invalid' });
      return;
    }

    const { response, data, model: actualModel } = await requestOllama({
      model: useModel,
      prompt,
      format: 'json',
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 2048,
      },
    }, 120_000);

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status}`);
    }

    let issues: any[] = [];

    try {
      const parsed = JSON.parse(data.response);
      if (Array.isArray(parsed)) {
        issues = parsed.slice(0, 10);
      } else if (parsed.issues && Array.isArray(parsed.issues)) {
        issues = parsed.issues.slice(0, 10);
      }
    } catch {
      issues = [{
        line: 1,
        severity: 'info' as const,
        message: 'Analysis completed but results were not structured',
        suggestion: data.response?.substring(0, 500) || 'No response',
      }];
    }

    res.json({ issues, model: actualModel });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0]?.message || 'Invalid code analysis request' });
      return;
    }
    console.error('[AI] Code analysis error:', error?.message || error);
    if (isTimeoutError(error)) {
      res.status(504).json({ 
        error: 'Analysis timed out — file may be too large. Try a smaller file or the Snappy model.' 
      });
    } else if (
      error instanceof OllamaBackendAuthorityError
      && error.code === 'RESPONSE_TOO_LARGE'
    ) {
      res.status(502).json({ error: 'Ollama returned an oversized response' });
    } else if (
      error instanceof OllamaBackendAuthorityError
      && [
        'BACKEND_UNAVAILABLE',
        'LOCAL_DISABLED',
        'REMOTE_DISCONNECTED',
        'REMOTE_IDENTITY_UNAVAILABLE',
      ].includes(error.code)
    ) {
      res.status(503).json({ error: 'The configured Ollama backend is unavailable' });
    } else {
      res.status(500).json({ error: 'Analysis failed' });
    }
  }
});

export default router;
