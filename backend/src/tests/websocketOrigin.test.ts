import { config } from '../config/env';
import { isAllowedWebSocketOrigin } from '../utils/websocketOrigin';

describe('websocket origin validation', () => {
  const originalCorsOrigin = [...config.corsOrigin];

  afterEach(() => {
    config.corsOrigin = [...originalCorsOrigin];
  });

  it('allows configured origins', () => {
    config.corsOrigin = ['https://portal.example.com'];

    expect(isAllowedWebSocketOrigin('https://portal.example.com')).toBe(true);
  });

  it('allows same-origin websocket upgrades even when CORS_ORIGIN is stale', () => {
    config.corsOrigin = ['http://203.0.113.10'];

    expect(isAllowedWebSocketOrigin('https://portal.example.com', 'portal.example.com')).toBe(true);
  });

  it('rejects cross-origin websocket upgrades', () => {
    config.corsOrigin = ['https://portal.example.com'];

    expect(isAllowedWebSocketOrigin('https://attacker.example.com', 'portal.example.com')).toBe(false);
  });
});
