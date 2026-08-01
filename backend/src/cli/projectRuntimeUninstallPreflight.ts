import { execFile } from 'child_process';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import type { ProjectIdentityRecord } from '../services/projectIdentity';

const PORTAL_SERVICE = 'bridgesllm-product.service';
const SYSTEMCTL_BIN = '/usr/bin/systemctl';
const DOCKER_BIN = '/usr/bin/docker';
const IPTABLES_BIN = '/usr/sbin/iptables';
const IP6TABLES_BIN = '/usr/sbin/ip6tables';
const DEFAULT_MAX_RUNTIME_SECONDS = 30 * 60;
const MIN_MAX_RUNTIME_SECONDS = 60;
const MAX_MAX_RUNTIME_SECONDS = 60 * 60;
const MAX_ENV_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;

export const PROJECT_RUNTIME_UNINSTALL_LIMITS = Object.freeze({
  projectIdentities: 1024,
  appsPerProject: 128,
  residualResources: 64,
  reportedResiduals: 16,
});

export type ProjectRuntimeResidualKind = 'container' | 'volume' | 'network';

export interface ProjectRuntimeResidual {
  kind: ProjectRuntimeResidualKind;
  identifier: string;
}

export interface ProjectRuntimeUninstallApp {
  id: string;
  userId: string;
}

export interface ProjectRuntimeCleanupSummary {
  removedResourceCount: number;
}

export interface ProjectRuntimeUninstallPreflightDependencies {
  listProjectIdentities(limit: number): Promise<readonly ProjectIdentityRecord[]>;
  listProjectApps(
    identity: Readonly<ProjectIdentityRecord>,
    limit: number,
  ): Promise<readonly ProjectRuntimeUninstallApp[]>;
  stopProjectApp(
    identity: Readonly<ProjectIdentityRecord>,
    app: Readonly<ProjectRuntimeUninstallApp>,
  ): Promise<void>;
  removeProjectWorkloads(projectIdentityId: string): Promise<number>;
  cleanupProjectRuntime(
    identity: Readonly<ProjectIdentityRecord>,
  ): Promise<ProjectRuntimeCleanupSummary>;
  cleanupKnownFirewallResiduals(): Promise<number>;
  cleanupOrphanedResiduals(): Promise<number>;
  scanKnownResiduals(): Promise<readonly ProjectRuntimeResidual[]>;
  disconnect(): Promise<void>;
}

export interface ProjectRuntimeUninstallPreflightResult {
  projectCount: number;
  appCount: number;
  workloadCount: number;
  providerResourceCount: number;
}

interface CommandResult {
  code: number;
  stdout: string;
}

export interface ProjectRuntimeUninstallReadOnlyCommandRunner {
  run(file: string, args: readonly string[], timeoutMs: number): Promise<CommandResult>;
}

export class ProjectRuntimeUninstallPreflightError extends Error {
  constructor(
    public readonly code: string,
    public readonly safeIdentifiers: readonly string[] = [],
    /**
     * Bounded, human-readable description of the underlying failure.
     *
     * Without this the operator sees only an opaque code and has no way to
     * learn why their uninstall aborted -- there is no log file, and the
     * original error was previously discarded entirely. Bounded and
     * newline-stripped because it is written to stderr during uninstall.
     */
    public readonly detail: string = '',
  ) {
    super(code);
    this.name = 'ProjectRuntimeUninstallPreflightError';
  }
}

/**
 * Bound and REDACT an arbitrary thrown value into one safe stderr line.
 *
 * Provider errors are untrusted: they routinely carry cookies, tokens, URLs,
 * and connection strings, and this string is printed during uninstall. So the
 * detail is redacted aggressively rather than echoed. Everything that looks
 * like an assignment, a URL, or a long opaque blob is removed; what survives
 * is the human-readable prose that actually aids diagnosis (for example
 * "OPENCLAW Project runtime cleanup failed").
 *
 * Redaction is deliberately over-broad. Losing a detail is acceptable; leaking
 * a credential into an operator's terminal or scrollback is not.
 */
