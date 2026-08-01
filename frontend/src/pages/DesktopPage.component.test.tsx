// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DesktopPage from './DesktopPage';

const desktopMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../api/client', () => ({
  default: { get: desktopMocks.get, post: desktopMocks.post },
}));

const statusPayload = (overrides: Record<string, unknown> = {}) => ({
  status: 'ready',
  message: 'Remote Desktop is ready.',
  diagnostics: {
    configuredUrl: '/novnc/vnc_portal.html?resize=smart',
    allowedPrefixes: ['/novnc', '/vnc'],
    checks: { vncServiceUnitPresent: true, websockifyUnitPresent: true },
  },
  actions: {
    setup: { confirmationPhrase: 'SET UP REMOTE DESKTOP' },
    recover: { confirmationPhrase: 'RESTART REMOTE DESKTOP' },
  },
  ...overrides,
});

const renderPage = () => render(
  <MemoryRouter>
    <DesktopPage />
  </MemoryRouter>,
);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('DesktopPage Remote Desktop contract', () => {
  beforeEach(() => {
    desktopMocks.get.mockReset().mockResolvedValue({ data: statusPayload() });
    desktopMocks.post.mockReset().mockResolvedValue({ data: { ok: false, steps: [] } });
  });

  it('requires an elevated operator to type the backend confirmation before host setup', async () => {
    const payload = statusPayload({
      status: 'unavailable',
      diagnostics: {
        configuredUrl: '',
        allowedPrefixes: ['/novnc', '/vnc'],
        checks: { vncServiceUnitPresent: false, websockifyUnitPresent: false },
      },
    });
    desktopMocks.get.mockResolvedValue({ data: payload });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Set Up Remote Desktop' }));
    const dialog = screen.getByRole('dialog', { name: 'Install or repair Remote Desktop?' });
    expect(dialog).toBeVisible();
    const confirmButton = screen.getByRole('button', { name: 'Install and restart' });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: /Type SET UP REMOTE DESKTOP to continue/i }), 'SET UP REMOTE DESKTOP');
    await user.click(confirmButton);

    await waitFor(() => {
      expect(desktopMocks.post).toHaveBeenCalledWith('/remote-desktop/auto-setup', {
        confirmation: 'SET UP REMOTE DESKTOP',
      });
    });
  });

  it('names the failing setup step and its reason instead of "review steps above"', async () => {
    // the warning case arrives as an HTTP 500, so the payload has to
    // be read off the thrown error. Previously only `message` survived, which
    // told the operator to review steps that were never shown anywhere.
    const payload = statusPayload({
      status: 'unavailable',
      diagnostics: {
        configuredUrl: '',
        allowedPrefixes: ['/novnc', '/vnc'],
        checks: { vncServiceUnitPresent: false, websockifyUnitPresent: false },
      },
    });
    desktopMocks.get.mockResolvedValue({ data: payload });
    desktopMocks.post.mockRejectedValue({
      response: {
        status: 500,
        data: {
          ok: false,
          message: 'Setup completed with warnings — review steps above.',
          steps: [
            { step: 'Verify noVNC portal HTML', ok: true, message: 'Present' },
            {
              step: 'Verify AI runtime launchers',
              ok: false,
              message: 'AI runtime launcher readiness blocked:\n - antigravity runtime binary at /usr/local/bin/agy failed its Portal command/version contract (expected 1.1.7)',
            },
          ],
        },
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Set Up Remote Desktop' }));
    await user.type(screen.getByRole('textbox', { name: /Type SET UP REMOTE DESKTOP to continue/i }), 'SET UP REMOTE DESKTOP');
    await user.click(screen.getByRole('button', { name: 'Install and restart' }));

    const failures = await screen.findAllByText(/1 step needs attention/i);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toHaveTextContent('Verify AI runtime launchers');
    expect(failures[0]).toHaveTextContent('expected 1.1.7');
  });

  it('retains setup ownership through the settle delay and exact status readback', async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 2000) {
        queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return 1 as any;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);
    try {
      const unavailable = statusPayload({
        status: 'unavailable',
        diagnostics: {
          configuredUrl: '',
          allowedPrefixes: ['/novnc', '/vnc'],
          checks: { vncServiceUnitPresent: false, websockifyUnitPresent: false },
        },
      });
      const verified = deferred<{ data: ReturnType<typeof statusPayload> }>();
      let setupStarted = false;
      desktopMocks.get.mockImplementation(() => setupStarted
        ? verified.promise
        : Promise.resolve({ data: unavailable }));
      desktopMocks.post.mockImplementation(() => {
        setupStarted = true;
        return Promise.resolve({ data: { ok: true, steps: [] } });
      });
      const { unmount } = renderPage();

      const open = await screen.findByRole('button', { name: 'Set Up Remote Desktop' });
      fireEvent.click(open);
      screen.getByRole('dialog', { name: 'Install or repair Remote Desktop?' });
      fireEvent.change(screen.getByRole('textbox', { name: /Type SET UP REMOTE DESKTOP to continue/i }), {
        target: { value: 'SET UP REMOTE DESKTOP' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
      await act(async () => { await Promise.resolve(); });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
      expect(screen.getByRole('dialog', { name: 'Install or repair Remote Desktop?' })).toBeVisible();
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('button', { name: 'Verifying desktop…' })).toHaveAttribute('aria-busy', 'true');

      await act(async () => {
        verified.resolve({ data: statusPayload() });
        await verified.promise;
      });
      expect(await screen.findByText('Remote Desktop setup is installed and verified ready.')).toBeVisible();
      expect(screen.queryByRole('dialog', { name: 'Install or repair Remote Desktop?' })).not.toBeInTheDocument();
      unmount();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('does not claim connected when the iframe merely loads', async () => {
    renderPage();
    const frame = await screen.findByTitle('Remote desktop session');
    fireEvent.load(frame);
    expect(screen.getByText('Connecting...')).toBeVisible();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: (frame as HTMLIFrameElement).contentWindow,
      data: {
        type: 'bridgesllm.remoteDesktopStatus',
        state: 'connected',
        message: 'Connected',
      },
    }));

    expect(await screen.findByText('Connected')).toBeVisible();
  });

  it('rejects prefix-confused same-origin desktop URLs', async () => {
    desktopMocks.get.mockResolvedValue({
      data: statusPayload({
        diagnostics: {
          configuredUrl: '/novncevil/session',
          allowedPrefixes: ['/novnc'],
          checks: { vncServiceUnitPresent: true, websockifyUnitPresent: true },
        },
      }),
    });
    renderPage();

    expect(await screen.findByText('Remote Desktop configuration error')).toBeVisible();
    expect(screen.getByText(/disallowed same-origin path "\/novncevil\/session"/i)).toBeVisible();
    expect(screen.queryByTitle('Remote desktop session')).not.toBeInTheDocument();
  });

  it('rejects executable or credential-bearing external desktop URLs', async () => {
    desktopMocks.get.mockResolvedValue({
      data: statusPayload({
        diagnostics: {
          configuredUrl: 'javascript:alert(document.cookie)',
          allowedPrefixes: ['/novnc'],
          checks: { vncServiceUnitPresent: true, websockifyUnitPresent: true },
        },
      }),
    });
    const { unmount } = renderPage();
    expect(await screen.findByText('Remote Desktop configuration error')).toBeVisible();
    expect(screen.getByText(/must use HTTP or HTTPS/i)).toBeVisible();
    expect(screen.queryByTitle('Remote desktop session')).not.toBeInTheDocument();
    unmount();

    desktopMocks.get.mockResolvedValue({
      data: statusPayload({
        diagnostics: {
          configuredUrl: 'https://operator:secret@example.com/desktop',
          allowedPrefixes: ['/novnc'],
          checks: { vncServiceUnitPresent: true, websockifyUnitPresent: true },
        },
      }),
    });
    renderPage();
    expect(await screen.findByText(/must not contain embedded credentials/i)).toBeVisible();
    expect(screen.queryByTitle('Remote desktop session')).not.toBeInTheDocument();
  });

  it('loads explicit external desktops as non-attested sandboxed frames', async () => {
    desktopMocks.get.mockResolvedValue({
      data: statusPayload({
        status: 'degraded',
        diagnostics: {
          configuredUrl: 'https://desktop.example.test/client',
          allowedPrefixes: ['/novnc'],
          checks: { vncServiceUnitPresent: false, websockifyServiceUnitPresent: false },
        },
      }),
    });
    renderPage();
    const frame = await screen.findByTitle('Remote desktop session');
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-pointer-lock allow-downloads');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.load(frame);
    expect(await screen.findByText('External view loaded')).toBeVisible();
  });

  it('keeps non-disruptive desktop repair available while the framebuffer is healthy', async () => {
    desktopMocks.post.mockResolvedValueOnce({
      data: {
        ok: true,
        mode: 'in-place',
        disrupted: false,
        note: 'Desktop policy repaired without interruption.',
      },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Repair remote desktop' }));
    await waitFor(() => {
      expect(desktopMocks.post).toHaveBeenCalledWith('/remote-desktop/recover', { confirmation: '' });
    });
    expect(await screen.findByText('Desktop policy repaired without interruption.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Restart Remote Desktop services?' })).not.toBeInTheDocument();
  });

  it('single-flights same-frame desktop repair attempts', async () => {
    const repair = deferred<{ data: { ok: boolean; mode: string; disrupted: boolean; note: string } }>();
    desktopMocks.post.mockReturnValueOnce(repair.promise);
    renderPage();

    const repairButton = await screen.findByRole('button', { name: 'Repair remote desktop' });
    act(() => {
      repairButton.click();
      repairButton.click();
    });

    expect(desktopMocks.post).toHaveBeenCalledTimes(1);
    expect(desktopMocks.post).toHaveBeenCalledWith('/remote-desktop/recover', { confirmation: '' });
    expect(await screen.findByRole('button', { name: 'Repair remote desktop' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      repair.resolve({
        data: {
          ok: true,
          mode: 'in-place',
          disrupted: false,
          note: 'Desktop policy repaired without interruption.',
        },
      });
      await repair.promise;
    });
  });

  it('retains recovery ownership until both status and a fresh VNC connection are attested', async () => {
    const verified = deferred<{ data: ReturnType<typeof statusPayload> }>();
    let recoveryStarted = false;
    desktopMocks.get.mockImplementation(() => recoveryStarted
      ? verified.promise
      : Promise.resolve({ data: statusPayload() }));
    desktopMocks.post.mockImplementation(() => {
      recoveryStarted = true;
      return Promise.resolve({
        data: { ok: true, mode: 'restart', disrupted: true, note: 'Desktop services restarted.' },
      });
    });
    renderPage();

    const repairButton = await screen.findByRole('button', { name: 'Repair remote desktop' });
    fireEvent.click(repairButton);
    expect(await screen.findByRole('button', { name: 'Repair remote desktop' })).toHaveAttribute('aria-busy', 'true');
    const frame = screen.getByTitle('Remote desktop session') as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: 'bridgesllm.remoteDesktopStatus', state: 'connected', message: 'Connected' },
    }));

    await act(async () => {
      verified.resolve({ data: statusPayload() });
      await verified.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Repair remote desktop' })).not.toHaveAttribute('aria-busy', 'true'));
    expect(await screen.findByText('Desktop services restarted.')).toBeVisible();
  });

  it('releases recovery only with a retryable failure after the bounded reconnect window', async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeDateNow = Date.now;
    let operationClock = 0;
    let accelerateOperationTimers = false;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => accelerateOperationTimers ? operationClock : nativeDateNow());
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (accelerateOperationTimers && typeof timeout === 'number' && timeout <= 4000) {
        operationClock += timeout;
        queueMicrotask(() => {
          if (typeof handler === 'function') handler(...args);
        });
        return 1 as any;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);
    try {
      let recoveryStarted = false;
      desktopMocks.get.mockImplementation(() => recoveryStarted
        ? new Promise(() => undefined)
        : Promise.resolve({ data: statusPayload() }));
      desktopMocks.post.mockImplementation(() => {
        recoveryStarted = true;
        return Promise.resolve({
          data: { ok: true, mode: 'restart', disrupted: true, note: 'Desktop services restarted.' },
        });
      });
      const { unmount } = renderPage();

      const repairButton = await screen.findByRole('button', { name: 'Repair remote desktop' });
      accelerateOperationTimers = true;
      fireEvent.click(repairButton);
      expect(screen.getByRole('button', { name: 'Repair remote desktop' })).toHaveAttribute('aria-busy', 'true');
      await act(async () => {
        for (let index = 0; index < 30; index += 1) await Promise.resolve();
      });
      await waitFor(() => expect(screen.getByText(/verification did not converge within 20 seconds/i)).toBeVisible());
      expect(screen.getByRole('button', { name: 'Repair remote desktop' })).not.toHaveAttribute('aria-busy', 'true');
      unmount();
    } finally {
      timeoutSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it('asks for typed confirmation only after safe repair reports that a restart is required', async () => {
    desktopMocks.post
      .mockRejectedValueOnce({
        response: {
          data: {
            ok: false,
            restartRequired: true,
            note: 'The graphical session is not running.',
            confirmationPhrase: 'RESTART REMOTE DESKTOP',
          },
        },
      })
      .mockResolvedValueOnce({
        data: { ok: true, mode: 'restart', disrupted: true, note: 'Desktop restarted and verified.' },
      });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Repair remote desktop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restart Remote Desktop services?' });
    expect(dialog).toBeVisible();
    const confirmButton = screen.getByRole('button', { name: 'Restart desktop services' });
    expect(confirmButton).toBeDisabled();
    await user.type(
      screen.getByRole('textbox', { name: /Type RESTART REMOTE DESKTOP to continue/i }),
      'RESTART REMOTE DESKTOP',
    );
    await user.click(confirmButton);
    await waitFor(() => {
      expect(desktopMocks.post).toHaveBeenLastCalledWith('/remote-desktop/recover', {
        confirmation: 'RESTART REMOTE DESKTOP',
      });
    });
    const frame = screen.getByTitle('Remote desktop session') as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: 'bridgesllm.remoteDesktopStatus', state: 'connected', message: 'Connected' },
    }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Restart Remote Desktop services?' })).not.toBeInTheDocument();
    });
  });
});
