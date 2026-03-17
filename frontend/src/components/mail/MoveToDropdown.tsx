import { FolderIcon } from './helpers';
import type { MailboxInfo } from './types';

export function MoveToDropdown({ mailboxes, onMove, onClose }: {
  mailboxes: MailboxInfo[];
  onMove: (mailboxId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute right-0 top-full mt-1 z-50 bg-[#0D1130] border border-white/[0.08] rounded-xl shadow-2xl shadow-black/50 py-1 min-w-[180px]">
      {mailboxes.map(mb => (
        <button
          key={mb.id}
          onClick={() => { onMove(mb.id); onClose(); }}
          className="w-full flex items-center gap-2.5 px-4 py-2 text-xs text-slate-300 hover:bg-white/[0.06] hover:text-white transition-colors"
        >
          <FolderIcon role={mb.role} size={14} />
          <span>{mb.name}</span>
        </button>
      ))}
    </div>
  );
}
