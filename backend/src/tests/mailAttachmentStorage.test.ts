import fs from 'fs';
import os from 'os';
import path from 'path';
import { persistMailAttachmentToFiles } from '../routes/mail';

function makeDependencies(root: string, overrides: Record<string, unknown> = {}) {
  const createFile = jest.fn(async (data: any) => ({ id: 'file-1', ...data }));
  const deleteFile = jest.fn(async () => undefined);
  const logActivity = jest.fn(async () => undefined);
  const createToolMirror = jest.fn(() => path.join(root, 'mirror'));
  const deleteToolMirror = jest.fn(() => undefined);
  return {
    createFile,
    deleteFile,
    logActivity,
    getUploadDir: jest.fn(() => root),
    createToolMirror,
    deleteToolMirror,
    ...overrides,
  };
}

describe('mail attachment Portal-file persistence', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridges-mail-save-'));
    fs.chmodSync(root, 0o700);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates a private canonical file, database row, and tool mirror', async () => {
    const dependencies = makeDependencies(root);
    const file = await persistMailAttachmentToFiles({
      userId: 'user-1',
      filename: '../../quarterly report.pdf',
      contentType: 'application/pdf',
      buffer: Buffer.from('safe attachment'),
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    }, dependencies);

    expect(file.id).toBe('file-1');
    expect(file.originalName).toBe('quarterly report.pdf');
    expect(file.path).toMatch(/^[0-9a-f-]+\.pdf$/i);
    const storedPath = path.join(root, file.path);
    expect(fs.readFileSync(storedPath, 'utf8')).toBe('safe attachment');
    expect(fs.statSync(storedPath).mode & 0o777).toBe(0o600);
    expect(dependencies.createToolMirror).toHaveBeenCalledWith('user-1', storedPath, file.path);
    expect(dependencies.logActivity).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'file-1' }));
  });

  test('removes the canonical file when database creation fails', async () => {
    const dependencies = makeDependencies(root, {
      createFile: jest.fn(async () => { throw new Error('database unavailable'); }),
    });

    await expect(persistMailAttachmentToFiles({
      userId: 'user-1',
      filename: 'attachment.txt',
      contentType: 'text/plain',
      buffer: Buffer.from('content'),
    }, dependencies)).rejects.toThrow('database unavailable');

    expect(fs.readdirSync(root)).toEqual([]);
    expect(dependencies.createToolMirror).not.toHaveBeenCalled();
  });

  test('compensates the database and canonical file when mirror creation fails', async () => {
    const dependencies = makeDependencies(root, {
      createToolMirror: jest.fn(() => { throw new Error('mirror unavailable'); }),
    });

    await expect(persistMailAttachmentToFiles({
      userId: 'user-1',
      filename: 'attachment.txt',
      contentType: 'text/plain',
      buffer: Buffer.from('content'),
    }, dependencies)).rejects.toThrow('mirror unavailable');

    expect(dependencies.deleteFile).toHaveBeenCalledWith('file-1');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('does not fail a completed save when activity logging is unavailable', async () => {
    const dependencies = makeDependencies(root, {
      logActivity: jest.fn(async () => { throw new Error('activity log unavailable'); }),
    });

    await expect(persistMailAttachmentToFiles({
      userId: 'user-1',
      filename: 'attachment.txt',
      contentType: 'text/plain',
      buffer: Buffer.from('content'),
    }, dependencies)).resolves.toEqual(expect.objectContaining({ id: 'file-1' }));

    expect(fs.readdirSync(root)).toHaveLength(1);
    expect(dependencies.deleteFile).not.toHaveBeenCalled();
  });
});
