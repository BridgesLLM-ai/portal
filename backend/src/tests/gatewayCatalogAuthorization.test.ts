import gatewayRouter from '../routes/gateway';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { AgentRegistry } from '../agents';

function routeHandlers(path: string): Array<(...args: any[]) => any> {
  const layer = (gatewayRouter as any).stack.find((entry: any) => entry.route?.path === path);
  if (!layer) throw new Error(`gateway ${path} route not found`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

function elevatedCatalogMiddleware(path: string) {
  const handlers = routeHandlers(path);
  const middleware = handlers.find((handler: unknown) => handler === requireAdmin);
  if (!middleware) throw new Error(`gateway ${path} route has no elevated-role middleware`);
  return {
    middleware,
    middlewareIndex: handlers.indexOf(middleware),
    terminalHandlerIndex: handlers.length - 1,
  };
}

describe('Agent Chat catalog authorization', () => {
  test.each(['/providers', '/commands'])(
    '%s applies the elevated-role gate before host metadata discovery',
    (path) => {
      const route = elevatedCatalogMiddleware(path);
      expect(route.middlewareIndex).toBeGreaterThan(0);
      expect(route.middlewareIndex).toBeLessThan(route.terminalHandlerIndex);
    },
  );

  test.each(['/providers', '/commands'])(
    '%s rejects ordinary users at the elevated-role boundary',
    (path) => {
      const { middleware } = elevatedCatalogMiddleware(path);
      const next = jest.fn();
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      middleware({ user: { role: 'USER' } } as any, res as any, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Admin access required' });
      expect(next).not.toHaveBeenCalled();
    },
  );

  test.each(['OWNER', 'SUB_ADMIN'])(
    'allows %s through all host catalog boundaries',
    (role) => {
      for (const path of ['/providers', '/commands']) {
        const { middleware } = elevatedCatalogMiddleware(path);
        const next = jest.fn();
        middleware(
          { user: { role } } as any,
          { status: jest.fn().mockReturnThis(), json: jest.fn() } as any,
          next,
        );
        expect(next).toHaveBeenCalledTimes(1);
      }
    },
  );

  test('keeps the shared model catalog authenticated without breaking Project Chat consumers', () => {
    const handlers = routeHandlers('/models');
    expect(handlers[0]).toBe(authenticateToken);
    expect(handlers).not.toContain(requireAdmin);
  });

  test('marks host provider readiness as private and non-cacheable', async () => {
    const handlers = routeHandlers('/providers');
    const terminalHandler = handlers[handlers.length - 1];
    const listSpy = jest.spyOn(AgentRegistry, 'listProvidersAsync').mockResolvedValue([]);
    const res = {
      setHeader: jest.fn().mockReturnThis(),
      vary: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    };

    await terminalHandler({} as any, res as any);

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store, max-age=0',
    );
    expect(res.vary).toHaveBeenCalledWith('Authorization');
    expect(res.vary).toHaveBeenCalledWith('Cookie');
    expect(res.json).toHaveBeenCalledWith({ providers: [] });
  });
});
