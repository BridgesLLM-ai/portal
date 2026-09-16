// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MissingCliInstallPanel from './MissingCliInstallPanel';
import type { AgentTool } from '../../api/agentTools';
const mocks = vi.hoisted(() => ({ install: vi.fn(), list: vi.fn(), wait: vi.fn(), jobs: vi.fn() }));
vi.mock('../../api/agentTools', () => ({ agentToolsAPI: { install: mocks.install, list: mocks.list },
  toolInstallConfirmationPhrase: (id: string) => `INSTALL ${id.toUpperCase()}`, waitForToolInstallJob: mocks.wait }));
vi.mock('../../api/agentJobs', () => ({ agentJobsAPI: { list: mocks.jobs } }));
const tool: AgentTool = { id: 'claude-code', name: 'Claude Code', description: '', install: [], commands: [], authRequired: true, tier: 1,
  status: { installed: false, missing: true, version: null, checkedAt: 'now', state: 'absent', installAvailable: true } };
const installed = { ...tool, status: { ...tool.status, installed: true, missing: false, version: '2.1.31' } };
describe('MissingCliInstallPanel', () => {
  beforeEach(() => { vi.resetAllMocks(); window.sessionStorage.clear(); });
  it('offers one install and only continues after completed job and installed inventory agree', async () => {
    mocks.install.mockResolvedValue({ jobId: 'job-1' }); mocks.wait.mockResolvedValue({ status: 'completed' });
    mocks.list.mockResolvedValue({ tools: [installed] }); const inventory = vi.fn();
    render(<MissingCliInstallPanel toolId="claude-code" tool={tool} onInventory={inventory} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install Claude Code' }));
    expect(await screen.findByText(/Claude Code is installed \(2.1.31\)/)).toBeInTheDocument();
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith('claude-code', 'INSTALL CLAUDE-CODE', { timeoutMs: 15000 });
    expect(inventory).toHaveBeenCalledWith([installed]);
  });
  it('does not claim success when the completed job is absent from the refreshed inventory', async () => {
    mocks.install.mockResolvedValue({ jobId: 'job-2' }); mocks.wait.mockResolvedValue({ status: 'completed' });
    mocks.list.mockResolvedValue({ tools: [tool] });
    render(<MissingCliInstallPanel toolId="claude-code" tool={tool} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install Claude Code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/still does not show Claude Code as installed/);
    expect(screen.queryByText(/Continue to sign in below/)).not.toBeInTheDocument();
  });
  it('recovers a lost start response through the retained job list without another install', async () => {
    mocks.install.mockRejectedValue(new Error('Network lost'));
    mocks.jobs.mockResolvedValue([{ id: 'retained', toolId: '_install:claude-code', status: 'completed', createdAt: '2026-09-15T16:00:00Z' }]);
    mocks.wait.mockResolvedValue({ status: 'completed' }); mocks.list.mockResolvedValue({ tools: [installed] });
    render(<MissingCliInstallPanel toolId="claude-code" tool={tool} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install Claude Code' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check status' }));
    expect(await screen.findByText(/Continue to sign in below/)).toBeInTheDocument();
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(mocks.wait).toHaveBeenCalledWith('retained', expect.any(Object));
  });
  it('resumes a pending job after remount instead of reissuing it', async () => {
    window.sessionStorage.setItem('bridgesllm.aiSetup.cliInstall.v1', JSON.stringify({toolId:'claude-code',jobId:'retained',startedAt:'2026-09-15T16:00:00Z'}));
    mocks.wait.mockResolvedValue({ status: 'completed' }); mocks.list.mockResolvedValue({ tools: [installed] });
    render(<MissingCliInstallPanel toolId="claude-code" tool={tool} />);
    await waitFor(() => expect(screen.getByText(/Continue to sign in below/)).toBeInTheDocument());
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it('shows an unsupported-install reason with a read-only refresh', () => {
    const unavailable = { ...tool, status: { ...tool.status, installAvailable: false, installUnavailableCode: 'CLI_PLATFORM_UNSUPPORTED' } };
    render(<MissingCliInstallPanel toolId="claude-code" tool={unavailable} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/architecture/);
    expect(screen.queryByRole('button', { name: 'Install Claude Code' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });
});
