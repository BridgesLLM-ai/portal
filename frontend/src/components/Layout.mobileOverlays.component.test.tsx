// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Layout from './Layout';
import {
  RouteOperationProvider,
  claimRouteOperation,
  releaseRouteOperation,
} from '../contexts/RouteOperationContext';

const shellMocks = vi.hoisted(() => ({
  logout: vi.fn(),
  errors: [] as Array<Record<string, unknown>>,
  isMobile: true,
  publicSettings: {
    assistantName: 'Atlas',
    logoUrl: '',
    mail: { available: true, reason: null },
  } as Record<string, unknown>,
  pendingQuestions: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  gatewayAPI: { pendingQuestions: shellMocks.pendingQuestions },
}));

vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => shellMocks.isMobile,
}));

vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => shellMocks.publicSettings,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    logout: shellMocks.logout,
    user: { id: 'actor-1', username: 'Robert', role: 'USER' },
  }),
}));

vi.mock('../utils/errorHandler', () => ({
  subscribeErrors: (listener: (errors: Array<Record<string, unknown>>) => void) => {
    listener(shellMocks.errors);
    return vi.fn();
  },
  initGlobalErrorHandlers: vi.fn(),
  clearErrors: vi.fn(),
  exportErrorsJSON: vi.fn(() => '[]'),
}));

vi.mock('../utils/sounds', () => ({
  default: { click: vi.fn(), question: vi.fn() },
}));

vi.mock('./FloatingUploadIndicator', () => ({ default: () => null }));
vi.mock('./OllamaControl', () => ({ default: () => null }));
vi.mock('./UserAvatar', () => ({
  default: ({ assistant }: { assistant?: boolean }) => (
    <span aria-hidden="true">{assistant ? 'Assistant avatar' : 'User avatar'}</span>
  ),
}));
vi.mock('./ErrorBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

function renderMobileLayout(initialPath = '/dashboard') {
  return render(
    <MemoryRouter
      initialEntries={[initialPath]}
    >
      <RouteOperationProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<button type="button">Page action</button>} />
            <Route path="/errors" element={<div>Errors route surface</div>} />
          </Route>
        </Routes>
      </RouteOperationProvider>
    </MemoryRouter>,
  );
}

function viewportRootFor(element: Element): HTMLElement {
  const root = element.closest<HTMLElement>('[data-viewport-overlay-root="true"]');
  if (!root) throw new Error('Expected a body-owned viewport overlay root');
  return root;
}

function viewportLayerFor(element: Element): HTMLElement {
  const layer = element.closest<HTMLElement>('[data-viewport-modal-layer="true"]');
  if (!layer) throw new Error('Expected a viewport modal interaction layer');
  return layer;
}

