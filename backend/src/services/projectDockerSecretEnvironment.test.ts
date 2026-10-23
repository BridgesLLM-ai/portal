import crypto from 'crypto';
import {
  PROTECTED_DOCKER_ENVIRONMENT_NAMES,
  dockerArgsCarryProtectedValue,
  protectedDockerCommandEnvironment,
  protectedDockerEnvironmentArgs,
  redactProtectedDockerValues,
} from './projectDockerSecretEnvironment';

// Synthetic, per-run values only; assertions compare through booleans.
const canary = () => `canary${crypto.randomBytes(16).toString('base64url')}`;
const proxyUrl = (token: string) => `http://portal:${encodeURIComponent(token)}@172.31.10.2:3128`;

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected a refusal');
}

describe('Project docker secret environment', () => {
  test('names exactly the token and the four proxy variables as protected', () => {
    expect([...PROTECTED_DOCKER_ENVIRONMENT_NAMES].sort()).toEqual([
      'HTTPS_PROXY', 'HTTP_PROXY', 'PROJECT_EGRESS_PROXY_TOKEN', 'http_proxy', 'https_proxy',
    ]);
  });

  test('names proxy credentials only, keeps empty and other entries inline, in the original order', () => {
    const url = proxyUrl(canary());
    const split = protectedDockerEnvironmentArgs({
      HOME: '/home/runtime',
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NO_PROXY: '',
      no_proxy: '',
      ALL_PROXY: '',
      LANG: 'C.UTF-8',
    });
    expect(split.args).toEqual([
      '--env', 'HOME=/home/runtime',
      '--env', 'HTTP_PROXY', '--env', 'HTTPS_PROXY', '--env', 'http_proxy', '--env', 'https_proxy',
      '--env', 'NO_PROXY=', '--env', 'no_proxy=', '--env', 'ALL_PROXY=', '--env', 'LANG=C.UTF-8',
    ]);
    expect(Object.keys(split.secretEnvironment)).toEqual(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']);
    expect(Object.values(split.secretEnvironment).every((value) => value === url)).toBe(true);
    expect(Object.isFrozen(split.secretEnvironment)).toBe(true);
    expect(dockerArgsCarryProtectedValue(split.args, split.secretEnvironment)).toBe(false);
  });

  test('an empty protected value stays inline and is not a secret', () => {
    const split = protectedDockerEnvironmentArgs({ HTTPS_PROXY: '' });
    expect(split.args).toEqual(['--env', 'HTTPS_PROXY=']);
    expect(split.secretEnvironment).toEqual({});
  });

  test('detects a protected value, its URL password, the decoded password or an extra secret in argv', () => {
    const token = `${canary()}/+=`;
    const url = proxyUrl(token);
    const secrets = { HTTPS_PROXY: url };
    expect(dockerArgsCarryProtectedValue(['--env', `HTTPS_PROXY=${url}`], secrets)).toBe(true);
    expect(dockerArgsCarryProtectedValue(['--label', `x=${encodeURIComponent(token)}`], secrets)).toBe(true);
    expect(dockerArgsCarryProtectedValue(['--label', `x=${token}`], secrets)).toBe(true);
    const other = canary();
    expect(dockerArgsCarryProtectedValue(['--label', `x=${other}`], secrets, [other])).toBe(true);
    expect(dockerArgsCarryProtectedValue(['--env', 'HTTPS_PROXY', '--env', 'NO_PROXY='], secrets)).toBe(false);
  });

  test('builds the CLI environment from the base, the named values and NO_PROXY=*', () => {
    const url = proxyUrl(canary());
    const base = { PATH: '/usr/bin', HOME: '/nonexistent', NO_PROXY: 'host-value' };
    const args = ['container', 'exec', '--env', 'HTTPS_PROXY', '--env', 'NO_PROXY=', 'id', 'cmd'];
    const environment = protectedDockerCommandEnvironment(base, args, { HTTPS_PROXY: url });
    expect(environment).toEqual({
      PATH: '/usr/bin', HOME: '/nonexistent', HTTPS_PROXY: url, NO_PROXY: '*', no_proxy: '*',
    });
    expect(base).toEqual({ PATH: '/usr/bin', HOME: '/nonexistent', NO_PROXY: 'host-value' });
  });

  test('without protected values the base environment is returned unchanged', () => {
    const base = { PATH: '/usr/bin' };
    expect(protectedDockerCommandEnvironment(base, ['container', 'ls', '--env', 'HTTPS_PROXY=inline'])).toBe(base);
    expect(protectedDockerCommandEnvironment(base, ['container', 'ls'], {})).toBe(base);
  });

  test.each([
    ['--env'],
    ['-e'],
  ])('refuses a protected name on argv (%s NAME) whose value is missing, before any spawn', (flag) => {
    const url = proxyUrl(canary());
    const failure = failureOf(() => protectedDockerCommandEnvironment(
      { PATH: '/usr/bin' },
      ['container', 'exec', flag, 'HTTP_PROXY', flag, 'HTTPS_PROXY', 'id', 'cmd'],
      { HTTP_PROXY: url },
    ));
    expect(failure.message).toBe('Project egress protected environment is incomplete');
    expect(failure.message.includes(url)).toBe(false);
  });

  test.each([
    ['an unlisted name that would steer the CLI', 'DOCKER_HOST', () => 'unix:///tmp/other.sock'],
    ['an unlisted credential-looking name', 'ALL_PROXY', () => proxyUrl(canary())],
    ['a NUL inside a protected value', 'HTTPS_PROXY', () => `${proxyUrl(canary())}\0tail`],
  ])('refuses %s without quoting the value', (_label, name, value) => {
    const secret = value();
    const failure = failureOf(() => protectedDockerCommandEnvironment(
      { PATH: '/usr/bin' },
      ['container', 'create', '--env', name, 'image'],
      { [name]: secret },
    ));
    expect(failure.message).toBe('Project egress protected environment is invalid');
    expect(failure.message.includes(secret)).toBe(false);
  });

  test('redacts each value, its URL password and the decoded password, longest first', () => {
    const token = `${canary()}/+=`;
    const url = proxyUrl(token);
    const text = `refused ${url} and ${encodeURIComponent(token)} and ${token} end`;
    const redacted = redactProtectedDockerValues(text, { HTTPS_PROXY: url });
    expect(redacted).toBe('refused [redacted] and [redacted] and [redacted] end');
    expect(redactProtectedDockerValues('nothing here', {})).toBe('nothing here');
  });
});
