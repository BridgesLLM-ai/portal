import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Terminal as TermIcon, Maximize2, Minimize2, RotateCcw, Copy, Send, X,
  Search, Command, AlertTriangle, Play, Loader2, Sparkles, ChevronRight,
  ShieldAlert, Zap, ToggleLeft, ToggleRight, Trash2, Plus, XCircle
} from 'lucide-react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { io, Socket } from 'socket.io-client';
import { aiAPI, terminalAPI, gatewayAPI } from '../api/endpoints';
import { useIsMobile } from '../hooks/useIsMobile';
import { captureError } from '../utils/errorHandler';
import { getShortModelLabel } from '../utils/modelId';
import sounds from '../utils/sounds';
import 'xterm/css/xterm.css';

const API_URL = import.meta.env.VITE_API_URL || '';
const TERMINAL_STATE_STORAGE_KEY = 'portal:terminal-state:v1';

// ─── Types ───────────────────────────────────────────────────────
interface LookupCommand {
  command: string;
  explanation: string;
  warning: string | null;
}

interface AutocompleteSuggestion {
  command: string;
  description: string;
  category: string;
  dangerous?: boolean;
}

// TabDescriptor moved to main component section below

interface ChatMessage {
  id: string;
  role: 'user' | 'ai';
  content: string;
  timestamp: number;
}

// ─── Category colors ─────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  openclaw: 'text-emerald-400 bg-emerald-500/10',
  tailscale: 'text-blue-400 bg-blue-500/10',
  ollama: 'text-purple-400 bg-purple-500/10',
  docker: 'text-cyan-400 bg-cyan-500/10',
  git: 'text-orange-400 bg-orange-500/10',
  npm: 'text-red-400 bg-red-500/10',
  yarn: 'text-sky-400 bg-sky-500/10',
  caddy: 'text-lime-400 bg-lime-500/10',
  system: 'text-slate-400 bg-slate-500/10',
  files: 'text-green-400 bg-green-500/10',
  network: 'text-indigo-400 bg-indigo-500/10',
  apt: 'text-teal-400 bg-teal-500/10',
  nginx: 'text-lime-400 bg-lime-500/10',
  ssh: 'text-fuchsia-400 bg-fuchsia-500/10',
  process: 'text-rose-400 bg-rose-500/10',
  security: 'text-amber-400 bg-amber-500/10',
  agents: 'text-violet-400 bg-violet-500/10',
  database: 'text-pink-400 bg-pink-500/10',
  ssl: 'text-yellow-400 bg-yellow-500/10',
  disk: 'text-orange-400 bg-orange-500/10',
  monitoring: 'text-cyan-400 bg-cyan-500/10',
  text: 'text-slate-400 bg-slate-500/10',
  python: 'text-yellow-400 bg-yellow-500/10',
};


const TOOL_PRESET_GROUPS: Array<{ tool: string; commands: string[] }> = [
  { tool: 'OpenClaw', commands: ['openclaw status', 'openclaw gateway status', 'openclaw gateway restart', 'openclaw doctor'] },
  { tool: 'Setup', commands: ['openclaw onboard', 'openclaw configure', 'openclaw channels list', 'openclaw models status'] },
  { tool: 'Claude Code', commands: ['claude', 'claude --continue', 'claude --resume'] },
  { tool: 'Codex', commands: ['codex', 'codex exec "task"'] },
  { tool: 'System', commands: ['htop', 'df -h', 'free -h', 'docker ps'] },
];

