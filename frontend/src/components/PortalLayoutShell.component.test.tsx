// @vitest-environment jsdom
import '../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PortalLayoutShell from './PortalLayoutShell';

const themeMock = vi.hoisted(() => ({ resolvedEffects: 'full' as 'full' | 'reduced' }));

vi.mock('framer-motion', () => ({
  MotionConfig: ({ reducedMotion, children }: { reducedMotion: string; children: React.ReactNode }) => (
    <div data-testid="motion-config" data-reduced-motion={reducedMotion}>{children}</div>
  ),
}));

vi.mock('./Layout', () => ({ default: () => <main>Authenticated portal layout</main> }));
vi.mock('./GlobalControls', () => ({ default: ({ children }: { children: React.ReactNode }) => <section data-testid="global-controls">{children}</section> }));
vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => themeMock,
}));

describe('PortalLayoutShell reduced motion contract', () => {
  it('renders the authenticated shell under the user motion preference', () => {
    themeMock.resolvedEffects = 'full';
    render(<PortalLayoutShell />);

    expect(screen.getByTestId('motion-config')).toHaveAttribute('data-reduced-motion', 'user');
    expect(screen.getByTestId('global-controls')).toBeVisible();
    expect(screen.getByRole('main')).toHaveTextContent('Authenticated portal layout');
  });

  it('forces reduced Framer Motion on constrained clients', () => {
    themeMock.resolvedEffects = 'reduced';
    render(<PortalLayoutShell />);

    expect(screen.getByTestId('motion-config')).toHaveAttribute('data-reduced-motion', 'always');
  });
});
