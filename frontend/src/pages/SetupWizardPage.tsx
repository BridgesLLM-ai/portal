import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Cpu,
  Download,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Lock,
  Monitor,
  Palette,
  RefreshCw,
  Rocket,
  Server,
  Shield,
  Sparkles,
  Upload,
  User,
} from 'lucide-react';
import { useAuthStore } from '../contexts/AuthContext';
import client from '../api/client';
import AiProviderSetup from '../components/ai-setup/AiProviderSetup';
import { sounds } from '../utils/sounds';
import { DEFAULT_REGISTRATION_MODE } from '../utils/securityDefaults';

type ThemeMode = 'dark' | 'light' | 'system';
type RegistrationMode = 'open' | 'approval' | 'closed';
type AsyncState = 'idle' | 'loading' | 'success' | 'error';
type DomainPath = 'domain' | 'skip';

interface DnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
  description?: string;
}

interface SystemInfoResponse {
  publicIp: string;
  ramGb: number;
  diskGb: number;
  cpus: number;
  osName: string;
  currentDomain?: string;
  components: Record<string, { installed: boolean; running?: boolean; version?: string }>;
}

interface DnsCheckResponse {
  domain: string;
  resolves: boolean;
  pointsToUs: boolean;
  resolvedIps: string[];
  expectedIp: string;
  message: string;
}

interface MailStatusResponse {
  available: boolean;
  configured: boolean;
  canSend: boolean;
  dnsRecords: DnsRecord[];
  domain?: string;
  hasDomain: boolean;
}

interface InstallMailResponse {
  success: boolean;
  domain: string;
  dnsRecords: DnsRecord[];
  message: string;
}

interface OllamaModelRecommendation {
  name: string;
  description: string;
  size: string;
}

interface OllamaStatusResponse {
  running: boolean;
  endpoint: string;
  models: string[];
  ramGb: number;
  ramTier: string;
  warning: string | null;
  recommendedModels: OllamaModelRecommendation[];
}

interface OpenClawStatusResponse {
  installed: boolean;
  version: string;
  gatewayRunning: boolean;
  gatewayUrl: string;
  hasToken: boolean;
  description: string;
}

interface CodingToolStatusResponse {
  tools: Array<{
    id: string;
    name: string;
    description: string;
    installed: boolean;
    version: string;
    installCmd: string;
  }>;
}

const STEPS = [
  { id: 'welcome', title: 'Welcome', icon: Rocket },
  { id: 'domain', title: 'Domain & HTTPS', icon: Globe },
  { id: 'admin', title: 'Admin Account', icon: User },
  { id: 'identity', title: 'Portal Identity', icon: Palette },
  { id: 'security', title: 'Security', icon: Lock },
  { id: 'email', title: 'Email & Security', icon: Shield },
  { id: 'ai', title: 'AI Setup', icon: Cpu },
  { id: 'remoteDesktop', title: 'Remote Desktop', icon: Monitor },
  { id: 'review', title: 'Review & Launch', icon: Sparkles },
] as const;

const ACCENT_PRESETS = [
  { name: 'Emerald', color: '#10b981' },
  { name: 'Blue', color: '#3b82f6' },
  { name: 'Violet', color: '#8b5cf6' },
  { name: 'Rose', color: '#f43f5e' },
  { name: 'Amber', color: '#f59e0b' },
  { name: 'Cyan', color: '#06b6d4' },
];

const REGISTRATION_OPTIONS: Array<{ value: RegistrationMode; title: string; description: string }> = [
  { value: 'open', title: 'Open', description: 'Anyone can create an account and start using your portal right away.' },
  { value: 'approval', title: 'Approval', description: 'People can request access, but an admin must approve them first.' },
  { value: 'closed', title: 'Closed', description: 'Only admins can create accounts. No public sign-ups.' },
];

const SECURITY_FEATURES = [
  { icon: '🔐', title: 'Two-factor authentication', description: 'Get login codes via email' },
  { icon: '🔑', title: 'Password resets', description: 'Recover accounts securely' },
  { icon: '🚨', title: 'Login alerts', description: 'Get notified of new device logins' },
  { icon: '👋', title: 'Welcome emails', description: 'Onboard new users automatically' },
];

const inputClass = 'w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white placeholder-slate-500 outline-none transition focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500';
const cardClass = 'rounded-2xl border border-slate-800 bg-slate-900/70';

function friendlyError(error: any, fallback: string) {
  return error?.response?.data?.error || error?.message || fallback;
}

const PASSWORD_POLICY_HINT = 'Use at least 8 characters, including 1 uppercase letter, 1 lowercase letter, and 1 number.';

