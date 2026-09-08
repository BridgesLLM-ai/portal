// @vitest-environment jsdom
import '../../test/setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NativeCliSetupFlow from './NativeCliSetupFlow';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ default: mocks }));
vi.mock('./HarnessNativeCliTerminal', () => ({ default: () => <div>Live setup terminal</div> }));
const conflict = { response: { status: 409, data: { success: false, code: 'PROVIDER_CREDENTIAL_LIFECYCLE_CONFLICT', error: 'Previous setup was interrupted.' } } };
afterEach(() => vi.resetAllMocks());

describe('native harness interrupted setup recovery', () => {
  it.each(['hermes', 'opencode'] as const)('allows %s recovery only after explicit owner reset', async (provider) => {
    let attempts = 0;
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/reset-lifecycle')) return { data: { success: true, cleared: true } };
      if (url.endsWith('/native-cli/start')) {
        if (++attempts === 1) throw conflict;
        return { data: { success: true, sessionId: 'setup-retry', status: 'processing' } };
      }
      throw Error('Unexpected request');
    });
    mocks.get.mockResolvedValue({ data: { status: 'processing' } });
    const user = userEvent.setup();
    render(<NativeCliSetupFlow provider={provider} apiBase="/api/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Configure Portal/i }));
    await user.click(await screen.findByRole('button', { name: 'Reset interrupted setup' }));
    expect(mocks.post).toHaveBeenCalledWith('/api/ai-setup/oauth/reset-lifecycle', { provider });
    expect(attempts).toBe(1);
    await user.click(screen.getByRole('button', { name: /Configure Portal/i }));
    expect(await screen.findByText('Live setup terminal')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('does not start another login if reset reports an active child', async () => {
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/oauth/reset-lifecycle')) throw { response: { data: { error: 'A provider sign-in is still running.' } } };
      throw conflict;
    });
    const user = userEvent.setup();
    render(<NativeCliSetupFlow provider="hermes" apiBase="/api/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Configure Portal/i }));
    await user.click(await screen.findByRole('button', { name: 'Reset interrupted setup' }));
    expect(await screen.findByText('A provider sign-in is still running.')).toBeInTheDocument();
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/native-cli/start'))).toHaveLength(1);
  });
});
