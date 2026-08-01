import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ProjectFilePolicyError,
  ProjectRangeError,
  parseProjectByteRange,
  readProjectTextFile,
  safeProjectDownloadName,
  writeProjectTextFile,
} from './projectSurfacePolicy';

describe('Project non-chat filesystem and media policy', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-project-surface-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads and atomically writes bounded regular project files', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"safe"}');
    expect(readProjectTextFile(root, 'package.json')).toBe('{"name":"safe"}');

    writeProjectTextFile(root, 'NOTES.md', '# Notes\n');
    expect(fs.readFileSync(path.join(root, 'NOTES.md'), 'utf8')).toBe('# Notes\n');
    expect(readProjectTextFile(root, 'missing.txt', { optional: true })).toBeNull();
  });

  it('rejects symlink reads and writes instead of touching host paths', () => {
    const outside = path.join(os.tmpdir(), `portal-project-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(root, 'NOTES.md'));
    try {
      expect(() => readProjectTextFile(root, 'NOTES.md')).toThrow(ProjectFilePolicyError);
      expect(() => writeProjectTextFile(root, 'NOTES.md', 'changed')).toThrow(ProjectFilePolicyError);
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('rejects oversized metadata before reading it into the Portal process', () => {
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'x'.repeat(32));
    expect(() => readProjectTextFile(root, 'requirements.txt', { maxBytes: 16 }))
      .toThrow('requirements.txt exceeds the 16-byte metadata limit');
  });

  it.each([
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=0-999', 100, { start: 0, end: 99 }],
  ])('parses a bounded media range %s', (header, size, expected) => {
    expect(parseProjectByteRange(header, size)).toEqual(expected);
  });

  it.each(['bytes=100-101', 'bytes=9-1', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-0'])(
    'rejects invalid or multipart media range %s',
    (header) => {
      expect(() => parseProjectByteRange(header, 100)).toThrow(ProjectRangeError);
    },
  );

  it('sanitizes project names used in attachment response headers', () => {
    expect(safeProjectDownloadName('bad\r\n"/name', 'clean')).toBe('bad____name-clean.zip');
  });
});
