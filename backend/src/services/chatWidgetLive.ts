import { BOARD_NAME_PATTERN, expandNativeNestedToolHistory, MAX_WIDGET_HTML_BYTES, nativeWidgetBinding, WIDGET_REFERENCE_SCHEMA } from './chatWidgetProjection';
import { readOwnedWidgetDocument, WidgetReadError, type WidgetReadDependencies } from './chatWidgetDocument';

/**
 * Live (pinned) widgets. A widget shown with a board name keeps that name
 * across updates, so "the newest version" is the newest show_widget result in
 * the session carrying it. Discovery here only nominates a tool call; the
 * transcript document is still read through readOwnedWidgetDocument, which
 * re-checks the exact call/result pairing. A pinned-only update (no transcript
 * document) is read from the session board through a loopback-only fetch.
 */
export const LIVE_WIDGET_HISTORY_PAGES = 4;
const LIVE_WIDGET_HISTORY_BYTES = 16 * 1024 * 1024;
const BOARD_FRAME_PATH = /^\/__openclaw__\/board\/[^/?#\\]+\/([^/?#\\]+)\/index\.html\?bt=[A-Za-z0-9._~%-]{1,2048}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface LiveWidgetVersion { toolCallId: string; title: string; mode: 'inline' | 'dashboard' }
export interface LatestBoardWidget { latest: LiveWidgetVersion; latestInline: LiveWidgetVersion | null }
type HistoryPage = WidgetReadDependencies['history'];

/** Newest first, at most LIVE_WIDGET_HISTORY_PAGES pages of one physical session. */
export async function findLatestBoardWidget(boardName: string, history: HistoryPage,
  maxPages = LIVE_WIDGET_HISTORY_PAGES): Promise<LatestBoardWidget | null> {
  if (!BOARD_NAME_PATTERN.test(boardName)) return null;
  let sessionId: string | undefined;
  let chronological: any[] = [];
  let bytes = 0;
  // Every scan covers all pages read so far, so its first hit is the newest version.
  let latest: LiveWidgetVersion | null = null;
  for (let page = 0, offset = 0; page < maxPages; page++) {
    const result = await history(offset);
    if (!result.ok || !Array.isArray(result.data?.messages)) throw new WidgetReadError(502, 'WIDGET_HISTORY_UNAVAILABLE');
    bytes += Buffer.byteLength(JSON.stringify(result.data.messages));
    if (bytes > LIVE_WIDGET_HISTORY_BYTES) throw new WidgetReadError(413, 'WIDGET_HISTORY_LIMIT');
    if (page === 0) sessionId = result.data.sessionId;
    if (!sessionId || result.data.sessionId !== sessionId) throw new WidgetReadError(409, 'WIDGET_SESSION_CHANGED');
    // Pages run newest to oldest; keep one chronological list so nested
    // Tool Search rows still find their parent call across a page boundary.
    chronological = [...result.data.messages, ...chronological];
    const rows = expandNativeNestedToolHistory(chronological);
    latest = null;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row?.role !== 'toolResult' || row.toolName !== 'show_widget' || row.isError === true) continue;
      const ref = nativeWidgetBinding('show_widget', row.toolCallId, row)?.ref;
      if (ref?.boardName !== boardName || (ref.mode !== 'inline' && ref.mode !== 'dashboard')) continue;
      const version: LiveWidgetVersion = { toolCallId: ref.toolCallId, title: ref.title, mode: ref.mode };
      latest ??= version;
      if (version.mode === 'inline') return { latest, latestInline: version };
    }
    if (!result.data.hasMore) break;
    if (!Number.isSafeInteger(result.data.nextOffset) || result.data.nextOffset <= offset)
      throw new WidgetReadError(502, 'WIDGET_HISTORY_UNAVAILABLE');
    offset = result.data.nextOffset;
  }
  return latest ? { latest, latestInline: null } : null;
}

type Rpc = (method: string, params: Record<string, any>, timeoutMs?: number) => Promise<{ ok: boolean; data?: any }>;
export interface BoardReadDependencies { rpc: Rpc; gatewayHttpBase: string; fetch?: typeof fetch }

