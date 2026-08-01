import { useState } from 'react';
import { AlertCircle, Download, Loader2 } from 'lucide-react';

export default function ProjectTextPreviewViewer({ src, name }: { src: string; name: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  return (
    <div className="flex-1 flex flex-col bg-theme-surface overflow-hidden">
      {!loaded && !error && (
        <div className="flex-1 flex items-center justify-center gap-3 bg-theme-surface text-theme-text-muted">
          <Loader2 size={22} className="animate-spin" />
          <div className="text-sm">
            <div className="text-theme-text">Loading preview…</div>
            <div className="text-xs text-slate-500">This file is too large for inline editing, so it is opening read-only.</div>
          </div>
        </div>
      )}
      {error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-theme-surface text-theme-text-muted">
          <AlertCircle size={24} className="text-red-400" />
          <div className="text-center">
            <div className="text-sm text-theme-text">Could not load text preview</div>
            <div className="text-xs text-slate-500">Try downloading {name} instead.</div>
          </div>
          <a href={src} download className="px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30 inline-flex items-center gap-2">
            <Download size={14} /> Download
          </a>
        </div>
      ) : (
        <iframe
          title={`${name} preview`}
          src={src}
          className={`flex-1 w-full border-0 ${loaded ? 'block' : 'hidden'}`}
          onLoad={() => setLoaded(true)}
          onError={() => { setError(true); setLoaded(false); }}
        />
      )}
    </div>
  );
}
