import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PROJECT_GIT_BASIC_LOG_FORMAT,
  parseProjectGitBasicLog,
  projectGitHistoryPage,
  projectGitHistoryRangeArgs,
  projectGitHistoryResult,
} from './projectGitHistoryPage';

const SUBJECTS = [
  'Initial commit from application package',
  'Add "quoted" rate notes',
  'Path C:\\rates\\table and a | pipe',
  'Revert "Add \\"quoted\\" rate notes"',
  'Plain change five',
  'Plain change six',
  'Plain change seven',
];

let repo: string;

function git(args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin', HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Owner "Ops" Name', GIT_AUTHOR_EMAIL: 'owner@example.invalid',
      GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid', ...env,
    },
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

function basicPage(skip: number, limit: number) {
  const page = projectGitHistoryPage({ limit, skip }, 50)!;
  return projectGitHistoryResult(parseProjectGitBasicLog(git(['log', '--all', PROJECT_GIT_BASIC_LOG_FORMAT,
    ...projectGitHistoryRangeArgs(page)])), page);
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-git-history-page-'));
  git(['init', '-q', '-b', 'master']);
  SUBJECTS.forEach((subject, index) => {
    fs.writeFileSync(path.join(repo, `file-${index}.txt`), `${index}\n`);
    git(['add', '-A']);
    const date = `2026-10-0${index + 1}T12:00:00Z`;
    git(['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  });
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('Projects Git History paging', () => {
  it('keeps the existing limits and accepts only a non-negative integer offset', () => {
    expect(projectGitHistoryPage({}, 30)).toEqual({ limit: 30, skip: 0 });
    expect(projectGitHistoryPage({ limit: 500 }, 30)).toEqual({ limit: 100, skip: 0 });
    expect(projectGitHistoryPage({ limit: 'x', skip: null }, 50)).toEqual({ limit: 50, skip: 0 });
    expect(projectGitHistoryPage({ skip: 60 }, 30)).toEqual({ limit: 30, skip: 60 });
    for (const skip of [-1, 1.5, '30', Number.NaN, 1_000_001, true]) {
      expect(projectGitHistoryPage({ skip }, 30)).toBeNull();
    }
    expect(projectGitHistoryRangeArgs({ limit: 30, skip: 0 })).toEqual(['-31']);
    expect(projectGitHistoryRangeArgs({ limit: 30, skip: 60 })).toEqual(['--skip=60', '-31']);
  });

  it('pages the whole history newest first with an accurate hasMore and no gaps or repeats', () => {
    const first = basicPage(0, 3);
    const second = basicPage(3, 3);
    const last = basicPage(6, 3);
    expect([first.hasMore, second.hasMore, last.hasMore]).toEqual([true, true, false]);
    const subjects = [...first.commits, ...second.commits, ...last.commits].map((commit) => commit?.message);
    expect(subjects).toEqual([...SUBJECTS].reverse());
    expect(basicPage(0, 7).hasMore).toBe(false);
  });

  it('keeps commits whose subject or author contains quotes, backslashes or pipes', () => {
    const { commits } = basicPage(0, 50);
    expect(commits.every(Boolean)).toBe(true);
    const revert = commits.find((commit) => commit?.message.startsWith('Revert'));
    expect(revert).toEqual(expect.objectContaining({
      message: 'Revert "Add \\"quoted\\" rate notes"', author: 'Owner "Ops" Name', email: 'owner@example.invalid',
    }));
    expect(revert!.hash).toMatch(/^[a-f0-9]{40}$/);
    expect(revert!.parent).toMatch(/^[a-f0-9]{40}$/);
    const root = commits[commits.length - 1]!;
    expect(root).toEqual(expect.objectContaining({ message: SUBJECTS[0], parent: '', refs: '' }));
    expect(commits[0]!.refs).toContain('master');
  });

  it('counts a malformed record toward the page instead of shifting the next offset', () => {
    const raw = `${'a'.repeat(40)}\x1fshort\x1e\n${'b'.repeat(40)}\x1fb\x1fn\x1fe\x1fd\x1fr\x1fs\x1f\x1f\x1e\n`;
    const parsed = parseProjectGitBasicLog(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBeNull();
    expect(parsed[1]).toEqual(expect.objectContaining({ hash: 'b'.repeat(40), message: 's', parent: '' }));
  });

  it('pages the enhanced --stat blocks the same way', () => {
    const page = projectGitHistoryPage({ skip: 5 }, 2)!;
    const raw = git(['log', '--all', '--format=COMMIT_START%n%H|%h|%an|%ae|%aI|%ar|%s|%D|%P',
      '--stat', '--no-ext-diff', '--no-textconv', ...projectGitHistoryRangeArgs(page)]);
    const { commits, hasMore } = projectGitHistoryResult(raw.split('COMMIT_START\n').filter(Boolean), page);
    expect(hasMore).toBe(false);
    expect(commits.map((block) => block.split('\n')[0].split('|')[6])).toEqual([SUBJECTS[1], SUBJECTS[0]]);
  });
});
