import { useState, useEffect, useCallback, lazy, Suspense, useContext, useRef } from 'react';
import { copyTextToClipboard } from '../utils/clipboardCopy';
import { AnimatePresence, motion } from 'framer-motion';
import { Link, UNSAFE_NavigationContext, useNavigate } from 'react-router-dom';
import { ChevronDown, Mail, Settings as SettingsIcon, X, Copy, Check, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePublicSettings } from '../hooks/usePublicSettings';
import { apiFetch, fetchMailAccounts, type MailAccount } from '../components/mail/api';
import MailSidebar from '../components/mail/MailSidebar';
import EmailList from '../components/mail/EmailList';
import type {
  MailboxInfo,
  EmailSummary,
  ComposeState,
  MailMutationActivity,
  MailMutationChangeHandler,
} from '../components/mail/types';
import AnchoredPopover from '../components/AnchoredPopover';
import ViewportModal from '../components/ViewportModal';

const LazyEmailDetail = lazy(() => import('../components/mail/EmailDetail'));
const LazyComposeModal = lazy(() => import('../components/mail/ComposeModal'));

// ── Main Mail Page ────────────────────────────────────────────

const PAGE_SIZE = 50;
const ACTIVE_MAIL_ACCOUNT_STORAGE_KEY = 'mail-active-account';

type MailMutationOwner = 'list' | 'detail' | 'compose' | 'forwarding';
type OwnedMailMutation = Readonly<MailMutationActivity & { owner: MailMutationOwner }>;

