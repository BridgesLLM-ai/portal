// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette, { dynamicCommandId } from './CommandPalette';
import { WORKSPACE_AUTHORIZATION_CHANGED_EVENT } from '../utils/workspaceAuthorization';
import { parseProjectDeepLink } from '../utils/projectSurface';
import { parseFileDeepLink } from '../utils/workspaceNavigation';

const paletteMocks = vi.hoisted(() => ({
  actor: {
    id: 'actor-1',
    role: 'USER',
    accountStatus: 'ACTIVE',
    authorizationVersion: 1,
  },
  projectSearch: vi.fn(),
  fileList: vi.fn(),
  publicSettings: {
    mail: { available: true, reason: null },
  } as Record<string, unknown>,
}));

vi.mock('../api/endpoints', () => ({
  projectsAPI: { search: paletteMocks.projectSearch },
  filesAPI: { list: paletteMocks.fileList },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    user: paletteMocks.actor,
  }),
}));

vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => paletteMocks.publicSettings,
}));

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  const components = new Map<string, React.ComponentType<any>>();
  const motion = new Proxy({}, {
    get: (_target, tag: string) => {
      const existing = components.get(tag);
      if (existing) return existing;
      const component = ReactModule.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
        const {
          children,
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          ...domProps
        } = props;
        return ReactModule.createElement(tag, { ...domProps, ref }, children as React.ReactNode);
      });
      components.set(tag, component);
      return component;
    },
  });
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderPalette(onClose = vi.fn()) {
  render(
    <MemoryRouter
      initialEntries={['/dashboard']}
    >
      <CommandPalette isOpen onClose={onClose} />
      <LocationProbe />
    </MemoryRouter>,
  );
  return { onClose };
}

