export type PortalSurfaceRole = 'OWNER' | 'SUB_ADMIN' | 'USER' | 'VIEWER' | string | null | undefined;

export type SettingsTabId =
  | 'general'
  | 'email'
  | 'security'
  | 'agents'
  | 'system'
  | 'ai-providers'
  | 'readiness'
  | 'backups'
  | 'profile';

export type AdminTabId = 'users' | 'maintenance' | 'pending';

export const SETTINGS_TAB_ACCESS: Record<SettingsTabId, 'all' | 'elevated' | 'owner'> = {
  general: 'owner',
  email: 'owner',
  security: 'owner',
  agents: 'owner',
  system: 'owner',
  'ai-providers': 'owner',
  readiness: 'elevated',
  backups: 'owner',
  profile: 'all',
};

/** Settings tabs in navigation order. */
export const SETTINGS_TAB_IDS = Object.freeze(Object.keys(SETTINGS_TAB_ACCESS) as SettingsTabId[]);

// ── Navigation and search catalogue ──────────────────────────────────
// The rendered tab labels and the Ctrl+K settings search read the same
// entries, so a new tab cannot ship without search text. Everything here is
// static, non-secret help text: never configuration values or credentials.

/** A card or control inside a tab or section that search can point at. */
export interface SearchTopic {
  /** Unique within its tab or section: lowercase letters, digits and hyphens. */
  id: string;
  label: string;
  summary: string;
  keywords: readonly string[];
  /** Narrower than the page itself: an Owner-only control, or one shown only to accounts without host authority. */
  audience?: 'owner' | 'non-owner' | 'non-elevated';
}

export interface SurfaceCatalogEntry {
  /** The label the navigation renders. */
  label: string;
  summary: string;
  keywords: readonly string[];
  topics: readonly SearchTopic[];
}

const TWO_FACTOR_KEYWORDS = ['2fa', 'mfa', 'two factor', 'multi-factor', 'authenticator', 'totp', 'backup codes', 'verification code', 'email code'];

