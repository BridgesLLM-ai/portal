// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../contexts/AuthContext';
import OllamaControl, { __resetOllamaControlStateForTests } from './OllamaControl';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

vi.mock('../api/client', () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
  },
}));

const owner = {
  id: 'owner-1',
  email: 'owner@example.com',
  username: 'owner',
  role: 'OWNER' as const,
  accountStatus: 'ACTIVE' as const,
};

const ownerControls = {
  unload: {
    ownerOnly: true,
    allowed: true,
    available: false,
    confirmationPhrase: 'UNLOAD OLLAMA MODELS',
  },
  restart: {
    ownerOnly: true,
    allowed: true,
    available: true,
    confirmationPhrase: 'RESTART OLLAMA',
  },
};

function offlineStatus() {
  return {
    available: false,
    backend: 'offline',
    version: null,
    models: [],
    runningModels: [],
    isGpu: false,
    authority: null,
    controls: ownerControls,
  };
}

function onlineStatus(runningModels: string[] = ['qwen3:8b']) {
  return {
    available: true,
    backend: 'cpu-local',
    version: '0.32.0',
    models: [{ name: 'qwen3:8b', size: '8.2B', family: 'qwen3' }],
    runningModels,
    isGpu: false,
    authority: {
      kind: 'LOCAL',
      generation: null,
      version: null,
      bindingFingerprint: 'local-loopback',
      displayName: null,
      selectedModel: 'qwen3:8b',
    },
    controls: {
      ...ownerControls,
      unload: { ...ownerControls.unload, available: runningModels.length > 0 },
    },
  };
}

function remoteStatus() {
  return {
    ...onlineStatus([]),
    backend: 'tailnet',
    isGpu: true,
    authority: {
      kind: 'TAILNET',
      generation: 7,
      version: 3,
      bindingFingerprint: 'native-binding-7',
      displayName: 'GPU workstation',
      selectedModel: 'qwen3.5:9b',
    },
  };
}

async function openPanel(): Promise<void> {
  const toggle = await screen.findByRole('button', { name: /Ollama/i });
  fireEvent.click(toggle);
}

