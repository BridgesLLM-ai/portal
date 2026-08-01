import {
  APP_HOSTING_UNCONFIGURED_REASON,
  LOCAL_MAIL_UNAVAILABLE_REASON,
  TAILNET_APP_HOSTING_UNAVAILABLE_REASON,
  TAILNET_MAIL_UNAVAILABLE_REASON,
  PortalFeatureUnavailableError,
  assertPortalFeatureAvailable,
  configuredPortalOriginMode,
  getPortalFeatureCapabilities,
  portalFeatureUnavailableResponse,
  privateRecoveryOriginIsAllowed,
} from '../utils/portalFeatureCapabilities';

describe('Portal origin feature capabilities', () => {
  test('keeps a Tailnet machine name private and disables public-domain features', () => {
    const environment = {
      ORIGIN_MODE: 'tailnet',
      INSTALL_PROFILE: 'server',
      CORS_ORIGIN: 'https://portal.example-tailnet.ts.net,http://localhost:4001',
      APP_CONTENT_ORIGIN: '',
    } as NodeJS.ProcessEnv;

    expect(configuredPortalOriginMode(environment)).toBe('tailnet');
    expect(getPortalFeatureCapabilities(environment)).toEqual({
      originMode: 'tailnet',
      experimental: true,
      privateNetworkOnly: true,
      mail: {
        available: false,
        reason: TAILNET_MAIL_UNAVAILABLE_REASON,
      },
      appHosting: {
        available: false,
        reason: TAILNET_APP_HOSTING_UNAVAILABLE_REASON,
      },
    });
    expect(portalFeatureUnavailableResponse('mail', environment)).toMatchObject({
      code: 'PORTAL_FEATURE_UNAVAILABLE',
      feature: 'mail',
      retryable: false,
    });
    expect(() => assertPortalFeatureAvailable('mail', environment)).toThrow(
      PortalFeatureUnavailableError,
    );
    try {
      assertPortalFeatureAvailable('mail', environment);
    } catch (error) {
      expect(error).toMatchObject({
        name: 'PortalFeatureUnavailableError',
        code: 'PORTAL_FEATURE_UNAVAILABLE',
        feature: 'mail',
        retryable: false,
        message: TAILNET_MAIL_UNAVAILABLE_REASON,
      });
    }
  });

  test('requires an actually distinct app-content origin in domain mode', () => {
    const base = {
      ORIGIN_MODE: '',
      INSTALL_PROFILE: 'server',
      CORS_ORIGIN: 'https://portal.example.com',
    } as NodeJS.ProcessEnv;

    expect(getPortalFeatureCapabilities(base)).toMatchObject({
      originMode: 'domain',
      experimental: false,
      privateNetworkOnly: false,
      mail: { available: true, reason: null },
      appHosting: { available: false, reason: APP_HOSTING_UNCONFIGURED_REASON },
    });
    expect(() => assertPortalFeatureAvailable('mail', base)).not.toThrow();

    expect(getPortalFeatureCapabilities({
      ...base,
      APP_CONTENT_ORIGIN: 'https://apps.example.net',
    })).toMatchObject({
      appHosting: { available: true, reason: null },
    });
  });

  test('does not treat local mode as Tailnet or public-domain mail authority', () => {
    const environment = {
      INSTALL_PROFILE: 'local',
      ORIGIN_MODE: '',
      CORS_ORIGIN: 'http://localhost:4001,http://127.0.0.1:4001',
      APP_CONTENT_ORIGIN: 'http://apps.localhost:4001',
    } as NodeJS.ProcessEnv;

    expect(configuredPortalOriginMode(environment)).toBe('local');
    expect(getPortalFeatureCapabilities(environment)).toMatchObject({
      originMode: 'local',
      experimental: true,
      privateNetworkOnly: false,
      mail: { available: false, reason: LOCAL_MAIL_UNAVAILABLE_REASON },
      appHosting: { available: true, reason: null },
    });
  });

  test('allows recovery only through the exact private origin for the selected mode', () => {
    const tailnet = {
      ORIGIN_MODE: 'tailnet',
      INSTALL_PROFILE: 'server',
      CORS_ORIGIN: 'https://portal.example-tailnet.ts.net,http://localhost:4001,https://old-public.example.com',
    } as NodeJS.ProcessEnv;
    expect(privateRecoveryOriginIsAllowed(
      'https://portal.example-tailnet.ts.net',
      tailnet,
    )).toBe(true);
    expect(privateRecoveryOriginIsAllowed('http://localhost:4001', tailnet)).toBe(true);
    expect(privateRecoveryOriginIsAllowed('https://old-public.example.com', tailnet)).toBe(false);
    expect(privateRecoveryOriginIsAllowed('http://portal.example-tailnet.ts.net', tailnet)).toBe(false);
    expect(privateRecoveryOriginIsAllowed('https://portal.example-tailnet.ts.net:8443', tailnet)).toBe(false);

    const local = {
      ORIGIN_MODE: '',
      INSTALL_PROFILE: 'local',
      CORS_ORIGIN: 'http://localhost:4001,http://127.0.0.1:4001',
    } as NodeJS.ProcessEnv;
    expect(privateRecoveryOriginIsAllowed('http://localhost:4001', local)).toBe(true);
    expect(privateRecoveryOriginIsAllowed('http://127.0.0.1:4001', local)).toBe(true);
    expect(privateRecoveryOriginIsAllowed('https://localhost:4001', local)).toBe(false);
    expect(privateRecoveryOriginIsAllowed('http://192.0.2.10:4001', local)).toBe(false);

    expect(privateRecoveryOriginIsAllowed('https://portal.example-tailnet.ts.net', {
      ...tailnet,
      ORIGIN_MODE: '',
    })).toBe(false);
    expect(privateRecoveryOriginIsAllowed(undefined, tailnet)).toBe(false);
  });
});
