/** Public photo raster worker. Invoked only through chatImageSandbox.ts. */
import sharp from 'sharp';
import { IMAGE_RASTER_LIMITS, IMAGE_RASTER_VERSION, type RasterOutput } from './imageRasterContract';
export { IMAGE_RASTER_LIMITS, IMAGE_RASTER_VERSION, type RasterOutput } from './imageRasterContract';

/** Orient the original, retain color, and strip metadata. */
export async function normalizeColorRaster(bytes: Buffer): Promise<RasterOutput> {
  if (!bytes.length || bytes.length > IMAGE_RASTER_LIMITS.inputBytes) return { ok: false, code: 'CHAT_IMAGE_LIMIT' };
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !webp) return { ok: false, code: 'CHAT_IMAGE_UNSUPPORTED' };
  // libvips can expose only the first APNG frame; reject animation from its
  // container marker as well as decoder metadata, rather than dropping frames.
  if (png) {
    let offset = 8;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) return { ok: false, code: 'CHAT_IMAGE_CORRUPT' };
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length) return { ok: false, code: 'CHAT_IMAGE_CORRUPT' };
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) return { ok: false, code: 'CHAT_IMAGE_UNSUPPORTED' };
      offset = end;
    }
  }
  if (webp) {
    if (bytes.length < 12 || bytes.readUInt32LE(4) !== bytes.length - 8) return { ok: false, code: 'CHAT_IMAGE_CORRUPT' };
    let offset = 12;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) return { ok: false, code: 'CHAT_IMAGE_CORRUPT' };
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      const end = offset + 8 + length + (length % 2);
      if (end > bytes.length) return { ok: false, code: 'CHAT_IMAGE_CORRUPT' };
      if (type === 'ANIM' || type === 'ANMF' || type === 'VP8X' && length > 0 && (bytes[offset + 8] & 2)) {
        return { ok: false, code: 'CHAT_IMAGE_UNSUPPORTED' };
      }
      offset = end;
    }
  }
  sharp.cache(false);
  sharp.concurrency(1);
  try {
    const options = { limitInputPixels: IMAGE_RASTER_LIMITS.inputPixels, failOn: 'warning' as const };
    const metadata = await sharp(bytes, options).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format || '') || (metadata.pages ?? 1) !== 1) {
      return { ok: false, code: 'CHAT_IMAGE_UNSUPPORTED' };
    }
    if (!metadata.width || !metadata.height || metadata.width > IMAGE_RASTER_LIMITS.inputSide
      || metadata.height > IMAGE_RASTER_LIMITS.inputSide || metadata.width * metadata.height > IMAGE_RASTER_LIMITS.inputPixels) {
      return { ok: false, code: 'CHAT_IMAGE_LIMIT' };
    }
    // No keepMetadata/withMetadata: apply orientation before discarding EXIF/ICC/XMP.
    const { data, info } = await sharp(bytes, options).autoOrient().toColourspace('srgb')
      .resize({ width: IMAGE_RASTER_LIMITS.outputSide, height: IMAGE_RASTER_LIMITS.outputSide, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 85, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
    if (data.length > IMAGE_RASTER_LIMITS.outputBytes) return { ok: false, code: 'CHAT_IMAGE_LIMIT' };
    return { ok: true, mimeType: 'image/jpeg', data: data.toString('base64'), width: info.width, height: info.height, version: IMAGE_RASTER_VERSION };
  } catch {
    return { ok: false, code: 'CHAT_IMAGE_CORRUPT' };
  }
}

if (require.main === module) {
  const chunks: Buffer[] = [];
  let size = 0;
  process.stdin.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > IMAGE_RASTER_LIMITS.inputBytes) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'CHAT_IMAGE_LIMIT' }));
      process.exit(0);
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    void normalizeColorRaster(Buffer.concat(chunks)).then((result) => process.stdout.write(JSON.stringify(result)));
  });
}
