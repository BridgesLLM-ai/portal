// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsContent } from './SkillsPage';

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

describe('Skills and plugins read-only maintenance boundary', () => {
  const weatherSkill = {
    name: 'weather',
    description: 'Weather skill',
    eligible: true,
    disabled: false,
    source: 'managed',
  };

  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue({ skills: [weatherSkill] });
    mocks.listPlugins.mockReset().mockResolvedValue({
      plugins: [{
        id: '@openclaw/example-plugin',
        name: 'Example Plugin',
        version: '1.2.3',
        status: 'loaded',
        enabled: true,
      }],
    });
    mocks.explore.mockReset().mockResolvedValue({
      results: [{
        name: 'Friendly Skill Name',
        slug: 'canonical-skill',
        description: 'Marketplace result',
      }],
    });
    mocks.search.mockReset().mockResolvedValue({ results: [] });
    mocks.install.mockReset();
    mocks.uninstall.mockReset();
    mocks.installPlugin.mockReset();
  });

  it('preserves inventories while removing every positive extension mutation control', async () => {
    const user = userEvent.setup();
    render(<SkillsContent />);

    expect(await screen.findByText('Extension changes paused')).toBeVisible();
    expect(screen.getByText(/Installed skill and plugin status remain available/i)).toBeVisible();
    expect(screen.getByText(/Marketplace browsing and search require a ClawHub host package that passes Portal execution admission/i)).toBeVisible();
    expect(await screen.findByText('Weather skill')).toBeVisible();
    expect(await screen.findByText('Example Plugin')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Show details for weather' }));
    expect(screen.getByText('Skill changes are paused until transactional maintenance is available.')).toBeVisible();

    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Plugin' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Plugin package specification')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /host extension/i })).not.toBeInTheDocument();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.uninstall).not.toHaveBeenCalled();
    expect(mocks.installPlugin).not.toHaveBeenCalled();
  });

  it('keeps ClawHub browse and search read-only without submitting a marketplace install', async () => {
    const user = userEvent.setup();
    mocks.search.mockResolvedValue({
      results: [{
        name: 'Search Result',
        slug: 'search-result',
        description: 'Found without changing the host',
      }],
    });
    render(<SkillsContent />);

    expect(await screen.findByText('Friendly Skill Name')).toBeVisible();
    expect(screen.getByLabelText('canonical-skill cannot be installed while extension changes are paused')).toHaveTextContent('Changes paused');

    await user.type(screen.getByRole('textbox', { name: 'Search marketplace skills' }), 'search');
    await user.click(screen.getByRole('button', { name: 'Search marketplace skills' }));

    expect(await screen.findByText('Search Result')).toBeVisible();
    expect(mocks.search).toHaveBeenCalledWith('search');
    expect(screen.getByLabelText('search-result cannot be installed while extension changes are paused')).toHaveTextContent('Changes paused');
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.uninstall).not.toHaveBeenCalled();
    expect(mocks.installPlugin).not.toHaveBeenCalled();
  });

  it('renders an explicit unavailable marketplace without hiding installed inventories', async () => {
    const user = userEvent.setup();
    mocks.explore.mockRejectedValueOnce(Object.assign(
      new Error('Request failed with status code 503'),
      {
        response: {
          status: 503,
          data: {
            state: 'unavailable',
            reason: 'ClawHub 0.23.1 is recognized for status only and cannot be executed by Portal.',
            remediation: 'Portal does not currently provide ClawHub package maintenance. Marketplace browsing stays unavailable until a supported Host Tools Maintenance operation ships.',
            results: [],
          },
        },
      },
    ));
    render(<SkillsContent />);

    expect(await screen.findByText('Weather skill')).toBeVisible();
    expect(await screen.findByText('Example Plugin')).toBeVisible();
    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent('ClawHub marketplace unavailable');
    expect(unavailable).toHaveTextContent('ClawHub 0.23.1 is recognized for status only');
    expect(unavailable).toHaveTextContent('Portal does not currently provide ClawHub package maintenance');
    expect(screen.getByRole('textbox', { name: 'Search marketplace skills' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Search marketplace skills' })).toBeDisabled();
    expect(screen.queryByText('No marketplace results.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Marketplace browsing and installed extension status remain available/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry marketplace check' }));

    expect(await screen.findByText('Friendly Skill Name')).toBeVisible();
    expect(screen.queryByText('ClawHub marketplace unavailable')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search marketplace skills' })).toBeEnabled();
    expect(mocks.explore).toHaveBeenCalledTimes(2);
  });

  it('replaces stale search results with the unavailable state when search admission fails', async () => {
    const user = userEvent.setup();
    mocks.search.mockRejectedValueOnce(Object.assign(
      new Error('Request failed with status code 503'),
      {
        response: {
          status: 503,
          data: {
            state: 'unavailable',
            reason: 'ClawHub package integrity admission failed.',
            remediation: 'Portal does not currently provide ClawHub package maintenance. Marketplace browsing stays unavailable until a supported Host Tools Maintenance operation ships.',
            results: [],
          },
        },
      },
    ));
    render(<SkillsContent />);

    expect(await screen.findByText('Friendly Skill Name')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Search marketplace skills' }), 'blocked');
    await user.click(screen.getByRole('button', { name: 'Search marketplace skills' }));

    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent('ClawHub package integrity admission failed.');
    expect(screen.queryByText('Friendly Skill Name')).not.toBeInTheDocument();
    expect(screen.queryByText('0 results for "blocked"')).not.toBeInTheDocument();
    expect(screen.queryByText('No marketplace results.')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search marketplace skills' })).toBeDisabled();
  });

  it('labels an already-installed marketplace skill without exposing another action', async () => {
    mocks.explore.mockResolvedValue({
      results: [{ name: 'Weather', slug: 'weather', description: 'Already present' }],
    });
    render(<SkillsContent />);

    const installedStatus = await screen.findByLabelText('weather is installed');
    expect(installedStatus).toHaveTextContent('Installed');
    expect(installedStatus.tagName).toBe('SPAN');
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.uninstall).not.toHaveBeenCalled();
    expect(mocks.installPlugin).not.toHaveBeenCalled();
  });

  it('keeps usable skill browsing visible when only plugin discovery fails', async () => {
    mocks.listPlugins.mockRejectedValueOnce(new Error('plugin registry unavailable'));
    render(<SkillsContent />);

    expect(await screen.findByText('Weather skill')).toBeVisible();
    expect(screen.getByText(/Some extension sources are unavailable: plugin registry unavailable/i)).toBeVisible();
    expect(screen.queryByText('Failed to load extensions')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(false));
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.uninstall).not.toHaveBeenCalled();
    expect(mocks.installPlugin).not.toHaveBeenCalled();
  });
});
