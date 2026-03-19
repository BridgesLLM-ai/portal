import fs from 'fs';
import { exec } from 'child_process';
import axios from 'axios';
import { config } from './env';

export type ReadinessStatus = 'ready' | 'partial' | 'missing';
export type ReadinessCheckType = 'command' | 'path' | 'http' | 'config';

export interface FeatureReadinessCheckDef {
  id: string;
  label: string;
  type: ReadinessCheckType;
  required: boolean;
  remediation: string;
  command?: string;
  path?: string;
  url?: string;
  timeoutMs?: number;
}

export interface FeatureReadinessDef {
  id: 'core' | 'terminal' | 'remoteDesktop' | 'fileManager' | 'agentTools' | 'ollamaLocal' | 'ollamaRemote';
  label: string;
  checks: FeatureReadinessCheckDef[];
}

export const FEATURE_READINESS_MATRIX: FeatureReadinessDef[] = [
  {
    id: 'core',
    label: 'Core Platform',
    checks: [
      { id: 'docker', label: 'Docker CLI', type: 'command', required: true, command: 'docker --version', remediation: 'Install Docker Engine (required for core portal services).' },
      { id: 'compose', label: 'Docker Compose v2', type: 'command', required: true, command: 'docker compose version', remediation: 'Install docker-compose-plugin so compose stacks can start.' },
      { id: 'dockerSock', label: 'Docker socket', type: 'path', required: true, path: '/var/run/docker.sock', remediation: 'Ensure Docker daemon is running and socket is mounted/accessible.' },
    ],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    checks: [
      { id: 'bash', label: 'Bash shell', type: 'command', required: true, command: 'bash --version', remediation: 'Install bash on the host/container image.' },
      { id: 'pty', label: 'node-pty module', type: 'path', required: true, path: process.cwd() + '/node_modules/node-pty', remediation: 'Run backend dependency install to restore node-pty.' },
    ],
  },
  {
    id: 'remoteDesktop',
    label: 'Remote Desktop',
    checks: [
      {
        id: 'novncPort',
        label: 'Websockify listener on port 6080',
        type: 'command',
        required: true,
        command: 'systemctl is-active --quiet bridges-rd-websockify.service && ss -ltn | grep -q ":6080" && echo "bridges-rd-websockify.service active; port 6080 listening"',
        remediation: 'Ensure bridges-rd-websockify.service is active and listening on 6080. A plain HTTP GET returning 405 from websockify is normal and does not indicate failure.',
      },
      {
        id: 'vncPort',
        label: 'Xtigervnc listener on port 5901',
        type: 'command',
        required: true,
        command: 'systemctl is-active --quiet bridges-rd-xtigervnc.service && ss -ltn | grep -q ":5901" && echo "bridges-rd-xtigervnc.service active; port 5901 listening"',
        remediation: 'Start/restart bridges-rd-xtigervnc.service so the VNC server is listening on 5901.',
      },
      {
        id: 'vncUnit',
        label: 'Xtigervnc systemd unit',
        type: 'path',
        required: false,
        path: '/etc/systemd/system/bridges-rd-xtigervnc.service',
        remediation: 'Re-run remote desktop setup to create bridges-rd-xtigervnc.service.',
      },
      {
        id: 'websockifyUnit',
        label: 'Websockify systemd unit',
        type: 'path',
        required: false,
        path: '/etc/systemd/system/bridges-rd-websockify.service',
        remediation: 'Re-run remote desktop setup to create bridges-rd-websockify.service.',
      },
    ],
  },
  {
    id: 'fileManager',
    label: 'File Manager',
    checks: [
      { id: 'uploadDir', label: 'Upload directory', type: 'path', required: true, path: config.uploadDir, remediation: `Create and mount upload dir (${config.uploadDir}) for file operations.` },
    ],
  },
  {
    id: 'agentTools',
    label: 'Agent Tools',
    checks: [
      { id: 'openclaw', label: 'OpenClaw CLI', type: 'command', required: true, command: 'openclaw --version', remediation: 'Install OpenClaw CLI to enable built-in agent runner features.' },
      { id: 'codex', label: 'Codex CLI', type: 'command', required: false, command: 'codex --version', remediation: 'Install Codex CLI or configure another runner in Settings → Agent Runners.' },
      { id: 'claude', label: 'Claude CLI', type: 'command', required: false, command: 'claude --version', remediation: 'Install Claude Code CLI or configure another runner in Settings → Agent Runners.' },
    ],
  },
  {
    id: 'ollamaLocal',
    label: 'Ollama (Local)',
    checks: [
      { id: 'ollamaBinary', label: 'Ollama binary', type: 'command', required: true, command: 'ollama --version', remediation: 'Install Ollama for local model execution.' },
      { id: 'ollamaLocalApi', label: 'Local Ollama API', type: 'http', required: true, url: 'http://localhost:11434/api/tags', timeoutMs: 2000, remediation: 'Start Ollama service (`ollama serve`) and verify localhost access.' },
    ],
  },
  {
    id: 'ollamaRemote',
    label: 'Ollama (Remote)',
    checks: [
      { id: 'ollamaRemoteApi', label: 'Configured Ollama API URL', type: 'http', required: false, url: `${config.ollamaApiUrl.replace(/\/$/, '')}/api/tags`, timeoutMs: 2500, remediation: 'Set ollama.remoteHost in Settings to a reachable remote endpoint.' },
    ],
  },
];

