import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Assets live at INSTALL_ROOT/assets (e.g. /opt/bridgesllm/assets), NOT inside the portal dir.
export const ASSETS_ROOT = path.join(
  process.env.INSTALL_ROOT || process.env.PORTAL_ROOT || '/root/bridgesllm-product',
  'assets'
);
export const AVATARS_DIR = path.join(ASSETS_ROOT, 'avatars');
export const BRANDING_DIR = path.join(ASSETS_ROOT, 'branding');
export const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — large animated GIFs

for (const dir of [AVATARS_DIR, BRANDING_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const ALLOWED_MIME_TYPES = ['image/gif', 'image/png', 'image/jpeg', 'image/webp'];

export type CropParams = {
  zoom: number;
  offsetX: number;
  offsetY: number;
  previewSize: number;
};

export function createImageUpload(fieldName = 'image') {
  return multer({
    storage: multer.diskStorage({
      destination: (_req: any, _file: any, cb: any) => cb(null, AVATARS_DIR),
      filename: (_req: any, file: any, cb: any) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
      },
    }),
    limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES },
    fileFilter: (_req: any, file: any, cb: any) => cb(null, ALLOWED_MIME_TYPES.includes(file.mimetype)),
  }).single(fieldName);
}

export function parseCropParams(body: any, defaultPreviewSize = 240): CropParams | undefined {
  if (!body?.zoom) return undefined;
  return {
    zoom: parseFloat(body.zoom),
    offsetX: parseFloat(body.offsetX || '0'),
    offsetY: parseFloat(body.offsetY || '0'),
    previewSize: parseFloat(body.previewSize || String(defaultPreviewSize)),
  };
}

function computeCropRegion(srcW: number, srcH: number, params: CropParams) {
  const { zoom, offsetX, offsetY, previewSize } = params;
  const aspect = srcW / srcH;

  let dispW: number;
  let dispH: number;
  if (aspect >= 1) {
    dispH = previewSize;
    dispW = previewSize * aspect;
  } else {
    dispW = previewSize;
    dispH = previewSize / aspect;
  }
  dispW *= zoom;
  dispH *= zoom;

  const scaleX = srcW / dispW;
  const scaleY = srcH / dispH;

  const centerX = (dispW / 2 - offsetX) * scaleX;
  const centerY = (dispH / 2 - offsetY) * scaleY;

  const cropW = previewSize * scaleX;
  const cropH = previewSize * scaleY;

  let left = Math.round(centerX - cropW / 2);
  let top = Math.round(centerY - cropH / 2);
  let width = Math.round(cropW);
  let height = Math.round(cropH);

  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (left + width > srcW) width = srcW - left;
  if (top + height > srcH) height = srcH - top;

  return { left, top, width, height };
}

async function cropStaticImage(filePath: string, outputPath: string, cropParams?: CropParams, outSize = 512): Promise<void> {
  const meta = await sharp(filePath).metadata();
  if (!meta.width || !meta.height) throw new Error('Cannot read image dimensions');

  if (cropParams && cropParams.previewSize > 0) {
    const { left, top, width, height } = computeCropRegion(meta.width, meta.height, cropParams);
    await sharp(filePath).extract({ left, top, width, height }).resize(outSize, outSize).png().toFile(outputPath);
    return;
  }

  await sharp(filePath).resize(outSize, outSize, { fit: 'cover' }).png().toFile(outputPath);
}

async function cropGifImage(filePath: string, outputPath: string, cropParams?: CropParams, outSize = 256): Promise<void> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', filePath,
  ]);
  const [srcW, srcH] = stdout.trim().split(',').map(Number);
  if (!srcW || !srcH) throw new Error('Cannot read GIF dimensions');

  let filterChain: string;
  if (cropParams && cropParams.previewSize > 0) {
    const { left, top, width, height } = computeCropRegion(srcW, srcH, cropParams);
    filterChain = `crop=${width}:${height}:${left}:${top},scale=${outSize}:${outSize}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a`;
  } else {
    const minDim = Math.min(srcW, srcH);
    filterChain = `crop=${minDim}:${minDim},scale=${outSize}:${outSize}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a`;
  }

  const tmpPath = outputPath + '.tmp.gif';
  await execFileAsync('ffmpeg', ['-y', '-i', filePath, '-filter_complex', filterChain, '-loop', '0', tmpPath], { timeout: 30000 });
  fs.renameSync(tmpPath, outputPath);
}

export async function processImageToTarget(tempFilePath: string, mimeType: string, targetPathNoExt: string, cropParams?: CropParams, sizes?: { staticSize?: number; gifSize?: number; skipGifCrop?: boolean }) {
  const isGif = mimeType === 'image/gif';
  const ext = isGif ? '.gif' : '.png';
  const outputPath = `${targetPathNoExt}${ext}`;

  if (isGif) {
    if (sizes?.skipGifCrop) {
      fs.copyFileSync(tempFilePath, outputPath);
    } else {
      await cropGifImage(tempFilePath, outputPath, cropParams, sizes?.gifSize ?? 256);
    }
  } else {
    await cropStaticImage(tempFilePath, outputPath, cropParams, sizes?.staticSize ?? 512);
  }

  return { outputPath, ext, isGif };
}

export function cleanupFile(filePath?: string | null) {
  if (!filePath) return;
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

export function cleanupBasenameVariants(dir: string, basenameNoExt: string, keepExt?: string) {
  const exts = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];
  for (const ext of exts) {
    if (keepExt && ext === keepExt) continue;
    cleanupFile(path.join(dir, `${basenameNoExt}${ext}`));
  }
}

/**
 * Remove any files in `dir` that start with `basenamePrefix` and have an image extension.
 * Keeps `keepFilename` if provided. Used for versioned filenames (e.g. portal-logo-<ts>.png).
 */
export function cleanupBasenamePrefixVariants(dir: string, basenamePrefix: string, keepFilename?: string) {
  const exts = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (keepFilename && name === keepFilename) continue;
    if (!name.startsWith(basenamePrefix)) continue;
    if (!exts.some((ext) => name.toLowerCase().endsWith(ext))) continue;
    cleanupFile(path.join(dir, name));
  }
}
