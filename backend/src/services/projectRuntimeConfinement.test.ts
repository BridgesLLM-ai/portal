import fs from 'fs';
import path from 'path';
import {
  CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE,
  CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_PATH,
  CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
  PROJECT_RUNTIME_APPARMOR_PROFILE,
  PROJECT_RUNTIME_APPARMOR_PROFILE_PATH,
  PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
  PROJECT_RUNTIME_SECCOMP_ONLY_POLICY,
  PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
  assertCodexProjectRuntimeConfinementReady,
  assertProjectRuntimeConfinementReady,
  attestCodexProjectRuntimeSecurityOptions,
  attestPreConfinementProjectRuntimeSecurityOptions,
  attestProjectRuntimeSecurityOptions,
  codexProjectRuntimeSecurityOptArgs,
  projectRuntimeSecurityOptArgs,
  resolveProjectRuntimeConfinementPolicy,
  type ProjectRuntimeConfinementHostProbe,
} from './projectRuntimeConfinement';

function metadata(mode = 0o100644): fs.Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    gid: 0,
    nlink: 1,
    mode,
  } as fs.Stats;
}

function fixture(policy = PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY): {
  environment: NodeJS.ProcessEnv;
  files: Map<string, Buffer>;
  stats: Map<string, fs.Stats>;
  probe: ProjectRuntimeConfinementHostProbe;
} {
  const installerRoot = path.resolve(__dirname, '../../../installer');
  const files = new Map<string, Buffer>([
    [
      PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
      fs.readFileSync(path.join(installerRoot, 'bridgesllm-project-runtime-v1.seccomp.json')),
    ],
    [
      PROJECT_RUNTIME_APPARMOR_PROFILE_PATH,
      fs.readFileSync(path.join(installerRoot, 'bridgesllm-project-runtime-v1.apparmor')),
    ],
    [
      CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
      fs.readFileSync(path.join(installerRoot, 'bridgesllm-codex-project-runtime-v1.seccomp.json')),
    ],
    [
      CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_PATH,
      fs.readFileSync(path.join(installerRoot, 'bridgesllm-codex-project-runtime-v1.apparmor')),
    ],
    ['/sys/module/apparmor/parameters/enabled', Buffer.from(policy === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY ? 'Y\n' : 'N\n')],
    ['/sys/kernel/security/apparmor/profiles', Buffer.from(
      `${PROJECT_RUNTIME_APPARMOR_PROFILE} (enforce)\n`
      + `${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE} (enforce)\n`,
    )],
  ]);
  const stats = new Map<string, fs.Stats>([
    [PROJECT_RUNTIME_SECCOMP_PROFILE_PATH, metadata()],
    [PROJECT_RUNTIME_APPARMOR_PROFILE_PATH, metadata()],
    [CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH, metadata()],
    [CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_PATH, metadata()],
  ]);
  const probe: ProjectRuntimeConfinementHostProbe = {
    readFile: (filePath) => {
      const value = files.get(filePath);
      if (!value) throw new Error('missing');
      return value;
    },
    lstat: (filePath) => {
      const value = stats.get(filePath);
      if (!value) throw new Error('missing');
      return value;
    },
    realpath: (filePath) => filePath,
    dockerSecurityOptions: () => JSON.stringify(
      policy === PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY
        ? ['name=apparmor', 'name=seccomp,profile=builtin']
        : ['name=seccomp,profile=builtin'],
    ),
  };
  return {
    environment: { NODE_ENV: 'production', PROJECT_RUNTIME_CONFINEMENT_POLICY: policy },
    files,
    stats,
    probe,
  };
}

test('production requires an installer-owned explicit policy', () => {
  expect(() => resolveProjectRuntimeConfinementPolicy({ NODE_ENV: 'production' })).toThrow(
    expect.objectContaining({ code: 'CONFINEMENT_POLICY' }),
  );
});

