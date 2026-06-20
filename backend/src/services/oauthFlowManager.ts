import * as pty from 'node-pty';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import { execSync } from 'child_process';
import { AUTH_PROFILES_PATH, readAuthProfiles, saveProviderToken } from './openclawConfigManager';
import { buildOpenClawCliEnv } from '../utils/openclawCli';

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
  capturedToken?: string | null;
  lastOutputAt?: number;
  processExited?: boolean;
  processExitCode?: number;
  processExitedAt?: number;
}

const sessions = new Map<string, OAuthSession>();
const OPENCLAW_BIN = 'openclaw';
const ANSI_REGEX = /\x1B\[[0-9;?]*[ -\/]*[@-~]|\x1B[@-_]/g;
const SCREEN_CONTROL_FRAGMENT_REGEX = /\[[0-9;?]*[ -\/]*[@-~]/g;

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

export function normalizeTerminalScreenText(value: string): string {
  return stripAnsi(value)
    .replace(SCREEN_CONTROL_FRAGMENT_REGEX, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function squashPromptText(value: string): string {
  return normalizeTerminalScreenText(value)
    .toLowerCase()
    .replace(/[^a-z0-9:/?._-]+/g, '');
}

export function extractClaudeSetupToken(text: string): string | null {
  const compact = normalizeTerminalScreenText(text).replace(/[\r\n\t ]+/g, '');
  const match = compact.match(/(sk-ant-oat01-[A-Za-z0-9_\-/.+=]{20,})/);
  return match?.[1]?.trim() || null;
}

export function extractClaudeAuthUrl(text: string): string | null {
  const lines = normalizeTerminalScreenText(text).split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const currentLine = lines[i];
    const startIndex = currentLine.indexOf('https://claude.');
    if (startIndex === -1) continue;

    let candidate = currentLine.slice(startIndex).trim();

    for (let j = i + 1; j < lines.length; j += 1) {
      const nextLine = lines[j].trim();
      if (!nextLine) break;
      if (/^Paste\s*code\s*here/i.test(nextLine) || /^Pastecodehereifprompted>?$/i.test(nextLine)) break;
      if (!/^[A-Za-z0-9%&=_\-./+:?#]+$/.test(nextLine)) break;
      candidate += nextLine;
    }

    const match = candidate.match(/^https:\/\/claude\.(?:ai|com)\/[A-Za-z0-9%&=_\-./+:?#]+/);
    if (!match) continue;

    return match[0];
  }

  return null;
}

export function outputLooksLikeClaudeCliAuthImportSuccess(text: string): boolean {
  const normalizedOutput = normalizeTerminalScreenText(stripAnsi(text));
  return /auth profile:|default model available:|claude cli auth detected/i.test(normalizedOutput);
}

function maybeCaptureClaudeSetupToken(session: OAuthSession) {
  if (session.provider !== 'anthropic') return null;
  const token = extractClaudeSetupToken(session.cleanOutput);
  if (!token) return null;
  if (session.capturedToken !== token) {
    session.capturedToken = token;
    session.status = 'complete';
    session.completedAt = Date.now();
    console.log(`[Claude] Token detected in PTY output: ${token.slice(0, 20)}... (${token.length} chars)`);
  }
  return token;
}

function readProviderProfileIds(provider: string) {
  const authProfiles = readAuthProfiles();
  const aliases = getOAuthProfileProviderAliases(provider);
  return Object.keys(authProfiles.profiles || {}).filter((profileId) => aliases.has(authProfiles.profiles?.[profileId]?.provider));
}

export function getOpenClawOAuthProviderId(provider: string): string {
  return provider === 'openai-codex' ? 'openai' : provider;
}

function getOAuthProfileProviderAliases(provider: string): Set<string> {
  if (provider === 'anthropic') return new Set(['anthropic', 'claude-cli']);
  if (provider === 'openai-codex' || provider === 'codex') return new Set(['openai', 'codex', 'openai-codex']);
  return new Set([provider]);
}

function rewriteStoredAuthProfileProvider(profileId: string | null | undefined, provider: string) {
  if (!profileId) return;
  const authProfiles = readAuthProfiles();
  const existing = authProfiles.profiles?.[profileId];
  if (!existing || existing.provider === provider) return;
  authProfiles.profiles[profileId] = {
    ...existing,
    provider,
  };
  fs.mkdirSync(path.dirname(AUTH_PROFILES_PATH), { recursive: true });
  fs.writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(authProfiles, null, 2));
}

function buildPortalOAuthEnv(extraEnv?: Record<string, string>) {
  return {
    ...buildOpenClawCliEnv(),
    ...extraEnv,
    BROWSER: '/bin/false',
    DISPLAY: '',
    WAYLAND_DISPLAY: '',
    SSH_CONNECTION: extraEnv?.SSH_CONNECTION || process.env.SSH_CONNECTION || 'bridgesllm-portal-oauth 127.0.0.1 127.0.0.1 0',
  } as Record<string, string>;
}

function buildOAuthLoginArgs(provider: string): string[] {
  const authProvider = getOpenClawOAuthProviderId(provider);
  const args = ['models', 'auth', 'login', '--provider', authProvider];
  if (provider === 'openai-codex') {
    args.push('--method', 'oauth');
  }
  return args;
}

function isProviderAuthUrl(provider: string, url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    switch (provider) {
      case 'openai-codex':
      case 'openai':
      case 'codex':
        return host === 'auth.openai.com';
      case 'google-gemini-cli':
      case 'gemini':
        return host === 'accounts.google.com' || host === 'accounts.googleusercontent.com';
      case 'anthropic':
      case 'claude-code':
        return host === 'claude.com' || host === 'claude.ai' || host.endsWith('.claude.com') || host.endsWith('.claude.ai');
      default:
        return true;
    }
  } catch {
    return false;
  }
}

function spawnOpenClawPty(args: string[], extraEnv?: Record<string, string>) {
  return pty.spawn(OPENCLAW_BIN, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: {
      ...buildOpenClawCliEnv(),
      // Force OpenClaw's remote/manual OAuth path for portal-managed auth sessions.
      // The portal UI expects a paste-the-redirect flow; letting the CLI drift into
      // local desktop callback mode on a server is brittle and provider-specific.
      SSH_CONNECTION: process.env.SSH_CONNECTION || 'portal-oauth 0 0 0',
      ...extraEnv,
    } as Record<string, string>,
  });
}

function spawnPortalOAuthPty(args: string[], extraEnv?: Record<string, string>) {
  return pty.spawn(OPENCLAW_BIN, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: buildPortalOAuthEnv(extraEnv),
  });
}

function shellEscape(arg: string): string {
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function runOpenClawViaScript(args: string[], timeoutMs: number, extraEnv?: Record<string, string>): string {
  const command = [OPENCLAW_BIN, ...args].map(shellEscape).join(' ');
  try {
    return execSync(`script -qefc ${shellEscape(command)} /dev/null`, {
      cwd: process.cwd(),
      env: {
        ...buildOpenClawCliEnv(),
        ...extraEnv,
      },
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 8,
    }) as string;
  } catch (error: any) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : error?.stdout?.toString?.('utf8') || '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : error?.stderr?.toString?.('utf8') || '';
    const combined = `${stdout}\n${stderr}`.trim();
    throw new Error(combined || error?.message || 'script-wrapped OpenClaw command failed');
  }
}

function checkForNewProviderProfile(session: OAuthSession): boolean {
  const currentProfiles = readProviderProfileIds(session.provider);
  const newProfile = currentProfiles.find((id) => !session.profileKeyBefore.includes(id));
  if (!newProfile) return false;
  session.status = 'complete';
  session.completedAt = Date.now();
  return true;
}

function validateOAuthCallbackForSession(session: OAuthSession, callbackUrl: string): string | null {
  try {
    const parsed = new URL(callbackUrl);
    const state = parsed.searchParams.get('state');
    if (session.oauthState && state && state !== session.oauthState) {
      return 'That redirect URL belongs to a different sign-in attempt. Start the sign-in again and paste the newest callback URL.';
    }
  } catch {
    return 'Invalid callback URL.';
  }
  return null;
}

export function textContainsCallbackPastePrompt(text: string): boolean {
  const normalizedText = normalizeTerminalScreenText(text);
  const squashedText = squashPromptText(text);

  return Boolean(
    /Paste the authorization code/i.test(normalizedText)
    || /Paste the redirect URL here/i.test(normalizedText)
    || /Paste the callback URL here/i.test(normalizedText)
    || /Paste the full redirect url/i.test(normalizedText)
    || /Waiting for you to paste the callback URL/i.test(normalizedText)
    || /Enter the authorization code:/i.test(normalizedText)
    || squashedText.includes('waitingforyoutopastethecallbackurl')
    || squashedText.includes('entertheauthorizationcode')
    || squashedText.includes('pastetheauthorizationcode')
    || squashedText.includes('pastetheredirecturlhere')
    || squashedText.includes('pastethecallbackurlhere')
    || squashedText.includes('pastethefullredirecturl')
  );
}

function hasCallbackPastePrompt(session: OAuthSession): boolean {
  return textContainsCallbackPastePrompt(session.cleanOutput);
}

function waitForCallbackPastePrompt(session: OAuthSession, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (session.error || session.status === 'error') {
        clearInterval(timer);
        reject(new Error(session.error || 'Provider login failed before the callback prompt appeared.'));
        return;
      }

      if (session.processExited) {
        clearInterval(timer);
        reject(new Error('Provider login process exited before the callback prompt was ready. Start the sign-in again.'));
        return;
      }

      if (hasCallbackPastePrompt(session)) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for the callback prompt. Start the sign-in again.'));
      }
    }, 200);
  });
}