export interface ReadinessCheckResult {
  id: string;
  label: string;
  type: ReadinessCheckType;
  required: boolean;
  ok: boolean;
  message: string;
  remediation: string;
}

export interface FeatureReadinessResult {
  id: FeatureReadinessDef['id'];
  label: string;
  status: ReadinessStatus;
  checks: ReadinessCheckResult[];
}

function runCommand(command: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: 3000, shell: '/bin/bash' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, message: (stderr || error.message || 'Command failed').trim() || 'Command failed' });
        return;
      }
      resolve({ ok: true, message: (stdout || stderr || 'Command ok').trim().split('\n')[0] || 'Command ok' });
    });
  });
}

async function evaluateCheck(check: FeatureReadinessCheckDef): Promise<ReadinessCheckResult> {
  if (check.type === 'command' && check.command) {
    const result = await runCommand(check.command);
    return { ...check, ok: result.ok, message: result.message };
  }

  if (check.type === 'path' && check.path) {
    const exists = fs.existsSync(check.path);
    return { ...check, ok: exists, message: exists ? `Path exists: ${check.path}` : `Path missing: ${check.path}` };
  }

  if (check.type === 'http' && check.url) {
    try {
      const response = await axios.get(check.url, { timeout: check.timeoutMs ?? 2500, validateStatus: () => true });
      const ok = response.status >= 200 && response.status < 400;
      return { ...check, ok, message: `HTTP ${response.status} from ${check.url}` };
    } catch (error: any) {
      return { ...check, ok: false, message: error?.message || `Unable to reach ${check.url}` };
    }
  }

  if (check.type === 'config') {
    const raw = (check.url || '').trim();
    if (!raw) {
      return { ...check, ok: false, message: 'Not configured (value is empty).' };
    }

    if (raw.startsWith('/')) {
      const validRelative = raw.startsWith('/novnc/') || raw === '/novnc';
      return {
        ...check,
        ok: validRelative,
        message: validRelative
          ? `Configured same-origin path: ${raw}`
          : `Configured path ${raw} is not a valid noVNC path (/novnc/...)`,
      };
    }

    try {
      const parsed = new URL(raw);
      const validAbsolute = ['http:', 'https:'].includes(parsed.protocol);
      return {
        ...check,
        ok: validAbsolute,
        message: validAbsolute ? `Configured URL: ${parsed.toString()}` : `Unsupported URL protocol: ${parsed.protocol}`,
      };
    } catch {
      return { ...check, ok: false, message: 'Configured value is not a valid URL.' };
    }
  }

  return { ...check, ok: false, message: 'Check misconfigured in readiness matrix.' };
}

function summarizeFeature(checks: ReadinessCheckResult[]): ReadinessStatus {
  const requiredChecks = checks.filter((c) => c.required);
  const optionalChecks = checks.filter((c) => !c.required);

  const requiredMissing = requiredChecks.some((c) => !c.ok);
  const requiredReady = requiredChecks.length === 0 || requiredChecks.every((c) => c.ok);
  const optionalReady = optionalChecks.every((c) => c.ok);

  if (requiredReady && optionalReady) return 'ready';
  if (requiredMissing) return checks.some((c) => c.ok) ? 'partial' : 'missing';
  return 'partial';
}

export async function buildFeatureReadinessReport(extraSettings?: Record<string, string>) {
  const matrix: FeatureReadinessDef[] = FEATURE_READINESS_MATRIX.map((feature) => {
    if (feature.id === 'remoteDesktop') {
      const url = (extraSettings?.['remoteDesktop.url'] || '').trim();
      const dynamicChecks = [...feature.checks];
      dynamicChecks.unshift({
        id: 'remoteDesktopUrl',
        label: 'Remote Desktop URL configured',
        type: 'config',
        required: true,
        url,
        remediation: 'Set remoteDesktop.url in Settings → System so Desktop can connect (default: /novnc/vnc_portal.html?reconnect=1&resize=remote&path=novnc/websockify).',
      });
      return { ...feature, checks: dynamicChecks };
    }

    if (feature.id === 'ollamaRemote') {
      const remoteHost = (extraSettings?.['ollama.remoteHost'] || '').trim().replace(/\/$/, '');
      const remoteChecks = feature.checks.map((check) =>
        check.id === 'ollamaRemoteApi'
          ? { ...check, url: remoteHost ? `${remoteHost}/api/tags` : '' }
          : check,
      );
      return { ...feature, checks: remoteChecks };
    }

    return feature;
  });

  const features: FeatureReadinessResult[] = [];

  for (const feature of matrix) {
    const checks = await Promise.all(feature.checks.map(async (check) => {
            if (feature.id === 'ollamaRemote' && check.id === 'ollamaRemoteApi' && !check.url) {
        return { ...check, ok: false, message: 'Not configured (ollama.remoteHost is empty).' };
      }
      return evaluateCheck(check);
    }));

    features.push({ id: feature.id, label: feature.label, status: summarizeFeature(checks), checks });
  }

  const overall = features.every((f) => f.status === 'ready')
    ? 'ready'
    : features.some((f) => f.status === 'ready' || f.status === 'partial')
      ? 'partial'
      : 'missing';

  const suggestedNextActions = features
    .flatMap((feature) => feature.checks
      .filter((check) => !check.ok)
      .slice(0, 2)
      .map((check) => `${feature.label}: ${check.remediation}`))
    .slice(0, 8);

  return { overall, features, suggestedNextActions };
}
