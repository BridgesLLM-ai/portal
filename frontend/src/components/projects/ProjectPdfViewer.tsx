import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export default function ProjectPdfViewer({ src }: { src: string }) {
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);
  const pdfFile = useMemo(() => ({ url: src, withCredentials: true }), [src]);

  useEffect(() => {
    setNumPages(0);
    setPageNumber(1);
    setError(null);
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

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <AlertCircle size={24} className="text-red-400" />
        <span className="text-red-400 text-sm">{error}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-theme-surface-strong" aria-label="PDF preview">
      <Document
        key={src}
        file={pdfFile}
        onLoadSuccess={({ numPages: n }) => {
          setNumPages(n);
          setPageNumber(1);
          setError(null);
        }}
        onLoadError={(err) => setError(err.message || 'Failed to render PDF')}
        loading={
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-slate-500" />
            <span className="ml-2 text-sm text-slate-500">Rendering pages…</span>
          </div>
        }
      >
        {numPages > 0 && (
          <div className="flex justify-center py-2">
            <Page
              pageNumber={pageNumber}
              width={Math.min(containerWidth - 32, 1200)}
              renderTextLayer={true}
              renderAnnotationLayer={true}
            />
          </div>
        )}
      </Document>
      {numPages > 0 && (
        <div className="sticky bottom-0 flex items-center justify-center gap-3 py-2 bg-theme-surface/95 backdrop-blur-sm text-xs text-theme-text">
          <button
            type="button"
            aria-label="Previous PDF page"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
            className="inline-flex size-8 items-center justify-center rounded bg-white/5 hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronLeft size={15} />
          </button>
          <span>Page {pageNumber} of {numPages}</span>
          <button
            type="button"
            aria-label="Next PDF page"
            disabled={pageNumber >= numPages}
            onClick={() => setPageNumber((current) => Math.min(numPages, current + 1))}
            className="inline-flex size-8 items-center justify-center rounded bg-white/5 hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
