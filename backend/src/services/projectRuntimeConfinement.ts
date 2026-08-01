import crypto from 'crypto';
import fs from 'fs';
import { execFileSync } from 'child_process';

export const PROJECT_RUNTIME_CONFINEMENT_POLICY_ENV = 'PROJECT_RUNTIME_CONFINEMENT_POLICY';
export const PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY = 'apparmor-seccomp-v1';
export const PROJECT_RUNTIME_SECCOMP_ONLY_POLICY = 'seccomp-only-apparmor-unsupported-v1';
// Operator-selected degraded install (--skip-project-runtimes). Never a valid
// execution policy: resolution fails closed with a distinct, truthful reason.
export const PROJECT_RUNTIME_DISABLED_POLICY = 'project-runtimes-disabled-v1';
export type ProjectRuntimeConfinementPolicy =
  | typeof PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY
  | typeof PROJECT_RUNTIME_SECCOMP_ONLY_POLICY;

export const PROJECT_RUNTIME_APPARMOR_PROFILE = 'bridgesllm-project-runtime-v1';
export const PROJECT_RUNTIME_APPARMOR_PROFILE_PATH =
  '/etc/apparmor.d/bridgesllm-project-runtime-v1';
export const PROJECT_RUNTIME_APPARMOR_PROFILE_SHA256 =
  '6a6f07e3481c678eb6b417532931a22c54200aba3560e1eaa2cb883f99f33164';
export const PROJECT_RUNTIME_SECCOMP_PROFILE_PATH =
  '/etc/bridgesllm/project-runtime/bridgesllm-project-runtime-v1.seccomp.json';
export const PROJECT_RUNTIME_SECCOMP_PROFILE_SHA256 =
  'de1f5327ca42b80be02daba8d39c0d087a530dc3c16f7028170fe068c9d66e61';

export const CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE =
  'bridgesllm-codex-project-runtime-v1';
export const CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_PATH =
  '/etc/apparmor.d/bridgesllm-codex-project-runtime-v1';
export const CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_SHA256 =
  '8c4e7db070bb7d6be3ef167e17dcc0949992c8fa6b6c58b47b758e2a939f8b24';
export const CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH =
  '/etc/bridgesllm/project-runtime/bridgesllm-codex-project-runtime-v1.seccomp.json';
export const CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_SHA256 =
  'e83f93eaf5b476dfd401d0482210217c5ff1484d1655ba9ca77de59435193c02';

const APPARMOR_ENABLED_PATH = '/sys/module/apparmor/parameters/enabled';
const APPARMOR_LOADED_PROFILES_PATH = '/sys/kernel/security/apparmor/profiles';
const FIXED_DOCKER_HOST_ENVIRONMENT = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/nonexistent',
  DOCKER_CONFIG: '/nonexistent',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

export class ProjectRuntimeConfinementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProjectRuntimeConfinementError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProjectRuntimeConfinementError(code, message);
}

export function resolveProjectRuntimeConfinementPolicy(
  environment: NodeJS.ProcessEnv = process.env,
): ProjectRuntimeConfinementPolicy {
  const configured = String(environment[PROJECT_RUNTIME_CONFINEMENT_POLICY_ENV] || '').trim();
  if (configured === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY
    || configured === PROJECT_RUNTIME_SECCOMP_ONLY_POLICY) {
    return configured;
  }
  if (configured === PROJECT_RUNTIME_DISABLED_POLICY) {
    fail(
      'CONFINEMENT_DISABLED',
      'Project runtimes are disabled on this host: the Portal was installed with '
      + '--skip-project-runtimes because confined runtimes could not be attested. '
      + 'Project Chat is unavailable until the installer runs on a supported host '
      + 'without that flag.',
    );
  }
  // Unit tests build and attest pure Docker plans without touching host policy
  // files. Production has no implicit fallback: the installer must persist one
  // of the two explicit host policies or Project runtime admission is blocked.
  if (environment.NODE_ENV === 'test' && !configured) {
    return PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY;
  }
  fail(
    'CONFINEMENT_POLICY',
    'Project runtime confinement policy is unavailable; rerun the Portal installer before qualification.',
  );
}

interface ProjectRuntimeConfinementProfile {
  appArmorProfile: string;
  appArmorPath: string;
  appArmorSha256: string;
  seccompPath: string;
  seccompSha256: string;
}

const SHARED_PROJECT_RUNTIME_PROFILE: ProjectRuntimeConfinementProfile = Object.freeze({
  appArmorProfile: PROJECT_RUNTIME_APPARMOR_PROFILE,
  appArmorPath: PROJECT_RUNTIME_APPARMOR_PROFILE_PATH,
  appArmorSha256: PROJECT_RUNTIME_APPARMOR_PROFILE_SHA256,
  seccompPath: PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
  seccompSha256: PROJECT_RUNTIME_SECCOMP_PROFILE_SHA256,
});

