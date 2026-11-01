// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiToolsHistory from './AiToolsHistory';
import type { ToolsHistoryEntry } from '../../api/maintenanceTools';

const api = vi.hoisted(() => ({ getRunReport: vi.fn() }));

vi.mock('../../api/maintenanceTools', () => ({
  maintenanceToolsAPI: { getRunReport: api.getRunReport },
}));

const LABELS = { openclaw: 'OpenClaw', codex: 'Codex CLI' };

function entry(overrides: Partial<ToolsHistoryEntry> = {}): ToolsHistoryEntry {
  return {
    runId: '0b6c2f1e-4a59-4d38-9d0e-2a7f5c1b9e01', tool: 'openclaw', action: 'update', from: '2026.9.9', to: '2026.10.9',
    outcome: 'succeeded', errorId: null, startedAt: '2026-10-30T11:00:00.000Z', endedAt: '2026-10-30T11:42:05.000Z',
    durationMs: 2_525_000, initiator: 'owner-1', ...overrides,
  };
}

describe('AI tools history', () => {
  beforeEach(() => api.getRunReport.mockReset());

  it('lists runs with tool, change, plain outcome, duration and who started them', () => {
    render(
      <AiToolsHistory
        owner
        currentUserId="owner-1"
        toolLabels={LABELS}
        history={[
          entry(),
          entry({ runId: '5d1f8a3c-6b72-4e19-8c40-7a2e9f0d3b12', tool: 'codex', action: 'requalify', from: '0.166.0', to: '0.166.0', durationMs: 41_000, initiator: 'previous-owner' }),
          entry({ runId: '7c4e2a10-3b5d-4f61-9a82-1d0e6b3c5f27', outcome: 'refused', to: null, durationMs: 12_000, initiator: null }),
          // F9: a refused pre-flight or Re-check is labelled by what it is, and only updates show a change.
          entry({ runId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c81', action: 'preflight', outcome: 'refused', from: '2026.9.3', to: null, durationMs: 10_000 }),
          entry({ runId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82', action: 'preflight', outcome: 'succeeded', from: '2026.9.9', to: '2026.10.9', durationMs: 9_000 }),
          entry({ runId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c83', tool: 'codex', action: 'requalify', outcome: 'refused', from: null, to: null, durationMs: 3_000 }),
          entry({ runId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c84', action: 'update', outcome: 'refused', from: '2026.9.3', to: '2026.10.9', durationMs: 11_000 }),
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'AI tools update history, newest first' });
    const rows = within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').slice(1, 6).map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['OpenClaw', '2026.9.9 → 2026.10.9', 'Updated', '42 min 5 s', 'You'],
      ['Codex CLI', '—', 'Checked — passed', '41 s', 'Owner'],
      ['OpenClaw', '—', 'Not updated', '12 s', 'Server'],
      ['OpenClaw', '—', 'Pre-flight refused', '10 s', 'You'],
      ['OpenClaw', '—', 'Pre-flight passed', '9 s', 'You'],
      ['Codex CLI', '—', 'Checked — not confirmed', '3 s', 'You'],
      ['OpenClaw', '2026.9.3 → 2026.10.9', 'Not updated', '11 s', 'You'],
    ]);
  });

  it('the owner opens a run report with its steps and evidence names; admins cannot', async () => {
    api.getRunReport.mockResolvedValue({
      run: {
        runId: entry().runId, tool: 'openclaw', state: 'refused', phase: 'refused',
        steps: [{ id: 'preflight', label: 'Checking…', state: 'failed', startedAt: null, endedAt: null, detail: 'Needs 49 GB free on /, has 19 GB.', evidence: [] }],
        error: { id: 'PF8_DISK', message: 'Needs 49 GB free on /, has 19 GB.' },
      },
      evidence: ['preflight.json', 'status.json'],
    });
    const user = userEvent.setup();
    const { unmount } = render(<AiToolsHistory owner currentUserId="owner-1" toolLabels={LABELS} history={[entry({ outcome: 'refused' })]} />);
    await user.click(screen.getByRole('button', { name: /^Report for the OpenClaw run/ }));
    expect(api.getRunReport).toHaveBeenCalledWith(entry().runId);
    const report = await screen.findByRole('region', { name: 'Run report' });
    expect(report).toHaveTextContent('OpenClaw: Not updated — Needs 49 GB free on /, has 19 GB.');
    // The report of a refused pre-flight says so (the history entry names the action).
    await user.click(screen.getByRole('button', { name: 'Close report' }));
    unmount();
    const preflight = render(<AiToolsHistory owner currentUserId="owner-1" toolLabels={LABELS} history={[entry({ outcome: 'refused', action: 'preflight' })]} />);
    await user.click(screen.getByRole('button', { name: /^Report for the OpenClaw run/ }));
    expect(await screen.findByRole('region', { name: 'Run report' })).toHaveTextContent('OpenClaw: Pre-flight refused — Needs 49 GB free on /, has 19 GB.');
    preflight.unmount();
    expect(within(report).getByRole('list', { name: 'Run steps' })).toHaveTextContent('Checking…: failed — Needs 49 GB free on /, has 19 GB.');
    expect(report).toHaveTextContent('Evidence kept on the server: preflight.json, status.json.');
    render(<AiToolsHistory owner={false} toolLabels={LABELS} history={[entry()]} />);
    expect(screen.queryByRole('button', { name: /^Report for/ })).toBeNull();
    expect(screen.getByText('Owner only')).toBeInTheDocument();
  });

  it('says so when nothing has run yet', () => {
    render(<AiToolsHistory owner toolLabels={LABELS} history={[]} />);
    expect(screen.getByText('No AI tool updates have run yet.')).toBeInTheDocument();
  });
});
