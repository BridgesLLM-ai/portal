// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalPage, { DangerWarningModal } from './TerminalPage';

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  classify: vi.fn(),
  autocomplete: vi.fn(),
  lookup: vi.fn(),
  sockets: [] as Array<{
    listeners: Map<string, (...args: unknown[]) => void>;
    emit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  return {
    motion: {
      div: ReactModule.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
        const {
          children,
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          ...domProps
        } = props;
        return <div ref={ref} {...domProps}>{children as React.ReactNode}</div>;
      }),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('xterm', () => ({
  Terminal: class TerminalMock {
    buffer = {
      active: {
        length: 0,
        getLine: vi.fn(() => undefined),
      },
    };

    loadAddon = vi.fn();
    open = vi.fn();
    writeln = vi.fn();
    write = vi.fn();
    focus = vi.fn();
    clear = vi.fn();
    reset = vi.fn();
    getSelection = vi.fn(() => '');
    dispose = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class FitAddonMock {
    fit = vi.fn();
  },
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      listeners,
      emit: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return socket;
      }),
    };
    mocks.sockets.push(socket);
    return socket;
  }),
  Socket: class SocketMock {},
}));

vi.mock('../api/endpoints', () => ({
  terminalAPI: {
    capabilities: mocks.capabilities,
    classify: mocks.classify,
    autocomplete: mocks.autocomplete,
    lookup: mocks.lookup,
  },
  gatewayAPI: {
    sessions: vi.fn(async () => ({ sessions: [] })),
    history: vi.fn(async () => ({ messages: [] })),
    sendStream: vi.fn(() => new AbortController()),
  },
}));

vi.mock('../utils/sounds', () => ({
  default: {
    click: vi.fn(),
    toggleOn: vi.fn(),
    toggleOff: vi.fn(),
  },
}));

const destructiveCapabilities = {
  generatedAt: '2026-07-21T20:00:00.000Z',
  scope: 'HOST_OPERATOR' as const,
  notice: 'Host operator terminal',
  tools: [],
  services: [],
  shell: {
    name: 'bash',
    executable: '/bin/bash',
    supportsRawInput: true,
    executableCount: 1,
  },
  actions: [
    {
      id: 'restart-demo',
      title: 'Restart demo service',
      description: 'Restart the demo service on the host',
      command: 'systemctl restart demo.service',
      category: 'system',
      risk: 'service_change' as const,
      confirmation: 'typed' as const,
      requirements: [],
      available: true,
      unmetRequirements: [],
    },
  ],
};

