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

// Global shortcut registry for help modal
export const GLOBAL_SHORTCUTS: Record<string, ShortcutConfig[]> = {
  general: [
    { key: 'k', ctrl: true, handler: () => {}, description: 'Open command palette' },
    { key: 'b', ctrl: true, handler: () => {}, description: 'Toggle sidebar' },
    { key: '/', ctrl: true, handler: () => {}, description: 'Toggle Assistant AI' },
    { key: 'Escape', handler: () => {}, description: 'Close modal/panel' },
    { key: '?', shift: true, handler: () => {}, description: 'Show keyboard shortcuts' },
  ],
  editor: [
    { key: 's', ctrl: true, handler: () => {}, description: 'Save file' },
    { key: 'f', ctrl: true, handler: () => {}, description: 'Find' },
    { key: 'h', ctrl: true, handler: () => {}, description: 'Find and replace' },
    { key: '/', ctrl: true, handler: () => {}, description: 'Toggle comment' },
    { key: 'w', ctrl: true, handler: () => {}, description: 'Close tab' },
    { key: 'Tab', ctrl: true, handler: () => {}, description: 'Next tab' },
    { key: 'Tab', ctrl: true, shift: true, handler: () => {}, description: 'Previous tab' },
  ],
  fileTree: [
    { key: 'ArrowUp', handler: () => {}, description: 'Navigate up' },
    { key: 'ArrowDown', handler: () => {}, description: 'Navigate down' },
    { key: 'ArrowRight', handler: () => {}, description: 'Expand folder' },
    { key: 'ArrowLeft', handler: () => {}, description: 'Collapse folder' },
    { key: 'Enter', handler: () => {}, description: 'Open file/toggle folder' },
    { key: 'Delete', handler: () => {}, description: 'Delete file' },
    { key: 'F2', handler: () => {}, description: 'Rename file' },
    { key: 'n', ctrl: true, handler: () => {}, description: 'New file' },
  ],
  terminal: [
    { key: 'ArrowUp', handler: () => {}, description: 'Previous command/suggestion' },
    { key: 'ArrowDown', handler: () => {}, description: 'Next command/suggestion' },
    { key: 'Tab', handler: () => {}, description: 'Fill suggestion' },
    { key: 'Escape', handler: () => {}, description: 'Exit autocomplete/return to chat' },
    { key: 'Enter', handler: () => {}, description: 'Execute command' },
  ],
};

// Pretty format shortcut for display
export function formatShortcut(shortcut: ShortcutConfig): string {
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
