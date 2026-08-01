import { randomBytes, timingSafeEqual } from 'crypto';
import { chownSync, mkdirSync, writeFileSync } from 'fs';
import { getDefaultAgentZeroAuthSessionManager } from '../agents/providers/agentZero/AgentZeroAuthSession';

/**
 * Click-time authenticated launch of the Agent Zero web UI from the Remote
 * Desktop, without ever exposing Agent Zero's credentials to the desktop.
 *
 * The desktop launcher runs as the unprivileged `bridgesrd` account and cannot
 * read the root-owned Agent Zero credential file. It instead asks this backend
 * (which runs as root and already holds a server-mediated Agent Zero session)
 * to mint a fresh session over loopback, gated by a per-boot capability secret
 * only the managed launcher can read. The backend returns the session cookies;
 * the launcher plants them into a dedicated Chrome profile via CDP and opens
 * Agent Zero already logged in. No static credential, no persistent tokenized
 * URL, and the Agent Zero password never leaves the server.
 */

// Where the launcher reads the capability secret. tmpfs, per-boot, root-owned
// but group-readable by bridgesrd (0640 root:bridgesrd).
export const AGENT_ZERO_DESKTOP_SECRET_PATH =
  process.env.AGENT_ZERO_DESKTOP_SECRET_PATH
  || '/run/bridgesllm-agent-zero-desktop.secret';
const DESKTOP_LAUNCHER_GROUP = 'bridgesrd';

let launcherSecret: string | null = null;

export interface AgentZeroDesktopCookie {
  name: string;
  value: string;
}

export interface AgentZeroDesktopSession {
  baseUrl: string;
  cookies: AgentZeroDesktopCookie[];
}

function currentSecret(): string {
  if (!launcherSecret) launcherSecret = randomBytes(32).toString('hex');
  return launcherSecret;
}

/**
 * Provision the per-boot launcher capability secret so the managed desktop
 * launcher can request a session. Best-effort: a failure to write the file
 * simply means the launcher cannot mint a session (fail closed), never a
 * server error.
 */
export function provisionAgentZeroDesktopLauncherSecret(): void {
  const secret = currentSecret();
  try {
    const directory = AGENT_ZERO_DESKTOP_SECRET_PATH.replace(/\/[^/]*$/, '') || '/run';
    mkdirSync(directory, { recursive: true });
    writeFileSync(AGENT_ZERO_DESKTOP_SECRET_PATH, `${secret}\n`, { mode: 0o640 });
    try {
      // Group-read for the bridgesrd desktop account; owner stays root.
      chownSync(AGENT_ZERO_DESKTOP_SECRET_PATH, 0, resolveDesktopGroupId());
    } catch {
      // Group resolution/chown can fail on hosts without the account; the
      // launcher then simply will not be able to read it and fails closed.
    }
  } catch (error) {
    console.warn('[agent-zero-desktop] launcher secret could not be provisioned:', (error as Error)?.message);
  }
}

function resolveDesktopGroupId(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('child_process');
    const gid = Number(String(execFileSync('id', ['-g', DESKTOP_LAUNCHER_GROUP], { encoding: 'utf8' }).trim()));
    if (Number.isInteger(gid) && gid >= 0) return gid;
  } catch {
    // fall through
  }
  return 0;
}

/**
 * Constant-time check of a launcher-presented capability secret. Returns false
 * for any shape mismatch so a wrong or absent secret is rejected uniformly.
 */
export function isValidAgentZeroDesktopLauncherSecret(presented: unknown): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const expected = Buffer.from(currentSecret());
  const actual = Buffer.from(presented);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function parseSessionCookieHeader(header: string): AgentZeroDesktopCookie[] {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf('=');
      if (separator <= 0) return null;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) return null;
      return { name, value };
    })
    .filter((cookie): cookie is AgentZeroDesktopCookie => cookie !== null);
}

/**
 * Mint a fresh authenticated Agent Zero web session for the desktop launcher.
 * Forces a new server-side login so each click gets a fresh, short-lived
 * session rather than reusing a cached one.
 */
export async function mintAgentZeroDesktopSession(
  manager = getDefaultAgentZeroAuthSessionManager(),
): Promise<AgentZeroDesktopSession> {
  const cookieHeader = await manager.getSessionCookie(true);
  const cookies = parseSessionCookieHeader(cookieHeader);
  if (!cookies.length) {
    throw new Error('Agent Zero did not return a usable web session.');
  }
  return { baseUrl: manager.baseUrl, cookies };
}
