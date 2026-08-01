// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectFileWriteQueue,
  REMOTE_DESKTOP_RUNTIME_WARNING,
  buildProjectDeepLink,
  canLaunchProjectRuntimeDemo,
  contentRangeTotal,
  hasProjectDeepLinkParams,
  isSameProjectDocument,
  isValidProjectRelativePath,
  parseProjectDeepLink,
} from './projectSurface';

describe('Projects surface coordination', () => {
  it('serializes writes for one document while allowing other files to progress', async () => {
    const queue = new ProjectFileWriteQueue();
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const persist = vi.fn(async (write: { filePath: string; content: string }) => {
      started.push(`${write.filePath}:${write.content}`);
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    const first = queue.enqueue({ projectName: 'p', filePath: 'a.ts', content: 'old', revision: 1 }, persist);
    const second = queue.enqueue({ projectName: 'p', filePath: 'a.ts', content: 'new', revision: 2 }, persist);
    const other = queue.enqueue({ projectName: 'p', filePath: 'b.ts', content: 'other', revision: 1 }, persist);
    await vi.waitFor(() => expect(started).toEqual(['a.ts:old', 'b.ts:other']));

    releases.shift()?.();
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(['a.ts:old', 'b.ts:other', 'a.ts:new']));
    releases.shift()?.();
    await expect(Promise.all([first, second, other])).resolves.toBeDefined();
  });

  it('does not let a failed autosave block the next revision', async () => {
    const queue = new ProjectFileWriteQueue();
    const persist = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    await expect(queue.enqueue({ projectName: 'p', filePath: 'a', content: '1', revision: 1 }, persist)).rejects.toThrow('offline');
    await expect(queue.enqueue({ projectName: 'p', filePath: 'a', content: '2', revision: 2 }, persist)).resolves.toBeUndefined();
  });

  it('matches document identity and validates path segments exactly', () => {
    const write = { projectName: 'alpha', filePath: 'src/a..b.ts' };
    expect(isSameProjectDocument('alpha', 'src/a..b.ts', write)).toBe(true);
    expect(isSameProjectDocument('beta', 'src/a..b.ts', write)).toBe(false);
    expect(isValidProjectRelativePath('src/a..b.ts')).toBe(true);
    expect(isValidProjectRelativePath('../a.ts')).toBe(false);
    expect(isValidProjectRelativePath('src//a.ts')).toBe(false);
    expect(isValidProjectRelativePath('/src/a.ts')).toBe(false);
  });

  it('extracts bounded totals from single-range responses', () => {
    expect(contentRangeTotal('bytes 0-0/10485760')).toBe(10_485_760);
    expect(contentRangeTotal('bytes */10485760')).toBeNull();
    expect(contentRangeTotal(null)).toBeNull();
  });

  it('builds opaque Project links and rejects legacy, mismatched, or unsafe targets', () => {
    window.sessionStorage.clear();
    const binding = { actorUserId: 'actor-1', authorizationVersion: 7 };
    const route = buildProjectDeepLink(
      'My Unicode Ω Project',
      'src/space and Ω/file.ts',
      binding,
    );
    expect(route).toMatch(/^\/projects\?open=[a-f0-9]{32}$/);
    expect(route).not.toContain('Project');
    expect(route).not.toContain('file.ts');
    expect(parseProjectDeepLink(route.split('?')[1], binding)).toEqual({
      project: 'My Unicode Ω Project',
      file: 'src/space and Ω/file.ts',
    });
    expect(hasProjectDeepLinkParams('?file=orphan.ts')).toBe(true);
    expect(parseProjectDeepLink('?file=orphan.ts', binding)).toBeNull();
    expect(parseProjectDeepLink('?project=alpha&file=..%2Fsecret', binding)).toBeNull();
    expect(parseProjectDeepLink(route.split('?')[1], {
      actorUserId: binding.actorUserId,
      authorizationVersion: binding.authorizationVersion + 1,
    })).toBeNull();
    expect(() => buildProjectDeepLink('alpha', '../secret', binding)).toThrow('Invalid Project deep link');
  });

  it('keeps Remote Desktop runtime demos elevated and gives ordinary users the Admin warning', () => {
    expect(canLaunchProjectRuntimeDemo('OWNER')).toBe(true);
    expect(canLaunchProjectRuntimeDemo('SUB_ADMIN')).toBe(true);
    expect(canLaunchProjectRuntimeDemo('USER')).toBe(false);
    expect(canLaunchProjectRuntimeDemo('VIEWER')).toBe(false);
    expect(canLaunchProjectRuntimeDemo(undefined)).toBe(false);
    expect(REMOTE_DESKTOP_RUNTIME_WARNING).toMatch(/Remote Desktop/i);
    expect(REMOTE_DESKTOP_RUNTIME_WARNING).toMatch(/Admin privileges/i);
  });
});
