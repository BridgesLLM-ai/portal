import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec as cpExec } from 'child_process';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { prisma } from '../config/database';
import { startAgentJob } from '../services/agentJobs';
import { isOwnerRole } from '../utils/authz';
import { isTypedConfirmationMatch } from '../utils/privilegedConfirmation';
import { getConfiguredBackupRoot, listBackupFiles } from '../services/backup.service';
import {
  getOpenClawSetupReadiness,
  type OpenClawSetupReadiness,
} from '../services/openclawSetupReadiness';

type MaintenanceSeverity = 'healthy' | 'info' | 'warning' | 'critical';
type MaintenanceActionRisk = 'safe' | 'scheduled' | 'manual';

type MaintenanceAction = {
  id: string;
  label: string;
  description: string;
  risk: MaintenanceActionRisk;
  downtimeExpected: boolean;
  requiresOwner: boolean;
  changesSystem: boolean;
  destructive: boolean;
  requiresBackup: boolean;
  requiresMaintenanceWindow: boolean;
  automationLevel: 'read-only' | 'safe' | 'guarded' | 'manual';
  impact: string;
  recovery: string;
  confirmationPhrase: string | null;
};

type MaintenanceCompatibilityComponent = {
  id: string;
  label: string;
  installedVersion: string | null;
  supportedVersion: string;
  policy: 'self-update-only' | 'known-compatible' | 'manual-review' | 'blocked-until-confirmed';
  status: 'ok' | 'review' | 'blocked' | 'unknown';
  note: string;
};

type MaintenanceCompatibility = {
  policy: 'guarded';
  summary: string;
  components: MaintenanceCompatibilityComponent[];
};

type MaintenanceIssue = {
  id: string;
  title: string;
  detail: string;
  severity: Exclude<MaintenanceSeverity, 'healthy'>;
  category: 'security' | 'updates' | 'services' | 'disk' | 'backups' | 'system';
  recommendation: string;
  actionId?: string;
  downtimeExpected?: boolean;
  automationSafe: boolean;
};

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

type ServiceState = {
  name: string;
  label: string;
  required: boolean;
  exists: boolean;
  active: string;
  healthy: boolean;
};

type CheckedService = {
  name: string;
  label: string;
  required: boolean;
  installedProbe?: string;
};

type PortalDeployStamp = {
  kind: 'portal' | 'candidate';
  schema: string | null;
  releaseVersion: string | null;
  sourceVersion: string | null;
  artifactSha256: string | null;
  manifestSha256: string | null;
  manifestSchema: string | null;
  installedAt: string | null;
  sourceHead: string | null;
  sourceDirty: string | null;
  deployedAt: string | null;
};

type PortalCompatibilitySnapshot = {
  packageVersion: string | null;
  sourceVersion: string | null;
  compiledVersion: string | null;
  installerVersion: string | null;
  deployStamp: PortalDeployStamp | null;
};

type ActiveMaintenanceJob = {
  id: string;
  title: string | null;
  startedAt: Date | null;
};

type MaintenanceAdmissionOptions = {
  lockPath?: string;
  nowMs?: () => number;
  activeJobLookup?: () => Promise<ActiveMaintenanceJob | null>;
  processAlive?: (pid: number) => boolean;
  staleMs?: number;
};

type MaintenanceBackupCandidate = {
  filename: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
};

type VerifiedMaintenanceBackup = {
  path: string;
  filename: string;
  createdAt: string;
  ageHours: number;
  size: number;
};

const router = Router();
router.use(authenticateToken, requireAdmin);

const APT_LOCKS = [
  '/var/lib/dpkg/lock-frontend',
  '/var/lib/dpkg/lock',
  '/var/cache/apt/archives/lock',
  '/var/lib/apt/lists/lock',
];

const CHECKED_SERVICES: CheckedService[] = [
  { name: 'bridgesllm-product.service', label: 'Portal backend', required: true },
  { name: 'caddy.service', label: 'Caddy reverse proxy', required: true },
  { name: 'openclaw-gateway.service', label: 'OpenClaw gateway', required: false, installedProbe: 'command -v openclaw >/dev/null 2>&1' },
  { name: 'postgresql.service', label: 'PostgreSQL', required: false, installedProbe: 'test -d /etc/postgresql' },
  { name: 'stalwart-mail.service', label: 'Stalwart mail server', required: false, installedProbe: 'command -v stalwart-mail >/dev/null 2>&1 || command -v stalwart >/dev/null 2>&1' },
  { name: 'clamav-daemon.service', label: 'ClamAV scanner', required: true },
  { name: 'clamav-freshclam.service', label: 'ClamAV signature updater', required: true },
  { name: 'monarx-agent.service', label: 'Monarx malware agent', required: false, installedProbe: 'command -v monarx-agent >/dev/null 2>&1 || test -d /opt/monarx' },
  { name: 'bridgesllm-backup-daily.timer', label: 'Daily backup timer', required: true },
  { name: 'bridgesllm-backup-comprehensive.timer', label: 'Comprehensive backup timer', required: true },
  { name: 'bridgesllm-backup-monthly.timer', label: 'Monthly backup timer', required: true },
  { name: 'docker.service', label: 'Docker engine', required: false, installedProbe: 'command -v docker >/dev/null 2>&1' },
  { name: 'bridges-rd-xtigervnc.service', label: 'Remote Desktop VNC', required: false },
  { name: 'bridges-rd-websockify.service', label: 'Remote Desktop WebSocket bridge', required: false },
];

export const MAINTENANCE_BACKUP_MAX_AGE_HOURS = 24;
const MAINTENANCE_BACKUP_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAINTENANCE_ADMISSION_STALE_MS = 10 * 60 * 1000;
const MAINTENANCE_TOOL_ID = 'system-maintenance';

const PROTECTED_PACKAGE_REGEX = /^(?:bridgesllm(?:-.+)?|openclaw(?:-.+)?|stalwart(?:-.+)?|stalwart-mail|caddy)$/i;

const MAINTENANCE_PLAN_COMMAND = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
portal_root="\${PORTAL_ROOT:-/opt/bridgesllm/portal}"

section() {
  printf '\\n== %s ==\\n' "$1"
}

show_version() {
  label="$1"
  shift
  printf '%s: ' "$label"
  ("$@" 2>/dev/null || true) | head -n 1
}

section "BridgesLLM maintenance plan"
date -Is
hostnamectl 2>/dev/null || true
printf 'Kernel: '
uname -r

section "Compatibility policy"
cat <<'EOF'
Portal maintenance is guarded:
- Security patches may be applied through the security-only path.
- Kernel/reboot work must be scheduled.
- Broad package upgrades require review.
- Portal-managed components must stay on versions the Portal has been confirmed to support.
- Mail server upgrades are blocked unless the Portal compatibility manifest confirms support.
EOF

section "Portal"
if [ -f "$portal_root/backend/package.json" ]; then
  node -e "const p=require(process.argv[1]); console.log('Portal backend version:', p.version || 'unknown')" "$portal_root/backend/package.json"
fi
if [ -f "$portal_root/installer/install.sh" ]; then
  grep -E 'readonly VERSION=' "$portal_root/installer/install.sh" || true
fi

section "Managed components"
show_version "OpenClaw" openclaw --version
show_version "Caddy" caddy version
show_version "Stalwart" stalwart-mail --version
show_version "Stalwart alternate binary" stalwart --version
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'Container: {{.Names}} {{.Image}} {{.Status}}' 2>/dev/null | grep -Ei 'stalwart|mail|caddy|portal|openclaw' || true
fi

