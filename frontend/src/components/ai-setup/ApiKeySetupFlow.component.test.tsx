// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../contexts/AuthContext';
import ApiKeySetupFlow from './ApiKeySetupFlow';
import { credentialOperationStorageKey } from './credentialOperationStorage';
import type { ProviderUIConfig } from './providerConfig';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
  },
}));

const provider: ProviderUIConfig = {
  id: 'openai',
  name: 'OpenAI API',
  tier: 1,
  icon: 'sparkles',
  primaryAuthType: 'api_key',
  guidedSetup: { status: 'available', authTypes: ['api_key'] },
  consoleUrl: 'https://example.com',
  signupUrl: 'https://example.com',
  pricingNote: 'Test pricing',
  freeTier: null,
  description: 'Test provider',
  setupInstructions: [],
  defaultModels: [{
    id: 'openai/gpt-test',
    name: 'GPT Test',
    tier: 'balanced',
    description: 'Test model',
  }],
};

async function reachValidatedModelStep(user: ReturnType<typeof userEvent.setup>, secret: string) {
  await user.click(screen.getByRole('button', { name: 'I have my key ready' }));
  await user.type(screen.getByLabelText('OpenAI API API key'), secret);
  await user.click(screen.getByRole('button', { name: 'Validate Key' }));
  await screen.findByRole('button', { name: 'Save & Activate' });
}

