import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import {
  X, Download, ZoomIn, ZoomOut, Maximize2, Minimize2,
  ChevronLeft, ChevronRight, RotateCw, Loader2, AlertCircle,
  FileText, FileCode, File as FileIcon, Copy, Trash2, Edit3,
  Volume2, Image as ImageIcon, Film, Music,
} from 'lucide-react';
import { useFileContent } from '../hooks/useFileContent';
import { useTheme } from '../contexts/ThemeContext';
import ViewportModal from './ViewportModal';
import {
  MAX_SPREADSHEET_FILE_BYTES,
  formatSpreadsheetCell,
  parseSpreadsheetWorkbook,
  type ParsedSpreadsheetWorkbook,
} from '../utils/spreadsheet';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// ─── Types ───────────────────────────────────────────────────
interface FileEntry {
  id: string;
  path: string;
  originalName?: string;
  size: number;
  mimeType?: string;
  visibility: string;
  createdAt: string;
}

interface MediaViewerProps {
  file: FileEntry;
  files?: FileEntry[];          // all files for next/prev navigation
  onClose: () => void;
  onNavigate?: (file: FileEntry) => void;
  onDelete?: (id: string) => void;
  onRename?: (file: FileEntry) => void;
  onCopyToProject?: (file: FileEntry) => void;
  downloadUrl: (id: string) => string;
  copyAIUrl?: (file: FileEntry) => void;
}

// ─── Helpers ─────────────────────────────────────────────────
function getDisplayName(file: FileEntry): string {
  if (file.originalName) return file.originalName;
  const name = file.path.split('/').pop() || file.path;
  return name.replace(/-\d{13}-\d+(?=\.[^.]+$)/, '');
}

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileCategory(mime?: string, filename?: string): 'image' | 'video' | 'audio' | 'pdf' | 'excel' | 'text' | 'code' | 'markdown' | 'unknown' {
  const ext = filename?.split('.').pop()?.toLowerCase();

  if (ext === 'csv') return 'text';

  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mime === 'application/vnd.ms-excel') return 'excel';
    if (mime.includes('markdown')) return 'markdown';

    const codeTypes = [
      'javascript', 'typescript', 'json', 'html', 'css', 'xml', 'yaml', 'yml',
      'python', 'java', 'c', 'cpp', 'rust', 'go', 'ruby', 'php', 'shell', 'bash',
      'sql', 'graphql', 'toml', 'ini', 'dockerfile',
    ];
    if (codeTypes.some(t => mime.includes(t))) return 'code';
  }

  if (ext) {
    if (['md', 'markdown', 'mdx'].includes(ext)) return 'markdown';
    if (['pdf'].includes(ext)) return 'pdf';
    if (['xlsx', 'xls', 'xlsm'].includes(ext)) return 'excel';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma'].includes(ext)) return 'audio';
    if (['js', 'jsx', 'ts', 'tsx', 'json', 'html', 'htm', 'css', 'scss', 'xml', 'yaml', 'yml', 'py', 'rb', 'php', 'java', 'go', 'rs', 'cpp', 'c', 'h', 'sh', 'bash', 'sql', 'graphql', 'toml', 'ini'].includes(ext)) return 'code';
  }

  if (mime?.startsWith('text/')) return 'text';
  if (mime === 'application/json') return 'code';

  return 'unknown';
}

function getCategoryIcon(cat: string) {
  switch (cat) {
    case 'image': return ImageIcon;
    case 'video': return Film;
    case 'audio': return Music;
    case 'pdf': return FileText;
    case 'code': return FileCode;
    case 'text':
    case 'markdown': return FileText;
    default: return FileIcon;
  }
}

function getMonacoLanguage(mime?: string, filename?: string): string {
  if (!mime && !filename) return 'plaintext';
  const ext = filename?.split('.').pop()?.toLowerCase();
  
  const extMap: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', html: 'html', htm: 'html', css: 'css', scss: 'scss',
    xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    py: 'python', rb: 'ruby', php: 'php', java: 'java', go: 'go',
    rs: 'rust', cpp: 'cpp', c: 'c', h: 'c', sh: 'shell', bash: 'shell',
    sql: 'sql', graphql: 'graphql', toml: 'plaintext', ini: 'ini',
    dockerfile: 'dockerfile', makefile: 'plaintext',
  };
  
  if (ext && extMap[ext]) return extMap[ext];
  if (mime?.includes('javascript')) return 'javascript';
  if (mime?.includes('typescript')) return 'typescript';
  if (mime?.includes('json')) return 'json';
  if (mime?.includes('html')) return 'html';
  if (mime?.includes('css')) return 'css';
  if (mime?.includes('python')) return 'python';
  if (mime?.includes('xml')) return 'xml';
  if (mime?.includes('yaml')) return 'yaml';
  if (mime?.includes('markdown')) return 'markdown';
  return 'plaintext';
}

