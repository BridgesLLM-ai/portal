// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../api/agentTools';
import { ToolsContent } from './ToolsPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  install: vi.fn(),
  waitForJob: vi.fn(),
}));

vi.mock('../api/agentTools', () => ({
  agentToolsAPI: { list: mocks.list, install: mocks.install },
  toolInstallConfirmationPhrase: (toolId: string) => `INSTALL ${toolId.toUpperCase()}`,
  waitForToolInstallJob: mocks.waitForJob,
}));

const tool: AgentTool = {
  id: 'codex',
  name: 'OpenAI Codex',
  description: 'Portal-tested coding runtime.',
  detect: { command: 'codex --version' },
  install: [{ label: 'Install Codex', command: 'reviewed-command' }],
  commands: [],
  authRequired: true,
  authHint: 'Sign in before use.',
  tier: 1 as const,
  status: {
    installed: false,
    version: null,
    missing: true,
    checkedAt: '2026-07-19T12:00:00.000Z',
  },
};

const installedTool = (checkedAt = '2026-07-19T12:01:00.000Z'): AgentTool => ({
  ...tool,
  status: {
    ...tool.status,
    installed: true,
    missing: false,
    version: '1.2.3',
    checkedAt,
  },
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Tools host inventory and durable installation', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mocks.list.mockReset()
      .mockResolvedValueOnce({ tools: [tool], cachedForMs: 60_000 })
      .mockResolvedValue({
        tools: [installedTool()],
        cachedForMs: 60_000,
      });
    mocks.install.mockReset().mockResolvedValue({ jobId: 'job-1', room: 'job:job-1', toolId: 'codex' });
    mocks.waitForJob.mockReset().mockResolvedValue({ id: 'job-1', status: 'completed' });
  });

  it('requires typed confirmation, waits for the retained job, and force-rechecks reality', async () => {
    const user = userEvent.setup();
    render(<ToolsContent />);

    expect(await screen.findByText('Not installed')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Install' }));
    const confirm = screen.getByRole('button', { name: 'Start install' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type .*INSTALL CODEX.* to continue/i), 'INSTALL CODEX');
    await user.click(confirm);

    await waitFor(() => {
      expect(mocks.install).toHaveBeenCalledWith('codex', 'INSTALL CODEX', { timeoutMs: 15_000 });
      expect(mocks.waitForJob).toHaveBeenCalledWith('job-1', {
        timeoutMs: 30 * 60 * 1000,
        requestTimeoutMs: 10_000,
      });
      expect(mocks.list).toHaveBeenLastCalledWith(true, { timeoutMs: 10_000 });
    });
    expect(await screen.findByText('Ready · 1.2.3')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Install OpenAI Codex' })).not.toBeInTheDocument();
  });

  it('keeps verification failures distinct from a confirmed missing tool', async () => {
    mocks.list.mockReset().mockResolvedValue({
      tools: [{ ...tool, install: [], status: { ...tool.status, missing: false } }],
      cachedForMs: 60_000,
    });
    render(<ToolsContent />);
    expect(await screen.findByText('Verification failed')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('admits one typed-confirm installation in the same frame and keeps startup failure in the dialog', async () => {
    const user = userEvent.setup();
    let rejectInstall!: (reason?: unknown) => void;
    const install = new Promise<never>((_resolve, reject) => { rejectInstall = reject; });
    mocks.install.mockReset().mockReturnValueOnce(install);
    render(<ToolsContent />);

    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = screen.getByRole('dialog', { name: 'Install OpenAI Codex' });
    await user.type(within(dialog).getByLabelText(/INSTALL CODEX/i), 'INSTALL CODEX');
    const confirm = within(dialog).getByRole('button', { name: 'Start install' });
    act(() => {
      confirm.click();
      confirm.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.install).toHaveBeenCalledWith('codex', 'INSTALL CODEX', { timeoutMs: 15_000 });
    expect(await within(dialog).findByRole('button', { name: 'Starting install…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('dialog', { name: 'Install OpenAI Codex' })).toBeVisible();

    await act(async () => {
      rejectInstall({ response: { data: { error: 'Package mirror is unavailable' } } });
      await install.catch(() => undefined);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Package mirror is unavailable');
    expect(within(dialog).getByRole('button', { name: 'Start install' })).toBeEnabled();
  });

  it('fails closed when start admission is indeterminate and cannot submit again after close and reopen', async () => {
    mocks.install.mockReset().mockRejectedValueOnce(new Error('Connection closed before Portal received a retained job ID'));
    const user = userEvent.setup();
    const first = render(<ToolsContent />);

    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const confirmation = screen.getByRole('dialog', { name: 'Install OpenAI Codex' });
    await user.type(within(confirmation).getByLabelText(/INSTALL CODEX/i), 'INSTALL CODEX');
    await user.click(within(confirmation).getByRole('button', { name: 'Start install' }));

    const unresolved = await screen.findByRole('dialog', { name: /install admission is unresolved/i });
    expect(within(unresolved).getByRole('alert')).toHaveTextContent(/will not submit another installation/i);
    expect(mocks.install).toHaveBeenCalledTimes(1);
    await user.click(within(unresolved).getByRole('button', { name: 'Close' }));

    const review = screen.getByRole('button', { name: 'Review admission' });
    await user.click(review);
    expect(await screen.findByRole('dialog', { name: /install admission is unresolved/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Start install' })).not.toBeInTheDocument();
    expect(mocks.install).toHaveBeenCalledTimes(1);

    first.unmount();
    render(<ToolsContent />);
    expect(await screen.findByRole('button', { name: 'Review admission' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirmation dialog as the sole progress owner through fresh inventory convergence', async () => {
    const verification = deferred<{ tools: AgentTool[]; cachedForMs: number }>();
    mocks.list.mockReset()
      .mockResolvedValueOnce({ tools: [tool], cachedForMs: 60_000 })
      .mockReturnValueOnce(verification.promise);
    const user = userEvent.setup();
    const { container } = render(<ToolsContent />);

    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = screen.getByRole('dialog', { name: 'Install OpenAI Codex' });
    await user.type(within(dialog).getByLabelText(/INSTALL CODEX/i), 'INSTALL CODEX');
    await user.click(within(dialog).getByRole('button', { name: 'Start install' }));

    expect(await within(dialog).findByRole('button', { name: 'Verifying fresh inventory…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('dialog', { name: 'Install OpenAI Codex' })).toBeVisible();
    const backgroundInstall = container.querySelector<HTMLButtonElement>('button[aria-busy="false"]');
    expect(backgroundInstall).toBeDisabled();
    expect(backgroundInstall).not.toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      verification.resolve({ tools: [installedTool()], cachedForMs: 0 });
      await verification.promise;
    });
    expect(await screen.findByText('Ready · 1.2.3')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Install OpenAI Codex' })).not.toBeInTheDocument();
  });

  it('fails closed on stale inventory and retries proof without launching a second job', async () => {
    mocks.list.mockReset()
      .mockResolvedValueOnce({ tools: [tool], cachedForMs: 60_000 })
      .mockResolvedValueOnce({ tools: [installedTool(tool.status.checkedAt)], cachedForMs: 0 })
      .mockResolvedValueOnce({ tools: [installedTool()], cachedForMs: 0 });
    const user = userEvent.setup();
    render(<ToolsContent />);

    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = screen.getByRole('dialog', { name: 'Install OpenAI Codex' });
    await user.type(within(dialog).getByLabelText(/INSTALL CODEX/i), 'INSTALL CODEX');
    await user.click(within(dialog).getByRole('button', { name: 'Start install' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/stale tool inventory/i);
    const retry = within(dialog).getByRole('button', { name: 'Retry verification' });
    expect(retry).toBeEnabled();
    await user.click(retry);

    expect(await screen.findByText('Ready · 1.2.3')).toBeVisible();
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.waitForJob).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it('retains a failed retained-job proof and never creates a replacement job on retry', async () => {
    mocks.waitForJob
      .mockRejectedValueOnce(new Error('Tool installation status check timed out'))
      .mockResolvedValueOnce({ id: 'job-1', status: 'completed' });
    const user = userEvent.setup();
    render(<ToolsContent />);

    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = screen.getByRole('dialog', { name: 'Install OpenAI Codex' });
    await user.type(within(dialog).getByLabelText(/INSTALL CODEX/i), 'INSTALL CODEX');
    await user.click(within(dialog).getByRole('button', { name: 'Start install' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/status check timed out/i);
    await user.click(within(dialog).getByRole('button', { name: 'Retry verification' }));

    expect(await screen.findByText('Ready · 1.2.3')).toBeVisible();
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.waitForJob).toHaveBeenCalledTimes(2);
  });

  it('clears a definitively failed retained job so a new deliberate install can start', async () => {
    mocks.waitForJob
      .mockRejectedValueOnce(Object.assign(new Error('Tool installation failed'), {
        code: 'TOOL_INSTALL_JOB_TERMINAL',
        terminalStatus: 'error',
      }))
      .mockResolvedValueOnce({ id: 'job-2', status: 'completed' });
    mocks.install
      .mockResolvedValueOnce({ jobId: 'job-1', room: 'job:job-1', toolId: 'codex' })
      .mockResolvedValueOnce({ jobId: 'job-2', room: 'job:job-2', toolId: 'codex' });
    const user = userEvent.setup();
    render(<ToolsContent />);

    await user.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = screen.getByRole('dialog', { name: 'Install OpenAI Codex' });
    await user.type(within(dialog).getByLabelText(/INSTALL CODEX/i), 'INSTALL CODEX');
    await user.click(within(dialog).getByRole('button', { name: 'Start install' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Tool installation failed');

    await user.click(within(dialog).getByRole('button', { name: 'Start install' }));
    expect(await screen.findByText('Ready · 1.2.3')).toBeVisible();
    expect(mocks.install).toHaveBeenCalledTimes(2);
    expect(mocks.waitForJob).toHaveBeenNthCalledWith(2, 'job-2', {
      timeoutMs: 30 * 60 * 1000,
      requestTimeoutMs: 10_000,
    });
  });
});
