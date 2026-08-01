import { ANTIGRAVITY_NO_UPDATE_ENV, PORTAL_TOOL_VERSIONS } from './toolVersions';

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

export const FFMPEG_INSTALL_COMMAND =
  'command -v apt-get >/dev/null 2>&1 && apt-get -o DPkg::Lock::Timeout=300 update -qq && DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq ffmpeg';

export const SAFE_INSTALL_ALLOWLIST = new Set<string>([
  `command -v npm >/dev/null 2>&1 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${PORTAL_TOOL_VERSIONS.claudeCode}`,
  `command -v npm >/dev/null 2>&1 && npm install -g --no-audit --no-fund @openai/codex@${PORTAL_TOOL_VERSIONS.codexCli}`,
  'bash /opt/bridgesllm/portal/installer/grok-build-runtime.sh converge',
  'bash /opt/bridgesllm/portal/installer/antigravity-runtime.sh converge',
  FFMPEG_INSTALL_COMMAND,
]);

export const TOOL_ADAPTERS: ToolAdapter[] = [
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Primary local orchestration CLI for agents, sessions, and gateway control.',
    detect: { command: 'openclaw --version' },
    // OpenClaw is an atomic core/plugin compatibility pair owned by the Portal
    // installer. Generic one-click installation would bypass rollback and the
    // exact package/readiness gates.
    install: [],
    commands: [
      { label: 'OpenClaw TUI', command: 'openclaw tui', description: 'Launch interactive OpenClaw TUI.' },
      { label: 'OpenClaw Status', command: 'openclaw status', description: 'Show gateway/health status.' },
      { label: 'Gateway Status', command: '/usr/bin/systemctl status --no-pager openclaw-gateway.service', description: 'Check the Portal-owned gateway service.' },
      { label: 'Start Gateway', command: '/usr/bin/systemctl start openclaw-gateway.service', description: 'Start the Portal-owned gateway service.' },
      { label: 'Version Check', command: 'openclaw --version', description: 'Verify installed version.' },
    ],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic CLI coding agent for interactive coding sessions.',
    detect: { command: 'claude --version' },
    install: [
      {
        label: 'Install Claude Code globally',
        command: `command -v npm >/dev/null 2>&1 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${PORTAL_TOOL_VERSIONS.claudeCode}`,
        description: `Install the Portal-tested Claude Code ${PORTAL_TOOL_VERSIONS.claudeCode} release.`,
      },
    ],
    commands: [
      { label: 'Claude (new session)', command: 'claude', description: 'Start Claude Code session.' },
      { label: 'Claude Continue', command: 'claude --continue', description: 'Continue recent session.' },
      { label: 'Claude Resume', command: 'claude --resume', description: 'Resume a paused session.' },
      { label: 'Version Check', command: 'claude --version', description: 'Verify installed version.' },
    ],
    authRequired: true,
    authHint: "Run 'claude' first time to authenticate via browser",
    tier: 1,
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    description: 'OpenAI CLI coding agent for autonomous and supervised tasks.',
    detect: { command: 'codex --version' },
    install: [
      {
        label: 'Install Codex globally',
        command: `command -v npm >/dev/null 2>&1 && npm install -g --no-audit --no-fund @openai/codex@${PORTAL_TOOL_VERSIONS.codexCli}`,
        description: `Install the Portal-tested Codex CLI ${PORTAL_TOOL_VERSIONS.codexCli} release.`,
      },
    ],
    commands: [
      { label: 'Codex (interactive)', command: 'codex', description: 'Start Codex session.' },
      { label: 'Codex Workspace Session', command: 'codex --sandbox workspace-write --ask-for-approval on-request', description: 'Run with workspace-only writes and supervised escalation.' },
      { label: 'Codex Resume Latest', command: 'codex resume --last', description: 'Resume the most recent Codex session.' },
      { label: 'Version Check', command: 'codex --version', description: 'Verify installed version.' },
    ],
    authRequired: true,
    authHint: 'Requires OPENAI_API_KEY or OAuth auth',
    tier: 1,
  },

  {
    id: 'grok-build',
    name: 'Grok Build',
    description: 'xAI native coding agent with subscription OAuth and API-key support.',
    detect: { command: 'GROK_DISABLE_AUTOUPDATER=1 grok --no-auto-update --version' },
    install: [
      {
        label: 'Install the Portal-tested Grok Build CLI',
        command: 'bash /opt/bridgesllm/portal/installer/grok-build-runtime.sh converge',
        description: 'Install the exact checksum-verified Portal release with automatic rollback on verification failure.',
      },
    ],
    commands: [
      { label: 'Grok Build (interactive)', command: 'GROK_DISABLE_AUTOUPDATER=1 grok --no-auto-update', description: 'Start an interactive Grok Build session without changing the Portal-tested binary.' },
      { label: 'Grok Build Device Login', command: 'GROK_DISABLE_AUTOUPDATER=1 grok --no-auto-update login --device-auth', description: 'Authenticate a headless server with xAI.' },
      { label: 'List Models', command: 'GROK_DISABLE_AUTOUPDATER=1 grok --no-auto-update models', description: 'List models available to the signed-in account.' },
      { label: 'Version Check', command: 'GROK_DISABLE_AUTOUPDATER=1 grok --no-auto-update --version', description: 'Verify the installed pinned version.' },
    ],
    authRequired: true,
    authHint: "Run 'grok --no-auto-update login --device-auth' or use the Portal native Grok login flow. OpenClaw xAI auth is separate.",
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
    description: 'Managed Agent Zero v2.5 runtime. The provider stays disabled until its host and project trust gates are proven.',
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
    description: 'Google Antigravity CLI for native AI coding and generation sessions.',
    detect: { command: `${ANTIGRAVITY_NO_UPDATE_ENV} agy --version` },
    install: [
      {
        label: 'Install the Portal-tested Google Antigravity CLI',
        command: 'bash /opt/bridgesllm/portal/installer/antigravity-runtime.sh converge',
        description: `Install checksum-verified Antigravity ${PORTAL_TOOL_VERSIONS.antigravity} with automatic rollback.`,
      },
    ],
    commands: [
      { label: 'Antigravity (interactive)', command: `${ANTIGRAVITY_NO_UPDATE_ENV} agy`, description: 'Start interactive Antigravity without replacing the Portal-tested binary.' },
      { label: 'Antigravity Print', command: `${ANTIGRAVITY_NO_UPDATE_ENV} agy --print "Say hello briefly"`, description: 'Run a one-shot Antigravity task.' },
      { label: 'List Models', command: `${ANTIGRAVITY_NO_UPDATE_ENV} agy models`, description: 'Verify Google sign-in and list available models.' },
      { label: 'Version Check', command: `${ANTIGRAVITY_NO_UPDATE_ENV} agy --version`, description: 'Verify the installed pinned version.' },
    ],
    authRequired: true,
    authHint: "Run 'agy' first time to authenticate with Google, or use the portal native Antigravity login flow.",
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