describe('ApiKeySetupFlow credential operation identity', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    useAuthStore.setState({ user: null, isAuthenticated: false });
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.get.mockResolvedValue({ data: { defaultModel: null } });
  });

  it('recovers the UUID after a lost response and a closed tab without persisting secret material', async () => {
    const user = userEvent.setup();
    const saveRequests: Array<Record<string, unknown>> = [];
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/validate-key')) return { data: { valid: true, models: ['openai/gpt-test'] } };
      if (url.endsWith('/save-key')) {
        saveRequests.push(body);
        throw { response: { data: { error: `simulated lost response ${saveRequests.length}` } } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const firstTab = render(
      <ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await reachValidatedModelStep(user, 'sk-first-secret');
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    await waitFor(() => expect(saveRequests).toHaveLength(1));
    expect(await screen.findByText('simulated lost response 1')).toBeInTheDocument();

    const storageKey = credentialOperationStorageKey('setup:pending', 'api-key', 'openai');
    const firstId = window.localStorage.getItem(storageKey);
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(firstId).toBe(saveRequests[0].operationId);
    expect(window.localStorage.getItem(storageKey)).not.toContain('sk-first-secret');
    expect([...Array(window.localStorage.length)].map((_, index) => (
      window.localStorage.getItem(window.localStorage.key(index) || '')
    )).join('\n')).not.toContain('sk-first-secret');

    firstTab.unmount();
    window.sessionStorage.clear();
    render(
      <ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await reachValidatedModelStep(user, 'sk-first-secret');
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    await waitFor(() => expect(saveRequests).toHaveLength(2));
    expect(saveRequests[1].operationId).toBe(firstId);
  }, 10_000);

  it('retires a closed-tab UUID rejected for a changed secret and waits for a deliberate fresh retry', async () => {
    const user = userEvent.setup();
    const saveRequests: Array<Record<string, unknown>> = [];
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/validate-key')) return { data: { valid: true, models: ['openai/gpt-test'] } };
      if (url.endsWith('/save-key')) {
        saveRequests.push(body);
        if (saveRequests.length === 1) {
          throw { response: { data: { error: 'simulated lost response' } } };
        }
        if (saveRequests.length === 2) {
          throw {
            response: {
              data: {
                error: 'operation UUID belongs to the earlier secret',
                operationDisposition: 'not_admitted',
              },
            },
          };
        }
        return { data: { success: true } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const firstTab = render(
      <ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await reachValidatedModelStep(user, 'sk-original-secret');
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    expect(await screen.findByText('simulated lost response')).toBeInTheDocument();

    const storageKey = credentialOperationStorageKey('setup:pending', 'api-key', 'openai');
    const retainedId = window.localStorage.getItem(storageKey);
    expect(retainedId).toBe(saveRequests[0].operationId);

    firstTab.unmount();
    const onComplete = vi.fn();
    render(
      <ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />,
    );
    await reachValidatedModelStep(user, 'sk-replacement-secret');
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    expect(await screen.findByText('operation UUID belongs to the earlier secret')).toBeInTheDocument();

    expect(saveRequests).toHaveLength(2);
    expect(saveRequests[1]).toMatchObject({
      operationId: retainedId,
      apiKey: 'sk-replacement-secret',
    });
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    await waitFor(() => expect(saveRequests).toHaveLength(3));
    expect(saveRequests[2]).toMatchObject({ apiKey: 'sk-replacement-secret' });
    expect(saveRequests[2].operationId).not.toBe(retainedId);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  }, 15_000);

  it('retires a closed-tab UUID after default-state drift and does not retry until the user asks', async () => {
    const user = userEvent.setup();
    const saveRequests: Array<Record<string, unknown>> = [];
    let currentDefault: string | null = null;
    mocks.get.mockImplementation(async () => ({ data: { defaultModel: currentDefault } }));
    mocks.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/validate-key')) return { data: { valid: true, models: ['openai/gpt-test'] } };
      if (url.endsWith('/save-key')) {
        saveRequests.push(body);
        if (saveRequests.length === 1) {
          throw { response: { data: { error: 'simulated lost response after setting the default' } } };
        }
        if (saveRequests.length === 2) {
          throw {
            response: {
              data: {
                error: 'operation UUID belongs to the earlier default selection',
                operationDisposition: 'not_admitted',
              },
            },
          };
        }
        return { data: { success: true } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const firstTab = render(
      <ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    await reachValidatedModelStep(user, 'sk-stable-secret');
    expect(screen.getByRole('checkbox', { name: 'Set this as the default AI model' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    expect(await screen.findByText('simulated lost response after setting the default')).toBeInTheDocument();

    const storageKey = credentialOperationStorageKey('setup:pending', 'api-key', 'openai');
    const retainedId = window.localStorage.getItem(storageKey);
    expect(saveRequests[0]).toMatchObject({ operationId: retainedId, setDefault: true });

    firstTab.unmount();
    currentDefault = 'openai/gpt-test';
    const onComplete = vi.fn();
    render(
      <ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={onComplete} onCancel={vi.fn()} />,
    );
    await reachValidatedModelStep(user, 'sk-stable-secret');
    expect(screen.getByRole('checkbox', { name: 'Set this as the default AI model' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    expect(await screen.findByText('operation UUID belongs to the earlier default selection')).toBeInTheDocument();

    expect(saveRequests).toHaveLength(2);
    expect(saveRequests[1]).toMatchObject({
      operationId: retainedId,
      apiKey: 'sk-stable-secret',
      setDefault: false,
    });
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    await waitFor(() => expect(saveRequests).toHaveLength(3));
    expect(saveRequests[2].operationId).not.toBe(retainedId);
    expect(saveRequests[2]).toMatchObject({ apiKey: 'sk-stable-secret', setDefault: false });
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  }, 15_000);

  it('blocks the credential POST when the durable record is malformed', async () => {
    const user = userEvent.setup();
    const storageKey = credentialOperationStorageKey('setup:pending', 'api-key', 'openai');
    window.localStorage.setItem(storageKey, 'malformed-operation-id');
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/validate-key')) return { data: { valid: true, models: ['openai/gpt-test'] } };
      throw new Error(`Credential POST must remain blocked: ${url}`);
    });

    render(<ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachValidatedModelStep(user, 'sk-never-posted');
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    expect(await screen.findByText(/malformed durable credential-operation record/i)).toBeInTheDocument();
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/save-key'))).toHaveLength(0);
  }, 10_000);

  it('blocks the credential POST when localStorage is unavailable', async () => {
    const user = userEvent.setup();
    const storageKey = credentialOperationStorageKey('setup:pending', 'api-key', 'openai');
    const originalGetItem = Storage.prototype.getItem;
    const unavailable = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function getItem(this: Storage, key: string) {
      if (this === window.localStorage && key === storageKey) throw new Error('storage disabled');
      return originalGetItem.call(this, key);
    });
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/validate-key')) return { data: { valid: true, models: ['openai/gpt-test'] } };
      throw new Error(`Credential POST must remain blocked: ${url}`);
    });

    render(<ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachValidatedModelStep(user, 'sk-still-never-posted');
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    expect(await screen.findByText(/cannot verify durable credential-operation storage/i)).toBeInTheDocument();
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/save-key'))).toHaveLength(0);
    unavailable.mockRestore();
  }, 10_000);

  it('blocks the credential POST when a new UUID cannot be read back exactly', async () => {
    const user = userEvent.setup();
    const storageKey = credentialOperationStorageKey('setup:pending', 'api-key', 'openai');
    expect(credentialOperationStorageKey('user:one', 'api-key', 'openai'))
      .not.toBe(credentialOperationStorageKey('user:two', 'api-key', 'openai'));
    const originalSetItem = Storage.prototype.setItem;
    const droppedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === window.localStorage && key === storageKey) return;
      originalSetItem.call(this, key, value);
    });
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/validate-key')) return { data: { valid: true, models: ['openai/gpt-test'] } };
      throw new Error(`Credential POST must remain blocked: ${url}`);
    });

    render(<ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachValidatedModelStep(user, 'sk-readback-must-fail');
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    expect(await screen.findByText(/cannot verify durable credential-operation storage/i)).toBeInTheDocument();
    expect(mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/save-key'))).toHaveLength(0);
    droppedWrite.mockRestore();
  }, 10_000);

  it('retires an exact UUID only after authoritative pre-admission rejection', async () => {
    const user = userEvent.setup();
    const storageKey = credentialOperationStorageKey('setup:pending', 'api-key', 'openai');
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/validate-key')) return { data: { valid: true, models: ['openai/gpt-test'] } };
      if (url.endsWith('/save-key')) {
        throw { response: { data: { error: 'rejected before admission', operationDisposition: 'not_admitted' } } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });
    render(<ApiKeySetupFlow provider={provider} apiBase="/ai-setup" onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachValidatedModelStep(user, 'sk-authoritatively-rejected');
    await user.click(screen.getByRole('button', { name: 'Save & Activate' }));
    expect(await screen.findByText('rejected before admission')).toBeInTheDocument();
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  }, 10_000);
});
