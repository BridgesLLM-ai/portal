// @vitest-environment jsdom
import '../test/setup';
import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaViewer from './MediaViewer';
import ViewportModal from './ViewportModal';

vi.mock('../hooks/useFileContent', () => ({
  useFileContent: () => ({ blobUrl: null, blob: null, loading: true, error: null }),
}));
vi.mock('react-pdf', () => ({
  Document: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));

const FILE = {
  id: 'file-1',
  path: 'alpha.txt',
  originalName: 'alpha.txt',
  size: 12,
  mimeType: 'text/plain',
  visibility: 'private',
  createdAt: '2026-07-21T12:00:00.000Z',
};
const NEXT_FILE = { ...FILE, id: 'file-2', path: 'beta.txt', originalName: 'beta.txt' };

function OwnershipHarness() {
  const [previewOpen, setPreviewOpen] = useState(true);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const closeConfirmationRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {previewOpen && (
        <MediaViewer
          file={FILE}
          files={[FILE]}
          onClose={() => setPreviewOpen(false)}
          onDelete={() => setConfirmationOpen(true)}
          downloadUrl={(id) => `/api/files/${id}/download`}
        />
      )}
      <ViewportModal
        open={confirmationOpen}
        onDismiss={() => setConfirmationOpen(false)}
        initialFocusRef={closeConfirmationRef}
      >
        <div role="alertdialog" aria-label="Delete guard">
          <button type="button" onClick={() => setPreviewOpen(false)}>Unmount preview</button>
          <button ref={closeConfirmationRef} type="button" onClick={() => setConfirmationOpen(false)}>Close guard</button>
        </div>
      </ViewportModal>
    </>
  );
}

describe('MediaViewer modal ownership', () => {
  beforeEach(() => {
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
  });

  it('does not restore page scrolling when the preview unmounts beneath a newer modal', async () => {
    const user = userEvent.setup();
    render(<OwnershipHarness />);

    expect(await screen.findByRole('dialog', { name: 'Preview alpha.txt' })).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    await user.click(screen.getByTitle('Delete'));

    const confirmation = await screen.findByRole('alertdialog', { name: 'Delete guard' });
    await user.click(withinDialog(confirmation, 'Unmount preview'));
    expect(screen.queryByRole('dialog', { name: 'Preview alpha.txt', hidden: true })).not.toBeInTheDocument();
    expect(screen.getByRole('alertdialog', { name: 'Delete guard' })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(withinDialog(confirmation, 'Close guard'));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Delete guard' })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps arrow navigation inside the modal-owned preview surface', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <MediaViewer
        file={FILE}
        files={[FILE, NEXT_FILE]}
        onClose={vi.fn()}
        onNavigate={onNavigate}
        downloadUrl={(id) => `/api/files/${id}/download`}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Close file preview' })).toHaveFocus());
    await user.keyboard('{ArrowRight}');
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(NEXT_FILE);
  });
});

function withinDialog(dialog: HTMLElement, name: string) {
  const button = Array.from(dialog.querySelectorAll('button')).find(element => element.textContent === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
}
