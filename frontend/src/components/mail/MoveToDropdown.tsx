import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Loader2 } from 'lucide-react';
import AnchoredPopover from '../AnchoredPopover';
import { FolderIcon } from './helpers';
import type { MailboxInfo } from './types';

interface MoveToDropdownProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  menuId: string;
  mailboxes: MailboxInfo[];
  onMove: (mailboxId: string) => void | Promise<void>;
  onClose: () => void;
}

export function MoveToDropdown({
  open,
  anchorRef,
  menuId,
  mailboxes,
  onMove,
  onClose,
}: MoveToDropdownProps) {
  const [menuElement, setMenuElement] = useState<HTMLDivElement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [pendingMailboxId, setPendingMailboxId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState('');
  const moveLockRef = useRef(false);

  const restoreTrigger = () => {
    window.requestAnimationFrame(() => anchorRef.current?.focus());
  };

  const completeClose = () => {
    onClose();
    restoreTrigger();
  };

  const requestClose = () => {
    if (moveLockRef.current) return;
    completeClose();
  };

  useEffect(() => {
    if (!open || !menuElement) return undefined;
    setFocusedIndex(0);
    setMoveError('');
    const frame = window.requestAnimationFrame(() => {
      menuElement.querySelector<HTMLButtonElement>('[data-move-mailbox]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menuElement, open]);

  const focusItem = (nextIndex: number) => {
    if (mailboxes.length === 0) return;
    const normalized = (nextIndex + mailboxes.length) % mailboxes.length;
    setFocusedIndex(normalized);
    menuElement
      ?.querySelectorAll<HTMLButtonElement>('[data-move-mailbox]')
      .item(normalized)
      ?.focus();
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mailboxes.length === 0 || moveLockRef.current) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(focusedIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(focusedIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(mailboxes.length - 1);
    }
  };

  const handleMove = async (mailbox: MailboxInfo) => {
    if (moveLockRef.current) return;
    moveLockRef.current = true;
    setPendingMailboxId(mailbox.id);
    setMoveError('');
    try {
      await onMove(mailbox.id);
      completeClose();
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message.replace(/\s+/g, ' ').trim().slice(0, 240)
        : `The message could not be moved to ${mailbox.name}.`;
      setMoveError(message);
      window.requestAnimationFrame(() => {
        Array.from(
          menuElement?.querySelectorAll<HTMLButtonElement>('[data-move-mailbox]') || [],
        ).find((item) => item.dataset.moveMailbox === mailbox.id)?.focus();
      });
    } finally {
      moveLockRef.current = false;
      setPendingMailboxId(null);
    }
  };

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onDismiss={requestClose}
      width={240}
      align="end"
      gap={6}
      mobileBreakpoint={639}
      ariaLabel="Move message to folder"
      className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#0D1130] shadow-2xl shadow-black/50"
    >
      <div
        ref={setMenuElement}
        id={menuId}
        role="menu"
        tabIndex={-1}
        aria-label="Move message to folder"
        onKeyDown={handleMenuKeyDown}
        className="max-h-full overflow-y-auto overscroll-contain py-1"
      >
        <div className="border-b border-white/[0.06] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Move to folder
        </div>
        {mailboxes.length > 0 ? mailboxes.map((mailbox, index) => (
          <button
            type="button"
            key={mailbox.id}
            data-move-mailbox={mailbox.id}
            tabIndex={focusedIndex === index ? 0 : -1}
            onFocus={() => setFocusedIndex(index)}
            onClick={() => { void handleMove(mailbox); }}
            disabled={pendingMailboxId !== null}
            aria-busy={pendingMailboxId === mailbox.id}
            className="flex min-h-[40px] w-full items-center gap-2.5 px-4 py-2 text-left text-xs text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white focus:bg-white/[0.06] focus:text-white focus:outline-none"
            role="menuitem"
          >
            {pendingMailboxId === mailbox.id ? (
              <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <FolderIcon role={mailbox.role} size={14} />
            )}
            <span className="truncate">{pendingMailboxId === mailbox.id ? 'Moving…' : mailbox.name}</span>
          </button>
        )) : (
          <div className="px-4 py-3 text-xs text-slate-500" role="status">
            No destination folders are available.
          </div>
        )}
        {moveError && (
          <div role="alert" className="mx-2 my-1 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-300">
            {moveError}
          </div>
        )}
        <div className="border-t border-white/[0.06] p-1">
          <button
            type="button"
            onClick={requestClose}
            disabled={pendingMailboxId !== null}
            className="min-h-[40px] w-full rounded-lg px-3 py-2 text-left text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:cursor-wait disabled:opacity-50"
            role="menuitem"
          >
            Cancel
          </button>
        </div>
      </div>
    </AnchoredPopover>
  );
}
