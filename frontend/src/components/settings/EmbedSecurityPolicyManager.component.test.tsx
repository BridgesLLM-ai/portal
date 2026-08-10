// @vitest-environment jsdom
import '../../test/setup';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EmbedSecurityPolicyManager, {
  normalizeClientEmbedOrigin,
  serializedEmbedOriginPolicyBytes,
} from './EmbedSecurityPolicyManager';

const mocks = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../api/settings', () => ({
  settingsAPI: {
    getEmbedOriginPolicy: mocks.getPolicy,
    updateEmbedOriginPolicy: mocks.updatePolicy,
  },
}));

const policy = (overrides: Record<string, unknown> = {}) => ({
  version: 1 as const,
  revision: 'a'.repeat(64),
  status: 'ready' as const,
  entries: [],
  defaultOrigins: ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
  limits: { maxOrigins: 32, maxOriginBytes: 512, maxPolicyBytes: 8192 },
  updatedAt: '2026-08-08T19:00:00.000Z',
  ...overrides,
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

function OwnershipHarness({ children }: { children: (props: {
  claimMutation: (owner: string) => boolean;
  releaseMutation: (owner: string) => void;
  mutationOwner: string | null;
}) => ReactNode }) {
  const ownerRef = useRef<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const claimMutation = useCallback((next: string) => {
    if (ownerRef.current) return false;
    ownerRef.current = next;
    setOwner(next);
    return true;
  }, []);
  const releaseMutation = useCallback((current: string) => {
    if (ownerRef.current !== current) return;
    ownerRef.current = null;
    setOwner(null);
  }, []);
  const props = useMemo(() => ({ claimMutation, releaseMutation, mutationOwner: owner }), [claimMutation, owner, releaseMutation]);
  return (
    <>
      <button type="button" disabled={Boolean(owner)}>Leave Settings</button>
      {children(props)}
    </>
  );
}

function renderManager() {
  return render(
    <OwnershipHarness>
      {(ownership) => (
        <EmbedSecurityPolicyManager
          {...ownership}
          addToast={mocks.addToast}
        />
      )}
    </OwnershipHarness>,
  );
}

describe('EmbedSecurityPolicyManager', () => {
  beforeEach(() => {
    mocks.getPolicy.mockReset().mockResolvedValue(policy());
    mocks.updatePolicy.mockReset();
    mocks.addToast.mockReset();
  });

  it('matches server-side exact HTTPS origin normalization', () => {
    expect(normalizeClientEmbedOrigin('HTTPS://Video.Example.com/', 512)).toEqual({
      origin: 'https://video.example.com',
    });
    expect(normalizeClientEmbedOrigin('https://video.example.com:443', 512)).toEqual({
      origin: 'https://video.example.com',
    });
    expect(normalizeClientEmbedOrigin('https://video.example.com/watch', 512)).toEqual({
      error: 'Enter only the origin, without a path, query, or fragment.',
    });
    expect(normalizeClientEmbedOrigin('http://video.example.com', 512)).toEqual({
      error: 'Origin must use HTTPS.',
    });
    expect(normalizeClientEmbedOrigin('https://*.example.com', 512)).toEqual({
      error: 'Wildcards are not allowed. Add each exact origin.',
    });
    expect(normalizeClientEmbedOrigin('https://video.example.com\\redirect', 512)).toEqual({
      error: 'Origin cannot contain spaces, control characters, or backslashes.',
    });
    expect(normalizeClientEmbedOrigin('https://video.example.com:8443', 512)).toEqual({
      error: 'Origin must use the standard HTTPS port.',
    });
    expect(normalizeClientEmbedOrigin('https://127.0.0.1', 512)).toEqual({
      error: 'Origin must use a DNS hostname, not an IP address.',
    });
    expect(normalizeClientEmbedOrigin('https://camera.internal', 512)).toEqual({
      error: 'Private and special-use hostnames cannot be used as embed origins.',
    });
    for (const blocked of ['https://camera.example', 'https://device.home.arpa', 'https://thing.alt']) {
      expect(normalizeClientEmbedOrigin(blocked, 512)).toEqual({
        error: 'Private and special-use hostnames cannot be used as embed origins.',
      });
    }
    expect(normalizeClientEmbedOrigin('https://camera.example.com', 512)).toEqual({
      origin: 'https://camera.example.com',
    });
  });

  it('explains portal-wide header visibility and saves one immutable normalized snapshot', async () => {
    const save = deferred<ReturnType<typeof policy>>();
    mocks.updatePolicy.mockReturnValueOnce(save.promise);
    renderManager();

    const panel = await screen.findByRole('region', { name: 'Hosted content embeds' });
    expect(within(panel).getByText(/visible in CSP and Permissions-Policy response headers/i)).toBeVisible();
    expect(within(panel).getByText(/not private or per-project/i)).toBeVisible();
    expect(within(panel).getByText(/allow="camera; microphone"/i)).toBeVisible();
    expect(within(panel).getByText(/provider can still refuse embedding/i)).toBeVisible();
    expect(within(panel).getByText(/do not grant it automatically/i)).toBeVisible();

    await userEvent.click(within(panel).getByRole('button', { name: 'Add origin' }));
    const origin = within(panel).getByRole('textbox', { name: 'Origin 1' });
    await userEvent.type(origin, 'https://video.example.com/path');
    expect(within(panel).getByRole('alert')).toHaveTextContent('without a path');
    expect(within(panel).getByRole('button', { name: 'Save embed policy' })).toBeDisabled();

    await userEvent.clear(origin);
    await userEvent.type(origin, 'HTTPS://Video.Example.com/');
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Allow camera for origin 1' }));
    const saveButton = within(panel).getByRole('button', { name: 'Save embed policy' });

    act(() => {
      saveButton.click();
      saveButton.click();
      fireEvent.change(origin, { target: { value: 'https://late.example.com' } });
    });

    expect(mocks.updatePolicy).toHaveBeenCalledTimes(1);
    expect(mocks.updatePolicy).toHaveBeenCalledWith({
      expectedRevision: 'a'.repeat(64),
      entries: [{
        origin: 'https://video.example.com',
        camera: true,
        microphone: false,
      }],
    });
    expect(origin).toHaveValue('HTTPS://Video.Example.com/');
    expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeDisabled();

    await act(async () => {
      save.resolve(policy({
        revision: 'b'.repeat(64),
        entries: [{ origin: 'https://video.example.com', camera: true, microphone: false }],
        updatedAt: '2026-08-08T20:00:00.000Z',
      }));
      await save.promise;
    });

    expect(within(panel).getByRole('textbox', { name: 'Origin 1' })).toHaveValue('https://video.example.com');
    expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeEnabled();
    expect(mocks.addToast).toHaveBeenCalledWith('success', 'Embed-origin policy saved');
  });

  it('presents starter origins as removable entries and preserves an explicitly saved empty policy', async () => {
    const starterEntries = [
      { origin: 'https://www.youtube.com', camera: false, microphone: false },
      { origin: 'https://www.youtube-nocookie.com', camera: false, microphone: false },
    ];
    mocks.getPolicy.mockResolvedValueOnce(policy({
      entries: starterEntries,
      updatedAt: null,
    }));
    mocks.updatePolicy.mockResolvedValueOnce(policy({
      revision: 'b'.repeat(64),
      entries: [],
      updatedAt: '2026-08-08T20:00:00.000Z',
    }));
    renderManager();

    const panel = await screen.findByRole('region', { name: 'Hosted content embeds' });
    expect(within(panel).getByText(/removable defaults/i)).toBeVisible();
    expect(within(panel).getByRole('textbox', { name: 'Origin 1' })).toHaveValue('https://www.youtube.com');
    expect(within(panel).getByRole('textbox', { name: 'Origin 2' })).toHaveValue('https://www.youtube-nocookie.com');

    await userEvent.click(within(panel).getByRole('button', { name: 'Remove embed origin 2' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove embed origin 1' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Save embed policy' }));

    expect(mocks.updatePolicy).toHaveBeenCalledWith({
      expectedRevision: 'a'.repeat(64),
      entries: [],
    });
    expect(await within(panel).findByText('No third-party embed origins are allowed.')).toBeVisible();
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(panel).queryByText(/removable defaults/i)).not.toBeInTheDocument();
  });

  it('fails closed if a cached new Settings bundle briefly reads the preceding API shape', async () => {
    mocks.getPolicy.mockResolvedValueOnce(policy({
      defaultOrigins: undefined,
      builtInOrigins: ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      updatedAt: null,
    }));
    renderManager();

    const panel = await screen.findByRole('region', { name: 'Hosted content embeds' });
    expect(within(panel).getByRole('alert')).toHaveTextContent(/update is still converging/i);
    expect(within(panel).getByRole('alert')).toHaveTextContent('https://www.youtube.com');
    expect(within(panel).getByText(/Saved policy entries are unavailable/i)).toBeVisible();
    expect(within(panel).queryByText('No third-party embed origins are allowed.')).not.toBeInTheDocument();
    expect(within(panel).queryByText(/removable defaults/i)).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Add origin' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Save embed policy' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Reload saved policy' })).toBeEnabled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it('keeps a conflicting draft, blocks blind overwrite, then reloads the current revision', async () => {
    mocks.getPolicy.mockResolvedValueOnce(policy({
      entries: [{ origin: 'https://old.example.com', camera: false, microphone: false }],
    }));
    mocks.updatePolicy.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          code: 'EMBED_SECURITY_POLICY_REVISION_CONFLICT',
          error: 'The embed-origin policy changed in another session.',
          current: policy({ revision: 'b'.repeat(64) }),
        },
      },
    });
    renderManager();

    const panel = await screen.findByRole('region', { name: 'Hosted content embeds' });
    const origin = within(panel).getByRole('textbox', { name: 'Origin 1' });
    await userEvent.clear(origin);
    await userEvent.type(origin, 'https://draft.example.com');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save embed policy' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent('Your draft is still here');
    expect(origin).toHaveValue('https://draft.example.com');
    expect(within(panel).getByRole('button', { name: 'Save embed policy' })).toBeDisabled();

    mocks.getPolicy.mockResolvedValueOnce(policy({
      revision: 'b'.repeat(64),
      entries: [{ origin: 'https://current.example.com', camera: false, microphone: true }],
      updatedAt: '2026-08-08T20:10:00.000Z',
    }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Reload saved policy' }));

    await waitFor(() => expect(within(panel).getByRole('textbox', { name: 'Origin 1' })).toHaveValue('https://current.example.com'));
    expect(within(panel).getByRole('checkbox', { name: 'Allow microphone for origin 1' })).toBeChecked();
    expect(within(panel).getByRole('button', { name: 'Save embed policy' })).toBeDisabled();
  });

  it('resets permission and origin edits to the last loaded policy', async () => {
    mocks.getPolicy.mockResolvedValueOnce(policy({
      entries: [{ origin: 'https://base.example.com', camera: false, microphone: false }],
    }));
    renderManager();

    const panel = await screen.findByRole('region', { name: 'Hosted content embeds' });
    const origin = within(panel).getByRole('textbox', { name: 'Origin 1' });
    await userEvent.clear(origin);
    await userEvent.type(origin, 'https://draft.example.com');
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Allow camera for origin 1' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Reset draft' }));

    expect(within(panel).getByRole('textbox', { name: 'Origin 1' })).toHaveValue('https://base.example.com');
    expect(within(panel).getByRole('checkbox', { name: 'Allow camera for origin 1' })).not.toBeChecked();
    expect(within(panel).getByRole('button', { name: 'Save embed policy' })).toBeDisabled();
    expect(within(panel).getByRole('status')).toHaveTextContent('Unsaved embed-origin changes were reset');
  });

  it('enforces the exact serialized versioned policy byte limit before PUT', async () => {
    const entry = { origin: 'https://embed.example.com', camera: false, microphone: false };
    const exactBytes = new TextEncoder().encode(JSON.stringify({ version: 1, entries: [entry] })).length;
    expect(serializedEmbedOriginPolicyBytes([entry])).toBe(exactBytes);
    mocks.getPolicy.mockResolvedValueOnce(policy({
      limits: { maxOrigins: 32, maxOriginBytes: 512, maxPolicyBytes: exactBytes - 1 },
    }));
    renderManager();

    const panel = await screen.findByRole('region', { name: 'Hosted content embeds' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Add origin' }));
    await userEvent.type(
      within(panel).getByRole('textbox', { name: 'Origin 1' }),
      entry.origin,
    );

    expect(within(panel).getByRole('alert')).toHaveTextContent(
      `serialized embed policy is ${exactBytes} UTF-8 bytes; the limit is ${exactBytes - 1}`,
    );
    expect(within(panel).getByRole('button', { name: 'Save embed policy' })).toBeDisabled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it('keeps edits made after a reload starts and ignores an older overlapping response', async () => {
    mocks.getPolicy.mockResolvedValueOnce(policy({
      entries: [{ origin: 'https://base.example.com', camera: false, microphone: false }],
    }));
    renderManager();
    const panel = await screen.findByRole('region', { name: 'Hosted content embeds' });

    const older = deferred<ReturnType<typeof policy>>();
    const newer = deferred<ReturnType<typeof policy>>();
    mocks.getPolicy.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const reload = within(panel).getByRole('button', { name: 'Reload saved policy' });
    act(() => {
      reload.click();
      reload.click();
    });
    expect(mocks.getPolicy).toHaveBeenCalledTimes(3);

    await act(async () => {
      newer.resolve(policy({
        revision: 'c'.repeat(64),
        entries: [{ origin: 'https://newer.example.com', camera: false, microphone: false }],
      }));
      await newer.promise;
    });
    expect(within(panel).getByRole('textbox', { name: 'Origin 1' })).toHaveValue('https://newer.example.com');

    await act(async () => {
      older.resolve(policy({
        revision: 'b'.repeat(64),
        entries: [{ origin: 'https://older.example.com', camera: false, microphone: false }],
      }));
      await older.promise;
    });
    expect(within(panel).getByRole('textbox', { name: 'Origin 1' })).toHaveValue('https://newer.example.com');

    const reloadWithEdit = deferred<ReturnType<typeof policy>>();
    mocks.getPolicy.mockReturnValueOnce(reloadWithEdit.promise);
    act(() => {
      reload.click();
      fireEvent.change(
        within(panel).getByRole('textbox', { name: 'Origin 1' }),
        { target: { value: 'https://local-after-reload.example.com' } },
      );
    });
    await act(async () => {
      reloadWithEdit.resolve(policy({
        revision: 'd'.repeat(64),
        entries: [{ origin: 'https://server-after-reload.example.com', camera: false, microphone: false }],
      }));
      await reloadWithEdit.promise;
    });

    expect(within(panel).getByRole('textbox', { name: 'Origin 1' })).toHaveValue('https://local-after-reload.example.com');
    expect(within(panel).getByRole('status')).toHaveTextContent('newer edits were kept');
  });

  it('can replace a corrupt stored policy with an empty fail-closed policy', async () => {
    mocks.getPolicy.mockResolvedValueOnce(policy({
      revision: 'e'.repeat(64),
      status: 'invalid',
      warning: 'The saved embed-origin policy is invalid.',
    }));
    mocks.updatePolicy.mockResolvedValueOnce(policy({ revision: 'f'.repeat(64) }));
    renderManager();

    const panel = await screen.findByRole('region', { name: 'Hosted content embeds' });
    expect(within(panel).getByRole('alert')).toHaveTextContent('saved embed-origin policy is invalid');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save embed policy' }));

    expect(mocks.updatePolicy).toHaveBeenCalledWith({
      expectedRevision: 'e'.repeat(64),
      entries: [],
    });
  });
});