function updateSessionFromOutput(session: OAuthSession) {
  const text = session.cleanOutput;
  const normalizedText = normalizeTerminalScreenText(text);
  const squashedText = squashPromptText(text);

  if (session.provider === 'google-gemini-cli') {
    const sawTrustPrompt = squashedText.includes('doyoutrustthefilesinthisfolder?') || squashedText.includes('doyoutrustthefilesinthisfolder');
    const sawOauthPrompt = squashedText.includes('continuewithgooglegeminiclioauth?') || squashedText.includes('continuewithgooglegeminiclioauth');

    // Auto-confirm trust folder prompt (option 1 = "Trust folder")
    if (!(session as any).__trustFolderConfirmed && sawTrustPrompt) {
      (session as any).__trustFolderConfirmed = true;
      session.sentInitialConfirm = true;
      console.log('[NativeCLI] Gemini trust-folder prompt detected, auto-confirming...');
      setTimeout(() => {
        session.process.write('\r');  // Press enter to select default (option 1)
      }, 500);
    }

    // Auto-confirm the Google OAuth caution prompt.
    // Gemini can now surface this prompt even when the trust-folder prompt never appears,
    // and newer TTY renders can draw the prompt as one glyph per line.
    if (sawOauthPrompt && !(session as any).__oauthConfirmed) {
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

  const urls = normalizedText.match(/https?:\/\/[^\s)"'>]+/g) || [];
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
    if (!session.authUrl && !isLocalCallbackUrl && !isGithubDeviceUrl && !isOpenAIDeviceUrl && isProviderAuthUrl(session.provider, url)) {
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
    const match = normalizedText.match(pattern);
    if (match?.[1]) {
      session.deviceCode = match[1];
      break;
    }
  }

  if (session.mode === 'device_code' && (session.deviceCode || session.verificationUrl || /waiting for github authorization/i.test(normalizedText))) {
    if (session.status !== 'complete') {
      session.status = 'polling_device';
    }
  }

  if (session.mode === 'oauth') {
    const needsCallback =
      /paste.*redirect url/i.test(normalizedText)
      || /paste.*callback url/i.test(normalizedText)
      || /paste the authorization code/i.test(normalizedText)
      || /paste the full redirect url/i.test(normalizedText)
      || textContainsCallbackPastePrompt(text)
      || /localhost/i.test(normalizedText)
      || /127\.0\.0\.1/i.test(normalizedText)
      || Boolean(session.authUrl);

    if (needsCallback && session.status !== 'complete') {
      session.status = 'awaiting_callback';
    }
  }

  if (/successfully logged in|login complete|authentication complete|provider added|saved profile|setup.token.*generated|token.*saved|successfully authenticated|auth profile:|default model available:/i.test(normalizedText)) {
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
      const normalizedText = normalizeTerminalScreenText(text);
      const squashedText = squashPromptText(text);
      if (session.status === 'complete') {
        clearInterval(timer);
        resolve(session);
        return;
      }
      const oauthReady = session.mode === 'oauth' && (
        Boolean(session.authUrl)
        || /Open this URL in your LOCAL browser:/i.test(normalizedText)
        || /Paste the authorization code/i.test(normalizedText)
        || /Paste the redirect URL here/i.test(normalizedText)
        || /Waiting for you to paste the callback URL/i.test(normalizedText)
        || textContainsCallbackPastePrompt(text)
        || /browser didn't open, visit:/i.test(normalizedText)
        || /Enter the authorization code:/i.test(normalizedText)  // Gemini headless OAuth
      );

      const deviceReady = session.mode === 'device_code' && (
        Boolean(session.deviceCode)
        || Boolean(session.verificationUrl)
        || /github\.com\/login\/device/i.test(normalizedText)
        || /auth\.openai\.com\/codex\/device/i.test(normalizedText)
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
    session.lastOutputAt = Date.now();
    session.processExited = false;
    maybeCaptureClaudeSetupToken(session);
    updateSessionFromOutput(session);
  });

  session.process.onExit(({ exitCode }) => {
    session.processExited = true;
    session.processExitCode = exitCode;
    session.processExitedAt = Date.now();
    console.log(`[OAuth] PTY exited: provider=${session.provider} code=${exitCode} status=${session.status} hasAuthUrl=${Boolean(session.authUrl)} outputLen=${session.cleanOutput.length}`);
    console.log(`[OAuth] Last 500 chars of clean output: ${session.cleanOutput.slice(-500)}`);
    if (session.status === 'complete') return;
    if (checkForNewProviderProfile(session)) return;
    if (session.authUrl && session.status === 'awaiting_callback') {
      console.log('[OAuth] Process exited after delivering auth URL; portal may respawn a fresh PTY when the callback arrives.');
      return;
    }
    if (exitCode === 0) {
      session.status = 'error';
      session.error = 'Provider login process exited before authentication finished. Start the sign-in again.';
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

  const loginArgs = buildOAuthLoginArgs(provider);

  const id = createSessionId();
  const session: OAuthSession = {
    id,
    provider,
    mode: 'oauth',
    process: spawnPortalOAuthPty(loginArgs, extraEnv),
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
    capturedToken: null,
    lastOutputAt: Date.now(),
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
    capturedToken: null,
    lastOutputAt: Date.now(),
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

export async function importClaudeCliAuthProfile(timeoutMs = 30000) {
  const profileKeyBefore = readProviderProfileIds('anthropic');

  const finalizeSuccess = (rawOutput: string) => {
    const profileIds = readProviderProfileIds('anthropic');
    const createdProfileId = profileIds.find((profileId) => !profileKeyBefore.includes(profileId))
      || profileIds.find((profileId) => profileId === 'anthropic:claude-cli')
      || profileIds[0]
      || null;

    if (createdProfileId === 'anthropic:claude-cli') {
      rewriteStoredAuthProfileProvider(createdProfileId, 'anthropic');
    }

    const normalizedOutput = normalizeTerminalScreenText(stripAnsi(rawOutput));
    const looksSuccessful = Boolean(createdProfileId)
      && outputLooksLikeClaudeCliAuthImportSuccess(normalizedOutput);

    if (!looksSuccessful) {
      const lastOutput = normalizedOutput.trim().split(/\n+/).slice(-12).join('\n').trim();
      throw new Error(lastOutput || 'Claude CLI auth import finished without producing a reusable Anthropic profile.');
    }

    return { success: true as const, profileId: createdProfileId, output: normalizedOutput };
  };

  try {
    const rawOutput = runOpenClawViaScript(['models', 'auth', 'login', '--provider', 'anthropic', '--method', 'cli'], timeoutMs);
    return finalizeSuccess(rawOutput);
  } catch (scriptError: any) {
    const message = String(scriptError?.message || scriptError || '');
    if (outputLooksLikeClaudeCliAuthImportSuccess(message)) {
      return finalizeSuccess(message);
    }
    if (!/\b(script: not found|ENOENT|Timed out waiting)\b/i.test(message)) {
      throw scriptError;
    }
  }

  const process = spawnOpenClawPty(['models', 'auth', 'login', '--provider', 'anthropic', '--method', 'cli']);
  let cleanOutput = '';

  return await new Promise<{ success: true; profileId: string | null; output: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        process.kill();
      } catch {}
      reject(new Error('Timed out waiting for Claude CLI auth import to finish.'));
    }, timeoutMs);

    process.onData((chunk: string) => {
      cleanOutput += chunk;
    });

    process.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try {
        const result = finalizeSuccess(cleanOutput);
        if (exitCode === 0) {
          resolve(result);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }

      const normalizedOutput = normalizeTerminalScreenText(stripAnsi(cleanOutput));
      const lastOutput = normalizedOutput.trim().split(/\n+/).slice(-12).join('\n').trim();
      reject(new Error(lastOutput || `Claude CLI auth import exited with code ${exitCode}`));
    });
  });
}

export async function completeOAuthFlow(sessionId: string, callbackUrl: string) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('OAuth session not found');
  if (session.mode !== 'oauth') throw new Error('Session is not waiting for a callback URL');

  if (session.status === 'complete' || checkForNewProviderProfile(session)) {
    return { success: true };
  }

  const callbackValidationError = validateOAuthCallbackForSession(session, callbackUrl);
  if (callbackValidationError) {
    return { success: false, error: callbackValidationError };
  }

  if (session.processExited) {
    return {
      success: false,
      error: 'Provider login process exited before the callback URL could be entered. Start the sign-in again.',
    };
  }

  if (session.error || session.status === 'error') {
    return {
      success: false,
      error: session.error || 'Provider login process exited before the callback URL could be entered. Start the sign-in again.',
    };
  }

  if (!hasCallbackPastePrompt(session)) {
    try {
      await waitForCallbackPastePrompt(session, session.provider === 'google-gemini-cli' ? 30000 : 15000);
      console.log(`[OAuth] Callback prompt confirmed for provider=${session.provider}; submitting callback URL...`);
    } catch (err: any) {
      console.error(`[OAuth] Callback prompt did not become ready for provider=${session.provider}:`, err.message);
      return { success: false, error: err.message || 'Provider login was not ready to accept the callback URL.' };
    }
  }

  session.status = 'processing';
  session.error = null;

  const callbackInput = callbackUrl;

  try {
    console.log(`[OAuth] Writing callback input for provider=${session.provider} (${callbackInput.length} chars)`);
    session.process.write(callbackInput);
    const submitDelayMs = session.provider === 'google-gemini-cli' ? 250 : 100;
    await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    session.process.write('\r');
  } catch {
    session.status = 'error';
    session.error = 'Provider login process exited before the callback URL could be entered. Start the sign-in again.';
    return { success: false, error: session.error };
  }

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
      if (checkForNewProviderProfile(session)) {
        clearInterval(timer);
        resolve({ success: true });
        return;
      }
      const timeoutMs = session.provider === 'google-gemini-cli' ? 90000 : 60000;
      if (Date.now() - started > timeoutMs) {
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
    authProvider: getOpenClawOAuthProviderId(session.provider),
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

function cleanupStaleClaudeSetupTokenProcesses() {
  try {
    const output = execSync("ps -eo pid=,ppid=,etimes=,args= | grep '[c]laude setup-token'", {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) return;

    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pidRaw, ppidRaw, etimesRaw, args] = match;
      if (!args.includes('claude setup-token')) continue;

      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      const etimes = Number(etimesRaw);
      if (!Number.isFinite(pid) || pid <= 0) continue;

      if (ppid === 1 || etimes > 600) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`[Claude] Cleaned up stale setup-token process pid=${pid} ppid=${ppid} age=${etimes}s`);
        } catch (err: any) {
          console.warn(`[Claude] Failed to clean up stale setup-token pid=${pid}: ${err.message}`);
        }
      }
    }
  } catch {
    // ignore cleanup lookup failures
  }
}

