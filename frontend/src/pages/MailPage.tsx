import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Mail, Settings as SettingsIcon } from 'lucide-react';
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
          return;
        }
        setNoMailbox(false);
        setMailboxes(data.mailboxes || []);
      })
      .catch(() => {});
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

  const inboxUnread = mailboxes.find(m => m.role === 'inbox')?.unreadEmails || 0;
  const showDetail = selectedId !== null;
  const currentAccount = accounts.find(a => a.id === activeAccount);

  // ── No-mailbox state ──────────────────────────────────────
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
    </div>
  );
}
