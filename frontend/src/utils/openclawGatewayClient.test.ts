// @vitest-environment jsdom
import '../test/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GatewayRequestError,
  OpenClawGatewayClient,
  clientMessageIdFromDirectGatewayIdempotencyKey,
  gatewayActiveTurnConflictFromError,
  gatewayUnconfirmedSendFromError,
} from './openclawGatewayClient';

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

class OpenTestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: OpenTestWebSocket[] = [];

  readyState = OpenTestWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    OpenTestWebSocket.instances.push(this);
  }

  open() {
    this.readyState = OpenTestWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  send(data: string) {
    this.sent.push(String(data));
  }

  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close() {
    this.readyState = OpenTestWebSocket.CLOSED;
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

describe('OpenClawGatewayClient direct chat identity and errors', () => {
  beforeEach(() => {
    OpenTestWebSocket.instances = [];
    vi.stubGlobal('WebSocket', OpenTestWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retains structured TURN_ACTIVE identity and snapshot details', async () => {
    const client = new OpenClawGatewayClient({
      url: 'ws://portal.test/api/gateway/direct',
      onEvent: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    client.connect();
    const socket = OpenTestWebSocket.instances[0];
    socket.open();

    const pending = client.request('chat.send', { sessionKey: 'agent:main:portal-owner' });
    const frame = JSON.parse(socket.sent[0]);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'GatewayRequestError',
      code: 'TURN_ACTIVE',
      details: {
        sessionKey: 'agent:main:portal-owner',
        clientMessageId: 'msg-direct-conflict',
        activeStream: { active: true, runId: 'upstream-run' },
      },
    });
    socket.receive({
      type: 'res',
      id: frame.id,
      ok: false,
      error: {
        code: 'TURN_ACTIVE',
        message: 'This chat already has an active turn.',
        sessionKey: 'agent:main:portal-owner',
        clientMessageId: 'msg-direct-conflict',
        activeStream: { active: true, runId: 'upstream-run' },
      },
    });

    await rejection;
    const conflict = gatewayActiveTurnConflictFromError(
      new GatewayRequestError('active', {
        code: 'TURN_ACTIVE',
        sessionKey: 'agent:main:portal-owner',
        clientMessageId: 'msg-direct-conflict',
        activeStream: { active: true, runId: 'upstream-run' },
      }),
      { sessionKey: 'fallback', clientMessageId: 'fallback' },
    );
    expect(conflict).toEqual({
      sessionKey: 'agent:main:portal-owner',
      clientMessageId: 'msg-direct-conflict',
      activeStream: { active: true, runId: 'upstream-run' },
    });
    client.disconnect();
  });

  it('keeps direct optimistic sends in the Portal idempotency namespace', async () => {
    const client = new OpenClawGatewayClient({
      url: 'ws://portal.test/api/gateway/direct',
      onEvent: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    client.connect();
    const socket = OpenTestWebSocket.instances[0];
    socket.open();

    const pending = client.sendMessage(
      'agent:main:portal-owner',
      'Do the work.',
      'msg-1786150000000-7',
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const frame = JSON.parse(socket.sent[0]);
    expect(frame).toMatchObject({
      method: 'chat.send',
      params: {
        idempotencyKey: 'portal-msg-1786150000000-7',
      },
    });
    expect(clientMessageIdFromDirectGatewayIdempotencyKey(
      'portal-msg-1786150000000-7:user',
    )).toBe('msg-1786150000000-7');
    expect(clientMessageIdFromDirectGatewayIdempotencyKey(
      'portal-server-request-entropy:client:msg-1786150000000-7:user',
    )).toBe('msg-1786150000000-7');

    socket.receive({
      type: 'res',
      id: frame.id,
      ok: true,
      payload: { runId: 'upstream-run' },
    });
    await expect(pending).resolves.toBe('upstream-run');
    client.disconnect();
  });

  it('keeps a pre-ack chat send recoverable when the direct gateway socket drops', async () => {
    const client = new OpenClawGatewayClient({
      url: 'ws://portal.test/api/gateway/direct',
      onEvent: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
    });
    client.connect();
    const socket = OpenTestWebSocket.instances[0];
    socket.open();

    const pending = client.request('chat.send', {
      sessionKey: 'agent:main:portal-owner',
      message: 'Continue through the restart.',
      idempotencyKey: 'portal-msg-direct-pre-ack',
    });
    socket.onclose?.({ code: 1012, reason: 'Gateway restarting' } as CloseEvent);

    const error = await pending.catch((caught) => caught);
    expect(error).toMatchObject({
      name: 'GatewayRequestError',
      code: 'CHAT_SEND_UNCONFIRMED',
      details: {
        sessionKey: 'agent:main:portal-owner',
        clientMessageId: 'msg-direct-pre-ack',
      },
    });
    expect(gatewayUnconfirmedSendFromError(error, {
      sessionKey: 'fallback',
      clientMessageId: 'fallback',
    })).toEqual({
      sessionKey: 'agent:main:portal-owner',
      clientMessageId: 'msg-direct-pre-ack',
    });
    client.disconnect();
  });
});
