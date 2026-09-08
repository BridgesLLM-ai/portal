import { unqualifiedNativeBinaryReason } from './unqualifiedNativeBinaryLane';

export type ToolTier = 1 | 2;

export type ToolCommandPreset = {
  label: string;
  command: string;
  description?: string;
  cwd?: string;
};

export type ToolInstallStep = {
  label: string;
  command: string;
  description?: string;
};

export type ToolAdapter = {
  id: string;
  name: string;
  description: string;
  detect?: {
    command: string;
    timeoutMs?: number;
  };
  install: ToolInstallStep[];
  commands: ToolCommandPreset[];
  authRequired: boolean;
  authHint?: string;
  tier: ToolTier;
};

export const HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE = Object.freeze({
  status: 503,
  code: 'HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE',
  error: 'Per-tool native host runtime changes are unavailable. Portal-qualified tools are updated only as one compatibility bundle.',
  retryable: false,
  remediation: 'Owner: use Admin > Maintenance > Update Compatible AI Tools for the exact OpenClaw, Codex, Claude Code, and ClawHub bundle. Do not update individual tools independently.',
} as const);

export const HOST_NATIVE_AGENT_TOOL_IDS = Object.freeze(new Set([
  'agent-zero',
  'antigravity',
  'claude-code',
  'codex',
  'gemini',
  'grok-build',
  'hermes',
  'opencode',
]));

export const FFMPEG_INSTALL_COMMAND =
  'command -v apt-get >/dev/null 2>&1 && apt-get -o DPkg::Lock::Timeout=300 update -qq && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq ffmpeg';

export const SAFE_INSTALL_ALLOWLIST = new Set<string>([
  FFMPEG_INSTALL_COMMAND,
]);

export const TOOL_ADAPTERS: ToolAdapter[] = [
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Portal-owned orchestration runtime. Agent Chat uses the durable Gateway run journal; Owner updates it only with the exact compatibility bundle under Admin > Maintenance.',
    detect: { command: 'openclaw --version' },
    // OpenClaw is an atomic core/plugin compatibility pair owned by the Portal
    // installer. Generic one-click installation would bypass rollback and the
    // exact package/readiness gates.
    install: [],
    commands: [],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Root-owned, hash-admitted Claude Code runtime for Portal Agent Chat. Owner updates it only with the exact compatibility bundle under Admin > Maintenance.',
    install: [],
    commands: [],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    description: 'Root-owned, hash-admitted Codex runtime for Portal Agent Chat. Owner updates it only with the exact compatibility bundle under Admin > Maintenance.',
    install: [],
    commands: [],
    authRequired: false,
    tier: 1,
  },

  {
    id: 'grok-build',
    name: 'Grok Build',
    description: unqualifiedNativeBinaryReason('GROK'),
    detect: { command: "test -x /usr/local/bin/grok && printf '%s\\n' detected" },
    install: [],
    commands: [],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local Ollama runtime management. Pair an external GPU separately through the Owner-only Tailnet wizard.',
    detect: {
      // Ollama 0.32.3+ panics on a missing $HOME, so the isolated probe must
      // still carry one alongside the fixed loopback endpoint.
      command: '/usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME="${HOME:-/root}" LANG=C LC_ALL=C OLLAMA_HOST=http://127.0.0.1:11434 timeout 2s ollama --version',
    },
    // Ollama upgrades require service restart plus client/server version and
    // model-readiness checks. Keep them in the dedicated setup/updater flow;
    // the generic recipe runner cannot prove that transaction safely.
    install: [],
    commands: [
      { label: 'List Models', command: 'env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy NO_PROXY="*" no_proxy="*" OLLAMA_HOST=http://127.0.0.1:11434 ollama list', description: 'List locally installed Ollama models without inherited proxy routing.' },
      { label: 'Start Server', command: 'env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy NO_PROXY="*" no_proxy="*" OLLAMA_HOST=http://127.0.0.1:11434 ollama serve', description: 'Start the loopback-only local Ollama API server.' },
      { label: 'Pull Model', command: 'env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy NO_PROXY="*" no_proxy="*" OLLAMA_HOST=http://127.0.0.1:11434 ollama pull <model>', description: 'Download a model to the local Ollama runtime by tag.' },
    ],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'agent-zero',
    name: 'Agent Zero',
    description: 'Managed Agent Zero v2.10 runtime. The provider stays disabled until its host and project trust gates are proven.',
    detect: {
      command: 'bash /opt/bridgesllm/portal/installer/agent-zero-runtime.sh status',
      timeoutMs: 20_000,
    },
    // Installation is intentionally unavailable from the generic one-click
    // runner. Agent Zero requires a root-owned mode-600 authentication file
    // and a supervised lifecycle transaction; setup UI will drive that path.
    install: [],
    commands: [
      { label: 'Managed Runtime Status', command: 'bash /opt/bridgesllm/portal/installer/agent-zero-runtime.sh status', description: 'Verify image pin, loopback binding, storage, authentication, and connector readiness.' },
      { label: 'Container Logs', command: 'docker logs --tail 100 bridgesllm-agent-zero', description: 'Inspect recent managed Agent Zero logs.' },
    ],
    authRequired: true,
    authHint: 'Agent Zero setup requires protected server-side credentials before the managed runtime can be installed.',
    tier: 1,
  },
  {
    id: 'gemini',
    name: 'Google Antigravity',
    description: unqualifiedNativeBinaryReason('GEMINI'),
    detect: { command: "test -x /usr/local/bin/agy && printf '%s\\n' detected" },
    install: [],
    commands: [],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'ffmpeg',
    name: 'Media Processing (FFmpeg)',
    description: 'Required host media tools for validating, cropping, and preserving animated GIF uploads.',
    detect: {
      command: 'ffmpeg -version >/dev/null 2>&1 && ffprobe -version | head -n 1',
    },
    install: [
      {
        label: 'Install FFmpeg and FFprobe',
        command: FFMPEG_INSTALL_COMMAND,
        description: 'Install the Ubuntu/Debian FFmpeg package used by every animated GIF upload surface.',
      },
    ],
    commands: [
      {
        label: 'Verify FFmpeg',
        command: 'ffmpeg -version && ffprobe -version',
        description: 'Verify both required media executables.',
      },
    ],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'shell',
    name: 'Generic Shell',
    description: 'Fallback shell adapter for free-form command execution.',
    install: [],
    commands: [
      { label: 'Shell Command', command: '', description: 'Type any shell command manually.' },
    ],
    authRequired: false,
    tier: 2,
  },
];

export function getToolAdapter(toolId: string): ToolAdapter | undefined {
  return TOOL_ADAPTERS.find((adapter) => adapter.id === toolId);
}

export function isInstallCommandAllowed(command: string): boolean {
  return SAFE_INSTALL_ALLOWLIST.has(command.trim());
}
