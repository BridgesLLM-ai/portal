import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { generateBoundedThumbnail } from '../services/fileThumbnail';

describe('bounded file thumbnails', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-thumb-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('creates and reuses a bounded WebP thumbnail', async () => {
    const source = path.join(root, 'source.png');
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#336699' } }).png().toFile(source);
    const cache = path.join(root, 'cache');

    const first = await generateBoundedThumbnail(source, cache);
    const second = await generateBoundedThumbnail(source, cache);
    expect(second).toBe(first);
    const metadata = await sharp(first).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBeLessThanOrEqual(256);
    expect(metadata.height).toBeLessThanOrEqual(256);
    expect(fs.statSync(first).size).toBeLessThan(2 * 1024 * 1024);
  });

  test('rejects active SVG input and symlink sources', async () => {
    const svg = path.join(root, 'active.svg');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(generateBoundedThumbnail(svg, path.join(root, 'cache'))).rejects.toThrow(/format/);

    const target = path.join(root, 'target.png');
    await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toFile(target);
    const link = path.join(root, 'link.png');
    fs.symlinkSync(target, link);
    await expect(generateBoundedThumbnail(link, path.join(root, 'cache'))).rejects.toThrow(/regular file/);
  });

  test('never reuses or returns a dangling cache symlink', async () => {
    const source = path.join(root, 'source.png');
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } }).png().toFile(source);
    const cache = path.join(root, 'cache');
    const first = await generateBoundedThumbnail(source, cache);
    fs.unlinkSync(first);
    fs.symlinkSync(path.join(root, 'missing.webp'), first);

    const regenerated = await generateBoundedThumbnail(source, cache);
    expect(regenerated).toBe(first);
    expect(fs.lstatSync(regenerated).isFile()).toBe(true);
    expect(fs.lstatSync(regenerated).isSymbolicLink()).toBe(false);
  });
});
