/**
 * System Settings Schema
 *
 * TypeScript types, default values, and category definitions for every
 * admin-configurable setting stored in the SystemSettings table.
 *
 * Phase 3 will build the admin UI that reads/writes these via API;
 * this file is the source of truth for shape & defaults.
 */

import type { AgentProviderName } from '../agents/AgentProvider.interface';

// ── Category: Appearance ────────────────────────────────────────────────────

export interface AppearanceSettings {
  /** Color theme — "light" | "dark" | "system" */
  theme: 'light' | 'dark' | 'system';
  /** URL or data-URI for the portal logo shown in the sidebar */
  logoUrl: string;
  /** Portal display name (shown in browser tab + header) */
  portalName: string;
  /** Accent color hex, e.g. "#6366f1" */
  accentColor: string;
}

export const APPEARANCE_DEFAULTS: AppearanceSettings = {
  theme: 'dark',
  logoUrl: '',
  portalName: 'Bridges Portal',
  accentColor: '#6366f1',
};

// ── Category: Notifications ─────────────────────────────────────────────────

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** Stored encrypted in DB; plaintext only in memory. */
  password: string;
  fromAddress: string;
  fromName: string;
}

export type AlertEvent =
  | 'user_registered'
  | 'login_failed_threshold'
  | 'system_error'
  | 'backup_completed'
  | 'backup_failed';

export interface NotificationSettings {
  smtp: SmtpConfig;
  /** Which events trigger an email to admins */
  enabledAlerts: AlertEvent[];
}

export const NOTIFICATION_DEFAULTS: NotificationSettings = {
  smtp: {
    host: '',
    port: 587,
    secure: false,
    user: '',
    password: '',
    fromAddress: 'noreply@localhost',
    fromName: 'Bridges Portal',
  },
  enabledAlerts: ['login_failed_threshold', 'system_error', 'backup_failed'],
};

// ── Category: Security ──────────────────────────────────────────────────────

export type RegistrationMode = 'open' | 'approval' | 'closed';

export interface SecuritySettings {
  /** How new users can join */
  registrationMode: RegistrationMode;
  /** Enable honeypot field on registration form */
  honeypotEnabled: boolean;
  /** Max failed logins before IP is temporarily blocked */
  maxFailedLogins: number;
  /** Block duration in minutes after maxFailedLogins */
  blockDurationMinutes: number;
  /** Require email verification before account activation */
  emailVerificationRequired: boolean;
  /** Block IP when registration attempt is made while registration is closed */
  blockClosedRegistration: boolean;
}

export const SECURITY_DEFAULTS: SecuritySettings = {
  registrationMode: 'approval',
  honeypotEnabled: true,
  maxFailedLogins: 5,
  blockDurationMinutes: 30,
  emailVerificationRequired: false,
  blockClosedRegistration: true,
};

// ── Category: Agents ────────────────────────────────────────────────────────

export interface AgentSettings {
  /** Which providers are available for users to select */
  enabledProviders: AgentProviderName[];
  /** Default provider for new sessions */
  defaultProvider: AgentProviderName;
  /** Max concurrent sessions per user (0 = unlimited) */
  maxSessionsPerUser: number;
}

export const AGENT_DEFAULTS: AgentSettings = {
  enabledProviders: ['OPENCLAW'],
  defaultProvider: 'OPENCLAW',
  maxSessionsPerUser: 5,
};


// ── Category: Remote Desktop ───────────────────────────────────────────────

export interface RemoteDesktopSettings {
  /** Full URL used by Desktop page iframe target */
  url: string;
  /** Comma-separated list of same-origin path prefixes allowed for iframe URL */
  allowedPathPrefixes: string;
}

export const REMOTE_DESKTOP_DEFAULTS: RemoteDesktopSettings = {
  url: '/novnc/vnc_portal.html?reconnect=1&resize=remote&path=novnc/websockify',
  allowedPathPrefixes: '/novnc,/vnc',
};

// ── Aggregate ───────────────────────────────────────────────────────────────

export interface SystemSettings {
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
  security: SecuritySettings;
  agents: AgentSettings;
  remoteDesktop: RemoteDesktopSettings;
}

export const SYSTEM_SETTINGS_DEFAULTS: SystemSettings = {
  appearance: APPEARANCE_DEFAULTS,
  notifications: NOTIFICATION_DEFAULTS,
  security: SECURITY_DEFAULTS,
  agents: AGENT_DEFAULTS,
  remoteDesktop: REMOTE_DESKTOP_DEFAULTS,
};

/**
 * All top-level category keys — used for DB key prefixes.
 * e.g. the DB row key "appearance.theme" stores the theme value.
 */
export const SETTINGS_CATEGORIES = [
  'appearance',
  'notifications',
  'security',
  'agents',
  'remoteDesktop',
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];
