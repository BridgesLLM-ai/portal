import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { copyTextToClipboard } from '../utils/clipboardCopy';
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
  ExternalLink,
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
import {
  refreshPublicSettings,
  type PortalFeatureAvailability,
  type PortalOriginMode,
} from '../hooks/usePublicSettings';
import {
  buildSetupHttpsHandoffUrl,
  getPostSetupDestination,
  getPreviousSetupStep,
  getSetupBrowserTransport,
  getSetupLogoValidationError,
  getSetupNavigationState,
  isSetupAiRuntimeReady,
  readSetupFragmentCredential,
  scrubSetupSecretsFromUrl,
  SETUP_LOGO_MIME_TYPES,
  SETUP_SESSION_STORAGE_KEY,
} from './setupWizardFlow';

type ThemeMode = 'dark' | 'light' | 'system';
type RegistrationMode = 'open' | 'approval' | 'closed';
type AsyncState = 'idle' | 'loading' | 'success' | 'error';
type DomainPath = 'domain' | 'skip';
type BootstrapState = 'loading' | 'ready' | 'required' | 'error' | 'blocked';
type WizardActionKind =
  | 'check-dns'
  | 'configure-domain'
  | 'install-mail'
  | 'test-email'
  | 'install-coding-tool'
  | 'pull-model'
  | 'tailnet-onboarding'
  | 'install-rd'
  | 'complete'
  | 'reinstall-reset';

interface WizardActionOwner {
  kind: WizardActionKind;
  step: number;
  label: string;
  subject?: string;
}

interface SetupNavigationGuard {
  token: string;
  url: string;
  baseState: unknown;
  owner: WizardActionOwner | null;
}

const SETUP_NAVIGATION_GUARD_STATE_KEY = '__bridgesSetupActionGuard';
const SETUP_STATUS_TIMEOUT_MS = 8_000;
const SETUP_COMPLETION_TIMEOUT_MS = 30_000;

function withSetupDeadline<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function setupNavigationGuardState(baseState: unknown, token: string) {
  const nextState = baseState && typeof baseState === 'object'
    ? { ...(baseState as Record<string, unknown>) }
    : {};
  nextState[SETUP_NAVIGATION_GUARD_STATE_KEY] = token;
  return nextState;
}

function setupNavigationBaseState(state: unknown) {
  if (!state || typeof state !== 'object') return state;
  const nextState = { ...(state as Record<string, unknown>) };
  delete nextState[SETUP_NAVIGATION_GUARD_STATE_KEY];
  return nextState;
}

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
  installProfile?: 'local' | 'server';
  originMode?: PortalOriginMode;
  featureCapabilities?: {
    originMode: PortalOriginMode;
    experimental: boolean;
    privateNetworkOnly: boolean;
    mail: PortalFeatureAvailability;
    appHosting: PortalFeatureAvailability;
  };
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
  dkimConfigured?: boolean;
  dnsRecords: DnsRecord[];
  domain?: string;
  hasDomain: boolean;
  supported?: boolean;
  reason?: string;
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
  minAvailableRamGb: number;
  contextWindow: string;
  useCase: 'general' | 'coding' | 'reasoning';
  sourceUrl: string;
}

interface OllamaStatusResponse {
  running: boolean;
  endpoint: string;
  models: string[];
  ramGb: number;
  availableRamGb: number;
  reservedHeadroomGb: number;
  ramTier: string;
  warning: string | null;
  recommendedModels: OllamaModelRecommendation[];
}

