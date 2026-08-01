import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  chooseUploadRoute,
  CONSERVATIVE_SINGLE_UPLOAD_LIMIT,
  directUploadErrorMessage,
  PORTAL_MAX_CHUNKED_UPLOAD_SIZE,
  PORTAL_UPLOAD_CHUNK_SIZE,
  smartUpload,
} from './smartUpload';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('smartUpload policy', () => {
  test('uses server-compatible conservative defaults before config loads', () => {
    expect(PORTAL_UPLOAD_CHUNK_SIZE).toBe(5 * 1024 * 1024);
    expect(CONSERVATIVE_SINGLE_UPLOAD_LIMIT).toBeLessThan(100 * 1024 * 1024);
    expect(chooseUploadRoute(CONSERVATIVE_SINGLE_UPLOAD_LIMIT)).toBe('direct');
    expect(chooseUploadRoute(CONSERVATIVE_SINGLE_UPLOAD_LIMIT + 1)).toBe('chunked');
  });

  test('rejects files above the server contract before starting an upload', () => {
    expect(() => chooseUploadRoute(PORTAL_MAX_CHUNKED_UPLOAD_SIZE + 1)).toThrow(/upload limit/);
    expect(() => chooseUploadRoute(Number.NaN)).toThrow(/Invalid file size/);
  });

  test('surfaces the backend upload rejection instead of a stale generic limit', () => {
    expect(directUploadErrorMessage(JSON.stringify({ error: 'Virus scanner unavailable; upload rejected' }), 503))
      .toBe('Virus scanner unavailable; upload rejected');
    expect(directUploadErrorMessage('<html>proxy error</html>', 413)).toBe('Upload failed (413)');
    expect(directUploadErrorMessage('', 0)).toBe('Upload failed');
  });

  test('reports chunk initialization failures exactly once through the UI callback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Upload storage is unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onError = vi.fn();
    const file = {
      name: 'large.bin',
      size: CONSERVATIVE_SINGLE_UPLOAD_LIMIT + 1,
      slice: vi.fn(),
    } as unknown as File;

    const { promise } = smartUpload(file, { onError });
    await expect(promise).rejects.toThrow('Upload storage is unavailable');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