describe('Ollama sidebar controls', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    __resetOllamaControlStateForTests();
    useAuthStore.setState({
      user: owner,
      isAuthenticated: true,
      isLoading: false,
      sessionRestoreError: false,
    });
    mocks.get.mockResolvedValue({ data: onlineStatus() });
    mocks.post.mockResolvedValue({ data: { success: true } });
  });

  afterEach(() => {
    __resetOllamaControlStateForTests();
    useAuthStore.setState({ user: null, isAuthenticated: false });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  });

  it('portals above a low sidebar trigger, moves focus inside, and restores it on Escape', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
    const { container } = render(<OllamaControl />);
    const trigger = await screen.findByRole('button', { name: /Ollama/i });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      left: 16,
      right: 220,
      top: 580,
      bottom: 620,
      width: 204,
      height: 40,
      x: 16,
      y: 580,
      toJSON: () => ({}),
    });

    trigger.focus();
    await user.keyboard('{ArrowUp}');
    const panel = await screen.findByRole('dialog', { name: 'Ollama runtime controls' });
    const popoverContent = panel.closest<HTMLElement>('[data-anchored-popover-mode="anchored"]');
    expect(container.contains(panel)).toBe(false);
    expect(popoverContent).toHaveAttribute('data-anchored-popover-placement', 'top');
    expect(popoverContent?.parentElement?.parentElement).toBe(document.body);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Ollama controls' })).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('uses the shared modal sheet and viewport locks on narrow screens', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });
    const { container } = render(<OllamaControl />);
    const trigger = await screen.findByRole('button', { name: /Ollama/i });

    await user.click(trigger);
    const panel = await screen.findByRole('dialog', { name: 'Ollama runtime controls' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(panel.closest('[data-anchored-popover-mode="sheet"]')).not.toBeNull();
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(screen.getByRole('button', { name: 'Close Ollama controls' }));
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps restart available while Ollama is offline and blocks duplicate submissions', async () => {
    const user = userEvent.setup();
    let resolveRestart!: (value: unknown) => void;
    const restartRequest = new Promise((resolve) => { resolveRestart = resolve; });
    mocks.get
      .mockResolvedValueOnce({ data: offlineStatus() })
      .mockResolvedValueOnce({ data: onlineStatus([]) });
    mocks.post.mockReturnValueOnce(restartRequest);

    render(<OllamaControl />);
    await openPanel();
    expect(screen.getByText(/No Ollama backend available/i)).toBeInTheDocument();
    const restart = screen.getByRole('button', { name: 'Restart local' });
    expect(restart).toBeEnabled();
    await user.click(restart);

    await user.type(screen.getByRole('textbox'), 'RESTART OLLAMA');
    const confirm = screen.getByRole('button', { name: 'Restart Ollama' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/system-control/ollama/restart', {
      confirmation: 'RESTART OLLAMA',
    }, {
      _skipNetworkRetry: true,
    });

    await act(async () => {
      resolveRestart({
        data: {
          success: true,
          verified: true,
          active: true,
          message: 'Local Ollama service restarted and is active.',
        },
      });
      await restartRequest;
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Local Ollama service restarted and is active.');
    expect(screen.getAllByText(/Local CPU/i).length).toBeGreaterThan(0);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('fails closed when runtime authority status cannot be loaded', async () => {
    mocks.get.mockRejectedValueOnce(new Error('status unavailable'));

    render(<OllamaControl />);
    await openPanel();

    expect(screen.getByRole('button', { name: 'Restart local' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('shows the authoritative Remote GPU peer/model, links to management, and keeps local restart unavailable', async () => {
    mocks.get.mockResolvedValueOnce({ data: remoteStatus() });
    render(<OllamaControl />);
    await openPanel();

    expect(screen.getByText('GPU workstation')).toBeVisible();
    expect(screen.getByText('qwen3.5:9b')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Manage Remote GPU' })).toHaveAttribute(
      'href',
      '/settings?tab=ai-providers&ollama=tailnet#ollama-tailnet-setup',
    );
    expect(screen.getByRole('button', { name: 'Restart local' })).toBeDisabled();
    expect(screen.getByText(/Local CPU restart is unavailable while the Remote GPU is authoritative/i))
      .toBeVisible();
    expect(mocks.post).not.toHaveBeenCalledWith(
      '/system-control/ollama/restart',
      expect.anything(),
    );
  });

  it('uses a truthful generic Remote GPU label when no peer display name is attested', async () => {
    const status = remoteStatus();
    mocks.get.mockResolvedValueOnce({
      data: {
        ...status,
        authority: {
          ...status.authority,
          displayName: null,
        },
      },
    });
    render(<OllamaControl />);
    await openPanel();

    expect(screen.getAllByText('Remote GPU').length).toBeGreaterThan(0);
  });

  it('queues invalidation during an in-flight poll and refetches authority after a Settings mutation event', async () => {
    let resolveInitial!: (value: { data: ReturnType<typeof onlineStatus> }) => void;
    const initialRequest = new Promise<{ data: ReturnType<typeof onlineStatus> }>((resolve) => {
      resolveInitial = resolve;
    });
    mocks.get
      .mockReturnValueOnce(initialRequest)
      .mockResolvedValueOnce({ data: remoteStatus() });

    render(<OllamaControl />);
    act(() => {
      window.dispatchEvent(new Event('bridgesllm:ollama-runtime-changed'));
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitial({ data: onlineStatus([]) });
      await initialRequest;
    });

    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Ollama: Remote GPU' }))
      .toBeVisible();
  });

  it('labels an available local backend as selected rather than a fallback', async () => {
    render(<OllamaControl />);
    await openPanel();
    expect(screen.getByText('💻 Local CPU Selected')).toBeVisible();
    expect(screen.queryByText(/Local CPU Fallback/)).not.toBeInTheDocument();
  });

  it('unloads running models with typed confirmation and refreshes runner status', async () => {
    const user = userEvent.setup();
    mocks.get
      .mockResolvedValueOnce({ data: onlineStatus(['qwen3:8b']) })
      .mockResolvedValueOnce({ data: onlineStatus([]) });
    mocks.post.mockResolvedValueOnce({
      data: {
        success: true,
        verified: true,
        message: 'Unloaded 1 Ollama model from memory.',
      },
    });

    render(<OllamaControl />);
    await openPanel();
    expect(screen.getAllByText('qwen3:8b')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Unload' }));
    await user.type(screen.getByRole('textbox'), 'UNLOAD OLLAMA MODELS');
    await user.click(screen.getByRole('button', { name: 'Unload models' }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      '/system-control/ollama/kill',
      { confirmation: 'UNLOAD OLLAMA MODELS' },
      { _skipNetworkRetry: true },
    ));
    expect(await screen.findByRole('status')).toHaveTextContent('Unloaded 1 Ollama model from memory.');
    await waitFor(() => {
      expect(screen.queryByText('Running')).not.toBeInTheDocument();
    });
  });

  it('closes the progress dialog and shows a bounded error without raw diagnostics', async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValueOnce({ data: offlineStatus() });
    mocks.post.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          error: 'Traceback litellm.AuthenticationError authorization=cookie-secret {"wall":"of json"}',
        },
      },
    });

    render(<OllamaControl />);
    await openPanel();
    await user.click(screen.getByRole('button', { name: 'Restart local' }));
    await user.type(screen.getByRole('textbox'), 'RESTART OLLAMA');
    await user.click(screen.getByRole('button', { name: 'Restart Ollama' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Portal could not restart the local Ollama service.');
    expect(document.body.textContent).not.toContain('cookie-secret');
    expect(document.body.textContent).not.toContain('Traceback');
    expect(screen.queryByRole('dialog', { name: 'Restart local Ollama?' })).not.toBeInTheDocument();
  });

  it('never replays an interrupted restart and reports the outcome as unknown', async () => {
    const user = userEvent.setup();
    mocks.get
      .mockResolvedValueOnce({ data: offlineStatus() })
      .mockResolvedValueOnce({ data: onlineStatus([]) });
    mocks.post.mockRejectedValueOnce({
      response: { status: 503 },
    });

    render(<OllamaControl />);
    await openPanel();
    await user.click(screen.getByRole('button', { name: 'Restart local' }));
    await user.type(screen.getByRole('textbox'), 'RESTART OLLAMA');
    await user.click(screen.getByRole('button', { name: 'Restart Ollama' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /restart response was interrupted.*will not replay/i,
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('never replays or falsely confirms an interrupted unload', async () => {
    const user = userEvent.setup();
    mocks.get
      .mockResolvedValueOnce({ data: onlineStatus(['qwen3:8b']) })
      .mockResolvedValueOnce({ data: onlineStatus([]) });
    mocks.post.mockRejectedValueOnce(new Error('response lost after unload'));

    render(<OllamaControl />);
    await openPanel();
    await user.click(screen.getByRole('button', { name: 'Unload' }));
    await user.type(screen.getByRole('textbox'), 'UNLOAD OLLAMA MODELS');
    await user.click(screen.getByRole('button', { name: 'Unload models' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /unload response was interrupted.*will not replay/i,
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('does not treat an unavailable status readback as proof an interrupted unload succeeded', async () => {
    const user = userEvent.setup();
    mocks.get
      .mockResolvedValueOnce({ data: onlineStatus(['qwen3:8b']) })
      .mockRejectedValueOnce(new Error('status readback unavailable'));
    mocks.post.mockRejectedValueOnce(new Error('response lost after unload'));

    render(<OllamaControl />);
    await openPanel();
    await user.click(screen.getByRole('button', { name: 'Unload' }));
    await user.type(screen.getByRole('textbox'), 'UNLOAD OLLAMA MODELS');
    await user.click(screen.getByRole('button', { name: 'Unload models' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /unload response was interrupted.*will not replay/i,
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('does not inspect or render Ollama runtime state for sub-admins', async () => {
    useAuthStore.setState({ user: { ...owner, role: 'SUB_ADMIN' } });

    render(<OllamaControl />);
    await waitFor(() => expect(mocks.get).not.toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Ollama:/i })).not.toBeInTheDocument();
  });
});