export function preflightFailureDetail(error: unknown): string {
  const raw = error instanceof Error
    ? (error.message || error.name)
    : (typeof error === 'string' ? error : '');
  return raw
    .replace(/\s+/g, ' ')
    // any key=value / key: value assignment, whatever the key
    .replace(/\b[\w.-]+\s*[:=]\s*\S+/g, '[redacted]')
    // URLs and connection strings
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[redacted]')
    // long opaque blobs (tokens, hashes, base64)
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

const RESIDUAL_QUERIES = Object.freeze([
  Object.freeze({
    kind: 'container' as const,
    selector: 'com.bridgesllm.project-egress.runtime-fingerprint',
  }),
  Object.freeze({
    kind: 'container' as const,
    selector: 'com.bridgesllm.project-egress.policy',
  }),
  Object.freeze({
    kind: 'container' as const,
    selector: 'com.bridgesllm.project-workload.policy',
  }),
  // Ollama Project runtimes are intentionally network-isolated and therefore
  // do not carry the shared project-egress labels. Keep their own immutable
  // runtime-policy label in the global scan so an orphaned container cannot
  // survive a clean-slate uninstall after its database identity is gone.
  Object.freeze({
    kind: 'container' as const,
    selector: 'com.bridgesllm.ollama-project.policy',
  }),
  Object.freeze({
    kind: 'container' as const,
    selector: 'com.bridgesllm.project-runtime=true',
  }),
  Object.freeze({
    kind: 'container' as const,
    selector: 'com.bridgesllm.project-git=true',
  }),
  Object.freeze({
    kind: 'container' as const,
    selector: 'io.bridgesllm.managed=agent-zero-project',
  }),
  Object.freeze({
    kind: 'volume' as const,
    selector: 'io.bridgesllm.managed=agent-zero-project',
  }),
  Object.freeze({
    kind: 'network' as const,
    selector: 'io.bridgesllm.managed=agent-zero-project',
  }),
  Object.freeze({
    kind: 'network' as const,
    selector: 'com.bridgesllm.project-egress.policy',
  }),
]);

interface ReservedProjectDockerNameQuery {
  kind: ProjectRuntimeResidualKind;
  patterns: readonly RegExp[];
}

// These are the exact deterministic Docker resource names emitted by the
// Portal Project runtimes. Labels remain the primary ownership contract for
// cleanup, but clean-slate verification must not let a missing or
// contradictory label hide a product-shaped orphan after its database row is
// gone. This scan is deliberately read-only: an exact name match is reported
// as a residual for fail-closed handling, never deleted by name alone.
const RESERVED_PROJECT_DOCKER_NAME_QUERIES: readonly ReservedProjectDockerNameQuery[] = Object.freeze([
  Object.freeze({
    kind: 'container' as const,
    patterns: Object.freeze([
      /^p4e-proxy-[a-f0-9]{20}$/,
      /^p4ol-[a-f0-9]{24}$/,
      /^p4cx-[a-f0-9]{24}$/,
      /^p4cc-[a-f0-9]{24}$/,
      /^p4ag-[a-f0-9]{24}$/,
      /^p4oc-[a-f0-9]{16}-[a-z0-9._-]{1,32}-[a-f0-9]{8}$/,
      /^bridgesllm-a0p-[a-f0-9]{24}$/,
      /^bridgesllm-project-(?:app|job|git)-[a-f0-9]{20}$/,
    ]),
  }),
  Object.freeze({
    kind: 'volume' as const,
    patterns: Object.freeze([
      /^bridgesllm-a0p-[a-f0-9]{24}-usr$/,
    ]),
  }),
  Object.freeze({
    kind: 'network' as const,
    patterns: Object.freeze([
      /^p4e-(?:in|out)-[a-f0-9]{20}$/,
    ]),
  }),
]);

function boundedIdentifier(value: unknown): string {
  const normalized = String(value || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) return normalized;
  const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `redacted-${digest}`;
}

function preflightError(error: unknown, code: string, identifiers: readonly unknown[] = []): never {
  if (error instanceof ProjectRuntimeUninstallPreflightError) throw error;
  // Carry the cause forward. Discarding it left operators with an opaque code
  // and nothing to act on when an uninstall aborted.
  throw new ProjectRuntimeUninstallPreflightError(
    code,
    identifiers.map(boundedIdentifier),
    preflightFailureDetail(error),
  );
}

function assertBeforeDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) {
    throw new ProjectRuntimeUninstallPreflightError('PREFLIGHT_DEADLINE_EXCEEDED');
  }
}

