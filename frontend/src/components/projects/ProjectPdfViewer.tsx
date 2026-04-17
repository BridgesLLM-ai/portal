import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export default function ProjectPdfViewer({ src }: { src: string }) {
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<{ data: Uint8Array } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  useEffect(() => {
    let cancelled = false;
    fetch(src, { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buf => { if (!cancelled) setPdfData({ data: new Uint8Array(buf) }); })
      .catch(err => { if (!cancelled) setError(err.message || 'Failed to load PDF'); });
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(containerRef.current);
    setContainerWidth(containerRef.current.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!pdfData && !error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-slate-500" />
        <span className="ml-2 text-sm text-slate-500">Loading PDF…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <AlertCircle size={24} className="text-red-400" />
        <span className="text-red-400 text-sm">{error}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-[#2a2a2a]">
      <Document
        file={pdfData}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        onLoadError={(err) => setError(err.message || 'Failed to render PDF')}
        loading={
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-slate-500" />
            <span className="ml-2 text-sm text-slate-500">Rendering pages…</span>
          </div>
        }
      >
        {numPages > 0 && Array.from({ length: numPages }, (_, i) => (
          <div key={i} className="flex justify-center py-2">
            <Page
              pageNumber={i + 1}
              width={Math.min(containerWidth - 32, 1200)}
              renderTextLayer={true}
              renderAnnotationLayer={true}
            />
          </div>
        ))}
      </Document>
      {numPages > 0 && (
        <div className="sticky bottom-0 text-center py-2 bg-[#2a2a2a]/90 backdrop-blur-sm text-xs text-slate-500">
          {numPages} page{numPages !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
