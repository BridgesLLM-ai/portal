// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('../../contexts/AuthContext', () => ({
  useAuthStore: () => ({
    user: {
      id: 'actor-1',
      role: 'USER',
      authorizationVersion: 4,
    },
  }),
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="route">{`${location.pathname}${location.search}`}</output>;
}

describe('MarkdownRenderer workspace links', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
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
  });

  it('defers path-only server references until the ordinary click', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/agent-chats']}>
        <MarkdownRenderer content="[Open path](/var/portal-files/owner/private/report.pdf)" />
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
      path: '/var/portal-files/owner/private/report.pdf',
    });
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
});
