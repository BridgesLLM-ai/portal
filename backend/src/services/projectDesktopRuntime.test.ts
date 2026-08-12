import fs from 'fs';
import os from 'os';
import path from 'path';
import { managedDesktopSystemdRunArgs } from '../utils/desktopEnv';
import {
  LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT,
  PROJECT_DESKTOP_RUNTIME_ROOT,
  buildProjectDesktopRuntimeIdentity,
  ensureSecureProjectDesktopRuntimeRoot,
  managedProjectDesktopRuntimeDirectory,
  projectDesktopRuntimeAppState,
  projectDesktopRuntimeCleanupDirectories,
  quiesceProjectDesktopRuntimeForDependencyPromotion,
} from './projectDesktopRuntime';

describe('Project desktop runtime identity', () => {
  test('uses immutable project identity so same-named projects cannot collide', () => {
    const first = buildProjectDesktopRuntimeIdentity('11111111-1111-4111-8111-111111111111', 'Demo');
    const second = buildProjectDesktopRuntimeIdentity('22222222-2222-4222-8222-222222222222', 'Demo');
    expect(first.runtimeDir).not.toBe(second.runtimeDir);
    expect(first.processMarker).not.toBe(second.processMarker);
    expect(first.systemdUnit).not.toBe(second.systemdUnit);
    expect(first.windowTitle).toBe('Demo — BridgesLLM');
  });

  test('launches the whole process tree in an immutable KillMode cgroup', () => {
    const identity = buildProjectDesktopRuntimeIdentity(
      '11111111-1111-4111-8111-111111111111',
      'Demo',
    );
    const args = managedDesktopSystemdRunArgs(identity.systemdUnit, 'xterm -e true');
    expect(args).toEqual(expect.arrayContaining([
      '--property=User=bridgesrd',
      '--property=KillMode=control-group',
      '--service-type=exec',
      '--collect',
    ]));
    expect(args.slice(-3)).toEqual([
      '/bin/bash',
      '-c',
      expect.stringContaining('xterm -e true'),
    ]);
    expect(args).toContain('--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  });

  test('rejects path-like project identities', () => {
    expect(() => buildProjectDesktopRuntimeIdentity('../escape', 'Demo')).toThrow(/identity/i);
    expect(() => buildProjectDesktopRuntimeIdentity('bad/id', 'Demo')).toThrow(/identity/i);
  });

  test('accepts only exact one-level managed runtime directories', () => {
    expect(managedProjectDesktopRuntimeDirectory(path.join(PROJECT_DESKTOP_RUNTIME_ROOT, 'project-id')))
      .toBe(path.join(PROJECT_DESKTOP_RUNTIME_ROOT, 'project-id'));
    expect(managedProjectDesktopRuntimeDirectory(PROJECT_DESKTOP_RUNTIME_ROOT)).toBeNull();
    expect(managedProjectDesktopRuntimeDirectory('/home/bridgesrd')).toBeNull();
    expect(managedProjectDesktopRuntimeDirectory(path.join(PROJECT_DESKTOP_RUNTIME_ROOT, 'one', 'two'))).toBeNull();
  });

  test('cleans both immutable and legacy recorded runtime directories without duplicates', () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    expect(projectDesktopRuntimeCleanupDirectories({
      projectId,
      projectName: 'Demo',
      recordedRuntimeDir: path.join(PROJECT_DESKTOP_RUNTIME_ROOT, 'Demo'),
    })).toEqual([
      path.join(PROJECT_DESKTOP_RUNTIME_ROOT, projectId),
      path.join(PROJECT_DESKTOP_RUNTIME_ROOT, 'Demo'),
      path.join(LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT, 'Demo'),
      path.join(LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT, projectId),
    ]);
    expect(projectDesktopRuntimeCleanupDirectories({
      projectId,
      projectName: 'Demo',
      recordedRuntimeDir: path.join(PROJECT_DESKTOP_RUNTIME_ROOT, projectId),
    })).toEqual([
      path.join(PROJECT_DESKTOP_RUNTIME_ROOT, projectId),
      path.join(LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT, 'Demo'),
      path.join(LEGACY_PROJECT_DESKTOP_RUNTIME_ROOT, projectId),
    ]);
  });

  test('provisions and re-attests an existing server-owned runtime root', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-desktop-root-'));
    const runtimeRoot = path.join(temporaryRoot, 'owner', 'runtimes');
    try {
      expect(() => ensureSecureProjectDesktopRuntimeRoot(runtimeRoot)).not.toThrow();
      expect(() => ensureSecureProjectDesktopRuntimeRoot(runtimeRoot)).not.toThrow();
      expect(fs.lstatSync(runtimeRoot).mode & 0o777).toBe(0o755);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('rejects a symlink runtime root without changing its target', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-desktop-link-'));
    const ownerRoot = path.join(temporaryRoot, 'owner');
    const targetRoot = path.join(temporaryRoot, 'target');
    const runtimeRoot = path.join(ownerRoot, 'runtimes');
    try {
      fs.mkdirSync(ownerRoot);
      fs.mkdirSync(targetRoot, { mode: 0o700 });
      fs.symlinkSync(targetRoot, runtimeRoot, 'dir');
      expect(() => ensureSecureProjectDesktopRuntimeRoot(runtimeRoot)).toThrow();
      expect(fs.lstatSync(targetRoot).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('never reports a failed desktop launch as running', () => {
    expect(projectDesktopRuntimeAppState(null)).toEqual({ isActive: true, processStatus: 'running' });
    expect(projectDesktopRuntimeAppState('xterm failed')).toEqual({ isActive: false, processStatus: 'error' });
  });

  test('dependency recovery stops and verifies the exact desktop cgroup and process marker', () => {
    const processIds = jest.fn()
      .mockReturnValueOnce([101])
      .mockReturnValueOnce([101])
      .mockReturnValueOnce([]);
    const signalProcesses = jest.fn();
    const stopUnit = jest.fn();
    const result = quiesceProjectDesktopRuntimeForDependencyPromotion({
      projectIdentityId: '11111111-1111-4111-8111-111111111111',
      projectName: 'Demo',
    }, {
      processIds,
      signalProcesses,
      unitProperty: jest.fn((_unit, property) => ({
        LoadState: 'loaded',
        ActiveState: 'inactive',
        ControlGroup: '/system.slice/bridgesllm-project.service',
      }[property] || '')),
      stopUnit,
      resetFailedUnit: jest.fn(),
      cgroupHasProcesses: jest.fn(() => false),
    });
    expect(stopUnit).toHaveBeenCalledWith(
      'bridgesllm-project-11111111-1111-4111-8111-111111111111.service',
    );
    expect(signalProcesses).toHaveBeenNthCalledWith(1, [101], 'SIGTERM');
    expect(signalProcesses).toHaveBeenNthCalledWith(2, [101], 'SIGKILL');
    expect(result).toEqual({ systemdUnitStopped: true, processCount: 1 });
  });

  test('dependency recovery fails closed when an exact desktop process remains', () => {
    expect(() => quiesceProjectDesktopRuntimeForDependencyPromotion({
      projectIdentityId: '11111111-1111-4111-8111-111111111111',
      projectName: 'Demo',
    }, {
      processIds: jest.fn(() => [101]),
      signalProcesses: jest.fn(),
      unitProperty: jest.fn(() => 'not-found'),
      stopUnit: jest.fn(),
      resetFailedUnit: jest.fn(),
      cgroupHasProcesses: jest.fn(() => false),
    })).toThrow(/remained/i);
  });
});
