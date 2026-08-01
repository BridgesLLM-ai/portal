import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ProjectSearchCapacityError,
  createProjectSearchGate,
  searchProjectWorkspace,
} from './projectSearch';

describe('bounded actor-scoped project search', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-search-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function file(relativePath: string, contents = ''): void {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  test('finds a nested file in a project after the first three', async () => {
    file('alpha/index.ts');
    file('bravo/index.ts');
    file('charlie/index.ts');
    file('delta/src/features/deep/needle-controller.ts');

    const response = await searchProjectWorkspace(root, { query: 'needle', limit: 20 });

    expect(response.results).toEqual([
      {
        kind: 'file',
        project: 'delta',
        name: 'needle-controller.ts',
        path: 'src/features/deep/needle-controller.ts',
      },
    ]);
    expect(response.truncated).toBe(false);
  });

  test('searches project names before file traversal reaches its result limit', async () => {
    for (let index = 0; index < 12; index += 1) file(`alpha/match-${index}.txt`);
    file('zulu-match/index.ts');

    const response = await searchProjectWorkspace(root, { query: 'match', limit: 3 });

    expect(response.results[0]).toEqual({
      kind: 'project',
      project: 'zulu-match',
      name: 'zulu-match',
    });
    expect(response.truncated).toBe(true);
  });

  test('never follows project or nested symlinks into a sibling root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-search-outside-'));
    try {
      fs.mkdirSync(path.join(root, 'actor-project', 'src'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'sibling-secret.txt'), 'private');
      fs.symlinkSync(outside, path.join(root, 'actor-project', 'src', 'escape'));
      fs.symlinkSync(outside, path.join(root, 'sibling-project-link'));

      const response = await searchProjectWorkspace(root, { query: 'sibling-secret', limit: 20 });

      expect(response.results).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('searches safe developer dotfiles and directories while excluding secrets and generated trees', async () => {
    file('project/.git/object-needle');
    file('project/node_modules/package/needle.js');
    file('project/dist/needle.js');
    file('project/.env.needle');
    file('project/.gitignore', 'needle');
    file('project/.editorconfig');
    file('project/.npmrc');
    file('project/.github/workflows/release-needle.yml');
    file('project/.devcontainer/devcontainer.json');

    expect((await searchProjectWorkspace(root, { query: 'env.needle', limit: 20 })).results).toEqual([]);
    expect((await searchProjectWorkspace(root, { query: 'gitignore', limit: 20 })).results).toEqual([
      { kind: 'file', project: 'project', name: '.gitignore', path: '.gitignore' },
    ]);
    expect((await searchProjectWorkspace(root, { query: 'editorconfig', limit: 20 })).results).toEqual([
      { kind: 'file', project: 'project', name: '.editorconfig', path: '.editorconfig' },
    ]);
    expect((await searchProjectWorkspace(root, { query: 'npmrc', limit: 20 })).results).toEqual([
      { kind: 'file', project: 'project', name: '.npmrc', path: '.npmrc' },
    ]);
    expect((await searchProjectWorkspace(root, { query: 'release-needle', limit: 20 })).results).toEqual([
      {
        kind: 'file',
        project: 'project',
        name: 'release-needle.yml',
        path: '.github/workflows/release-needle.yml',
      },
    ]);
    expect((await searchProjectWorkspace(root, { query: 'devcontainer.json', limit: 20 })).results).toEqual([
      {
        kind: 'file',
        project: 'project',
        name: 'devcontainer.json',
        path: '.devcontainer/devcontainer.json',
      },
    ]);
  });

  test('reports honest truncation at depth and visit limits', async () => {
    file('project/one/two/three/depth-needle.ts');
    for (let index = 0; index < 8; index += 1) file(`project/${String(index).padStart(2, '0')}.txt`);

    const depthLimited = await searchProjectWorkspace(root, { query: 'depth-needle', maxDepth: 1, limit: 20 });
    expect(depthLimited.results).toEqual([]);
    expect(depthLimited.truncated).toBe(true);

    const visitLimited = await searchProjectWorkspace(root, { query: 'not-present', maxVisited: 2, limit: 20 });
    expect(visitLimited.visited).toBe(2);
    expect(visitLimited.truncated).toBe(true);
  });

  test('bounds a large directory before sorting or materializing all of its entries and yields the event loop', async () => {
    for (let index = 0; index < 500; index += 1) {
      file(`project/large/${String(index).padStart(4, '0')}-ordinary.txt`);
    }
    file('project/large/9999-never-read-needle.txt');
    let eventLoopYielded = false;
    setImmediate(() => { eventLoopYielded = true; });

    const response = await searchProjectWorkspace(root, {
      query: 'never-read-needle',
      limit: 20,
      maxEntriesPerDirectory: 25,
      maxVisited: 1_000,
      yieldEvery: 5,
    });

    expect(response.results).toEqual([]);
    expect(response.truncated).toBe(true);
    // workspace project + project/large + at most 25 entries in large
    expect(response.visited).toBeLessThanOrEqual(27);
    expect(eventLoopYielded).toBe(true);
  });

  test('rejects excess concurrent work instead of building an unbounded search queue', async () => {
    const gate = createProjectSearchGate(2);
    const releases: Array<() => void> = [];
    const operation = () => gate(() => new Promise<string>((resolve) => releases.push(() => resolve('done'))));

    const first = operation();
    const second = operation();
    await expect(operation()).rejects.toBeInstanceOf(ProjectSearchCapacityError);
    releases.shift()?.();
    await expect(first).resolves.toBe('done');
    const third = operation();
    releases.shift()?.();
    releases.shift()?.();
    await expect(Promise.all([second, third])).resolves.toEqual(['done', 'done']);
  });

  test('stops promptly when the caller disconnects', async () => {
    file('project/src/needle.ts');
    const controller = new AbortController();
    controller.abort();
    await expect(searchProjectWorkspace(root, {
      query: 'needle',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('treats a not-yet-created actor workspace as empty', async () => {
    const missing = path.join(root, 'not-created');
    await expect(searchProjectWorkspace(missing, { query: 'needle' })).resolves.toEqual({
      query: 'needle',
      results: [],
      truncated: false,
      visited: 0,
    });
  });
});
