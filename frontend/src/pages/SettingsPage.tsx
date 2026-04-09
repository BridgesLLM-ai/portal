import { useState, useEffect, useCallback } from 'react';
import {
  Settings, Database, User, ShieldCheck, Palette, Mail, Bot, Server, Cpu,
  Save, Loader2, Eye, EyeOff, Sun, Moon, Monitor, Check, X, Send,
  Wrench, CheckCircle2, AlertCircle, ChevronDown, ChevronRight, PlugZap,
  Shield, Copy, KeyRound, RefreshCw
} from 'lucide-react';
import { useAuthStore } from '../contexts/AuthContext';
import { isElevated, isOwnerRole } from '../utils/authz';
import { useTheme } from '../contexts/ThemeContext';
import { adminAPI } from '../api/admin';
import client from '../api/client';
import { gatewayAPI, type CompatibilityHotfixStatus } from '../api/endpoints';
import { agentRuntimeAPI, AgentRuntimeStatus } from '../api/agentRuntime';
import { authAPI, TwoFactorSetupResponse, TwoFactorStatusResponse } from '../api/auth';
import BackupsTab from '../components/settings/BackupsTab';
import AiProviderSetup from '../components/ai-setup/AiProviderSetup';
import ImagePickerCropper from '../components/ImagePickerCropper';
import sounds from '../utils/sounds';
import { QRCodeSVG } from 'qrcode.react';

// ── Toast system (local to settings) ──────────────────────────────────

interface ToastItem {
  id: string;
  type: 'success' | 'error';
  message: string;
}

function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const add = useCallback((type: 'success' | 'error', message: string) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);
  return { toasts, add };
}

