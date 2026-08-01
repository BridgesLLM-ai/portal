// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPersistedChatAttachmentText } from './chatAttachmentPersistence';
import { WORKSPACE_NAVIGATION_STORAGE_KEY } from './workspaceNavigation';

describe('persisted Agent Chat attachment text', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('uses a relative API reference without pre-minting a Files navigation token', () => {
    const text = buildPersistedChatAttachmentText([{
      name: 'owner report.pdf',
      size: 42,
      type: 'other',
      fileId: 'folder/secret file-id',
      serverPath: '/var/portal-files/owner/private/report.pdf',
      uploadStatus: 'done',
    }]);

    expect(text).toContain('- portal_url: /api/files/folder%2Fsecret%20file-id');
    expect(text).toContain('- server_path: /var/portal-files/owner/private/report.pdf');
    expect(text).not.toContain('?open=');
    expect(text).not.toContain('/files?file=');
    expect(text).not.toContain('/files?path=');
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
  });

  it('keeps path-only attachments in the recognized non-query server-path form', () => {
    const text = buildPersistedChatAttachmentText([{
      name: 'path only.txt',
      size: 7,
      type: 'other',
      serverPath: '/var/portal-files/owner/private/path-only.txt',
      uploadStatus: 'done',
    }]);

    expect(text).toContain('- server_path: /var/portal-files/owner/private/path-only.txt');
    expect(text).not.toContain('portal_url:');
    expect(text).not.toContain('/files?');
    expect(sessionStorage.getItem(WORKSPACE_NAVIGATION_STORAGE_KEY)).toBeNull();
  });
});