export async function startClaudeSetupTokenFlow() {
  cleanupStaleClaudeSetupTokenProcesses();
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
    capturedToken: null,
    lastOutputAt: Date.now(),
  };

  sessions.set(id, session);

  // Attach parsing — look for the Claude OAuth URL specifically
  proc.onData((chunk: string) => {
    session.output += chunk;
    session.cleanOutput += stripAnsi(chunk);
    session.lastOutputAt = Date.now();
    session.processExited = false;
    maybeCaptureClaudeSetupToken(session);

    // Check for Claude auth URL
    const firstUrl = extractClaudeAuthUrl(session.cleanOutput);
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
        setupToken = session.capturedToken || extractClaudeSetupToken(session.cleanOutput);
        if (setupToken) {
          session.capturedToken = setupToken;
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

  const trimmedCode = code.trim();
  console.log(`[Claude] Pasting auth code (${trimmedCode.length} chars) to PTY...`);

  try {
    session.status = 'processing';
    session.error = null;
    session.process.write(`${trimmedCode}\r\n`);
  } catch (err: any) {
    return { success: false, error: `PTY write failed: ${err.message}` };
  }

  // Give Claude a brief moment to reject obviously bad state, but do not block
  // the request on full token generation. The frontend completes that via /claude/complete.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  maybeCaptureClaudeSetupToken(session);

  if (session.error) {
    return { success: false, error: session.error || 'Claude setup failed' };
  }

  return { success: true };
}

export async function getClaudeSetupToken(sessionId: string): Promise<{ success: boolean; token?: string; error?: string; usedCliImport?: boolean }> {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, error: 'Session not found' };
  if (session.provider !== 'anthropic') return { success: false, error: 'Not a Claude session' };

  const tokenPromise = (session as any)._tokenPromise as Promise<string | null> | undefined;
  if (!tokenPromise) return { success: false, error: 'No token promise found' };

  const started = Date.now();
  let cliImportAttempted = false;

  const maybeImportNativeClaudeAuth = async () => {
    if (cliImportAttempted) return false;
    if (!checkCredentialFile(CLAUDE_CREDENTIALS_PATH, ['claudeAiOauth.accessToken'])) return false;
    cliImportAttempted = true;

    try {
      console.log('[Claude] Native Claude CLI auth detected during setup-token flow; importing into OpenClaw auth profiles...');
      await importClaudeCliAuthProfile(30000);
      session.status = 'complete';
      session.completedAt = Date.now();
      return true;
    } catch (err: any) {
      console.warn('[Claude] Native Claude CLI auth import failed during setup-token flow:', err?.message || err);
      return false;
    }
  };

  while (Date.now() - started < 180000) {
    const liveToken = session.capturedToken || extractClaudeSetupToken(session.cleanOutput);
    if (liveToken) {
      session.capturedToken = liveToken;
      return { success: true, token: liveToken };
    }

    if (await maybeImportNativeClaudeAuth()) {
      return { success: true, usedCliImport: true };
    }

    const token = await Promise.race([
      tokenPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (token) {
      session.capturedToken = token;
      return { success: true, token };
    }

    if (session.status === 'error') {
      return { success: false, error: session.error || 'Claude setup-token failed' };
    }

    if (session.status === 'complete') {
      const completedToken = session.capturedToken || extractClaudeSetupToken(session.cleanOutput);
      if (completedToken) {
        session.capturedToken = completedToken;
        return { success: true, token: completedToken };
      }
      if (await maybeImportNativeClaudeAuth()) {
        return { success: true, usedCliImport: true };
      }
      return { success: false, error: 'Claude completed but the token could not be extracted from the output.' };
    }
  }

  return { success: false, error: 'Timed out waiting for Claude browser sign-in' };
}

export async function saveClaudeToken(token: string) {
  try {
    // Write directly to auth-profiles.json, openclaw.json, and models.json.
    // The 'openclaw models auth paste-token' CLI is unreliable on fresh installs.
    saveProviderToken('anthropic', token);
    console.log(`[Claude] Token saved directly to auth files (${token.length} chars)`);
    return { success: true };
  } catch (err: any) {
    console.error('[Claude] Failed to save token:', err.message);
    return { success: false, error: `Failed to save token: ${err.message}` };
  }
}

// ── Native CLI OAuth flows ──────────────────────────────────────────
// Spawn native CLI binaries (claude, codex, agy) in PTY to authenticate
// their own credential stores separate from OpenClaw auth profiles.

const HOME_DIR = process.env.HOME || '/root';
const CLAUDE_CREDENTIALS_PATH = path.join(HOME_DIR, '.claude', '.credentials.json');
const CODEX_AUTH_PATH = path.join(HOME_DIR, '.codex', 'auth.json');

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

function checkAntigravityCredentials(): boolean {
  try {
    execSync('agy models >/dev/null 2>&1', {
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        SSH_CONNECTION: process.env.SSH_CONNECTION || 'portal-auth-check 127.0.0.1 127.0.0.1 0',
      },
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
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
      const antigravityBin = findCliBin('agy');
      console.log(`[NativeCLI] Starting Antigravity login, binary=${antigravityBin}`);

      // Pre-configure Antigravity to use Google OAuth so it skips any auth selector.
      const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity-cli');
      const antigravitySettingsPath = path.join(antigravityDir, 'settings.json');
      try {
        fs.mkdirSync(antigravityDir, { recursive: true });
        let existingSettings: any = {};
        try {
          existingSettings = JSON.parse(fs.readFileSync(antigravitySettingsPath, 'utf-8'));
        } catch { /* file doesn't exist yet */ }
        if (!existingSettings.security?.auth?.selectedType) {
          existingSettings.security = existingSettings.security || {};
          existingSettings.security.auth = existingSettings.security.auth || {};
          existingSettings.security.auth.selectedType = 'oauth-personal';
          fs.writeFileSync(antigravitySettingsPath, JSON.stringify(existingSettings, null, 2));
          console.log('[NativeCLI] Pre-configured Antigravity auth type to oauth-personal');
        }
      } catch (err: any) {
        console.log(`[NativeCLI] Warning: could not pre-configure Antigravity settings: ${err.message}`);
      }

      const proc = pty.spawn(antigravityBin, ['--print', 'Authentication setup complete. Reply exactly AUTH_OK.', '--print-timeout', '5m', '--sandbox'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: '/tmp',
        env: {
          ...process.env,
          NO_BROWSER: 'true',
          SSH_CONNECTION: process.env.SSH_CONNECTION || 'portal-antigravity-auth 127.0.0.1 127.0.0.1 0',
        } as Record<string, string>,
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
        console.log(`[NativeCLI] Antigravity PTY exited: code=${exitCode} status=${session.status}`);
        if (checkAntigravityCredentials()) {
          session.status = 'complete';
          session.completedAt = Date.now();
          console.log('[NativeCLI] Antigravity credentials verified');
        } else if (session.status !== 'complete' && !session.error) {
          session.status = 'error';
          session.error = `Antigravity CLI exited with code ${exitCode}`;
        }
      });

      // Antigravity can take a few seconds before it prints the Google authorization URL.
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
    // Antigravity: write the auth code to PTY stdin (readline is waiting for it)
    let ptyAlive = false;
    try {
      session.process.write('');
      ptyAlive = true;
    } catch {
      ptyAlive = false;
    }

    if (!ptyAlive) {
      return { success: false, error: 'Antigravity CLI process is no longer running. Try restarting the flow.' };
    }

    const code = callbackValue.trim();
    console.log(`[NativeCLI] Writing auth code to Antigravity stdin (${code.length} chars)`);
    session.process.write(`${code}\r`);
  }

  // Poll for credential files
  const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const credCheck = session.provider === 'claude-code'
        ? checkCredentialFile(CLAUDE_CREDENTIALS_PATH, ['claudeAiOauth.accessToken'])
        : checkAntigravityCredentials();

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
