import Ajv from 'ajv';
import { injectChatMessageWithRpc, type ChatInjectParams } from '../agents/providers/PersistentGatewayWs';
import nativeSchema from './fixtures/openclaw-2026.9.3/chat-inject.schema.json';

// Exported from the archived native schema, not synthesized from Portal's adapter.
const validate = new Ajv({ allErrors: true }).compile(nativeSchema);
const sessionKey = 'agent:main:portal-injection-fixture';

describe('native 2026.9.3 chat.inject contract', () => {
  it('accepts the serialized Portal adapter payload and dispatches only once', async () => {
    const rpc = jest.fn(async (_method: 'chat.inject', params: ChatInjectParams) => {
      const wire = JSON.parse(JSON.stringify(params));
      expect(validate(wire)).toBe(true);
      expect(wire).toEqual({ sessionKey, message: 'Synthetic note 🧪\nsecond line' });
      return { ok: true, messageId: 'synthetic-message-1' };
    });
    await injectChatMessageWithRpc(sessionKey, 'Synthetic note 🧪\nsecond line', rpc);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('chat.inject', expect.any(Object), 30000);
  });

  it.each([
    { sessionKey, text: 'old REST payload', role: 'assistant' },
    { sessionKey, message: { role: 'assistant', content: [{ type: 'input_text', text: 'old direct payload' }] } },
    { sessionKey, message: 'note', role: 'assistant' },
    { sessionKey, message: '' },
    { sessionKey: '', message: 'note' },
  ])('native schema rejects incompatible input %#', (params) => {
    expect(validate(params)).toBe(false);
  });

  it.each(['chat.inject RPC timeout', 'Session access denied', 'WebSocket connection closed'])
  ('propagates %s without replaying the append', async (message) => {
    const error = new Error(message);
    const rpc = jest.fn().mockRejectedValue(error);
    await expect(injectChatMessageWithRpc(sessionKey, 'note', rpc)).rejects.toBe(error);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
