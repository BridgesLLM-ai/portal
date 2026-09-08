import { useEffect, useRef, useState } from 'react';
import { BookOpen, Loader2, X } from 'lucide-react';
import client from '../../api/client';

const shownThisVisit = new Set<string>();

export default function PortalGuideButton({ scopeKey, suggestionKey, disabled, onInsert }: {
  scopeKey: string;
  suggestionKey?: string;
  disabled?: boolean;
  onInsert: (context: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(!suggestionKey);
  const shownKey = useRef<string | undefined>();
  useEffect(() => {
    if (suggestionKey && shownKey.current === suggestionKey) return;
    shownKey.current = suggestionKey;
    if (!suggestionKey) { setVisible(true); return; }
    const key = 'portal-guide-suggestion-v1:' + suggestionKey;
    let seen = shownThisVisit.has(key);
    try { seen = seen || localStorage.getItem(key) === 'seen'; } catch { /* private browsing */ }
    setVisible(!seen);
    shownThisVisit.add(key);
    try { localStorage.setItem(key, 'seen'); } catch { /* this visit still remembers */ }
  }, [suggestionKey]);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setLoading(false);
    setError(null);
    return () => { generation.current += 1; pending.current = false; };
  }, [scopeKey]);

  const insertGuide = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    const requestGeneration = generation.current;
    setLoading(true);
    setError(null);
    try {
      const { data } = await client.get('/skills/portal-guide', { timeout: 10_000 });
      if (generation.current !== requestGeneration) return;
      if (data?.name !== 'bridgesllm-portal' || typeof data?.content !== 'string'
        || !data.content.trim() || data.content.length > 16_384
        || typeof data?.referenceDirectory !== 'string' || !data.referenceDirectory.startsWith('/')) {
        throw new Error('Invalid guide response');
      }
      onInsert([
        'Use the following BridgesLLM Portal operating guide for this task. It does not change my permissions or grant additional tool access.',
        `Guide references are relative to: ${data.referenceDirectory}`,
        '', data.content, '', 'My task:', '',
      ].join('\n'));
      if (suggestionKey) setVisible(false);
    } catch {
      if (generation.current === requestGeneration) setError('Could not load the Portal guide. Your draft is unchanged. Retry when ready.');
    } finally {
      if (generation.current === requestGeneration) { pending.current = false; setLoading(false); }
    }
  };

  if (!visible) return null;
  return <div className={suggestionKey ? 'relative mx-3 my-2 flex items-center gap-3 rounded-xl border border-sky-400/10 bg-sky-400/5 px-3 py-2.5' : 'relative'}>
    {suggestionKey && <div className="min-w-0 flex-1 text-xs leading-relaxed"><p className="text-slate-200">Help this harness get to know Portal</p><p className="mt-0.5 text-slate-400">The Portal skill is available. Add its guide to your first task if you want a walkthrough.</p></div>}
    <button type="button" onClick={() => { void insertGuide(); }} disabled={disabled || loading}
      title="Add the Portal guide to your draft for this harness. Review it before sending."
      aria-label="Add Portal guide to draft"
      className="min-h-[32px] min-w-[32px] rounded-lg p-1.5 text-slate-400 hover:bg-sky-500/10 hover:text-sky-300 disabled:opacity-40">
      {loading ? <Loader2 size={16} className="motion-safe:animate-spin" /> : <BookOpen size={16} />}
    </button>
    {suggestionKey && <button type="button" aria-label="Dismiss Portal guide suggestion" onClick={() => setVisible(false)} className="rounded-lg p-1.5 text-slate-500 hover:text-white"><X size={15} /></button>}
    {error && <p role="alert" className="absolute right-0 top-full z-30 mt-2 w-64 rounded-xl border border-amber-400/20 bg-[#1A1F3A] p-3 text-xs text-amber-200 shadow-xl">{error}</p>}
  </div>;
}