export async function runProjectRuntimeUninstallPreflight(
  dependencies: ProjectRuntimeUninstallPreflightDependencies,
  options: { deadlineMs: number },
): Promise<ProjectRuntimeUninstallPreflightResult> {
  assertBeforeDeadline(options.deadlineMs);
  let identities: readonly ProjectIdentityRecord[];
  try {
    identities = await dependencies.listProjectIdentities(
      PROJECT_RUNTIME_UNINSTALL_LIMITS.projectIdentities + 1,
    );
  } catch (error) {
    preflightError(error, 'PROJECT_IDENTITY_DISCOVERY_FAILED');
  }
  if (identities.length > PROJECT_RUNTIME_UNINSTALL_LIMITS.projectIdentities) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_IDENTITY_LIMIT_EXCEEDED');
  }

  const orderedIdentities = [...identities].sort((left, right) => left.id.localeCompare(right.id));
  let appCount = 0;
  let workloadCount = 0;
  let providerResourceCount = 0;

  for (const identity of orderedIdentities) {
    const safeProjectId = boundedIdentifier(identity.id);
    assertBeforeDeadline(options.deadlineMs);
    let apps: readonly ProjectRuntimeUninstallApp[];
    try {
      apps = await dependencies.listProjectApps(
        identity,
        PROJECT_RUNTIME_UNINSTALL_LIMITS.appsPerProject + 1,
      );
    } catch (error) {
      preflightError(error, 'PROJECT_APP_DISCOVERY_FAILED', [safeProjectId]);
    }
    if (apps.length > PROJECT_RUNTIME_UNINSTALL_LIMITS.appsPerProject) {
      throw new ProjectRuntimeUninstallPreflightError(
        'PROJECT_APP_LIMIT_EXCEEDED',
        [safeProjectId],
      );
    }

    for (const app of [...apps].sort((left, right) => left.id.localeCompare(right.id))) {
      assertBeforeDeadline(options.deadlineMs);
      try {
        await dependencies.stopProjectApp(identity, app);
      } catch (error) {
        preflightError(error, 'PROJECT_APP_STOP_FAILED', [safeProjectId, app.id]);
      }
      appCount += 1;
    }

    assertBeforeDeadline(options.deadlineMs);
    try {
      workloadCount += await dependencies.removeProjectWorkloads(identity.id);
    } catch (error) {
      preflightError(error, 'PROJECT_WORKLOAD_CLEANUP_FAILED', [safeProjectId]);
    }

    assertBeforeDeadline(options.deadlineMs);
    try {
      const cleanup = await dependencies.cleanupProjectRuntime(identity);
      providerResourceCount += cleanup.removedResourceCount;
    } catch (error) {
      preflightError(error, 'PROJECT_PROVIDER_CLEANUP_FAILED', [safeProjectId]);
    }
    assertBeforeDeadline(options.deadlineMs);
  }

  try {
    providerResourceCount += await dependencies.cleanupKnownFirewallResiduals();
  } catch (error) {
    preflightError(error, 'PROJECT_FIREWALL_CLEANUP_FAILED');
  }
  assertBeforeDeadline(options.deadlineMs);

  // Sweep managed resources orphaned from their database identity before the
  // final scan, otherwise they are detected and never removed.
  try {
    providerResourceCount += await dependencies.cleanupOrphanedResiduals();
  } catch (error) {
    preflightError(error, 'PROJECT_ORPHAN_CLEANUP_FAILED');
  }
  assertBeforeDeadline(options.deadlineMs);

  let residuals: readonly ProjectRuntimeResidual[];
  try {
    residuals = await dependencies.scanKnownResiduals();
  } catch (error) {
    preflightError(error, 'PROJECT_RESIDUAL_SCAN_FAILED');
  }
  if (residuals.length > 0) {
    const identifiers = residuals
      .slice(0, PROJECT_RUNTIME_UNINSTALL_LIMITS.reportedResiduals)
      .map((entry) => `${entry.kind}:${boundedIdentifier(entry.identifier)}`);
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_RUNTIME_RESIDUALS', identifiers);
  }

  assertBeforeDeadline(options.deadlineMs);
  return Object.freeze({
    projectCount: orderedIdentities.length,
    appCount,
    workloadCount,
    providerResourceCount,
  });
}

const defaultCommandRunner: ProjectRuntimeUninstallReadOnlyCommandRunner = {
  run(file, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(file, [...args], {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        windowsHide: true,
        env: {
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          HOME: '/tmp',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
      }, (error, stdout) => {
        if (!error) {
          resolve({ code: 0, stdout });
          return;
        }
        const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (error as NodeJS.ErrnoException & { code: number }).code
          : -1;
        if (code < 0) {
          reject(new ProjectRuntimeUninstallPreflightError('READ_ONLY_COMMAND_FAILED'));
          return;
        }
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
      });
    });
  },
};

function residualCommand(query: typeof RESIDUAL_QUERIES[number]): readonly string[] {
  if (query.kind === 'container') {
    return ['container', 'ls', '--all', '--filter', `label=${query.selector}`, '--format', '{{.ID}}\t{{.Names}}'];
  }
  if (query.kind === 'volume') {
    return ['volume', 'ls', '--filter', `label=${query.selector}`, '--format', '{{.Name}}'];
  }
  return ['network', 'ls', '--filter', `label=${query.selector}`, '--format', '{{.ID}}\t{{.Name}}'];
}

function identifierFromDockerLine(line: string): string {
  const columns = line.split('\t');
  return boundedIdentifier(columns[columns.length - 1]);
}

function reservedNameCommand(query: ReservedProjectDockerNameQuery): readonly string[] {
  if (query.kind === 'container') {
    return ['container', 'ls', '--all', '--format', '{{.ID}}\t{{.Names}}'];
  }
  if (query.kind === 'volume') {
    return ['volume', 'ls', '--format', '{{.Name}}'];
  }
  return ['network', 'ls', '--format', '{{.ID}}\t{{.Name}}'];
}

function recordResidual(
  discovered: Map<string, ProjectRuntimeResidual>,
  kind: ProjectRuntimeResidualKind,
  identifier: string,
): void {
  const key = `${kind}\u0000${identifier}`;
  discovered.set(key, Object.freeze({ kind, identifier }));
  if (discovered.size > PROJECT_RUNTIME_UNINSTALL_LIMITS.residualResources) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_RESIDUAL_LIMIT_EXCEEDED');
  }
}

