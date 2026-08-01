import fs from 'fs';
import { exec, execFile } from 'child_process';
import axios from 'axios';
import { config } from './env';
import { PORTAL_TOOL_VERSIONS } from './toolVersions';
import { PRIVILEGED_CONFIRMATION } from '../utils/privilegedConfirmation';
import {
  OllamaBackendAuthorityError,
  requestResolvedOllama,
  resolveOllamaBackendAuthority,
  type OllamaBackendAuthority,
  type ResolvedOllamaBackendAuthority,
} from '../services/ollamaBackendAuthority';
import { PROJECT_RUNTIME_AUTHORIZATION_POLICY } from '../services/projectRuntimeAuthorizationPolicy';

export type ReadinessStatus = 'ready' | 'partial' | 'missing' | 'not_configured';
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
  // Portal-tested pin verification: the check fails when the
  // installed binary's version has drifted from the pin, so a self-updated
  // CLI can never silently falsify the tested-version claim.
  pinnedCli?: {
    binary: string;
    args: string[];
    tested: string;
    env?: Record<string, string>;
  };
}

export interface FeatureReadinessDef {
  id: 'core' | 'terminal' | 'remoteDesktop' | 'fileManager' | 'agentTools' | 'authorizationTransitions' | 'ollamaLocal' | 'ollamaRemote';
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
        label: 'Websockify listener on loopback port 6080',
        type: 'command',
        required: true,
        command: 'systemctl is-active --quiet bridges-rd-websockify.service && ss -ltn | grep -q "127.0.0.1:6080" && echo "bridges-rd-websockify.service active; 127.0.0.1:6080 listening"',
        remediation: 'Ensure bridges-rd-websockify.service is active and bound to 127.0.0.1:6080 only. Raw websockify must never listen on a public interface because portal auth is the intended security boundary.',
      },
      {
        id: 'vncPort',
        label: 'Usable supervised XFCE session on loopback VNC port 5901',
        type: 'command',
        required: true,
        // One physical line: the executor hands this to `bash -c`, where an
        // embedded newline ends the command and a continuation starting with
        // `&&` is a syntax error the operator then sees as the check result.
        command: `systemctl is-active --quiet bridges-rd-xtigervnc.service && test -x /usr/local/bin/bridges-rd-session-guard.sh && /usr/local/bin/bridges-rd-session-guard.sh check && ss -H -ltn 'sport = :5901' | awk '{print $4}' | grep -Eq '^(127\\.0\\.0\\.1|\\[::1\\]|::1):5901$' && ! ss -H -ltn 'sport = :5901' | awk '{print $4}' | grep -Ev '^(127\\.0\\.0\\.1|\\[::1\\]|::1):5901$' && echo "bridges-rd-xtigervnc.service active; semantic XFCE policy healthy; loopback VNC listening"`,
        remediation: 'Run Remote Desktop recovery so the signed session guard can repair or restart the real XFCE session. A reachable VNC socket alone is not considered ready.',
      },
      {
        id: 'automaticRecovery',
        label: 'Out-of-process Remote Desktop health recovery',
        type: 'command',
        required: true,
        command: 'systemctl is-active --quiet bridges-rd-healthcheck.timer && test -x /usr/local/bin/bridges-rd-healthcheck.sh && echo "bridges-rd-healthcheck.timer active; automatic recovery installed"',
        remediation: 'Re-run Remote Desktop setup or confirmed recovery to install and enable the signed, rate-limited healthcheck timer.',
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
      {
        id: 'sharedChromeLauncher',
        label: 'Shared Chrome launcher script',
        type: 'path',
        required: false,
        path: '/usr/local/bin/bridges-rd-shared-chrome.sh',
        remediation: 'Re-run remote desktop setup to create the shared Chrome launcher used by the agent and user inside Remote Desktop.',
      },
      {
        id: 'sharedChromeDesktopEntry',
        label: 'Shared Browser desktop entry',
        type: 'path',
        required: false,
        path: '/home/bridgesrd/Desktop/Shared Chrome.desktop',
        remediation: 'Re-run remote desktop setup to create the Shared Browser desktop shortcut for the remote desktop user.',
      },
      {
        id: 'openclawUiLauncher',
        label: 'OpenClaw Web UI launcher script',
        type: 'path',
        required: false,
        path: '/usr/local/bin/bridges-rd-openclaw-ui.sh',
        remediation: 'Re-run remote desktop setup to create the dedicated OpenClaw Web UI launcher.',
      },
      {
        id: 'openclawUiDesktopEntry',
        label: 'OpenClaw Web UI desktop entry',
        type: 'path',
        required: false,
        path: '/home/bridgesrd/Desktop/OpenClaw Web UI.desktop',
        remediation: 'Re-run remote desktop setup to create the OpenClaw Web UI desktop shortcut for the remote desktop user.',
      },
      {
        id: 'aiProviderLaunchers',
        label: 'AI runtime desktop launchers',
        type: 'command',
        required: true,
        command: 'test -x /usr/local/bin/bridges-rd-ai-launchers.sh && /usr/local/bin/bridges-rd-ai-launchers.sh verify',
        remediation: 'Re-run Remote Desktop setup to provision truthful Claude Code, Codex, Grok Build, Antigravity, Ollama, and Agent Zero (web UI) runtime launchers. The Agent Zero icon opens its web UI signed in through a click-time backend session exchange; it appears once the managed Agent Zero runtime is installed.',
      },
      {
        id: 'openclawUiDashboardUrl',
        label: 'OpenClaw Web UI tokenized dashboard URL',
        type: 'path',
        required: false,
        path: '/home/bridgesrd/.config/openclaw-control-ui-browser/dashboard-url',
        remediation: 'Re-run remote desktop setup to write the tokenized OpenClaw Control UI URL used by the desktop launcher.',
      },
      {
        id: 'sharedChromeBinary',
        label: 'Chrome/Chromium binary',
        type: 'command',
        required: true,
        command: 'command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium',
        remediation: 'Install Google Chrome or Chromium so the shared desktop browser can be launched and attached by OpenClaw.',
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
      {
        id: 'codex',
        label: 'Codex CLI (Portal-tested pin)',
        type: 'command',
        required: false,
        command: 'codex --version',
        pinnedCli: { binary: 'codex', args: ['--version'], tested: PORTAL_TOOL_VERSIONS.codexCli },
        remediation: 'Run the Portal update (or the installer with --maintain-tools) to converge Codex CLI to the Portal-tested version, or configure another runner in Settings → Agent Runners.',
      },
      {
        id: 'claude',
        label: 'Claude Code CLI (Portal-tested pin)',
        type: 'command',
        required: false,
        command: 'claude --version',
        pinnedCli: { binary: 'claude', args: ['--version'], tested: PORTAL_TOOL_VERSIONS.claudeCode },
        remediation: 'Run the Portal update (or the installer with --maintain-tools) to converge Claude Code to the Portal-tested version, or configure another runner in Settings → Agent Runners.',
      },
      {
        id: 'antigravity',
        label: 'Antigravity CLI (Portal-tested pin)',
        type: 'command',
        required: false,
        command: 'agy --version',
        pinnedCli: {
          binary: 'agy',
          args: ['--version'],
          tested: PORTAL_TOOL_VERSIONS.antigravity,
          // The probe itself must never trigger the vendor self-updater.
          env: { AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
        },
        remediation: 'Run the Portal update (or the installer with --maintain-tools) to reconverge the checksum-verified Antigravity release; the vendor CLI self-updates outside installer control.',
      },
      {
        id: 'grokBuild',
        label: 'Grok Build CLI (Portal-tested pin)',
        type: 'command',
        required: false,
        command: 'grok --no-auto-update --version',
        pinnedCli: {
          binary: 'grok',
          args: ['--no-auto-update', '--version'],
          tested: PORTAL_TOOL_VERSIONS.grokBuild,
          env: { GROK_DISABLE_AUTOUPDATER: '1' },
        },
        remediation: 'Run the Portal update (or the installer with --maintain-tools) to reconverge the checksum-verified Grok Build release; drifted versions are refused by the ACP transport.',
      },
    ],
  },
  {
    id: 'authorizationTransitions',
    label: 'Authorization Transition Safety',
    checks: [
      {
        id: 'projectAuthorizationTransitionQuiescence',
        label: 'Durable Project runtime quiescence for authorization changes',
        type: 'config',
        required: true,
        remediation: 'If this check fails, repair the durable authorization-transition journal and provider cleanup runtime before changing roles, account status, workspace scope, or ownership.',
      },
    ],
  },
  {
    id: 'ollamaLocal',
    label: 'Ollama (Local)',
    checks: [
      { id: 'ollamaBinary', label: 'Ollama binary', type: 'command', required: true, command: 'ollama --version', remediation: 'Install Ollama for local model execution.' },
      { id: 'ollamaLocalApi', label: 'Local Ollama API', type: 'http', required: true, url: 'http://127.0.0.1:11434/api/tags', timeoutMs: 2000, remediation: 'Start Ollama service (`ollama serve`) and verify local access.' },
    ],
  },
  {
    id: 'ollamaRemote',
    label: 'Ollama (Tailnet Remote)',
    checks: [
      {
        id: 'ollamaTailnetApi',
        label: 'Identity-bound Tailnet Ollama API',
        type: 'http',
        required: true,
        timeoutMs: 2500,
        remediation: 'Connect or reverify an identity-bound Tailnet Ollama backend in Settings → AI Providers.',
      },
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
  applicable: boolean;
  note?: string;
  checks: ReadinessCheckResult[];
  remediationAction?: {
    id: string;
    label: string;
    /** Absent when no Portal endpoint can perform the fix. */
    endpoint?: string;
    method?: 'POST';
    ownerOnly: true;
    confirmationPhrase?: string;
    /** Shown when the operator must run something outside the Portal. */
    manualCommand?: string;
    impact: string;
  };
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

export function probeLocalOllamaVersion(): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile('ollama', ['--version'], {
      timeout: 3_000,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        // Ollama 0.32.3+ panics when $HOME is undefined; keep the probe
        // otherwise isolated from inherited endpoints and proxies.
        HOME: process.env.HOME || '/root',
        LANG: 'C',
        LC_ALL: 'C',
        OLLAMA_HOST: 'http://127.0.0.1:11434',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, message: (stderr || error.message || 'Command failed').trim() || 'Command failed' });
        return;
      }
      resolve({ ok: true, message: (stdout || stderr || 'Command ok').trim().split('\n')[0] || 'Command ok' });
    });
  });
}

