// @vitest-environment jsdom
import '../../test/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock('../../api/appCredentials', () => ({ appCredentialsAPI: api }));
import ProjectAppCredentials from './ProjectAppCredentials';

const APP = '11111111-2222-4333-8444-555555555555';
const SECRET = 'DUMMY-NOT-A-REAL-SECRET';
const view = (overrides: Record<string, unknown> = {}) => ({
  app: { id: APP, name: 'demo-app' },
  revision: 5,
  slots: [
    { slot: 'api-token', revision: 5, updatedAt: '2026-10-06T05:00:00.000Z', updatedBy: { kind: 'operator' } },
    { slot: 'legacy-key', revision: 2, updatedAt: '2026-10-06T04:00:00.000Z', updatedBy: { kind: 'user', username: 'site-owner' } },
  ],
  limits: { maxSlots: 16, maxBytes: 65536 },
  containerDirectory: '/portal/credentials',
  runtime: { running: true, restartRequired: false },
  ...overrides,
});

describe('Project App credentials', () => {
  beforeEach(() => {
    api.list.mockReset().mockResolvedValue(view());
    api.set.mockReset();
    api.remove.mockReset();
  });

  it('is managed by the Portal owner only: others see a note and nothing is requested', () => {
    render(<ProjectAppCredentials appId={APP} canManage={false} />);
    expect(screen.getByText('App credentials are managed by the Portal owner.')).toBeVisible();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('lists names and who set them, never values, and says when the App must restart', async () => {
    api.list.mockResolvedValue(view({ runtime: { running: true, restartRequired: true } }));
    render(<ProjectAppCredentials appId={APP} canManage />);
    expect(await screen.findByText('api-token')).toBeVisible();
    expect(screen.getByText(/by the server operator \(import\)/)).toBeVisible();
    expect(screen.getByText(/by site-owner/)).toBeVisible();
    expect(screen.getByText('Credentials changed since this App started. Restart the App to apply them.')).toBeVisible();
    expect(screen.getByText(/next time the App starts or is redeployed/)).toBeVisible();
    expect(api.list).toHaveBeenCalledWith(APP);
  });

  it('adds a credential through a masked field and drops the value from the page afterwards', async () => {
    api.set.mockResolvedValue(view({ slots: [...view().slots, { slot: 'service-login', revision: 6, updatedAt: '2026-10-06T06:00:00.000Z', updatedBy: { kind: 'user', username: 'site-owner' } }], revision: 6 }));
    render(<ProjectAppCredentials appId={APP} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add credential' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'service-login' } });
    const field = screen.getByLabelText(/Value \(hidden; never shown again\)/) as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
    fireEvent.change(field, { target: { value: `PASSWORD=${SECRET}` } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith(APP, 'service-login', `PASSWORD=${SECRET}`, null));
    expect(await screen.findByText(/Saved "service-login"/)).toBeVisible();
    expect(screen.queryByLabelText(/Value \(hidden/)).toBeNull();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('preserves a multiline paste without putting the payload in the native password field', async () => {
    api.set.mockResolvedValue(view());
    render(<ProjectAppCredentials appId={APP} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add credential' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'multiline-key' } });
    const field = screen.getByLabelText(/Value \(hidden/) as HTMLInputElement;
    const multiline = `first-line\r\n${SECRET}\nlast-line\n`;
    fireEvent.paste(field, { clipboardData: { getData: () => multiline } });
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('readonly');
    expect(field.value).toBe('');
    expect(document.body.innerHTML).not.toContain(SECRET);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith(APP, 'multiline-key', multiline, null));
    expect(await screen.findByText(/Saved "multiline-key"/)).toBeVisible();
  });

  it('replaces exactly the listed revision and removes only after confirmation', async () => {
    api.set.mockResolvedValue(view());
    api.remove.mockResolvedValue(view({ slots: [view().slots[0]], revision: 7 }));
    render(<ProjectAppCredentials appId={APP} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace api-token' }));
    expect(screen.getByText(/Replace/, { selector: 'p' })).toHaveTextContent('Replace api-token (revision 5).');
    fireEvent.change(screen.getByLabelText(/Value \(hidden/), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(api.set).toHaveBeenCalledWith(APP, 'api-token', SECRET, 5));

    fireEvent.click(screen.getByRole('button', { name: 'Remove legacy-key' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(APP, 'legacy-key', 2));
    expect(await screen.findByText(/Removed "legacy-key"/)).toBeVisible();
  });

  it('refuses an invalid name or an oversize value before sending anything', async () => {
    render(<ProjectAppCredentials appId={APP} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add credential' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad_Name' } });
    fireEvent.change(screen.getByLabelText(/Value \(hidden/), { target: { value: 'x' } });
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'big' } });
    fireEvent.change(screen.getByLabelText(/Value \(hidden/), { target: { value: 'é'.repeat(32769) } });
    expect(screen.getByText('The value is larger than 65536 bytes.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(api.set).not.toHaveBeenCalled();
  });

  describe('a file read that finishes late never restores a value', () => {
    // Controllable FileReader: the test decides when (and whether) a read completes.
    class SlowReader {
      static last: SlowReader | null = null;
      readyState = 0;
      result: string | null = null;
      aborted = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText() { this.readyState = 1; SlowReader.last = this; }
      abort() { this.aborted = true; this.readyState = 2; }
      finish(text: string) { this.result = text; this.readyState = 2; this.onload?.(); }
    }
    const realReader = globalThis.FileReader;
    beforeEach(() => { SlowReader.last = null; (globalThis as any).FileReader = SlowReader; });
    afterEach(() => { (globalThis as any).FileReader = realReader; });

    const startFileRead = () => {
      fireEvent.change(screen.getByLabelText('Load from a file'), { target: { files: [new File(['x'], 'credential.txt')] } });
      expect(SlowReader.last).not.toBeNull();
      return SlowReader.last!;
    };

    it('saves complete multiline file contents without rendering them in the form', async () => {
      api.set.mockResolvedValue(view());
      render(<ProjectAppCredentials appId={APP} canManage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Add credential' }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'file-key' } });
      const pending = startFileRead();
      const contents = `first\n${SECRET}\nlast\n`;
      act(() => pending.finish(contents));
      const field = screen.getByLabelText(/Value \(hidden/) as HTMLInputElement;
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('readonly');
      expect(field.value).toBe('');
      expect(document.body.innerHTML).not.toContain(SECRET);
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(api.set).toHaveBeenCalledWith(APP, 'file-key', contents, null));
      expect(await screen.findByText(/Saved "file-key"/)).toBeVisible();
    });

    it('after a successful save', async () => {
      api.set.mockResolvedValue(view());
      render(<ProjectAppCredentials appId={APP} canManage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Add credential' }));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'service-login' } });
      fireEvent.change(screen.getByLabelText(/Value \(hidden/), { target: { value: `PASSWORD=${SECRET}` } });
      const pending = startFileRead();
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(api.set).toHaveBeenCalledWith(APP, 'service-login', `PASSWORD=${SECRET}`, null));
      expect(await screen.findByText(/Saved "service-login"/)).toBeVisible();
      expect(pending.aborted).toBe(true);
      act(() => pending.finish(`PASSWORD=${SECRET}`));
      fireEvent.click(screen.getByRole('button', { name: 'Add credential' }));
      expect((screen.getByLabelText(/Value \(hidden/) as HTMLInputElement).value).toBe('');
      expect(document.body.innerHTML).not.toContain(SECRET);
    });

    it('after cancel', async () => {
      render(<ProjectAppCredentials appId={APP} canManage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Add credential' }));
      const pending = startFileRead();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(pending.aborted).toBe(true);
      act(() => pending.finish(SECRET));
      fireEvent.click(screen.getByRole('button', { name: 'Add credential' }));
      expect((screen.getByLabelText(/Value \(hidden/) as HTMLInputElement).value).toBe('');
      expect(document.body.innerHTML).not.toContain(SECRET);
    });

    it('a read that finishes while the editor is open records a concealed value', async () => {
      render(<ProjectAppCredentials appId={APP} canManage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Add credential' }));
      const pending = startFileRead();
      act(() => pending.finish('FROM-FILE'));
      expect((screen.getByLabelText(/Value \(hidden/) as HTMLInputElement).value).toBe('');
      expect(screen.getByText(/File loaded\./)).toBeVisible();
      expect(document.body.innerHTML).not.toContain('FROM-FILE');
      fireEvent.click(screen.getByRole('button', { name: 'Clear value' }));
      expect(screen.getByLabelText(/Value \(hidden/)).not.toHaveAttribute('readonly');
    });
  });

  it('shows a server refusal such as a concurrent change, and offers no add at the slot limit', async () => {
    api.set.mockRejectedValue({ response: { status: 409, data: { code: 'APP_CREDENTIAL_CONFLICT', error: 'The credential "api-token" changed since it was loaded. Reload and try again.' } } });
    render(<ProjectAppCredentials appId={APP} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace api-token' }));
    fireEvent.change(screen.getByLabelText(/Value \(hidden/), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed since it was loaded');
    api.list.mockResolvedValue(view({ slots: Array.from({ length: 16 }, (_, index) => ({ slot: `s${index}`, revision: index + 1, updatedAt: '2026-10-06T05:00:00.000Z', updatedBy: { kind: 'operator' } })) }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh App credentials' }));
    expect(await screen.findByText('This App holds the maximum of 16 credentials.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add credential' })).toBeDisabled();
  });
});
