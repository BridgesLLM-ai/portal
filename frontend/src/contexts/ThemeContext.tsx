import { createContext, useContext, useEffect, useLayoutEffect, useState, useCallback, type ReactNode } from 'react';
import { usePublicSettings } from '../hooks/usePublicSettings';

type ThemeMode = 'dark' | 'light' | 'system';
export type VisualEffectsMode = 'auto' | 'full' | 'reduced';

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  accentColor: string;
  setAccentColor: (c: string) => void;
  /** The resolved theme actually applied (never 'system') */
  resolvedTheme: 'dark' | 'light';
  effectsMode: VisualEffectsMode;
  setEffectsMode: (mode: VisualEffectsMode) => void;
  resolvedEffects: 'full' | 'reduced';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DEFAULT_ACCENT = '#6366f1';
const LS_THEME_KEY = 'theme';
const LS_ACCENT_KEY = 'accentColor';
const LS_EFFECTS_KEY = 'visualEffects';

function readStoredValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* non-fatal */ }
}

function normalizeAccent(value: unknown): string | null {
  return typeof value === 'string' && /^#[a-f\d]{6}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function normalizeTheme(value: unknown): ThemeMode | null {
  return value === 'dark' || value === 'light' || value === 'system' ? value : null;
}

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.style.backgroundColor = resolved === 'light' ? '#f2f5f9' : '#0A0E27';
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute('content', resolved === 'light' ? '#f2f5f9' : '#0A0E27');
}

function shouldAutoReduceEffects(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const slowDisplay = window.matchMedia?.('(update: slow)').matches === true;
  const memory = Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0);
  const cores = Number(navigator.hardwareConcurrency || 0);
  const constrainedHardware = (memory > 0 && memory <= 4 && (cores === 0 || cores <= 4))
    || (memory === 0 && cores > 0 && cores <= 2);
  return prefersReducedMotion || slowDisplay || constrainedHardware;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : null;
}

function lighten(r: number, g: number, b: number, amount: number): string {
  return `${Math.min(255, r + amount)}, ${Math.min(255, g + amount)}, ${Math.min(255, b + amount)}`;
}

function darken(r: number, g: number, b: number, amount: number): string {
  return `${Math.max(0, r - amount)}, ${Math.max(0, g - amount)}, ${Math.max(0, b - amount)}`;
}

function applyAccent(hex: string) {
  const el = document.documentElement;
  el.style.setProperty('--color-accent-custom', hex);

  const rgb = hexToRgb(hex);
  if (rgb) {
    const { r, g, b } = rgb;
    // Core accent color
    el.style.setProperty('--accent', hex);
    el.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    // Light variant (for hover states, lighter text)
    el.style.setProperty('--accent-light', `rgb(${lighten(r, g, b, 40)})`);
    // Dark variant (for pressed/active states)
    el.style.setProperty('--accent-dark', `rgb(${darken(r, g, b, 30)})`);
    // Background variants (translucent)
    el.style.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.15)`);
    el.style.setProperty('--accent-bg-hover', `rgba(${r}, ${g}, ${b}, 0.25)`);
    el.style.setProperty('--accent-bg-subtle', `rgba(${r}, ${g}, ${b}, 0.08)`);
    // Border variant
    el.style.setProperty('--accent-border', `rgba(${r}, ${g}, ${b}, 0.2)`);
    el.style.setProperty('--accent-border-hover', `rgba(${r}, ${g}, ${b}, 0.35)`);
    // Shadow
    el.style.setProperty('--accent-shadow', `rgba(${r}, ${g}, ${b}, 0.05)`);
    // Ring / focus
    el.style.setProperty('--accent-ring', `rgba(${r}, ${g}, ${b}, 0.3)`);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialize from localStorage first (instant, no flash), then override with server settings
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    return normalizeTheme(readStoredValue(LS_THEME_KEY)) || 'dark';
  });

  const [accentColor, setAccentState] = useState(() => {
    return normalizeAccent(readStoredValue(LS_ACCENT_KEY)) || DEFAULT_ACCENT;
  });

  const [effectsMode, setEffectsModeState] = useState<VisualEffectsMode>(() => {
    const stored = readStoredValue(LS_EFFECTS_KEY);
    return stored === 'full' || stored === 'reduced' || stored === 'auto' ? stored : 'auto';
  });
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(getSystemTheme);
  const [autoReduceEffects, setAutoReduceEffects] = useState(shouldAutoReduceEffects);

  const publicSettings = usePublicSettings();

  const resolvedTheme = theme === 'system' ? systemTheme : theme;
  const resolvedEffects = effectsMode === 'auto'
    ? (autoReduceEffects ? 'reduced' : 'full')
    : effectsMode;

  useEffect(() => {
    if (!readStoredValue(LS_THEME_KEY)) {
      const publicTheme = normalizeTheme(publicSettings?.theme);
      if (publicTheme) setThemeState(publicTheme);
    }
    if (!readStoredValue(LS_ACCENT_KEY)) {
      const publicAccent = normalizeAccent(publicSettings?.accentColor);
      if (publicAccent) setAccentState(publicAccent);
    }
  }, [publicSettings]);

  // Apply the visual theme before paint. Using a normal effect here produced a
  // dark-frame flash whenever a user with light mode refreshed the Portal.
  useLayoutEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Accent variables affect controls throughout the first screen, so apply
  // them in the same pre-paint phase as the color theme.
  useLayoutEffect(() => {
    applyAccent(accentColor);
  }, [accentColor]);

  useEffect(() => {
    document.documentElement.setAttribute('data-effects', resolvedEffects);
  }, [resolvedEffects]);

  useEffect(() => {
    if (effectsMode !== 'auto') return;
    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const updateQuery = window.matchMedia?.('(update: slow)');
    const refresh = () => setAutoReduceEffects(shouldAutoReduceEffects());
    motionQuery?.addEventListener?.('change', refresh);
    updateQuery?.addEventListener?.('change', refresh);
    refresh();
    return () => {
      motionQuery?.removeEventListener?.('change', refresh);
      updateQuery?.removeEventListener?.('change', refresh);
    };
  }, [effectsMode]);

  // Keep the system preference current even while the user has selected a
  // fixed theme. That prevents a stale frame if they later switch to System.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    const handler = () => setSystemTheme(mq?.matches ? 'light' : 'dark');
    handler();
    mq?.addEventListener?.('change', handler);
    return () => mq?.removeEventListener?.('change', handler);
  }, []);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    writeStoredValue(LS_THEME_KEY, t);
  }, []);

  const setAccentColor = useCallback((c: string) => {
    const normalized = normalizeAccent(c);
    if (!normalized) return;
    setAccentState(normalized);
    writeStoredValue(LS_ACCENT_KEY, normalized);
  }, []);

  const setEffectsMode = useCallback((mode: VisualEffectsMode) => {
    setEffectsModeState(mode);
    writeStoredValue(LS_EFFECTS_KEY, mode);
  }, []);

  return (
    <ThemeContext.Provider value={{
      theme,
      setTheme,
      accentColor,
      setAccentColor,
      resolvedTheme,
      effectsMode,
      setEffectsMode,
      resolvedEffects,
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
