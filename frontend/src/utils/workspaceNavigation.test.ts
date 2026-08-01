// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProjectDeepLink,
  hasProjectDeepLinkParams,
  parseProjectDeepLink,
} from './projectSurface';
import {
  buildDeferredFileReference,
  buildFileDeepLink,
  hasFileDeepLinkParams,
  parseFileDeepLink,
  WORKSPACE_NAVIGATION_STORAGE_KEY,
} from './workspaceNavigation';

const CURRENT_ACTOR = {
  actorUserId: 'actor-current',
  authorizationVersion: 11,
};

describe('opaque workspace navigation', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps project names, paths, and file IDs out of URLs', () => {
    const projectUrl = buildProjectDeepLink(
      'Owner Secret Project',
      'private/contracts/customer-list.txt',
      CURRENT_ACTOR,
    );
    const fileUrl = buildFileDeepLink(
      'library-file-secret-id',
      'owner/private/customer-list.pdf',
      CURRENT_ACTOR,
    );

    expect(projectUrl).toMatch(/^\/projects\?open=[a-f0-9]{32}$/);
    expect(fileUrl).toMatch(/^\/files\?open=[a-f0-9]{32}$/);
    expect(projectUrl).not.toContain('Owner');
    expect(projectUrl).not.toContain('customer');
    expect(fileUrl).not.toContain('library-file-secret-id');
    expect(fileUrl).not.toContain('customer');
    expect(parseProjectDeepLink(projectUrl.split('?')[1], CURRENT_ACTOR)).toEqual({
      project: 'Owner Secret Project',
      file: 'private/contracts/customer-list.txt',
    });
    expect(parseFileDeepLink(fileUrl.split('?')[1], CURRENT_ACTOR)).toEqual({
      fileId: 'library-file-secret-id',
      path: 'owner/private/customer-list.pdf',
    });
  });

  it('builds a deferred non-query API reference without minting a navigation token', () => {
    const reference = buildDeferredFileReference('folder/file secret-id');

    expect(reference).toBe('/api/files/folder%2Ffile%20secret-id');
    expect(reference).not.toContain('?open=');
    expect(reference).not.toContain('/files?file=');
    expect(reference).not.toContain('/files?path=');
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
  });

  it('binds targets to the exact actor and authorization generation', () => {
    const projectUrl = buildProjectDeepLink('alpha', 'src/index.ts', CURRENT_ACTOR);
    const fileUrl = buildFileDeepLink('file-alpha', 'alpha.txt', CURRENT_ACTOR);
    const projectSearch = projectUrl.split('?')[1];
    const fileSearch = fileUrl.split('?')[1];

    expect(parseProjectDeepLink(projectSearch, {
      ...CURRENT_ACTOR,
      actorUserId: 'actor-other',
    })).toBeNull();
    expect(parseProjectDeepLink(projectSearch, {
      ...CURRENT_ACTOR,
      authorizationVersion: CURRENT_ACTOR.authorizationVersion + 1,
    })).toBeNull();
    expect(parseFileDeepLink(fileSearch, {
      ...CURRENT_ACTOR,
      actorUserId: 'actor-other',
    })).toBeNull();
    expect(parseFileDeepLink(fileSearch, {
      ...CURRENT_ACTOR,
      authorizationVersion: CURRENT_ACTOR.authorizationVersion + 1,
    })).toBeNull();
  });

  it('invalidates multiple historical URLs when workspace state is cleared', () => {
    const firstHistoryUrl = buildProjectDeepLink('history-project', 'secret/a.ts', CURRENT_ACTOR);
    const secondHistoryUrl = buildFileDeepLink('history-file-id', 'secret/b.pdf', CURRENT_ACTOR);
    expect(parseProjectDeepLink(firstHistoryUrl.split('?')[1], CURRENT_ACTOR)).not.toBeNull();
    expect(parseFileDeepLink(secondHistoryUrl.split('?')[1], CURRENT_ACTOR)).not.toBeNull();

    window.sessionStorage.clear();

    expect(parseProjectDeepLink(firstHistoryUrl.split('?')[1], CURRENT_ACTOR)).toBeNull();
    expect(parseFileDeepLink(secondHistoryUrl.split('?')[1], CURRENT_ACTOR)).toBeNull();
  });

  it('recognizes sensitive legacy parameters only so pages can scrub them', () => {
    expect(hasProjectDeepLinkParams('?project=alpha&file=src%2Findex.ts')).toBe(true);
    expect(parseProjectDeepLink('?project=alpha&file=src%2Findex.ts', CURRENT_ACTOR)).toBeNull();
    expect(hasFileDeepLinkParams('?file=file-1&path=owner%2Fsecret.txt')).toBe(true);
    expect(parseFileDeepLink('?file=file-1&path=owner%2Fsecret.txt', CURRENT_ACTOR)).toBeNull();
  });

  it('fails closed when session storage cannot be written or read', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(buildFileDeepLink('file-1', 'secret.txt', CURRENT_ACTOR)).toBe('/files');
    setItem.mockRestore();

    const projectUrl = buildProjectDeepLink('alpha', CURRENT_ACTOR);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(parseProjectDeepLink(projectUrl.split('?')[1], CURRENT_ACTOR)).toBeNull();
  });

  it('evicts old targets instead of allowing the per-tab registry to grow without bound', () => {
    const urls = Array.from({ length: 33 }, (_unused, index) => (
      buildFileDeepLink(`file-${index}`, `path-${index}.txt`, CURRENT_ACTOR)
    ));
    expect(parseFileDeepLink(urls[0].split('?')[1], CURRENT_ACTOR)).toBeNull();
    expect(parseFileDeepLink(urls.at(-1)!.split('?')[1], CURRENT_ACTOR)).toEqual({
      fileId: 'file-32',
      path: 'path-32.txt',
    });
  });
});
