// @vitest-environment jsdom
import '../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';

vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => null,
}));

function Probe() {
  const { effectsMode, resolvedEffects, accentColor } = useTheme();
  return <output data-testid="effects">{effectsMode}:{resolvedEffects}:{accentColor}</output>;
}

function setHardware(memory: number | undefined, cores: number) {
  Object.defineProperty(navigator, 'deviceMemory', {
    configurable: true,
    value: memory,
  });
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    configurable: true,
    value: cores,
  });
}

describe('per-device visual effects', () => {
  beforeEach(() => setHardware(undefined, 8));

  it('automatically reduces expensive effects on constrained hardware', async () => {
    setHardware(4, 4);
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('effects')).toHaveTextContent('auto:reduced');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-effects', 'reduced'));
  });

  it('honors an explicit full-effects override on the same device', async () => {
    setHardware(4, 4);
    localStorage.setItem('visualEffects', 'full');
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('effects')).toHaveTextContent('full:full');
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-effects', 'full'));
  });

  it('rejects malformed persisted accent values instead of applying arbitrary CSS', async () => {
    localStorage.setItem('accentColor', 'url(javascript:alert(1))');
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('effects')).toHaveTextContent('#6366f1');
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#6366f1'));
  });
});