export const SETTINGS_TABS: Readonly<Record<SettingsTabId, SurfaceCatalogEntry>> = Object.freeze({
  general: {
    label: 'General',
    summary: 'Portal name, logo, assistant name, avatars, theme, search-engine indexing and the domain.',
    keywords: ['branding', 'appearance', 'portal name', 'logo', 'assistant name', 'avatars', 'theme', 'dark mode', 'light mode', 'accent color', 'visual effects', 'search engines', 'domain', 'https'],
    topics: [
      { id: 'identity', label: 'Portal identity', summary: 'Portal name, logo, assistant display name, agent chat avatars and search-engine indexing.', keywords: ['portal name', 'rename portal', 'logo', 'branding', 'assistant display name', 'avatar', 'agent chat avatars', 'search engines', 'indexing', 'noindex', 'seo'] },
      { id: 'theme', label: 'Theme and accent color', summary: 'Color mode, accent color and visual effects (reduced blur and glass for older graphics).', keywords: ['dark mode', 'light mode', 'system theme', 'color mode', 'accent', 'colour', 'visual effects', 'reduced effects', 'blur', 'animations'] },
      { id: 'domain', label: 'Domain & HTTPS', summary: 'Custom domain with a DNS check, public IP and HTTPS status.', keywords: ['custom domain', 'dns', 'a record', 'https', 'ssl', 'certificate', 'public ip', 'configure domain'] },
    ],
  },
  email: {
    label: 'Email',
    summary: 'Mail server status, test email and notification events.',
    keywords: ['email', 'notifications', 'system email', 'alerts'],
    topics: [
      { id: 'notification-events', label: 'Notification events', summary: 'Which events email admins and users: registrations, approvals, system errors, password changes and new-device logins.', keywords: ['notifications', 'email alerts', 'new registration', 'account approved', 'system errors', 'password change email', 'new device login'] },
      { id: 'mail-server', label: 'Mail server', summary: 'Hosted mail server status and test email.', keywords: ['mail server', 'smtp', 'test email', 'sender'] },
    ],
  },
  security: {
    label: 'Security',
    summary: 'Registration, the Project workspace default, login limits, hosted content embeds and your two-factor authentication.',
    keywords: ['registration', 'sign up', 'login', 'sessions', 'embeds', '2fa', 'mfa'],
    topics: [
      { id: 'registration', label: 'Registration', summary: 'Open, approval-only or closed registration, and blocking the requester IP when it is closed.', keywords: ['registration mode', 'sign up', 'signup', 'open registration', 'approval', 'closed registration', 'block ip', 'new users'] },
      { id: 'workspace-default', label: 'Project workspace default', summary: 'Whether newly created accounts get a private Project workspace.', keywords: ['private workspace', 'sandbox', 'workspace isolation', 'new accounts', 'shared projects'] },
      { id: 'login-security', label: 'Login security', summary: 'Failed login attempts before lockout, and how long a session lasts.', keywords: ['max login attempts', 'lockout', 'failed logins', 'session duration', 'session length', 'session timeout', 'brute force'] },
      { id: 'embeds', label: 'Hosted content embeds', summary: 'Portal-wide allowlist of origins that hosted Apps and Project shares may embed.', keywords: ['embed policy', 'allowed origins', 'iframe', 'youtube', 'frame', 'content security policy', 'csp'] },
      { id: 'two-factor', label: 'Two-factor authentication', summary: 'Your own sign-in protection: authenticator app or email code, and backup codes.', keywords: TWO_FACTOR_KEYWORDS },
    ],
  },
  agents: {
    label: 'Harnesses',
    summary: 'Default assistant harness, harness readiness and OpenClaw runtime notices.',
    keywords: ['agents', 'harness', 'openclaw', 'runtime', 'agent chat'],
    topics: [
      { id: 'openclaw-runtime', label: 'OpenClaw runtime', summary: 'Show compaction notices in OpenClaw chats; applies immediately.', keywords: ['compaction', 'compacting context', 'notices', 'context window', 'notify'] },
      { id: 'default-harness', label: 'Default assistant harness', summary: 'The harness new assistant chats use by default.', keywords: ['default harness', 'assistant', 'agent'] },
    ],
  },
  system: {
    label: 'System',
    summary: 'Telemetry, Remote Desktop, coding tool status and OpenClaw compatibility status.',
    keywords: ['telemetry', 'remote desktop', 'novnc', 'coding tools', 'compatibility'],
    topics: [
      { id: 'telemetry', label: 'Telemetry', summary: 'Limited operational reports that help improve BridgesLLM; never content or credentials.', keywords: ['usage reports', 'analytics', 'operational report', 'privacy', 'help improve'] },
      { id: 'remote-desktop', label: 'Remote Desktop configuration', summary: 'Remote Desktop URL and the allowed same-origin path prefixes.', keywords: ['remote desktop', 'novnc', 'vnc', 'desktop url', 'allowed path prefixes'] },
      { id: 'coding-tools', label: 'AI coding tools', summary: 'Read-only package status for optional host coding runtimes.', keywords: ['coding tools', 'cli', 'packages', 'host tools'] },
      { id: 'compatibility', label: 'OpenClaw compatibility status', summary: 'Read-only compatibility markers for the installed OpenClaw bundle; updates are in Admin → Maintenance.', keywords: ['hotfix', 'compatibility bridge', 'openclaw bundle', 'patches'] },
      { id: 'mailboxes', label: 'Mailbox management', summary: 'Hosted user mailboxes; requires a public domain.', keywords: ['mailboxes', 'delete mailbox', 'user mailboxes'] },
    ],
  },
  'ai-providers': {
    label: 'Model Providers',
    summary: 'Model provider accounts, native coding runtimes, Agent Zero and Ollama models.',
    keywords: ['models', 'providers', 'accounts', 'api key', 'oauth'],
    topics: [
      { id: 'provider-accounts', label: 'Provider accounts', summary: 'Connect or change model-provider accounts using the supported sign-in and API-key flows.', keywords: ['provider setup', 'sign in', 'oauth', 'api key', 'setup token', 'device code', 'aws', 'native cli'] },
      { id: 'ollama', label: 'Ollama local and Remote GPU', summary: 'Local CPU models and a remote Ollama runtime over Tailscale.', keywords: ['ollama', 'local models', 'cpu', 'remote gpu', 'tailscale', 'tailnet', 'windows', 'pull model'] },
      { id: 'agent-zero', label: 'Agent Zero', summary: 'Agent Zero setup and provider connections.', keywords: ['agent zero', 'agent0', 'setup', 'oauth', 'provider connections'] },
    ],
  },
  readiness: {
    label: 'Feature Readiness',
    summary: 'Read-only readiness of Portal features and runtimes, with the next required actions.',
    keywords: ['readiness', 'health', 'status', 'diagnostics', 'runtime', 'project chat readiness', 'next actions'],
    topics: [],
  },
  backups: {
    label: 'Backups',
    summary: 'Backup storage, manual backups, editable schedules, storage limits, reviewed cleanup and restore instructions.',
    keywords: ['backup', 'restore', 'archives', 'snapshots'],
    topics: [
      { id: 'storage-path', label: 'Backup storage path', summary: 'Where backup archives are stored on the server.', keywords: ['backup path', 'storage location', 'backup directory', 'backup folder', 'disk', 'drive'] },
      { id: 'manual-backup', label: 'Create a manual backup', summary: 'Start a standard (Projects and settings) or comprehensive backup now and follow its progress.', keywords: ['backup now', 'create backup', 'standard backup', 'comprehensive backup', 'agent context'] },
      { id: 'schedule', label: 'Automatic backup schedule', summary: 'Change the day and time of automatic backups or pause them.', keywords: ['auto backup', 'automatic backups', 'schedule', 'timer', 'systemd', 'cron', 'nightly', 'next run', 'pause backups', 'backup time'] },
      { id: 'restore', label: 'Restore a backup', summary: 'Restore instructions for a listed backup; the restore itself runs from the server terminal.', keywords: ['restore', 'recover', 'recovery', 'restore backup'] },
      { id: 'storage-limits', label: 'Backup storage limits and cleanup', summary: 'Choose how many backups to keep, enable automatic space recovery or review old backups before deleting them.', keywords: ['retention limits', 'storage limits', 'make room', 'automatic cleanup', 'clean up old backups'] },
      { id: 'retention', label: 'Retention locks, downloads and deletion', summary: 'Lock a backup against cleanup, download it or delete it.', keywords: ['retention', 'lock backup', 'keep backup', 'download backup', 'delete backup', 'cleanup'] },
    ],
  },
  profile: {
    label: 'Profile',
    summary: 'Your username, email, password and personal preferences.',
    keywords: ['my account', 'account', 'preferences', 'personal'],
    topics: [
      { id: 'information', label: 'Profile information', summary: 'Your username and email address; changing them needs your current password.', keywords: ['username', 'user name', 'email address', 'change email', 'rename account'] },
      { id: 'password', label: 'Change password', summary: 'Set a new password using your current one.', keywords: ['password', 'new password', 'update password'] },
      { id: 'sounds', label: 'Sound effects', summary: 'Turn interface sounds on or off and set their volume.', keywords: ['sound', 'audio', 'volume', 'mute', 'clicks'] },
      { id: 'two-factor', label: 'Two-factor authentication', summary: 'Authenticator app or email code, and backup codes, for your sign-in.', keywords: TWO_FACTOR_KEYWORDS, audience: 'non-elevated' },
    ],
  },
});


