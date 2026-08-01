import fs from 'fs';
import path from 'path';

describe('Project Chat attachment boundary', () => {
  it('materializes scanned files into the attested project and returns only a relative path', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/projects.ts'), 'utf8');
    const start = source.indexOf("'/:name/assistant/attachments'");
    const end = source.indexOf('// POST /api/projects/:name/upload', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const route = source.slice(start, end);

    expect(route).toContain("fileUpload.single('file')");
    expect(route).toContain('resolveProjectChatOperationContext(');
    expect(route).toContain('actorUserId');
    expect(route).toContain('requireSelectedProjectChatState({');
    expect(route).toContain('coordination.activeTurn');
    expect(route).toContain('scanFile(uploadedFile.path)');
    expect(route).toContain("path.posix.join('.portal', 'attachments', crypto.randomUUID())");
    expect(route).toContain('resolveContainedPath(attachmentDir, safeOriginalName');
    expect(route).toContain('projectPath,');
    expect(route).not.toMatch(/\b(?:diskPath|originalDiskPath|serverPath|toolUrl)\b/);
    expect(route).not.toMatch(/(?:server_path|tool_url|portal_url):/);
  });
});
