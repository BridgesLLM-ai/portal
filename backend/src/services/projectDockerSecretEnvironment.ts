/**
 * Project egress credentials reach a container as `--env NAME`: the docker CLI
 * copies each value from its own environment, so none appears in argv, which
 * every local user can read through /proc. Docker CLI 29.8 resolves the name
 * this way for both `container create` and `container exec`. A name whose
 * value is missing from the CLI environment still reaches the Engine, as a
 * bare name, and the CLI does not refuse it; so a missing value is refused
 * here, before spawn.
 */

// The CLI never reads the token's name. It would read the proxy names as its
// own proxy settings, so its environment also gets NO_PROXY=* and the CLI keeps
// connecting directly. Any other name could steer the CLI itself (HOME, PATH,
// DOCKER_*), so it is refused.
export const PROTECTED_DOCKER_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  'PROJECT_EGRESS_PROXY_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
]);

/** A docker command whose `--env NAME` arguments read `secretEnvironment`. */
export interface ProtectedDockerCommand {
  readonly args: string[];
  readonly secretEnvironment: Readonly<Record<string, string>>;
}

/**
 * `--env` arguments for a container environment, in its own order. A proxy
 * variable with a value is named only; its value moves to `secretEnvironment`.
 * Empty values (the container's `NO_PROXY=`) and other names stay inline.
 */
export function protectedDockerEnvironmentArgs(
  environment: Readonly<Record<string, string>>,
): ProtectedDockerCommand {
  const args: string[] = [];
  const secretEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (PROTECTED_DOCKER_ENVIRONMENT_NAMES.has(name) && value !== '') {
      secretEnvironment[name] = value;
      args.push('--env', name);
    } else {
      args.push('--env', `${name}=${value}`);
    }
  }
  return { args, secretEnvironment: Object.freeze(secretEnvironment) };
}

// Each protected value, and the password inside a protected proxy URL.
function protectedFragments(values: readonly string[]): string[] {
  const fragments = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    fragments.add(value);
    try {
      const password = new URL(value).password;
      if (password) {
        fragments.add(password);
        fragments.add(decodeURIComponent(password));
      }
    } catch {
      // Not a URL: the whole value is the secret.
    }
  }
  return [...fragments].sort((left, right) => right.length - left.length);
}

/** True when an argument carries a protected value, its URL password, or an `extra` secret. */
export function dockerArgsCarryProtectedValue(
  args: readonly string[],
  secretEnvironment: Readonly<Record<string, string>>,
  extraSecrets: readonly string[] = [],
): boolean {
  const fragments = protectedFragments([...Object.values(secretEnvironment), ...extraSecrets]);
  return args.some((value) => fragments.some((fragment) => value.includes(fragment)));
}

// Failure text quotes stderr. Scrub each protected value, and the password
// inside a protected proxy URL, before the text can reach an error or a log.
export function redactProtectedDockerValues(
  text: string,
  secretEnvironment: Readonly<Record<string, string>>,
): string {
  let redacted = text;
  for (const fragment of protectedFragments(Object.values(secretEnvironment))) {
    redacted = redacted.split(fragment).join('[redacted]');
  }
  return redacted;
}

/**
 * The environment for one docker CLI subprocess: `base`, plus the values that
 * its `--env NAME` arguments read, plus NO_PROXY=* for the CLI's own
 * connections. Without protected values it returns `base` unchanged. Throws,
 * without quoting any value, on an unlisted name, a NUL (Node's own spawn error
 * would quote the value), or a protected name on argv whose value is missing.
 */
export function protectedDockerCommandEnvironment(
  base: NodeJS.ProcessEnv,
  args: readonly string[],
  secretEnvironment: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const entries = Object.entries(secretEnvironment);
  if (entries.some(([name, value]) => !PROTECTED_DOCKER_ENVIRONMENT_NAMES.has(name)
    || typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('Project egress protected environment is invalid');
  }
  for (let index = 0; index < args.length - 1; index += 1) {
    if ((args[index] === '--env' || args[index] === '-e')
      && PROTECTED_DOCKER_ENVIRONMENT_NAMES.has(args[index + 1])
      && !Object.prototype.hasOwnProperty.call(secretEnvironment, args[index + 1])) {
      throw new Error('Project egress protected environment is incomplete');
    }
  }
  if (entries.length === 0) return base;
  return { ...base, ...secretEnvironment, NO_PROXY: '*', no_proxy: '*' };
}
