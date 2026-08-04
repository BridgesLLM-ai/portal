// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilesPage from './FilesPage';
import { buildFileDeepLink } from '../utils/workspaceNavigation';

const TEST_WORKSPACE_BINDING = {
  actorUserId: 'actor-1',
  authorizationVersion: 7,
};

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  deleteFile: vi.fn(),
  batchDelete: vi.fn(),
  clientGet: vi.fn(),
  fetch: vi.fn(),
  uploadStore: {
    setUpload: vi.fn(),
    updateUpload: vi.fn(),
    removeUpload: vi.fn(),
  },
}));

vi.mock('../api/endpoints', () => ({
  filesAPI: {
    list: mocks.list,
    resolve: mocks.resolve,
    delete: mocks.deleteFile,
    batchDelete: mocks.batchDelete,
    download: (id: string) => `/api/files/${id}/download`,
  },
}));

vi.mock('../api/client', () => ({ default: { get: mocks.clientGet } }));
vi.mock('../contexts/AuthContext', () => {
  const user = {
    id: 'actor-1',
    role: 'USER',
    authorizationVersion: 7,
  };
  return {
    useAuthStore: Object.assign(
      () => ({ user }),
      { getState: () => ({ user }) },
    ),
  };
});
vi.mock('../hooks/useThumbnail', () => ({ useThumbnails: () => ({}) }));
vi.mock('../stores/uploadStore', () => ({ useUploadStore: () => mocks.uploadStore }));
vi.mock('../utils/smartUpload', () => ({
  smartUpload: vi.fn(),
  formatBytes: (bytes: number) => `${bytes} B`,
  formatSpeed: () => '0 B/s',
  formatTime: () => '0s',
}));
vi.mock('../utils/sounds', () => ({
  default: {
    click: vi.fn(),
    delete: vi.fn(),
    error: vi.fn(),
    notification: vi.fn(),
    success: vi.fn(),
    upload: vi.fn(),
  },
}));
vi.mock('react-dropzone', () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: (props: Record<string, unknown> = {}) => props,
    isDragActive: false,
  }),
}));
vi.mock('../components/MediaViewer', () => ({
  default: ({ file, onClose, onDelete, onRename, onCopyToProject }: any) => (
    <div data-testid="preview-harness">
      <p>{`Preview harness ${file.originalName}`}</p>
      <button type="button" onClick={() => { onRename(file); onClose(); }}>Rename from preview</button>
      <button type="button" onClick={() => { onCopyToProject(file); onClose(); }}>Copy from preview</button>
      <button type="button" onClick={() => onDelete(file.id)}>Delete from preview</button>
    </div>
  ),
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

const FILE_LIST = { files: [FILE], total: 1, pages: 1, totalSize: FILE.size };
const EMPTY_FILE_LIST = { files: [], total: 0, pages: 1, totalSize: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function FileLocationProbe() {
  const location = useLocation();
  return <output data-testid="files-route">{`${location.pathname}${location.search}`}</output>;
}

function renderFilesPage(initialEntry = '/files') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <FilesPage />
      <FileLocationProbe />
    </MemoryRouter>,
  );
}

async function openPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Preview alpha.txt' }));
  return screen.findByTestId('preview-harness');
}

describe('FilesPage mutation dialog ownership', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    mocks.list.mockReset().mockResolvedValue(FILE_LIST);
    mocks.resolve.mockReset().mockRejectedValue(new Error('not found'));
    mocks.deleteFile.mockReset();
    mocks.batchDelete.mockReset();
    mocks.clientGet.mockReset().mockResolvedValue({ data: { tree: [] } });
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the extension warning focused, contained, and single-flight while rename is pending', async () => {
    const user = userEvent.setup();
    const renameRequest = deferred<{ ok: boolean }>();
    mocks.fetch.mockImplementation((input: string | URL | Request) => {
      if (String(input) === '/api/files/file-1/rename') return renameRequest.promise;
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    renderFilesPage();
    await openPreview(user);
    await user.click(screen.getByRole('button', { name: 'Rename from preview' }));

    const renameDialog = await screen.findByRole('dialog', { name: 'Rename File' });
    expect(renameDialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto');
    const nameInput = within(renameDialog).getByLabelText('New name');
    await waitFor(() => expect(nameInput).toHaveFocus());
    await user.click(within(renameDialog).getByRole('checkbox', { name: 'Show Extensions' }));
    await user.clear(nameInput);
    await user.type(nameInput, 'beta.md');
    await user.click(within(renameDialog).getByRole('button', { name: 'Rename' }));

    const warning = await screen.findByRole('alertdialog', { name: 'Change Extension?' });
    expect(warning).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto');
    const continueButton = within(warning).getByRole('button', { name: 'Continue' });
    act(() => {
      continueButton.click();
      continueButton.click();
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(await within(warning).findByRole('button', { name: 'Renaming…' })).toBeDisabled();
    expect(within(warning).getByRole('button', { name: 'Renaming…' })).toHaveAttribute('aria-busy', 'true');
    expect(within(warning).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    fireEvent.click(warning.parentElement!);
    expect(screen.getByRole('alertdialog', { name: 'Change Extension?' })).toBeInTheDocument();

    await act(async () => { renameRequest.resolve({ ok: true }); });
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Change Extension?' })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');
    expect(JSON.parse(String(mocks.fetch.mock.calls[0][1]?.body))).toEqual({ newName: 'beta.md' });
  });

  it('keeps copy or move controls stable and blocks repeat submission and dismissal', async () => {
    const user = userEvent.setup();
    const copyRequest = deferred<{ ok: boolean; json: () => Promise<Record<string, never>> }>();
    mocks.fetch.mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/projects') {
        return Promise.resolve({ ok: true, json: async () => ({ projects: [{ name: 'Project One' }] }) });
      }
      if (url === '/api/files/file-1/copy-to-project') return copyRequest.promise;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    renderFilesPage();
    await openPreview(user);
    await user.click(screen.getByRole('button', { name: 'Copy from preview' }));

    const copyDialog = await screen.findByRole('dialog', { name: 'Copy to Project' });
    expect(copyDialog).toHaveClass('max-h-[calc(100dvh-2rem)]', 'overflow-y-auto');
    const projectSelect = within(copyDialog).getByLabelText('Destination Project');
    await waitFor(() => expect(projectSelect).toHaveFocus());
    await waitFor(() => expect(within(projectSelect).getByRole('option', { name: 'Project One' })).toBeInTheDocument());
    await user.selectOptions(projectSelect, 'Project One');
    await screen.findByLabelText('Destination Directory');
    await user.click(within(copyDialog).getByRole('checkbox', { name: /Move file/ }));
    const moveButton = within(copyDialog).getByRole('button', { name: 'Move' });
    act(() => {
      moveButton.click();
      moveButton.click();
    });

    const workingButton = await within(copyDialog).findByRole('button', { name: 'Moving…' });
    expect(workingButton).toBeDisabled();
    expect(workingButton).toHaveAttribute('aria-busy', 'true');
    expect(projectSelect).toBeDisabled();
    expect(within(copyDialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(mocks.fetch.mock.calls.filter(([input]) => String(input).includes('copy-to-project'))).toHaveLength(1);

    await user.keyboard('{Escape}');
    fireEvent.click(copyDialog.parentElement!);
    expect(screen.getByRole('dialog', { name: 'Copy to Project' })).toBeInTheDocument();

    await act(async () => { copyRequest.resolve({ ok: true, json: async () => ({}) }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Copy to Project' })).not.toBeInTheDocument());
    const copyCall = mocks.fetch.mock.calls.find(([input]) => String(input).includes('copy-to-project'))!;
    expect(JSON.parse(String(copyCall[1]?.body))).toEqual({
      projectName: 'Project One',
      destinationPath: '/',
      moveFile: true,
    });
    expect(document.body.style.overflow).toBe('');
  });

  it('retains preview and confirmation ownership until one delete request settles', async () => {
    const user = userEvent.setup();
    const deleteRequest = deferred<void>();
    mocks.deleteFile.mockReturnValue(deleteRequest.promise);
    renderFilesPage();
    await openPreview(user);
    await user.click(screen.getByRole('button', { name: 'Delete from preview' }));

    const confirmation = await screen.findByRole('alertdialog', { name: '⚠️ Delete file?' });
    const deleteButton = within(confirmation).getByRole('button', { name: 'Delete' });
    act(() => {
      deleteButton.click();
      deleteButton.click();
    });

    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    expect(await within(confirmation).findByRole('button', { name: 'Deleting file…' })).toBeDisabled();
    expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByTestId('preview-harness')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    fireEvent.click(confirmation.parentElement!);
    expect(screen.getByRole('alertdialog', { name: '⚠️ Delete file?' })).toBeInTheDocument();
    expect(screen.getByTestId('preview-harness')).toBeInTheDocument();

    mocks.list.mockResolvedValue(EMPTY_FILE_LIST);
    await act(async () => { deleteRequest.resolve(); });
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '⚠️ Delete file?' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('preview-harness')).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');
  });

  it('opens an opaque actor/version-bound target without exposing file identity in the route', async () => {
    const route = buildFileDeepLink(FILE.id, FILE.path, TEST_WORKSPACE_BINDING);
    renderFilesPage(route);

    expect(await screen.findByTestId('preview-harness')).toBeInTheDocument();
    expect(screen.getByTestId('files-route')).toHaveTextContent(/^\/files\?open=[a-f0-9]{32}$/);
    expect(screen.getByTestId('files-route')).not.toHaveTextContent(FILE.id);
    expect(screen.getByTestId('files-route')).not.toHaveTextContent(FILE.path);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('matches an exact stored path locally but attests physical paths through the backend', async () => {
    const exactRoute = buildFileDeepLink(undefined, FILE.path, TEST_WORKSPACE_BINDING);
    const exactView = renderFilesPage(exactRoute);
    expect(await screen.findByTestId('preview-harness')).toBeInTheDocument();
    expect(mocks.resolve).not.toHaveBeenCalled();
    exactView.unmount();

    mocks.resolve.mockRejectedValueOnce(new Error('outside actor root'));
    const outsidePath = '/var/portal-files/user-other/uploads/alpha.txt';
    renderFilesPage(buildFileDeepLink(undefined, outsidePath, TEST_WORKSPACE_BINDING));
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith({
      id: undefined,
      path: outsidePath,
    }));
    expect(screen.queryByTestId('preview-harness')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('files-route')).toHaveTextContent(/^\/files$/));
  });

  it('scrubs mismatched and legacy targets without resolving or opening them', async () => {
    const mismatchedRoute = buildFileDeepLink(FILE.id, FILE.path, {
      ...TEST_WORKSPACE_BINDING,
      authorizationVersion: TEST_WORKSPACE_BINDING.authorizationVersion - 1,
    });
    const firstView = renderFilesPage(mismatchedRoute);
    await waitFor(() => expect(screen.getByTestId('files-route')).toHaveTextContent(/^\/files$/));
    expect(screen.queryByTestId('preview-harness')).not.toBeInTheDocument();
    expect(mocks.resolve).not.toHaveBeenCalled();
    firstView.unmount();

    renderFilesPage('/files?file=file-1&path=owner%2Fsecret.txt');
    await waitFor(() => expect(screen.getByTestId('files-route')).toHaveTextContent(/^\/files$/));
    expect(screen.queryByTestId('preview-harness')).not.toBeInTheDocument();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('does not write file IDs or paths into the URL for an ordinary preview', async () => {
    const user = userEvent.setup();
    renderFilesPage();
    await openPreview(user);
    expect(screen.getByTestId('files-route')).toHaveTextContent(/^\/files$/);
    expect(screen.getByTestId('files-route')).not.toHaveTextContent(FILE.id);
    expect(screen.getByTestId('files-route')).not.toHaveTextContent(FILE.path);
  });
});