export async function scanKnownProjectRuntimeResiduals(
  runner: ProjectRuntimeUninstallReadOnlyCommandRunner = defaultCommandRunner,
): Promise<readonly ProjectRuntimeResidual[]> {
  const discovered = new Map<string, ProjectRuntimeResidual>();
  for (const query of RESIDUAL_QUERIES) {
    const result = await runner.run(DOCKER_BIN, residualCommand(query), COMMAND_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new ProjectRuntimeUninstallPreflightError('DOCKER_RESIDUAL_SCAN_FAILED');
    }
    for (const line of result.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const identifier = identifierFromDockerLine(line);
      recordResidual(discovered, query.kind, identifier);
    }
  }
  for (const query of RESERVED_PROJECT_DOCKER_NAME_QUERIES) {
    const result = await runner.run(DOCKER_BIN, reservedNameCommand(query), COMMAND_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new ProjectRuntimeUninstallPreflightError('DOCKER_RESIDUAL_SCAN_FAILED');
    }
    for (const line of result.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
      const identifier = identifierFromDockerLine(line);
      if (query.patterns.some((pattern) => pattern.test(identifier))) {
        recordResidual(discovered, query.kind, identifier);
      }
    }
  }
  return Object.freeze([...discovered.values()].sort((left, right) => (
    `${left.kind}:${left.identifier}`.localeCompare(`${right.kind}:${right.identifier}`)
  )));
}

interface ManagedFirewallChainPlan {
  name: string;
  parentRules: readonly string[];
}

interface ManagedFirewallCleanupPlan {
  snapshot: string;
  projectChains: readonly ManagedFirewallChainPlan[];
  hostRules: readonly string[];
  masterDeclared: boolean;
  hostDeclared: boolean;
  masterParentRules: readonly string[];
  hostParentRules: readonly string[];
}

const FIREWALL_STATEMENT_LIMIT = 4096;
const P4E_MASTER_CHAIN = 'P4E-MASTER-V1';
const P4E_HOST_CHAIN = 'P4E-HOST-V1';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeFirewallLine(value: string): string {
  return value.trim()
    .replace(/--comment "([^"]*)"/g, '--comment $1')
    .replace(/ -j REJECT --reject-with (?:icmp6?-port-unreachable|icmp-port-unreachable)$/, ' -j REJECT');
}

function firewallLines(payload: string): string[] {
  const lines = payload.split(/\r?\n/).map(normalizeFirewallLine).filter(Boolean);
  if (lines.length > FIREWALL_STATEMENT_LIMIT) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_STATEMENT_LIMIT_EXCEEDED');
  }
  return lines;
}

