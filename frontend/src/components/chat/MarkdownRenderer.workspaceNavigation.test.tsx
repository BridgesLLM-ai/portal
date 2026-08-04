// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownRenderer from './MarkdownRenderer';
import { buildPersistedChatAttachmentText } from '../../utils/chatAttachmentPersistence';
import {
  parseFileDeepLink,
  WORKSPACE_NAVIGATION_STORAGE_KEY,
} from '../../utils/workspaceNavigation';

const TEST_BINDING = {
  actorUserId: 'actor-1',
  authorizationVersion: 4,
};

const rendererMocks = vi.hoisted(() => ({
  post: vi.fn(),
  user: {
    id: 'actor-1',
    role: 'OWNER' as 'OWNER' | 'SUB_ADMIN' | 'USER',
    authorizationVersion: 4,
  },
}));

vi.mock('../../api/client', () => ({
  default: { post: rendererMocks.post },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    user: rendererMocks.user,
  }),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="route">{`${location.pathname}${location.search}`}</output>;
}

describe('MarkdownRenderer workspace links', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    rendererMocks.user.role = 'OWNER';
    rendererMocks.post.mockReset().mockResolvedValue({
      data: { accepted: true, mode: 'snapshot', targetType: 'file' },
    });
  });

  it('mints an opaque target only when an ordinary click follows a persisted API reference', async () => {
    const user = userEvent.setup();
    const persistedText = buildPersistedChatAttachmentText([{
      name: 'owner report.pdf',
      size: 42,
      type: 'other',
      fileId: 'secret-file-id',
      serverPath: '/var/portal-files/owner/private/report.pdf',
      uploadStatus: 'done',
    }]);
    const reference = persistedText.match(/portal_url:\s*(\S+)/)?.[1];
    expect(reference).toBe('/api/files/secret-file-id');
    expect(persistedText).not.toContain('?open=');
    expect(persistedText).not.toContain('/files?file=');
    expect(persistedText).not.toContain('/files?path=');
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();

    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content={`[Open file](${reference})`} />
        <LocationProbe />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Open file' });
    expect(link).toHaveAttribute('href', '/files');
    expect(link.getAttribute('href')).not.toContain('secret-file-id');
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
    await user.click(link);

    const route = screen.getByTestId('route').textContent || '';
    expect(route).toMatch(/^\/files\?open=[a-f0-9]{32}$/);
    expect(route).not.toContain('secret-file-id');
    expect(route).not.toContain('report.pdf');
    expect(parseFileDeepLink(route.split('?')[1], TEST_BINDING)).toEqual({
      fileId: 'secret-file-id',
    });
    expect(rendererMocks.post).not.toHaveBeenCalled();
  });

  it('defers path-only server references until the ordinary click', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content="[Open path](/var/portal-files/owner/private/report%20final.pdf)" />
        <LocationProbe />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Open path' });
    expect(link).toHaveAttribute('href', '/files');
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
    await user.click(link);

    const route = screen.getByTestId('route').textContent || '';
    expect(route).toMatch(/^\/files\?open=[a-f0-9]{32}$/);
    expect(parseFileDeepLink(route.split('?')[1], TEST_BINDING)).toEqual({
      path: '/var/portal-files/owner/private/report final.pdf',
    });
    expect(rendererMocks.post).not.toHaveBeenCalled();
  });

  it('decodes an explicit Files path once so literal percent escapes remain addressable', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content="[Open literal](/var/portal-files/owner/private/report%2520final.pdf)" />
        <LocationProbe />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('link', { name: 'Open literal' }));
    const route = screen.getByTestId('route').textContent || '';
    expect(parseFileDeepLink(route.split('?')[1], TEST_BINDING)).toEqual({
      path: '/var/portal-files/owner/private/report%20final.pdf',
    });
  });

  it('keeps a legacy Files storage path on the actor-bound Files flow', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content="[Open legacy file](/portal/files/actor-1/archive/report.pdf)" />
        <LocationProbe />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Open legacy file' });
    expect(link).toHaveAttribute('href', '/files');
    await user.click(link);

    const route = screen.getByTestId('route').textContent || '';
    expect(route).toMatch(/^\/files\?open=[a-f0-9]{32}$/);
    expect(parseFileDeepLink(route.split('?')[1], TEST_BINDING)).toEqual({
      path: '/portal/files/actor-1/archive/report.pdf',
    });
    expect(rendererMocks.post).not.toHaveBeenCalled();
  });

  it('leaves modified clicks on the non-sensitive Files root without minting a token', () => {
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content="[Open file](/api/files/secret-file-id)" />
        <LocationProbe />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Open file' });
    expect(link).toHaveAttribute('href', '/files');
    // React handles the modified click at the router root. Prevent jsdom's
    // unimplemented browser navigation afterward at document scope.
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, { button: 0, ctrlKey: true });
    expect(screen.getByTestId('route')).toHaveTextContent('/agent-chats');
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
  });

  it('treats an absolute Files link as local only for the current origin', async () => {
    const user = userEvent.setup();
    const sameOrigin = `${window.location.origin}/files?file=same-origin-file`;
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content={`[Local file](${sameOrigin})`} />
        <MarkdownRenderer content="[Third-party file](https://third.example/files?file=external-file)" />
        <LocationProbe />
      </MemoryRouter>,
    );

    const localLink = screen.getByRole('link', { name: 'Local file' });
    expect(localLink).toHaveAttribute('href', '/files');
    expect(localLink).not.toHaveAttribute('target');

    const externalLink = screen.getByRole('link', { name: 'Third-party file' });
    expect(externalLink).toHaveAttribute(
      'href',
      'https://third.example/files?file=external-file',
    );
    expect(externalLink).toHaveAttribute('target', '_blank');
    expect(externalLink).toHaveAttribute('rel', 'noopener noreferrer');

    await user.click(localLink);
    const route = screen.getByTestId('route').textContent || '';
    expect(route).toMatch(/^\/files\?open=[a-f0-9]{32}$/);
    expect(parseFileDeepLink(route.split('?')[1], TEST_BINDING)).toEqual({
      fileId: 'same-origin-file',
    });
  });

  it('hands an agent workspace file to Remote Desktop without exposing its path in the route', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer
          content="[Open report](/root/.openclaw/workspace-main/report%20final.md#L42C7)"
          hostFileContext={{ source: 'agent-workspace', agent: 'main' }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Open report' });
    expect(link).toHaveAttribute('href', '/desktop');
    expect(link.getAttribute('href')).not.toContain('report');
    await user.click(link);

    await waitFor(() => {
      expect(rendererMocks.post).toHaveBeenCalledWith('/remote-desktop/open-path', {
        source: 'agent-workspace',
        agent: 'main',
        path: '/root/.openclaw/workspace-main/report final.md#L42C7',
      });
    });
    expect(screen.getByTestId('route')).toHaveTextContent('/desktop');
  });

  it('does not turn a host path into a Remote Desktop request without exact chat authority', () => {
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content="[Unbound host path](/root/.openclaw/workspace-main/report.md)" />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Unbound host path' }))
      .not.toHaveAttribute('href', '/desktop');
    expect(rendererMocks.post).not.toHaveBeenCalled();
  });

  it('carries exact Project authority for container-style project links', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <MarkdownRenderer
          content="[Open source](/workspace/project/src/index.ts:19:3)"
          hostFileContext={{ source: 'project', project: 'alpha' }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('link', { name: 'Open source' }));
    await waitFor(() => {
      expect(rendererMocks.post).toHaveBeenCalledWith('/remote-desktop/open-path', {
        source: 'project',
        project: 'alpha',
        // Colon anchors are resolved only after the backend proves the literal
        // filename does not exist; colons are legal in Linux filenames.
        path: '/workspace/project/src/index.ts:19:3',
      });
    });
    expect(screen.getByTestId('route')).toHaveTextContent('/desktop');
  });

  it('resolves a relative Project link only through the exact Project authority', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <MarkdownRenderer
          content="[Open relative source](src/index.ts#L19C3)"
          hostFileContext={{ source: 'project', project: 'alpha' }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('link', { name: 'Open relative source' }));
    await waitFor(() => {
      expect(rendererMocks.post).toHaveBeenCalledWith('/remote-desktop/open-path', {
        source: 'project',
        project: 'alpha',
        path: 'src/index.ts#L19C3',
      });
    });
    expect(screen.getByTestId('route')).toHaveTextContent('/desktop');
  });

  it('resolves a relative Agent link only when the active Agent identity is supplied', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer
          content="[Open notes](notes.md:8)"
          hostFileContext={{ source: 'agent-workspace', agent: 'main' }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('link', { name: 'Open notes' }));
    await waitFor(() => {
      expect(rendererMocks.post).toHaveBeenCalledWith('/remote-desktop/open-path', {
        source: 'agent-workspace',
        agent: 'main',
        path: 'notes.md:8',
      });
    });
    expect(screen.getByTestId('route')).toHaveTextContent('/desktop');
  });

  it('does not turn relative links into host authority without an exact workspace context', () => {
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content="[Relative web link](notes.md) [Section](#details)" />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Relative web link' })).toHaveAttribute('href', 'notes.md');
    expect(screen.getByRole('link', { name: 'Section' })).toHaveAttribute('href', '#details');
    expect(rendererMocks.post).not.toHaveBeenCalled();
  });

  it('never launches a Remote Desktop file on a modified click', () => {
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer
          content="[Open report](/root/.openclaw/workspace-main/report.md)"
          hostFileContext={{ source: 'agent-workspace', agent: 'main' }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Open report' });
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, { button: 0, ctrlKey: true });
    expect(rendererMocks.post).not.toHaveBeenCalled();
    expect(screen.getByTestId('route')).toHaveTextContent('/agent-chats');
  });

  it('keeps the host-file bridge unavailable to ordinary workspace users', async () => {
    rendererMocks.user.role = 'USER';
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <MarkdownRenderer
          content="[Open source](/workspace/project/src/index.ts)"
          hostFileContext={{ source: 'project', project: 'alpha' }}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Open source' });
    expect(link).toHaveAttribute('href', '#');
    expect(link).toHaveAttribute('aria-disabled', 'true');
    await user.click(link);
    expect(rendererMocks.post).not.toHaveBeenCalled();
    expect(screen.getByText(/requires Owner or Sub-admin access/i)).toBeVisible();
    expect(screen.getByTestId('route')).toHaveTextContent('/projects');
  });

  it('converts file URLs but leaves executable schemes inert', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer
          content="[Local file](file:///root/.openclaw/workspace-main/notes.md#L8)"
          hostFileContext={{ source: 'agent-workspace', agent: 'main' }}
        />
        <MarkdownRenderer content="[Unsafe](javascript:alert(document.cookie))" />
        <LocationProbe />
      </MemoryRouter>,
    );

    const local = screen.getByRole('link', { name: 'Local file' });
    expect(local).toHaveAttribute('href', '/desktop');
    expect(screen.getByRole('link', { name: 'Unsafe' })).toHaveAttribute('href', '#');
    await user.click(local);
    await waitFor(() => {
      expect(rendererMocks.post).toHaveBeenCalledWith('/remote-desktop/open-path', {
        source: 'agent-workspace',
        agent: 'main',
        path: '/root/.openclaw/workspace-main/notes.md#L8',
      });
    });
  });
});
