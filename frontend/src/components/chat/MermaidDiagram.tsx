import { useEffect, useId, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Check, Code2, Copy, GitBranch, Loader2 } from 'lucide-react';

let renderer: Promise<typeof import('mermaid')['default']> | undefined;
let renderQueue: Promise<unknown> = Promise.resolve();

function loadRenderer() {
  if (!renderer) renderer = import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'dark',
      maxTextSize: 50_000, maxEdges: 500,
      // Global SVG labels survive sanitization; per-diagram settings are insufficient.
      htmlLabels: false,
      flowchart: { htmlLabels: false }, class: { htmlLabels: false },
      secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels'],
    });
    return mermaid;
  }).catch(error => { renderer = undefined; throw error; });
  return renderer;
}

/** Render locally, then isolate the resulting SVG in a scriptless, networkless frame. */
export async function renderMermaidDocument(source: string, id: string) {
  if (source.length > 50_000) throw new Error('Diagram is too large');
  const operation = renderQueue.catch(() => undefined).then(async () => {
    const mermaid = await loadRenderer();
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden';
    document.body.appendChild(container);
    try {
      const { svg } = await mermaid.render(id, source, container);
      const clean = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'a', 'image', 'script'],
        FORBID_ATTR: ['href', 'xlink:href'],
      });
      const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
      const viewBox = parsed.documentElement.getAttribute('viewBox')?.split(/\s+/).map(Number);
      const aspect = viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0 ? viewBox[3] / viewBox[2] : 0.5;
      const height = Math.max(160, Math.min(600, Math.round(640 * aspect + 24)));
      return {
        height,
        document: '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src \'none\'; font-src \'none\'; form-action \'none\'; base-uri \'none\'"><style>body{margin:0;padding:12px;background:#111827;color:#e2e8f0;text-align:center}svg{max-width:100%;height:auto}*{box-sizing:border-box}</style></head><body>' + clean + '</body></html>',
      };
    } finally {
      container.remove();
      document.getElementById('d' + id)?.remove(); // Mermaid's parse-error scratch node.
    }
  });
  renderQueue = operation;
  return operation;
}

export default function MermaidDiagram({ source, isStreaming }: { source: string; isStreaming?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const generation = useRef(0);
  const [diagram, setDiagram] = useState<{ document: string; height: number } | null>(null);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const stableSource = useMemo(() => source.trim(), [source]);
  useEffect(() => {
    const current = ++generation.current;
    setError(false);
    setDiagram(null);
    // Don't parse every token of an unfinished diagram.
    if (isStreaming) return;
    void renderMermaidDocument(stableSource, 'mermaid-' + id + '-' + current).then(result => {
      if (generation.current === current) setDiagram(result);
    }).catch(() => { if (generation.current === current) setError(true); });
    return () => { generation.current += 1; };
  }, [stableSource, isStreaming, id]);
  return <figure className="my-3 overflow-hidden rounded-xl border border-sky-400/15 bg-[#111827]">
    <figcaption className="flex items-center gap-2 border-b border-white/5 px-3 py-2 text-xs text-slate-400">
      <GitBranch size={14} aria-hidden="true" /><span className="flex-1">Mermaid diagram</span>
      <button type="button" onClick={() => setSourceVisible(v => !v)} aria-pressed={sourceVisible} aria-label="Show diagram source" className="rounded-md p-1.5 hover:bg-white/5"><Code2 size={14} /></button>
      <button type="button" aria-label="Copy diagram source" className="rounded-md p-1.5 hover:bg-white/5" onClick={() => {
        void navigator.clipboard.writeText(source).then(() => setCopied(true)).catch(() => setCopied(false));
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    </figcaption>
    {!sourceVisible && diagram && <iframe title="Mermaid diagram" sandbox="" referrerPolicy="no-referrer"
      srcDoc={diagram.document} style={{ height: diagram.height }} className="block w-full border-0" />}
    {!sourceVisible && !diagram && !error && <p role="status" className="flex items-center gap-2 px-3 py-4 text-xs text-slate-400">
      <Loader2 size={14} className="motion-safe:animate-spin" />{isStreaming ? 'Diagram is being written…' : 'Rendering diagram…'}</p>}
    {error && <p role="status" className="px-3 pt-3 text-xs text-slate-400">This diagram could not be rendered. Its source is preserved below.</p>}
    {(sourceVisible || error) && <pre className="overflow-x-auto whitespace-pre p-3 text-xs leading-relaxed text-slate-300"><code>{source}</code></pre>}
  </figure>;
}
