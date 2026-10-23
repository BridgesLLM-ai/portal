export const IMAGE_RASTER_LIMITS = {
  inputBytes: 10 * 1024 * 1024, inputPixels: 40_000_000, inputSide: 16_000,
  outputBytes: 1024 * 1024, outputSide: 1024,
} as const;
export const IMAGE_RASTER_VERSION = 'portal-color-raster/1';
export type RasterOutput =
  | { ok: true; mimeType: 'image/jpeg'; data: string; width: number; height: number; version: typeof IMAGE_RASTER_VERSION }
  | { ok: false; code: 'CHAT_IMAGE_UNSUPPORTED' | 'CHAT_IMAGE_LIMIT' | 'CHAT_IMAGE_CORRUPT' };
