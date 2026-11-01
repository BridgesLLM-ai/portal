import { create } from 'zustand';

/** Something posted in a chat, opened beside it so nobody has to scroll back up for it. */
export type WorkspacePreview =
  | { id: string; kind: 'code'; title: string; language: string; code: string }
  | { id: string; kind: 'mermaid'; title: string; source: string }
  | { id: string; kind: 'markdown'; title: string; markdown: string }
  | { id: string; kind: 'file'; title: string; href: string }
  | { id: string; kind: 'widget'; title: string; provider: string; session: string; toolCallId: string; boardName?: string };
export type WorkspacePreviewInput = WorkspacePreview extends infer T ? T extends WorkspacePreview ? Omit<T, 'id'> & { id?: string } : never : never;
export type BuiltinWorkspaceTab = 'browser' | 'widgets' | 'artifacts';
export type WorkspaceTab = BuiltinWorkspaceTab | `preview:${string}`;
export const BUILTIN_WORKSPACE_TABS: BuiltinWorkspaceTab[] = ['browser', 'widgets', 'artifacts'];

/** Per-user browser storage; cleared with the rest of the workspace state at sign-out. */
export const AGENT_WORKSPACE_LAYOUT_PREFIX = 'portal.agentWorkspace.v1:';
export const FLOATING_WIDGETS_PREFIX = 'portal.floatingWidgets.v1:';
const MAX_PREVIEWS = 6;
export const MAX_FLOATING_WIDGETS = 12;
export const WORKSPACE_MIN_WIDTH = 320;
export const WORKSPACE_MAX_WIDTH = 1200;

type Layout = { open: boolean; width: number; tab: WorkspaceTab; closedTabs: BuiltinWorkspaceTab[] };
const DEFAULT_LAYOUT: Layout = { open: false, width: 460, tab: 'artifacts', closedTabs: [] };

