import type { AgentTool } from '../../api/agentTools';

/**
 * Which host CLI a setup surface depends on, and what Portal may do about it.
 *
 * The server owns the truth (`GET /api/agent-tools`): whether the CLI is
 * present, and whether a first-time install is offered. Portal only renders
 * that and starts the retained install job the server exposes. It never
 * upgrades, replaces, or signs anything in.
 */

/** Portal tool ids (the `/api/agent-tools` inventory) keyed by setup surface. */
export const NATIVE_LOGIN_TOOL_ID: Readonly<Record<string, string>> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
  grok: 'grok-build',
  hermes: 'hermes',
  opencode: 'opencode',
};

/**
 * OpenClaw providers whose sign-in is native OAuth (no CLI needed) but whose
 * matching Agent Chat harness runs a host CLI. The card offers that CLI's
 * install alongside the sign-in so both halves can be completed in one place.
 * Google Gemini CLI is deliberately absent: the provider backend decides
 * whether its native flow needs an install, and the Portal inventory has no
 * distinct Gemini CLI entry.
 */
export const OPENCLAW_PROVIDER_HARNESS_TOOL_ID: Readonly<Record<string, string>> = {
  anthropic: 'claude-code',
  'openai-codex': 'codex',
  xai: 'grok-build',
};

export type CliInstallAvailability =
  | { kind: 'installed'; version: string | null }
  | { kind: 'missing'; installable: true }
  | { kind: 'missing'; installable: false; reason: string }
  | { kind: 'unverified'; reason: string }
  | { kind: 'unknown' };

export function describeInstallUnavailableCode(code: string | null | undefined, toolName: string): string {
  switch (code) {
    case 'NATIVE_BINARY_RUNTIME_UNQUALIFIED':
    case 'CLI_PLATFORM_UNSUPPORTED':
      return `${toolName} cannot be installed automatically on this server's architecture.`;
    case 'HOST_NATIVE_RUNTIME_MUTATION_UNAVAILABLE':
    case 'HOST_TOOL_INSTALL_AFTER_SETUP':
      return `${toolName} is not installed, and this server does not allow Portal to install it. Install it on the server, then refresh.`;
    case 'CLI_ALREADY_PRESENT':
      return `${toolName} is already present on this server.`;
    default:
      return `${toolName} is not installed, and Portal cannot install it on this server. Install it on the server, then refresh.`;
  }
}

/**
 * Reduce an inventory row to what the setup surface needs. `undefined` tool
 * means the inventory could not be loaded (for example before sign-in or on a
 * server that does not expose it): nothing is offered and nothing is claimed.
 */
export function describeCliInstallAvailability(tool: AgentTool | null | undefined): CliInstallAvailability {
  if (!tool) return { kind: 'unknown' };
  const status = tool.status;
  if (status.installed) return { kind: 'installed', version: status.version };
  const absent = status.missing || status.state === 'absent' || (!status.state && !status.installed);
  if (!absent) {
    return {
      kind: 'unverified',
      reason: status.state === 'busy' || status.state === 'recovering'
        ? `${tool.name} is being maintained on the server right now. Refresh in a moment.`
        : status.state === 'recovery-required'
          ? `${tool.name} needs server-side recovery before it can be installed or used. Ask the server owner to run Maintenance.`
          : `Portal could not verify whether ${tool.name} is installed. Refresh to check again.`,
    };
  }
  if (status.installAvailable === true) return { kind: 'missing', installable: true };
  return { kind: 'missing', installable: false, reason: describeInstallUnavailableCode(status.installUnavailableCode, tool.name) };
}

// ── retained install job across a reload ────────────────────────────────────

const RETAINED_INSTALL_KEY = 'bridgesllm.aiSetup.cliInstall.v1';

export interface RetainedCliInstall {
  toolId: string;
  jobId: string;
  startedAt: string;
}

export function readRetainedCliInstall(toolId: string): RetainedCliInstall | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(RETAINED_INSTALL_KEY) || 'null');
    if (parsed && parsed.toolId === toolId && typeof parsed.jobId === 'string' && parsed.jobId && typeof parsed.startedAt === 'string') {
      return { toolId, jobId: parsed.jobId, startedAt: parsed.startedAt };
    }
  } catch {
    // Unreadable browser state is ignored; the server job record is authoritative.
  }
  return null;
}

export function retainCliInstall(value: RetainedCliInstall): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(RETAINED_INSTALL_KEY, JSON.stringify(value));
  } catch {
    // Storage may be unavailable; the in-memory state still tracks the job.
  }
}

export function clearRetainedCliInstall(toolId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const current = readRetainedCliInstall(toolId);
    if (current) window.sessionStorage.removeItem(RETAINED_INSTALL_KEY);
  } catch {
    // Nothing to clear.
  }
}
