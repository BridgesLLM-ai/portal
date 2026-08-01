import { useCallback, useState, useEffect, useMemo } from 'react';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import CommandPalette from './CommandPalette';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';
import ViewportOverlay from './ViewportOverlay';
import { isRouteOperationOwned, useRouteOperationGuard } from '../contexts/RouteOperationContext';

interface GlobalControlsProps {
  children: React.ReactNode;
  onToggleSidebar?: () => void;
  onToggleAssistantAI?: () => void;
}

export default function GlobalControls({ children, onToggleSidebar, onToggleAssistantAI }: GlobalControlsProps) {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const { active: routeOperationActive } = useRouteOperationGuard();

  const openCommandPalette = useCallback(() => {
    if (isRouteOperationOwned()) return;
    setShortcutsHelpOpen(false);
    setCommandPaletteOpen(true);
  }, []);

  const openShortcutsHelp = useCallback(() => {
    if (isRouteOperationOwned()) return;
    setCommandPaletteOpen(false);
    setShortcutsHelpOpen(true);
  }, []);

  useEffect(() => {
    if (!routeOperationActive) return;
    setCommandPaletteOpen(false);
    setShortcutsHelpOpen(false);
  }, [routeOperationActive]);

  // Global keyboard shortcuts
  const shortcuts = useMemo(() => [
    {
      key: 'k',
      ctrl: true,
      handler: openCommandPalette,
      description: 'Open command palette',
    },
    ...(onToggleSidebar ? [{
      key: 'b',
      ctrl: true,
      handler: onToggleSidebar,
      description: 'Toggle sidebar',
    }] : []),
    ...(onToggleAssistantAI ? [{
      key: '/',
      ctrl: true,
      handler: onToggleAssistantAI,
      description: 'Toggle Assistant AI',
    }] : []),
    {
      key: '?',
      shift: true,
      handler: (e: KeyboardEvent) => {
        // Only open if shift+? pressed (not just ?)
        if (e.shiftKey && e.key === '?') {
          openShortcutsHelp();
        }
      },
      description: 'Show keyboard shortcuts',
      preventDefault: false, // Allow normal ? in inputs
    },
  ], [onToggleAssistantAI, onToggleSidebar, openCommandPalette, openShortcutsHelp]);
  useKeyboardShortcuts(shortcuts);

  // Add keyboard hint overlay (subtle, dismissible)
  const [showKeyboardHint, setShowKeyboardHint] = useState(false);

  useEffect(() => {
    // Show hint after 5 seconds if user hasn't opened palette
    const timer = setTimeout(() => {
      let hasSeenHint = true;
      try {
        hasSeenHint = localStorage.getItem('portalKeyboardHintSeen') === 'true';
      } catch {
        // Storage can be unavailable in hardened/private browser modes.
      }
      if (!hasSeenHint && !isRouteOperationOwned()) {
        setShowKeyboardHint(true);
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (routeOperationActive) setShowKeyboardHint(false);
  }, [routeOperationActive]);

  const dismissKeyboardHint = () => {
    setShowKeyboardHint(false);
    try { localStorage.setItem('portalKeyboardHintSeen', 'true'); } catch { /* non-fatal */ }
  };

  const commandKey = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
    ? '⌘ K'
    : 'Ctrl K';

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
      {showKeyboardHint && !routeOperationActive && (
        <ViewportOverlay anchor="bottom-left" zIndex={1100} margin="1.5rem" className="max-w-[min(20rem,calc(100vw-3rem))]">
          <div className="bg-[#0A0E27]/95 border border-emerald-500/30 rounded-xl p-4 shadow-2xl backdrop-blur-xl animate-fade-in">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex-1">
                <div className="text-sm font-semibold text-emerald-400 mb-1">
                  💡 Pro Tip
                </div>
                <div className="text-xs text-slate-300">
                  Press <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-emerald-400 font-mono">{commandKey}</kbd> for quick navigation
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
        </ViewportOverlay>
      )}
    </>
  );
}
