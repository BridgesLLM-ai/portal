import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, Loader2 } from 'lucide-react';
import {
  MAX_SPREADSHEET_FILE_BYTES,
  formatSpreadsheetCell,
  parseSpreadsheetWorkbook,
  type ParsedSpreadsheetWorkbook,
} from '../../utils/spreadsheet';
import { contentRangeTotal } from '../../utils/projectSurface';

const APPS_INITIAL_ROWS = 500;
const APPS_LOAD_MORE = 500;
const WARN_FILE_BYTES = 5 * 1024 * 1024;

export default function ProjectExcelViewer({ src, name }: { src: string; name: string }) {
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [data, setData] = useState<any[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [totalColumns, setTotalColumns] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [visibleRows, setVisibleRows] = useState(APPS_INITIAL_ROWS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState(0);
  const [sizeWarningAcceptedFor, setSizeWarningAcceptedFor] = useState<string | null>(null);
  const workbookRef = useRef<ParsedSpreadsheetWorkbook | null>(null);

  function selectSheet(workbook: ParsedSpreadsheetWorkbook, sheetIndex: number) {
    const sheet = workbook.sheets[sheetIndex];
    if (!sheet) throw new Error('Spreadsheet sheet is unavailable.');
    setSheetNames(workbook.sheets.map((candidate) => candidate.name));
    setData(sheet.data);
    setTotalRows(sheet.totalRows);
    setTotalColumns(sheet.totalColumns);
    setTruncated(sheet.truncated);
    setActiveSheet(sheetIndex);
    setVisibleRows(APPS_INITIAL_ROWS);
  }

  useEffect(() => {
    const controller = new AbortController();
    const accepted = sizeWarningAcceptedFor === src;

    async function fetchFile() {
      try {
        setLoading(true);
        setError(null);
        workbookRef.current = null;
        setSheetNames([]);
        setData([]);
        setTotalRows(0);
        setTotalColumns(0);
        setTruncated(false);
        if (/\.xls$/i.test(name)) {
          setError('Legacy .xls files are not parsed in the browser. Convert this file to .xlsx or download it instead.');
          return;
        }

        if (!accepted) {
          const probe = await fetch(src, {
            credentials: 'include',
            headers: { Range: 'bytes=0-0' },
            signal: controller.signal,
          });
          if (!probe.ok) throw new Error(`Download failed with HTTP ${probe.status}`);

          const contentLengthHeader = probe.headers.get('Content-Length');
          const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
          const probedSize = contentRangeTotal(probe.headers.get('Content-Range'))
            ?? (Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null);
          await probe.body?.cancel();
          if (probedSize === null) {
            throw new Error('The server did not report the file size, so this spreadsheet cannot be previewed safely.');
          }
          setFileSize(probedSize);
          if (probedSize > MAX_SPREADSHEET_FILE_BYTES) {
            setError(`File is too large (${(probedSize / 1024 / 1024).toFixed(1)}MB). Please download it instead.`);
            return;
          }
          if (probedSize > WARN_FILE_BYTES) return;
        }

        const response = await fetch(src, { credentials: 'include', signal: controller.signal });
        if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
        const declaredSizeHeader = response.headers.get('Content-Length');
        const declaredSize = declaredSizeHeader === null ? Number.NaN : Number(declaredSizeHeader);
        if (Number.isSafeInteger(declaredSize) && declaredSize > MAX_SPREADSHEET_FILE_BYTES) {
          setFileSize(declaredSize);
          await response.body?.cancel();
          setError(`File is too large (${(declaredSize / 1024 / 1024).toFixed(1)}MB). Please download it instead.`);
          return;
        }
        const buffer = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        setFileSize(buffer.byteLength);
        if (buffer.byteLength > MAX_SPREADSHEET_FILE_BYTES) {
          setError(`File is too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB). Please download it instead.`);
          return;
        }
        if (buffer.byteLength > WARN_FILE_BYTES && !accepted) return;

        const workbook = await parseSpreadsheetWorkbook(buffer);
        if (controller.signal.aborted) return;
        workbookRef.current = workbook;
        selectSheet(workbook, 0);
      } catch (cause: any) {
        if (!controller.signal.aborted) setError(cause?.message || 'Failed to parse spreadsheet');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    fetchFile();
    return () => controller.abort();
  }, [src, name, sizeWarningAcceptedFor]);

  if (!loading && fileSize > WARN_FILE_BYTES && sizeWarningAcceptedFor !== src && !error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <AlertCircle size={28} className="mx-auto text-amber-400" />
          <div>
            <p className="text-sm text-theme-text font-medium">Large spreadsheet</p>
            <p className="text-xs text-slate-400 mt-1">{name} is {(fileSize / 1024 / 1024).toFixed(1)}MB. Parsing it may use substantial browser memory.</p>
          </div>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setSizeWarningAcceptedFor(src)} className="px-3 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30">Preview safely</button>
            <a href={src} download className="px-3 py-2 rounded-lg bg-white/5 text-slate-300 text-sm hover:bg-white/10 inline-flex items-center gap-2"><Download size={14} /> Download</a>
          </div>
        </div>
      </div>
    );
  }

  if (loading) return (
    <div className="flex-1 flex items-center justify-center gap-2 text-slate-400">
      <Loader2 size={18} className="animate-spin" />
      <span className="text-sm">Parsing spreadsheet safely…</span>
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

  const columns = Array.from({ length: Math.min(totalColumns, 256) }, (_, index) => index);
  const rows = data.slice(1, visibleRows + 1);
  const visibleTotalRows = Math.max(0, Math.min(data.length - 1, totalRows - 1));

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-theme-surface">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-theme-border bg-theme-surface-raised">
        <div className="flex items-center gap-2 overflow-x-auto" role="tablist" aria-label={`Sheets in ${name}`}>
          {sheetNames.map((sheet, idx) => (
            <button
              key={`${sheet}-${idx}`}
              role="tab"
              aria-selected={idx === activeSheet}
              onClick={() => workbookRef.current && selectSheet(workbookRef.current, idx)}
              className={`px-2.5 py-1 rounded text-xs whitespace-nowrap ${idx === activeSheet ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'}`}
            >
              {sheet}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-slate-500">
          {Math.min(visibleTotalRows, visibleRows)} / {Math.max(0, totalRows - 1)} rows{truncated ? ' · safely limited' : ''}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="min-w-full text-xs text-theme-text">
          <caption className="sr-only">Spreadsheet data for {name}, sheet {sheetNames[activeSheet] || activeSheet + 1}</caption>
          <thead className="sticky top-0 bg-theme-surface-strong z-10">
            <tr>
              {columns.map((columnIndex) => (
                <th key={columnIndex} className="px-3 py-2 text-left border-b border-theme-border font-medium text-theme-text whitespace-nowrap">
                  {formatSpreadsheetCell(data[0]?.[columnIndex]) || `Column ${columnIndex + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-white/[0.02]">
                {columns.map((columnIndex) => (
                  <td key={columnIndex} className="px-3 py-2 border-b border-theme-border align-top whitespace-nowrap">
                    {formatSpreadsheetCell(row[columnIndex])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visibleRows < visibleTotalRows && (
        <div className="border-t border-theme-border p-3 flex justify-center bg-theme-surface-raised">
          <button onClick={() => setVisibleRows((value) => Math.min(value + APPS_LOAD_MORE, visibleTotalRows))} className="px-3 py-1.5 rounded-lg bg-white/5 text-slate-300 text-xs hover:bg-white/10">Load more rows</button>
        </div>
      )}
    </div>
  );
}