// ─── Autocomplete Database ──────────────────────────────────────
const AUTOCOMPLETE_DB: AutocompleteSuggestion[] = [
  // ── OpenClaw: Core ────────────────────────────────────────────
  { command: 'openclaw help', description: 'Show all available OpenClaw commands', category: 'openclaw' },
  { command: 'openclaw status', description: 'Channel health + recent session recipients', category: 'openclaw' },
  { command: 'openclaw -V', description: 'Print installed OpenClaw version', category: 'openclaw' },
  { command: 'openclaw health', description: 'Fetch health from the running gateway', category: 'openclaw' },
  // ── OpenClaw: Onboarding & Setup ──────────────────────────────
  { command: 'openclaw onboard', description: 'Interactive onboarding wizard (gateway + workspace + skills)', category: 'openclaw' },
  { command: 'openclaw configure', description: 'Interactive setup wizard (credentials, channels, agent defaults)', category: 'openclaw' },
  { command: 'openclaw setup', description: 'Initialize local config and agent workspace', category: 'openclaw' },
  { command: 'openclaw doctor', description: 'Health checks + quick fixes for gateway and channels', category: 'openclaw' },
  { command: 'openclaw doctor --deep', description: 'Deep scan for extra gateway installs + service issues', category: 'openclaw' },
  { command: 'openclaw doctor --non-interactive', description: 'Run safe migrations only (no prompts)', category: 'openclaw' },
  // ── OpenClaw: Gateway ─────────────────────────────────────────
  { command: 'openclaw gateway status', description: 'Service status + reachability probe', category: 'openclaw' },
  { command: 'openclaw gateway start', description: 'Start the gateway service', category: 'openclaw' },
  { command: 'openclaw gateway stop', description: '⚠️ Stop the gateway service', category: 'openclaw', dangerous: true },
  { command: 'openclaw gateway restart', description: 'Restart the gateway service', category: 'openclaw' },
  { command: 'openclaw gateway run', description: 'Run gateway in foreground (debug)', category: 'openclaw' },
  { command: 'openclaw gateway run --verbose', description: 'Foreground gateway with verbose logging', category: 'openclaw' },
  { command: 'openclaw gateway probe', description: 'Reachability + discovery + health summary', category: 'openclaw' },
  { command: 'openclaw gateway install', description: 'Install gateway as system service', category: 'openclaw' },
  { command: 'openclaw gateway uninstall', description: '⚠️ Uninstall the gateway service', category: 'openclaw', dangerous: true },
  { command: 'openclaw gateway usage-cost', description: 'Fetch usage cost summary from session logs', category: 'openclaw' },
  { command: 'openclaw logs', description: 'Tail gateway file logs via RPC', category: 'openclaw' },
  // ── OpenClaw: Config ──────────────────────────────────────────
  { command: 'openclaw config get', description: 'Get a config value by dot path', category: 'openclaw' },
  { command: 'openclaw config set', description: 'Set a config value by dot path', category: 'openclaw' },
  { command: 'openclaw config unset', description: 'Remove a config value by dot path', category: 'openclaw' },
  { command: 'openclaw config file', description: 'Print the active config file path', category: 'openclaw' },
  { command: 'openclaw config validate', description: 'Validate config against schema', category: 'openclaw' },
  // ── OpenClaw: Models ──────────────────────────────────────────
  { command: 'openclaw models status', description: 'Show configured model state (providers, keys)', category: 'openclaw' },
  { command: 'openclaw models list', description: 'List configured models', category: 'openclaw' },
  { command: 'openclaw models set', description: 'Set the default model', category: 'openclaw' },
  { command: 'openclaw models set-image', description: 'Set the image model', category: 'openclaw' },
  { command: 'openclaw models aliases', description: 'Manage model aliases', category: 'openclaw' },
  { command: 'openclaw models auth', description: 'Manage model auth profiles', category: 'openclaw' },
  { command: 'openclaw models fallbacks', description: 'Manage model fallback list', category: 'openclaw' },
  { command: 'openclaw models scan', description: 'Scan OpenRouter free models for tools + images', category: 'openclaw' },
  // ── OpenClaw: Channels ────────────────────────────────────────
  { command: 'openclaw channels list', description: 'List configured channels + auth profiles', category: 'openclaw' },
  { command: 'openclaw channels status', description: 'Show gateway channel status', category: 'openclaw' },
  { command: 'openclaw channels status --deep', description: 'Deep local channel status checks', category: 'openclaw' },
  { command: 'openclaw channels add', description: 'Add or update a channel account', category: 'openclaw' },
  { command: 'openclaw channels login', description: 'Link a channel account (WhatsApp QR, etc.)', category: 'openclaw' },
  { command: 'openclaw channels logout', description: 'Log out of a channel session', category: 'openclaw' },
  { command: 'openclaw channels remove', description: '⚠️ Disable or delete a channel account', category: 'openclaw', dangerous: true },
  { command: 'openclaw channels logs', description: 'Show recent channel logs', category: 'openclaw' },
  { command: 'openclaw channels capabilities', description: 'Show provider capabilities + features', category: 'openclaw' },
  // ── OpenClaw: Agents ──────────────────────────────────────────
  { command: 'openclaw agents list', description: 'List configured agents', category: 'openclaw' },
  { command: 'openclaw agents add', description: 'Add a new isolated agent', category: 'openclaw' },
  { command: 'openclaw agents delete', description: '⚠️ Delete an agent and prune workspace/state', category: 'openclaw', dangerous: true },
  { command: 'openclaw agents bind', description: 'Add routing bindings for an agent', category: 'openclaw' },
  { command: 'openclaw agents bindings', description: 'List routing bindings', category: 'openclaw' },
  { command: 'openclaw agents unbind', description: 'Remove routing bindings for an agent', category: 'openclaw' },
  { command: 'openclaw agents set-identity', description: 'Update agent identity (name/emoji/avatar)', category: 'openclaw' },
  // ── OpenClaw: Sessions & Cron ─────────────────────────────────
  { command: 'openclaw sessions', description: 'List stored conversation sessions', category: 'openclaw' },
  { command: 'openclaw sessions --active 60', description: 'Sessions updated in last hour', category: 'openclaw' },
  { command: 'openclaw sessions --all-agents', description: 'Sessions across all agents', category: 'openclaw' },
  { command: 'openclaw sessions cleanup', description: 'Run session-store maintenance', category: 'openclaw' },
  { command: 'openclaw cron list', description: 'See all scheduled automatic tasks', category: 'openclaw' },
  { command: 'openclaw cron add', description: 'Add a new scheduled task', category: 'openclaw' },
  // ── OpenClaw: Memory ──────────────────────────────────────────
  { command: 'openclaw memory status', description: 'Show memory search index status', category: 'openclaw' },
  { command: 'openclaw memory status --deep', description: 'Probe embedding provider readiness', category: 'openclaw' },
  { command: 'openclaw memory index --force', description: 'Force full memory reindex', category: 'openclaw' },
  { command: 'openclaw memory search', description: 'Search memory files', category: 'openclaw' },
  // ── OpenClaw: Skills & Plugins ────────────────────────────────
  { command: 'openclaw skills list', description: 'List all available skills', category: 'openclaw' },
  { command: 'openclaw skills check', description: 'Check skill readiness vs missing requirements', category: 'openclaw' },
  { command: 'openclaw skills info', description: 'Show detailed info about a skill', category: 'openclaw' },
  { command: 'openclaw plugins doctor', description: 'Report plugin load issues', category: 'openclaw' },
  { command: 'openclaw plugins enable', description: 'Enable a plugin in config', category: 'openclaw' },
  { command: 'openclaw plugins disable', description: 'Disable a plugin in config', category: 'openclaw' },
  // ── OpenClaw: Security & Backup ───────────────────────────────
  { command: 'openclaw security audit', description: 'Audit config + state for security foot-guns', category: 'openclaw' },
  { command: 'openclaw security audit --deep', description: 'Include live gateway probe checks', category: 'openclaw' },
  { command: 'openclaw security audit --fix', description: 'Apply safe security remediations', category: 'openclaw' },
  { command: 'openclaw backup create', description: 'Create backup archive of config + state', category: 'openclaw' },
  { command: 'openclaw backup verify', description: 'Validate a backup archive', category: 'openclaw' },
  // ── OpenClaw: Devices & Pairing ───────────────────────────────
  { command: 'openclaw devices list', description: 'List pending and paired devices', category: 'openclaw' },
  { command: 'openclaw devices approve', description: 'Approve a pending device pairing', category: 'openclaw' },
  { command: 'openclaw devices reject', description: 'Reject a pending device pairing', category: 'openclaw' },
  { command: 'openclaw devices remove', description: 'Remove a paired device', category: 'openclaw' },
  { command: 'openclaw qr', description: 'Generate iOS pairing QR/setup code', category: 'openclaw' },
  // ── OpenClaw: Sandbox & Updates ───────────────────────────────
  { command: 'openclaw sandbox list', description: 'List sandbox containers and status', category: 'openclaw' },
  { command: 'openclaw sandbox recreate --all', description: 'Recreate all sandbox containers', category: 'openclaw' },
  { command: 'openclaw sandbox explain', description: 'Explain effective sandbox/tool policy', category: 'openclaw' },
  { command: 'openclaw update', description: 'Update OpenClaw to latest version', category: 'openclaw' },
  { command: 'openclaw update status', description: 'Show update channel and version status', category: 'openclaw' },
  { command: 'openclaw update --channel beta', description: 'Switch to beta update channel', category: 'openclaw' },
  { command: 'openclaw update --dry-run', description: 'Preview update actions without changes', category: 'openclaw' },
  // ── OpenClaw: Misc ────────────────────────────────────────────
  { command: 'openclaw dashboard', description: 'Open the Control UI with your current token', category: 'openclaw' },
  { command: 'openclaw tui', description: 'Open terminal UI connected to the Gateway', category: 'openclaw' },
  { command: 'openclaw directory', description: 'Lookup contact and group IDs for chat channels', category: 'openclaw' },
  { command: 'openclaw message send', description: 'Send a message via a chat channel', category: 'openclaw' },
  { command: 'openclaw reset', description: '⚠️ Reset local config/state (keeps CLI installed)', category: 'openclaw', dangerous: true },
  { command: 'openclaw uninstall', description: '⚠️ Uninstall gateway service + local data', category: 'openclaw', dangerous: true },
  // ── Tailscale ─────────────────────────────────────────────────
  { command: 'tailscale status', description: 'See your private network connections', category: 'tailscale' },
  { command: 'tailscale ip', description: 'Show your private network address', category: 'tailscale' },
  { command: 'tailscale ping', description: 'Test if you can reach another device', category: 'tailscale' },
  { command: 'tailscale netcheck', description: 'Diagnose network connection problems', category: 'tailscale' },
  { command: 'tailscale up', description: 'Connect to your private network', category: 'tailscale' },
  { command: 'tailscale down', description: 'Disconnect from private network', category: 'tailscale' },
  { command: 'tailscale logout', description: '⚠️ Sign out of Tailscale', category: 'tailscale', dangerous: true },
  // ── Ollama ────────────────────────────────────────────────────
  { command: 'ollama list', description: 'See which AI models are downloaded', category: 'ollama' },
  { command: 'ollama ps', description: 'See which AI models are currently loaded', category: 'ollama' },
  { command: 'ollama run', description: 'Chat with a local AI model', category: 'ollama' },
  { command: 'ollama pull', description: 'Download a new AI model', category: 'ollama' },
  { command: 'ollama show', description: 'See details about a specific model', category: 'ollama' },
  { command: 'ollama rm', description: '⚠️ Delete an AI model', category: 'ollama', dangerous: true },
  // ── Docker ────────────────────────────────────────────────────
  { command: 'docker ps', description: 'Show running containers', category: 'docker' },
  { command: 'docker ps -a', description: 'Show ALL containers including stopped', category: 'docker' },
  { command: 'docker images', description: 'List downloaded images', category: 'docker' },
  { command: 'docker logs', description: 'Read container log messages', category: 'docker' },
  { command: 'docker logs -f', description: 'Watch container logs in real-time', category: 'docker' },
  { command: 'docker exec -it', description: 'Open a terminal inside a container', category: 'docker' },
  { command: 'docker stop', description: 'Gracefully shut down a container', category: 'docker' },
  { command: 'docker start', description: 'Start a stopped container', category: 'docker' },
  { command: 'docker restart', description: 'Restart a container', category: 'docker' },
  { command: 'docker rm', description: '⚠️ Remove a stopped container', category: 'docker', dangerous: true },
  { command: 'docker rm -f', description: '⚠️ Force-remove a container', category: 'docker', dangerous: true },
  { command: 'docker rmi', description: '⚠️ Delete an image', category: 'docker', dangerous: true },
  { command: 'docker compose up -d', description: 'Start all project services', category: 'docker' },
  { command: 'docker compose down', description: '⚠️ Stop and remove all services', category: 'docker', dangerous: true },
  { command: 'docker compose logs -f', description: 'Watch all service logs live', category: 'docker' },
  { command: 'docker compose ps', description: 'See status of all services', category: 'docker' },
  { command: 'docker system prune', description: '⚠️ Clean up unused Docker data', category: 'docker', dangerous: true },
  { command: 'docker system prune -a --volumes', description: '⚠️ Deep clean ALL unused + volumes', category: 'docker', dangerous: true },
  { command: 'docker system df', description: 'See Docker disk usage', category: 'docker' },
  { command: 'docker stats', description: 'Live CPU & memory usage', category: 'docker' },
  { command: 'docker stats --no-stream', description: 'Quick resource snapshot', category: 'docker' },
  // ── Git ───────────────────────────────────────────────────────
  { command: 'git status', description: 'See what files changed since last save', category: 'git' },
  { command: 'git add .', description: 'Stage all changes', category: 'git' },
  { command: 'git add -p', description: 'Stage interactively', category: 'git' },
  { command: 'git commit -m ""', description: 'Commit with message', category: 'git' },
  { command: 'git commit --amend', description: 'Fix your last commit', category: 'git' },
  { command: 'git push', description: 'Push to remote', category: 'git' },
  { command: 'git push --force-with-lease', description: 'Safe force push', category: 'git' },
  { command: 'git push --force', description: '⚠️ Force push (overwrites remote!)', category: 'git', dangerous: true },
  { command: 'git pull', description: 'Pull from remote', category: 'git' },
  { command: 'git pull --rebase', description: 'Pull with rebase', category: 'git' },
  { command: 'git fetch --all', description: 'Fetch all remotes', category: 'git' },
  { command: 'git log --oneline -10', description: 'Recent commits', category: 'git' },
  { command: 'git log --oneline --graph', description: 'Commit graph', category: 'git' },
  { command: 'git diff', description: 'Show unstaged changes', category: 'git' },
  { command: 'git diff --staged', description: 'Show staged changes', category: 'git' },
  { command: 'git branch', description: 'List branches', category: 'git' },
  { command: 'git branch -a', description: 'List all branches', category: 'git' },
  { command: 'git checkout -b', description: 'New branch', category: 'git' },
  { command: 'git switch -c', description: 'Create & switch branch', category: 'git' },
  { command: 'git merge', description: 'Merge a branch', category: 'git' },
  { command: 'git stash', description: 'Stash changes', category: 'git' },
  { command: 'git stash list', description: 'List stashed changes', category: 'git' },
  { command: 'git stash pop', description: 'Apply stash', category: 'git' },
  { command: 'git reset --soft HEAD~1', description: 'Undo commit, keep changes', category: 'git' },
  { command: 'git reset --hard HEAD', description: '⚠️ Discard ALL changes', category: 'git', dangerous: true },
  { command: 'git clean -fd', description: '⚠️ Remove untracked files', category: 'git', dangerous: true },
  { command: 'git remote -v', description: 'Show remotes', category: 'git' },
  { command: 'git reflog', description: 'Reference log (recovery tool)', category: 'git' },
  // ── npm / Node ────────────────────────────────────────────────
  { command: 'npm install', description: 'Download all dependencies', category: 'npm' },
  { command: 'npm run dev', description: 'Start dev mode', category: 'npm' },
  { command: 'npm run build', description: 'Build for production', category: 'npm' },
  { command: 'npm start', description: 'Start application', category: 'npm' },
  { command: 'npm test', description: 'Run tests', category: 'npm' },
  { command: 'npm outdated', description: 'Check outdated packages', category: 'npm' },
  { command: 'npm audit', description: 'Security audit', category: 'npm' },
  { command: 'npx tsc --noEmit', description: 'Type check', category: 'npm' },
  { command: 'node -v', description: 'Node version', category: 'npm' },
  // ── Caddy (Reverse Proxy) ─────────────────────────────────────
  { command: 'caddy version', description: 'Caddy version', category: 'caddy' },
  { command: 'caddy validate --config /etc/caddy/Caddyfile', description: 'Validate Caddyfile', category: 'caddy' },
  { command: 'caddy reload --config /etc/caddy/Caddyfile', description: 'Reload Caddy config', category: 'caddy' },
  { command: 'caddy fmt --overwrite /etc/caddy/Caddyfile', description: 'Format Caddyfile', category: 'caddy' },
  { command: 'systemctl status caddy', description: 'Caddy service status', category: 'caddy' },
  { command: 'systemctl restart caddy', description: 'Restart Caddy', category: 'caddy' },
  { command: 'journalctl -u caddy --since "10 min ago"', description: 'Recent Caddy logs', category: 'caddy' },
  { command: 'cat /etc/caddy/Caddyfile', description: 'View Caddyfile', category: 'caddy' },
  // ── System / systemd ──────────────────────────────────────────
  { command: 'systemctl status', description: 'Check service status', category: 'system' },
  { command: 'systemctl start', description: 'Start a service', category: 'system' },
  { command: 'systemctl stop', description: '⚠️ Stop a service', category: 'system', dangerous: true },
  { command: 'systemctl restart', description: 'Restart a service', category: 'system' },
  { command: 'systemctl enable', description: 'Auto-start on boot', category: 'system' },
  { command: 'systemctl daemon-reload', description: 'Reload systemd', category: 'system' },
  { command: 'systemctl list-units --failed', description: 'Show crashed services', category: 'system' },
  { command: 'systemctl list-units --type=service --state=running', description: 'All running services', category: 'system' },
  { command: 'systemctl list-timers', description: 'Scheduled timers', category: 'system' },
  { command: 'systemctl cat', description: 'Show service file', category: 'system' },
  { command: 'journalctl -u', description: 'Read service logs', category: 'system' },
  { command: 'journalctl -xe', description: 'Show recent errors', category: 'system' },
  { command: 'journalctl -f', description: 'Follow system logs', category: 'system' },
  { command: 'htop', description: 'Visual process viewer', category: 'system' },
  { command: 'df -h', description: 'Disk usage', category: 'system' },
  { command: 'du -sh * | sort -hr', description: 'Folder sizes, biggest first', category: 'system' },
  { command: 'free -h', description: 'Memory usage', category: 'system' },
  { command: 'uname -a', description: 'System info', category: 'system' },
  { command: 'uptime', description: 'Uptime & load', category: 'system' },
  { command: 'lscpu', description: 'CPU info', category: 'system' },
  { command: 'lsblk', description: 'Block devices', category: 'system' },
  { command: 'date', description: 'Current date/time', category: 'system' },
  { command: 'timedatectl', description: 'Timezone & time sync', category: 'system' },
  { command: 'hostnamectl', description: 'System hostname info', category: 'system' },
  { command: 'history | grep', description: 'Search history', category: 'system' },
  { command: 'tmux ls', description: 'List tmux sessions', category: 'system' },
  { command: 'tmux new -s', description: 'New tmux session', category: 'system' },
  { command: 'crontab -l', description: 'List cron jobs', category: 'system' },
  { command: 'crontab -e', description: 'Edit cron jobs', category: 'system' },
  { command: 'whoami', description: 'Current user', category: 'system' },
  { command: 'id', description: 'User ID & groups', category: 'system' },
  { command: 'who', description: 'Logged in users', category: 'system' },
  { command: 'last -10', description: 'Recent logins', category: 'system' },
  // ── apt ───────────────────────────────────────────────────────
  { command: 'apt update', description: 'Refresh package lists', category: 'apt' },
  { command: 'apt upgrade', description: 'Upgrade packages', category: 'apt' },
  { command: 'apt install', description: 'Install package', category: 'apt' },
  { command: 'apt remove', description: 'Remove package', category: 'apt' },
  { command: 'apt purge', description: '⚠️ Remove + config', category: 'apt', dangerous: true },
  { command: 'apt autoremove', description: 'Remove unused deps', category: 'apt' },
  { command: 'apt search', description: 'Search packages', category: 'apt' },
  // ── Files ─────────────────────────────────────────────────────
  { command: 'ls', description: 'List files', category: 'files' },
  { command: 'ls -la', description: 'Detailed list', category: 'files' },
  { command: 'ls -lah', description: 'Detailed + human sizes', category: 'files' },
  { command: 'cd', description: 'Change directory', category: 'files' },
  { command: 'pwd', description: 'Print working dir', category: 'files' },
  { command: 'mkdir -p', description: 'Create directory', category: 'files' },
  { command: 'cp -r', description: 'Copy recursive', category: 'files' },
  { command: 'mv', description: 'Move/rename', category: 'files' },
  { command: 'rm', description: '⚠️ Delete files', category: 'files', dangerous: true },
  { command: 'rm -rf', description: '⚠️ Force recursive delete', category: 'files', dangerous: true },
  { command: 'cat', description: 'Show file contents', category: 'files' },
  { command: 'less', description: 'Page through file', category: 'files' },
  { command: 'head -n 20', description: 'First 20 lines', category: 'files' },
  { command: 'tail -n 20', description: 'Last 20 lines', category: 'files' },
  { command: 'tail -f', description: 'Follow file', category: 'files' },
  { command: 'find . -name', description: 'Find by name', category: 'files' },
  { command: 'find . -type f -size +100M', description: 'Files > 100MB', category: 'files' },
  { command: 'grep -r "" .', description: 'Search recursively', category: 'files' },
  { command: 'grep -rn "" .', description: 'Search with line nums', category: 'files' },
  { command: 'chmod +x', description: 'Make executable', category: 'files' },
  { command: 'chmod -R 777', description: '⚠️ Wide open (security risk)', category: 'files', dangerous: true },
  { command: 'chown -R', description: 'Change ownership', category: 'files' },
  { command: 'tar -czf', description: 'Create .tar.gz', category: 'files' },
  { command: 'tar -xzf', description: 'Extract .tar.gz', category: 'files' },
  { command: 'zip -r archive.zip folder/', description: 'Create zip archive', category: 'files' },
  { command: 'unzip archive.zip', description: 'Extract zip archive', category: 'files' },
  { command: 'tree -L 2', description: 'Tree 2 levels', category: 'files' },
  { command: 'nano', description: 'Text editor', category: 'files' },
  // ── Network ───────────────────────────────────────────────────
  { command: 'curl -s', description: 'HTTP request', category: 'network' },
  { command: 'curl -I', description: 'Headers only', category: 'network' },
  { command: 'curl -X POST', description: 'POST request', category: 'network' },
  { command: 'wget', description: 'Download file', category: 'network' },
  { command: 'ping -c 4', description: 'Ping 4 packets', category: 'network' },
  { command: 'dig', description: 'DNS lookup', category: 'network' },
  { command: 'nslookup', description: 'DNS lookup (alternative)', category: 'network' },
  { command: 'ip addr', description: 'Network interfaces', category: 'network' },
  { command: 'ss -tlnp', description: 'Listening TCP ports', category: 'network' },
  { command: 'lsof -i', description: 'Open connections', category: 'network' },
  { command: 'lsof -i :3001', description: 'What uses port 3001', category: 'network' },
  { command: 'fuser -k 3001/tcp', description: '⚠️ Kill port process', category: 'network', dangerous: true },
  { command: 'ufw status', description: 'Firewall status', category: 'network' },
  { command: 'ufw allow', description: 'Allow port through firewall', category: 'network' },
  { command: 'ufw deny', description: 'Block port in firewall', category: 'network' },
  { command: 'iptables -L -n', description: 'Firewall rules (iptables)', category: 'network' },
  { command: 'ssh', description: 'SSH connect', category: 'network' },
  { command: 'rsync -avz --progress', description: 'Sync with progress', category: 'network' },
  { command: 'traceroute', description: 'Trace packet route', category: 'network' },
  { command: 'mtr', description: 'Interactive traceroute', category: 'network' },
  // ── Nginx ─────────────────────────────────────────────────────
  { command: 'nginx -t', description: 'Test nginx config', category: 'nginx' },
  { command: 'nginx -s reload', description: 'Reload nginx', category: 'nginx' },
  { command: 'systemctl restart nginx', description: 'Restart nginx', category: 'nginx' },
  { command: 'systemctl status nginx', description: 'Nginx status', category: 'nginx' },
  { command: 'tail -f /var/log/nginx/error.log', description: 'Nginx errors', category: 'nginx' },
  // ── Processes ─────────────────────────────────────────────────
  { command: 'ps aux', description: 'All processes', category: 'process' },
  { command: 'ps aux | grep', description: 'Search process', category: 'process' },
  { command: 'kill', description: 'Send signal', category: 'process' },
  { command: 'kill -9', description: '⚠️ Force kill', category: 'process', dangerous: true },
  { command: 'killall', description: '⚠️ Kill by name', category: 'process', dangerous: true },
  { command: 'pkill -f', description: '⚠️ Kill by pattern', category: 'process', dangerous: true },
  // ── Dangerous / Destructive ───────────────────────────────────
  { command: 'dd if=', description: '⚠️ Low-level disk copy', category: 'security', dangerous: true },
  { command: 'mkfs', description: '⚠️ Format disk', category: 'security', dangerous: true },
  { command: 'shutdown -h now', description: '⚠️ Shutdown now', category: 'security', dangerous: true },
  { command: 'reboot', description: '⚠️ Reboot system', category: 'security', dangerous: true },
  // ── Python ────────────────────────────────────────────────────
  { command: 'python3 --version', description: 'Python version', category: 'python' },
  { command: 'python3', description: 'Start Python REPL', category: 'python' },
  { command: 'python3 -m venv venv', description: 'Create virtual environment', category: 'python' },
  { command: 'source venv/bin/activate', description: 'Activate virtual environment', category: 'python' },
  { command: 'pip install', description: 'Install Python package', category: 'python' },
  { command: 'pip install -r requirements.txt', description: 'Install from requirements', category: 'python' },
  { command: 'pip list', description: 'List installed packages', category: 'python' },
  { command: 'pip freeze > requirements.txt', description: 'Export requirements', category: 'python' },
  { command: 'python3 -m http.server 8080', description: 'Quick HTTP server', category: 'python' },
  // ── Database / Prisma ─────────────────────────────────────────
  { command: 'npx prisma studio', description: 'Open Prisma DB browser', category: 'database' },
  { command: 'npx prisma migrate dev', description: 'Run dev migrations', category: 'database' },
  { command: 'npx prisma migrate deploy', description: 'Apply prod migrations', category: 'database' },
  { command: 'npx prisma db push', description: 'Push schema to DB', category: 'database' },
  { command: 'npx prisma generate', description: 'Generate Prisma client', category: 'database' },
  { command: 'psql "$(grep \'^DATABASE_URL=\' /opt/bridgesllm/portal/backend/.env.production | cut -d= -f2- | tr -d \"\")"', description: 'Connect to configured portal DB', category: 'database' },
  { command: 'pg_dump "$(grep \'^DATABASE_URL=\' /opt/bridgesllm/portal/backend/.env.production | cut -d= -f2- | tr -d \"\")" > backup.sql', description: 'Backup configured portal DB', category: 'database' },
  // ── SSL / Certbot ─────────────────────────────────────────────
  { command: 'certbot certificates', description: 'List SSL certificates', category: 'ssl' },
  { command: 'certbot renew --dry-run', description: 'Test certificate renewal', category: 'ssl' },
  { command: 'certbot renew', description: 'Renew SSL certificates', category: 'ssl' },
  { command: 'openssl s_client -connect', description: 'Test SSL connection', category: 'ssl' },
  // ── Monitoring ────────────────────────────────────────────────
  { command: 'top -bn1 | head -20', description: 'Quick process snapshot', category: 'monitoring' },
  { command: 'dmesg | tail -20', description: 'Recent kernel messages', category: 'monitoring' },
  { command: 'dmesg -Tw', description: 'Follow kernel messages', category: 'monitoring' },
  { command: 'vmstat 1 5', description: 'VM stats (5 samples)', category: 'monitoring' },
  // ── Disk Cleanup ──────────────────────────────────────────────
  { command: 'du -sh /var/log/*', description: 'Log directory sizes', category: 'disk' },
  { command: 'find /tmp -type f -atime +7 -delete', description: '⚠️ Clean old temp files', category: 'disk', dangerous: true },
  { command: 'journalctl --disk-usage', description: 'Journal log disk usage', category: 'disk' },
  { command: 'journalctl --vacuum-time=7d', description: 'Trim journal to 7 days', category: 'disk' },
  // ── Agent Tools ───────────────────────────────────────────────
  { command: 'claude', description: 'Start Claude Code session', category: 'agents' },
  { command: 'claude --continue', description: 'Continue last Claude session', category: 'agents' },
  { command: 'claude --resume', description: 'Resume Claude session', category: 'agents' },
  { command: 'claude -p "task"', description: 'One-shot Claude task', category: 'agents' },
  { command: 'codex', description: 'Start Codex session', category: 'agents' },
  { command: 'codex exec "task"', description: 'One-shot Codex task', category: 'agents' },
  { command: 'codex --help', description: 'Show Codex CLI options', category: 'agents' },
  { command: 'gemini', description: 'Start Gemini CLI session', category: 'agents' },
  // ── Text Processing ───────────────────────────────────────────
  { command: 'wc -l', description: 'Count lines', category: 'text' },
  { command: 'sort | uniq -c | sort -rn', description: 'Frequency count', category: 'text' },
  { command: 'awk \'{print $1}\'', description: 'Print first column', category: 'text' },
  { command: 'sed -i \'s/old/new/g\'', description: 'Find & replace in file', category: 'text' },
  { command: 'jq .', description: 'Pretty-print JSON', category: 'text' },
  { command: 'jq -r \'.key\'', description: 'Extract JSON value', category: 'text' },
  { command: 'xargs', description: 'Build command from stdin', category: 'text' },
  { command: 'tee', description: 'Write to file + stdout', category: 'text' },
];

