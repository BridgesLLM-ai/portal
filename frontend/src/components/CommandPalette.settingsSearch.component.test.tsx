// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';

const mocks = vi.hoisted(() => ({
  actor: { id: 'owner-1', role: 'OWNER', accountStatus: 'ACTIVE', authorizationVersion: 1 },
  projects: vi.fn(), files: vi.fn(),
  publicSettings: { mail: { available: true, reason: null } },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuthStore: () => ({ user: mocks.actor }) }));
vi.mock('../api/endpoints', () => ({ projectsAPI: { search: mocks.projects }, filesAPI: { list: mocks.files } }));
vi.mock('../hooks/usePublicSettings', () => ({ usePublicSettings: () => mocks.publicSettings }));

function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
const closed = vi.fn();
function Host() { return <MemoryRouter initialEntries={['/dashboard']}><CommandPalette isOpen onClose={closed} /><Location /></MemoryRouter>; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  mocks.actor = { id: 'owner-1', role: 'OWNER', accountStatus: 'ACTIVE', authorizationVersion: 1 };
  mocks.projects.mockReset().mockReturnValue(new Promise(() => {}));
  mocks.files.mockReset().mockReturnValue(new Promise(() => {}));
  closed.mockReset();
});

describe('public command palette settings search', () => {
  it('opens a Settings control before workspace search resolves', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'backup path');
    expect(screen.getByRole('option', { name: /^Backup storage path/ })).toHaveTextContent('Settings › Backups');
    expect(screen.getByText('Searching Files and Projects…')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=backups');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it.each(['ollama', 'agent zero', 'api key'])('reaches retained public provider settings via %s', async query => {
    const user = userEvent.setup(); render(<Host />);
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), query);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=ai-providers');
  });

  it.each(['SUB_ADMIN', 'USER', 'VIEWER', 'unknown'])('does not advertise Owner configuration to %s', async role => {
    mocks.actor.role = role;
    const user = userEvent.setup(); render(<Host />);
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'ollama');
    expect(screen.queryByRole('option', { name: /Ollama local/ })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('combobox', { name: 'Search commands' }));
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'sound effects');
    expect(screen.getByRole('option', { name: /Sound effects/ })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=profile');
  });

  it('keeps static destinations first and the chosen highlight when workspace results arrive', async () => {
    const projects = deferred<any>(); const files = deferred<any>();
    mocks.projects.mockReturnValue(projects.promise); mocks.files.mockReturnValue(files.promise);
    const user = userEvent.setup(); render(<Host />);
    const input = screen.getByRole('combobox', { name: 'Search commands' });
    await user.type(input, 'backup');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const selectedId = input.getAttribute('aria-activedescendant');
    const selected = document.getElementById(selectedId!);
    expect(selected).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(mocks.projects).toHaveBeenCalled());
    await act(async () => {
      projects.resolve({ results: [{ kind: 'project', project: 'backup-app', name: 'backup-app' }], truncated: false });
      files.resolve({ files: [], total: 0 });
    });
    expect(await screen.findByRole('option', { name: /backup-app/ })).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-activedescendant', selectedId);
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]).toHaveTextContent('backup-app');
    expect(document.getElementById(selectedId!)).toHaveAttribute('aria-selected', 'true');
  });
});