describe('CommandPalette global Files and Projects search', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    paletteMocks.publicSettings = {
      mail: { available: true, reason: null },
    };
    paletteMocks.projectSearch.mockReset().mockResolvedValue({
      query: 'needle',
      results: [
        { kind: 'project', project: 'Needle-App', name: 'Needle-App' },
        {
          kind: 'file',
          project: 'Fourth-Project',
          name: 'needle-controller.ts',
          path: 'src/features/deep/needle-controller.ts',
        },
      ],
      truncated: false,
      visited: 40,
    });
    paletteMocks.fileList.mockReset().mockResolvedValue({
      files: [{
        id: 'library-file-1',
        path: 'stored/9f2-quarterly-needle.pdf',
        originalName: 'Quarterly Needle.pdf',
      }],
      total: 1,
      page: 1,
      pages: 1,
    });
  });

  it('routes unavailable Mail to its explanation without advertising a working inbox', async () => {
    const user = userEvent.setup();
    paletteMocks.publicSettings = {
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };
    const { onClose } = renderPalette();

    expect(await screen.findByText('Mail unavailable — view details')).toBeInTheDocument();
    expect(screen.getByText(
      'Mail requires a public domain and is unavailable in private Tailnet mode.',
    )).toBeInTheDocument();

    await user.click(screen.getByText('Mail unavailable — view details'));

    expect(screen.getByTestId('location')).toHaveTextContent('/mail');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps domain-mode Mail wording unchanged', async () => {
    renderPalette();

    expect(await screen.findByText('Go to Mail')).toBeInTheDocument();
    expect(screen.queryByText(/Mail unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Mail availability pending/)).not.toBeInTheDocument();
  });

  it('fails closed in wording while Mail availability is unresolved', async () => {
    paletteMocks.publicSettings = {};
    renderPalette();

    expect(await screen.findByText('Mail availability pending — view details')).toBeInTheDocument();
    expect(screen.getByText('Open Mail to view its current availability.')).toBeInTheDocument();
  });

  it('labels Library and Project results distinctly and deep-links a Library preview', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();

    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'needle');

    expect(await screen.findByText('Project • Open project')).toBeInTheDocument();
    expect(screen.getByText('Project file • Fourth-Project/src/features/deep/needle-controller.ts')).toBeInTheDocument();
    expect(screen.getByText('Files library • Quarterly Needle.pdf')).toBeInTheDocument();

    await user.click(screen.getByText('Quarterly Needle.pdf'));

    expect(onClose).toHaveBeenCalledTimes(1);
    const route = screen.getByTestId('location').textContent || '';
    expect(route).toMatch(/^\/files\?open=[a-f0-9]{32}$/);
    expect(route).not.toContain('library-file-1');
    expect(route).not.toContain('quarterly');
    expect(parseFileDeepLink(route.split('?')[1], {
      actorUserId: paletteMocks.actor.id,
      authorizationVersion: paletteMocks.actor.authorizationVersion,
    })).toEqual({
      fileId: 'library-file-1',
      path: 'stored/9f2-quarterly-needle.pdf',
    });
  });

  it('hands a nested Project file to Projects without issuing browser tree crawls', async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'needle');
    await user.click(await screen.findByText('needle-controller.ts'));

    expect(paletteMocks.projectSearch).toHaveBeenCalledWith('needle', 20, expect.any(AbortSignal));
    expect(window.localStorage.getItem('palette-open-file')).toBeNull();
    expect(window.sessionStorage.getItem('palette-open-file')).toBeNull();
    const route = screen.getByTestId('location').textContent || '';
    expect(route).toMatch(/^\/projects\?open=[a-f0-9]{32}$/);
    expect(route).not.toContain('Fourth-Project');
    expect(route).not.toContain('needle-controller');
    expect(parseProjectDeepLink(route.split('?')[1], {
      actorUserId: paletteMocks.actor.id,
      authorizationVersion: paletteMocks.actor.authorizationVersion,
    })).toEqual({
      project: 'Fourth-Project',
      file: 'src/features/deep/needle-controller.ts',
    });
  });

  it('shows loading and keeps partial results honest when one source fails', async () => {
    const user = userEvent.setup();
    paletteMocks.projectSearch.mockRejectedValue(new Error('project search offline'));
    renderPalette();

    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'needle');

    expect(screen.getByText('Searching Files and Projects…')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Project search is unavailable; showing Files results.',
    );
    expect(screen.getByRole('listbox')).not.toContainElement(screen.getByRole('alert'));
    expect(screen.getByText('Quarterly Needle.pdf')).toBeInTheDocument();
  });

  it('discloses bounded result truncation instead of implying the list is complete', async () => {
    const user = userEvent.setup();
    paletteMocks.projectSearch.mockResolvedValue({
      query: 'needle',
      results: [],
      truncated: true,
      visited: 20_000,
    });
    paletteMocks.fileList.mockResolvedValue({ files: [], total: 0 });
    renderPalette();

    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'needle');

    await waitFor(() => expect(screen.getByText(
      'Search limit reached. Refine the query for a complete result set.',
    )).toBeInTheDocument());
  });

  it('uses collision-free ARIA-safe IDs for spaces, Unicode, and separator-like tuples', async () => {
    const user = userEvent.setup();
    paletteMocks.projectSearch.mockResolvedValue({
      query: 'result',
      results: [
        { kind: 'file', project: 'a-b', name: 'result-c', path: 'c' },
        { kind: 'file', project: 'a', name: 'result-b-c', path: 'b-c' },
        { kind: 'file', project: 'Space Ω Project', name: 'result Ω.ts', path: 'src/space Ω.ts' },
      ],
      truncated: false,
      visited: 3,
    });
    paletteMocks.fileList.mockResolvedValue({ files: [], total: 0 });
    renderPalette();

    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'result');
    await screen.findByText('result Ω.ts');
    const options = screen.getAllByRole('option');
    const ids = options.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^command-[A-Za-z0-9_-]+$/);
    expect(dynamicCommandId('project-file', 'a-b', 'c')).not.toBe(
      dynamicCommandId('project-file', 'a', 'b-c'),
    );
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', ids[0]);
  });

  it('synchronously removes rendered workspace results when authorization changes', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette();
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'needle');
    expect(await screen.findByText('Quarterly Needle.pdf')).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, {
      detail: { userId: 'actor-1', authorizationVersion: 2, source: 'socket' },
    }));

    await waitFor(() => expect(screen.queryByText('Quarterly Needle.pdf')).not.toBeInTheDocument());
    expect(screen.queryByText('needle-controller.ts')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot reinsert a deferred search result after synchronous quarantine', async () => {
    const user = userEvent.setup();
    let resolveProjects!: (value: any) => void;
    let resolveFiles!: (value: any) => void;
    paletteMocks.projectSearch.mockImplementation(() => new Promise((resolve) => {
      resolveProjects = resolve;
    }));
    paletteMocks.fileList.mockImplementation(() => new Promise((resolve) => {
      resolveFiles = resolve;
    }));
    const { onClose } = renderPalette();
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'delayed');
    await waitFor(() => expect(paletteMocks.projectSearch).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new CustomEvent(WORKSPACE_AUTHORIZATION_CHANGED_EVENT, {
        detail: { userId: 'actor-1', authorizationVersion: 2, source: 'socket' },
      }));
      resolveProjects({
        query: 'delayed',
        results: [{ kind: 'project', project: 'Owner Secret', name: 'Owner Secret' }],
        truncated: false,
        visited: 1,
      });
      resolveFiles({
        files: [{
          id: 'stale-file',
          path: 'owner/stale.txt',
          originalName: 'Stale Owner File',
        }],
        total: 1,
      });
    });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Owner Secret')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale Owner File')).not.toBeInTheDocument();
  });
});