function storageKey(prefix: string, userId: string): string | null {
  return userId ? `${prefix}${userId}` : null;
}
function readJson(key: string | null): any {
  if (!key) return null;
  try { return JSON.parse(window.localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key: string | null, value: unknown): void {
  if (!key) return;
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or disabled: state simply resets */ }
}

/** Below Tailwind `lg` the panel covers the whole screen (`fixed inset-0`). */
const COMPACT_VIEWPORT_QUERY = '(max-width: 1023.98px)';
function compactViewport(): boolean {
  try { return typeof window !== 'undefined' && window.matchMedia?.(COMPACT_VIEWPORT_QUERY).matches === true; } catch { return false; }
}

function readLayout(userId: string): Layout {
  const value = readJson(storageKey(AGENT_WORKSPACE_LAYOUT_PREFIX, userId));
  if (!value || typeof value !== 'object') return { ...DEFAULT_LAYOUT };
  const width = Number.isFinite(value.width) ? Math.min(WORKSPACE_MAX_WIDTH, Math.max(WORKSPACE_MIN_WIDTH, value.width)) : DEFAULT_LAYOUT.width;
  const closedTabs = BUILTIN_WORKSPACE_TABS.filter((id) => Array.isArray(value.closedTabs) && value.closedTabs.includes(id));
  const savedTab: BuiltinWorkspaceTab = BUILTIN_WORKSPACE_TABS.includes(value.tab) ? value.tab : 'artifacts';
  const tab = !closedTabs.includes(savedTab) ? savedTab : BUILTIN_WORKSPACE_TABS.find((id) => !closedTabs.includes(id)) || 'artifacts';
  return { open: value.open === true && closedTabs.length < BUILTIN_WORKSPACE_TABS.length, width, tab, closedTabs };
}
function saveLayout(userId: string, state: Layout): void {
  writeJson(storageKey(AGENT_WORKSPACE_LAYOUT_PREFIX, userId), { open: state.open, width: state.width, closedTabs: state.closedTabs,
    tab: state.tab.startsWith('preview:') ? 'artifacts' : state.tab });
}

/** Short stable hash so the same artifact focuses its existing tab instead of opening another. */
export function previewId(kind: string, text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `${kind}-${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}

interface WorkspaceState extends Layout {
  userId: string;
  previews: WorkspacePreview[];
  /** Built-in tabs the user closed during this run; agent activity will not reopen them. */
  dismissedTabsDuringRun: WorkspaceTab[];
  /** Set when the user closes the panel; an agent action in the same run will not reopen it. */
  closedDuringRun: boolean;
  /**
   * On a compact screen an automatic open would take over the whole screen, so
   * it only marks this tab as having new agent activity. Opening the panel clears it.
   */
  unreadTab: WorkspaceTab | null;
  bindUser: (userId: string) => void;
  show: (tab?: WorkspaceTab, options?: { automatic?: boolean }) => void;
  hide: () => void;
  toggle: (tab?: WorkspaceTab) => void;
  setWidth: (width: number) => void;
  openPreview: (item: WorkspacePreviewInput) => void;
  closePreview: (id: string, available?: BuiltinWorkspaceTab[]) => void;
  closeTab: (tab: WorkspaceTab, available?: BuiltinWorkspaceTab[]) => void;
  runStarted: () => void;
}

export const useAgentWorkspaceStore = create<WorkspaceState>((set, get) => ({
  ...DEFAULT_LAYOUT, userId: '', previews: [], closedDuringRun: false, dismissedTabsDuringRun: [], unreadTab: null,
  bindUser: (userId) => {
    if (get().userId === userId) return;
    // Another account never inherits the previous user's previews or layout.
    set({ ...readLayout(userId), userId, previews: [], closedDuringRun: false, dismissedTabsDuringRun: [], unreadTab: null });
  },
  show: (tab, options) => {
    if (options?.automatic && (get().closedDuringRun || (tab && get().dismissedTabsDuringRun.includes(tab)))) return;
    if (options?.automatic && compactViewport()) {
      const state = get();
      const target = tab ?? state.tab;
      if (!state.open || state.tab !== target) set({ unreadTab: target });
      return;
    }
    set((state) => {
      // Opening without a tab goes to the tab that has unseen agent activity.
      const nextTab = tab ?? state.unreadTab ?? state.tab;
      const next = { ...state, open: true, tab: nextTab, closedTabs: state.closedTabs.filter((id) => id !== nextTab) };
      saveLayout(state.userId, next);
      return { open: true, tab: nextTab, closedTabs: next.closedTabs, unreadTab: null };
    });
  },
  hide: () => set((state) => { saveLayout(state.userId, { ...state, open: false }); return { open: false, closedDuringRun: true }; }),
  toggle: (tab) => {
    const state = get();
    if (state.open && (!tab || state.tab === tab)) state.hide(); else state.show(tab);
  },
  setWidth: (width) => set((state) => {
    const next = Math.round(Math.min(WORKSPACE_MAX_WIDTH, Math.max(WORKSPACE_MIN_WIDTH, width)));
    saveLayout(state.userId, { ...state, width: next });
    return { width: next };
  }),
  openPreview: (item) => set((state) => {
    const key = item.kind === 'code' ? `${item.language}\n${item.code}` : item.kind === 'mermaid' ? item.source
      : item.kind === 'markdown' ? item.markdown : item.kind === 'file' ? item.href
        // A live widget is one tab whatever version it was opened from.
        : `${item.provider}\n${item.session}\n${item.boardName ? `board:${item.boardName}` : item.toolCallId}`;
    const id = item.id || previewId(item.kind, key);
    const existing = state.previews.filter((preview) => preview.id !== id);
    const previews = [...existing, { ...item, id } as WorkspacePreview].slice(-MAX_PREVIEWS);
    const next = { ...state, open: true, tab: `preview:${id}` as WorkspaceTab };
    saveLayout(state.userId, next);
    return { previews, open: true, tab: next.tab, unreadTab: null };
  }),
  closePreview: (id, available) => get().closeTab(`preview:${id}`, available),
  closeTab: (closing, available = BUILTIN_WORKSPACE_TABS) => set((state) => {
    const tabs: WorkspaceTab[] = [...available.filter((id) => !state.closedTabs.includes(id)),
      ...state.previews.map((preview) => `preview:${preview.id}` as WorkspaceTab)];
    const index = tabs.indexOf(closing);
    const remaining = tabs.filter((id) => id !== closing);
    // Closing a tab never deletes what it showed: chat artifacts stay in the transcript.
    const previews = state.previews.filter((preview) => `preview:${preview.id}` !== closing);
    const closedTabs = closing.startsWith('preview:') ? state.closedTabs
      : [...new Set([...state.closedTabs, closing as BuiltinWorkspaceTab])];
    const tab = state.tab === closing ? remaining[Math.min(Math.max(0, index), remaining.length - 1)] ?? 'artifacts' : state.tab;
    const open = state.open && remaining.length > 0;
    saveLayout(state.userId, { ...state, tab, open, closedTabs });
    return { previews, tab, open, closedTabs, dismissedTabsDuringRun: [...new Set([...state.dismissedTabsDuringRun, closing])],
      closedDuringRun: state.closedDuringRun || !open };
  }),
  runStarted: () => set({ closedDuringRun: false, dismissedTabsDuringRun: [] }),
}));

/** One widget kept on screen over every Portal page. Identity is the chat it came from plus its tool call. */
export interface FloatingWidget {
  id: string; provider: string; session: string; toolCallId: string; title: string;
  x: number; y: number; width: number; height: number; minimized: boolean; z: number;
}
type Geometry = Partial<Pick<FloatingWidget, 'x' | 'y' | 'width' | 'height' | 'minimized' | 'z'>>;
const GEOMETRY_BOUNDS: ReadonlyArray<readonly [keyof Geometry, number, number]> = [
  ['x', -4000, 20000], ['y', -200, 20000], ['width', 200, 4000], ['height', 120, 4000], ['z', 0, 1_000_000],
];
const PROVIDER = /^[A-Z][A-Z0-9_]{0,31}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Geometry is the browser's business, but stored values are bounded before use. */
export function sanitizeFloatingWidget(value: unknown): FloatingWidget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(v.id)) return null;
  if (typeof v.provider !== 'string' || !PROVIDER.test(v.provider)) return null;
  if (typeof v.session !== 'string' || !v.session || v.session.length > 512 || CONTROL.test(v.session)) return null;
  if (typeof v.toolCallId !== 'string' || !v.toolCallId || v.toolCallId.length > 256 || CONTROL.test(v.toolCallId)) return null;
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 160) return null;
  for (const [key, min, max] of GEOMETRY_BOUNDS) {
    const number = v[key];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) return null;
  }
  if (typeof v.minimized !== 'boolean') return null;
  return { id: v.id, provider: v.provider, session: v.session, toolCallId: v.toolCallId, title: v.title.trim(),
    x: v.x as number, y: v.y as number, width: v.width as number, height: v.height as number, minimized: v.minimized, z: v.z as number };
}

function readFloating(userId: string): FloatingWidget[] {
  const value = readJson(storageKey(FLOATING_WIDGETS_PREFIX, userId));
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_FLOATING_WIDGETS).map(sanitizeFloatingWidget).filter((item): item is FloatingWidget => item !== null);
}

function floatingId(): string {
  try { return `fw-${crypto.randomUUID()}`; } catch { return `fw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
}

interface FloatingState {
  userId: string; widgets: FloatingWidget[]; error: string;
  bindUser: (userId: string) => void;
  popOut: (source: { provider: string; session: string; toolCallId: string; title: string }) => FloatingWidget | null;
  patch: (id: string, geometry: Geometry) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
}

/**
 * Floating windows are kept for this user in this browser. Only identities and
 * geometry are stored; every document is re-read through the owner-checked
 * widget route each time a window shows it.
 */
export const useFloatingWidgetsStore = create<FloatingState>((set, get) => {
  const persist = (widgets: FloatingWidget[]) => { writeJson(storageKey(FLOATING_WIDGETS_PREFIX, get().userId), widgets); return widgets; };
  return {
    userId: '', widgets: [], error: '',
    bindUser: (userId) => {
      if (get().userId === userId) return;
      set({ userId, widgets: readFloating(userId), error: '' });
    },
    popOut: (source) => {
      const state = get();
      if (!state.userId) { set({ error: 'Sign in again to pop out widgets.' }); return null; }
      const provider = String(source.provider || '').trim().toUpperCase();
      const existing = state.widgets.find((item) => item.provider === provider && item.session === source.session && item.toolCallId === source.toolCallId);
      const top = state.widgets.reduce((max, item) => Math.max(max, item.z), 0);
      if (existing) {
        set({ widgets: persist(state.widgets.map((item) => item === existing ? { ...item, minimized: false, z: Math.min(1_000_000, top + 1) } : item)), error: '' });
        return get().widgets.find((item) => item.id === existing.id) || null;
      }
      if (state.widgets.length >= MAX_FLOATING_WIDGETS) {
        set({ error: `Close a floating widget first (limit ${MAX_FLOATING_WIDGETS}).` });
        return null;
      }
      const count = state.widgets.length;
      const width = 360; const height = 280;
      const candidate = sanitizeFloatingWidget({
        id: floatingId(), provider, session: source.session, toolCallId: source.toolCallId, title: String(source.title || 'Widget').slice(0, 160),
        x: Math.max(16, Math.round(window.innerWidth - width - 32 - (count % 4) * 28)), y: Math.max(72, 96 + (count % 4) * 28),
        width, height, minimized: false, z: Math.min(1_000_000, top + 1),
      });
      if (!candidate) { set({ error: 'This widget could not be popped out.' }); return null; }
      set({ widgets: persist([...state.widgets, candidate]), error: '' });
      return candidate;
    },
    patch: (id, geometry) => {
      const widgets = get().widgets.map((item) => {
        if (item.id !== id) return item;
        return sanitizeFloatingWidget({ ...item, ...geometry }) || item;
      });
      set({ widgets: persist(widgets) });
    },
    close: (id) => set((state) => ({ widgets: persist(state.widgets.filter((item) => item.id !== id)), error: '' })),
    focus: (id) => {
      const widgets = get().widgets;
      const top = widgets.reduce((max, item) => Math.max(max, item.z), 0);
      const target = widgets.find((item) => item.id === id);
      if (target && target.z < top) get().patch(id, { z: Math.min(1_000_000, top + 1) });
    },
  };
});
