import {
  APP_API_SECRET_HEADER,
  APP_API_ID_HEADER,
  addConfiguredAppApiSecret,
  appApiBindingKey,
  buildAppApiTargetUrl,
  configuredAppApiTarget,
  configuredAppApiTargetBinding,
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

  it('distinguishes an absent target from every present-but-invalid binding', () => {
    expect(configuredAppApiTargetBinding(appId, {})).toEqual({ status: 'absent' });
    for (const value of [
      '',
      '   ',
      'not a URL',
      'https://127.0.0.1:5005',
      'http://10.0.0.1:5005',
      'http://127.0.0.1',
      'http://user:pass@127.0.0.1:5005',
      'http://127.0.0.1:5005?target=other',
      'http://127.0.0.1:5005/#fragment',
      'http://127.0.0.1:5005\r\nunsafe',
      'http://127.0.0.1:5005\\misleading',
    ]) {
      expect(configuredAppApiTargetBinding(appId, {
        [`APP_API_TARGET_${binding}`]: value,
      })).toEqual({ status: 'invalid' });
    }
    expect(configuredAppApiTargetBinding(appId, {
      [`APP_API_TARGET_${binding}`]: '  http://127.0.0.1:5005/base/  ',
    })).toEqual({ status: 'configured', target: 'http://127.0.0.1:5005/base' });
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

  it('forwards a directory-style path instead of rejecting it as an empty segment', () => {
    // A hosted app can launch from a directory URL like `/api/<app>/app/`.
    // Splitting on "/" and rejecting every empty segment made any trailing slash 502 with
    // "App API backend is not configured" — a message about config for what was
    // really a path-parsing rejection. The slash has to survive to the upstream,
    // because the app resolves its asset base URL from it.
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'app/', '?bridge=1'))
      .toBe('http://127.0.0.1:5005/api/app/?bridge=1');
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', '/app/'))
      .toBe('http://127.0.0.1:5005/api/app/');
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'app/index.html'))
      .toBe('http://127.0.0.1:5005/api/app/index.html');
  });

  it('still rejects internal empty segments and traversal that ends in a slash', () => {
    // Tolerating a trailing slash must not tolerate segment confusion.
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth//login')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth//')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', '../admin/')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth/../admin/')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', '/')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', '//')).toBeUndefined();
    expect(buildAppApiTargetUrl('http://127.0.0.1:5005', 'auth\\login/')).toBeUndefined();
  });
});
