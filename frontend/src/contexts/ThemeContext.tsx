import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

type ThemeMode = 'dark' | 'light' | 'system';

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  accentColor: string;
  setAccentColor: (c: string) => void;
  /** The resolved theme actually applied (never 'system') */
  resolvedTheme: 'dark' | 'light';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DEFAULT_ACCENT = '#6366f1';
const LS_THEME_KEY = 'theme';
const LS_ACCENT_KEY = 'accentColor';

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  return mode === 'system' ? getSystemTheme() : mode;
}

function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved);
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
    const stored = localStorage.getItem(LS_THEME_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
    return 'dark';
  });

  const [accentColor, setAccentState] = useState(() => {
    return localStorage.getItem(LS_ACCENT_KEY) || DEFAULT_ACCENT;
  });

  const [serverLoaded, setServerLoaded] = useState(false);

  const resolvedTheme = resolveTheme(theme);

  // Fetch server appearance settings once on mount
  useEffect(() => {
    const fetchPublicSettings = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || '';
        const res = await fetch(`${apiUrl}/settings/public`);
        if (res.ok) {
          const data = await res.json();
          // Only apply server values if user hasn't set a local preference
          if (!localStorage.getItem(LS_THEME_KEY) && data.theme) {
            setThemeState(data.theme as ThemeMode);
          }
          if (!localStorage.getItem(LS_ACCENT_KEY) && data.accentColor) {
            setAccentState(data.accentColor);
          }
        }
      } catch {
        // Server unavailable, stick with defaults/localStorage
      }
      setServerLoaded(true);
    };
    fetchPublicSettings();
  }, []);

  // Apply theme to DOM whenever it changes
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Apply accent color whenever it changes
  useEffect(() => {
    applyAccent(accentColor);
  }, [accentColor]);

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => applyTheme(getSystemTheme());
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t);
    localStorage.setItem(LS_THEME_KEY, t);
  }, []);

  const setAccentColor = useCallback((c: string) => {
    setAccentState(c);
    localStorage.setItem(LS_ACCENT_KEY, c);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, accentColor, setAccentColor, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