function managedFirewallComment(line: string): string | null {
  const matches = [...line.matchAll(/(?:^| )--comment ([^ ]+)(?= |$)/g)];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

function commentMatchesChain(comment: string, chain: string): boolean {
  const p4e = comment.match(/^p4e-v1:[a-f0-9]{64}:([a-f0-9]{64})$/);
  if (p4e && /^P4E-[A-F0-9]{23}$/.test(chain)) {
    return chain === `P4E-${p4e[1].slice(0, 23).toUpperCase()}`;
  }
  const a0p = comment.match(/^a0p-v3:[a-f0-9]{64}:([a-f0-9]{64})$/);
  return Boolean(a0p && /^A0P-[A-F0-9]{24}$/.test(chain)
    && chain === `A0P-${a0p![1].slice(0, 24).toUpperCase()}`);
}

function validP4eChainRules(lines: readonly string[], chain: string, comment: string): boolean {
  const escapedChain = escapeRegExp(chain);
  const escapedComment = escapeRegExp(comment);
  const cidr = '[0-9A-Fa-f:.]+/[0-9]{1,3}';
  const deny = new RegExp(`^-A ${escapedChain} -d ${cidr} -m comment --comment ${escapedComment} -j REJECT$`);
  const ipv4Return = new RegExp(`^-A ${escapedChain} -p tcp -m multiport --dports 80,443 -m comment --comment ${escapedComment} -j RETURN$`);
  const ipv6Return = new RegExp(`^-A ${escapedChain} -d 2000::/3 -p tcp -m multiport --dports 80,443 -m comment --comment ${escapedComment} -j RETURN$`);
  const finalReject = new RegExp(`^-A ${escapedChain} -m comment --comment ${escapedComment} -j REJECT$`);
  return lines.length >= 2
    && lines.every((line) => deny.test(line) || ipv4Return.test(line) || ipv6Return.test(line) || finalReject.test(line))
    && lines.filter((line) => ipv4Return.test(line) || ipv6Return.test(line)).length === 1
    && finalReject.test(lines[lines.length - 1]);
}

function validA0pChainRules(lines: readonly string[], chain: string, comment: string): boolean {
  const escapedChain = escapeRegExp(chain);
  const escapedComment = escapeRegExp(comment);
  const established = new RegExp(`^-A ${escapedChain} -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment ${escapedComment} -j ACCEPT$`);
  const destination = new RegExp(`^-A ${escapedChain} -d [0-9.]+/32 -p tcp -m tcp --dport [0-9]{1,5} -m comment --comment ${escapedComment} -j ACCEPT$`);
  const reject = new RegExp(`^-A ${escapedChain} -m comment --comment ${escapedComment} -j REJECT$`);
  return lines.length === 4
    && established.test(lines[0])
    && destination.test(lines[1])
    && destination.test(lines[2])
    && reject.test(lines[3]);
}

function referenceLines(lines: readonly string[], chain: string): string[] {
  const target = new RegExp(` (?:-j|-g) ${escapeRegExp(chain)}(?: |$)`);
  return lines.filter((line) => !line.startsWith(`-A ${chain} `) && target.test(line));
}

function parseManagedFirewallCleanupPlan(payload: string): ManagedFirewallCleanupPlan {
  const lines = firewallLines(payload);
  const declarations = new Set(lines
    .map((line) => line.match(/^-N ([A-Za-z0-9_.:-]+)$/)?.[1] || null)
    .filter((value): value is string => Boolean(value)));
  const projectChains = [...declarations]
    .filter((name) => /^P4E-[A-F0-9]{23}$/.test(name) || /^A0P-[A-F0-9]{24}$/.test(name))
    .sort();
  const consumed = new Set<string>();
  const plans: ManagedFirewallChainPlan[] = [];

  for (const chain of projectChains) {
    const localRules = lines.filter((line) => line.startsWith(`-A ${chain} `));
    const comments = new Set(localRules.map(managedFirewallComment).filter((value): value is string => Boolean(value)));
    if (localRules.length === 0 || comments.size !== 1) {
      throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_AMBIGUOUS_CHAIN');
    }
    const comment = [...comments][0];
    if (!localRules.every((line) => managedFirewallComment(line) === comment)
      || !commentMatchesChain(comment, chain)
      || (chain.startsWith('P4E-')
        ? !validP4eChainRules(localRules, chain, comment)
        : !validA0pChainRules(localRules, chain, comment))) {
      throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_AMBIGUOUS_CHAIN');
    }
    const parents = referenceLines(lines, chain);
    const escapedChain = escapeRegExp(chain);
    const escapedComment = escapeRegExp(comment);
    const cidr = '[0-9A-Fa-f:.]+/[0-9]{1,3}';
    const parentPattern = chain.startsWith('P4E-')
      ? new RegExp(`^-A ${P4E_MASTER_CHAIN} -s ${cidr} -m comment --comment ${escapedComment} -j ${escapedChain}$`)
      : new RegExp(`^-A (?:INPUT|DOCKER-USER) -s ${cidr} -m comment --comment ${escapedComment} -j ${escapedChain}$`);
    if (!parents.every((line) => parentPattern.test(line))) {
      throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_AMBIGUOUS_CHAIN');
    }
    localRules.forEach((line) => consumed.add(line));
    parents.forEach((line) => consumed.add(line));
    consumed.add(`-N ${chain}`);
    plans.push(Object.freeze({ name: chain, parentRules: Object.freeze([...parents]) }));
  }

  const hostRules = lines.filter((line) => line.startsWith(`-A ${P4E_HOST_CHAIN} `));
  const hostPattern = new RegExp(
    `^-A ${P4E_HOST_CHAIN} -s [0-9A-Fa-f:.]+/[0-9]{1,3} -m comment --comment p4e-v1:[a-f0-9]{64}:[a-f0-9]{64} -j REJECT$`,
  );
  if (!hostRules.every((line) => hostPattern.test(line))) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_AMBIGUOUS_CHAIN');
  }
  hostRules.forEach((line) => consumed.add(line));

  const masterLocalRules = lines.filter((line) => line.startsWith(`-A ${P4E_MASTER_CHAIN} `));
  const recognizedMasterRules = new Set(plans
    .filter((plan) => plan.name.startsWith('P4E-'))
    .flatMap((plan) => plan.parentRules));
  if (masterLocalRules.some((line) => !recognizedMasterRules.has(line))) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_AMBIGUOUS_CHAIN');
  }

  const masterDeclared = declarations.has(P4E_MASTER_CHAIN);
  const hostDeclared = declarations.has(P4E_HOST_CHAIN);
  const masterParentRules = referenceLines(lines, P4E_MASTER_CHAIN);
  const hostParentRules = referenceLines(lines, P4E_HOST_CHAIN);
  if (masterParentRules.some((line) => line !== `-A DOCKER-USER -j ${P4E_MASTER_CHAIN}`)
    || hostParentRules.some((line) => line !== `-A INPUT -j ${P4E_HOST_CHAIN}`)
    || (!masterDeclared && (masterLocalRules.length > 0 || masterParentRules.length > 0))
    || (!hostDeclared && (hostRules.length > 0 || hostParentRules.length > 0))) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_AMBIGUOUS_CHAIN');
  }
  masterParentRules.forEach((line) => consumed.add(line));
  hostParentRules.forEach((line) => consumed.add(line));
  if (masterDeclared) consumed.add(`-N ${P4E_MASTER_CHAIN}`);
  if (hostDeclared) consumed.add(`-N ${P4E_HOST_CHAIN}`);

  for (const line of lines) {
    const portalShapedDeclaration = /^-N (?:P4E-|A0P-)/.test(line);
    const portalComment = / --comment (?:p4e-v1|a0p-v3):/.test(line);
    const portalTarget = / (?:-j|-g) (?:P4E-|A0P-)/.test(line);
    if ((portalShapedDeclaration || portalComment || portalTarget) && !consumed.has(line)) {
      throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_AMBIGUOUS_CHAIN');
    }
  }

  return Object.freeze({
    snapshot: lines.join('\n'),
    projectChains: Object.freeze(plans),
    hostRules: Object.freeze([...hostRules]),
    masterDeclared,
    hostDeclared,
    masterParentRules: Object.freeze([...masterParentRules]),
    hostParentRules: Object.freeze([...hostParentRules]),
  });
}

