// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsContent } from './SkillsPage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: ReactModule.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
        const {
          children,
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          variants: _variants,
          layout: _layout,
          ...domProps
        } = props;
        return <div ref={ref} {...domProps}>{children as React.ReactNode}</div>;
      }),
    },
  };
});

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listPlugins: vi.fn(),
  explore: vi.fn(),
  search: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  installPlugin: vi.fn(),
  jobStatus: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  skillsAPI: {
    list: mocks.list,
    listPlugins: mocks.listPlugins,
    explore: mocks.explore,
    search: mocks.search,
    install: mocks.install,
    uninstall: mocks.uninstall,
    installPlugin: mocks.installPlugin,
  },
}));

vi.mock('../api/agentJobs', () => ({
  agentJobsAPI: { status: mocks.jobStatus },
}));

describe('Skills and plugins durable mutation flow', () => {
  const weatherSkill = {
    name: 'weather',
    description: 'Weather skill',
    eligible: true,
    disabled: false,
    source: 'managed',
  };

  beforeEach(() => {
    mocks.list.mockReset()
      .mockResolvedValueOnce({ skills: [weatherSkill] })
      .mockResolvedValue({ skills: [] });
    mocks.listPlugins.mockReset().mockResolvedValue({ plugins: [] });
    mocks.explore.mockReset().mockResolvedValue({ results: [] });
    mocks.search.mockReset().mockResolvedValue({ results: [] });
    mocks.install.mockReset().mockResolvedValue({ jobId: 'job-install' });
    mocks.uninstall.mockReset().mockResolvedValue({ jobId: 'job-remove' });
    mocks.installPlugin.mockReset().mockResolvedValue({ jobId: 'job-plugin' });
    mocks.jobStatus.mockReset().mockResolvedValue({ status: 'completed' });
  });

  afterEach(() => vi.useRealTimers());

  it('requires typed confirmation and tracks skill removal as a retained job', async () => {
    const user = userEvent.setup();
    render(<SkillsContent />);

    await user.click(await screen.findByRole('button', { name: 'Show details for weather' }));
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));

    const confirmButton = screen.getByRole('button', { name: 'Remove extension' });
    expect(confirmButton).toBeDisabled();
    await user.type(screen.getByLabelText(/Type .*UNINSTALL SKILL weather.* to continue/i), 'UNINSTALL SKILL weather');
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mocks.uninstall).toHaveBeenCalledWith('weather', 'UNINSTALL SKILL weather');
      expect(mocks.jobStatus).toHaveBeenCalledWith('job-remove', { timeoutMs: 8000 });
      expect(mocks.list).toHaveBeenLastCalledWith(true);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Removed weather.');
  });

  it('uses the server job contract for plugin installation', async () => {
    const user = userEvent.setup();
    mocks.listPlugins.mockReset()
      .mockResolvedValueOnce({ plugins: [] })
      .mockResolvedValue({ plugins: [{ id: '@example/plugin', source: '/opt/node_modules/@example/plugin/index.js' }] });
    render(<SkillsContent />);

    const spec = 'npm:@example/plugin';
    await user.type(await screen.findByLabelText('Plugin package specification'), spec);
    await user.click(screen.getByRole('button', { name: 'Install Plugin' }));
    await user.type(screen.getByLabelText(/Type .*INSTALL PLUGIN npm:@example\/plugin.* to continue/i), `INSTALL PLUGIN ${spec}`);
    await user.click(screen.getByRole('button', { name: 'Install extension' }));

    await waitFor(() => {
      expect(mocks.installPlugin).toHaveBeenCalledWith(spec, `INSTALL PLUGIN ${spec}`);
      expect(mocks.jobStatus).toHaveBeenCalledWith('job-plugin', { timeoutMs: 8000 });
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Install host extension' })).not.toBeInTheDocument());
  });

  it('keeps the usable skill inventory visible when only plugin discovery fails', async () => {
    mocks.listPlugins.mockRejectedValueOnce(new Error('plugin registry unavailable'));
    render(<SkillsContent />);

    expect(await screen.findByText('Weather skill')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Some extension sources are unavailable: plugin registry unavailable',
    );
    expect(screen.queryByText('Failed to load extensions')).not.toBeInTheDocument();
  });

  it('installs the canonical marketplace slug instead of a display title', async () => {
    const user = userEvent.setup();
    mocks.list.mockReset()
      .mockResolvedValueOnce({ skills: [] })
      .mockResolvedValue({ skills: [{ ...weatherSkill, name: 'canonical-skill' }] });
    mocks.explore.mockResolvedValue({
      results: [{ name: 'Friendly Skill Name', slug: 'canonical-skill', description: 'Marketplace result' }],
    });
    mocks.install.mockResolvedValue({ jobId: 'job-install' });
    render(<SkillsContent />);

    await user.click(await screen.findByRole('button', { name: 'Install' }));
    await user.type(
      screen.getByLabelText(/Type .*INSTALL SKILL canonical-skill.* to continue/i),
      'INSTALL SKILL canonical-skill',
    );
    await user.click(screen.getByRole('button', { name: 'Install extension' }));

    await waitFor(() => {
      expect(mocks.install).toHaveBeenCalledWith('canonical-skill', 'INSTALL SKILL canonical-skill');
    });
  });

  it('admits only one immutable host mutation across same-frame confirmations and targets', async () => {
    const user = userEvent.setup();
    const installGate = deferred<{ jobId: string }>();
    mocks.list.mockResolvedValue({ skills: [] });
    mocks.explore.mockResolvedValue({
      results: [{ name: 'Other Skill', slug: 'other-skill', description: 'Second mutation target' }],
    });
    mocks.installPlugin.mockReturnValueOnce(installGate.promise);
    mocks.listPlugins.mockReset()
      .mockResolvedValueOnce({ plugins: [] })
      .mockResolvedValue({ plugins: [{ id: '@example/guarded-plugin' }] });
    render(<SkillsContent />);

    const marketplaceInstall = await screen.findByRole('button', { name: 'Install' });
    const spec = 'npm:@example/guarded-plugin';
    await user.type(screen.getByLabelText('Plugin package specification'), spec);
    await user.click(screen.getByRole('button', { name: 'Install Plugin' }));
    await user.type(
      screen.getByLabelText(/Type .*INSTALL PLUGIN npm:@example\/guarded-plugin.* to continue/i),
      `INSTALL PLUGIN ${spec}`,
    );
    const confirm = screen.getByRole('button', { name: 'Install extension' });

    act(() => {
      confirm.click();
      confirm.click();
      marketplaceInstall.click();
    });

    expect(mocks.installPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.installPlugin).toHaveBeenCalledWith(spec, `INSTALL PLUGIN ${spec}`);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Installing extension…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close confirmation dialog' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Install host extension' })).toBeVisible();
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false);
    const pushState = vi.spyOn(window.history, 'pushState');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Install host extension' })).toBeVisible();
    pushState.mockRestore();

    installGate.resolve({ jobId: 'job-plugin' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Install host extension' })).not.toBeInTheDocument());
  });

  it('retains a failed mutation on its initiating dialog and permits an explicit retry', async () => {
    const user = userEvent.setup();
    mocks.uninstall
      .mockRejectedValueOnce(new Error('host extension service refused the request'))
      .mockResolvedValueOnce({ jobId: 'job-remove' });
    render(<SkillsContent />);

    await user.click(await screen.findByRole('button', { name: 'Show details for weather' }));
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    await user.type(screen.getByLabelText(/Type .*UNINSTALL SKILL weather.* to continue/i), 'UNINSTALL SKILL weather');
    await user.click(screen.getByRole('button', { name: 'Remove extension' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('host extension service refused the request');
    expect(screen.getByRole('dialog', { name: 'Remove host extension' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove extension' }));

    await waitFor(() => expect(mocks.uninstall).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove host extension' })).not.toBeInTheDocument());
  });

  it('bounds an unresolved status RPC and retries verification without starting a second job', async () => {
    const user = userEvent.setup();
    mocks.jobStatus.mockReturnValue(new Promise(() => undefined));
    render(<SkillsContent />);

    await user.click(await screen.findByRole('button', { name: 'Show details for weather' }));
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    await user.type(screen.getByLabelText(/Type .*UNINSTALL SKILL weather.* to continue/i), 'UNINSTALL SKILL weather');

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove extension' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    vi.useRealTimers();

    expect(await screen.findByRole('alert')).toHaveTextContent('did not answer a bounded status request');
    expect(screen.getByRole('dialog', { name: 'Remove host extension' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry verification' })).toBeEnabled();
    expect(mocks.uninstall).toHaveBeenCalledTimes(1);
  });

  it('keeps stale inventory in the dialog and retries only fresh proof for the retained job', async () => {
    const user = userEvent.setup();
    mocks.list.mockReset()
      .mockResolvedValueOnce({ skills: [weatherSkill] })
      .mockResolvedValueOnce({ skills: [weatherSkill] })
      .mockResolvedValue({ skills: [] });
    render(<SkillsContent />);

    await user.click(await screen.findByRole('button', { name: 'Show details for weather' }));
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    await user.type(screen.getByLabelText(/Type .*UNINSTALL SKILL weather.* to continue/i), 'UNINSTALL SKILL weather');
    await user.click(screen.getByRole('button', { name: 'Remove extension' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('does not prove weather was removed');
    expect(screen.getByRole('dialog', { name: 'Remove host extension' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry verification' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove host extension' })).not.toBeInTheDocument());
    expect(mocks.uninstall).toHaveBeenCalledTimes(1);
    expect(mocks.jobStatus).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it('fails closed when fresh inventory rejects and preserves a safe readback retry', async () => {
    const user = userEvent.setup();
    mocks.list.mockReset()
      .mockResolvedValueOnce({ skills: [weatherSkill] })
      .mockRejectedValueOnce(new Error('fresh skill inventory unavailable'))
      .mockResolvedValue({ skills: [] });
    render(<SkillsContent />);

    await user.click(await screen.findByRole('button', { name: 'Show details for weather' }));
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    await user.type(screen.getByLabelText(/Type .*UNINSTALL SKILL weather.* to continue/i), 'UNINSTALL SKILL weather');
    await user.click(screen.getByRole('button', { name: 'Remove extension' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('fresh skill inventory unavailable');
    expect(screen.getByRole('button', { name: 'Retry verification' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Retry verification' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove host extension' })).not.toBeInTheDocument());
    expect(mocks.uninstall).toHaveBeenCalledTimes(1);
  });
});
