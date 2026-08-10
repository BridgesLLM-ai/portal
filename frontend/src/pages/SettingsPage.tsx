import { useState, useEffect, useCallback, useContext, useMemo, useRef, lazy, Suspense } from 'react';
import { copyTextToClipboard } from '../utils/clipboardCopy';
import { Link, UNSAFE_NavigationContext, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Settings, Database, User, ShieldCheck, Palette, Mail, Bot, Server, Cpu,
  Save, Loader2, Eye, EyeOff, Sun, Moon, Monitor, Check, X, Send,
  Wrench, CheckCircle2, AlertCircle,
  Shield, Copy, KeyRound, RefreshCw
} from 'lucide-react';
import { useAuthStore } from '../contexts/AuthContext';
import { isElevated, isOwnerRole } from '../utils/authz';
import { useTheme } from '../contexts/ThemeContext';
import { settingsAPI } from '../api/settings';
import client from '../api/client';
import { gatewayAPI, type CompatibilityHotfixStatus } from '../api/endpoints';
import { agentRuntimeAPI, AgentRuntimeStatus } from '../api/agentRuntime';
import { authAPI, TwoFactorSetupResponse, TwoFactorStatusResponse } from '../api/auth';
import type { OllamaTailnetStatus } from '../api/ollamaTailnet';
import sounds from '../utils/sounds';
import { DEFAULT_REGISTRATION_MODE } from '../utils/securityDefaults';
import ViewportOverlay from '../components/ViewportOverlay';
import TypedConfirmationDialog from '../components/TypedConfirmationDialog';
import FeatureReadinessPanel from '../components/settings/FeatureReadinessPanel';
import EmbedSecurityPolicyManager from '../components/settings/EmbedSecurityPolicyManager';
import {
  refreshPublicSettings,
  usePublicSettings,
  type PortalFeatureAvailability,
} from '../hooks/usePublicSettings';
import {
  SettingsMutationProvider,
  type SettingsMutationClaim,
  type SettingsMutationRelease,
} from '../components/settings/SettingsMutationContext';
import {
  SETTINGS_TAB_ACCESS,
  nextTabIndex,
  resolveSettingsTab,
  settingsTabIdsForRole,
  type SettingsTabId,
} from './settingsAdminContract';
import { resolvePortalLogoUrl } from '../utils/portalBranding';

const LazyBackupsTab = lazy(() => import('../components/settings/BackupsTab'));
const LazyAiProviderSetup = lazy(() => import('../components/ai-setup/AiProviderSetup'));
const LazyAgentZeroSetupPanel = lazy(() => import('../components/settings/AgentZeroSetupPanel'));
const LazyOllamaTailnetSetup = lazy(() => import('../components/settings/OllamaTailnetSetup'));
const LazyImagePickerCropper = lazy(() => import('../components/ImagePickerCropper'));
const LazyQRCodeSVG = lazy(async () => {
  const mod = await import('qrcode.react');
  return { default: mod.QRCodeSVG };
});

// ── Toast system (local to settings) ──────────────────────────────────

interface ToastItem {
  id: string;
  type: 'success' | 'error';
  message: string;
}

function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Set<number>>(new Set());
  const add = useCallback((type: 'success' | 'error', message: string) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setToasts(prev => [...prev, { id, type, message }]);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
    timersRef.current.add(timer);
  }, []);
  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current.clear();
  }, []);
  return { toasts, add };
}

function SettingsToasts({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) return null;

  return (
    <ViewportOverlay anchor="bottom-right" zIndex={1200} className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto overscroll-contain pr-1">
      {toasts.map(t => (
        <div key={t.id} role={t.type === 'error' ? 'alert' : 'status'} aria-live={t.type === 'error' ? 'assertive' : 'polite'} className={`flex items-center gap-2 px-4 py-3 rounded-lg border text-sm font-medium animate-slide-in ${
          t.type === 'success'
            ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
            : 'bg-red-500/20 border-red-500/30 text-red-400'
        }`}>
          {t.type === 'success' ? <Check size={16} /> : <X size={16} />}
          {t.message}
        </div>
      ))}
    </ViewportOverlay>
  );
}

// ── Types ──────────────────────────────────────────────────────────────

type TabId = SettingsTabId;

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof Settings;
  access: 'all' | 'elevated' | 'owner';
}

const allTabs: TabDef[] = [
  { id: 'general', label: 'General', icon: Palette, access: SETTINGS_TAB_ACCESS.general },
  { id: 'email', label: 'Email', icon: Mail, access: SETTINGS_TAB_ACCESS.email },
  { id: 'security', label: 'Security', icon: ShieldCheck, access: SETTINGS_TAB_ACCESS.security },
  { id: 'agents', label: 'Agents', icon: Bot, access: SETTINGS_TAB_ACCESS.agents },
  { id: 'system', label: 'System', icon: Server, access: SETTINGS_TAB_ACCESS.system },
  { id: 'ai-providers', label: 'AI Providers', icon: Cpu, access: SETTINGS_TAB_ACCESS['ai-providers'] },
  { id: 'readiness', label: 'Feature Readiness', icon: Wrench, access: SETTINGS_TAB_ACCESS.readiness },
  { id: 'backups', label: 'Backups', icon: Database, access: SETTINGS_TAB_ACCESS.backups },
  { id: 'profile', label: 'Profile', icon: User, access: SETTINGS_TAB_ACCESS.profile },
];

const ACCENT_PRESETS = [
  { name: 'Indigo', color: '#6366f1' },
  { name: 'Emerald', color: '#10b981' },
  { name: 'Violet', color: '#8b5cf6' },
  { name: 'Rose', color: '#f43f5e' },
  { name: 'Amber', color: '#f59e0b' },
  { name: 'Cyan', color: '#06b6d4' },
];

// ── Shared components ─────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5 mb-4">
      <h3 className="text-sm font-semibold text-theme-text mb-4">{title}</h3>
      {children}
    </div>
  );
}

type SettingsMutationProps = {
  claimMutation: SettingsMutationClaim;
  releaseMutation: SettingsMutationRelease;
  mutationOwner?: string | null;
};

type SettingsActionResult = false | void | Promise<void>;

const SETTINGS_READBACK_TIMEOUT_MS = 15_000;
const SETTINGS_READBACK_INTERVAL_MS = 400;
const SETTINGS_READBACK_REQUEST_TIMEOUT_MS = 5_000;

class SettingsReadbackError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SettingsReadbackError';
    this.cause = cause;
  }
}

async function waitForSettingsConvergence<T>({
  label,
  read,
  accepts,
  timeoutMs = SETTINGS_READBACK_TIMEOUT_MS,
}: {
  label: string;
  read: (signal: AbortSignal) => Promise<T>;
  accepts: (value: T) => boolean;
  timeoutMs?: number;
}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new SettingsReadbackError(
        `${label} did not converge before the verification deadline.`,
        lastError,
      );
    }

    const controller = new AbortController();
    const requestTimeoutMs = Math.min(SETTINGS_READBACK_REQUEST_TIMEOUT_MS, remaining);
    let rejectRequestTimeout: ((reason?: unknown) => void) | null = null;
    const requestTimeout = new Promise<never>((_resolve, reject) => {
      rejectRequestTimeout = reject;
    });
    const requestTimer = window.setTimeout(() => {
      controller.abort();
      rejectRequestTimeout?.(new SettingsReadbackError(`${label} status request timed out.`));
    }, requestTimeoutMs);
    let value: T;
    try {
      value = await Promise.race([read(controller.signal), requestTimeout]);
    } catch (error) {
      lastError = error;
      if (Date.now() + SETTINGS_READBACK_INTERVAL_MS >= deadline) {
        throw new SettingsReadbackError(`${label} could not be verified.`, error);
      }
      window.clearTimeout(requestTimer);
      await new Promise((resolve) => window.setTimeout(resolve, SETTINGS_READBACK_INTERVAL_MS));
      continue;
    } finally {
      window.clearTimeout(requestTimer);
    }

    if (accepts(value)) return value;
    if (Date.now() + SETTINGS_READBACK_INTERVAL_MS >= deadline) {
      throw new SettingsReadbackError(`${label} did not converge before the verification deadline.`);
    }
    await new Promise((resolve) => window.setTimeout(resolve, SETTINGS_READBACK_INTERVAL_MS));
  }
}

function SaveButton({ onClick, isDirty, saving = false, disabled = false }: {
  onClick: () => SettingsActionResult;
  isDirty: boolean;
  saving?: boolean;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const busy = saving || pending;

  const handleClick = () => {
    if (!isDirty || disabled || busy || pendingRef.current) return;
    pendingRef.current = true;
    let result: SettingsActionResult;
    try {
      result = onClick();
    } catch (error) {
      pendingRef.current = false;
      throw error;
    }
    if (result === false) {
      pendingRef.current = false;
      return;
    }
    setPending(true);
    void Promise.resolve(result).finally(() => {
      pendingRef.current = false;
      setPending(false);
    });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!isDirty || disabled || busy}
      aria-busy={busy}
      className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all border ${
        isDirty
          ? 'accent-btn'
          : 'bg-white/[0.04] text-slate-500 border-white/[0.06] cursor-not-allowed'
      }`}
      style={isDirty ? {
        background: 'var(--accent-bg)',
        color: 'var(--accent)',
        borderColor: 'var(--accent-border)',
      } : undefined}
    >
      {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
      {busy ? 'Saving…' : 'Save Changes'}
    </button>
  );
}

function FieldLabel({ label, description }: { label: string; description?: string }) {
  return (
    <div className="mb-1.5">
      <label className="text-sm font-medium text-slate-200">{label}</label>
      {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
    </div>
  );
}

function getSettingDraft(settings: Record<string, string>, drafts: Record<string, string>, key: string, fallback = ''): string {
  if (Object.prototype.hasOwnProperty.call(drafts, key)) {
    return drafts[key] ?? '';
  }
  return settings[key] ?? fallback;
}

function TextInput({ value, onChange, placeholder, type = 'text', ariaLabel, disabled = false }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string; ariaLabel: string; disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none accent-focus transition-all disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        '--accent-border': 'var(--accent-border)',
        '--accent-ring': 'var(--accent-ring)',
      } as React.CSSProperties}
    />
  );
}

function Toggle({ checked, onChange, label, disabled = false, busy = false, describedBy }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className="flex items-center gap-3 cursor-pointer group text-left disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div
        aria-hidden="true"
        className={`relative w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer ${
          checked ? 'accent-toggle' : 'bg-slate-600'
        }`}
      >
        <div
          className={`absolute top-1 w-4 h-4 rounded-full shadow transition-all duration-200 ${
            checked ? 'left-6 accent-toggle-dot' : 'left-1 bg-white'
          }`}
        />
      </div>
      <span className="text-sm text-slate-300 group-hover:text-white transition-colors">{label}</span>
    </button>
  );
}

// ── General Tab ───────────────────────────────────────────────────────

function GeneralTab({ settings, draftSettings, updateSetting, setSettingValue, setDraftSettingValue, onSave, isDirty, addToast, claimMutation, releaseMutation }: {
  settings: Record<string, string>;
  draftSettings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  setSettingValue: (k: string, v: string) => void;
  setDraftSettingValue: (k: string, v: string) => void;
  onSave: () => SettingsActionResult;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
} & SettingsMutationProps) {
  const [logoEditorOpen, setLogoEditorOpen] = useState(false);
  const [searchVisibilitySaving, setSearchVisibilitySaving] = useState(false);
  const [agentEditorOpen, setAgentEditorOpen] = useState<string | null>(null);
  const [domainStatus, setDomainStatus] = useState<{ currentDomain: string; publicIp: string; httpsActive: boolean } | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainValue, setDomainValue] = useState('');
  const [domainDnsLoading, setDomainDnsLoading] = useState(false);
  const [domainConfigureLoading, setDomainConfigureLoading] = useState(false);
  const [domainStatusError, setDomainStatusError] = useState<string | null>(null);
  const [domainCommittedTarget, setDomainCommittedTarget] = useState<string | null>(null);
  const [domainDnsResult, setDomainDnsResult] = useState<{ domain: string; resolves: boolean; pointsToUs: boolean; resolvedIps: string[]; expectedIp: string; message: string } | null>(null);
  const domainDnsRef = useRef(false);
  const committedDomainRef = useRef<{ domain: string; successMessage: string } | null>(null);
  const generalMutationRef = useRef<
    | { owner: 'settings:general:configure-domain'; domain: string }
    | { owner: 'settings:general:search-visibility'; next: 'visible' | 'hidden'; previous: 'visible' | 'hidden' }
    | null
  >(null);
  const [generalMutationOwner, setGeneralMutationOwner] = useState<string | null>(null);
  const [domainConfigureError, setDomainConfigureError] = useState<string | null>(null);
  const [searchVisibilityError, setSearchVisibilityError] = useState<string | null>(null);
  const isLocalPortalOrigin = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const {
    theme,
    setTheme,
    accentColor,
    setAccentColor,
    effectsMode,
    setEffectsMode,
    resolvedEffects,
  } = useTheme();
  const currentTheme = settings['appearance.theme'] || theme;
  const currentAccent = settings['appearance.accentColor'] || accentColor;
  const portalLogoUrl = resolvePortalLogoUrl(settings['appearance.logoUrl']);

  const handleLogoSaved = (url: string | null) => {
    setSettingValue('appearance.logoUrl', url ? url.split('?')[0] : '');
    void refreshPublicSettings().catch(() => null);
  };

  const handleThemeChange = (t: string) => {
    updateSetting('appearance.theme', t);
    setTheme(t as 'dark' | 'light' | 'system');
  };

  const handleAccentChange = (c: string) => {
    updateSetting('appearance.accentColor', c);
    setAccentColor(c);
  };

  const readDomainStatus = useCallback(async (signal?: AbortSignal) => {
    const res = await client.get('/admin/domain-status', { signal });
    return res.data as { currentDomain: string; publicIp: string; httpsActive: boolean };
  }, []);

  const applyDomainStatus = useCallback((next: { currentDomain: string; publicIp: string; httpsActive: boolean }) => {
    setDomainStatus(next);
    setDomainValue(next.currentDomain || '');
    setDomainStatusError(null);
    const committed = committedDomainRef.current;
    if (committed && next.currentDomain === committed.domain && next.httpsActive) {
      committedDomainRef.current = null;
      setDomainCommittedTarget(null);
    }
  }, []);

  const loadDomainStatus = useCallback(async () => {
    setDomainLoading(true);
    try {
      applyDomainStatus(await readDomainStatus());
    } catch (error: any) {
      setDomainStatusError(error?.response?.data?.error || error?.message || 'Domain status could not be loaded.');
    } finally {
      setDomainLoading(false);
    }
  }, [applyDomainStatus, readDomainStatus]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        void loadDomainStatus();
      }
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadDomainStatus]);

  const handleCheckDomainDns = async () => {
    const domain = domainValue.trim();
    if (!domain) {
      addToast('error', 'Enter a domain first');
      return;
    }
    if (domainDnsRef.current || generalMutationRef.current) return;

    domainDnsRef.current = true;
    setDomainDnsLoading(true);
    try {
      const res = await client.post('/admin/check-domain-dns', { domain });
      setDomainDnsResult(res.data);
    } catch (err: any) {
      addToast('error', err?.response?.data?.error || 'DNS check failed');
      setDomainDnsResult(null);
    } finally {
      domainDnsRef.current = false;
      setDomainDnsLoading(false);
    }
  };

  const handleConfigureDomain = async () => {
    const existingCommit = committedDomainRef.current;
    const domain = existingCommit?.domain || domainValue.trim();
    if (!domain) {
      addToast('error', 'Enter a domain first');
      return;
    }
    const snapshot = Object.freeze({ owner: 'settings:general:configure-domain' as const, domain });
    if (generalMutationRef.current || domainDnsRef.current || !claimMutation(snapshot.owner)) return;
    generalMutationRef.current = snapshot;

    setGeneralMutationOwner(snapshot.owner);
    setDomainConfigureError(null);
    setDomainConfigureLoading(true);
    let configurationAccepted = Boolean(existingCommit);
    try {
      let successMessage = existingCommit?.successMessage || 'Domain configured';
      if (!existingCommit) {
        const res = await client.post('/admin/configure-domain', { domain: snapshot.domain });
        configurationAccepted = true;
        successMessage = res.data?.message || successMessage;
        committedDomainRef.current = { domain: snapshot.domain, successMessage };
        setDomainCommittedTarget(snapshot.domain);
      }
      const verifiedStatus = await waitForSettingsConvergence({
        label: 'Domain and HTTPS status',
        read: (signal) => readDomainStatus(signal),
        accepts: (status) => status.currentDomain === snapshot.domain && status.httpsActive === true,
      });
      applyDomainStatus(verifiedStatus);
      committedDomainRef.current = null;
      setDomainCommittedTarget(null);
      setDomainDnsResult(null);
      addToast('success', successMessage);
    } catch (err: any) {
      const message = configurationAccepted
        ? 'Domain configuration finished, but Portal could not verify the new HTTPS status. Retry verification; the configuration request will not be repeated.'
        : err?.response?.data?.error || 'Domain configuration failed';
      if (configurationAccepted) setDomainStatusError(message);
      setDomainConfigureError(message);
      addToast('error', message);
    } finally {
      if (generalMutationRef.current === snapshot) generalMutationRef.current = null;
      setGeneralMutationOwner(null);
      setDomainConfigureLoading(false);
      releaseMutation(snapshot.owner);
    }
  };

  const handleSearchVisibilityToggle = async (allowed: boolean) => {
    const nextVisibility = allowed ? 'visible' : 'hidden';
    const previousVisibility = settings['system.searchEngineVisibility'] === 'visible' ? 'visible' : 'hidden';
    const snapshot = Object.freeze({
      owner: 'settings:general:search-visibility' as const,
      next: nextVisibility,
      previous: previousVisibility,
    });
    if (generalMutationRef.current || domainDnsRef.current || !claimMutation(snapshot.owner)) return;
    generalMutationRef.current = snapshot;
    setGeneralMutationOwner(snapshot.owner);
    setSearchVisibilityError(null);
    setSettingValue('system.searchEngineVisibility', nextVisibility);
    setSearchVisibilitySaving(true);
    try {
      await settingsAPI.updateSearchVisibility(snapshot.next);
      addToast('success', allowed ? 'Search indexing enabled' : 'Search indexing disabled');
    } catch (err: any) {
      setSettingValue('system.searchEngineVisibility', snapshot.previous);
      const message = err?.response?.data?.error || 'Failed to update search visibility';
      setSearchVisibilityError(message);
      addToast('error', message);
    } finally {
      if (generalMutationRef.current === snapshot) generalMutationRef.current = null;
      setGeneralMutationOwner(null);
      setSearchVisibilitySaving(false);
      releaseMutation(snapshot.owner);
    }
  };

  const handleSave = (): SettingsActionResult => {
    if (!settings['appearance.portalName']?.trim()) {
      addToast('error', 'Portal name cannot be empty');
      return false;
    }

    if (!settings['appearance.assistantName']?.trim()) {
      addToast('error', 'Assistant display name cannot be empty');
      return false;
    }

    return onSave();
  };

  return (
    <div>
      <SectionCard title="Portal Identity">
        <div className="space-y-4">
          <div>
            <FieldLabel label="Portal Name" description="Displayed in the header and browser tab" />
            <TextInput
              value={getSettingDraft(settings, draftSettings, 'appearance.portalName', 'Bridges Portal')}
              onChange={v => {
                setDraftSettingValue('appearance.portalName', v);
                updateSetting('appearance.portalName', v);
              }}
              placeholder="Bridges Portal"
              ariaLabel="Portal name"
            />
          </div>
          <div>
            <FieldLabel label="Portal Logo" description="Upload and crop the logo shown across the portal" />
            <div className="flex items-center gap-3">
              <img src={portalLogoUrl} alt="Portal logo" className="h-10 w-10 rounded-lg border border-white/10 object-contain" />
              <button type="button" onClick={() => setLogoEditorOpen(true)} className="min-h-[44px] px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-slate-200 hover:bg-white/[0.08]">Upload and Crop</button>
            </div>
            <div className="mt-2">
              <TextInput
                value={settings['appearance.logoUrl'] || ''}
                onChange={v => updateSetting('appearance.logoUrl', v)}
                placeholder="https://example.com/logo.png"
                ariaLabel="Portal logo URL"
              />
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <FieldLabel
                  label="Search engines"
                  description="Control whether search engines are allowed to index your portal. Off adds a noindex directive to the portal HTML."
                />
                <p className="text-xs text-slate-500">Default is off for privacy.</p>
              </div>
              <div className="flex items-center gap-3">
                {searchVisibilitySaving && <Loader2 size={16} className="animate-spin text-slate-400" />}
                <Toggle
                  checked={settings['system.searchEngineVisibility'] === 'visible'}
                  onChange={handleSearchVisibilityToggle}
                  label="Allow search engines to index this portal"
                  disabled={Boolean(generalMutationOwner)}
                  busy={generalMutationOwner === 'settings:general:search-visibility'}
                />
              </div>
            </div>
            {searchVisibilityError && (
              <p role="alert" className="mt-3 text-xs text-red-300">{searchVisibilityError}</p>
            )}
          </div>

          <div>
            <FieldLabel label="Assistant Display Name" description="Shown in chat and sidebar identity areas" />
            <TextInput
              value={getSettingDraft(settings, draftSettings, 'appearance.assistantName', 'Assistant')}
              onChange={v => {
                setDraftSettingValue('appearance.assistantName', v);
                updateSetting('appearance.assistantName', v);
              }}
              placeholder="Assistant"
              ariaLabel="Assistant display name"
            />
          </div>

          <div>
            <FieldLabel label="Agent Chat Avatars" description="Per-agent avatars shown in chat list and message bubbles" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { key: 'OPENCLAW', label: 'OpenClaw' },
                { key: 'CLAUDE_CODE', label: 'Claude' },
                { key: 'CODEX', label: 'Codex' },
                { key: 'GROK', label: 'Grok Build' },
                { key: 'AGENT_ZERO', label: 'Agent Zero' },
                { key: 'GEMINI', label: 'Antigravity' },
                { key: 'OLLAMA', label: 'Ollama' },
              ].map((a) => (
                <button type="button" key={a.key} onClick={() => setAgentEditorOpen(a.key)} className="min-h-[44px] p-2 rounded-lg bg-white/[0.03] border border-white/[0.08] hover:bg-white/[0.06] text-left" aria-label={`Edit ${a.label} avatar`}>
                  <div className="flex items-center gap-2">
                    {settings[`appearance.agentAvatar.${a.key}`] ? <img src={settings[`appearance.agentAvatar.${a.key}`]} alt={a.label} className="w-8 h-8 rounded-full object-cover" /> : <div className="w-8 h-8 rounded-full bg-white/10" />}
                    <span className="text-sm text-slate-200">{a.label}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <Suspense fallback={null}>
            <LazyImagePickerCropper
              isOpen={logoEditorOpen}
              onClose={() => setLogoEditorOpen(false)}
              onSaved={handleLogoSaved}
              currentImageUrl={settings['appearance.logoUrl'] || null}
              uploadEndpoint="/admin/appearance/logo"
              deleteEndpoint="/admin/appearance/logo"
              fieldName="image"
              title="Edit Portal Logo"
              shape="square"
              responseKey="logoUrl"
            />
          </Suspense>

          {agentEditorOpen && (
            <Suspense fallback={null}>
              <LazyImagePickerCropper
                isOpen={Boolean(agentEditorOpen)}
                onClose={() => setAgentEditorOpen(null)}
                onSaved={(url) => {
                  if (!agentEditorOpen) return;
                  setSettingValue(`appearance.agentAvatar.${agentEditorOpen}`, url ? url.split('?')[0] : '');
                }}
                currentImageUrl={settings[`appearance.agentAvatar.${agentEditorOpen}`] || null}
                uploadEndpoint={`/admin/appearance/agent-avatar/${agentEditorOpen}`}
                deleteEndpoint={`/admin/appearance/agent-avatar/${agentEditorOpen}`}
                fieldName="image"
                title={`Edit ${agentEditorOpen.replace('_CODE', '')} Avatar`}
                shape="circle"
                responseKey="avatarUrl"
              />
            </Suspense>
          )}

        </div>
      </SectionCard>

      <SectionCard title="Theme">
        <div className="space-y-4">
          <div>
            <FieldLabel label="Color Mode" />
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Portal color mode">
              {[
                { value: 'dark', icon: Moon, label: 'Dark' },
                { value: 'light', icon: Sun, label: 'Light' },
                { value: 'system', icon: Monitor, label: 'System' },
              ].map(({ value, icon: Icon, label }) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => handleThemeChange(value)}
                  role="radio"
                  aria-checked={currentTheme === value}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all border ${
                    currentTheme === value
                      ? ''
                      : 'text-slate-400 hover:text-white bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
                  }`}
                  style={currentTheme === value ? {
                    background: 'var(--accent-bg)',
                    color: 'var(--accent)',
                    borderColor: 'var(--accent-border)',
                  } : undefined}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel label="Accent Color" />
            <div className="flex items-center gap-3 flex-wrap">
              {ACCENT_PRESETS.map(({ name, color }) => (
                <button
                  type="button"
                  key={color}
                  onClick={() => handleAccentChange(color)}
                  title={name}
                  aria-label={`${name} accent color`}
                  aria-pressed={currentAccent === color}
                  className={`w-8 h-8 rounded-lg border-2 transition-all ${
                    currentAccent === color
                      ? 'border-white scale-110 shadow-lg'
                      : 'border-transparent hover:border-white/30 hover:scale-105'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
              <div className="flex items-center gap-2 ml-2">
                <input
                  type="text"
                  value={currentAccent}
                  onChange={e => {
                    const v = e.target.value;
                    if (/^#[0-9a-fA-F]{0,6}$/.test(v) || v === '' || v === '#') handleAccentChange(v);
                  }}
                  className="w-24 px-2 py-1.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-xs text-slate-300 font-mono focus:outline-none focus:border-emerald-500/30"
                  placeholder="#6366f1"
                  aria-label="Custom accent color in hexadecimal"
                />
                <div
                  className="w-8 h-8 rounded-lg border border-white/10"
                  style={{ backgroundColor: currentAccent }}
                />
              </div>
            </div>
          </div>

          <div>
            <FieldLabel
              label="Visual Effects"
              description="This preference is stored on this device. Reduced mode removes animated blur and glass effects that can overwhelm older GPUs."
            />
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Portal visual effects">
              {([
                { value: 'auto', label: 'Auto' },
                { value: 'full', label: 'Full' },
                { value: 'reduced', label: 'Reduced' },
              ] as const).map(({ value, label }) => (
                <button
                  type="button"
                  key={value}
                  role="radio"
                  aria-checked={effectsMode === value}
                  onClick={() => setEffectsMode(value)}
                  className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-all border ${
                    effectsMode === value
                      ? ''
                      : 'text-slate-400 hover:text-white bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
                  }`}
                  style={effectsMode === value ? {
                    background: 'var(--accent-bg)',
                    color: 'var(--accent)',
                    borderColor: 'var(--accent-border)',
                  } : undefined}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-theme-text-muted" role="status">
              Active on this device: {resolvedEffects === 'reduced' ? 'Reduced effects' : 'Full effects'}
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Domain & HTTPS">
        <div className="space-y-4">
          {isLocalPortalOrigin && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
              <p className="font-medium text-amber-200">Local Windows / WSL beta</p>
              <p className="mt-2">This portal is running on localhost right now. Public hosting, custom-domain HTTPS, and internet-facing share links are VPS features for now.</p>
            </div>
          )}
          {domainLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" /> Loading domain status...
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Current domain</p>
                <p className="mt-1 text-sm font-medium text-white">{domainStatus ? domainStatus.currentDomain || 'Not configured — using IP address' : 'Status unavailable'}</p>
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Public IP</p>
                <p className="mt-1 text-sm font-medium text-white">{domainStatus?.publicIp || 'Unavailable'}</p>
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">HTTPS status</p>
                <p className={`mt-1 text-sm font-medium ${domainStatus?.httpsActive ? 'text-emerald-400' : 'text-amber-300'}`}>{domainStatus ? domainStatus.httpsActive ? 'Active' : 'Not configured' : 'Status unavailable'}</p>
              </div>
            </div>
          )}

          <div>
            <FieldLabel label="Custom Domain" description="Point your domain's A record to this server, then verify DNS before enabling HTTPS." />
            <TextInput value={domainValue} onChange={(value) => { if (!generalMutationRef.current && !domainDnsRef.current && !committedDomainRef.current) setDomainValue(value); }} placeholder="portal.example.com" ariaLabel="Custom domain" disabled={domainDnsLoading || Boolean(generalMutationOwner) || Boolean(domainCommittedTarget)} />
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={handleCheckDomainDns} disabled={domainDnsLoading || Boolean(generalMutationOwner)} aria-busy={domainDnsLoading} className="min-h-[44px] px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-slate-200 hover:bg-white/[0.08] disabled:opacity-50">
              {domainDnsLoading ? <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Checking DNS...</span> : 'Check DNS'}
            </button>
            <button type="button" onClick={handleConfigureDomain} disabled={domainConfigureLoading || domainDnsLoading || (!domainStatus && !domainCommittedTarget) || Boolean(domainStatusError && !domainCommittedTarget) || Boolean(generalMutationOwner && generalMutationOwner !== 'settings:general:configure-domain')} aria-busy={domainConfigureLoading} className="min-h-[44px] px-3 py-2 rounded-lg bg-emerald-500 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
              {domainConfigureLoading
                ? <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> {domainCommittedTarget ? 'Verifying domain status...' : 'Configuring...'}</span>
                : domainCommittedTarget ? 'Verify domain status' : 'Configure domain'}
            </button>
            <button type="button" onClick={loadDomainStatus} disabled={domainLoading || domainDnsLoading || Boolean(generalMutationOwner)} className="min-h-[44px] px-3 py-2 rounded-lg border border-white/[0.08] text-sm text-slate-400 hover:text-white hover:bg-white/[0.04] disabled:opacity-50">
              <span className="inline-flex items-center gap-2"><RefreshCw size={14} className={domainLoading ? 'animate-spin' : ''} /> Refresh</span>
            </button>
          </div>

          {domainConfigureError && (
            <p role="alert" className="text-sm text-red-300">{domainConfigureError}</p>
          )}

          {domainStatusError && (
            <p role="alert" className="text-sm text-red-300">{domainStatusError}</p>
          )}

          {domainDnsResult && (
            <div role="status" aria-live="polite" className={`rounded-xl border p-4 text-sm ${domainDnsResult.pointsToUs ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100' : 'border-amber-500/20 bg-amber-500/10 text-amber-100'}`}>
              <p className="font-medium">{domainDnsResult.message}</p>
              <p className="mt-2 text-xs opacity-80">Expected IP: {domainDnsResult.expectedIp}</p>
              {domainDnsResult.resolvedIps.length > 0 && (
                <p className="mt-1 text-xs opacity-80">Resolved IPs: {domainDnsResult.resolvedIps.join(', ')}</p>
              )}
            </div>
          )}
        </div>
      </SectionCard>

      <div className="flex justify-end">
        <SaveButton onClick={handleSave} isDirty={isDirty} disabled={Boolean(generalMutationOwner)} />
      </div>
    </div>
  );
}

