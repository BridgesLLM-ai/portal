// @vitest-environment jsdom
import '../test/setup';
import { useCallback, useMemo, useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ImagePickerCropper from './ImagePickerCropper';
import { SettingsMutationProvider } from './settings/SettingsMutationContext';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../api/client', () => ({
  default: {
    post: mocks.post,
    delete: mocks.delete,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ImageEditorHarness({ onSaved = vi.fn() }: { onSaved?: (url: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ownerRef = useRef<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const claim = useCallback((nextOwner: string) => {
    if (ownerRef.current) return false;
    ownerRef.current = nextOwner;
    setOwner(nextOwner);
    return true;
  }, []);
  const release = useCallback((nextOwner: string) => {
    if (ownerRef.current !== nextOwner) return;
    ownerRef.current = null;
    setOwner(null);
  }, []);
  const value = useMemo(() => ({ owner, claim, release }), [claim, owner, release]);
  return (
    <SettingsMutationProvider value={value}>
      <div data-testid="page">
        <button type="button" onClick={() => setOpen(true)}>Open image editor</button>
        <button type="button" disabled={Boolean(owner)}>Leave Settings</button>
        <ImagePickerCropper
          isOpen={open}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
          currentImageUrl="/current.png"
          uploadEndpoint="/profile/image"
          deleteEndpoint="/profile/image"
          title="Edit profile image"
        />
      </div>
    </SettingsMutationProvider>
  );
}

describe('ImagePickerCropper modal ownership', () => {
  beforeEach(() => {
    mocks.post.mockReset();
    mocks.delete.mockReset();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:chosen-image'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('owns a body portal, traps focus, and restores the opener when dismissed', async () => {
    const user = userEvent.setup();
    const { container } = render(<ImageEditorHarness />);
    const opener = screen.getByRole('button', { name: 'Open image editor' });

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Edit profile image' });
    const close = screen.getByRole('button', { name: 'Close image editor' });
    await waitFor(() => expect(close).toHaveFocus());
    expect(container.contains(dialog)).toBe(false);
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });

  it('single-flights save across same-frame save/remove input and blocks every dismissal path', async () => {
    const user = userEvent.setup();
    const upload = deferred<{ data: { avatarUrl: string } }>();
    const onSaved = vi.fn();
    mocks.post.mockReturnValue(upload.promise);
    render(<ImageEditorHarness onSaved={onSaved} />);

    await user.click(screen.getByRole('button', { name: 'Open image editor' }));
    await user.upload(
      screen.getByLabelText('Choose image'),
      new File(['pixels'], 'avatar.png', { type: 'image/png' }),
    );

    const save = screen.getByRole('button', { name: 'Save' });
    const remove = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.click(remove);

    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.delete).not.toHaveBeenCalled();
    const saving = screen.getByRole('button', { name: 'Saving…' });
    expect(saving).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close image editor' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByText('Leave Settings').closest('button')).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Edit profile image' })).toBeInTheDocument();
    const modalLayer = document.querySelector<HTMLElement>('[data-viewport-modal-layer="true"]')!;
    fireEvent.mouseDown(modalLayer);
    fireEvent.click(modalLayer);
    expect(screen.getByRole('dialog', { name: 'Edit profile image' })).toBeInTheDocument();

    await act(async () => {
      upload.resolve({ data: { avatarUrl: '/saved.png' } });
      await upload.promise;
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0]?.[0]).toMatch(/^\/saved\.png\?t=\d+$/);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit profile image' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Leave Settings' })).toBeEnabled();
  });

  it('single-flights removal, stays open on failure, and exposes one honest working action', async () => {
    const user = userEvent.setup();
    const removal = deferred<unknown>();
    mocks.delete.mockReturnValue(removal.promise);
    render(<ImageEditorHarness />);

    await user.click(screen.getByRole('button', { name: 'Open image editor' }));
    const remove = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(remove);
    fireEvent.click(remove);

    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Removing…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument();

    await act(async () => {
      removal.reject(new Error('Image removal failed safely'));
      try {
        await removal.promise;
      } catch {
        // Expected rejection is surfaced in the dialog.
      }
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Image removal failed safely');
    expect(screen.getByRole('dialog', { name: 'Edit profile image' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
  });

  it('surfaces the shared media-tool repair action for animated GIF dependency failures', async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Animated GIF processing requires FFmpeg.',
          code: 'IMAGE_MEDIA_TOOLCHAIN_UNAVAILABLE',
          repairToolId: 'ffmpeg',
          repairUrl: '/agent-tools?tool=ffmpeg',
        },
      },
    });
    render(<ImageEditorHarness />);

    await user.click(screen.getByRole('button', { name: 'Open image editor' }));
    await user.upload(
      screen.getByLabelText('Choose image'),
      new File(['gif-data'], 'avatar.gif', { type: 'image/gif' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Animated GIF processing requires FFmpeg.');
    expect(screen.getByRole('link', { name: 'Open repair tools' }))
      .toHaveAttribute('href', '/agent-tools?tool=ffmpeg');
    expect(screen.getByRole('dialog', { name: 'Edit profile image' })).toBeInTheDocument();
  });
});
