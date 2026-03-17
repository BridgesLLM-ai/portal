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
  };
  install: ToolInstallStep[];
  commands: ToolCommandPreset[];
  authRequired: boolean;
  authHint?: string;
  tier: ToolTier;
};

export const SAFE_INSTALL_ALLOWLIST = new Set<string>([
  'command -v npm >/dev/null 2>&1 || { echo "npm is required. Install Node.js/npm and retry."; exit 1; }',
  'npm list -g --depth=0 openclaw >/dev/null 2>&1 && echo "openclaw already installed" || npm install -g openclaw',
  'command -v npm >/dev/null 2>&1 && npm install -g @anthropic-ai/claude-code',
  'command -v npm >/dev/null 2>&1 && npm install -g @openai/codex',
  'curl -fsSL https://ollama.ai/install.sh | sh',
  'docker pull agent0ai/agent-zero && docker run -d -p 50001:80 --name agent-zero --restart unless-stopped agent0ai/agent-zero',
  'command -v npm >/dev/null 2>&1 && npm install -g @google/gemini-cli',
]);

export const TOOL_ADAPTERS: ToolAdapter[] = [
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Primary local orchestration CLI for agents, sessions, and gateway control.',
    detect: { command: 'openclaw --version' },
    install: [
      {
        label: 'Verify npm is available',
        command: 'command -v npm >/dev/null 2>&1 || { echo "npm is required. Install Node.js/npm and retry."; exit 1; }',
      },
      {
        label: 'Install OpenClaw globally (or keep existing install)',
        command: 'npm list -g --depth=0 openclaw >/dev/null 2>&1 && echo "openclaw already installed" || npm install -g openclaw',
      },
    ],
    commands: [
      { label: 'OpenClaw TUI', command: 'openclaw tui', description: 'Launch interactive OpenClaw TUI.' },
      { label: 'OpenClaw Status', command: 'openclaw status', description: 'Show gateway/health status.' },
      { label: 'Gateway Status', command: 'openclaw gateway status', description: 'Check gateway daemon status.' },
      { label: 'Start Gateway', command: 'openclaw gateway start', description: 'Start gateway daemon.' },
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
        command: 'command -v npm >/dev/null 2>&1 && npm install -g @anthropic-ai/claude-code',
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
        command: 'command -v npm >/dev/null 2>&1 && npm install -g @openai/codex',
      },
    ],
    commands: [
      { label: 'Codex (interactive)', command: 'codex', description: 'Start Codex session.' },
      { label: 'Codex Full Auto', command: 'codex --approval-mode full-auto', description: 'Run in full-auto approval mode.' },
      { label: 'Version Check', command: 'codex --version', description: 'Verify installed version.' },
    ],
    authRequired: true,
    authHint: 'Requires OPENAI_API_KEY or OAuth auth',
    tier: 1,
  },

  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local LLM runtime for offline and remote (Tailscale) model serving.',
    detect: { command: 'ollama --version' },
    install: [
      {
        label: 'Install Ollama',
        command: 'curl -fsSL https://ollama.ai/install.sh | sh',
      },
    ],
    commands: [
      { label: 'List Models', command: 'ollama list', description: 'List installed Ollama models.' },
      { label: 'Start Server', command: 'ollama serve', description: 'Start local Ollama API server.' },
      { label: 'Pull Model', command: 'ollama pull <model>', description: 'Download a model by tag.' },
    ],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'agent-zero',
    name: 'Agent Zero',
    description: 'Autonomous AI agent framework running in Docker with web UI.',
    detect: { command: 'docker ps --filter ancestor=agent0ai/agent-zero --format \'{{.Status}}\' 2>/dev/null | head -1' },
    install: [
      {
        label: 'Pull and start Agent Zero container',
        command: 'docker pull agent0ai/agent-zero && docker run -d -p 50001:80 --name agent-zero --restart unless-stopped agent0ai/agent-zero',
      },
    ],
    commands: [
      { label: 'Open Web UI', command: 'echo "Agent Zero UI: http://localhost:50001"', description: 'Open Agent Zero web interface.' },
      { label: 'Start Container', command: 'docker start agent-zero', description: 'Start the Agent Zero container.' },
      { label: 'Stop Container', command: 'docker stop agent-zero', description: 'Stop the Agent Zero container.' },
      { label: 'Container Status', command: 'docker ps --filter name=agent-zero --format "table {{.Status}}\t{{.Ports}}"', description: 'Check container status.' },
    ],
    authRequired: false,
    tier: 1,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI for interactive AI coding and generation sessions.',
    detect: { command: 'gemini --version' },
    install: [
      {
        label: 'Install Gemini CLI globally',
        command: 'command -v npm >/dev/null 2>&1 && npm install -g @google/gemini-cli',
      },
    ],
    commands: [
      { label: 'Gemini (interactive)', command: 'gemini', description: 'Start interactive Gemini session.' },
      { label: 'Gemini Exec', command: 'gemini exec "Say hello briefly"', description: 'Run a one-shot Gemini task.' },
      { label: 'Version Check', command: 'gemini --version', description: 'Verify installed version.' },
    ],
    authRequired: true,
    authHint: 'Requires GEMINI_API_KEY or Google Cloud auth',
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