// ─── Image Viewer ────────────────────────────────────────────
function ImageViewer({ blobUrl, name }: { blobUrl: string; name: string }) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const containerRef = useRef<HTMLButtonElement>(null);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.max(0.1, Math.min(10, z + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return;
    setDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  }, [zoom, position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [dragging, dragStart]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  const resetView = () => { setZoom(1); setPosition({ x: 0, y: 0 }); setRotation(0); };

  return (
    <div className="flex flex-col h-full">
      {/* Image controls */}
      <div className="flex items-center justify-center gap-1 py-2 bg-theme-surface-raised backdrop-blur-sm border-b border-theme-border">
        <button onClick={() => setZoom(z => Math.max(0.1, z - 0.25))} className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors" title="Zoom out">
          <ZoomOut size={16} />
        </button>
        <span className="text-xs text-slate-400 w-14 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(10, z + 0.25))} className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors" title="Zoom in">
          <ZoomIn size={16} />
        </button>
        <div className="w-px h-4 bg-white/10 mx-1" />
        <button onClick={() => setRotation(r => r + 90)} className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors" title="Rotate">
          <RotateCw size={16} />
        </button>
        <button onClick={resetView} className="px-2 py-1 text-xs rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors">
          Reset
        </button>
      </div>

      {/* Image area */}
      <button
        type="button"
        ref={containerRef}
        aria-label="Image viewer. Use arrow keys to pan and plus or minus to zoom."
        className="flex-1 overflow-hidden flex items-center justify-center border-0 bg-[#0a0a0a] p-0 cursor-grab active:cursor-grabbing select-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={() => zoom === 1 ? setZoom(2) : resetView()}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 50 : 10;
          if (event.key === 'ArrowLeft') setPosition((current) => ({ ...current, x: current.x - delta }));
          else if (event.key === 'ArrowRight') setPosition((current) => ({ ...current, x: current.x + delta }));
          else if (event.key === 'ArrowUp') setPosition((current) => ({ ...current, y: current.y - delta }));
          else if (event.key === 'ArrowDown') setPosition((current) => ({ ...current, y: current.y + delta }));
          else if (event.key === '+' || event.key === '=') setZoom((current) => Math.min(10, current + 0.25));
          else if (event.key === '-') setZoom((current) => Math.max(0.25, current - 0.25));
          else return;
          event.preventDefault();
        }}
      >
        <img
          src={blobUrl}
          alt={name}
          className="max-w-none transition-transform duration-100"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${zoom}) rotate(${rotation}deg)`,
            maxWidth: zoom <= 1 ? '100%' : 'none',
            maxHeight: zoom <= 1 ? '100%' : 'none',
          }}
          draggable={false}
        />
      </button>
    </div>
  );
}

// ─── Text/Code Viewer ────────────────────────────────────────
function TextViewer({ blob, mime, filename }: { blob: Blob; mime?: string; filename?: string }) {
  const { resolvedTheme } = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const text = await blob.text();
        if (!cancelled) {
          // Limit display to 500KB for performance
          setContent(text.length > 500_000 ? text.slice(0, 500_000) + '\n\n... [truncated at 500KB]' : text);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [blob]);

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-slate-500" /></div>;
  if (error) return <div className="flex items-center justify-center h-full text-red-400">{error}</div>;

  const lang = getMonacoLanguage(mime, filename);
  const isMarkdown = lang === 'markdown';

  return (
    <div className="h-full overflow-auto bg-theme-surface">
      {isMarkdown ? (
        <div className="p-8 max-w-4xl mx-auto">
          <article className={`prose prose-slate prose-sm md:prose-base lg:prose-lg max-w-none ${resolvedTheme === 'dark' ? 'prose-invert' : ''}
            prose-headings:font-bold prose-headings:text-theme-text
            prose-h1:text-3xl prose-h1:border-b prose-h1:border-theme-border prose-h1:pb-2 prose-h1:mb-4
            prose-h2:text-2xl prose-h2:border-b prose-h2:border-theme-border prose-h2:pb-2 prose-h2:mt-8 prose-h2:mb-4
            prose-h3:text-xl prose-h3:mt-6 prose-h3:mb-3
            prose-p:text-slate-300 prose-p:leading-relaxed
            prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
            prose-strong:text-theme-text prose-strong:font-semibold
            prose-code:text-emerald-400 prose-code:bg-white/5 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none
            prose-pre:bg-theme-surface-strong prose-pre:border prose-pre:border-theme-border prose-pre:rounded-lg
            prose-blockquote:border-l-4 prose-blockquote:border-blue-500/30 prose-blockquote:bg-blue-500/5 prose-blockquote:py-2 prose-blockquote:px-4 prose-blockquote:not-italic prose-blockquote:text-slate-300
            prose-ul:text-slate-300 prose-ol:text-slate-300
            prose-li:marker:text-slate-500
            prose-table:border prose-table:border-theme-border prose-table:rounded-lg prose-table:overflow-hidden
            prose-thead:bg-theme-surface-raised prose-thead:border-b prose-thead:border-theme-border
            prose-th:px-4 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-th:text-theme-text
            prose-td:px-4 prose-td:py-2 prose-td:border-t prose-td:border-theme-border
            prose-img:rounded-lg prose-img:border prose-img:border-theme-border
            prose-hr:border-theme-border`}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                // Custom checkbox rendering for task lists
                input: ({ node: _node, ...props }) => {
                  if (props.type === 'checkbox') {
                    return (
                      <input
                        {...props}
                        aria-label={props.checked ? 'Completed task' : 'Incomplete task'}
                        disabled
                        className="mr-2 accent-emerald-500 cursor-default"
                      />
                    );
                  }
                  return <input {...props} aria-label="Document form field" />;
                },
              }}
            >
              {content || ''}
            </ReactMarkdown>
          </article>
        </div>
      ) : (
        <div className="relative">
          <div className="absolute top-2 right-3 z-10">
            <span className="text-[10px] px-2 py-1 rounded bg-white/10 text-slate-400 font-mono">{lang}</span>
          </div>
          <pre className="p-4 text-sm font-mono leading-relaxed text-slate-300 overflow-x-auto">
            <code>{content}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── PDF Viewer (react-pdf, renders all pages) ─────────────
function PdfViewer({ blob, name: _name }: { blob: Blob; name: string }) {
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<{ data: Uint8Array } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  // Convert blob to ArrayBuffer so PDF.js worker doesn't need to fetch a blob URL
  useEffect(() => {
    let cancelled = false;
    blob.arrayBuffer().then(buf => {
      if (!cancelled) setPdfData({ data: new Uint8Array(buf) });
    }).catch(err => {
      if (!cancelled) setError(err.message || 'Failed to read PDF');
    });
    return () => { cancelled = true; };
  }, [blob]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(containerRef.current);
    setContainerWidth(containerRef.current.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!pdfData && !error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-slate-500" />
        <span className="ml-2 text-sm text-slate-500">Loading PDF…</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full overflow-auto bg-theme-surface-strong">
      <Document
        file={pdfData}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        onLoadError={(err) => setError(err.message || 'Failed to load PDF')}
        loading={
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-slate-500" />
            <span className="ml-2 text-sm text-slate-500">Rendering pages…</span>
          </div>
        }
        error={
          <div className="flex flex-col items-center justify-center h-full gap-2 p-4">
            <AlertCircle size={24} className="text-red-400" />
            <span className="text-red-400 text-sm">{error || 'Failed to load PDF'}</span>
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
        <div className="sticky bottom-0 text-center py-2 bg-theme-surface/90 backdrop-blur-sm text-xs text-theme-text-muted">
          {numPages} page{numPages !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

const INITIAL_ROWS = 500;
const LOAD_MORE_ROWS = 500;
const WARN_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// ─── Excel Viewer ────────────────────────────────────────────
function ExcelViewer({ blob, name }: { blob: Blob; name: string }) {
  const [workbook, setWorkbook] = useState<ParsedSpreadsheetWorkbook | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [visibleRows, setVisibleRows] = useState(INITIAL_ROWS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sizeWarningAccepted, setSizeWarningAccepted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadBlob() {
      try {
        setLoading(true);
        setError(null);
        setWorkbook(null);
        setActiveSheet(0);
        setVisibleRows(INITIAL_ROWS);
        if (/\.xls$/i.test(name)) {
          setError('Legacy .xls files are not parsed in the browser. Convert this file to .xlsx or download it instead.');
          setLoading(false);
          return;
        }
        if (blob.size > MAX_SPREADSHEET_FILE_BYTES) {
          setError(`File is too large (${(blob.size / 1024 / 1024).toFixed(1)}MB). Please download it instead.`);
          setLoading(false);
          return;
        }
        if (blob.size > WARN_FILE_SIZE && !sizeWarningAccepted) {
          setLoading(false);
          return; // Show warning UI
        }
        const parsed = await parseSpreadsheetWorkbook(blob);
        if (!cancelled) setWorkbook(parsed);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to parse spreadsheet');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadBlob();
    return () => { cancelled = true; };
  }, [blob, name, sizeWarningAccepted]);

  function handleSheetChange(i: number) {
    if (!workbook?.sheets[i] || i === activeSheet) return;
    setActiveSheet(i);
    setVisibleRows(INITIAL_ROWS);
  }

  // Size warning gate
  if (!loading && blob.size > WARN_FILE_SIZE && !sizeWarningAccepted && !error) {
    return (
      <div className="h-full flex items-center justify-center bg-theme-surface">
        <div className="text-center space-y-3 p-6 max-w-sm">
          <AlertCircle size={32} className="text-amber-400 mx-auto" />
          <p className="text-amber-300 text-sm font-medium">Large File Warning</p>
          <p className="text-slate-400 text-xs">This file is {(blob.size / 1024 / 1024).toFixed(1)}MB. Previewing may be slow.</p>
          <button onClick={() => setSizeWarningAccepted(true)}
            className="px-4 py-1.5 text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded hover:bg-amber-500/30 transition-colors">
            Load Preview Anyway
          </button>
        </div>
      </div>
    );
  }

  if (loading) return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <Loader2 size={24} className="animate-spin text-slate-500" />
      <span className="text-xs text-slate-500">Parsing spreadsheet safely…</span>
    </div>
  );
  if (error) return (
    <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
      <AlertCircle size={20} className="text-red-400" />
      <span className="text-red-400 text-sm">{error}</span>
      {blob.size > 0 && <span className="text-slate-500 text-xs">File size: {(blob.size / 1024 / 1024).toFixed(1)}MB</span>}
    </div>
  );

  const sheet = workbook?.sheets[activeSheet];
  const data = sheet?.data || [];
  const columnCount = Math.max(0, Math.min(sheet?.totalColumns || 0, 256));
  const columns = Array.from({ length: columnCount }, (_, index) => index);
  const rows = data.slice(1, visibleRows + 1);
  const hasMore = data.length > visibleRows + 1;

  return (
    <div className="h-full flex flex-col bg-theme-surface">
      {/* Info bar */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-theme-border bg-theme-surface-raised text-[10px] text-theme-text-muted shrink-0">
        <span>{(sheet?.totalRows || 0).toLocaleString()} rows · {workbook?.sheets.length || 0} sheet{workbook?.sheets.length !== 1 ? 's' : ''} · {(blob.size / 1024).toFixed(0)}KB</span>
        {sheet?.truncated && <span className="text-amber-400/70">Preview safely limited to 5,000 rows / 256 columns</span>}
      </div>
      {/* Sheet tabs */}
      {(workbook?.sheets.length || 0) > 1 && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-theme-border bg-theme-surface-raised overflow-x-auto shrink-0" role="tablist" aria-label={`Sheets in ${name}`}>
          {workbook?.sheets.map((candidate, i) => (
            <button
              key={`${candidate.name}-${i}`}
              role="tab"
              aria-selected={i === activeSheet}
              onClick={() => handleSheetChange(i)}
              className={`px-3 py-1 text-xs rounded transition-colors whitespace-nowrap ${
                i === activeSheet
                  ? 'accent-active border'
                  : 'text-slate-400 hover:bg-white/10 hover:text-white'
              }`}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      )}
      {/* Table */}
      <div className="flex-1 overflow-auto">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">Empty sheet</div>
        ) : (
          <>
            <table className="w-full text-xs text-slate-300 border-collapse">
              <caption className="sr-only">Spreadsheet data for {name}, sheet {sheet?.name || activeSheet + 1}</caption>
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="bg-theme-surface-strong border border-theme-border px-2 py-1.5 text-theme-text-muted font-normal text-center w-10">#</th>
                  {columns.map((ci) => (
                    <th key={ci} className="bg-theme-surface-strong border border-theme-border px-3 py-1.5 text-left font-semibold text-theme-text whitespace-nowrap">
                      {formatSpreadsheetCell(data[0]?.[ci]) || `Column ${ci + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri} className="hover:bg-white/[0.03]">
                    <td className="bg-theme-surface-raised border border-theme-border px-2 py-1 text-theme-text-muted text-center tabular-nums">{ri + 2}</td>
                    {columns.map((ci) => (
                      <td key={ci} className="border border-theme-border px-3 py-1 whitespace-nowrap">
                        {formatSpreadsheetCell(row[ci])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {hasMore && (
              <div className="flex items-center justify-center py-3 border-t border-white/5">
                <button
                  onClick={() => setVisibleRows(v => v + LOAD_MORE_ROWS)}
                  className="px-4 py-1.5 text-xs bg-white/5 text-slate-400 rounded hover:bg-white/10 hover:text-white transition-colors"
                >
                  Load more rows ({Math.min(LOAD_MORE_ROWS, Math.max(0, data.length - 1 - visibleRows)).toLocaleString()} more)
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main MediaViewer ────────────────────────────────────────
export default function MediaViewer({
  file, files = [], onClose, onNavigate, onDelete, onRename,
  onCopyToProject, downloadUrl, copyAIUrl,
}: MediaViewerProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  
  const { blobUrl, blob, loading, error } = useFileContent(file.id, file.mimeType);
  
  const name = getDisplayName(file);
  const category = getFileCategory(file.mimeType, name);
  const CatIcon = getCategoryIcon(category);

  // Navigation
  const currentIndex = files.findIndex(f => f.id === file.id);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < files.length - 1;
  
  const goPrev = useCallback(() => {
    if (hasPrev && onNavigate) onNavigate(files[currentIndex - 1]);
  }, [hasPrev, currentIndex, files, onNavigate]);
  
  const goNext = useCallback(() => {
    if (hasNext && onNavigate) onNavigate(files[currentIndex + 1]);
  }, [hasNext, currentIndex, files, onNavigate]);

  // Fullscreen
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3">
          <Loader2 size={36} className="animate-spin text-emerald-400" />
          <span className="text-sm text-slate-400">Loading {name}...</span>
        </div>
      );
    }
    
    // Excel and text viewers use the blob directly — handle before blobUrl check
    // Blob-based viewers — handle before blobUrl null check
    if (category === 'excel' || category === 'pdf') {
      if (!blob) return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
          <AlertCircle size={48} className="text-red-400/60" />
          <p className="font-medium text-red-300">Failed to load file</p>
          {error && <p className="text-xs text-red-400/80">{error}</p>}
          <a href={downloadUrl(file.id)} className="mt-2 px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30 transition-colors">
            <Download size={14} className="inline mr-1.5" /> Download instead
          </a>
        </div>
      );
      if (category === 'excel') return <ExcelViewer blob={blob} name={name} />;
      return <PdfViewer blob={blob} name={name} />;
    }

    if ((category === 'code' || category === 'text' || category === 'markdown') && blob) {
      return <TextViewer blob={blob} mime={file.mimeType} filename={name} />;
    }

    if (error || !blobUrl) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
          <AlertCircle size={48} className="text-red-400/60" />
          <p className="font-medium text-red-300">Failed to load file</p>
          {error && <p className="text-xs text-red-400/80">{error}</p>}
          <a
            href={downloadUrl(file.id)}
            className="mt-2 px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30 transition-colors"
          >
            <Download size={14} className="inline mr-1.5" /> Download instead
          </a>
        </div>
      );
    }

    switch (category) {
      case 'image':
        return <ImageViewer blobUrl={blobUrl} name={name} />;
      
      case 'video':
        return (
          <div className="flex items-center justify-center h-full bg-black p-4">
            <video
              src={blobUrl}
              aria-label={`Video preview for ${name}`}
              controls
              autoPlay
              className="max-w-full max-h-full rounded-lg"
              style={{ outline: 'none' }}
            />
          </div>
        );
      
      case 'audio':
        return (
          <div className="flex flex-col items-center justify-center h-full gap-6 p-8">
            <div className="w-32 h-32 rounded-2xl bg-gradient-to-br from-purple-500/20 to-blue-500/20 border border-white/10 flex items-center justify-center">
              <Volume2 size={48} className="text-purple-400" />
            </div>
            <div className="text-center">
              <p className="font-medium text-lg">{name}</p>
              <p className="text-sm text-slate-400 mt-1">{formatSize(file.size)}</p>
            </div>
            <audio src={blobUrl} controls autoPlay aria-label={`Audio preview for ${name}`} className="w-full max-w-md" />
          </div>
        );
      
      default:
        return (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
            <FileIcon size={64} className="text-slate-500/50" />
            <p className="text-lg font-medium text-slate-300">{name}</p>
            <p className="text-sm text-slate-500">
              Preview not available for {file.mimeType || 'this file type'}
            </p>
            <a
              href={downloadUrl(file.id)}
              className="mt-2 px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-sm transition-colors flex items-center gap-2"
            >
              <Download size={16} /> Download File
            </a>
          </div>
        );
    }
  };

  return (
    <ViewportModal
      open
      onDismiss={onClose}
      initialFocusRef={closeButtonRef}
      className="bg-theme-bg/95 text-theme-text backdrop-blur-xl"
    >
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="flex h-full min-h-0 w-full flex-col bg-theme-bg/95 text-theme-text backdrop-blur-xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${name}`}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft') goPrev();
          if (event.key === 'ArrowRight') goNext();
        }}
      >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-theme-surface/95 border-b border-theme-border shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <CatIcon size={18} className="text-slate-400 shrink-0" />
          <span className="text-sm font-medium truncate max-w-[40vw]">{name}</span>
          <span className="text-[11px] text-slate-500 shrink-0">{formatSize(file.size)}</span>
          {files.length > 1 && (
            <span className="text-[11px] text-slate-600 shrink-0">
              {currentIndex + 1} / {files.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {copyAIUrl && (
            <button onClick={() => copyAIUrl(file)} className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-blue-400 transition-colors" title="Copy AI URL">
              <Copy size={16} />
            </button>
          )}
          <a href={downloadUrl(file.id)} className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-emerald-400 transition-colors" title="Download">
            <Download size={16} />
          </a>
          <button onClick={toggleFullscreen} className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors" title="Fullscreen">
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <div className="w-px h-5 bg-white/10 mx-1" />
          <button ref={closeButtonRef} onClick={onClose} aria-label="Close file preview" className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors" title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 relative overflow-hidden min-h-0">
        <AnimatePresence mode="wait">
          <motion.div
            key={file.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0"
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>

        {/* Navigation arrows */}
        {files.length > 1 && (
          <>
            {hasPrev && (
              <button
                onClick={goPrev}
                className="theme-fixed-dark absolute left-3 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white/70 hover:text-white transition-all shadow-xl backdrop-blur-sm border border-white/10 z-10"
                title="Previous (←)"
              >
                <ChevronLeft size={24} />
              </button>
            )}
            {hasNext && (
              <button
                onClick={goNext}
                className="theme-fixed-dark absolute right-3 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/60 hover:bg-black/80 text-white/70 hover:text-white transition-all shadow-xl backdrop-blur-sm border border-white/10 z-10"
                title="Next (→)"
              >
                <ChevronRight size={24} />
              </button>
            )}
          </>
        )}
      </div>

      {/* Bottom bar with file info */}
      <div className="flex items-center justify-between px-4 py-2 bg-theme-surface/95 border-t border-theme-border shrink-0">
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className="px-2 py-0.5 rounded bg-white/5">{file.mimeType || 'Unknown type'}</span>
          <span>{new Date(file.createdAt).toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-1">
          {onRename && (
            <button onClick={() => { onRename(file); onClose(); }} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-500 hover:text-blue-400 transition-colors" title="Rename">
              <Edit3 size={14} />
            </button>
          )}
          {onCopyToProject && (
            <button onClick={() => { onCopyToProject(file); onClose(); }} className="p-1.5 rounded-lg hover:bg-white/10 text-slate-500 hover:text-purple-400 transition-colors" title="Copy to Project">
              <Copy size={14} />
            </button>
          )}
          {onDelete && (
            <button onClick={() => onDelete(file.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-500 hover:text-red-400 transition-colors" title="Delete">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      </motion.div>
    </ViewportModal>
  );
}
