import { Router } from 'express';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { prisma } from '../config/database';
import { config } from '../config/env';

const router = Router();

router.use(authenticateToken, requireAdmin);

const OLLAMA_CTRL_URL = process.env.OLLAMA_CTRL_URL || 'http://host.docker.internal:19123';
const OLLAMA_CTRL_SECRET = process.env.OLLAMA_CTRL_SECRET || 'ollama-ctrl-8f3k2j';

// Call the host-side Ollama control API
async function ollamaCtrl(path: string, method: 'GET' | 'POST' = 'GET'): Promise<any> {
  const resp = await fetch(`${OLLAMA_CTRL_URL}${path}`, {
    method,
    headers: { 'X-Secret': OLLAMA_CTRL_SECRET },
    signal: AbortSignal.timeout(30000)
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Ollama control API error (${resp.status}): ${text}`);
  }
  return resp.json();
}

/**
 * Emergency Ollama controls
 * POST /api/system-control/ollama/kill - Kill all Ollama runners
 * POST /api/system-control/ollama/restart - Stop and restart Ollama service
 */

router.post('/ollama/kill', async (req, res) => {
  const userId = req.user!.userId;
  
  try {
    console.log('🚨 Emergency: Killing Ollama runners');
    
    const result = await ollamaCtrl('/kill', 'POST');
    const load = result.load || 0;
    
    // Log to activity
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'OLLAMA_KILL',
        resource: 'system',
        metadata: { runnersKilled: true, load },
        translatedMessage: `🛑 Emergency: Killed Ollama (load: ${load.toFixed(2)})`,
        severity: 'WARNING'
      }
    }).catch(err => console.error('Failed to log activity:', err));
    
    res.json({
      success: true,
      message: 'Ollama killed successfully',
      load: load,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Failed to kill Ollama:', error);
    
    // Log failure
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'OLLAMA_KILL',
        resource: 'system',
        metadata: { error: error.message },
        translatedMessage: `❌ Failed to kill Ollama: ${error.message}`,
        severity: 'ERROR'
      }
    }).catch(err => console.error('Failed to log activity:', err));
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.post('/ollama/restart', async (req, res) => {
  const userId = req.user!.userId;
  
  try {
    console.log('🔄 Restarting Ollama service');
    
    const result = await ollamaCtrl('/restart', 'POST');
    const isActive = result.active === 'active';
    const load = result.load || 0;
    
    // Log to activity
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'OLLAMA_RESTART',
        resource: 'system',
        metadata: { active: isActive, load },
        translatedMessage: `🔄 Restarted Ollama (${isActive ? 'active' : 'inactive'}, load: ${load.toFixed(2)})`,
        severity: 'INFO'
      }
    }).catch(err => console.error('Failed to log activity:', err));
    
    res.json({
      success: true,
      message: isActive ? 'Ollama restarted successfully' : 'Ollama stopped (not started)',
      active: isActive,
      load: load,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Failed to restart Ollama:', error);
    
    // Log failure
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'OLLAMA_RESTART',
        resource: 'system',
        metadata: { error: error.message },
        translatedMessage: `❌ Failed to restart Ollama: ${error.message}`,
        severity: 'ERROR'
      }
    }).catch(err => console.error('Failed to log activity:', err));
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

router.get('/ollama/status', async (req, res) => {
  try {
    const result = await ollamaCtrl('/status');
    const isActive = result.active === 'active';
    const runnerCount = result.runners || 0;
    const load = result.load || 0;
    const stuckRunners: any[] = [];
    
    res.json({
      success: true,
      active: isActive,
      runnerCount,
      stuckRunners,
      load,
      loadWarning: load > 4.0,
      loadCritical: load > 6.0,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Failed to get Ollama status:', error);
    res.json({
      success: true,
      active: false,
      runnerCount: 0,
      stuckRunners: [],
      load: 0,
      loadWarning: false,
      loadCritical: false,
      unavailable: true,
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/ollama/model-status', authenticateToken, async (req, res) => {
  try {
    const model = req.query.model as string;
    const result = await ollamaCtrl(`/model-status${model ? `?model=${encodeURIComponent(model)}` : ''}`);
    
    res.json({
      success: true,
      runningModels: result.running_models || [],
      targetModel: result.target_model,
      modelLoaded: result.model_loaded || false,
      isLoading: result.is_loading || false,
      totalRunning: result.total_running || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Failed to get Ollama model status:', error);
    res.json({
      success: true,
      runningModels: [],
      targetModel: null,
      modelLoaded: false,
      isLoading: false,
      totalRunning: 0,
      unavailable: true,
      timestamp: new Date().toISOString()
    });
  }
});

// Smart proxy-aware status: checks the Ollama proxy to determine backend (GPU remote vs CPU local)
router.get('/ollama/proxy-status', authenticateToken, async (_req, res) => {
  const ollamaUrl = config.ollamaApiUrl;
  try {
    // Check version (gets x-ollama-backend header from proxy)
    const versionRes = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
    const backend = versionRes.headers.get('x-ollama-backend') || 'unknown';
    const version = await versionRes.json() as any;

    // Get models list
    const tagsRes = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const tagsData = await tagsRes.json() as any;
    const models = (tagsData.models || []).map((m: any) => ({
      name: m.name,
      size: m.details?.parameter_size || 'unknown',
      family: m.details?.family || 'unknown',
    }));

    // Get running models
    let runningModels: string[] = [];
    try {
      const psRes = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(3000) });
      const psData = await psRes.json() as any;
      runningModels = (psData.models || []).map((m: any) => m.name);
    } catch {}

    res.json({
      available: true,
      backend, // 'gpu-remote' | 'cpu-local' | 'cpu-local-fallback' | 'unknown'
      version: version.version,
      models,
      runningModels,
      isGpu: backend === 'gpu-remote',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.json({
      available: false,
      backend: 'offline',
      version: null,
      models: [],
      runningModels: [],
      isGpu: false,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
