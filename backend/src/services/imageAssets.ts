import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';

const execFileAsync = promisify(execFile);

export type ImageMediaCommandResult = { stdout: string };
export type ImageMediaCommandRunner = (
  executable: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<ImageMediaCommandResult>;

const runImageMediaCommand: ImageMediaCommandRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, args, options);
  return { stdout: String(result.stdout || '') };
};

export interface ImageAssetStorageOptions {
  assetsRoot?: string;
  avatarsDir?: string;
  brandingDir?: string;
}

export function resolveImageAssetPaths(options: ImageAssetStorageOptions = {}) {
  // Assets live at INSTALL_ROOT/assets, not in an imported module's cwd.
  const assetsRoot = path.resolve(
    options.assetsRoot
      || process.env.PORTAL_ASSETS_ROOT
      || path.join(process.env.INSTALL_ROOT || process.env.PORTAL_ROOT || '/opt/bridgesllm/portal', 'assets'),
  );
  return {
    assetsRoot,
    avatarsDir: path.resolve(options.avatarsDir || process.env.PORTAL_AVATARS_ROOT || path.join(assetsRoot, 'avatars')),
    brandingDir: path.resolve(options.brandingDir || process.env.PORTAL_BRANDING_ROOT || path.join(assetsRoot, 'branding')),
  };
}

const imageAssetPaths = resolveImageAssetPaths();
export const ASSETS_ROOT = imageAssetPaths.assetsRoot;
export const AVATARS_DIR = imageAssetPaths.avatarsDir;
export const BRANDING_DIR = imageAssetPaths.brandingDir;
export const MAX_IMAGE_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — large animated GIFs

export function initializeImageAssetStorage(options: ImageAssetStorageOptions = {}): ReturnType<typeof resolveImageAssetPaths> {
  const paths = Object.keys(options).length > 0 ? resolveImageAssetPaths(options) : imageAssetPaths;
  ensureRuntimeDirectory(paths.avatarsDir, { mode: 0o755 });
  ensureRuntimeDirectory(paths.brandingDir, { mode: 0o755 });
  return paths;
}

const ALLOWED_MIME_TYPES = ['image/gif', 'image/png', 'image/jpeg', 'image/webp'];
const SAFE_RASTER_FORMATS = new Set(['gif', 'jpeg', 'png', 'webp']);
const MAX_BRANDING_INPUT_PIXELS = 4096 * 4096;

export class UnsafeImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeImageUploadError';
  }
}

export const IMAGE_MEDIA_TOOLCHAIN_ERROR_CODE = 'IMAGE_MEDIA_TOOLCHAIN_UNAVAILABLE';
export const IMAGE_MEDIA_TOOLCHAIN_REPAIR_TOOL_ID = 'ffmpeg';
export const IMAGE_MEDIA_TOOLCHAIN_REPAIR_URL = '/agent-tools?tool=ffmpeg';
export const IMAGE_MEDIA_TOOLCHAIN_ERROR_MESSAGE =
  'Animated GIF processing requires FFmpeg, but this Portal host does not have a working ffmpeg/ffprobe toolchain. An administrator can install Media Processing (FFmpeg) from Agent Tools, then retry.';

export class ImageMediaToolchainUnavailableError extends Error {
  readonly code = IMAGE_MEDIA_TOOLCHAIN_ERROR_CODE;

  constructor() {
    super(IMAGE_MEDIA_TOOLCHAIN_ERROR_MESSAGE);
    this.name = 'ImageMediaToolchainUnavailableError';
  }
}

export type ImageUploadFailure = {
  statusCode: number;
  error: string;
  code: string;
  retryable: boolean;
  repairToolId?: string;
  repairUrl?: string;
};

export function classifyImageUploadFailure(error: unknown): ImageUploadFailure | null {
  if (error instanceof ImageMediaToolchainUnavailableError) {
    return {
      statusCode: 503,
      error: error.message,
      code: error.code,
      retryable: true,
      repairToolId: IMAGE_MEDIA_TOOLCHAIN_REPAIR_TOOL_ID,
      repairUrl: IMAGE_MEDIA_TOOLCHAIN_REPAIR_URL,
    };
  }
  if (error instanceof UnsafeImageUploadError) {
    return {
      statusCode: 400,
      error: error.message,
      code: 'INVALID_IMAGE_UPLOAD',
      retryable: false,
    };
  }
  return null;
}

export function isSafeMutableImageAssetPath(requestPath: string): boolean {
  const normalized = String(requestPath || '').replace(/\\/g, '/');
  if (normalized.includes('\0') || normalized.split('/').some((part) => part === '..')) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length !== 2) return false;
  const [bucket, filename] = parts;
  const ext = path.extname(filename).toLowerCase();
  const rasterExts = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);
  if (bucket === 'branding') return rasterExts.has(ext);
  if (bucket === 'avatars') return rasterExts.has(ext) || ext === '.webm';
  return false;
}

export type CropParams = {
  zoom: number;
  offsetX: number;
  offsetY: number;
  previewSize: number;
};

