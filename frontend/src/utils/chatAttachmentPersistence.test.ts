// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPersistedChatAttachmentText, presentChatImageReferences } from './chatAttachmentPersistence';
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

describe('native photo input references', () => {
  const photo = { name: 'private-photo.jpg', size: 42, type: 'image' as const,
    fileId: '11111111-1111-4111-8111-111111111111', fileRevision: '2026-10-20T12:00:00.000Z',
    serverPath: '/private/upload', toolUrl: 'https://example.test/private', uploadStatus: 'done' as const };
  it('uses an owned file identity and revision without sending paths or tool instructions', () => {
    const text = buildPersistedChatAttachmentText([photo], { nativeImages: true });
    expect(text).toContain('[portal-chat-image:'); expect(text).toContain(photo.fileRevision);
    expect(text).not.toContain(photo.serverPath); expect(text).not.toContain(photo.toolUrl); expect(text).not.toContain('image tool');
  });
  it('blocks failed and unversioned photo uploads', () => {
    expect(() => buildPersistedChatAttachmentText([{ ...photo, uploadStatus: 'error' }], { nativeImages: true })).toThrow();
    expect(() => buildPersistedChatAttachmentText([{ ...photo, fileRevision: undefined }], { nativeImages: true })).toThrow();
  });
  it('retains legacy provider attachments and mixed text/PDF behavior', () => {
    expect(buildPersistedChatAttachmentText([photo])).toContain('image tool');
    expect(buildPersistedChatAttachmentText([photo, { name: 'note.txt', size: 3, type: 'text', textContent: 'yes' }], { nativeImages: true })).toContain('yes');
  });
});

 it('presents persisted photo identities as authorized Files links', () => {
  expect(presentChatImageReferences('[portal-chat-image:{"fileId":"11111111-1111-4111-8111-111111111111","revision":"2026-10-20T12:00:00.000Z"}]'))
    .toBe('[Attached photo](/api/files/11111111-1111-4111-8111-111111111111)');
  expect(presentChatImageReferences('[portal-chat-image:{"fileId":"javascript:alert(1)"}]')).not.toContain('](/api/');
});