const CODEX_PROJECT_RUNTIME_PROFILE: ProjectRuntimeConfinementProfile = Object.freeze({
  appArmorProfile: CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE,
  appArmorPath: CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_PATH,
  appArmorSha256: CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_SHA256,
  seccompPath: CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
  seccompSha256: CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_SHA256,
});

function securityOptionValuesForProfile(
  profile: ProjectRuntimeConfinementProfile,
  policy = resolveProjectRuntimeConfinementPolicy(),
): readonly string[] {
  const values = [
    'no-new-privileges:true',
    `seccomp=${profile.seccompPath}`,
  ];
  if (policy === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY) {
    values.push(`apparmor=${profile.appArmorProfile}`);
  }
  return Object.freeze(values);
}

export function projectRuntimeSecurityOptionValues(
  policy = resolveProjectRuntimeConfinementPolicy(),
): readonly string[] {
  return securityOptionValuesForProfile(SHARED_PROJECT_RUNTIME_PROFILE, policy);
}

export function codexProjectRuntimeSecurityOptionValues(
  policy = resolveProjectRuntimeConfinementPolicy(),
): readonly string[] {
  return securityOptionValuesForProfile(CODEX_PROJECT_RUNTIME_PROFILE, policy);
}

export function projectRuntimeSecurityOptArgs(
  policy = resolveProjectRuntimeConfinementPolicy(),
): readonly string[] {
  return Object.freeze(
    projectRuntimeSecurityOptionValues(policy)
      .flatMap((value) => ['--security-opt', value]),
  );
}

export function codexProjectRuntimeSecurityOptArgs(
  policy = resolveProjectRuntimeConfinementPolicy(),
): readonly string[] {
  return Object.freeze(
    codexProjectRuntimeSecurityOptionValues(policy)
      .flatMap((value) => ['--security-opt', value]),
  );
}

function compactTrustedJson(bytes: Buffer): string {
  const source = bytes.toString('utf8');
  try {
    JSON.parse(source);
  } catch {
    fail(
      'CONFINEMENT_FILE_FORMAT',
      'The installed Project runtime seccomp profile is not valid JSON.',
    );
  }

  // Docker stores a file-backed seccomp option in HostConfig.SecurityOpt as
  // Go json.Compact output. Preserve the trusted file's exact key order and
  // escape spelling while removing only insignificant JSON whitespace.
  let compacted = '';
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      compacted += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      compacted += character;
    } else if (!/[\u0020\u0009\u000a\u000d]/.test(character)) {
      compacted += character;
    }
  }
  return compacted;
}

interface ProjectRuntimeSecurityOptionsAttestationInput {
  securityOpt: string[] | null | undefined;
  appArmorProfile?: string | null;
  policy?: ProjectRuntimeConfinementPolicy;
  profileProbe?: Pick<
  ProjectRuntimeConfinementHostProbe,
  'readFile' | 'lstat' | 'realpath'
  >;
}

function attestSecurityOptionsForProfile(
  profile: ProjectRuntimeConfinementProfile,
  input: ProjectRuntimeSecurityOptionsAttestationInput,
): void {
  const policy = input.policy || resolveProjectRuntimeConfinementPolicy();
  const actual = (input.securityOpt || []).map((value) => String(value || '')).sort();
  const seccompOptions = actual.filter((value) => value.startsWith('seccomp='));
  let expectedSeccomp = `seccomp=${profile.seccompPath}`;
  // Existing pure unit fixtures model the create-time path spelling and do not
  // have an installer-managed /etc tree. Production has no such bypass (and
  // the execution boundary already treats NODE_ENV=test as non-production).
  const pureTestPathFixture = process.env.NODE_ENV === 'test'
    && !input.profileProbe
    && seccompOptions.length === 1
    && seccompOptions[0] === expectedSeccomp;
  if (seccompOptions.length === 1 && !pureTestPathFixture) {
    const trustedProfile = assertRootOwnedRegularFile(
      profile.seccompPath,
      profile.seccompSha256,
      input.profileProbe || defaultHostProbe(),
    );
    // Docker has already loaded the profile by inspection time. Only its
    // embedded json.Compact bytes prove which policy that container acquired;
    // a preserved path could point at a file restored after a create-time swap.
    expectedSeccomp = `seccomp=${compactTrustedJson(trustedProfile)}`;
  }
  const expected = securityOptionValuesForProfile(profile, policy)
    .map((value) => (
      value === `seccomp=${profile.seccompPath}` ? expectedSeccomp : value
    ))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      'CONFINEMENT_SECURITY_OPT',
      'Project runtime Docker security options do not match the installed confinement policy.',
    );
  }
  if (policy === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY) {
    if (input.appArmorProfile !== profile.appArmorProfile) {
      fail(
        'CONFINEMENT_APPARMOR_CONTAINER',
        'Project runtime Docker inspection does not report the required AppArmor profile.',
      );
    }
  } else if (input.appArmorProfile !== '') {
    fail(
      'CONFINEMENT_APPARMOR_POLICY',
      'Project runtime AppArmor inspection state does not match the explicit unsupported-host policy.',
    );
  }
}

