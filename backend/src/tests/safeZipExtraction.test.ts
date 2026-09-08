import fs from 'fs';
import os from 'os';
import path from 'path';
import archiver from 'archiver';
import {
  PROJECT_ZIP_LIMITS,
  UnsafeZipError,
  createZipValidationState,
  safeExtractZipToNewDirectory,
  validateZipEntry,
} from '../services/safeZipExtraction';

describe('safe ZIP extraction', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-zip-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function createZip(
    fileName: string,
    build: (archive: archiver.Archiver) => void,
    options: { store?: boolean } = {},
  ): Promise<string> {
    const zipPath = path.join(tempRoot, fileName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 }, store: options.store });
    const finished = new Promise<void>((resolve, reject) => {
      output.once('close', resolve);
      output.once('error', reject);
      archive.once('error', reject);
    });
    archive.pipe(output);
    build(archive);
    await archive.finalize();
    await finished;
    return zipPath;
  }

  function corruptCentralDirectoryCrc(zipPath: string): void {
    const raw = fs.readFileSync(zipPath);
    const centralHeader = raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (centralHeader < 0) throw new Error('test ZIP lacks a central-directory entry');
    raw.writeUInt32LE((raw.readUInt32LE(centralHeader + 16) ^ 0xffffffff) >>> 0, centralHeader + 16);
    fs.writeFileSync(zipPath, raw);
  }

  function corruptStoredEntryPayload(zipPath: string): void {
    const raw = fs.readFileSync(zipPath);
    const localHeader = raw.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (localHeader < 0 || raw.readUInt16LE(localHeader + 8) !== 0) {
      throw new Error('test ZIP lacks a stored local entry');
    }
    const dataOffset = localHeader + 30
      + raw.readUInt16LE(localHeader + 26)
      + raw.readUInt16LE(localHeader + 28);
    raw[dataOffset] ^= 0x01;
    fs.writeFileSync(zipPath, raw);
  }

  function entry(overrides: Partial<Parameters<typeof validateZipEntry>[0]> = {}) {
    return {
      fileName: 'file.txt',
      compressedSize: 5,
      uncompressedSize: 5,
      externalFileAttributes: 0,
      generalPurposeBitFlag: 0,
      compressionMethod: 0,
      ...overrides,
    };
  }

  test('rejects traversal, absolute, duplicate, encrypted, symlink, and bomb entries', () => {
    const invalidEntries = [
      entry({ fileName: '../outside' }),
      entry({ fileName: '/etc/passwd' }),
      entry({ fileName: 'C:/windows/file' }),
      entry({ fileName: 'dir\\file' }),
      entry({ generalPurposeBitFlag: 1 }),
      entry({ externalFileAttributes: 0o120777 << 16 }),
      entry({ externalFileAttributes: 0o010644 << 16 }),
      entry({ compressionMethod: 99 }),
      entry({ compressedSize: 1, uncompressedSize: PROJECT_ZIP_LIMITS.maxEntryBytes + 1 }),
      entry({ compressedSize: 1, uncompressedSize: PROJECT_ZIP_LIMITS.maxCompressionRatio + 1 }),
    ];
    for (const invalid of invalidEntries) {
      expect(() => validateZipEntry(invalid, createZipValidationState(), PROJECT_ZIP_LIMITS)).toThrow(UnsafeZipError);
    }

    const state = createZipValidationState();
    validateZipEntry(entry(), state, PROJECT_ZIP_LIMITS);
    expect(() => validateZipEntry(entry(), state, PROJECT_ZIP_LIMITS)).toThrow(/duplicate/);

    const parentFileState = createZipValidationState();
    validateZipEntry(entry({ fileName: 'node' }), parentFileState, PROJECT_ZIP_LIMITS);
    expect(() => validateZipEntry(
      entry({ fileName: 'node/child.txt' }),
      parentFileState,
      PROJECT_ZIP_LIMITS,
    )).toThrow(/collision/);

    const childFirstState = createZipValidationState();
    validateZipEntry(entry({ fileName: 'node/child.txt' }), childFirstState, PROJECT_ZIP_LIMITS);
    expect(() => validateZipEntry(entry({ fileName: 'node' }), childFirstState, PROJECT_ZIP_LIMITS))
      .toThrow(/collision/);

    const metadataState = createZipValidationState();
    expect(() => validateZipEntry(entry({
      fileNameLength: 5,
      extraFieldLength: 8,
      fileCommentLength: 9,
    }), metadataState, { ...PROJECT_ZIP_LIMITS, maxMetadataBytes: 21 }))
      .toThrow(/metadata/i);
  });

  test('extracts to staging, audits the result, collapses one root, then promotes atomically', async () => {
    const zipPath = await createZip('valid.zip', (archive) => {
      archive.append('hello', { name: 'source/readme.txt' });
      archive.append('{"name":"safe"}', { name: 'source/package.json' });
    });
    const destination = path.join(tempRoot, 'project');
    await safeExtractZipToNewDirectory(zipPath, destination, { collapseSingleRoot: true });

    expect(fs.readFileSync(path.join(destination, 'readme.txt'), 'utf8')).toBe('hello');
    expect(fs.existsSync(path.join(destination, 'source'))).toBe(false);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(destination, 'readme.txt')).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(tempRoot).some((name) => name.includes('.extract-'))).toBe(false);
  });

  test('promotes into an attested empty directory without changing its inode', async () => {
    const zipPath = await createZip('existing.zip', (archive) => {
      archive.append('hello', { name: 'source/readme.txt' });
      archive.append('world', { name: 'source/nested/value.txt' });
    });
    const destination = path.join(tempRoot, 'reserved-project');
    fs.mkdirSync(destination, { mode: 0o700 });
    const before = fs.lstatSync(destination, { bigint: true });

    await safeExtractZipToNewDirectory(zipPath, destination, {
      collapseSingleRoot: true,
      existingEmptyDirectory: true,
    });

    const after = fs.lstatSync(destination, { bigint: true });
    expect({ dev: after.dev, ino: after.ino, birthtimeNs: after.birthtimeNs }).toEqual({
      dev: before.dev,
      ino: before.ino,
      birthtimeNs: before.birthtimeNs,
    });
    expect(fs.readFileSync(path.join(destination, 'readme.txt'), 'utf8')).toBe('hello');
    expect(fs.readdirSync(tempRoot).some((name) => name.includes('.extract-'))).toBe(false);
  });

  test('rejects nonempty and symbolic-link existing destinations', async () => {
    const zipPath = await createZip('existing-invalid.zip', (archive) => {
      archive.append('hello', { name: 'readme.txt' });
    });
    const nonempty = path.join(tempRoot, 'nonempty');
    fs.mkdirSync(nonempty);
    fs.writeFileSync(path.join(nonempty, 'keep.txt'), 'keep');
    await expect(safeExtractZipToNewDirectory(zipPath, nonempty, {
      existingEmptyDirectory: true,
    })).rejects.toThrow(/must be empty/i);

    const real = path.join(tempRoot, 'real');
    const linked = path.join(tempRoot, 'linked');
    fs.mkdirSync(real);
    fs.symlinkSync(real, linked);
    await expect(safeExtractZipToNewDirectory(zipPath, linked, {
      existingEmptyDirectory: true,
    })).rejects.toThrow(/real directory/i);
  });

  test('rejects a replaced existing destination without deleting the displaced attested root', async () => {
    const zipPath = await createZip('replaced.zip', (archive) => {
      archive.append('hello', { name: 'readme.txt' });
    });
    const destination = path.join(tempRoot, 'replace-me');
    fs.mkdirSync(destination);
    const displaced = path.join(tempRoot, 'displaced');
    const chmodSync = fs.chmodSync.bind(fs);
    let replaced = false;
    const chmod = jest.spyOn(fs, 'chmodSync').mockImplementation(((target: fs.PathLike, mode: fs.Mode) => {
      chmodSync(target, mode);
      if (
        !replaced
        && typeof target === 'string'
        && path.dirname(target) === destination
        && path.basename(target).startsWith('.portal-zip-extract-')
        && mode === 0o755
      ) {
        fs.renameSync(destination, displaced);
        fs.mkdirSync(destination);
        replaced = true;
      }
    }) as typeof fs.chmodSync);
    try {
      await expect(safeExtractZipToNewDirectory(zipPath, destination, {
        existingEmptyDirectory: true,
      })).rejects.toThrow(/changed during extraction/i);
    } finally {
      chmod.mockRestore();
    }
    expect(fs.readdirSync(tempRoot).some((name) => name.includes('.extract-'))).toBe(false);
    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.existsSync(displaced)).toBe(true);
    expect(fs.readdirSync(displaced).some((name) => name.startsWith('.portal-zip-extract-'))).toBe(true);
  });

  test('leaves a partially promoted destination attested when a child move fails', async () => {
    const zipPath = await createZip('partial.zip', (archive) => {
      archive.append('one', { name: 'one.txt' });
      archive.append('two', { name: 'two.txt' });
    });
    const destination = path.join(tempRoot, 'partial-project');
    fs.mkdirSync(destination);
    const before = fs.lstatSync(destination, { bigint: true });
    const renameSync = fs.renameSync.bind(fs);
    let promotedChildren = 0;
    const rename = jest.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (
        typeof source === 'string'
        && typeof target === 'string'
        && source.includes('.portal-zip-extract-')
        && path.dirname(target) === destination
      ) {
        promotedChildren += 1;
        if (promotedChildren === 2) throw new Error('injected child move failure');
      }
      return renameSync(source, target);
    });
    try {
      await expect(safeExtractZipToNewDirectory(zipPath, destination, {
        existingEmptyDirectory: true,
      })).rejects.toThrow(/injected child move failure/);
    } finally {
      rename.mockRestore();
    }
    const after = fs.lstatSync(destination, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(fs.readdirSync(destination)).toHaveLength(1);
    expect(fs.readdirSync(destination).some((name) => name.startsWith('.portal-zip-extract-'))).toBe(false);
    expect(fs.readdirSync(tempRoot).some((name) => name.includes('.extract-'))).toBe(false);
    fs.rmSync(destination, { recursive: true, force: false });
    expect(fs.existsSync(destination)).toBe(false);
  });

  test('rejects symlink archives without leaving a partial destination', async () => {
    const zipPath = await createZip('symlink.zip', (archive) => {
      archive.append('safe', { name: 'safe.txt' });
      archive.symlink('escape', '/etc/passwd');
    });
    const destination = path.join(tempRoot, 'project');
    await expect(safeExtractZipToNewDirectory(zipPath, destination)).rejects.toThrow(/symbolic link/i);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(tempRoot).some((name) => name.includes('.extract-'))).toBe(false);
  });

  test('rejects a symlink followed by the same regular path before writing any entry', async () => {
    const outside = path.join(tempRoot, 'outside-sentinel.txt');
    fs.writeFileSync(outside, 'unchanged');
    const zipPath = await createZip('symlink-duplicate.zip', (archive) => {
      archive.append('safe', { name: 'safe.txt' });
      archive.symlink('same-path', outside);
      archive.append('overwrite', { name: 'same-path' });
    });
    const destination = path.join(tempRoot, 'project');
    const openSync = jest.spyOn(fs, 'openSync');
    try {
      await expect(safeExtractZipToNewDirectory(zipPath, destination))
        .rejects.toThrow(/symbolic link|duplicate/i);
      expect(openSync).not.toHaveBeenCalled();
    } finally {
      openSync.mockRestore();
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(tempRoot).some((name) => name.includes('.extract-'))).toBe(false);
  });

  test('rejects corrupt and file-directory-collision archives without promotion', async () => {
    const validZip = await createZip('valid-before-corruption.zip', (archive) => {
      archive.append('hello', { name: 'readme.txt' });
    });
    const truncatedZip = path.join(tempRoot, 'truncated.zip');
    const complete = fs.readFileSync(validZip);
    fs.writeFileSync(truncatedZip, complete.subarray(0, complete.length - 12));
    const corruptDestination = path.join(tempRoot, 'corrupt-project');
    await expect(safeExtractZipToNewDirectory(truncatedZip, corruptDestination)).rejects.toThrow();
    expect(fs.existsSync(corruptDestination)).toBe(false);

    const collisionZip = await createZip('collision.zip', (archive) => {
      archive.append('file', { name: 'node' });
      archive.append('child', { name: 'node/child.txt' });
    });
    const collisionDestination = path.join(tempRoot, 'collision-project');
    await expect(safeExtractZipToNewDirectory(collisionZip, collisionDestination))
      .rejects.toThrow(/collision/i);
    expect(fs.existsSync(collisionDestination)).toBe(false);
    expect(fs.readdirSync(tempRoot).some((name) => name.includes('.extract-'))).toBe(false);
  });

  test.each([
    ['stored', true],
    ['deflated', false],
  ] as const)('rejects a same-size CRC-corrupt %s entry without promotion', async (label, store) => {
    const zipPath = await createZip(`${label}-crc.zip`, (archive) => {
      archive.append('crc-protected-content'.repeat(64), { name: 'readme.txt' });
    }, { store });
    if (store) corruptStoredEntryPayload(zipPath);
    else corruptCentralDirectoryCrc(zipPath);
    const destination = path.join(tempRoot, `${label}-crc-project`);

    await expect(safeExtractZipToNewDirectory(zipPath, destination))
      .rejects.toThrow(/CRC-32/i);
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readdirSync(tempRoot).some((name) => name.includes('.extract-'))).toBe(false);
  });

  test('preserves executable mode while ignoring macOS metadata', async () => {
    const zipPath = await createZip('macos-and-mode.zip', (archive) => {
      archive.append('metadata', { name: '__MACOSX/._run.sh' });
      archive.append('#!/bin/sh\necho safe\n', { name: 'source/bin/run.sh', mode: 0o755 });
      archive.append('hello', { name: 'source/readme.txt', mode: 0o644 });
    });
    const destination = path.join(tempRoot, 'project');
    await safeExtractZipToNewDirectory(zipPath, destination, { collapseSingleRoot: true });

    expect(fs.existsSync(path.join(destination, '__MACOSX'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'bin/run.sh'), 'utf8')).toContain('echo safe');
    expect(fs.statSync(path.join(destination, 'bin/run.sh')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(destination, 'readme.txt')).mode & 0o777).toBe(0o644);
  });

  test('enforces aggregate expanded size before promotion', async () => {
    const zipPath = await createZip('too-large.zip', (archive) => {
      archive.append('12345', { name: 'one.txt' });
      archive.append('67890', { name: 'two.txt' });
    });
    const destination = path.join(tempRoot, 'project');
    await expect(safeExtractZipToNewDirectory(zipPath, destination, {
      limits: { ...PROJECT_ZIP_LIMITS, maxExpandedBytes: 8 },
    })).rejects.toThrow(/expanded-size/);
    expect(fs.existsSync(destination)).toBe(false);
  });
});
