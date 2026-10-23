/**
 * Composer photos reach the model as native image input only when the selected
 * harness advertises it in the harness catalog (`supportsAttachments`). Other
 * harnesses keep receiving photos as ordinary uploaded files. The server still
 * decides per model; this only chooses what the composer offers and sends.
 */

export const NATIVE_PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_NATIVE_PHOTOS = 4;
export const MAX_NATIVE_PHOTO_BYTES = 10 * 1024 * 1024;
export const NATIVE_PHOTO_LIMIT_MESSAGE = 'Attach up to 4 JPEG, PNG, or WebP photos, each no larger than 10 MB.';

export function harnessAcceptsNativePhotos(
  capabilities: { supportsAttachments?: boolean } | null | undefined,
): boolean {
  return capabilities?.supportsAttachments === true;
}

/** Null when the photo can be sent as native image input, else the user-facing reason. */
export function nativePhotoAdmissionError(
  file: { type: string; size: number },
  photosAlreadyAttached: number,
): string | null {
  if (!NATIVE_PHOTO_TYPES.includes(file.type)
    || file.size > MAX_NATIVE_PHOTO_BYTES
    || photosAlreadyAttached >= MAX_NATIVE_PHOTOS) return NATIVE_PHOTO_LIMIT_MESSAGE;
  return null;
}
