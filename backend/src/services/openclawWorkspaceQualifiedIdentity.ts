import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * OpenClaw 2026.9.2 workspace-qualified sandbox identity.
 *
 * From 9.2 on, a non-shared (scope `session`) sandbox runtime is keyed by the
 * session key PLUS the resolved agent workspace path. The Gateway derives the
 * container name, the per-session sandbox workspace directory and the
 * `openclaw.configHash` label from that qualified key and adopts a
 * pre-existing container only when the name AND the configHash label match
 * its own expectation (otherwise it removes and recreates it). Portal must
 * therefore reproduce these derivations exactly so that the container it
 * attests and stages its private runtime challenge into is the one the
 * model's `exec` tool actually runs in.
 *
 * Mirrors (installed openclaw dist): src/agents/sandbox/shared.ts
 * (slugifySessionKey, buildSandboxContainerName, resolveSandboxScopeKey),
 * src/agents/sandbox/config-hash.ts (normalizeForHash, computeSandboxConfigHash),
 * src/agents/sandbox/workspace-mounts.ts (resolveReadOnlyWorkspaceSkillMounts,
 * formatReadOnlyWorkspaceSkillMountHashState) and docker.ts
 * (ensureSandboxContainerLifecycle hash inputs). Verified on TEST against a
 * live 9.2 container: scopeKey suffix d4baa011…, slug workspace-ef5c9c09…,
 * name p4oc-79-workspace-ef5c…-283ef0d4b775, configHash dcbec56b… all matched
 * both OpenClaw's own exports and this re-implementation.
 *
 * This module is intentionally pure (no Docker, no Gateway) so the sandbox
 * planner and the qualification flow can share it and tests can pin the
 * derivations to known values.
 */

export const OPENCLAW_92_SANDBOX_MOUNT_FORMAT_VERSION = 4;
export const OPENCLAW_92_SANDBOX_CREATE_ARGS_EPOCH = '2026-08-25-container-env-file';
const CONTAINER_NAME_MAX_LENGTH = 63;
const WORKSPACE_SCOPE_SUFFIX_RE = /:workspace:[a-f0-9]{32}$/i;
const WORKSPACE_RUNTIME_SLUG_RE = /^workspace-[a-f0-9]{32}$/i;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

/** `${sessionKey}:workspace:${sha256(resolvedAgentWorkspaceDir).slice(0, 32)}` (scope `session`). */
export function resolveOpenClawWorkspaceScopeKey(sessionKey: string, agentWorkspaceDir: string): string {
  const key = requireNonEmpty(sessionKey, 'OpenClaw session key');
  const workspace = requireNonEmpty(agentWorkspaceDir, 'OpenClaw agent workspace');
  if (!path.isAbsolute(workspace)) throw new Error('OpenClaw agent workspace must be absolute');
  if (WORKSPACE_SCOPE_SUFFIX_RE.test(key)) throw new Error('OpenClaw session key is already workspace-qualified');
  return `${key}:workspace:${sha256Hex(path.resolve(workspace)).slice(0, 32)}`;
}

/** OpenClaw's slugifySessionKey for a workspace-qualified scope key. */
export function slugifyOpenClawWorkspaceScopeKey(scopeKey: string): string {
  const trimmed = requireNonEmpty(scopeKey, 'OpenClaw scope key');
  if (!WORKSPACE_SCOPE_SUFFIX_RE.test(trimmed)) throw new Error('OpenClaw scope key is not workspace-qualified');
  return `workspace-${sha256Hex(trimmed).slice(0, 32)}`;
}

/** OpenClaw's buildSandboxContainerName: keeps the identity slug, truncates the prefix. */
export function buildOpenClawSandboxContainerName(prefix: string, slug: string): string {
  if (!WORKSPACE_RUNTIME_SLUG_RE.test(slug)) throw new Error('OpenClaw runtime slug is not workspace-qualified');
  const fullName = `${prefix}${slug}`;
  if (fullName.length <= CONTAINER_NAME_MAX_LENGTH) return fullName;
  const identitySuffix = `-${slug}-${sha256Hex(fullName).slice(0, 12)}`;
  const prefixBudget = CONTAINER_NAME_MAX_LENGTH - identitySuffix.length;
  return `${prefix.slice(0, prefixBudget)}${identitySuffix}`;
}

export interface OpenClawWorkspaceQualifiedRuntimeIdentity {
  readonly sessionKey: string;
  readonly scopeKey: string;
  readonly slug: string;
  readonly containerName: string;
  readonly sandboxWorkspaceDir: string;
}

