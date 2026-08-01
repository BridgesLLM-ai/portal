// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import { gatewayAPI } from '../../api/endpoints';
import {
  AgentSettingsDrawer,
  CompatibilityHotfixConfirmationDialog,
  SessionControls,
  useAgentChatHeartbeatModel,
} from './ChatInterface';

const mocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  installTool: vi.fn(),
  waitForJob: vi.fn(),
}));

vi.mock('../../api/agentTools', () => ({
  agentToolsAPI: {
    list: mocks.listTools,
    install: mocks.installTool,
  },
  toolInstallConfirmationPhrase: (toolId: string) => `INSTALL ${toolId}`,
  waitForToolInstallJob: mocks.waitForJob,
}));

vi.mock('../ai-setup/AiProviderSetup', () => ({
  default: () => <div>Provider settings</div>,
}));

const originalInnerWidth = window.innerWidth;

const installableTool = {
  id: 'codex',
  name: 'OpenAI Codex',
  description: 'Portal-tested coding runtime.',
  install: [{ label: 'Install Codex', command: 'reviewed-command' }],
  commands: [],
  authRequired: false,
  tier: 1 as const,
  status: {
    installed: false,
    version: null,
    missing: true,
    checkedAt: '2026-07-21T12:00:00.000Z',
  },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function HeartbeatControlsHarness({
  sessionKey = 'agent:main:session-1',
  loadOnOpen = false,
  onReasoningChange = vi.fn(),
}: {
  sessionKey?: string;
  loadOnOpen?: boolean;
  onReasoningChange?: (value: 'off' | 'on' | 'stream') => void;
}) {
  const heartbeat = useAgentChatHeartbeatModel({ enabled: true, sessionKey });
  return (
    <div>
      <output data-testid="heartbeat-value">{heartbeat.heartbeatModel || 'default'}</output>
      <output data-testid="heartbeat-busy">{String(heartbeat.heartbeatModelLoading)}</output>
      <button type="button" onClick={() => { void heartbeat.loadHeartbeatModel(); }}>Load heartbeat</button>
      <button type="button" onClick={() => { heartbeat.setHeartbeatModel('openai/gpt-5.6-terra'); }}>Set heartbeat Terra</button>
      <SessionControls
        thinkingLevel="off"
        reasoningVisibility="off"
        fastModeEnabled={false}
        compactionModelOverride=""
        heartbeatModel={heartbeat.heartbeatModel}
        heartbeatModelLoading={heartbeat.heartbeatModelLoading}
        heartbeatModelError={heartbeat.heartbeatModelError}
        showHeartbeatModel
        onSetThinkingLevel={vi.fn()}
        onSetReasoningVisibility={onReasoningChange}
        onToggleFastMode={vi.fn()}
        onSetCompactionModelOverride={vi.fn()}
        onSetHeartbeatModel={heartbeat.setHeartbeatModel}
        availableModels={['openai/gpt-5.6-terra', 'openai/gpt-5.6-sol']}
        sessionControlsSupported
        onPanelOpen={loadOnOpen ? () => { void heartbeat.loadHeartbeatModel(); } : undefined}
        currentModel="openai/gpt-5.6-terra"
        sessionKey={sessionKey}
      />
    </div>
  );
}

describe('Agent Chat viewport-owned controls', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    mocks.listTools.mockResolvedValue({ tools: [] });
    mocks.installTool.mockReset();
    mocks.waitForJob.mockReset().mockResolvedValue({ id: 'job-1', status: 'completed' });
    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'owner-1', email: 'owner@example.com', role: 'OWNER' },
    } as any);
  });

  afterEach(() => {
    mocks.listTools.mockReset();
    vi.restoreAllMocks();
    useAuthStore.setState({ isAuthenticated: false, user: null });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  });

  it('portals session controls outside clipped chat ancestors and restores the trigger on Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <div style={{ overflow: 'hidden', transform: 'translate3d(0, 0, 0)' }}>
        <SessionControls
          thinkingLevel="off"
          reasoningVisibility="off"
          fastModeEnabled={false}
          compactionModelOverride=""
          heartbeatModel=""
          onSetThinkingLevel={vi.fn()}
          onSetReasoningVisibility={vi.fn()}
          onToggleFastMode={vi.fn()}
          onSetCompactionModelOverride={vi.fn()}
          onSetHeartbeatModel={vi.fn()}
          availableModels={[]}
          sessionControlsSupported={false}
          currentModel="openai/gpt-5.6-terra"
          sessionKey="agent:main:session-1"
        />
      </div>,
    );
    const opener = screen.getByTitle('Session Controls');

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Session controls' });
    expect(container).not.toContainElement(dialog);
    const popoverRoot = dialog.closest<HTMLElement>('[data-anchored-popover-root="true"]');
    expect(popoverRoot).not.toBeNull();
    expect(popoverRoot?.style.zIndex).toBe('1300');
    expect(document.body.innerHTML).not.toContain('z-50');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Session controls' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('retires Session Controls before handing ownership to a confirmation modal', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <SessionControls
        thinkingLevel="off"
        reasoningVisibility="off"
        fastModeEnabled={false}
        compactionModelOverride=""
        heartbeatModel=""
        onSetThinkingLevel={vi.fn()}
        onSetReasoningVisibility={vi.fn()}
        onToggleFastMode={vi.fn()}
        onSetCompactionModelOverride={vi.fn()}
        onSetHeartbeatModel={vi.fn()}
        availableModels={[]}
        sessionControlsSupported
        showCompatibilityHotfix
        compatibilityHotfixStatus={{ supported: true, applied: false, issues: [] } as any}
        onApplyCompatibilityHotfix={onApply}
      />,
    );

    await user.click(screen.getByTitle('Session Controls'));
    await user.click(await screen.findByRole('button', { name: 'Apply + restart' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Session controls' })).not.toBeInTheDocument();
  });

  it('keeps the owning Session Controls surface visible while a mutation is unresolved', async () => {
    const user = userEvent.setup();
    render(
      <SessionControls
        thinkingLevel="high"
        reasoningVisibility="stream"
        fastModeEnabled={false}
        compactionModelOverride=""
        heartbeatModel=""
        onSetThinkingLevel={vi.fn()}
        onSetReasoningVisibility={vi.fn()}
        onToggleFastMode={vi.fn()}
        onSetCompactionModelOverride={vi.fn()}
        onSetHeartbeatModel={vi.fn()}
        availableModels={[]}
        sessionControlsSupported
        sessionControlMutation="fastMode"
        currentModel="openai/gpt-5.6-terra"
        sessionKey="agent:main:session-1"
      />,
    );

    await user.click(screen.getByTitle('Session Controls'));
    const dialog = await screen.findByRole('dialog', { name: 'Session controls' });
    expect(within(dialog).getByRole('button', { name: 'Close session controls' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Saving fast mode…');
  });

  it('admits one heartbeat save in the same render and owns all Session Controls interaction through canonical readback', async () => {
    const patch = deferred<any>();
    const readback = deferred<any>();
    const patchSpy = vi.spyOn(gatewayAPI, 'patchConfigPath').mockReturnValue(patch.promise);
    const readbackSpy = vi.spyOn(gatewayAPI, 'getConfigPath').mockReturnValue(readback.promise);
    const onReasoningChange = vi.fn();
    const user = userEvent.setup();
    render(<HeartbeatControlsHarness onReasoningChange={onReasoningChange} />);

    await user.click(screen.getByTitle('Session Controls'));
    const dialog = await screen.findByRole('dialog', { name: 'Session controls' });
    const heartbeatSelect = within(dialog).getByRole('combobox', { name: 'Heartbeat model' });
    const reasoningSelect = within(dialog).getByRole('combobox', { name: 'Reasoning visibility' });
    const close = within(dialog).getByRole('button', { name: 'Close session controls' });

    act(() => {
      fireEvent.change(heartbeatSelect, { target: { value: 'openai/gpt-5.6-terra' } });
      fireEvent.change(heartbeatSelect, { target: { value: 'openai/gpt-5.6-sol' } });
      fireEvent.change(reasoningSelect, { target: { value: 'stream' } });
      close.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith('agents.defaults.heartbeat.model', 'openai/gpt-5.6-terra');
    expect(onReasoningChange).not.toHaveBeenCalled();
    expect(dialog).toBeVisible();
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Saving heartbeat model…');
    expect(close).toBeDisabled();

    await act(async () => {
      patch.resolve({ value: 'untrusted-patch-value' });
      await patch.promise;
    });
    await waitFor(() => expect(readbackSpy).toHaveBeenCalledTimes(1));
    expect(close).toBeDisabled();
    expect(screen.getByTestId('heartbeat-value')).toHaveTextContent('default');

    await act(async () => {
      readback.resolve({ value: 'openai/gpt-5.6-terra' });
      await readback.promise;
    });
    await waitFor(() => expect(screen.getByTestId('heartbeat-value')).toHaveTextContent('openai/gpt-5.6-terra'));
    expect(close).toBeEnabled();
  });

  it('rejects an older load response after a newer heartbeat mutation owns the generation', async () => {
    const staleLoad = deferred<any>();
    const canonicalReadback = deferred<any>();
    const getSpy = vi.spyOn(gatewayAPI, 'getConfigPath')
      .mockReturnValueOnce(staleLoad.promise)
      .mockReturnValueOnce(canonicalReadback.promise);
    vi.spyOn(gatewayAPI, 'patchConfigPath').mockResolvedValue({ value: 'untrusted-patch-value' });
    const user = userEvent.setup();
    render(<HeartbeatControlsHarness />);

    await user.click(screen.getByRole('button', { name: 'Load heartbeat' }));
    await user.click(screen.getByRole('button', { name: 'Set heartbeat Terra' }));
    await waitFor(() => expect(getSpy).toHaveBeenCalledTimes(2));

    await act(async () => {
      staleLoad.resolve({ value: 'openai/gpt-5.6-sol' });
      await staleLoad.promise;
    });
    expect(screen.getByTestId('heartbeat-value')).toHaveTextContent('default');

    await act(async () => {
      canonicalReadback.resolve({ value: 'openai/gpt-5.6-terra' });
      await canonicalReadback.promise;
    });
    await waitFor(() => expect(screen.getByTestId('heartbeat-value')).toHaveTextContent('openai/gpt-5.6-terra'));
  });

  it('rejects a completed heartbeat response after the owning Agent Chat session changes', async () => {
    const patch = deferred<any>();
    const readback = deferred<any>();
    vi.spyOn(gatewayAPI, 'patchConfigPath').mockReturnValue(patch.promise);
    vi.spyOn(gatewayAPI, 'getConfigPath').mockReturnValue(readback.promise);
    const user = userEvent.setup();
    const { rerender } = render(<HeartbeatControlsHarness sessionKey="agent:main:session-1" />);

    await user.click(screen.getByRole('button', { name: 'Set heartbeat Terra' }));
    rerender(<HeartbeatControlsHarness sessionKey="agent:main:session-2" />);
    await act(async () => {
      patch.resolve({ value: 'openai/gpt-5.6-terra' });
      await patch.promise;
    });
    await act(async () => {
      readback.resolve({ value: 'openai/gpt-5.6-terra' });
      await readback.promise;
    });

    await waitFor(() => expect(screen.getByTestId('heartbeat-busy')).toHaveTextContent('false'));
    expect(screen.getByTestId('heartbeat-value')).toHaveTextContent('default');
  });

  it('keeps the prior confirmed heartbeat model and an honest retryable error when PATCH readback fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const getSpy = vi.spyOn(gatewayAPI, 'getConfigPath')
      .mockResolvedValueOnce({ value: 'openai/gpt-5.6-sol' })
      .mockRejectedValueOnce(new Error('readback offline'));
    vi.spyOn(gatewayAPI, 'patchConfigPath').mockResolvedValue({ value: 'openai/gpt-5.6-terra' });
    const user = userEvent.setup();
    render(<HeartbeatControlsHarness loadOnOpen />);

    await user.click(screen.getByTitle('Session Controls'));
    const dialog = await screen.findByRole('dialog', { name: 'Session controls' });
    const heartbeatSelect = within(dialog).getByRole('combobox', { name: 'Heartbeat model' });
    await waitFor(() => expect(heartbeatSelect).toHaveValue('openai/gpt-5.6-sol'));

    await user.selectOptions(heartbeatSelect, 'openai/gpt-5.6-terra');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('update was accepted, but its saved value could not be verified');
    expect(heartbeatSelect).toHaveValue('openai/gpt-5.6-sol');
    expect(within(dialog).getByRole('button', { name: 'Close session controls' })).toBeEnabled();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('owns the settings drawer through the shared modal and restores page interaction on dismissal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <div data-testid="transformed-chat" style={{ transform: 'translate3d(0, 0, 0)' }}>
          <AgentSettingsDrawer
            open={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          />
        </div>
      );
    }

    const { container } = render(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Agent settings' });
    const close = screen.getByRole('button', { name: 'Close agent settings' });
    expect(container).not.toContainElement(dialog);
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() => expect(close).toHaveFocus());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Agent settings' })).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe('');
  });

  it('single-flights typed host-tool installation and retains startup failure in the owning dialog', async () => {
    const user = userEvent.setup();
    let rejectInstall!: (reason?: unknown) => void;
    const install = new Promise<never>((_resolve, reject) => { rejectInstall = reject; });
    mocks.listTools.mockResolvedValue({ tools: [installableTool] });
    mocks.installTool.mockReturnValueOnce(install);
    render(<AgentSettingsDrawer open onClose={vi.fn()} />);

    await user.click(await screen.findByText('Coding Tools'));
    await user.click(await screen.findByRole('button', { name: 'Install OpenAI Codex' }));
    const dialog = screen.getByRole('dialog', { name: 'Install OpenAI Codex' });
    await user.type(within(dialog).getByLabelText(/INSTALL codex/i), 'INSTALL codex');
    const confirm = within(dialog).getByRole('button', { name: 'Start install' });
    act(() => {
      confirm.click();
      confirm.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(mocks.installTool).toHaveBeenCalledTimes(1);
    expect(mocks.installTool).toHaveBeenCalledWith('codex', 'INSTALL codex');
    expect(await within(dialog).findByRole('button', { name: 'Starting install…' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      rejectInstall({ response: { data: { error: 'Host installer rejected the request' } } });
      await install.catch(() => undefined);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Host installer rejected the request');
    expect(within(dialog).getByRole('button', { name: 'Start install' })).toBeEnabled();
  });

  it('single-flights compatibility hotfix application and closes only after verified server success', async () => {
    const user = userEvent.setup();
    let rejectFirst!: (reason?: unknown) => void;
    const firstAttempt = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const applySpy = vi.spyOn(gatewayAPI, 'applyCompatibilityHotfix').mockReturnValueOnce(firstAttempt);
    const onClose = vi.fn();
    const onVerified = vi.fn();
    render(
      <CompatibilityHotfixConfirmationDialog
        open
        status={{ supported: true, applied: false, confirmationPhrase: 'APPLY HOTFIX', issues: [] } as any}
        onClose={onClose}
        onVerified={onVerified}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Apply OpenClaw compatibility hotfix?' });
    await user.type(within(dialog).getByRole('textbox'), 'APPLY HOTFIX');
    const confirm = within(dialog).getByRole('button', { name: 'Apply hotfix + restart' });
    act(() => {
      confirm.click();
      confirm.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith('APPLY HOTFIX');
    expect(within(dialog).getByRole('button', { name: 'Applying hotfix + restarting…' })).toHaveAttribute('aria-busy', 'true');
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      rejectFirst({ response: { data: { detail: 'Gateway restart was refused' } } });
      await firstAttempt.catch(() => undefined);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Gateway restart was refused');
    expect(dialog).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    const verifiedStatus = { supported: true, applied: true, issues: [] } as any;
    applySpy.mockResolvedValueOnce({ ok: true, alreadyApplied: false, status: verifiedStatus, message: 'Verified after restart' });
    await user.click(within(dialog).getByRole('button', { name: 'Apply hotfix + restart' }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(verifiedStatus, 'Verified after restart'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
