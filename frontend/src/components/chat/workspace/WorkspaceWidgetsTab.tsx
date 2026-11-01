import { useEffect, useState } from 'react';
import { LayoutGrid, MessageSquare, PictureInPicture2 } from 'lucide-react';
import client from '../../../api/client';
import { useFloatingWidgetsStore } from '../../../stores/agentWorkspaceStore';
import type { ChatWidgetEntry } from './artifacts';
import { WidgetPreview } from './WorkspacePreviewView';

const button = 'inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-40';

/** One finding of the read-only agent tool policy check (backend displayToolPolicy). */
export type DisplayToolFinding = { tool: 'show_widget' | 'progress_card' | 'ask_user'; kind: 'deny' | 'allow' | 'empty-allow'; setting: string; entry?: string };
const DISPLAY_TOOL_LABELS: Record<DisplayToolFinding['tool'], string> = {
  show_widget: 'Widgets (show_widget)', progress_card: 'Progress notes (progress_card)', ask_user: 'Question cards (ask_user)',
};

/** Why the agent's own policy hides a display tool, and what to change. */
export function displayToolFindingText(finding: DisplayToolFinding): string {
  const label = DISPLAY_TOOL_LABELS[finding.tool];
  if (finding.kind === 'deny') return `${label}: hidden because ${finding.setting} lists "${finding.entry}". Remove that entry, or deny only the tools you mean.`;
  if (finding.kind === 'empty-allow') return `${label}: hidden because ${finding.setting} is empty, which turns off every tool. List the tools this agent should use, including ${finding.tool}.`;
  return `${label}: hidden because ${finding.setting} does not include it. Add ${finding.tool} to that list.`;
}

const isDisplayToolFinding = (value: any): value is DisplayToolFinding => Boolean(value)
  && Object.prototype.hasOwnProperty.call(DISPLAY_TOOL_LABELS, value.tool) && ['deny', 'allow', 'empty-allow'].includes(value.kind)
  && typeof value.setting === 'string' && (value.kind !== 'deny' || typeof value.entry === 'string');

/** Bring a widget card in the transcript into view, briefly highlighted. */
export function scrollToChatWidget(toolCallId: string): boolean {
  const element = document.getElementById(`chat-widget-${toolCallId}`);
  if (!element) return false;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.classList.add('ring-2', 'ring-violet-400/60');
  setTimeout(() => element.classList.remove('ring-2', 'ring-violet-400/60'), 1800);
  return true;
}

/** Every widget in this chat, newest first; a live widget is one row showing its newest version. */
export default function WorkspaceWidgetsTab({ provider, session, widgets, supported }: {
  provider: string; session: string; widgets: ChatWidgetEntry[]; supported: boolean;
}) {
  const [selected, setSelected] = useState(widgets[0]?.key || '');
  const [notice, setNotice] = useState('');
  const popOut = useFloatingWidgetsStore((state) => state.popOut);
  const floating = useFloatingWidgetsStore((state) => state.widgets);
  const floatingError = useFloatingWidgetsStore((state) => state.error);
  useEffect(() => { if (!widgets.some((widget) => widget.key === selected)) setSelected(widgets[0]?.key || ''); }, [widgets, selected]);
  const [policy, setPolicy] = useState<DisplayToolFinding[]>([]);
  const empty = widgets.length === 0;
  // Read-only: an empty tab asks once whether the agent's own tool policy hides the display tools.
  useEffect(() => {
    setPolicy([]);
    if (!empty || !supported || provider.toUpperCase() !== 'OPENCLAW' || !session.startsWith('agent:')) return;
    let current = true;
    client.get(`/agent-workspace/sessions/${encodeURIComponent(session)}/widget-policy`, { _silent: true } as any)
      .then(({ data }) => { if (current && data?.checked === true && Array.isArray(data.findings)) setPolicy(data.findings.filter(isDisplayToolFinding)); })
      .catch(() => { /* Nothing is claimed when the policy cannot be read. */ });
    return () => { current = false; };
  }, [empty, supported, provider, session]);
  if (!widgets.length) return <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-400">
    <LayoutGrid size={22} className="text-slate-500" />
    {supported
      ? 'Widgets the agent makes in this chat collect here. Ask it to time, track or chart something and it can build one.'
      : 'This harness does not offer interactive widgets. Code previews, diagrams and files still collect under Artifacts.'}
    {policy.length > 0 && <div role="note" aria-label="Agent tool policy" className="mt-2 max-w-md rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-left text-xs text-amber-100">
      <p className="font-medium">This agent&apos;s own tool policy hides some chat tools:</p>
      <ul className="mt-1 list-disc space-y-1 pl-4">{policy.map((finding) => <li key={`${finding.tool}:${finding.setting}`}>{displayToolFindingText(finding)}</li>)}</ul>
      <p className="mt-1 text-amber-100/80">Change it in the agent&apos;s OpenClaw configuration. The Portal never changes tool policy for you.</p>
    </div>}
  </div>;
  const normalizedProvider = provider.toUpperCase();
  return <div className="flex h-full min-h-0 flex-col">
    <ul className="max-h-[40%] shrink-0 overflow-auto border-b border-white/[0.06] py-1" aria-label="Widgets in this chat">
      {widgets.map((widget) => {
        const isFloating = floating.some((item) => item.provider === normalizedProvider && item.session === session && item.toolCallId === widget.toolCallId);
        return <li key={widget.key} className={`flex items-center gap-2 px-3 py-1.5 ${selected === widget.key ? 'bg-white/[0.05]' : ''}`}>
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected(widget.key)} aria-pressed={selected === widget.key}>
            <span className="block truncate text-sm text-slate-200">{widget.title}</span>
            <span className="block text-[10px] text-slate-400">{widget.boardName
              ? `Live widget · ${widget.versions} update${widget.versions === 1 ? '' : 's'}`
              : widget.mode === 'inline' ? 'Snapshot' : 'Saved to the session dashboard'}{isFloating ? ' · floating' : ''}</span>
          </button>
          <button type="button" className={button} aria-label={`Pop out ${widget.title}`} title="Keep it on screen over any page"
            disabled={widget.mode !== 'inline'}
            onClick={() => { setNotice(''); const done = popOut({ provider: normalizedProvider, session, toolCallId: widget.toolCallId, title: widget.title }); if (done) setNotice(`${widget.title} is floating. Drag its bar to move it.`); }}>
            <PictureInPicture2 size={12} />Pop out</button>
          <button type="button" className={button} aria-label={`Show ${widget.title} in chat`} title="Show in chat"
            onClick={() => { if (!scrollToChatWidget(widget.toolCallId)) setNotice('That widget is further up in this chat. Scroll up to load older messages.'); }}>
            <MessageSquare size={12} /></button>
        </li>;
      })}
    </ul>
    {(notice || floatingError) && <p role="status" className="border-b border-white/[0.06] px-3 py-1.5 text-[11px] text-slate-400">{floatingError || notice}</p>}
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {(() => {
        const widget = widgets.find((item) => item.key === selected);
        if (!widget) return null;
        if (widget.mode !== 'inline' && !widget.boardName) return <p className="text-sm text-slate-400">This widget was saved to the session dashboard without a chat copy, so it has no preview here.</p>;
        // A live widget previews its newest version, including pinned-only updates.
        return <WidgetPreview key={widget.key} provider={normalizedProvider} session={session} toolCallId={widget.toolCallId} title={widget.title} boardName={widget.boardName} />;
      })()}
    </div>
  </div>;
}
