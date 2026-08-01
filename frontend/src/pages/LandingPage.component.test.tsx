// @vitest-environment jsdom
import '../test/setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LandingPage from './LandingPage';

describe('public landing claims', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
  });

  it('documents the secure localhost bootstrap and reports clipboard failure honestly', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('blocked'); }) },
    });
    render(<LandingPage />);

    expect(screen.getByRole('heading', { name: 'Start through localhost' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Access via IP' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not copy the installer command');
  });
});
