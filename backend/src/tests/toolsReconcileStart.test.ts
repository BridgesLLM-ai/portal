import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultToolsPaths, startToolsReconcileAtPortalStart } from '../services/toolsStatus';

describe('startToolsReconcileAtPortalStart', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-reconcile-start-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function paths(withUnit: boolean) {
    const toolctl = path.join(root, 'bridgesllm-toolctl.py');
    const unit = path.join(root, 'bridgesllm-tools@.service');
    fs.writeFileSync(toolctl, '# toolctl\n');
    if (withUnit) fs.writeFileSync(unit, '[Service]\n');
    return defaultToolsPaths({ BRIDGESLLM_TOOLCTL: toolctl, BRIDGESLLM_TOOLS_UNIT: unit });
  }

  it('starts the reconcile unit without blocking when the runner is installed', () => {
    const calls: string[][] = [];
    const started = startToolsReconcileAtPortalStart(paths(true), (args, done) => {
      calls.push(args);
      done(null);
    });
    expect(started).toBe(true);
    expect(calls).toEqual([['start', '--no-block', 'bridgesllm-tools-reconcile.service']]);
  });

  it('does nothing on a host without the runner unit', () => {
    const calls: string[][] = [];
    const started = startToolsReconcileAtPortalStart(paths(false), (args, done) => {
      calls.push(args);
      done(null);
    });
    expect(started).toBe(false);
    expect(calls).toEqual([]);
  });

  it('only warns when systemd refuses the start', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(startToolsReconcileAtPortalStart(paths(true), (_args, done) => done(new Error('Unit not found')))).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('start-up reconcile could not be started: Unit not found'));
    } finally {
      warn.mockRestore();
    }
  });
});
