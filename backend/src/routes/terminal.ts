import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { config } from '../config/env';
import { prisma } from '../config/database';
import {
  classifyTerminalCommand,
  getTerminalCapabilities,
  getTerminalSuggestions,
} from '../services/terminalCapabilities';
import {
  requestResolvedOllamaJson,
  resolveOllamaBackendAuthority,
} from '../services/ollamaBackendAuthority';

const router = Router();
router.use(authenticateToken, requireAdmin);

// Resolve model from tier settings + current backend (GPU/CPU)
async function resolveModelFromTier(tier: string | undefined, explicitModel?: string): Promise<string> {
  // Explicit model overrides tier
  if (explicitModel && explicitModel.trim()) return explicitModel;

  const validTier = ['snappy', 'smart', 'best'].includes(tier || '') ? tier : 'smart';

  // Raw remote endpoints are not runtime authority. The identity-bound
  // adapter will select a remote tier only after a native connection exists.
  const prefix = 'ollama.local.tier';
  const settingKey = `${prefix}.${validTier}`;

  // Try to read the tier model from DB settings
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: settingKey } });
    if (setting?.value && setting.value.trim()) return setting.value;
  } catch {}

  // Fallback: try default model setting
  try {
    const def = await prisma.systemSetting.findUnique({ where: { key: 'ollama.defaultModel' } });
    if (def?.value && def.value.trim()) return def.value;
  } catch {}

  return config.ollamaModel;
}

function normalizeLookupCommands(rows: unknown[]): Array<{
  command: string;
  explanation: string;
  warning: string | null;
  risk: 'read_only' | 'service_change' | 'destructive';
  confirmation: 'none' | 'explicit' | 'typed';
}> {
  return rows.slice(0, 5).flatMap((row: any) => {
    if (!row || typeof row.command !== 'string') return [];
    const command = row.command.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (!command || command.length > 1_000 || /[\r\n]/.test(command)) return [];
    const classification = classifyTerminalCommand(command);
    return [{
      command,
      explanation: typeof row.explanation === 'string' ? row.explanation.slice(0, 500) : '',
      warning: classification.message || (typeof row.warning === 'string' ? row.warning.slice(0, 500) : null),
      risk: classification.risk,
      confirmation: classification.confirmation,
    }];
  });
}

