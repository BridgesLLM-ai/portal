import fs from "fs";
import path from "path";
import https from "https";
import { execFileSync, execSync } from "child_process";
import dns from "dns/promises";
import { AppError } from "../middleware/errorHandler";
import { appContentOriginIsDistinct, configuredAppContentOrigin } from "./appContentSecurity";
import { ANTIGRAVITY_NO_UPDATE_ENV, PORTAL_TOOL_VERSIONS } from '../config/toolVersions';

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
const DEFAULT_CADDY_PATH = '/etc/caddy/Caddyfile';

export const PORTAL_CADDY_BLOCK_BEGIN = '# BEGIN BridgesLLM Portal — managed block';
export const PORTAL_CADDY_BLOCK_END = '# END BridgesLLM Portal — managed block';
export const PORTAL_CADDY_SETUP_IP_BEGIN = '# BEGIN BridgesLLM Portal — temporary setup IP access';
export const PORTAL_CADDY_SETUP_IP_END = '# END BridgesLLM Portal — temporary setup IP access';
export const APP_CONTENT_CADDY_BLOCK_BEGIN = '# BEGIN BridgesLLM App Content — managed block';
export const APP_CONTENT_CADDY_BLOCK_END = '# END BridgesLLM App Content — managed block';

const LEGACY_PORTAL_HEADERS = new Set([
  '# BridgesLLM Portal — managed by setup wizard',
  '# BridgesLLM Portal — managed by installer',
]);

export interface CaddyCommandRunner {
  validate(configPath: string): void;
  reload(): void;
}

export interface CaddyFileOptions {
  caddyPath?: string;
  commandRunner?: CaddyCommandRunner;
}

interface TextRange {
  start: number;
  end: number;
}

interface ManagedPortalOwnedRange extends TextRange {
  kind: 'managed';
}

interface FileMetadata {
  mode: number;
  uid: number;
  gid: number;
}

const defaultCaddyCommandRunner: CaddyCommandRunner = {
  validate(configPath: string): void {
    execFileSync('caddy', ['validate', '--config', configPath, '--adapter', 'caddyfile'], {
      timeout: 10000,
      stdio: 'ignore',
    });
  },
  reload(): void {
    execFileSync('systemctl', ['reload', 'caddy'], {
      timeout: 10000,
      stdio: 'ignore',
    });
  },
};

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
    installCmd: `npm install -g --no-audit --no-fund @openai/codex@${PORTAL_TOOL_VERSIONS.codexCli}`,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude --version',
    description: 'Anthropic coding agent — strong at architecture, reviews, and complex reasoning',
    installCmd: `npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${PORTAL_TOOL_VERSIONS.claudeCode}`,
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    command: `${ANTIGRAVITY_NO_UPDATE_ENV} agy --version`,
    description: 'Google coding agent — native replacement for Gemini CLI',
    installCmd: 'bash /opt/bridgesllm/portal/installer/antigravity-runtime.sh converge',
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

interface TextLine extends TextRange {
  text: string;
}

interface LegacyPortalOwnedRange extends TextRange {
  kind: 'legacy';
  bodyStart: number;
  setupIpRange?: TextRange;
}

type PortalOwnedRange = ManagedPortalOwnedRange | LegacyPortalOwnedRange;

let caddyTempSequence = 0;

function getTextLines(content: string): TextLine[] {
  const lines: TextLine[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const newline = content.indexOf('\n', cursor);
    const end = newline === -1 ? content.length : newline + 1;
    let text = content.slice(cursor, newline === -1 ? content.length : newline);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    lines.push({ start: cursor, end, text });
    cursor = end;
  }

  return lines;
}

function findExactLines(content: string, marker: string): TextLine[] {
  return getTextLines(content).filter((line) => line.text.trim() === marker);
}

function findMarkedRange(content: string, beginMarker: string, endMarker: string): TextRange | null {
  const begins = findExactLines(content, beginMarker);
  const ends = findExactLines(content, endMarker);

  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0].start < begins[0].end) {
    throw new AppError(500, `Caddyfile contains malformed or duplicate ${beginMarker} markers.`);
  }

  return { start: begins[0].start, end: ends[0].end };
}