interface OpenClawStatusResponse {
  installed: boolean;
  version: string | null;
  corePackageVersion: string | null;
  runningVersion: string | null;
  gatewayRunning: boolean;
  authenticatedRpc: boolean;
  gatewayUrl: string;
  hasToken: boolean;
  tokenParity: boolean;
  codexPluginVersion: string | null;
  codexPluginInstallSpec: string | null;
  credentialStoreReady: boolean;
  credentialStoreWritable: boolean;
  testedCorePackageVersion: string;
  testedRuntimeVersion: string;
  testedCodexPluginVersion: string;
  testedPairReady: boolean;
  ready: boolean;
  blockers: Array<{ code: string; message: string }>;
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

const inputClass = 'w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white placeholder-slate-500 outline-none transition accent-focus';
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
  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopy = async () => {
    setCopyFailed(false);
    const copiedOk = await copyTextToClipboard(value);

    if (copiedOk) {
      setCopied(true);
      sounds.success();
      setTimeout(() => setCopied(false), 1500);
      return;
    }
    // Never play a failure sound without saying what failed.
    setCopyFailed(true);
    sounds.error();
    setTimeout(() => setCopyFailed(false), 4000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-slate-600 hover:bg-slate-800"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      <span className={copied ? 'text-emerald-400' : copyFailed ? 'text-amber-400' : ''}>
        {copied ? 'Copied' : copyFailed ? 'Select and copy manually' : label}
      </span>
    </button>
  );
}

function PasswordInput({ id, value, onChange, ariaLabel, placeholder, disabled = false }: { id: string; value: string; onChange: (value: string) => void; ariaLabel: string; placeholder?: string; disabled?: boolean }) {
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={`${inputClass} pr-11`}
      />
      <button
        type="button"
        onClick={() => setShow((current) => !current)}
        disabled={disabled}
        aria-label={`${show ? 'Hide' : 'Show'} ${ariaLabel.toLowerCase()}`}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-200"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 xl:grid-cols-9">
      {STEPS.map((step, index) => {
        const Icon = step.icon;
        const active = index === currentStep;
        const complete = index < currentStep;

        return (
          <div key={step.id} className="flex flex-col items-center gap-2 text-center">
            <div
              className={[
                'flex h-10 w-10 items-center justify-center rounded-full border transition-all',
                active ? 'accent-active scale-105' : '',
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
  const bootstrapExchangeStartedRef = useRef(false);

  const browserTransport = useMemo(
    () => getSetupBrowserTransport(window.location.protocol, window.location.hostname),
    [],
  );
  const [initialFragmentCredential, setInitialFragmentCredential] = useState(
    () => readSetupFragmentCredential(window.location.hash),
  );
  const [setupSessionToken, setSetupSessionToken] = useState(() => {
    try { return window.sessionStorage.getItem(SETUP_SESSION_STORAGE_KEY) || ''; } catch { return ''; }
  });
  const setupSessionTokenRef = useRef(setupSessionToken);
  setupSessionTokenRef.current = setupSessionToken;
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>(() => {
    if (browserTransport === 'blocked') return 'blocked';
    return 'loading';
  });
  const [bootstrapError, setBootstrapError] = useState('');

  // Keep the non-secret navigation state resumable across HTTPS handoff,
  // service restart, and an accidental refresh. Password fields are never
  // persisted in browser storage or the URL.
  const initialNavigation = useMemo(
    () => getSetupNavigationState(window.location.search, STEPS.length - 1),
    [],
  );

  const api = client;

  useEffect(() => {
    // Fragments are not sent to the server, and this removes them before any
    // user navigation, copy, screenshot, or external provider flow.
    const scrubbed = scrubSetupSecretsFromUrl(window.location.href);
    if (scrubbed !== window.location.href) {
      window.history.replaceState(window.history.state, '', scrubbed);
    }
  }, []);

  useEffect(() => {
    const interceptorId = api.interceptors.request.use((cfg) => {
      if (
        setupSessionTokenRef.current
        && cfg.url?.startsWith('/setup/')
        && cfg.url !== '/setup/status'
        && !cfg.url.startsWith('/setup/bootstrap')
      ) {
        cfg.headers = cfg.headers || {};
        cfg.headers.Authorization = `Bearer ${setupSessionTokenRef.current}`;
      }
      return cfg;
    });
    return () => api.interceptors.request.eject(interceptorId);
  }, [api]);

  useEffect(() => {
    if (browserTransport === 'blocked') {
      setBootstrapState('blocked');
      return;
    }
    if (bootstrapExchangeStartedRef.current) return;
    bootstrapExchangeStartedRef.current = true;
    setBootstrapState('loading');

    // Ask the server to classify the real socket/proxy path before sending any
    // bootstrap or resumed bearer. Browser hostname checks alone cannot prove
    // that "localhost" was not forwarded through an exposed reverse proxy.
    withSetupDeadline(
      api.get('/setup/status', { params: { _transport: Date.now() }, timeout: SETUP_STATUS_TIMEOUT_MS }),
      SETUP_STATUS_TIMEOUT_MS,
      'The setup transport check timed out.',
    )
      .then(async ({ data: status }) => {
        if (!status?.setupTransport || status.setupTransport.allowed !== true) {
          const reason = String(status?.setupTransport?.reason || 'The server could not verify HTTPS or a true loopback connection.');
          setBootstrapError(reason);
          setBootstrapState(status?.setupTransport?.allowed === false ? 'blocked' : 'error');
          return null;
        }
        if (setupSessionToken && !initialFragmentCredential) {
          setBootstrapState('ready');
          return null;
        }
        if (!initialFragmentCredential) {
          setBootstrapState('required');
          return null;
        }

        const isHandoff = initialFragmentCredential.kind === 'handoff';
        const endpoint = isHandoff ? '/setup/bootstrap/handoff' : '/setup/bootstrap';
        const header = isHandoff ? 'x-setup-handoff' : 'x-setup-bootstrap';
        const oneTimeCredential = initialFragmentCredential.value;
        setInitialFragmentCredential(null);
        return api.post(endpoint, {}, { headers: { [header]: oneTimeCredential } });
      })
      .then((response) => {
        if (!response) return;
        const { data } = response;
        const nextToken = String(data?.setupToken || '');
        if (!/^[A-Za-z0-9_-]{32,512}$/.test(nextToken)) {
          throw new Error('Portal returned an invalid setup session.');
        }
        try { window.sessionStorage.setItem(SETUP_SESSION_STORAGE_KEY, nextToken); } catch {}
        setupSessionTokenRef.current = nextToken;
        setSetupSessionToken(nextToken);
        setBootstrapError('');
        setBootstrapState('ready');
      })
      .catch((err: any) => {
        try { window.sessionStorage.removeItem(SETUP_SESSION_STORAGE_KEY); } catch {}
        setupSessionTokenRef.current = '';
        setSetupSessionToken('');
        setBootstrapError(friendlyError(err, 'The protected setup link could not be exchanged. Re-run the installer with --reinstall for a new link.'));
        setBootstrapState('error');
      });
  }, [api, browserTransport, initialFragmentCredential, setupSessionToken]);

  const [step, setStep] = useState(initialNavigation.step);
  const [quickSetup, setQuickSetup] = useState(initialNavigation.quickSetup);
  const [error, setError] = useState('');
  const [setupComplete, setSetupComplete] = useState(false);
  const [setupRecoveryError, setSetupRecoveryError] = useState('');
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
  const [domainConfigState, setDomainConfigState] = useState<AsyncState>('idle');
  const [configuredDomainUrl, setConfiguredDomainUrl] = useState('');
  const [domainHandoffToken, setDomainHandoffToken] = useState('');
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
  const [tailnetRequested, setTailnetRequested] = useState(false);
  const [openClawStatus, setOpenClawStatus] = useState<OpenClawStatusResponse | null>(null);
  const [openClawState, setOpenClawState] = useState<AsyncState>('idle');
  const [codingToolsStatus, setCodingToolsStatus] = useState<CodingToolStatusResponse | null>(null);

  const [rdSetupState, setRdSetupState] = useState<AsyncState>('idle');
  const [rdSetupMessage, setRdSetupMessage] = useState('');
  const [rdSetupSteps, setRdSetupSteps] = useState<Array<{ step: string; ok: boolean; message: string }>>([]);
  const wizardActionRef = useRef<WizardActionOwner | null>(null);
  const setupNavigationGuardRef = useRef<SetupNavigationGuard | null>(null);
  const setupLifecycleGenerationRef = useRef(0);
  const [activeWizardAction, setActiveWizardAction] = useState<WizardActionOwner | null>(null);
  const aiRuntimeReady = useMemo(() => isSetupAiRuntimeReady(openClawStatus), [openClawStatus]);

  const finishWizardAction = useCallback((owner: WizardActionOwner) => {
    if (wizardActionRef.current !== owner) return;
    wizardActionRef.current = null;
    setActiveWizardAction((current) => current === owner ? null : current);
  }, []);

  const claimWizardAction = useCallback((owner: WizardActionOwner) => {
    if (wizardActionRef.current) return null;

    const existingGuard = setupNavigationGuardRef.current;
    const currentState = window.history.state as Record<string, unknown> | null;
    if (
      existingGuard
      && existingGuard.owner === null
      && currentState?.[SETUP_NAVIGATION_GUARD_STATE_KEY] === existingGuard.token
    ) {
      existingGuard.url = window.location.href;
      existingGuard.baseState = setupNavigationBaseState(currentState);
      existingGuard.owner = owner;
      setupLifecycleGenerationRef.current += 1;
      wizardActionRef.current = owner;
      setActiveWizardAction(owner);
      return owner;
    }

    const baseState = setupNavigationBaseState(window.history.state);
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = window.location.href;
    try {
      window.history.replaceState(baseState, '', url);
      window.history.pushState(setupNavigationGuardState(baseState, token), '', url);
    } catch {
      setError('This setup step could not lock browser navigation. Reload the protected setup link and retry.');
      return null;
    }

    setupNavigationGuardRef.current = { token, url, baseState, owner };
    setupLifecycleGenerationRef.current += 1;
    wizardActionRef.current = owner;
    setActiveWizardAction(owner);
    return owner;
  }, []);

  const releaseWizardAction = useCallback((owner: WizardActionOwner) => {
    if (wizardActionRef.current !== owner) return;
    const guard = setupNavigationGuardRef.current;
    if (guard?.owner === owner) {
      guard.owner = null;
    }
    finishWizardAction(owner);
  }, [finishWizardAction]);

  const navigateAfterWizardAction = useCallback((owner: WizardActionOwner, target: string) => {
    if (wizardActionRef.current !== owner) return;
    const guard = setupNavigationGuardRef.current;
    const state = window.history.state as Record<string, unknown> | null;
    if (guard?.owner === owner && state?.[SETUP_NAVIGATION_GUARD_STATE_KEY] === guard.token) {
      // Collapse the same-URL sentinel first, then replace the underlying Setup
      // entry. Browser Back from the destination must not reopen an invalid,
      // already-consumed setup session.
      setupNavigationGuardRef.current = null;
      const completeNavigation = (event: PopStateEvent) => {
        event.stopImmediatePropagation();
        finishWizardAction(owner);
        navigate(target, { replace: true });
      };
      window.addEventListener('popstate', completeNavigation, { capture: true, once: true });
      window.history.back();
      return;
    }
    setupNavigationGuardRef.current = null;
    finishWizardAction(owner);
    navigate(target, { replace: true });
  }, [finishWizardAction, navigate]);

  const navigateAfterSetupRecovery = useCallback((target: string) => {
    const guard = setupNavigationGuardRef.current;
    const state = window.history.state as Record<string, unknown> | null;
    if (guard && state?.[SETUP_NAVIGATION_GUARD_STATE_KEY] === guard.token) {
      setupNavigationGuardRef.current = null;
      const completeNavigation = (event: PopStateEvent) => {
        event.stopImmediatePropagation();
        navigate(target, { replace: true });
      };
      window.addEventListener('popstate', completeNavigation, { capture: true, once: true });
      window.history.back();
      return;
    }
    navigate(target, { replace: true });
  }, [navigate]);

  const wizardActionActive = activeWizardAction !== null;
  const ownsWizardAction = (kind: WizardActionKind, subject?: string) => (
    activeWizardAction?.kind === kind
    && (subject === undefined || activeWizardAction.subject === subject)
  );

  const progress = useMemo(
    () => quickSetup ? (step === 0 ? 50 : 100) : ((step + 1) / STEPS.length) * 100,
    [quickSetup, step],
  );
  const emailLooksValid = useMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), [email]);
  const passwordPolicy = useMemo(() => validatePasswordPolicy(password), [password]);
  const adminStepValid = useMemo(
    () => name.trim().length >= 2 && emailLooksValid && passwordPolicy.valid && password === confirmPassword,
    [confirmPassword, emailLooksValid, name, password, passwordPolicy.valid],
  );
  const domainConfigured = useMemo(() => Boolean(configuredDomainUrl || mailStatus?.domain || dnsStatus?.pointsToUs), [configuredDomainUrl, mailStatus?.domain, dnsStatus?.pointsToUs]);
  const setupMailCapability = systemInfo?.featureCapabilities?.mail;
  const setupMailAvailable = setupMailCapability?.available !== false;
  const isTailnetOrigin = systemInfo?.originMode === 'tailnet';

  const goNext = () => {
    if (wizardActionRef.current) return;
    sounds.click();
    setError('');

    // If domain/HTTPS was configured while we're still on HTTP, use Next as the
    // explicit handoff into the secure portal instead of auto-redirecting.
    if (step === 1 && configuredDomainUrl && window.location.protocol === 'http:') {
      if (!domainHandoffToken) {
        setError('HTTPS has not been proven yet. Retry Configure HTTPS while keeping the SSH tunnel open.');
        return;
      }
      window.location.href = buildSetupHttpsHandoffUrl({
        targetUrl: configuredDomainUrl,
        handoffToken: domainHandoffToken,
        navigation: { step: step + 1, quickSetup },
      });
      return;
    }

    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const goBack = () => {
    if (wizardActionRef.current) return;
    sounds.click();
    setError('');
    const previous = getPreviousSetupStep({ step, quickSetup });
    setQuickSetup(previous.quickSetup);
    setStep(previous.step);
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('step', String(step));
    if (quickSetup) url.searchParams.set('mode', 'quick');
    else url.searchParams.delete('mode');
    window.history.replaceState(window.history.state, '', url.toString());
  }, [quickSetup, step]);

  useEffect(() => {
    const blockUnload = (event: BeforeUnloadEvent) => {
      if (!wizardActionRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    const blockHistoryBack = (event: PopStateEvent) => {
      const guard = setupNavigationGuardRef.current;
      if (!guard) return;
      const state = event.state as Record<string, unknown> | null;

      if (!guard.owner) {
        if (state?.[SETUP_NAVIGATION_GUARD_STATE_KEY] === guard.token) return;
        // The current page owns one same-URL sentinel entry. When no mutation
        // is running, transparently skip that entry so a normal Back still
        // leaves Setup in one user action.
        event.preventDefault();
        event.stopImmediatePropagation();
        setupNavigationGuardRef.current = null;
        window.history.back();
        return;
      }

      if (state?.[SETUP_NAVIGATION_GUARD_STATE_KEY] === guard.token) return;

      // The guard entry uses the exact same URL as the live setup step. Restore
      // it synchronously and stop Router's listener before a same-document Back
      // can unmount the wizard while host work is still running.
      event.preventDefault();
      event.stopImmediatePropagation();
      window.history.pushState(
        setupNavigationGuardState(guard.baseState, guard.token),
        '',
        guard.url,
      );
    };

    window.addEventListener('beforeunload', blockUnload);
    window.addEventListener('popstate', blockHistoryBack, true);
    return () => {
      window.removeEventListener('beforeunload', blockUnload);
      window.removeEventListener('popstate', blockHistoryBack, true);
    };
  }, [finishWizardAction]);

  const invalidateSetupSession = useCallback((message: string) => {
    try { window.sessionStorage.removeItem(SETUP_SESSION_STORAGE_KEY); } catch {}
    setupSessionTokenRef.current = '';
    setSetupSessionToken('');
    setTokenInvalid(true);
    setBootstrapError(message);
  }, []);

  const loadSystemInfo = useCallback(async () => {
    if (bootstrapState !== 'ready') return;
    setSystemInfoState('loading');
    try {
      const { data } = await api.get<SystemInfoResponse>('/setup/system-info');
      setSystemInfo(data);
      setSystemInfoState('success');
      if (data.currentDomain && data.originMode !== 'tailnet') {
        setDomain(data.currentDomain);
        setConfiguredDomainUrl(`https://${data.currentDomain}`);
      }
    } catch (err: any) {
      if ([403, 410, 426].includes(Number(err?.response?.status))) {
        invalidateSetupSession(friendlyError(err, 'This setup session is no longer valid. Re-run the installer with --reinstall for a new protected link.'));
        return;
      }
      setSystemInfoState('error');
      setError(friendlyError(err, 'Could not load server details right now.'));
    }
  }, [api, bootstrapState, invalidateSetupSession]);

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
    } catch {
      setMailStatusState('error');
      setMailStatus(null);
    }
  }, [api]);

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
    } catch {
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
    let cancelled = false;
    const lifecycleGeneration = setupLifecycleGenerationRef.current;
    withSetupDeadline(
      api.get('/setup/status', { timeout: SETUP_STATUS_TIMEOUT_MS }),
      SETUP_STATUS_TIMEOUT_MS,
      'The setup status check timed out.',
    ).then(({ data }) => {
      if (
        cancelled
        || lifecycleGeneration !== setupLifecycleGenerationRef.current
        || wizardActionRef.current
      ) return;
      const persistedTailnetRequest = data?.tailnetOnboarding?.phase === 'REQUESTED';
      setTailnetRequested(persistedTailnetRequest);
      if (data.isReinstall) {
        setIsReinstall(true);
        if (data.ownerHint) setOwnerHint(data.ownerHint);
      } else if (!data.needsSetup) {
        const destination = getPostSetupDestination({
          quickSetup: false,
          aiRuntimeReady: true,
          tailnetRequested: persistedTailnetRequest,
        });
        navigateAfterSetupRecovery(
          persistedTailnetRequest
            ? `/login?setup=complete&redirect=${encodeURIComponent(destination)}`
            : '/login',
        );
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api, navigateAfterSetupRecovery]);

  const clearRedirectTimer = useCallback(() => {
    if (redirectTimerRef.current) {
      clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (bootstrapState === 'ready') void loadSystemInfo();
    return () => clearRedirectTimer();
  }, [bootstrapState, loadSystemInfo, clearRedirectTimer]);

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
    if (bootstrapState !== 'ready') return;
    if (step === 5 && systemInfo && setupMailAvailable && mailStatusState === 'idle') {
      loadMailStatus();
      if (preflightState === 'idle') loadMailPreflight();
    }
    if (step === 6 && (ollamaState === 'idle' || openClawState === 'idle')) loadAiStatus();
  }, [bootstrapState, step, systemInfo, setupMailAvailable, mailStatusState, ollamaState, openClawState, preflightState, loadMailStatus, loadMailPreflight, loadAiStatus]);

  const reinstallPasswordPolicy = useMemo(() => validatePasswordPolicy(reinstallPassword), [reinstallPassword]);
  const reinstallFormValid = useMemo(
    () => reinstallPassword.length > 0 && reinstallPasswordPolicy.valid && reinstallPassword === reinstallConfirmPassword,
    [reinstallConfirmPassword, reinstallPassword, reinstallPasswordPolicy.valid],
  );

  const handleLogoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const validationError = getSetupLogoValidationError(file);
    if (validationError) {
      setLogoFile(null);
      setLogoPreview('');
      setError(validationError);
      event.target.value = '';
      return;
    }
    setError('');
    setLogoFile(file);
  };

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview('');
      return;
    }
    const previewUrl = URL.createObjectURL(logoFile);
    setLogoPreview(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [logoFile]);

  const handleCheckDns = async () => {
    const domainSnapshot = domain.trim();
    if (!domainSnapshot) return;
    const owner = claimWizardAction({
      kind: 'check-dns',
      step,
      label: 'Checking DNS…',
      subject: domainSnapshot,
    });
    if (!owner) return;
    setDomainMessage('');
    setDnsStatus(null);
    try {
      const { data } = await api.post<DnsCheckResponse>('/setup/check-dns', { domain: domainSnapshot });
      setDnsStatus(data);
      setDomainMessage(data.message);
      if (data.pointsToUs) sounds.success();
    } catch (err) {
      setDomainMessage(friendlyError(err, 'DNS lookup failed. Double-check your domain and try again.'));
      sounds.error();
    } finally {
      releaseWizardAction(owner);
    }
  };

  const handleConfigureDomain = async () => {
    const domainSnapshot = domain.trim();
    if (!domainSnapshot) return;
    const owner = claimWizardAction({
      kind: 'configure-domain',
      step,
      label: 'Configuring HTTPS…',
      subject: domainSnapshot,
    });
    if (!owner) return;
    setDomainConfigState('loading');
    setDomainMessage('');
    setConfiguredDomainUrl('');
    setDomainHandoffToken('');
    try {
      const { data } = await api.post<{
        success: boolean;
        url: string;
        message: string;
        httpsReady: boolean;
        handoffToken?: string;
      }>('/setup/configure-domain', { domain: domainSnapshot });
      if (data.httpsReady && data.url && data.handoffToken) {
        setConfiguredDomainUrl(data.url);
        setDomainHandoffToken(data.handoffToken);
        setDomainConfigState('success');
        setDomainMessage(data.message);
        sounds.success();
      } else {
        setDomainConfigState('idle');
        setDomainMessage(data.message || 'HTTPS is not proven yet. Keep the SSH tunnel open and retry.');
      }

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
    } finally {
      releaseWizardAction(owner);
    }
  };

  const handleInstallMail = async () => {
    const owner = claimWizardAction({ kind: 'install-mail', step, label: 'Setting up email…' });
    if (!owner) return;
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
    } finally {
      releaseWizardAction(owner);
    }
  };

  const handleTestEmail = async () => {
    if (wizardActionRef.current) return;
    const emailSnapshot = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailSnapshot)) {
      setTestEmailState('error');
      setTestEmailMessage('Enter a valid admin email first so we know where to send the test message.');
      return;
    }