export function probePinnedCliVersion(
  pin: NonNullable<FeatureReadinessCheckDef['pinnedCli']>,
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile(pin.binary, pin.args, {
      timeout: 5_000,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        ...pin.env,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || 'probe failed').trim().split('\n')[0];
        resolve({ ok: false, message: `Could not verify the Portal-tested ${pin.tested}: ${detail}` });
        return;
      }
      const installed = String(stdout || stderr || '')
        .match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] || '';
      if (!installed) {
        resolve({ ok: false, message: `No version reported (Portal-tested ${pin.tested}).` });
        return;
      }
      if (installed === pin.tested) {
        resolve({ ok: true, message: `Portal-tested ${pin.tested} (verified)` });
        return;
      }
      resolve({
        ok: false,
        message: `Installed ${installed} has drifted from the Portal-tested ${pin.tested}.`,
      });
    });
  });
}

export async function evaluateFeatureReadinessCheck(check: FeatureReadinessCheckDef): Promise<ReadinessCheckResult> {
  if (check.id === 'projectAuthorizationTransitionQuiescence') {
    return {
      ...check,
      ok: PROJECT_RUNTIME_AUTHORIZATION_POLICY.ready,
      message: PROJECT_RUNTIME_AUTHORIZATION_POLICY.message,
    };
  }
  if (check.type === 'command' && check.pinnedCli) {
    const result = await probePinnedCliVersion(check.pinnedCli);
    return { ...check, ok: result.ok, message: result.message };
  }
  if (check.type === 'command' && check.command) {
    const result = check.id === 'ollamaBinary'
      ? await probeLocalOllamaVersion()
      : await runCommand(check.command);
    return { ...check, ok: result.ok, message: result.message };
  }

  if (check.type === 'path' && check.path) {
    const exists = fs.existsSync(check.path);
    return { ...check, ok: exists, message: exists ? `Path exists: ${check.path}` : `Path missing: ${check.path}` };
  }

  if (check.type === 'http' && check.url) {
    try {
      const response = await axios.get(check.url, {
        timeout: check.timeoutMs ?? 2500,
        maxRedirects: 0,
        validateStatus: () => true,
      });
      const ok = isSuccessfulReadinessHttpStatus(response.status);
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

export function isSuccessfulReadinessHttpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

export function summarizeFeature(checks: ReadinessCheckResult[]): ReadinessStatus {
  const requiredChecks = checks.filter((c) => c.required);
  if (requiredChecks.length === 0) {
    if (checks.length === 0 || checks.every((check) => check.ok)) return 'ready';
    return checks.some((check) => check.ok) ? 'partial' : 'missing';
  }
  if (requiredChecks.every((check) => check.ok)) return 'ready';
  return checks.some((check) => check.ok) ? 'partial' : 'missing';
}

export interface FeatureReadinessDependencies {
  resolveOllamaAuthorityImpl?: () => Promise<ResolvedOllamaBackendAuthority>;
  requestResolvedOllamaImpl?: typeof requestResolvedOllama;
  probeLocalOllamaVersionImpl?: typeof probeLocalOllamaVersion;
}

const OLLAMA_READINESS_MAX_RESPONSE_BYTES = 1024 * 1024;

function inactiveFeature(
  feature: FeatureReadinessDef,
  note: string,
): FeatureReadinessResult {
  return {
    id: feature.id,
    label: feature.label,
    status: 'not_configured',
    applicable: false,
    note,
    checks: feature.checks.map((check) => ({
      ...check,
      ok: false,
      message: note,
    })),
  };
}

function failedFeature(
  feature: FeatureReadinessDef,
  note: string,
): FeatureReadinessResult {
  return {
    id: feature.id,
    label: feature.label,
    status: 'missing',
    applicable: true,
    note,
    checks: feature.checks.map((check) => ({
      ...check,
      ok: false,
      message: note,
    })),
  };
}

function ollamaProbeFailureMessage(kind: OllamaBackendAuthority['kind']): string {
  return kind === 'TAILNET'
    ? 'The identity-bound Tailnet Ollama backend did not pass readiness verification.'
    : 'The selected local Ollama backend did not pass readiness verification.';
}

async function probeResolvedOllamaAuthority(
  resolved: ResolvedOllamaBackendAuthority,
  check: FeatureReadinessCheckDef,
  requestImpl: typeof requestResolvedOllama,
): Promise<ReadinessCheckResult> {
  try {
    const response = await requestImpl(resolved, {
      path: '/api/tags',
      method: 'GET',
      timeoutMs: check.timeoutMs ?? 2_500,
      maxResponseBytes: OLLAMA_READINESS_MAX_RESPONSE_BYTES,
    });
    try {
      const ok = isSuccessfulReadinessHttpStatus(response.statusCode);
      const backend = resolved.authority.kind === 'TAILNET'
        ? 'Identity-bound Tailnet Ollama API'
        : 'Local Ollama API';
      return {
        ...check,
        ok,
        message: `${backend} responded with HTTP ${response.statusCode}.`,
      };
    } finally {
      response.body.fill(0);
    }
  } catch {
    return {
      ...check,
      ok: false,
      message: ollamaProbeFailureMessage(resolved.authority.kind),
    };
  }
}

export async function buildOllamaFeatureReadiness(
  localFeature: FeatureReadinessDef,
  tailnetFeature: FeatureReadinessDef,
  dependencies: FeatureReadinessDependencies,
): Promise<Readonly<{
  ollamaLocal: FeatureReadinessResult;
  ollamaRemote: FeatureReadinessResult;
}>> {
  const resolveImpl = dependencies.resolveOllamaAuthorityImpl
    ?? resolveOllamaBackendAuthority;
  let resolved: ResolvedOllamaBackendAuthority;
  try {
    resolved = await resolveImpl();
  } catch (error) {
    if (error instanceof OllamaBackendAuthorityError && error.code === 'LOCAL_DISABLED') {
      const note = 'No Ollama backend authority is selected. Enable local Ollama or connect an identity-bound Remote GPU.';
      return {
        ollamaLocal: inactiveFeature(localFeature, note),
        ollamaRemote: inactiveFeature(tailnetFeature, note),
      };
    }
    if (
      error instanceof OllamaBackendAuthorityError
      && ['REMOTE_DISCONNECTED', 'BINDING_INVALID'].includes(error.code)
    ) {
      const note = error.code === 'REMOTE_DISCONNECTED'
        ? 'The identity-bound Tailnet Ollama backend is disconnected and must be reverified.'
        : 'The identity-bound Tailnet Ollama backend configuration is incomplete.';
      return {
        ollamaLocal: inactiveFeature(
          localFeature,
          'An identity-bound Tailnet Ollama backend is configured; local Ollama is not probed.',
        ),
        ollamaRemote: failedFeature(tailnetFeature, note),
      };
    }
    const note = 'Portal could not resolve the selected Ollama backend authority.';
    return {
      ollamaLocal: failedFeature(localFeature, note),
      ollamaRemote: failedFeature(tailnetFeature, note),
    };
  }

  if (resolved.authority.kind === 'TAILNET') {
    const check = tailnetFeature.checks[0];
    const checks = check
      ? [await probeResolvedOllamaAuthority(
        resolved,
        check,
        dependencies.requestResolvedOllamaImpl ?? requestResolvedOllama,
      )]
      : [];
    return {
      ollamaLocal: inactiveFeature(
        localFeature,
        'An identity-bound Tailnet Ollama backend is selected; local Ollama is not probed.',
      ),
      ollamaRemote: {
        id: tailnetFeature.id,
        label: tailnetFeature.label,
        status: summarizeFeature(checks),
        applicable: true,
        note: 'The selected backend is verified through its identity-bound private Tailscale Serve route.',
        checks,
      },
    };
  }

  const [binaryCheck, apiCheck] = await Promise.all([
    (async (): Promise<ReadinessCheckResult | null> => {
      const check = localFeature.checks.find((candidate) => candidate.id === 'ollamaBinary');
      if (!check) return null;
      const result = await (
        dependencies.probeLocalOllamaVersionImpl
        ?? probeLocalOllamaVersion
      )();
      return { ...check, ok: result.ok, message: result.message };
    })(),
    (async (): Promise<ReadinessCheckResult | null> => {
      const check = localFeature.checks.find((candidate) => candidate.id === 'ollamaLocalApi');
      if (!check) return null;
      return probeResolvedOllamaAuthority(
        resolved,
        check,
        dependencies.requestResolvedOllamaImpl ?? requestResolvedOllama,
      );
    })(),
  ]);
  const checks = [binaryCheck, apiCheck].filter(
    (check): check is ReadinessCheckResult => check !== null,
  );
  return {
    ollamaLocal: {
      id: localFeature.id,
      label: localFeature.label,
      status: summarizeFeature(checks),
      applicable: true,
      note: 'The selected backend is the fixed loopback Ollama authority.',
      checks,
    },
    ollamaRemote: inactiveFeature(
      tailnetFeature,
      'Local Ollama is selected; no Tailnet backend is probed.',
    ),
  };
}

export async function buildFeatureReadinessReport(
  extraSettings?: Record<string, string>,
  dependencies: FeatureReadinessDependencies = {},
) {
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
        remediation: 'Set remoteDesktop.url in Settings → System so Desktop can connect (default: /novnc/vnc_portal.html?reconnect=1&resize=smart).',
      });
      return { ...feature, checks: dynamicChecks };
    }

    return feature;
  });

  const localOllamaFeature = matrix.find((feature) => feature.id === 'ollamaLocal');
  const tailnetOllamaFeature = matrix.find((feature) => feature.id === 'ollamaRemote');
  if (!localOllamaFeature || !tailnetOllamaFeature) {
    throw new Error('Ollama readiness definitions are missing.');
  }
  const ollamaReadiness = buildOllamaFeatureReadiness(
    localOllamaFeature,
    tailnetOllamaFeature,
    dependencies,
  );
  const features: FeatureReadinessResult[] = await Promise.all(matrix.map(async (feature) => {
    if (feature.id === 'ollamaLocal' || feature.id === 'ollamaRemote') {
      return (await ollamaReadiness)[feature.id];
    }

    const checks = await Promise.all(feature.checks.map((check) => evaluateFeatureReadinessCheck(check)));
    const status = summarizeFeature(checks);
    const result: FeatureReadinessResult = {
      id: feature.id,
      label: feature.label,
      status,
      applicable: true,
      checks,
    };
    if (feature.id === 'remoteDesktop' && status !== 'ready') {
      // A launcher blocked by a drifted runtime binary is not fixable by
      // re-running setup: tool versions converge only on a fresh install, an
      // installer --maintain-tools run, or an explicit maintenance action.
      // Offering setup here sent operators through sixty-one steps that ended
      // in the same warning and changed nothing.
      const driftBlocked = checks.some((check) => (
        check.ok === false && /runtime binary .* failed its Portal/i.test(String(check.message || ''))
      ));
      if (driftBlocked) {
        result.remediationAction = {
          id: 'converge-portal-tested-tools',
          label: 'Reconverge Portal-tested runtimes',
          ownerOnly: true,
          manualCommand: 'bash install.sh --update --maintain-tools',
          impact: 'A runtime binary drifted from the version this Portal pins. Re-running Remote Desktop setup cannot change it; converge the tools, then Remote Desktop becomes ready on its own.',
        };
      } else {
        result.remediationAction = {
          id: 'remote-desktop-auto-setup',
          label: 'Set up Remote Desktop',
          endpoint: '/remote-desktop/auto-setup',
          method: 'POST',
          ownerOnly: true,
          confirmationPhrase: PRIVILEGED_CONFIRMATION.remoteDesktopSetup,
          impact: 'Installs host packages, writes systemd services and desktop launchers, and restarts Remote Desktop services.',
        };
      }
    }
    return result;
  }));

  const applicableFeatures = features.filter((feature) => feature.applicable);
  const overall = applicableFeatures.every((f) => f.status === 'ready')
    ? 'ready'
    : applicableFeatures.some((f) => f.status === 'ready' || f.status === 'partial')
      ? 'partial'
      : 'missing';

  const suggestedNextActions = features
    .filter((feature) => feature.applicable)
    .flatMap((feature) => feature.checks
      .filter((check) => check.required && !check.ok)
      .slice(0, 2)
      .map((check) => `${feature.label}: ${check.remediation}`))
    .slice(0, 8);

  return { overall, features, suggestedNextActions };
}