export function createImageUpload(fieldName = 'image') {
  return multer({
    storage: multer.diskStorage({
      destination: (_req: any, _file: any, cb: any) => {
        try {
          initializeImageAssetStorage();
          cb(null, AVATARS_DIR);
        } catch (error) {
          cb(error, AVATARS_DIR);
        }
      },
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

function isMissingImageMediaExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

async function cropGifImage(
  filePath: string,
  outputPath: string,
  cropParams?: CropParams,
  outSize = 256,
  commandRunner: ImageMediaCommandRunner = runImageMediaCommand,
): Promise<void> {
  let stdout = '';
  try {
    ({ stdout } = await commandRunner('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', filePath,
    ]));
  } catch (error) {
    if (isMissingImageMediaExecutable(error)) {
      throw new ImageMediaToolchainUnavailableError();
    }
    throw new UnsafeImageUploadError('The uploaded GIF is corrupt or could not be inspected safely.');
  }
  const [srcW, srcH] = stdout.trim().split(',').map(Number);
  if (
    !Number.isInteger(srcW)
    || !Number.isInteger(srcH)
    || srcW <= 0
    || srcH <= 0
    || srcW * srcH > MAX_BRANDING_INPUT_PIXELS
  ) {
    throw new UnsafeImageUploadError('The uploaded GIF dimensions are invalid or too large.');
  }

  let filterChain: string;
  if (cropParams && cropParams.previewSize > 0) {
    const { left, top, width, height } = computeCropRegion(srcW, srcH, cropParams);
    filterChain = `crop=${width}:${height}:${left}:${top},scale=${outSize}:${outSize}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a`;
  } else {
    const minDim = Math.min(srcW, srcH);
    filterChain = `crop=${minDim}:${minDim},scale=${outSize}:${outSize}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=sierra2_4a`;
  }

  const tmpPath = outputPath + '.tmp.gif';
  try {
    await commandRunner(
      'ffmpeg',
      ['-y', '-i', filePath, '-filter_complex', filterChain, '-loop', '0', tmpPath],
      { timeout: 30000 },
    );
    fs.renameSync(tmpPath, outputPath);
  } catch (error) {
    if (isMissingImageMediaExecutable(error)) {
      throw new ImageMediaToolchainUnavailableError();
    }
    throw new UnsafeImageUploadError('The uploaded GIF could not be processed safely.');
  } finally {
    cleanupFile(tmpPath);
  }
}

export async function processImageToTarget(
  tempFilePath: string,
  mimeType: string,
  targetPathNoExt: string,
  cropParams?: CropParams,
  sizes?: { staticSize?: number; gifSize?: number; skipGifCrop?: boolean },
  dependencies?: { commandRunner?: ImageMediaCommandRunner },
) {
  const isGif = mimeType === 'image/gif';
  const ext = isGif ? '.gif' : '.png';
  const outputPath = `${targetPathNoExt}${ext}`;

  if (isGif) {
    if (sizes?.skipGifCrop) {
      fs.copyFileSync(tempFilePath, outputPath);
    } else {
      await cropGifImage(
        tempFilePath,
        outputPath,
        cropParams,
        sizes?.gifSize ?? 256,
        dependencies?.commandRunner,
      );
    }
  } else {
    await cropStaticImage(tempFilePath, outputPath, cropParams, sizes?.staticSize ?? 512);
  }

  return { outputPath, ext, isGif };
}

/**
 * Decode an untrusted branding upload and emit one static PNG. The decoder's
 * discovered format is authoritative; client MIME and filename are ignored.
 * SVG and other active/document formats are rejected even when mislabeled as
 * image/png.
 */
export async function normalizeBrandingLogoToPng(
  input: Buffer,
  outputPath: string,
  size = 512,
): Promise<void> {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new UnsafeImageUploadError('The uploaded logo is empty.');
  }
  if (!Number.isInteger(size) || size < 64 || size > 1024) {
    throw new UnsafeImageUploadError('The requested logo size is invalid.');
  }
  if (path.extname(outputPath).toLowerCase() !== '.png') {
    throw new UnsafeImageUploadError('Branding output must use the PNG format.');
  }

  const createDecoder = () => sharp(input, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: MAX_BRANDING_INPUT_PIXELS,
    sequentialRead: true,
  });

  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    metadata = await createDecoder().metadata();
  } catch {
    throw new UnsafeImageUploadError('The uploaded logo is not a valid raster image.');
  }

  if (!metadata.format || !SAFE_RASTER_FORMATS.has(metadata.format)) {
    throw new UnsafeImageUploadError('Only PNG, JPEG, WebP, and GIF raster images are supported.');
  }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_BRANDING_INPUT_PIXELS) {
    throw new UnsafeImageUploadError('The uploaded logo dimensions are invalid or too large.');
  }

  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const tempPath = path.join(outputDir, `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await createDecoder()
      .rotate()
      .resize(size, size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true, force: true })
      .toFile(tempPath);
    fs.chmodSync(tempPath, 0o644);
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    cleanupFile(tempPath);
    if (error instanceof UnsafeImageUploadError) throw error;
    throw new UnsafeImageUploadError('The uploaded logo could not be normalized safely.');
  }
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