    const owner = claimWizardAction({
      kind: 'test-email',
      step,
      label: 'Sending test email…',
      subject: emailSnapshot,
    });
    if (!owner) return;

    setTestEmailState('loading');
    setTestEmailMessage('Sending a test email...');
    try {
      const { data } = await api.post<{ success: boolean; message: string }>('/setup/test-email', { email: emailSnapshot });
      setTestEmailState('success');
      setTestEmailMessage(data.message || 'Test email sent.');
      sounds.success();
    } catch (err) {
      setTestEmailState('error');
      setTestEmailMessage(friendlyError(err, 'The test email did not send. Check your DNS records and try again later.'));
      sounds.error();
    } finally {
      releaseWizardAction(owner);
    }
  };

  const handlePullModel = async (model: string) => {
    const modelSnapshot = model.trim();
    if (!modelSnapshot) return;
    const owner = claimWizardAction({
      kind: 'pull-model',
      step,
      label: `Pulling ${modelSnapshot}…`,
      subject: modelSnapshot,
    });
    if (!owner) return;
    setError('');
    setPullingModel(modelSnapshot);
    try {
      await api.post('/setup/ollama-pull', { model: modelSnapshot });
      sounds.success();
      await loadAiStatus();
    } catch (err) {
      setError(friendlyError(err, `Could not pull ${modelSnapshot}. Try again in a minute.`));
      sounds.error();
    } finally {
      setPullingModel('');
      releaseWizardAction(owner);
    }
  };

  const handleInstallCodingTool = async (tool: CodingToolStatusResponse['tools'][number]) => {
    const toolSnapshot = { id: tool.id, name: tool.name };
    const owner = claimWizardAction({
      kind: 'install-coding-tool',
      step,
      label: `Installing ${toolSnapshot.name}…`,
      subject: toolSnapshot.id,
    });
    if (!owner) return;
    setError('');
    try {
      await api.post('/setup/install-coding-tool', { toolId: toolSnapshot.id });
      await loadAiStatus();
      sounds.success();
    } catch (err: any) {
      setError(friendlyError(err, `Failed to install ${toolSnapshot.name}`));
      sounds.error();
    } finally {
      releaseWizardAction(owner);
    }
  };

  const handleRdSetup = async () => {
    const owner = claimWizardAction({ kind: 'install-rd', step, label: 'Setting up Remote Desktop…' });
    if (!owner) return;
    setRdSetupState('loading');
    setRdSetupMessage('Installing packages and configuring services… this can take 1–2 minutes.');
    setRdSetupSteps([]);
    try {
      const res = await api.post('/setup/install-rd');
      setRdSetupState(res.data.ok ? 'success' : 'error');
      setRdSetupMessage(res.data.message || '');
      setRdSetupSteps(res.data.steps || []);
      if (res.data.ok) sounds.success();
      else sounds.error();
    } catch (err: any) {
      setRdSetupState('error');
      setRdSetupMessage(err?.response?.data?.message || err?.message || 'Setup failed');
      setRdSetupSteps([]);
      sounds.error();
    } finally {
      releaseWizardAction(owner);
    }
  };

  const handleTailnetOnboardingToggle = async () => {
    const requested = !tailnetRequested;
    const owner = claimWizardAction({
      kind: 'tailnet-onboarding',
      step,
      label: requested
        ? 'Saving Remote GPU handoff…'
        : 'Removing Remote GPU handoff…',
    });
    if (!owner) return;
    setError('');
    try {
      const { data } = await api.post('/setup/tailnet-onboarding', {
        requested,
      });
      setTailnetRequested(data?.phase === 'REQUESTED');
      sounds.success();
    } catch (err) {
      setError(friendlyError(
        err,
        'The Remote GPU handoff choice could not be saved. Retry before leaving setup.',
      ));
      sounds.error();
    } finally {
      releaseWizardAction(owner);
    }
  };

  const handleComplete = async () => {
    if (wizardActionRef.current) return;
    const snapshot = {
      name: name.trim(),
      email: email.trim(),
      password,
      confirmPassword,
      portalName: portalName.trim() || 'My AI Portal',
      theme,
      accentColor,
      logoFile,
      registrationMode,
      allowTelemetry,
      searchEngineVisibility,
      quickSetup,
      aiRuntimeReady,
      tailnetRequested,
    };
    const snapshotPasswordPolicy = validatePasswordPolicy(snapshot.password);

    if (snapshot.name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(snapshot.email)) {
      setError('Finish the admin account step before launching the portal.');
      return;
    }

    if (!snapshotPasswordPolicy.valid) {
      setError(PASSWORD_POLICY_HINT);
      return;
    }

    if (snapshot.password !== snapshot.confirmPassword) {
      setError('Passwords must match before launching the portal.');
      return;
    }

    const owner = claimWizardAction({ kind: 'complete', step, label: 'Completing setup…' });
    if (!owner) return;

    setSubmitting(true);
    setError('');
    setSetupRecoveryError('');
    let completionRequestStarted = false;
    let completionRequestConfirmed = false;
    try {
      let logoUrl = '';
      if (snapshot.logoFile) {
        const formData = new FormData();
        formData.append('file', snapshot.logoFile);
        const { data } = await withSetupDeadline(
          api.post<{ url: string }>('/setup/upload-logo', formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: SETUP_COMPLETION_TIMEOUT_MS,
          }),
          SETUP_COMPLETION_TIMEOUT_MS,
          'The logo upload timed out before setup was submitted.',
        );
        logoUrl = data.url;
      }

      completionRequestStarted = true;
      await withSetupDeadline(
        api.post('/setup/complete', {
          name: snapshot.name,
          email: snapshot.email,
          password: snapshot.password,
          portalName: snapshot.portalName,
          theme: snapshot.theme,
          accentColor: snapshot.accentColor,
          logoUrl: logoUrl || undefined,
          registrationMode: snapshot.registrationMode,
          allowTelemetry: snapshot.allowTelemetry,
          searchEngineVisibility: snapshot.searchEngineVisibility,
          tailnetRequested: snapshot.tailnetRequested,
        }, { timeout: SETUP_COMPLETION_TIMEOUT_MS }),
        SETUP_COMPLETION_TIMEOUT_MS,
        'The setup completion request timed out. Portal is checking whether it committed before allowing a retry.',
      );
      completionRequestConfirmed = true;

      try { window.sessionStorage.removeItem(SETUP_SESSION_STORAGE_KEY); } catch {}
      setupSessionTokenRef.current = '';
      setSetupSessionToken('');

      localStorage.setItem('theme', snapshot.theme);
      localStorage.setItem('accentColor', snapshot.accentColor);
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

      const serverReady = await waitForServer();
      if (!serverReady) throw new Error('Portal did not become healthy before the restart deadline.');
      await withSetupDeadline(
        refreshPublicSettings(),
        SETUP_STATUS_TIMEOUT_MS,
        'Public settings did not refresh before the recovery deadline.',
      );
      const restored = await withSetupDeadline(
        restoreSession(),
        SETUP_STATUS_TIMEOUT_MS,
        'Session recovery did not finish before the recovery deadline.',
      );
      if (restored) {
        navigateAfterWizardAction(owner, getPostSetupDestination({
          quickSetup: snapshot.quickSetup,
          aiRuntimeReady: snapshot.aiRuntimeReady,
          tailnetRequested: snapshot.tailnetRequested,
        }));
      } else {
        const destination = getPostSetupDestination({
          quickSetup: snapshot.quickSetup,
          aiRuntimeReady: snapshot.aiRuntimeReady,
          tailnetRequested: snapshot.tailnetRequested,
        });
        navigateAfterWizardAction(
          owner,
          `/login?setup=complete&redirect=${encodeURIComponent(destination)}`,
        );
      }
    } catch (err) {
      // A response can be lost while the service restarts after a successful
      // atomic commit. Reconcile status before telling the user to repeat setup.
      let authoritativeStatus: {
        needsSetup?: boolean;
        isReinstall?: boolean;
        tailnetOnboarding?: { phase?: string };
      } | null = null;
      try {
        const { data: status } = await withSetupDeadline(
          api.get('/setup/status', {
            params: { _t: Date.now() },
            timeout: SETUP_STATUS_TIMEOUT_MS,
          }),
          SETUP_STATUS_TIMEOUT_MS,
          'The setup reconciliation request timed out.',
        );
        authoritativeStatus = status;
        if (status && status.needsSetup === false && status.isReinstall !== true) {
          const tailnetOnboardingRequested =
            status.tailnetOnboarding?.phase === 'REQUESTED';
          const destination = getPostSetupDestination({
            quickSetup: snapshot.quickSetup,
            aiRuntimeReady: snapshot.aiRuntimeReady,
            tailnetRequested: tailnetOnboardingRequested,
          });
          navigateAfterWizardAction(
            owner,
            `/login?setup=complete&redirect=${encodeURIComponent(destination)}`,
          );
          return;
        }
      } catch {}
      const rejectionStatus = Number((err as any)?.response?.status);
      const definitelyRejectedBeforeCommit = rejectionStatus === 400 || rejectionStatus === 422;
      const authoritativelyPending = authoritativeStatus?.needsSetup === true && !completionRequestConfirmed;
      if (authoritativelyPending || !completionRequestStarted || definitelyRejectedBeforeCommit) {
        setSetupComplete(false);
        setError(friendlyError(err, 'Setup could not be completed. Review the details and retry.'));
      } else {
        setSetupComplete(false);
        setSetupRecoveryError('Portal setup may already be committed, but the restart could not be confirmed. Do not submit setup again. Reload to re-check the service, or continue to sign in.');
      }
      sounds.error();
    } finally {
      setSubmitting(false);
      releaseWizardAction(owner);
    }
  };

  const handleReinstallReset = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (wizardActionRef.current) return;
    setReinstallError('');

    const passwordSnapshot = reinstallPassword;
    const confirmationSnapshot = reinstallConfirmPassword;
    const passwordPolicySnapshot = validatePasswordPolicy(passwordSnapshot);

    if (passwordSnapshot !== confirmationSnapshot) {
      setReinstallError('Passwords must match.');
      return;
    }

    if (!passwordPolicySnapshot.valid) {
      setReinstallError(PASSWORD_POLICY_HINT);
      return;
    }

    const owner = claimWizardAction({ kind: 'reinstall-reset', step, label: 'Resetting password…' });
    if (!owner) return;

    setReinstallSubmitting(true);
    try {
      const { data } = await api.post('/setup/reinstall-reset', { password: passwordSnapshot });
      try { window.sessionStorage.removeItem(SETUP_SESSION_STORAGE_KEY); } catch {}
      setupSessionTokenRef.current = '';
      setSetupSessionToken('');
      alert(`Password reset! Log in with: ${data.email || data.username}`);
      navigateAfterWizardAction(owner, '/login');
    } catch (err: any) {
      setReinstallError(friendlyError(err, 'Reset failed'));
    } finally {
      setReinstallSubmitting(false);
      releaseWizardAction(owner);
    }
  };

  const renderWelcome = () => (
    <StepShell stepKey={step}>
      <div className="text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-xl shadow-emerald-900/30">
          <Rocket className="h-10 w-10 text-white" />
        </div>
        <h2 className="mt-5 text-3xl font-bold text-white">Your portal is installed!</h2>
        <p className="mt-2 text-slate-400">Create the owner account now, then configure only the services you actually need.</p>
      </div>

      <div className={`${cardClass} p-5`}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Server snapshot</h3>
            <p className="text-sm text-slate-400">What the installer found on this machine.</p>
          </div>
          <button type="button" aria-label="Refresh server snapshot" onClick={loadSystemInfo} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800">
            <RefreshCw className={`h-4 w-4 ${systemInfoState === 'loading' ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {systemInfoState === 'loading' && !systemInfo ? (
          <div className="flex items-center justify-center py-8 text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading system info...</div>
        ) : systemInfo ? (
          <div className="space-y-5">
            {systemInfo.originMode === 'tailnet' && (
              <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-4 text-left">
                <div className="flex items-start gap-3">
                  <Lock className="mt-0.5 h-5 w-5 flex-shrink-0 text-cyan-300" />
                  <div>
                    <p className="font-semibold text-cyan-100">Experimental private Tailnet install</p>
                    <p className="mt-1 text-sm text-cyan-50/80">
                      This Portal is reachable only from devices signed into your Tailscale network. No public domain or open web ports are required.
                    </p>
                  </div>
                </div>
              </div>
            )}
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

      <div className="grid gap-3 md:grid-cols-2">
        <button
          type="button"
          onClick={() => {
            sounds.click();
            setQuickSetup(true);
            setStep(2);
          }}
          className="rounded-2xl bg-emerald-500 px-6 py-4 text-left text-white transition hover:bg-emerald-600"
        >
          <span className="block text-lg font-semibold">Quick setup</span>
          <span className="mt-1 block text-sm text-emerald-50/90">Create the owner, launch the runtime, then connect AI from the authenticated portal.</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setQuickSetup(false);
            goNext();
          }}
          className="rounded-2xl border border-slate-700 bg-slate-900 px-6 py-4 text-left text-white transition hover:border-slate-600 hover:bg-slate-800"
        >
          <span className="block text-lg font-semibold">Guided setup</span>
          <span className="mt-1 block text-sm text-slate-400">Configure domain, branding, security, email, and optional services before launch.</span>
        </button>
      </div>
    </StepShell>
  );

  const renderAdmin = () => (
    <StepShell stepKey={step}>
      <div>
        <h2 className="text-2xl font-bold text-white">Create your admin account</h2>
        <p className="mt-2 text-slate-400">This is YOUR account — the portal owner.</p>
      </div>
      {quickSetup && (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">
          After this account is created, the portal will restart and take you directly to AI Providers. OpenClaw sign-in happens there, after its gateway is ready to save credentials.
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label htmlFor="setup-owner-name" className="mb-2 block text-sm font-medium text-slate-300">Full name</label>
          <input id="setup-owner-name" value={name} onChange={(e) => { if (!wizardActionRef.current) setName(e.target.value); }} disabled={wizardActionActive} placeholder="Your name" aria-label="Full name" className={inputClass} />
          {name.length > 0 && name.trim().length < 2 && <p className="mt-2 text-xs text-amber-400">Use at least 2 characters.</p>}
        </div>
        <div className="md:col-span-2">
          <label htmlFor="setup-owner-email" className="mb-2 block text-sm font-medium text-slate-300">Email address</label>
          <input id="setup-owner-email" value={email} onChange={(e) => { if (!wizardActionRef.current) setEmail(e.target.value); }} disabled={wizardActionActive} placeholder="you@example.com" aria-label="Email address" className={inputClass} />
          {email.length > 0 && !emailLooksValid && <p className="mt-2 text-xs text-amber-400">Enter a valid email address.</p>}
        </div>
        <div>
          <label htmlFor="setup-owner-password" className="mb-2 block text-sm font-medium text-slate-300">Password</label>
          <PasswordInput id="setup-owner-password" value={password} onChange={(value) => { if (!wizardActionRef.current) setPassword(value); }} disabled={wizardActionActive} ariaLabel="Password" placeholder="Min 8 chars, upper/lower/number" />
          <p className={`mt-2 text-xs ${password.length > 0 && !passwordPolicy.valid ? 'text-amber-400' : 'text-slate-500'}`}>{PASSWORD_POLICY_HINT}</p>
          {password.length > 0 && !passwordPolicy.valid && (
            <ul className="mt-2 space-y-1 text-xs text-amber-300">
              {passwordPolicy.errors.map((message) => <li key={message}>• {message}</li>)}
            </ul>
          )}
        </div>
        <div>
          <label htmlFor="setup-owner-password-confirmation" className="mb-2 block text-sm font-medium text-slate-300">Confirm password</label>
          <PasswordInput id="setup-owner-password-confirmation" value={confirmPassword} onChange={(value) => { if (!wizardActionRef.current) setConfirmPassword(value); }} disabled={wizardActionActive} ariaLabel="Confirm password" placeholder="Repeat your password" />
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
          <label htmlFor="setup-portal-name" className="mb-2 block text-sm font-medium text-slate-300">Portal name</label>
          <input id="setup-portal-name" value={portalName} onChange={(e) => setPortalName(e.target.value)} placeholder="My AI Portal" aria-label="Portal name" className={inputClass} />
        </div>

        <fieldset>
          <legend className="mb-2 block text-sm font-medium text-slate-300">Theme</legend>
          <div className="grid gap-3 md:grid-cols-3">
            {(['dark', 'light', 'system'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setTheme(choice)}
                aria-pressed={theme === choice}
                className={`rounded-xl border px-4 py-3 text-sm font-medium capitalize transition ${theme === choice ? 'accent-active' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'}`}
              >
                {choice}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 block text-sm font-medium text-slate-300">Accent color</legend>
          <div className="flex flex-wrap gap-3">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.color}
                type="button"
                title={preset.name}
                aria-label={`${preset.name} accent color`}
                aria-pressed={accentColor === preset.color}
                onClick={() => setAccentColor(preset.color)}
                className={`h-11 w-11 rounded-xl border transition ${accentColor === preset.color ? 'scale-110 border-white ring-2 ring-white/60 ring-offset-2 ring-offset-slate-950' : 'border-slate-700 hover:scale-105'}`}
                style={{ backgroundColor: preset.color }}
              />
            ))}
            <label className="flex h-11 w-24 cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-600 bg-slate-900 text-sm text-slate-300 transition hover:border-slate-500">
              Custom
              <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} aria-label="Custom accent color" className="sr-only" />
            </label>
          </div>
        </fieldset>

        <div className={`${cardClass} p-4`}>
          <p className="mb-3 block text-sm font-medium text-slate-300">Logo upload (optional)</p>
          <div className="flex flex-col gap-4 md:flex-row md:items-center">
            <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
              {logoPreview ? <img src={logoPreview} alt="Logo preview" className="h-full w-full object-contain" /> : <Upload className="h-6 w-6 text-slate-500" />}
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-600 hover:bg-slate-800">
              <Upload className="h-4 w-4" />
              {logoFile ? 'Replace logo' : 'Upload logo'}
              <input type="file" accept={SETUP_LOGO_MIME_TYPES.join(',')} aria-label="Upload portal logo" className="sr-only" onChange={handleLogoChange} />
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
            aria-label="Allow search engine indexing"
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
    const hostname = window.location.hostname;
    const isLocalInstall = systemInfo?.installProfile === 'local' || hostname === 'localhost' || hostname === '127.0.0.1';
    // If we're already on HTTPS, domain is already configured
    const alreadyOnHttps = window.location.protocol === 'https:';
    const currentDomain = alreadyOnHttps ? window.location.hostname : '';

    return (
    <StepShell stepKey={step}>
      {!systemInfo ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-300">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Checking this Portal&apos;s access mode…
        </div>
      ) : isTailnetOrigin ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-2xl font-bold text-white">Private Tailnet access</h2>
            <p className="mt-2 text-slate-400">Tailscale is providing the private HTTPS address for this Portal.</p>
          </div>
          <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-5">
            <div className="flex items-start gap-3">
              <Lock className="mt-0.5 h-5 w-5 flex-shrink-0 text-cyan-300" />
              <div>
                <p className="font-semibold text-cyan-100">Experimental private mode</p>
                <p className="mt-2 break-all font-mono text-sm text-cyan-50">{window.location.origin}</p>
                <p className="mt-3 text-sm text-cyan-50/80">
                  Only devices joined to this same tailnet can open the Portal. You do not need to buy a domain, edit public DNS, or expose ports 80 and 443.
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <p className="font-semibold text-amber-200">Private-mode limitations in 4.0</p>
            <p className="mt-2">{setupMailCapability?.reason || 'Portal mail requires a public domain and is unavailable in this mode.'}</p>
            <p className="mt-2">{systemInfo?.featureCapabilities?.appHosting.reason || 'Hosted apps and public share links require a separate isolated origin and are unavailable in this mode.'}</p>
            <p className="mt-2 text-amber-200/90">For a public production portal with mail and hosted sharing, use the recommended domain install mode.</p>
          </div>
        </div>
      ) : isLocalInstall ? (
        <div className="space-y-4">
          <div>
            <h2 className="text-2xl font-bold text-white">Domain &amp; HTTPS</h2>
            <p className="mt-2 text-slate-400">This install is running in local beta mode.</p>
          </div>
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <p className="font-semibold text-amber-200">Local Windows / WSL beta</p>
            <p className="mt-2">This Windows path is still <strong className="text-amber-50">experimental, untested in the field, and under active development</strong>. This portal is intentionally staying on <span className="font-mono text-amber-50">localhost</span> right now.</p>
            <p className="mt-2">Public domains, automatic HTTPS, stable external project share links, and email DNS setup are VPS features and are not implemented in the Windows beta path yet.</p>
            <p className="mt-2 text-amber-200/90">Use this install to test the product on your own machine. If you want a real public URL people can visit from the internet, deploy the portal on a Linux VPS.</p>
          </div>
        </div>
      ) : alreadyOnHttps ? (
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
        <button type="button" onClick={() => { if (!wizardActionRef.current) setDomainPath('domain'); }} disabled={wizardActionActive} aria-pressed={domainPath === 'domain'} className={`rounded-2xl border p-5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${domainPath === 'domain' ? 'accent-active' : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'}`}>
          <p className="font-semibold text-white">I have a domain</p>
          <p className="mt-2 text-sm text-slate-400">We&apos;ll verify DNS and turn on HTTPS for you.</p>
        </button>
        <button type="button" onClick={() => { if (!wizardActionRef.current) setDomainPath('skip'); }} disabled={wizardActionActive} aria-pressed={domainPath === 'skip'} className={`rounded-2xl border p-5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${domainPath === 'skip' ? 'accent-active' : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'}`}>
          <p className="font-semibold text-white">Not yet, skip for now</p>
          <p className="mt-2 text-sm text-slate-400">You can add a domain anytime in Settings → General.</p>
        </button>
      </div>

      {domainPath === 'domain' ? (
        <div className="space-y-4">
          <div>
            <label htmlFor="setup-domain-name" className="mb-2 block text-sm font-medium text-slate-300">Domain name</label>
            <input id="setup-domain-name" value={domain} onChange={(e) => { if (!wizardActionRef.current) setDomain(e.target.value); }} disabled={wizardActionActive} placeholder="portal.example.com" aria-label="Domain name" className={inputClass} />
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
            <button type="button" onClick={handleCheckDns} aria-busy={ownsWizardAction('check-dns')} disabled={wizardActionActive || !domain.trim()} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
              {ownsWizardAction('check-dns') ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {ownsWizardAction('check-dns') ? 'Checking DNS…' : 'Check DNS'}
            </button>
            <button type="button" onClick={handleConfigureDomain} aria-busy={ownsWizardAction('configure-domain')} disabled={wizardActionActive || !dnsStatus?.pointsToUs} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
              {ownsWizardAction('configure-domain') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />} {ownsWizardAction('configure-domain') ? 'Configuring HTTPS…' : 'Configure HTTPS'}
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
          You can add a domain anytime in Settings → General. For now the portal will stay on HTTP.
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
        <p className="mt-2 text-slate-400">
          {setupMailAvailable
            ? 'Email powers these security features. If you already added the optional mail DNS records on the previous step, you only have a small final DNS step left here.'
            : 'Email-based security features require a public domain and are not part of this install mode.'}
        </p>
      </div>

      {!systemInfo ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-300">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Checking whether mail is available…
        </div>
      ) : !setupMailAvailable ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-300" />
            <div>
              <p className="font-semibold text-amber-100">Mail is unavailable in this install mode</p>
              <p className="mt-2 text-sm text-amber-100/80">
                {setupMailCapability?.reason || 'Mail requires a public domain.'}
              </p>
              {isTailnetOrigin && (
                <p className="mt-2 text-sm text-amber-200/90">
                  Your private Tailnet Portal remains usable without mail. Password reset and email-code security options will stay unavailable until the Portal is migrated to a public domain.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
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
              <button type="button" aria-label="Refresh email status" onClick={loadMailStatus} disabled={wizardActionActive} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                <RefreshCw className={`h-4 w-4 ${mailStatusState === 'loading' ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {mailStatus && (
              <div className="mt-4 grid gap-3 md:grid-cols-4">
                {[
                  { label: 'Mail server', value: mailStatus.available ? 'Detected' : 'Not installed' },
                  { label: 'Configured', value: mailStatus.configured ? 'Yes' : 'No' },
                  { label: 'DKIM signing', value: mailStatus.dkimConfigured ? 'Verified' : 'Needs setup' },
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
            <button type="button" onClick={handleInstallMail} aria-busy={ownsWizardAction('install-mail')} disabled={wizardActionActive} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
              {ownsWizardAction('install-mail') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />} {ownsWizardAction('install-mail') ? 'Setting up email…' : installMailState === 'error' ? 'Retry email setup' : 'Set Up Email'}
            </button>
            <button type="button" onClick={handleTestEmail} aria-busy={ownsWizardAction('test-email')} disabled={wizardActionActive || !(mailStatus?.configured || installMailState === 'success')} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-white transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
              {ownsWizardAction('test-email') ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {ownsWizardAction('test-email') ? 'Sending test email…' : testEmailState === 'error' ? 'Retry test email' : 'Send Test Email'}
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
                <p><strong className="text-slate-300">Registrar tip:</strong> Most providers auto-append your domain — enter the exact names shown above (such as <code className="bg-slate-800 px-1 rounded">portal-rsa._domainkey</code>) rather than adding the full domain yourself.</p>
              </div>
            </div>
          )}
        </div>
      )}
        </>
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
            <button type="button" aria-label="Refresh AI coding tools" onClick={loadAiStatus} disabled={wizardActionActive} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
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
                      onClick={() => handleInstallCodingTool(tool)}
                      aria-busy={ownsWizardAction('install-coding-tool', tool.id)}
                      disabled={wizardActionActive}
                      className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {ownsWizardAction('install-coding-tool', tool.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      {ownsWizardAction('install-coding-tool', tool.id) ? 'Installing…' : 'Install'}
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

        {aiRuntimeReady ? (
          <fieldset disabled={wizardActionActive} className="min-w-0 border-0 p-0 disabled:opacity-60">
            <AiProviderSetup mode="wizard" apiBase="/setup/ai" onComplete={() => goNext()} />
          </fieldset>
        ) : (
          <div className="rounded-2xl border border-sky-500/20 bg-sky-500/10 p-5">
            <h3 className="font-semibold text-sky-100">Cloud provider sign-in moves to after launch</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              OpenClaw and its credential store are not ready for a durable sign-in yet. The wizard will not start an OAuth or token flow that cannot persist its credentials. After the portal restarts, you will land on AI Providers and continue there with the tested runtime online.
            </p>
          </div>
        )}

        <div className={`${cardClass} p-5`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-white">Ollama</h3>
              <p className="mt-1 text-sm text-slate-400">Local Ollama runs model inference on this server. If you configure a remote or Tailnet Ollama host, requests are sent to that selected host.</p>
            </div>
            <button type="button" aria-label="Refresh Ollama status" onClick={loadAiStatus} disabled={wizardActionActive} className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
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
                  <p className="text-xs uppercase tracking-wide text-slate-500">Available now</p>
                  <p className="mt-1 text-sm font-medium text-white">{ollamaStatus.availableRamGb} GB</p>
                  <p className="mt-1 text-xs text-slate-500">{ollamaStatus.ramGb} GB total</p>
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
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                              <span>Download: {model.size}</span>
                              <span>Context: {model.contextWindow}</span>
                              <span className="capitalize">Use: {model.useCase}</span>
                              <a href={model.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300">
                                Official catalog <ExternalLink className="h-3 w-3" />
                              </a>
                            </div>
                          </div>
                        </div>
                        {installed ? (
                          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-300">
                            <CheckCircle2 className="h-4 w-4" /> Installed
                          </span>
                        ) : (
                          <button type="button" onClick={() => handlePullModel(model.name)} aria-busy={ownsWizardAction('pull-model', model.name)} disabled={wizardActionActive} className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
                            {ownsWizardAction('pull-model', model.name) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} {ownsWizardAction('pull-model', model.name) ? 'Pulling…' : 'Pull'}
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
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="max-w-2xl">
              <h3 className="text-lg font-semibold text-white">Remote GPU over your Tailnet</h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">
                After launch, the Owner can choose a Windows PC already on this tailnet and connect its loopback Ollama through one private, identity-bound Tailscale Serve rule.
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Run one Windows setup, acknowledge the narrow Tailscale Grant, then pull or select a model. Portal never asks for a raw Ollama URL or browser secret, and connecting does not require a preinstalled model.
              </p>
            </div>
            <button
              type="button"
              aria-pressed={tailnetRequested}
              aria-busy={ownsWizardAction('tailnet-onboarding')}
              onClick={() => { void handleTailnetOnboardingToggle(); }}
              disabled={wizardActionActive}
              className={`min-h-11 rounded-xl border px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
                tailnetRequested
                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800'
              }`}
            >
              {ownsWizardAction('tailnet-onboarding')
                ? 'Saving handoff…'
                : tailnetRequested
                  ? 'Remote GPU queued after launch'
                  : 'Connect after launch'}
            </button>
          </div>
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
            <div className="mt-5 space-y-3">
              <div className="grid gap-3 md:grid-cols-4">
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
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Ready for sign-in</p>
                <p className={`mt-1 text-sm font-medium ${openClawStatus.ready ? 'text-emerald-300' : 'text-amber-300'}`}>{openClawStatus.ready ? '✓ Yes' : '✗ Not yet'}</p>
              </div>
              </div>
              {!openClawStatus.ready && (openClawStatus.blockers || []).length > 0 && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-200">Readiness checks</p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-300">
                    {(openClawStatus.blockers || []).map((blocker) => <li key={blocker.code}>• {blocker.message}</li>)}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">OpenClaw status is unavailable right now. If it is not installed yet, you can add it later.</div>
          )}
        </div>

      </div>
    </StepShell>
  );

  const renderRemoteDesktop = () => {
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
            {rdSetupState !== 'success' && (
              <button
                type="button"
                onClick={handleRdSetup}
                aria-busy={ownsWizardAction('install-rd')}
                disabled={wizardActionActive}
                className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/30 px-4 py-3 text-sm font-medium text-blue-300 transition hover:bg-blue-500/30 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {ownsWizardAction('install-rd') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Monitor className="h-4 w-4" />}
                {ownsWizardAction('install-rd') ? 'Setting up Remote Desktop…' : rdSetupState === 'error' ? 'Retry Remote Desktop Setup' : 'Set Up Remote Desktop'}
              </button>
            )}
            {rdSetupState === 'loading' && (
              <p role="status" className="mt-3 text-sm text-blue-300">Installing packages and configuring services… this can take 1–2 minutes.</p>
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
              </div>
            )}
          </div>
        </div>

        <div className="text-sm text-slate-500 text-center">
          You can also set up Remote Desktop later from Settings → Feature Readiness.
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
          {
            title: 'Access',
            content: !systemInfo
              ? 'Checking access mode…'
              : isTailnetOrigin
              ? `Private Tailnet (experimental)\n${window.location.origin}`
              : configuredDomainUrl || 'No public domain (HTTP)',
          },
          {
            title: 'Email',
            content: !systemInfo
              ? 'Checking availability…'
              : setupMailAvailable
              ? mailStatus?.configured || installMailState === 'success' ? 'Configured' : 'Not configured'
              : `Unavailable\n${setupMailCapability?.reason || 'Requires a public domain'}`,
          },
          {
            title: 'AI',
            content: `Ollama on Portal host: ${ollamaStatus?.running ? `${ollamaStatus.models.length} model(s)` : 'Not ready'}${tailnetRequested ? '\nRemote GPU: Setup queued after launch' : ''}\nOpenClaw: ${openClawStatus?.installed ? (openClawStatus.gatewayRunning ? 'Installed + running' : 'Installed') : 'Not detected'}`,
          },
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
            <h3 className="text-sm font-semibold text-white">Share limited operational telemetry</h3>
            <p className="mt-1 text-sm text-slate-400">
              Enabled by default and optional. The Portal sends a report shortly after startup and then about every 24 hours while it remains running. That report contains a random install ID, Portal and dependency versions, Portal user count, uptime, Node version, operating system, and architecture. Messages, prompts, project files, credentials, usernames, and email addresses are not included. You can turn this off now or later in Settings. Installer lifecycle tracking is separate: install and update milestones include the event type, Portal version, operating system name and version, and the random install ID. This switch controls Portal operational telemetry, not those installer events.
            </p>
            {!allowTelemetry && <p className="mt-2 text-xs text-amber-300/90">Portal operational reports are off. Dashboard version checks and manual refreshes still work.</p>}
          </div>
          <button
            type="button"
            aria-label="Share limited operational telemetry"
            onClick={() => { if (!wizardActionRef.current) setAllowTelemetry((current) => !current); }}
            disabled={wizardActionActive}
            className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full border transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-60 ${allowTelemetry ? 'border-emerald-400/40 bg-emerald-500' : 'border-slate-700 bg-slate-800'}`}
            aria-pressed={allowTelemetry}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 translate-y-0.5 rounded-full shadow-sm transition-transform duration-200 ${allowTelemetry ? 'translate-x-[22px] bg-white' : 'translate-x-0.5 bg-slate-400'}`}
            />
          </button>
        </div>
      </div>

    </StepShell>
  );

  if (bootstrapState === 'blocked') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 px-4 text-slate-100">
        <div className="max-w-lg rounded-3xl border border-amber-500/30 bg-slate-900/90 p-8 shadow-2xl">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10">
            <Lock className="h-8 w-8 text-amber-300" />
          </div>
          <h1 className="text-center text-2xl font-semibold text-white">Setup is blocked on public HTTP</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">
            This page will not collect a bootstrap bearer, owner password, or provider credential on an unencrypted public origin.
          </p>
          {bootstrapError && <p className="mt-3 text-sm text-amber-200">{bootstrapError}</p>}
          <div className="mt-5 rounded-2xl border border-slate-700 bg-slate-950/70 p-4">
            <p className="text-sm font-medium text-white">Use the protected path printed by the installer</p>
            <p className="mt-2 text-sm text-slate-400">Without a TLS domain, keep this SSH tunnel running on your computer:</p>
            <code className="mt-3 block break-all rounded-lg bg-slate-900 p-3 text-xs text-emerald-300">ssh -N -L 4001:127.0.0.1:4001 &lt;ssh-user&gt;@{window.location.hostname}</code>
            <p className="mt-3 text-sm text-slate-400">Then open the full <span className="font-mono text-slate-200">http://localhost:4001/setup#bootstrap=…</span> link from that installer output. If you supplied a domain, use only its installer-verified HTTPS link.</p>
          </div>
        </div>
      </div>
    );
  }

  if (bootstrapState !== 'ready') {
    const loading = bootstrapState === 'loading';
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-950 px-4 text-slate-100">
        <div className="max-w-md rounded-3xl border border-slate-800 bg-slate-900/90 p-8 text-center shadow-2xl">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
            {loading ? <Loader2 className="h-8 w-8 animate-spin text-emerald-300" /> : <Lock className="h-8 w-8 text-emerald-300" />}
          </div>
          <h1 className="text-xl font-semibold text-white">{loading ? 'Securing setup…' : 'Protected setup link required'}</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            {loading
              ? 'Exchanging the one-time bootstrap for an origin-bound setup session.'
              : bootstrapError || 'Open the full loopback or verified-HTTPS setup link printed by the installer.'}
          </p>
          {!loading && (
            <div className="mt-5 rounded-xl bg-slate-950/70 p-4 text-left text-xs text-slate-400">
              <p>Accepted examples:</p>
              <code className="mt-2 block break-all text-emerald-300">http://localhost:4001/setup#bootstrap=…</code>
              <code className="mt-2 block break-all text-emerald-300">https://portal.example.com/setup#bootstrap=…</code>
              <p className="mt-3">The fragment is exchanged once, removed from the address bar, and cannot be replayed.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (setupRecoveryError) {
    return (
      <div className="min-h-dvh bg-slate-950 px-4 py-10 text-slate-100">
        <div className="mx-auto flex min-h-[80vh] max-w-2xl items-center justify-center">
          <div className="w-full rounded-3xl border border-amber-500/25 bg-slate-900/90 p-8 text-center shadow-2xl shadow-black/30 backdrop-blur">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-amber-500/10 ring-8 ring-amber-500/5">
              <AlertTriangle className="h-10 w-10 text-amber-300" />
            </div>
            <h2 className="mt-6 text-2xl font-bold text-white">Setup status needs confirmation</h2>
            <p role="alert" className="mt-3 text-sm leading-6 text-amber-100">{setupRecoveryError}</p>
            <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
              <button type="button" onClick={() => window.location.reload()} className="rounded-xl border border-slate-700 bg-slate-800 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-700">
                Reload and re-check
              </button>
              <button type="button" onClick={() => navigateAfterSetupRecovery('/login?setup=complete')} className="rounded-xl bg-emerald-500 px-5 py-3 text-sm font-medium text-slate-950 transition hover:bg-emerald-400">
                Continue to sign in
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
            This origin-bound setup session is missing, expired, or no longer valid.
            Re-run the installer with <span className="font-mono">--reinstall</span> if the original browser tab cannot be resumed.
          </p>
          {bootstrapError && <p className="mb-4 text-sm text-amber-200">{bootstrapError}</p>}
          <div className="rounded-lg bg-slate-800/60 p-3 text-left">
            <p className="text-xs text-slate-500 mb-1">Use a protected installer URL:</p>
            <code className="text-xs text-emerald-400 break-all">http://localhost:4001/setup#bootstrap=…</code>
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
            <form onSubmit={handleReinstallReset} aria-busy={ownsWizardAction('reinstall-reset')}>
              <div className="mb-4">
                <label htmlFor="reinstall-password" className="mb-1 block text-sm font-medium text-slate-300">New Password</label>
                <PasswordInput id="reinstall-password" value={reinstallPassword} onChange={(value) => { if (!wizardActionRef.current) setReinstallPassword(value); }} disabled={wizardActionActive} ariaLabel="New password" placeholder="Min 8 chars, upper/lower/number" />
                <p className={`mt-2 text-xs ${reinstallPassword.length > 0 && !reinstallPasswordPolicy.valid ? 'text-amber-400' : 'text-slate-500'}`}>{PASSWORD_POLICY_HINT}</p>
                {reinstallPassword.length > 0 && !reinstallPasswordPolicy.valid && (
                  <ul className="mt-2 space-y-1 text-xs text-amber-300">
                    {reinstallPasswordPolicy.errors.map((message) => <li key={message}>• {message}</li>)}
                  </ul>
                )}
              </div>
              <div className="mb-6">
                <label htmlFor="reinstall-password-confirmation" className="mb-1 block text-sm font-medium text-slate-300">Confirm Password</label>
                <PasswordInput id="reinstall-password-confirmation" value={reinstallConfirmPassword} onChange={(value) => { if (!wizardActionRef.current) setReinstallConfirmPassword(value); }} disabled={wizardActionActive} ariaLabel="Confirm new password" placeholder="Repeat your password" />
                {reinstallConfirmPassword.length > 0 && reinstallPassword !== reinstallConfirmPassword && <p className="mt-2 text-xs text-amber-400">Passwords must match.</p>}
              </div>
              {reinstallError && <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{reinstallError}</div>}
              <button type="submit" aria-busy={ownsWizardAction('reinstall-reset')} disabled={wizardActionActive || !reinstallFormValid}
                className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60">
                {ownsWizardAction('reinstall-reset') ? 'Resetting password…' : reinstallSubmitting ? 'Resetting…' : 'Reset Password & Continue'}
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
              <p className="text-sm text-slate-400">{quickSetup ? 'Quick setup' : `Step ${step + 1} of ${STEPS.length}`}</p>
            </div>
          </div>

          <div className="mb-6 h-2 overflow-hidden rounded-full bg-slate-800">
            <motion.div className="h-full bg-emerald-500" animate={{ width: `${progress}%` }} transition={{ duration: 0.25 }} />
          </div>

          {!quickSetup && (
            <div className="mb-8">
              <StepIndicator currentStep={step} />
            </div>
          )}

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

          {activeWizardAction && (
            <p role="status" className="sr-only">{activeWizardAction.label}</p>
          )}

          {error && (
            <div role="alert" className="mt-6 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
              {error}
            </div>
          )}

          {step !== 0 && (
            <div className="mt-8 border-t border-slate-800 pt-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={goBack} disabled={step === 0 || wizardActionActive || submitting} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>

                <div className="flex flex-col-reverse gap-3 sm:flex-row">
                  {/* Domain has its own skip control; the owner account is required. */}
                  {step < STEPS.length - 1 && step !== 1 && step !== 2 && !quickSetup && (
                    <button type="button" onClick={goNext} disabled={wizardActionActive} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200 transition hover:border-slate-600 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
                      Skip for now <ChevronRight className="h-4 w-4" />
                    </button>
                  )}

                  {quickSetup && step === 2 ? (
                    <button type="button" onClick={handleComplete} aria-busy={ownsWizardAction('complete')} disabled={wizardActionActive || submitting || !adminStepValid} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
                      {ownsWizardAction('complete') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} {ownsWizardAction('complete') ? 'Launching Portal…' : 'Launch Portal'}
                    </button>
                  ) : step < STEPS.length - 1 ? (
                    <button type="button" onClick={goNext} disabled={wizardActionActive || (step === 2 && !adminStepValid)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
                      {step === 1 && configuredDomainUrl && window.location.protocol === 'http:' ? 'Continue on secure portal' : 'Next'} <ChevronRight className="h-4 w-4" />
                    </button>
                  ) : (
                    <button type="button" onClick={handleComplete} aria-busy={ownsWizardAction('complete')} disabled={wizardActionActive || submitting || !adminStepValid} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60">
                      {ownsWizardAction('complete') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {ownsWizardAction('complete') ? 'Completing Setup…' : 'Complete Setup'}
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
