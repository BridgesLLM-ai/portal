// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentZeroRecoveryCard,
  BlockedAgentChatSendButton,
  ModelPicker,
  ProviderAvailabilityBarrier,
  planAgentChatSelection,
} from './ChatInterface';

const originalInnerWidth = window.innerWidth;

describe('Agent Chat provider navigation', () => {
  it('lets a provider switch restore that provider\'s last session', () => {
    expect(planAgentChatSelection('OPENCLAW', undefined, {
      provider: 'CODEX',
      agentId: undefined,
    })).toMatchObject({
      changed: true,
      providerChanged: true,
      nextAgentId: undefined,
    });
  });

  it('treats switching OpenClaw agents as a scoped navigation', () => {
    expect(planAgentChatSelection('OPENCLAW', undefined, {
      provider: 'OPENCLAW',
      agentId: 'parity',
    })).toMatchObject({
      changed: true,
      providerChanged: false,
      nextAgentId: 'parity',
    });
  });
});

function useMobileViewport() {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 720 });
}

describe('Agent Chat model picker', () => {
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  });

  it('explains models the catalog knows but cannot run instead of hiding them', async () => {
    // an operator looking for gpt-5.6 saw no entry and no reason.
    const user = userEvent.setup();
    render(
      <ModelPicker
        value=""
        onChange={vi.fn()}
        models={['xai/grok-4.5']}
        unavailableModelIds={['openai/gpt-5.6-sol', 'openai/gpt-5.5']}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Chat model' }));
    const note = await screen.findByText(/2 models hidden/i);
    expect(note).toHaveTextContent('openai/gpt-5.6-sol');
    expect(note).toHaveTextContent('Settings → AI Providers');
  });

  it('submits a custom provider model once instead of switching on every keystroke', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelPicker
        value=""
        models={[]}
        modelCatalogKind="none"
        supportsCustomModelInput
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Chat model' }));
    await user.click(screen.getByRole('button', { name: 'Custom model…' }));
    await user.type(screen.getByRole('textbox', { name: 'Custom model name' }), 'codex_oauth/gpt-5.5');

    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply model' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('codex_oauth/gpt-5.5');
  });

  it('keeps a catalog failure actionable even when custom ids are not supported', async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelPicker
        value=""
        models={[]}
        supportsCustomModelInput={false}
        error="Connected provider model catalog could not be loaded."
        onRetry={retry}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Chat model' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Connected provider model catalog could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Retry model catalog' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps the real provider-default reset available outside Agent Zero', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelPicker
        value="gpt-5.5"
        models={['gpt-5.5']}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Chat model' }));
    await user.click(screen.getByRole('button', { name: 'Default' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('restores the desktop model trigger after Escape dismissal', async () => {
    const user = userEvent.setup();
    render(<ModelPicker value="" models={['gpt-5.5']} onChange={vi.fn()} />);
    const opener = screen.getByRole('button', { name: 'Chat model' });

    await user.click(opener);
    expect(await screen.findByRole('dialog', { name: 'Available chat models' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Available chat models' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('requires a catalog-backed Agent Zero model without offering a misleading default', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelPicker
        value=""
        models={['codex_oauth/gpt-5.5']}
        supportsCustomModelInput={false}
        allowDefaultModel={false}
        required
        onChange={onChange}
      />,
    );

    expect(screen.getByRole('button', { name: 'Chat model' })).toHaveTextContent('Select model');
    await user.click(screen.getByRole('button', { name: 'Chat model' }));
    expect(screen.queryByRole('button', { name: 'Default' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Custom model…' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Select model codex_oauth/gpt-5.5' }));
    expect(onChange).toHaveBeenCalledWith('codex_oauth/gpt-5.5');
  });

  it('does not display a stale Agent Zero model while the current catalog is unresolved', () => {
    render(
      <ModelPicker
        value=""
        models={['codex_oauth/gpt-5.6-terra']}
        supportsCustomModelInput={false}
        allowDefaultModel={false}
        required
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Chat model' });
    expect(trigger).toHaveTextContent('Select model');
    expect(trigger).not.toHaveTextContent('gpt-5.6-sol');
  });

  it('offers bounded Agent Zero recovery through Retry and managed runtime Repair', async () => {
    const retry = vi.fn();
    const repair = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentZeroRecoveryCard
        message="Agent Zero’s connected model catalog could not be loaded."
        onRetry={retry}
        onRepair={repair}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Agent Zero needs attention');
    await user.click(screen.getByRole('button', { name: 'Retry Agent Zero' }));
    await user.click(screen.getByRole('button', { name: 'Repair managed runtime' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('keeps required model selection visible when no connected models exist', async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        value=""
        models={[]}
        supportsCustomModelInput={false}
        allowDefaultModel={false}
        required
        emptyMessage="Connect an Agent Zero account first."
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Chat model' }));
    expect(screen.getByRole('status')).toHaveTextContent('Connect an Agent Zero account first.');
  });

  it('uses the shared mobile sheet outside transformed chat ancestors', async () => {
    useMobileViewport();
    const user = userEvent.setup();
    const { container } = render(
      <div style={{ transform: 'translate3d(0, 0, 0)' }}>
        <ModelPicker value="" models={['gpt-5.5']} onChange={vi.fn()} />
      </div>,
    );
    const opener = screen.getByRole('button', { name: 'Chat model' });

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Available chat models' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.closest('[data-anchored-popover-mode="sheet"]')).not.toBeNull();
    expect(container).not.toContainElement(dialog);
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('button', { name: 'Close model selector' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Available chat models' })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Agent Chat selected-provider availability barrier', () => {
  it('exposes a genuinely disabled Send control while the selected provider is unsettled', () => {
    render(
      <>
        <div id="agent-chat-provider-availability">
          Checking Codex availability before sending…
        </div>
        <BlockedAgentChatSendButton
          title="Checking Codex availability before sending…"
          describedBy="agent-chat-provider-availability"
          className="send"
        >
          Send
        </BlockedAgentChatSendButton>
      </>,
    );

    const send = screen.getByRole('button', {
      name: 'Checking Codex availability before sending…',
    });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveAttribute('aria-describedby', 'agent-chat-provider-availability');
  });

  it('shows checking as a blocking status without offering a premature retry', () => {
    render(
      <ProviderAvailabilityBarrier
        assessment={{
          status: 'checking',
          canSend: false,
          message: 'Checking Codex availability before sending…',
          retryable: false,
        }}
        loading
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking Codex availability before sending',
    );
    expect(screen.queryByRole('button', { name: 'Retry provider availability' })).not.toBeInTheDocument();
  });

  it('keeps stale/error state separate from model enumeration and explicitly retryable', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderAvailabilityBarrier
        assessment={{
          status: 'stale',
          canSend: false,
          message: 'Codex availability is stale. Retry before sending.',
          retryable: true,
        }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Codex availability is stale');
    await user.click(screen.getByRole('button', { name: 'Retry provider availability' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/model catalog/i)).not.toBeInTheDocument();
  });

  it('renders no barrier for a ready current provider', () => {
    const { container } = render(
      <ProviderAvailabilityBarrier
        assessment={{
          status: 'ready',
          canSend: true,
          message: null,
          retryable: false,
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
