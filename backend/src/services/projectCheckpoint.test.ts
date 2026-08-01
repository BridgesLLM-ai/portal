import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  assertNoTransientProjectStateStaged,
  projectGitAddAllArgs,
  runProjectCheckpointBoundary,
  shelveTransientProjectState,
} from './projectCheckpoint';

describe('Project checkpoint safety', () => {
  test('fails closed when transient state cannot be shelved', async () => {
    const git = jest.fn(async () => {
      throw new Error('stash rejected');
    });

    await expect(shelveTransientProjectState(git, [
      '.agent-session.json',
      '.portal/attachments/upload.bin',
    ])).rejects.toThrow('stash rejected');

    expect(git).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledWith([
      'stash',
      'push',
      '-u',
      '-m',
      'portal-transient-project-state',
      '--',
      '.agent-session.json',
      '.portal/attachments/upload.bin',
    ]);
  });

  test('uses exclusion pathspecs for every checkpoint index operation', () => {
    const args = projectGitAddAllArgs();
    expect(args.slice(0, 4)).toEqual(['add', '-A', '--', '.']);
    expect(args).toContain(':(glob,exclude)**/.agent-session.json');
    expect(args).toContain(':(exclude).portal/attachments');
    expect(args).toContain(':(glob,exclude).portal/attachments/**');
    expect(args).not.toEqual(['add', '-A']);
  });

  test('the real Git index excludes nested agent state and Project attachments', () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-checkpoint-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repository });
      fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
      fs.mkdirSync(path.join(repository, '.portal', 'attachments'), { recursive: true });
      fs.writeFileSync(path.join(repository, 'src', 'index.ts'), 'export const ready = true;\n');
      fs.writeFileSync(path.join(repository, 'src', '.agent-session.json'), '{"private":true}\n');
      fs.writeFileSync(path.join(repository, '.portal', 'attachments', 'prompt.txt'), 'private attachment\n');

      execFileSync('git', projectGitAddAllArgs(), { cwd: repository });
      const staged = execFileSync(
        'git',
        ['diff', '--cached', '--name-only', '-z'],
        { cwd: repository, encoding: 'utf8' },
      ).split('\0').filter(Boolean);

      expect(staged).toEqual(['src/index.ts']);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  test('rejects a checkpoint if transient state reaches the index anyway', () => {
    expect(() => assertNoTransientProjectStateStaged([
      'src/index.ts',
      '.portal/attachments/prompt.txt',
    ])).toThrow(/Transient Project state reached the Git index/);
  });

  test('does not rerun a successful commit when durable notice persistence fails', async () => {
    const createCheckpoint = jest.fn(async () => ({
      commit: { hash: 'abc1234', message: 'Assistant: update', filesChanged: 1 },
      attempts: 1,
    }));
    const persistNotice = jest.fn(async () => {
      throw new Error('database notice write failed');
    });
    const logError = jest.fn();

    await expect(runProjectCheckpointBoundary({
      createCheckpoint,
      persistNotice,
      successNotice: (checkpoint) => `Committed ${checkpoint.commit!.hash}`,
      failureNotice: 'Checkpoint failed.',
      logError,
    })).resolves.toMatchObject({
      checkpoint: { commit: { hash: 'abc1234' } },
      checkpointError: null,
      noticePersisted: false,
    });

    expect(createCheckpoint).toHaveBeenCalledTimes(1);
    expect(persistNotice).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      'Project checkpoint success notice could not be persisted',
      expect.any(Error),
    );
  });

  test('keeps checkpoint failure reporting separate from provider completion', async () => {
    const createCheckpoint = jest.fn(async () => {
      throw new Error('commit failed twice');
    });
    const persistNotice = jest.fn(async () => undefined);

    await expect(runProjectCheckpointBoundary({
      createCheckpoint,
      persistNotice,
      successNotice: () => 'unused',
      failureNotice: 'Project checkpoint failed after one automatic retry.',
    })).resolves.toMatchObject({
      checkpoint: null,
      checkpointError: expect.any(Error),
      noticePersisted: true,
    });

    expect(createCheckpoint).toHaveBeenCalledTimes(1);
    expect(persistNotice).toHaveBeenCalledWith('Project checkpoint failed after one automatic retry.');
  });
});
