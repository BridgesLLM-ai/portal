// @vitest-environment jsdom
import '../test/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawGatewayClient } from './openclawGatewayClient';

class ClosedUpgradeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: ClosedUpgradeWebSocket[] = [];

  readyState = ClosedUpgradeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    ClosedUpgradeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = ClosedUpgradeWebSocket.CLOSED;
  }

  rejectUpgrade() {
    this.readyState = ClosedUpgradeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: '' } as CloseEvent);
  }
}

describe('OpenClawGatewayClient upgrade authentication recovery', () => {
  beforeEach(() => {
    ClosedUpgradeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', ClosedUpgradeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checks Portal auth once when the browser hides a rejected upgrade as code 1006', async () => {
    const onAuthFailure = vi.fn().mockResolvedValue(false);
    const client = new OpenClawGatewayClient({
      url: 'ws://portal.test/api/gateway/direct',
      onEvent: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onAuthFailure,
    });

    client.connect();
    ClosedUpgradeWebSocket.instances[0].rejectUpgrade();
    await vi.waitFor(() => expect(onAuthFailure).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(ClosedUpgradeWebSocket.instances).toHaveLength(1);
  });

  it('reconnects after a hidden upgrade rejection when session refresh succeeds', async () => {
    const onAuthFailure = vi.fn().mockResolvedValue(true);
    const client = new OpenClawGatewayClient({
      url: 'ws://portal.test/api/gateway/direct',
      onEvent: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onAuthFailure,
    });

    client.connect();
    ClosedUpgradeWebSocket.instances[0].rejectUpgrade();
    await vi.waitFor(() => expect(onAuthFailure).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(ClosedUpgradeWebSocket.instances).toHaveLength(2), {
      timeout: 1_500,
    });

    expect(ClosedUpgradeWebSocket.instances).toHaveLength(2);
  });
});
