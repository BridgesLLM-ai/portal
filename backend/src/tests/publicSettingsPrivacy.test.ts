const mockFindMany = jest.fn();

jest.mock('../config/database', () => ({
  prisma: { systemSetting: { findMany: mockFindMany } },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: function authenticateToken(_req: unknown, _res: unknown, next: () => void) { next(); },
  requireAdmin: function requireAdmin(_req: unknown, _res: unknown, next: () => void) { next(); },
}));

import settingsRouter from '../routes/settings-public';

function routeLayer(path: string): any {
  return (settingsRouter as any).stack.find((layer: any) => layer.route?.path === path);
}

async function invokeHandler(path: string) {
  const layer = routeLayer(path);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const response = {
    setHeader: jest.fn(),
    json: jest.fn(),
  };
  const next = jest.fn();
  await handler({}, response, next);
  expect(next).not.toHaveBeenCalled();
  expect(response.json).toHaveBeenCalledTimes(1);
  return { payload: response.json.mock.calls[0][0], response };
}

describe('public settings privacy boundary', () => {
  beforeEach(() => mockFindMany.mockReset());

  it('does not query or expose dynamic sub-agent identifiers anonymously', async () => {
    mockFindMany.mockResolvedValue([
      { key: 'appearance.portalName', value: 'Private Portal' },
      // A permissive test double returns an unexpected row; the response must
      // still be schema-shaped rather than forwarding it.
      { key: 'appearance.subAgentAvatar.customer-project', value: '/private.png' },
    ]);

    const { payload } = await invokeHandler('/public');

    expect(payload.portalName).toBe('Private Portal');
    expect(payload).not.toHaveProperty('subAgentAvatars');
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: { key: { in: expect.any(Array) } },
    }));
    expect(mockFindMany.mock.calls[0][0].where.key).not.toHaveProperty('startsWith');
  });

  it('returns avatar IDs only from the admin-authenticated client route', async () => {
    mockFindMany
      .mockResolvedValueOnce([{ key: 'agent.defaultOpenClawAgentId', value: 'main' }])
      .mockResolvedValueOnce([
        { key: 'appearance.subAgentAvatar.customer-project', value: '/private.png' },
      ]);

    const { payload, response } = await invokeHandler('/client');
    const middlewareNames = routeLayer('/client').route.stack.map((entry: any) => entry.handle?.name);

    expect(middlewareNames).toEqual(expect.arrayContaining(['authenticateToken', 'requireAdmin']));
    expect(payload).toMatchObject({
      defaultOpenClawAgentId: 'main',
      subAgentAvatars: { 'customer-project': '/private.png' },
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      expect.stringContaining('private, no-store'),
    );
  });
});