section "Package drift"
if command -v apt-get >/dev/null 2>&1; then
  if [ -x /usr/lib/update-notifier/apt-check ]; then
    /usr/lib/update-notifier/apt-check 2>/dev/null | awk -F';' '{print "Upgradable packages: "$1; print "Security updates: "$2}'
  fi
  apt list --upgradable 2>/dev/null | tail -n +2 | sed '/^$/d' | head -n 120 || true
else
  echo "apt-get is not available on this host."
fi

section "Held or pinned packages"
apt-mark showhold 2>/dev/null || true
find /etc/apt/preferences /etc/apt/preferences.d -maxdepth 1 -type f -print -exec sed -n '1,120p' {} \\; 2>/dev/null || true

section "Reboot state"
if [ -f /var/run/reboot-required ]; then
  echo "Reboot required."
  cat /var/run/reboot-required.pkgs 2>/dev/null || true
else
  echo "No reboot-required flag present."
fi

section "Service state"
for service in \
  bridgesllm-product.service caddy.service openclaw-gateway.service postgresql.service \
  stalwart-mail.service clamav-daemon.service clamav-freshclam.service monarx-agent.service \
  bridgesllm-backup-daily.timer bridgesllm-backup-comprehensive.timer bridgesllm-backup-monthly.timer \
  docker.service bridges-rd-xtigervnc.service bridges-rd-websockify.service; do
  printf '%s: ' "$service"
  systemctl is-active "$service" 2>/dev/null || true
done

section "Recommended next step"
cat <<'EOF'
Review this plan before applying broad updates. If only security updates are pending, use the security-only maintenance action. If kernel packages require a reboot, schedule downtime and confirm the Portal is backed up first.
EOF`;

const REBOOT_CHECKLIST_COMMAND = `set -euo pipefail
portal_root="\${PORTAL_ROOT:-/opt/bridgesllm/portal}"

section() {
  printf '\\n== %s ==\\n' "$1"
}

section "Reboot maintenance checklist"
date -Is
printf 'Host: '
hostname
printf 'Current kernel: '
uname -r
printf 'Uptime: '
uptime -p || true

section "Why reboot is requested"
if [ -f /var/run/reboot-required ]; then
  echo "The OS reports that a reboot is required."
  cat /var/run/reboot-required.pkgs 2>/dev/null || true
else
  echo "No reboot-required flag is currently present."
fi

