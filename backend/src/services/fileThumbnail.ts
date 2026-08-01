import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const MAX_THUMBNAIL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_THUMBNAIL_INPUT_PIXELS = 40_000_000;
const MAX_THUMBNAIL_OUTPUT_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_EDGE = 256;
const SAFE_RASTER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.tif', '.tiff', '.bmp']);

export class ThumbnailError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'ThumbnailError';
  }
}

export async function generateBoundedThumbnail(sourcePath: string, cacheDir: string): Promise<string> {
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new ThumbnailError('Image source is not a regular file');
  if (sourceStat.size <= 0 || sourceStat.size > MAX_THUMBNAIL_SOURCE_BYTES) {
    throw new ThumbnailError('Image is too large to thumbnail', 413);
  }
  if (!SAFE_RASTER_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
    throw new ThumbnailError('This image format cannot be thumbnailed safely');
  }

  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const cacheStat = fs.lstatSync(cacheDir);
  if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) throw new ThumbnailError('Thumbnail cache is unavailable', 500);
  fs.chmodSync(cacheDir, 0o700);

  const key = crypto.createHash('sha256')
    .update(`${fs.realpathSync(sourcePath)}\0${sourceStat.ino}\0${sourceStat.size}\0${sourceStat.mtimeMs}\0${sourceStat.ctimeMs}`)
    .digest('hex');
  const outputPath = path.join(cacheDir, `${key}.webp`);
  let cached: fs.Stats | undefined;
  try {
    cached = fs.lstatSync(outputPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (cached) {
    if (!cached.isSymbolicLink() && cached.isFile() && cached.size > 0 && cached.size <= MAX_THUMBNAIL_OUTPUT_BYTES) {
      return outputPath;
    }
    try { fs.unlinkSync(outputPath); } catch {}
  }

  const tempPath = path.join(cacheDir, `.${key}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await sharp(sourcePath, {
      failOn: 'warning',
      limitInputPixels: MAX_THUMBNAIL_INPUT_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .resize(THUMBNAIL_EDGE, THUMBNAIL_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toFile(tempPath);
    const outputStat = fs.lstatSync(tempPath);
    if (!outputStat.isFile() || outputStat.size <= 0 || outputStat.size > MAX_THUMBNAIL_OUTPUT_BYTES) {
      throw new ThumbnailError('Generated thumbnail is outside its output limit');
    }
    fs.chmodSync(tempPath, 0o600);
    try {
      fs.linkSync(tempPath, outputPath);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const published = fs.lstatSync(outputPath);
    if (published.isSymbolicLink() || !published.isFile() || published.size <= 0 || published.size > MAX_THUMBNAIL_OUTPUT_BYTES) {
      throw new ThumbnailError('Thumbnail cache entry is unsafe', 500);
    }
    return outputPath;
  } catch (error: any) {
    if (error instanceof ThumbnailError) throw error;
    throw new ThumbnailError('Image could not be decoded safely');
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}
