import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec as cpExec } from 'child_process';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import { startAgentJob } from '../services/agentJobs';

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

const router = Router();
router.use(authenticateToken, requireAdmin);

const APT_LOCKS = [
  '/var/lib/dpkg/lock-frontend',
  '/var/lib/dpkg/lock',
  '/var/cache/apt/archives/lock',
  '/var/lib/apt/lists/lock',
];

const BACKUP_DIRS = [
  '/root/backups/daily',
  '/root/backups/weekly',
  '/root/backups/monthly',
  '/root/backups/comprehensive',
  '/opt/bridgesllm/backups',
];

const CHECKED_SERVICES = [
  { name: 'bridgesllm-product.service', label: 'Portal backend', required: true },
  { name: 'caddy.service', label: 'Caddy reverse proxy', required: true },
  { name: 'docker.service', label: 'Docker engine', required: false },
  { name: 'bridges-rd-xtigervnc.service', label: 'Remote Desktop VNC', required: false },
  { name: 'bridges-rd-websockify.service', label: 'Remote Desktop WebSocket bridge', required: false },
];

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
for service in bridgesllm-product.service caddy.service docker.service bridges-rd-xtigervnc.service bridges-rd-websockify.service; do
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
find /opt/bridgesllm/backups /root/backups/daily /root/backups/weekly /root/backups/monthly /root/backups/comprehensive \\
  -maxdepth 1 -type f \\( -name '*.tgz' -o -name '*.tar.gz' \\) -printf '%T@ %TY-%Tm-%Td %TH:%TM %p\\n' 2>/dev/null \\
  | sort -nr | head -n 10 || true

section "Services that should come back after reboot"
for service in bridgesllm-product.service caddy.service docker.service bridges-rd-xtigervnc.service bridges-rd-websockify.service; do
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
    requiresOwner: true,
    changesSystem: false,
    destructive: false,
    requiresBackup: false,
    requiresMaintenanceWindow: false,
    automationLevel: 'read-only',
    impact: 'Reads package, service, reboot, backup, and compatibility state. It does not modify the server.',
    recovery: 'No rollback needed; this action only writes a background-task transcript.',
    command: MAINTENANCE_PLAN_COMMAND,
  },
  'prepare-reboot-checklist': {
    id: 'prepare-reboot-checklist',
    label: 'Prepare Reboot Checklist',
    title: 'Prepare reboot checklist',
    description: 'Creates a read-only reboot readiness checklist with backup, service, and package context. It does not reboot the server.',
    risk: 'scheduled',
    downtimeExpected: false,
    requiresOwner: true,
    changesSystem: false,
    destructive: false,
    requiresBackup: false,
    requiresMaintenanceWindow: false,
    automationLevel: 'read-only',
    impact: 'Reads reboot-required state and service health so an admin can schedule downtime deliberately.',
    recovery: 'No rollback needed; this action only writes a background-task transcript.',
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
    command: 'set -euo pipefail\nportal_root="${PORTAL_ROOT:-/opt/bridgesllm/portal}"\nbash "$portal_root/backup-full.sh" daily',
  },
};

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runShell(command: string, timeoutMs = 8000): Promise<CommandResult> {
  return new Promise((resolve) => {
    cpExec(command, { timeout: timeoutMs, shell: '/bin/bash', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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

async function firstCommandLine(command: string, timeoutMs = 4000): Promise<string | null> {
  const result = await runShell(command, timeoutMs);
  const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return line || null;
}

async function getCompatibilityState(): Promise<MaintenanceCompatibility> {
  const root = portalRoot();
  const [openClawVersion, caddyVersion, stalwartVersion] = await Promise.all([
    firstCommandLine('command -v openclaw >/dev/null 2>&1 && openclaw --version'),
    firstCommandLine('command -v caddy >/dev/null 2>&1 && caddy version'),
    firstCommandLine('command -v stalwart-mail >/dev/null 2>&1 && stalwart-mail --version || command -v stalwart >/dev/null 2>&1 && stalwart --version'),
  ]);

  return {
    policy: 'guarded',
    summary: 'Automation is limited to known-safe maintenance. Broad package and managed-component upgrades require a generated plan before execution.',
    components: [
      {
        id: 'portal',
        label: 'BridgesLLM Portal',
        installedVersion: readJsonVersion(path.join(root, 'backend/package.json')),
        supportedVersion: 'Current release channel',
        policy: 'self-update-only',
        status: 'ok',
        note: 'Portal updates should use the Portal updater or installer artifact path, not a broad system upgrade.',
      },
      {
        id: 'openclaw',
        label: 'OpenClaw runtime',
        installedVersion: openClawVersion,
        supportedVersion: 'Portal-confirmed runtime versions',
        policy: 'known-compatible',
        status: openClawVersion ? 'ok' : 'unknown',
        note: 'Runtime upgrades should be coordinated with Portal gateway compatibility checks.',
      },
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
        supportedVersion: 'Distribution security updates',
        policy: 'manual-review',
        status: caddyVersion ? 'review' : 'unknown',
        note: 'Security updates are usually safe, but config-impacting upgrades should be reviewed.',
      },
    ],
  };
}

function latestBackup(): { path: string; createdAt: string; ageHours: number } | null {
  let latest: { path: string; mtimeMs: number } | null = null;
  for (const dir of BACKUP_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(?:tar\.gz|tgz)$/i.test(name)) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { path: fullPath, mtimeMs: stat.mtimeMs };
      } catch {}
    }
  }
  if (!latest) return null;
  return {
    path: latest.path,
    createdAt: new Date(latest.mtimeMs).toISOString(),
    ageHours: ageHoursSince(latest.mtimeMs),
  };
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
    if (!exists.ok && !service.required) continue;
    const active = await runShell(`systemctl is-active ${shellQuote(service.name)} 2>/dev/null || true`, 4000);
    states.push({
      ...service,
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
  const backup = latestBackup();
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
      detail: 'No backup archive was found in the standard backup locations.',
      severity: 'warning',
      category: 'backups',
      recommendation: 'Create a backup before maintenance.',
      actionId: 'create-maintenance-backup',
      automationSafe: true,
    });
  } else if (backup.ageHours > 72) {
    issues.push({
      id: 'backup-stale',
      title: 'Latest backup is stale',
      detail: `Latest backup is about ${backup.ageHours} hours old.`,
      severity: backup.ageHours > 168 ? 'warning' : 'info',
      category: 'backups',
      recommendation: 'Create a fresh backup before maintenance.',
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
    actions: Object.values(ACTIONS).map(({ command, title, ...action }) => action),
    issues,
  };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await collectMaintenanceStatus());
  } catch (error: any) {
    console.error('[system-maintenance] status failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to collect maintenance status' });
  }
});

router.post('/actions/:actionId', requireOwner, async (req: Request, res: Response) => {
  try {
    const actionId = String(req.params.actionId || '').trim();
    const action = ACTIONS[actionId];
    if (!action) {
      res.status(404).json({ error: 'Maintenance action not found' });
      return;
    }

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

    const job = await startAgentJob({
      userId: req.user!.userId,
      toolId: 'system-maintenance',
      title: action.title,
      command: action.command,
      cwd: process.env.PORTAL_ROOT || '/opt/bridgesllm/portal',
      env: { DEBIAN_FRONTEND: 'noninteractive' },
    });

    const { command, title, ...publicAction } = action;
    res.status(202).json({ job, action: publicAction });
  } catch (error: any) {
    console.error('[system-maintenance] action failed:', error);
    res.status(500).json({ error: error?.message || 'Failed to start maintenance action' });
  }
});

export default router;