function getLocalSuggestions(input: string): AutocompleteSuggestion[] {
  if (!input.trim()) return [];
  const lower = input.toLowerCase();
  const exact = AUTOCOMPLETE_DB.filter(c => c.command.toLowerCase().startsWith(lower));
  if (exact.length > 0) return exact.slice(0, 10);
  const words = lower.split(/\s+/);
  return AUTOCOMPLETE_DB.filter(c =>
    words.every(w => c.command.toLowerCase().includes(w) || c.description.toLowerCase().includes(w)) ||
    c.category.startsWith(lower)
  ).slice(0, 10);
}

// ─── Destructive Command Detection ──────────────────────────────
const DANGEROUS_PATTERNS = [
  { pattern: /^rm\s+-rf\s+\//, message: 'This will recursively delete from root! System will be destroyed.' },
  { pattern: /^rm\s+(-[a-z]*f[a-z]*\s+|.*--force)/, message: 'Force deletion — files cannot be recovered!' },
  { pattern: /^rm\s+-r/, message: 'Recursive file deletion — files cannot be recovered.' },
  { pattern: /^dd\s+/, message: 'Low-level disk operation. Can overwrite entire drives.' },
  { pattern: /^mkfs/, message: 'This will FORMAT a disk partition, destroying all data!' },
  { pattern: /^fdisk/, message: 'Disk partition editor — changes can cause data loss.' },
  { pattern: /^parted/, message: 'Disk partition editor — changes can cause data loss.' },
  { pattern: /^chmod\s+(-R\s+)?777/, message: 'Setting 777 permissions is a security risk!' },
  { pattern: /^rm\s+-rf\s+\*/, message: 'This will delete everything in the current directory!' },
  { pattern: />\s*\/dev\/sd[a-z]/, message: 'Writing directly to disk device — will destroy data!' },
  { pattern: /^shutdown/, message: 'This will shut down the server!' },
  { pattern: /^reboot/, message: 'This will reboot the server!' },
  { pattern: /^kill\s+-9/, message: 'Force killing a process — no cleanup will occur.' },
  { pattern: /^killall/, message: 'This kills ALL processes matching the name.' },
  { pattern: /^docker\s+system\s+prune\s+-a/, message: 'This removes ALL unused Docker data!' },
  { pattern: /^docker\s+compose\s+down\s+-v/, message: 'This will remove containers AND their volumes (data)!' },
  { pattern: /^git\s+reset\s+--hard/, message: 'This will discard ALL uncommitted changes permanently!' },
  { pattern: /^git\s+clean\s+-f/, message: 'This removes untracked files permanently!' },
  { pattern: /^git\s+push\s+--force\b/, message: 'Force push will overwrite remote history!' },
  { pattern: /^\s*:\s*\(\)\s*\{/, message: 'Fork bomb detected — this will crash the system!' },
  { pattern: /^userdel/, message: 'This will delete a user account.' },
  { pattern: /^apt\s+purge/, message: 'This removes packages AND their configuration.' },
  { pattern: /^pm2\s+delete\s+all/, message: 'This will remove all PM2 managed processes.' },
  { pattern: /^tailscale\s+logout/, message: 'This will disconnect from Tailscale network.' },
  { pattern: /^openclaw\s+reset/, message: 'This will reset local config/state!' },
  { pattern: /^openclaw\s+gateway\s+--force/, message: 'Force restart without safety checks — may interrupt active sessions!' },
  { pattern: /^openclaw\s+gateway\s+stop/, message: 'This will stop the AI gateway — all AI features will be unavailable!' },
  { pattern: /^openclaw\s+update/, message: 'Self-update may change system behavior or require restart!' },
  { pattern: /^openclaw\s+.*--force/, message: 'Force flag bypasses safety checks!' },
];

function detectDanger(command: string): { isDangerous: boolean; message: string } | null {
  const trimmed = command.trim();
  for (const { pattern, message } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) return { isDangerous: true, message };
  }
  return null;
}

// ─── Danger Warning Modal ────────────────────────────────────────
function DangerWarningModal({ command, message, onConfirm, onCancel }: {
  command: string; message: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onCancel}>
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
        className="bg-[#1A0A0A] border-2 border-red-500/40 rounded-2xl p-6 max-w-md w-full mx-4 shadow-[0_0_60px_rgba(239,68,68,0.15)]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
            <ShieldAlert size={24} className="text-red-400" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-red-400">⚠️ DANGEROUS COMMAND</h3>
            <p className="text-xs text-red-300/60">This action may be destructive</p>
          </div>
        </div>
        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-3 mb-4">
          <code className="text-sm font-mono text-red-300 break-all">{command}</code>
        </div>
        <p className="text-sm text-slate-300 mb-6">{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors">Cancel</button>
          <button onClick={onConfirm} className="flex-1 py-2.5 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400 text-sm font-medium hover:bg-red-500/30 transition-colors">Run Anyway</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── Local Lookup Search (no Ollama) ─────────────────────────────
function extractKeywordsFromBuffer(buffer: string): string[] {
  const words = buffer.toLowerCase().replace(/\x1b\[[0-9;]*m/g, '').split(/[\s\/\-_.,:;|]+/).filter(w => w.length > 2);
  const freq: Record<string, number> = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w]) => w);
}

function localLookupSearch(query: string, contextKeywords: string[]): AutocompleteSuggestion[] {
  const q = query.toLowerCase().trim();
  const isEmptyQuery = !q;
  const qWords = isEmptyQuery ? [] : q.split(/\s+/);

  // Score each command
  const scored = AUTOCOMPLETE_DB.map(cmd => {
    const cmdLower = cmd.command.toLowerCase();
    const descLower = cmd.description.toLowerCase();
    const catLower = cmd.category.toLowerCase();
    let score = 0;

    // Exact prefix match on command
    if (cmdLower.startsWith(q)) score += 100;
    // Each query word matches command or description
    qWords.forEach(w => {
      if (cmdLower.includes(w)) score += 30;
      if (descLower.includes(w)) score += 20;
      if (catLower.includes(w)) score += 15;
    });
    // Tag/category exact match
    if (catLower === q) score += 50;

    // Context boost: terminal buffer keywords significantly boost matching commands
    let contextBoost = 0;
    contextKeywords.forEach(kw => {
      if (catLower === kw) contextBoost += 25;
      else if (catLower.includes(kw)) contextBoost += 15;
      if (cmdLower.includes(kw)) contextBoost += 10;
    });
    score += contextBoost;

    // For empty query, give a small base score to popular/common commands
    if (isEmptyQuery && contextBoost > 0) score += 5;

    return { cmd, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  return scored.slice(0, 20).map(s => s.cmd);
}

// ─── Assistant Side Panel ────────────────────────────────────────
function AssistantAIPanel({ isOpen, onClose, onInsert, getFullBuffer, contextEnabled, setContextEnabled }: {
  isOpen: boolean; onClose: () => void; onInsert: (cmd: string) => void; getFullBuffer: () => string;
  contextEnabled: boolean; setContextEnabled: (v: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<'lookup' | 'aidebug'>('lookup');
  const [query, setQuery] = useState('');
  const [lookupResults, setLookupResults] = useState<AutocompleteSuggestion[]>([]);
  const includeContext = contextEnabled;
  const setIncludeContext = (v: boolean | ((prev: boolean) => boolean)) => {
    if (typeof v === 'function') setContextEnabled(v(contextEnabled));
    else setContextEnabled(v);
  };
  // AI Debug state
  const [aiDebugModel, setAiDebugModel] = useState<string>('');
  const [aiDebugTier, setAiDebugTier] = useState<string>('smart');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugResults, setDebugResults] = useState<LookupCommand[]>([]);
  const [debugSummary, setDebugSummary] = useState('');
  const [debugError, setDebugError] = useState('');
  const [debugQuery, setDebugQuery] = useState('');
  const [debugIncludeContext, setDebugIncludeContext] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const debugInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && activeTab === 'lookup') setTimeout(() => inputRef.current?.focus(), 100);
    if (isOpen && activeTab === 'aidebug') setTimeout(() => debugInputRef.current?.focus(), 100);
  }, [isOpen, activeTab]);

  // Live local search for Lookup tab
  useEffect(() => {
    const contextKeywords = includeContext ? extractKeywordsFromBuffer(getFullBuffer()) : [];
    setLookupResults(localLookupSearch(query, contextKeywords));
  }, [query, includeContext]);

  // AI Debug: calls Ollama via backend
  const doAIDebug = async () => {
    if (!debugQuery.trim()) return;
    setDebugLoading(true); setDebugError(''); setDebugResults([]);
    try {
      const contextToSend = debugIncludeContext ? getFullBuffer() : undefined;
      const data = await terminalAPI.lookup(debugQuery, contextToSend, aiDebugModel || undefined, aiDebugTier || undefined);
      if (data.commands?.length > 0) { setDebugResults(data.commands); setDebugSummary(data.summary || ''); }
      else setDebugError(data.summary || 'No commands found. Try rephrasing.');
    } catch { setDebugError('Failed to reach AI service. Is Ollama running?'); }
    finally { setDebugLoading(false); }
  };

  if (!isOpen) return null;

  return (
    <motion.div
      initial={window.innerWidth < 768 ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      animate={window.innerWidth < 768 ? { opacity: 1, x: 0 } : { width: 360, opacity: 1 }}
      exit={window.innerWidth < 768 ? { opacity: 0, x: '100%' } : { width: 0, opacity: 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
      className={window.innerWidth < 768
        ? 'fixed inset-0 z-[60] flex flex-col bg-[#0D1130]/98 backdrop-blur-xl'
        : 'border-l border-white/5 flex flex-col bg-[#0D1130]/95 flex-shrink-0 overflow-hidden backdrop-blur-xl z-[60]'}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-emerald-400" />
          <span className="text-sm font-semibold text-white">Assistant</span>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors">
          <X size={16} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/5">
        <button onClick={() => setActiveTab('lookup')}
          className={`flex-1 py-2 text-xs font-medium transition-all ${activeTab === 'lookup' ? 'text-emerald-400 border-b-2 border-emerald-400 bg-emerald-500/5' : 'text-slate-500 hover:text-slate-300'}`}>
          <Search size={12} className="inline mr-1.5" />Lookup
        </button>
        <button onClick={() => setActiveTab('aidebug')}
          className={`flex-1 py-2 text-xs font-medium transition-all ${activeTab === 'aidebug' ? 'text-purple-400 border-b-2 border-purple-400 bg-purple-500/5' : 'text-slate-500 hover:text-slate-300'}`}>
          <AlertTriangle size={12} className="inline mr-1.5" />AI Debug
        </button>
      </div>

      {/* Lookup Tab — LOCAL search only, no Ollama */}
      {activeTab === 'lookup' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
            <Search size={12} className="text-slate-500 flex-shrink-0" />
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search commands (e.g. docker, disk, nginx)..."
              className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 outline-none" />
            {query && <button onClick={() => setQuery('')} className="text-slate-500 hover:text-white"><XCircle size={12} /></button>}
          </div>

          {/* Context toggle */}
          <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
            <label className="flex items-center gap-1.5 cursor-pointer select-none" onClick={() => { const next = !includeContext; next ? sounds.toggleOn() : sounds.toggleOff(); setIncludeContext(next); }}>
              {includeContext ? <ToggleRight size={14} className="text-emerald-400" /> : <ToggleLeft size={14} className="text-slate-500" />}
              <span className="text-[10px] font-medium text-slate-400">📋 Context boost</span>
            </label>
            <span className="text-[9px] text-slate-600">{includeContext ? '✅ Biased by terminal (+ chat box)' : '⚡ All commands'}</span>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-auto">
            {!query && lookupResults.length === 0 && (
              <div className="px-3 py-6 text-center">
                <Command size={24} className="mx-auto mb-2 text-slate-600" />
                <p className="text-[11px] text-slate-500 mb-1">Local Command Search</p>
                <p className="text-[10px] text-slate-600 mb-3">{AUTOCOMPLETE_DB.length} commands · Instant results · No AI calls</p>
                <p className="text-[10px] text-slate-500 mb-2">{includeContext ? '💡 Enable context boost & run some commands to see ranked suggestions here' : '💡 Turn on Context boost to see ranked suggestions'}</p>
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {['openclaw', 'docker', 'nginx', 'git', 'disk', 'network'].map(ex => (
                    <button key={ex} onClick={() => setQuery(ex)}
                      className="px-2 py-0.5 rounded-lg bg-white/5 text-[10px] text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors">{ex}</button>
                  ))}
                </div>
              </div>
            )}
            {!query && lookupResults.length > 0 && (
              <div className="px-3 pt-2 pb-1 text-[10px] text-emerald-400/70">
                <Sparkles size={10} className="inline mr-1" />Suggested based on terminal activity
              </div>
            )}
            {query && lookupResults.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-slate-500">No matching commands. Try different keywords.</div>
            )}
            {lookupResults.length > 0 && (
              <div>
                <div className="px-3 pt-2 pb-1 text-[10px] text-slate-500">{lookupResults.length} result{lookupResults.length !== 1 ? 's' : ''}</div>
                {lookupResults.map((r, i) => {
                  const catColor = CATEGORY_COLORS[r.category] || 'text-slate-400 bg-slate-500/10';
                  return (
                    <div key={i} className="px-3 py-2 border-b border-white/5 last:border-0 hover:bg-white/[0.02] group">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          <span className={`px-1.5 py-0.5 rounded text-[8px] font-medium uppercase ${catColor}`}>{r.category}</span>
                          <code className="text-[11px] font-mono text-emerald-400 truncate">{r.command}</code>
                        </div>
                        <button onClick={() => onInsert(r.command)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-[10px] font-medium hover:bg-emerald-500/20 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0">
                          <Play size={8} /> Run
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-0.5">{r.description}</p>
                      {r.dangerous && (
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-amber-400">
                          <AlertTriangle size={10} />⚠️ Potentially dangerous
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick commands */}
          <div className="px-3 py-2 border-t border-white/5">
            <span className="text-[9px] text-slate-600 uppercase tracking-wider">Quick</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {['ls -la', 'git status', 'docker ps', 'df -h', 'free -h'].map(cmd => (
                <button key={cmd} onClick={() => onInsert(cmd)}
                  className="px-1.5 py-0.5 rounded bg-white/5 text-[9px] text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors font-mono">{cmd}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* AI Debug Tab — Ollama-powered troubleshooting */}
      {activeTab === 'aidebug' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
            <input ref={debugInputRef} value={debugQuery} onChange={e => setDebugQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') doAIDebug(); }}
              placeholder="Describe your problem or what you want to do..."
              className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 outline-none" />
            {debugLoading ? <Loader2 size={14} className="text-purple-400 animate-spin" /> :
              <button onClick={doAIDebug} disabled={debugLoading} className="px-2.5 py-1 rounded-lg bg-purple-500/20 text-purple-300 text-[10px] font-medium hover:bg-purple-500/30 transition-colors disabled:opacity-40">Debug</button>}
          </div>

          {/* Model tier toggle: Snappy / Smart / Best */}
          <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
              <button onClick={() => { setAiDebugTier('snappy'); setAiDebugModel(''); }}
                className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${aiDebugTier === 'snappy' ? 'bg-emerald-500/20 text-emerald-400 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                title="Snappy — fastest responses">⚡ Snappy</button>
              <button onClick={() => { setAiDebugTier('smart'); setAiDebugModel(''); }}
                className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${aiDebugTier === 'smart' ? 'bg-cyan-500/20 text-cyan-400 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                title="Smart — balanced speed and quality">🧠 Smart</button>
              <button onClick={() => { setAiDebugTier('best'); setAiDebugModel(''); }}
                className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-all ${aiDebugTier === 'best' ? 'bg-violet-500/20 text-violet-400 shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}
                title="Best — highest quality analysis">🏆 Best</button>
            </div>
            <span className="text-[9px] text-slate-600">{aiDebugTier === 'snappy' ? 'Snappy' : aiDebugTier === 'best' ? 'Best' : 'Smart'}</span>
          </div>

          {/* Context toggle */}
          <div className="px-3 py-1.5 border-b border-white/5 flex items-center justify-between">
            <label className="flex items-center gap-1.5 cursor-pointer select-none" onClick={() => { const next = !debugIncludeContext; next ? sounds.toggleOn() : sounds.toggleOff(); setDebugIncludeContext(next); }}>
              {debugIncludeContext ? <ToggleRight size={14} className="text-purple-400" /> : <ToggleLeft size={14} className="text-slate-500" />}
              <span className="text-[10px] font-medium text-slate-400">📋 Include terminal buffer</span>
            </label>
            <span className="text-[9px] text-slate-600">{debugIncludeContext ? '✅ Context-aware' : '⚡ Fast'}</span>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-auto">
            {!debugResults.length && !debugError && !debugLoading && (
              <div className="px-3 py-6 text-center">
                <AlertTriangle size={24} className="mx-auto mb-2 text-purple-400/50" />
                <p className="text-[11px] text-slate-500 mb-1">AI Debug · Powered by Ollama</p>
                <p className="text-[10px] text-slate-600 mb-3">Describe errors, ask how to fix things, or get troubleshooting help.</p>
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {['why is nginx 502', 'command failed help', 'disk is full', 'port already in use'].map(ex => (
                    <button key={ex} onClick={() => setDebugQuery(ex)}
                      className="px-2 py-0.5 rounded-lg bg-white/5 text-[10px] text-slate-400 hover:text-purple-400 hover:bg-purple-500/10 transition-colors">{ex}</button>
                  ))}
                </div>
              </div>
            )}
            {debugLoading && (
              <div className="px-3 py-8 text-center">
                <Loader2 size={20} className="mx-auto mb-2 text-purple-400 animate-spin" />
                <p className="text-[10px] text-slate-500">AI is thinking...</p>
              </div>
            )}
            {debugError && <div className="px-3 py-4 text-center text-[11px] text-red-400">{debugError}</div>}
            {debugResults.length > 0 && (
              <div>
                {debugSummary && <div className="px-3 pt-2 pb-1 text-[10px] text-slate-400">{debugSummary}</div>}
                {debugResults.map((r, i) => {
                  const danger = detectDanger(r.command);
                  return (
                    <div key={i} className="px-3 py-2 border-b border-white/5 last:border-0 hover:bg-white/[0.02] group">
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-[11px] font-mono text-purple-400 flex-1 break-all">{r.command}</code>
                        <button onClick={() => onInsert(r.command)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-purple-500/10 text-purple-400 text-[10px] font-medium hover:bg-purple-500/20 transition-colors opacity-0 group-hover:opacity-100">
                          <Play size={8} /> Run
                        </button>
                      </div>
                      <p className="text-[10px] text-slate-500 mt-0.5">{r.explanation}</p>
                      {(r.warning || danger) && (
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-amber-400">
                          <AlertTriangle size={10} />{r.warning || danger?.message}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Chat Box Input with Autocomplete ────────────────────────────
function ChatBoxInput({ onSubmit, onInputChange, connected, running, externalClear, inputMode, onFocusChatBox, contextEnabled, getFullBuffer }: {
  onSubmit: (cmd: string) => void; onInputChange: (value: string) => void; connected: boolean; running: boolean; externalClear?: number;
  inputMode: 'chat' | 'terminal'; onFocusChatBox: () => void; contextEnabled: boolean; getFullBuffer: () => string;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const lastClearRef = useRef(0);
  const [chatAcResults, setChatAcResults] = useState<AutocompleteSuggestion[]>([]);
  const [chatAcIndex, setChatAcIndex] = useState(0);
  const [chatAcVisible, setChatAcVisible] = useState(false);
  const [sentFlash, setSentFlash] = useState(false);

  useEffect(() => {
    if (externalClear && externalClear !== lastClearRef.current) {
      lastClearRef.current = externalClear;
      setValue(''); onInputChange(''); setChatAcVisible(false);
    }
  }, [externalClear, onInputChange]);

  // Update autocomplete as user types
  useEffect(() => {
    if (value.length < 1) { setChatAcVisible(false); return; }
    const contextKeywords = contextEnabled ? extractKeywordsFromBuffer(getFullBuffer()) : [];
    const results = localLookupSearch(value, contextKeywords);
    if (results.length > 0) {
      setChatAcResults(results.slice(0, 8));
      setChatAcIndex(0);
      setChatAcVisible(true);
    } else {
      setChatAcVisible(false);
    }
  }, [value, contextEnabled]);

  const handleSubmit = () => {
    if (!value.trim()) return;
    onSubmit(value); setValue(''); onInputChange(''); setChatAcVisible(false);
    setSentFlash(true);
    setTimeout(() => setSentFlash(false), 800);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const selectSuggestion = (cmd: string) => {
    onSubmit(cmd); setValue(''); onInputChange(''); setChatAcVisible(false);
    setSentFlash(true);
    setTimeout(() => setSentFlash(false), 800);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (chatAcVisible) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setChatAcIndex(prev => Math.max(0, prev - 1)); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setChatAcIndex(prev => Math.min(chatAcResults.length - 1, prev + 1)); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (chatAcResults.length > 0) {
          const cmd = chatAcResults[chatAcIndex]?.command || '';
          setValue(cmd); onInputChange(cmd);
          // Keep autocomplete open for further refinement
        }
        return;
      }
      if (e.key === 'Escape') { setChatAcVisible(false); return; }
    }
    if (e.key === 'Escape') {
      // Handled by parent to switch to terminal mode
      return;
    }
    if (e.key === 'Enter') {
      if (chatAcVisible && chatAcResults.length > 0) {
        selectSuggestion(chatAcResults[chatAcIndex].command);
      } else {
        handleSubmit();
      }
    }
  };

  const isFocused = inputMode === 'chat';

  return (
    <div className="relative flex-shrink-0">
      {/* Autocomplete panel floating above */}
      <AnimatePresence>
        {chatAcVisible && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full left-0 right-0 mb-1 z-[200] max-h-[300px] overflow-auto">
            <div className="mx-2 bg-[#0D1130]/95 border border-white/10 rounded-xl shadow-2xl backdrop-blur-2xl overflow-hidden">
              <div className="px-3 py-1.5 border-b border-white/5 flex items-center gap-2">
                <Zap size={10} className="text-emerald-400" />
                <span className="text-[9px] text-slate-500 uppercase tracking-wider">Suggestions</span>
                {contextEnabled && <span className="text-[8px] text-emerald-500/60 ml-auto">context-aware</span>}
              </div>
              {chatAcResults.map((s, i) => {
                const catColor = CATEGORY_COLORS[s.category] || 'text-slate-400 bg-slate-500/10';
                return (
                  <button key={s.command} onClick={() => selectSuggestion(s.command)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-all ${
                      i === chatAcIndex ? 'bg-emerald-500/10 border-l-2 border-emerald-400' : 'hover:bg-white/[0.03] border-l-2 border-transparent'
                    }`}>
                    <span className={`px-1 py-0.5 rounded text-[7px] font-medium uppercase ${catColor} flex-shrink-0`}>{s.category}</span>
                    <code className={`text-[11px] font-mono flex-1 truncate ${i === chatAcIndex ? 'text-emerald-400' : 'text-slate-300'}`}>{s.command}</code>
                    {s.dangerous && <AlertTriangle size={10} className="text-red-400 flex-shrink-0" />}
                    <span className="text-[9px] text-slate-600 truncate max-w-[120px]">{s.description}</span>
                  </button>
                );
              })}
              <div className="px-3 py-1 border-t border-white/5 text-[8px] text-slate-600 flex gap-3">
                <span>↑↓ navigate</span><span>Tab fill</span><span>Enter run</span><span>Esc dismiss</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat box input */}
      <div className={`flex items-center gap-2 px-4 py-3 bg-[#080B20]/95 backdrop-blur-xl border-t transition-all duration-300 z-[100] ${
        sentFlash ? 'border-emerald-400/60 shadow-[0_-2px_30px_rgba(16,185,129,0.15)]'
          : running ? 'border-emerald-500/40 shadow-[0_-2px_20px_rgba(16,185,129,0.08)]'
          : isFocused ? 'border-emerald-500/30 shadow-[0_-2px_20px_rgba(16,185,129,0.05)]'
          : 'border-white/[0.06]'
      }`}
        style={running ? { animation: 'pulse-border 2s ease-in-out infinite' } : undefined}>
        <span className={`font-mono text-sm select-none flex-shrink-0 transition-colors ${sentFlash ? 'text-emerald-300' : isFocused ? 'text-emerald-400' : 'text-slate-600'}`}>
          {sentFlash ? '✓' : '$'}
        </span>
        <input ref={inputRef} value={value}
          onChange={e => { setValue(e.target.value); onInputChange(e.target.value); }}
          onKeyDown={handleKeyDown}
          onFocus={onFocusChatBox}
          placeholder={connected ? (running ? 'Command running… (click terminal for interactive)' : 'Type a command… or click terminal for direct input') : 'Disconnected...'}
          disabled={!connected}
          className={`flex-1 bg-transparent text-white font-mono placeholder-slate-600 outline-none caret-emerald-400 transition-opacity ${running ? 'opacity-50' : ''}`}
          style={{ fontSize: '16px' }}
        />
        {value && !running && (
          <button onClick={() => { setValue(''); onInputChange(''); setTimeout(() => inputRef.current?.focus(), 50); }}
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5 transition-colors flex-shrink-0"
            title="Clear">
            <X size={14} />
          </button>
        )}
        {running ? (
          <div className="p-2 rounded-lg bg-emerald-500/15 border border-emerald-500/10">
            <Loader2 size={14} className="text-emerald-400 animate-spin" />
          </div>
        ) : (
          <button onClick={handleSubmit} disabled={!connected || !value.trim()}
            className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-all disabled:opacity-20 disabled:cursor-not-allowed border border-emerald-500/10 text-xs font-medium min-w-[44px] min-h-[44px] flex items-center justify-center"
            style={{ minWidth: '44px', minHeight: '44px' }}>
            Run
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Prompt detection for running indicator ──────────────────────
const PROMPT_PATTERN = /(\$|#|❯|>)\s*$/;

// ─── Terminal theme constant ─────────────────────────────────────
const XTERM_THEME = {
  background: '#0A0E27', foreground: '#F0F4F8', cursor: '#10B981', cursorAccent: '#0A0E27',
  selectionBackground: 'rgba(16, 185, 129, 0.3)',
  black: '#1A1F3A', red: '#EF4444', green: '#10B981', yellow: '#F59E0B',
  blue: '#3B82F6', magenta: '#8B5CF6', cyan: '#06B6D4', white: '#F0F4F8',
  brightBlack: '#475569', brightRed: '#F87171', brightGreen: '#34D399', brightYellow: '#FBBF24',
  brightBlue: '#60A5FA', brightMagenta: '#A78BFA', brightCyan: '#22D3EE', brightWhite: '#FFFFFF',
};

// ─── Per-tab session state (lives outside React to avoid re-renders) ─
interface TabSession {
  terminal: Terminal;
  fitAddon: FitAddon;
  socket: Socket;
  connected: boolean;
  running: boolean;
  outputLines: string[];
  inputBuffer: string;
}

interface PersistedTerminalState {
  tabs: TabDescriptor[];
  activeTabId: string;
}

// ─── Independent Shell Tab Component ─────────────────────────────
// Each instance creates its own PTY socket + xterm terminal.
// The div persists; parent shows/hides via CSS.
function ShellTabSession({ tabId, isActive, onConnectionChange, onRunningChange, onDanger, onShowAssistant, acActiveRef, acSelectedIndexRef, setAcSuggestions, setAcSelectedIndex, setAcVisible, setAcInput }: {
  tabId: string;
  isActive: boolean;
  onConnectionChange: (tabId: string, connected: boolean) => void;
  onRunningChange: (tabId: string, running: boolean) => void;
  onDanger: (cmd: string, message: string) => void;
  onShowAssistant: (tab?: 'lookup' | 'chat') => void;
  acActiveRef: React.MutableRefObject<boolean>;
  acSelectedIndexRef: React.MutableRefObject<number>;
  setAcSuggestions: (s: AutocompleteSuggestion[]) => void;
  setAcSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setAcVisible: (v: boolean) => void;
  setAcInput: (v: string) => void;
}) {
  const termRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TabSession | null>(null);

  // Expose session for parent to read (terminal, socket, etc.)
  // We store it on the DOM element as a data attribute workaround,
  // but better: use a ref map in parent. We'll use a global map.
  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      theme: XTERM_THEME,
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
      fontSize: 14, lineHeight: 1.4, cursorBlink: true, cursorStyle: 'bar',
      allowProposedApi: true, scrollback: 5000, convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    setTimeout(() => fit.fit(), 100);

    const wsUrl = API_URL.replace(/\/api$/, '');
    const socket = io(`${wsUrl}/terminal`, {
      transports: ['polling', 'websocket'],
      reconnection: false,
      withCredentials: true,
    });

    const session: TabSession = {
      terminal: term, fitAddon: fit, socket, connected: false, running: false, outputLines: [], inputBuffer: '',
    };
    sessionRef.current = session;
    // Register in global map so parent can access
    tabSessionMap.set(tabId, session);

    socket.on('connect', () => {
      const resumedAfterDisconnect = reconnectAttempt > 0;
      session.connected = true;
      session.running = false;
      session.inputBuffer = '';
      reconnectAttempt = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      onConnectionChange(tabId, true);
      onRunningChange(tabId, false);
      term.writeln('\r\n\x1b[38;5;240m────────────────────────────────────────\x1b[0m');
      if (resumedAfterDisconnect) {
        term.writeln('\x1b[33m ↻ Connected to a fresh shell\x1b[0m');
        term.writeln('\x1b[38;5;240m   The previous shell could not be resumed after the disconnect.\x1b[0m');
      } else {
        term.writeln('\x1b[32m ✓ Connected to Terminal\x1b[0m');
        term.writeln('\x1b[38;5;240m   Ctrl+K → AI Lookup  ·  Ctrl+T → New Tab\x1b[0m');
        term.writeln('\x1b[38;5;240m   Ctrl+` → Assistant  ·  ⚠️ Dangerous cmds require confirmation\x1b[0m');
      }
      term.writeln('\x1b[38;5;240m────────────────────────────────────────\x1b[0m\r\n');
    });

    // PTY reconnection with exponential backoff
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    socket.on('disconnect', (reason) => {
      session.connected = false;
      session.running = false;
      session.inputBuffer = '';
      onConnectionChange(tabId, false);
      onRunningChange(tabId, false);
      // Don't attempt reconnect if intentionally closed
      if (reason === 'io client disconnect') {
        term.writeln('\r\n\x1b[31m ✗ Disconnected from terminal\x1b[0m');
        term.writeln('\x1b[38;5;240m   Open a new tab or reset the terminal to start a fresh shell.\x1b[0m\r\n');
        return;
      }
      term.writeln('\r\n\x1b[33m ⟳ Connection lost — retrying with a fresh shell...\x1b[0m');
      reconnectAttempt = 0;
      const tryReconnect = () => {
        if (session.connected) return;
        reconnectAttempt++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
        term.writeln(`\x1b[38;5;240m   Attempt ${reconnectAttempt} in ${(delay/1000).toFixed(0)}s...\x1b[0m`);
        reconnectTimer = setTimeout(() => {
          if (!session.connected) socket.connect();
        }, delay);
      };
      tryReconnect();
    });

    socket.on('connect_error', (err: any) => {
      // Continue backoff on connect errors during reconnection.
      // Treat these as transient until we've truly failed repeated recovery.
      if (reconnectAttempt === 0) {
        reconnectAttempt = 1;
        term.writeln('\r\n\x1b[33m ⟳ Terminal connection failed — retrying a fresh shell...\x1b[0m');
      }
      if (reconnectAttempt < 10) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
        term.writeln(`\x1b[38;5;240m   Attempt ${reconnectAttempt} in ${(delay/1000).toFixed(0)}s...\x1b[0m`);
        reconnectTimer = setTimeout(() => {
          if (!session.connected) socket.connect();
        }, delay);
        reconnectAttempt++;
      } else {
        captureError(err || new Error('Terminal socket connect_error'), 'system', 'terminal websocket connect_error');
        term.writeln('\r\n\x1b[31m ✗ Could not start a fresh shell after 10 attempts\x1b[0m\r\n');
      }
    });

    socket.on('output', (data: string) => {
      term.write(data);
      if (PROMPT_PATTERN.test(data.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())) {
        session.running = false;
        onRunningChange(tabId, false);
      }
      const lines = data.split('\n').filter(l => l.trim().length > 0);
      session.outputLines.push(...lines);
      if (session.outputLines.length > 50) session.outputLines = session.outputLines.slice(-50);
    });

    // connect_error handled above in reconnection logic

    // Direct typing in xterm
    term.onData((data) => {
      if (data === '\r' || data === '\n') {
        const cmd = session.inputBuffer.trim();
        const danger = detectDanger(cmd);
        if (danger && cmd.length > 0) {
          // Clear the shell's line buffer so the command doesn't persist in the PTY
          // (characters were already sent keystroke-by-keystroke via socket.emit)
          socket.emit('input', '\x15'); // Ctrl+U clears line in bash/zsh
          onDanger(cmd, danger.message);
          session.inputBuffer = '';
          setAcVisible(false); acActiveRef.current = false;
          return;
        }
        socket.emit('input', data);
        if (cmd) { session.running = true; onRunningChange(tabId, true); }
        session.inputBuffer = '';
        setAcVisible(false); acActiveRef.current = false;
        return;
      }
      socket.emit('input', data);
      if (data === '\x7f' || data === '\b') { session.inputBuffer = session.inputBuffer.slice(0, -1); }
      else if (data === '\x15' || data === '\x03') { session.inputBuffer = ''; setAcVisible(false); }
      else if (data.length === 1 && data.charCodeAt(0) >= 32) { session.inputBuffer += data; }
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (acActiveRef.current) {
        if (e.key === 'ArrowUp' && e.type === 'keydown') { e.preventDefault(); setAcSelectedIndex(prev => Math.max(0, prev - 1)); return false; }
        if (e.key === 'ArrowDown' && e.type === 'keydown') {
          e.preventDefault();
          setAcSelectedIndex(prev => {
            const s = getLocalSuggestions(session.inputBuffer);
            return Math.min(s.length - 1, prev + 1);
          });
          return false;
        }
        if (e.key === 'Tab' && e.type === 'keydown') {
          e.preventDefault();
          const s = getLocalSuggestions(session.inputBuffer);
          if (s.length > 0) {
            const cmd = s[Math.min(acSelectedIndexRef.current, s.length - 1)]?.command || '';
            socket.emit('input', '\x15' + cmd);
            session.inputBuffer = cmd;
            setAcVisible(false); acActiveRef.current = false;
          }
          return false;
        }
        if (e.key === 'Escape' && e.type === 'keydown') { setAcVisible(false); acActiveRef.current = false; return true; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k' && e.type === 'keydown') { e.preventDefault(); onShowAssistant('lookup'); return false; }
      if ((e.ctrlKey || e.metaKey) && e.key === '`' && e.type === 'keydown') { e.preventDefault(); onShowAssistant(); return false; }
      return true;
    });

    term.onResize(({ cols, rows }) => { socket.emit('resize', { cols, rows }); });

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const resizeObs = new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => { try { fit.fit(); } catch {} }, 50);
    });
    resizeObs.observe(termRef.current);

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearTimeout(resizeTimeout);
      resizeObs.disconnect();
      socket.disconnect();
      term.dispose();
      tabSessionMap.delete(tabId);
    };
  }, [tabId, onConnectionChange, onDanger, onRunningChange, onShowAssistant, setAcInput, setAcSelectedIndex, setAcSuggestions, setAcVisible]);

  // Re-fit when becoming active or layout changes
  useEffect(() => {
    if (isActive) {
      setTimeout(() => sessionRef.current?.fitAddon.fit(), 50);
      // Focus the terminal
      sessionRef.current?.terminal.focus();
    }
  }, [isActive]);

  return (
    <div ref={termRef} className="absolute inset-0 p-1"
      style={{ display: isActive ? 'block' : 'none' }} />
  );
}

// Global session map — lets parent access any tab's terminal/socket without React state
const tabSessionMap = new Map<string, TabSession>();

// ─── Simple tab descriptor (no heavy objects in React state) ─────
interface TabDescriptor {
  id: string;
  label: string;
  type: 'shell' | 'chat' | 'openclaw-tui';
}

// ─── OpenClaw TUI Tab (native xterm.js rendering) ────────────────
// The `openclaw tui` command is a full Ink-based TUI that does its own rendering.
// We render it in xterm.js directly and let it handle its own UI.

// ─── OpenClaw Chat Tab (React-based chat UI) ────────────────────
// Replaces xterm-based TUI with proper chat bubbles, system message filtering, and copy support.

interface GatewayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

// Detect system/status messages that should be rendered as faint gray text
function isSystemLine(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return true;
  // Gateway status
  if (cleaned.includes('gateway connected')) return true;
  if (cleaned.includes('gateway reconnected')) return true;
  if (/\|\s*idle/.test(cleaned)) return true;
  if (/agent\s+\w+\s*\|\s*session/.test(cleaned)) return true;
  if (/anthropic\/|openai\/|google\/|meta\//.test(cleaned)) return true;
  if (/tokens?\s+\d+[kmb]?\//i.test(cleaned)) return true;
  if (/\|\s*think\s/.test(cleaned)) return true;
  // Horizontal rules
  if (/^[─\-═]{10,}$/.test(cleaned)) return true;
  // Lines with 2+ pipe separators (status bars)
  if ((cleaned.match(/\|/g) || []).length >= 2 && cleaned.length < 200) return true;
  // Session info
  if (/^session\s+\S+/.test(cleaned)) return true;
  // Connection status
  if (/^(connected|disconnected|connecting|reconnecting)/i.test(cleaned)) return true;
  // Model info  
  if (/^model\s+(set|changed|list)/i.test(cleaned)) return true;
  if (/^thinking\s+set/i.test(cleaned)) return true;
  // Command outputs
  if (/^(history|status|usage)\s*(failed|:)/i.test(cleaned)) return true;
  return false;
}

// Strip webchat metadata from user messages (e.g. "[Sat 2026-02-07 20:07 EST]", "[message_id: ...]")
function cleanUserMessage(text: string): string {
  // Remove timestamp prefix
  let cleaned = text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/m, '');
  // Remove [message_id: ...] lines
  cleaned = cleaned.replace(/\[message_id:\s*[^\]]+\]/g, '').trim();
  return cleaned;
}

// Parse assistant message content into visual sections
function parseMessageSections(content: string): { type: 'text' | 'tool' | 'thinking'; content: string }[] {
  const sections: { type: 'text' | 'tool' | 'thinking'; content: string }[] = [];
  // Split on tool call patterns and thinking blocks
  const lines = content.split('\n');
  let currentType: 'text' | 'tool' | 'thinking' = 'text';
  let currentLines: string[] = [];

  const flush = () => {
    const text = currentLines.join('\n').trim();
    if (text) sections.push({ type: currentType, content: text });
    currentLines = [];
  };

  for (const line of lines) {
    if (/^(🔧|Tool|Running|Executing|tool_call|<tool)/i.test(line.trim())) {
      flush();
      currentType = 'tool';
      currentLines.push(line);
    } else if (/^(🧠|Thinking|<thinking)/i.test(line.trim())) {
      flush();
      currentType = 'thinking';
      currentLines.push(line);
    } else if (currentType !== 'text' && line.trim() === '') {
      flush();
      currentType = 'text';
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ type: 'text', content }];
}

// Truncatable message content
function TruncatableContent({ content, maxHeight = 300 }: { content: string; maxHeight?: number }) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsTruncation, setNeedsTruncation] = useState(false);

  useEffect(() => {
    if (contentRef.current && contentRef.current.scrollHeight > maxHeight) {
      setNeedsTruncation(true);
    }
  }, [content, maxHeight]);

  const sections = parseMessageSections(content);

  return (
    <div>
      <div
        ref={contentRef}
        className={!expanded && needsTruncation ? 'overflow-hidden' : ''}
        style={!expanded && needsTruncation ? { maxHeight: `${maxHeight}px` } : undefined}
      >
        {sections.map((section, i) => (
          <div key={i}>
            {sections.length > 1 && i > 0 && (
              <div className="border-t border-white/5 my-1.5" />
            )}
            {section.type === 'tool' && (
              <div className="text-[10px] text-amber-400/60 font-medium mb-0.5">🔧 Tool</div>
            )}
            {section.type === 'thinking' && (
              <div className="text-[10px] text-purple-400/60 font-medium mb-0.5">🧠 Thinking</div>
            )}
            <div className={`text-sm whitespace-pre-wrap break-words leading-relaxed ${
              section.type === 'tool' ? 'text-amber-200/80 font-mono text-xs pl-2 border-l border-amber-500/20' :
              section.type === 'thinking' ? 'text-purple-200/70 italic text-xs pl-2 border-l border-purple-500/20' :
              ''
            }`}>
              {section.content}
            </div>
          </div>
        ))}
      </div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-emerald-400 hover:text-emerald-300 mt-1"
        >
          {expanded ? '▲ Show less' : '▼ Show more...'}
        </button>
      )}
    </div>
  );
}

function OpenClawTUITab({ tabId, isActive, onConnectionChange }: {
  tabId: string; isActive: boolean; onConnectionChange: (tabId: string, connected: boolean) => void;
}) {
  const [messages, setMessages] = useState<GatewayMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [selectedSession, setSelectedSession] = useState('agent:main:main');
  const [availableSessions, setAvailableSessions] = useState<Array<{ key: string; updatedAt?: number; label?: string; agentId?: string }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const streamControllerRef = useRef<AbortController | null>(null);
  const statusSocketRef = useRef<Socket | null>(null);
  const selectedSessionRef = useRef('agent:main:main');

  const createFreshSessionKey = useCallback(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 8);
    return `agent:main:portal-${stamp}-${random}`;
  }, []);

  // Load history on mount + connect status socket
  useEffect(() => {
    loadSessions();
    loadHistory(selectedSessionRef.current);
    // Poll for new messages every 3 seconds
    pollRef.current = setInterval(() => pollMessages(selectedSessionRef.current), 3000);

    // Connect to OpenClaw status socket
    const statusSocket = io('/openclaw-status', { transports: ['websocket'] });
    statusSocketRef.current = statusSocket;
    statusSocket.on('status', (data: any) => {
      if (data.session !== 'main') return;
      if (data.type === 'thinking') {
        const shortModel = getShortModelLabel(data.model);
        setStatusText(`🧠 Thinking${shortModel ? ` (${shortModel})` : ''}...`);
      } else if (data.type === 'tool_start') {
        setStatusText(`🔧 Running ${data.tool}...`);
      } else if (data.type === 'tool_end') {
        setStatusText('🧠 Thinking...');
      } else if (data.type === 'streaming') {
        setStatusText('✍️ Writing...');
      } else if (data.type === 'done') {
        setStatusText('');
      }
    });

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      statusSocket.disconnect();
      streamControllerRef.current?.abort();
    };
  }, []);

  // Auto-scroll on new messages (with rAF to ensure DOM is updated)
  useEffect(() => {
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, [messages, streamingText]);

  // Focus input when tab becomes active
  useEffect(() => {
    if (isActive) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isActive]);

  const humanizeSession = (session: { key: string; label?: string }) => {
    if (session.label) return session.label;
    if (session.key === 'agent:main:main') return 'Main session';
    return session.key.split(':').slice(2).join(':') || session.key;
  };

  const loadSessions = async () => {
    try {
      const data = await gatewayAPI.sessions();
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const filtered = sessions
        .filter((s: any) => typeof s.key === 'string' && s.key.startsWith('agent:'))
        .filter((s: any) => !s.key.includes(':run:'))
        .sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0));
      setAvailableSessions(filtered);
      if (!filtered.some((s: any) => s.key === selectedSessionRef.current)) {
        const fallback = filtered[0]?.key || 'agent:main:main';
        selectedSessionRef.current = fallback;
        setSelectedSession(fallback);
      }
      return filtered;
    } catch {
      return [];
    }
  };

  const loadHistory = async (sessionKey = selectedSessionRef.current) => {
    try {
      const data = await gatewayAPI.history(sessionKey);
      if (data.messages?.length) {
        const processed = processMessages(data.messages);
        setMessages(processed);
        lastMessageIdRef.current = data.messages[data.messages.length - 1]?.id || null;
      } else {
        setMessages([]);
        lastMessageIdRef.current = null;
      }
      setConnected(true);
      onConnectionChange(tabId, true);
      setError('');
    } catch (err: any) {
      setError('Failed to connect to gateway');
      setConnected(false);
      onConnectionChange(tabId, false);
    }
  };

  const pollMessages = async (sessionKey = selectedSessionRef.current) => {
    try {
      const data = await gatewayAPI.history(sessionKey, lastMessageIdRef.current || undefined);
      if (data.messages?.length) {
        const processed = processMessages(data.messages);
        setMessages(prev => {
          const next = [...prev];
          for (const msg of processed) {
            if (!next.some(existing => existing.id === msg.id)) next.push(msg);
          }
          return next;
        });
        lastMessageIdRef.current = data.messages[data.messages.length - 1]?.id || null;
      }
      if (!connected) {
        setConnected(true);
        onConnectionChange(tabId, true);
      }
    } catch {
      // Silently fail on poll errors
    }
  };

  const processMessages = (msgs: any[]): GatewayMessage[] => {
    return msgs.map(m => {
      const content = m.content || '';
      // Check if it's a system message
      const lines = content.split('\n');
      const allSystem = lines.every((l: string) => isSystemLine(l));
      
      return {
        id: m.id,
        role: allSystem ? 'system' : m.role,
        content: m.role === 'user' ? cleanUserMessage(content) : content,
        timestamp: m.timestamp,
      };
    });
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const msg = input.trim();
    setInput('');
    
    // Add user message immediately
    const userMsg: GatewayMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: msg,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    setStreamingText('');
    setStatusText('🧠 Thinking...');

    const controller = gatewayAPI.sendStream(msg, 'main', {
      onStatus: (content) => setStatusText(content),
      onText: (chunk) => {
        setStreamingText(prev => prev + chunk);
        setStatusText('✍️ Writing...');
      },
      onDone: (fullText) => {
        setStreamingText('');
        setStatusText('');
        setLoading(false);
        const assistantMsg: GatewayMessage = {
          id: `resp-${Date.now()}`,
          role: 'assistant',
          content: fullText,
          timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, assistantMsg]);
      },
      onError: (error) => {
        setStreamingText('');
        setStatusText('');
        setLoading(false);
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}`,
          role: 'system',
          content: `Failed: ${error}`,
          timestamp: new Date().toISOString(),
        }]);
      },
    });
    streamControllerRef.current = controller;
  };

  const handleNewSession = async () => {
    const freshSession = createFreshSessionKey();
    selectedSessionRef.current = freshSession;
    setSelectedSession(freshSession);
    setAvailableSessions(prev => [{ key: freshSession, updatedAt: Date.now() }, ...prev.filter(s => s.key !== freshSession)]);
    setMessages([]);
    setError('');
    setLoading(true);
    setStreamingText('');
    setStatusText('Starting fresh session...');
    lastMessageIdRef.current = null;

    const streamController = new AbortController();
    streamControllerRef.current = streamController;

    try {
      await gatewayAPI.sendStream('/new', freshSession, {
        onStatus: (status) => setStatusText(status),
        onText: () => setStatusText('✍️ Writing...'),
        onDone: async () => {
          setLoading(false);
          setStreamingText('');
          setStatusText('');
          streamControllerRef.current = null;
          await loadSessions();
          await loadHistory(freshSession);
        },
        onError: (error) => {
          setLoading(false);
          setStreamingText('');
          setStatusText('');
          setError(error || 'Failed to start a fresh session');
          streamControllerRef.current = null;
        },
      });
    } catch (err: any) {
      setLoading(false);
      setStatusText('');
      setError(err?.message || 'Failed to start a fresh session');
      streamControllerRef.current = null;
    }
  };

  const handleCopy = async () => {
    const text = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : 'You';
        return `${role}: ${m.content}`;
      })
      .join('\n\n');
    
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  if (!isActive) return null;

  return (
    <div className="flex flex-col h-full bg-[#0A0E27]">
      {/* Chat header with copy button */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
          <span className="text-xs text-slate-400">
            {connected ? 'Connected to Assistant' : 'Connecting...'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedSession}
            onChange={(e) => {
              const next = e.target.value;
              selectedSessionRef.current = next;
              setSelectedSession(next);
              setMessages([]);
              setError('');
              setStreamingText('');
              setStatusText('');
              lastMessageIdRef.current = null;
              loadHistory(next);
            }}
            className="max-w-[220px] text-xs px-2 py-1 rounded-lg bg-white/5 text-slate-300 border border-white/10 hover:border-white/20 focus:outline-none"
            title="Switch session"
          >
            {availableSessions.map((session) => (
              <option key={session.key} value={session.key}>{humanizeSession(session as any)}</option>
            ))}
          </select>
          <button
            onClick={handleNewSession}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 border border-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles size={12} />
            New Session
          </button>
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              copied
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 border border-white/10'
            }`}
          >
            <Copy size={12} />
            {copied ? 'Copied!' : 'Copy Chat'}
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-auto px-4 py-4 space-y-3">
        {error && (
          <div className="text-center text-red-400 text-sm py-4">{error}</div>
        )}
        
        {messages.length === 0 && !error && (
          <div className="text-center text-slate-500 text-sm py-8">
            <Sparkles size={24} className="mx-auto mb-2 text-emerald-400/40" />
            <p>Chat with Assistant</p>
            <p className="text-xs text-slate-600 mt-1">Messages from your current session will appear here</p>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === 'system') {
            return (
              <div key={msg.id} className="text-center text-slate-500 text-xs my-1 opacity-50 italic select-none">
                {msg.content}
              </div>
            );
          }

          const isUser = msg.role === 'user';
          return (
            <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                isUser
                  ? 'bg-emerald-500/20 text-emerald-50 border border-emerald-500/20'
                  : 'bg-white/[0.06] text-slate-200 border border-white/[0.06]'
              }`}>
                <div className="text-[10px] font-medium mb-1 opacity-50">
                  {isUser ? 'You' : 'Assistant'}
                </div>
                {isUser ? (
                  <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">{msg.content}</div>
                ) : (
                  <TruncatableContent content={msg.content} />
                )}
                <div className="text-[9px] opacity-30 mt-1 text-right">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          );
        })}

        {loading && streamingText && (
          <div className="flex justify-start">
            <div className="bg-white/[0.06] rounded-2xl px-4 py-3 border border-white/[0.06] max-w-[80%]">
              <div className="text-[10px] font-medium mb-1 opacity-50">Assistant</div>
              <TruncatableContent content={streamingText} maxHeight={400} />
              <span className="inline-block w-1.5 h-4 bg-emerald-400 animate-pulse ml-0.5 align-text-bottom" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Status indicator - fixed position above input */}
      {loading && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-t border-white/5 bg-[#0A0E27]/95 flex-shrink-0">
          <Loader2 size={12} className="text-emerald-400 animate-spin" />
          <span className="text-[11px] text-slate-400">{statusText || '🧠 Thinking...'}</span>
        </div>
      )}

      {/* Input */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-white/5 bg-[#080B20]/95 flex-shrink-0">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
          placeholder={connected ? 'Type a message...' : 'Connecting...'}
          disabled={!connected || loading}
          className="flex-1 bg-transparent text-white placeholder-slate-600 outline-none text-sm"
          style={{ fontSize: '16px' }}
        />
        <button
          onClick={handleSend}
          disabled={!connected || !input.trim() || loading}
          className="p-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-all disabled:opacity-20 border border-emerald-500/20"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

// ─── Main Terminal Page ──────────────────────────────────────────
export default function TerminalPage() {
  const [fullscreen, setFullscreen] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [inputMode, setInputMode] = useState<'chat' | 'terminal'>('chat');
  // Shared context toggle for both Lookup and chat box autocomplete
  const [sharedContextEnabled, setSharedContextEnabled] = useState(true);

  const buildDefaultState = (): PersistedTerminalState => {
    const tabId = `tab-${Date.now()}`;
    return {
      tabs: [{ id: tabId, label: 'bash', type: 'shell' }],
      activeTabId: tabId,
    };
  };

  const readInitialState = (): PersistedTerminalState => {
    try {
      const raw = sessionStorage.getItem(TERMINAL_STATE_STORAGE_KEY);
      if (!raw) return buildDefaultState();
      const parsed = JSON.parse(raw) as PersistedTerminalState;
      if (!Array.isArray(parsed?.tabs) || parsed.tabs.length === 0) return buildDefaultState();
      const normalizedTabs = parsed.tabs.filter((t) => t?.id && (t.type === 'shell' || t.type === 'chat' || t.type === 'openclaw-tui'));
      if (normalizedTabs.length === 0) return buildDefaultState();
      const activeTabExists = normalizedTabs.some((t) => t.id === parsed.activeTabId);
      return {
        tabs: normalizedTabs,
        activeTabId: activeTabExists ? parsed.activeTabId : normalizedTabs[0].id,
      };
    } catch {
      return buildDefaultState();
    }
  };

  // Tabs — lightweight descriptors only, heavy state in tabSessionMap
  const initialState = useMemo(() => readInitialState(), []);
  const [tabs, setTabs] = useState<TabDescriptor[]>(initialState.tabs);
  const [activeTabId, setActiveTabId] = useState(initialState.activeTabId);

  // Per-tab connection/running state (kept in React for UI)
  const [tabStates, setTabStates] = useState<Record<string, { connected: boolean; running: boolean }>>({});

  // Autocomplete state (shared — only active tab drives it)
  const [acSuggestions, setAcSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [acSelectedIndex, setAcSelectedIndex] = useState(0);
  const [acVisible, setAcVisible] = useState(false);
  const [acInput, setAcInput] = useState('');
  const acActiveRef = useRef(false);
  const acSelectedIndexRef = useRef(0);
  useEffect(() => { acSelectedIndexRef.current = acSelectedIndex; }, [acSelectedIndex]);

  // Danger warning
  const [dangerWarning, setDangerWarning] = useState<{ command: string; message: string; tabId: string } | null>(null);
  const [clearTrigger, setClearTrigger] = useState(0);

  const INPUT_BAR_HEIGHT = 48;

  const activeState = tabStates[activeTabId] || { connected: false, running: false };

  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const newTabMenuRef = useRef<HTMLDivElement>(null);
  const newTabButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const snapshot: PersistedTerminalState = {
      tabs,
      activeTabId,
    };
    sessionStorage.setItem(TERMINAL_STATE_STORAGE_KEY, JSON.stringify(snapshot));
  }, [tabs, activeTabId]);

  // Create tab
  const createTab = useCallback((type: 'shell' | 'chat' | 'openclaw-tui' = 'shell') => {
    if (tabs.length >= 5) return;
    const id = `tab-${Date.now()}`;
    let label: string;
    if (type === 'shell') { const shellCount = tabs.filter(t => t.type === 'shell').length; label = `bash ${shellCount + 1}`; }
    else if (type === 'openclaw-tui') { label = '💬 OpenClaw'; }
    else { label = '💬 Assistant'; }
    setTabs(prev => [...prev, { id, label, type }]);
    setActiveTabId(id);
    setShowNewTabMenu(false);
  }, [tabs]);

  // Close tab
  const closeTab = useCallback((tabId: string) => {
    if (tabs.length <= 1) return;
    // Session cleanup happens in ShellTabSession's useEffect return
    setTabs(prev => prev.filter(t => t.id !== tabId));
    if (activeTabId === tabId) {
      setActiveTabId(prev => {
        const remaining = tabs.filter(t => t.id !== tabId);
        return remaining[remaining.length - 1]?.id || remaining[0]?.id || '';
      });
    }
  }, [tabs, activeTabId]);

  // Callbacks from child sessions
  const handleConnectionChange = useCallback((tabId: string, connected: boolean) => {
    setTabStates(prev => ({ ...prev, [tabId]: { ...prev[tabId], connected, running: prev[tabId]?.running || false } }));
  }, []);

  const handleRunningChange = useCallback((tabId: string, running: boolean) => {
    setTabStates(prev => ({ ...prev, [tabId]: { ...prev[tabId], connected: prev[tabId]?.connected || false, running } }));
  }, []);

  const handleDanger = useCallback((cmd: string, message: string) => {
    setDangerWarning({ command: cmd, message, tabId: activeTabId });
  }, [activeTabId]);

  const handleShowAssistant = useCallback((tab?: 'lookup' | 'chat') => {
    setShowAssistant(prev => tab ? true : !prev);
  }, []);

  // Execute command on active tab's socket
  const executeCommand = useCallback((cmd: string) => {
    const danger = detectDanger(cmd);
    if (danger) { setDangerWarning({ command: cmd, message: danger.message, tabId: activeTabId }); return; }
    const session = tabSessionMap.get(activeTabId);
    if (session) {
      sounds.click();
      session.socket.emit('input', cmd + '\n');
      session.running = true;
      handleRunningChange(activeTabId, true);
    }
  }, [activeTabId, handleRunningChange]);

  const insertCommand = useCallback((cmd: string) => {
    executeCommand(cmd);
    setClearTrigger(prev => prev + 1);
  }, [executeCommand]);

  const forceExecuteCommand = useCallback(() => {
    if (dangerWarning) {
      const session = tabSessionMap.get(dangerWarning.tabId);
      if (session) {
        session.socket.emit('input', dangerWarning.command + '\n');
        session.running = true;
        handleRunningChange(dangerWarning.tabId, true);
      }
    }
    setDangerWarning(null);
  }, [dangerWarning, handleRunningChange]);

  const cancelDangerCommand = useCallback(() => { setDangerWarning(null); }, []);

  const handleInputBarSubmit = useCallback((cmd: string) => { executeCommand(cmd); }, [executeCommand]);

  const handleInputBarChange = useCallback((value: string) => {
    if (value.length < 2) { setAcVisible(false); acActiveRef.current = false; return; }
    const suggestions = getLocalSuggestions(value);
    if (suggestions.length > 0) {
      setAcSuggestions(suggestions); setAcSelectedIndex(0); setAcInput(value);
      setAcVisible(true); acActiveRef.current = true;
    } else { setAcVisible(false); acActiveRef.current = false; }
  }, []);

  const handleAcSelect = useCallback((cmd: string) => {
    executeCommand(cmd);
    setAcVisible(false); acActiveRef.current = false;
  }, [executeCommand]);

  const getFullBuffer = useCallback(() => {
    const session = tabSessionMap.get(activeTabId);
    if (!session) return '';
    const buf = session.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n').trimEnd().slice(-8000);
  }, [activeTabId]);

  // Close new tab menu on outside click
  useEffect(() => {
    if (!showNewTabMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Don't close if clicking the menu itself or the button that opens it
      if (
        (newTabMenuRef.current && newTabMenuRef.current.contains(target)) ||
        (newTabButtonRef.current && newTabButtonRef.current.contains(target))
      ) {
        return;
      }
      setShowNewTabMenu(false);
    };
    // Use requestAnimationFrame to ensure the click that opened the menu completes first
    const rafId = requestAnimationFrame(() => {
      document.addEventListener('click', handler);
    });
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('click', handler);
    };
  }, [showNewTabMenu]);

  const activeTabType = tabs.find(t => t.id === activeTabId)?.type || 'shell';

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowAssistant(true); }
      if ((e.ctrlKey || e.metaKey) && e.key === '`') { e.preventDefault(); setShowAssistant(prev => !prev); }
      if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); createTab('shell'); }
      if (e.key === 'Escape' && inputMode === 'chat') {
        setInputMode('terminal');
        const session = tabSessionMap.get(activeTabId);
        if (session) session.terminal.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); closeTab(activeTabId); }
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '5') {
        const idx = parseInt(e.key) - 1;
        if (idx < tabs.length) { e.preventDefault(); setActiveTabId(tabs[idx].id); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabId, createTab, closeTab]);

  // Re-fit active terminal on layout changes
  useEffect(() => {
    // Fit after a short delay and again after animations settle
    const t1 = setTimeout(() => {
      const session = tabSessionMap.get(activeTabId);
      try { session?.fitAddon.fit(); } catch {}
    }, 100);
    const t2 = setTimeout(() => {
      const session = tabSessionMap.get(activeTabId);
      try { session?.fitAddon.fit(); } catch {}
    }, 400);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [fullscreen, showAssistant, activeTabId]);

  // Global window resize handler — fit all visible terminals
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        tabSessionMap.forEach((session) => {
          try { session.fitAddon.fit(); } catch {}
        });
      }, 150);
    };
    window.addEventListener('resize', handleResize);
    // Also handle orientation change for tablets
    window.addEventListener('orientationchange', () => {
      setTimeout(handleResize, 300);
    });
    return () => {
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className={`flex flex-col ${fullscreen ? 'fixed inset-0 z-50 bg-[#0A0E27]' : 'h-full min-h-0 overflow-hidden'}`}>

      {/* Danger Warning Modal */}
      <AnimatePresence>
        {dangerWarning && <DangerWarningModal command={dangerWarning.command} message={dangerWarning.message} onConfirm={forceExecuteCommand} onCancel={cancelDangerCommand} />}
      </AnimatePresence>

      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 border-b border-white/5 bg-[#0D1130]/80 backdrop-blur-xl flex-shrink-0" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0.5rem))' }}>
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
          <TermIcon size={16} className="text-emerald-400 flex-shrink-0" />
          <span className="font-medium text-sm hidden sm:inline">Terminal</span>
          <span className={`inline-flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${activeState.connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${activeState.connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
            <span className="hidden sm:inline">{activeState.connected ? 'Connected' : 'Disconnected'}</span>
          </span>
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <button onClick={() => setShowAssistant(true)}
            className="flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-colors text-xs font-medium border border-emerald-500/20 mr-0.5 sm:mr-1 min-w-[44px] min-h-[44px] justify-center"
            title="Assistant (Ctrl+` to toggle)">
            <Sparkles size={13} />
            <span className="hidden md:inline">Assistant</span>
          </button>
          {activeTabType === 'shell' && (
            <>
              <button onClick={() => {
                  const s = tabSessionMap.get(activeTabId);
                  s?.terminal.clear();
                }}
                className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center" title="Clear"><Trash2 size={15} /></button>
              <button onClick={() => {
                  const s = tabSessionMap.get(activeTabId);
                  if (s) { s.terminal.reset(); s.socket.emit('input', '\x03'); }
                }}
                className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center hidden sm:flex" title="Reset"><RotateCcw size={15} /></button>
              <button onClick={async () => {
                  const s = tabSessionMap.get(activeTabId);
                  const sel = s?.terminal.getSelection();
                  if (sel) { try { await navigator.clipboard.writeText(sel); } catch {} }
                }}
                className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center hidden sm:flex" title="Copy"><Copy size={15} /></button>
            </>
          )}
          <button onClick={() => setFullscreen(!fullscreen)} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center" title="Fullscreen">
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex items-center bg-[#080B20] border-b border-white/5 px-2 overflow-x-auto overflow-y-visible flex-shrink-0 scrollbar-none relative">
        {tabs.map(tab => {
          const state = tabStates[tab.id];
          return (
            <button key={tab.id} onClick={() => setActiveTabId(tab.id)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
                tab.id === activeTabId
                  ? 'border-emerald-400 text-emerald-400 bg-emerald-500/5'
                  : 'border-transparent text-slate-500 hover:text-slate-300 hover:bg-white/[0.02]'
              }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${state?.connected ? 'bg-emerald-400' : 'bg-slate-500'}`} />
              🟢 {tab.label}
              {state?.running && <Loader2 size={10} className="text-emerald-400 animate-spin" />}
              {tabs.length > 1 && (
                <span onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                  className="ml-1 p-0.5 rounded hover:bg-white/10 text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all">
                  <X size={10} />
                </span>
              )}
            </button>
          );
        })}
        <div className="relative">
          <button ref={newTabButtonRef} onClick={() => setShowNewTabMenu(prev => !prev)} disabled={tabs.length >= 5}
            className="flex items-center gap-1 px-2 py-1.5 text-slate-600 hover:text-emerald-400 transition-colors disabled:opacity-20 cursor-pointer disabled:cursor-not-allowed"
            title="New tab (Ctrl+T)">
            <Plus size={14} />
          </button>
          {showNewTabMenu && createPortal(
            <div ref={newTabMenuRef} style={{
              position: 'fixed',
              left: newTabButtonRef.current ? newTabButtonRef.current.getBoundingClientRect().left : 0,
              top: newTabButtonRef.current ? newTabButtonRef.current.getBoundingClientRect().bottom + 4 : 0,
            }} className="w-48 bg-[#0D1130]/95 border border-white/10 rounded-xl shadow-2xl backdrop-blur-xl z-[9999] overflow-hidden" onClick={e => e.stopPropagation()}>
              <button onClick={(e) => { e.stopPropagation(); createTab('shell'); setShowNewTabMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-emerald-500/10 hover:text-emerald-400 transition-colors">
                <span>🟢</span> New Terminal
              </button>
            </div>,
            document.body
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* All terminal sessions — each has own div, shown/hidden */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 relative">
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative" onClick={() => {
            if (activeTabType === 'shell') {
              setInputMode('terminal');
              const session = tabSessionMap.get(activeTabId);
              if (session) session.terminal.focus();
            }
          }}>
            {tabs.filter(t => t.type === 'shell').map(tab => (
              <ShellTabSession
                key={tab.id}
                tabId={tab.id}
                isActive={tab.id === activeTabId}
                onConnectionChange={handleConnectionChange}
                onRunningChange={handleRunningChange}
                onDanger={handleDanger}
                onShowAssistant={handleShowAssistant}
                acActiveRef={acActiveRef}
                acSelectedIndexRef={acSelectedIndexRef}
                setAcSuggestions={setAcSuggestions}
                setAcSelectedIndex={setAcSelectedIndex}
                setAcVisible={setAcVisible}
                setAcInput={setAcInput}
              />
            ))}
            {tabs.filter(t => t.type === 'openclaw-tui').map(tab => (
              <OpenClawTUITab
                key={tab.id}
                tabId={tab.id}
                isActive={tab.id === activeTabId}
                onConnectionChange={handleConnectionChange}
              />
            ))}
          </div>

          {activeTabType === 'shell' && (
            <>
              {/* tool preset command groups */}
              <div className="px-3 py-2 border-t border-white/5 bg-[#080B20]/85">
                <div className="flex flex-wrap gap-3">
                  {TOOL_PRESET_GROUPS.map((group) => (
                    <div key={group.tool} className="min-w-[180px]">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{group.tool}</div>
                      <div className="flex flex-wrap gap-1">
                        {group.commands.map((cmd) => (
                          <button
                            key={cmd}
                            onClick={() => executeCommand(cmd)}
                            className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-emerald-500/10 text-[10px] text-slate-300 hover:text-emerald-300 font-mono"
                          >
                            {cmd}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <ChatBoxInput onSubmit={handleInputBarSubmit} onInputChange={handleInputBarChange}
                connected={activeState.connected} running={activeState.running} externalClear={clearTrigger}
                inputMode={inputMode} onFocusChatBox={() => setInputMode('chat')}
                contextEnabled={sharedContextEnabled} getFullBuffer={getFullBuffer} />
            </>
          )}
        </div>

        {/* Assistant Panel */}
        <AnimatePresence>
          {showAssistant && (
            <AssistantAIPanel isOpen={showAssistant} onClose={() => setShowAssistant(false)}
              onInsert={insertCommand} getFullBuffer={getFullBuffer}
              contextEnabled={sharedContextEnabled} setContextEnabled={setSharedContextEnabled} />
          )}
        </AnimatePresence>
      </div>

      {/* CSS for pulse animation and responsive fixes */}
      <style>{`
        @keyframes pulse-border {
          0%, 100% { border-color: rgba(16, 185, 129, 0.2); }
          50% { border-color: rgba(16, 185, 129, 0.5); }
        }
        .scrollbar-none::-webkit-scrollbar { display: none; }
        .scrollbar-none { -ms-overflow-style: none; scrollbar-width: none; }
        /* Ensure xterm fills container */
        .xterm { height: 100% !important; }
        .xterm-viewport { overflow-y: auto !important; }
        .xterm-screen { height: 100% !important; }
        /* Tablet: Assistant panel overlays instead of pushing */
        @media (max-width: 1024px) {
          .assistant-panel-container {
            position: absolute !important;
            right: 0;
            top: 0;
            bottom: 0;
            z-index: 60;
          }
        }
      `}</style>
    </motion.div>
  );
}