export function settingsTabIdsForRole(role: PortalSurfaceRole): SettingsTabId[] {
  const owner = role === 'OWNER';
  const elevated = owner || role === 'SUB_ADMIN';
  return SETTINGS_TAB_IDS.filter((tab) => {
    const access = SETTINGS_TAB_ACCESS[tab];
    return access === 'all' || (access === 'elevated' && elevated) || (access === 'owner' && owner);
  });
}

export function resolveSettingsTab(role: PortalSurfaceRole, requested: string | null | undefined): SettingsTabId {
  const allowed = settingsTabIdsForRole(role);
  if (requested && allowed.includes(requested as SettingsTabId)) return requested as SettingsTabId;
  return role === 'OWNER' ? 'general' : role === 'SUB_ADMIN' ? 'readiness' : 'profile';
}

export function adminTabIdsForRole(role: PortalSurfaceRole): AdminTabId[] {
  return role === 'OWNER' ? ['users', 'maintenance', 'pending'] : ['users', 'maintenance'];
}

export function resolveAdminTab(role: PortalSurfaceRole, requested: string | null | undefined): AdminTabId {
  const allowed = adminTabIdsForRole(role);
  return requested && allowed.includes(requested as AdminTabId) ? requested as AdminTabId : 'users';
}

export function maintenanceActionNeedsOwner(action: { requiresOwner: boolean; changesSystem: boolean }): boolean {
  return action.requiresOwner || action.changesSystem;
}

