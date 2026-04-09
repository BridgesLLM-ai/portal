import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { config } from '../config/env';
import { prisma } from '../config/database';

const router = Router();
router.use(authenticateToken, requireAdmin);

// Resolve model from tier settings + current backend (GPU/CPU)
async function resolveModelFromTier(tier: string | undefined, explicitModel?: string): Promise<string> {
  // Explicit model overrides tier
  if (explicitModel && explicitModel.trim()) return explicitModel;

  const validTier = ['snappy', 'smart', 'best'].includes(tier || '') ? tier : 'smart';

  // Detect current backend (GPU or CPU) from the proxy
  let isGpu = false;
  try {
    const res = await fetch(`${config.ollamaApiUrl}/api/version`, { signal: AbortSignal.timeout(2000) });
    isGpu = res.headers.get('x-ollama-backend') === 'gpu-remote';
  } catch {}

  const prefix = isGpu ? 'ollama.remote.tier' : 'ollama.local.tier';
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

// POST /api/terminal/lookup - AI-powered natural language → command generation
router.post('/lookup', async (req: Request, res: Response) => {
  try {
    const { query, context, model, tier } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }
    const ollamaModel = await resolveModelFromTier(tier, model);

    const systemPrompt = `You are a Linux command-line expert. You MUST respond with ONLY valid JSON, no other text.

REQUIRED JSON FORMAT:
{"commands":[{"command":"the command","explanation":"what it does","warning":null}],"summary":"one sentence"}

Example response:
{"commands":[{"command":"ls -la","explanation":"List all files with details","warning":null}],"summary":"List files in current directory"}

Server: Ubuntu 24.04 LTS with docker, git, npm, node, ollama, nginx, openclaw, tailscale, pm2, postgres.
Flag dangerous commands with warnings. Keep explanations brief.`;

    // Build prompt with optional terminal context (limited to 4000 chars)
    let fullPrompt = systemPrompt;
    if (context && typeof context === 'string' && context.trim()) {
      fullPrompt += `\n\nTerminal context:\n${context.slice(-4000)}`;
    }
    fullPrompt += `\n\nUser request: ${query}\n\nRespond with ONLY JSON:`;

    // Try Ollama
    try {
      const response = await fetch(`${config.ollamaApiUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: fullPrompt,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.3,
            num_predict: 512,
            num_ctx: 4096,
          },
        }),
        signal: AbortSignal.timeout(120000), // 120s timeout (larger models need cold-load time)
      });

      if (response.ok) {
        const data = await response.json() as any;
        const rawResponse = (data.response || '').trim();
        console.log('[AI Debug] Model:', ollamaModel, 'Query:', query.slice(0, 80));
        console.log('[AI Debug] Raw response:', rawResponse.slice(0, 500));
        
        try {
          const parsed = JSON.parse(rawResponse);
          // Validate structure
          if (parsed.commands && Array.isArray(parsed.commands)) {
            res.json({ ...parsed, model: ollamaModel, source: 'ollama' });
            return;
          }
          // Model returned JSON but wrong structure - try to adapt
          if (parsed.command) {
            res.json({
              commands: [{ command: parsed.command, explanation: parsed.explanation || '', warning: parsed.warning || null }],
              summary: parsed.summary || parsed.explanation || '',
              model: ollamaModel, source: 'ollama',
            });
            return;
          }
        } catch (parseErr) {
          console.log('[AI Debug] JSON parse failed, attempting fallback extraction');
        }
        
        // Fallback: try to extract commands from backticks in plain text
        const backtickMatches = rawResponse.match(/`([^`]+)`/g);
        if (backtickMatches && backtickMatches.length > 0) {
          const commands = backtickMatches.slice(0, 5).map((m: string) => ({
            command: m.replace(/`/g, ''),
            explanation: 'Extracted from AI response',
            warning: null,
          }));
          res.json({ commands, summary: rawResponse.split('\n')[0].slice(0, 200), model: ollamaModel, source: 'ollama' });
          return;
        }
        
        // Last resort: if response looks like a command (short, no spaces or starts with known tools)
        if (rawResponse.length < 200 && !rawResponse.includes('{')) {
          res.json({
            commands: [{ command: rawResponse.split('\n')[0], explanation: 'AI suggestion', warning: null }],
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
      }
    } catch {
      // Ollama not available
    }

    res.json({
      commands: [],
      summary: 'Ollama is not available. Please ensure Ollama is running with one of your configured local models.',
      model: 'unavailable',
      source: 'none',
    });
  } catch (error) {
    console.error('Terminal lookup error:', error);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// GET /api/terminal/autocomplete - Get command completions
router.get('/autocomplete', async (req: Request, res: Response) => {
  try {
    const prefix = (req.query.prefix as string || '').trim();
    if (!prefix) {
      res.json({ suggestions: [] });
      return;
    }

    const matches = getAutocompleteSuggestions(prefix);
    res.json({ suggestions: matches.slice(0, 12) });
  } catch (error) {
    res.status(500).json({ error: 'Autocomplete failed' });
  }
});

// 500+ Command database
interface CommandSuggestion {
  command: string;
  description: string;
  category: string;
  dangerous?: boolean;
}

const COMMAND_DB: CommandSuggestion[] = [
  // OpenClaw
  { command: 'openclaw help', description: 'Show OpenClaw help', category: 'openclaw' },
  { command: 'openclaw gateway status', description: 'Check gateway daemon status', category: 'openclaw' },
  { command: 'openclaw gateway start', description: 'Start the gateway daemon', category: 'openclaw' },
  { command: 'openclaw gateway stop', description: 'Stop the gateway daemon', category: 'openclaw' },
  { command: 'openclaw gateway restart', description: 'Restart the gateway daemon', category: 'openclaw' },
  { command: 'openclaw gateway logs', description: 'View gateway logs', category: 'openclaw' },
  { command: 'openclaw version', description: 'Show version', category: 'openclaw' },
  { command: 'openclaw config', description: 'View/edit config', category: 'openclaw' },
  { command: 'openclaw cron list', description: 'List cron jobs', category: 'openclaw' },
  { command: 'openclaw cron add', description: 'Add cron job', category: 'openclaw' },
  { command: 'openclaw status', description: 'Overall status', category: 'openclaw' },

  // Tailscale
  { command: 'tailscale status', description: 'Show Tailscale network status', category: 'tailscale' },
  { command: 'tailscale ip', description: 'Show Tailscale IP addresses', category: 'tailscale' },
  { command: 'tailscale ping', description: 'Ping a Tailscale peer', category: 'tailscale' },
  { command: 'tailscale netcheck', description: 'Run network connectivity check', category: 'tailscale' },
  { command: 'tailscale up', description: 'Connect to Tailscale', category: 'tailscale' },
  { command: 'tailscale down', description: 'Disconnect', category: 'tailscale' },
  { command: 'tailscale logout', description: 'Log out', category: 'tailscale', dangerous: true },
  { command: 'tailscale cert', description: 'Get TLS certificate', category: 'tailscale' },
  { command: 'tailscale file send', description: 'Send via Taildrop', category: 'tailscale' },
  { command: 'tailscale ssh', description: 'SSH via Tailscale', category: 'tailscale' },
  { command: 'tailscale funnel', description: 'Expose publicly', category: 'tailscale' },
  { command: 'tailscale serve', description: 'Serve content', category: 'tailscale' },

  // Ollama
  { command: 'ollama list', description: 'List installed models', category: 'ollama' },
  { command: 'ollama run mistral', description: 'Run mistral', category: 'ollama' },
  { command: 'ollama pull', description: 'Pull/download a model', category: 'ollama' },
  { command: 'ollama rm', description: 'Remove a model', category: 'ollama', dangerous: true },
  { command: 'ollama show', description: 'Show model details', category: 'ollama' },
  { command: 'ollama ps', description: 'Show running models', category: 'ollama' },
  { command: 'ollama serve', description: 'Start Ollama server', category: 'ollama' },
  { command: 'ollama cp', description: 'Copy a model', category: 'ollama' },
  { command: 'ollama create', description: 'Create from Modelfile', category: 'ollama' },

  // Docker
  { command: 'docker ps', description: 'List running containers', category: 'docker' },
  { command: 'docker ps -a', description: 'List all containers', category: 'docker' },
  { command: 'docker images', description: 'List images', category: 'docker' },
  { command: 'docker logs', description: 'View container logs', category: 'docker' },
  { command: 'docker logs -f', description: 'Follow container logs', category: 'docker' },
  { command: 'docker logs --tail 100', description: 'Last 100 lines', category: 'docker' },
  { command: 'docker exec -it', description: 'Execute in container', category: 'docker' },
  { command: 'docker stop', description: 'Stop container', category: 'docker' },
  { command: 'docker start', description: 'Start container', category: 'docker' },
  { command: 'docker restart', description: 'Restart container', category: 'docker' },
  { command: 'docker rm', description: 'Remove container', category: 'docker', dangerous: true },
  { command: 'docker rm -f', description: 'Force remove', category: 'docker', dangerous: true },
  { command: 'docker rmi', description: 'Remove image', category: 'docker', dangerous: true },
  { command: 'docker pull', description: 'Pull image', category: 'docker' },
  { command: 'docker build -t', description: 'Build with tag', category: 'docker' },
  { command: 'docker run -d', description: 'Run detached', category: 'docker' },
  { command: 'docker run -it --rm', description: 'Interactive, auto-remove', category: 'docker' },
  { command: 'docker compose up -d', description: 'Start services', category: 'docker' },
  { command: 'docker compose down', description: 'Stop services', category: 'docker', dangerous: true },
  { command: 'docker compose down -v', description: 'Stop + volumes', category: 'docker', dangerous: true },
  { command: 'docker compose logs -f', description: 'Follow compose logs', category: 'docker' },
  { command: 'docker compose ps', description: 'Compose status', category: 'docker' },
  { command: 'docker compose restart', description: 'Restart services', category: 'docker' },
  { command: 'docker compose build', description: 'Build services', category: 'docker' },
  { command: 'docker compose pull', description: 'Pull images', category: 'docker' },
  { command: 'docker compose exec', description: 'Exec in service', category: 'docker' },
  { command: 'docker system prune', description: 'Remove unused data', category: 'docker', dangerous: true },
  { command: 'docker system prune -a', description: 'Remove ALL unused', category: 'docker', dangerous: true },
  { command: 'docker system df', description: 'Disk usage', category: 'docker' },
  { command: 'docker stats', description: 'Live usage', category: 'docker' },
  { command: 'docker stats --no-stream', description: 'Usage snapshot', category: 'docker' },
  { command: 'docker inspect', description: 'Inspect container', category: 'docker' },
  { command: 'docker network ls', description: 'List networks', category: 'docker' },
  { command: 'docker volume ls', description: 'List volumes', category: 'docker' },
  { command: 'docker volume prune', description: 'Remove unused volumes', category: 'docker', dangerous: true },
  { command: 'docker cp', description: 'Copy files to/from', category: 'docker' },
  { command: 'docker top', description: 'Container processes', category: 'docker' },
  { command: 'docker port', description: 'Port mappings', category: 'docker' },

  // Git
  { command: 'git status', description: 'Working tree status', category: 'git' },
  { command: 'git add .', description: 'Stage all changes', category: 'git' },
  { command: 'git add -p', description: 'Stage interactively', category: 'git' },
  { command: 'git add -A', description: 'Stage all incl deletes', category: 'git' },
  { command: 'git commit -m ""', description: 'Commit with message', category: 'git' },
  { command: 'git commit --amend', description: 'Amend last commit', category: 'git' },
  { command: 'git commit --amend --no-edit', description: 'Amend, keep message', category: 'git' },
  { command: 'git push', description: 'Push to remote', category: 'git' },
  { command: 'git push -u origin', description: 'Push & set upstream', category: 'git' },
  { command: 'git push --force-with-lease', description: 'Safe force push', category: 'git' },
  { command: 'git push --force', description: 'Force push (dangerous)', category: 'git', dangerous: true },
  { command: 'git pull', description: 'Pull from remote', category: 'git' },
  { command: 'git pull --rebase', description: 'Pull with rebase', category: 'git' },
  { command: 'git fetch', description: 'Fetch from remote', category: 'git' },
  { command: 'git fetch --all', description: 'Fetch all remotes', category: 'git' },
  { command: 'git log --oneline -10', description: 'Recent commits', category: 'git' },
  { command: 'git log --oneline --graph', description: 'Commit graph', category: 'git' },
  { command: 'git log --stat', description: 'Commits with stats', category: 'git' },
  { command: 'git diff', description: 'Show unstaged changes', category: 'git' },
  { command: 'git diff --staged', description: 'Show staged changes', category: 'git' },
  { command: 'git diff HEAD~1', description: 'Diff with prev commit', category: 'git' },
  { command: 'git branch', description: 'List branches', category: 'git' },
  { command: 'git branch -a', description: 'List all branches', category: 'git' },
  { command: 'git branch -d', description: 'Delete merged branch', category: 'git' },
  { command: 'git branch -D', description: 'Force delete branch', category: 'git', dangerous: true },
  { command: 'git checkout', description: 'Switch branches', category: 'git' },
  { command: 'git checkout -b', description: 'New branch', category: 'git' },
  { command: 'git switch', description: 'Switch (modern)', category: 'git' },
  { command: 'git switch -c', description: 'Create & switch', category: 'git' },
  { command: 'git merge', description: 'Merge a branch', category: 'git' },
  { command: 'git merge --no-ff', description: 'Merge with commit', category: 'git' },
  { command: 'git rebase', description: 'Rebase current branch', category: 'git' },
  { command: 'git rebase -i', description: 'Interactive rebase: rewrite commit history', category: 'git' },
  { command: 'git rebase -i HEAD~3', description: 'Rewrite last 3 commits', category: 'git' },
  { command: 'git stash', description: 'Stash changes', category: 'git' },
  { command: 'git stash pop', description: 'Apply & drop stash', category: 'git' },
  { command: 'git stash list', description: 'List stashes', category: 'git' },
  { command: 'git stash drop', description: 'Drop a stash', category: 'git' },
  { command: 'git reset HEAD', description: 'Unstage changes', category: 'git' },
  { command: 'git reset --soft HEAD~1', description: 'Undo commit, keep changes', category: 'git' },
  { command: 'git reset --hard HEAD', description: 'Discard ALL changes', category: 'git', dangerous: true },
  { command: 'git reset --hard HEAD~1', description: 'Delete last commit', category: 'git', dangerous: true },
  { command: 'git clean -fd', description: 'Remove untracked files', category: 'git', dangerous: true },
  { command: 'git clean -fdn', description: 'Preview removal', category: 'git' },
  { command: 'git cherry-pick', description: 'Apply specific commit', category: 'git' },
  { command: 'git tag', description: 'List tags', category: 'git' },
  { command: 'git tag -a', description: 'Annotated tag', category: 'git' },
  { command: 'git remote -v', description: 'Show remotes', category: 'git' },
  { command: 'git reflog', description: 'Reference log', category: 'git' },
  { command: 'git blame', description: 'Line-by-line authorship', category: 'git' },

  // npm / Node
  { command: 'npm install', description: 'Install dependencies', category: 'npm' },
  { command: 'npm install --save-dev', description: 'Dev dependency', category: 'npm' },
  { command: 'npm install -g', description: 'Install globally', category: 'npm' },
  { command: 'npm uninstall', description: 'Remove package', category: 'npm' },
  { command: 'npm run dev', description: 'Dev script', category: 'npm' },
  { command: 'npm run build', description: 'Build', category: 'npm' },
  { command: 'npm start', description: 'Start', category: 'npm' },
  { command: 'npm test', description: 'Run tests', category: 'npm' },
  { command: 'npm run lint', description: 'Linter', category: 'npm' },
  { command: 'npm outdated', description: 'Outdated packages', category: 'npm' },
  { command: 'npm audit', description: 'Security audit', category: 'npm' },
  { command: 'npm audit fix', description: 'Fix vulnerabilities', category: 'npm' },
  { command: 'npm ls --depth=0', description: 'Top-level packages', category: 'npm' },
  { command: 'npm cache clean --force', description: 'Clear cache', category: 'npm' },
  { command: 'npm init -y', description: 'Init package.json', category: 'npm' },
  { command: 'npm version patch', description: 'Bump patch version', category: 'npm' },
  { command: 'npx', description: 'Execute package binary', category: 'npm' },
  { command: 'npx tsc --noEmit', description: 'Type check', category: 'npm' },
  { command: 'npx vite build', description: 'Build with Vite', category: 'npm' },
  { command: 'npx prisma migrate dev', description: 'Prisma migration', category: 'npm' },
  { command: 'npx prisma generate', description: 'Generate Prisma client', category: 'npm' },
  { command: 'npx prisma studio', description: 'Prisma Studio', category: 'npm' },
  { command: 'node -v', description: 'Node version', category: 'npm' },
  { command: 'node --inspect', description: 'Debug mode', category: 'npm' },
  { command: 'yarn install', description: 'Install deps', category: 'npm' },
  { command: 'yarn add', description: 'Add package', category: 'npm' },
  { command: 'yarn add -D', description: 'Dev dependency', category: 'npm' },
  { command: 'yarn build', description: 'Build', category: 'npm' },

  // PM2
  { command: 'pm2 list', description: 'List processes', category: 'pm2' },
  { command: 'pm2 start', description: 'Start process', category: 'pm2' },
  { command: 'pm2 stop', description: 'Stop process', category: 'pm2' },
  { command: 'pm2 stop all', description: 'Stop all', category: 'pm2' },
  { command: 'pm2 restart', description: 'Restart process', category: 'pm2' },
  { command: 'pm2 restart all', description: 'Restart all', category: 'pm2' },
  { command: 'pm2 reload', description: 'Graceful reload', category: 'pm2' },
  { command: 'pm2 logs', description: 'View logs', category: 'pm2' },
  { command: 'pm2 logs --lines 100', description: 'Last 100 lines', category: 'pm2' },
  { command: 'pm2 monit', description: 'Monitor', category: 'pm2' },
  { command: 'pm2 delete all', description: 'Delete all', category: 'pm2', dangerous: true },
  { command: 'pm2 flush', description: 'Flush logs', category: 'pm2' },
  { command: 'pm2 save', description: 'Save process list', category: 'pm2' },
  { command: 'pm2 startup', description: 'Generate startup script', category: 'pm2' },
  { command: 'pm2 describe', description: 'Process details', category: 'pm2' },

  // System
  { command: 'systemctl status', description: 'Service status', category: 'system' },
  { command: 'systemctl start', description: 'Start service', category: 'system' },
  { command: 'systemctl stop', description: 'Stop service', category: 'system', dangerous: true },
  { command: 'systemctl restart', description: 'Restart service', category: 'system' },
  { command: 'systemctl reload', description: 'Reload config', category: 'system' },
  { command: 'systemctl enable', description: 'Enable on boot', category: 'system' },
  { command: 'systemctl disable', description: 'Disable on boot', category: 'system' },
  { command: 'systemctl daemon-reload', description: 'Reload systemd', category: 'system' },
  { command: 'systemctl list-units --type=service', description: 'List services', category: 'system' },
  { command: 'systemctl list-units --failed', description: 'Failed services', category: 'system' },
  { command: 'journalctl -u', description: 'Service logs', category: 'system' },
  { command: 'journalctl -u --since "1 hour ago"', description: 'Recent logs', category: 'system' },
  { command: 'journalctl -xe', description: 'Latest errors', category: 'system' },
  { command: 'journalctl -f', description: 'Follow logs', category: 'system' },
  { command: 'journalctl --disk-usage', description: 'Journal size', category: 'system' },
  { command: 'journalctl --vacuum-size=100M', description: 'Trim journal', category: 'system' },
  { command: 'htop', description: 'Process viewer', category: 'system' },
  { command: 'top', description: 'Basic process viewer', category: 'system' },
  { command: 'df -h', description: 'Disk usage', category: 'system' },
  { command: 'df -i', description: 'Inode usage', category: 'system' },
  { command: 'du -sh *', description: 'Directory sizes', category: 'system' },
  { command: 'du -sh * | sort -hr', description: 'Sorted sizes', category: 'system' },
  { command: 'du -sh /* 2>/dev/null | sort -hr | head -20', description: 'Top 20 dirs', category: 'system' },
  { command: 'free -h', description: 'Memory usage', category: 'system' },
  { command: 'uname -a', description: 'System info', category: 'system' },
  { command: 'uptime', description: 'Uptime & load', category: 'system' },
  { command: 'whoami', description: 'Current user', category: 'system' },
  { command: 'hostname', description: 'Hostname', category: 'system' },
  { command: 'lsb_release -a', description: 'Distro info', category: 'system' },
  { command: 'date', description: 'Current date/time', category: 'system' },
  { command: 'timedatectl', description: 'Time/timezone', category: 'system' },
  { command: 'dmesg | tail -20', description: 'Kernel messages', category: 'system' },
  { command: 'lscpu', description: 'CPU info', category: 'system' },
  { command: 'lsblk', description: 'Block devices', category: 'system' },
  { command: 'vmstat 1 5', description: 'VM stats', category: 'system' },
  { command: 'nproc', description: 'CPU count', category: 'system' },
  { command: 'env', description: 'Environment vars', category: 'system' },
  { command: 'crontab -l', description: 'List cron', category: 'system' },
  { command: 'crontab -e', description: 'Edit cron', category: 'system' },
  { command: 'history', description: 'Command history', category: 'system' },
  { command: 'history | grep', description: 'Search history', category: 'system' },
  { command: 'watch -n 2', description: 'Repeat every 2s', category: 'system' },
  { command: 'tmux ls', description: 'List tmux sessions', category: 'system' },
  { command: 'tmux new -s', description: 'New tmux session', category: 'system' },
  { command: 'tmux attach -t', description: 'Attach session', category: 'system' },
  { command: 'screen -ls', description: 'List screens', category: 'system' },

  // APT
  { command: 'apt update', description: 'Update package lists', category: 'apt' },
  { command: 'apt upgrade', description: 'Upgrade packages', category: 'apt' },
  { command: 'apt full-upgrade', description: 'Full upgrade', category: 'apt' },
  { command: 'apt install', description: 'Install package', category: 'apt' },
  { command: 'apt remove', description: 'Remove package', category: 'apt' },
  { command: 'apt purge', description: 'Remove + config', category: 'apt', dangerous: true },
  { command: 'apt autoremove', description: 'Remove unused deps', category: 'apt' },
  { command: 'apt search', description: 'Search packages', category: 'apt' },
  { command: 'apt show', description: 'Package info', category: 'apt' },
  { command: 'apt list --installed', description: 'Installed packages', category: 'apt' },
  { command: 'apt list --upgradable', description: 'Upgradable packages', category: 'apt' },
  { command: 'dpkg -l | grep', description: 'Search installed', category: 'apt' },
  { command: 'apt-cache policy', description: 'Package version/source', category: 'apt' },

  // Files
  { command: 'ls', description: 'List directory', category: 'files' },
  { command: 'ls -la', description: 'Detailed list', category: 'files' },
  { command: 'ls -lah', description: 'Detailed + human sizes', category: 'files' },
  { command: 'ls -lt', description: 'Sort by time', category: 'files' },
  { command: 'ls -lS', description: 'Sort by size', category: 'files' },
  { command: 'cd', description: 'Change directory', category: 'files' },
  { command: 'pwd', description: 'Print working dir', category: 'files' },
  { command: 'mkdir -p', description: 'Create directory', category: 'files' },
  { command: 'cp -r', description: 'Copy recursive', category: 'files' },
  { command: 'mv', description: 'Move/rename', category: 'files' },
  { command: 'rm', description: 'Remove files', category: 'files', dangerous: true },
  { command: 'rm -rf', description: 'Force recursive delete', category: 'files', dangerous: true },
  { command: 'cat', description: 'Show file', category: 'files' },
  { command: 'less', description: 'Page through file', category: 'files' },
  { command: 'head -n 20', description: 'First 20 lines', category: 'files' },
  { command: 'tail -n 20', description: 'Last 20 lines', category: 'files' },
  { command: 'tail -f', description: 'Follow file', category: 'files' },
  { command: 'wc -l', description: 'Count lines', category: 'files' },
  { command: 'find . -name', description: 'Find by name', category: 'files' },
  { command: 'find . -type f -size +100M', description: 'Files > 100MB', category: 'files' },
  { command: 'find . -type f -name "*.ts"', description: 'Find .ts files', category: 'files' },
  { command: 'grep -r "" .', description: 'Search recursively', category: 'files' },
  { command: 'grep -rn "" .', description: 'Search with line nums', category: 'files' },
  { command: 'grep -ri "" .', description: 'Case-insensitive search', category: 'files' },
  { command: 'grep -rl "" .', description: 'List matching files', category: 'files' },
  { command: 'chmod +x', description: 'Make executable', category: 'files' },
  { command: 'chmod 755', description: 'rwxr-xr-x', category: 'files' },
  { command: 'chmod 644', description: 'rw-r--r--', category: 'files' },
  { command: 'chmod -R 777', description: 'Wide open (BAD)', category: 'files', dangerous: true },
  { command: 'chown -R', description: 'Recursive ownership', category: 'files' },
  { command: 'ln -s', description: 'Symbolic link', category: 'files' },
  { command: 'stat', description: 'File details', category: 'files' },
  { command: 'file', description: 'File type', category: 'files' },
  { command: 'touch', description: 'Create empty file', category: 'files' },
  { command: 'tar -czf', description: 'Create .tar.gz', category: 'files' },
  { command: 'tar -xzf', description: 'Extract .tar.gz', category: 'files' },
  { command: 'zip -r', description: 'Create zip', category: 'files' },
  { command: 'unzip', description: 'Extract zip', category: 'files' },
  { command: 'diff', description: 'Compare files', category: 'files' },
  { command: 'sort', description: 'Sort lines', category: 'files' },
  { command: 'uniq', description: 'Remove duplicates', category: 'files' },
  { command: 'awk', description: 'Pattern processing', category: 'files' },
  { command: 'sed', description: 'Stream editor', category: 'files' },
  { command: 'sed -i', description: 'In-place edit', category: 'files' },
  { command: 'xargs', description: 'Build commands', category: 'files' },
  { command: 'tree', description: 'Dir tree view', category: 'files' },
  { command: 'tree -L 2', description: 'Tree 2 levels', category: 'files' },
  { command: 'nano', description: 'Text editor', category: 'files' },
  { command: 'vi', description: 'Vi editor', category: 'files' },

  // Network
  { command: 'curl -s', description: 'HTTP request', category: 'network' },
  { command: 'curl -I', description: 'Headers only', category: 'network' },
  { command: 'curl -X POST', description: 'POST request', category: 'network' },
  { command: 'curl -o', description: 'Download to file', category: 'network' },
  { command: 'wget', description: 'Download file', category: 'network' },
  { command: 'ping -c 4', description: 'Ping 4 packets', category: 'network' },
  { command: 'traceroute', description: 'Trace route', category: 'network' },
  { command: 'dig', description: 'DNS lookup', category: 'network' },
  { command: 'nslookup', description: 'DNS query', category: 'network' },
  { command: 'ip addr', description: 'Network interfaces', category: 'network' },
  { command: 'ip route', description: 'Routing table', category: 'network' },
  { command: 'ss -tlnp', description: 'Listening TCP ports', category: 'network' },
  { command: 'ss -ulnp', description: 'Listening UDP ports', category: 'network' },
  { command: 'ss -tunap', description: 'All connections', category: 'network' },
  { command: 'netstat -tlnp', description: 'Listening ports', category: 'network' },
  { command: 'lsof -i', description: 'Open connections', category: 'network' },
  { command: 'lsof -i :3001', description: 'What uses port', category: 'network' },
  { command: 'fuser -k 3001/tcp', description: 'Kill port process', category: 'network', dangerous: true },
  { command: 'iptables -L', description: 'Firewall rules', category: 'network' },
  { command: 'ufw status', description: 'UFW status', category: 'network' },
  { command: 'ufw allow', description: 'Allow port', category: 'network' },
  { command: 'nc -zv', description: 'Test port', category: 'network' },
  { command: 'ssh', description: 'SSH connect', category: 'network' },
  { command: 'ssh-keygen -t ed25519', description: 'Generate SSH key', category: 'network' },
  { command: 'scp', description: 'Secure copy', category: 'network' },
  { command: 'rsync -avz', description: 'Sync files', category: 'network' },
  { command: 'rsync -avz --progress', description: 'Sync with progress', category: 'network' },

  // Nginx
  { command: 'nginx -t', description: 'Test config', category: 'nginx' },
  { command: 'nginx -s reload', description: 'Reload nginx', category: 'nginx' },
  { command: 'systemctl restart nginx', description: 'Restart nginx', category: 'nginx' },
  { command: 'systemctl status nginx', description: 'Nginx status', category: 'nginx' },
  { command: 'tail -f /var/log/nginx/error.log', description: 'Nginx errors', category: 'nginx' },
  { command: 'tail -f /var/log/nginx/access.log', description: 'Nginx access', category: 'nginx' },
  { command: 'ls /etc/nginx/sites-enabled/', description: 'Enabled sites', category: 'nginx' },

  // Process
  { command: 'ps aux', description: 'All processes', category: 'process' },
  { command: 'ps aux | grep', description: 'Search process', category: 'process' },
  { command: 'pgrep -f', description: 'Find by pattern', category: 'process' },
  { command: 'kill', description: 'Send signal', category: 'process' },
  { command: 'kill -9', description: 'Force kill', category: 'process', dangerous: true },
  { command: 'killall', description: 'Kill by name', category: 'process', dangerous: true },
  { command: 'pkill -f', description: 'Kill by pattern', category: 'process', dangerous: true },
  { command: 'nohup', description: 'Run immune to hangup', category: 'process' },
  { command: 'jobs', description: 'List bg jobs', category: 'process' },
  { command: 'lsof -p', description: 'Files by process', category: 'process' },

  // Dangerous
  { command: 'dd if=', description: 'Low-level disk copy', category: 'security', dangerous: true },
  { command: 'mkfs', description: 'Format disk', category: 'security', dangerous: true },
  { command: 'fdisk', description: 'Partition editor', category: 'security', dangerous: true },
  { command: 'shutdown -h now', description: 'Shutdown now', category: 'security', dangerous: true },
  { command: 'reboot', description: 'Reboot system', category: 'security', dangerous: true },
  { command: 'passwd', description: 'Change password', category: 'security' },
];

function getAutocompleteSuggestions(prefix: string): CommandSuggestion[] {
  const lower = prefix.toLowerCase();
  const exact = COMMAND_DB.filter(c => c.command.toLowerCase().startsWith(lower));
  if (exact.length > 0) return exact;

  const words = lower.split(/\s+/);
  return COMMAND_DB.filter(c => {
    const cmdLower = c.command.toLowerCase();
    return words.every(w => cmdLower.includes(w)) ||
           c.description.toLowerCase().includes(lower) ||
           c.category.toLowerCase().startsWith(lower);
  });
}

export default router;
