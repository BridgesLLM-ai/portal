import { PanelRight } from 'lucide-react';
import { useAgentWorkspaceStore } from '../../../stores/agentWorkspaceStore';

/**
 * Opens and closes the side panel. On a compact screen the agent's automatic
 * opens only mark new activity here (a dot) instead of covering the chat;
 * opening the panel goes to that tab and clears the mark.
 */
export default function WorkspacePanelButton() {
  const open = useAgentWorkspaceStore((state) => state.open);
  const unread = useAgentWorkspaceStore((state) => state.unreadTab !== null) && !open;
  return (
    <button
      type="button"
      onClick={() => useAgentWorkspaceStore.getState().toggle()}
      aria-label={open ? 'Close side panel' : unread ? 'Open side panel, new agent activity' : 'Open side panel'}
      aria-pressed={open}
      className={`relative p-1.5 rounded-lg transition-colors ${open ? 'text-white bg-white/[0.08]' : 'text-slate-400 hover:text-white hover:bg-white/[0.06]'}`}
      title="Side panel — widgets, artifacts and the agent browser"
    >
      <PanelRight size={16} aria-hidden="true" />
      {unread && (
        <span data-workspace-unread aria-hidden="true"
          className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-[var(--accent-light)] ring-2 ring-[var(--color-surface)]" />
      )}
    </button>
  );
}
