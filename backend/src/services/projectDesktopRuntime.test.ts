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
});
