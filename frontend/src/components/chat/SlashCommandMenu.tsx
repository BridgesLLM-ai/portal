import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import type { SlashCommand } from '../../utils/slashCommands';
import AnchoredPopover from '../AnchoredPopover';

interface SlashCommandMenuProps {
  id: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  commands: SlashCommand[];
  selectedIndex: number;
  onNavigate: (index: number) => void;
  onSelect: (command: SlashCommand) => void;
  onDismiss: () => void;
}

export default function SlashCommandMenu({
  id,
  open,
  anchorRef,
  commands,
  selectedIndex,
  onNavigate,
  onSelect,
  onDismiss,
}: SlashCommandMenuProps) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open || commands.length === 0) return;
    const selected = optionRefs.current[Math.min(selectedIndex, commands.length - 1)];
    selected?.scrollIntoView?.({ block: 'nearest' });
  }, [commands.length, open, selectedIndex]);

  if (!open || commands.length === 0) return null;

  const focusOption = (index: number) => {
    const nextIndex = (index + commands.length) % commands.length;
    onNavigate(nextIndex);
    optionRefs.current[nextIndex]?.focus();
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusOption(commands.length - 1);
    }
  };

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onDismiss={onDismiss}
      width={480}
      align="start"
      mobileBreakpoint={639}
      preferredMinimumHeight={180}
      ariaLabel="Slash commands"
      className="flex flex-col rounded-xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl shadow-black/20 backdrop-blur-xl"
    >
      <div
        id={id}
        data-slash-command-menu="true"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        role="listbox"
        aria-label="Slash commands"
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          {commands.map((cmd, index) => {
            const active = index === selectedIndex;
            return (
              <button
                key={cmd.command}
                id={`${id}-option-${index}`}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                onMouseDown={(event) => {
                  // Desktop selection keeps the composer focused until the
                  // completed click applies the command. Mobile sheets already
                  // own focus through ViewportModal.
                  event.preventDefault();
                }}
                onMouseEnter={() => onNavigate(index)}
                onFocus={() => onNavigate(index)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
                onClick={() => onSelect(cmd)}
                className={`group w-full border-l-2 px-3 py-2 text-left transition-colors duration-100 ${
                  active
                    ? 'accent-active'
                    : 'border-transparent hover:bg-theme-surface-hover'
                }`}
                role="option"
                aria-selected={active}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`shrink-0 font-mono text-[13px] tracking-tight ${active ? 'accent-text' : 'text-theme-text'}`}>
                    {cmd.command}
                  </span>
                  {cmd.argsHint && (
                    <span className="min-w-0 truncate font-mono text-[10px] text-theme-text-muted">{cmd.argsHint}</span>
                  )}
                  <span className="ml-auto shrink-0 text-[10px] text-theme-text-muted">{cmd.category}</span>
                </div>
                <div className="mt-0.5 text-[11px] text-theme-text-muted">
                  {cmd.description}
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-theme-border bg-theme-surface-raised px-3 py-1.5 text-[10px] text-theme-text-muted">
          <span>↑↓ navigate</span>
          <span>enter select</span>
          <span>esc dismiss</span>
        </div>
      </div>
    </AnchoredPopover>
  );
}
