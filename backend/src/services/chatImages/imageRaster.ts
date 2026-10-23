/** Fail-closed host wrapper; worker diagnostics and pixels never enter logs. */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { runSandboxed, SandboxUnavailableError } from './chatImageSandbox';
import { IMAGE_RASTER_LIMITS, IMAGE_RASTER_VERSION, type RasterOutput } from './imageRasterContract';
import { sandboxReadableModules } from './rasterModules';

export interface RasterRuntime { appDir: string; script: string; modulesDir?: string }
export class ImagePreparationError extends Error {
  readonly brokerStatus: number;
  constructor(readonly code: string) {
    super('Photo pixels are unavailable: validation, resource, scan, or sandbox prerequisites were not met. Other attachments are unchanged.');
    this.brokerStatus = code === 'CHAT_IMAGE_SANDBOX_UNAVAILABLE' ? 503 : 422;
  }
}
export function rasterRuntimeFromBuild(): RasterRuntime | null {
  const compiled = path.join(__dirname, 'imageRasterWorker.js');
  if (!fs.existsSync(compiled)) return null;
  const appDir = __dirname;
  let modulesDir: string;
  try {
    // Installed node_modules is root-only; the nobody-owned worker gets a readable copy of sharp's closure.
    modulesDir = sandboxReadableModules(fs.realpathSync(path.resolve(__dirname, '../../../node_modules')));
  } catch {
    return null;
  }
  return { appDir, script: path.join('/mnt/app', path.relative(appDir, compiled)), modulesDir };
}
const outputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), mimeType: z.literal('image/jpeg'), version: z.literal(IMAGE_RASTER_VERSION),
    data: z.string().min(4).max(4 * Math.ceil(IMAGE_RASTER_LIMITS.outputBytes / 3)).regex(/^[A-Za-z0-9+/]*={0,2}$/),
    width: z.number().int().min(1).max(IMAGE_RASTER_LIMITS.outputSide), height: z.number().int().min(1).max(IMAGE_RASTER_LIMITS.outputSide) }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['CHAT_IMAGE_UNSUPPORTED', 'CHAT_IMAGE_LIMIT', 'CHAT_IMAGE_CORRUPT']) }).strict(),
]);

/**
 * Structural validation of our single-frame baseline JPEG derivative.
 * Full entropy decoding happens in the constrained worker, not the host.
 * Reject metadata/extensions and dimensions inconsistent with the envelope.
 */
export function validateRasterJpeg(bytes: Buffer, width: number, height: number): boolean {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return false;
  let offset = 2, frame = false, scan = false, entropy = 0;
  while (offset < bytes.length) {
    if (scan && bytes[offset] !== 255) { entropy++; offset++; continue; }
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (scan && marker === 0) { entropy++; continue; }
    if (scan && marker >= 208 && marker <= 215) continue;
    if (scan) return marker === 217 && entropy > 0 && offset === bytes.length;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    const part = bytes.subarray(offset + 2, offset + length); offset += length;
    if (marker === 192) {
      if (frame || part.length !== 15 || part[0] !== 8 || part[5] !== 3
        || part.readUInt16BE(1) !== height || part.readUInt16BE(3) !== width
        || width < 1 || height < 1 || width > IMAGE_RASTER_LIMITS.outputSide || height > IMAGE_RASTER_LIMITS.outputSide) return false;
      frame = true;
    } else if (marker === 218) {
      if (!frame || part.length !== 10 || part[0] !== 3
        || part[7] !== 0 || part[8] !== 63 || part[9] !== 0) return false;
      scan = true;
    } else if (marker === 224) {
      if (part.length !== 14 || !part.subarray(0, 5).equals(Buffer.from('JFIF\0')) || part[12] !== 0 || part[13] !== 0) return false;
    } else if (![219, 196].includes(marker)) return false; // quantization/Huffman only; no EXIF/ICC/XMP/comments
  }
  return false;
}

let activeWorkers = 0;
export async function prepareColorRaster(runtime: RasterRuntime | null, bytes: Buffer): Promise<Extract<RasterOutput, { ok: true }>> {
  if (activeWorkers >= 2) throw new ImagePreparationError('CHAT_IMAGE_BUSY');
  activeWorkers++;
  try { return await prepareBoundedRaster(runtime, bytes); }
  finally { activeWorkers--; }
}
async function prepareBoundedRaster(runtime: RasterRuntime | null, bytes: Buffer): Promise<Extract<RasterOutput, { ok: true }>> {
  if (!runtime) throw new ImagePreparationError('CHAT_IMAGE_SANDBOX_UNAVAILABLE');
  if (!bytes.length || bytes.length > IMAGE_RASTER_LIMITS.inputBytes) throw new ImagePreparationError('CHAT_IMAGE_LIMIT');
  const binds = [{ source: runtime.appDir, name: 'app' }];
  if (runtime.modulesDir) binds.push({ source: runtime.modulesDir, name: 'modules' });
  let result;
  try {
    result = await runSandboxed({ script: runtime.script, binds,
      ...(runtime.modulesDir ? { nodePath: '/mnt/modules' } : {}), input: bytes,
      timeoutMs: 15_000, cpuSeconds: 10, dataBytes: 1536 * 1024 * 1024,
      heapMegabytes: 128, maxOutputBytes: 4 * Math.ceil(IMAGE_RASTER_LIMITS.outputBytes / 3) + 1024 });
  } catch (error) {
    if (error instanceof SandboxUnavailableError) throw new ImagePreparationError('CHAT_IMAGE_SANDBOX_UNAVAILABLE');
    throw new ImagePreparationError('CHAT_IMAGE_PREPARATION_FAILED');
  }
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
    const setup = /mount:|setpriv:|unshare:|prlimit:/.test(result.stderrTail);
    throw new ImagePreparationError(setup ? 'CHAT_IMAGE_SANDBOX_UNAVAILABLE' : 'CHAT_IMAGE_PREPARATION_FAILED');
  }
  let parsed;
  try { parsed = outputSchema.safeParse(JSON.parse(result.stdout.toString('utf8'))); } catch { /* fail closed below */ }
  if (!parsed?.success) throw new ImagePreparationError('CHAT_IMAGE_PREPARATION_FAILED');
  if (!parsed.data.ok) throw new ImagePreparationError(parsed.data.code);
  const output = parsed.data;
  const decoded = Buffer.from(output.data, 'base64');
  if (decoded.length > IMAGE_RASTER_LIMITS.outputBytes || decoded.toString('base64') !== output.data
    || !validateRasterJpeg(decoded, output.width, output.height)) {
    throw new ImagePreparationError('CHAT_IMAGE_PREPARATION_FAILED');
  }
  return output;
}