async function requireFirewallCommand(
  runner: ProjectRuntimeUninstallReadOnlyCommandRunner,
  file: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run(file, args, COMMAND_TIMEOUT_MS);
  if (result.code !== 0) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_COMMAND_FAILED');
  }
  return result.stdout;
}

function deleteRuleArgs(line: string): readonly string[] {
  const tokens = line.split(/\s+/);
  if (tokens[0] !== '-A' || tokens.length < 4) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_AMBIGUOUS_CHAIN');
  }
  return ['-w', '-D', tokens[1], ...tokens.slice(2)];
}

async function cleanupManagedFirewallFamily(
  file: string,
  runner: ProjectRuntimeUninstallReadOnlyCommandRunner,
): Promise<number> {
  const initial = parseManagedFirewallCleanupPlan(
    await requireFirewallCommand(runner, file, ['-w', '-S']),
  );
  const managedCount = initial.projectChains.length + initial.hostRules.length
    + Number(initial.masterDeclared) + Number(initial.hostDeclared);
  if (managedCount === 0) return 0;

  const second = parseManagedFirewallCleanupPlan(
    await requireFirewallCommand(runner, file, ['-w', '-S']),
  );
  if (second.snapshot !== initial.snapshot) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_CLEANUP_RACE');
  }
  for (const chain of second.projectChains) {
    for (const parentRule of chain.parentRules) {
      await requireFirewallCommand(runner, file, deleteRuleArgs(parentRule));
    }
  }
  for (const hostRule of second.hostRules) {
    await requireFirewallCommand(runner, file, deleteRuleArgs(hostRule));
  }
  for (const chain of second.projectChains) {
    await requireFirewallCommand(runner, file, ['-w', '-F', chain.name]);
    await requireFirewallCommand(runner, file, ['-w', '-X', chain.name]);
  }

  const shared = parseManagedFirewallCleanupPlan(
    await requireFirewallCommand(runner, file, ['-w', '-S']),
  );
  if (shared.projectChains.length > 0 || shared.hostRules.length > 0) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_CLEANUP_INCOMPLETE');
  }
  if (shared.masterDeclared) {
    for (const rule of shared.masterParentRules) {
      await requireFirewallCommand(runner, file, deleteRuleArgs(rule));
    }
    await requireFirewallCommand(runner, file, ['-w', '-F', P4E_MASTER_CHAIN]);
    await requireFirewallCommand(runner, file, ['-w', '-X', P4E_MASTER_CHAIN]);
  }
  if (shared.hostDeclared) {
    for (const rule of shared.hostParentRules) {
      await requireFirewallCommand(runner, file, deleteRuleArgs(rule));
    }
    await requireFirewallCommand(runner, file, ['-w', '-F', P4E_HOST_CHAIN]);
    await requireFirewallCommand(runner, file, ['-w', '-X', P4E_HOST_CHAIN]);
  }

  const finalPlan = parseManagedFirewallCleanupPlan(
    await requireFirewallCommand(runner, file, ['-w', '-S']),
  );
  if (finalPlan.projectChains.length > 0 || finalPlan.hostRules.length > 0
    || finalPlan.masterDeclared || finalPlan.hostDeclared
    || finalPlan.masterParentRules.length > 0 || finalPlan.hostParentRules.length > 0) {
    throw new ProjectRuntimeUninstallPreflightError('PROJECT_FIREWALL_CLEANUP_INCOMPLETE');
  }
  return managedCount;
}

export async function cleanupKnownProjectFirewallResiduals(
  runner: ProjectRuntimeUninstallReadOnlyCommandRunner = defaultCommandRunner,
): Promise<number> {
  let removed = 0;
  removed += await cleanupManagedFirewallFamily(IPTABLES_BIN, runner);
  removed += await cleanupManagedFirewallFamily(IP6TABLES_BIN, runner);
  return removed;
}

/**
 * Remove managed Docker resources that the per-project cleanup cannot reach.
 *
 * Per-project cleanup iterates **database project identities**, but the
 * residual scan searches by **Docker label**. Any managed resource whose
 * owning project row is gone is therefore detected by the scan and removed by
 * nothing, which raises PROJECT_RUNTIME_RESIDUALS and makes clean-slate
 * uninstall permanently impossible -- there is no --force and no escape hatch,
 * and `docker system prune --volumes` does not help because these are *named*
 * volumes.
 *
 * Scoped to exactly the label selectors the scanner uses, so it can only ever
 * touch Portal-managed resources. Anything unlabelled is left alone.
 */
