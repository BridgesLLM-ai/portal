import { describe, expect, it } from 'vitest';
import { harnessAcceptsNativePhotos, NATIVE_PHOTO_LIMIT_MESSAGE, nativePhotoAdmissionError } from './chatPhotoAdmission';

const photo = (type: string, size = 1024) => ({ type, size });

describe('composer photo admission by harness capability', () => {
  it('follows the harness catalog, not the harness name', () => {
    expect(harnessAcceptsNativePhotos({ supportsAttachments: true })).toBe(true);
    expect(harnessAcceptsNativePhotos({ supportsAttachments: false })).toBe(false);
    expect(harnessAcceptsNativePhotos({})).toBe(false);
    expect(harnessAcceptsNativePhotos(undefined)).toBe(false);
  });

  it('keeps the JPEG, PNG and WebP, four photo and 10 MB rules', () => {
    expect(nativePhotoAdmissionError(photo('image/jpeg'), 0)).toBeNull();
    expect(nativePhotoAdmissionError(photo('image/png'), 3)).toBeNull();
    expect(nativePhotoAdmissionError(photo('image/webp', 10 * 1024 * 1024), 0)).toBeNull();
    expect(nativePhotoAdmissionError(photo('image/gif'), 0)).toBe(NATIVE_PHOTO_LIMIT_MESSAGE);
    expect(nativePhotoAdmissionError(photo('image/jpeg', 10 * 1024 * 1024 + 1), 0)).toBe(NATIVE_PHOTO_LIMIT_MESSAGE);
    expect(nativePhotoAdmissionError(photo('image/jpeg'), 4)).toBe(NATIVE_PHOTO_LIMIT_MESSAGE);
  });
});
