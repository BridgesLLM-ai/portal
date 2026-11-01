/** A deliberately small human-input protocol, not an arbitrary browser RPC tunnel. */
export type BrowserFrame = { url: string; cssWidth: number; cssHeight: number };
export type BrowserInput =
  | { type: 'control'; enabled: boolean }
  | { type: 'input'; id: number; url: string; action: 'click'; x: number; y: number; doubleClick?: boolean; button?: 'left' | 'right' }
  | { type: 'input'; id: number; url: string; action: 'text'; text: string }
  | { type: 'input'; id: number; url: string; action: 'key'; key: string }
  | { type: 'input'; id: number; url: string; action: 'scroll'; x: number; y: number; deltaX: number; deltaY: number };
// Editing and navigation inside the page only: no browser chrome shortcuts
// (address bar, devtools, new tab/window, print, save, close).
const KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Shift+Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Control+A', 'Control+Z', 'Control+Shift+Z', 'Control+Y', 'Shift+ArrowLeft', 'Shift+ArrowRight',
  'Shift+ArrowUp', 'Shift+ArrowDown', 'Control+ArrowLeft', 'Control+ArrowRight', 'Control+Backspace', 'Control+Delete']);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const point = (n: unknown) => finite(n) && n >= 0 && n <= 1;

export function parseBrowserInput(value: unknown): BrowserInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, any>;
  if (v.type === 'control') return Object.keys(v).every(k => ['type', 'enabled'].includes(k)) && typeof v.enabled === 'boolean' ? v as BrowserInput : null;
  if (v.type !== 'input' || !Number.isSafeInteger(v.id) || v.id < 0 || typeof v.url !== 'string' || v.url.length > 4096) return null;
  const common = ['type', 'id', 'url', 'action'];
  const keys = (extra: string[]) => Object.keys(v).every(k => [...common, ...extra].includes(k));
  if (v.action === 'click' && keys(['x', 'y', 'doubleClick', 'button']) && point(v.x) && point(v.y)
    && (v.doubleClick === undefined || typeof v.doubleClick === 'boolean') && (v.button === undefined || ['left', 'right'].includes(v.button))) return v as BrowserInput;
  if (v.action === 'text' && keys(['text']) && typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 4096) return v as BrowserInput;
  if (v.action === 'key' && keys(['key']) && KEYS.has(v.key)) return v as BrowserInput;
  if (v.action === 'scroll' && keys(['x', 'y', 'deltaX', 'deltaY']) && point(v.x) && point(v.y)
    && finite(v.deltaX) && finite(v.deltaY) && Math.abs(v.deltaX) <= 2000 && Math.abs(v.deltaY) <= 2000) return v as BrowserInput;
  return null;
}

/** Native screencast frames: 4-byte header length, JSON header (page URL, CSS size), JPEG bytes. */
export function readBrowserFrame(data: Buffer): BrowserFrame | null {
  if (data.length < 8) return null;
  const size = data.readUInt32BE(0);
  if (size < 2 || size > 16384 || size + 4 >= data.length) return null;
  try {
    const v = JSON.parse(data.subarray(4, size + 4).toString('utf8'));
    return typeof v.url === 'string' && v.url.length <= 4096 && finite(v.cssWidth) && v.cssWidth > 0 && v.cssWidth <= 16384
      && finite(v.cssHeight) && v.cssHeight > 0 && v.cssHeight <= 16384 ? { url: v.url, cssWidth: v.cssWidth, cssHeight: v.cssHeight } : null;
  } catch { return null; }
}

/** Map zoom-independent ratios to native CSS pixels; refuse input aimed at a page that has since changed. */
export function browserInputAction(input: Exclude<BrowserInput, { type: 'control' }>, frame: BrowserFrame): Record<string, unknown> {
  if (input.url !== frame.url) throw new Error('Page changed. Click the current page before typing.');
  if (input.action === 'text') return { kind: 'insertText', text: input.text };
  if (input.action === 'key') return { kind: 'press', key: input.key };
  const x = Math.min(frame.cssWidth - 1, Math.round(input.x * frame.cssWidth));
  const y = Math.min(frame.cssHeight - 1, Math.round(input.y * frame.cssHeight));
  if (input.action === 'click') return { kind: 'clickCoords', x, y, doubleClick: input.doubleClick === true, button: input.button || 'left' };
  // Fixed program with bounded numeric constants only. Native evaluate policy remains authoritative.
  const dx = Math.round(input.deltaX), dy = Math.round(input.deltaY);
  return { kind: 'evaluate', fn: `() => { let n = document.elementFromPoint(${x}, ${y}); while (n && n !== document.documentElement) { const s = getComputedStyle(n); if ((/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight) || (/auto|scroll/.test(s.overflowX) && n.scrollWidth > n.clientWidth)) { n.scrollBy(${dx}, ${dy}); return; } n = n.parentElement; } window.scrollBy(${dx}, ${dy}); }` };
}