export function attestProjectRuntimeSecurityOptions(
  input: ProjectRuntimeSecurityOptionsAttestationInput,
): void {
  attestSecurityOptionsForProfile(SHARED_PROJECT_RUNTIME_PROFILE, input);
}

export function attestCodexProjectRuntimeSecurityOptions(
  input: ProjectRuntimeSecurityOptionsAttestationInput,
): void {
  attestSecurityOptionsForProfile(CODEX_PROJECT_RUNTIME_PROFILE, input);
}

/**
 * Retirement-only attestation for the single Project runtime generation that
 * immediately predates the installer-managed seccomp/AppArmor policy.
 *
 * This must never be used to admit execution. Callers first reconstruct and
 * match that generation's exact immutable fingerprint, then use this helper
 * only while stopping and removing the old container.
 */
export function attestPreConfinementProjectRuntimeSecurityOptions(input: {
  securityOpt: string[] | null | undefined;
  appArmorProfile?: string | null;
  policy?: ProjectRuntimeConfinementPolicy;
}): void {
  const policy = input.policy || resolveProjectRuntimeConfinementPolicy();
  const expectedAppArmorProfile = policy === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY
    ? 'docker-default'
    : '';
  const actual = (input.securityOpt || []).map((value) => String(value || '').trim()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(['no-new-privileges:true'])
    || String(input.appArmorProfile || '') !== expectedAppArmorProfile) {
    fail(
      'CONFINEMENT_PREVIOUS_GENERATION',
      'Project runtime Docker security options do not match the exact pre-confinement generation.',
    );
  }
}

export interface ProjectRuntimeConfinementHostProbe {
  readFile(filePath: string): Buffer;
  lstat(filePath: string): fs.Stats;
  realpath(filePath: string): string;
  dockerSecurityOptions(): string;
}

function defaultHostProbe(): ProjectRuntimeConfinementHostProbe {
  return {
    readFile: (filePath) => fs.readFileSync(filePath),
    lstat: (filePath) => fs.lstatSync(filePath),
    realpath: (filePath) => fs.realpathSync(filePath),
    dockerSecurityOptions: () => execFileSync(
      'docker',
      ['info', '--format', '{{json .SecurityOptions}}'],
      {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        env: FIXED_DOCKER_HOST_ENVIRONMENT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim(),
  };
}

function assertRootOwnedRegularFile(
  filePath: string,
  expectedSha256: string,
  probe: Pick<ProjectRuntimeConfinementHostProbe, 'readFile' | 'lstat' | 'realpath'>,
): Buffer {
  let metadata: fs.Stats;
  let bytes: Buffer;
  let resolvedPath: string;
  try {
    metadata = probe.lstat(filePath);
    bytes = probe.readFile(filePath);
    resolvedPath = probe.realpath(filePath);
  } catch {
    fail('CONFINEMENT_FILE_MISSING', 'A required Project runtime confinement profile is unavailable.');
  }
  if (!metadata!.isFile()
    || metadata!.isSymbolicLink()
    || metadata!.uid !== 0
    || metadata!.gid !== 0
    || metadata!.nlink !== 1
    || (metadata!.mode & 0o777) !== 0o644
    || resolvedPath! !== filePath) {
    fail('CONFINEMENT_FILE_METADATA', 'A Project runtime confinement profile has unsafe file metadata.');
  }
  const digest = crypto.createHash('sha256').update(bytes!).digest('hex');
  if (digest !== expectedSha256) {
    fail('CONFINEMENT_FILE_DIGEST', 'A Project runtime confinement profile changed after installation.');
  }
  return bytes!;
}

function parseDockerSecurityOptions(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw || '').trim());
  } catch {
    fail('CONFINEMENT_DOCKER_INFO', 'Docker confinement capabilities could not be parsed.');
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    fail('CONFINEMENT_DOCKER_INFO', 'Docker confinement capabilities are incomplete.');
  }
  return parsed as string[];
}

