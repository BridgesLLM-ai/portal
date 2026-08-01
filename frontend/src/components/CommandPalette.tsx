import { useState, useEffect, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Search, Command, File, Folder, Terminal, Layout, Settings, X, Shield, Mail, MessageCircle, Wrench, Loader2, AlertCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../contexts/AuthContext';
import { canUseInteractivePortal, isElevated } from '../utils/authz';
import { filesAPI, projectsAPI } from '../api/endpoints';
import { buildProjectDeepLink } from '../utils/projectSurface';
import { buildFileDeepLink } from '../utils/workspaceNavigation';
import ViewportModal from './ViewportModal';
import { isRouteOperationOwned } from '../contexts/RouteOperationContext';
import { usePublicSettings } from '../hooks/usePublicSettings';
import {
  WORKSPACE_AUTHORIZATION_CHANGED_EVENT,
  type WorkspaceAuthorizationChangeDetail,
} from '../utils/workspaceAuthorization';

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  action: () => void;
  category: 'navigation' | 'project' | 'project file' | 'library file' | 'action' | 'recent';
  keywords?: string[];
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Encode a structured result identity into an HTML/ARIA-safe, injective ID. */
export function dynamicCommandId(kind: string, ...parts: string[]): string {
  const structured = JSON.stringify([kind, ...parts]);
  let encoded = '';
  for (let index = 0; index < structured.length; index += 1) {
    encoded += structured.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `dynamic-${encoded}`;
}

export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filteredCommands, setFilteredCommands] = useState<CommandItem[]>([]);
  const [dynamicItems, setDynamicItems] = useState<CommandItem[]>([]);
  const [searchStatus, setSearchStatus] = useState<null | {
    kind: 'loading' | 'error' | 'notice';
    message: string;
  }>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchEpochRef = useRef(0);
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const publicSettings = usePublicSettings();
  const mailAvailability = publicSettings?.mail;
  const workspaceNavigationBinding = useMemo(() => {
    const authorizationVersion = Number(user?.authorizationVersion ?? 1);
    if (!user?.id || !Number.isSafeInteger(authorizationVersion) || authorizationVersion < 1) return null;
    return { actorUserId: user.id, authorizationVersion };
  }, [user?.authorizationVersion, user?.id]);

  useEffect(() => {
    const quarantine = (raw: Event) => {
      const event = raw as CustomEvent<WorkspaceAuthorizationChangeDetail>;
      if (event.detail?.userId !== user?.id) return;
      searchEpochRef.current += 1;
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      setDynamicItems([]);
      setFilteredCommands([]);
      setSearchStatus(null);
      setQuery('');
      onClose();
    };
    window.addEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, quarantine);
    return () => window.removeEventListener(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, quarantine);
  }, [onClose, user?.id]);

  const commands = useMemo<CommandItem[]>(() => [
    {
      id: 'nav-dashboard',
      label: 'Go to Dashboard',
      icon: <Layout size={16} />,
      action: () => navigate('/dashboard'),
      category: 'navigation' as const,
      keywords: ['home', 'overview', 'main'],
    },
    ...(canUseInteractivePortal(user) ? [{
      id: 'nav-projects',
      label: 'Go to Projects',
      icon: <Folder size={16} />,
      action: () => navigate('/projects'),
      category: 'navigation' as const,
      keywords: ['code', 'repos', 'deploy', 'share', 'hosted', 'apps'],
    }, {
      id: 'nav-files',
      label: 'Go to Files',
      icon: <File size={16} />,
      action: () => navigate('/files'),
      category: 'navigation' as const,
      keywords: ['browse', 'explorer'],
    }, {
      id: 'nav-mail',
      label: mailAvailability?.available === true
        ? 'Go to Mail'
        : mailAvailability?.available === false
          ? 'Mail unavailable — view details'
          : 'Mail availability pending — view details',
      description: mailAvailability?.available === false
        ? mailAvailability.reason || 'Mail requires a public domain.'
        : mailAvailability?.available === true
          ? undefined
          : 'Open Mail to view its current availability.',
      icon: <Mail size={16} />,
      action: () => navigate('/mail'),
      category: 'navigation' as const,
      keywords: ['email', 'inbox', 'messages', 'unavailable', 'availability'],
    }] : []),
    ...(isElevated(user)
      ? [{
          id: 'nav-agent-chats',
          label: 'Go to Agent Chats',
          icon: <MessageCircle size={16} />,
          action: () => navigate('/agent-chats'),
          category: 'navigation' as const,
          keywords: ['chat', 'agents', 'openclaw'],
        },
        {
          id: 'nav-agent-tools',
          label: 'Go to Agent Tools',
          icon: <Wrench size={16} />,
          action: () => navigate('/agent-tools'),
          category: 'navigation' as const,
          keywords: ['automations', 'skills', 'tasks', 'usage'],
        },
        {
          id: 'nav-terminal',
          label: 'Go to Terminal',
          icon: <Terminal size={16} />,
          action: () => navigate('/terminal'),
          category: 'navigation' as const,
          keywords: ['shell', 'console', 'command'],
        },
        {
          id: 'nav-admin-maintenance',
          label: 'Go to Admin Maintenance',
          icon: <Shield size={16} />,
          action: () => navigate('/admin?tab=maintenance'),
          category: 'navigation' as const,
          keywords: ['admin', 'maintenance', 'security', 'updates', 'drift'],
        }]
      : []),
    {
      id: 'nav-settings',
      label: 'Go to Settings',
      icon: <Settings size={16} />,
      action: () => navigate('/settings'),
      category: 'navigation' as const,
      keywords: ['config', 'preferences'],
    },
  ], [mailAvailability, navigate, user]);

  // Search both actor-scoped Portal workspaces. Project traversal is performed
  // by one bounded backend operation; Ctrl+K must not recursively fan out into
  // one browser request per project/directory.
  useEffect(() => {
    if (!isOpen || !canUseInteractivePortal(user)) {
      setDynamicItems([]);
      setSearchStatus(null);
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setDynamicItems([]);
      setSearchStatus(null);
      return;
    }
    let cancelled = false;
    const abortController = new AbortController();
    const searchEpoch = ++searchEpochRef.current;
    searchAbortRef.current?.abort();
    searchAbortRef.current = abortController;
    setDynamicItems([]);
    setSearchStatus({ kind: 'loading', message: 'Searching Files and Projects…' });
    const timer = window.setTimeout(async () => {
      const [projectOutcome, fileOutcome] = await Promise.allSettled([
        projectsAPI.search(trimmed, 20, abortController.signal),
        filesAPI.list({ page: 1, limit: 12, search: trimmed }, abortController.signal),
      ]);
      if (cancelled || searchEpoch !== searchEpochRef.current) return;

      const openProject = (name: string) => {
        navigate(workspaceNavigationBinding
          ? buildProjectDeepLink(name, workspaceNavigationBinding)
          : '/projects');
      };
      const items: CommandItem[] = [];

      if (projectOutcome.status === 'fulfilled') {
        for (const result of projectOutcome.value.results || []) {
          if (result.kind === 'project') {
            items.push({
              id: dynamicCommandId('project', result.project),
              label: result.name,
              description: 'Project • Open project',
              icon: <Folder size={16} />,
              action: () => openProject(result.project),
              category: 'project',
            });
            continue;
          }
          items.push({
            id: dynamicCommandId('project-file', result.project, result.path),
            label: result.name || result.path.split('/').pop() || result.path,
            description: `Project file • ${result.project}/${result.path}`,
            icon: <File size={16} />,
            action: () => {
              navigate(workspaceNavigationBinding
                ? buildProjectDeepLink(result.project, result.path, workspaceNavigationBinding)
                : '/projects');
            },
            category: 'project file',
          });
        }
      }

      let visibleLibraryFiles: any[] = [];
      let libraryTotal = 0;
      if (fileOutcome.status === 'fulfilled') {
        const payload = fileOutcome.value;
        visibleLibraryFiles = Array.isArray(payload) ? payload : Array.isArray(payload?.files) ? payload.files : [];
        libraryTotal = Array.isArray(payload) ? visibleLibraryFiles.length : Number(payload?.total || 0);
        for (const libraryFile of visibleLibraryFiles) {
          const fileId = String(libraryFile?.id || '');
          const filePath = String(libraryFile?.path || '');
          if (!fileId || !filePath) continue;
          const label = String(libraryFile?.originalName || filePath.split('/').pop() || filePath);
          items.push({
            id: dynamicCommandId('library-file', fileId),
            label,
            description: `Files library • ${label}`,
            icon: <File size={16} />,
            action: () => {
              navigate(workspaceNavigationBinding
                ? buildFileDeepLink(fileId, filePath, workspaceNavigationBinding)
                : '/files');
            },
            category: 'library file',
          });
        }
      }

      setDynamicItems(items);
      const projectFailed = projectOutcome.status === 'rejected';
      const filesFailed = fileOutcome.status === 'rejected';
      if (projectFailed && filesFailed) {
        setSearchStatus({ kind: 'error', message: 'Files and Project search are unavailable. Try again.' });
      } else if (projectFailed) {
        setSearchStatus({ kind: 'error', message: 'Project search is unavailable; showing Files results.' });
      } else if (filesFailed) {
        setSearchStatus({ kind: 'error', message: 'Files search is unavailable; showing Project results.' });
      } else if (projectOutcome.value.truncated || libraryTotal > visibleLibraryFiles.length) {
        setSearchStatus({ kind: 'notice', message: 'Search limit reached. Refine the query for a complete result set.' });
      } else {
        setSearchStatus(null);
      }
    }, 180);
    return () => {
      cancelled = true;
      abortController.abort();
      if (searchAbortRef.current === abortController) searchAbortRef.current = null;
      window.clearTimeout(timer);
    };
  }, [isOpen, query, user, navigate, workspaceNavigationBinding]);

  // Filter commands based on query
  useEffect(() => {
    if (!query.trim()) {
      setFilteredCommands(commands);
      setSelectedIndex(0);
      return;
    }

    const lowerQuery = query.toLowerCase();
    const filtered = commands.filter(cmd => {
      const labelMatch = cmd.label.toLowerCase().includes(lowerQuery);
      const descMatch = cmd.description?.toLowerCase().includes(lowerQuery);
      const keywordMatch = cmd.keywords?.some(kw => kw.includes(lowerQuery));
      return labelMatch || descMatch || keywordMatch;
    });

    setFilteredCommands([...dynamicItems, ...filtered]);
    setSelectedIndex(0);
  }, [commands, dynamicItems, query]);

  // Focus input when opened
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setSelectedIndex(0);
  }, [isOpen]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredCommands.length > 0) setSelectedIndex(prev => Math.min(filteredCommands.length - 1, prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(0, prev - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        executeCommand(filteredCommands[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const executeCommand = (cmd: CommandItem) => {
    if (isRouteOperationOwned()) return;
    cmd.action();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <ViewportModal
      open={isOpen}
      onDismiss={onClose}
      initialFocusRef={inputRef}
      className="items-start bg-black/60 px-4 pb-4 pt-[min(20vh,6rem)] backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: -20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="flex max-h-[calc(100dvh-7rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl backdrop-blur-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
          {/* Search input */}
          <div className="flex items-center gap-3 px-4 py-4 border-b border-white/5">
            <Search size={20} className="text-slate-400 flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command or search..."
              aria-label="Search commands"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="command-palette-results"
              aria-expanded="true"
              aria-describedby={searchStatus ? 'command-palette-search-status' : undefined}
              aria-activedescendant={filteredCommands[selectedIndex] ? `command-${filteredCommands[selectedIndex].id}` : undefined}
              className="flex-1 bg-transparent text-theme-text text-lg placeholder-slate-500 outline-none"
            />
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {searchStatus && (
            <div
              id="command-palette-search-status"
              className={`flex items-center gap-2 px-4 py-2 text-xs border-b border-white/5 ${
                searchStatus.kind === 'error' ? 'text-amber-300' : 'text-slate-400'
              }`}
              role={searchStatus.kind === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {searchStatus.kind === 'loading'
                ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                : searchStatus.kind === 'error'
                  ? <AlertCircle size={14} aria-hidden="true" />
                  : <Search size={14} aria-hidden="true" />}
              <span>{searchStatus.message}</span>
            </div>
          )}

          {/* Results */}
          <div id="command-palette-results" role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-auto py-2">
            {filteredCommands.length === 0 && searchStatus?.kind === 'loading' ? null : filteredCommands.length === 0 ? (
              <div role="option" aria-selected="false" aria-disabled="true" className="px-4 py-8 text-center text-slate-500">
                <Command size={32} className="mx-auto mb-2 opacity-30" />
                <p>No commands found</p>
              </div>
            ) : (
              filteredCommands.map((cmd, index) => (
                <button
                  key={cmd.id}
                  id={`command-${cmd.id}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onClick={() => executeCommand(cmd)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all ${
                    index === selectedIndex
                      ? 'accent-active border-l-2'
                      : 'hover:bg-white/5 border-l-2 border-transparent'
                  }`}
                >
                  <div className={`flex-shrink-0 ${index === selectedIndex ? 'accent-text' : 'text-slate-400'}`}>
                    {cmd.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`font-medium ${index === selectedIndex ? 'accent-text' : 'text-white'}`}>
                      {cmd.label}
                    </div>
                    {cmd.description && (
                      <div className="text-xs text-slate-500 truncate">
                        {cmd.description}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-slate-600 uppercase flex-shrink-0">
                    {cmd.category}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Footer hint */}
          <div className="px-4 py-2 border-t border-white/5 flex items-center justify-between text-xs text-slate-600">
            <div className="flex items-center gap-4">
              <span>↑↓ navigate</span>
              <span>↵ select</span>
              <span>esc close</span>
            </div>
            <div className="flex items-center gap-1">
              <Command size={12} />
              <span>K to open</span>
            </div>
          </div>
      </motion.div>
    </ViewportModal>
  );
}
