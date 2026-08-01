// @vitest-environment jsdom
import '../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageContent } from './UsagePage';

const mocks = vi.hoisted(() => ({
  stats: vi.fn(),
  writeText: vi.fn(async () => undefined),
}));

vi.mock('../api/endpoints', () => ({ usageAPI: { stats: mocks.stats } }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Cell: () => null,
}));

describe('usage content states', () => {
  beforeEach(() => {
    mocks.stats.mockReset();
    mocks.writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
  });

  it('does not present a failed first load as zero usage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.stats.mockRejectedValueOnce(new Error('Usage service unavailable'));
    render(<UsageContent showHeader />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Usage service unavailable');
    expect(screen.queryByText('Total Sessions')).not.toBeInTheDocument();
    expect(screen.queryByText('Model Breakdown')).not.toBeInTheDocument();
  });

  it('uses a real keyboard-accessible copy control for session keys', async () => {
    mocks.stats.mockResolvedValueOnce({
      totalSessions: 1,
      activeSessions: 1,
      cronJobs: 0,
      activeCrons: 0,
      modelBreakdown: [{ model: 'openai/gpt-5.5', sessions: 1 }],
      recentSessions: [{
        key: 'agent:main:session-1',
        agent: 'main',
        model: 'openai/gpt-5.5',
        lastActivity: null,
        turns: null,
      }],
    });
    render(<UsageContent showHeader />);

    const copyButton = await screen.findByRole('button', { name: 'Copy session key agent:main:session-1' });
    await userEvent.click(copyButton);

    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('agent:main:session-1'));
    expect(screen.getByText('Session key copied.')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('shows a visible clipboard failure instead of pretending copy succeeded', async () => {
    mocks.writeText.mockRejectedValueOnce(new Error('Clipboard blocked'));
    mocks.stats.mockResolvedValueOnce({
      totalSessions: 1,
      activeSessions: 0,
      cronJobs: 0,
      activeCrons: 0,
      modelBreakdown: [],
      recentSessions: [{
        key: 'session-copy-failure',
        agent: 'main',
        model: 'unknown',
        lastActivity: null,
        turns: null,
      }],
    });
    render(<UsageContent showHeader />);

    await userEvent.click(await screen.findByRole('button', { name: 'Copy session key session-copy-failure' }));

    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
    expect(screen.getByText('Could not copy the session key.')).toBeInTheDocument();
  });
});
