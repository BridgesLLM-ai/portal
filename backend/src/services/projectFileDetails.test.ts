import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { parseProjectNumstat, projectFileDetails } from './projectFileDetails';

let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-file-details-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
test('real Git counts the net working tree against HEAD, not staged plus unstaged totals', () => {
  git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'a\tfile.txt'), 'one\ntwo\nthree\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  fs.writeFileSync(path.join(root, 'a\tfile.txt'), 'one\nstaged\nthree\n'); git('add', '.');
  fs.writeFileSync(path.join(root, 'a\tfile.txt'), 'one\nfinal\nthree\nextra\n');
  const changes = parseProjectNumstat(git('diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--'));
  expect(changes.get('a\tfile.txt')).toEqual({ added: 2, removed: 1, binary: false });
  const detail = projectFileDetails(root, 'a\tfile.txt', changes.get('a\tfile.txt'), false, { bytes: 1024 });
  expect(detail).toMatchObject({ size: 22, added: 2, removed: 1 });
  expect(detail.modifiedAt).toBe(fs.statSync(path.join(root, 'a\tfile.txt')).mtime.toISOString());
});
test('new text handles empty files, terminal newlines and binary content without invented counts', () => {
  const budget = { bytes: 1024 };
  for (const [name, content] of [['empty', ''], ['text', 'one\ntwo\n'], ['no-newline', 'one\ntwo'], ['binary', '\0abc']]) fs.writeFileSync(path.join(root, name), content);
  expect(projectFileDetails(root, 'empty', undefined, true, budget)).toMatchObject({ size: 0, added: 0, removed: 0 });
  expect(projectFileDetails(root, 'text', undefined, true, budget)).toMatchObject({ added: 2, removed: 0 });
  expect(projectFileDetails(root, 'no-newline', undefined, true, budget)).toMatchObject({ added: 2, removed: 0 });
  expect(projectFileDetails(root, 'binary', undefined, true, budget)).toMatchObject({ binary: true, added: null, removed: null });
  expect(projectFileDetails(root, 'text', undefined, true, { bytes: 1 }).added).toBeUndefined();
});
test('outside paths and symlinks cannot contribute metadata or line counts', () => {
  fs.symlinkSync('/etc/passwd', path.join(root, 'outside'));
  for (const name of ['outside', '../secret', '/etc/passwd']) {
    expect(projectFileDetails(root, name, undefined, true, { bytes: 1024 })).toMatchObject({ size: null, modifiedAt: null, unavailable: true });
  }
});
test('deleted, binary and NUL-delimited renamed files keep accurate status', () => {
  const stats = parseProjectNumstat('0\t4\tgone.txt\0-\t-\ta.png\0' + '5\t2\t\0old\tname.txt\0new\nname.txt\0');
  expect(stats.get('new\nname.txt')).toEqual({ added: 5, removed: 2, binary: false });
  expect(stats.get('a.png')).toEqual({ added: null, removed: null, binary: true });
  expect(projectFileDetails(root, 'gone.txt', stats.get('gone.txt'), false, { bytes: 0 })).toMatchObject({ size: null, modifiedAt: null, added: 0, removed: 4 });
});
