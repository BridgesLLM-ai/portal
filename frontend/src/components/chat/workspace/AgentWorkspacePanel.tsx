import { useEffect, useMemo, useRef } from 'react';
import { FileCode2, FileText, GitBranch, Globe, LayoutGrid, Library, Plus, Paperclip, PictureInPicture2, Settings, X } from 'lucide-react';
import type { ChatMessage } from '../../../contexts/ChatStateProvider';
import { useAgentWorkspaceStore, type BuiltinWorkspaceTab, type WorkspacePreview, type WorkspaceTab } from '../../../stores/agentWorkspaceStore';
import { collectArtifacts, collectWidgets, latestBrowserActivity, type ChatArtifact } from './artifacts';
import WorkspaceBrowserTab from './WorkspaceBrowserTab';
import WorkspacePreviewView from './WorkspacePreviewView';
import WorkspaceWidgetsTab from './WorkspaceWidgetsTab';

const KIND_ICON = { code: FileCode2, mermaid: GitBranch, markdown: FileText, file: Paperclip, widget: PictureInPicture2 } as const;
const tabClass = (active: boolean) => `group relative inline-flex h-9 max-w-[11rem] shrink-0 items-center gap-1 rounded-t-md pl-2.5 pr-1 text-xs transition-colors ${active
  ? 'bg-[var(--color-surface)] text-white shadow-[inset_0_2px_0_rgba(56,189,248,0.7)]' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'}`;
export const BROWSER_UNAVAILABLE_REASON = 'The live browser view follows OpenClaw’s managed browser. Other harnesses do not report a browser this panel can show.';