/** Derives the complete 9.2 non-shared runtime identity for one Portal project agent. */
export function resolveOpenClawWorkspaceQualifiedRuntime(input: {
  sessionKey: string;
  agentWorkspaceDir: string;
  sandboxWorkspaceRoot: string;
  containerPrefix: string;
}): OpenClawWorkspaceQualifiedRuntimeIdentity {
  const root = requireNonEmpty(input.sandboxWorkspaceRoot, 'OpenClaw sandbox workspace root');
  if (!path.isAbsolute(root)) throw new Error('OpenClaw sandbox workspace root must be absolute');
  const prefix = requireNonEmpty(input.containerPrefix, 'OpenClaw container prefix');
  const scopeKey = resolveOpenClawWorkspaceScopeKey(input.sessionKey, input.agentWorkspaceDir);
  const slug = slugifyOpenClawWorkspaceScopeKey(scopeKey);
  return Object.freeze({
    sessionKey: input.sessionKey.trim(),
    scopeKey,
    slug,
    containerName: buildOpenClawSandboxContainerName(prefix, slug),
    sandboxWorkspaceDir: path.join(path.resolve(root), slug),
  });
}

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.endsWith('/') && root !== '/' ? root.slice(0, -1) : root;
  const suffix = parts.map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

export interface OpenClawReadOnlySkillMount {
  readonly hostPath: string;
  readonly containerPath: string;
}

/**
 * Read-only skill overlays OpenClaw adds for `workspaceAccess: none`: the
 * `skills` and `.agents/skills` directories that exist under the sandbox
 * workspace directory, mounted below the container workdir.
 */
export function resolveOpenClawReadOnlySkillMounts(input: {
  sandboxWorkspaceDir: string;
  workdir: string;
  isDirectory?: (hostPath: string) => boolean;
}): OpenClawReadOnlySkillMount[] {
  const isDirectory = input.isDirectory || ((hostPath: string) => {
    try {
      return fs.lstatSync(hostPath).isDirectory();
    } catch {
      return false;
    }
  });
  const candidates: Array<{ segments: string[] }> = [
    { segments: ['skills'] },
    { segments: ['.agents', 'skills'] },
  ];
  const mounts: OpenClawReadOnlySkillMount[] = [];
  for (const candidate of candidates) {
    const hostPath = path.join(input.sandboxWorkspaceDir, ...candidate.segments);
    if (!isDirectory(hostPath)) continue;
    mounts.push(Object.freeze({
      hostPath,
      containerPath: containerJoin(input.workdir, ...candidate.segments),
    }));
  }
  return mounts;
}

/** Docker `-v` spec OpenClaw writes for a managed workspace mount. */
export function formatOpenClawManagedWorkspaceBind(hostPath: string, containerPath: string, readOnly: boolean): string {
  return `${hostPath}:${containerPath}:${readOnly ? 'ro,z' : 'z'}`;
}

/** Stable hash state OpenClaw feeds into the config hash for skill mounts. */
export function formatOpenClawReadOnlySkillMountHashState(mounts: readonly OpenClawReadOnlySkillMount[]): string[] {
  return mounts.map((mount) => `${mount.hostPath}:${mount.containerPath}:ro`);
}

/** OpenClaw's normalizeForHash: sorted keys, undefined dropped (also inside arrays). */
export function normalizeOpenClawHashInput(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map(normalizeOpenClawHashInput).filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      const next = normalizeOpenClawHashInput(entryValue);
      if (next !== undefined) normalized[key] = next;
    }
    return normalized;
  }
  return value;
}

/**
 * OpenClaw 9.2 `openclaw.configHash` for a non-shared Docker sandbox. `docker`
 * must be the exact `sandbox.docker` object the agent config carries (Portal's
 * desired docker config); `workspaceDir` is the 9.2 sandbox workspace
 * directory (NOT the agent workspace). `dockerEnvPolicyEpoch` is OpenClaw's
 * resolveDockerEnvPolicyEpoch(docker.env); it resolved to undefined for the
 * Portal project env on TEST, and undefined is dropped by the normalizer.
 */
export function computeOpenClaw92SandboxConfigHash(input: {
  docker: Record<string, unknown>;
  workspaceAccess: 'none' | 'ro' | 'rw';
  workspaceDir: string;
  agentWorkspaceDir: string;
  readOnlyWorkspaceSkillMounts: readonly string[];
  dockerEnvPolicyEpoch?: string;
}): string {
  const payload = normalizeOpenClawHashInput({
    docker: input.docker,
    dockerEnvPolicyEpoch: input.dockerEnvPolicyEpoch,
    workspaceAccess: input.workspaceAccess,
    workspaceDir: input.workspaceDir,
    agentWorkspaceDir: input.agentWorkspaceDir,
    mountFormatVersion: OPENCLAW_92_SANDBOX_MOUNT_FORMAT_VERSION,
    createArgsEpoch: OPENCLAW_92_SANDBOX_CREATE_ARGS_EPOCH,
    readOnlyWorkspaceSkillMounts: [...input.readOnlyWorkspaceSkillMounts],
  });
  return sha256Hex(JSON.stringify(payload));
}

/** Container path the 9.2 runtime uses as workdir for `workspaceAccess: none`. */
export function isOpenClawWorkspaceQualifiedScopeKey(value: string): boolean {
  return WORKSPACE_SCOPE_SUFFIX_RE.test(String(value || '').trim());
}