function validatePasswordPolicy(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (password.length < 8) errors.push('Use at least 8 characters.');
  if (!/[A-Z]/.test(password)) errors.push('Add at least 1 uppercase letter.');
  if (!/[a-z]/.test(password)) errors.push('Add at least 1 lowercase letter.');
  if (!/[0-9]/.test(password)) errors.push('Add at least 1 number.');

  return {
    valid: errors.length === 0,
    errors,
  };
}

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      // navigator.clipboard requires HTTPS — fall back for plain HTTP
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      sounds.success();
      setTimeout(() => setCopied(false), 1500);
    } catch {
      sounds.error();
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-slate-600 hover:bg-slate-800"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      <span className={copied ? 'text-emerald-400' : ''}>{copied ? 'Copied' : label}</span>
    </button>
  );
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`${inputClass} pr-11`}
      />
      <button
        type="button"
        onClick={() => setShow((current) => !current)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-200"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="grid grid-cols-4 gap-2 md:grid-cols-8">
      {STEPS.map((step, index) => {
        const Icon = step.icon;
        const active = index === currentStep;
        const complete = index < currentStep;

        return (
          <div key={step.id} className="flex flex-col items-center gap-2 text-center">
            <div
              className={[
                'flex h-10 w-10 items-center justify-center rounded-full border transition-all',
                active ? 'border-emerald-400 bg-emerald-500 text-white shadow-lg shadow-emerald-500/20 scale-105' : '',
                complete ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : '',
                !active && !complete ? 'border-slate-800 bg-slate-900 text-slate-500' : '',
              ].join(' ')}
            >
              {complete ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
            </div>
            <div>
              <p className={`text-[11px] font-medium ${active ? 'text-white' : complete ? 'text-emerald-300' : 'text-slate-500'}`}>{step.title}</p>
              <p className="text-[10px] text-slate-600">{active ? 'Current' : complete ? 'Done' : 'Upcoming'}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StepShell({ children, stepKey }: { children: ReactNode; stepKey?: string | number }) {
  return (
    <motion.div
      key={stepKey ?? 'step'}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -18 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      {children}
    </motion.div>
  );
}

export default function SetupWizardPage() {
  const navigate = useNavigate();
  const { restoreSession } = useAuthStore();
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Extract one-time setup token from URL query param
  const setupToken = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('token') || '';
  }, []);

  // Restore step from URL (used after HTTP→HTTPS redirect preserves progress)
  const initialStep = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const s = parseInt(params.get('step') || '0', 10);
    return Number.isFinite(s) && s >= 0 && s <= 8 ? s : 0;
  }, []);

  // Setup-aware API helper — attaches token to every setup call
  const setupClient = useMemo(() => {
    const instance = client;
    // Add interceptor to inject setup token
    const interceptorId = instance.interceptors.request.use((cfg) => {
      if (setupToken && cfg.url?.startsWith('/setup/') && cfg.url !== '/setup/status') {
        cfg.headers = cfg.headers || {};
        cfg.headers['x-setup-token'] = setupToken;
      }
      return cfg;
    });
    // Return cleanup for the interceptor
    return { client: instance, interceptorId };
  }, [setupToken]);

  // Shortcut
  const api = setupClient.client;

  const [step, setStep] = useState(initialStep);
  const [error, setError] = useState('');
  const [setupComplete, setSetupComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [portalName, setPortalName] = useState('');
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [accentColor, setAccentColor] = useState('#10b981');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState('');

  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>(DEFAULT_REGISTRATION_MODE);
  const [allowTelemetry, setAllowTelemetry] = useState(true);
  const [searchEngineVisibility, setSearchEngineVisibility] = useState<'visible' | 'hidden'>('hidden');

  const [systemInfo, setSystemInfo] = useState<SystemInfoResponse | null>(null);
  const [systemInfoState, setSystemInfoState] = useState<AsyncState>('idle');

  const [domainPath, setDomainPath] = useState<DomainPath>('domain');
  const [domain, setDomain] = useState('');
  const [dnsStatus, setDnsStatus] = useState<DnsCheckResponse | null>(null);
  const [dnsState, setDnsState] = useState<AsyncState>('idle');
  const [domainConfigState, setDomainConfigState] = useState<AsyncState>('idle');
  const [configuredDomainUrl, setConfiguredDomainUrl] = useState('');
  const [domainMessage, setDomainMessage] = useState('');

  const [tokenInvalid, setTokenInvalid] = useState(false);

  const [mailStatus, setMailStatus] = useState<MailStatusResponse | null>(null);
  const [mailStatusState, setMailStatusState] = useState<AsyncState>('idle');
  const [installMailState, setInstallMailState] = useState<AsyncState>('idle');
  const [installMailMessage, setInstallMailMessage] = useState('');
  const [mailDnsRecords, setMailDnsRecords] = useState<DnsRecord[]>([]);
  const [testEmailState, setTestEmailState] = useState<AsyncState>('idle');
  const [testEmailMessage, setTestEmailMessage] = useState('');
  const [mailPreflight, setMailPreflight] = useState<{ provider: string; providerName: string; dockerOk: boolean; port25Open: boolean; smtpBlocked: boolean; providerInstructions: string | null; providerLink: string | null; canSelfHost: boolean } | null>(null);
  const [preflightState, setPreflightState] = useState<AsyncState>('idle');

  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatusResponse | null>(null);
  const [ollamaState, setOllamaState] = useState<AsyncState>('idle');
  const [pullingModel, setPullingModel] = useState('');
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawStatusResponse | null>(null);
  const [openClawState, setOpenClawState] = useState<AsyncState>('idle');
  const [codingToolsStatus, setCodingToolsStatus] = useState<CodingToolStatusResponse | null>(null);
  const [installingTool, setInstallingTool] = useState('');

  const [rdSetupState, setRdSetupState] = useState<AsyncState>('idle');
  const [rdSetupMessage, setRdSetupMessage] = useState('');
  const [rdSetupSteps, setRdSetupSteps] = useState<Array<{ step: string; ok: boolean; message: string }>>([]);

  const progress = useMemo(() => ((step + 1) / STEPS.length) * 100, [step]);
  const emailLooksValid = useMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), [email]);
  const passwordPolicy = useMemo(() => validatePasswordPolicy(password), [password]);
  const adminStepValid = useMemo(
    () => name.trim().length >= 2 && emailLooksValid && passwordPolicy.valid && password === confirmPassword,
    [confirmPassword, emailLooksValid, name, password, passwordPolicy.valid],
  );
  const domainConfigured = useMemo(() => Boolean(configuredDomainUrl || mailStatus?.domain || dnsStatus?.pointsToUs), [configuredDomainUrl, mailStatus?.domain, dnsStatus?.pointsToUs]);

  const goNext = () => {
    sounds.click();
    setError('');

    // If domain/HTTPS was configured while we're still on HTTP, use Next as the
    // explicit handoff into the secure portal instead of auto-redirecting.
    if (step === 1 && configuredDomainUrl && window.location.protocol === 'http:') {
      const newUrl = new URL(window.location.href);
      const httpsBase = new URL(configuredDomainUrl);
      newUrl.protocol = httpsBase.protocol;
      newUrl.hostname = httpsBase.hostname;
      newUrl.port = httpsBase.port || '';
      newUrl.searchParams.set('step', String(step + 1));
      window.location.href = newUrl.toString();
      return;
    }

    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const goBack = () => {
    sounds.click();
    setError('');
    setStep((current) => Math.max(current - 1, 0));
  };

  const loadSystemInfo = useCallback(async () => {
    setSystemInfoState('loading');
    try {
      const { data } = await api.get<SystemInfoResponse>('/setup/system-info');
      setSystemInfo(data);
      setSystemInfoState('success');
      if (data.currentDomain) {
        setDomain(data.currentDomain);
        setConfiguredDomainUrl(`https://${data.currentDomain}`);
      }
    } catch (err: any) {
      if (err?.response?.status === 403 && err?.response?.data?.error?.includes('setup token')) {
        setTokenInvalid(true);
        return;
      }
      setSystemInfoState('error');
      setError(friendlyError(err, 'Could not load server details right now.'));
    }
  }, [api]);

  const loadMailStatus = useCallback(async () => {
    setMailStatusState('loading');
    try {
      const { data } = await api.get<MailStatusResponse>('/setup/mail-status');
      setMailStatus(data);
      setMailDnsRecords(data.dnsRecords || []);
      setMailStatusState('success');
      if (data.domain) {
        setDomain(data.domain);
        setConfiguredDomainUrl(`https://${data.domain}`);
      }
    } catch (err) {
      setMailStatusState('error');
      setMailStatus(null);
    }
  }, []);

  const loadAiStatus = useCallback(async () => {
    setOllamaState('loading');
    setOpenClawState('loading');

    try {
      const [{ data: ollama }, { data: openclaw }, { data: codingTools }] = await Promise.all([
        api.get<OllamaStatusResponse>('/setup/ollama-status'),
        api.get<OpenClawStatusResponse>('/setup/openclaw-status'),
        api.get<CodingToolStatusResponse>('/setup/coding-tools-status'),
      ]);
      setOllamaStatus(ollama);
      setOpenClawStatus(openclaw);
      setCodingToolsStatus(codingTools);
      setOllamaState('success');
      setOpenClawState('success');
    } catch (err) {
      try {
        const { data } = await api.get<OllamaStatusResponse>('/setup/ollama-status');
        setOllamaStatus(data);
        setOllamaState('success');
      } catch {
        setOllamaState('error');
      }
      try {
        const { data } = await api.get<OpenClawStatusResponse>('/setup/openclaw-status');
        setOpenClawStatus(data);
        setOpenClawState('success');
      } catch {
        setOpenClawState('error');
      }
      try {
        const { data } = await api.get<CodingToolStatusResponse>('/setup/coding-tools-status');
        setCodingToolsStatus(data);
      } catch {
        setCodingToolsStatus({ tools: [] });
      }
    }
  }, [api]);

  const [isReinstall, setIsReinstall] = useState(false);
  const [ownerHint, setOwnerHint] = useState('');
  const [reinstallPassword, setReinstallPassword] = useState('');
  const [reinstallConfirmPassword, setReinstallConfirmPassword] = useState('');
  const [reinstallError, setReinstallError] = useState('');
  const [reinstallSubmitting, setReinstallSubmitting] = useState(false);

  useEffect(() => {
    api.get('/setup/status').then(({ data }) => {
      if (data.isReinstall) {
        setIsReinstall(true);
        if (data.ownerHint) setOwnerHint(data.ownerHint);
      } else if (!data.needsSetup) {
        navigate('/login', { replace: true });
      }
    }).catch(() => undefined);
  }, [navigate]);


  useEffect(() => {
    loadSystemInfo();
    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
      // Clean up setup token interceptor
      api.interceptors.request.eject(setupClient.interceptorId);
    };
  }, [loadSystemInfo, api, setupClient.interceptorId]);

  const loadMailPreflight = useCallback(async () => {
    setPreflightState('loading');
    try {
      const { data } = await api.get('/setup/mail-preflight');
      setMailPreflight(data);
      setPreflightState('success');
    } catch {
      setPreflightState('error');
    }
  }, [api]);

  useEffect(() => {
    if (step === 5 && mailStatusState === 'idle') {
      loadMailStatus();
      if (preflightState === 'idle') loadMailPreflight();
    }
    if (step === 6 && (ollamaState === 'idle' || openClawState === 'idle')) loadAiStatus();
  }, [step, mailStatusState, ollamaState, openClawState, preflightState, loadMailStatus, loadMailPreflight, loadAiStatus]);

  const reinstallPasswordPolicy = useMemo(() => validatePasswordPolicy(reinstallPassword), [reinstallPassword]);
  const reinstallFormValid = useMemo(
    () => reinstallPassword.length > 0 && reinstallPasswordPolicy.valid && reinstallPassword === reinstallConfirmPassword,
    [reinstallConfirmPassword, reinstallPassword, reinstallPasswordPolicy.valid],
  );

  const handleLogoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const handleCheckDns = async () => {
    if (!domain.trim()) return;
    setDnsState('loading');
    setDomainMessage('');
    setDnsStatus(null);
    try {
      const { data } = await api.post<DnsCheckResponse>('/setup/check-dns', { domain: domain.trim() });
      setDnsStatus(data);
      setDnsState('success');
      setDomainMessage(data.message);
      if (data.pointsToUs) sounds.success();
    } catch (err) {
      setDnsState('error');
      setDomainMessage(friendlyError(err, 'DNS lookup failed. Double-check your domain and try again.'));
      sounds.error();
    }
  };

  const handleConfigureDomain = async () => {
    if (!domain.trim()) return;
    setDomainConfigState('loading');
    setDomainMessage('');
    try {
      const { data } = await api.post<{ success: boolean; url: string; message: string; httpsReady?: boolean }>('/setup/configure-domain', { domain: domain.trim() });
      setConfiguredDomainUrl(data.url);
      setDomainConfigState('success');
      setDomainMessage(data.httpsReady === false ? `${data.message} (HTTPS certificate is still being provisioned — it may take a moment)` : data.message);
      sounds.success();

      // Do NOT auto-redirect. The DNS/TLS handoff can race the first browser
      // navigation even when the cert is basically ready. Show a clear CTA and
      // let the user click into HTTPS when they're ready.
      if (!data.url) {
        await loadMailStatus();
      }
    } catch (err) {
      setDomainConfigState('error');
      setDomainMessage(friendlyError(err, 'HTTPS setup failed. Please confirm DNS is pointed here and try again.'));
      sounds.error();
    }
  };

  const handleInstallMail = async () => {
    setInstallMailState('loading');
    setInstallMailMessage('Pulling the mail server image and preparing security features...');
    try {
      const { data } = await api.post<InstallMailResponse>('/setup/install-mail');
      setInstallMailState('success');
      setInstallMailMessage(data.message);
      setMailDnsRecords(data.dnsRecords || []);
      sounds.success();
      await loadMailStatus();
    } catch (err) {
      setInstallMailState('error');
      setInstallMailMessage(friendlyError(err, 'Email setup failed. You can skip this for now and come back later.'));
      sounds.error();
    }
  };

  const handleTestEmail = async () => {
    if (!emailLooksValid) {
      setTestEmailState('error');
      setTestEmailMessage('Enter a valid admin email first so we know where to send the test message.');
      return;
    }

    setTestEmailState('loading');
    setTestEmailMessage('Sending a test email...');
    try {
      const { data } = await api.post<{ success: boolean; message: string }>('/setup/test-email', { email });
      setTestEmailState('success');
      setTestEmailMessage(data.message || 'Test email sent.');
      sounds.success();
    } catch (err) {
      setTestEmailState('error');
      setTestEmailMessage(friendlyError(err, 'The test email did not send. Check your DNS records and try again later.'));
      sounds.error();
    }
  };

  const handlePullModel = async (model: string) => {
    setPullingModel(model);
    try {
      await api.post('/setup/ollama-pull', { model });
      sounds.success();
      await loadAiStatus();
    } catch (err) {
      setError(friendlyError(err, `Could not pull ${model}. Try again in a minute.`));
      sounds.error();
    } finally {
      setPullingModel('');
    }
  };

  const handleComplete = async () => {
    if (name.trim().length < 2 || !emailLooksValid) {
      setError('Finish the admin account step before launching the portal.');
      return;
    }

    if (!passwordPolicy.valid) {
      setError(PASSWORD_POLICY_HINT);
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords must match before launching the portal.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      let logoUrl = '';
      if (logoFile) {
        const formData = new FormData();
        formData.append('file', logoFile);
        const { data } = await api.post<{ url: string }>('/setup/upload-logo', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        logoUrl = data.url;
      }

      await api.post('/setup/complete', {
        name,
        email,
        password,
        portalName: portalName || 'My AI Portal',
        theme,
        accentColor,
        logoUrl: logoUrl || undefined,
        registrationMode,
        allowTelemetry,
        searchEngineVisibility,
      });

      localStorage.setItem('theme', theme);
      localStorage.setItem('accentColor', accentColor);
      sounds.success();
      setSetupComplete(true);

      // The backend schedules a service restart after setup completes (to pick
      // up env changes like CORS_ORIGIN, cookie flags, etc.). Wait for the
      // server to come back before trying to restore the session.
      const waitForServer = async (maxWait = 20000) => {
        const start = Date.now();
        // Give the restart time to begin
        await new Promise(r => setTimeout(r, 4000));
        while (Date.now() - start < maxWait) {
          try {
            const resp = await fetch('/health', { signal: AbortSignal.timeout(2000) });
            if (resp.ok) return true;
          } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
        return false;
      };

      await waitForServer();
      const restored = await restoreSession();
      if (restored) {
        navigate('/dashboard', { replace: true });
      }
    } catch (err) {
      setError(friendlyError(err, 'Setup could not be completed. Please review the details and try again.'));
      sounds.error();
    } finally {
      setSubmitting(false);
    }
  };

  const handleReinstallReset = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setReinstallError('');

    if (reinstallPassword !== reinstallConfirmPassword) {
      setReinstallError('Passwords must match.');
      return;
    }

    if (!reinstallPasswordPolicy.valid) {
      setReinstallError(PASSWORD_POLICY_HINT);
      return;
    }

    setReinstallSubmitting(true);
    try {
      const { data } = await api.post('/setup/reinstall-reset', { password: reinstallPassword });
      alert(`Password reset! Log in with: ${data.email || data.username}`);
      navigate('/login', { replace: true });
    } catch (err: any) {
      setReinstallError(err?.response?.data?.error || 'Reset failed');
    } finally {
      setReinstallSubmitting(false);
    }
  };

  const renderWelcome = () => (
    <StepShell stepKey={step}>
      <div className="text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-xl shadow-emerald-900/30">
          <Rocket className="h-10 w-10 text-white" />
        </div>
        <h2 className="mt-5 text-3xl font-bold text-white">Your portal is installed!</h2>
        <p className="mt-2 text-slate-400">Let&apos;s finish setting it up. This takes about 5 minutes.</p>
      </div>

      <div className={`${cardClass} p-5`}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Server snapshot</h3>
            <p className="text-sm text-slate-400">What the installer found on this machine.</p>
          </div>
          <button type="button" onClick={loadSystemInfo} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800">
            <RefreshCw className={`h-4 w-4 ${systemInfoState === 'loading' ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {systemInfoState === 'loading' && !systemInfo ? (
          <div className="flex items-center justify-center py-8 text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading system info...</div>
        ) : systemInfo ? (
          <div className="space-y-5">
            <div className="grid gap-3 md:grid-cols-4">
              {[
                { label: 'OS', value: systemInfo.osName },
                { label: 'RAM', value: `${systemInfo.ramGb} GB` },
                { label: 'CPUs', value: String(systemInfo.cpus) },
                { label: 'Disk Free', value: `${systemInfo.diskGb} GB` },
              ].map((item) => (
                <div key={item.label} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">{item.label}</p>
                  <p className="mt-1 text-sm font-medium text-white">{item.value}</p>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-3 text-sm font-medium text-white">Installed components</p>
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  ['nodejs', 'Node.js'],
                  ['postgresql', 'PostgreSQL'],
                  ['caddy', 'Caddy'],
                  ['docker', 'Docker'],
                  ['ollama', 'Ollama'],
                  ['openclaw', 'OpenClaw'],
                  ['clamav', 'ClamAV'],
                ].map(([key, label]) => {
                  const component = systemInfo.components[key] || { installed: false };
                  const ok = component.installed;
                  return (
                    <div key={key} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                      <div>
                        <p className="text-sm font-medium text-white">{label}</p>
                        <p className="text-xs text-slate-500">{component.version || (component.running === false ? 'Installed, not running' : component.running ? 'Installed and running' : ok ? 'Installed' : 'Missing')}</p>
                      </div>
                      {ok ? <CheckCircle2 className="h-5 w-5 text-emerald-400" /> : <AlertTriangle className="h-5 w-5 text-amber-400" />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">We could not load server details right now, but you can still continue.</div>
        )}
      </div>

      <button type="button" onClick={goNext} className="w-full rounded-2xl bg-emerald-500 px-6 py-4 text-lg font-semibold text-white transition hover:bg-emerald-600">
        Let&apos;s Go
      </button>
    </StepShell>
  );

  const renderAdmin = () => (
    <StepShell stepKey={step}>
      <div>
        <h2 className="text-2xl font-bold text-white">Create your admin account</h2>
        <p className="mt-2 text-slate-400">This is YOUR account — the portal owner.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="mb-2 block text-sm font-medium text-slate-300">Full name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className={inputClass} />
          {name.length > 0 && name.trim().length < 2 && <p className="mt-2 text-xs text-amber-400">Use at least 2 characters.</p>}
        </div>
        <div className="md:col-span-2">
          <label className="mb-2 block text-sm font-medium text-slate-300">Email address</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputClass} />
          {email.length > 0 && !emailLooksValid && <p className="mt-2 text-xs text-amber-400">Enter a valid email address.</p>}
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300">Password</label>
          <PasswordInput value={password} onChange={setPassword} placeholder="Min 8 chars, upper/lower/number" />
          <p className={`mt-2 text-xs ${password.length > 0 && !passwordPolicy.valid ? 'text-amber-400' : 'text-slate-500'}`}>{PASSWORD_POLICY_HINT}</p>
          {password.length > 0 && !passwordPolicy.valid && (
            <ul className="mt-2 space-y-1 text-xs text-amber-300">
              {passwordPolicy.errors.map((message) => <li key={message}>• {message}</li>)}
            </ul>
          )}
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300">Confirm password</label>
          <PasswordInput value={confirmPassword} onChange={setConfirmPassword} placeholder="Repeat your password" />
          {confirmPassword.length > 0 && password !== confirmPassword && <p className="mt-2 text-xs text-amber-400">Passwords must match.</p>}
        </div>
      </div>
    </StepShell>
  );

  const renderIdentity = () => (
    <StepShell stepKey={step}>
      <div>
        <h2 className="text-2xl font-bold text-white">Portal identity</h2>
        <p className="mt-2 text-slate-400">Pick the look and branding you want people to see first.</p>
      </div>
      <div className="space-y-5">
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300">Portal name</label>
          <input value={portalName} onChange={(e) => setPortalName(e.target.value)} placeholder="My AI Portal" className={inputClass} />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300">Theme</label>
          <div className="grid gap-3 md:grid-cols-3">
            {(['dark', 'light', 'system'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setTheme(choice)}
                className={`rounded-xl border px-4 py-3 text-sm font-medium capitalize transition ${theme === choice ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'}`}
              >
                {choice}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-300">Accent color</label>
          <div className="flex flex-wrap gap-3">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.color}
                type="button"
                title={preset.name}
                onClick={() => setAccentColor(preset.color)}
                className={`h-11 w-11 rounded-xl border transition ${accentColor === preset.color ? 'scale-110 border-white ring-2 ring-white/60 ring-offset-2 ring-offset-slate-950' : 'border-slate-700 hover:scale-105'}`}
                style={{ backgroundColor: preset.color }}
              />
            ))}
            <label className="flex h-11 w-24 cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-600 bg-slate-900 text-sm text-slate-300 transition hover:border-slate-500">
              Custom
              <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} className="sr-only" />
            </label>
          </div>
        </div>

        <div className={`${cardClass} p-4`}>
          <label className="mb-3 block text-sm font-medium text-slate-300">Logo upload (optional)</label>
          <div className="flex flex-col gap-4 md:flex-row md:items-center">
            <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
              {logoPreview ? <img src={logoPreview} alt="Logo preview" className="h-full w-full object-contain" /> : <Upload className="h-6 w-6 text-slate-500" />}
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-600 hover:bg-slate-800">
              <Upload className="h-4 w-4" />
              {logoFile ? 'Replace logo' : 'Upload logo'}
              <input type="file" accept="image/*" className="sr-only" onChange={handleLogoChange} />
            </label>
          </div>
        </div>
      </div>
    </StepShell>
  );

  const renderSecurity = () => (
    <StepShell stepKey={step}>
      <div>
        <h2 className="text-2xl font-bold text-white">Security</h2>
        <p className="mt-2 text-slate-400">Decide who gets into the portal and how tightly you want to control access.</p>
      </div>
      <div className="space-y-3">
        {REGISTRATION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setRegistrationMode(option.value)}
            className={`w-full rounded-2xl border p-4 text-left transition ${registrationMode === option.value ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'}`}
          >
            <div className="flex items-center justify-between">
              <p className={`font-semibold ${registrationMode === option.value ? 'text-emerald-300' : 'text-white'}`}>{option.title}</p>
              {registrationMode === option.value && <Check className="h-4 w-4 text-emerald-400" />}
            </div>
            <p className="mt-2 text-sm text-slate-400">{option.description}</p>
          </button>
        ))}
      </div>
      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
        <div className="flex gap-3">
          <Shield className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-400" />
          <div>
            <p className="font-semibold text-white">2FA can be enabled later</p>
            <p className="mt-1 text-sm text-slate-300">Once setup is complete, you can turn on two-factor authentication for accounts that need stronger protection.</p>
          </div>
        </div>
      </div>

      <div className={`${cardClass} p-5`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-white">Search engines</h3>
            <p className="mt-1 text-sm text-slate-400">Allow search engines to find your portal. Leave this off if you want the portal hidden from indexing by default.</p>
          </div>
          <button
            type="button"
            onClick={() => setSearchEngineVisibility((current) => current === 'visible' ? 'hidden' : 'visible')}
            className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full border transition-colors duration-200 ${searchEngineVisibility === 'visible' ? 'border-emerald-400/40 bg-emerald-500' : 'border-slate-700 bg-slate-800'}`}
            aria-pressed={searchEngineVisibility === 'visible'}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 translate-y-0.5 rounded-full shadow-sm transition-transform duration-200 ${searchEngineVisibility === 'visible' ? 'translate-x-[22px] bg-white' : 'translate-x-0.5 bg-slate-400'}`}
            />
          </button>
        </div>
      </div>
    </StepShell>
  );

  const renderDomain = () => {
    // If we're already on HTTPS, domain is already configured
    const alreadyOnHttps = window.location.protocol === 'https:';
    const currentDomain = alreadyOnHttps ? window.location.hostname : '';

    return (
    <StepShell stepKey={step}>
      {alreadyOnHttps ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-2xl font-bold text-white">Domain &amp; HTTPS</h2>
            <p className="mt-2 text-slate-400">Your domain is already configured.</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <p className="font-semibold text-emerald-300">✓ HTTPS is active</p>
            <p className="mt-1 text-sm text-slate-200">{currentDomain}</p>
          </div>
        </div>
      ) : (
      <>
      <div>
        <h2 className="text-2xl font-bold text-white">Domain &amp; HTTPS</h2>
        <p className="mt-2 text-slate-400">Do you have a domain name pointed at this server?</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <button type="button" onClick={() => setDomainPath('domain')} className={`rounded-2xl border p-5 text-left transition ${domainPath === 'domain' ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'}`}>
          <p className="font-semibold text-white">I have a domain</p>
          <p className="mt-2 text-sm text-slate-400">We&apos;ll verify DNS and turn on HTTPS for you.</p>
        </button>
        <button type="button" onClick={() => setDomainPath('skip')} className={`rounded-2xl border p-5 text-left transition ${domainPath === 'skip' ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'}`}>
          <p className="font-semibold text-white">Not yet, skip for now</p>
          <p className="mt-2 text-sm text-slate-400">You can add a domain anytime in Settings → Domain.</p>
        </button>
      </div>

      {domainPath === 'domain' ? (
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Domain name</label>
            <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="portal.example.com" className={inputClass} />
          </div>

          {(() => {
            const ip = systemInfo?.publicIp || 'YOUR_SERVER_IP';
            const isSubdomain = domain ? domain.split('.').length > 2 : false;
            const hostName = isSubdomain ? domain.split('.')[0] : '@';
            const baseDomain = isSubdomain ? domain.split('.').slice(1).join('.') : domain;
            const dnsRecords = [
              { type: 'A', name: hostName, value: ip, description: '🌐 Portal — required for HTTPS and points your domain to this server', required: true },
              { type: 'CNAME', name: 'www', value: `${domain || 'yourdomain.com'}.`, description: '🔀 Optional but recommended — redirects www to your portal' },
              { type: 'A', name: 'mail', value: ip, description: '📧 Optional now, but recommended if you want email security features later' },
              { type: 'MX', name: hostName, value: `mail.${baseDomain || 'yourdomain.com'}`, priority: 10, description: '📧 Optional now, but recommended — routes incoming email to your server' },
              { type: 'TXT', name: hostName, value: `v=spf1 mx a ip4:${ip} -all`, description: '🔒 Optional now, but recommended — allows your server to send email correctly' },
            ];
            return (
              <div className={`${cardClass} overflow-hidden`}>
                <div className="border-b border-slate-800 px-4 py-3">
                  <p className="font-semibold text-white">Set all DNS records now</p>
                  <p className="mt-1 text-sm text-slate-400">Go to your domain provider (GoDaddy, Namecheap, Cloudflare, etc.) → DNS settings and add everything below in one pass so you only wait for DNS propagation once.</p>
                </div>
                <div className="divide-y divide-slate-800">
                  {dnsRecords.map((record, index) => (
                    <div key={`${record.type}-${record.name}-${index}`} className={`grid gap-3 px-4 py-4 md:grid-cols-[100px_1fr_auto] md:items-start ${record.required ? '' : 'opacity-80'}`}>
                      <div>
                        <p className="text-xs uppercase tracking-wide text-emerald-400">{record.type}</p>
                        {record.required && <p className="mt-1 text-xs font-medium text-emerald-300">Required</p>}
                        {'priority' in record && record.priority ? <p className="mt-1 text-xs text-slate-500">Priority {record.priority}</p> : null}
                      </div>
                      <div className="space-y-1 text-sm">
                        <p className="text-slate-300"><span className="text-slate-500">Name:</span> <span className="font-mono">{record.name}</span></p>
                        <p className="break-all text-slate-300"><span className="text-slate-500">Value:</span> <span className="font-mono">{record.value}</span></p>
                        {record.description ? <p className="text-xs text-slate-500">{record.description}</p> : null}
                      </div>
                      <div className="flex gap-2 md:justify-end">
                        <CopyButton value={record.name} label="Copy name" />
                        <CopyButton value={record.value} label="Copy value" />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="border-t border-slate-800 px-4 py-3 text-xs text-slate-400 space-y-1">
                  <p><strong className="text-emerald-300">Do this now:</strong> Add every record in this table before you wait for DNS propagation. That way HTTPS and optional email records start propagating together.</p>
                  <p><strong className="text-slate-300">Portal required:</strong> The first A record is required for HTTPS. The mail-related rows are optional, but if you plan to use email security features, add them now so you do not wait twice.</p>
                  <p className="text-amber-300 font-medium">💡 Later on the email step, you may only need final authentication records like DKIM/DMARC — not a second full DNS round trip.</p>
                  <p><strong className="text-slate-300">Registrar tip:</strong> Most providers (GoDaddy, Namecheap, etc.) auto-append your domain — so enter just <code className="bg-slate-800 px-1 rounded">@</code>, <code className="bg-slate-800 px-1 rounded">mail</code>, or <code className="bg-slate-800 px-1 rounded">www</code>, not the full domain name.</p>
                  <p><strong className="text-slate-300">Propagation:</strong> Usually 1–5 minutes, but can take up to 48 hours. Wait once, then click &ldquo;Check DNS&rdquo; below to verify.</p>
                  {domain && domain.includes('www.') && <p className="text-amber-400">⚠ Tip: remove &ldquo;www.&rdquo; — use the bare domain or a subdomain like &ldquo;portal&rdquo;.</p>}
                </div>
              </div>
            );
          })()}

          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={handleCheckDns} disabled={!domain.trim() || dnsState === 'loading'} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
              {dnsState === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check DNS
            </button>
            <button type="button" onClick={handleConfigureDomain} disabled={!dnsStatus?.pointsToUs || domainConfigState === 'loading'} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
              {domainConfigState === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />} Configure HTTPS
            </button>
          </div>

          {dnsStatus && (
            <div className={`${cardClass} p-4`}>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Resolves</p>
                  <p className={`mt-1 text-sm font-semibold ${dnsStatus.resolves ? 'text-emerald-400' : 'text-amber-400'}`}>{dnsStatus.resolves ? '✓ Yes' : '✗ No'}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Points to this server</p>
                  <p className={`mt-1 text-sm font-semibold ${dnsStatus.pointsToUs ? 'text-emerald-400' : 'text-amber-400'}`}>{dnsStatus.pointsToUs ? '✓ Yes' : '✗ Not yet'}</p>
                </div>
              </div>
              {dnsStatus.resolvedIps.length > 0 && <p className="mt-3 text-sm text-slate-400">Current DNS answer: {dnsStatus.resolvedIps.join(', ')}</p>}
            </div>
          )}

          {domainMessage && (
            <div className={`rounded-2xl border p-4 text-sm ${domainConfigState === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-slate-800 bg-slate-900/70 text-slate-300'}`}>
              {domainMessage}
            </div>
          )}

          {configuredDomainUrl && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3">
              <p className="font-semibold text-emerald-300">✓ HTTPS is ready</p>
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
                <span>{configuredDomainUrl}</span>
                <CopyButton value={configuredDomainUrl} />
              </div>
              <p className="text-sm text-slate-200/90">
                Click <strong>Next</strong> to continue setup on the secure portal. We no longer force an automatic redirect during the DNS/TLS handoff.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 text-slate-300">
          You can add a domain anytime in Settings → Domain. For now the portal will stay on HTTP.
        </div>
      )}
      </>
      )}
    </StepShell>
    );
  };

  const renderEmail = () => (
    <StepShell stepKey={step}>
      <div>
        <h2 className="text-2xl font-bold text-white">Secure Your Portal</h2>
        <p className="mt-2 text-slate-400">Email powers these security features. If you already added the optional mail DNS records on the previous step, you only have a small final DNS step left here.</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {SECURITY_FEATURES.map((feature) => (
          <div key={feature.title} className={`${cardClass} p-4`}>
            <p className="text-2xl">{feature.icon}</p>
            <p className="mt-3 font-semibold text-white">{feature.title}</p>
            <p className="mt-1 text-sm text-slate-400">{feature.description}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
        Without email, these features won&apos;t be available.
      </div>

      {!domainConfigured && !mailStatus?.hasDomain ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <p className="font-semibold text-white">Email requires a domain.</p>
          <p className="mt-2 text-sm text-slate-400">Complete the Domain step first to enable email. You can set this up later in Settings.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* SMTP preflight warning */}
          {preflightState === 'loading' && (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 flex items-center gap-3 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" /> Checking if your server can send email...
            </div>
          )}
          {mailPreflight?.smtpBlocked && !mailStatus?.available && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 space-y-3">
              <div className="flex items-start gap-3">
                <span className="text-2xl flex-shrink-0">⚠️</span>
                <div className="space-y-2">
                  <p className="font-semibold text-amber-200">
                    SMTP is blocked{mailPreflight.providerName !== 'Unknown' ? ` by ${mailPreflight.providerName}` : ' on this server'}
                  </p>
                  <p className="text-sm text-amber-100/80">
                    Most hosting providers block outbound email (port 25) on new servers to prevent spam.
                    {mailPreflight.providerInstructions && <> {mailPreflight.providerInstructions}</>}
                  </p>
                  {mailPreflight.providerLink && (
                    <a href={mailPreflight.providerLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-amber-300 underline underline-offset-2 hover:text-amber-200">
                      Open {mailPreflight.providerName} support →
                    </a>
                  )}
                  <div className="pt-2 border-t border-amber-500/20">
                    <p className="text-sm text-amber-100/80"><strong className="text-amber-200">Options:</strong></p>
                    <ul className="mt-1 text-sm text-amber-100/70 list-disc list-inside space-y-1">
                      <li>Request SMTP unblock from your provider (usually approved within 1 business day)</li>
                      <li>Skip email for now — you can set it up later in Settings</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}
          {mailPreflight && !mailPreflight.dockerOk && (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
              <strong>Docker is not running.</strong> Email requires Docker for the mail server. Start Docker and refresh this page.
            </div>
          )}
          {mailPreflight?.canSelfHost && !mailStatus?.available && (
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
              ✓ Your server can send email — SMTP is open and Docker is running.{mailPreflight.providerName !== 'Unknown' && ` Detected: ${mailPreflight.providerName}.`}
            </div>
          )}

          <div className={`${cardClass} p-4`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-white">Email security stack</p>
                <p className="mt-1 text-sm text-slate-400">Domain: {mailStatus?.domain || domain}</p>
              </div>
              <button type="button" onClick={loadMailStatus} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800">
                <RefreshCw className={`h-4 w-4 ${mailStatusState === 'loading' ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {mailStatus && (
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                {[
                  { label: 'Mail server', value: mailStatus.available ? 'Detected' : 'Not installed' },
                  { label: 'Configured', value: mailStatus.configured ? 'Yes' : 'No' },
                  { label: 'Can send', value: mailStatus.canSend ? 'Yes' : 'Not yet' },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">{item.label}</p>
                    <p className="mt-1 text-sm font-medium text-white">{item.value}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={handleInstallMail} disabled={installMailState === 'loading'} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
              {installMailState === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />} Set Up Email
            </button>
            <button type="button" onClick={handleTestEmail} disabled={testEmailState === 'loading' || !(mailStatus?.configured || installMailState === 'success')} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
              {testEmailState === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Send Test Email
            </button>
          </div>

          {installMailMessage && (
            <div className={`rounded-2xl border p-4 text-sm ${installMailState === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : installMailState === 'error' ? 'border-amber-500/20 bg-amber-500/10 text-amber-100' : 'border-slate-800 bg-slate-900/70 text-slate-300'}`}>
              {installMailMessage}
            </div>
          )}

          {testEmailMessage && (
            <div className={`rounded-2xl border p-4 text-sm ${testEmailState === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : testEmailState === 'error' ? 'border-amber-500/20 bg-amber-500/10 text-amber-100' : 'border-slate-800 bg-slate-900/70 text-slate-300'}`}>
              {testEmailMessage}
            </div>
          )}

          {mailDnsRecords.length > 0 && (
            <div className={`${cardClass} overflow-hidden`}>
              <div className="border-b border-slate-800 px-4 py-3">
                <p className="font-semibold text-white">Final DNS records for email</p>
                <p className="mt-1 text-sm text-slate-400">This is the final email-authentication step. If you already added the earlier optional mail records, these TXT records are the only DNS changes left.</p>
              </div>
              <div className="divide-y divide-slate-800">
                {mailDnsRecords.map((record, index) => (
                  <div key={`${record.type}-${record.name}-${index}`} className="grid gap-3 px-4 py-4 md:grid-cols-[100px_1fr_auto] md:items-start">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-emerald-400">{record.type}</p>
                      {record.priority ? <p className="mt-1 text-xs text-slate-500">Priority {record.priority}</p> : null}
                    </div>
                    <div className="space-y-1 text-sm">
                      <p className="text-slate-300"><span className="text-slate-500">Name:</span> <span className="font-mono">{record.name}</span></p>
                      <p className="break-all text-slate-300"><span className="text-slate-500">Value:</span> <span className="font-mono">{record.value}</span></p>
                      {record.description ? <p className="text-xs text-slate-500">{record.description}</p> : null}
                    </div>
                    <div className="flex gap-2 md:justify-end">
                      <CopyButton value={record.name} label="Copy name" />
                      <CopyButton value={record.value} label="Copy value" />
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-800 px-4 py-3 text-xs text-slate-400">
                <p><strong className="text-slate-300">Registrar tip:</strong> Most providers auto-append your domain — enter just <code className="bg-slate-800 px-1 rounded">default._domainkey</code> and <code className="bg-slate-800 px-1 rounded">_dmarc</code>, not the full domain.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </StepShell>
  );

  const renderAi = () => (
    <StepShell stepKey={step}>
      <div>
        <h2 className="text-2xl font-bold text-white">AI setup</h2>
        <p className="mt-2 text-slate-400">Connect cloud AI providers, choose your default model, and manage local AI services already installed on the server.</p>
      </div>

      <div className="space-y-5">
        <div className={`${cardClass} p-5`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-white">AI Coding Tools</h3>
              <p className="mt-1 text-sm text-slate-400">
                Install the CLI tools that connect to cloud AI providers. These must be installed before you can sign in to a provider below.
              </p>
            </div>
            <button type="button" onClick={loadAiStatus} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800">
              <RefreshCw className={`h-4 w-4 ${!codingToolsStatus ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {!codingToolsStatus ? (
            <div className="mt-6 flex items-center justify-center py-6 text-slate-400">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Checking coding tools...
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              {codingToolsStatus.tools.map((tool) => (
                <div key={tool.id} className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex-1">
                    <p className="font-medium text-white">{tool.name}</p>
                    <p className="text-sm text-slate-400">{tool.description}</p>
                    {tool.installed && tool.version && (
                      <p className="mt-1 text-xs text-emerald-400">v{tool.version}</p>
                    )}
                  </div>
                  {tool.installed ? (
                    <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-300">
                      <CheckCircle2 className="h-4 w-4" /> Installed
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={async () => {
                        setInstallingTool(tool.id);
                        try {
                          await api.post('/setup/install-coding-tool', { toolId: tool.id });
                          await loadAiStatus();
                        } catch (err: any) {
                          setError(friendlyError(err, `Failed to install ${tool.name}`));
                        } finally {
                          setInstallingTool('');
                        }
                      }}
                      disabled={installingTool.length > 0}
                      className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {installingTool === tool.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      Install
                    </button>
                  )}
                </div>
              ))}
              <p className="text-xs text-slate-500">
                These are optional. You can install them later from Settings → System.
              </p>
            </div>
          )}
        </div>

        <AiProviderSetup mode="wizard" apiBase="/setup/ai" onComplete={() => goNext()} />

        <div className={`${cardClass} p-5`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-white">Ollama (Local AI)</h3>
              <p className="mt-1 text-sm text-slate-400">Ollama runs AI models directly on your server. No data leaves your machine.</p>
            </div>
            <button type="button" onClick={loadAiStatus} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800">
              <RefreshCw className={`h-4 w-4 ${ollamaState === 'loading' ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {ollamaState === 'loading' && !ollamaStatus ? (
            <div className="mt-6 flex items-center justify-center py-8 text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Checking Ollama...</div>
          ) : ollamaStatus?.running ? (
            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                <p className="font-semibold text-emerald-300">Ollama is running</p>
                <p className="mt-1 text-sm text-slate-300">Endpoint: {ollamaStatus.endpoint}</p>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Installed models</p>
                  <p className="mt-1 text-sm font-medium text-white">{ollamaStatus.models.length}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">RAM tier</p>
                  <p className="mt-1 text-sm font-medium text-white">{ollamaStatus.ramTier}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Server RAM</p>
                  <p className="mt-1 text-sm font-medium text-white">{ollamaStatus.ramGb} GB</p>
                </div>
              </div>

              {ollamaStatus.models.length > 0 && (
                <div>
                  <p className="mb-2 text-sm font-medium text-white">Installed models</p>
                  <div className="flex flex-wrap gap-2">
                    {ollamaStatus.models.map((model) => (
                      <span key={model} className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-sm text-slate-300">{model}</span>
                    ))}
                  </div>
                </div>
              )}

              {ollamaStatus.warning && <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">{ollamaStatus.warning}</div>}

              <div>
                <p className="mb-3 text-sm font-medium text-white">Recommended models</p>
                <div className="space-y-3">
                  {ollamaStatus.recommendedModels.map((model) => {
                    const installed = ollamaStatus.models.includes(model.name);
                    return (
                      <div key={model.name} className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 md:flex-row md:items-center md:justify-between">
                        <div className="flex items-start gap-3">
                          <div className="mt-1 h-4 w-4 rounded border border-emerald-500/50 bg-emerald-500/10">
                            <Check className="h-4 w-4 text-emerald-400" />
                          </div>
                          <div>
                            <p className="font-medium text-white">{model.name}</p>
                            <p className="text-sm text-slate-400">{model.description}</p>
                            <p className="mt-1 text-xs text-slate-500">Size: {model.size}</p>
                          </div>
                        </div>
                        {installed ? (
                          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-300">
                            <CheckCircle2 className="h-4 w-4" /> Installed
                          </span>
                        ) : (
                          <button type="button" onClick={() => handlePullModel(model.name)} disabled={pullingModel.length > 0} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
                            {pullingModel === model.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Pull
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {pullingModel && <p className="mt-3 text-sm text-slate-400">Pulling <span className="text-emerald-300">{pullingModel}</span>...</p>}
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">Ollama is not responding right now. You can install or troubleshoot it later in Settings.</div>
          )}
        </div>

        <div className={`${cardClass} p-5`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-white">OpenClaw (AI Agent)</h3>
              <p className="mt-1 text-sm text-slate-400">{openClawStatus?.description || 'OpenClaw powers advanced AI agent workflows and automation.'}</p>
            </div>
            <Server className="h-5 w-5 text-emerald-400" />
          </div>

          {openClawState === 'loading' && !openClawStatus ? (
            <div className="mt-6 flex items-center justify-center py-8 text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Checking OpenClaw...</div>
          ) : openClawStatus ? (
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Installed</p>
                <p className={`mt-1 text-sm font-medium ${openClawStatus.installed ? 'text-emerald-300' : 'text-amber-300'}`}>{openClawStatus.installed ? '✓ Yes' : '✗ No'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Gateway running</p>
                <p className={`mt-1 text-sm font-medium ${openClawStatus.gatewayRunning ? 'text-emerald-300' : 'text-amber-300'}`}>{openClawStatus.gatewayRunning ? '✓ Yes' : '✗ No'}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Version</p>
                <p className="mt-1 text-sm font-medium text-white">{openClawStatus.version || 'Unknown'}</p>
              </div>
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">OpenClaw status is unavailable right now. If it is not installed yet, you can add it later.</div>
          )}
        </div>

      </div>
    </StepShell>
  );

  const renderRemoteDesktop = () => {
    const handleRdSetup = async () => {
      setRdSetupState('loading');
      setRdSetupMessage('');
      setRdSetupSteps([]);
      try {
        const res = await api.post('/setup/install-rd');
        setRdSetupState(res.data.ok ? 'success' : 'error');
        setRdSetupMessage(res.data.message || '');
        setRdSetupSteps(res.data.steps || []);
      } catch (err: any) {
        setRdSetupState('error');
        setRdSetupMessage(err?.response?.data?.message || err?.message || 'Setup failed');
        setRdSetupSteps([]);
      }
    };

    return (
      <StepShell stepKey={step}>
        <div>
          <h2 className="text-2xl font-bold text-white">Remote Desktop</h2>
          <p className="mt-2 text-slate-400">
            Optional — set up a browser-accessible desktop (noVNC + Xfce4). Skip this if you don't need a GUI environment on this server.
          </p>
        </div>

        <div className={`${cardClass} p-5`}>
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-blue-500/10 border border-blue-500/20">
              <Monitor className="h-6 w-6 text-blue-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-white">Browser-based desktop access</h3>
              <p className="mt-1 text-sm text-slate-400">
                Installs Xtigervnc, noVNC, and Xfce4 — creates systemd services so the desktop auto-starts on reboot. Access via the portal's Desktop page.
              </p>
              <ul className="mt-3 space-y-1 text-xs text-slate-500">
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" /> Xtigervnc + Xfce4 desktop</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" /> noVNC web client (port 6080)</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" /> systemd services (auto-restart)</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" /> Portal authentication gates access</li>
              </ul>
            </div>
          </div>

          <div className="mt-5">
            {rdSetupState === 'idle' && (
              <button
                type="button"
                onClick={handleRdSetup}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/30 px-4 py-3 text-sm font-medium text-blue-300 transition hover:bg-blue-500/30"
              >
                <Monitor className="h-4 w-4" /> Set Up Remote Desktop
              </button>
            )}
            {rdSetupState === 'loading' && (
              <div className="flex items-center gap-3 rounded-xl bg-blue-500/10 border border-blue-500/20 px-4 py-3">
                <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
                <span className="text-sm text-blue-300">Installing packages and configuring services… this can take 1–2 minutes</span>
              </div>
            )}
            {(rdSetupState === 'success' || rdSetupState === 'error') && (
              <div className={`rounded-xl border p-4 ${rdSetupState === 'success' ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'}`}>
                <div className={`text-sm font-semibold mb-2 ${rdSetupState === 'success' ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {rdSetupState === 'success' ? '✓ Remote Desktop Ready' : '⚠ Setup Finished with Issues'}
                </div>
                <div className="text-xs text-slate-400 mb-3">{rdSetupMessage}</div>
                {rdSetupSteps.length > 0 && (
                  <div className="space-y-1">
                    {rdSetupSteps.map((s, i) => (
                      <div key={i} className="flex items-center gap-2 text-[11px]">
                        {s.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />}
                        <span className="text-slate-300">{s.step}:</span>
                        <span className="text-slate-500 truncate">{s.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {rdSetupState === 'error' && (
                  <button type="button" onClick={handleRdSetup} className="mt-3 text-xs text-blue-400 hover:text-blue-300 underline">
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="text-sm text-slate-500 text-center">
          You can also set up Remote Desktop later from Settings → System → Feature Readiness.
        </div>
      </StepShell>
    );
  };

  const renderReview = () => (
    <StepShell stepKey={step}>
      <div>
        <h2 className="text-2xl font-bold text-white">Review &amp; launch</h2>
        <p className="mt-2 text-slate-400">One last look before the portal goes live.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {[
          { title: 'Admin', content: `${name || 'Not set'}\n${email || 'No email provided yet'}` },
          { title: 'Portal', content: `${portalName || 'My AI Portal'}\n${theme} theme · ${accentColor}` },
          { title: 'Security', content: `${registrationMode} registration
Search indexing: ${searchEngineVisibility === 'visible' ? 'Enabled' : 'Hidden'}` },
          { title: 'Telemetry', content: allowTelemetry ? 'Enabled' : 'Disabled' },
          { title: 'Domain', content: configuredDomainUrl ? configuredDomainUrl : 'Not configured (HTTP)' },
          { title: 'Email', content: mailStatus?.configured || installMailState === 'success' ? 'Configured' : 'Not configured' },
          { title: 'AI', content: `Ollama: ${ollamaStatus?.running ? `${ollamaStatus.models.length} model(s)` : 'Not ready'}\nOpenClaw: ${openClawStatus?.installed ? (openClawStatus.gatewayRunning ? 'Installed + running' : 'Installed') : 'Not detected'}` },
        ].map((section) => (
          <div key={section.title} className={`${cardClass} p-4`}>
            <p className="text-sm font-semibold text-slate-300">{section.title}</p>
            {section.content.split('\n').map((line) => (
              <p key={line} className="mt-2 text-sm text-white">{line}</p>
            ))}
          </div>
        ))}
      </div>


      <div className={`${cardClass} p-5`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-white">Help improve BridgesLLM</h3>
            <p className="mt-1 text-sm text-slate-400">
              Sends anonymous usage stats (install ID, version, user count) once daily. No personal data, messages, or files are ever collected. Keeping this on helps us track active installs and notifies you when updates are available.
            </p>
            {!allowTelemetry && <p className="mt-2 text-xs text-amber-300/90">Update notifications will be disabled.</p>}
          </div>
          <button
            type="button"
            onClick={() => setAllowTelemetry((current) => !current)}
            className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full border transition-colors duration-200 ${allowTelemetry ? 'border-emerald-400/40 bg-emerald-500' : 'border-slate-700 bg-slate-800'}`}
            aria-pressed={allowTelemetry}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 translate-y-0.5 rounded-full shadow-sm transition-transform duration-200 ${allowTelemetry ? 'translate-x-[22px] bg-white' : 'translate-x-0.5 bg-slate-400'}`}
            />
          </button>
        </div>
      </div>

      {error && <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">{error}</div>}
    </StepShell>
  );

  if (setupComplete) {
    return (
      <div className="min-h-dvh bg-slate-950 px-4 py-10 text-slate-100">
        <div className="mx-auto flex min-h-[80vh] max-w-2xl items-center justify-center">
          <div className="w-full rounded-3xl border border-slate-800 bg-slate-900/80 p-8 text-center shadow-2xl shadow-black/30 backdrop-blur">
            <motion.div initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 16 }} className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/15 ring-8 ring-emerald-500/10">
              <CheckCircle2 className="h-12 w-12 text-emerald-400" />
            </motion.div>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}>
              <h2 className="mt-6 text-3xl font-bold text-white">Portal ready</h2>
              <p className="mt-2 text-slate-400">Applying your settings and restarting the server...</p>
              <div className="mt-4 flex justify-center">
                <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full animate-pulse rounded-full bg-emerald-500/60" style={{ animation: 'pulse 1.5s ease-in-out infinite, grow 8s ease-out forwards' }} />
                </div>
              </div>
              <style>{`@keyframes grow { from { width: 20%; } to { width: 100%; } }`}</style>
            </motion.div>
          </div>
        </div>
      </div>
    );
  }

  if (tokenInvalid) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 px-4 text-slate-100">
        <div className="max-w-md rounded-2xl border border-red-500/30 bg-slate-900/80 p-8 text-center shadow-2xl">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
            <Lock className="h-8 w-8 text-red-400" />
          </div>
          <h1 className="mb-2 text-xl font-semibold text-white">Setup Token Required</h1>
          <p className="mb-4 text-sm text-slate-400">
            This setup page requires the security token from your terminal.
            Copy the full URL printed after installation — it includes a one-time token.
          </p>
          <div className="rounded-lg bg-slate-800/60 p-3 text-left">
            <p className="text-xs text-slate-500 mb-1">Your URL should look like:</p>
            <code className="text-xs text-emerald-400 break-all">http://your-ip/setup?token=abc123...</code>
          </div>
        </div>
      </div>
    );
  }

  // Reinstall: password reset UI
  if (isReinstall) {
    return (
      <div className="min-h-dvh bg-slate-950 px-4 py-8 text-slate-100">
        <div className="mx-auto max-w-md">
          <div className="rounded-[28px] border border-slate-800 bg-slate-900/80 p-8 shadow-2xl shadow-black/30 backdrop-blur">
            <div className="mb-6 flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-500/20 bg-amber-500/10">
                <Shield className="h-6 w-6 text-amber-300" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold text-white">Welcome Back</h1>
                <p className="text-sm text-slate-400">Reinstall detected — reset your password</p>
              </div>
            </div>
            <p className="mb-4 text-sm text-slate-400">
              Your previous data (projects, settings, email) has been preserved.
              Set a new password to regain access to your account.
            </p>
            {ownerHint && (
              <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-3">
                <p className="text-xs text-slate-500">Owner account on file</p>
                <p className="text-sm font-medium text-white">{ownerHint}</p>
              </div>
            )}
            <form onSubmit={handleReinstallReset}>
              <div className="mb-4">
                <label className="mb-1 block text-sm font-medium text-slate-300">New Password</label>
                <PasswordInput value={reinstallPassword} onChange={setReinstallPassword} placeholder="Min 8 chars, upper/lower/number" />
                <p className={`mt-2 text-xs ${reinstallPassword.length > 0 && !reinstallPasswordPolicy.valid ? 'text-amber-400' : 'text-slate-500'}`}>{PASSWORD_POLICY_HINT}</p>
                {reinstallPassword.length > 0 && !reinstallPasswordPolicy.valid && (
                  <ul className="mt-2 space-y-1 text-xs text-amber-300">
                    {reinstallPasswordPolicy.errors.map((message) => <li key={message}>• {message}</li>)}
                  </ul>
                )}
              </div>
              <div className="mb-6">
                <label className="mb-1 block text-sm font-medium text-slate-300">Confirm Password</label>
                <PasswordInput value={reinstallConfirmPassword} onChange={setReinstallConfirmPassword} placeholder="Repeat your password" />
                {reinstallConfirmPassword.length > 0 && reinstallPassword !== reinstallConfirmPassword && <p className="mt-2 text-xs text-amber-400">Passwords must match.</p>}
              </div>
              {reinstallError && <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{reinstallError}</div>}
              <button type="submit" disabled={reinstallSubmitting || !reinstallFormValid}
                className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60">
                {reinstallSubmitting ? 'Resetting…' : 'Reset Password & Continue'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto max-w-5xl rounded-[28px] border border-slate-800 bg-slate-900/80 p-6 shadow-2xl shadow-black/30 backdrop-blur md:p-8">
          <div className="mb-6 flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10">
              <Shield className="h-6 w-6 text-emerald-300" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-white">Setup Wizard</h1>
              <p className="text-sm text-slate-400">Step {step + 1} of {STEPS.length}</p>
            </div>
          </div>

          <div className="mb-6 h-2 overflow-hidden rounded-full bg-slate-800">
            <motion.div className="h-full bg-emerald-500" animate={{ width: `${progress}%` }} transition={{ duration: 0.25 }} />
          </div>

          <div className="mb-8">
            <StepIndicator currentStep={step} />
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <div key={STEPS[step].id}>
              {step === 0 && renderWelcome()}
              {step === 1 && renderDomain()}
              {step === 2 && renderAdmin()}
              {step === 3 && renderIdentity()}
              {step === 4 && renderSecurity()}
              {step === 5 && renderEmail()}
              {step === 6 && renderAi()}
              {step === 7 && renderRemoteDesktop()}
              {step === 8 && renderReview()}
            </div>
          </AnimatePresence>

          {step !== 0 && (
            <div className="mt-8 border-t border-slate-800 pt-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={goBack} disabled={step === 0 || submitting} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>

                <div className="flex flex-col-reverse gap-3 sm:flex-row">
                  {/* Skip button: hide on domain (step 1 — has its own skip option) and admin (step 2 — required) */}
                  {step < STEPS.length - 1 && step !== 1 && step !== 2 && (
                    <button type="button" onClick={goNext} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-600 hover:bg-slate-800">
                      Skip for now <ChevronRight className="h-4 w-4" />
                    </button>
                  )}

                  {step < STEPS.length - 1 ? (
                    <button type="button" onClick={goNext} disabled={step === 2 && !adminStepValid} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
                      {step === 1 && configuredDomainUrl && window.location.protocol === 'http:' ? 'Continue on secure portal' : 'Next'} <ChevronRight className="h-4 w-4" />
                    </button>
                  ) : (
                    <button type="button" onClick={handleComplete} disabled={submitting || !adminStepValid} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Complete Setup
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
