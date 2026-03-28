import { useState, useEffect, useCallback, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Mail, Settings as SettingsIcon, X, Copy, Check, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { apiFetch, fetchMailAccounts, type MailAccount } from '../components/mail/api';
import MailSidebar from '../components/mail/MailSidebar';
import EmailList from '../components/mail/EmailList';
import EmailDetail from '../components/mail/EmailDetail';
import ComposeModal from '../components/mail/ComposeModal';
import type { MailboxInfo, EmailSummary, ComposeState } from '../components/mail/types';

// ── Main Mail Page ────────────────────────────────────────────

const PAGE_SIZE = 50;

export default function MailPage() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([]);
  const [activeMailbox, setActiveMailbox] = useState<string>('inbox');
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeState, setComposeState] = useState<ComposeState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  
  // Account management
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<string>('');
  const [hasMailbox, setHasMailbox] = useState<boolean>(true);
  const [noMailbox, setNoMailbox] = useState<boolean>(false);
  const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);

  // Setup guide and forwarding modals
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [showForwardSettings, setShowForwardSettings] = useState(false);
  const [credentials, setCredentials] = useState<{
    username: string;
    email: string;
    password: string;
    imap: { server: string; port: number; security: string };
    smtp: { server: string; port: number; security: string };
  } | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [forwardEmail, setForwardEmail] = useState('');
  const [forwardLoading, setForwardLoading] = useState(false);
  const [forwardError, setForwardError] = useState('');

  // Load accounts
  useEffect(() => {
    fetchMailAccounts().then(({ accounts: accts, hasMailbox: has }) => {
      setAccounts(accts);
      setHasMailbox(has);

      const primaryPersonal = accts.find(a => a.isPrimary);
      const currentStillExists = accts.some(a => a.id === activeAccount);

      if (!currentStillExists) {
        if (primaryPersonal) {
          setActiveAccount(primaryPersonal.id);
        } else if (!has && accts.length > 0) {
          const supportAcct = accts.find(a => a.id === 'support');
          if (supportAcct) setActiveAccount('support');
        } else if (accts[0]) {
          setActiveAccount(accts[0].id);
        }
      }
    }).catch(() => {});
  }, [activeAccount]);

  // Load mailboxes
  const loadMailboxes = useCallback(() => {
    apiFetch('/mailboxes', { account: activeAccount })
      .then((data) => {
        if (data.error === 'no_mailbox') {
          setNoMailbox(true);
          setMailboxes([]);
          setError('');
          return;
        }
        setNoMailbox(false);
        setMailboxes(data.mailboxes || []);
        setError('');
      })
      .catch((err: any) => {
        const msg = err?.response?.data?.error || err?.message || 'Failed to connect to mail server';
        setError(msg);
        setMailboxes([]);
      });
  }, [activeAccount]);

  useEffect(() => { loadMailboxes(); }, [loadMailboxes]);

  // Auto-refresh mailbox counts every 30s
  useEffect(() => {
    const timer = setInterval(loadMailboxes, 30000);
    return () => clearInterval(timer);
  }, [loadMailboxes]);

  // Load emails
  const loadEmails = useCallback(async (role?: string, pageNum?: number) => {
    setLoading(true);
    setError('');
    try {
      const position = (pageNum ?? page) * PAGE_SIZE;
      const data = await apiFetch(`/messages?mailboxRole=${role || activeMailbox}&limit=${PAGE_SIZE}&position=${position}`, { account: activeAccount });
      if (data.error === 'no_mailbox') {
        setNoMailbox(true);
        setEmails([]);
        setTotal(0);
      } else {
        setNoMailbox(false);
        setEmails(data.emails || []);
        setTotal(data.total || 0);
      }
    } catch (err: any) {
      setError(err.message);
      setEmails([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeMailbox, page, activeAccount]);

  useEffect(() => { loadEmails(); }, [activeMailbox, page, loadEmails]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadEmails();
    loadMailboxes();
  };

  const handleSelectMailbox = (role: string) => {
    setActiveMailbox(role);
    setSelectedId(null);
    setPage(0);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handleSwitchAccount = (accountId: string) => {
    setActiveAccount(accountId);
    setAccountDropdownOpen(false);
    setSelectedId(null);
    setPage(0);
    setActiveMailbox('inbox');
  };

  // Setup guide handlers
  const handleOpenSetupGuide = async () => {
    setShowSetupGuide(true);
    try {
      const data = await apiFetch('/credentials', { account: activeAccount });
      setCredentials(data);
    } catch {
      setCredentials(null);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Forward settings handlers
  const handleOpenForwardSettings = async () => {
    setShowForwardSettings(true);
    setForwardError('');
    try {
      const data = await apiFetch('/forward-settings', { account: activeAccount });
      setForwardEmail(data.autoForwardTo || '');
    } catch {
      setForwardEmail('');
    }
  };

  const handleSaveForwardSettings = async () => {
    setForwardLoading(true);
    setForwardError('');
    try {
      await apiFetch('/forward-settings', {
        method: 'PUT',
        body: JSON.stringify({ autoForwardTo: forwardEmail.trim() || null }),
        account: activeAccount,
      });
      setShowForwardSettings(false);
    } catch (err: any) {
      setForwardError(err.message || 'Failed to save');
    } finally {
      setForwardLoading(false);
    }
  };

  const inboxUnread = mailboxes.find(m => m.role === 'inbox')?.unreadEmails || 0;
  const showDetail = selectedId !== null;
  const currentAccount = accounts.find(a => a.id === activeAccount);

  // ── No-mailbox state ──────────────────────────────────────
    if (error && mailboxes.length === 0 && !noMailbox) {
    return (
      <div className="h-full flex items-center justify-center bg-[#080B20]">
        <div className="text-center max-w-md px-6">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <Mail size={28} className="text-red-400" />
          </div>
          <h2 className="text-lg font-semibold text-white mb-2">Mail server connection failed</h2>
          <p className="text-sm text-slate-400 mb-3">
            {error}
          </p>
          <p className="text-xs text-slate-500 mb-6">
            This usually means the mail server container isn't running, or the authentication credentials are out of sync. Try re-running email setup from Settings, or check that the Stalwart container is healthy.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => loadMailboxes()}
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
    <div className="h-full flex bg-[#080B20]">
      {/* Sidebar */}
      <MailSidebar
        mailboxes={mailboxes}
        activeMailbox={activeMailbox}
        onSelectMailbox={handleSelectMailbox}
        onCompose={() => setComposeState({ mode: 'new' })}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        isMobile={isMobile}
        onSetupGuide={handleOpenSetupGuide}
        onForwardSettings={handleOpenForwardSettings}
      >
        {/* Account switcher — rendered inside sidebar above folders */}
        {accounts.length > 1 && (
          <div className="px-3 pb-3 relative">
            <button
              onClick={() => setAccountDropdownOpen(!accountDropdownOpen)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-sm transition-colors"
            >
              <div className="flex flex-col items-start min-w-0">
                <span className="text-white font-medium truncate">{currentAccount?.label || 'Personal'}</span>
                <span className="text-xs text-slate-500 truncate">{currentAccount?.email || ''}</span>
              </div>
              <ChevronDown size={14} className={`text-slate-400 shrink-0 transition-transform ${accountDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {accountDropdownOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setAccountDropdownOpen(false)} />
                <div className="absolute left-3 right-3 mt-1 z-20 bg-[#0D1033] border border-white/[0.08] rounded-lg shadow-xl overflow-hidden">
                  {accounts.map(acct => (
                    <button
                      key={acct.id}
                      onClick={() => handleSwitchAccount(acct.id)}
                      className={`w-full flex flex-col items-start px-3 py-2.5 text-sm hover:bg-white/[0.06] transition-colors ${
                        acct.id === activeAccount ? 'bg-white/[0.04]' : ''
                      }`}
                    >
                      <span className="text-white font-medium">{acct.label}</span>
                      <span className="text-xs text-slate-500">{acct.email}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
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
              error={error}
              searchQuery={searchQuery}
              activeMailbox={activeMailbox}
              inboxUnread={inboxUnread}
              mailboxes={mailboxes}
              isMobile={isMobile}
              onSelectEmail={(id) => setSelectedId(id)}
              onRefresh={handleRefresh}
              onSearchChange={setSearchQuery}
              onPageChange={handlePageChange}
              onOpenSidebar={() => setSidebarOpen(true)}
              onLoadMailboxes={loadMailboxes}
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
                <EmailDetail
                  emailId={selectedId!}
                  onBack={() => setSelectedId(null)}
                  onRefresh={handleRefresh}
                  mailboxes={mailboxes}
                  onCompose={setComposeState}
                  isMobile={isMobile}
                  account={activeAccount}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <>
          {showDetail ? (
            <EmailDetail
              emailId={selectedId!}
              onBack={() => setSelectedId(null)}
              onRefresh={handleRefresh}
              mailboxes={mailboxes}
              onCompose={setComposeState}
              isMobile={isMobile}
              account={activeAccount}
            />
          ) : (
            <EmailList
              emails={emails}
              total={total}
              page={page}
              pageSize={PAGE_SIZE}
              loading={loading}
              refreshing={refreshing}
              error={error}
              searchQuery={searchQuery}
              activeMailbox={activeMailbox}
              inboxUnread={inboxUnread}
              mailboxes={mailboxes}
              isMobile={isMobile}
              onSelectEmail={(id) => setSelectedId(id)}
              onRefresh={handleRefresh}
              onSearchChange={setSearchQuery}
              onPageChange={handlePageChange}
              onOpenSidebar={() => setSidebarOpen(true)}
              onLoadMailboxes={loadMailboxes}
              account={activeAccount}
            />
          )}
        </>
      )}

      {/* Compose Modal */}
      <AnimatePresence>
        {composeState && (
          <ComposeModal
            onClose={() => setComposeState(null)}
            onSent={handleRefresh}
            composeState={composeState}
            mailboxes={mailboxes}
            isMobile={isMobile}
            account={activeAccount}
          />
        )}
      </AnimatePresence>

      {/* IMAP Setup Guide Modal */}
      <AnimatePresence>
        {showSetupGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-[#0D1130] border border-white/[0.08] rounded-2xl w-full max-w-lg mx-4 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
            >
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <h3 className="text-sm font-semibold text-white">📱 Connect Your Phone</h3>
                <button onClick={() => setShowSetupGuide(false)} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors">
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
                            <button onClick={() => copyToClipboard(credentials.email, 'email')} className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white">
                              {copiedField === 'email' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-400">Password:</span>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-white font-mono">{showPassword ? credentials.password : '••••••••'}</span>
                            <button onClick={() => setShowPassword(!showPassword)} className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white">
                              {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                            </button>
                            <button onClick={() => copyToClipboard(credentials.password, 'password')} className="p-1 rounded hover:bg-white/[0.06] text-slate-400 hover:text-white">
                              {copiedField === 'password' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                            </button>
                          </div>
                        </div>
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
                ) : (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="animate-spin text-slate-400" size={24} />
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Auto-Forward Settings Modal */}
      <AnimatePresence>
        {showForwardSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-[#0D1130] border border-white/[0.08] rounded-2xl w-full max-w-md mx-4 shadow-2xl overflow-hidden"
            >
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
                <h3 className="text-sm font-semibold text-white">Auto-Forward Emails</h3>
                <button onClick={() => setShowForwardSettings(false)} className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-400 hover:text-white transition-colors">
                  <X size={16} />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <p className="text-sm text-slate-400">
                  Automatically forward incoming emails to your personal email address.
                </p>
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">Forward to email address</label>
                  <input
                    type="email"
                    value={forwardEmail}
                    onChange={(e) => setForwardEmail(e.target.value)}
                    placeholder="your.email@gmail.com"
                    className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-violet-500/50 focus:border-violet-500/30 transition-colors"
                  />
                </div>
                {forwardError && (
                  <p className="text-xs text-red-400">{forwardError}</p>
                )}
                <p className="text-xs text-slate-500">
                  Leave empty to disable auto-forwarding. Emails will still be delivered to your portal inbox.
                </p>
              </div>
              <div className="flex justify-end gap-2 px-5 py-3 border-t border-white/[0.06]">
                <button
                  onClick={() => setShowForwardSettings(false)}
                  className="px-3 py-1.5 text-xs rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-slate-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveForwardSettings}
                  disabled={forwardLoading}
                  className="px-4 py-1.5 text-xs rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-medium disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {forwardLoading ? <Loader2 size={12} className="animate-spin" /> : null}
                  Save
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