describe('Layout mobile overlay ownership', () => {
  beforeEach(() => {
    shellMocks.logout.mockReset().mockResolvedValue(undefined);
    shellMocks.errors = [];
    shellMocks.isMobile = true;
    shellMocks.publicSettings = {
      assistantName: 'Atlas',
      logoUrl: '',
      mail: { available: true, reason: null },
    };
    shellMocks.pendingQuestions.mockReset().mockResolvedValue({ questions: [] });
  });

  it('shows a cross-section badge that links a waiting Project question back to Projects', async () => {
    shellMocks.pendingQuestions.mockResolvedValue({
      questions: [{
        id: 'askq-project-shell',
        sessionKey: 'project-session-1',
        surface: 'project-chat',
        state: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        questions: [{ id: 'question-continue', question: 'Continue?', multiSelect: false, options: [] }],
      }],
    });
    shellMocks.isMobile = false;
    renderMobileLayout();

    const projectsLink = await screen.findByRole('link', { name: /Projects.*1 waiting/i });
    expect(projectsLink).toHaveAttribute('href', '/projects');
    expect(within(projectsLink).getByRole('status')).toHaveTextContent('1 waiting');
  });

  it('keeps unavailable Mail discoverable and labels it honestly on desktop and mobile', async () => {
    shellMocks.publicSettings = {
      assistantName: 'Atlas',
      logoUrl: '',
      mail: {
        available: false,
        reason: 'Mail requires a public domain and is unavailable in private Tailnet mode.',
      },
    };

    shellMocks.isMobile = false;
    const desktop = renderMobileLayout();
    const desktopMail = screen.getByRole('link', { name: 'Mail — unavailable' });
    expect(desktopMail).toHaveAttribute('href', '/mail');
    expect(within(desktopMail).getByText('Unavailable')).toBeVisible();
    expect(desktopMail).toHaveAttribute(
      'title',
      expect.stringContaining('Mail requires a public domain'),
    );
    desktop.unmount();

    shellMocks.isMobile = true;
    renderMobileLayout();
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    const navigation = await screen.findByRole('dialog', { name: 'Navigation menu' });
    const mobileMail = within(navigation).getByRole('link', { name: 'Mail — unavailable' });
    expect(mobileMail).toHaveAttribute('href', '/mail');
    expect(within(mobileMail).getByText('Unavailable')).toBeVisible();
  });

  it('preserves the normal Mail navigation label when the capability is available', () => {
    shellMocks.isMobile = false;
    renderMobileLayout();

    expect(screen.getByRole('link', { name: 'Mail' })).toHaveAttribute('href', '/mail');
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Checking')).not.toBeInTheDocument();
  });

  it('portals the navigation to the visual viewport and restores focus after backdrop dismissal', async () => {
    const user = userEvent.setup();
    const { container } = renderMobileLayout();
    const trigger = screen.getByRole('button', { name: 'Open navigation menu' });
    const pageAction = screen.getByRole('button', { name: 'Page action' });
    trigger.focus();

    await user.click(trigger);

    const navigation = await screen.findByRole('dialog', { name: 'Navigation menu' });
    const root = viewportRootFor(navigation);
    expect(root.parentElement).toBe(document.body);
    expect(container).toHaveAttribute('aria-hidden', 'true');
    expect(container).toHaveAttribute('inert');
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    expect(document.documentElement).toHaveStyle({ overflow: 'hidden' });
    await waitFor(() => expect(navigation).toHaveFocus());

    pageAction.focus();
    await waitFor(() => expect(navigation).toHaveFocus());

    fireEvent.click(viewportLayerFor(navigation));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(container).not.toHaveAttribute('aria-hidden');
    expect(container).not.toHaveAttribute('inert');
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
    expect(document.documentElement).not.toHaveStyle({ overflow: 'hidden' });
  });

  it('gives ErrorPanel deterministic LIFO ownership and returns to the still-open navigation', async () => {
    const user = userEvent.setup();
    renderMobileLayout();
    const trigger = screen.getByRole('button', { name: 'Open navigation menu' });
    trigger.focus();
    await user.click(trigger);

    const navigation = await screen.findByRole('dialog', { name: 'Navigation menu' });
    const navigationRoot = viewportRootFor(navigation);
    const errorsButton = screen.getByRole('button', { name: 'Errors' });
    await user.click(errorsButton);

    const errorPanel = await screen.findByRole('dialog', { name: 'Error Log' });
    const errorRoot = viewportRootFor(errorPanel);
    expect(errorRoot.parentElement).toBe(document.body);
    expect(navigationRoot).toHaveAttribute('aria-hidden', 'true');
    expect(navigationRoot).toHaveAttribute('inert');
    expect(errorRoot).not.toHaveAttribute('aria-hidden');
    expect(Number(errorRoot.style.zIndex)).toBeGreaterThan(Number(navigationRoot.style.zIndex));
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    await waitFor(() => expect(errorPanel).toHaveFocus());

    errorsButton.focus();
    await waitFor(() => expect(errorPanel).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Error Log' })).not.toBeInTheDocument());
    expect(navigationRoot).not.toHaveAttribute('aria-hidden');
    expect(navigationRoot).not.toHaveAttribute('inert');
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    await waitFor(() => expect(errorsButton).toHaveFocus());

    await user.click(errorsButton);
    const reopenedErrorPanel = await screen.findByRole('dialog', { name: 'Error Log' });
    fireEvent.click(viewportLayerFor(reopenedErrorPanel));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Error Log' })).not.toBeInTheDocument());
    await waitFor(() => expect(errorsButton).toHaveFocus());
    expect(document.body).toHaveStyle({ overflow: 'hidden' });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
  });

  it('opens the error log for a direct /errors route and closes back to the dashboard', async () => {
    renderMobileLayout('/errors');

    const errorPanel = await screen.findByRole('dialog', { name: 'Error Log' });
    expect(screen.getByText('Errors route surface')).toBeInTheDocument();
    await userEvent.click(within(errorPanel).getByRole('button', { name: 'Close error log' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Error Log' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Page action' })).toBeVisible();
  });

  it('disables shell navigation and Logout for the exact route owner, then releases both on settlement', async () => {
    shellMocks.isMobile = false;
    renderMobileLayout();
    const owner = Object.freeze({ scope: 'apps-project-operation', token: 1 });

    act(() => {
      expect(claimRouteOperation(owner)).toBe(true);
    });

    const settings = screen.getByRole('link', { name: 'Settings' });
    const logout = screen.getByRole('button', { name: 'Logout' });
    expect(settings).toHaveAttribute('aria-disabled', 'true');
    expect(logout).toBeDisabled();
    fireEvent.click(settings);
    fireEvent.click(logout);
    expect(screen.getByRole('button', { name: 'Page action' })).toBeVisible();
    expect(shellMocks.logout).not.toHaveBeenCalled();

    act(() => {
      expect(releaseRouteOperation(owner)).toBe(true);
    });

    expect(settings).not.toHaveAttribute('aria-disabled');
    expect(logout).toBeEnabled();
    await userEvent.click(logout);
    expect(shellMocks.logout).toHaveBeenCalledTimes(1);
  });
});
