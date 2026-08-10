import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  __projectSessionProjectionTest,
  writeProjectSessionProjectionBestEffort,
} from './projectSessionProjection';
import { PROJECT_RUNTIME_GID, PROJECT_RUNTIME_UID } from './projectRuntimeIdentity';

describe('legacy Project session projection', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-session-projection-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('repairs malformed project-writable JSON without failing the admitted operation', () => {
    fs.writeFileSync(path.join(projectRoot, '.agent-session.json'), '{broken', 'utf8');
    const warnings: string[] = [];

    expect(writeProjectSessionProjectionBestEffort(projectRoot, {
      initialized: true,
      model: 'openai/gpt-5.5',
      stableSlug: 'p-project-1',
    }, (warning) => warnings.push(warning))).toBe(true);

    expect(JSON.parse(fs.readFileSync(path.join(projectRoot, '.agent-session.json'), 'utf8')))
      .toEqual({ initialized: true, model: 'openai/gpt-5.5', stableSlug: 'p-project-1' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('{broken');
    const projection = fs.lstatSync(path.join(projectRoot, '.agent-session.json'));
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      expect(projection.uid).toBe(PROJECT_RUNTIME_UID);
      expect(projection.gid).toBe(PROJECT_RUNTIME_GID);
    }
  });

  test('fails open when the project replaces the projection path', () => {
    fs.mkdirSync(path.join(projectRoot, 'target'));
    fs.symlinkSync(path.join(projectRoot, 'target'), path.join(projectRoot, '.agent-session.json'));
    const warnings: string[] = [];

    expect(writeProjectSessionProjectionBestEffort(projectRoot, {
      initialized: true,
    }, (warning) => warnings.push(warning))).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(projectRoot, 'target'))).toEqual([]);
  });

  test('keeps only bounded compatibility fields from untrusted content', () => {
    expect(__projectSessionProjectionTest.sanitizeProjection({
      initialized: true,
      model: 'model-a',
      modelConfigured: true,
      lastActivity: '2026-08-06T12:00:00.000Z',
      stableSlug: 'p-project-1',
      sessionKey: 'must-not-survive',
      injected: { admin: true },
    })).toEqual({
      initialized: true,
      model: 'model-a',
      modelConfigured: true,
      lastActivity: '2026-08-06T12:00:00.000Z',
      stableSlug: 'p-project-1',
    });
  });

  test('replaces stale compatibility fields instead of merging them across provider changes or reset', () => {
    fs.writeFileSync(path.join(projectRoot, '.agent-session.json'), JSON.stringify({
      initialized: true,
      model: 'stale-native-model',
      modelConfigured: true,
      lastActivity: 'stale',
      stableSlug: 'p-project-1',
    }));

    expect(writeProjectSessionProjectionBestEffort(projectRoot, {
      initialized: false,
      stableSlug: 'p-project-1',
    })).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(projectRoot, '.agent-session.json'), 'utf8'))).toEqual({
      initialized: false,
      stableSlug: 'p-project-1',
    });
  });
});
