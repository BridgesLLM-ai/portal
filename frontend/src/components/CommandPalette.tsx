import { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Command, File, Folder, Terminal, Layout, Rocket, Settings, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../contexts/AuthContext';
import { isElevated } from '../utils/authz';

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  action: () => void;
  category: 'navigation' | 'file' | 'action' | 'recent';
  keywords?: string[];
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filteredCommands, setFilteredCommands] = useState<CommandItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const commands = useMemo<CommandItem[]>(() => [
    {
      id: 'nav-dashboard',
      label: 'Go to Dashboard',
      icon: <Layout size={16} />,
      action: () => navigate('/'),
      category: 'navigation',
      keywords: ['home', 'overview', 'main'],
    },
    {
      id: 'nav-projects',
      label: 'Go to Projects',
      icon: <Folder size={16} />,
      action: () => navigate('/projects'),
      category: 'navigation',
      keywords: ['code', 'repos', 'deploy', 'share', 'hosted', 'apps'],
    },
    {
      id: 'nav-files',
      label: 'Go to Files',
      icon: <File size={16} />,
      action: () => navigate('/files'),
      category: 'navigation',
      keywords: ['browse', 'explorer'],
    },
    ...(isElevated(user)
      ? [{
          id: 'nav-terminal',
          label: 'Go to Terminal',
          icon: <Terminal size={16} />,
          action: () => navigate('/terminal'),
          category: 'navigation' as const,
          keywords: ['shell', 'console', 'command'],
        }]
      : []),
    {
      id: 'nav-settings',
      label: 'Go to Settings',
      icon: <Settings size={16} />,
      action: () => navigate('/settings'),
      category: 'navigation',
      keywords: ['config', 'preferences'],
    },
  ], [navigate, user]);

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

    setFilteredCommands(filtered);
    setSelectedIndex(0);
  }, [commands, query]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
      setQuery('');
    }
  }, [isOpen]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(filteredCommands.length - 1, prev + 1));
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
    cmd.action();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] flex items-start justify-center pt-[20vh] bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: -20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: -20 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="w-full max-w-2xl mx-4 bg-[#0A0E27]/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-2xl"
          onClick={e => e.stopPropagation()}
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
              className="flex-1 bg-transparent text-white text-lg placeholder-slate-500 outline-none"
            />
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {/* Results */}
          <div className="max-h-[60vh] overflow-auto">
            {filteredCommands.length === 0 ? (
              <div className="px-4 py-8 text-center text-slate-500">
                <Command size={32} className="mx-auto mb-2 opacity-30" />
                <p>No commands found</p>
              </div>
            ) : (
              <div className="py-2">
                {filteredCommands.map((cmd, index) => (
                  <button
                    key={cmd.id}
                    onClick={() => executeCommand(cmd)}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all ${
                      index === selectedIndex
                        ? 'bg-emerald-500/10 border-l-2 border-emerald-400'
                        : 'hover:bg-white/5 border-l-2 border-transparent'
                    }`}
                  >
                    <div className={`flex-shrink-0 ${index === selectedIndex ? 'text-emerald-400' : 'text-slate-400'}`}>
                      {cmd.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`font-medium ${index === selectedIndex ? 'text-emerald-300' : 'text-white'}`}>
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
                ))}
              </div>
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
      </motion.div>
    </AnimatePresence>
  );
}