const typedWarning = {
  risk: 'service_change' as const,
  confirmation: 'typed' as const,
  message: 'This restarts a host service.',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function renderTerminalPage() {
  render(<TerminalPage />);
  const action = await screen.findByRole('button', { name: /Restart demo service/i });
  await waitFor(() => expect(mocks.sockets.length).toBeGreaterThan(0));
  return action;
}

describe('Terminal modal and transient interaction ownership', () => {
  beforeEach(() => {
    let timestamp = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++timestamp);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    mocks.sockets.length = 0;
    mocks.capabilities.mockResolvedValue(destructiveCapabilities);
    mocks.classify.mockResolvedValue(typedWarning);
    mocks.autocomplete.mockResolvedValue({ suggestions: [] });
    mocks.lookup.mockResolvedValue({ results: [] });
  });

  it('blocks Terminal shortcuts during confirmation, lets Escape cancel once, and restores trigger focus', async () => {
    const user = userEvent.setup();
    const action = await renderTerminalPage();

    await user.keyboard('{Control>}t{/Control}');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));

    await user.click(action);
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm host command' });
    const typedInput = screen.getByRole('textbox', { name: 'Type RUN to confirm' });
    await waitFor(() => expect(typedInput).toHaveFocus());
    expect(dialog.closest('[data-viewport-overlay-root="true"]')?.parentElement).toBe(document.body);

    await user.keyboard('{Control>}t{/Control}');
    expect(screen.getAllByRole('tab', { hidden: true })).toHaveLength(2);
    await user.keyboard('{Control>}w{/Control}');
    expect(screen.getAllByRole('tab', { hidden: true })).toHaveLength(2);
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('button', { name: 'Close terminal assistant', hidden: true })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Confirm host command' })).not.toBeInTheDocument());
    await waitFor(() => expect(action).toHaveFocus());
  });

  it('lets an async destructive modal take ownership above the new-tab popover, then restores both layers', async () => {
    const user = userEvent.setup();
    const classification = deferred<typeof typedWarning>();
    mocks.classify.mockReturnValueOnce(classification.promise);
    const action = await renderTerminalPage();

    const fullscreenButton = screen.getByRole('button', { name: 'Open fullscreen Terminal' });
    await user.click(fullscreenButton);
    expect(screen.getByRole('button', { name: 'Exit fullscreen Terminal' }).closest('.fixed')).toHaveClass('inset-0', 'z-50');

    await user.click(action);
    const newTabButton = screen.getByRole('button', { name: 'Create terminal tab' });
    await user.click(newTabButton);
    const menu = await screen.findByRole('menu', { name: 'Create terminal tab' });
    const transientRoot = menu.closest<HTMLElement>('[data-anchored-popover-root="true"]');
    expect(transientRoot).not.toBeNull();
    expect(transientRoot).toHaveStyle({ zIndex: '1300' });

    await act(async () => {
      classification.resolve(typedWarning);
      await classification.promise;
    });

    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm host command' });
    expect(dialog.closest<HTMLElement>('[data-viewport-overlay-root="true"]')).toHaveStyle({ zIndex: '1400' });
    await waitFor(() => {
      expect(transientRoot).toHaveAttribute('data-viewport-transient-suppressed', 'true');
      expect(transientRoot).toHaveAttribute('aria-hidden', 'true');
      expect(transientRoot).toHaveAttribute('inert');
      expect(transientRoot).not.toBeVisible();
    });
    expect(dialog).toBeVisible();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Confirm host command' })).not.toBeInTheDocument());
    await waitFor(() => {
      expect(transientRoot).not.toHaveAttribute('data-viewport-transient-suppressed');
      expect(transientRoot).not.toHaveAttribute('aria-hidden');
      expect(transientRoot).not.toHaveAttribute('inert');
      expect(screen.getByRole('menu', { name: 'Create terminal tab' })).toBeVisible();
    });
    await waitFor(() => expect(newTabButton).toHaveFocus());
  });

  it('locks dismissal while confirmation is busy and submits only one action', async () => {
    const user = userEvent.setup();
    const confirmation = deferred<void>();
    const onConfirm = vi.fn(() => confirmation.promise);
    const onCancel = vi.fn();
    const { container } = render(
      <DangerWarningModal
        command="rm -rf /tmp/demo"
        message="This removes host files."
        confirmation="typed"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm host command' });
    const input = screen.getByRole('textbox', { name: 'Type RUN to confirm' });
    await waitFor(() => expect(input).toHaveFocus());
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.type(input, 'RUN');
    const runButton = screen.getByRole('button', { name: 'Run command' });
    fireEvent.click(runButton);
    fireEvent.click(runButton);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(input).toBeDisabled();

    await user.keyboard('{Escape}');
    const layer = dialog.closest<HTMLElement>('[data-viewport-modal-layer="true"]');
    expect(layer).not.toBeNull();
    fireEvent.mouseDown(layer as HTMLElement);
    fireEvent.click(layer as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();

    await act(async () => {
      confirmation.resolve();
      await confirmation.promise;
    });
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'false'));
    await user.click(screen.getByRole('button', { name: 'Run command' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('owns the mobile Assistant, single-flights AI Debug, and never carries results to another terminal tab', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes('max-width: 767px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const debug = deferred<{
      commands: Array<{ command: string; explanation: string; warning: null; risk: 'read_only' }>;
      summary: string;
    }>();
    mocks.lookup.mockReturnValueOnce(debug.promise);
    await renderTerminalPage();
    const user = userEvent.setup();

    await user.keyboard('{Control>}t{/Control}');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    const tabs = screen.getAllByRole('tab');
    const firstTab = tabs[0];
    const secondTab = tabs[1];
    expect(secondTab).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('button', { name: 'Open Terminal assistant' }));
    const assistant = await screen.findByRole('dialog', { name: 'Terminal assistant' });
    expect(assistant.closest('[data-viewport-overlay-root="true"]')?.parentElement).toBe(document.body);
    await user.click(screen.getByRole('button', { name: 'AI Debug' }));
    const input = screen.getByRole('textbox', { name: 'Describe a terminal problem' });
    await user.type(input, 'why is this command failing');
    const submit = screen.getByRole('button', { name: 'Debug terminal context' });

    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.click(submit);
      fireEvent.click(screen.getByRole('button', { name: 'Close terminal assistant' }));
      fireEvent.keyDown(window, { key: 't', ctrlKey: true });
      fireEvent.keyDown(window, { key: '1', ctrlKey: true });
    });

    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.lookup).toHaveBeenCalledWith('why is this command failing', '', undefined, 'smart');
    expect(await screen.findByRole('button', { name: 'Debugging terminal context' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close terminal assistant' })).toBeDisabled();
    expect(screen.getAllByRole('tab', { hidden: true })).toHaveLength(2);
    expect(secondTab).toHaveAttribute('aria-selected', 'true');
    expect(assistant).toBeInTheDocument();

    await act(async () => {
      debug.resolve({
        commands: [{ command: 'journalctl -xe', explanation: 'Inspect recent service errors.', warning: null, risk: 'read_only' }],
        summary: 'Inspect the logs first.',
      });
      await debug.promise;
    });
    expect(await screen.findByText('Inspect the logs first.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close terminal assistant' })).toBeEnabled();

    await user.click(firstTab);
    expect(firstTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Inspect the logs first.')).not.toBeInTheDocument();
  });

  it('names the configured Ollama backend when AI Debug is unavailable', async () => {
    mocks.lookup.mockRejectedValueOnce(new Error('backend unavailable'));
    await renderTerminalPage();
    const user = userEvent.setup();

    await user.keyboard('{Control>}k{/Control}');
    await user.click(await screen.findByRole('button', { name: 'AI Debug' }));
    const input = screen.getByRole('textbox', {
      name: 'Describe a terminal problem',
    });
    await user.type(input, 'explain this failure');
    await user.click(screen.getByRole('button', {
      name: 'Debug terminal context',
    }));

    expect(await screen.findByText(
      'Failed to reach the configured Ollama backend. Check Settings → AI Providers and retry.',
    )).toBeVisible();
    expect(screen.queryByText(/Is Ollama running/)).not.toBeInTheDocument();
  });
});
