import {
  APP_API_SECRET_HEADER,
  APP_API_ID_HEADER,
  addConfiguredAppApiSecret,
  appApiBindingKey,
  buildAppApiTargetUrl,
  configuredAppApiTarget,
  configuredAppApiSecret,
} from '../utils/appApiProxyAuth';

describe('app API proxy authentication', () => {
  const appId = '87cc0065-6c3e-4a9d-a9ee-c47eaadf9c0a';
  const binding = '87CC0065_6C3E_4A9D_A9EE_C47EAADF9C0A';

  it('derives the binding from the server-selected App id, not an API path namespace', () => {
    expect(appApiBindingKey(appId)).toBe(binding);
    expect(APP_API_ID_HEADER).toBe('x-portal-app-id');
  });

  it('returns the per-app secret when configured', () => {
    const environment = { [`APP_API_SECRET_${binding}`]: '  private-value  ' };
    expect(configuredAppApiSecret(appId, environment)).toBe('private-value');
  });

  it('rejects unsafe header values', () => {
    const environment = { [`APP_API_SECRET_${binding}`]: 'value\r\ninjected: yes' };
    expect(configuredAppApiSecret(appId, environment)).toBeUndefined();
  });

  it('injects a configured secret without copying a client-provided value', () => {
    const headers = { [APP_API_SECRET_HEADER]: 'client-spoof' };
    addConfiguredAppApiSecret(headers, appId, {
      [`APP_API_SECRET_${binding}`]: 'server-secret',
    });
    expect(headers[APP_API_SECRET_HEADER]).toBe('server-secret');
  });

  it('does not add a header for apps that have not opted in', () => {
    const headers: Record<string, string> = {};
    addConfiguredAppApiSecret(headers, 'other-app', {});
    expect(headers).toEqual({});
  });

  it('accepts only app-id-bound loopback targets', () => {
    expect(configuredAppApiTarget(appId, {
      [`APP_API_TARGET_${binding}`]: 'http://127.0.0.1:5005',
    })).toBe('http://127.0.0.1:5005');
    expect(configuredAppApiTarget(appId, {
      [`APP_API_TARGET_${binding}`]: 'https://attacker.example/internal',
    })).toBeUndefined();
    expect(configuredAppApiTarget(appId, {
      APP_API_TARGET_AUTH: 'http://127.0.0.1:5005',
    })).toBeUndefined();
  });

  it('preserves the API path without allowing traversal to select another target', () => {
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth/login', '?next=%2Fhome'))
      .toBe('http://127.0.0.1:5005/api/auth/login?next=%2Fhome');
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', '../admin')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth/../admin')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', '%2e%2e/admin')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth/%2E%2E/admin')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth%2flogin')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth%5Clogin')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth\\login')).toBeUndefined();
  });
});