section "Latest backups"
backup_base="/root/backups"
backup_config="\${portal_root}/backend/.data/backups/backup-base-path"
if [ -r "\${backup_config}" ]; then
  IFS= read -r configured_backup_base < "\${backup_config}" || true
  case "\${configured_backup_base:-}" in
    /*) backup_base="\${configured_backup_base}" ;;
  esac
fi
find "\${backup_base}/daily" "\${backup_base}/weekly" "\${backup_base}/monthly" "\${backup_base}/comprehensive" \\
  -maxdepth 1 -type f \\( -name '*.tgz' -o -name '*.tar.gz' \\) -printf '%T@ %TY-%Tm-%Td %TH:%TM %p\\n' 2>/dev/null \\
  | sort -nr | head -n 10 || true

section "Services that should come back after reboot"
for service in \
  bridgesllm-product.service caddy.service openclaw-gateway.service postgresql.service \
  stalwart-mail.service clamav-daemon.service clamav-freshclam.service monarx-agent.service \
  bridgesllm-backup-daily.timer bridgesllm-backup-comprehensive.timer bridgesllm-backup-monthly.timer \
  docker.service bridges-rd-xtigervnc.service bridges-rd-websockify.service; do
  printf '%s: ' "$service"
  systemctl is-active "$service" 2>/dev/null || true
done

section "Recommended procedure"
cat <<'EOF'
1. Confirm a fresh Portal backup exists.
2. Tell active users there will be a short interruption.
3. Reboot from an approved maintenance window.
4. After reboot, confirm Portal health, Caddy, OpenClaw gateway, and Remote Desktop services.

This checklist does not reboot the server.
EOF`;

const SECURITY_UPDATE_COMMAND = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

protected="$(apt list --upgradable 2>/dev/null \\
  | tail -n +2 \\
  | awk -F/ '{print $1}' \\
  | grep -E '^(bridgesllm(-.+)?|openclaw(-.+)?|stalwart(-.+)?|stalwart-mail|caddy)$' \\
  | sort -u || true)"

if [ -n "$protected" ]; then
  cat <<EOF >&2
Security maintenance is blocked because protected Portal components have pending package updates:
$protected

Generate a maintenance plan first. These components need Portal compatibility review before package-manager upgrades are allowed.
EOF
  exit 42
fi

command -v unattended-upgrade >/dev/null
unattended-upgrade -v`;

function ageHoursSince(mtimeMs: number): number {
  return Math.round(((Date.now() - mtimeMs) / 3_600_000) * 10) / 10;
}

const ACTIONS: Record<string, MaintenanceAction & { command: string; title: string }> = {
  'generate-maintenance-plan': {
    id: 'generate-maintenance-plan',
    label: 'Generate Maintenance Plan',
    title: 'Generate maintenance plan',
    description: 'Creates a read-only compatibility and package drift report. No updates are applied.',
    risk: 'safe',
    downtimeExpected: false,
    requiresOwner: false,
    changesSystem: false,
    destructive: false,
    requiresBackup: false,
    requiresMaintenanceWindow: false,
    automationLevel: 'read-only',
    impact: 'Reads package, service, reboot, backup, and compatibility state. It does not modify the server.',
    recovery: 'No rollback needed; this action only writes a background-task transcript.',
    confirmationPhrase: null,
    command: MAINTENANCE_PLAN_COMMAND,
  },
  'prepare-reboot-checklist': {
    id: 'prepare-reboot-checklist',
    label: 'Prepare Reboot Checklist',
    title: 'Prepare reboot checklist',
    description: 'Creates a read-only reboot readiness checklist with backup, service, and package context. It does not reboot the server.',
    risk: 'scheduled',
    downtimeExpected: false,
    requiresOwner: false,
    changesSystem: false,
    destructive: false,
    requiresBackup: false,
    requiresMaintenanceWindow: false,
    automationLevel: 'read-only',
    impact: 'Reads reboot-required state and service health so an admin can schedule downtime deliberately.',
    recovery: 'No rollback needed; this action only writes a background-task transcript.',
    confirmationPhrase: null,
    command: REBOOT_CHECKLIST_COMMAND,
  },
  'refresh-package-cache': {
    id: 'refresh-package-cache',
    label: 'Refresh Package Cache',
    title: 'Refresh package cache',
    description: 'Runs apt-get update so security and package drift checks use current package metadata.',
    risk: 'safe',
    downtimeExpected: false,
    requiresOwner: true,
    changesSystem: true,
    destructive: false,
    requiresBackup: false,
    requiresMaintenanceWindow: false,
    automationLevel: 'safe',
    impact: 'Updates local apt metadata only. It does not install or remove packages.',
    recovery: 'Usually no rollback needed; rerun package checks if the cache refresh fails.',
    confirmationPhrase: 'REFRESH PACKAGE CACHE',
    command: 'set -euo pipefail\nexport DEBIAN_FRONTEND=noninteractive\napt-get update',
  },
  'apply-security-updates': {
    id: 'apply-security-updates',
    label: 'Apply Security Updates',
    title: 'Apply security updates',
    description: 'Runs unattended-upgrade for security updates only. Reboots are still reported separately and are not automatic.',
    risk: 'scheduled',
    downtimeExpected: false,
    requiresOwner: true,
    changesSystem: true,
    destructive: false,
    requiresBackup: true,
    requiresMaintenanceWindow: true,
    automationLevel: 'guarded',
    impact: 'Installs security updates through unattended-upgrade. It does not intentionally run broad upgrades or reboot automatically.',
    recovery: 'Use the latest Portal backup and package logs if a security update causes a regression; reboot still requires a separate scheduled action.',
    confirmationPhrase: 'APPLY SECURITY UPDATES',
    command: SECURITY_UPDATE_COMMAND,
  },
  'create-maintenance-backup': {
    id: 'create-maintenance-backup',
    label: 'Create Maintenance Backup',
    title: 'Create maintenance backup',
    description: 'Creates a daily Portal backup before maintenance work.',
    risk: 'safe',
    downtimeExpected: false,
    requiresOwner: true,
    changesSystem: true,
    destructive: false,
    requiresBackup: false,
    requiresMaintenanceWindow: false,
    automationLevel: 'safe',
    impact: 'Creates a Portal backup archive. It writes backup files but should not change running services.',
    recovery: 'Delete the failed or unwanted backup archive if storage cleanup is needed.',
    confirmationPhrase: 'CREATE MAINTENANCE BACKUP',
    command: 'set -euo pipefail\nsystemctl start bridgesllm-backup@daily.service',
  },
};

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runShell(command: string, timeoutMs = 8000): Promise<CommandResult> {
  return new Promise((resolve) => {
    cpExec(command, {
      env: process.env,
      timeout: timeoutMs,
      shell: '/bin/bash',
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function readOsRelease(): Record<string, string> {
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf8');
    return Object.fromEntries(content.split(/\r?\n/).map((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) return null;
      return [match[1], match[2].replace(/^"|"$/g, '')];
    }).filter(Boolean) as Array<[string, string]>);
  } catch {
    return {};
  }
}

function portalRoot(): string {
  const candidates = [
    process.env.PORTAL_ROOT,
    '/opt/bridgesllm/portal',
    path.resolve(process.cwd(), '..'),
    process.cwd(),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'backend/package.json'))) || candidates[0] || process.cwd();
}

function readJsonVersion(filePath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function readVersionLiteral(filePath: string, expression: RegExp): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.match(expression)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function emptyDeployStamp(kind: PortalDeployStamp['kind']): PortalDeployStamp {
  return {
    kind,
    schema: null,
    releaseVersion: null,
    sourceVersion: null,
    artifactSha256: null,
    manifestSha256: null,
    manifestSchema: null,
    installedAt: null,
    sourceHead: null,
    sourceDirty: null,
    deployedAt: null,
  };
}

function parseDeployStamp(raw: string, kind: PortalDeployStamp['kind']): PortalDeployStamp | null {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) return null;
    const key = line.slice(0, separator).trim();
    if (!key || values.has(key)) return null;
    values.set(key, line.slice(separator + 1).trim());
  }
  const expectedKeys = kind === 'portal'
    ? new Set(['schema', 'source_version', 'release_version', 'artifact_sha256', 'manifest_sha256', 'manifest_schema', 'installed_at'])
    : new Set(['artifact_sha256', 'source_head', 'source_dirty', 'deployed_at']);
  if (values.size !== expectedKeys.size || [...values.keys()].some((key) => !expectedKeys.has(key))) return null;
  return {
    ...emptyDeployStamp(kind),
    schema: values.get('schema') || null,
    releaseVersion: values.get('release_version') || null,
    sourceVersion: values.get('source_version') || null,
    artifactSha256: values.get('artifact_sha256') || null,
    manifestSha256: values.get('manifest_sha256') || null,
    manifestSchema: values.get('manifest_schema') || null,
    installedAt: values.get('installed_at') || null,
    sourceHead: values.get('source_head') || null,
    sourceDirty: values.get('source_dirty') || null,
    deployedAt: values.get('deployed_at') || null,
  };
}

function readPortalDeployStamp(root: string): PortalDeployStamp | null {
  const candidates = [
    { path: path.join(path.dirname(root), '.last-portal-deploy'), kind: 'portal' as const },
    { path: path.join(root, '.last-portal-deploy'), kind: 'portal' as const },
    { path: path.join(path.dirname(root), '.last-candidate-deploy'), kind: 'candidate' as const },
    { path: path.join(root, '.last-candidate-deploy'), kind: 'candidate' as const },
  ];
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
        return emptyDeployStamp(candidate.kind);
      }
      return parseDeployStamp(fs.readFileSync(candidate.path, 'utf8'), candidate.kind)
        || emptyDeployStamp(candidate.kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      return emptyDeployStamp(candidate.kind);
    }
  }
  return null;
}

export function portalCompatibilitySnapshot(root: string): PortalCompatibilitySnapshot {
  return {
    packageVersion: readJsonVersion(path.join(root, 'backend/package.json')),
    sourceVersion: readVersionLiteral(
      path.join(root, 'backend/src/version.ts'),
      /PORTAL_VERSION\s*=\s*['"]([^'"]+)['"]/,
    ),
    compiledVersion: readVersionLiteral(
      path.join(root, 'backend/dist/version.js'),
      /PORTAL_VERSION\s*=\s*['"]([^'"]+)['"]/,
    ),
    installerVersion: readVersionLiteral(
      path.join(root, 'installer/install.sh'),
      /readonly\s+VERSION\s*=\s*['"]([^'"]+)['"]/,
    ),
    deployStamp: readPortalDeployStamp(root),
  };
}

function validDeployStamp(stamp: PortalDeployStamp | null, expectedVersion: string | null): boolean {
  if (!stamp || !expectedVersion || !/^[a-f0-9]{64}$/i.test(stamp.artifactSha256 || '')) return false;
  if (stamp.kind === 'portal') {
    return Boolean(
      stamp.schema === '1'
      && (stamp.manifestSchema === '1' || stamp.manifestSchema === '2')
      && stamp.releaseVersion === expectedVersion
      && stamp.sourceVersion === expectedVersion
      && /^[a-f0-9]{64}$/i.test(stamp.manifestSha256 || '')
      && stamp.installedAt
      && Number.isFinite(Date.parse(stamp.installedAt)),
    );
  }
  // Candidate transport stamps predate the signed manifest identity and are
  // useful diagnostics, but they are not installer-owned release provenance.
  return false;
}

export function buildPortalMaintenanceComponent(
  snapshot: PortalCompatibilitySnapshot,
): MaintenanceCompatibilityComponent {
  const requiredVersions = [
    ['package', snapshot.packageVersion],
    ['compiled runtime', snapshot.compiledVersion],
    ['installer', snapshot.installerVersion],
  ] as const;
  const presentVersions = [
    ...requiredVersions,
    ...(snapshot.sourceVersion ? [['source', snapshot.sourceVersion] as const] : []),
  ];
  const missing = requiredVersions.filter(([, version]) => !version).map(([label]) => label);
  const distinctVersions = new Set(presentVersions.map(([, version]) => version).filter(Boolean));
  const versionMismatch = distinctVersions.size > 1;
  const expectedVersion = distinctVersions.size === 1 ? [...distinctVersions][0] || null : null;
  const stampValid = validDeployStamp(snapshot.deployStamp, expectedVersion);
  const stampVersionMismatch = snapshot.deployStamp?.kind === 'portal'
    && expectedVersion !== null
    && (snapshot.deployStamp.releaseVersion !== expectedVersion || snapshot.deployStamp.sourceVersion !== expectedVersion);
  const stampDescription = snapshot.deployStamp
    ? snapshot.deployStamp.kind === 'portal'
      ? `release ${snapshot.deployStamp.releaseVersion || 'unknown'} · artifact ${(snapshot.deployStamp.artifactSha256 || 'unknown').slice(0, 12)} · manifest ${(snapshot.deployStamp.manifestSha256 || 'unknown').slice(0, 12)}`
      : `candidate artifact ${(snapshot.deployStamp.artifactSha256 || 'unknown').slice(0, 12)} · source ${snapshot.deployStamp.sourceHead || 'unknown'}`
    : 'deployment stamp missing';

  let status: MaintenanceCompatibilityComponent['status'] = 'ok';
  let note = `Package, compiled runtime, installer${snapshot.sourceVersion ? ', and source' : ''} agree; ${stampDescription}.`;
  if (versionMismatch) {
    status = 'blocked';
    note = `Portal version drift detected: ${presentVersions.map(([label, version]) => `${label} ${version || 'missing'}`).join(' · ')}.`;
  } else if (missing.length > 0) {
    status = 'unknown';
    note = `Portal compatibility cannot be proven because ${missing.join(', ')} version evidence is missing.`;
  } else if (stampVersionMismatch) {
    status = 'blocked';
    note = `Portal deploy provenance targets release ${snapshot.deployStamp?.releaseVersion || 'unknown'} / source ${snapshot.deployStamp?.sourceVersion || 'unknown'}, but the installed runtime is ${expectedVersion}.`;
  } else if (!stampValid) {
    status = 'review';
    note = 'Portal versions agree, but clean source/artifact deployment provenance could not be verified from the deploy stamp.';
  }

  return {
    id: 'portal',
    label: 'BridgesLLM Portal',
    installedVersion: presentVersions.map(([label, version]) => `${label} ${version || 'unknown'}`).join(' · '),
    supportedVersion: 'Exact package/source/compiled/installer parity with a clean artifact deploy stamp',
    policy: 'self-update-only',
    status,
    note,
  };
}

async function firstCommandLine(command: string, timeoutMs = 4000): Promise<string | null> {
  const result = await runShell(command, timeoutMs);
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return line || null;
}

type OpenClawCompatibilitySnapshot = Pick<OpenClawSetupReadiness,
  | 'installed'
  | 'version'
  | 'corePackageVersion'
  | 'runningVersion'
  | 'codexPluginVersion'
  | 'testedCorePackageVersion'
  | 'testedRuntimeVersion'
  | 'testedCodexPluginVersion'
  | 'testedPairReady'
  | 'blockers'
>;

export function buildOpenClawMaintenanceComponent(
  readiness: OpenClawCompatibilitySnapshot,
): MaintenanceCompatibilityComponent {
  const pairBlockerCodes = new Set([
    'not-installed',
    'core-package-mismatch',
    'cli-runtime-mismatch',
    'gateway-rpc-unavailable',
    'gateway-runtime-mismatch',
    'codex-plugin-mismatch',
  ]);
  const pairBlockers = readiness.blockers
    .filter((blocker) => pairBlockerCodes.has(blocker.code))
    .map((blocker) => blocker.message);
  const installedSummary = [
    `core ${readiness.corePackageVersion || 'unknown'}`,
    `CLI ${readiness.version || 'unknown'}`,
    `gateway ${readiness.runningVersion || 'unknown'}`,
    `Codex ${readiness.codexPluginVersion || 'unknown'}`,
  ].join(' · ');
  const supportedSummary = [
    `core ${readiness.testedCorePackageVersion}`,
    `runtime ${readiness.testedRuntimeVersion}`,
    `Codex ${readiness.testedCodexPluginVersion}`,
  ].join(' · ');

  return {
    id: 'openclaw',
    label: 'OpenClaw runtime',
    installedVersion: readiness.installed ? installedSummary : null,
    supportedVersion: supportedSummary,
    policy: 'known-compatible',
    status: !readiness.installed ? 'unknown' : (readiness.testedPairReady ? 'ok' : 'blocked'),
    note: readiness.testedPairReady
      ? 'Installed core, running gateway, and Codex plugin match the exact Portal-tested pair.'
      : (pairBlockers.join(' ') || 'The installed OpenClaw pair could not be verified.'),
  };
}

async function getCompatibilityState(): Promise<MaintenanceCompatibility> {
  const root = portalRoot();
  const [openClawReadiness, caddyVersion, stalwartVersion, caddyCandidateRaw] = await Promise.all([
    getOpenClawSetupReadiness(),
    firstCommandLine('command -v caddy >/dev/null 2>&1 && caddy version'),
    firstCommandLine('command -v stalwart-mail >/dev/null 2>&1 && stalwart-mail --version || command -v stalwart >/dev/null 2>&1 && stalwart --version'),
    firstCommandLine("apt-cache policy caddy 2>/dev/null | awk '/Candidate:/ {print $2}'"),
  ]);

  // A pending Caddy update only exists when apt's candidate differs from the
  // installed package. The old permanent "review" status read like an update
  // was always waiting, which caused repeated false alarms.
  const caddyInstalledPkg = (caddyVersion || '').replace(/^v/, '').split(/\s+/)[0] || '';
  const caddyCandidate = (caddyCandidateRaw || '').trim();
  const caddyUpdatePending = Boolean(
    caddyCandidate
    && caddyCandidate !== '(none)'
    && caddyInstalledPkg
    && !caddyCandidate.startsWith(caddyInstalledPkg)
    && caddyCandidate !== caddyInstalledPkg,
  );

  return {
    policy: 'guarded',
    summary: 'Automation is limited to known-safe maintenance. Broad package and managed-component upgrades require a generated plan before execution.',
    components: [
      buildPortalMaintenanceComponent(portalCompatibilitySnapshot(root)),
      buildOpenClawMaintenanceComponent(openClawReadiness),
      {
        id: 'stalwart',
        label: 'Mail server',
        installedVersion: stalwartVersion,
        supportedVersion: 'Portal-confirmed mail API versions only',
        policy: 'blocked-until-confirmed',
        status: stalwartVersion ? 'blocked' : 'unknown',
        note: 'Mail server major/minor upgrades are blocked until Portal compatibility is confirmed.',
      },
      {
        id: 'caddy',
        label: 'Caddy reverse proxy',
        installedVersion: caddyVersion,
        supportedVersion: caddyUpdatePending ? `Update available: ${caddyCandidate}` : 'Up to date with the stable channel',
        policy: 'manual-review',
        status: !caddyVersion ? 'unknown' : (caddyUpdatePending ? 'review' : 'ok'),
        note: caddyUpdatePending
          ? 'A Caddy package update is pending. Review the release notes and validate the Caddyfile before upgrading — never upgrade Caddy as part of a Portal update.'
          : 'Installed Caddy matches the newest package in the stable channel. No action needed.',
      },
    ],
  };
}

async function latestBackup(): Promise<{ path: string; createdAt: string; ageHours: number } | null> {
  let latest: { fullPath: string; mtimeMs: number } | null = null;
  try {
    const root = await getConfiguredBackupRoot();
    latest = listBackupFiles(root).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
  } catch {
    return null;
  }
  if (!latest) return null;
  return {
    path: latest.fullPath,
    createdAt: new Date(latest.mtimeMs).toISOString(),
    ageHours: ageHoursSince(latest.mtimeMs),
  };
}

function maintenanceLockPath(): string {
  return path.join(portalRoot(), 'backend', '.data', 'locks', 'system-maintenance.lock');
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function readMaintenanceLockOwner(lockPath: string): { pid: number; token: string } | null {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown; token?: unknown };
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 1 || typeof parsed.token !== 'string') return null;
    return { pid: parsed.pid as number, token: parsed.token };
  } catch {
    return null;
  }
}

async function findActiveMaintenanceJob(): Promise<ActiveMaintenanceJob | null> {
  return prisma.agentJob.findFirst({
    where: { toolId: MAINTENANCE_TOOL_ID, status: 'running' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, startedAt: true },
  });
}

export class MaintenanceAdmissionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 409 | 503,
    public readonly code: 'MAINTENANCE_BUSY' | 'MAINTENANCE_ADMISSION_UNAVAILABLE',
    public readonly activeJob: ActiveMaintenanceJob | null = null,
  ) {
    super(message);
    this.name = 'MaintenanceAdmissionError';
  }
}

function releaseOwnedMaintenanceLock(lockPath: string, token: string): void {
  const owner = readMaintenanceLockOwner(lockPath);
  if (!owner || owner.token !== token) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') console.warn('[system-maintenance] failed to release admission lock:', error);
  }
}

/**
 * Acquire a host-local atomic admission lock, then consult the durable AgentJob
 * ledger before allowing a new maintenance process. The file closes the
 * query/create race between concurrent requests; the DB row keeps the gate
 * closed after admission is released and across Portal restarts.
 */
