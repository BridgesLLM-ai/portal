import { useState, useEffect } from 'react';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import CommandPalette from './CommandPalette';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';

interface GlobalControlsProps {
  children: React.ReactNode;
  onToggleSidebar?: () => void;
  onToggleAssistantAI?: () => void;
}

export default function GlobalControls({ children, onToggleSidebar, onToggleAssistantAI }: GlobalControlsProps) {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);

  // Global keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: 'k',
      ctrl: true,
      handler: () => setCommandPaletteOpen(true),
      description: 'Open command palette',
    },
    {
      key: 'b',
      ctrl: true,
      handler: () => onToggleSidebar?.(),
      description: 'Toggle sidebar',
    },
    {
      key: '/',
      ctrl: true,
      handler: () => onToggleAssistantAI?.(),
      description: 'Toggle Assistant AI',
    },
    {
      key: '?',
      shift: true,
      handler: (e) => {
        // Only open if shift+? pressed (not just ?)
        if (e.shiftKey && e.key === '?') {
          setShortcutsHelpOpen(true);
        }
      },
      description: 'Show keyboard shortcuts',
      preventDefault: false, // Allow normal ? in inputs
    },
    {
      key: 'Escape',
      handler: () => {
        if (commandPaletteOpen) setCommandPaletteOpen(false);
        if (shortcutsHelpOpen) setShortcutsHelpOpen(false);
      },
      description: 'Close modals',
      preventDefault: false, // Let components handle their own escape
    },
  ]);

  // Add keyboard hint overlay (subtle, dismissible)
  const [showKeyboardHint, setShowKeyboardHint] = useState(false);

  useEffect(() => {
    // Show hint after 5 seconds if user hasn't opened palette
    const timer = setTimeout(() => {
      const hasSeenHint = localStorage.getItem('portalKeyboardHintSeen');
      if (!hasSeenHint) {
        setShowKeyboardHint(true);
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, []);

  const dismissKeyboardHint = () => {
    setShowKeyboardHint(false);
    localStorage.setItem('portalKeyboardHintSeen', 'true');
  };

  return (
    <>
      {children}
      
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />
      
      <KeyboardShortcutsHelp
        isOpen={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
      />

      {/* Keyboard hint overlay */}
      {showKeyboardHint && (
        <div className="fixed bottom-6 right-6 z-[100] max-w-xs">
          <div className="bg-[#0A0E27]/95 border border-emerald-500/30 rounded-xl p-4 shadow-2xl backdrop-blur-xl animate-fade-in">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex-1">
                <div className="text-sm font-semibold text-emerald-400 mb-1">
                  💡 Pro Tip
                </div>
                <div className="text-xs text-slate-300">
                  Press <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-emerald-400 font-mono">⌘ K</kbd> for quick navigation
                </div>
              </div>
              <button
                onClick={dismissKeyboardHint}
                className="text-slate-500 hover:text-white text-xs"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
            <div className="text-[10px] text-slate-500">
              Press <kbd className="px-1 py-0.5 rounded bg-slate-800 text-emerald-400 font-mono">Shift ?</kbd> to see all shortcuts
            </div>
          </div>
        </div>
      )}
    </>
  );
}