export async function cleanupOrphanedProjectRuntimeResiduals(
  runner: ProjectRuntimeUninstallReadOnlyCommandRunner = defaultCommandRunner,
): Promise<number> {
  let removed = 0;
  for (const query of RESIDUAL_QUERIES) {
    const listed = await runner.run(DOCKER_BIN, residualCommand(query), COMMAND_TIMEOUT_MS);
    if (listed.code !== 0) {
      throw new ProjectRuntimeUninstallPreflightError('DOCKER_RESIDUAL_SCAN_FAILED');
    }
    const identifiers = listed.stdout
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((line) => identifierFromDockerLine(line))
      .filter((identifier) => identifier.length > 0);

    for (const identifier of [...new Set(identifiers)]) {
      const args = query.kind === 'container'
        ? ['rm', '--force', '--volumes', identifier]
        : (query.kind === 'volume'
          ? ['volume', 'rm', '--force', identifier]
          : ['network', 'rm', identifier]);
      const result = await runner.run(DOCKER_BIN, args, COMMAND_TIMEOUT_MS);
      // A resource that vanished between listing and removal is fine; the
      // final scan is the authority on whether anything actually remains.
      if (result.code === 0) removed += 1;
    }
  }
  return removed;
}

export async function assertPortalServiceStopped(
  runner: ProjectRuntimeUninstallReadOnlyCommandRunner = defaultCommandRunner,
): Promise<void> {
  const result = await runner.run(
    SYSTEMCTL_BIN,
    ['is-active', '--quiet', PORTAL_SERVICE],
    COMMAND_TIMEOUT_MS,
  );
  if (result.code === 0) {
    throw new ProjectRuntimeUninstallPreflightError('PORTAL_SERVICE_ACTIVE');
  }
  if (result.code !== 3) {
    throw new ProjectRuntimeUninstallPreflightError('PORTAL_SERVICE_STATE_UNKNOWN');
  }
}

function validateEnvironmentValues(values: Readonly<Record<string, string>>): void {
  const required = [
    'DATABASE_URL',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'PROJECT_EGRESS_TOKEN_SECRET',
  ];
  if (values.NODE_ENV !== 'production' || required.some((key) => !String(values[key] || '').trim())) {
    throw new ProjectRuntimeUninstallPreflightError('DEPLOYED_ENV_INCOMPLETE');
  }
}

export function loadProtectedEnvironmentFile(envFile: string): void {
  if (!path.isAbsolute(envFile)) {
    throw new ProjectRuntimeUninstallPreflightError('DEPLOYED_ENV_PATH_UNSAFE');
  }
  const resolved = path.resolve(envFile);
  let descriptor = -1;
  try {
    const lstat = fs.lstatSync(resolved);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      throw new ProjectRuntimeUninstallPreflightError('DEPLOYED_ENV_UNSAFE');
    }
    if (fs.realpathSync.native(resolved) !== resolved) {
      throw new ProjectRuntimeUninstallPreflightError('DEPLOYED_ENV_UNSAFE');
    }
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0
      || stat.size <= 0 || stat.size > MAX_ENV_BYTES) {
      throw new ProjectRuntimeUninstallPreflightError('DEPLOYED_ENV_UNSAFE');
    }
    const contents = fs.readFileSync(descriptor, { encoding: 'utf8' });
    const parsed = dotenv.parse(contents);
    validateEnvironmentValues(parsed);
    for (const [key, value] of Object.entries(parsed)) process.env[key] = value;
  } catch (error) {
    if (error instanceof ProjectRuntimeUninstallPreflightError) throw error;
    throw new ProjectRuntimeUninstallPreflightError('DEPLOYED_ENV_UNAVAILABLE');
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

async function loadDefaultDependencies(): Promise<ProjectRuntimeUninstallPreflightDependencies> {
  const [
    databaseModule,
    cleanupModule,
    cleanupAdaptersModule,
    egressCleanupModule,
    workloadModule,
    lifecycleModule,
  ] = await Promise.all([
    import('../config/database'),
    import('../services/projectRuntimeCleanup'),
    import('../services/projectRuntimeCleanupAdapters'),
    import('../services/projectEgressCleanupAdapter'),
    import('../services/projectWorkloadRuntime'),
    import('../services/project-lifecycle.service'),
  ]);
  const prisma = databaseModule.prisma;
  const adapters = cleanupAdaptersModule.createDefaultProjectRuntimeCleanupAdapters();
  const egressAdapter = egressCleanupModule.createProjectEgressCleanupAdapter();

  return {
    async listProjectIdentities(limit) {
      return prisma.projectIdentity.findMany({
        orderBy: { id: 'asc' },
        take: limit,
      });
    },
    async listProjectApps(identity, limit) {
      return prisma.app.findMany({
        where: {
          userId: identity.workspaceOwnerId,
          name: identity.projectName,
          deployType: 'fullstack',
        },
        select: { id: true, userId: true },
        orderBy: { id: 'asc' },
        take: limit,
      });
    },
    async stopProjectApp(identity, app) {
      await lifecycleModule.stopProjectAppContainer({
        actorId: app.userId,
        projectId: identity.id,
        workloadId: app.id,
      });
    },
    removeProjectWorkloads(projectIdentityId) {
      return workloadModule.removePortalProjectWorkloadsForProject(projectIdentityId);
    },
    cleanupProjectRuntime(identity) {
      return cleanupModule.cleanupProjectRuntime({
        authenticatedActorId: identity.workspaceOwnerId,
        workspaceOwnerId: identity.workspaceOwnerId,
        projectIdentity: identity,
      }, { adapters, egressAdapter });
    },
    cleanupKnownFirewallResiduals() {
      return cleanupKnownProjectFirewallResiduals();
    },
    cleanupOrphanedResiduals() {
      return cleanupOrphanedProjectRuntimeResiduals();
    },
    scanKnownResiduals() {
      return scanKnownProjectRuntimeResiduals();
    },
    disconnect() {
      return prisma.$disconnect();
    },
  };
}

interface ParsedArguments {
  envFile: string;
  maxRuntimeSeconds: number;
}

export function parseProjectRuntimeUninstallArguments(args: readonly string[]): ParsedArguments {
  let envFile = path.resolve(__dirname, '..', '..', '.env.production');
  let maxRuntimeSeconds = DEFAULT_MAX_RUNTIME_SECONDS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--env-file') {
      const value = args[index + 1];
      if (!value || !path.isAbsolute(value)) {
        throw new ProjectRuntimeUninstallPreflightError('INVALID_ARGUMENTS');
      }
      envFile = value;
      index += 1;
      continue;
    }
    if (argument === '--max-runtime-seconds') {
      const value = Number.parseInt(args[index + 1] || '', 10);
      if (!Number.isSafeInteger(value)
        || value < MIN_MAX_RUNTIME_SECONDS
        || value > MAX_MAX_RUNTIME_SECONDS) {
        throw new ProjectRuntimeUninstallPreflightError('INVALID_ARGUMENTS');
      }
      maxRuntimeSeconds = value;
      index += 1;
      continue;
    }
    throw new ProjectRuntimeUninstallPreflightError('INVALID_ARGUMENTS');
  }
  return { envFile, maxRuntimeSeconds };
}