export function assertProjectRuntimeConfinementReady(input: {
  environment?: NodeJS.ProcessEnv;
  probe?: ProjectRuntimeConfinementHostProbe;
} = {}): ProjectRuntimeConfinementPolicy {
  const environment = input.environment || process.env;
  const policy = resolveProjectRuntimeConfinementPolicy(environment);
  const probe = input.probe || defaultHostProbe();

  assertRootOwnedRegularFile(
    PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
    PROJECT_RUNTIME_SECCOMP_PROFILE_SHA256,
    probe,
  );
  const dockerOptions = parseDockerSecurityOptions(probe.dockerSecurityOptions());
  if (!dockerOptions.some((entry) => /^name=seccomp(?:,|$)/.test(entry))) {
    fail('CONFINEMENT_SECCOMP_UNAVAILABLE', 'Docker does not report seccomp support for Project runtimes.');
  }

  let appArmorEnabled = '';
  try {
    appArmorEnabled = probe.readFile(APPARMOR_ENABLED_PATH).toString('utf8').trim();
  } catch {
    appArmorEnabled = '';
  }
  const dockerHasAppArmor = dockerOptions.some((entry) => entry === 'name=apparmor');

  if (policy === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY) {
    assertRootOwnedRegularFile(
      PROJECT_RUNTIME_APPARMOR_PROFILE_PATH,
      PROJECT_RUNTIME_APPARMOR_PROFILE_SHA256,
      probe,
    );
    if (appArmorEnabled !== 'Y' || !dockerHasAppArmor) {
      fail('CONFINEMENT_APPARMOR_UNAVAILABLE', 'AppArmor support disappeared from the Project runtime host.');
    }
    let loadedProfiles = '';
    try {
      loadedProfiles = probe.readFile(APPARMOR_LOADED_PROFILES_PATH).toString('utf8');
    } catch {
      fail('CONFINEMENT_APPARMOR_UNAVAILABLE', 'Loaded AppArmor policy state is unavailable.');
    }
    const expected = `${PROJECT_RUNTIME_APPARMOR_PROFILE} (enforce)`;
    if (!loadedProfiles!.split(/\r?\n/).includes(expected)) {
      fail('CONFINEMENT_APPARMOR_UNLOADED', 'The required Project runtime AppArmor profile is not loaded in enforce mode.');
    }
  } else if (appArmorEnabled === 'Y' || dockerHasAppArmor) {
    fail(
      'CONFINEMENT_POLICY_DOWNGRADE',
      'The host supports AppArmor but is configured for the unsupported-host Project runtime policy.',
    );
  }
  return policy;
}

export function assertCodexProjectRuntimeConfinementReady(input: {
  environment?: NodeJS.ProcessEnv;
  probe?: ProjectRuntimeConfinementHostProbe;
} = {}): ProjectRuntimeConfinementPolicy {
  const probe = input.probe || defaultHostProbe();
  const policy = assertProjectRuntimeConfinementReady({
    environment: input.environment,
    probe,
  });
  assertRootOwnedRegularFile(
    CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
    CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_SHA256,
    probe,
  );
  if (policy === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY) {
    assertRootOwnedRegularFile(
      CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_PATH,
      CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_SHA256,
      probe,
    );
    let loadedProfiles = '';
    try {
      loadedProfiles = probe.readFile(APPARMOR_LOADED_PROFILES_PATH).toString('utf8');
    } catch {
      fail('CONFINEMENT_APPARMOR_UNAVAILABLE', 'Loaded AppArmor policy state is unavailable.');
    }
    const expected = `${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE} (enforce)`;
    if (!loadedProfiles.split(/\r?\n/).includes(expected)) {
      fail(
        'CONFINEMENT_APPARMOR_UNLOADED',
        'The required Codex Project runtime AppArmor profile is not loaded in enforce mode.',
      );
    }
  }
  return policy;
}

/**
 * Production execution boundary. Jest exercises the host probe separately and
 * injects hostile verifiers into every provider path; unit fixtures must not
 * depend on the developer machine having installer-managed /etc state.
 */
export function assertProjectRuntimeConfinementReadyForExecution(): ProjectRuntimeConfinementPolicy {
  if (process.env.NODE_ENV === 'test') {
    return resolveProjectRuntimeConfinementPolicy();
  }
  return assertProjectRuntimeConfinementReady();
}

export function assertCodexProjectRuntimeConfinementReadyForExecution(): ProjectRuntimeConfinementPolicy {
  if (process.env.NODE_ENV === 'test') {
    return resolveProjectRuntimeConfinementPolicy();
  }
  return assertCodexProjectRuntimeConfinementReady();
}