async function readBounded(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_WIDGET_HTML_BYTES) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WIDGET_HTML_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * The newest board copy of a pinned widget. board.get mints a short view
 * ticket per widget; the frame is fetched from the loopback Gateway only, with
 * no redirects, an HTML content type and the widget size cap. Anything else,
 * including an unknown widget content kind, is refused (null).
 */
export async function readBoardWidgetHtml(sessionKey: string, boardName: string,
  deps: BoardReadDependencies): Promise<{ html: string; revision: number; title?: string } | null> {
  if (!BOARD_NAME_PATTERN.test(boardName)) return null;
  let base: URL;
  try { base = new URL(deps.gatewayHttpBase); } catch { return null; }
  if ((base.protocol !== 'http:' && base.protocol !== 'https:') || !LOOPBACK_HOSTS.has(base.hostname)) return null;
  const board = await deps.rpc('board.get', { sessionKey }, 10_000);
  if (!board.ok || !Array.isArray(board.data?.widgets)) return null;
  const matches = board.data.widgets.filter((item: any) => item?.name === boardName);
  if (matches.length !== 1) return null;
  const widget = matches[0];
  if (widget.contentKind !== undefined && widget.contentKind !== 'html') return null;
  const frameUrl = widget.frameUrl;
  const match = typeof frameUrl === 'string' && frameUrl.length <= 4096 && !frameUrl.includes('..') ? BOARD_FRAME_PATH.exec(frameUrl) : null;
  let framedName: string | null = null;
  try { framedName = match ? decodeURIComponent(match[1]) : null; } catch { framedName = null; }
  if (framedName !== boardName) return null;
  const target = new URL(frameUrl, base);
  if (target.origin !== base.origin) return null;
  const response = await (deps.fetch ?? fetch)(target, {
    redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'text/html' },
  });
  if (!response.ok || !/^text\/html(\s*;|$)/i.test(response.headers.get('content-type') || '')) return null;
  const html = await readBounded(response);
  if (html === null) return null;
  return { html, revision: Number.isSafeInteger(widget.revision) ? widget.revision : 0,
    ...(typeof widget.title === 'string' && widget.title ? { title: widget.title.slice(0, 160) } : {}) };
}

export interface LiveWidgetReadDependencies extends WidgetReadDependencies {
  /** The session board copy of this widget; null when unreadable. */
  board(): Promise<{ html: string; revision: number; title?: string } | null>;
}

/**
 * The newest version of a live widget, owner-checked before any read and
 * again after every document read. A board copy is used only when the newest
 * version is a pinned-only update; otherwise (or when the board is unreadable)
 * the newest transcript document is read through the attested path.
 */
export async function readLiveWidgetDocument(boardName: string, deps: LiveWidgetReadDependencies) {
  if (!BOARD_NAME_PATTERN.test(boardName)) throw new WidgetReadError(400, 'WIDGET_INVALID');
  await deps.authorize();
  const found = await findLatestBoardWidget(boardName, deps.history);
  if (!found) throw new WidgetReadError(404, 'WIDGET_NOT_FOUND');
  if (found.latest.mode === 'dashboard') {
    const board = await deps.board().catch(() => null);
    if (board) {
      // Re-authorize after the fetch: a revoked actor or session gets nothing.
      await deps.authorize();
      return {
        v: 1,
        reference: { schema: WIDGET_REFERENCE_SCHEMA, toolCallId: found.latest.toolCallId, title: board.title || found.latest.title,
          mode: 'inline' as const, boardName },
        html: board.html,
        live: { boardName, source: 'board' as const, revision: board.revision },
      };
    }
  }
  if (!found.latestInline) throw new WidgetReadError(404, 'WIDGET_NOT_FOUND');
  const document = await readOwnedWidgetDocument(found.latestInline.toolCallId, deps);
  if (document.reference.boardName !== boardName) throw new WidgetReadError(409, 'WIDGET_SESSION_CHANGED');
  return { ...document, live: { boardName, source: 'transcript' as const } };
}