interface PreflightIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export async function projectRuntimeUninstallPreflightMain(
  args: readonly string[] = process.argv.slice(2),
  io: PreflightIo = { stdout: process.stdout, stderr: process.stderr },
  hooks: {
    getUid?: () => number;
    loadDependencies?: () => Promise<ProjectRuntimeUninstallPreflightDependencies>;
    assertServiceStopped?: () => Promise<void>;
    loadEnvironment?: (envFile: string) => void;
    now?: () => number;
  } = {},
): Promise<number> {
  let dependencies: ProjectRuntimeUninstallPreflightDependencies | null = null;
  let failure: ProjectRuntimeUninstallPreflightError | null = null;
  let result: ProjectRuntimeUninstallPreflightResult | null = null;
  try {
    const getUid = hooks.getUid || (() => process.getuid?.() ?? -1);
    if (getUid() !== 0) throw new ProjectRuntimeUninstallPreflightError('ROOT_REQUIRED');
    const parsed = parseProjectRuntimeUninstallArguments(args);
    (hooks.loadEnvironment || loadProtectedEnvironmentFile)(parsed.envFile);
    await (hooks.assertServiceStopped || (() => assertPortalServiceStopped()))();
    dependencies = await (hooks.loadDependencies || loadDefaultDependencies)();
    const now = hooks.now || Date.now;
    result = await runProjectRuntimeUninstallPreflight(dependencies, {
      deadlineMs: now() + parsed.maxRuntimeSeconds * 1000,
    });
  } catch (error) {
    failure = error instanceof ProjectRuntimeUninstallPreflightError
      ? error
      : new ProjectRuntimeUninstallPreflightError('PREFLIGHT_FAILED');
  } finally {
    if (dependencies) {
      try {
        await dependencies.disconnect();
      } catch {
        failure ||= new ProjectRuntimeUninstallPreflightError('DATABASE_DISCONNECT_FAILED');
      }
    }
  }

  if (failure || !result) {
    const safe = (failure?.safeIdentifiers || [])
      .slice(0, PROJECT_RUNTIME_UNINSTALL_LIMITS.reportedResiduals)
      .map(boundedIdentifier);
    const suffix = safe.length > 0 ? ` [${safe.join(',')}]` : '';
    const detail = failure?.detail ? `: ${failure.detail}` : '';
    io.stderr.write(`Portal project-runtime uninstall preflight failed: ${failure?.code || 'PREFLIGHT_FAILED'}${suffix}${detail}\n`);
    return 1;
  }
  io.stdout.write(
    `Portal project-runtime uninstall preflight complete: projects=${result.projectCount}`
      + ` apps=${result.appCount} workloads=${result.workloadCount}`
      + ` resources=${result.providerResourceCount}\n`,
  );
  return 0;
}

if (require.main === module) {
  void projectRuntimeUninstallPreflightMain().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write('Portal project-runtime uninstall preflight failed: PREFLIGHT_FAILED\n');
    process.exitCode = 1;
  });
}