// ── Email & Notifications Tab ─────────────────────────────────────────

interface EmailStatus {
  connected: boolean;
  server: string;
  protocol: string;
  sender: string;
  url: string;
  error: string | null;
}

type MailInstallResult = {
  state: 'verified' | 'unverified' | 'failed';
  message: string;
  domain?: string;
  dnsRecords?: Array<{ type: string; name: string; value: string; priority?: number; description?: string }>;
};

function EmailTab({ capability, settings, updateSetting, onSave, isDirty, addToast, claimMutation, releaseMutation }: {
  capability?: PortalFeatureAvailability;
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => SettingsActionResult;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
} & SettingsMutationProps) {
  const [testingSend, setTestingSend] = useState(false);
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [emailStatusError, setEmailStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [installingMail, setInstallingMail] = useState(false);
  const [installMailResult, setInstallMailResult] = useState<MailInstallResult | null>(null);
  const [mailInstallVerificationPending, setMailInstallVerificationPending] = useState(false);
  const [testEmailError, setTestEmailError] = useState<string | null>(null);
  const emailActionRef = useRef<
    | { owner: 'settings:email:install-mail' }
    | { owner: 'settings:email:test-message' }
    | null
  >(null);
  const [emailActionOwner, setEmailActionOwner] = useState<string | null>(null);
  const committedMailInstallRef = useRef<MailInstallResult | null>(null);

  const readEmailStatus = useCallback(async (signal?: AbortSignal) => {
    const res = await client.get('/admin/email-status', { signal });
    return res.data as EmailStatus;
  }, []);

  const applyEmailStatus = useCallback((next: EmailStatus) => {
    setEmailStatus(next);
    setEmailStatusError(null);
    if (next.connected && committedMailInstallRef.current) {
      const committed = committedMailInstallRef.current;
      committedMailInstallRef.current = null;
      setMailInstallVerificationPending(false);
      setInstallMailResult({ ...committed, state: 'verified' });
    }
  }, []);

  const refreshEmailStatus = useCallback(async (signal?: AbortSignal) => {
    setStatusLoading(true);
    try {
      applyEmailStatus(await readEmailStatus(signal));
    } catch (error: any) {
      setEmailStatusError(error?.response?.data?.error || error?.message || 'Email status could not be loaded.');
    } finally {
      setStatusLoading(false);
    }
  }, [applyEmailStatus, readEmailStatus]);

  useEffect(() => {
    if (capability?.available !== true) return undefined;
    const controller = new AbortController();
    void refreshEmailStatus(controller.signal);
    return () => controller.abort();
  }, [capability?.available, refreshEmailStatus]);

  const handleInstallMail = async () => {
    if (capability?.available !== true) return;
    const snapshot = Object.freeze({ owner: 'settings:email:install-mail' as const });
    if (emailActionRef.current || !claimMutation(snapshot.owner)) return;
    emailActionRef.current = snapshot;
    setEmailActionOwner(snapshot.owner);
    setInstallingMail(true);
    const existingCommit = committedMailInstallRef.current;
    if (!existingCommit) setInstallMailResult(null);
    let acceptedResult: MailInstallResult | null = existingCommit;
    try {
      if (!acceptedResult) {
        const res = await client.post('/admin/install-mail');
        acceptedResult = {
          state: 'unverified',
          message: res.data.message || 'Mail server installation finished.',
          domain: res.data.domain,
          dnsRecords: res.data.dnsRecords,
        };
        committedMailInstallRef.current = acceptedResult;
        setMailInstallVerificationPending(true);
      }
      const verifiedStatus = await waitForSettingsConvergence({
        label: 'Mail server readiness',
        read: (signal) => readEmailStatus(signal),
        accepts: (status) => status.connected === true,
      });
      applyEmailStatus(verifiedStatus);
      committedMailInstallRef.current = null;
      setMailInstallVerificationPending(false);
      setInstallMailResult({ ...acceptedResult, state: 'verified' });
      addToast('success', 'Email server installed successfully!');
    } catch (err: any) {
      const msg = acceptedResult
        ? 'Mail installation finished, but Portal could not verify a connected mail service. Retry verification; the installation request will not be repeated.'
        : err?.response?.data?.error || err?.message || 'Installation failed';
      setInstallMailResult({
        state: acceptedResult ? 'unverified' : 'failed',
        message: msg,
        domain: acceptedResult?.domain,
        dnsRecords: acceptedResult?.dnsRecords,
      });
      if (acceptedResult) setEmailStatusError(msg);
      addToast('error', msg);
    } finally {
      if (emailActionRef.current === snapshot) emailActionRef.current = null;
      setEmailActionOwner(null);
      setInstallingMail(false);
      releaseMutation(snapshot.owner);
    }
  };

  const handleTestEmail = async () => {
    if (capability?.available !== true) return;
    const snapshot = Object.freeze({ owner: 'settings:email:test-message' as const });
    if (emailActionRef.current || !claimMutation(snapshot.owner)) return;
    emailActionRef.current = snapshot;
    setEmailActionOwner(snapshot.owner);
    setTestEmailError(null);
    setTestingSend(true);
    try {
      const result = await settingsAPI.sendTestEmail();
      sounds.success();
      addToast('success', result.message || 'Test email sent successfully');
    } catch (err: any) {
      sounds.error();
      const message = err?.response?.data?.error || 'Failed to send test email';
      setTestEmailError(message);
      addToast('error', message);
    } finally {
      if (emailActionRef.current === snapshot) emailActionRef.current = null;
      setEmailActionOwner(null);
      setTestingSend(false);
      releaseMutation(snapshot.owner);
    }
  };

  if (!capability) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-5 py-6"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-slate-400">
            <Loader2 size={18} className="animate-spin" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-theme-text">Checking email availability</h2>
            <p className="mt-1 text-xs leading-5 text-theme-text-muted">
              Portal is confirming whether this installation can safely host mail.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!capability.available) {
    return (
      <div className="overflow-hidden rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.09] via-white/[0.03] to-violet-500/[0.06]">
        <div className="border-b border-white/[0.07] px-5 py-4">
          <span className="inline-flex items-center rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-200">
            Unavailable for this installation
          </span>
        </div>
        <div className="px-5 py-6 sm:px-6">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-400/20 bg-amber-400/10 text-amber-200">
              <Mail size={20} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-theme-text">Mail requires a public domain</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-theme-text-muted">
                {capability.reason || 'Mail is unavailable for this Portal installation.'}
              </p>
              <p className="mt-3 max-w-2xl text-xs leading-5 text-slate-500">
                Portal has left mail installation, test delivery, and notification controls off so it cannot create a partially configured mail system.
              </p>
              <Link
                to="/settings?tab=general"
                className="mt-5 inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.06] px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/[0.1]"
              >
                <Settings size={15} /> Review domain settings
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionCard title="Email System Status">
        {statusLoading ? (
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin" /> Checking email system...
          </div>
        ) : emailStatus ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold ${
                emailStatus.connected
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                  : 'bg-red-500/15 text-red-400 border border-red-500/20'
              }`}>
                {emailStatus.connected ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {emailStatus.connected ? 'Connected' : 'Offline'}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <div className="text-xs text-slate-500 mb-1">Mail Server</div>
                <div className="text-slate-200 font-medium">{emailStatus.server}</div>
              </div>
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <div className="text-xs text-slate-500 mb-1">Protocol</div>
                <div className="text-slate-200 font-medium">{emailStatus.protocol}</div>
              </div>
              <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
                <div className="text-xs text-slate-500 mb-1">Sender</div>
                <div className="text-slate-200 font-medium">{emailStatus.sender}</div>
              </div>
            </div>
            {emailStatus.error && (
              <div className="text-xs text-red-400 mt-1">Error: {emailStatus.error}</div>
            )}
            {!emailStatus.connected && (
              <div className="mt-4 pt-4 border-t border-white/[0.06]">
                <p className="text-xs text-slate-500 mb-3">Email server is offline or not installed. Click below to install and configure Stalwart mail server via Docker.</p>
                <button
                  onClick={handleInstallMail}
                  disabled={Boolean(emailActionOwner) || Boolean(emailStatusError && !mailInstallVerificationPending)}
                  aria-busy={installingMail}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {installingMail ? <Loader2 size={16} className="animate-spin" /> : mailInstallVerificationPending ? <RefreshCw size={16} /> : <Server size={16} />}
                  {installingMail
                    ? mailInstallVerificationPending ? 'Verifying mail server…' : 'Installing mail server… (1–2 min)'
                    : mailInstallVerificationPending ? 'Verify Mail Server Status' : 'Set Up Email Server'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-slate-500">Could not retrieve email system status.</div>
            <p className="text-xs text-slate-500">Status must be verified before Portal can safely offer installation or report connection state.</p>
          </div>
        )}
        {emailStatusError && (
          <div className="mt-3 space-y-2">
            <p role="alert" className="text-sm text-red-300">{emailStatusError}</p>
            <button
              type="button"
              onClick={() => { void refreshEmailStatus(); }}
              disabled={statusLoading || Boolean(emailActionOwner)}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-slate-200 transition hover:bg-white/[0.08] disabled:opacity-50"
            >
              <RefreshCw size={14} className={statusLoading ? 'animate-spin' : ''} /> Retry email status
            </button>
          </div>
        )}
        {installMailResult && (
          <div className={`mt-4 p-4 rounded-lg border ${installMailResult.state === 'verified' ? 'border-emerald-500/20 bg-emerald-500/5' : installMailResult.state === 'unverified' ? 'border-amber-500/20 bg-amber-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
            <div className={`text-xs font-semibold mb-1 ${installMailResult.state === 'verified' ? 'text-emerald-400' : installMailResult.state === 'unverified' ? 'text-amber-300' : 'text-red-400'}`}>
              {installMailResult.state === 'verified' ? '✓ Mail Server Installed' : installMailResult.state === 'unverified' ? 'Mail Server Status Unverified' : '✗ Installation Failed'}
            </div>
            <div className="text-xs text-slate-400">{installMailResult.message}</div>
            {installMailResult.dnsRecords && installMailResult.dnsRecords.length > 0 && (
              <div className="mt-3 rounded-xl border border-slate-800 overflow-hidden">
                <div className="border-b border-slate-800 px-4 py-3">
                  <p className="text-sm font-semibold text-white">DNS Records to Add</p>
                  <p className="mt-1 text-xs text-slate-400">Go to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.) → DNS settings.</p>
                </div>
                <div className="divide-y divide-slate-800">
                  {installMailResult.dnsRecords.map((r, i) => (
                    <div key={i} className="grid gap-3 px-4 py-3 md:grid-cols-[80px_1fr_auto] md:items-start">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-emerald-400 font-semibold">{r.type}</p>
                        {r.priority && <p className="mt-1 text-xs text-slate-500">Priority {r.priority}</p>}
                      </div>
                      <div className="space-y-1 text-sm">
                        <p className="text-slate-300"><span className="text-slate-500">Name:</span> <span className="font-mono">{r.name}</span></p>
                        <p className="break-all text-slate-300"><span className="text-slate-500">Value:</span> <span className="font-mono text-emerald-300">{r.value}</span></p>
                        {r.description && <p className="text-xs text-slate-500">{r.description}</p>}
                      </div>
                      <div className="flex gap-2 md:justify-end">
                        <button onClick={async () => { const ok = await copyTextToClipboard(r.name); addToast(ok ? 'success' : 'error', ok ? 'Name copied' : 'Could not copy — select the value manually'); }} className="px-2 py-1 rounded text-xs text-slate-400 bg-white/5 hover:bg-white/10 transition">Copy name</button>
                        <button onClick={async () => { const ok = await copyTextToClipboard(r.value); addToast(ok ? 'success' : 'error', ok ? 'Value copied' : 'Could not copy — select the value manually'); }} className="px-2 py-1 rounded text-xs text-slate-400 bg-white/5 hover:bg-white/10 transition">Copy value</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="border-t border-slate-800 px-4 py-3 text-xs text-slate-400 space-y-1">
                  <p><strong className="text-slate-300">Registrar tip:</strong> Most providers auto-append your domain — enter just <code className="bg-slate-800 px-1 rounded">@</code>, <code className="bg-slate-800 px-1 rounded">mail</code>, or <code className="bg-slate-800 px-1 rounded">default._domainkey</code>, not the full domain name.</p>
                  <p><strong className="text-slate-300">Propagation:</strong> Usually 1–5 minutes, but can take up to 48 hours.</p>
                </div>
              </div>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Notification Events">
        <div className="space-y-3">
          <Toggle
            checked={settings['notifications.newRegistration'] !== 'false'}
            onChange={v => updateSetting('notifications.newRegistration', v ? 'true' : 'false')}
            label="Email admin on new registration request"
          />
          <Toggle
            checked={settings['notifications.userApproved'] !== 'false'}
            onChange={v => updateSetting('notifications.userApproved', v ? 'true' : 'false')}
            label="Email user when account approved"
          />
          <Toggle
            checked={settings['notifications.systemAlerts'] !== 'false'}
            onChange={v => updateSetting('notifications.systemAlerts', v ? 'true' : 'false')}
            label="Email admin on system errors"
          />
          <Toggle
            checked={settings['notifications.passwordChange'] === 'true'}
            onChange={v => updateSetting('notifications.passwordChange', v ? 'true' : 'false')}
            label="Email user on password change"
          />
          <Toggle
            checked={settings['notifications.newDeviceLogin'] === 'true'}
            onChange={v => updateSetting('notifications.newDeviceLogin', v ? 'true' : 'false')}
            label="Email user on new device login"
          />
        </div>
      </SectionCard>

      <div className="flex items-center justify-between">
        <button
          onClick={handleTestEmail}
          disabled={Boolean(emailActionOwner)}
          aria-busy={testingSend}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-blue-400 bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 transition-all"
        >
          {testingSend ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          {testingSend ? 'Sending test email…' : 'Send Test Email'}
        </button>
        <SaveButton onClick={onSave} isDirty={isDirty} disabled={Boolean(emailActionOwner)} />
      </div>
      {testEmailError && <p role="alert" className="mt-3 text-sm text-red-300">{testEmailError}</p>}
    </div>
  );
}

// ── Security Tab ──────────────────────────────────────────────────────

function SecurityTab({ mailCapability, settings, updateSetting, onSave, isDirty, addToast, claimMutation, releaseMutation, mutationOwner, embedPolicyNavigationAttemptVersion, onEmbedPolicyDirtyChange }: {
  mailCapability?: PortalFeatureAvailability;
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => SettingsActionResult;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
  embedPolicyNavigationAttemptVersion: number;
  onEmbedPolicyDirtyChange: (dirty: boolean) => void;
} & SettingsMutationProps) {
  const twoFactorMutationBusy = Boolean(mutationOwner?.startsWith('settings:security:2fa'));
  return (
    <div>
      <SectionCard title="Registration">
        <div className="space-y-4">
          <div>
            <FieldLabel label="Registration Mode" description="Controls how new users can join the portal" />
            <div className="flex gap-2">
              {(['open', 'approval', 'closed'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => updateSetting('security.registrationMode', mode)}
                  disabled={twoFactorMutationBusy}
                  className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-all border ${
                    (settings['security.registrationMode'] || settings['registrationMode'] || DEFAULT_REGISTRATION_MODE) === mode
                      ? ''
                      : 'text-slate-400 bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
                  }`}
                  style={(settings['security.registrationMode'] || settings['registrationMode'] || DEFAULT_REGISTRATION_MODE) === mode ? {
                    background: 'var(--accent-bg)',
                    color: 'var(--accent)',
                    borderColor: 'var(--accent-border)',
                  } : undefined}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <Toggle
            checked={(settings['security.blockClosedRegistration'] ?? 'true') === 'true'}
            onChange={v => updateSetting('security.blockClosedRegistration', v ? 'true' : 'false')}
            label="Block IP on closed registration attempt"
            disabled={twoFactorMutationBusy}
          />
          <p className="text-xs text-theme-text-muted -mt-2 ml-0.5">
            When registration is closed, silently block the requester's IP instead of returning an error message
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Project Workspace Default">
        <Toggle
          checked={(settings['security.sandboxDefaultEnabled'] || 'true') === 'true'}
          onChange={v => updateSetting('security.sandboxDefaultEnabled', v ? 'true' : 'false')}
          label="Use a private project workspace for newly created accounts"
          disabled={twoFactorMutationBusy}
        />
        <p className="mt-3 text-xs leading-5 text-theme-text-muted">
          Regular users and viewers are always isolated to their own Project workspace. This default matters if an account is later promoted to SUB_ADMIN: enabled keeps the human Projects surface private; disabled shares the Owner's Projects surface. Project Chat never inherits that sharing—it can run only against the authenticated user's own project tree. Main Agent Chat and Terminal remain intentional host-operator surfaces for SUB_ADMIN.
        </p>
      </SectionCard>

      <SectionCard title="Login Security">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <FieldLabel label="Max Login Attempts" description="Lock account after this many failed attempts" />
            <TextInput
              value={settings['security.maxLoginAttempts'] || '5'}
              onChange={v => updateSetting('security.maxLoginAttempts', v)}
              placeholder="5"
              type="number"
              ariaLabel="Maximum login attempts"
              disabled={twoFactorMutationBusy}
            />
          </div>
          <div>
            <FieldLabel label="Session Duration (hours)" description="How long before requiring re-login" />
            <TextInput
              value={settings['security.sessionDurationHours'] || '24'}
              onChange={v => updateSetting('security.sessionDurationHours', v)}
              placeholder="24"
              type="number"
              ariaLabel="Session duration in hours"
              disabled={twoFactorMutationBusy}
            />
          </div>
        </div>
      </SectionCard>

      <EmbedSecurityPolicyManager
        addToast={addToast}
        claimMutation={claimMutation}
        releaseMutation={releaseMutation}
        mutationOwner={mutationOwner}
        navigationAttemptVersion={embedPolicyNavigationAttemptVersion}
        onDirtyChange={onEmbedPolicyDirtyChange}
      />

      {/* Two-Factor Authentication (admin sees it here) */}
      <TwoFactorSection
        mailCapability={mailCapability}
        addToast={addToast}
        claimMutation={claimMutation}
        releaseMutation={releaseMutation}
        mutationOwner={mutationOwner}
      />

      <div className="flex justify-end">
        <SaveButton onClick={onSave} isDirty={isDirty} disabled={twoFactorMutationBusy} />
      </div>
    </div>
  );
}

// ── Agents Tab ────────────────────────────────────────────────────────

function AgentsTab({ addToast, onOpenProviders, claimMutation, releaseMutation }: {
  addToast: (type: 'success' | 'error', msg: string) => void;
  onOpenProviders: () => void;
} & SettingsMutationProps) {
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus | null>(null);
  const [compactionNoticeEnabled, setCompactionNoticeEnabled] = useState(false);
  const [compactionNoticeLoading, setCompactionNoticeLoading] = useState(true);
  const [compactionNoticeSaving, setCompactionNoticeSaving] = useState(false);
  const [compactionNoticeError, setCompactionNoticeError] = useState<string | null>(null);
  const compactionNoticeActionRef = useRef<{ owner: 'settings:agents:compaction-notice'; enabled: boolean; previous: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadStatus = async () => {
      try {
        const status = await agentRuntimeAPI.status();
        if (!cancelled) setRuntimeStatus(status);
      } catch {
        if (!cancelled) setRuntimeStatus(null);
      }
    };
    loadStatus();
    const interval = setInterval(loadStatus, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const loadCompactionNoticeSetting = useCallback(async () => {
    setCompactionNoticeLoading(true);
    try {
      const data = await gatewayAPI.getConfigPath('agents.defaults.compaction.notifyUser');
      setCompactionNoticeEnabled(data?.value === true);
    } catch (err: any) {
      setCompactionNoticeEnabled(false);
      addToast('error', err?.response?.data?.error || 'Failed to load OpenClaw compaction notice setting');
    } finally {
      setCompactionNoticeLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void loadCompactionNoticeSetting();
  }, [loadCompactionNoticeSetting]);

  const handleCompactionNoticeToggle = useCallback(async (enabled: boolean) => {
    const snapshot = Object.freeze({
      owner: 'settings:agents:compaction-notice' as const,
      enabled,
      previous: compactionNoticeEnabled,
    });
    if (compactionNoticeLoading || compactionNoticeActionRef.current || !claimMutation(snapshot.owner)) return;
    compactionNoticeActionRef.current = snapshot;
    setCompactionNoticeError(null);
    setCompactionNoticeEnabled(enabled);
    setCompactionNoticeSaving(true);
    try {
      await gatewayAPI.patchConfigPath('agents.defaults.compaction.notifyUser', snapshot.enabled);
      addToast('success', enabled ? 'OpenClaw compaction notices enabled' : 'OpenClaw compaction notices disabled');
    } catch (err: any) {
      setCompactionNoticeEnabled(snapshot.previous);
      const message = err?.response?.data?.error || 'Failed to update OpenClaw compaction notice setting';
      setCompactionNoticeError(message);
      addToast('error', message);
    } finally {
      if (compactionNoticeActionRef.current === snapshot) compactionNoticeActionRef.current = null;
      setCompactionNoticeSaving(false);
      releaseMutation(snapshot.owner);
    }
  }, [addToast, claimMutation, compactionNoticeEnabled, compactionNoticeLoading, releaseMutation]);

  return (
    <div>
      {/* Gateway Status Bar */}
      <div className="mb-4 flex items-center gap-2 text-xs">
        <span className={`px-2 py-1 rounded ${runtimeStatus?.gateway.connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
          Gateway {runtimeStatus?.gateway.connected ? 'Connected' : 'Offline'}
        </span>
        <span className={`px-2 py-1 rounded ${(runtimeStatus?.adapters.filter((a) => a.available && a.id !== 'shell').length || 0) > 0 ? 'bg-blue-500/10 text-blue-300' : 'bg-amber-500/10 text-amber-300'}`}>
          Agents {(runtimeStatus?.adapters.filter((a) => a.available && a.id !== 'shell').length || 0) > 0
            ? `${runtimeStatus?.adapters.filter((a) => a.available && a.id !== 'shell').length} ready`
            : 'Unavailable'}
        </span>
      </div>

      <SectionCard title="Provider Connections">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-6 text-slate-400">
            Authentication, OAuth, API keys, model discovery, and local Ollama configuration now live in one canonical place: AI Providers.
          </p>
          <button type="button" onClick={onOpenProviders} disabled={compactionNoticeSaving} className="min-h-[44px] shrink-0 rounded-xl border border-blue-500/25 bg-blue-500/10 px-4 py-2 text-sm font-medium text-blue-200 transition hover:bg-blue-500/20 disabled:opacity-50">
            Open AI Providers
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Runtime ownership">
        <div className="space-y-3 text-sm leading-6 text-slate-400">
          <p>
            Provider availability is derived from the installed, authenticated runtime and its tested capabilities. There is no separate enable switch or binary override in Portal Settings.
          </p>
          <p>
            Main Agent Chats run with intentional host-operator access for the Owner and Sub Admins. Project Chat uses a separate provider capability gate and an enforced project workspace.
          </p>
        </div>
      </SectionCard>

      <Suspense fallback={<div className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 text-sm text-slate-400"><Loader2 size={16} className="mr-2 inline animate-spin" />Loading Agent Zero setup controls…</div>}>
        <LazyAgentZeroSetupPanel onOpenProviderSettings={onOpenProviders} />
      </Suspense>

      <SectionCard title="OpenClaw Runtime">
        <div className="space-y-3">
          <Toggle
            checked={compactionNoticeEnabled}
            onChange={(enabled) => { void handleCompactionNoticeToggle(enabled); }}
            label="Show compaction notices in OpenClaw chats"
            disabled={compactionNoticeLoading || compactionNoticeSaving}
            busy={compactionNoticeSaving}
          />
          <p className="text-sm text-slate-400">
            Flips <code className="text-xs text-slate-300">agents.defaults.compaction.notifyUser</code> so OpenClaw can emit a visible “Compacting context…” notice when auto-compaction starts.
          </p>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            {(compactionNoticeLoading || compactionNoticeSaving) && <Loader2 size={12} className="animate-spin" />}
            {compactionNoticeLoading
              ? 'Loading current OpenClaw compaction notice setting…'
              : compactionNoticeSaving
                ? 'Updating OpenClaw runtime setting…'
                : 'Applies immediately to OpenClaw. No portal Save click needed.'}
          </div>
          {compactionNoticeError && <p role="alert" className="text-xs text-red-300">{compactionNoticeError}</p>}
        </div>
      </SectionCard>

      <div className="flex flex-wrap items-center gap-4">
        <a href="/agent-chats" aria-disabled={compactionNoticeSaving} onClick={(event) => { if (compactionNoticeActionRef.current) event.preventDefault(); }} className="text-sm text-blue-400 hover:text-blue-300 underline">
          Open Agent Chats →
        </a>
        <a href="/agent-tools" aria-disabled={compactionNoticeSaving} onClick={(event) => { if (compactionNoticeActionRef.current) event.preventDefault(); }} className="text-sm text-blue-400 hover:text-blue-300 underline">
          Manage agent tools →
        </a>
      </div>
    </div>
  );
}

// ── System Tab ────────────────────────────────────────────────────────

function SystemTab({ mailCapability, settings, updateSetting, onSave, isDirty, addToast, claimMutation, releaseMutation }: {
  mailCapability?: PortalFeatureAvailability;
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => SettingsActionResult;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
} & SettingsMutationProps) {
  // Mailbox management state
  const [mailboxes, setMailboxes] = useState<{ userId: string; username: string; email: string; createdAt: string; lastLoginAt: string | null }[]>([]);
  const [mailboxLoading, setMailboxLoading] = useState(false);
  const [mailboxLoadError, setMailboxLoadError] = useState<string | null>(null);
  const [deletingMailbox, setDeletingMailbox] = useState<string | null>(null);
  const [pendingMailboxDelete, setPendingMailboxDelete] = useState<string | null>(null);
  const { user } = useAuthStore();
  const isAdmin = isElevated(user);
  const canApplyCompatibilityHotfix = isOwnerRole(user?.role);
  const [codingTools, setCodingTools] = useState<Array<{ id: string; name: string; description: string; installed: boolean; version: string }>>([]);
  const [codingToolsLoading, setCodingToolsLoading] = useState(false);
  const [codingToolsError, setCodingToolsError] = useState<string | null>(null);
  const [installingToolId, setInstallingToolId] = useState('');
  const [pendingToolInstall, setPendingToolInstall] = useState<{ id: string; name: string } | null>(null);
  const [compatHotfixStatus, setCompatHotfixStatus] = useState<CompatibilityHotfixStatus | null>(null);
  const [compatHotfixLoading, setCompatHotfixLoading] = useState(false);
  const [compatHotfixApplying, setCompatHotfixApplying] = useState(false);
  const [compatHotfixOutput, setCompatHotfixOutput] = useState('');
  const [compatHotfixConfirmOpen, setCompatHotfixConfirmOpen] = useState(false);
  const [toolInstallError, setToolInstallError] = useState<string | null>(null);
  const [toolInstallVerificationPending, setToolInstallVerificationPending] = useState(false);
  const [mailboxDeleteError, setMailboxDeleteError] = useState<string | null>(null);
  const [compatHotfixError, setCompatHotfixError] = useState<string | null>(null);
  const systemDialogRef = useRef<'mailbox-delete' | 'tool-install' | 'compat-hotfix' | null>(null);
  const systemActionRef = useRef<
    | { owner: 'settings:system:tool-install'; toolId: string; toolName: string; confirmation: string }
    | { owner: 'settings:system:mailbox-delete'; username: string; confirmation: string }
    | { owner: 'settings:system:compat-hotfix'; confirmation: string }
    | null
  >(null);
  const [systemActionOwner, setSystemActionOwner] = useState<string | null>(null);
  const committedToolInstallRef = useRef<{ toolId: string; toolName: string } | null>(null);

  const loadMailboxes = useCallback(async () => {
    setMailboxLoading(true);
    try {
      const res = await client.get('/admin/mailboxes');
      setMailboxes(res.data?.mailboxes || []);
      setMailboxLoadError(null);
    } catch (error: any) {
      setMailboxLoadError(
        error?.response?.data?.error
        || error?.message
        || 'Mailbox status could not be loaded.',
      );
    } finally {
      setMailboxLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mailCapability?.available !== true) return;
    void loadMailboxes();
  }, [loadMailboxes, mailCapability?.available]);

  const readCodingTools = useCallback(async (signal?: AbortSignal) => {
    const res = await client.get('/admin/coding-tools-status', { signal });
    const tools = (res.data.tools || []) as Array<{ id: string; name: string; description: string; installed: boolean; version: string }>;
    setCodingTools(tools);
    setCodingToolsError(null);
    return tools;
  }, []);

  const loadCodingTools = useCallback(async () => {
    setCodingToolsLoading(true);
    try {
      await readCodingTools();
    } catch (error: any) {
      setCodingToolsError(error?.response?.data?.error || error?.message || 'Coding-tool status could not be loaded.');
    } finally {
      setCodingToolsLoading(false);
    }
  }, [readCodingTools]);

  useEffect(() => { loadCodingTools(); }, [loadCodingTools]);

  const loadCompatibilityHotfixStatus = useCallback(async () => {
    if (!isAdmin) {
      setCompatHotfixStatus(null);
      setCompatHotfixLoading(false);
      return;
    }
    setCompatHotfixLoading(true);
    try {
      const status = await gatewayAPI.getCompatibilityHotfixStatus();
      setCompatHotfixStatus(status);
    } catch (err: any) {
      setCompatHotfixStatus(null);
      addToast('error', err?.response?.data?.error || 'Failed to load hotfix status');
    } finally {
      setCompatHotfixLoading(false);
    }
  }, [addToast, isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      setCompatHotfixStatus(null);
      setCompatHotfixLoading(false);
      return;
    }
    void loadCompatibilityHotfixStatus();
  }, [isAdmin, loadCompatibilityHotfixStatus]);

  const openSystemDialog = (
    kind: 'mailbox-delete' | 'tool-install' | 'compat-hotfix',
    open: () => void,
  ) => {
    if (systemDialogRef.current || systemActionRef.current) return;
    systemDialogRef.current = kind;
    open();
  };

  const closeSystemDialog = (kind: 'mailbox-delete' | 'tool-install' | 'compat-hotfix', close: () => void) => {
    if (systemActionRef.current || systemDialogRef.current !== kind) return;
    systemDialogRef.current = null;
    close();
  };

  const handleInstallTool = async (toolId: string, toolName: string, confirmation: string) => {
    const snapshot = Object.freeze({
      owner: 'settings:system:tool-install' as const,
      toolId,
      toolName,
      confirmation,
    });
    if (systemActionRef.current || !claimMutation(snapshot.owner)) return;
    systemActionRef.current = snapshot;
    setSystemActionOwner(snapshot.owner);
    setToolInstallError(null);
    setInstallingToolId(snapshot.toolId);
    let installationAccepted = committedToolInstallRef.current?.toolId === snapshot.toolId;
    try {
      if (!installationAccepted) {
        await client.post('/admin/install-coding-tool', { toolId: snapshot.toolId, confirmation: snapshot.confirmation });
        installationAccepted = true;
        committedToolInstallRef.current = { toolId: snapshot.toolId, toolName: snapshot.toolName };
        setToolInstallVerificationPending(true);
      }
      const verifiedTools = await waitForSettingsConvergence({
        label: `${snapshot.toolName} installation status`,
        read: (signal) => readCodingTools(signal),
        accepts: (tools) => tools.some((tool) => tool.id === snapshot.toolId && tool.installed),
      });
      setCodingTools(verifiedTools);
      setCodingToolsError(null);
      committedToolInstallRef.current = null;
      setToolInstallVerificationPending(false);
      addToast('success', 'Tool installed successfully');
      setPendingToolInstall(null);
      systemDialogRef.current = null;
    } catch (err: any) {
      const message = installationAccepted
        ? `${snapshot.toolName} installation finished, but Portal could not verify the installed tool. Retry verification; the install request will not be repeated.`
        : err?.response?.data?.error || `Failed to install ${snapshot.toolName}`;
      setToolInstallError(message);
      addToast('error', message);
    } finally {
      if (systemActionRef.current === snapshot) systemActionRef.current = null;
      setSystemActionOwner(null);
      setInstallingToolId('');
      releaseMutation(snapshot.owner);
    }
  };

  const handleDeleteMailbox = async (username: string, confirmation: string) => {
    if (mailCapability?.available !== true) return;
    const snapshot = Object.freeze({
      owner: 'settings:system:mailbox-delete' as const,
      username,
      confirmation,
    });
    if (systemActionRef.current || !claimMutation(snapshot.owner)) return;
    systemActionRef.current = snapshot;
    setSystemActionOwner(snapshot.owner);
    setMailboxDeleteError(null);
    setDeletingMailbox(snapshot.username);
    try {
      await client.delete(`/admin/mailboxes/${encodeURIComponent(snapshot.username)}`, { data: { confirmation: snapshot.confirmation } });
      await loadMailboxes();
      addToast('success', `Mailbox ${snapshot.username} deleted`);
      setPendingMailboxDelete(null);
      systemDialogRef.current = null;
    } catch (err: any) {
      const message = err?.response?.data?.error || 'Failed to delete mailbox';
      setMailboxDeleteError(message);
      addToast('error', message);
    } finally {
      if (systemActionRef.current === snapshot) systemActionRef.current = null;
      setSystemActionOwner(null);
      setDeletingMailbox(null);
      releaseMutation(snapshot.owner);
    }
  };

  const handleApplyCompatibilityHotfix = async (confirmation: string) => {
    if (!canApplyCompatibilityHotfix) return;
    const snapshot = Object.freeze({ owner: 'settings:system:compat-hotfix' as const, confirmation });
    if (systemActionRef.current || !claimMutation(snapshot.owner)) return;
    systemActionRef.current = snapshot;
    setSystemActionOwner(snapshot.owner);
    setCompatHotfixError(null);
    setCompatHotfixApplying(true);
    try {
      const result = await gatewayAPI.applyCompatibilityHotfix(snapshot.confirmation);
      const combinedOutput = [result.patchOutput, result.restartOutput].filter(Boolean).join('\n\n');
      setCompatHotfixOutput(combinedOutput);
      setCompatHotfixStatus(result.status);
      addToast('success', result.message || 'Compatibility hotfix applied');
      setCompatHotfixConfirmOpen(false);
      systemDialogRef.current = null;
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.response?.data?.error || 'Failed to apply compatibility hotfix';
      setCompatHotfixError(detail);
      addToast('error', detail);
    } finally {
      if (systemActionRef.current === snapshot) systemActionRef.current = null;
      setSystemActionOwner(null);
      setCompatHotfixApplying(false);
      void loadCompatibilityHotfixStatus();
      releaseMutation(snapshot.owner);
    }
  };

  return (
    <div>
      <div className="mb-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-xs leading-5 text-cyan-100">
        This tab changes Portal configuration and installed host integrations. Server health, backups, package maintenance, and update planning live in <Link to="/admin?tab=maintenance" className="font-semibold underline underline-offset-2">Admin → Maintenance</Link>. Actions that install software, delete data, or restart OpenClaw require a typed confirmation.
      </div>
      {!mailCapability ? (
        <SectionCard title="Mailbox Management">
          <div role="alert" className="rounded-xl border border-amber-500/20 bg-amber-500/[0.08] p-4">
            <p className="text-sm font-semibold text-theme-text">Mailbox availability is not confirmed</p>
            <p className="mt-1 text-xs leading-5 text-theme-text-muted">
              Portal keeps mailbox actions disabled until it can load the current server capabilities.
            </p>
            <button
              type="button"
              onClick={() => { void refreshPublicSettings(); }}
              className="mt-3 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-amber-400/20 px-3 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/10"
            >
              <RefreshCw size={14} /> Retry availability check
            </button>
          </div>
        </SectionCard>
      ) : !mailCapability.available ? (
        <SectionCard title="Mailbox Management">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.08] p-4">
            <div className="flex items-start gap-3">
              <Mail size={18} className="mt-0.5 shrink-0 text-amber-300" />
              <div>
                <p className="text-sm font-semibold text-theme-text">Mailbox management requires a public domain</p>
                <p className="mt-1 text-xs leading-5 text-theme-text-muted">
                  {mailCapability.reason || 'Mail is unavailable for this Portal installation.'}
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  This panel will not discover or delete mailboxes while mail is unavailable.
                </p>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : (
      <SectionCard title="Mailbox Management">
        <p className="text-xs text-slate-500 mb-3">User email accounts provisioned on Stalwart. Deleting a mailbox removes the Stalwart account but keeps the portal user.</p>
        {mailboxLoadError && (
          <div role="alert" className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-sm text-red-200">
            <p>{mailboxLoadError}</p>
            <button
              type="button"
              onClick={() => { void loadMailboxes(); }}
              disabled={mailboxLoading}
              className="mt-2 inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-red-400/20 px-3 py-2 text-xs font-semibold transition hover:bg-red-500/10 disabled:opacity-50"
            >
              <RefreshCw size={13} className={mailboxLoading ? 'animate-spin' : ''} /> Retry mailbox status
            </button>
          </div>
        )}
        {mailboxLoading && mailboxes.length === 0 ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
            <Loader2 size={16} className="animate-spin" /> Loading mailboxes...
          </div>
        ) : mailboxes.length === 0 && !mailboxLoadError ? (
          <div className="text-sm text-slate-500 py-4">No mailboxes provisioned yet.</div>
        ) : mailboxes.length > 0 ? (
          <div className="space-y-2">
            {mailboxes.map(mb => (
              <div key={mb.username} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white font-medium truncate">{mb.username}</div>
                  <div className="text-xs text-slate-500 truncate">{mb.email}</div>
                </div>
                <div className="text-xs text-slate-500 shrink-0 hidden sm:block">
                  {mb.lastLoginAt ? `Last login: ${new Date(mb.lastLoginAt).toLocaleDateString()}` : 'Never logged in'}
                </div>
                <button
                  onClick={() => openSystemDialog('mailbox-delete', () => {
                    setMailboxDeleteError(null);
                    setPendingMailboxDelete(mb.username);
                  })}
                  disabled={Boolean(systemDialogRef.current || systemActionOwner)}
                  className="min-h-[40px] shrink-0 rounded-lg border border-transparent px-3 py-1 text-xs font-medium text-red-400 transition hover:border-red-500/20 hover:bg-red-500/10 disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="mt-3 flex justify-end">
          <button onClick={() => { void loadMailboxes(); }} disabled={mailboxLoading || Boolean(systemActionOwner)} className="text-xs text-slate-400 hover:text-white flex items-center gap-1 disabled:opacity-50">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </SectionCard>
      )}

      <SectionCard title="Telemetry">
        <div className="space-y-3">
          <Toggle
            checked={settings['system.allowTelemetry'] === 'true'}
            onChange={v => updateSetting('system.allowTelemetry', v ? 'true' : 'false')}
            label="Help improve BridgesLLM"
          />
          <p className="text-sm text-slate-400">
            Sends a limited operational report shortly after startup and then about every 24 hours while Portal remains running: a random install ID, Portal and dependency versions, Portal user count, uptime, Node version, operating system, and architecture. It excludes messages, prompts, project and app content, files, credentials, usernames, and email addresses. Turning this off stops this report only. Owner Dashboard version checks and manual refreshes still work without this operational payload. Installer lifecycle tracking is separate: install and update milestones include the event type, Portal version, operating system name and version, and the random install ID. This switch controls Portal operational telemetry, not those installer events.
          </p>
          {settings['system.allowTelemetry'] !== 'true' && (
            <p className="text-xs text-amber-300/90">Portal operational reports are off. Dashboard version checks and manual refreshes still work.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Remote Desktop Configuration">
        <div className="space-y-4">
          <div>
            <FieldLabel label="remoteDesktop.url" description="Use the managed same-origin noVNC path when possible. External URLs can be embedded, but the Portal cannot attest their authentication or connection state." />
            <TextInput
              value={settings['remoteDesktop.url'] || ''}
              onChange={v => updateSetting('remoteDesktop.url', v)}
              placeholder="/novnc/vnc_portal.html?reconnect=1&resize=smart"
              ariaLabel="Remote Desktop URL"
            />
          </div>
          <div>
            <FieldLabel label="remoteDesktop.allowedPathPrefixes" description="Comma-separated non-root path segments allowed inside the authenticated Portal (for example /novnc,/vnc). Prefix lookalikes such as /novncevil are rejected." />
            <TextInput
              value={settings['remoteDesktop.allowedPathPrefixes'] || '/novnc,/vnc'}
              onChange={v => updateSetting('remoteDesktop.allowedPathPrefixes', v)}
              placeholder="/novnc,/vnc"
              ariaLabel="Remote Desktop allowed path prefixes"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="AI Coding Tools">
        <p className="text-sm text-slate-400 mb-4">Optional CLI tools for AI-powered coding agents.</p>
        {codingToolsError && (
          <div className="mb-3 space-y-2">
            <p role="alert" className="text-sm text-red-300">{codingToolsError}</p>
            <button type="button" onClick={() => { void loadCodingTools(); }} disabled={codingToolsLoading || Boolean(systemActionOwner)} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-slate-200 transition hover:bg-white/[0.08] disabled:opacity-50">
              <RefreshCw size={14} className={codingToolsLoading ? 'animate-spin' : ''} /> Retry tool status
            </button>
          </div>
        )}
        {codingToolsLoading ? (
          <div className="flex items-center gap-2 text-slate-400"><Loader2 size={16} className="animate-spin" /> Checking...</div>
        ) : codingTools.length === 0 ? (
          <p className="text-sm text-slate-500">Could not check coding tools status.</p>
        ) : (
          <div className="space-y-3">
            {codingTools.map(tool => (
              <div key={tool.id} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <div>
                  <p className="font-medium text-slate-200">{tool.name}</p>
                  <p className="text-xs text-slate-500">{tool.description}</p>
                  {tool.installed && tool.version && <p className="text-xs text-emerald-400 mt-1">v{tool.version}</p>}
                </div>
                {tool.installed ? (
                  <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 size={14} /> Installed</span>
                ) : (
                  <button onClick={() => openSystemDialog('tool-install', () => {
                    setToolInstallError(null);
                    setPendingToolInstall({ id: tool.id, name: tool.name });
                  })} disabled={Boolean(systemDialogRef.current || systemActionOwner)} className="min-h-[40px] rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
                    {installingToolId === tool.id ? 'Installing...' : 'Install'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {isAdmin && (
        <SectionCard title="OpenClaw Compatibility Hotfix">
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              Installer and updater runs usually auto-apply this temporary OpenClaw patch now. Use this fallback if OpenClaw was upgraded separately or this install is still missing the relay, Gemini, or Claude ask-question compatibility markers. Applying it patches the installed OpenClaw runtime files and restarts the OpenClaw gateway.
            </p>

            {compatHotfixLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm">
                <Loader2 size={16} className="animate-spin" /> Checking hotfix status...
              </div>
            ) : compatHotfixStatus ? (
              <>
                <div className={`rounded-xl border p-3 ${compatHotfixStatus.applied ? 'border-emerald-500/20 bg-emerald-500/10' : 'border-amber-500/20 bg-amber-500/10'}`}>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {compatHotfixStatus.applied ? <CheckCircle2 size={16} className="text-emerald-400" /> : <AlertCircle size={16} className="text-amber-300" />}
                    <span className={compatHotfixStatus.applied ? 'text-emerald-300' : 'text-amber-200'}>
                      {compatHotfixStatus.applied ? 'Compatibility patches present in the installed OpenClaw bundle' : 'Compatibility patches not applied'}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-slate-300">
                    <div>Heartbeat bundle: <span className="font-mono text-slate-400">{compatHotfixStatus.heartbeatRunner || 'missing'}</span></div>
                    <div>Reply bundle: <span className="font-mono text-slate-400">{compatHotfixStatus.replyBundle || 'missing'}</span></div>
                    <div>Execute runtime: <span className="font-mono text-slate-400">{compatHotfixStatus.executeRuntime || 'missing'}</span></div>
                    <div>Gemini CLI backend: <span className="font-mono text-slate-400">{compatHotfixStatus.geminiCliBackend || 'missing'}</span></div>
                    <div>Claude CLI shared bundle: <span className="font-mono text-slate-400">{compatHotfixStatus.claudeCliShared || 'missing'}</span></div>
                    <div>Relay patches: <span className="text-slate-400">detector {compatHotfixStatus.detectorPatched ? '✓' : '✗'}, relay {compatHotfixStatus.relayPatched ? '✓' : '✗'}, reply {compatHotfixStatus.replyPatched ? '✓' : '✗'}</span></div>
                    <div>Gemini patches: <span className="text-slate-400">cli {compatHotfixStatus.geminiCliPatched ? '✓' : '✗'}, yolo {compatHotfixStatus.geminiCliYoloPatched ? '✓' : '✗'}, runtime {compatHotfixStatus.geminiRuntimePatched ? '✓' : '✗'}</span></div>
                    <div>Claude questions: <span className="text-slate-400">route {compatHotfixStatus.claudeAskUserPatched ? '✓' : '✗'}, bridge {compatHotfixStatus.claudeAskUserBridgeReady ? '✓' : '✗'}, timers {compatHotfixStatus.claudeAskUserTimeoutsReady ? '✓' : '✗'}</span></div>
                    {compatHotfixStatus.note && <div className="text-slate-400">{compatHotfixStatus.note}</div>}
                  </div>
                </div>

                {compatHotfixStatus.issues.length > 0 && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200 space-y-1">
                    {compatHotfixStatus.issues.map((issue) => (
                      <div key={issue}>{issue}</div>
                    ))}
                  </div>
                )}

                {compatHotfixOutput && (
                  <details className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
                    <summary className="cursor-pointer text-xs font-medium text-slate-300">Last hotfix output</summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-400">{compatHotfixOutput}</pre>
                  </details>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    onClick={() => { void loadCompatibilityHotfixStatus(); }}
                    disabled={compatHotfixLoading || Boolean(systemActionOwner)}
                    className="flex items-center gap-1 text-xs text-slate-400 hover:text-white disabled:opacity-50"
                  >
                    <RefreshCw size={12} /> Refresh status
                  </button>
                  <button
                    onClick={() => openSystemDialog('compat-hotfix', () => {
                      setCompatHotfixError(null);
                      setCompatHotfixConfirmOpen(true);
                    })}
                    disabled={Boolean(systemDialogRef.current || systemActionOwner) || !compatHotfixStatus.supported || !canApplyCompatibilityHotfix}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-amber-200/70 bg-gradient-to-r from-amber-300 via-amber-400 to-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-[0_10px_24px_rgba(245,158,11,0.28)] transition-all hover:-translate-y-0.5 hover:from-amber-200 hover:via-amber-300 hover:to-amber-400 hover:shadow-[0_14px_28px_rgba(245,158,11,0.36)] focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/90 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0E27] disabled:translate-y-0 disabled:cursor-not-allowed disabled:border-white/[0.08] disabled:bg-white/[0.06] disabled:bg-none disabled:text-slate-500 disabled:shadow-none"
                  >
                    {compatHotfixApplying ? <Loader2 size={15} className="animate-spin" /> : <Wrench size={15} />}
                    <span>{compatHotfixApplying ? 'Applying and restarting…' : compatHotfixStatus.applied ? 'Reapply compatibility patches and restart' : 'Apply compatibility patches and restart'}</span>
                  </button>
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-500">Could not load compatibility hotfix status.</div>
            )}
          </div>
        </SectionCard>
      )}

      <TypedConfirmationDialog
        open={mailCapability?.available === true && !!pendingMailboxDelete}
        title={`Delete mailbox ${pendingMailboxDelete || ''}?`}
        description="This permanently removes the Stalwart mailbox and its stored messages. The Portal user account is not deleted."
        confirmationPhrase={pendingMailboxDelete ? `DELETE MAILBOX ${pendingMailboxDelete}` : null}
        confirmLabel="Delete mailbox"
        busyLabel="Deleting mailbox…"
        busy={!!pendingMailboxDelete && deletingMailbox === pendingMailboxDelete}
        tone="danger"
        details={mailboxDeleteError ? <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">{mailboxDeleteError}</p> : undefined}
        onCancel={() => closeSystemDialog('mailbox-delete', () => setPendingMailboxDelete(null))}
        onConfirm={(confirmation) => { if (pendingMailboxDelete) void handleDeleteMailbox(pendingMailboxDelete, confirmation); }}
      />

      <TypedConfirmationDialog
        open={!!pendingToolInstall}
        title={`Install ${pendingToolInstall?.name || 'coding tool'}?`}
        description="This installs a host-level executable used by operator Agent Chats. Package installation can change system files and may download third-party dependencies."
        confirmationPhrase={pendingToolInstall ? `INSTALL ${pendingToolInstall.id.trim().toUpperCase()}` : null}
        confirmLabel={toolInstallVerificationPending ? 'Verify installed tool' : 'Install host tool'}
        busyLabel={toolInstallVerificationPending ? 'Verifying installed tool…' : 'Installing host tool…'}
        busy={!!pendingToolInstall && installingToolId === pendingToolInstall.id}
        details={toolInstallError ? <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">{toolInstallError}</p> : undefined}
        onCancel={() => {
          if (committedToolInstallRef.current) return;
          closeSystemDialog('tool-install', () => setPendingToolInstall(null));
        }}
        onConfirm={(confirmation) => { if (pendingToolInstall) void handleInstallTool(pendingToolInstall.id, pendingToolInstall.name, confirmation); }}
      />

      <TypedConfirmationDialog
        open={compatHotfixConfirmOpen}
        title="Apply OpenClaw compatibility hotfix?"
        description="This updates the installed OpenClaw compatibility bundle and restarts the gateway. Active agent turns may be interrupted."
        confirmationPhrase={compatHotfixStatus?.confirmationPhrase || null}
        confirmLabel="Apply hotfix + restart"
        busyLabel="Applying hotfix and restarting…"
        busy={compatHotfixApplying}
        tone="warning"
        details={compatHotfixError ? <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">{compatHotfixError}</p> : undefined}
        onCancel={() => closeSystemDialog('compat-hotfix', () => setCompatHotfixConfirmOpen(false))}
        onConfirm={(confirmation) => { void handleApplyCompatibilityHotfix(confirmation); }}
      />

      <div className="flex justify-end">
        <SaveButton onClick={onSave} isDirty={isDirty} disabled={Boolean(systemDialogRef.current || systemActionOwner)} />
      </div>
    </div>
  );
}


const LOCAL_CPU_SETTING_KEYS = [
  'ollama.localEnabled',
  'ollama.defaultModel',
  'ollama.local.tier.snappy',
  'ollama.local.tier.smart',
  'ollama.local.tier.best',
] as const;

const LOCAL_CPU_MODEL_SETTING_KEYS = LOCAL_CPU_SETTING_KEYS.filter(
  (key) => key !== 'ollama.localEnabled',
);

function LocalCpuPreferences({
  settings,
  updateSetting,
  onSave,
  isDirty,
  localRuntimeLocked,
}: {
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => SettingsActionResult;
  isDirty: boolean;
  localRuntimeLocked: boolean;
}) {
  const tiers = [
    {
      key: 'snappy',
      label: 'Snappy local model',
      description: 'Fast local CPU work',
    },
    {
      key: 'smart',
      label: 'Smart local model',
      description: 'Balanced local CPU work',
    },
    {
      key: 'best',
      label: 'Best local model',
      description: 'Highest-quality local CPU work',
    },
  ] as const;
  return (
    <details className="group rounded-xl border border-white/[0.06] bg-white/[0.025]">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-theme-text marker:hidden">
        <span>
          Local CPU preferences
          <span className="ml-2 text-xs font-normal text-theme-text-muted">
            optional policy
          </span>
        </span>
        <span
          aria-hidden="true"
          className="text-theme-text-muted transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="space-y-4 border-t border-white/[0.06] px-4 py-4">
        <p className="text-xs leading-5 text-theme-text-muted">
          These exact tags are preferences for the fixed local CPU runtime at
          <span className="mx-1 font-mono text-theme-text">
            http://127.0.0.1:11434
          </span>
          only. They do not inspect, merge with, download to, or silently
          replace the active Remote GPU.
        </p>
        <div className={`rounded-xl border p-3 ${
          localRuntimeLocked
            ? 'border-amber-500/20 bg-amber-500/[0.05]'
            : 'border-white/[0.06] bg-black/10'
        }`}>
          <Toggle
            checked={settings['ollama.localEnabled'] !== 'false'}
            onChange={v => updateSetting('ollama.localEnabled', v ? 'true' : 'false')}
            label="Enable local CPU runtime"
            disabled={localRuntimeLocked}
            describedBy={localRuntimeLocked
              ? 'ollama-local-runtime-authority-note'
              : undefined}
          />
          {localRuntimeLocked && (
            <p
              id="ollama-local-runtime-authority-note"
              className="mt-2 text-xs leading-5 text-amber-100"
            >
              Remote GPU currently owns Ollama execution, so this switch is
              locked. You can still save local model and tier preferences;
              Portal restores the server&apos;s saved local-runtime policy
              when Remote GPU is removed.
            </p>
          )}
        </div>
        <div>
          <FieldLabel
            label="Default local CPU model"
            description="Exact Ollama tag used when no local tier is assigned"
          />
          <TextInput
            value={settings['ollama.defaultModel'] || ''}
            onChange={(value) => updateSetting('ollama.defaultModel', value)}
            placeholder="qwen3.5:4b"
            ariaLabel="Default local CPU model"
          />
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {tiers.map((tier) => (
            <div key={tier.key}>
              <FieldLabel
                label={tier.label}
                description={tier.description}
              />
              <TextInput
                value={settings[`ollama.local.tier.${tier.key}`] || ''}
                onChange={(value) => {
                  updateSetting(`ollama.local.tier.${tier.key}`, value);
                }}
                placeholder="Exact model tag"
                ariaLabel={tier.label}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <SaveButton onClick={onSave} isDirty={isDirty} />
        </div>
      </div>
    </details>
  );
}

// ── Profile Tab ───────────────────────────────────────────────────────

// ── Two-Factor Authentication Section ─────────────────────────────────

function useMailCapabilityRetry() {
  const refreshInFlightRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);

  const retry = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setRefreshing(true);
    try {
      await refreshPublicSettings();
    } finally {
      refreshInFlightRef.current = false;
      setRefreshing(false);
    }
  }, []);

  return { refreshing, retry };
}

function TwoFactorSection({ mailCapability, addToast, claimMutation, releaseMutation, mutationOwner }: {
  mailCapability?: PortalFeatureAvailability;
  addToast: (type: 'success' | 'error', msg: string) => void;
} & SettingsMutationProps) {
  const { user } = useAuthStore();
  const mailCapabilityRetry = useMailCapabilityRetry();
  const [status, setStatus] = useState<TwoFactorStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Setup flow
  const [setupData, setSetupData] = useState<TwoFactorSetupResponse | null>(null);
  const [setupStep, setSetupStep] = useState<'idle' | 'choose-method' | 'qr' | 'email-verify' | 'backup' | 'done'>('idle');
  const [setupMethod, setSetupMethod] = useState<'totp' | 'email'>('totp');
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  // Disable flow
  const [disableCode, setDisableCode] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [disableEmailSent, setDisableEmailSent] = useState(false);

  // Regenerate backup codes
  const [regenCode, setRegenCode] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [showRegen, setShowRegen] = useState(false);

  // Resend countdown for email
  const [resendCountdown, setResendCountdown] = useState(0);
  type TwoFactorAction =
    | { owner: 'settings:security:2fa-choose-method'; method: 'totp' | 'email' }
    | { owner: 'settings:security:2fa-verify-setup'; code: string; method: 'totp' | 'email' }
    | { owner: 'settings:security:2fa-resend-setup' }
    | { owner: 'settings:security:2fa-send-disable-code' }
    | { owner: 'settings:security:2fa-disable'; code: string }
    | { owner: 'settings:security:2fa-regenerate'; code: string };
  type TwoFactorCommittedMutation =
    | { kind: 'enable'; method: 'totp' | 'email'; backupCodes: string[] }
    | { kind: 'disable' }
    | { kind: 'regenerate'; backupCodes: string[] };
  const twoFactorActionRef = useRef<TwoFactorAction | null>(null);
  const twoFactorCommittedMutationRef = useRef<TwoFactorCommittedMutation | null>(null);
  const verificationFlowRef = useRef<'disable' | 'regenerate' | null>(null);
  const [twoFactorActionOwner, setTwoFactorActionOwner] = useState<TwoFactorAction['owner'] | null>(null);
  const [twoFactorCommittedMutationKind, setTwoFactorCommittedMutationKind] = useState<TwoFactorCommittedMutation['kind'] | null>(null);
  const [twoFactorError, setTwoFactorError] = useState<string | null>(null);
  const [twoFactorStatusError, setTwoFactorStatusError] = useState<string | null>(null);

  const beginTwoFactorAction = (snapshot: TwoFactorAction) => {
    if (twoFactorActionRef.current || !claimMutation(snapshot.owner)) return false;
    twoFactorActionRef.current = snapshot;
    setTwoFactorActionOwner(snapshot.owner);
    setTwoFactorError(null);
    return true;
  };

  const finishTwoFactorAction = (snapshot: TwoFactorAction) => {
    if (twoFactorActionRef.current === snapshot) twoFactorActionRef.current = null;
    setTwoFactorActionOwner(null);
    releaseMutation(snapshot.owner);
  };

  const reportTwoFactorError = (message: string) => {
    setTwoFactorError(message);
    addToast('error', message);
  };

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  const readTwoFactorStatus = useCallback(async () => authAPI.twoFactorStatus(), []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await readTwoFactorStatus();
      setStatus(s);
      setTwoFactorStatusError(null);
    } catch {
      setTwoFactorStatusError('Two-factor status could not be loaded. Retry before changing security settings.');
    } finally {
      setLoading(false);
    }
  }, [readTwoFactorStatus]);

  const convergeTwoFactorStatus = useCallback(async (
    label: string,
    accepts: (nextStatus: TwoFactorStatusResponse) => boolean,
  ) => {
    const nextStatus = await waitForSettingsConvergence({
      label,
      read: () => readTwoFactorStatus(),
      accepts,
    });
    setStatus(nextStatus);
    setTwoFactorStatusError(null);
    return nextStatus;
  }, [readTwoFactorStatus]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleStartSetup = () => {
    if (twoFactorActionRef.current || verificationFlowRef.current || twoFactorCommittedMutationRef.current) return;
    setTwoFactorError(null);
    setSetupStep('choose-method');
  };

  const openVerificationFlow = (flow: 'disable' | 'regenerate') => {
    if (twoFactorActionRef.current || verificationFlowRef.current || twoFactorCommittedMutationRef.current) return;
    if (flow === 'disable' && (emailDisableCapabilityPending || privateEmailDisableHasNoBackup)) return;
    verificationFlowRef.current = flow;
    setTwoFactorError(null);
    if (flow === 'disable') {
      setShowDisableConfirm(true);
      setDisableEmailSent(false);
      setDisableCode('');
      return;
    }
    setShowRegen(true);
    setRegenCode('');
  };

  const closeVerificationFlow = (flow: 'disable' | 'regenerate') => {
    if (twoFactorActionRef.current || twoFactorCommittedMutationRef.current || verificationFlowRef.current !== flow) return;
    verificationFlowRef.current = null;
    setTwoFactorError(null);
    if (flow === 'disable') {
      setShowDisableConfirm(false);
      setDisableCode('');
      setDisableEmailSent(false);
      return;
    }
    setShowRegen(false);
    setRegenCode('');
  };

  const handleChooseMethod = async (method: 'totp' | 'email') => {
    if (method === 'email' && mailCapability?.available !== true) return;
    const snapshot = Object.freeze({ owner: 'settings:security:2fa-choose-method' as const, method });
    if (!beginTwoFactorAction(snapshot)) return;
    setSetupMethod(snapshot.method);
    try {
      const data = await authAPI.twoFactorSetup(snapshot.method);
      setSetupData(data);
      if (snapshot.method === 'totp') {
        setSetupStep('qr');
      } else {
        setSetupStep('email-verify');
        setResendCountdown(60);
      }
    } catch (err: any) {
      reportTwoFactorError(err.response?.data?.error || 'Failed to start 2FA setup');
    } finally {
      finishTwoFactorAction(snapshot);
    }
  };

  const handleVerifySetup = async () => {
    const code = verifyCode;
    const method = setupMethod;
    if (method === 'email' && mailCapability?.available !== true) return;
    if (code.length !== 6) return;
    const snapshot = Object.freeze({ owner: 'settings:security:2fa-verify-setup' as const, code, method });
    if (!beginTwoFactorAction(snapshot)) return;
    setVerifying(true);
    let committed = twoFactorCommittedMutationRef.current;
    if (committed?.kind !== 'enable' || committed.method !== snapshot.method) committed = null;
    try {
      if (!committed) {
        const { backupCodes: codes } = await authAPI.twoFactorVerifySetup(snapshot.code, snapshot.method);
        committed = Object.freeze({ kind: 'enable' as const, method: snapshot.method, backupCodes: [...codes] });
        twoFactorCommittedMutationRef.current = committed;
        setTwoFactorCommittedMutationKind('enable');
      }
      const enableCommit = committed as Extract<TwoFactorCommittedMutation, { kind: 'enable' }>;
      await convergeTwoFactorStatus(
        'Two-factor enablement',
        (nextStatus) => nextStatus.enabled && nextStatus.method === enableCommit.method,
      );
      twoFactorCommittedMutationRef.current = null;
      setTwoFactorCommittedMutationKind(null);
      setBackupCodes(enableCommit.backupCodes);
      setSetupStep('backup');
      setVerifyCode('');
      sounds.success();
      addToast('success', 'Two-factor authentication enabled!');
    } catch (err: any) {
      sounds.error();
      reportTwoFactorError(committed
        ? 'Two-factor enablement was accepted, but its current status could not be verified. Retry status verification; the enable request will not be repeated.'
        : err.response?.data?.error || 'Invalid verification code');
    } finally {
      setVerifying(false);
      finishTwoFactorAction(snapshot);
    }
  };

  const handleResendSetupEmail = async () => {
    if (mailCapability?.available !== true) return;
    if (resendCountdown > 0) return;
    const snapshot = Object.freeze({ owner: 'settings:security:2fa-resend-setup' as const });
    if (!beginTwoFactorAction(snapshot)) return;
    try {
      await authAPI.twoFactorSetup('email');
      setResendCountdown(60);
      addToast('success', 'Verification code resent');
    } catch (err: any) {
      reportTwoFactorError(err.response?.data?.error || 'Failed to resend code');
    } finally {
      finishTwoFactorAction(snapshot);
    }
  };

  const handleSendDisableEmail = async () => {
    if (mailCapability?.available !== true) return;
    const snapshot = Object.freeze({ owner: 'settings:security:2fa-send-disable-code' as const });
    if (!beginTwoFactorAction(snapshot)) return;
    try {
      await authAPI.twoFactorSendEmailAuthenticated();
      setDisableEmailSent(true);
      setResendCountdown(60);
      addToast('success', 'Verification code sent to your email');
    } catch (err: any) {
      reportTwoFactorError(err.response?.data?.error || 'Failed to send verification code');
    } finally {
      finishTwoFactorAction(snapshot);
    }
  };

  const handleDisable = async () => {
    const code = disableCode;
    if (emailDisableCapabilityPending || privateEmailDisableHasNoBackup) return;
    if (code.length !== disableCodeLength) return;
    const snapshot = Object.freeze({ owner: 'settings:security:2fa-disable' as const, code });
    if (!beginTwoFactorAction(snapshot)) return;
    setDisabling(true);
    let committed = twoFactorCommittedMutationRef.current;
    if (committed?.kind !== 'disable') committed = null;
    try {
      if (!committed) {
        await authAPI.twoFactorDisable(snapshot.code);
        committed = Object.freeze({ kind: 'disable' as const });
        twoFactorCommittedMutationRef.current = committed;
        setTwoFactorCommittedMutationKind('disable');
      }
      await convergeTwoFactorStatus('Two-factor disablement', (nextStatus) => !nextStatus.enabled);
      twoFactorCommittedMutationRef.current = null;
      setTwoFactorCommittedMutationKind(null);
      sounds.success();
      addToast('success', 'Two-factor authentication disabled');
      setShowDisableConfirm(false);
      setDisableCode('');
      setDisableEmailSent(false);
      verificationFlowRef.current = null;
    } catch (err: any) {
      sounds.error();
      reportTwoFactorError(committed
        ? 'Two-factor disablement was accepted, but its current status could not be verified. Retry status verification; the disable request will not be repeated.'
        : err.response?.data?.error || 'Failed to disable 2FA');
    } finally {
      setDisabling(false);
      finishTwoFactorAction(snapshot);
    }
  };

  const handleRegenerateBackupCodes = async () => {
    const code = regenCode;
    if (code.length !== 6) return;
    const snapshot = Object.freeze({ owner: 'settings:security:2fa-regenerate' as const, code });
    if (!beginTwoFactorAction(snapshot)) return;
    setRegenerating(true);
    let committed = twoFactorCommittedMutationRef.current;
    if (committed?.kind !== 'regenerate') committed = null;
    try {
      if (!committed) {
        const { backupCodes: codes } = await authAPI.twoFactorRegenerateBackupCodes(snapshot.code);
        committed = Object.freeze({ kind: 'regenerate' as const, backupCodes: [...codes] });
        twoFactorCommittedMutationRef.current = committed;
        setTwoFactorCommittedMutationKind('regenerate');
      }
      const regenerateCommit = committed as Extract<TwoFactorCommittedMutation, { kind: 'regenerate' }>;
      await convergeTwoFactorStatus(
        'Backup-code regeneration',
        (nextStatus) => nextStatus.enabled && nextStatus.backupCodesRemaining === regenerateCommit.backupCodes.length,
      );
      twoFactorCommittedMutationRef.current = null;
      setTwoFactorCommittedMutationKind(null);
      setBackupCodes(regenerateCommit.backupCodes);
      setSetupStep('backup');
      setShowRegen(false);
      setRegenCode('');
      verificationFlowRef.current = null;
      sounds.success();
      addToast('success', 'Backup codes regenerated');
    } catch (err: any) {
      sounds.error();
      reportTwoFactorError(committed
        ? 'Backup-code regeneration was accepted, but its current status could not be verified. Retry status verification; new codes will not be generated again.'
        : err.response?.data?.error || 'Failed to regenerate backup codes');
    } finally {
      setRegenerating(false);
      finishTwoFactorAction(snapshot);
    }
  };

  const copyBackupCodes = async () => {
    // Never claim recovery codes are safe on the clipboard when the write was
    // refused; a user who believes this could lose account access.
    const copied = await copyTextToClipboard(backupCodes.join('\n'));
    addToast(
      copied ? 'success' : 'error',
      copied
        ? 'Backup codes copied to clipboard'
        : 'Could not copy the backup codes. Select and copy them manually before continuing.',
    );
  };

  const formatSecret = (secret: string) => {
    return secret.match(/.{1,4}/g)?.join(' ') || secret;
  };

  const isEmailMethod = status?.method === 'email';
  const mailAvailable = mailCapability?.available === true;
  const mailUnavailable = mailCapability?.available === false;
  const emailDisableUsesBackupCode = isEmailMethod && mailUnavailable;
  const emailDisableCapabilityPending = isEmailMethod && !mailCapability;
  const privateEmailDisableHasNoBackup = emailDisableUsesBackupCode
    && status?.backupCodesRemaining === 0;
  const disableCodeLength = emailDisableUsesBackupCode ? 8 : 6;
  const twoFactorBusy = Boolean(twoFactorActionOwner || mutationOwner);
  const twoFactorCannotAbandon = twoFactorBusy || Boolean(twoFactorCommittedMutationKind);
  const twoFactorErrorMessage = twoFactorError ? (
    <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">{twoFactorError}</p>
  ) : null;
  const twoFactorStatusErrorMessage = twoFactorStatusError ? (
    <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">{twoFactorStatusError}</p>
  ) : null;

  if (loading) {
    return (
      <SectionCard title="Two-Factor Authentication">
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading...
        </div>
      </SectionCard>
    );
  }

  if (!status) {
    return (
      <SectionCard title="Two-Factor Authentication">
        <div className="space-y-3">
          {twoFactorStatusErrorMessage}
          <button
            type="button"
            onClick={() => void loadStatus()}
            className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-slate-200 transition hover:bg-white/[0.08]"
          >
            <RefreshCw size={14} /> Retry status
          </button>
        </div>
      </SectionCard>
    );
  }

  // Backup codes display (shared between setup and regenerate)
  if (setupStep === 'backup' && backupCodes.length > 0) {
    return (
      <SectionCard title="Two-Factor Authentication">
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound size={18} className="text-emerald-400" />
            <h4 className="text-sm font-semibold text-white">Save your backup codes</h4>
          </div>
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <p className="text-xs text-amber-300 font-medium mb-1">⚠ Important</p>
            <p className="text-xs text-amber-200/80">
              Store these codes in a safe place. Each code can only be used once. You won't be able to see them again.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 p-4 rounded-lg bg-black/30 border border-white/[0.08]">
            {backupCodes.map((code, i) => (
              <div key={i} className="font-mono text-sm text-slate-200 text-center py-1">
                {code}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={copyBackupCodes}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-slate-200 hover:bg-white/[0.08] transition-all"
            >
              <Copy size={14} /> Copy all
            </button>
            <button
              onClick={() => { setSetupStep('done'); setBackupCodes([]); }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/20 border border-emerald-500/20 text-sm text-emerald-400 hover:bg-emerald-500/30 transition-all"
            >
              <Check size={14} /> Done
            </button>
          </div>
        </div>
      </SectionCard>
    );
  }

  // Method choice step
  if (setupStep === 'choose-method') {
    return (
      <SectionCard title="Two-Factor Authentication">
        <div className="space-y-4">
          <p className="text-sm text-slate-400">Choose your preferred verification method:</p>
          {twoFactorErrorMessage}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              onClick={() => handleChooseMethod('totp')}
              disabled={twoFactorBusy}
              aria-busy={twoFactorActionOwner === 'settings:security:2fa-choose-method' && setupMethod === 'totp'}
              className="p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-emerald-500/30 transition-all text-left group disabled:opacity-50"
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/15 flex items-center justify-center">
                  <Shield size={20} className="text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white group-hover:text-emerald-400 transition-colors">Authenticator App</p>
                  <p className="text-xs text-slate-500">Google Authenticator, Authy, etc.</p>
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-2">
                Use a time-based code from your authenticator app. Works offline.
              </p>
            </button>
            {mailAvailable ? (
              <button
                onClick={() => handleChooseMethod('email')}
                disabled={twoFactorBusy}
                aria-busy={twoFactorActionOwner === 'settings:security:2fa-choose-method' && setupMethod === 'email'}
                className="p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-blue-500/30 transition-all text-left group disabled:opacity-50"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/15 flex items-center justify-center">
                    <Mail size={20} className="text-blue-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors">Email Code</p>
                    <p className="text-xs text-slate-500">Receive codes via email</p>
                  </div>
                </div>
                <p className="text-xs text-slate-400 mt-2">
                  We'll send a verification code to your email each time you sign in.
                </p>
              </button>
            ) : (
              <div
                role={mailUnavailable ? 'note' : 'status'}
                className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-left"
              >
                <div className="mb-2 flex items-center gap-3">
                  {mailUnavailable ? <AlertCircle size={20} className="text-amber-300" /> : <Loader2 size={20} className="animate-spin text-slate-400" />}
                  <p className="text-sm font-semibold text-slate-200">
                    {mailUnavailable ? 'Email Code is unavailable' : 'Checking Email Code availability'}
                  </p>
                </div>
                <p className="text-xs leading-5 text-slate-400">
                  {mailUnavailable
                    ? mailCapability.reason || 'Email Code requires working Portal mail delivery.'
                    : 'Portal must confirm mail delivery before it can offer email-based two-factor authentication.'}
                </p>
                {!mailCapability && (
                  <button
                    type="button"
                    onClick={() => void mailCapabilityRetry.retry()}
                    disabled={mailCapabilityRetry.refreshing}
                    aria-busy={mailCapabilityRetry.refreshing}
                    className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200 underline underline-offset-2 disabled:opacity-50"
                  >
                    {mailCapabilityRetry.refreshing
                      ? <><Loader2 size={12} className="animate-spin" /> Retrying availability check…</>
                      : <><RefreshCw size={12} /> Retry availability check</>}
                  </button>
                )}
              </div>
            )}
          </div>
          {twoFactorActionOwner === 'settings:security:2fa-choose-method' && (
            <p role="status" className="flex items-center gap-2 text-xs text-slate-300">
              <Loader2 size={13} className="animate-spin" /> Starting {setupMethod === 'email' ? 'email' : 'authenticator'} setup…
            </p>
          )}
          <button
            onClick={() => { if (!twoFactorActionRef.current && !twoFactorCommittedMutationRef.current) setSetupStep('idle'); }}
            disabled={twoFactorCannotAbandon}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </SectionCard>
    );
  }

  // Email verify step (during setup)
  if (setupStep === 'email-verify') {
    if (!mailAvailable) {
      return (
        <SectionCard title="Two-Factor Authentication">
          <div className="space-y-3">
            <p role={mailUnavailable ? 'alert' : 'status'} className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
              {mailUnavailable
                ? mailCapability.reason || 'Email Code setup cannot continue because Portal mail is unavailable.'
                : 'Email Code setup is paused until Portal confirms mail availability.'}
            </p>
            {!mailCapability && (
              <button
                type="button"
                onClick={() => void mailCapabilityRetry.retry()}
                disabled={mailCapabilityRetry.refreshing}
                aria-busy={mailCapabilityRetry.refreshing}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-200 underline underline-offset-2 disabled:opacity-50"
              >
                {mailCapabilityRetry.refreshing
                  ? <><Loader2 size={12} className="animate-spin" /> Retrying availability check…</>
                  : <><RefreshCw size={12} /> Retry availability check</>}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (twoFactorActionRef.current || twoFactorCommittedMutationRef.current) return;
                setSetupStep('choose-method');
                setSetupData(null);
                setVerifyCode('');
                setTwoFactorError(null);
              }}
              disabled={twoFactorCannotAbandon}
              className="text-xs text-slate-300 hover:text-white transition-colors disabled:opacity-50"
            >
              Choose Authenticator App instead
            </button>
          </div>
        </SectionCard>
      );
    }
    return (
      <SectionCard title="Two-Factor Authentication">
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Mail size={18} className="text-blue-400" />
            <h4 className="text-sm font-semibold text-white">Verify your email</h4>
          </div>
          <p className="text-xs text-slate-400">
            We sent a verification code to <strong className="text-slate-200">{user?.email}</strong>. Enter it below to enable email-based 2FA.
          </p>
          {twoFactorErrorMessage}
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                aria-label="Email verification code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                value={verifyCode}
                onChange={e => {
                  if (!twoFactorActionRef.current) setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                }}
                disabled={twoFactorCannotAbandon}
                placeholder="000000"
                maxLength={6}
                className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all font-mono text-center tracking-[0.3em]"
              />
              <button
                onClick={handleVerifySetup}
                disabled={verifyCode.length !== 6 || twoFactorBusy}
                aria-busy={verifying}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  verifyCode.length === 6
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30'
                    : 'bg-white/[0.04] text-slate-500 border border-white/[0.06] cursor-not-allowed'
                }`}
              >
                {verifying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {verifying
                  ? twoFactorCommittedMutationKind === 'enable' ? 'Verifying enabled status…' : 'Enabling 2FA…'
                  : twoFactorCommittedMutationKind === 'enable' ? 'Verify enabled status' : 'Verify & Enable'}
              </button>
            </div>
            <button
              onClick={handleResendSetupEmail}
              disabled={resendCountdown > 0 || twoFactorBusy}
              aria-busy={twoFactorActionOwner === 'settings:security:2fa-resend-setup'}
              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} />
              {twoFactorActionOwner === 'settings:security:2fa-resend-setup' ? 'Resending code…' : resendCountdown > 0 ? `Resend code (${resendCountdown}s)` : 'Resend code'}
            </button>
          </div>
          <button
            onClick={() => {
              if (twoFactorActionRef.current || twoFactorCommittedMutationRef.current) return;
              setSetupStep('idle');
              setSetupData(null);
              setVerifyCode('');
              setTwoFactorError(null);
            }}
            disabled={twoFactorCannotAbandon}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
          >
            Cancel setup
          </button>
        </div>
      </SectionCard>
    );
  }

  // Setup QR code step (TOTP)
  if (setupStep === 'qr' && setupData) {
    return (
      <SectionCard title="Two-Factor Authentication">
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Shield size={18} className="text-emerald-400" />
            <h4 className="text-sm font-semibold text-white">Scan QR Code</h4>
          </div>
          <p className="text-xs text-slate-400">
            Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)
          </p>
          {twoFactorErrorMessage}
          <div className="flex justify-center py-4">
            <div className="p-4 bg-white rounded-xl">
              <Suspense fallback={<div className="h-[180px] w-[180px] rounded bg-slate-100 dark:bg-white/5" />}>
                <LazyQRCodeSVG value={setupData.otpauthUrl!} size={180} />
              </Suspense>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs text-slate-500">Can't scan? Enter this key manually:</p>
            <div className="p-3 rounded-lg bg-black/30 border border-white/[0.08]">
              <p className="font-mono text-xs text-emerald-400 text-center tracking-widest select-all">
                {formatSecret(setupData.secret!)}
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs text-slate-400">Enter the 6-digit verification code from your app:</p>
            <div className="flex gap-2">
              <input
                aria-label="Authenticator verification code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                value={verifyCode}
                onChange={e => {
                  if (!twoFactorActionRef.current) setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                }}
                disabled={twoFactorCannotAbandon}
                placeholder="000000"
                maxLength={6}
                className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all font-mono text-center tracking-[0.3em]"
              />
              <button
                onClick={handleVerifySetup}
                disabled={verifyCode.length !== 6 || twoFactorBusy}
                aria-busy={verifying}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  verifyCode.length === 6
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30'
                    : 'bg-white/[0.04] text-slate-500 border border-white/[0.06] cursor-not-allowed'
                }`}
              >
                {verifying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {verifying
                  ? twoFactorCommittedMutationKind === 'enable' ? 'Verifying enabled status…' : 'Enabling 2FA…'
                  : twoFactorCommittedMutationKind === 'enable' ? 'Verify enabled status' : 'Verify & Enable'}
              </button>
            </div>
          </div>
          <button
            onClick={() => {
              if (twoFactorActionRef.current || twoFactorCommittedMutationRef.current) return;
              setSetupStep('idle');
              setSetupData(null);
              setVerifyCode('');
              setTwoFactorError(null);
            }}
            disabled={twoFactorCannotAbandon}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-50"
          >
            Cancel setup
          </button>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Two-Factor Authentication">
      {twoFactorStatusErrorMessage}
      {status.enabled ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              {isEmailMethod ? <Mail size={18} className="text-blue-400" /> : <Shield size={18} className="text-emerald-400" />}
              <span className="text-sm font-medium text-white">Status</span>
            </div>
            <span className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
              Enabled
            </span>
            <span className="px-2 py-0.5 rounded text-xs text-slate-400 bg-white/[0.04] border border-white/[0.06]">
              {isEmailMethod ? 'Email' : 'Authenticator App'}
            </span>
          </div>
          {status.backupCodesRemaining > 0 && (
            <p className="text-xs text-slate-500">
              {status.backupCodesRemaining} backup code{status.backupCodesRemaining !== 1 ? 's' : ''} remaining
            </p>
          )}
          {isEmailMethod && mailUnavailable && (
            <div role="note" className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100">
              <p className="font-semibold">Email Code delivery is unavailable.</p>
              {privateEmailDisableHasNoBackup ? (
                <p className="mt-1">
                  No backup codes remain. Sign out, sign in again with your password, then use the Email Code recovery option on the login screen.
                </p>
              ) : (
                <p className="mt-1">
                  {mailCapability.reason || 'This Portal cannot deliver email verification codes.'}
                  {' '}Use one remaining backup code to disable Email Code 2FA, then enable Authenticator App.
                </p>
              )}
            </div>
          )}
          {emailDisableCapabilityPending && (
            <div role="status" className="rounded-lg border border-white/[0.08] bg-white/[0.03] p-3 text-xs text-slate-300">
              <p className="flex items-center gap-2">
                <Loader2 size={13} className="animate-spin" /> Checking mail availability before allowing Email Code changes…
              </p>
              <button
                type="button"
                onClick={() => void mailCapabilityRetry.retry()}
                disabled={mailCapabilityRetry.refreshing}
                aria-busy={mailCapabilityRetry.refreshing}
                className="mt-2 inline-flex items-center gap-1.5 font-semibold text-slate-200 underline underline-offset-2 disabled:opacity-50"
              >
                {mailCapabilityRetry.refreshing
                  ? <><Loader2 size={12} className="animate-spin" /> Retrying availability check…</>
                  : <><RefreshCw size={12} /> Retry availability check</>}
              </button>
            </div>
          )}
          {twoFactorErrorMessage}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => openVerificationFlow('disable')}
              disabled={twoFactorBusy || Boolean(verificationFlowRef.current) || emailDisableCapabilityPending || privateEmailDisableHasNoBackup}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-400 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-all disabled:opacity-50"
            >
              <X size={14} /> Disable 2FA
            </button>
            {!isEmailMethod && (
              <button
                onClick={() => openVerificationFlow('regenerate')}
                disabled={twoFactorBusy || Boolean(verificationFlowRef.current)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-blue-400 bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 transition-all disabled:opacity-50"
              >
                <KeyRound size={14} /> Regenerate Backup Codes
              </button>
            )}
          </div>

          {/* Disable confirmation */}
          {showDisableConfirm && (
            <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20 space-y-3">
              <p className="text-sm text-red-400 font-medium">Confirm disable 2FA</p>
              {isEmailMethod && mailAvailable && !disableEmailSent ? (
                <>
                  <p className="text-xs text-slate-400">We need to verify your identity. Click below to receive a verification code.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleSendDisableEmail}
                      disabled={twoFactorBusy}
                      aria-busy={twoFactorActionOwner === 'settings:security:2fa-send-disable-code'}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30 transition-all disabled:opacity-50"
                    >
                      {twoFactorActionOwner === 'settings:security:2fa-send-disable-code' ? 'Sending verification code…' : 'Send verification code'}
                    </button>
                    <button
                      onClick={() => closeVerificationFlow('disable')}
                      disabled={twoFactorCannotAbandon}
                      className="px-3 py-2 rounded-lg text-sm text-slate-400 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-all disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-400">
                    {emailDisableUsesBackupCode
                      ? 'Enter one of your remaining 8-character backup codes. It will be consumed when Email Code 2FA is disabled:'
                      : isEmailMethod
                        ? 'Enter the verification code sent to your email:'
                        : 'Enter your current authenticator code to confirm:'}
                  </p>
                  <div className="flex gap-2">
                    <input
                      aria-label="Code to disable two-factor authentication"
                      type="text"
                      inputMode={emailDisableUsesBackupCode ? 'text' : 'numeric'}
                      pattern={emailDisableUsesBackupCode ? '[A-Za-z0-9]*' : '[0-9]*'}
                      autoComplete="one-time-code"
                      value={disableCode}
                      onChange={e => {
                        if (twoFactorActionRef.current) return;
                        setDisableCode(emailDisableUsesBackupCode
                          ? e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
                          : e.target.value.replace(/\D/g, '').slice(0, 6));
                      }}
                      disabled={twoFactorCannotAbandon}
                      placeholder={emailDisableUsesBackupCode ? 'Ab3dE7xQ' : '000000'}
                      maxLength={disableCodeLength}
                      className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-red-500/30 transition-all font-mono text-center tracking-[0.3em]"
                    />
                    <button
                      aria-label="Disable two-factor authentication"
                      onClick={handleDisable}
                      disabled={disableCode.length !== disableCodeLength || twoFactorBusy}
                      aria-busy={disabling}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30 disabled:opacity-50 transition-all"
                    >
                      {disabling
                        ? <><Loader2 size={14} className="animate-spin" /> {twoFactorCommittedMutationKind === 'disable' ? 'Verifying disabled status…' : 'Disabling…'}</>
                        : twoFactorCommittedMutationKind === 'disable' ? 'Verify disabled status' : 'Disable'}
                    </button>
                    <button
                      onClick={() => closeVerificationFlow('disable')}
                      disabled={twoFactorCannotAbandon}
                      className="px-3 py-2 rounded-lg text-sm text-slate-400 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-all disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Regenerate backup codes */}
          {showRegen && !isEmailMethod && (
            <div className="p-4 rounded-lg bg-blue-500/5 border border-blue-500/20 space-y-3">
              <p className="text-sm text-blue-400 font-medium">Regenerate backup codes</p>
              <p className="text-xs text-slate-400">
                Enter your current authenticator code to generate new backup codes:
              </p>
              <div className="flex gap-2">
                <input
                  aria-label="Code to regenerate backup codes"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  value={regenCode}
                  onChange={e => {
                    if (!twoFactorActionRef.current) setRegenCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                  }}
                  disabled={twoFactorCannotAbandon}
                  placeholder="000000"
                  maxLength={6}
                  className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/30 transition-all font-mono text-center tracking-[0.3em]"
                />
                <button
                  aria-label="Regenerate backup codes"
                  onClick={handleRegenerateBackupCodes}
                  disabled={regenCode.length !== 6 || twoFactorBusy}
                  aria-busy={regenerating}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500/20 text-blue-400 border border-blue-500/20 hover:bg-blue-500/30 disabled:opacity-50 transition-all"
                >
                  {regenerating
                    ? <><Loader2 size={14} className="animate-spin" /> {twoFactorCommittedMutationKind === 'regenerate' ? 'Verifying regenerated status…' : 'Regenerating…'}</>
                    : twoFactorCommittedMutationKind === 'regenerate' ? 'Verify regenerated status' : 'Regenerate'}
                </button>
                <button
                  onClick={() => closeVerificationFlow('regenerate')}
                  disabled={twoFactorCannotAbandon}
                  className="px-3 py-2 rounded-lg text-sm text-slate-400 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-all disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Add an extra layer of security to your account by requiring a verification code at sign-in.
          </p>
          <button
            onClick={handleStartSetup}
            disabled={twoFactorBusy}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30 transition-all disabled:opacity-50"
          >
            <Shield size={16} /> Enable Two-Factor Authentication
          </button>
        </div>
      )}
    </SectionCard>
  );
}

function ProfileTab({ mailCapability, addToast, claimMutation, releaseMutation, mutationOwner }: {
  mailCapability?: PortalFeatureAvailability;
  addToast: (type: 'success' | 'error', msg: string) => void;
} & SettingsMutationProps) {
  const { user, silentLogout } = useAuthStore();
  const navigate = useNavigate();
  const mailCapabilityRetry = useMailCapabilityRetry();
  const [username, setUsername] = useState(user?.username || '');
  const [email, setEmail] = useState(user?.email || '');
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profilePassword, setProfilePassword] = useState('');
  const [profileTwoFactorToken, setProfileTwoFactorToken] = useState('');
  const [profileTwoFactorStatus, setProfileTwoFactorStatus] = useState<TwoFactorStatusResponse | null>(null);
  const [profileTwoFactorStatusLoading, setProfileTwoFactorStatusLoading] = useState(true);
  const [profileTwoFactorStatusError, setProfileTwoFactorStatusError] = useState<string | null>(null);
  const [profileCodeSending, setProfileCodeSending] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  type ProfileAction =
    | { owner: 'settings:profile:send-code' }
    | { owner: 'settings:profile:update'; username: string; email: string; currentPassword: string; twoFactorToken: string }
    | { owner: 'settings:profile:password'; currentPassword: string; newPassword: string };
  const profileActionRef = useRef<ProfileAction | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const profileSurfaceBusy = Boolean(mutationOwner);
  const emailTwoFactorIdentityBlocked = profileTwoFactorStatus?.enabled
    && profileTwoFactorStatus.method === 'email'
    && mailCapability?.available !== true;
  const profileIdentityBlocked = profileTwoFactorStatusLoading
    || Boolean(profileTwoFactorStatusError)
    || emailTwoFactorIdentityBlocked;

  const beginProfileAction = (snapshot: ProfileAction) => {
    if (profileActionRef.current || !claimMutation(snapshot.owner)) return false;
    profileActionRef.current = snapshot;
    return true;
  };

  const finishProfileAction = (snapshot: ProfileAction) => {
    if (profileActionRef.current !== snapshot) return;
    profileActionRef.current = null;
    releaseMutation(snapshot.owner);
  };

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setEmail(user.email);
    }
  }, [user]);

  const loadProfileTwoFactorStatus = useCallback(async () => {
    setProfileTwoFactorStatusLoading(true);
    try {
      const nextStatus = await authAPI.twoFactorStatus();
      setProfileTwoFactorStatus(nextStatus);
      setProfileTwoFactorStatusError(null);
    } catch {
      setProfileTwoFactorStatus(null);
      setProfileTwoFactorStatusError(
        'Two-factor status could not be verified. Identity changes stay locked until this check succeeds.',
      );
    } finally {
      setProfileTwoFactorStatusLoading(false);
    }
  }, []);

  useEffect(() => { void loadProfileTwoFactorStatus(); }, [loadProfileTwoFactorStatus]);

  const handleSendProfileCode = async () => {
    if (profileIdentityBlocked) return;
    const snapshot = Object.freeze({ owner: 'settings:profile:send-code' as const });
    if (!beginProfileAction(snapshot)) return;
    setProfileError(null);
    setProfileCodeSending(true);
    try {
      await authAPI.twoFactorSendEmailAuthenticated();
      addToast('success', 'Verification code sent');
    } catch (err: any) {
      const message = err.response?.data?.error || 'Failed to send verification code';
      setProfileError(message);
      addToast('error', message);
    } finally {
      setProfileCodeSending(false);
      finishProfileAction(snapshot);
    }
  };

  const handleProfileSave = async () => {
    if (profileIdentityBlocked) return;
    const snapshot = Object.freeze({
      owner: 'settings:profile:update' as const,
      username,
      email,
      currentPassword: profilePassword,
      twoFactorToken: profileTwoFactorToken,
    });
    if (!beginProfileAction(snapshot)) return;
    setProfileError(null);
    setProfileSaving(true);
    try {
      await client.put('/auth/me', {
        username: snapshot.username,
        email: snapshot.email,
        currentPassword: snapshot.currentPassword,
        ...(snapshot.twoFactorToken ? { twoFactorToken: snapshot.twoFactorToken } : {}),
      });
      setProfileDirty(false);
      setProfilePassword('');
      setProfileTwoFactorToken('');
      setProfileSaving(false);
      finishProfileAction(snapshot);
      silentLogout();
      sounds.success();
      navigate('/login?identity=changed', { replace: true });
      return;
    } catch (err: any) {
      sounds.error();
      const message = err.response?.data?.error || 'Failed to update profile';
      setProfileError(message);
      addToast('error', message);
    } finally {
      if (profileActionRef.current === snapshot) {
        setProfileSaving(false);
        finishProfileAction(snapshot);
      }
    }
  };

  const handlePasswordChange = async () => {
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      addToast('error', 'Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      addToast('error', 'Password must be at least 8 characters');
      return;
    }
    const snapshot = Object.freeze({
      owner: 'settings:profile:password' as const,
      currentPassword,
      newPassword,
    });
    if (!beginProfileAction(snapshot)) return;
    setPasswordError(null);
    setPasswordSaving(true);
    try {
      await client.post('/auth/change-password', {
        currentPassword: snapshot.currentPassword,
        newPassword: snapshot.newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSaving(false);
      finishProfileAction(snapshot);
      silentLogout();
      sounds.success();
      navigate('/login?password=changed', { replace: true });
      return;
    } catch (err: any) {
      sounds.error();
      const message = err.response?.data?.error || 'Failed to change password';
      setPasswordError(message);
      addToast('error', message);
    } finally {
      if (profileActionRef.current === snapshot) {
        setPasswordSaving(false);
        finishProfileAction(snapshot);
      }
    }
  };

  return (
    <div>
      <SectionCard title="Profile Information">
        <div className="space-y-4">
          {profileTwoFactorStatusLoading && (
            <p role="status" className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] p-3 text-xs text-slate-300">
              <Loader2 size={13} className="animate-spin" /> Checking profile security requirements…
            </p>
          )}
          {profileTwoFactorStatusError && (
            <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">
              <p>{profileTwoFactorStatusError}</p>
              <button
                type="button"
                onClick={() => void loadProfileTwoFactorStatus()}
                disabled={profileTwoFactorStatusLoading || profileSurfaceBusy}
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-red-100 underline underline-offset-2 disabled:opacity-50"
              >
                <RefreshCw size={12} /> Retry security check
              </button>
            </div>
          )}
          {emailTwoFactorIdentityBlocked && (
            <div role={mailCapability ? 'alert' : 'status'} className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100">
              <p className="font-semibold">Profile identity changes are temporarily unavailable.</p>
              <p className="mt-1 text-xs">
                {mailCapability
                  ? `${mailCapability.reason || 'Portal mail delivery is unavailable.'} Use a remaining backup code in Two-Factor Authentication to disable Email Code, then enable Authenticator App before changing your username or email.`
                  : 'Portal is checking mail availability. Username and email changes stay locked until Email Code verification can be proven.'}
              </p>
              {!mailCapability && (
                <button
                  type="button"
                  onClick={() => void mailCapabilityRetry.retry()}
                  disabled={mailCapabilityRetry.refreshing || profileSurfaceBusy}
                  aria-busy={mailCapabilityRetry.refreshing}
                  className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-50 underline underline-offset-2 disabled:opacity-50"
                >
                  {mailCapabilityRetry.refreshing
                    ? <><Loader2 size={12} className="animate-spin" /> Retrying availability check…</>
                    : <><RefreshCw size={12} /> Retry availability check</>}
                </button>
              )}
            </div>
          )}
          <div>
            <FieldLabel label="Username" />
            <TextInput
              value={username}
              onChange={v => {
                if (profileActionRef.current) return;
                setUsername(v);
                setProfileDirty(true);
              }}
              placeholder="Your username"
              ariaLabel="Username"
              disabled={profileSurfaceBusy || profileIdentityBlocked}
            />
          </div>
          <div>
            <FieldLabel label="Email" />
            <TextInput
              value={email}
              onChange={v => {
                if (profileActionRef.current) return;
                setEmail(v);
                setProfileDirty(true);
              }}
              placeholder="your@email.com"
              ariaLabel="Email address"
              disabled={profileSurfaceBusy || profileIdentityBlocked}
            />
          </div>
          <div>
            <FieldLabel label="Current Password" description="Required to change your username or email." />
            <TextInput
              value={profilePassword}
              onChange={(value) => { if (!profileActionRef.current) setProfilePassword(value); }}
              placeholder="Confirm your current password"
              type="password"
              ariaLabel="Current password for profile changes"
              disabled={profileSurfaceBusy || profileIdentityBlocked}
            />
          </div>
          {profileTwoFactorStatus?.enabled && (
            <div>
              <FieldLabel
                label="Two-Factor Code"
                description="A fresh code is required because two-factor authentication is enabled."
              />
              <div className="flex gap-2">
                <TextInput
                  value={profileTwoFactorToken}
                  onChange={(value) => { if (!profileActionRef.current) setProfileTwoFactorToken(value); }}
                  placeholder={profileTwoFactorStatus.method === 'email' ? 'Email verification code' : 'Authenticator code'}
                  ariaLabel="Two-factor code for profile changes"
                  disabled={profileSurfaceBusy || profileIdentityBlocked}
                />
                {profileTwoFactorStatus.method === 'email' && mailCapability?.available === true && (
                  <button
                    type="button"
                    aria-label="Send profile verification code"
                    onClick={handleSendProfileCode}
                    disabled={profileSurfaceBusy}
                    aria-busy={profileCodeSending}
                    className="shrink-0 px-3 py-2 rounded-lg border border-white/[0.08] text-sm text-slate-300 hover:bg-white/[0.05] disabled:opacity-50"
                  >
                    {profileCodeSending ? <><Loader2 size={16} className="inline animate-spin" /> Sending…</> : 'Send code'}
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="text-xs text-slate-500">
            Role: <span className="text-slate-300 font-medium">{user?.role}</span>
          </div>
          {profileError && <p role="alert" className="text-sm text-red-300">{profileError}</p>}
        </div>
        <div className="flex justify-end mt-4">
          <SaveButton
            onClick={handleProfileSave}
            isDirty={profileDirty && Boolean(profilePassword) && (!profileTwoFactorStatus?.enabled || Boolean(profileTwoFactorToken))}
            saving={profileSaving}
            disabled={profileSurfaceBusy || profileIdentityBlocked}
          />
        </div>
      </SectionCard>

      <SectionCard title="Change Password">
        <div className="space-y-4 max-w-md">
          <div>
            <FieldLabel label="Current Password" />
            <div className="relative">
              <input
                type={showCurrentPw ? 'text' : 'password'}
                value={currentPassword}
                onChange={e => { if (!profileActionRef.current) setCurrentPassword(e.target.value); }}
                disabled={profileSurfaceBusy}
                placeholder="Enter current password"
                aria-label="Current password"
                className="w-full px-3 py-2 pr-10 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowCurrentPw(!showCurrentPw)}
                disabled={profileSurfaceBusy}
                aria-label={showCurrentPw ? 'Hide current password' : 'Show current password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showCurrentPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div>
            <FieldLabel label="New Password" />
            <div className="relative">
              <input
                type={showNewPw ? 'text' : 'password'}
                value={newPassword}
                onChange={e => { if (!profileActionRef.current) setNewPassword(e.target.value); }}
                disabled={profileSurfaceBusy}
                placeholder="At least 8 characters"
                aria-label="New password"
                className="w-full px-3 py-2 pr-10 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowNewPw(!showNewPw)}
                disabled={profileSurfaceBusy}
                aria-label={showNewPw ? 'Hide new password' : 'Show new password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                {showNewPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div>
            <FieldLabel label="Confirm New Password" />
            <input
              type="password"
              value={confirmPassword}
              onChange={e => { if (!profileActionRef.current) setConfirmPassword(e.target.value); }}
              disabled={profileSurfaceBusy}
              placeholder="Repeat new password"
              aria-label="Confirm new password"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all"
            />
          </div>
          {passwordError && <p role="alert" className="text-sm text-red-300">{passwordError}</p>}
        </div>
        <div className="flex justify-end mt-4">
          <button
            onClick={handlePasswordChange}
            disabled={!currentPassword || !newPassword || !confirmPassword || profileSurfaceBusy}
            aria-busy={passwordSaving}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              currentPassword && newPassword && confirmPassword
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30'
                : 'bg-white/[0.04] text-slate-500 border border-white/[0.06] cursor-not-allowed'
            }`}
          >
            {passwordSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {passwordSaving ? 'Changing password…' : 'Change Password'}
          </button>
        </div>
      </SectionCard>

      {/* Sound Preferences */}
      <SoundPreferencesSection />

      {/* Two-Factor Authentication (only shown for non-elevated users; elevated users see it in Security tab) */}
      {!isElevated(user) && (
        <TwoFactorSection
          mailCapability={mailCapability}
          addToast={addToast}
          claimMutation={claimMutation}
          releaseMutation={releaseMutation}
          mutationOwner={mutationOwner}
        />
      )}
    </div>
  );
}

// ── Sound Preferences Section ─────────────────────────────────────────

function SoundPreferencesSection() {
  const [enabled, setEnabled] = useState(sounds.isEnabled());
  const [volume, setVolume] = useState(Math.round(sounds.getVolume() * 100));

  const handleToggle = () => {
    if (enabled) {
      // Turning off: play toggleOff THEN disable
      sounds.toggleOff();
      setTimeout(() => {
        sounds.setEnabled(false);
        setEnabled(false);
      }, 80);
    } else {
      // Turning on: enable THEN play toggleOn
      sounds.setEnabled(true);
      setEnabled(true);
      setTimeout(() => sounds.toggleOn(), 50);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    setVolume(v);
    sounds.setVolume(v / 100);
  };

  return (
    <SectionCard title="Sound Effects">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-theme-text">Enable Sound Effects</div>
            <div className="text-xs text-theme-text-muted mt-0.5">Play UI sounds for clicks, notifications, and actions</div>
          </div>
          <button
            onClick={handleToggle}
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable sound effects"
            className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? '' : 'bg-white/[0.08]'}`}
            style={enabled ? { background: 'var(--accent-bg, rgba(99,102,241,0.3))' } : undefined}
          >
            <div
              className={`absolute top-0.5 w-5 h-5 rounded-full transition-all shadow-sm ${
                enabled ? 'left-[22px]' : 'left-0.5 bg-slate-400'
              }`}
              style={enabled ? { background: 'var(--accent, #6366f1)' } : undefined}
            />
          </button>
        </div>
        {enabled && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-theme-text-muted">Volume</span>
              <span className="text-xs text-theme-text-muted tabular-nums">{volume}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={handleVolumeChange}
              aria-label="Sound effects volume"
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-white/[0.08] accent-violet-500"
              style={{ accentColor: 'var(--accent, #6366f1)' }}
            />
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ── Main Component ────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user } = useAuthStore();
  const publicSettings = usePublicSettings();
  const mailCapability = publicSettings?.mail;
  const { navigator: routerNavigator } = useContext(UNSAFE_NavigationContext);
  const isOwner = isOwnerRole(user?.role);
  const [searchParams, setSearchParams] = useSearchParams();
  const allowedTabIds = settingsTabIdsForRole(user?.role);
  const tabs = allTabs.filter((tab) => allowedTabIds.includes(tab.id));
  const activeTab = resolveSettingsTab(user?.role, searchParams.get('tab'));
  const tailnetSetupRequested = searchParams.get('ollama') === 'tailnet';
  const tailnetSetupRef = useRef<HTMLDivElement | null>(null);
  const [showSetupHandoff, setShowSetupHandoff] = useState(
    searchParams.get('setup') === 'complete',
  );
  const { toasts, add: addToast } = useToasts();
  const settingsMutationOwnerRef = useRef<string | null>(null);
  const [settingsMutationOwner, setSettingsMutationOwner] = useState<string | null>(null);
  const embedPolicyDirtyRef = useRef(false);
  const [embedPolicyDirty, setEmbedPolicyDirty] = useState(false);
  const [embedPolicyNavigationAttemptVersion, setEmbedPolicyNavigationAttemptVersion] = useState(0);
  const releaseNavigationLockRef = useRef<(() => void) | null>(null);
  const mutationNavigationGuardRef = useRef<{
    url: string;
    state: unknown;
    historyIndex: number | null;
  } | null>(null);

  const releaseNavigationLock = useCallback(() => {
    releaseNavigationLockRef.current?.();
    releaseNavigationLockRef.current = null;
    mutationNavigationGuardRef.current = null;
  }, []);

  const releaseNavigationLockIfIdle = useCallback(() => {
    if (settingsMutationOwnerRef.current || embedPolicyDirtyRef.current) return;
    releaseNavigationLock();
  }, [releaseNavigationLock]);

  const acquireNavigationLock = useCallback(() => {
    if (releaseNavigationLockRef.current) return;
    const originalPush = routerNavigator.push;
    const originalReplace = routerNavigator.replace;
    const originalGo = routerNavigator.go;
    const blockedPush: typeof routerNavigator.push = () => undefined;
    const blockedReplace: typeof routerNavigator.replace = () => undefined;
    const blockedGo: typeof routerNavigator.go = () => undefined;

    routerNavigator.push = blockedPush;
    routerNavigator.replace = blockedReplace;
    routerNavigator.go = blockedGo;
    const browserHistoryIndex = window.history.state?.idx;
    mutationNavigationGuardRef.current = {
      url: window.location.href,
      state: window.history.state,
      historyIndex: typeof browserHistoryIndex === 'number' ? browserHistoryIndex : null,
    };
    releaseNavigationLockRef.current = () => {
      if (routerNavigator.push === blockedPush) routerNavigator.push = originalPush;
      if (routerNavigator.replace === blockedReplace) routerNavigator.replace = originalReplace;
      if (routerNavigator.go === blockedGo) routerNavigator.go = originalGo;
    };
  }, [routerNavigator]);

  const claimMutation = useCallback<SettingsMutationClaim>((owner) => {
    if (settingsMutationOwnerRef.current) return false;
    settingsMutationOwnerRef.current = owner;
    acquireNavigationLock();
    setSettingsMutationOwner(owner);
    return true;
  }, [acquireNavigationLock]);

  const releaseMutation = useCallback<SettingsMutationRelease>((owner) => {
    if (settingsMutationOwnerRef.current !== owner) return;
    settingsMutationOwnerRef.current = null;
    setSettingsMutationOwner(null);
    releaseNavigationLockIfIdle();
  }, [releaseNavigationLockIfIdle]);

  const handleEmbedPolicyDirtyChange = useCallback((dirty: boolean) => {
    if (embedPolicyDirtyRef.current === dirty) return;
    embedPolicyDirtyRef.current = dirty;
    setEmbedPolicyDirty(dirty);
    if (dirty) {
      acquireNavigationLock();
      return;
    }
    setEmbedPolicyNavigationAttemptVersion(0);
    releaseNavigationLockIfIdle();
  }, [acquireNavigationLock, releaseNavigationLockIfIdle]);

  const reportEmbedPolicyNavigationAttempt = useCallback(() => {
    if (!embedPolicyDirtyRef.current) return;
    setEmbedPolicyNavigationAttemptVersion((current) => current + 1);
  }, []);

  const mutationCoordinator = useMemo(() => ({
    owner: settingsMutationOwner,
    claim: claimMutation,
    release: releaseMutation,
  }), [claimMutation, releaseMutation, settingsMutationOwner]);

  // Admin settings state
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [draftSettings, setDraftSettings] = useState<Record<string, string>>({});
  const draftSettingsRef = useRef<Record<string, string>>({});
  const dirtySettingKeysRef = useRef<Set<string>>(new Set());
  const portalSettingsLoadSequenceRef = useRef(0);
  const tailnetAuthoritySignatureRef = useRef<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<{ tab: TabId; message: string } | null>(null);
  const [nativeOllamaAuthorityPresent, setNativeOllamaAuthorityPresent] =
    useState(false);

  // Track dirty state per tab
  const [dirtyTabs, setDirtyTabs] = useState<Set<TabId>>(new Set());

  const markDirty = useCallback((tab: TabId) => {
    setDirtyTabs(prev => new Set(prev).add(tab));
  }, []);

  const markClean = useCallback((tab: TabId) => {
    setDirtyTabs(prev => {
      const next = new Set(prev);
      next.delete(tab);
      return next;
    });
  }, []);

  useEffect(() => {
    draftSettingsRef.current = draftSettings;
  }, [draftSettings]);

  const refreshPortalSettings = useCallback(async (showLoading = false) => {
    const sequence = ++portalSettingsLoadSequenceRef.current;
    if (showLoading) setSettingsLoading(true);
    try {
      const data = await settingsAPI.getPortalSettings();
      if (sequence !== portalSettingsLoadSequenceRef.current) return;
      setSettings((prev) => {
        const next = { ...data };
        const preservedKeys = new Set([
          ...dirtySettingKeysRef.current,
          ...Object.keys(draftSettingsRef.current),
        ]);
        for (const key of preservedKeys) {
          if (Object.prototype.hasOwnProperty.call(prev, key)) {
            next[key] = prev[key];
          }
        }
        return next;
      });
    } catch {
      if (sequence === portalSettingsLoadSequenceRef.current) {
        addToast('error', 'Failed to load settings');
      }
    } finally {
      if (sequence === portalSettingsLoadSequenceRef.current) {
        setSettingsLoading(false);
      }
    }
  }, [addToast]);

  const selectTab = useCallback((tab: TabId) => {
    if (settingsMutationOwnerRef.current) return;
    if (embedPolicyDirtyRef.current) {
      reportEmbedPolicyNavigationAttempt();
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    next.delete('setup');
    setSearchParams(next, { replace: true });
  }, [reportEmbedPolicyNavigationAttempt, searchParams, setSearchParams]);

  const handleTailnetStatus = useCallback((
    status: OllamaTailnetStatus,
  ) => {
    window.dispatchEvent(new Event('bridgesllm:ollama-runtime-changed'));
    const authority = status.binding.authority;
    const authorityControlsLocalRuntime = (
      authority?.state === 'ACTIVE'
      || authority?.state === 'DISCONNECTED'
    );
    setNativeOllamaAuthorityPresent(authorityControlsLocalRuntime);

    if (
      authorityControlsLocalRuntime
      && dirtySettingKeysRef.current.delete('ollama.localEnabled')
    ) {
      setDraftSettings((prev) => {
        if (!Object.prototype.hasOwnProperty.call(
          prev,
          'ollama.localEnabled',
        )) {
          return prev;
        }
        const next = { ...prev };
        delete next['ollama.localEnabled'];
        return next;
      });
      if (!LOCAL_CPU_MODEL_SETTING_KEYS.some(
        (key) => dirtySettingKeysRef.current.has(key),
      )) {
        markClean('ai-providers');
      }
    }

    const authoritySignature = authority
      ? [
          authority.id,
          authority.generation,
          authority.version,
          authority.state,
        ].join(':')
      : 'none';
    if (tailnetAuthoritySignatureRef.current !== authoritySignature) {
      tailnetAuthoritySignatureRef.current = authoritySignature;
      void refreshPortalSettings();
    }

    if (
      !tailnetSetupRequested
      || !authority
    ) return;
    setShowSetupHandoff(false);
    const next = new URLSearchParams(searchParams);
    next.delete('setup');
    next.delete('ollama');
    setSearchParams(next, { replace: true });
  }, [
    markClean,
    refreshPortalSettings,
    searchParams,
    setSearchParams,
    tailnetSetupRequested,
  ]);

  useEffect(() => {
    if (activeTab !== 'ai-providers' || !tailnetSetupRequested) return;
    tailnetSetupRef.current?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'start',
    });
  }, [activeTab, tailnetSetupRequested]);

  useEffect(() => {
    const ownsSettingsInteraction = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      if (target.closest('[data-settings-mutation-surface="true"]')) return true;
      const modalLayer = target.closest('[data-viewport-modal-layer="true"]');
      if (!modalLayer) return false;
      const modalRoot = modalLayer.closest<HTMLElement>('[data-viewport-overlay-root="true"]');
      return Boolean(
        modalRoot &&
        !modalRoot.hasAttribute('inert') &&
        modalRoot.getAttribute('aria-hidden') !== 'true',
      );
    };
    const preventMutationUnload = (event: BeforeUnloadEvent) => {
      if (!settingsMutationOwnerRef.current && !embedPolicyDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const preventOutsideSettingsInteraction = (event: Event) => {
      if ((!settingsMutationOwnerRef.current && !embedPolicyDirtyRef.current) || ownsSettingsInteraction(event.target)) return;
      reportEmbedPolicyNavigationAttempt();
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const preventHistoryTraversal = (event: PopStateEvent) => {
      if (!settingsMutationOwnerRef.current && !embedPolicyDirtyRef.current) return;
      reportEmbedPolicyNavigationAttempt();
      const guard = mutationNavigationGuardRef.current;
      if (!guard) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const nextIndex = window.history.state?.idx;
      if (guard.historyIndex !== null && typeof nextIndex === 'number') {
        const distanceToOwner = guard.historyIndex - nextIndex;
        if (distanceToOwner !== 0) window.history.go(distanceToOwner);
        return;
      }
      window.history.pushState(guard.state, '', guard.url);
    };

    window.addEventListener('beforeunload', preventMutationUnload);
    window.addEventListener('popstate', preventHistoryTraversal, true);
    document.addEventListener('pointerdown', preventOutsideSettingsInteraction, true);
    document.addEventListener('click', preventOutsideSettingsInteraction, true);
    return () => {
      window.removeEventListener('beforeunload', preventMutationUnload);
      window.removeEventListener('popstate', preventHistoryTraversal, true);
      document.removeEventListener('pointerdown', preventOutsideSettingsInteraction, true);
      document.removeEventListener('click', preventOutsideSettingsInteraction, true);
    };
  }, [reportEmbedPolicyNavigationAttempt]);

  useEffect(() => releaseNavigationLock, [releaseNavigationLock]);

  useEffect(() => {
    if (dirtyTabs.size === 0) return;
    const warnAboutUnsavedSettings = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnAboutUnsavedSettings);
    return () => window.removeEventListener('beforeunload', warnAboutUnsavedSettings);
  }, [dirtyTabs.size]);

  // Load admin settings
  useEffect(() => {
    if (!isOwner) return;
    void refreshPortalSettings(true);
  }, [isOwner, refreshPortalSettings]);

  const saveSettings = useCallback((keys: string[], tab: TabId): false | Promise<void> => {
    const owner = `settings:save:${tab}`;
    if (!claimMutation(owner)) return false;
    const payload: Record<string, string> = {};
    for (const key of keys) {
      if (settings[key] !== undefined) payload[key] = settings[key];
    }
    const snapshot = Object.freeze({ ...payload });
    setSettingsSaveError((current) => current?.tab === tab ? null : current);
    return (async () => {
      try {
        const updated = await settingsAPI.updatePortalSettings(snapshot);
        setSettings(prev => ({ ...prev, ...updated }));
        if (tab === 'general') {
          void refreshPublicSettings().catch(() => null);
        }
        setDraftSettings((prev) => {
          const next = { ...prev };
          for (const key of keys) {
            delete next[key];
          }
          return next;
        });
        for (const key of keys) {
          dirtySettingKeysRef.current.delete(key);
        }
        markClean(tab);
        sounds.success();
        addToast('success', 'Settings saved');
      } catch (error: any) {
        sounds.error();
        const validationMessage = error?.response?.data?.details?.[0]?.message
          || error?.response?.data?.error
          || error?.response?.data?.message;
        const message = validationMessage || 'Failed to save settings';
        setSettingsSaveError({ tab, message });
        addToast('error', message);
      } finally {
        releaseMutation(owner);
      }
    })();
  }, [settings, markClean, addToast, claimMutation, releaseMutation]);

  const updateSetting = useCallback((key: string, value: string, tab: TabId) => {
    if (settingsMutationOwnerRef.current) return;
    dirtySettingKeysRef.current.add(key);
    setSettings(prev => ({ ...prev, [key]: value }));
    markDirty(tab);
  }, [markDirty]);

  const setSettingValue = useCallback((key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const setDraftSettingValue = useCallback((key: string, value: string) => {
    if (settingsMutationOwnerRef.current) return;
    setDraftSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  return (
    <SettingsMutationProvider value={mutationCoordinator}>
    <div data-settings-mutation-surface="true" className="h-full overflow-y-auto p-4 md:p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center accent-icon-badge"
          style={{ background: 'var(--accent-bg-subtle)', borderColor: 'var(--accent-border)' }}>
          <Settings size={20} style={{ color: 'var(--accent)' }} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-theme-text">Settings</h1>
          <p className="text-xs text-theme-text-muted">
            {isOwnerRole(user?.role)
              ? 'Portal configuration and your personal preferences'
              : user?.role === 'SUB_ADMIN'
                ? 'Read-only operational readiness and your personal preferences'
                : 'Your profile, security, and personal preferences'}
          </p>
        </div>
      </div>

      <div className={`mb-6 rounded-xl border px-4 py-3 text-xs leading-5 ${isOwner ? 'border-fuchsia-500/20 bg-fuchsia-500/5 text-fuchsia-100' : user?.role === 'SUB_ADMIN' ? 'border-purple-500/20 bg-purple-500/5 text-purple-100' : 'border-white/[0.08] bg-white/[0.03] text-slate-300'}`}>
        {isOwner
          ? <>Portal-wide configuration belongs here. User authority, approvals, and guarded server maintenance live in <Link to="/admin" aria-disabled={Boolean(settingsMutationOwner) || embedPolicyDirty} onClick={(event) => { if (settingsMutationOwnerRef.current || embedPolicyDirtyRef.current) { event.preventDefault(); reportEmbedPolicyNavigationAttempt(); } }} className="font-semibold underline underline-offset-2">Admin</Link>.</>
          : user?.role === 'SUB_ADMIN'
            ? <>Feature Readiness is intentionally read-only. As a root-equivalent host operator you can inspect maintenance in <Link to="/admin?tab=maintenance" aria-disabled={Boolean(settingsMutationOwner)} onClick={(event) => { if (settingsMutationOwnerRef.current) event.preventDefault(); }} className="font-semibold underline underline-offset-2">Admin</Link>, but only the Owner can change Portal or server configuration.</>
            : 'Portal-wide configuration is Owner-managed. These settings affect only your account and browser preferences.'}
      </div>

      {showSetupHandoff && activeTab === 'ai-providers' && (
        <div className="mb-6 flex items-start justify-between gap-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4">
          <div>
            <p className="text-sm font-semibold text-emerald-200">
              {tailnetSetupRequested
                ? 'Portal launched. Now connect the Remote GPU.'
                : 'Portal launched. Now connect the AI runtime.'}
            </p>
            <p className="mt-1 text-sm text-slate-300">
              {tailnetSetupRequested
                ? 'Choose the Windows PC, run the one-time setup, and acknowledge the narrow Tailscale Grant below. You can pull or select a model after the private route connects.'
                : 'OpenClaw is online at this stage, so OAuth and token flows can persist and verify their credentials before you enter Agent Chat.'}
            </p>
          </div>
          <button type="button" onClick={() => setShowSetupHandoff(false)} className="rounded-lg p-1 text-slate-400 transition hover:bg-white/5 hover:text-white" aria-label="Dismiss setup handoff">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-6">
        {/* Sidebar Tabs */}
        <div className="md:w-56 flex-shrink-0">
          <div role="tablist" aria-label="Settings sections" className="flex md:flex-col gap-1 bg-white/[0.03] rounded-xl p-1.5 border border-white/[0.06] overflow-x-auto md:overflow-visible">
            {tabs.map(({ id, label, icon: Icon }, index) => (
              <button
                type="button"
                key={id}
                id={`settings-tab-${id}`}
                role="tab"
                aria-label={id === 'email' && mailCapability?.available === false
                  ? `${label} — unavailable`
                  : undefined}
                aria-selected={activeTab === id}
                aria-controls={`settings-panel-${id}`}
                tabIndex={activeTab === id ? 0 : -1}
                disabled={Boolean(settingsMutationOwner)}
                onClick={() => { sounds.click(); selectTab(id); }}
                onKeyDown={(event) => {
                  const targetIndex = nextTabIndex(index, tabs.length, event.key);
                  if (targetIndex === null) return;
                  event.preventDefault();
                  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                  buttons?.[targetIndex]?.focus();
                  buttons?.[targetIndex]?.click();
                }}
                className={`flex min-h-[44px] items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                  activeTab === id
                    ? ''
                    : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                }`}
                style={activeTab === id ? {
                  background: 'var(--accent-bg)',
                  color: 'var(--accent)',
                  boxShadow: '0 4px 15px var(--accent-shadow)',
                } : undefined}
              >
                <Icon size={16} className="flex-shrink-0" />
                <span>{label}</span>
                {id === 'email' && mailCapability?.available === false && (
                  <span className="ml-auto rounded-full border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                    Unavailable
                  </span>
                )}
                {(dirtyTabs.has(id) || (id === 'security' && embedPolicyDirty)) && <span className="text-amber-400 text-xs ml-auto">*</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        <div className="flex-1 min-w-0">
          {settingsLoading && isOwner && activeTab !== 'profile' ? (
            <div role="status" aria-live="polite" className="flex items-center justify-center py-20 text-slate-500">
              <Loader2 size={24} className="animate-spin mr-2" /> Loading settings...
            </div>
          ) : (
            <div
              id={`settings-panel-${activeTab}`}
              role="tabpanel"
              aria-labelledby={`settings-tab-${activeTab}`}
              tabIndex={0}
              className="outline-none"
            >
              {settingsSaveError?.tab === activeTab && (
                <p role="alert" className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">
                  {settingsSaveError.message}
                </p>
              )}
              <fieldset
                disabled={Boolean(settingsMutationOwner)}
                aria-busy={Boolean(settingsMutationOwner)}
                className="m-0 min-w-0 border-0 p-0"
              >
              {activeTab === 'general' && (
                <GeneralTab
                  settings={settings}
                  draftSettings={draftSettings}
                  updateSetting={(k, v) => updateSetting(k, v, 'general')}
                  setSettingValue={setSettingValue}
                  setDraftSettingValue={setDraftSettingValue}
                  onSave={() => saveSettings([
                    'appearance.portalName', 'appearance.logoUrl', 'appearance.assistantName',
                    'appearance.agentAvatar.OPENCLAW', 'appearance.agentAvatar.CLAUDE_CODE', 'appearance.agentAvatar.CODEX',
                    'appearance.agentAvatar.GROK', 'appearance.agentAvatar.AGENT_ZERO', 'appearance.agentAvatar.GEMINI', 'appearance.agentAvatar.OLLAMA',
                    'appearance.theme', 'appearance.accentColor'
                  ], 'general')}
                  isDirty={dirtyTabs.has('general')}
                  addToast={addToast}
                  claimMutation={claimMutation}
                  releaseMutation={releaseMutation}
                  mutationOwner={settingsMutationOwner}
                />
              )}
              {activeTab === 'email' && (
                <EmailTab
                  capability={mailCapability}
                  settings={settings}
                  updateSetting={(k, v) => updateSetting(k, v, 'email')}
                  onSave={() => saveSettings([
                    'notifications.newRegistration', 'notifications.userApproved', 'notifications.systemAlerts',
                    'notifications.passwordChange', 'notifications.newDeviceLogin'
                  ], 'email')}
                  isDirty={dirtyTabs.has('email')}
                  addToast={addToast}
                  claimMutation={claimMutation}
                  releaseMutation={releaseMutation}
                />
              )}
              {activeTab === 'security' && (
                <SecurityTab
                  mailCapability={mailCapability}
                  settings={settings}
                  updateSetting={(k, v) => updateSetting(k, v, 'security')}
                  onSave={() => saveSettings([
                    'security.registrationMode', 'security.maxLoginAttempts', 'security.sessionDurationHours',
                    'security.sandboxDefaultEnabled', 'security.blockClosedRegistration'
                  ], 'security')}
                  isDirty={dirtyTabs.has('security')}
                  addToast={addToast}
                  claimMutation={claimMutation}
                  releaseMutation={releaseMutation}
                  mutationOwner={settingsMutationOwner}
                  embedPolicyNavigationAttemptVersion={embedPolicyNavigationAttemptVersion}
                  onEmbedPolicyDirtyChange={handleEmbedPolicyDirtyChange}
                />
              )}
              {activeTab === 'agents' && (
                <AgentsTab
                  addToast={addToast}
                  onOpenProviders={() => {
                    selectTab('ai-providers');
                  }}
                  claimMutation={claimMutation}
                  releaseMutation={releaseMutation}
                />
              )}
              {activeTab === 'system' && (
                <SystemTab
                  mailCapability={mailCapability}
                  settings={settings}
                  updateSetting={(k, v) => updateSetting(k, v, 'system')}
                  onSave={() => saveSettings([
                    'system.allowTelemetry', 'remoteDesktop.url', 'remoteDesktop.allowedPathPrefixes'
                  ], 'system')}
                  isDirty={dirtyTabs.has('system')}
                  addToast={addToast}
                  claimMutation={claimMutation}
                  releaseMutation={releaseMutation}
                />
              )}
              {activeTab === 'ai-providers' && (
                <div className="space-y-5">
                  <Suspense fallback={<div role="status" className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-sm text-slate-400">Loading AI provider settings…</div>}>
                    <LazyAiProviderSetup
                      mode="settings"
                      apiBase="/ai-setup"
                      additionalProviderCards={(
                        <Suspense fallback={<div role="status" className="rounded-xl border border-slate-800 bg-slate-950/60 p-5 text-sm text-slate-400"><Loader2 size={16} className="mr-2 inline animate-spin" />Loading Agent Zero model accounts…</div>}>
                          <LazyAgentZeroSetupPanel
                            view="providers"
                            onOpenRuntimeSettings={() => {
                              selectTab('agents');
                            }}
                          />
                        </Suspense>
                      )}
                    />
                  </Suspense>
                  <div
                    id="ollama-tailnet-setup"
                    ref={tailnetSetupRef}
                    className="scroll-mt-6"
                  >
                    <Suspense fallback={<div role="status" className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-sm text-slate-400">Loading Remote GPU…</div>}>
                      <LazyOllamaTailnetSetup
                        className={tailnetSetupRequested
                          ? 'ring-2 ring-violet-400/40 ring-offset-2 ring-offset-[#0A0E27]'
                          : undefined}
                        onStatusChange={handleTailnetStatus}
                      />
                    </Suspense>
                  </div>
                  <LocalCpuPreferences
                    settings={settings}
                    updateSetting={(k, v) => updateSetting(k, v, 'ai-providers')}
                    onSave={() => saveSettings(
                      nativeOllamaAuthorityPresent
                        ? [...LOCAL_CPU_MODEL_SETTING_KEYS]
                        : [...LOCAL_CPU_SETTING_KEYS],
                      'ai-providers',
                    )}
                    isDirty={dirtyTabs.has('ai-providers')}
                    localRuntimeLocked={nativeOllamaAuthorityPresent}
                  />
                </div>
              )}
              {activeTab === 'readiness' && <FeatureReadinessPanel />}
              {activeTab === 'backups' && (
                <Suspense fallback={<div role="status" className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-sm text-slate-400">Loading backup settings…</div>}>
                  <LazyBackupsTab
                    backupPath={settings['system.backupPath'] || '/root/backups'}
                    onBackupPathChange={(v) => updateSetting('system.backupPath', v, 'backups')}
                    onSaveBackupPath={() => saveSettings(['system.backupPath'], 'backups')}
                    backupPathDirty={dirtyTabs.has('backups')}
                  />
                </Suspense>
              )}
              {activeTab === 'profile' && (
                <ProfileTab
                  mailCapability={mailCapability}
                  addToast={addToast}
                  claimMutation={claimMutation}
                  releaseMutation={releaseMutation}
                  mutationOwner={settingsMutationOwner}
                />
              )}
              </fieldset>
            </div>
          )}
        </div>
      </div>

      <SettingsToasts toasts={toasts} />
    </div>
    </SettingsMutationProvider>
  );
}