// POST /api/terminal/lookup - AI-powered natural language → command generation
router.post('/lookup', async (req: Request, res: Response) => {
  try {
    const { query, context, model, tier } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }
    if (query.length > 4_000) {
      res.status(400).json({ error: 'query is too long' });
      return;
    }
    const runtimeCapabilities = await getTerminalCapabilities(false);
    const installedTools = runtimeCapabilities.tools
      .filter((tool) => tool.installed)
      .map((tool) => `${tool.id}${tool.version ? ` (${tool.version})` : ''}`)
      .join(', ');
    const serviceStates = runtimeCapabilities.services
      .filter((service) => service.installed)
      .map((service) => `${service.unit}=${service.status}`)
      .join(', ');
    const reviewedActions = runtimeCapabilities.actions
      .filter((action) => action.available)
      .map((action) => `${action.title}: ${action.command}`)
      .join('\n');

    const systemPrompt = `You are assisting an authorized host operator in a Linux terminal. You MUST respond with ONLY valid JSON, no other text.

REQUIRED JSON FORMAT:
{"commands":[{"command":"the command","explanation":"what it does","warning":null}],"summary":"one sentence"}

Example response:
{"commands":[{"command":"ls -la","explanation":"List all files with details","warning":null}],"summary":"List files in current directory"}

Runtime-detected tools: ${installedTools || 'none detected'}.
Runtime-detected services: ${serviceStates || 'none detected'}.
Reviewed Portal actions available on this host:
${reviewedActions || 'none'}
Prefer read-only inspection before mutation. Never invent an installed tool, version, service name, or option. Do not suggest automatic OpenClaw doctor repairs. Flag service changes and destructive commands with precise warnings. Keep explanations brief.`;

    // Build prompt with optional terminal context (limited to 4000 chars)
    let fullPrompt = systemPrompt;
    if (context && typeof context === 'string' && context.trim()) {
      fullPrompt += `\n\nTerminal context:\n${context.slice(-4000)}`;
    }
    fullPrompt += `\n\nUser request: ${query}\n\nRespond with ONLY JSON:`;

    // Try Ollama
    try {
      const resolvedAuthority = await resolveOllamaBackendAuthority();
      const ollamaModel = resolvedAuthority.authority.kind === 'TAILNET'
        ? String(resolvedAuthority.authority.selectedModel || '')
        : await resolveModelFromTier(tier, model);
      const { value: data } = await requestResolvedOllamaJson<any>(resolvedAuthority, {
        path: '/api/generate',
        method: 'POST',
        json: {
          model: ollamaModel,
          prompt: fullPrompt,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.3,
            num_predict: 512,
            num_ctx: 4096,
          },
        },
        timeoutMs: 120_000,
        maxResponseBytes: 2 * 1024 * 1024,
      });

      const rawResponse = (data.response || '').trim();
        try {
          const parsed = JSON.parse(rawResponse);
          // Validate structure
          if (parsed.commands && Array.isArray(parsed.commands)) {
            res.json({
              commands: normalizeLookupCommands(parsed.commands),
              summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 300) : '',
              model: ollamaModel,
              source: 'ollama',
            });
            return;
          }
          // Model returned JSON but wrong structure - try to adapt
          if (parsed.command) {
            res.json({
              commands: normalizeLookupCommands([{ command: parsed.command, explanation: parsed.explanation, warning: parsed.warning }]),
              summary: String(parsed.summary || parsed.explanation || '').slice(0, 300),
              model: ollamaModel, source: 'ollama',
            });
            return;
          }
        } catch {
          // Fall through to bounded plain-text extraction.
        }
        
        // Fallback: try to extract commands from backticks in plain text
        const backtickMatches = rawResponse.match(/`([^`]+)`/g);
        if (backtickMatches && backtickMatches.length > 0) {
          const commands = normalizeLookupCommands(backtickMatches.slice(0, 5).map((m: string) => ({
            command: m.replace(/`/g, ''),
            explanation: 'Extracted from AI response',
            warning: null,
          })));
          res.json({ commands, summary: rawResponse.split('\n')[0].slice(0, 200), model: ollamaModel, source: 'ollama' });
          return;
        }
        
        // Last resort: if response looks like a command (short, no spaces or starts with known tools)
        if (rawResponse.length < 200 && !rawResponse.includes('{')) {
          res.json({
            commands: normalizeLookupCommands([{ command: rawResponse.split('\n')[0], explanation: 'AI suggestion', warning: null }]),
            summary: rawResponse.split('\n')[0],
            model: ollamaModel, source: 'ollama',
          });
          return;
        }
        
        // Truly couldn't parse - return the text as summary with no commands
        res.json({
          commands: [],
          summary: rawResponse.slice(0, 300),
          note: 'AI responded but could not extract specific commands. Try rephrasing.',
          model: ollamaModel, source: 'ollama',
        });
      return;
    } catch {
      // Ollama not available
    }

    res.json({
      commands: [],
      summary: 'The configured Ollama backend is unavailable.',
      model: 'unavailable',
      source: 'none',
    });
  } catch (error) {
    console.error('Terminal lookup error:', error);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// Runtime capability inventory. This is intentionally not a shell-command encyclopedia:
// the server reports what is actually installed, plus a short reviewed action set.
router.get('/capabilities', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const capabilities = await getTerminalCapabilities(forceRefresh);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(capabilities);
  } catch (error) {
    console.error('Terminal capability probe failed:', error);
    res.status(500).json({ error: 'Capability discovery failed' });
  }
});

// Runtime-backed completion from PATH, installed tool help, and curated actions.
router.get('/autocomplete', async (req: Request, res: Response) => {
  try {
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix.slice(0, 500) : '';
    const requestedLimit = Number.parseInt(String(req.query.limit || '20'), 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20;
    const suggestions = await getTerminalSuggestions(prefix, limit);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ suggestions });
  } catch (error) {
    console.error('Terminal autocomplete failed:', error);
    res.status(500).json({ error: 'Autocomplete failed' });
  }
});

// Shared risk policy for AI suggestions and UI confirmations.
router.post('/classify', (req: Request, res: Response) => {
  const command = typeof req.body?.command === 'string' ? req.body.command : '';
  if (!command.trim()) {
    res.status(400).json({ error: 'command is required' });
    return;
  }
  if (command.length > 2_000) {
    res.status(413).json({ error: 'command is too long to classify safely' });
    return;
  }
  res.json(classifyTerminalCommand(command));
});

export default router;
