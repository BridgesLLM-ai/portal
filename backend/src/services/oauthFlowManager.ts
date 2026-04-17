import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { readAuthProfiles, saveProviderApiKey } from './openclawConfigManager';

export type OAuthFlowStatus = 'starting' | 'awaiting_callback' | 'polling_device' | 'processing' | 'complete' | 'error';

export interface OAuthSession {
  id: string;
  provider: string;
  mode: 'oauth' | 'device_code';
  process: pty.IPty;
  authUrl: string | null;
  callbackHintUrl: string | null;
  deviceCode: string | null;
  verificationUrl: string | null;
  localPort: number | null;
  oauthState: string | null;
  status: OAuthFlowStatus;
  error: string | null;
  output: string;
  cleanOutput: string;
  createdAt: number;
  completedAt: number | null;
  profileKeyBefore: string[];
  sentInitialConfirm?: boolean;
  extraEnv?: Record<string, string>;
}

const sessions = new Map<string, OAuthSession>();
const OPENCLAW_BIN = 'openclaw';
const ANSI_REGEX = /\x1B\[[0-9;?]*[ -\/]*[@-~]|\x1B[@-_]/g;

function createSessionId() {
  return `oauth_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildPkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

function safeReadJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function stripAnsi(value: string) {
  return value.replace(ANSI_REGEX, '');
}

function readProviderProfileIds(provider: string) {
  const authProfiles = readAuthProfiles();
  return Object.keys(authProfiles.profiles || {}).filter((profileId) => authProfiles.profiles?.[profileId]?.provider === provider);
}

function spawnOpenClawPty(args: string[], extraEnv?: Record<string, string>) {
  return pty.spawn(OPENCLAW_BIN, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv } as Record<string, string>,
  });
}

function updateSessionFromOutput(session: OAuthSession) {
  const text = session.cleanOutput;

  if (session.provider === 'google-gemini-cli') {
    // Auto-confirm trust folder prompt (option 1 = "Trust folder")
    if (!(session as any).__trustFolderConfirmed && /Do you trust the files in this folder\?/i.test(text)) {
      (session as any).__trustFolderConfirmed = true;
      session.sentInitialConfirm = true;
      console.log('[NativeCLI] Gemini trust-folder prompt detected, auto-confirming...');
      setTimeout(() => {
        session.process.write('\r');  // Press enter to select default (option 1)
      }, 500);
    }

    // Auto-confirm the Google OAuth caution prompt.
    // Gemini can now surface this prompt even when the trust-folder prompt never appears,
    // so gating on sentInitialConfirm leaves the default selection on "No" and the PTY exits.
    if (/Continue with Google Gemini CLI OAuth\?/i.test(text) && !(session as any).__oauthConfirmed) {
      (session as any).__oauthConfirmed = true;
      session.sentInitialConfirm = true;
      console.log('[NativeCLI] Google OAuth caution prompt detected, auto-confirming...');
      setTimeout(() => {
        session.process.write('\u001b[D');  // left-arrow to select "Yes"
        setTimeout(() => {
          session.process.write('\r');
        }, 300);
      }, 500);
    }
  }

  const urls = text.match(/https?:\/\/[^\s)"'>]+/g) || [];
  for (const url of urls) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = '';
    }

    const isLocalCallbackUrl = hostname === '127.0.0.1' || hostname === 'localhost';
    const isGithubDeviceUrl = /github\.com\/login\/device/i.test(url);
    const isOpenAIDeviceUrl = /auth\.openai\.com\/codex\/device/i.test(url);

    if (!session.verificationUrl && (isGithubDeviceUrl || isOpenAIDeviceUrl)) {
      session.verificationUrl = url;
    }
    // For Claude native CLI, extract local callback port from the local server URL
    if (isLocalCallbackUrl && !session.localPort) {
      try {
        const localUrl = new URL(url);
        session.localPort = parseInt(localUrl.port, 10) || null;
      } catch { /* ignore */ }
    }
    if (!session.authUrl && !isLocalCallbackUrl && !isGithubDeviceUrl && !isOpenAIDeviceUrl) {
      session.authUrl = url;
      // Extract OAuth state parameter for local callback relay
      try {
        const parsed = new URL(url);
        const state = parsed.searchParams.get('state');
        if (state) session.oauthState = state;
      } catch { /* ignore */ }
    }
    if (!session.callbackHintUrl && isLocalCallbackUrl) {
      session.callbackHintUrl = url;
    }
  }

  const deviceCodePatterns = [
    /one-time code[^]*?\n\s+([A-Z0-9-]{6,})/i,  // Codex: "Enter this one-time code\n   OW1I-ARN5H"
    /Code:\s*([A-Z0-9-]{6,})/i,
    /enter (?:the )?code[:\s]+([A-Z0-9-]{6,})/i,
  ];
  for (const pattern of deviceCodePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      session.deviceCode = match[1];
      break;
    }
  }

  if (session.mode === 'device_code' && (session.deviceCode || session.verificationUrl || /waiting for github authorization/i.test(text))) {
    if (session.status !== 'complete') {
      session.status = 'polling_device';
    }
  }

  if (session.mode === 'oauth') {
    const needsCallback =
      /paste.*redirect url/i.test(text)
      || /paste.*callback url/i.test(text)
      || /paste the authorization code/i.test(text)
      || /paste the full redirect url/i.test(text)
      || /localhost/i.test(text)
      || /127\.0\.0\.1/i.test(text)
      || Boolean(session.authUrl);

    if (needsCallback && session.status !== 'complete') {
      session.status = 'awaiting_callback';
    }
  }

  if (/successfully logged in|login complete|authentication complete|provider added|saved profile|setup.token.*generated|token.*saved|successfully authenticated/i.test(text)) {
    session.status = 'complete';
    session.completedAt = Date.now();
  }
}

function waitForInitialOutput(session: OAuthSession, timeoutMs: number) {
  return new Promise<OAuthSession>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (session.error) {
        clearInterval(timer);
        reject(new Error(session.error));
        return;
      }

      const text = session.cleanOutput;
      const oauthReady = session.mode === 'oauth' && (
        Boolean(session.authUrl)
        || /Open this URL in your LOCAL browser:/i.test(text)
        || /Paste the authorization code/i.test(text)
        || /Paste the redirect URL here/i.test(text)
        || /Waiting for you to paste the callback URL/i.test(text)
        || /browser didn't open, visit:/i.test(text)
        || /Enter the authorization code:/i.test(text)  // Gemini headless OAuth
      );

      const deviceReady = session.mode === 'device_code' && (
        Boolean(session.deviceCode)
        || Boolean(session.verificationUrl)
        || /github\.com\/login\/device/i.test(text)
        || /auth\.openai\.com\/codex\/device/i.test(text)
      );

      if (oauthReady || deviceReady) {
        updateSessionFromOutput(session);
        clearInterval(timer);
        resolve(session);
        return;
      }

      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for provider login instructions.'));
      }
    }, 200);
  });
}

function attachPtyParsing(session: OAuthSession) {
  session.process.onData((chunk: string) => {
    session.output += chunk;
    session.cleanOutput += stripAnsi(chunk);
    updateSessionFromOutput(session);
  });

  session.process.onExit(({ exitCode }) => {
    console.log(`[OAuth] PTY exited: provider=${session.provider} code=${exitCode} status=${session.status} hasAuthUrl=${Boolean(session.authUrl)} outputLen=${session.cleanOutput.length}`);
    console.log(`[OAuth] Last 500 chars of clean output: ${session.cleanOutput.slice(-500)}`);
    if (session.status === 'complete') return;
    if (exitCode === 0) {
      session.status = 'complete';
      session.completedAt = Date.now();
      return;
    }
    // If we already got the auth URL and are waiting for callback, don't treat exit as error
    if (session.authUrl && session.status === 'awaiting_callback') {
      console.log('[OAuth] Process exited but auth URL was already delivered, keeping session alive');
      return;
    }
    if (!session.error) {
      session.status = 'error';
      session.error = `Provider login process exited with code ${exitCode}`;
    }
  });
}

export async function startOAuthFlow(provider: string, options?: { googleProjectId?: string }) {
  const extraEnv: Record<string, string> = {};
  if (provider === 'google-gemini-cli' && options?.googleProjectId) {
    extraEnv.GOOGLE_CLOUD_PROJECT = options.googleProjectId;
    console.log(`[OAuth] Setting GOOGLE_CLOUD_PROJECT=${options.googleProjectId}`);
  }

  const id = createSessionId();
  const session: OAuthSession = {
    id,
    provider,
    mode: 'oauth',
    process: spawnOpenClawPty(['models', 'auth', 'login', '--provider', provider], extraEnv),
    authUrl: null,
    callbackHintUrl: null,
    deviceCode: null,
    verificationUrl: null,
    localPort: null,
    oauthState: null,
    status: 'starting',
    error: null,
    output: '',
    cleanOutput: '',
    createdAt: Date.now(),
    completedAt: null,
    profileKeyBefore: readProviderProfileIds(provider),
    sentInitialConfirm: false,
    extraEnv: Object.keys(extraEnv).length ? extraEnv : undefined,
  };

  sessions.set(id, session);
  attachPtyParsing(session);
  // Google needs extra time for the auto-confirm step
  const timeout = provider === 'google-gemini-cli' ? 30000 : 20000;
  await waitForInitialOutput(session, timeout);
  return {
    sessionId: session.id,
    authUrl: session.authUrl,
    callbackHintUrl: session.callbackHintUrl,
  };
}

export async function startDeviceCodeFlow(provider: 'github-copilot') {
  const id = createSessionId();
  const session: OAuthSession = {
    id,
    provider,
    mode: 'device_code',
    process: spawnOpenClawPty(['models', 'auth', 'login-github-copilot', '--yes']),
    authUrl: null,
    callbackHintUrl: null,
    deviceCode: null,
    verificationUrl: null,
    localPort: null,
    oauthState: null,
    status: 'starting',
    error: null,
    output: '',
    cleanOutput: '',
    createdAt: Date.now(),
    completedAt: null,
    profileKeyBefore: readProviderProfileIds('github-copilot'),
    sentInitialConfirm: false,
  };

  sessions.set(id, session);
  attachPtyParsing(session);
  await waitForInitialOutput(session, 20000);
  return {
    sessionId: session.id,
    verificationUrl: session.verificationUrl || session.authUrl,
    deviceCode: session.deviceCode,
  };
}

export async function completeOAuthFlow(sessionId: string, callbackUrl: string) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('OAuth session not found');
  if (session.mode !== 'oauth') throw new Error('Session is not waiting for a callback URL');

  session.status = 'processing';
  session.error = null;

  // Check if the original PTY is still alive by trying to write
  let ptyAlive = false;
  try {
    // node-pty throws if the process is dead
    session.process.write('');
    ptyAlive = true;
  } catch {
    ptyAlive = false;
  }

  if (!ptyAlive) {
    console.log(`[OAuth] PTY dead for ${session.provider}, spawning fresh process to complete flow...`);
    // Spawn a fresh PTY and feed the callback URL after it's ready
    const freshProcess = spawnOpenClawPty(['models', 'auth', 'login', '--provider', session.provider], session.extraEnv);
    session.process = freshProcess;
    session.output = '';
    session.cleanOutput = '';
    session.sentInitialConfirm = false;

    // Re-attach parsing
    freshProcess.onData((chunk: string) => {
      session.output += chunk;
      session.cleanOutput += stripAnsi(chunk);
      updateSessionFromOutput(session);
    });

    freshProcess.onExit(({ exitCode }) => {
      console.log(`[OAuth] Fresh PTY exited: provider=${session.provider} code=${exitCode} status=${session.status}`);
      if (session.status === 'complete') return;
      if (exitCode === 0) {
        session.status = 'complete';
        session.completedAt = Date.now();
        return;
      }
      // Check if a new profile was created despite non-zero exit
      const currentProfiles = readProviderProfileIds(session.provider);
      const newProfile = currentProfiles.find((id) => !session.profileKeyBefore.includes(id));
      if (newProfile) {
        console.log(`[OAuth] New profile detected despite exit code ${exitCode}: ${newProfile}`);
        session.status = 'complete';
        session.completedAt = Date.now();
        return;
      }
      if (!session.error) {
        session.status = 'error';
        session.error = `Provider login process exited with code ${exitCode}`;
      }
    });

    // Wait for the fresh PTY to reach the paste prompt
    try {
      await waitForInitialOutput(session, session.provider === 'google-gemini-cli' ? 30000 : 20000);
      console.log('[OAuth] Fresh PTY ready, feeding callback URL...');
    } catch (err: any) {
      console.error('[OAuth] Fresh PTY failed to reach paste prompt:', err.message);
      return { success: false, error: `Failed to restart login flow: ${err.message}` };
    }
  }

  // Write the callback URL to the PTY
  session.process.write(`${callbackUrl}\r`);

  const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (session.status === 'complete') {
        clearInterval(timer);
        resolve({ success: true });
        return;
      }
      if (session.error || session.status === 'error') {
        clearInterval(timer);
        resolve({ success: false, error: session.error || 'Provider login failed' });
        return;
      }
      // Also check if a new profile appeared (the CLI might exit with code 0 + "complete" text)
      const currentProfiles = readProviderProfileIds(session.provider);
      const newProfile = currentProfiles.find((id) => !session.profileKeyBefore.includes(id));
      if (newProfile) {
        clearInterval(timer);
        session.status = 'complete';
        session.completedAt = Date.now();
        resolve({ success: true });
        return;
      }
      if (Date.now() - started > 45000) {
        clearInterval(timer);
        resolve({ success: false, error: 'Timed out waiting for provider login to finish.' });
      }
    }, 250);
  });

  return result;
}

export function getOAuthFlowStatus(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const providerProfileIds = readProviderProfileIds(session.provider);
  const createdProfileId = providerProfileIds.find((profileId) => !session.profileKeyBefore.includes(profileId))
    || providerProfileIds[0]
    || null;

  return {
    id: session.id,
    provider: session.provider,
    mode: session.mode,
    status: session.status,
    authUrl: session.authUrl,
    callbackHintUrl: session.callbackHintUrl,
    deviceCode: session.deviceCode,
    verificationUrl: session.verificationUrl,
    error: session.error,
    createdProfileId,
    output: session.cleanOutput.slice(-4000),
  };
}

// ── Claude setup-token flow ──────────────────────────────────────────
// Runs `claude setup-token` in a PTY, captures the auth URL and waits
// for the token to be printed after the user completes browser sign-in.

function findClaudeBin(): string {
  
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim() || 'claude';
  } catch {
    return 'claude';
  }
}

export async function startClaudeSetupTokenFlow() {
  const id = createSessionId();
  const claudeBin = findClaudeBin();
  console.log(`[Claude] Starting setup-token flow, binary=${claudeBin}`);

  const proc = pty.spawn(claudeBin, ['setup-token'], {
    name: 'xterm-256color',
    cols: 500,  // Wide enough to prevent URL line-wrapping
    rows: 40,
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
  });

  const session: OAuthSession = {
    id,
    provider: 'anthropic',
    mode: 'oauth',
    process: proc,
    authUrl: null,
    callbackHintUrl: null,
    deviceCode: null,
    verificationUrl: null,
    localPort: null,
    oauthState: null,
    status: 'starting',
    error: null,
    output: '',
    cleanOutput: '',
    createdAt: Date.now(),
    completedAt: null,
    profileKeyBefore: readProviderProfileIds('anthropic'),
    sentInitialConfirm: false,
  };

  sessions.set(id, session);

  // Attach parsing — look for the Claude OAuth URL specifically
  proc.onData((chunk: string) => {
    session.output += chunk;
    session.cleanOutput += stripAnsi(chunk);

    // Check for Claude auth URL
    const text = session.cleanOutput;
    // Claude URL can be claude.ai or claude.com, path may be /oauth/authorize or /cai/oauth/authorize
    // PTY may line-wrap long URLs; strip \r\n between URL-safe chars to reassemble
    const unwrapped = text.replace(/([A-Za-z0-9%&=_\-.+/])[\r\n]+([A-Za-z0-9%&=_\-.+/])/g, '$1$2');
    const urls = unwrapped.match(/https:\/\/claude\.(ai|com)\/[^\s)">]*oauth\/authorize[^\s)">]*/g);
    const firstUrl = urls?.[0] ?? null;
    if (firstUrl && !session.authUrl) {
      session.authUrl = firstUrl;
      session.status = 'awaiting_callback';
      console.log(`[Claude] Auth URL captured: ${firstUrl.slice(0, 100)}...`);
    }
  });

  let setupToken: string | null = null;
  const tokenPromise = new Promise<string | null>((resolve) => {
    proc.onExit(({ exitCode }) => {
      console.log(`[Claude] PTY exited: code=${exitCode} status=${session.status} outputLen=${session.cleanOutput.length}`);
      console.log(`[Claude] Last 500 chars: ${session.cleanOutput.slice(-500)}`);

      if (exitCode === 0 && !setupToken) {
        // Extract token by matching the sk-ant-oat01- prefix directly.
        // The PTY output has \r padding and collapsed spaces that break line-based regexes.
        const text = session.cleanOutput;
        const m = text.match(/(sk-ant-oat01-[A-Za-z0-9_\-/.+=]{20,})/);
        if (m?.[1]) {
          setupToken = m[1].trim();
          console.log(`[Claude] Token captured on exit: ${setupToken.slice(0, 20)}... (${setupToken.length} chars)`);
          // Save immediately — don't wait for frontend to ask
          saveClaudeToken(setupToken);
        }
      }

      if (setupToken || exitCode === 0) {
        session.status = 'complete';
        session.completedAt = Date.now();
      } else if (!session.error) {
        session.status = 'error';
        session.error = `Claude setup-token exited with code ${exitCode}`;
      }
      resolve(setupToken);
    });
  });

  // Store the token promise on the session for later retrieval
  (session as any)._tokenPromise = tokenPromise;

  // Wait for the auth URL to appear (up to 30s)
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (session.authUrl) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (session.error || session.status === 'error') {
        clearInterval(timer);
        reject(new Error(session.error || 'Claude setup-token failed'));
        return;
      }
      if (Date.now() - started > 30000) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for Claude auth URL. Is Claude Code installed?'));
      }
    }, 200);
  });

  return {
    sessionId: session.id,
    authUrl: session.authUrl,
  };
}

export async function pasteCodeToClaudeSession(sessionId: string, code: string): Promise<{ success: boolean; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, error: 'Session not found' };
  if (session.provider !== 'anthropic') return { success: false, error: 'Not a Claude session' };

  console.log(`[Claude] Pasting auth code (${code.length} chars) to PTY...`);

  // Write the code to the PTY stdin
  try {
    session.process.write(`${code}\r`);
  } catch (err: any) {
    return { success: false, error: `PTY write failed: ${err.message}` };
  }

  // Wait for completion (token printed + exit, or profile created)
  const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      // Check if new auth profile appeared (saved by onExit handler or earlier iteration)
      const currentProfiles = readProviderProfileIds('anthropic');
      const newProfile = currentProfiles.find((id) => !session.profileKeyBefore.includes(id));
      if (newProfile) {
        clearInterval(timer);
        session.status = 'complete';
        session.completedAt = Date.now();
        console.log(`[Claude] New profile detected: ${newProfile}`);
        resolve({ success: true });
        return;
      }

      if (session.status === 'error') {
        clearInterval(timer);
        resolve({ success: false, error: session.error || 'Claude setup failed' });
        return;
      }

      // If session completed (exit 0) but no profile saved yet, try to extract and save token
      if (session.status === 'complete') {
        // Give a brief window for the onExit handler to save — then check
        const profilesNow = readProviderProfileIds('anthropic');
        const savedProfile = profilesNow.find((id) => !session.profileKeyBefore.includes(id));
        if (savedProfile) {
          clearInterval(timer);
          resolve({ success: true });
          return;
        }
        // onExit may not have matched the token — fall through to our extraction below
      }

      // Check output for token patterns — Claude CLI prints tokens in various formats:
      // - "Setup token (expires ...): <token>"
      // - "export CLAUDE_CODE_OAUTH_TOKEN=<token>"
      // - "Store this token securely..." followed by a long token string
      const text = session.cleanOutput;
      // Bulletproof token extraction: match the sk-ant-oat01- prefix directly.
      // PTY output has \r characters and space-padding that break line-based regexes,
      // but the token itself is always a contiguous string starting with sk-ant-oat01-.
      const tokenMatch = text.match(/(sk-ant-oat01-[A-Za-z0-9_\-/.+=]{20,})/);
      if (tokenMatch?.[1]) {
        clearInterval(timer);
        const token = tokenMatch[1].trim();
        console.log(`[Claude] Token captured: ${token.slice(0, 20)}... (${token.length} chars), saving...`);
        saveClaudeToken(token).then((saveResult) => {
          if (saveResult.success) {
            session.status = 'complete';
            session.completedAt = Date.now();
          }
          resolve(saveResult);
        });
        return;
      }

      if (Date.now() - started > 60000) {
        clearInterval(timer);
        // Final check: did the token get saved by onExit while we were waiting?
        const finalProfiles = readProviderProfileIds('anthropic');
        const finalProfile = finalProfiles.find((id) => !session.profileKeyBefore.includes(id));
        if (finalProfile) {
          session.status = 'complete';
          session.completedAt = Date.now();
          resolve({ success: true });
        } else if (session.status === 'complete') {
          resolve({ success: false, error: 'Claude completed but the token could not be extracted from the output. Try using an API key instead.' });
        } else {
          resolve({ success: false, error: 'Timed out waiting for Claude to process the code.' });
        }
      }
    }, 500);
  });

  return result;
}

export async function getClaudeSetupToken(sessionId: string): Promise<{ success: boolean; token?: string; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, error: 'Session not found' };
  if (session.provider !== 'anthropic') return { success: false, error: 'Not a Claude session' };

  const tokenPromise = (session as any)._tokenPromise as Promise<string | null> | undefined;
  if (!tokenPromise) return { success: false, error: 'No token promise found' };

  // Wait up to 120s for the token (user might take a while to complete browser auth)
  const token = await Promise.race([
    tokenPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 120000)),
  ]);

  if (token) {
    return { success: true, token };
  }

  // Check if the session already completed (exit code 0) but we didn't find the token format
  if (session.status === 'complete') {
    // Maybe the token was printed in a format we didn't recognize — give the raw output
    return { success: false, error: 'Claude completed but the token format was not recognized. Check the raw output.' };
  }

  if (session.status === 'error') {
    return { success: false, error: session.error || 'Claude setup-token failed' };
  }

  return { success: false, error: 'Timed out waiting for Claude browser sign-in' };
}

export async function saveClaudeToken(token: string) {
  try {
    // Write directly to auth-profiles.json, openclaw.json, and models.json.
    // The 'openclaw models auth paste-token' CLI is unreliable on fresh installs.
    saveProviderApiKey('anthropic', token);
    console.log(`[Claude] Token saved directly to auth files (${token.length} chars)`);
    return { success: true };
  } catch (err: any) {
    console.error('[Claude] Failed to save token:', err.message);
    return { success: false, error: `Failed to save token: ${err.message}` };
  }
}

// ── Native CLI OAuth flows ──────────────────────────────────────────
// Spawn native CLI binaries (claude, codex, gemini) in PTY to authenticate
// their own credential stores separate from OpenClaw auth profiles.

const HOME_DIR = process.env.HOME || '/root';
const CLAUDE_CREDENTIALS_PATH = path.join(HOME_DIR, '.claude', '.credentials.json');
const CODEX_AUTH_PATH = path.join(HOME_DIR, '.codex', 'auth.json');
const GEMINI_CONFIG_DIR = path.join(HOME_DIR, '.config', 'gemini');
const GEMINI_OAUTH_CREDS_PATH = path.join(HOME_DIR, '.gemini', 'oauth_creds.json');

function findCliBin(command: string): string {
  
  try {
    return execSync(`which ${command}`, { encoding: 'utf-8' }).trim() || command;
  } catch {
    return command;
  }
}

function checkCredentialFile(filePath: string, requiredKeys: string[]): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return requiredKeys.every((key) => {
      const parts = key.split('.');
      let current = content;
      for (const part of parts) {
        if (!current || typeof current !== 'object' || !(part in current)) return false;
        current = current[part];
      }
      return Boolean(current);
    });
  } catch {
    return false;
  }
}

function checkCredentialDir(dirPath: string): boolean {
  try {
    return fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function checkGeminiCredentials(): boolean {
  // Check both the new ~/.gemini/oauth_creds.json and the legacy ~/.config/gemini/ directory
  return checkCredentialFile(GEMINI_OAUTH_CREDS_PATH, ['access_token']) || checkCredentialDir(GEMINI_CONFIG_DIR);
}

export async function startNativeCliFlow(provider: 'claude-code' | 'codex' | 'gemini') {
  const id = createSessionId();
  let session: OAuthSession;

  switch (provider) {
    case 'claude-code': {
      // Claude headless login uses a manual PKCE flow. Do it directly instead of
      // trying to puppet the CLI's internal auth UI.
      const codeVerifier = base64Url(randomBytes(32));
      const codeChallenge = buildPkceChallenge(codeVerifier);
      const state = base64Url(randomBytes(32));
      const scopes = [
        'org:create_api_key',
        'user:profile',
        'user:inference',
        'user:sessions:claude_code',
        'user:mcp_servers',
        'user:file_upload',
      ];
      const authUrl = new URL('https://claude.com/cai/oauth/authorize');
      authUrl.searchParams.append('code', 'true');
      authUrl.searchParams.append('client_id', '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      authUrl.searchParams.append('response_type', 'code');
      authUrl.searchParams.append('redirect_uri', 'https://platform.claude.com/oauth/code/callback');
      authUrl.searchParams.append('scope', scopes.join(' '));
      authUrl.searchParams.append('code_challenge', codeChallenge);
      authUrl.searchParams.append('code_challenge_method', 'S256');
      authUrl.searchParams.append('state', state);

      session = {
        id,
        provider: 'claude-code',
        mode: 'oauth',
        process: null as any,
        authUrl: authUrl.toString(),
        callbackHintUrl: null,
        deviceCode: null,
        verificationUrl: null,
        localPort: null,
        oauthState: state,
        status: 'awaiting_callback',
        error: null,
        output: '',
        cleanOutput: '',
        createdAt: Date.now(),
        completedAt: null,
        profileKeyBefore: [],
        sentInitialConfirm: false,
        extraEnv: { codeVerifier },
      };

      sessions.set(id, session);
      console.log(`[NativeCLI] Claude manual auth URL prepared: ${authUrl.toString().slice(0, 100)}...`);
      break;
    }

    case 'codex': {
      const codexBin = findCliBin('codex');
      console.log(`[NativeCLI] Starting Codex login, binary=${codexBin}`);
      
      const proc = pty.spawn(codexBin, ['login', '--device-auth'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: { ...process.env, BROWSER: '/bin/false' } as Record<string, string>,
      });

      session = {
        id,
        provider: 'codex',
        mode: 'device_code',
        process: proc,
        authUrl: null,
        callbackHintUrl: null,
        deviceCode: null,
        verificationUrl: null,
        localPort: null,
        oauthState: null,
        status: 'starting',
        error: null,
        output: '',
        cleanOutput: '',
        createdAt: Date.now(),
        completedAt: null,
        profileKeyBefore: [],
        sentInitialConfirm: false,
      };

      sessions.set(id, session);

      proc.onData((chunk: string) => {
        session.output += chunk;
        session.cleanOutput += stripAnsi(chunk);
        updateSessionFromOutput(session);
      });

      proc.onExit(({ exitCode }) => {
        console.log(`[NativeCLI] Codex PTY exited: code=${exitCode} status=${session.status}`);
        if (checkCredentialFile(CODEX_AUTH_PATH, ['tokens.access_token'])) {
          session.status = 'complete';
          session.completedAt = Date.now();
          console.log('[NativeCLI] Codex credentials verified');
        } else if (session.status !== 'complete' && !session.error) {
          session.status = 'error';
          session.error = `Codex CLI exited with code ${exitCode}`;
        }
      });

      await waitForInitialOutput(session, 20000);
      break;
    }

    case 'gemini': {
      const geminiBin = findCliBin('gemini');
      console.log(`[NativeCLI] Starting Gemini login, binary=${geminiBin}`);

      // Pre-configure Gemini to use Google OAuth (oauth-personal) so it skips the auth selector
      const geminiDir = path.join(os.homedir(), '.gemini');
      const geminiSettingsPath = path.join(geminiDir, 'settings.json');
      try {
        fs.mkdirSync(geminiDir, { recursive: true });
        let existingSettings: any = {};
        try {
          existingSettings = JSON.parse(fs.readFileSync(geminiSettingsPath, 'utf-8'));
        } catch { /* file doesn't exist yet */ }
        if (!existingSettings.security?.auth?.selectedType) {
          existingSettings.security = existingSettings.security || {};
          existingSettings.security.auth = existingSettings.security.auth || {};
          existingSettings.security.auth.selectedType = 'oauth-personal';
          fs.writeFileSync(geminiSettingsPath, JSON.stringify(existingSettings, null, 2));
          console.log('[NativeCLI] Pre-configured Gemini auth type to oauth-personal');
        }
      } catch (err: any) {
        console.log(`[NativeCLI] Warning: could not pre-configure Gemini settings: ${err.message}`);
      }

      const proc = pty.spawn(geminiBin, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: '/tmp',
        env: { ...process.env, NO_BROWSER: 'true' } as Record<string, string>,
      });

      session = {
        id,
        provider: 'gemini',
        mode: 'oauth',
        process: proc,
        authUrl: null,
        callbackHintUrl: null,
        deviceCode: null,
        verificationUrl: null,
        localPort: null,
        oauthState: null,
        status: 'starting',
        error: null,
        output: '',
        cleanOutput: '',
        createdAt: Date.now(),
        completedAt: null,
        profileKeyBefore: [],
        sentInitialConfirm: false,
      };

      sessions.set(id, session);

      proc.onData((chunk: string) => {
        session.output += chunk;
        session.cleanOutput += stripAnsi(chunk);
        updateSessionFromOutput(session);
      });

      proc.onExit(({ exitCode }) => {
        console.log(`[NativeCLI] Gemini PTY exited: code=${exitCode} status=${session.status}`);
        if (checkGeminiCredentials()) {
          session.status = 'complete';
          session.completedAt = Date.now();
          console.log('[NativeCLI] Gemini credentials verified');
        } else if (exitCode === 199) {
          // Gemini relaunch code — the wrapper should respawn, not an error
          console.log('[NativeCLI] Gemini exited with relaunch code 199, waiting for respawn...');
        } else if (session.status !== 'complete' && !session.error) {
          session.status = 'error';
          session.error = `Gemini CLI exited with code ${exitCode}`;
        }
      });

      // Gemini needs extra time: it relaunches itself after saving auth config
      await waitForInitialOutput(session, 45000);
      break;
    }
  }

  return {
    sessionId: session.id,
    authUrl: session.authUrl,
    callbackHintUrl: session.callbackHintUrl,
    deviceCode: session.deviceCode,
    verificationUrl: session.verificationUrl,
  };
}

export async function completeNativeCliFlow(sessionId: string, callbackValue: string) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Native CLI session not found');
  if (!['claude-code', 'gemini', 'google-gemini-cli'].includes(session.provider)) {
    throw new Error('Session is not a callback-based native CLI flow');
  }

  session.status = 'processing';
  session.error = null;

  if (session.provider === 'claude-code') {
    // Claude headless flow returns a manual auth code in the form code#fragment.
    // The actual token exchange only uses the code plus the PKCE verifier + state we stored.
    if (!session.oauthState || !session.extraEnv?.codeVerifier) {
      return { success: false, error: 'Claude login session is missing OAuth state. Try restarting the flow.' };
    }

    const pasted = callbackValue.trim();
    const code = pasted.split('#')[0]?.trim();
    if (!code) {
      return { success: false, error: 'Invalid authorization code.' };
    }

    try {
      const resp = await fetch('https://platform.claude.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'https://platform.claude.com/oauth/code/callback',
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
          code_verifier: session.extraEnv.codeVerifier,
          state: session.oauthState,
        }),
      });

      const data: any = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const detail = data?.error_description || data?.error || data?.message || `HTTP ${resp.status}`;
        session.status = 'error';
        session.error = `Claude token exchange failed: ${detail}`;
        return { success: false, error: session.error };
      }

      const existing = safeReadJson(CLAUDE_CREDENTIALS_PATH) || {};
      existing.claudeAiOauth = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + ((data.expires_in || 0) * 1000),
        scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [],
        subscriptionType: existing.claudeAiOauth?.subscriptionType ?? null,
        rateLimitTier: existing.claudeAiOauth?.rateLimitTier ?? null,
      };
      fs.mkdirSync(path.dirname(CLAUDE_CREDENTIALS_PATH), { recursive: true });
      fs.writeFileSync(CLAUDE_CREDENTIALS_PATH, JSON.stringify(existing, null, 2));
      console.log('[NativeCLI] Claude OAuth tokens written to credentials file');
    } catch (err: any) {
      session.status = 'error';
      session.error = `Claude token exchange failed: ${err.message}`;
      return { success: false, error: session.error };
    }
  } else if (session.provider === 'gemini' || session.provider === 'google-gemini-cli') {
    // Gemini: write the auth code to PTY stdin (readline is waiting for it)
    let ptyAlive = false;
    try {
      session.process.write('');
      ptyAlive = true;
    } catch {
      ptyAlive = false;
    }

    if (!ptyAlive) {
      return { success: false, error: 'Gemini CLI process is no longer running. Try restarting the flow.' };
    }

    const code = callbackValue.trim();
    console.log(`[NativeCLI] Writing auth code to Gemini stdin (${code.length} chars)`);
    session.process.write(`${code}\r`);
  }

  // Poll for credential files
  const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const credCheck = session.provider === 'claude-code'
        ? checkCredentialFile(CLAUDE_CREDENTIALS_PATH, ['claudeAiOauth.accessToken'])
        : checkGeminiCredentials();

      if (credCheck || session.status === 'complete') {
        clearInterval(timer);
        session.status = 'complete';
        session.completedAt = Date.now();
        resolve({ success: true });
        return;
      }

      if (session.error || session.status === 'error') {
        clearInterval(timer);
        resolve({ success: false, error: session.error || 'Native CLI login failed' });
        return;
      }

      // Check for failure messages in output
      if (/Login failed/i.test(session.cleanOutput) && Date.now() - started > 3000) {
        clearInterval(timer);
        session.status = 'error';
        session.error = 'Login failed — the authorization code may be invalid or expired.';
        resolve({ success: false, error: session.error });
        return;
      }

      if (Date.now() - started > 45000) {
        clearInterval(timer);
        resolve({ success: false, error: 'Timed out waiting for native CLI login to finish.' });
      }
    }, 250);
  });

  return result;
}

setInterval(() => {
  for (const [id, session] of sessions.entries()) {
    if (Date.now() - session.createdAt > 10 * 60 * 1000) {
      try {
        session.process.kill();
      } catch {}
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();