/**
 * Find one complete Caddy block using balanced braces. Comments and quoted
 * strings are ignored so nested handlers and matcher expressions are safe.
 */
function findNextCaddyBlock(content: string, from: number): TextRange | null {
  let open = -1;
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let inComment = false;

  for (let index = from; index < content.length; index += 1) {
    const char = content[index];

    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\' && quote !== '`') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '#') {
      inComment = true;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      if (open === -1) open = index;
      depth += 1;
      continue;
    }
    if (char === '}' && open !== -1) {
      depth -= 1;
      if (depth === 0) return { start: open, end: index + 1 };
      if (depth < 0) return null;
    }
  }

  return null;
}

function includeFollowingLineEnding(content: string, end: number): number {
  if (content.startsWith('\r\n', end)) return end + 2;
  if (content[end] === '\n') return end + 1;
  return end;
}

function isPortalReverseProxyBlock(content: string, range: TextRange): boolean {
  return /\breverse_proxy\s+127\.0\.0\.1:4001\b/.test(content.slice(range.start, range.end));
}

function findLegacyPortalOwnedRange(content: string): LegacyPortalOwnedRange | null {
  const legacyHeaders = getTextLines(content).filter((line) => LEGACY_PORTAL_HEADERS.has(line.text.trim()));
  if (legacyHeaders.length === 0) return null;
  if (legacyHeaders.length !== 1) {
    throw new AppError(500, 'Caddyfile contains multiple legacy BridgesLLM Portal blocks; refusing an ambiguous update.');
  }

  const header = legacyHeaders[0];
  const primaryBlock = findNextCaddyBlock(content, header.end);
  if (!primaryBlock || !isPortalReverseProxyBlock(content, primaryBlock)) {
    throw new AppError(500, 'The legacy BridgesLLM Portal Caddy block is incomplete; refusing to modify it.');
  }

  let end = includeFollowingLineEnding(content, primaryBlock.end);
  let setupIpRange: TextRange | undefined;
  const nextMeaningfulLine = getTextLines(content).find(
    (line) => line.start >= end && line.text.trim().length > 0,
  );

  if (nextMeaningfulLine?.text.trim().startsWith('# Keep IP access alive during setup')) {
    const setupIpBlock = findNextCaddyBlock(content, nextMeaningfulLine.end);
    const setupIpHeader = setupIpBlock
      ? content.slice(nextMeaningfulLine.end, setupIpBlock.start).trim()
      : '';
    if (
      !setupIpBlock
      || !/^http:\/\/\d{1,3}(?:\.\d{1,3}){3}$/.test(setupIpHeader)
      || !isPortalReverseProxyBlock(content, setupIpBlock)
    ) {
      throw new AppError(500, 'The legacy BridgesLLM Portal setup-IP block is incomplete; refusing to modify it.');
    }
    setupIpRange = {
      start: nextMeaningfulLine.start,
      end: includeFollowingLineEnding(content, setupIpBlock.end),
    };
    end = setupIpRange.end;
  }

  return {
    start: header.start,
    end,
    kind: 'legacy',
    bodyStart: header.end,
    setupIpRange,
  };
}

function findPortalOwnedRange(content: string): PortalOwnedRange | null {
  const managedRange = findMarkedRange(content, PORTAL_CADDY_BLOCK_BEGIN, PORTAL_CADDY_BLOCK_END);
  if (managedRange) return { ...managedRange, kind: 'managed' };
  return findLegacyPortalOwnedRange(content);
}

function normalizeManagedBlock(managedBlock: string): string {
  const range = findMarkedRange(managedBlock, PORTAL_CADDY_BLOCK_BEGIN, PORTAL_CADDY_BLOCK_END);
  if (
    !range
    || managedBlock.slice(0, range.start).trim().length > 0
    || managedBlock.slice(range.end).trim().length > 0
  ) {
    throw new AppError(500, 'Refusing to install an unmarked BridgesLLM Portal Caddy block.');
  }
  return managedBlock.endsWith('\n') ? managedBlock : `${managedBlock}\n`;
}

export function buildPortalManagedCaddyBlock(
  domain: string,
  publicIp: string,
  includeSetupIpAccess: boolean,
): string {
  const setupIpBlock = includeSetupIpAccess
    ? `
${PORTAL_CADDY_SETUP_IP_BEGIN}
# Keep IP access alive during setup so the wizard can finish on HTTP
http://${publicIp} {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
${PORTAL_CADDY_SETUP_IP_END}
`
    : '';

  return `${PORTAL_CADDY_BLOCK_BEGIN}
# Managed by BridgesLLM Portal. Changes inside this block may be replaced.
${domain}, www.${domain} {
  reverse_proxy 127.0.0.1:4001 {
    flush_interval -1
  }
}
${setupIpBlock}${PORTAL_CADDY_BLOCK_END}
`;
}

function validHostname(value: string): boolean {
  return value.length <= 253
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)
    && !value.includes('..')
    && value.includes('.');
}

export function defaultAppContentDomain(publicIp: string): string {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(publicIp)) {
    throw new AppError(400, 'A public IPv4 address is required to derive the isolated app-content hostname.');
  }
  const octets = publicIp.split('.').map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new AppError(400, 'A valid public IPv4 address is required to derive the isolated app-content hostname.');
  }
  return `app-content.${publicIp}.sslip.io`;
}

export function configuredAppContentDomain(
  publicIp: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicitDomain = String(environment.APP_CONTENT_DOMAIN || '').trim().toLowerCase();
  if (explicitDomain) {
    if (!validHostname(explicitDomain)) throw new AppError(400, 'APP_CONTENT_DOMAIN is not a valid hostname.');
    return explicitDomain;
  }

  const existingOrigin = configuredAppContentOrigin(environment);
  if (existingOrigin) {
    const parsed = new URL(existingOrigin);
    if (parsed.protocol === 'https:' && validHostname(parsed.hostname)) return parsed.hostname.toLowerCase();
  }

  return defaultAppContentDomain(publicIp);
}

export async function resolveAppContentDomain(
  portalDomain: string,
  publicIp: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ domain: string; origin: string; externalDnsFallback: boolean }> {
  const domain = configuredAppContentDomain(publicIp, environment);
  const origin = `https://${domain}`;
  const portalOrigins = [`https://${portalDomain}`, `https://www.${portalDomain}`, `http://${publicIp}`];
  if (!appContentOriginIsDistinct(portalOrigins, origin)) {
    throw new AppError(
      400,
      'The app-content hostname must use a different registrable site from the Portal; sibling subdomains and alternate ports are unsafe.',
    );
  }

  let resolvedIps: string[] = [];
  try {
    resolvedIps = await dns.resolve4(domain);
  } catch {
    throw new AppError(400, `Cannot resolve isolated app-content hostname ${domain}. Add its A record before continuing.`);
  }
  if (!resolvedIps.includes(publicIp)) {
    throw new AppError(
      400,
      `${domain} resolves to ${resolvedIps.join(', ')} but this server is ${publicIp}. Update its A record before continuing.`,
    );
  }

  return {
    domain,
    origin,
    externalDnsFallback: domain === defaultAppContentDomain(publicIp),
  };
}

export function buildAppContentManagedCaddyBlock(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (!validHostname(normalized)) throw new AppError(400, 'Refusing an invalid app-content Caddy hostname.');

  return `${APP_CONTENT_CADDY_BLOCK_BEGIN}
# Active user apps are isolated from Portal cookies and authenticated routes.
${normalized} {
  @bridgesllm_app_content path /share /share/* /hosted /hosted/*
  handle @bridgesllm_app_content {
    reverse_proxy 127.0.0.1:4001 {
      flush_interval -1
    }
  }
  respond "Not found" 404
}
${APP_CONTENT_CADDY_BLOCK_END}
`;
}

export function replaceAppContentManagedCaddyBlock(existing: string, managedBlock: string): string {
  const blockRange = findMarkedRange(managedBlock, APP_CONTENT_CADDY_BLOCK_BEGIN, APP_CONTENT_CADDY_BLOCK_END);
  if (
    !blockRange
    || managedBlock.slice(0, blockRange.start).trim().length > 0
    || managedBlock.slice(blockRange.end).trim().length > 0
  ) {
    throw new AppError(500, 'Refusing to install an unmarked BridgesLLM app-content Caddy block.');
  }
  const existingRange = findMarkedRange(existing, APP_CONTENT_CADDY_BLOCK_BEGIN, APP_CONTENT_CADDY_BLOCK_END);
  const normalizedBlock = managedBlock.endsWith('\n') ? managedBlock : `${managedBlock}\n`;
  if (existingRange) {
    return `${existing.slice(0, existingRange.start)}${normalizedBlock}${existing.slice(existingRange.end)}`;
  }
  if (!existing) return normalizedBlock;
  const separator = existing.endsWith('\n') ? '' : '\n';
  return `${existing}${separator}${normalizedBlock}`;
}

export function replacePortalManagedCaddyBlock(existing: string, managedBlock: string): string {
  const normalizedBlock = normalizeManagedBlock(managedBlock);
  const ownedRange = findPortalOwnedRange(existing);

  if (ownedRange) {
    return `${existing.slice(0, ownedRange.start)}${normalizedBlock}${existing.slice(ownedRange.end)}`;
  }

  if (existing.length === 0) return normalizedBlock;
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${normalizedBlock}`;
}

export function removePortalSetupIpAccessFromContent(existing: string): string {
  const ownedRange = findPortalOwnedRange(existing);
  if (!ownedRange) return existing;

  if (ownedRange.kind === 'managed') {
    const managedBlock = existing.slice(ownedRange.start, ownedRange.end);
    const setupIpRange = findMarkedRange(
      managedBlock,
      PORTAL_CADDY_SETUP_IP_BEGIN,
      PORTAL_CADDY_SETUP_IP_END,
    );
    if (!setupIpRange) return existing;
    const updatedBlock = `${managedBlock.slice(0, setupIpRange.start)}${managedBlock.slice(setupIpRange.end)}`;
    return `${existing.slice(0, ownedRange.start)}${updatedBlock}${existing.slice(ownedRange.end)}`;
  }

  if (!ownedRange.setupIpRange) return existing;
  const legacyBody = `${existing.slice(ownedRange.bodyStart, ownedRange.setupIpRange.start)}${existing.slice(
    ownedRange.setupIpRange.end,
    ownedRange.end,
  )}`.trim();
  const migratedBlock = `${PORTAL_CADDY_BLOCK_BEGIN}
# Managed by BridgesLLM Portal. Changes inside this block may be replaced.
${legacyBody}
${PORTAL_CADDY_BLOCK_END}
`;
  return `${existing.slice(0, ownedRange.start)}${migratedBlock}${existing.slice(ownedRange.end)}`;
}

function getFileMetadata(filePath: string): FileMetadata | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const stat = fs.statSync(filePath);
  return { mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
}

function writeSiblingTempFile(filePath: string, content: string, metadata?: FileMetadata): string {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.bridgesllm-${process.pid}-${Date.now()}-${caddyTempSequence += 1}.tmp`,
  );

  try {
    fs.writeFileSync(tempPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: metadata?.mode ?? 0o644,
    });
    if (metadata) fs.chownSync(tempPath, metadata.uid, metadata.gid);
    return tempPath;
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function restoreOriginalCaddyFile(
  caddyPath: string,
  originalExists: boolean,
  originalContent: string,
  originalMetadata?: FileMetadata,
): void {
  if (!originalExists) {
    if (fs.existsSync(caddyPath)) fs.unlinkSync(caddyPath);
    return;
  }

  const rollbackTemp = writeSiblingTempFile(caddyPath, originalContent, originalMetadata);
  try {
    fs.renameSync(rollbackTemp, caddyPath);
  } catch (error) {
    try { fs.unlinkSync(rollbackTemp); } catch {}
    throw error;
  }
}

function applyCaddyContentUpdate(
  transform: (existing: string) => string,
  options: CaddyFileOptions = {},
): boolean {
  const caddyPath = options.caddyPath ?? DEFAULT_CADDY_PATH;
  const commandRunner = options.commandRunner ?? defaultCaddyCommandRunner;
  const originalExists = fs.existsSync(caddyPath);
  const originalContent = originalExists ? fs.readFileSync(caddyPath, 'utf8') : '';
  const originalMetadata = getFileMetadata(caddyPath);
  const candidateContent = transform(originalContent);

  if (candidateContent === originalContent) return false;

  const candidateTemp = writeSiblingTempFile(caddyPath, candidateContent, originalMetadata);
  try {
    commandRunner.validate(candidateTemp);
  } catch {
    try { fs.unlinkSync(candidateTemp); } catch {}
    throw new AppError(500, 'Caddy configuration validation failed. Existing configuration was left unchanged.');
  }

  try {
    fs.renameSync(candidateTemp, caddyPath);
  } catch {
    try { fs.unlinkSync(candidateTemp); } catch {}
    throw new AppError(500, 'Could not atomically replace the Caddy configuration. Existing configuration was left unchanged.');
  }

  try {
    commandRunner.reload();
  } catch {
    let rollbackRestored = false;
    try {
      restoreOriginalCaddyFile(caddyPath, originalExists, originalContent, originalMetadata);
      rollbackRestored = true;
    } catch {}

    if (rollbackRestored) {
      try { commandRunner.reload(); } catch {}
      throw new AppError(500, 'Caddy reload failed. Restored the previous Caddy configuration.');
    }

    throw new AppError(500, 'Caddy reload failed and the previous Caddy configuration could not be restored automatically.');
  }

  return true;
}

export function updatePortalCaddyConfig(
  domain: string,
  publicIp: string,
  includeSetupIpAccess: boolean,
  options: CaddyFileOptions = {},
): boolean {
  const managedBlock = buildPortalManagedCaddyBlock(domain, publicIp, includeSetupIpAccess);
  return applyCaddyContentUpdate(
    (existing) => replacePortalManagedCaddyBlock(existing, managedBlock),
    options,
  );
}

export function updatePortalAndAppContentCaddyConfig(
  domain: string,
  publicIp: string,
  includeSetupIpAccess: boolean,
  appContentDomain: string,
  options: CaddyFileOptions = {},
): boolean {
  const portalBlock = buildPortalManagedCaddyBlock(domain, publicIp, includeSetupIpAccess);
  const appContentBlock = buildAppContentManagedCaddyBlock(appContentDomain);
  return applyCaddyContentUpdate(
    (existing) => replaceAppContentManagedCaddyBlock(
      replacePortalManagedCaddyBlock(existing, portalBlock),
      appContentBlock,
    ),
    options,
  );
}

export function removePortalSetupIpAccess(options: CaddyFileOptions = {}): boolean {
  return applyCaddyContentUpdate(removePortalSetupIpAccessFromContent, options);
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

export async function configureDomainAndHttps(domain: string): Promise<{
  success: true;
  domain: string;
  url: string;
  appContentOrigin: string;
  appContentUsesExternalDnsFallback: boolean;
  message: string;
  httpsReady: boolean;
}> {
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

  const appContent = await resolveAppContentDomain(domain, publicIp);
  updatePortalAndAppContentCaddyConfig(domain, publicIp, true, appContent.domain);

  // Wait for HTTPS cert to be provisioned (Let's Encrypt ACME takes a few seconds)
  const httpsReady = await waitForHttps(domain, 15000);

  updateEnvFile({
    CORS_ORIGIN: `https://${domain},https://www.${domain},http://${publicIp}`,
    MAIL_DOMAIN: domain,
    PORTAL_URL: `https://${domain}`,
    APP_CONTENT_DOMAIN: appContent.domain,
    APP_CONTENT_ORIGIN: appContent.origin,
    APP_CONTENT_DNS_MODE: appContent.externalDnsFallback ? 'sslip' : 'custom',
  });

  return {
    success: true,
    domain,
    url: `https://${domain}`,
    appContentOrigin: appContent.origin,
    appContentUsesExternalDnsFallback: appContent.externalDnsFallback,
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
