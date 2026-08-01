import { useEffect, useCallback } from 'react';

export interface ShortcutConfig {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: (e: KeyboardEvent) => void;
  description?: string;
  preventDefault?: boolean;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

export function useKeyboardShortcuts(shortcuts: ShortcutConfig[], enabled = true) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;

    // Ignore if user is typing in an input/textarea (unless explicitly handled)
    const target = e.target as HTMLElement;
    const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    for (const shortcut of shortcuts) {
      const keyMatches = e.key.toLowerCase() === shortcut.key.toLowerCase();
      const ctrlMatches = shortcut.ctrl ? (isMac ? e.metaKey : e.ctrlKey) : true;
      const metaMatches = shortcut.meta ? e.metaKey : true;
      const shiftMatches = shortcut.shift ? e.shiftKey : !e.shiftKey;
      const altMatches = shortcut.alt ? e.altKey : !e.altKey;

      // Special case: if ctrl/meta specified, require it
      if (shortcut.ctrl || shortcut.meta) {
        const modifierPressed = isMac ? e.metaKey : (e.ctrlKey || e.metaKey);
        if (!modifierPressed) continue;
      }

      if (keyMatches && ctrlMatches && metaMatches && shiftMatches && altMatches) {
        // Allow escape key even in input fields
        if (e.key === 'Escape' || !isInputField) {
          if (shortcut.preventDefault !== false) {
            e.preventDefault();
            e.stopPropagation();
          }
          shortcut.handler(e);
          break;
        }
      }
    }
  }, [shortcuts, enabled]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

export type ShortcutDisplay = Omit<ShortcutConfig, 'handler' | 'preventDefault'>;

// Display-only registry for the help modal. Keep this list narrower than the
// live handlers: an advertised shortcut is a product promise, not a wishlist.
export const GLOBAL_SHORTCUTS: Record<string, ShortcutDisplay[]> = {
  general: [
    { key: 'k', ctrl: true, description: 'Open command palette' },
    { key: 'Escape', description: 'Close the active modal or panel' },
    { key: '?', shift: true, description: 'Show keyboard shortcuts' },
  ],
  editor: [
    { key: 's', ctrl: true, description: 'Save file' },
    { key: 'f', ctrl: true, description: 'Find' },
    { key: 'h', ctrl: true, description: 'Find and replace' },
    { key: '/', ctrl: true, description: 'Toggle comment' },
  ],
  projects: [
    { key: 'b', ctrl: true, description: 'Toggle project sidebar' },
    { key: 'p', ctrl: true, description: 'Search project files' },
    { key: 'F', ctrl: true, shift: true, description: 'Toggle editor fullscreen' },
  ],
  terminal: [
    { key: 'ArrowUp', description: 'Previous command or suggestion' },
    { key: 'ArrowDown', description: 'Next command or suggestion' },
    { key: 'Tab', description: 'Fill suggestion' },
    { key: 'Escape', description: 'Exit autocomplete or return to chat' },
    { key: 'Enter', description: 'Execute command' },
  ],
};

// Pretty format shortcut for display
export function formatShortcut(shortcut: ShortcutDisplay): string {
  const parts: string[] = [];
  const mod = isMac ? '⌘' : 'Ctrl';
  
  if (shortcut.ctrl || shortcut.meta) parts.push(mod);
  if (shortcut.shift) parts.push('⇧');
  if (shortcut.alt) parts.push(isMac ? '⌥' : 'Alt');
  
  // Pretty key names
  const keyMap: Record<string, string> = {
    'ArrowUp': '↑',
    'ArrowDown': '↓',
    'ArrowLeft': '←',
    'ArrowRight': '→',
    'Escape': 'Esc',
    'Delete': 'Del',
    ' ': 'Space',
  };
  
  parts.push(keyMap[shortcut.key] || shortcut.key.toUpperCase());
  
  return parts.join(' ');
}