function SettingsToasts({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => (
        <div key={t.id} className={`flex items-center gap-2 px-4 py-3 rounded-lg border text-sm font-medium animate-slide-in ${
          t.type === 'success'
            ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
            : 'bg-red-500/20 border-red-500/30 text-red-400'
        }`}>
          {t.type === 'success' ? <Check size={16} /> : <X size={16} />}
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ── Types ──────────────────────────────────────────────────────────────

type TabId = 'general' | 'email' | 'security' | 'agents' | 'system' | 'ai-providers' | 'readiness' | 'backups' | 'profile';

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof Settings;
  adminOnly: boolean;
}

const allTabs: TabDef[] = [
  { id: 'general', label: 'General', icon: Palette, adminOnly: true },
  { id: 'email', label: 'Email', icon: Mail, adminOnly: true },
  { id: 'security', label: 'Security', icon: ShieldCheck, adminOnly: true },
  { id: 'agents', label: 'Agents', icon: Bot, adminOnly: true },
  { id: 'system', label: 'System', icon: Server, adminOnly: true },
  { id: 'ai-providers', label: 'AI Providers', icon: Cpu, adminOnly: true },
  { id: 'readiness', label: 'Feature Readiness', icon: Wrench, adminOnly: true },
  { id: 'backups', label: 'Backups', icon: Database, adminOnly: true },
  { id: 'profile', label: 'Profile', icon: User, adminOnly: false },
];

const ACCENT_PRESETS = [
  { name: 'Indigo', color: '#6366f1' },
  { name: 'Emerald', color: '#10b981' },
  { name: 'Violet', color: '#8b5cf6' },
  { name: 'Rose', color: '#f43f5e' },
  { name: 'Amber', color: '#f59e0b' },
  { name: 'Cyan', color: '#06b6d4' },
];

const PROVIDER_OPTIONS = ['OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'AGENT_ZERO', 'GEMINI', 'OLLAMA'] as const;

// ── Shared components ─────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5 mb-4">
      <h3 className="text-sm font-semibold text-theme-text mb-4">{title}</h3>
      {children}
    </div>
  );
}

function SaveButton({ onClick, isDirty, saving }: { onClick: () => void; isDirty: boolean; saving?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={!isDirty || saving}
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
      {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
      Save Changes
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

function TextInput({ value, onChange, placeholder, type = 'text' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none accent-focus transition-all"
      style={{
        '--accent-border': 'var(--accent-border)',
        '--accent-ring': 'var(--accent-ring)',
      } as React.CSSProperties}
    />
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer group">
      <div
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer ${
          checked ? 'bg-emerald-500' : 'bg-slate-600'
        }`}
      >
        <div
          className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-200 ${
            checked ? 'left-6' : 'left-1'
          }`}
        />
      </div>
      <span className="text-sm text-slate-300 group-hover:text-white transition-colors">{label}</span>
    </label>
  );
}

// ── General Tab ───────────────────────────────────────────────────────

function GeneralTab({ settings, updateSetting, setSettingValue, onSave, isDirty, addToast }: {
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  setSettingValue: (k: string, v: string) => void;
  onSave: () => void;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
}) {
  const [logoEditorOpen, setLogoEditorOpen] = useState(false);
  const [searchVisibilitySaving, setSearchVisibilitySaving] = useState(false);
  const [agentEditorOpen, setAgentEditorOpen] = useState<string | null>(null);
  const [domainStatus, setDomainStatus] = useState<{ currentDomain: string; publicIp: string; httpsActive: boolean } | null>(null);
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainValue, setDomainValue] = useState('');
  const [domainDnsLoading, setDomainDnsLoading] = useState(false);
  const [domainConfigureLoading, setDomainConfigureLoading] = useState(false);
  const [domainDnsResult, setDomainDnsResult] = useState<{ domain: string; resolves: boolean; pointsToUs: boolean; resolvedIps: string[]; expectedIp: string; message: string } | null>(null);
  const { theme, setTheme, accentColor, setAccentColor } = useTheme();
  const currentTheme = settings['appearance.theme'] || theme;
  const currentAccent = settings['appearance.accentColor'] || accentColor;

  const handleThemeChange = (t: string) => {
    updateSetting('appearance.theme', t);
    setTheme(t as 'dark' | 'light' | 'system');
  };

  const handleAccentChange = (c: string) => {
    updateSetting('appearance.accentColor', c);
    setAccentColor(c);
  };

  const loadDomainStatus = useCallback(async () => {
    setDomainLoading(true);
    try {
      const res = await client.get('/admin/domain-status');
      setDomainStatus(res.data);
      setDomainValue(res.data?.currentDomain || '');
    } catch {
      setDomainStatus(null);
    } finally {
      setDomainLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDomainStatus();
  }, [loadDomainStatus]);

  const handleCheckDomainDns = async () => {
    if (!domainValue.trim()) {
      addToast('error', 'Enter a domain first');
      return;
    }

    setDomainDnsLoading(true);
    try {
      const res = await client.post('/admin/check-domain-dns', { domain: domainValue.trim() });
      setDomainDnsResult(res.data);
    } catch (err: any) {
      addToast('error', err?.response?.data?.error || 'DNS check failed');
      setDomainDnsResult(null);
    } finally {
      setDomainDnsLoading(false);
    }
  };

  const handleConfigureDomain = async () => {
    if (!domainValue.trim()) {
      addToast('error', 'Enter a domain first');
      return;
    }

    setDomainConfigureLoading(true);
    try {
      const res = await client.post('/admin/configure-domain', { domain: domainValue.trim() });
      addToast('success', res.data?.message || 'Domain configured');
      await loadDomainStatus();
      setDomainDnsResult(null);
    } catch (err: any) {
      addToast('error', err?.response?.data?.error || 'Domain configuration failed');
    } finally {
      setDomainConfigureLoading(false);
    }
  };

  const handleSearchVisibilityToggle = async (allowed: boolean) => {
    const nextVisibility = allowed ? 'visible' : 'hidden';
    const previousVisibility = settings['system.searchEngineVisibility'] === 'visible' ? 'visible' : 'hidden';
    setSettingValue('system.searchEngineVisibility', nextVisibility);
    setSearchVisibilitySaving(true);
    try {
      await adminAPI.updateSearchVisibility(nextVisibility);
      addToast('success', allowed ? 'Search indexing enabled' : 'Search indexing disabled');
    } catch (err: any) {
      setSettingValue('system.searchEngineVisibility', previousVisibility);
      addToast('error', err?.response?.data?.error || 'Failed to update search visibility');
    } finally {
      setSearchVisibilitySaving(false);
    }
  };

  return (
    <div>
      <SectionCard title="Portal Identity">
        <div className="space-y-4">
          <div>
            <FieldLabel label="Portal Name" description="Displayed in the header and browser tab" />
            <TextInput
              value={settings['appearance.portalName'] || 'Bridges Portal'}
              onChange={v => updateSetting('appearance.portalName', v)}
              placeholder="Bridges Portal"
            />
          </div>
          <div>
            <FieldLabel label="Portal Logo" description="Upload and crop the logo shown across the portal" />
            <div className="flex items-center gap-3">
              {settings['appearance.logoUrl'] ? <img src={settings['appearance.logoUrl']} alt="Portal logo" className="w-10 h-10 rounded-lg object-cover border border-white/10" /> : <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10" />}
              <button onClick={() => setLogoEditorOpen(true)} className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-slate-200 hover:bg-white/[0.08]">Upload / Crop</button>
            </div>
            <div className="mt-2">
              <TextInput
                value={settings['appearance.logoUrl'] || ''}
                onChange={v => updateSetting('appearance.logoUrl', v)}
                placeholder="https://example.com/logo.png"
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
                />
              </div>
            </div>
          </div>

          <div>
            <FieldLabel label="Assistant Display Name" description="Shown in chat and sidebar identity areas" />
            <TextInput
              value={settings['appearance.assistantName'] || 'Assistant'}
              onChange={v => updateSetting('appearance.assistantName', v)}
              placeholder="Assistant"
            />
          </div>

          <div>
            <FieldLabel label="Agent Chat Avatars" description="Per-agent avatars shown in chat list and message bubbles" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { key: 'OPENCLAW', label: 'OpenClaw' },
                { key: 'CLAUDE_CODE', label: 'Claude' },
                { key: 'CODEX', label: 'Codex' },
                { key: 'AGENT_ZERO', label: 'Agent Zero' },
                { key: 'GEMINI', label: 'Gemini' },
                { key: 'OLLAMA', label: 'Ollama' },
              ].map((a) => (
                <button key={a.key} onClick={() => setAgentEditorOpen(a.key)} className="p-2 rounded-lg bg-white/[0.03] border border-white/[0.08] hover:bg-white/[0.06] text-left">
                  <div className="flex items-center gap-2">
                    {settings[`appearance.agentAvatar.${a.key}`] ? <img src={settings[`appearance.agentAvatar.${a.key}`]} alt={a.label} className="w-8 h-8 rounded-full object-cover" /> : <div className="w-8 h-8 rounded-full bg-white/10" />}
                    <span className="text-sm text-slate-200">{a.label}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <ImagePickerCropper
            isOpen={logoEditorOpen}
            onClose={() => setLogoEditorOpen(false)}
            onSaved={(url) => updateSetting('appearance.logoUrl', url ? url.split('?')[0] : '')}
            currentImageUrl={settings['appearance.logoUrl'] || null}
            uploadEndpoint="/admin/appearance/logo"
            deleteEndpoint="/admin/appearance/logo"
            fieldName="image"
            title="Edit Portal Logo"
            shape="square"
            responseKey="logoUrl"
          />

          {agentEditorOpen && (
            <ImagePickerCropper
              isOpen={Boolean(agentEditorOpen)}
              onClose={() => setAgentEditorOpen(null)}
              onSaved={(url) => {
                if (!agentEditorOpen) return;
                updateSetting(`appearance.agentAvatar.${agentEditorOpen}`, url ? url.split('?')[0] : '');
              }}
              currentImageUrl={settings[`appearance.agentAvatar.${agentEditorOpen}`] || null}
              uploadEndpoint={`/admin/appearance/agent-avatar/${agentEditorOpen}`}
              deleteEndpoint={`/admin/appearance/agent-avatar/${agentEditorOpen}`}
              fieldName="image"
              title={`Edit ${agentEditorOpen.replace('_CODE', '')} Avatar`}
              shape="circle"
              responseKey="avatarUrl"
            />
          )}

        </div>
      </SectionCard>

      <SectionCard title="Theme">
        <div className="space-y-4">
          <div>
            <FieldLabel label="Color Mode" />
            <div className="flex gap-2">
              {[
                { value: 'dark', icon: Moon, label: 'Dark' },
                { value: 'light', icon: Sun, label: 'Light' },
                { value: 'system', icon: Monitor, label: 'System' },
              ].map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  onClick={() => handleThemeChange(value)}
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
                  key={color}
                  onClick={() => handleAccentChange(color)}
                  title={name}
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
                />
                <div
                  className="w-8 h-8 rounded-lg border border-white/10"
                  style={{ backgroundColor: currentAccent }}
                />
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Domain & HTTPS">
        <div className="space-y-4">
          {domainLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Loader2 size={16} className="animate-spin" /> Loading domain status...
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Current domain</p>
                <p className="mt-1 text-sm font-medium text-white">{domainStatus?.currentDomain || 'Not configured — using IP address'}</p>
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Public IP</p>
                <p className="mt-1 text-sm font-medium text-white">{domainStatus?.publicIp || 'Unavailable'}</p>
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">HTTPS status</p>
                <p className={`mt-1 text-sm font-medium ${domainStatus?.httpsActive ? 'text-emerald-400' : 'text-amber-300'}`}>{domainStatus?.httpsActive ? 'Active' : 'Not configured'}</p>
              </div>
            </div>
          )}

          <div>
            <FieldLabel label="Custom Domain" description="Point your domain's A record to this server, then verify DNS before enabling HTTPS." />
            <TextInput value={domainValue} onChange={setDomainValue} placeholder="portal.example.com" />
          </div>

          <div className="flex flex-wrap gap-2">
            <button onClick={handleCheckDomainDns} disabled={domainDnsLoading || domainConfigureLoading} className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-slate-200 hover:bg-white/[0.08] disabled:opacity-50">
              {domainDnsLoading ? <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Checking DNS...</span> : 'Check DNS'}
            </button>
            <button onClick={handleConfigureDomain} disabled={domainConfigureLoading || domainDnsLoading} className="px-3 py-2 rounded-lg bg-emerald-500 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
              {domainConfigureLoading ? <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Configuring...</span> : 'Configure domain'}
            </button>
            <button onClick={loadDomainStatus} disabled={domainLoading} className="px-3 py-2 rounded-lg border border-white/[0.08] text-sm text-slate-400 hover:text-white hover:bg-white/[0.04] disabled:opacity-50">
              <span className="inline-flex items-center gap-2"><RefreshCw size={14} className={domainLoading ? 'animate-spin' : ''} /> Refresh</span>
            </button>
          </div>

          {domainDnsResult && (
            <div className={`rounded-xl border p-4 text-sm ${domainDnsResult.pointsToUs ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100' : 'border-amber-500/20 bg-amber-500/10 text-amber-100'}`}>
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
        <SaveButton onClick={onSave} isDirty={isDirty} />
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

function EmailTab({ settings, updateSetting, onSave, isDirty, addToast }: {
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => void;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
}) {
  const [testingSend, setTestingSend] = useState(false);
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [installingMail, setInstallingMail] = useState(false);
  const [installMailResult, setInstallMailResult] = useState<{ success: boolean; message: string; domain?: string; dnsRecords?: Array<{ type: string; name: string; value: string; priority?: number; description?: string }> } | null>(null);

  const refreshEmailStatus = async () => {
    setStatusLoading(true);
    try {
      const res = await client.get('/admin/email-status');
      setEmailStatus(res.data);
    } catch {
      setEmailStatus(null);
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadStatus = async () => {
      setStatusLoading(true);
      try {
        const res = await client.get('/admin/email-status');
        if (!cancelled) setEmailStatus(res.data);
      } catch {
        if (!cancelled) setEmailStatus(null);
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    };
    loadStatus();
    return () => { cancelled = true; };
  }, []);

  const handleInstallMail = async () => {
    setInstallingMail(true);
    setInstallMailResult(null);
    try {
      const res = await client.post('/admin/install-mail');
      setInstallMailResult({ success: true, message: res.data.message || 'Mail server installed!', domain: res.data.domain, dnsRecords: res.data.dnsRecords });
      addToast('success', 'Email server installed successfully!');
      // Refresh status after install
      setTimeout(() => refreshEmailStatus(), 2000);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Installation failed';
      setInstallMailResult({ success: false, message: msg });
      addToast('error', msg);
    } finally {
      setInstallingMail(false);
    }
  };

  const handleTestEmail = async () => {
    setTestingSend(true);
    try {
      const result = await adminAPI.sendTestEmail();
      sounds.success();
      addToast('success', result.message || 'Test email sent successfully');
    } catch (err: any) {
      sounds.error();
      addToast('error', err?.response?.data?.error || 'Failed to send test email');
    } finally {
      setTestingSend(false);
    }
  };

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
                  disabled={installingMail}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {installingMail ? <Loader2 size={16} className="animate-spin" /> : <Server size={16} />}
                  {installingMail ? 'Installing mail server… (1–2 min)' : 'Set Up Email Server'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm text-slate-500">Could not retrieve email system status.</div>
            <div className="pt-3 border-t border-white/[0.06]">
              <p className="text-xs text-slate-500 mb-3">Install Stalwart mail server via Docker to enable email features.</p>
              <button
                onClick={handleInstallMail}
                disabled={installingMail}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {installingMail ? <Loader2 size={16} className="animate-spin" /> : <Server size={16} />}
                {installingMail ? 'Installing mail server… (1–2 min)' : 'Set Up Email Server'}
              </button>
            </div>
          </div>
        )}
        {installMailResult && (
          <div className={`mt-4 p-4 rounded-lg border ${installMailResult.success ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}>
            <div className={`text-xs font-semibold mb-1 ${installMailResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
              {installMailResult.success ? '✓ Mail Server Installed' : '✗ Installation Failed'}
            </div>
            <div className="text-xs text-slate-400">{installMailResult.message}</div>
            {installMailResult.success && installMailResult.dnsRecords && installMailResult.dnsRecords.length > 0 && (
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
                        <button onClick={() => { navigator.clipboard.writeText(r.name); addToast('success', 'Name copied'); }} className="px-2 py-1 rounded text-xs text-slate-400 bg-white/5 hover:bg-white/10 transition">Copy name</button>
                        <button onClick={() => { navigator.clipboard.writeText(r.value); addToast('success', 'Value copied'); }} className="px-2 py-1 rounded text-xs text-slate-400 bg-white/5 hover:bg-white/10 transition">Copy value</button>
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
          disabled={testingSend}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-blue-400 bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 transition-all"
        >
          {testingSend ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          Send Test Email
        </button>
        <SaveButton onClick={onSave} isDirty={isDirty} />
      </div>
    </div>
  );
}

// ── Security Tab ──────────────────────────────────────────────────────

function SecurityTab({ settings, updateSetting, onSave, isDirty, addToast }: {
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => void;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
}) {
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
                  className={`px-4 py-2 rounded-lg text-sm font-medium capitalize transition-all border ${
                    (settings['security.registrationMode'] || settings['registrationMode'] || 'approval') === mode
                      ? ''
                      : 'text-slate-400 bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
                  }`}
                  style={(settings['security.registrationMode'] || settings['registrationMode'] || 'approval') === mode ? {
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
          />
          <p className="text-xs text-theme-text-muted -mt-2 ml-0.5">
            When registration is closed, silently block the requester's IP instead of returning an error message
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Sandbox Defaults">
        <Toggle
          checked={(settings['security.sandboxDefaultEnabled'] || 'true') === 'true'}
          onChange={v => updateSetting('security.sandboxDefaultEnabled', v ? 'true' : 'false')}
          label="Enable sandbox for newly created users by default"
        />
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
            />
          </div>
          <div>
            <FieldLabel label="Session Duration (hours)" description="How long before requiring re-login" />
            <TextInput
              value={settings['security.sessionDurationHours'] || '24'}
              onChange={v => updateSetting('security.sessionDurationHours', v)}
              placeholder="24"
              type="number"
            />
          </div>
        </div>
      </SectionCard>

      {/* Two-Factor Authentication (admin sees it here) */}
      <TwoFactorSection addToast={addToast} />

      <div className="flex justify-end">
        <SaveButton onClick={onSave} isDirty={isDirty} />
      </div>
    </div>
  );
}

// ── Agents Tab ────────────────────────────────────────────────────────

function AgentsTab({ settings, updateSetting, onSave, isDirty }: {
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => void;
  isDirty: boolean;
}) {
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus | null>(null);

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

  const enabledStr = settings['agents.enabledProviders'] || '["OPENCLAW"]';
  let enabledProviders: string[] = [];
  try { enabledProviders = JSON.parse(enabledStr); } catch { enabledProviders = ['OPENCLAW']; }

  const toggleProvider = (provider: string) => {
    const newList = enabledProviders.includes(provider)
      ? enabledProviders.filter(p => p !== provider)
      : [...enabledProviders, provider];
    updateSetting('agents.enabledProviders', JSON.stringify(newList));
  };

  const adapters = [
    { key: 'openclaw', label: 'OpenClaw' },
    { key: 'claudeCode', label: 'Claude Code' },
    { key: 'codex', label: 'Codex' },
    { key: 'shell', label: 'Shell' },
  ];

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

      <SectionCard title="AI Provider Setup">
        <div className="space-y-4">
          <p className="text-sm text-slate-400">
            Connect cloud providers, complete remote sign-in flows, and choose which models are available to your agents.
          </p>
          <AiProviderSetup mode="settings" apiBase="/ai-setup" />
        </div>
      </SectionCard>

      <SectionCard title="Enabled Providers">
        <div className="space-y-3">
          {PROVIDER_OPTIONS.map(provider => (
            <Toggle
              key={provider}
              checked={enabledProviders.includes(provider)}
              onChange={() => toggleProvider(provider)}
              label={provider.replace(/_/g, ' ')}
            />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Agent Configuration">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <FieldLabel label="Default Provider" />
            <select
              value={settings['agents.defaultProvider'] || 'OPENCLAW'}
              onChange={e => updateSetting('agents.defaultProvider', e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 focus:outline-none transition-all accent-focus"
            >
              {PROVIDER_OPTIONS.map(p => (
                <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel label="Max Sessions Per User" description="0 = unlimited" />
            <TextInput
              value={settings['agents.maxSessionsPerUser'] || '5'}
              onChange={v => updateSetting('agents.maxSessionsPerUser', v)}
              placeholder="5"
              type="number"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Gateway Connection">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <FieldLabel label="OpenClaw Gateway Host" />
            <TextInput
              value={settings['agents.openclaw.gatewayHost'] || 'localhost'}
              onChange={v => updateSetting('agents.openclaw.gatewayHost', v)}
              placeholder="localhost"
            />
          </div>
          <div>
            <FieldLabel label="OpenClaw Gateway Port" />
            <TextInput
              value={settings['agents.openclaw.gatewayPort'] || '18789'}
              onChange={v => updateSetting('agents.openclaw.gatewayPort', v)}
              placeholder="18789"
              type="number"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Runner Configuration">
        <div className="space-y-4">
          {adapters.map((adapter) => (
            <div key={adapter.key} className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
              <div className="mb-3">
                <Toggle
                  checked={settings[`runners.${adapter.key}.enabled`] !== 'false'}
                  onChange={(v) => updateSetting(`runners.${adapter.key}.enabled`, v ? 'true' : 'false')}
                  label={`${adapter.label} enabled`}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <FieldLabel label="Binary Path Override" description="Optional absolute path to executable" />
                  <TextInput
                    value={settings[`runners.${adapter.key}.binaryPath`] || ''}
                    onChange={(v) => updateSetting(`runners.${adapter.key}.binaryPath`, v)}
                    placeholder="/usr/local/bin/..."
                  />
                </div>
                <div>
                  <FieldLabel label="Default Working Directory" description="Runner starts here unless overridden" />
                  <TextInput
                    value={settings[`runners.${adapter.key}.workingDirectory`] || ''}
                    onChange={(v) => updateSetting(`runners.${adapter.key}.workingDirectory`, v)}
                    placeholder="/portal/projects"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="flex items-center justify-between">
        <a href="/agent-tools" className="text-sm text-blue-400 hover:text-blue-300 underline">
          Manage installs and updates on Agent Tools →
        </a>
        <SaveButton onClick={onSave} isDirty={isDirty} />
      </div>
    </div>
  );
}

// ── System Tab ────────────────────────────────────────────────────────

function SystemTab({ settings, updateSetting, onSave, isDirty, addToast }: {
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => void;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
}) {
  // Mailbox management state
  const [mailboxes, setMailboxes] = useState<{ userId: string; username: string; email: string; createdAt: string; lastLoginAt: string | null }[]>([]);
  const [mailboxLoading, setMailboxLoading] = useState(false);
  const [deletingMailbox, setDeletingMailbox] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const { user } = useAuthStore();
  const isAdmin = isElevated(user);
  const [codingTools, setCodingTools] = useState<Array<{ id: string; name: string; description: string; installed: boolean; version: string }>>([]);
  const [codingToolsLoading, setCodingToolsLoading] = useState(false);
  const [installingToolId, setInstallingToolId] = useState('');
  const [compatHotfixStatus, setCompatHotfixStatus] = useState<CompatibilityHotfixStatus | null>(null);
  const [compatHotfixLoading, setCompatHotfixLoading] = useState(false);
  const [compatHotfixApplying, setCompatHotfixApplying] = useState(false);
  const [compatHotfixOutput, setCompatHotfixOutput] = useState('');

  const loadMailboxes = useCallback(() => {
    setMailboxLoading(true);
    client.get('/admin/mailboxes')
      .then(res => setMailboxes(res.data?.mailboxes || []))
      .catch(() => setMailboxes([]))
      .finally(() => setMailboxLoading(false));
  }, []);

  useEffect(() => { loadMailboxes(); }, [loadMailboxes]);

  const loadCodingTools = useCallback(async () => {
    setCodingToolsLoading(true);
    try {
      const res = await client.get('/admin/coding-tools-status');
      setCodingTools(res.data.tools || []);
    } catch {
      setCodingTools([]);
    } finally {
      setCodingToolsLoading(false);
    }
  }, []);

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

  const handleInstallTool = async (toolId: string) => {
    setInstallingToolId(toolId);
    try {
      await client.post('/admin/install-coding-tool', { toolId });
      addToast('success', 'Tool installed successfully');
      await loadCodingTools();
    } catch (err: any) {
      addToast('error', err?.response?.data?.error || 'Installation failed');
    } finally {
      setInstallingToolId('');
    }
  };

  const handleDeleteMailbox = async (username: string) => {
    setDeletingMailbox(username);
    try {
      await client.delete(`/admin/mailboxes/${username}`);
      setConfirmDelete(null);
      loadMailboxes();
    } catch (err) {
      console.error('Failed to delete mailbox:', err);
    } finally {
      setDeletingMailbox(null);
    }
  };

  const handleApplyCompatibilityHotfix = async () => {
    if (!isAdmin) return;
    setCompatHotfixApplying(true);
    try {
      const result = await gatewayAPI.applyCompatibilityHotfix();
      const combinedOutput = [result.patchOutput, result.restartOutput].filter(Boolean).join('\n\n');
      setCompatHotfixOutput(combinedOutput);
      setCompatHotfixStatus(result.status);
      addToast('success', result.message || 'Compatibility hotfix applied');
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.response?.data?.error || 'Failed to apply compatibility hotfix';
      addToast('error', detail);
    } finally {
      setCompatHotfixApplying(false);
      void loadCompatibilityHotfixStatus();
    }
  };

  return (
    <div>
      <SectionCard title="Mailbox Management">
        <p className="text-xs text-slate-500 mb-3">User email accounts provisioned on Stalwart. Deleting a mailbox removes the Stalwart account but keeps the portal user.</p>
        {mailboxLoading ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
            <Loader2 size={16} className="animate-spin" /> Loading mailboxes...
          </div>
        ) : mailboxes.length === 0 ? (
          <div className="text-sm text-slate-500 py-4">No mailboxes provisioned yet.</div>
        ) : (
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
                {confirmDelete === mb.username ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => handleDeleteMailbox(mb.username)}
                      disabled={deletingMailbox === mb.username}
                      className="px-2.5 py-1 rounded text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-50"
                    >
                      {deletingMailbox === mb.username ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="px-2 py-1 rounded text-xs text-slate-400 hover:text-white"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(mb.username)}
                    className="px-2.5 py-1 rounded text-xs font-medium text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 shrink-0"
                  >
                    Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <button onClick={loadMailboxes} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Telemetry">
        <div className="space-y-3">
          <Toggle
            checked={settings['system.allowTelemetry'] === 'true'}
            onChange={v => updateSetting('system.allowTelemetry', v ? 'true' : 'false')}
            label="Help improve BridgesLLM"
          />
          <p className="text-sm text-slate-400">
            Sends anonymous usage stats (install ID, version, user count) once daily. No personal data, messages, or files are ever collected. Keeping this on helps us track active installs and notifies you when updates are available.
          </p>
          {settings['system.allowTelemetry'] !== 'true' && (
            <p className="text-xs text-amber-300/90">Update notifications will be disabled.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Remote Desktop Configuration">
        <div className="space-y-4">
          <div>
            <FieldLabel label="remoteDesktop.url" description="Absolute URL or allowed same-origin path used by Desktop page" />
            <TextInput
              value={settings['remoteDesktop.url'] || ''}
              onChange={v => updateSetting('remoteDesktop.url', v)}
              placeholder="https://rdp.example.com/novnc/vnc_portal.html?reconnect=1&resize=remote&path=novnc/websockify"
            />
          </div>
          <div>
            <FieldLabel label="remoteDesktop.allowedPathPrefixes" description="Comma-separated allowed same-origin path prefixes" />
            <TextInput
              value={settings['remoteDesktop.allowedPathPrefixes'] || '/novnc,/vnc'}
              onChange={v => updateSetting('remoteDesktop.allowedPathPrefixes', v)}
              placeholder="/novnc,/vnc"
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="AI Coding Tools">
        <p className="text-sm text-slate-400 mb-4">Optional CLI tools for AI-powered coding agents.</p>
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
                  <button onClick={() => handleInstallTool(tool.id)} disabled={!!installingToolId} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
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
              Optional temporary patch for the long-run OpenClaw exec relay bug on older installs. Applying it patches the installed OpenClaw runtime files and restarts the OpenClaw gateway.
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
                      {compatHotfixStatus.applied ? 'Hotfix present in the installed OpenClaw bundle' : 'Hotfix not applied'}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs text-slate-300">
                    <div>Heartbeat bundle: <span className="font-mono text-slate-400">{compatHotfixStatus.heartbeatRunner || 'missing'}</span></div>
                    <div>Reply bundle: <span className="font-mono text-slate-400">{compatHotfixStatus.replyBundle || 'missing'}</span></div>
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
                    className="flex items-center gap-1 text-xs text-slate-400 hover:text-white"
                  >
                    <RefreshCw size={12} /> Refresh status
                  </button>
                  <button
                    onClick={handleApplyCompatibilityHotfix}
                    disabled={compatHotfixApplying || !compatHotfixStatus.supported}
                    className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-black hover:bg-amber-400 disabled:opacity-50"
                  >
                    {compatHotfixApplying ? 'Applying + restarting…' : compatHotfixStatus.applied ? 'Reapply hotfix + restart' : 'Apply hotfix + restart'}
                  </button>
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-500">Could not load compatibility hotfix status.</div>
            )}
          </div>
        </SectionCard>
      )}

      <div className="flex justify-end">
        <SaveButton onClick={onSave} isDirty={isDirty} />
      </div>
    </div>
  );
}


type OllamaModelRecommendation = {
  name: string;
  description: string;
  size: string;
};

type OllamaRecommendationsResponse = {
  ramBytes: number;
  ramGb: number;
  ramTier: string;
  warning: string | null;
  recommendedModels: OllamaModelRecommendation[];
};

function OllamaTab({ settings, updateSetting, onSave, isDirty, addToast }: {
  settings: Record<string, string>;
  updateSetting: (k: string, v: string) => void;
  onSave: () => void;
  isDirty: boolean;
  addToast: (type: 'success' | 'error', msg: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [statusText, setStatusText] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [pullModel, setPullModel] = useState('');
  const [testingRemote, setTestingRemote] = useState(false);
  const [recommendation, setRecommendation] = useState<OllamaRecommendationsResponse | null>(null);
  const [tailscalePeers, setTailscalePeers] = useState<{ available: boolean; peers: { hostname: string; ip: string; os: string; online: boolean }[]; self: { hostname: string; ip: string } | null } | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const res = await client.get('/ollama/models');
      setModels((res.data?.models || []).map((m: any) => m.name));
    } catch {
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
    client.get('/ollama/recommendations').then((res) => {
      setRecommendation(res.data);
    }).catch(() => {});
    client.get('/system/stats/tailscale-peers').then((res) => {
      setTailscalePeers(res.data);
    }).catch(() => {
      setTailscalePeers({ available: false, peers: [], self: null });
    });
  }, [loadModels]);

  const testConnection = async () => {
    setTestingRemote(true);
    try {
      const remoteHost = (settings['ollama.remoteHost'] || '').trim();
      if (!remoteHost) {
        addToast('error', 'Set ollama.remoteHost first');
      } else {
        await client.put('/admin/settings', { 'ollama.remoteHost': remoteHost });
        const res = await client.get('/ollama/status');
        addToast(res.data?.running ? 'success' : 'error', res.data?.running ? 'Remote Ollama reachable' : 'Remote Ollama not reachable');
      }
    } catch {
      addToast('error', 'Failed to test remote connection');
    } finally {
      setTestingRemote(false);
    }
  };

  const pullNow = async (model?: string) => {
    const target = (model || pullModel).trim();
    if (!target) return;
    try {
      await client.post('/ollama/pull', { model: target });
      addToast('success', `Started pull: ${target}`);
      setPullModel('');
    } catch (err: any) {
      addToast('error', err?.response?.data?.error || 'Failed to pull model');
    }
  };

  return (
    <div>
      <SectionCard title="Local Ollama">
        <div className="space-y-3">
          <Toggle
            checked={settings['ollama.localEnabled'] !== 'false'}
            onChange={v => updateSetting('ollama.localEnabled', v ? 'true' : 'false')}
            label="Enable local Ollama"
          />
          <div>
            <FieldLabel label="Local Host" description="Default: http://localhost:11434" />
            <TextInput value={settings['ollama.host'] || 'http://localhost:11434'} onChange={v => updateSetting('ollama.host', v)} placeholder="http://localhost:11434" />
          </div>
          <div className="text-xs text-slate-400">
            {loadingModels ? 'Loading models...' : (models.length ? `Detected models: ${models.join(', ')}` : 'No models detected')}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Pull Model">
        <div className="flex gap-2">
          <TextInput value={pullModel} onChange={setPullModel} placeholder="qwen3:8b" />
          <button onClick={() => pullNow()} className="px-3 py-2 rounded-lg bg-violet-500/20 text-violet-300 border border-violet-500/30">Pull</button>
          <button onClick={loadModels} className="px-3 py-2 rounded-lg bg-white/[0.04] text-slate-300 border border-white/[0.08]">Refresh</button>
        </div>
      </SectionCard>

      <SectionCard title="Remote / Tailscale Ollama">
        <div className="space-y-4">

          {/* Tailscale status */}
          {tailscalePeers === null ? (
            <div className="flex items-center gap-2 text-slate-500 text-xs"><Loader2 size={12} className="animate-spin" /> Detecting Tailscale…</div>
          ) : !tailscalePeers.available ? (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 space-y-1">
              <p className="text-xs font-semibold text-amber-300">⚠ Tailscale not detected</p>
              <p className="text-xs text-amber-200/70">Tailscale is not installed or not running on this server. Remote Ollama over Tailscale requires Tailscale on both this server and the machine running Ollama.</p>
              <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="inline-block mt-1 text-xs text-blue-400 hover:underline">Install Tailscale →</a>
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <p className="text-xs font-semibold text-emerald-400 mb-2">✓ Tailscale active — {tailscalePeers.self?.hostname} ({tailscalePeers.self?.ip})</p>
              {tailscalePeers.peers.length === 0 ? (
                <p className="text-xs text-slate-400">No other devices on your Tailnet.</p>
              ) : (
                <div className="space-y-1">
                  <p className="text-xs text-slate-400 mb-2">Tailnet devices — click to use as remote Ollama host:</p>
                  {tailscalePeers.peers.map(peer => (
                    <button
                      key={peer.ip}
                      onClick={() => {
                        const url = `http://${peer.ip}:11434`;
                        updateSetting('ollama.remoteHost', url);
                        sounds.click();
                        addToast('success', `Set remote host to ${url}`);
                      }}
                      className="flex items-center justify-between w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.07] hover:border-white/[0.12] transition-all group text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${peer.online ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                        <span className="text-xs font-medium text-slate-200">{peer.hostname}</span>
                        <span className="text-xs text-slate-500">{peer.os}</span>
                      </div>
                      <span className="text-xs text-slate-500 font-mono group-hover:text-slate-300 transition-colors">{peer.ip}:11434</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Host URL input */}
          <div>
            <FieldLabel label="Remote Host URL" description="Tailscale IP of the machine running Ollama, port 11434" />
            <TextInput value={settings['ollama.remoteHost'] || ''} onChange={v => updateSetting('ollama.remoteHost', v)} placeholder="http://192.168.1.100:11434" />
          </div>

          {/* Setup instructions */}
          <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.06] space-y-3">
            <p className="text-xs font-semibold text-slate-300">Setup: allow remote access on the Ollama machine</p>
            <p className="text-xs text-slate-400">By default Ollama only listens on localhost. Run this command on the machine running Ollama (e.g. your PC) to allow connections from your Tailnet:</p>

            {/* Windows */}
            <div className="space-y-1">
              <p className="text-xs text-slate-500 font-medium">Windows (PowerShell — run as Admin, then restart Ollama):</p>
              <div className="flex items-center gap-2 p-2 rounded bg-black/40 border border-white/[0.06]">
                <code className="flex-1 text-xs text-emerald-400 font-mono break-all">[System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0', 'Machine')</code>
                <button
                  onClick={() => { navigator.clipboard.writeText("[System.Environment]::SetEnvironmentVariable('OLLAMA_HOST', '0.0.0.0', 'Machine')"); setCopiedCmd(true); setTimeout(() => setCopiedCmd(false), 2000); sounds.click(); }}
                  className="flex-shrink-0 p-1 rounded text-slate-500 hover:text-slate-300 transition-colors"
                  title="Copy"
                >
                  {copiedCmd ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                </button>
              </div>
            </div>

            {/* Linux/Mac */}
            <div className="space-y-1">
              <p className="text-xs text-slate-500 font-medium">Linux / macOS (add to shell profile or systemd override):</p>
              <div className="flex items-center gap-2 p-2 rounded bg-black/40 border border-white/[0.06]">
                <code className="flex-1 text-xs text-emerald-400 font-mono">OLLAMA_HOST=0.0.0.0 ollama serve</code>
              </div>
            </div>

            <p className="text-xs text-slate-500">After setting the env var, restart the Ollama service. Ollama will listen on all interfaces — Tailscale handles the security, only your tailnet can reach it.</p>
          </div>

          {/* Test + Save */}
          <div className="flex gap-2">
            <button onClick={testConnection} disabled={testingRemote} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30 transition-all text-sm">
              {testingRemote ? <><Loader2 size={13} className="animate-spin" /> Testing…</> : 'Test Connection'}
            </button>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Model Tiers — Remote (GPU)">
        <p className="text-xs text-slate-400 mb-3">Models to use when the remote GPU is available. Detected models are from your remote Ollama instance.</p>
        <div className="space-y-3">
          {[
            { key: 'snappy', label: '⚡ Snappy', desc: 'Fast' },
            { key: 'smart', label: '🧠 Smart', desc: 'Balanced' },
            { key: 'best', label: '🏆 Best', desc: 'Quality' },
          ].map(tier => (
            <div key={tier.key} className="flex items-center gap-3">
              <span className="text-xs font-medium text-slate-300 w-24 flex-shrink-0">{tier.label}</span>
              <select
                value={settings[`ollama.remote.tier.${tier.key}`] || ''}
                onChange={e => updateSetting(`ollama.remote.tier.${tier.key}`, e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 focus:outline-none focus:border-emerald-500/30 transition-all"
              >
                <option value="">— select —</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Model Tiers — Local (CPU Fallback)">
        <p className="text-xs text-slate-400 mb-3">Models to use when the remote GPU is offline. Should be smaller models suited for CPU inference.</p>
        <div className="space-y-3">
          {[
            { key: 'snappy', label: '⚡ Snappy', desc: 'Fast' },
            { key: 'smart', label: '🧠 Smart', desc: 'Balanced' },
            { key: 'best', label: '🏆 Best', desc: 'Quality' },
          ].map(tier => (
            <div key={tier.key} className="flex items-center gap-3">
              <span className="text-xs font-medium text-slate-300 w-24 flex-shrink-0">{tier.label}</span>
              <select
                value={settings[`ollama.local.tier.${tier.key}`] || ''}
                onChange={e => updateSetting(`ollama.local.tier.${tier.key}`, e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 focus:outline-none focus:border-emerald-500/30 transition-all"
              >
                <option value="">— select —</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Default Model">
        <p className="text-xs text-slate-400 mb-2">Fallback when no tier is assigned.</p>
        <select value={settings['ollama.defaultModel'] || ''} onChange={e => updateSetting('ollama.defaultModel', e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 focus:outline-none focus:border-emerald-500/30 transition-all">
          <option value="">Select default model</option>
          {models.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </SectionCard>

      {recommendation && (
        <SectionCard title="Recommended Models">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="text-sm text-slate-300">RAM Tier: {recommendation.ramTier}</div>
            <div className="text-xs text-slate-500">Host RAM: {recommendation.ramGb} GB</div>
          </div>
          {recommendation.warning && <div className="text-xs text-amber-300 mb-3">{recommendation.warning}</div>}
          <div className="space-y-2">
            {recommendation.recommendedModels.map((model) => {
              const installed = models.includes(model.name);
              return (
                <div key={model.name} className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-slate-100">{model.name}</div>
                      <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-400">{model.size}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-400">{model.description}</div>
                  </div>
                  {installed ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300">
                      <CheckCircle2 size={12} /> Installed
                    </span>
                  ) : (
                    <button onClick={() => pullNow(model.name)} className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-slate-200 hover:bg-white/[0.08]">
                      Pull {model.name}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      <div className="flex justify-end">
        <SaveButton onClick={onSave} isDirty={isDirty} />
      </div>
      {statusText && <div className="text-xs text-slate-400 mt-2">{statusText}</div>}
    </div>
  );
}

// ── Feature Readiness Tab ─────────────────────────────────────────────

type ReadinessStatus = 'ready' | 'partial' | 'missing';

type ReadinessCheck = {
  id: string;
  label: string;
  type: 'command' | 'path' | 'http' | 'config';
  required: boolean;
  ok: boolean;
  message: string;
  remediation: string;
};

type FeatureReadiness = {
  id: string;
  label: string;
  status: ReadinessStatus;
  checks: ReadinessCheck[];
};

type ReadinessResponse = {
  overall: ReadinessStatus;
  features: FeatureReadiness[];
  suggestedNextActions: string[];
};

function FeatureReadinessTab() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReadinessResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [autoSetupRunning, setAutoSetupRunning] = useState(false);
  const [autoSetupResult, setAutoSetupResult] = useState<{ ok: boolean; steps: Array<{ step: string; ok: boolean; message: string }>; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.get('/system/readiness');
      setData(res.data);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to load readiness status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAutoSetup = useCallback(async (featureId: string) => {
    if (!autoSetupFeatures.has(featureId)) return;
    setAutoSetupRunning(true);
    setAutoSetupResult(null);
    try {
      const endpoint = featureId === 'remoteDesktop'
        ? '/remote-desktop/auto-setup'
        : `/system/remediation/${featureId}/auto-setup`;

      const res = await client.post(endpoint);
      setAutoSetupResult(res.data);
      // Refresh readiness after setup
      setTimeout(() => load(), 1500);
    } catch (err: any) {
      setAutoSetupResult({ ok: false, steps: [], message: err?.response?.data?.message || err?.message || 'Auto-setup request failed' });
    } finally {
      setAutoSetupRunning(false);
    }
  }, [load]);

  const statusBadge = (status: ReadinessStatus) => {
    if (status === 'ready') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20';
    if (status === 'partial') return 'bg-amber-500/15 text-amber-300 border-amber-500/20';
    return 'bg-red-500/15 text-red-400 border-red-500/20';
  };

  const actionLink = (featureId: string) => {
    if (featureId === 'agentTools') return '/agent-tools';
    if (featureId === 'remoteDesktop') return '/settings';
    if (featureId === 'terminal') return '/terminal';
    return '/settings';
  };

  const autoSetupFeatures = new Set(['remoteDesktop', 'terminal', 'fileManager', 'agentTools']);
  const hasAutoSetup = (featureId: string) => autoSetupFeatures.has(featureId);

  if (loading) return <div className="text-slate-400"><Loader2 size={18} className="inline mr-2 animate-spin" />Loading readiness...</div>;
  if (error) return <div className="text-red-400 text-sm">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <SectionCard title="Overall Status">
        <div className="flex items-center justify-between gap-3">
          <div className={`px-3 py-1 rounded-lg border text-xs font-semibold ${statusBadge(data.overall)}`}>
            {data.overall.toUpperCase()}
          </div>
          <button onClick={load} className="text-xs px-3 py-1 rounded border border-white/10 text-slate-300 hover:text-white hover:bg-white/5">Refresh</button>
        </div>
      </SectionCard>

      <SectionCard title="Features">
        <div className="space-y-3">
          {data.features.map((feature) => {
            const open = expanded.has(feature.id);
            return (
              <div key={feature.id} className="rounded-lg border border-white/[0.08] bg-white/[0.02]">
                <button
                  onClick={() => setExpanded(prev => {
                    const next = new Set(prev);
                    if (next.has(feature.id)) next.delete(feature.id); else next.add(feature.id);
                    return next;
                  })}
                  className="w-full px-4 py-3 flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-3">
                    {open ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
                    <div>
                      <div className="text-sm text-white font-medium">{feature.label}</div>
                      <div className="text-xs text-slate-500">{feature.checks.filter(c => c.ok).length}/{feature.checks.length} checks passing</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-1 rounded border text-[11px] font-semibold ${statusBadge(feature.status)}`}>{feature.status.toUpperCase()}</span>
                    {hasAutoSetup(feature.id) && feature.status !== 'ready' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAutoSetup(feature.id); }}
                        disabled={autoSetupRunning}
                        className="text-xs px-2.5 py-1 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300 transition-colors inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Auto-setup Remote Desktop (installs packages, creates services, configures URL)"
                      >
                        {autoSetupRunning ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                        {autoSetupRunning ? 'Setting up...' : 'Auto-Setup'}
                      </button>
                    )}
                    <a href={actionLink(feature.id)} className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"><PlugZap size={12} />Open</a>
                  </div>
                </button>

                {open && (
                  <div className="px-4 pb-4 space-y-2">
                    {feature.checks.map((check) => (
                      <div key={check.id} className="p-2 rounded bg-black/20 border border-white/5 text-xs">
                        <div className="flex items-center gap-2 mb-1">
                          {check.ok ? <CheckCircle2 size={14} className="text-emerald-400" /> : <AlertCircle size={14} className="text-red-400" />}
                          <span className="text-slate-200 font-medium">{check.label}</span>
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] ${check.required ? 'text-red-300 border-red-500/20 bg-red-500/10' : 'text-amber-300 border-amber-500/20 bg-amber-500/10'}`}>{check.required ? 'Required' : 'Optional'}</span>
                        </div>
                        <div className="text-slate-400">{check.message}</div>
                        {!check.ok && <div className="text-slate-500 mt-1">Action: {check.remediation}</div>}
                      </div>
                    ))}

                    {/* Auto-setup result panel */}
                    {autoSetupResult && (
                      <div className={`mt-3 p-3 rounded-lg border ${autoSetupResult.ok ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}>
                        <div className={`text-xs font-semibold mb-2 ${autoSetupResult.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {autoSetupResult.ok ? '✓ Auto-Setup Complete' : '⚠ Auto-Setup Finished with Warnings'}
                        </div>
                        <div className="text-xs text-slate-400 mb-2">{autoSetupResult.message}</div>
                        {autoSetupResult.steps.map((s, i) => (
                          <div key={i} className="flex items-center gap-2 text-[11px] py-0.5">
                            {s.ok ? <CheckCircle2 size={12} className="text-emerald-400 flex-shrink-0" /> : <AlertCircle size={12} className="text-red-400 flex-shrink-0" />}
                            <span className="text-slate-300">{s.step}</span>
                            <span className="text-slate-500 truncate">{s.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard title="Suggested Next Actions">
        <ul className="list-disc pl-5 space-y-1 text-sm text-slate-300">
          {data.suggestedNextActions.length ? data.suggestedNextActions.map((a, i) => <li key={i}>{a}</li>) : <li>All configured.</li>}
        </ul>
      </SectionCard>
    </div>
  );
}


// ── Profile Tab ───────────────────────────────────────────────────────

// ── Two-Factor Authentication Section ─────────────────────────────────

function TwoFactorSection({ addToast }: { addToast: (type: 'success' | 'error', msg: string) => void }) {
  const { user } = useAuthStore();
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
  const [regenEmailSent, setRegenEmailSent] = useState(false);

  // Resend countdown for email
  const [resendCountdown, setResendCountdown] = useState(0);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  const loadStatus = useCallback(async () => {
    try {
      const s = await authAPI.twoFactorStatus();
      setStatus(s);
    } catch {
      setStatus({ enabled: false, method: null, backupCodesRemaining: 0 });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleStartSetup = () => {
    setSetupStep('choose-method');
  };

  const handleChooseMethod = async (method: 'totp' | 'email') => {
    setSetupMethod(method);
    try {
      const data = await authAPI.twoFactorSetup(method);
      setSetupData(data);
      if (method === 'totp') {
        setSetupStep('qr');
      } else {
        setSetupStep('email-verify');
        setResendCountdown(60);
      }
    } catch (err: any) {
      addToast('error', err.response?.data?.error || 'Failed to start 2FA setup');
    }
  };

  const handleVerifySetup = async () => {
    if (verifyCode.length !== 6) return;
    setVerifying(true);
    try {
      const { backupCodes: codes } = await authAPI.twoFactorVerifySetup(verifyCode, setupMethod);
      setBackupCodes(codes);
      setSetupStep('backup');
      setVerifyCode('');
      sounds.success();
      addToast('success', 'Two-factor authentication enabled!');
      loadStatus();
    } catch (err: any) {
      sounds.error();
      addToast('error', err.response?.data?.error || 'Invalid verification code');
    } finally {
      setVerifying(false);
    }
  };

  const handleResendSetupEmail = async () => {
    if (resendCountdown > 0) return;
    try {
      await authAPI.twoFactorSetup('email');
      setResendCountdown(60);
      addToast('success', 'Verification code resent');
    } catch (err: any) {
      addToast('error', err.response?.data?.error || 'Failed to resend code');
    }
  };

  const handleSendDisableEmail = async () => {
    try {
      await authAPI.twoFactorSendEmailAuthenticated();
      setDisableEmailSent(true);
      setResendCountdown(60);
      addToast('success', 'Verification code sent to your email');
    } catch (err: any) {
      addToast('error', err.response?.data?.error || 'Failed to send verification code');
    }
  };

  const handleSendRegenEmail = async () => {
    try {
      await authAPI.twoFactorSendEmailAuthenticated();
      setRegenEmailSent(true);
      setResendCountdown(60);
      addToast('success', 'Verification code sent to your email');
    } catch (err: any) {
      addToast('error', err.response?.data?.error || 'Failed to send verification code');
    }
  };

  const handleDisable = async () => {
    if (disableCode.length < 6) return;
    setDisabling(true);
    try {
      await authAPI.twoFactorDisable(disableCode);
      sounds.success();
      addToast('success', 'Two-factor authentication disabled');
      setShowDisableConfirm(false);
      setDisableCode('');
      setDisableEmailSent(false);
      loadStatus();
    } catch (err: any) {
      sounds.error();
      addToast('error', err.response?.data?.error || 'Failed to disable 2FA');
    } finally {
      setDisabling(false);
    }
  };

  const handleRegenerateBackupCodes = async () => {
    if (regenCode.length !== 6) return;
    setRegenerating(true);
    try {
      const { backupCodes: codes } = await authAPI.twoFactorRegenerateBackupCodes(regenCode);
      setBackupCodes(codes);
      setSetupStep('backup');
      setShowRegen(false);
      setRegenCode('');
      setRegenEmailSent(false);
      sounds.success();
      addToast('success', 'Backup codes regenerated');
      loadStatus();
    } catch (err: any) {
      sounds.error();
      addToast('error', err.response?.data?.error || 'Failed to regenerate backup codes');
    } finally {
      setRegenerating(false);
    }
  };

  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join('\n'));
    addToast('success', 'Backup codes copied to clipboard');
  };

  const formatSecret = (secret: string) => {
    return secret.match(/.{1,4}/g)?.join(' ') || secret;
  };

  const isEmailMethod = status?.method === 'email';

  if (loading) {
    return (
      <SectionCard title="Two-Factor Authentication">
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading...
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              onClick={() => handleChooseMethod('totp')}
              className="p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-emerald-500/30 transition-all text-left group"
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
            <button
              onClick={() => handleChooseMethod('email')}
              className="p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-blue-500/30 transition-all text-left group"
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
          </div>
          <button
            onClick={() => setSetupStep('idle')}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      </SectionCard>
    );
  }

  // Email verify step (during setup)
  if (setupStep === 'email-verify') {
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
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                value={verifyCode}
                onChange={e => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all font-mono text-center tracking-[0.3em]"
              />
              <button
                onClick={handleVerifySetup}
                disabled={verifyCode.length !== 6 || verifying}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  verifyCode.length === 6
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30'
                    : 'bg-white/[0.04] text-slate-500 border border-white/[0.06] cursor-not-allowed'
                }`}
              >
                {verifying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Verify & Enable
              </button>
            </div>
            <button
              onClick={handleResendSetupEmail}
              disabled={resendCountdown > 0}
              className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              <RefreshCw size={12} />
              {resendCountdown > 0 ? `Resend code (${resendCountdown}s)` : 'Resend code'}
            </button>
          </div>
          <button
            onClick={() => { setSetupStep('idle'); setSetupData(null); setVerifyCode(''); }}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
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
          <div className="flex justify-center py-4">
            <div className="p-4 bg-white rounded-xl">
              <QRCodeSVG value={setupData.otpauthUrl!} size={180} />
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
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                value={verifyCode}
                onChange={e => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all font-mono text-center tracking-[0.3em]"
              />
              <button
                onClick={handleVerifySetup}
                disabled={verifyCode.length !== 6 || verifying}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  verifyCode.length === 6
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30'
                    : 'bg-white/[0.04] text-slate-500 border border-white/[0.06] cursor-not-allowed'
                }`}
              >
                {verifying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                Verify & Enable
              </button>
            </div>
          </div>
          <button
            onClick={() => { setSetupStep('idle'); setSetupData(null); setVerifyCode(''); }}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Cancel setup
          </button>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Two-Factor Authentication">
      {status?.enabled ? (
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
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setShowDisableConfirm(true);
                setDisableEmailSent(false);
                setDisableCode('');
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-red-400 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 transition-all"
            >
              <X size={14} /> Disable 2FA
            </button>
            <button
              onClick={() => {
                setShowRegen(true);
                setRegenEmailSent(false);
                setRegenCode('');
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-blue-400 bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 transition-all"
            >
              <KeyRound size={14} /> Regenerate Backup Codes
            </button>
          </div>

          {/* Disable confirmation */}
          {showDisableConfirm && (
            <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20 space-y-3">
              <p className="text-sm text-red-400 font-medium">Confirm disable 2FA</p>
              {isEmailMethod && !disableEmailSent ? (
                <>
                  <p className="text-xs text-slate-400">We need to verify your identity. Click below to receive a verification code.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleSendDisableEmail}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30 transition-all"
                    >
                      Send verification code
                    </button>
                    <button
                      onClick={() => { setShowDisableConfirm(false); setDisableCode(''); }}
                      className="px-3 py-2 rounded-lg text-sm text-slate-400 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-400">
                    {isEmailMethod ? 'Enter the verification code sent to your email:' : 'Enter your current authenticator code to confirm:'}
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="one-time-code"
                      value={disableCode}
                      onChange={e => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      maxLength={6}
                      className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-red-500/30 transition-all font-mono text-center tracking-[0.3em]"
                    />
                    <button
                      onClick={handleDisable}
                      disabled={disableCode.length < 6 || disabling}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30 disabled:opacity-50 transition-all"
                    >
                      {disabling ? <Loader2 size={14} className="animate-spin" /> : 'Disable'}
                    </button>
                    <button
                      onClick={() => { setShowDisableConfirm(false); setDisableCode(''); setDisableEmailSent(false); }}
                      className="px-3 py-2 rounded-lg text-sm text-slate-400 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Regenerate backup codes */}
          {showRegen && (
            <div className="p-4 rounded-lg bg-blue-500/5 border border-blue-500/20 space-y-3">
              <p className="text-sm text-blue-400 font-medium">Regenerate backup codes</p>
              {isEmailMethod && !regenEmailSent ? (
                <>
                  <p className="text-xs text-slate-400">We need to verify your identity. Click below to receive a verification code.</p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleSendRegenEmail}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500/20 text-blue-400 border border-blue-500/20 hover:bg-blue-500/30 transition-all"
                    >
                      Send verification code
                    </button>
                    <button
                      onClick={() => { setShowRegen(false); setRegenCode(''); }}
                      className="px-3 py-2 rounded-lg text-sm text-slate-400 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-400">
                    {isEmailMethod ? 'Enter the verification code sent to your email:' : 'Enter your current authenticator code to generate new backup codes:'}
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="one-time-code"
                      value={regenCode}
                      onChange={e => setRegenCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      maxLength={6}
                      className="flex-1 px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/30 transition-all font-mono text-center tracking-[0.3em]"
                    />
                    <button
                      onClick={handleRegenerateBackupCodes}
                      disabled={regenCode.length !== 6 || regenerating}
                      className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500/20 text-blue-400 border border-blue-500/20 hover:bg-blue-500/30 disabled:opacity-50 transition-all"
                    >
                      {regenerating ? <Loader2 size={14} className="animate-spin" /> : 'Regenerate'}
                    </button>
                    <button
                      onClick={() => { setShowRegen(false); setRegenCode(''); setRegenEmailSent(false); }}
                      className="px-3 py-2 rounded-lg text-sm text-slate-400 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
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
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30 transition-all"
          >
            <Shield size={16} /> Enable Two-Factor Authentication
          </button>
        </div>
      )}
    </SectionCard>
  );
}

function ProfileTab({ addToast }: { addToast: (type: 'success' | 'error', msg: string) => void }) {
  const { user } = useAuthStore();
  const [username, setUsername] = useState(user?.username || '');
  const [email, setEmail] = useState(user?.email || '');
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);

  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setEmail(user.email);
    }
  }, [user]);

  const handleProfileSave = async () => {
    setProfileSaving(true);
    try {
      await client.put('/auth/me', { username, email });
      setProfileDirty(false);
      sounds.success();
      addToast('success', 'Profile updated');
    } catch (err: any) {
      sounds.error();
      addToast('error', err.response?.data?.error || 'Failed to update profile');
    } finally {
      setProfileSaving(false);
    }
  };

  const handlePasswordChange = async () => {
    if (newPassword !== confirmPassword) {
      addToast('error', 'Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      addToast('error', 'Password must be at least 8 characters');
      return;
    }
    setPasswordSaving(true);
    try {
      await client.post('/auth/change-password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      sounds.success();
      addToast('success', 'Password changed successfully');
    } catch (err: any) {
      sounds.error();
      addToast('error', err.response?.data?.error || 'Failed to change password');
    } finally {
      setPasswordSaving(false);
    }
  };

  return (
    <div>
      <SectionCard title="Profile Information">
        <div className="space-y-4">
          <div>
            <FieldLabel label="Username" />
            <TextInput
              value={username}
              onChange={v => { setUsername(v); setProfileDirty(true); }}
              placeholder="Your username"
            />
          </div>
          <div>
            <FieldLabel label="Email" />
            <TextInput
              value={email}
              onChange={v => { setEmail(v); setProfileDirty(true); }}
              placeholder="your@email.com"
            />
          </div>
          <div className="text-xs text-slate-500">
            Role: <span className="text-slate-300 font-medium">{user?.role}</span>
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <SaveButton onClick={handleProfileSave} isDirty={profileDirty} saving={profileSaving} />
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
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                className="w-full px-3 py-2 pr-10 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowCurrentPw(!showCurrentPw)}
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
                onChange={e => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full px-3 py-2 pr-10 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowNewPw(!showNewPw)}
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
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Repeat new password"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500/30 focus:ring-1 focus:ring-emerald-500/20 transition-all"
            />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button
            onClick={handlePasswordChange}
            disabled={!currentPassword || !newPassword || !confirmPassword || passwordSaving}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
              currentPassword && newPassword && confirmPassword
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/30'
                : 'bg-white/[0.04] text-slate-500 border border-white/[0.06] cursor-not-allowed'
            }`}
          >
            {passwordSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Change Password
          </button>
        </div>
      </SectionCard>

      {/* Sound Preferences */}
      <SoundPreferencesSection />

      {/* Two-Factor Authentication (only shown for non-elevated users; elevated users see it in Security tab) */}
      {!isElevated(user) && <TwoFactorSection addToast={addToast} />}
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
  const isAdmin = isElevated(user);
  const isOwner = isOwnerRole(user?.role);
  const tabs = allTabs.filter(t => !t.adminOnly || isOwner);
  const [activeTab, setActiveTab] = useState<TabId>(isOwner ? 'general' : 'profile');
  const { toasts, add: addToast } = useToasts();

  // Admin settings state
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);

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

  // Load admin settings
  useEffect(() => {
    if (!isOwner) return;
    setSettingsLoading(true);
    adminAPI.getSettings()
      .then(data => {
        setSettings(data);
      })
      .catch(() => addToast('error', 'Failed to load settings'))
      .finally(() => setSettingsLoading(false));
  }, [isOwner, addToast]);

  const saveSettings = useCallback(async (keys: string[], tab: TabId) => {
    try {
      const payload: Record<string, string> = {};
      for (const k of keys) {
        if (settings[k] !== undefined) payload[k] = settings[k];
      }
      const updated = await adminAPI.updateSettings(payload);
      setSettings(prev => ({ ...prev, ...updated }));
      markClean(tab);
      sounds.success();
      addToast('success', 'Settings saved');
    } catch {
      sounds.error();
      addToast('error', 'Failed to save settings');
    }
  }, [settings, markClean, addToast]);

  const updateSetting = useCallback((key: string, value: string, tab: TabId) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    markDirty(tab);
  }, [markDirty]);

  const setSettingValue = useCallback((key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 lg:p-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center accent-icon-badge"
          style={{ background: 'var(--accent-bg-subtle)', borderColor: 'var(--accent-border)' }}>
          <Settings size={20} style={{ color: 'var(--accent)' }} />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-theme-text">Settings</h1>
          <p className="text-xs text-theme-text-muted">Manage your portal configuration</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Sidebar Tabs */}
        <div className="md:w-56 flex-shrink-0">
          <div className="flex md:flex-col gap-1 bg-white/[0.03] rounded-xl p-1.5 border border-white/[0.06] overflow-x-auto md:overflow-visible">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => { sounds.click(); setActiveTab(id); }}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
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
                {dirtyTabs.has(id) && <span className="text-amber-400 text-xs ml-auto">*</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Content */}
        <div className="flex-1 min-w-0">
          {settingsLoading && isAdmin && activeTab !== 'profile' && activeTab !== 'backups' ? (
            <div className="flex items-center justify-center py-20 text-slate-500">
              <Loader2 size={24} className="animate-spin mr-2" /> Loading settings...
            </div>
          ) : (
            <>
              {activeTab === 'general' && (
                <GeneralTab
                  settings={settings}
                  updateSetting={(k, v) => updateSetting(k, v, 'general')}
                  setSettingValue={setSettingValue}
                  onSave={() => saveSettings([
                    'appearance.portalName', 'appearance.logoUrl', 'appearance.assistantName',
                    'appearance.agentAvatar.OPENCLAW', 'appearance.agentAvatar.CLAUDE_CODE', 'appearance.agentAvatar.CODEX',
                    'appearance.agentAvatar.AGENT_ZERO', 'appearance.agentAvatar.GEMINI', 'appearance.agentAvatar.OLLAMA',
                    'appearance.theme', 'appearance.accentColor'
                  ], 'general')}
                  isDirty={dirtyTabs.has('general')}
                  addToast={addToast}
                />
              )}
              {activeTab === 'email' && (
                <EmailTab
                  settings={settings}
                  updateSetting={(k, v) => updateSetting(k, v, 'email')}
                  onSave={() => saveSettings([
                    'notifications.newRegistration', 'notifications.userApproved', 'notifications.systemAlerts',
                    'notifications.passwordChange', 'notifications.newDeviceLogin'
                  ], 'email')}
                  isDirty={dirtyTabs.has('email')}
                  addToast={addToast}
                />
              )}
              {activeTab === 'security' && (
                <SecurityTab
                  settings={settings}
                  updateSetting={(k, v) => updateSetting(k, v, 'security')}
                  onSave={() => saveSettings([
                    'security.registrationMode', 'security.maxLoginAttempts', 'security.sessionDurationHours',
                    'security.sandboxDefaultEnabled', 'security.blockClosedRegistration'
                  ], 'security')}
                  isDirty={dirtyTabs.has('security')}
                  addToast={addToast}
                />
              )}
              {activeTab === 'agents' && (
                <AgentsTab
                  settings={settings}
                  updateSetting={(k, v) => updateSetting(k, v, 'agents')}
                  onSave={() => saveSettings([
                    'agents.enabledProviders', 'agents.defaultProvider',
                    'agents.maxSessionsPerUser', 'agents.openclaw.gatewayHost', 'agents.openclaw.gatewayPort',
                    'runners.openclaw.enabled', 'runners.openclaw.binaryPath', 'runners.openclaw.workingDirectory',
                    'runners.claudeCode.enabled', 'runners.claudeCode.binaryPath', 'runners.claudeCode.workingDirectory',
                    'runners.codex.enabled', 'runners.codex.binaryPath', 'runners.codex.workingDirectory',
                    'runners.shell.enabled', 'runners.shell.binaryPath', 'runners.shell.workingDirectory'
                  ], 'agents')}
                  isDirty={dirtyTabs.has('agents')}
                />
              )}
              {activeTab === 'system' && (
                <SystemTab
                  settings={settings}
                  updateSetting={(k, v) => updateSetting(k, v, 'system')}
                  onSave={() => saveSettings([
                    'system.allowTelemetry', 'remoteDesktop.url', 'remoteDesktop.allowedPathPrefixes'
                  ], 'system')}
                  isDirty={dirtyTabs.has('system')}
                  addToast={addToast}
                />
              )}
              {activeTab === 'ai-providers' && (
                <div className="space-y-5">
                  <AiProviderSetup mode="settings" apiBase="/ai-setup" />
                  <SectionCard title="Local Models (Ollama)">
                    <OllamaTab
                      settings={settings}
                      updateSetting={(k, v) => updateSetting(k, v, 'ai-providers')}
                      onSave={() => saveSettings([
                        'ollama.localEnabled', 'ollama.host', 'ollama.remoteHost', 'ollama.defaultModel',
                        'ollama.remote.tier.snappy', 'ollama.remote.tier.smart', 'ollama.remote.tier.best',
                        'ollama.local.tier.snappy', 'ollama.local.tier.smart', 'ollama.local.tier.best'
                      ], 'ai-providers')}
                      isDirty={dirtyTabs.has('ai-providers')}
                      addToast={addToast}
                    />
                  </SectionCard>
                </div>
              )}
              {activeTab === 'readiness' && <FeatureReadinessTab />}
              {activeTab === 'backups' && (
                <BackupsTab
                  backupPath={settings['system.backupPath'] || '/opt/bridgesllm/backups'}
                  onBackupPathChange={(v) => updateSetting('system.backupPath', v, 'backups')}
                  onSaveBackupPath={() => saveSettings(['system.backupPath'], 'backups')}
                  backupPathDirty={dirtyTabs.has('backups')}
                />
              )}
              {activeTab === 'profile' && <ProfileTab addToast={addToast} />}
            </>
          )}
        </div>
      </div>

      <SettingsToasts toasts={toasts} />
    </div>
  );
}