export function isActiveMaintenanceJob(status: string | null | undefined): boolean {
  return status === 'running' || status === 'waiting';
}

export function shouldPollMaintenance(input: {
  pageVisible: boolean;
  ready?: boolean;
  refreshing?: boolean;
  retryAfterMs?: number | null;
  hasActiveJob: boolean;
}): boolean {
  if (!input.pageVisible) return false;
  return input.ready === false
    || input.refreshing === true
    || (input.retryAfterMs || 0) > 0
    || input.hasActiveJob;
}

export function maintenancePollDelayMs(input: {
  retryAfterMs?: number | null;
  hasActiveJob: boolean;
}): number {
  if ((input.retryAfterMs || 0) > 0) return Math.max(1_000, Math.min(60_000, input.retryAfterMs || 0));
  return input.hasActiveJob ? 2_500 : 3_000;
}

export function maintenanceRetryDelayLabel(retryAfterMs: number | null | undefined): string | null {
  if (!Number.isFinite(retryAfterMs) || (retryAfterMs || 0) <= 0) return null;
  const seconds = Math.max(1, Math.ceil((retryAfterMs || 0) / 1_000));
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

export function nextTabIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return null;
  const delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  return (current + delta + count) % count;
}

export const ADMIN_TABS: Readonly<Record<AdminTabId, SurfaceCatalogEntry>> = Object.freeze({
  users: {
    label: 'Users',
    summary: 'Portal accounts, roles and status. Changes are Owner-only.',
    keywords: ['accounts', 'people', 'roles', 'permissions', 'sub admin', 'viewer', 'promote', 'demote', 'disable account', 'workspace sharing'],
    topics: [
      { id: 'transfer-ownership', label: 'Transfer Portal ownership', summary: 'Make another account the Portal owner.', keywords: ['transfer ownership', 'new owner', 'change owner'], audience: 'owner' },
      { id: 'retire-user', label: 'Retire and delete a user', summary: 'Retire an account and delete its user identity.', keywords: ['delete user', 'remove user', 'retire user', 'offboard'], audience: 'owner' },
    ],
  },
  maintenance: {
    label: 'Maintenance',
    summary: 'Server health, open items, compatibility guardrails, guarded maintenance actions and recent jobs.',
    keywords: ['admin', 'server health', 'updates', 'update compatible ai tools', 'drift', 'security', 'jobs', 'guardrails'],
    topics: [
      { id: 'legacy-agents', label: 'Preserved OpenClaw 3.x agents', summary: 'Inspect retired Project agent registrations and detach exact stale entries.', keywords: ['legacy agents', 'openclaw 3', 'portal agents', 'detach registration', 'stale agents'], audience: 'owner' },
    ],
  },
  pending: {
    label: 'Pending Approvals',
    summary: 'Approve or deny registration requests.',
    keywords: ['approvals', 'registration requests', 'approve user', 'deny', 'sign up requests', 'waiting users'],
    topics: [],
  },
});