function ArtifactsList({ artifacts }: { artifacts: ChatArtifact[] }) {
  const openPreview = useAgentWorkspaceStore((state) => state.openPreview);
  if (!artifacts.length) return <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-400">
    <Library size={22} className="text-slate-500" />
    Code, diagrams, documents and files the agent posts in this chat collect here, newest first.
  </div>;
  return <ul className="h-full overflow-auto py-1" aria-label="Chat artifacts">
    {artifacts.map((artifact) => {
      const Icon = KIND_ICON[artifact.kind];
      return <li key={artifact.key}>
        <button type="button" onClick={() => openPreview(artifact.preview)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-white/[0.04]">
          <Icon size={15} className="shrink-0 text-sky-300/80" aria-hidden="true" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm text-slate-200">{artifact.title}</span>
            <span className="block text-[10px] text-slate-400">{artifact.detail}</span></span>
        </button>
      </li>;
    })}
  </ul>;
}

/**
 * The Agent Chat side panel: the agent's live browser (where the harness has
 * one), this chat's widgets, its artifacts, and anything opened beside the
 * chat. Docked and resizable on wide screens, full-screen on small ones.
 */
export default function AgentWorkspacePanel({ provider, session, messages, browserAvailable, widgetsSupported, onOpenSettings }: {
  provider: string; session: string; messages: ChatMessage[]; browserAvailable: boolean; widgetsSupported: boolean; onOpenSettings?: () => void;
}) {
  const { open, tab, width, previews, show, hide, setWidth, closePreview, closeTab, closedTabs } = useAgentWorkspaceStore();
  const availableTabs: BuiltinWorkspaceTab[] = browserAvailable ? ['browser', 'widgets', 'artifacts'] : ['widgets', 'artifacts'];
  const artifacts = useMemo(() => collectArtifacts(messages), [messages]);
  const widgets = useMemo(() => collectWidgets(messages), [messages]);
  const activity = useMemo(() => browserAvailable ? latestBrowserActivity(messages) : null, [messages, browserAvailable]);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const activePreview = tab.startsWith('preview:') ? previews.find((preview) => `preview:${preview.id}` === tab) : undefined;
  const fallback = availableTabs.find((id) => !closedTabs.includes(id)) || 'artifacts';
  const current: WorkspaceTab = (tab.startsWith('preview:') && !activePreview) || (!browserAvailable && tab === 'browser') ? fallback : tab;

  const tablist = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tablist.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [current, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && window.innerWidth < 1024) hide(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hide]);

  if (!open) return null;
  const startResize = (event: React.PointerEvent) => {
    drag.current = { startX: event.clientX, startWidth: width };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const resize = (event: React.PointerEvent) => {
    if (!drag.current) return;
    setWidth(Math.min(window.innerWidth - 360, drag.current.startWidth + (drag.current.startX - event.clientX)));
  };
  const fixedTabs: Array<{ id: BuiltinWorkspaceTab; label: string; Icon: typeof Globe; count?: number }> = [
    { id: 'browser', label: 'Browser', Icon: Globe },
    { id: 'widgets', label: 'Widgets', Icon: LayoutGrid, count: widgets.length },
    { id: 'artifacts', label: 'Artifacts', Icon: Library, count: artifacts.length },
  ];
  const visibleTabs = fixedTabs.filter((item) => availableTabs.includes(item.id) && !closedTabs.includes(item.id));
  return <aside aria-label="Agent workspace"
    className="fixed inset-0 z-40 flex flex-col bg-[var(--color-surface)] lg:relative lg:inset-auto lg:z-auto lg:w-[var(--agent-workspace-width)] lg:shrink-0 lg:border-l lg:border-white/[0.06]"
    style={{ ['--agent-workspace-width' as string]: `${width}px` }}>
    <button type="button" aria-label={`Resize side panel, ${width} pixels wide`} title="Drag, or use the left and right arrow keys, to resize"
      onPointerDown={startResize} onPointerMove={resize} onPointerUp={() => { drag.current = null; }}
      onKeyDown={(event) => { if (event.key === 'ArrowLeft') setWidth(width + 24); if (event.key === 'ArrowRight') setWidth(width - 24); }}
      className="absolute inset-y-0 left-0 z-10 hidden w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-sky-400/40 focus-visible:bg-sky-400/60 lg:block" />
    <div className="flex items-end border-b border-white/[0.06] bg-white/[0.02]">
      <div ref={tablist} className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-1.5 pt-1.5 [scrollbar-width:thin]" role="tablist" aria-label="Side panel tabs">
        {visibleTabs.map(({ id, label, Icon, count }) => (
          <span key={id} className={tabClass(current === id)}>
            <button type="button" role="tab" aria-selected={current === id} className="flex min-w-0 items-center gap-1.5"
              onClick={() => show(id)} onKeyDown={(event) => { if (event.key === 'Delete') closeTab(id, availableTabs); }}>
              <Icon size={13} aria-hidden="true" />{label}
              {!!count && <span className="rounded-full bg-white/10 px-1.5 text-[10px] text-slate-300">{count}</span>}
            </button>
            <button type="button" aria-label={`Close ${label} tab`} title={`Close ${label} tab`} onClick={() => closeTab(id, availableTabs)}
              className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"><X size={13} /></button>
          </span>
        ))}
        {previews.map((preview: WorkspacePreview) => {
          const Icon = KIND_ICON[preview.kind];
          const active = current === `preview:${preview.id}`;
          return <span key={preview.id} className={tabClass(active)}>
            <button type="button" role="tab" aria-selected={active} className="flex min-w-0 items-center gap-1.5" onClick={() => show(`preview:${preview.id}`)}
              onKeyDown={(event) => { if (event.key === 'Delete') closePreview(preview.id, availableTabs); }}>
              <Icon size={13} aria-hidden="true" /><span className="truncate">{preview.title}</span>
            </button>
            <button type="button" aria-label={`Close ${preview.title}`} onClick={() => closePreview(preview.id, availableTabs)}
              className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white"><X size={13} /></button>
          </span>;
        })}
      </div>
      <span className="flex shrink-0 items-center gap-0.5 px-1.5 pb-1">
        <details className="relative">
          <summary aria-label="Open a side panel tab" title="Open a tab" className="flex cursor-pointer list-none rounded-md p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white [&::-webkit-details-marker]:hidden"><Plus size={15} /></summary>
          <div className="absolute right-0 top-full z-20 mt-1 min-w-44 rounded-lg border border-white/10 bg-[var(--color-surface-raised)] p-1 shadow-xl">
            {fixedTabs.map(({ id, label, Icon }) => {
              const available = availableTabs.includes(id);
              return <button key={id} type="button" disabled={!available} title={available ? `Open ${label}` : BROWSER_UNAVAILABLE_REASON}
                onClick={(event) => { show(id); event.currentTarget.closest('details')?.removeAttribute('open'); }}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-xs text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50">
                <Icon size={14} aria-hidden="true" /><span className="flex-1">{label}</span>{!available && <span className="text-[10px] text-slate-400">OpenClaw only</span>}
              </button>;
            })}
          </div>
        </details>
        {onOpenSettings && <button type="button" aria-label="Agent settings" title="Agent settings" onClick={onOpenSettings}
          className="rounded-md p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white"><Settings size={14} /></button>}
        <button type="button" aria-label="Close side panel" title="Close side panel" onClick={hide}
          className="rounded-md p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-white"><X size={15} /></button>
      </span>
    </div>
    <div className="min-h-0 flex-1 overflow-hidden">
      {browserAvailable && !closedTabs.includes('browser') && <div className={current === 'browser' ? 'h-full' : 'hidden'}>
        <WorkspaceBrowserTab session={session} activity={activity} visible={current === 'browser'} />
      </div>}
      {current === 'widgets' && <WorkspaceWidgetsTab provider={provider} session={session} widgets={widgets} supported={widgetsSupported} />}
      {current === 'artifacts' && <ArtifactsList artifacts={artifacts} />}
      {activePreview && <WorkspacePreviewView key={activePreview.id} preview={activePreview} />}
      {!visibleTabs.length && !previews.length && <p className="p-4 text-sm text-slate-400">All tabs are closed. Use + to reopen one.</p>}
    </div>
  </aside>;
}