test('the operator-disabled policy fails closed with a distinct truthful reason', () => {
  const environment = {
    NODE_ENV: 'production',
    PROJECT_RUNTIME_CONFINEMENT_POLICY: 'project-runtimes-disabled-v1',
  };
  expect(() => resolveProjectRuntimeConfinementPolicy(environment)).toThrow(
    expect.objectContaining({ code: 'CONFINEMENT_DISABLED' }),
  );
  expect(() => resolveProjectRuntimeConfinementPolicy(environment)).toThrow(
    /--skip-project-runtimes/,
  );
  // The disabled policy is never admitted in test bypasses either.
  expect(() => resolveProjectRuntimeConfinementPolicy({
    NODE_ENV: 'test',
    PROJECT_RUNTIME_CONFINEMENT_POLICY: 'project-runtimes-disabled-v1',
  })).toThrow(expect.objectContaining({ code: 'CONFINEMENT_DISABLED' }));
});

test('builds exact explicit Docker security options', () => {
  expect(projectRuntimeSecurityOptArgs(PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY)).toEqual([
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
    '--security-opt', `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
  ]);
  expect(projectRuntimeSecurityOptArgs(PROJECT_RUNTIME_SECCOMP_ONLY_POLICY)).toEqual([
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
  ]);
  expect(codexProjectRuntimeSecurityOptArgs(PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY)).toEqual([
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
    '--security-opt', `apparmor=${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE}`,
  ]);
  expect(codexProjectRuntimeSecurityOptArgs(PROJECT_RUNTIME_SECCOMP_ONLY_POLICY)).toEqual([
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
  ]);
});

test('keeps the Codex confinement identity separate from the shared runtime identity', () => {
  const value = fixture();
  const codexProfile = value.files.get(CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH);
  const sharedProfile = value.files.get(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH);
  expect(codexProfile).toBeDefined();
  expect(sharedProfile).toBeDefined();
  const codexInline = JSON.stringify(JSON.parse(codexProfile!.toString('utf8')));
  const sharedInline = JSON.stringify(JSON.parse(sharedProfile!.toString('utf8')));

  expect(() => attestCodexProjectRuntimeSecurityOptions({
    securityOpt: [
      `apparmor=${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      'no-new-privileges:true',
      `seccomp=${codexInline}`,
    ],
    appArmorProfile: CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE,
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
    profileProbe: value.probe,
  })).not.toThrow();
  expect(() => attestCodexProjectRuntimeSecurityOptions({
    securityOpt: [
      `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      'no-new-privileges:true',
      `seccomp=${sharedInline}`,
    ],
    appArmorProfile: PROJECT_RUNTIME_APPARMOR_PROFILE,
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
    profileProbe: value.probe,
  })).toThrow(expect.objectContaining({ code: 'CONFINEMENT_SECURITY_OPT' }));
  expect(() => attestProjectRuntimeSecurityOptions({
    securityOpt: [
      `apparmor=${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      'no-new-privileges:true',
      `seccomp=${codexInline}`,
    ],
    appArmorProfile: CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE,
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
    profileProbe: value.probe,
  })).toThrow(expect.objectContaining({ code: 'CONFINEMENT_SECURITY_OPT' }));
});

