import fs from "fs";
import path from "path";
import https from "https";
import { execSync } from "child_process";
import dns from "dns/promises";
import { AppError } from "../middleware/errorHandler";

/**
 * Poll until HTTPS responds with a valid cert, or timeout.
 * Returns true if HTTPS is ready, false if we timed out (setup can still continue).
 */
async function waitForHttps(domain: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = https.get(`https://${domain}/api/setup/status`, { timeout: 3000 }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

const PORTAL_ROOT = process.env.PORTAL_ROOT || '/opt/bridgesllm/portal';

export interface CodingToolStatus {
  id: string;
  name: string;
  command: string;
  description: string;
  installCmd: string;
  installed: boolean;
  version: string;
}

const CODING_TOOL_CHECKS = [
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex --version',
    description: 'OpenAI coding agent — excels at multi-file refactoring and building features',
    installCmd: 'npm install -g @openai/codex',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude --version',
    description: 'Anthropic coding agent — strong at architecture, reviews, and complex reasoning',
    installCmd: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    command: 'gemini --version',
    description: 'Google coding agent — fast generation with large context windows',
    installCmd: 'npm install -g @google/gemini-cli',
  },
] as const;

const CODING_TOOL_INSTALL_MAP: Record<string, string> = Object.fromEntries(
  CODING_TOOL_CHECKS.map((tool) => [tool.id, tool.installCmd]),
);

export function getPublicIp(): string {
  if (process.env.PUBLIC_IP && process.env.PUBLIC_IP !== '0.0.0.0') return process.env.PUBLIC_IP;

  try {
    return execSync('curl -4 -s --max-time 5 ifconfig.me || curl -4 -s --max-time 5 icanhazip.com', {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim() || '0.0.0.0';
  } catch {
    return process.env.PUBLIC_IP || '0.0.0.0';
  }
}

export function buildIpFallbackCaddyConfig(publicIp: string): string {
  const siteLabel = publicIp && publicIp !== '0.0.0.0' ? `http://${publicIp}` : ':80';
  return `${siteLabel} {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
`;
}

export function updateEnvFile(updates: Record<string, string>): void {
  const envPath = path.join(PORTAL_ROOT, 'backend', '.env.production');
  if (!fs.existsSync(envPath)) return;

  let content = fs.readFileSync(envPath, 'utf-8');

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    const newLine = `${key}=${value}`;
    if (regex.test(content)) {
      content = content.replace(regex, newLine);
    } else {
      // Ensure trailing newline before appending
      if (content.length > 0 && !content.endsWith('\n')) content += '\n';
      content += `${newLine}\n`;
    }
  }

  fs.writeFileSync(envPath, content, { mode: 0o600 });

  // Also inject into the running process so new values take effect immediately
  // (without requiring a service restart)
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

export async function configureDomainAndHttps(domain: string): Promise<{ success: true; domain: string; url: string; message: string; httpsReady: boolean }> {
  const publicIp = getPublicIp();

  let resolvedIps: string[] = [];
  try {
    resolvedIps = await dns.resolve4(domain);
  } catch {
    throw new AppError(400, `Cannot resolve ${domain}. Make sure the A record is set up first.`);
  }

  if (!resolvedIps.includes(publicIp)) {
    throw new AppError(400, `${domain} resolves to ${resolvedIps.join(', ')} but this server is ${publicIp}. Update your DNS.`);
  }

  const caddyConfig = `# BridgesLLM Portal — managed by setup wizard
${domain}, www.${domain} {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}

# Keep IP access alive during setup so the wizard can finish on HTTP
http://${publicIp} {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
`;

  fs.writeFileSync('/etc/caddy/Caddyfile', caddyConfig);

  try {
    execSync('caddy validate --config /etc/caddy/Caddyfile', { timeout: 10000, stdio: 'ignore' });
  } catch {
    const fallback = buildIpFallbackCaddyConfig(publicIp);
    fs.writeFileSync('/etc/caddy/Caddyfile', fallback);
    throw new AppError(500, 'Caddy configuration validation failed. Reverted to IP-based config.');
  }

  execSync('systemctl reload caddy', { timeout: 10000 });

  // Wait for HTTPS cert to be provisioned (Let's Encrypt ACME takes a few seconds)
  const httpsReady = await waitForHttps(domain, 15000);

  updateEnvFile({
    CORS_ORIGIN: `https://${domain},https://www.${domain},http://${publicIp}`,
    MAIL_DOMAIN: domain,
  });

  return {
    success: true,
    domain,
    url: `https://${domain}`,
    httpsReady,
    message: `HTTPS configured! Your portal is now at https://${domain}`,
  };
}

export async function getCodingToolsStatus(): Promise<{ tools: CodingToolStatus[] }> {
  const tools = CODING_TOOL_CHECKS.map((tool) => {
    let installed = false;
    let version = '';

    try {
      const output = execSync(tool.command, { timeout: 5000, encoding: 'utf8' }).trim();
      installed = true;
      version = output.split('\n')[0].replace(/^[^0-9]*/, '').trim() || output.substring(0, 50);
    } catch {
      installed = false;
    }

    return { ...tool, installed, version };
  });

  return { tools };
}

export function installCodingTool(toolId: string): void {
  const cmd = CODING_TOOL_INSTALL_MAP[toolId];
  if (!cmd) throw new AppError(400, 'Unknown tool');

  execSync(cmd, { timeout: 120000, encoding: 'utf8' });
}