function getCachedActiveMailAccount(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.sessionStorage.getItem(ACTIVE_MAIL_ACCOUNT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function MailWorkspace() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { navigator: routerNavigator } = useContext(UNSAFE_NavigationContext);
  const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([]);
  const [activeMailbox, setActiveMailbox] = useState<string>('inbox');
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeState, setComposeState] = useState<ComposeState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [mailboxError, setMailboxError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
  // Account management
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<string>(() => getCachedActiveMailAccount());
  const [noMailbox, setNoMailbox] = useState<boolean>(false);
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);
  const [accountsResolved, setAccountsResolved] = useState(false);
  const [activeMailMutation, setActiveMailMutation] = useState<OwnedMailMutation | null>(null);

  // Setup guide and forwarding modals
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [showForwardSettings, setShowForwardSettings] = useState(false);
  const [credentials, setCredentials] = useState<{
    username: string;
    email: string;
    password?: string;
    passwordRequired?: boolean;
    imap: { server: string; port: number; security: string };
    smtp: { server: string; port: number; security: string };
  } | null>(null);
  const [credentialLoading, setCredentialLoading] = useState(false);
  const [credentialLoadError, setCredentialLoadError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [portalPassword, setPortalPassword] = useState('');
  const [credentialRevealLoading, setCredentialRevealLoading] = useState(false);
  const [credentialRevealError, setCredentialRevealError] = useState('');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [forwardEmail, setForwardEmail] = useState('');
  const [forwardSettingsLoading, setForwardSettingsLoading] = useState(false);
  const [forwardLoadError, setForwardLoadError] = useState('');
  const [forwardLoading, setForwardLoading] = useState(false);
  const [forwardError, setForwardError] = useState('');
  const accountRequestSequence = useRef(0);
  const mailboxRequestSequence = useRef(0);
  const emailRequestSequence = useRef(0);
  const setupRequestSequence = useRef(0);
  const forwardRequestSequence = useRef(0);
  const credentialRevealInFlightRef = useRef(false);
  const forwardSaveInFlightRef = useRef(false);
  const accountMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mailSurfaceRef = useRef<HTMLDivElement>(null);
  const setupCloseButtonRef = useRef<HTMLButtonElement>(null);
  const forwardEmailInputRef = useRef<HTMLInputElement>(null);
  const mailMutationOwnersRef = useRef<Partial<Record<MailMutationOwner, OwnedMailMutation>>>({});
  const activeMailMutationRef = useRef<OwnedMailMutation | null>(null);
  const releaseNavigationLockRef = useRef<(() => void) | null>(null);
  const lockedBrowserHistoryIndexRef = useRef<number | null>(null);

  const releaseNavigationLock = useCallback(() => {
    releaseNavigationLockRef.current?.();
    releaseNavigationLockRef.current = null;
    lockedBrowserHistoryIndexRef.current = null;
  }, []);

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
    lockedBrowserHistoryIndexRef.current = typeof browserHistoryIndex === 'number'
      ? browserHistoryIndex
      : null;
    releaseNavigationLockRef.current = () => {
      // Do not overwrite a newer owner if another guard deliberately wrapped
      // the same navigator after Mail acquired it.
      if (routerNavigator.push === blockedPush) routerNavigator.push = originalPush;
      if (routerNavigator.replace === blockedReplace) routerNavigator.replace = originalReplace;
      if (routerNavigator.go === blockedGo) routerNavigator.go = originalGo;
    };
  }, [routerNavigator]);

  const updateMailMutationOwner = useCallback((
    owner: MailMutationOwner,
    activity: Readonly<MailMutationActivity> | null,
  ) => {
    if (activity) {
      mailMutationOwnersRef.current[owner] = Object.freeze({ ...activity, owner });
      // A menu opened before admission must not remain as a second interactive
      // surface while the child owns its request.
      setAccountDropdownOpen(false);
    } else {
      delete mailMutationOwnersRef.current[owner];
    }

    const owners = mailMutationOwnersRef.current;
    const next = owners.forwarding || owners.compose || owners.detail || owners.list || null;
    activeMailMutationRef.current = next;
    if (next) acquireNavigationLock();
    else releaseNavigationLock();
    setActiveMailMutation(next);
  }, [acquireNavigationLock, releaseNavigationLock]);

  const handleListMutationChange = useCallback<MailMutationChangeHandler>(
    (activity) => updateMailMutationOwner('list', activity),
    [updateMailMutationOwner],
  );
  const handleDetailMutationChange = useCallback<MailMutationChangeHandler>(
    (activity) => updateMailMutationOwner('detail', activity),
    [updateMailMutationOwner],
  );
  const handleComposeMutationChange = useCallback<MailMutationChangeHandler>(
    (activity) => updateMailMutationOwner('compose', activity),
    [updateMailMutationOwner],
  );

  useEffect(() => {
    if (activeMailMutationRef.current) return undefined;
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [activeMailMutation, searchQuery]);

  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (!activeMailMutationRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const isHiddenInteractionOwner = (element: HTMLElement) => {
      let current: HTMLElement | null = element;
      while (current) {
        if (
          current.hidden
          || current.inert
          || current.hasAttribute('inert')
          || current.getAttribute('aria-hidden') === 'true'
          || current.getAttribute('data-viewport-transient-suppressed') === 'true'
        ) return true;
        current = current.parentElement;
      }
      return false;
    };
    const isOwnedMailInteraction = (event: Event) => {
      const path = typeof event.composedPath === 'function'
        ? event.composedPath()
        : event.target ? [event.target] : [];
      const mailSurface = mailSurfaceRef.current;
      if (mailSurface && path.some((target) => target instanceof Node && mailSurface.contains(target))) {
        return true;
      }
      return path.some((target) => (
        target instanceof HTMLElement
        && (
          target.matches('[data-viewport-modal-layer="true"]')
          || target.matches('[data-viewport-transient-overlay="true"]')
        )
        && !isHiddenInteractionOwner(target)
      ));
    };
    const containExternalInteraction = (event: Event) => {
      if (!activeMailMutationRef.current) return;
      if (isOwnedMailInteraction(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const preventHistoryTraversal = (event: PopStateEvent) => {
      if (!activeMailMutationRef.current) return;
      const lockedIndex = lockedBrowserHistoryIndexRef.current;
      const nextIndex = window.history.state?.idx;
      if (lockedIndex === null || typeof nextIndex !== 'number') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const distanceToOwner = lockedIndex - nextIndex;
      if (distanceToOwner !== 0) window.history.go(distanceToOwner);
    };

    window.addEventListener('beforeunload', preventUnload);
    window.addEventListener('popstate', preventHistoryTraversal, true);
    document.addEventListener('pointerdown', containExternalInteraction, true);
    document.addEventListener('click', containExternalInteraction, true);
    return () => {
      window.removeEventListener('beforeunload', preventUnload);
      window.removeEventListener('popstate', preventHistoryTraversal, true);
      document.removeEventListener('pointerdown', containExternalInteraction, true);
      document.removeEventListener('click', containExternalInteraction, true);
    };
  }, []);

  useEffect(() => releaseNavigationLock, [releaseNavigationLock]);

  useEffect(() => {
    mailboxRequestSequence.current += 1;
    emailRequestSequence.current += 1;
  }, [activeAccount]);

  const loadAccounts = useCallback(async () => {
    const requestSequence = ++accountRequestSequence.current;
    setAccountsResolved(false);
    setMailboxError('');
    try {
      const { accounts: accts, hasMailbox: has } = await fetchMailAccounts();
      if (requestSequence !== accountRequestSequence.current) return;
      setAccounts(accts);
      const primaryPersonal = accts.find(a => a.isPrimary);
      const nextAccount = primaryPersonal?.id
        || (!has && accts.find(a => a.id === 'support')?.id)
        || accts[0]?.id
        || '';

      setActiveAccount(prev => {
        if (prev && accts.some(a => a.id === prev)) return prev;
        return nextAccount;
      });
      setAccountsResolved(true);
    } catch (err: any) {
      if (requestSequence !== accountRequestSequence.current) return;
      setMailboxError(err?.message || 'Failed to discover mail accounts');
    }
  }, []);

  // Verify account visibility before loading any mailbox state.
  useEffect(() => {
    void loadAccounts();
    return () => { accountRequestSequence.current += 1; };
  }, [loadAccounts]);

  useEffect(() => {
    return () => {
      mailboxRequestSequence.current += 1;
      emailRequestSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (activeAccount) window.sessionStorage.setItem(ACTIVE_MAIL_ACCOUNT_STORAGE_KEY, activeAccount);
      else window.sessionStorage.removeItem(ACTIVE_MAIL_ACCOUNT_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }, [activeAccount]);

  // Load mailboxes
  const loadMailboxes = useCallback(async (): Promise<boolean> => {
    if (!accountsResolved) return false;
    const requestSequence = ++mailboxRequestSequence.current;
    try {
      const data = await apiFetch('/mailboxes', { account: activeAccount || undefined });
      if (requestSequence !== mailboxRequestSequence.current) return false;
      if (data.error === 'no_mailbox') {
        setNoMailbox(true);
        setMailboxes([]);
        setMailboxError('');
        return true;
      }
      setNoMailbox(false);
      setMailboxes(data.mailboxes || []);
      setMailboxError('');
      return true;
    } catch (err: any) {
      if (requestSequence !== mailboxRequestSequence.current) return false;
      const msg = err?.response?.data?.error || err?.message || 'Failed to connect to mail server';
      setMailboxError(msg);
      setMailboxes([]);
      return false;
    }
  }, [accountsResolved, activeAccount]);

  useEffect(() => {
    if (!accountsResolved) return;
    void loadMailboxes();
  }, [accountsResolved, activeAccount, loadMailboxes]);

  // Auto-refresh mailbox counts every 30s
  useEffect(() => {
    if (!accountsResolved) return;
    const refreshVisibleMailboxes = () => {
      if (document.visibilityState === 'visible' && !activeMailMutationRef.current) void loadMailboxes();
    };
    const timer = window.setInterval(refreshVisibleMailboxes, 30000);
    document.addEventListener('visibilitychange', refreshVisibleMailboxes);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisibleMailboxes);
    };
  }, [accountsResolved, activeAccount, loadMailboxes]);

  // Load emails
  const loadEmails = useCallback(async (role?: string, pageNum?: number): Promise<boolean> => {
    if (!accountsResolved) return false;
    const requestSequence = ++emailRequestSequence.current;
    setLoading(true);
    setEmailError('');
    try {
      const position = (pageNum ?? page) * PAGE_SIZE;
      const query = new URLSearchParams({
        mailboxRole: role || activeMailbox,
        limit: String(PAGE_SIZE),
        position: String(position),
      });
      if (debouncedSearchQuery) query.set('query', debouncedSearchQuery);
      const data = await apiFetch(`/messages?${query.toString()}`, { account: activeAccount || undefined });
      if (requestSequence !== emailRequestSequence.current) return false;
      if (data.error === 'no_mailbox') {
        setNoMailbox(true);
        setEmails([]);
        setTotal(0);
      } else {
        setNoMailbox(false);
        setEmails(data.emails || []);
        setTotal(data.total || 0);
      }
      return true;
    } catch (err: any) {
      if (requestSequence !== emailRequestSequence.current) return false;
      setEmailError(err?.message || 'Failed to load emails');
      setEmails([]);
      return false;
    } finally {
      if (requestSequence === emailRequestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [accountsResolved, activeMailbox, page, activeAccount, debouncedSearchQuery]);

  useEffect(() => {
    if (!accountsResolved) return;
    void loadEmails();
  }, [accountsResolved, activeAccount, activeMailbox, page, loadEmails]);

  const handleRefresh = useCallback(async (): Promise<boolean> => {
    setRefreshing(true);
    const [emailsReady, mailboxesReady] = await Promise.all([
      loadEmails(),
      loadMailboxes(),
    ]);
    return emailsReady && mailboxesReady;
  }, [loadEmails, loadMailboxes]);

  const handleSelectMailbox = (role: string) => {
    if (activeMailMutationRef.current) return;
    setActiveMailbox(role);
    setSelectedId(null);
    setPage(0);
  };

  const handlePageChange = (newPage: number) => {
    if (activeMailMutationRef.current) return;
    setPage(newPage);
  };

  const handleSwitchAccount = (accountId: string) => {
    if (activeMailMutationRef.current) return;
    mailboxRequestSequence.current += 1;
    emailRequestSequence.current += 1;
    setActiveAccount(accountId);
    setAccountDropdownOpen(false);
    setSelectedId(null);
    setPage(0);
    setActiveMailbox('inbox');
    setSearchQuery('');
    setDebouncedSearchQuery('');
  };

  const handleSearchChange = (query: string) => {
    if (activeMailMutationRef.current) return;
    setSearchQuery(query);
    setPage(0);
    setSelectedId(null);
  };

  // Setup guide handlers
  const handleOpenSetupGuide = async () => {
    if (activeMailMutationRef.current) return;
    const requestSequence = ++setupRequestSequence.current;
    setShowSetupGuide(true);
    setCredentials(null);
    setCredentialLoading(true);
    setCredentialLoadError('');
    setShowPassword(false);
    setPortalPassword('');
    setCredentialRevealError('');
    try {
      const data = await apiFetch('/credentials', { account: activeAccount });
      if (requestSequence !== setupRequestSequence.current) return;
      setCredentials(data);
    } catch (error: any) {
      if (requestSequence !== setupRequestSequence.current) return;
      setCredentials(null);
      setCredentialLoadError(error?.message || 'Could not load mail connection settings');
    } finally {
      if (requestSequence === setupRequestSequence.current) setCredentialLoading(false);
    }
  };

  const handleRevealMailPassword = async () => {
    if (!portalPassword || credentialRevealInFlightRef.current) return;
    credentialRevealInFlightRef.current = true;
    setCredentialRevealLoading(true);
    setCredentialRevealError('');
    try {
      const data = await apiFetch('/credentials/reveal', {
        account: activeAccount,
        method: 'POST',
        body: JSON.stringify({ currentPassword: portalPassword }),
      });
      setCredentials(data);
      setPortalPassword('');
      setShowPassword(true);
    } catch (error: any) {
      setCredentialRevealError(error?.message || 'Could not verify your Portal password');
    } finally {
      credentialRevealInFlightRef.current = false;
      setCredentialRevealLoading(false);
    }
  };

  const closeSetupGuide = () => {
    if (credentialRevealInFlightRef.current) return;
    setupRequestSequence.current += 1;
    setShowSetupGuide(false);
    setCredentials(null);
    setCredentialLoading(false);
    setCredentialLoadError('');
    setPortalPassword('');
    setCredentialRevealError('');
    setShowPassword(false);
  };

  const copyToClipboard = async (text: string, field: string) => {
    // Only show the copied affordance when the write actually succeeded.
    if (!(await copyTextToClipboard(text))) return;
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Forward settings handlers
  const handleOpenForwardSettings = async () => {
    if (activeMailMutationRef.current) return;
    const requestSequence = ++forwardRequestSequence.current;
    setShowForwardSettings(true);
    setForwardError('');
    setForwardLoadError('');
    setForwardSettingsLoading(true);
    setForwardEmail('');
    try {
      const data = await apiFetch('/forward-settings', { account: activeAccount });
      if (requestSequence !== forwardRequestSequence.current) return;
      setForwardEmail(data.autoForwardTo || '');
    } catch (error: any) {
      if (requestSequence !== forwardRequestSequence.current) return;
      setForwardEmail('');
      setForwardLoadError(error?.message || 'Could not load forwarding settings');
    } finally {
      if (requestSequence === forwardRequestSequence.current) setForwardSettingsLoading(false);
    }
  };

  const handleSaveForwardSettings = async () => {
    if (forwardSaveInFlightRef.current || activeMailMutationRef.current) return;
    const snapshot = Object.freeze({
      account: activeAccount,
      forwardingAddress: forwardEmail.trim(),
    });
    forwardSaveInFlightRef.current = true;
    updateMailMutationOwner('forwarding', Object.freeze({
      kind: 'forwarding-settings',
      label: 'Saving email forwarding settings',
      account: snapshot.account,
    }));
    setForwardLoading(true);
    setForwardError('');
    try {
      await apiFetch('/forward-settings', {
        method: 'PUT',
        body: JSON.stringify({ autoForwardTo: snapshot.forwardingAddress || null }),
        account: snapshot.account,
      });
      setShowForwardSettings(false);
    } catch (err: any) {
      setForwardError(err.message || 'Failed to save');
    } finally {
      forwardSaveInFlightRef.current = false;
      updateMailMutationOwner('forwarding', null);
      setForwardLoading(false);
    }
  };

  const closeForwardSettings = () => {
    if (forwardSaveInFlightRef.current) return;
    forwardRequestSequence.current += 1;
    setShowForwardSettings(false);
    setForwardSettingsLoading(false);
    setForwardLoadError('');
  };

  const inboxUnread = mailboxes.find(m => m.role === 'inbox')?.unreadEmails || 0;
  const showDetail = selectedId !== null;
  const currentAccount = accounts.find(a => a.id === activeAccount);
  const isSharedActiveAccount = currentAccount?.kind === 'shared';
  const mailNavigationBlocked = activeMailMutation !== null;

  // ── No-mailbox state ──────────────────────────────────────
  if (mailboxError && mailboxes.length === 0 && !noMailbox) {
    return (
      <div className="h-full flex items-center justify-center bg-[#080B20]">
        <div className="text-center max-w-md px-6">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <Mail size={28} className="text-red-400" />
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">Mail server connection failed</h2>
          <p className="text-sm text-slate-400 mb-3">
            {mailboxError}
          </p>
          <p className="text-xs text-slate-500 mb-6">
            This usually means the mail server container isn't running, or the authentication credentials are out of sync. Try re-running email setup from Settings, or check that the Stalwart container is healthy.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => accountsResolved ? loadMailboxes() : void loadAccounts()}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 text-sm font-medium transition-colors"
            >
              Retry
            </button>
            <button
              onClick={() => navigate('/settings')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 border border-indigo-500/30 text-sm font-medium transition-colors"
            >
              <SettingsIcon size={16} /> Go to Settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (noMailbox && accounts.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#080B20]">
        <div className="text-center max-w-md px-6">
          <div className="w-16 h-16 rounded-full bg-white/[0.05] flex items-center justify-center mx-auto mb-4">
            <Mail size={28} className="text-slate-500" />
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">No inbox configured</h2>
          <p className="text-sm text-slate-400 mb-6">
            Your personal inbox has not been provisioned yet. If your username is already set, this should happen automatically after save or account approval.
          </p>
          <button
            onClick={() => navigate('/settings')}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 border border-indigo-500/30 text-sm font-medium transition-colors"
          >
            <SettingsIcon size={16} /> Go to Profile Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={mailSurfaceRef} data-mail-page-surface="true" className="h-full flex bg-[#080B20]">
      {/* Sidebar */}
      <MailSidebar
        mailboxes={mailboxes}
        activeMailbox={activeMailbox}
        onSelectMailbox={handleSelectMailbox}
        onCompose={() => {
          if (!activeMailMutationRef.current) setComposeState({ mode: 'new' });
        }}
        isOpen={sidebarOpen}
        onClose={() => { if (!activeMailMutationRef.current) setSidebarOpen(false); }}
        isMobile={isMobile}
        interactionBlocked={mailNavigationBlocked}
        onSetupGuide={isSharedActiveAccount ? undefined : handleOpenSetupGuide}
        onForwardSettings={isSharedActiveAccount ? undefined : handleOpenForwardSettings}
      >
        {/* Account switcher — rendered inside sidebar above folders */}
        {accounts.length > 1 && (
          <div className="px-3 pb-3 relative">
            <button
              ref={accountMenuButtonRef}
              type="button"
              onClick={() => {
                if (!activeMailMutationRef.current) setAccountDropdownOpen(!accountDropdownOpen);
              }}
              disabled={mailNavigationBlocked}
              aria-haspopup="menu"
              aria-expanded={accountDropdownOpen}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-sm disabled:cursor-wait disabled:opacity-50 transition-colors"
            >
              <div className="flex flex-col items-start min-w-0">
                <span className="text-white font-medium truncate">{currentAccount?.label || 'Personal'}</span>
                <span className="text-xs text-slate-500 truncate">{currentAccount?.email || ''}</span>
              </div>
              <ChevronDown size={14} className={`text-slate-400 shrink-0 transition-transform ${accountDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            <AnchoredPopover
              open={accountDropdownOpen}
              anchorRef={accountMenuButtonRef}
              onDismiss={() => { if (!activeMailMutationRef.current) setAccountDropdownOpen(false); }}
              width={216}
              align="start"
              gap={4}
              ariaLabel="Mail account menu"
              className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#0D1033] shadow-xl"
            >
                <div role="menu" aria-label="Mail account menu" className="overflow-hidden rounded-lg">
                  {accounts.map(acct => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={acct.id === activeAccount}
                      key={acct.id}
                      onClick={() => handleSwitchAccount(acct.id)}
                      disabled={mailNavigationBlocked}
                      className={`w-full flex flex-col items-start px-3 py-2.5 text-sm hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-50 transition-colors ${
                        acct.id === activeAccount ? 'bg-white/[0.04]' : ''
                      }`}
                    >
                      <span className="text-white font-medium">{acct.label}</span>
                      <span className="text-xs text-slate-500">{acct.email}</span>
                    </button>
                  ))}
                </div>
            </AnchoredPopover>
          </div>
        )}
      </MailSidebar>

      {/* Main content */}
      {isMobile ? (
        <div className="flex-1 flex flex-col min-h-0 relative">
          <div className={`flex-1 flex flex-col min-h-0 ${showDetail ? 'hidden' : ''}`}>
            <EmailList
              emails={emails}
              total={total}
              page={page}
              pageSize={PAGE_SIZE}
              loading={loading}
              refreshing={refreshing}
              error={emailError}
              searchQuery={searchQuery}
              activeMailbox={activeMailbox}
              inboxUnread={inboxUnread}
              mailboxes={mailboxes}
              isMobile={isMobile}
              onSelectEmail={(id) => { if (!activeMailMutationRef.current) setSelectedId(id); }}
              onRefresh={handleRefresh}
              onSearchChange={handleSearchChange}
              onPageChange={handlePageChange}
              onOpenSidebar={() => { if (!activeMailMutationRef.current) setSidebarOpen(true); }}
              onLoadMailboxes={loadMailboxes}
              onMutationChange={handleListMutationChange}
              account={activeAccount}
            />
          </div>

          <AnimatePresence>
            {showDetail && (
              <motion.div
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'spring', damping: 28, stiffness: 300 }}
                className="absolute inset-0 z-10 bg-[#080B20]"
              >
                <Suspense fallback={null}>
                  <LazyEmailDetail
                    emailId={selectedId!}
                    onBack={() => setSelectedId(null)}
                    onRefresh={handleRefresh}
                    mailboxes={mailboxes}
                    onCompose={setComposeState}
                    isMobile={isMobile}
                    onMutationChange={handleDetailMutationChange}
                    account={activeAccount}
                  />
                </Suspense>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <>
          {showDetail ? (
            <Suspense fallback={null}>
              <LazyEmailDetail
                emailId={selectedId!}
                onBack={() => setSelectedId(null)}
                onRefresh={handleRefresh}
                mailboxes={mailboxes}
                onCompose={setComposeState}
                isMobile={isMobile}
                onMutationChange={handleDetailMutationChange}
                account={activeAccount}
              />
            </Suspense>
          ) : (
            <EmailList
              emails={emails}
              total={total}
              page={page}
              pageSize={PAGE_SIZE}
              loading={loading}
              refreshing={refreshing}
              error={emailError}
              searchQuery={searchQuery}
              activeMailbox={activeMailbox}
              inboxUnread={inboxUnread}
              mailboxes={mailboxes}
              isMobile={isMobile}
              onSelectEmail={(id) => { if (!activeMailMutationRef.current) setSelectedId(id); }}
              onRefresh={handleRefresh}
              onSearchChange={handleSearchChange}
              onPageChange={handlePageChange}
              onOpenSidebar={() => { if (!activeMailMutationRef.current) setSidebarOpen(true); }}
              onLoadMailboxes={loadMailboxes}
              onMutationChange={handleListMutationChange}
              account={activeAccount}
            />
          )}
        </>
      )}

      {/* Compose Modal */}
      <AnimatePresence>
        {composeState && (
          <Suspense fallback={null}>
            <LazyComposeModal
              onClose={() => setComposeState(null)}
              onSent={handleRefresh}
              composeState={composeState}
              mailboxes={mailboxes}
              isMobile={isMobile}
              account={activeAccount}
              accountEmail={currentAccount?.email}
              onMutationChange={handleComposeMutationChange}
            />
          </Suspense>
        )}
      </AnimatePresence>

      {/* IMAP Setup Guide Modal */}
      <ViewportModal
        open={showSetupGuide}
        onDismiss={closeSetupGuide}
        dismissible={!credentialRevealLoading}
        initialFocusRef={setupCloseButtonRef}
        className="bg-black/60 p-4 backdrop-blur-sm"
      >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0D1130] shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="mail-setup-guide-title"
            >
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <h3 id="mail-setup-guide-title" className="text-sm font-semibold text-white">📱 Connect Your Phone</h3>
                <button ref={setupCloseButtonRef} type="button" aria-label="Close mail setup guide" onClick={closeSetupGuide} disabled={credentialRevealLoading} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:opacity-50 transition-colors">
                  <X size={16} />
                </button>
              </div>
              <div className="p-5 overflow-y-auto space-y-4">
                <p className="text-sm text-slate-400">Your portal email works with any mail app that supports IMAP.</p>
                
                {credentials ? (
                  <>
                    <div className="space-y-3">
                      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">📧 Account Settings</h4>
                      <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-400">Email:</span>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-white font-mono">{credentials.email}</span>
                            <button type="button" aria-label="Copy mail address" onClick={() => copyToClipboard(credentials.email, 'email')} className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white">
                              {copiedField === 'email' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                            </button>
                          </div>
                        </div>
                        {credentials.password ? (
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-slate-400">Password:</span>
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-white font-mono">{showPassword ? credentials.password : '••••••••'}</span>
                              <button type="button" aria-label={showPassword ? 'Hide mail password' : 'Show mail password'} onClick={() => setShowPassword(!showPassword)} className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white">
                                {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                              </button>
                              <button type="button" aria-label="Copy mail password" onClick={() => copyToClipboard(credentials.password || '', 'password')} className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white">
                                {copiedField === 'password' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2 border-t border-white/[0.06] pt-3">
                            <label htmlFor="mail-credential-portal-password" className="block text-xs text-slate-300">Confirm your Portal password to reveal the reusable mail password</label>
                            <div className="flex gap-2">
                              <input
                                id="mail-credential-portal-password"
                                type="password"
                                autoComplete="current-password"
                                value={portalPassword}
                                onChange={(event) => setPortalPassword(event.target.value)}
                                onKeyDown={(event) => { if (event.key === 'Enter') void handleRevealMailPassword(); }}
                                className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-violet-500"
                              />
                              <button
                                type="button"
                                onClick={() => void handleRevealMailPassword()}
                                disabled={!portalPassword || credentialRevealLoading}
                                aria-busy={credentialRevealLoading}
                                aria-label={credentialRevealLoading ? 'Revealing mail password' : 'Reveal mail password'}
                                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
                              >
                                {credentialRevealLoading ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
                                {credentialRevealLoading ? 'Revealing…' : 'Reveal'}
                              </button>
                            </div>
                            {credentialRevealError && <p className="text-xs text-red-300">{credentialRevealError}</p>}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">📥 Incoming (IMAP)</h4>
                        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-xs space-y-1">
                          <div className="flex justify-between"><span className="text-slate-400">Server:</span><span className="text-white font-mono">{credentials.imap.server}</span></div>
                          <div className="flex justify-between"><span className="text-slate-400">Port:</span><span className="text-white font-mono">{credentials.imap.port}</span></div>
                          <div className="flex justify-between"><span className="text-slate-400">Security:</span><span className="text-white font-mono">{credentials.imap.security}</span></div>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">📤 Outgoing (SMTP)</h4>
                        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-xs space-y-1">
                          <div className="flex justify-between"><span className="text-slate-400">Server:</span><span className="text-white font-mono">{credentials.smtp.server}</span></div>
                          <div className="flex justify-between"><span className="text-slate-400">Port:</span><span className="text-white font-mono">{credentials.smtp.port}</span></div>
                          <div className="flex justify-between"><span className="text-slate-400">Security:</span><span className="text-white font-mono">{credentials.smtp.security}</span></div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3 pt-2">
                      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Quick Setup Guides</h4>
                      <div className="text-xs text-slate-400 space-y-3">
                        <div>
                          <strong className="text-slate-300">iPhone:</strong> Settings → Mail → Accounts → Add Account → Other → Add Mail Account → Enter your portal email and password → Choose IMAP → Enter the server settings above
                        </div>
                        <div>
                          <strong className="text-slate-300">Android / Gmail:</strong> Gmail → Settings → Add Account → Other → Enter your portal email → Choose IMAP → Enter server settings above
                        </div>
                        <div>
                          <strong className="text-slate-300">Outlook:</strong> Add Account → Advanced Setup → IMAP → Enter the server settings above
                        </div>
                      </div>
                    </div>
                  </>
                ) : credentialLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="animate-spin text-slate-400" size={24} />
                  </div>
                ) : (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-center">
                    <p role="alert" className="mb-3 text-sm text-red-300">{credentialLoadError || 'Mail connection settings are unavailable.'}</p>
                    <button type="button" onClick={() => void handleOpenSetupGuide()} className="rounded-lg bg-white/[0.06] px-3 py-2 text-xs font-medium text-white hover:bg-white/[0.1]">
                      Retry
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
      </ViewportModal>

      {/* Auto-Forward Settings Modal */}
      <ViewportModal
        open={showForwardSettings}
        onDismiss={closeForwardSettings}
        dismissible={!forwardLoading}
        initialFocusRef={forwardEmailInputRef}
        className="bg-black/60 p-4 backdrop-blur-sm"
      >
            <motion.form
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0D1130] shadow-2xl"
              onSubmit={(event) => { event.preventDefault(); void handleSaveForwardSettings(); }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="mail-forwarding-title"
            >
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <h3 id="mail-forwarding-title" className="text-sm font-semibold text-white">Auto-Forward Emails</h3>
                <button type="button" aria-label="Close forwarding settings" onClick={closeForwardSettings} disabled={forwardLoading} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white disabled:opacity-50 transition-colors">
                  <X size={16} />
                </button>
              </div>
              {forwardSettingsLoading ? (
                <div className="flex min-h-32 items-center justify-center gap-2 px-5 py-6 text-sm text-slate-400" role="status">
                  <Loader2 size={16} className="animate-spin" /> Loading forwarding settings…
                </div>
              ) : forwardLoadError ? (
                <div className="space-y-3 px-5 py-5">
                  <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">{forwardLoadError}</p>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={closeForwardSettings} className="rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.08]">Cancel</button>
                    <button type="button" onClick={() => void handleOpenForwardSettings()} className="rounded-xl bg-violet-600 px-3 py-2 text-xs font-medium text-white hover:bg-violet-500">Retry</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="p-5 space-y-4">
                    <p className="text-sm text-slate-400">
                      Automatically forward incoming emails to your personal email address.
                    </p>
                    <div>
                      <label htmlFor="mail-forwarding-address" className="text-xs text-slate-400 block mb-1.5">Forward to email address</label>
                      <input
                        ref={forwardEmailInputRef}
                        id="mail-forwarding-address"
                        type="email"
                        value={forwardEmail}
                        onChange={(e) => setForwardEmail(e.target.value)}
                        disabled={forwardLoading}
                        placeholder="your.email@gmail.com"
                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/30 transition-colors"
                      />
                    </div>
                    {forwardError && (
                      <p role="alert" className="text-xs text-red-400">{forwardError}</p>
                    )}
                    <p className="text-xs text-slate-500">
                      Leave empty to disable auto-forwarding. Emails will still be delivered to your portal inbox.
                    </p>
                  </div>
                  <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
                    <button
                      type="button"
                      onClick={closeForwardSettings}
                      disabled={forwardLoading}
                      className="px-3 py-1.5 text-xs rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 disabled:opacity-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={forwardLoading}
                      aria-busy={forwardLoading}
                      aria-label={forwardLoading ? 'Saving forwarding settings' : 'Save forwarding settings'}
                      className="px-4 py-1.5 text-xs rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-medium disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                    >
                      {forwardLoading ? <Loader2 size={12} className="animate-spin" /> : null}
                      {forwardLoading ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}
            </motion.form>
      </ViewportModal>
    </div>
  );
}

/** How long the capability probe may spin before it owes the user an answer. */
const MAIL_CAPABILITY_WAIT_MS = 10_000;

export default function MailPage() {
  const publicSettings = usePublicSettings();
  const mailCapability = publicSettings?.mail;
  // this gate had no timeout and no failure branch, so public settings
  // that never arrive left the page spinning indefinitely with nothing to
  // click. Waiting is fine; waiting silently and forever is not.
  const [capabilityWaitElapsed, setCapabilityWaitElapsed] = useState(false);

  useEffect(() => {
    if (mailCapability) {
      setCapabilityWaitElapsed(false);
      return;
    }
    const timer = setTimeout(() => setCapabilityWaitElapsed(true), MAIL_CAPABILITY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [mailCapability]);

  if (!mailCapability) {
    if (capabilityWaitElapsed) {
      return (
        <div className="flex h-full items-center justify-center bg-[#080B20] px-6 text-center">
          <div role="alert" className="max-w-md rounded-2xl border border-amber-500/20 bg-amber-500/10 p-6">
            <h2 className="text-base font-semibold text-white">Mail availability could not be confirmed</h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              The Portal could not load its public settings, so it cannot tell whether Mail is
              configured on this server.
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="min-h-[44px] rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400"
              >
                Retry
              </button>
              <Link
                to="/settings"
                className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-500/40 bg-slate-900/40 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900/70"
              >
                Go to Settings
              </Link>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center bg-[#080B20] px-6">
        <div role="status" aria-live="polite" className="flex items-center gap-3 text-sm text-slate-400">
          <Loader2 size={18} className="animate-spin" />
          Checking mail availability…
        </div>
      </div>
    );
  }

  if (!mailCapability.available) {
    const isTailnet = publicSettings?.originMode === 'tailnet';
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto bg-[#080B20] px-5 py-8">
        <section className="w-full max-w-2xl overflow-hidden rounded-3xl border border-amber-400/20 bg-gradient-to-br from-amber-500/[0.1] via-[#0D1130] to-violet-500/[0.09] shadow-2xl shadow-black/30">
          <div className="border-b border-white/[0.07] px-6 py-4">
            <span className="inline-flex items-center rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200">
              {isTailnet ? 'Private Tailnet mode' : 'Mail unavailable'}
            </span>
          </div>
          <div className="px-6 py-8 sm:px-9 sm:py-10">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-400/20 bg-amber-400/10 text-amber-200">
              <Mail size={26} />
            </div>
            <h1 className="mt-6 text-2xl font-semibold tracking-tight text-white">
              Mail requires a public domain
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">
              {mailCapability.reason || 'Mail is unavailable for this Portal installation.'}
            </p>
            <p className="mt-4 max-w-xl text-sm leading-6 text-slate-500">
              Your Portal and AI tools remain available. Mailboxes, message polling, and mail setup stay off until the installation has a public domain that can receive DNS and TLS records.
            </p>
            <Link
              to="/settings?tab=general"
              className="mt-7 inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-violet-400/25 bg-violet-500/20 px-4 py-2.5 text-sm font-semibold text-violet-100 transition hover:bg-violet-500/30 focus:outline-none focus:ring-2 focus:ring-violet-400/60"
            >
              <SettingsIcon size={17} /> Review domain settings
            </Link>
          </div>
        </section>
      </div>
    );
  }

  return <MailWorkspace />;
}
