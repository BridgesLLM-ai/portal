import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { authenticateToken } from '../middleware/auth';
import { config } from '../config/env';
import { prisma } from '../config/database';

const router = Router();
const UPLOAD_DIR = '/portal/files';
const PROJECTS_DIR = path.join(process.env.PORTAL_ROOT || '/portal', 'projects');

// Test Ollama availability
const testOllama = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${config.ollamaApiUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

// POST /api/ai/analyze - Analyze a file with Ollama
router.post('/analyze', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { filePath, projectName, prompt = 'Analyze this code and provide suggestions for improvement.' } = req.body;
    
    let content = '';
    let resolvedPath = '';

    if (projectName && filePath) {
      resolvedPath = path.join(PROJECTS_DIR, req.user!.userId, projectName, filePath);
    } else if (filePath) {
      resolvedPath = path.join(UPLOAD_DIR, req.user!.userId, filePath);
    }

    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
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
      const response = await fetch(`${config.ollamaApiUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollamaModel,
          prompt: fullPrompt,
          stream: false,
        }),
      });

      if (response.ok) {
        const data = await response.json() as any;
        res.json({ analysis: data.response, model: config.ollamaModel, source: 'ollama' });
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
      '*Note: Ollama is not available. Install and start Ollama for AI-powered analysis.*',
    ].join('\n');

    res.json({ analysis, model: 'fallback', source: 'basic' });
  } catch (error) {
    console.error('AI analysis error:', error);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// POST /api/ai/chat - Chat about code
router.post('/chat', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { message, context } = req.body;
    if (!message) { res.status(400).json({ error: 'message required' }); return; }

    const fullPrompt = context 
      ? `Context:\n\`\`\`\n${context}\n\`\`\`\n\nQuestion: ${message}`
      : message;

    try {
      const response = await fetch(`${config.ollamaApiUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollamaModel,
          prompt: fullPrompt,
          stream: false,
        }),
      });

      if (response.ok) {
        const data = await response.json() as any;
        res.json({ response: data.response, model: config.ollamaModel });
        return;
      }
    } catch {}

    res.json({ response: 'Ollama is not available. Please ensure Ollama is running on this server.', model: 'unavailable' });
  } catch (error) {
    res.status(500).json({ error: 'Chat failed' });
  }
});

// GET /api/ai/file-content - Read file for assistant/Claude access
router.get('/file-content', authenticateToken, async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    const projectName = req.query.project as string;

    let resolved = '';
    if (projectName && filePath) {
      resolved = path.join(PROJECTS_DIR, req.user!.userId, projectName, filePath);
    } else if (filePath) {
      resolved = path.join(UPLOAD_DIR, req.user!.userId, filePath);
    }

    if (!resolved || !fs.existsSync(resolved)) {
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
  } catch (error) {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// GET /api/ai/ollama-status - Check Ollama availability and models
router.get('/ollama-status', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const response = await fetch(`${config.ollamaApiUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const data = await response.json() as any;
      const models = (data.models || []).map((m: any) => m.name);
      res.json({ available: true, models, defaultModel: config.ollamaModel });
    } else {
      res.json({ available: false, models: [], defaultModel: config.ollamaModel });
    }
  } catch {
    res.json({ available: false, models: [], defaultModel: config.ollamaModel });
  }
});

// POST /api/ai/analyze-code - Analyze code content with Ollama (structured issues)
router.post('/analyze-code', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { code, language, model } = req.body;

    if (!code) {
      res.status(400).json({ error: 'Code required' });
      return;
    }

    const ollamaAvailable = await testOllama();
    if (!ollamaAvailable) {
      res.status(503).json({ error: 'Ollama service unavailable' });
      return;
    }

    const defaultModelSetting = await prisma.systemSetting.findUnique({ where: { key: 'ollama.defaultModel' } });
    const useModel = model || defaultModelSetting?.value || config.ollamaModel;

    const prompt = `Find up to 10 critical issues in this ${language || 'code'}. Return JSON: {"issues":[{"line":1,"endLine":1,"severity":"error","message":"desc","suggestion":"explanation of fix","code":"corrected code for those lines"}]}
Severity: error/warning/info. "code" must contain the corrected replacement code for lines line..endLine. If the fix spans one line, endLine equals line. If none, return {"issues":[]}.

\`\`\`${language || 'javascript'}
${code}
\`\`\``;

    const response = await fetch(`${config.ollamaApiUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: useModel,
        prompt,
        format: 'json',
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 2048,
        },
      }),
      signal: AbortSignal.timeout(120000), // 2 minutes for complex code analysis
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status}`);
    }

    const data = await response.json() as any;
    let issues: any[] = [];

    try {
      const parsed = JSON.parse(data.response);
      if (Array.isArray(parsed)) {
        issues = parsed;
      } else if (parsed.issues && Array.isArray(parsed.issues)) {
        issues = parsed.issues;
      }
    } catch {
      issues = [{
        line: 1,
        severity: 'info' as const,
        message: 'Analysis completed but results were not structured',
        suggestion: data.response?.substring(0, 500) || 'No response',
      }];
    }

    res.json({ issues, model: useModel });
  } catch (error: any) {
    console.error('[AI] Code analysis error:', error?.message || error);
    if (error?.name === 'AbortError' || error?.message?.includes('timeout')) {
      res.status(504).json({ 
        error: 'Analysis timed out — file may be too large. Try a smaller file or the Snappy model.' 
      });
    } else if (error?.cause?.code === 'ECONNREFUSED') {
      res.status(503).json({ error: 'Ollama is not running' });
    } else {
      res.status(500).json({ 
        error: `Analysis failed: ${error?.message || 'Unknown error'}` 
      });
    }
  }
});

export default router;
