import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Maximize2, X } from 'lucide-react';
import ViewportModal from '../ViewportModal';
import { inspectJson, type JsonTreeNode } from './jsonPresentation';

const controlClass = 'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-theme-text hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400';

function useExactCopy() {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string) => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied');
    } catch { setStatus('Copy failed. Select the text to copy manually.'); }
    timer.current = setTimeout(() => setStatus(''), 2500);
  };
  return { status, copy };
}

function JsonBranch({ node, label = 'Root', depth = 0 }: { node: JsonTreeNode; label?: string; depth?: number }) {
  if (node.kind === 'value') return <div className="break-all py-0.5"><span className="text-theme-text-muted">{label}: </span><span>{node.raw}</span></div>;
  const children = node.kind === 'object'
    ? node.entries.map((entry, index) => <JsonBranch key={index} node={entry.value} label={`${entry.rawKey}${entry.duplicate ? ` (duplicate key, occurrence ${entry.occurrence})` : ''}`} depth={depth + 1} />)
    : node.items.map((item, index) => <JsonBranch key={index} node={item} label={`[${index}]`} depth={depth + 1} />);
  return <details open={depth === 0} className="min-w-0 py-0.5">
    <summary className="cursor-pointer break-all rounded px-1 py-1 text-theme-text">{label} <span className="text-theme-text-muted">{node.kind === 'object' ? `{${children.length} entries}` : `[${children.length} items]`}</span></summary>
    <div className="ml-3 border-l border-theme-border pl-3">{children}</div>
  </details>;
}

export function AssistantJson({ raw, isStreaming = false }: { raw: string; isStreaming?: boolean }) {
  const [view, setView] = useState<'tree' | 'raw'>('tree');
  const presentation = useMemo(() => isStreaming ? { tree: null, reason: 'Response is streaming. Showing original raw text.' } : inspectJson(raw), [raw, isStreaming]);
  const { status, copy } = useExactCopy();
  const treeVisible = Boolean(presentation.tree) && view === 'tree';
  return <section aria-label="Assistant JSON" className="my-3 min-w-0 rounded-xl border border-theme-border bg-theme-surface-raised">
    <div className="flex flex-wrap items-center gap-1 border-b border-theme-border px-2 py-1">
      <span className="mr-auto px-1 text-xs font-semibold text-theme-text">JSON</span>
      <button type="button" className={controlClass} disabled={!presentation.tree} aria-pressed={treeVisible} onClick={() => setView('tree')}>Tree</button>
      <button type="button" className={controlClass} aria-pressed={!treeVisible} onClick={() => setView('raw')}>Raw</button>
      <button type="button" className={controlClass} aria-label="Copy original JSON" onClick={() => void copy(raw)}>{status === 'Copied' ? <Check size={14} /> : <Copy size={14} />}Copy</button>
    </div>
    <p className="px-3 pt-2 text-xs text-theme-text-muted">{presentation.reason || 'Raw text is authoritative. Tree preserves number tokens and every duplicate key.'}</p>
    {/* eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex -- a scrollable region must be keyboard-focusable (WCAG 2.1.1) */}
    <div className="max-h-[28rem] min-w-0 overflow-auto overscroll-contain p-3 font-mono text-xs text-theme-text" tabIndex={0} role="region" aria-label={treeVisible ? 'JSON tree' : 'Original JSON'}>
      {treeVisible && presentation.tree ? <JsonBranch node={presentation.tree} /> : <pre className="m-0 whitespace-pre">{raw}</pre>}
    </div>
    <span role="status" className="px-3 text-xs text-theme-text-muted">{status}</span>
  </section>;
}

function visibleCellText(element: Node): string {
  if (element.nodeType === Node.TEXT_NODE) return element.textContent || '';
  if (element instanceof HTMLBRElement) return '\n';
  return Array.from(element.childNodes).map(visibleCellText).join('');
}

export function visibleTableTsv(table: HTMLTableElement): string {
  const quote = (text: string) => /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  return Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => quote(cell.innerText ?? visibleCellText(cell))).join('\t')).join('\n');
}

export function MarkdownTable({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const table = useRef<HTMLTableElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const title = useId();
  const { status, copy } = useExactCopy();
  const copyTable = () => { if (table.current) void copy(visibleTableTsv(table.current)); };
  const controls = <>
    <button type="button" className={controlClass} onClick={copyTable} aria-label="Copy table as TSV"><Copy size={14} />Copy TSV</button>
    <span role="status" className="text-xs text-theme-text-muted">{status}</span>
  </>;
  return <section aria-label="Markdown table" className="my-3 min-w-0 rounded-xl border border-theme-border bg-theme-surface-raised">
    <div className="flex flex-wrap items-center gap-1 border-b border-theme-border px-2 py-1">
      {controls}
      <button type="button" className={`${controlClass} ml-auto`} aria-label="Expand table" aria-haspopup="dialog" onClick={() => setExpanded(true)}><Maximize2 size={14} />Expand</button>
    </div>
    {/* eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex -- a scrollable region must be keyboard-focusable (WCAG 2.1.1) */}
    <div className="max-h-[28rem] overflow-auto overscroll-contain rounded-b-xl" role="region" aria-label="Scrollable table" tabIndex={0}>
      <table ref={table} className="w-full text-sm">{children}</table>
    </div>
    <ViewportModal open={expanded} onDismiss={() => setExpanded(false)} initialFocusRef={close} className="flex items-center justify-center bg-black/60 p-3 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby={title} className="flex max-h-[calc(100dvh-3rem)] w-full max-w-[100rem] min-w-0 flex-col rounded-2xl border border-theme-border bg-theme-surface shadow-xl">
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-theme-border px-3 py-2">
          <h2 id={title} className="mr-auto text-sm font-semibold text-theme-text">Expanded table</h2>
          {controls}
          <button ref={close} type="button" className={controlClass} aria-label="Close expanded table" onClick={() => setExpanded(false)}><X size={16} /></button>
        </header>
        {/* eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex -- a scrollable region must be keyboard-focusable (WCAG 2.1.1) */}
        <div className="min-h-0 overflow-auto overscroll-contain p-2" role="region" aria-label="Expanded table content" tabIndex={0}>
          <table className="w-full text-sm">{children}</table>
        </div>
      </section>
    </ViewportModal>
  </section>;
}
