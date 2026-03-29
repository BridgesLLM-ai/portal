import * as pty from 'node-pty';
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

  if (
    session.provider === 'google-gemini-cli'
    && !session.sentInitialConfirm
    && /Continue with Google Gemini CLI OAuth\?/i.test(text)
  ) {
    session.sentInitialConfirm = true;
    console.log('[OAuth] Google caution prompt detected, auto-confirming in 500ms...');
    // Default selection is "No"; send left-arrow to move to "Yes", then Enter after a delay.
    // Use setTimeout to avoid race with the prompt rendering.
    setTimeout(() => {
      console.log('[OAuth] Sending left-arrow...');
      session.process.write('\u001b[D');
      setTimeout(() => {
        console.log('[OAuth] Sending enter...');
        session.process.write('\r');
      }, 300);
    }, 500);
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

    if (!session.verificationUrl && isGithubDeviceUrl) {
      session.verificationUrl = url;
    }
    if (!session.authUrl && !isLocalCallbackUrl && !isGithubDeviceUrl) {
      session.authUrl = url;
    }
    if (!session.callbackHintUrl && isLocalCallbackUrl) {
      session.callbackHintUrl = url;
    }
  }

  const deviceCodePatterns = [
    /Code:\s*([A-Z0-9-]{4,})/i,
    /device code[:\s]+([A-Z0-9-]{4,})/i,
    /enter (?:the )?code[:\s]+([A-Z0-9-]{4,})/i,
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
      );

      const deviceReady = session.mode === 'device_code' && (
        Boolean(session.deviceCode)
        || Boolean(session.verificationUrl)
        || /github\.com\/login\/device/i.test(text)
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
  const { execSync } = require('child_process');
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
        // Try to extract the token from the output — Claude CLI prints in multiple formats
        const text = session.cleanOutput;
        const patterns = [
          /(?:Setup token[^:]*:\s*)([A-Za-z0-9_\-/.+=]{20,})/i,
          /(?:Token:\s*)([A-Za-z0-9_\-/.+=]{20,})/i,
          /CLAUDE_CODE_OAUTH_TOKEN=([A-Za-z0-9_\-/.+=]{20,})/,
          /(?:Store this token|won't be able to see it)[\s\S]*?\n\s*([A-Za-z0-9_\-/.+=]{50,})/i,
          /\n([A-Za-z0-9_\-/.+=]{50,})\s*\n/,
        ];
        for (const pat of patterns) {
          const m = text.match(pat);
          if (m?.[1]) {
            setupToken = m[1].trim();
            console.log(`[Claude] Token captured from output (${setupToken.length} chars)`);
            // Save immediately — don't wait for frontend to ask
            saveClaudeToken(setupToken);
            break;
          }
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
      const tokenPatterns = [
        /(?:setup[- ]token[^:]*:\s*)([A-Za-z0-9_\-/.+=]{20,})/i,
        /CLAUDE_CODE_OAUTH_TOKEN=([A-Za-z0-9_\-/.+=]{20,})/,
        /(?:Store this token|won't be able to see it)[\s\S]*?\n\s*([A-Za-z0-9_\-/.+=]{50,})/i,
        /\n([A-Za-z0-9_\-/.+=]{50,})\s*\n/,
      ];
      for (const pattern of tokenPatterns) {
        const tokenMatch = text.match(pattern);
        if (tokenMatch?.[1]) {
          clearInterval(timer);
          const token = tokenMatch[1].trim();
          console.log(`[Claude] Token captured from output (${token.length} chars), saving...`);
          saveClaudeToken(token).then((saveResult) => {
            if (saveResult.success) {
              session.status = 'complete';
              session.completedAt = Date.now();
            }
            resolve(saveResult);
          });
          return;
        }
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
