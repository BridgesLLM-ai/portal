jest.mock('../config/env', () => ({ config: { nodeEnv: 'test', openclawApiUrl: 'http://localhost:18789' } }));
jest.mock('../config/database', () => ({ prisma: { agentSession: { findFirst: jest.fn() } } }));
import gatewayRouter from '../routes/gateway';
import { prisma } from '../config/database';

function handler() {
  const route = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === '/stream-status');
  return route.route.stack[route.route.stack.length - 1].handle;
}

// Express 4 does not observe a rejected async route promise. These requests must
// settle with a denial, not become the unhandled rejection observed in systemd.
describe('stream-status session resolution rejection', () => {
  test.each(['invalid account identity', 'owner lookup failure'])('%s returns a response without rejecting', async (failure) => {
    const lookup = prisma.agentSession.findFirst as jest.Mock;
    lookup.mockReset();
    if (failure === 'owner lookup failure') lookup.mockRejectedValue(new Error('owner lookup unavailable'));
    else lookup.mockResolvedValue(null);
    const req = { query: { provider: 'OPENCLAW', session: 'main' }, user: { userId: 'synthetic-owner', role: 'OWNER' } };
    const res: any = { json: jest.fn() };
    res.status = jest.fn(() => res);
    await expect(handler()(req, res)).resolves.toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Admin access required' }));
  });
});
