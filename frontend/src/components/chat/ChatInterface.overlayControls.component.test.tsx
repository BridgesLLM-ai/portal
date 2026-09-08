// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import { gatewayAPI } from '../../api/endpoints';
import {
  AGENT_CHAT_ASK_USER_SUPERVISOR_REASON,
  AgentSettingsDrawer,
  isAskUserResponseDisabled,
  isAgentChatPositiveApprovalBlocked,
  ModelPicker,
  SessionControls,
  StreamReconnectButton,
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
  id: 'ffmpeg',
  name: 'FFmpeg',
  description: 'Media runtime.',
  install: [{ label: 'Install FFmpeg', command: 'reviewed-command' }],
  commands: [],
  authRequired: false,
  tier: 1 as const,
  status: {
    installed: false,
    version: null,
    missing: true,
    installAvailable: true,
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

  it('allows exact native-run approvals while persistent OpenClaw remains blocked', () => {
    expect(isAgentChatPositiveApprovalBlocked('approval-openclaw-1')).toBe(true);
    expect(isAgentChatPositiveApprovalBlocked('native-codex-1')).toBe(false);
    expect(isAgentChatPositiveApprovalBlocked('native-claude_code-1')).toBe(false);
    expect(isAgentChatPositiveApprovalBlocked('native-gemini-1')).toBe(false);
    expect(isAgentChatPositiveApprovalBlocked('native-grok-1')).toBe(false);
    expect(isAgentChatPositiveApprovalBlocked('native-hermes-1')).toBe(false);
    expect(isAgentChatPositiveApprovalBlocked('native-opencode-1')).toBe(false);
  });

  it('keeps every Agent Chat ask-user response read-only across provider switches', () => {
    expect(isAskUserResponseDisabled('agent-chat', true)).toBe(true);
    expect(isAskUserResponseDisabled('agent-chat', false)).toBe(true);
    expect(isAskUserResponseDisabled('project-chat', true)).toBe(false);
    expect(isAskUserResponseDisabled('project-chat', false)).toBe(true);
    expect(AGENT_CHAT_ASK_USER_SUPERVISOR_REASON).toMatch(/not bound to a supervised native provider run/i);
  });

  it('keeps fenced model and session controls inert in the browser', async () => {
    const onModelChange = vi.fn();
    render(
      <>
        <ModelPicker
          value="openai/gpt-5.6-sol"
          onChange={onModelChange}
          models={['openai/gpt-5.6-sol']}
          disabled
        />
        <SessionControls
          thinkingLevel="high"
          reasoningVisibility="stream"
          fastModeEnabled={false}
          compactionModelOverride=""
          heartbeatModel="openai/gpt-5.6-sol"
          showHeartbeatModel
          onSetThinkingLevel={vi.fn()}
          onSetReasoningVisibility={vi.fn()}
          onToggleFastMode={vi.fn()}
          onSetCompactionModelOverride={vi.fn()}
          onSetHeartbeatModel={vi.fn()}
          availableModels={['openai/gpt-5.6-sol']}
          sessionControlsSupported
          disabled
        />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Chat model' })).toBeDisabled();
    expect(screen.getByTitle('Session Controls')).toBeDisabled();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('renders the real stale-stream rail and invokes its reconnect path', async () => {
    const user = userEvent.setup();
    const onReconnect = vi.fn();
    const { rerender } = render(
      <StreamReconnectButton visible onReconnect={onReconnect} />,
    );

    await user.click(screen.getByRole('button', { name: 'Reconnect live stream' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);

    rerender(<StreamReconnectButton visible={false} onReconnect={onReconnect} />);
    expect(screen.queryByRole('button', { name: 'Reconnect live stream' })).not.toBeInTheDocument();
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

  it('keeps compatibility repair read-only inside Session Controls', async () => {
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
    expect(await screen.findByText('Update via Admin > Maintenance')).toBeVisible();
    expect(screen.getByText(/Owner applies the exact OpenClaw and native-tool bundle under Admin > Maintenance/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Apply + restart' })).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
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
    await user.click(await screen.findByRole('button', { name: 'Install FFmpeg' }));
    const dialog = screen.getByRole('dialog', { name: 'Install FFmpeg' });
    await user.type(within(dialog).getByLabelText(/INSTALL ffmpeg/i), 'INSTALL ffmpeg');
    const confirm = within(dialog).getByRole('button', { name: 'Start install' });
    act(() => {
      confirm.click();
      confirm.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(mocks.installTool).toHaveBeenCalledTimes(1);
    expect(mocks.installTool).toHaveBeenCalledWith('ffmpeg', 'INSTALL ffmpeg');
    expect(await within(dialog).findByRole('button', { name: 'Starting install…' })).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      rejectInstall({ response: { data: { error: 'Host installer rejected the request' } } });
      await install.catch(() => undefined);
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Host installer rejected the request');
    expect(within(dialog).getByRole('button', { name: 'Start install' })).toBeEnabled();
  });

  it('renders managed Codex package status without an install action', async () => {
    mocks.listTools.mockResolvedValue({ tools: [{
      ...installableTool,
      id: 'codex',
      name: 'OpenAI Codex',
      managedInstall: 'npm-cli',
      install: [],
      status: {
        ...installableTool.status,
        state: 'verified',
        installed: true,
        missing: false,
        version: '1.0.0',
        installAvailable: false,
        installUnavailableCode: 'HOST_TOOL_INSTALL_AFTER_SETUP',
      },
    }] });
    render(<AgentSettingsDrawer open onClose={vi.fn()} />);

    await userEvent.click(await screen.findByText('Coding Tools'));
    expect(await screen.findByText('OpenAI Codex')).toBeVisible();
    expect(screen.getByText(/Package detected for Agent Chat.*Owner updates the exact bundle in Admin > Maintenance/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Install OpenAI Codex/i })).not.toBeInTheDocument();
    expect(mocks.installTool).not.toHaveBeenCalled();
  });

  it.each([
    ['agent-zero', 'Agent Zero'],
    ['antigravity', 'Antigravity'],
    ['gemini', 'Antigravity CLI'],
    ['grok-build', 'Grok Build'],
    ['hermes', 'Hermes'],
    ['opencode', 'OpenCode'],
  ])('never offers Portal acquisition for native runtime %s even when a stale row claims it is installable', async (id, name) => {
    mocks.listTools.mockResolvedValue({ tools: [{
      ...installableTool,
      id,
      name,
      install: [{ label: `Install ${name}`, command: 'stale-native-command' }],
      status: { ...installableTool.status, installAvailable: true },
    }] });
    render(<AgentSettingsDrawer open onClose={vi.fn()} />);

    await userEvent.click(await screen.findByText('Coding Tools'));
    expect(await screen.findByText(/use this runtime's dedicated setup/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: `Install ${name}` })).not.toBeInTheDocument();
    expect(mocks.installTool).not.toHaveBeenCalled();
  });

});