test.each([
  ['profile substitution', (value: ReturnType<typeof fixture>) => {
    value.files.set(
      CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH,
      value.files.get(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH)!,
    );
  }, 'CONFINEMENT_FILE_DIGEST'],
  ['unsafe metadata', (value: ReturnType<typeof fixture>) => {
    value.stats.set(CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH, metadata(0o100666));
  }, 'CONFINEMENT_FILE_METADATA'],
  ['duplicate seccomp option', (
    _value: ReturnType<typeof fixture>,
    inline: string,
    options: string[],
  ) => {
    options.push(`seccomp=${inline}`);
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['wrong inline JSON', (
    value: ReturnType<typeof fixture>,
    _inline: string,
    options: string[],
  ) => {
    const shared = value.files.get(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH)!;
    options[1] = `seccomp=${JSON.stringify(JSON.parse(shared.toString('utf8')))}`;
  }, 'CONFINEMENT_SECURITY_OPT'],
] as const)('fails closed for Codex confinement %s', (_label, mutate, code) => {
  const value = fixture();
  const profile = value.files.get(CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH);
  expect(profile).toBeDefined();
  const inline = JSON.stringify(JSON.parse(profile!.toString('utf8')));
  const securityOpt = [
    `apparmor=${CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE}`,
    `seccomp=${inline}`,
    'no-new-privileges:true',
  ];
  mutate(value, inline, securityOpt);
  expect(() => attestCodexProjectRuntimeSecurityOptions({
    securityOpt,
    appArmorProfile: CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE,
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
    profileProbe: value.probe,
  })).toThrow(expect.objectContaining({ code }));
});

test('attests the exact HostConfig security options and AppArmor identity', () => {
  expect(() => attestProjectRuntimeSecurityOptions({
    securityOpt: [
      `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      'no-new-privileges:true',
      `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
    ],
    appArmorProfile: PROJECT_RUNTIME_APPARMOR_PROFILE,
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
  })).not.toThrow();
  expect(() => attestProjectRuntimeSecurityOptions({
    securityOpt: ['no-new-privileges:true', `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`],
    appArmorProfile: '',
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
  })).toThrow(expect.objectContaining({ code: 'CONFINEMENT_SECURITY_OPT' }));
});

test('rejects a path-form seccomp inspection outside the pure unit-fixture contract', () => {
  const value = fixture();
  expect(() => attestProjectRuntimeSecurityOptions({
    securityOpt: [
      `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      'no-new-privileges:true',
      `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
    ],
    appArmorProfile: PROJECT_RUNTIME_APPARMOR_PROFILE,
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
    profileProbe: value.probe,
  })).toThrow(expect.objectContaining({ code: 'CONFINEMENT_SECURITY_OPT' }));
});

test('attests Docker inline seccomp inspect output against the exact installed profile', () => {
  const value = fixture();
  const profile = value.files.get(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH);
  expect(profile).toBeDefined();
  const dockerInlineProfile = JSON.stringify(JSON.parse(profile!.toString('utf8')));

  expect(() => attestProjectRuntimeSecurityOptions({
    securityOpt: [
      `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      'no-new-privileges:true',
      `seccomp=${dockerInlineProfile}`,
    ],
    appArmorProfile: PROJECT_RUNTIME_APPARMOR_PROFILE,
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
    profileProbe: value.probe,
  })).not.toThrow();
});

test('seccomp-only attestation requires an explicit empty AppArmor inspection value', () => {
  const value = fixture(PROJECT_RUNTIME_SECCOMP_ONLY_POLICY);
  const profile = value.files.get(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH);
  expect(profile).toBeDefined();
  const securityOpt = [
    'no-new-privileges:true',
    `seccomp=${JSON.stringify(JSON.parse(profile!.toString('utf8')))}`,
  ];
  expect(() => attestProjectRuntimeSecurityOptions({
    securityOpt,
    appArmorProfile: '',
    policy: PROJECT_RUNTIME_SECCOMP_ONLY_POLICY,
    profileProbe: value.probe,
  })).not.toThrow();
  expect(() => attestProjectRuntimeSecurityOptions({
    securityOpt,
    appArmorProfile: undefined,
    policy: PROJECT_RUNTIME_SECCOMP_ONLY_POLICY,
    profileProbe: value.probe,
  })).toThrow(expect.objectContaining({ code: 'CONFINEMENT_APPARMOR_POLICY' }));
});

test.each([
  ['changed installed profile', (value: ReturnType<typeof fixture>, inline: string) => {
    value.files.set(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH, Buffer.from(`${inline}\n`));
  }, 'CONFINEMENT_FILE_DIGEST'],
  ['unsafe installed profile metadata', (value: ReturnType<typeof fixture>) => {
    value.stats.set(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH, metadata(0o100666));
  }, 'CONFINEMENT_FILE_METADATA'],
  ['missing installed profile', (value: ReturnType<typeof fixture>) => {
    value.files.delete(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH);
  }, 'CONFINEMENT_FILE_MISSING'],
  ['reordered inline profile', (_value: ReturnType<typeof fixture>, inline: string, options: string[]) => {
    const parsed = JSON.parse(inline) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    options[1] = `seccomp=${JSON.stringify(reversed)}`;
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['semantically changed inline profile', (_value: ReturnType<typeof fixture>, inline: string, options: string[]) => {
    const parsed = JSON.parse(inline) as Record<string, unknown>;
    options[1] = `seccomp=${JSON.stringify({ ...parsed, defaultAction: 'SCMP_ACT_ALLOW' })}`;
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['malformed inline profile', (_value: ReturnType<typeof fixture>, _inline: string, options: string[]) => {
    options[1] = 'seccomp={"defaultAction":';
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['duplicate JSON key', (_value: ReturnType<typeof fixture>, inline: string, options: string[]) => {
    options[1] = `seccomp={"defaultAction":"SCMP_ACT_ALLOW",${inline.slice(1)}`;
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['duplicate seccomp option', (_value: ReturnType<typeof fixture>, inline: string, options: string[]) => {
    options.push(`seccomp=${inline}`);
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['unconfined seccomp option', (_value: ReturnType<typeof fixture>, _inline: string, options: string[]) => {
    options[1] = 'seccomp=unconfined';
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['non-canonical no-new-privileges', (_value: ReturnType<typeof fixture>, _inline: string, options: string[]) => {
    options[2] = 'NO_NEW_PRIVILEGES!!!true';
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['shorthand no-new-privileges', (_value: ReturnType<typeof fixture>, _inline: string, options: string[]) => {
    options[2] = 'no-new-privileges';
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['whitespace-padded no-new-privileges', (_value: ReturnType<typeof fixture>, _inline: string, options: string[]) => {
    options[2] = ' no-new-privileges:true ';
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['duplicate no-new-privileges', (_value: ReturnType<typeof fixture>, _inline: string, options: string[]) => {
    options.push('no-new-privileges:true');
  }, 'CONFINEMENT_SECURITY_OPT'],
  ['wrong AppArmor option', (_value: ReturnType<typeof fixture>, _inline: string, options: string[]) => {
    options[0] = 'apparmor=unconfined';
  }, 'CONFINEMENT_SECURITY_OPT'],
] as const)('fails closed for Docker inline seccomp output with %s', (
  _label,
  mutate,
  code,
) => {
  const value = fixture();
  const profile = value.files.get(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH);
  expect(profile).toBeDefined();
  const inline = JSON.stringify(JSON.parse(profile!.toString('utf8')));
  const securityOpt = [
    `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
    `seccomp=${inline}`,
    'no-new-privileges:true',
  ];
  mutate(value, inline, securityOpt);
  expect(() => attestProjectRuntimeSecurityOptions({
    securityOpt,
    appArmorProfile: PROJECT_RUNTIME_APPARMOR_PROFILE,
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
    profileProbe: value.probe,
  })).toThrow(expect.objectContaining({ code }));
});

test('accepts only the exact retirement-only pre-confinement Docker posture', () => {
  expect(() => attestPreConfinementProjectRuntimeSecurityOptions({
    securityOpt: ['no-new-privileges:true'],
    appArmorProfile: 'docker-default',
    policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
  })).not.toThrow();
  expect(() => attestPreConfinementProjectRuntimeSecurityOptions({
    securityOpt: ['no-new-privileges:true'],
    appArmorProfile: '',
    policy: PROJECT_RUNTIME_SECCOMP_ONLY_POLICY,
  })).not.toThrow();
  const hostileInputs: Array<Parameters<
  typeof attestPreConfinementProjectRuntimeSecurityOptions
  >[0]> = [
    {
      securityOpt: ['no-new-privileges:true', 'seccomp=unconfined'],
      appArmorProfile: 'docker-default',
    },
    {
      securityOpt: ['no-new-privileges:true'],
      appArmorProfile: 'unconfined',
    },
    {
      securityOpt: [
        'no-new-privileges:true',
        `seccomp=${PROJECT_RUNTIME_SECCOMP_PROFILE_PATH}`,
        `apparmor=${PROJECT_RUNTIME_APPARMOR_PROFILE}`,
      ],
      appArmorProfile: PROJECT_RUNTIME_APPARMOR_PROFILE,
      policy: PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY,
    },
    {
      securityOpt: ['no-new-privileges:true'],
      appArmorProfile: 'docker-default',
      policy: PROJECT_RUNTIME_SECCOMP_ONLY_POLICY,
    },
  ];
  for (const hostile of hostileInputs) {
    expect(() => attestPreConfinementProjectRuntimeSecurityOptions(hostile))
      .toThrow(expect.objectContaining({ code: 'CONFINEMENT_PREVIOUS_GENERATION' }));
  }
});

test('accepts an exact loaded supported-host profile', () => {
  const value = fixture();
  expect(assertProjectRuntimeConfinementReady(value)).toBe(PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY);
  expect(assertCodexProjectRuntimeConfinementReady(value))
    .toBe(PROJECT_RUNTIME_APPARMOR_SECCOMP_POLICY);
});

test.each([
  ['missing Codex seccomp', (value: ReturnType<typeof fixture>) => {
    value.files.delete(CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH);
  }, 'CONFINEMENT_FILE_MISSING'],
  ['changed Codex seccomp', (value: ReturnType<typeof fixture>) => {
    value.files.set(CODEX_PROJECT_RUNTIME_SECCOMP_PROFILE_PATH, Buffer.from('changed'));
  }, 'CONFINEMENT_FILE_DIGEST'],
  ['unsafe Codex AppArmor metadata', (value: ReturnType<typeof fixture>) => {
    value.stats.set(CODEX_PROJECT_RUNTIME_APPARMOR_PROFILE_PATH, metadata(0o100666));
  }, 'CONFINEMENT_FILE_METADATA'],
  ['unloaded Codex AppArmor', (value: ReturnType<typeof fixture>) => {
    value.files.set(
      '/sys/kernel/security/apparmor/profiles',
      Buffer.from(`${PROJECT_RUNTIME_APPARMOR_PROFILE} (enforce)\n`),
    );
  }, 'CONFINEMENT_APPARMOR_UNLOADED'],
] as const)('Codex host preflight fails closed for %s', (_label, mutate, code) => {
  const value = fixture();
  mutate(value);
  expect(() => assertCodexProjectRuntimeConfinementReady(value))
    .toThrow(expect.objectContaining({ code }));
});

test.each([
  ['missing seccomp', (value: ReturnType<typeof fixture>) => value.files.delete(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH), 'CONFINEMENT_FILE_MISSING'],
  ['changed seccomp', (value: ReturnType<typeof fixture>) => value.files.set(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH, Buffer.from('changed')), 'CONFINEMENT_FILE_DIGEST'],
  ['unsafe mode', (value: ReturnType<typeof fixture>) => value.stats.set(PROJECT_RUNTIME_SECCOMP_PROFILE_PATH, metadata(0o100666)), 'CONFINEMENT_FILE_METADATA'],
  ['unloaded AppArmor', (value: ReturnType<typeof fixture>) => value.files.set('/sys/kernel/security/apparmor/profiles', Buffer.from('docker-default (enforce)\n')), 'CONFINEMENT_APPARMOR_UNLOADED'],
  ['Docker lost AppArmor', (value: ReturnType<typeof fixture>) => { value.probe.dockerSecurityOptions = () => JSON.stringify(['name=seccomp,profile=builtin']); }, 'CONFINEMENT_APPARMOR_UNAVAILABLE'],
  ['Docker lost seccomp', (value: ReturnType<typeof fixture>) => { value.probe.dockerSecurityOptions = () => JSON.stringify(['name=apparmor']); }, 'CONFINEMENT_SECCOMP_UNAVAILABLE'],
] as const)('fails closed for %s', (_label, mutate, code) => {
  const value = fixture();
  mutate(value);
  expect(() => assertProjectRuntimeConfinementReady(value)).toThrow(expect.objectContaining({ code }));
});

test('seccomp-only policy is accepted only when AppArmor is genuinely unsupported', () => {
  const value = fixture(PROJECT_RUNTIME_SECCOMP_ONLY_POLICY);
  expect(assertProjectRuntimeConfinementReady(value)).toBe(PROJECT_RUNTIME_SECCOMP_ONLY_POLICY);
  value.files.set('/sys/module/apparmor/parameters/enabled', Buffer.from('Y\n'));
  expect(() => assertProjectRuntimeConfinementReady(value)).toThrow(
    expect.objectContaining({ code: 'CONFINEMENT_POLICY_DOWNGRADE' }),
  );
});
