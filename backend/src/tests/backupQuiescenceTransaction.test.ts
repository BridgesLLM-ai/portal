import path from 'path';
import { spawnSync } from 'child_process';

const repositoryRoot = path.resolve(__dirname, '../../..');

describe('backup quiescence transaction fault matrix', () => {
  it('passes the crash, deletion, legacy, diagnostic, and verification-cleanup validator', () => {
    const result = spawnSync(
      'python3',
      [path.join(repositoryRoot, 'scripts/validation/backup-quiescence-transaction-test.py')],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          BACKUP_SCRIPT_UNDER_TEST: process.env.BACKUP_SCRIPT_UNDER_TEST
            || path.join(repositoryRoot, 'backup-full.sh'),
        },
        timeout: 180_000,
      },
    );
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr })
      .toMatchObject({ status: 0 });
    expect(`${result.stdout}\n${result.stderr}`).toContain('Ran 24 tests');
  }, 190_000);
});
