// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GlobalControls from './GlobalControls';
import { claimRouteOperation, releaseRouteOperation } from '../contexts/RouteOperationContext';

const controlMocks = vi.hoisted(() => ({
  actor: { id: 'actor-1', role: 'USER', accountStatus: 'ACTIVE' },
  projectSearch: vi.fn(),
  fileList: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  projectsAPI: { search: controlMocks.projectSearch },
  filesAPI: { list: controlMocks.fileList },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    user: controlMocks.actor,
  }),
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
  return { motion };
});

function renderControls() {
  return render(
    <MemoryRouter
      initialEntries={['/dashboard']}
    >
      <GlobalControls>
        <button type="button">Underlying action</button>
      </GlobalControls>
    </MemoryRouter>,
  );
}

describe('GlobalControls modal ownership', () => {
  beforeEach(() => {
    window.localStorage.setItem('portalKeyboardHintSeen', 'true');
    controlMocks.projectSearch.mockReset().mockResolvedValue({ results: [], truncated: false, visited: 0 });
    controlMocks.fileList.mockReset().mockResolvedValue({ files: [], total: 0 });
  });

  it('keeps global surfaces mutually exclusive and restores page ownership in LIFO order', async () => {
    renderControls();
    const underlyingAction = screen.getByRole('button', { name: 'Underlying action' });
    underlyingAction.focus();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    expect(underlyingAction.closest('[aria-hidden="true"]')).not.toBeNull();

    fireEvent.keyDown(window, { key: '?', shiftKey: true });

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('Search project files')).toBeVisible();
    expect(screen.queryByText('Close tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Navigate up')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete file')).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(underlyingAction).toHaveFocus());
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
  });

  it('moves the coach mark away from Project Chat and removes it while a route operation owns the page', async () => {
    const qualificationOwner = Object.freeze({ kind: 'project-provider-qualification' });
    window.localStorage.setItem('portalKeyboardHintSeen', 'false');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      renderControls();
      act(() => { vi.advanceTimersByTime(5000); });

      expect(screen.getByText('💡 Pro Tip')).toBeVisible();
      expect(document.querySelector('[data-viewport-overlay-anchor="bottom-left"]')).not.toBeNull();

      act(() => { expect(claimRouteOperation(qualificationOwner)).toBe(true); });
      expect(screen.queryByText('💡 Pro Tip')).not.toBeInTheDocument();
    } finally {
      releaseRouteOperation(qualificationOwner);
      vi.useRealTimers();
    }
  });
});
