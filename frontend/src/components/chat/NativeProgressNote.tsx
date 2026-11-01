import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Activity } from 'lucide-react';
import type { NativeProgress } from '../../utils/nativeProgress';
import { safeLink } from './toolCards/safeDisplay';

/** Native progress, using Portal chrome. No HTML, images, actions or invented counts. */
export default function NativeProgressNote({ progress }: { progress: NativeProgress }) {
  if (!progress.note && !progress.measure) return null;
  return <section aria-label="Agent progress" className="mb-3 min-w-0 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-bg-subtle)] p-3">
    <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-[var(--accent-light)]"><Activity size={13} aria-hidden="true" />Agent progress</div>
    {progress.measure && <div className="mb-2.5">
      <div className="mb-1.5 break-words text-xs font-medium text-slate-200">{progress.measure.label}</div>
      <progress aria-label={progress.measure.label} value={progress.measure.value} max={progress.measure.max} className="native-progress-meter block h-1.5 w-full overflow-hidden rounded-full accent-[var(--accent-light)]" />
    </div>}
    {progress.note && <div className="space-y-2 break-words text-xs leading-relaxed text-slate-300 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_table]:w-full [&_td]:border-b [&_td]:border-white/5 [&_td]:py-1 [&_th]:text-left [&_pre]:overflow-auto">
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => { const safe = safeLink(href); return safe?.href ? <a href={safe.href} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--accent-light)] underline underline-offset-2">{children}</a> : <span>{children}</span>; },
        img: ({ alt }) => <span>{alt}</span>,
        input: ({ checked }) => <span aria-label={checked ? 'Completed' : 'Pending'}>{checked ? '✓' : '○'}</span>,
      }}>{progress.note}</ReactMarkdown>
    </div>}
  </section>;
}
