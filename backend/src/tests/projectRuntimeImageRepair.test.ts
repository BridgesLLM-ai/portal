process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';

const { spawnSync } = require('child_process') as typeof import('child_process');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');

const {
  __projectRuntimeImageRepairTest,
  __resetProjectRuntimeImageRepairForTests,
  getProjectRuntimeImageRepairStatus,
  launchProjectRuntimeImageRepair,
  PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
} = require('../services/projectRuntimeImageRepair') as typeof import('../services/projectRuntimeImageRepair');

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const logPathFactory = () => '/opt/bridgesllm/logs/project-runtime-image-repair-test.log';

describe('Project runtime image repair launcher', () => {
  beforeEach(() => __resetProjectRuntimeImageRepairForTests());

  it('returns an idempotent ready result without launching a host process', async () => {
    const execFileImpl = jest.fn().mockResolvedValue({ stdout: 'inactive\n' });
    await expect(launchProjectRuntimeImageRepair({
      imageReady: async () => true,
      execFileImpl,
      logPathFactory,
    })).resolves.toEqual({ state: 'ready', started: false });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(execFileImpl).toHaveBeenCalledWith(
      '/usr/bin/systemctl',
      expect.arrayContaining([
        'show',
        'bridgesllm-project-runtime-image-repair.service',
      ]),
      expect.any(Object),
    );
  });

  it('registers one fixed host service with an absolute trusted installer and no caller-controlled command', async () => {
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce({ stdout: 'inactive\n' })
      .mockResolvedValueOnce({ stdout: '' });
    await expect(launchProjectRuntimeImageRepair({
      imageReady: async () => false,
      execFileImpl,
      logPathFactory,
    })).resolves.toEqual({ state: 'running', started: true });

    expect(execFileImpl).toHaveBeenCalledTimes(2);
    const [file, args, options] = execFileImpl.mock.calls[1];
    expect(file).toBe('/usr/bin/systemd-run');
    expect(args).toEqual([
      '--unit=bridgesllm-project-runtime-image-repair',
      '--no-block',
      '--quiet',
      '--setenv=HOME=/root',
      '/usr/bin/python3',
      '-I',
      '-S',
      '/opt/bridgesllm/portal/installer/project-runtime-image-repair-launcher.py',
      '4.0.14',
      '/opt/bridgesllm/logs/project-runtime-image-repair-test.log',
    ]);
    expect(args).not.toContain('--collect');
    expect(args).not.toContain('/bin/bash');
    expect(args).not.toContain('-c');
    expect(__projectRuntimeImageRepairTest.INSTALLED_REPAIR_LAUNCHER).toBe(
      '/opt/bridgesllm/portal/installer/project-runtime-image-repair-launcher.py',
    );
    const launcherPath = path.resolve(
      __dirname,
      '../../../installer/project-runtime-image-repair-launcher.py',
    );
    const script = fs.readFileSync(launcherPath, 'utf8');
    expect(script).toContain(__projectRuntimeImageRepairTest.INSTALLED_REPAIR_SCRIPT);
    expect(script).toContain('INSTALLER_SIGNATURE_PATH = f"{INSTALLER_PATH}.sig"');
    expect(script).toContain('os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC');
    expect(script).toContain('os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC');
    expect(script).toContain('log_info.st_nlink != 1');
    expect(script).toContain('stat.S_IMODE(log_info.st_mode) != 0o600');
    expect(script).toContain('identity(current_log_info) != identity(log_info)');
    expect(script.indexOf('os.dup2(log_fd, 2)')).toBeLessThan(script.indexOf('installer_parts ='));
    expect(script).toContain('exact_size=64');
    expect(script).toContain('verify_installer_version(installer_fd, expected_version)');
    expect(script).toContain('def reattest_file(');
    expect(script.match(/reattest_file\(/g)).toHaveLength(4);
    expect(script.indexOf('verify_installer_signature(installer_fd, signature_fd)'))
      .toBeLessThan(script.indexOf('        reattest_file('));
    expect(script.lastIndexOf('reattest_file('))
      .toBeLessThan(script.indexOf('os.set_inheritable(installer_fd, True)'));
    expect(script).toContain('os.set_inheritable(installer_fd, True)');
    expect(script).toContain('f"/proc/self/fd/{installer_fd}"');
    expect(script).toContain('"--repair-project-runtime-image"');
    expect(script).toContain('EXECUTION_ENVIRONMENT,');
    expect(script).not.toContain('os.environ');
    const syntax = spawnSync('/usr/bin/python3', [
      '-I',
      '-c',
      'import ast, sys; ast.parse(sys.stdin.read())',
    ], {
      input: script,
      encoding: 'utf8',
    });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe('');
    expect(options).toEqual(expect.objectContaining({ timeout: 10_000, maxBuffer: 64 * 1024 }));
  });

  it('closes the registration race and adopts an already-running fixed unit', async () => {
    const gate = deferred<{ stdout: string }>();
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce({ stdout: 'inactive\n' })
      .mockReturnValueOnce(gate.promise);
    const dependencies = {
      imageReady: async () => false,
      execFileImpl,
      logPathFactory,
    };

    const first = launchProjectRuntimeImageRepair(dependencies);
    await expect(launchProjectRuntimeImageRepair(dependencies)).resolves.toEqual({
      state: 'running',
      started: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    gate.resolve({ stdout: '' });
    await expect(first).resolves.toEqual({ state: 'running', started: true });

    const duplicateExec = jest.fn()
      .mockResolvedValueOnce({ stdout: 'active\n' });
    await expect(launchProjectRuntimeImageRepair({
      ...dependencies,
      execFileImpl: duplicateExec,
    })).resolves.toEqual({ state: 'running', started: false });
    expect(duplicateExec.mock.calls[0]?.[0]).toBe('/usr/bin/systemctl');
    expect(duplicateExec.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      'show',
      'bridgesllm-project-runtime-image-repair.service',
    ]));
  });

  it('retains failed-unit diagnostics, resets the fixed unit, and retries exactly once', async () => {
    const duplicateUnit = Object.assign(new Error('registration failed'), {
      stderr: 'Unit bridgesllm-project-runtime-image-repair.service already exists.',
    });
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce({ stdout: 'failed\n' })
      .mockRejectedValueOnce(duplicateUnit)
      .mockResolvedValueOnce({ stdout: 'failed\n' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' });

    await expect(launchProjectRuntimeImageRepair({
      imageReady: async () => false,
      execFileImpl,
      logPathFactory,
      allowFailedRetry: true,
    })).resolves.toEqual({ state: 'running', started: true });

    expect(execFileImpl).toHaveBeenCalledTimes(5);
    expect(execFileImpl.mock.calls[3]?.slice(0, 2)).toEqual([
      '/usr/bin/systemctl',
      ['reset-failed', 'bridgesllm-project-runtime-image-repair.service'],
    ]);
    expect(execFileImpl.mock.calls[4]?.[0]).toBe('/usr/bin/systemd-run');
    expect(execFileImpl.mock.calls[4]?.[1]).toEqual(execFileImpl.mock.calls[1]?.[1]);
  });

  it('does not reset a failed unit unless the serialized route preflight authorized it', async () => {
    const execFileImpl = jest.fn().mockResolvedValueOnce({ stdout: 'failed\n' });

    await expect(launchProjectRuntimeImageRepair({
      imageReady: async () => false,
      execFileImpl,
      logPathFactory,
    })).rejects.toMatchObject({
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
      statusCode: 409,
    });

    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(execFileImpl).not.toHaveBeenCalledWith(
      '/usr/bin/systemctl',
      expect.arrayContaining(['reset-failed']),
      expect.anything(),
    );
  });

  it('does not reset a unit that fails between the route preflight and registration', async () => {
    const duplicateUnit = Object.assign(new Error('registration failed'), {
      stderr: 'Unit bridgesllm-project-runtime-image-repair.service already exists.',
    });
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce({ stdout: 'inactive\n' })
      .mockRejectedValueOnce(duplicateUnit)
      .mockResolvedValueOnce({ stdout: 'failed\n' });

    await expect(launchProjectRuntimeImageRepair({
      imageReady: async () => false,
      execFileImpl,
      logPathFactory,
    })).rejects.toMatchObject({
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
      statusCode: 409,
    });

    expect(execFileImpl).toHaveBeenCalledTimes(3);
    expect(execFileImpl).not.toHaveBeenCalledWith(
      '/usr/bin/systemctl',
      expect.arrayContaining(['reset-failed']),
      expect.anything(),
    );
  });

  it('adopts a unit that became active after the registration response timed out', async () => {
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce({ stdout: 'inactive\n' })
      .mockRejectedValueOnce(Object.assign(new Error('registration timed out'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ stdout: 'active\n' });

    await expect(launchProjectRuntimeImageRepair({
      imageReady: async () => false,
      execFileImpl,
      logPathFactory,
    })).resolves.toEqual({ state: 'running', started: true });

    expect(execFileImpl).toHaveBeenCalledTimes(3);
  });

  it('recognizes a first registration that completed before its timeout was reconciled', async () => {
    const imageReady = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce({ stdout: 'inactive\n' })
      .mockRejectedValueOnce(Object.assign(new Error('registration timed out'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ stdout: 'inactive\n' });

    await expect(launchProjectRuntimeImageRepair({
      imageReady,
      execFileImpl,
      logPathFactory,
    })).resolves.toEqual({ state: 'ready', started: true });

    expect(imageReady).toHaveBeenCalledTimes(2);
  });

  it('adopts the authorized retry when its registration response is lost', async () => {
    const duplicateUnit = Object.assign(new Error('registration failed'), {
      stderr: 'Unit bridgesllm-project-runtime-image-repair.service already exists.',
    });
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce({ stdout: 'failed\n' })
      .mockRejectedValueOnce(duplicateUnit)
      .mockResolvedValueOnce({ stdout: 'failed\n' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(Object.assign(new Error('retry timed out'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ stdout: 'active\n' });

    await expect(launchProjectRuntimeImageRepair({
      imageReady: async () => false,
      execFileImpl,
      logPathFactory,
      allowFailedRetry: true,
    })).resolves.toEqual({ state: 'running', started: true });

    expect(execFileImpl).toHaveBeenCalledTimes(6);
  });

  it('recognizes an authorized retry that completed before its timeout was reconciled', async () => {
    const duplicateUnit = Object.assign(new Error('registration failed'), {
      stderr: 'Unit bridgesllm-project-runtime-image-repair.service already exists.',
    });
    const imageReady = jest.fn().mockResolvedValueOnce(true);
    const execFileImpl = jest.fn()
      .mockResolvedValueOnce({ stdout: 'failed\n' })
      .mockRejectedValueOnce(duplicateUnit)
      .mockResolvedValueOnce({ stdout: 'failed\n' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValueOnce(Object.assign(new Error('retry timed out'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ stdout: 'inactive\n' });

    await expect(launchProjectRuntimeImageRepair({
      imageReady,
      execFileImpl,
      logPathFactory,
      allowFailedRetry: true,
    })).resolves.toEqual({ state: 'ready', started: true });

    expect(imageReady).toHaveBeenCalledTimes(1);
  });

  it('keeps launch diagnostics private', async () => {
    await expect(launchProjectRuntimeImageRepair({
      imageReady: async () => false,
      execFileImpl: jest.fn()
        .mockResolvedValueOnce({ stdout: 'inactive\n' })
        .mockRejectedValueOnce(Object.assign(new Error('secret token'), {
          stderr: 'private host traceback',
        }))
        .mockResolvedValueOnce({ stdout: 'inactive\n' }),
      logPathFactory,
    })).rejects.toMatchObject({
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_LAUNCH_FAILED',
      statusCode: 500,
      message: expect.not.stringMatching(/secret|traceback/i),
    });
  });

  it('fails closed when fixed-unit ownership cannot be read', async () => {
    const imageReady = jest.fn(async () => true);
    const execFileImpl = jest.fn().mockRejectedValue(new Error('systemd bus timed out'));

    await expect(getProjectRuntimeImageRepairStatus({
      imageReady,
      execFileImpl,
    })).resolves.toMatchObject({
      state: 'unavailable',
      unavailableReason: 'unit-state-unknown',
    });
    expect(imageReady).not.toHaveBeenCalled();

    await expect(launchProjectRuntimeImageRepair({
      imageReady,
      execFileImpl,
      logPathFactory,
    })).rejects.toMatchObject({
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
      statusCode: 409,
    });
    expect(imageReady).not.toHaveBeenCalled();
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it('treats only an explicit never-loaded fixed unit as an idle lane', async () => {
    const missingUnit = Object.assign(new Error(
      'Unit bridgesllm-project-runtime-image-repair.service could not be found.',
    ), { stderr: 'Unit bridgesllm-project-runtime-image-repair.service could not be found.' });
    const imageReady = jest.fn(async () => true);

    await expect(getProjectRuntimeImageRepairStatus({
      imageReady,
      execFileImpl: jest.fn().mockRejectedValue(missingUnit),
    })).resolves.toMatchObject({ state: 'ready' });
    expect(imageReady).toHaveBeenCalledTimes(1);
  });

  it('uses one bounded image inspection and distinguishes absence from Docker failure', async () => {
    const imageId = `sha256:${'a'.repeat(64)}`;
    const readyExec = jest.fn()
      .mockResolvedValueOnce({ stdout: 'inactive\n' })
      .mockResolvedValueOnce({ stdout: `${imageId}\n` });
    await expect(getProjectRuntimeImageRepairStatus({
      execFileImpl: readyExec,
    })).resolves.toMatchObject({ state: 'ready' });
    expect(readyExec.mock.calls[1]).toEqual([
      '/usr/bin/docker',
      ['image', 'inspect', '--format', '{{.Id}}', expect.any(String)],
      expect.objectContaining({ timeout: 5_000, maxBuffer: 16 * 1024 }),
    ]);

    const missingExec = jest.fn()
      .mockResolvedValueOnce({ stdout: 'inactive\n' })
      .mockRejectedValueOnce(Object.assign(new Error('Docker image inspection failed'), {
        code: 1,
        stderr: 'Error response from daemon: No such image: hidden-image-id',
      }));
    await expect(getProjectRuntimeImageRepairStatus({
      execFileImpl: missingExec,
    })).resolves.toMatchObject({
      state: 'unavailable',
      unavailableReason: 'image-missing',
    });

    for (const dockerFailure of [
      Object.assign(new Error('Docker inspection timed out'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('Docker daemon unavailable'), { stderr: 'Cannot connect to the Docker daemon' }),
      null,
    ]) {
      const unknownExec = jest.fn()
        .mockResolvedValueOnce({ stdout: 'inactive\n' });
      if (dockerFailure) unknownExec.mockRejectedValueOnce(dockerFailure);
      else unknownExec.mockResolvedValueOnce({ stdout: 'not-an-image-id\n' });
      await expect(getProjectRuntimeImageRepairStatus({
        execFileImpl: unknownExec,
      })).resolves.toMatchObject({
        state: 'unavailable',
        unavailableReason: 'image-state-unknown',
      });
    }
  });

  it('reports ready, running, failed, and unavailable without exposing image IDs', async () => {
    await expect(getProjectRuntimeImageRepairStatus({
      imageReady: async () => true,
      execFileImpl: jest.fn().mockResolvedValue({ stdout: 'inactive\n' }),
    })).resolves.toEqual({
      state: 'ready',
      confirmationPhrase: PROJECT_RUNTIME_IMAGE_REPAIR_CONFIRMATION,
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });

    for (const [activeState, expected] of [
      ['active', 'running'],
      ['failed', 'failed'],
      ['inactive', 'unavailable'],
    ] as const) {
      const status = await getProjectRuntimeImageRepairStatus({
        imageReady: async () => false,
        execFileImpl: jest.fn().mockResolvedValue({ stdout: `${activeState}\n` }),
      });
      expect(status.state).toBe(expected);
      if (activeState === 'inactive') {
        expect(status.unavailableReason).toBe('image-missing');
      }
      expect(JSON.stringify(status)).not.toContain('sha256:');
    }

    for (const [activeState, expected] of [
      ['active', 'running'],
      ['failed', 'failed'],
    ] as const) {
      const status = await getProjectRuntimeImageRepairStatus({
        imageReady: async () => true,
        execFileImpl: jest.fn().mockResolvedValue({ stdout: `${activeState}\n` }),
      });
      expect(status.state).toBe(expected);
    }
  });

  it('keeps an unreadable Docker image state indeterminate and never launches repair', async () => {
    const statusExec = jest.fn().mockResolvedValue({ stdout: 'inactive\n' });
    await expect(getProjectRuntimeImageRepairStatus({
      imageReadiness: async () => 'unknown',
      execFileImpl: statusExec,
    })).resolves.toMatchObject({
      state: 'unavailable',
      unavailableReason: 'image-state-unknown',
    });

    const launchExec = jest.fn().mockResolvedValue({ stdout: 'inactive\n' });
    await expect(launchProjectRuntimeImageRepair({
      imageReadiness: async () => 'unknown',
      execFileImpl: launchExec,
      logPathFactory,
    })).rejects.toMatchObject({
      code: 'PROJECT_RUNTIME_IMAGE_REPAIR_BUSY',
      statusCode: 409,
    });
    expect(launchExec).toHaveBeenCalledTimes(1);
    expect(launchExec).not.toHaveBeenCalledWith(
      '/usr/bin/systemd-run',
      expect.anything(),
      expect.anything(),
    );
  });
});
