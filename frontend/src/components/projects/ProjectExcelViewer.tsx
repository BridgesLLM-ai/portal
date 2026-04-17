import { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, Download, Loader2 } from 'lucide-react';

const APPS_INITIAL_ROWS = 500;
const APPS_LOAD_MORE = 500;

function parseExcelBufferApps(buf: ArrayBuffer, sheetIndex: number, maxRows: number = 5000) {
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetNames = wb.SheetNames;
  const sheet = wb.Sheets[sheetNames[sheetIndex]];
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  const totalRows = range ? range.e.r + 1 : 0;
  if (range && range.e.r >= maxRows) {
    range.e.r = maxRows - 1;
    sheet['!ref'] = XLSX.utils.encode_range(range);
  }
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as any[][];
  return { sheetNames, data, totalRows, sheetIndex };
}

export default function ProjectExcelViewer({ src, name }: { src: string; name: string }) {
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [data, setData] = useState<any[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [visibleRows, setVisibleRows] = useState(APPS_INITIAL_ROWS);
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState(0);
  const [sizeWarningAccepted, setSizeWarningAccepted] = useState(false);
  const bufferRef = useRef<ArrayBuffer | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchFile() {
      try {
        setLoading(true); setError(null);
        const resp = await fetch(src, { credentials: 'include' });
        const buf = await resp.arrayBuffer();
        if (cancelled) return;
        setFileSize(buf.byteLength);
        if (buf.byteLength > 20 * 1024 * 1024) {
          setError(`File is too large (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB). Please download it instead.`);
          setLoading(false); return;
        }
        bufferRef.current = buf;
        if (buf.byteLength > 5 * 1024 * 1024 && !sizeWarningAccepted) { setLoading(false); return; }
        parseSheet(buf, 0);
      } catch (e: any) {
        if (!cancelled) { setError(e.message); setLoading(false); }
      }
    }
    fetchFile();
    return () => { cancelled = true; };
  }, [src, sizeWarningAccepted]);

  function parseSheet(buf: ArrayBuffer, sheetIndex: number) {
    setParsing(true); setError(null); setVisibleRows(APPS_INITIAL_ROWS);
    try {
      const result = parseExcelBufferApps(buf, sheetIndex, 5000);
      setSheetNames(result.sheetNames); setData(result.data);
      setTotalRows(result.totalRows); setActiveSheet(result.sheetIndex);
    } catch (e: any) {
      setError(e.message || 'Failed to parse spreadsheet');
    } finally {
      setLoading(false); setParsing(false);
    }
  }

  if (!loading && fileSize > 5 * 1024 * 1024 && !sizeWarningAccepted && !error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <AlertCircle size={28} className="mx-auto text-amber-400" />
          <div>
            <p className="text-sm text-white font-medium">Large spreadsheet</p>
            <p className="text-xs text-slate-400 mt-1">{name} is {(fileSize / 1024 / 1024).toFixed(1)}MB. Parsing it inline may feel sluggish.</p>
          </div>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setSizeWarningAccepted(true)} className="px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30">Preview anyway</button>
            <a href={src} download className="px-3 py-2 rounded-lg bg-white/5 text-slate-300 text-sm hover:bg-white/10 inline-flex items-center gap-2"><Download size={14} /> Download</a>
          </div>
        </div>
      </div>
    );
  }

  if (loading || parsing) return (
    <div className="flex-1 flex items-center justify-center gap-2 text-slate-400">
      <Loader2 size={18} className="animate-spin" />
      <span className="text-sm">Loading spreadsheet…</span>
    </div>
  );

  if (error) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
      <AlertCircle size={24} className="text-red-400" />
      <div className="text-center">
        <div className="text-sm text-slate-200">Could not load spreadsheet</div>
        <div className="text-xs text-slate-500 mt-1">{error}</div>
      </div>
      <a href={src} download className="px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30 inline-flex items-center gap-2">
        <Download size={14} /> Download
      </a>
    </div>
  );

  const headers = (data[0] || []).map((cell) => String(cell ?? ''));
  const rows = data.slice(1, visibleRows + 1);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#0a0e1a]">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-2 overflow-x-auto">
          {sheetNames.map((sheet, idx) => (
            <button
              key={sheet}
              onClick={() => bufferRef.current && parseSheet(bufferRef.current, idx)}
              className={`px-2.5 py-1 rounded text-xs whitespace-nowrap ${idx === activeSheet ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'}`}
            >
              {sheet}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-slate-500">{Math.min(totalRows, visibleRows)} / {totalRows} rows</div>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="min-w-full text-xs text-slate-300">
          <thead className="sticky top-0 bg-[#0f1429] z-10">
            <tr>
              {headers.map((header, idx) => (
                <th key={idx} className="px-3 py-2 text-left border-b border-white/5 font-medium text-slate-200 whitespace-nowrap">{header || `Column ${idx + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="odd:bg-white/[0.02]">
                {headers.map((_, colIdx) => (
                  <td key={colIdx} className="px-3 py-2 border-b border-white/[0.03] align-top whitespace-nowrap">{String(row[colIdx] ?? '')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visibleRows < totalRows && (
        <div className="border-t border-white/5 p-3 flex justify-center bg-black/20">
          <button onClick={() => setVisibleRows(v => Math.min(v + APPS_LOAD_MORE, totalRows))} className="px-3 py-1.5 rounded-lg bg-white/5 text-slate-300 text-xs hover:bg-white/10">Load more rows</button>
        </div>
      )}
    </div>
  );
}
