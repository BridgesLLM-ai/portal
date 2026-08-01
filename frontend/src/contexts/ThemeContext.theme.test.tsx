// @vitest-environment jsdom
import '../test/setup';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';

vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => null,
}));

function Probe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <>
      <output data-testid="theme">{theme}:{resolvedTheme}</output>
      <button type="button" onClick={() => setTheme('system')}>Use system</button>
    </>
  );
}

describe('theme application', () => {
  let prefersLight = false;
  let themeListeners: Set<() => void>;

  beforeEach(() => {
    themeListeners = new Set();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        get matches() { return query === '(prefers-color-scheme: light)' && prefersLight; },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((event: string, listener: () => void) => {
          if (query === '(prefers-color-scheme: light)' && event === 'change') themeListeners.add(listener);
        }),
        removeEventListener: vi.fn((event: string, listener: () => void) => {
          if (query === '(prefers-color-scheme: light)' && event === 'change') themeListeners.delete(listener);
        }),
        dispatchEvent: vi.fn(),
      })),
    });
    prefersLight = false;
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');
    document.head.querySelector('meta[name="theme-color"]')?.remove();
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#0A0E27';
    document.head.append(meta);
  });

  it('applies a persisted light theme and browser chrome color before paint', () => {
    localStorage.setItem('theme', 'light');
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('theme')).toHaveTextContent('light:light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.style.backgroundColor).toBe('rgb(242, 245, 249)');
    expect(document.head.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#f2f5f9');
  });

  it('keeps React consumers synchronized when the system theme changes', async () => {
    localStorage.setItem('theme', 'system');
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('theme')).toHaveTextContent('system:dark');
    prefersLight = true;
    act(() => themeListeners.forEach((listener) => listener()));

    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('system:light'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.head.querySelector('meta[name="theme-color"]')).toHaveAttribute('content', '#f2f5f9');
  });

  it('tracks the system preference while a fixed theme is selected', async () => {
    localStorage.setItem('theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);

    prefersLight = true;
    act(() => themeListeners.forEach((listener) => listener()));
    expect(screen.getByTestId('theme')).toHaveTextContent('dark:dark');

    screen.getByRole('button', { name: 'Use system' }).click();
    await waitFor(() => expect(screen.getByTestId('theme')).toHaveTextContent('system:light'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});