export async function acquireMaintenanceActionAdmission(
  options: MaintenanceAdmissionOptions = {},
): Promise<{ release: () => void }> {
  const lockPath = options.lockPath || maintenanceLockPath();
  const nowMs = options.nowMs || Date.now;
  const activeJobLookup = options.activeJobLookup || findActiveMaintenanceJob;
  const processAlive = options.processAlive || defaultProcessAlive;
  const staleMs = options.staleMs ?? MAINTENANCE_ADMISSION_STALE_MS;
  const token = crypto.randomUUID();

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(path.dirname(lockPath));
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('Maintenance lock directory is not a real directory');
    }
    fs.chmodSync(path.dirname(lockPath), 0o700);
  } catch (error: any) {
    throw new MaintenanceAdmissionError(
      `Maintenance admission is unavailable: ${error?.message || 'lock directory validation failed'}`,
      503,
      'MAINTENANCE_ADMISSION_UNAVAILABLE',
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | null = null;
    let createdLock = false;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      createdLock = true;
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date(nowMs()).toISOString() })}\n`, 'utf8');
      fs.closeSync(descriptor);
      descriptor = null;

      let activeJob: ActiveMaintenanceJob | null;
      try {
        activeJob = await activeJobLookup();
      } catch (error: any) {
        releaseOwnedMaintenanceLock(lockPath, token);
        throw new MaintenanceAdmissionError(
          `Maintenance admission is unavailable because active jobs could not be verified: ${error?.message || 'database query failed'}`,
          503,
          'MAINTENANCE_ADMISSION_UNAVAILABLE',
        );
      }
      if (activeJob) {
        releaseOwnedMaintenanceLock(lockPath, token);
        throw new MaintenanceAdmissionError(
          `A maintenance job is already running${activeJob.title ? `: ${activeJob.title}` : ''}.`,
          409,
          'MAINTENANCE_BUSY',
          activeJob,
        );
      }

      return { release: () => releaseOwnedMaintenanceLock(lockPath, token) };
    } catch (error: any) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      if (createdLock && !(error instanceof MaintenanceAdmissionError)) {
        try { fs.unlinkSync(lockPath); } catch {}
      }
      if (error instanceof MaintenanceAdmissionError) throw error;
      if (error?.code !== 'EEXIST') {
        throw new MaintenanceAdmissionError(
          `Maintenance admission is unavailable: ${error?.message || 'lock acquisition failed'}`,
          503,
          'MAINTENANCE_ADMISSION_UNAVAILABLE',
        );
      }

      let activeJob: ActiveMaintenanceJob | null;
      try {
        activeJob = await activeJobLookup();
      } catch (lookupError: any) {
        throw new MaintenanceAdmissionError(
          `Maintenance admission is unavailable because active jobs could not be verified: ${lookupError?.message || 'database query failed'}`,
          503,
          'MAINTENANCE_ADMISSION_UNAVAILABLE',
        );
      }
      if (activeJob) {
        throw new MaintenanceAdmissionError(
          `A maintenance job is already running${activeJob.title ? `: ${activeJob.title}` : ''}.`,
          409,
          'MAINTENANCE_BUSY',
          activeJob,
        );
      }

      let stat: fs.Stats | null = null;
      try { stat = fs.lstatSync(lockPath); } catch {}
      const owner = readMaintenanceLockOwner(lockPath);
      const stale = Boolean(stat && nowMs() - stat.mtimeMs >= staleMs);
      const abandoned = owner ? !processAlive(owner.pid) : stale;
      if (attempt === 0 && stale && abandoned) {
        const quarantinePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
        try {
          fs.renameSync(lockPath, quarantinePath);
          fs.unlinkSync(quarantinePath);
          continue;
        } catch (reclaimError: any) {
          if (reclaimError?.code === 'ENOENT') continue;
        }
      }
      throw new MaintenanceAdmissionError(
        'Another maintenance request is being admitted. Wait for it to finish before starting another action.',
        409,
        'MAINTENANCE_BUSY',
      );
    }
  }

  throw new MaintenanceAdmissionError(
    'Maintenance admission could not be established safely.',
    503,
    'MAINTENANCE_ADMISSION_UNAVAILABLE',
  );
}

export async function verifyMaintenanceBackupArchive(candidate: MaintenanceBackupCandidate): Promise<boolean> {
  if (candidate.size <= 0) return false;
  const backupScript = process.env.BACKUP_SCRIPT_PATH
    || path.join(portalRoot(), 'backup-full.sh');
  const verification = await runShell(
    `/bin/bash ${shellQuote(backupScript)} --verify-archive ${shellQuote(candidate.fullPath)}`,
    120_000,
  );
  if (!verification.ok) return false;
  try {
    const stat = fs.lstatSync(candidate.fullPath);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && stat.dev === candidate.dev
      && stat.ino === candidate.ino
      && stat.size === candidate.size
      && stat.mtimeMs === candidate.mtimeMs;
  } catch {
    return false;
  }
}

export async function findFreshVerifiedMaintenanceBackup(options: {
  nowMs?: number;
  candidates?: MaintenanceBackupCandidate[];
  verifyArchive?: (candidate: MaintenanceBackupCandidate) => Promise<boolean>;
} = {}): Promise<VerifiedMaintenanceBackup | null> {
  const nowMs = options.nowMs ?? Date.now();
  let candidates = options.candidates;
  if (!candidates) {
    try {
      const root = await getConfiguredBackupRoot();
      candidates = listBackupFiles(root);
    } catch {
      return null;
    }
  }
  const verifyArchive = options.verifyArchive || verifyMaintenanceBackupArchive;
  const maxAgeMs = MAINTENANCE_BACKUP_MAX_AGE_HOURS * 3_600_000;
  const eligible = candidates
    .filter((candidate) => candidate.size > 0)
    .filter((candidate) => nowMs - candidate.mtimeMs <= maxAgeMs)
    .filter((candidate) => candidate.mtimeMs - nowMs <= MAINTENANCE_BACKUP_MAX_FUTURE_SKEW_MS)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of eligible) {
    if (!await verifyArchive(candidate)) continue;
    return {
      path: candidate.fullPath,
      filename: candidate.filename,
      createdAt: new Date(candidate.mtimeMs).toISOString(),
      ageHours: Math.round(((nowMs - candidate.mtimeMs) / 3_600_000) * 10) / 10,
      size: candidate.size,
    };
  }
  return null;
}

async function getRootDisk() {
  const result = await runShell("df -B1 --output=target,size,used,avail,pcent / | tail -n 1 | awk '{print $1\" \"$2\" \"$3\" \"$4\" \"$5}'", 5000);
  const [mount, totalRaw, usedRaw, availableRaw, percentRaw] = result.stdout.split(/\s+/);
  const usagePercent = Number.parseFloat(String(percentRaw || '0').replace('%', '')) || 0;
  return {
    mount: mount || '/',
    total: Number.parseInt(totalRaw || '0', 10) || 0,
    used: Number.parseInt(usedRaw || '0', 10) || 0,
    available: Number.parseInt(availableRaw || '0', 10) || 0,
    usagePercent,
  };
}

async function getAptState() {
  const aptAvailable = (await runShell('command -v apt-get >/dev/null 2>&1')).ok;
  if (!aptAvailable) {
    return {
      available: false,
      cacheAgeHours: null,
      upgradableCount: null,
      securityUpgradableCount: null,
      protectedUpdatePackages: [],
      locksActive: false,
      unattendedUpgradeAvailable: false,
    };
  }

  const stampCandidates = [
    '/var/lib/apt/periodic/update-success-stamp',
    '/var/cache/apt/pkgcache.bin',
    '/var/lib/apt/lists',
  ];
  const stampMs = stampCandidates.map(fileMtimeMs).filter((value): value is number => typeof value === 'number').sort((a, b) => b - a)[0] || null;
  const cacheAgeHours = stampMs ? ageHoursSince(stampMs) : null;

  const lockCheck = await runShell(`for lock in ${APT_LOCKS.map(shellQuote).join(' ')}; do fuser "$lock" >/dev/null 2>&1 && echo "$lock"; done`, 4000);
  const upgradable = await runShell("apt list --upgradable 2>/dev/null | tail -n +2 | sed '/^$/d'", 12000);
  const lines = upgradable.stdout ? upgradable.stdout.split(/\r?\n/).filter(Boolean) : [];
  const held = await runShell('apt-mark showhold 2>/dev/null || true', 12000);
  const heldPackages = new Set(held.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const packageNameFromAptLine = (line: string): string => line.split('/')[0]?.trim() || '';
  const actionableLines = lines.filter((line) => {
    const name = packageNameFromAptLine(line);
    return Boolean(name && !heldPackages.has(name));
  });
  const heldUpdatePackages = Array.from(new Set(lines
    .map(packageNameFromAptLine)
    .filter((name): name is string => Boolean(name && heldPackages.has(name)))))
    .sort();
  const securityLines = actionableLines.filter((line) => /(?:-security|security\.ubuntu\.com|Debian-Security|\/.*security)/i.test(line));
  const protectedUpdatePackages = Array.from(new Set(actionableLines
    .map(packageNameFromAptLine)
    .filter((name): name is string => Boolean(name && PROTECTED_PACKAGE_REGEX.test(name)))))
    .sort();
  const aptCheck = await runShell('if [ -x /usr/lib/update-notifier/apt-check ]; then /usr/lib/update-notifier/apt-check 2>/dev/null; fi', 12000);
  const aptCheckMatch = aptCheck.stdout.match(/^\s*(\d+)\s*;\s*(\d+)\s*$/);
  const aptCheckUpgradableCount = aptCheckMatch ? Number.parseInt(aptCheckMatch[1], 10) : null;
  const aptCheckSecurityCount = aptCheckMatch ? Number.parseInt(aptCheckMatch[2], 10) : null;
  const unattendedUpgradeAvailable = (await runShell('command -v unattended-upgrade >/dev/null 2>&1')).ok;

  return {
    available: true,
    cacheAgeHours,
    upgradableCount: heldUpdatePackages.length > 0 ? actionableLines.length : (Number.isFinite(aptCheckUpgradableCount) ? aptCheckUpgradableCount : actionableLines.length),
    securityUpgradableCount: heldUpdatePackages.length > 0 ? securityLines.length : (Number.isFinite(aptCheckSecurityCount) ? aptCheckSecurityCount : securityLines.length),
    protectedUpdatePackages,
    heldPackages: Array.from(heldPackages).sort(),
    heldUpdatePackages,
    locksActive: Boolean(lockCheck.stdout.trim()),
    unattendedUpgradeAvailable,
  };
}

async function getServiceStates(): Promise<ServiceState[]> {
  const states: ServiceState[] = [];
  for (const service of CHECKED_SERVICES) {
    const exists = await runShell(`systemctl cat ${shellQuote(service.name)} >/dev/null 2>&1`, 4000);
    if (!exists.ok && !service.required) {
      const installed = service.installedProbe
        ? await runShell(service.installedProbe, 4000)
        : null;
      if (!installed?.ok) continue;
    }
    const active = await runShell(`systemctl is-active ${shellQuote(service.name)} 2>/dev/null || true`, 4000);
    states.push({
      name: service.name,
      label: service.label,
      required: service.required,
      exists: exists.ok,
      active: active.stdout.trim() || 'unknown',
      healthy: exists.ok && active.stdout.trim() === 'active',
    });
  }
  return states;
}

function severityRank(severity: MaintenanceSeverity): number {
  return severity === 'critical' ? 3 : severity === 'warning' ? 2 : severity === 'info' ? 1 : 0;
}

async function collectMaintenanceStatus() {
  const [apt, disk, services, compatibility] = await Promise.all([
    getAptState(),
    getRootDisk(),
    getServiceStates(),
    getCompatibilityState(),
  ]);
  const osRelease = readOsRelease();
  const backup = await latestBackup();
  const rebootRequired = fs.existsSync('/var/run/reboot-required');
  const rebootPackages = fs.existsSync('/var/run/reboot-required.pkgs')
    ? fs.readFileSync('/var/run/reboot-required.pkgs', 'utf8').split(/\r?\n/).filter(Boolean).slice(0, 20)
    : [];

  const issues: MaintenanceIssue[] = [];

  if (apt.available && apt.cacheAgeHours !== null && apt.cacheAgeHours > 48) {
    issues.push({
      id: 'apt-cache-stale',
      title: 'Package metadata is stale',
      detail: `Package metadata was refreshed about ${apt.cacheAgeHours} hours ago.`,
      severity: apt.cacheAgeHours > 168 ? 'warning' : 'info',
      category: 'updates',
      recommendation: 'Refresh the package cache before judging update drift.',
      actionId: 'refresh-package-cache',
      automationSafe: true,
    });
  }

  if (apt.locksActive) {
    issues.push({
      id: 'apt-lock-active',
      title: 'Package manager is busy',
      detail: 'Apt or dpkg currently has an active lock.',
      severity: 'warning',
      category: 'updates',
      recommendation: 'Wait for the package manager to finish before starting maintenance.',
      automationSafe: false,
    });
  }

  const protectedUpdatesPending = Boolean(apt.available && apt.protectedUpdatePackages.length > 0);

  if (protectedUpdatesPending) {
    issues.push({
      id: 'protected-component-updates-pending',
      title: 'Protected component updates need compatibility review',
      detail: `Pending protected package${apt.protectedUpdatePackages.length === 1 ? '' : 's'}: ${apt.protectedUpdatePackages.join(', ')}.`,
      severity: 'warning',
      category: 'updates',
      recommendation: 'Generate a maintenance plan before upgrading Portal-managed components. Security automation will pause until compatibility is reviewed.',
      actionId: 'generate-maintenance-plan',
      automationSafe: true,
    });
  }

  if (apt.available && (apt.securityUpgradableCount || 0) > 0) {
    issues.push({
      id: 'security-updates-pending',
      title: 'Security updates are pending',
      detail: `${apt.securityUpgradableCount} security-related package update${apt.securityUpgradableCount === 1 ? '' : 's'} appear available.`,
      severity: 'critical',
      category: 'security',
      recommendation: protectedUpdatesPending
        ? 'Generate a maintenance plan first because protected Portal-managed components are pending package updates.'
        : apt.unattendedUpgradeAvailable
        ? 'Schedule or run security maintenance from the dashboard.'
        : 'Install/configure unattended-upgrades or review security package updates manually.',
      actionId: protectedUpdatesPending ? 'generate-maintenance-plan' : (apt.unattendedUpgradeAvailable ? 'apply-security-updates' : undefined),
      automationSafe: apt.unattendedUpgradeAvailable || protectedUpdatesPending,
    });
  } else if (apt.available && (apt.upgradableCount || 0) > 0) {
    issues.push({
      id: 'package-updates-pending',
      title: 'Package updates are available',
      detail: `${apt.upgradableCount} package update${apt.upgradableCount === 1 ? '' : 's'} appear available.`,
      severity: 'info',
      category: 'updates',
      recommendation: 'Generate a maintenance plan before broad upgrades. Portal-managed components should only move to known-compatible versions.',
      actionId: 'generate-maintenance-plan',
      automationSafe: true,
    });
  }

  if (rebootRequired) {
    issues.push({
      id: 'reboot-required',
      title: 'Reboot required to finish updates',
      detail: rebootPackages.length ? `Pending reboot packages: ${rebootPackages.join(', ')}` : 'The host reports that a reboot is required.',
      severity: 'critical',
      category: 'security',
      recommendation: 'Prepare a reboot checklist, then schedule a short maintenance window. Reboot is intentionally not automated.',
      actionId: 'prepare-reboot-checklist',
      downtimeExpected: true,
      automationSafe: true,
    });
  }

  if (disk.usagePercent >= 90) {
    issues.push({
      id: 'root-disk-critical',
      title: 'Root disk is critically full',
      detail: `/ is ${disk.usagePercent.toFixed(1)}% full.`,
      severity: 'critical',
      category: 'disk',
      recommendation: 'Free disk before running updates or backups.',
      automationSafe: false,
    });
  } else if (disk.usagePercent >= 80) {
    issues.push({
      id: 'root-disk-warning',
      title: 'Root disk is getting full',
      detail: `/ is ${disk.usagePercent.toFixed(1)}% full.`,
      severity: 'warning',
      category: 'disk',
      recommendation: 'Review storage before large updates or backups.',
      automationSafe: false,
    });
  }

  if (!backup) {
    issues.push({
      id: 'backup-missing',
      title: 'No Portal backup found',
      detail: 'No backup archive was found in the configured backup storage.',
      severity: 'warning',
      category: 'backups',
      recommendation: 'Create a backup before maintenance.',
      actionId: 'create-maintenance-backup',
      automationSafe: true,
    });
  } else if (backup.ageHours > MAINTENANCE_BACKUP_MAX_AGE_HOURS) {
    issues.push({
      id: 'backup-stale',
      title: 'Latest backup is stale',
      detail: `Latest backup is about ${backup.ageHours} hours old.`,
      severity: backup.ageHours > 72 ? 'warning' : 'info',
      category: 'backups',
      recommendation: `Create a verified backup no more than ${MAINTENANCE_BACKUP_MAX_AGE_HOURS} hours before guarded maintenance.`,
      actionId: 'create-maintenance-backup',
      automationSafe: true,
    });
  }

  for (const service of services) {
    if (!service.healthy) {
      issues.push({
        id: `service-${service.name.replace(/[^a-z0-9]+/gi, '-')}`,
        title: `${service.label} is not healthy`,
        detail: service.exists ? `${service.name} is ${service.active}.` : `${service.name} is missing.`,
        severity: service.required ? 'critical' : 'warning',
        category: 'services',
        recommendation: 'Ask an admin agent to inspect service logs before running maintenance.',
        automationSafe: false,
      });
    }
  }

  const status = issues.reduce<MaintenanceSeverity>((current, issue) => (
    severityRank(issue.severity) > severityRank(current) ? issue.severity : current
  ), 'healthy');

  return {
    checkedAt: new Date().toISOString(),
    status,
    summary: issues.length === 0
      ? 'No server maintenance drift detected.'
      : `${issues.length} maintenance item${issues.length === 1 ? '' : 's'} need attention.`,
    host: {
      hostname: os.hostname(),
      os: osRelease.PRETTY_NAME || os.type(),
      kernel: os.release(),
      uptimeSeconds: os.uptime(),
    },
    apt,
    disk,
    backup,
    services,
    reboot: { required: rebootRequired, packages: rebootPackages },
    compatibility,
    actions: Object.values(ACTIONS).map(({ command: _command, title: _title, ...action }) => action),
    issues,
  };
}

// Maintenance collection shells out to apt/systemctl and can take seconds on
// a cold or busy host. Serve a short-lived cache with stale-while-refresh
// semantics so the dashboard's checks section renders instantly on revisit
// while a background refresh keeps the data honest.
const MAINTENANCE_CACHE_TTL_MS = 10 * 60_000;
const MAINTENANCE_REFRESH_RETRY_BASE_MS = 5_000;
const MAINTENANCE_REFRESH_RETRY_MAX_MS = 60_000;

type MaintenanceRefreshCache<T> = { at: number; status: T };

type MaintenanceRefreshSnapshot<T> = {
  cache: MaintenanceRefreshCache<T> | null;
  refreshing: boolean;
  refreshError: string | null;
  retryAfterMs: number | null;
};

type MaintenanceRefreshAttempt<T> = {
  started: boolean;
  promise: Promise<T | null> | null;
};

type MaintenanceRefreshCoordinatorOptions = {
  nowMs?: () => number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onError?: (error: unknown) => void;
};

function boundedRefreshError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.trim().slice(0, 320) || 'Maintenance status refresh failed';
}

/**
 * Owns the expensive host-status collector's cache, single-flight promise,
 * and persistent-failure cooldown. Keeping the cooldown server-side means a
 * remounted page, another browser tab, or a client that ignores retry hints
 * still cannot hammer apt/systemd probes after a failure.
 */
export class MaintenanceRefreshCoordinator<T> {
  private cache: MaintenanceRefreshCache<T> | null = null;
  private refreshInFlight: Promise<T | null> | null = null;
  private lastRefreshError: string | null = null;
  private consecutiveFailures = 0;
  private retryAtMs = 0;
  private readonly nowMs: () => number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly collect: () => Promise<T>,
    options: MaintenanceRefreshCoordinatorOptions = {},
  ) {
    this.nowMs = options.nowMs || Date.now;
    this.retryBaseMs = Math.max(1, options.retryBaseMs || MAINTENANCE_REFRESH_RETRY_BASE_MS);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs || MAINTENANCE_REFRESH_RETRY_MAX_MS);
    this.onError = options.onError || (() => undefined);
  }

  snapshot(): MaintenanceRefreshSnapshot<T> {
    const retryAfterMs = Math.max(0, this.retryAtMs - this.nowMs());
    return {
      cache: this.cache,
      refreshing: this.refreshInFlight !== null,
      refreshError: this.lastRefreshError,
      retryAfterMs: retryAfterMs > 0 ? retryAfterMs : null,
    };
  }

  requestRefresh(): MaintenanceRefreshAttempt<T> {
    if (this.refreshInFlight) {
      return { started: false, promise: this.refreshInFlight };
    }
    if ((this.snapshot().retryAfterMs || 0) > 0) {
      return { started: false, promise: null };
    }

    const refreshPromise: Promise<T | null> = Promise.resolve()
      .then(() => this.collect())
      .then((status) => {
        this.cache = { at: this.nowMs(), status };
        this.lastRefreshError = null;
        this.consecutiveFailures = 0;
        this.retryAtMs = 0;
        return status;
      })
      .catch((error: unknown) => {
        this.consecutiveFailures += 1;
        const exponent = Math.min(30, this.consecutiveFailures - 1);
        const retryDelayMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
        this.retryAtMs = this.nowMs() + retryDelayMs;
        this.lastRefreshError = boundedRefreshError(error);
        this.onError(error);
        return null;
      })
      .finally(() => {
        if (this.refreshInFlight === refreshPromise) this.refreshInFlight = null;
      });
    this.refreshInFlight = refreshPromise;
    return { started: true, promise: refreshPromise };
  }
}

const maintenanceRefreshCoordinator = new MaintenanceRefreshCoordinator(collectMaintenanceStatus, {
  onError: (error) => console.error('[system-maintenance] background refresh failed:', error),
});

function publicMaintenanceActions(): MaintenanceAction[] {
  return Object.values(ACTIONS).map(({ command: _command, title: _title, ...action }) => action);
}

export function maintenanceActionCanRun(role: string | null | undefined, action: Pick<MaintenanceAction, 'requiresOwner'>): boolean {
  return !action.requiresOwner || isOwnerRole(role);
}

export function maintenanceActionConfirmationValid(
  action: Pick<MaintenanceAction, 'confirmationPhrase'>,
  confirmation: unknown,
): boolean {
  return isTypedConfirmationMatch(action.confirmationPhrase, confirmation);
}

export function maintenanceWindowAcknowledgementValid(
  action: Pick<MaintenanceAction, 'requiresMaintenanceWindow'>,
  acknowledgement: unknown,
): boolean {
  return !action.requiresMaintenanceWindow || acknowledgement === true;
}

export function checkedMaintenanceServiceUnits(): Array<{ name: string; required: boolean }> {
  return CHECKED_SERVICES.map(({ name, required }) => ({ name, required }));
}

export function getMaintenanceActionContract(actionId: string): MaintenanceAction | null {
  const action = ACTIONS[actionId];
  if (!action) return null;
  const { command: _command, title: _title, ...publicAction } = action;
  return publicAction;
}

export function createMaintenanceStatusHandler(
  refreshCoordinator: MaintenanceRefreshCoordinator<any> = maintenanceRefreshCoordinator,
): (req: Request, res: Response) => void {
  return (req: Request, res: Response) => {
  try {
    const force = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    const beforeRefresh = refreshCoordinator.snapshot();
    const cached = beforeRefresh.cache;
    if (cached) {
      const cacheAgeMs = Date.now() - cached.at;
      const retryDue = beforeRefresh.refreshError !== null && beforeRefresh.retryAfterMs === null;
      const shouldRefresh = force || retryDue || cacheAgeMs >= MAINTENANCE_CACHE_TTL_MS;
      if (shouldRefresh) refreshCoordinator.requestRefresh();
      const refresh = refreshCoordinator.snapshot();
      if (refresh.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(refresh.retryAfterMs / 1_000))));
      }
      res.json({
        ...cached.status,
        ready: true,
        cached: true,
        cacheAgeMs,
        refreshing: refresh.refreshing,
        refreshError: refresh.refreshError,
        retryAfterMs: refresh.retryAfterMs,
      });
      return;
    }

    refreshCoordinator.requestRefresh();
    const refresh = refreshCoordinator.snapshot();
    if (refresh.retryAfterMs) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(refresh.retryAfterMs / 1_000))));
    }
    res.status(202).json({
      ready: false,
      cached: false,
      refreshing: refresh.refreshing,
      checkedAt: null,
      refreshError: refresh.refreshError,
      retryAfterMs: refresh.retryAfterMs,
      status: refresh.refreshError ? 'warning' : 'info',
      summary: refresh.refreshError
        ? 'Server checks are paused after a failed refresh.'
        : 'Server checks are running in the background.',
      issues: [],
      actions: publicMaintenanceActions(),
    });
  } catch (error: any) {
    console.error('[system-maintenance] status failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to collect maintenance status' });
  }
  };
}

router.get('/', createMaintenanceStatusHandler());

router.post('/actions/:actionId', async (req: Request, res: Response) => {
  try {
    const actionId = String(req.params.actionId || '').trim();
    const action = ACTIONS[actionId];
    if (!action) {
      res.status(404).json({ error: 'Maintenance action not found' });
      return;
    }

    if (!maintenanceActionCanRun(req.user?.role, action)) {
      res.status(403).json({ error: 'Owner access is required for maintenance actions that change the server.' });
      return;
    }

    if (!maintenanceActionConfirmationValid(action, req.body?.confirmation)) {
      res.status(400).json({
        error: `Type ${action.confirmationPhrase} to confirm this server change.`,
        confirmationPhrase: action.confirmationPhrase,
      });
      return;
    }

    if (!maintenanceWindowAcknowledgementValid(action, req.body?.maintenanceWindowAcknowledged)) {
      res.status(400).json({
        error: 'Acknowledge that an approved maintenance window is active before starting this action.',
        code: 'MAINTENANCE_WINDOW_REQUIRED',
        requiresMaintenanceWindow: true,
      });
      return;
    }

    const admission = await acquireMaintenanceActionAdmission();
    try {
      if ((actionId === 'refresh-package-cache' || actionId === 'apply-security-updates')) {
        const apt = await getAptState();
        if (!apt.available) {
          res.status(400).json({ error: 'Apt is not available on this host.' });
          return;
        }
        if (apt.locksActive) {
          res.status(409).json({ error: 'Package manager is busy. Try again after apt/dpkg finishes.' });
          return;
        }
        if (actionId === 'apply-security-updates' && !apt.unattendedUpgradeAvailable) {
          res.status(400).json({ error: 'unattended-upgrade is not installed; security updates require manual review.' });
          return;
        }
      }

      const verifiedBackup = action.requiresBackup
        ? await findFreshVerifiedMaintenanceBackup()
        : null;
      if (action.requiresBackup && !verifiedBackup) {
        res.status(409).json({
          error: `A verified Portal backup no older than ${MAINTENANCE_BACKUP_MAX_AGE_HOURS} hours is required before this action. Create a maintenance backup and wait for it to complete.`,
          code: 'FRESH_VERIFIED_BACKUP_REQUIRED',
          maxBackupAgeHours: MAINTENANCE_BACKUP_MAX_AGE_HOURS,
        });
        return;
      }

      const job = await startAgentJob({
        userId: req.user!.userId,
        actorAuthorizationVersion: Number(req.user!.authorizationVersion ?? 1),
        toolId: MAINTENANCE_TOOL_ID,
        title: action.title,
        command: action.command,
        cwd: process.env.PORTAL_ROOT || '/opt/bridgesllm/portal',
        env: { DEBIAN_FRONTEND: 'noninteractive' },
      });

      const { command: _command, title: _title, ...publicAction } = action;
      res.status(202).json({
        job,
        action: publicAction,
        preflight: {
          maintenanceWindowAcknowledged: action.requiresMaintenanceWindow,
          backup: verifiedBackup,
        },
      });
    } finally {
      admission.release();
    }
  } catch (error: any) {
    console.error('[system-maintenance] action failed:', error);
    if (error instanceof MaintenanceAdmissionError) {
      res.status(error.statusCode).json({
        error: error.message,
        code: error.code,
        activeJob: error.activeJob,
      });
      return;
    }
    res.status(500).json({ error: error?.message || 'Failed to start maintenance action' });
  }
});

export default router;
