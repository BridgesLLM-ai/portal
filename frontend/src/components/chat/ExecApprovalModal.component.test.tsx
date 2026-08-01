// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ExecApprovalModal } from './ExecApprovalModal';
import type { ExecApprovalRequest } from './useAgentRuntime';

function approval(): ExecApprovalRequest {
  const now = Date.now();
  return {
    id: 'approval-1',
    request: {
      command: 'npm test',
      cwd: '/workspace/project',
      host: 'gateway',
      security: 'workspace-write',
      agentId: 'agent-1',
      sessionKey: 'session-1',
    },
    createdAtMs: now,
    expiresAtMs: now + 60_000,
  };
}

describe('ExecApprovalModal', () => {
  it('owns a body portal above transformed chat surfaces and focuses the safe action', async () => {
    const { container } = render(
      <div style={{ transform: 'translate3d(0, 0, 0)' }}>
        <ExecApprovalModal
          approval={approval()}
          onResolve={vi.fn()}
          onDismiss={vi.fn()}
        />
      </div>,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Command Approval Required' });
    expect(container).not.toContainElement(dialog);
    expect(dialog.closest('[data-viewport-overlay-root="true"]')?.parentElement).toBe(document.body);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus());
  });

  it('gives progress to only the selected decision and blocks duplicate dismissal', async () => {
    const onResolve = vi.fn(() => new Promise<void>(() => undefined));
    const user = userEvent.setup();
    render(
      <ExecApprovalModal
        approval={approval()}
        onResolve={onResolve}
        onDismiss={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(onResolve).toHaveBeenCalledWith('approval-1', 'allow-once');
    expect(screen.getByRole('button', { name: 'Approving…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Always Allow' })).toBeDisabled();
    expect(document.querySelectorAll('button[aria-busy="true"]')).toHaveLength(1);

    await user.keyboard('{Escape}');
    await user.click(document.querySelector('[data-viewport-modal-layer="true"]')!);
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('treats Escape as an explicit deny while idle', async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ExecApprovalModal
        approval={approval()}
        onResolve={onResolve}
        onDismiss={vi.fn()}
      />,
    );

    await screen.findByRole('dialog', { name: 'Command Approval Required' });
    await user.keyboard('{Escape}');
    expect(onResolve).toHaveBeenCalledWith('approval-1', 'deny');
  });

  it('emits only one dismissal when an approval expires', async () => {
    const expired = approval();
    expired.expiresAtMs = Date.now() - 1;
    const onDismiss = vi.fn();

    render(
      <ExecApprovalModal
        approval={expired}
        onResolve={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
