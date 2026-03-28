// Dynamic upload limits — fetched from backend based on proxy detection
let SINGLE_UPLOAD_LIMIT = 500 * 1024 * 1024; // default 500MB (no proxy)
let CHUNK_SIZE = 50 * 1024 * 1024; // default 50MB chunks
const BASE_URL = window.location.origin;

// Fetch actual upload config from server
let uploadConfigLoaded = false;
async function loadUploadConfig() {
  if (uploadConfigLoaded) return;
  try {
    const resp = await fetch(`${BASE_URL}/api/files/upload-config`, {
      credentials: 'include',
      headers: {},
    });
    if (resp.ok) {
      const config = await resp.json();
      SINGLE_UPLOAD_LIMIT = config.singleUploadLimit;
      CHUNK_SIZE = config.chunkSize;
      uploadConfigLoaded = true;
    }
  } catch {
    // Fall back to defaults
  }
}

export interface UploadProgress {
  loaded: number;
  total: number;
  percentage: number;
  speed: number; // bytes/sec
  eta: number; // seconds
  route: 'direct' | 'chunked' | 'tailscale';
  chunksCompleted?: number;
  chunksTotal?: number;
}

export interface UploadCallbacks {
  onProgress?: (progress: UploadProgress) => void;
  onComplete?: (response: any) => void;
  onError?: (error: Error) => void;
  onRouteChange?: (route: string) => void;
}

export interface UploadController {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  isPaused: () => boolean;
}

function getToken() {
  return '';
}

export function smartUpload(file: File, callbacks: UploadCallbacks = {}): { promise: Promise<any>; controller: UploadController } {
  let paused = false;
  let cancelled = false;
  let currentXHR: XMLHttpRequest | null = null;
  let pauseResolve: (() => void) | null = null;
  let uploadId: string | null = null;

  const controller: UploadController = {
    pause: () => { paused = true; },
    resume: () => {
      paused = false;
      if (pauseResolve) { pauseResolve(); pauseResolve = null; }
    },
    cancel: () => {
      cancelled = true;
      paused = false;
      if (pauseResolve) { pauseResolve(); pauseResolve = null; }
      if (currentXHR) currentXHR.abort();
      // Cancel server-side session if chunked
      if (uploadId) {
        fetch(`${BASE_URL}/api/upload/${uploadId}`, {
          method: 'DELETE',
          credentials: 'include',
        }).catch(() => {});
      }
    },
    isPaused: () => paused,
  };

  const waitIfPaused = () => new Promise<void>(resolve => {
    if (!paused) return resolve();
    pauseResolve = resolve;
  });

  const promise = (async () => {
    await loadUploadConfig();
    if (file.size <= SINGLE_UPLOAD_LIMIT) {
      callbacks.onRouteChange?.('direct');
      return uploadViaXHR(file, BASE_URL, 'direct', callbacks, ctrl => currentXHR = ctrl);
    }

    if (cancelled) throw new Error('Upload cancelled');

    // Large file: chunked upload (each chunk within limit)
    callbacks.onRouteChange?.('chunked');
    return await uploadChunked(file, BASE_URL, callbacks, (id) => { uploadId = id; }, waitIfPaused, () => cancelled);
  })();

  return { promise, controller };
}

// Legacy compat: simple async interface (no pause/resume)
export async function smartUploadSimple(file: File, callbacks: UploadCallbacks = {}): Promise<any> {
  const { promise } = smartUpload(file, callbacks);
  return promise;
}

function uploadViaXHR(
  file: File, baseUrl: string, route: UploadProgress['route'],
  callbacks: UploadCallbacks, setXHR: (xhr: XMLHttpRequest) => void,
  timeoutMs?: number
): Promise<any> {
  const formData = new FormData();
  formData.append('file', file);
  const xhr = new XMLHttpRequest();
  setXHR(xhr);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && callbacks.onProgress) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? e.loaded / elapsed : 0;
        const eta = speed > 0 ? (e.total - e.loaded) / speed : 0;
        callbacks.onProgress({ loaded: e.loaded, total: e.total, percentage: (e.loaded / e.total) * 100, speed, eta, route });
      }
    });

    // Ensure we emit at least an initial progress event for small/fast uploads
    xhr.upload.addEventListener('loadstart', () => {
      callbacks.onProgress?.({ loaded: 0, total: file.size, percentage: 0, speed: 0, eta: 0, route });
    });

    // Emit 100% when upload body is fully sent (before server responds)
    xhr.upload.addEventListener('load', () => {
      callbacks.onProgress?.({ loaded: file.size, total: file.size, percentage: 100, speed: 0, eta: 0, route });
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          callbacks.onComplete?.(response);
          resolve(response);
        } catch {
          callbacks.onComplete?.(xhr.responseText);
          resolve(xhr.responseText);
        }
      } else {
        const error = new Error(`Upload failed: ${xhr.status}`);
        callbacks.onError?.(error);
        reject(error);
      }
    });

    xhr.addEventListener('error', () => { const e = new Error('Network error'); callbacks.onError?.(e); reject(e); });
    xhr.addEventListener('abort', () => { reject(new Error('Upload cancelled')); });
    xhr.addEventListener('timeout', () => { const e = new Error('Upload timeout'); callbacks.onError?.(e); reject(e); });

    xhr.open('POST', `${baseUrl}/api/files`);
    xhr.timeout = timeoutMs || 30 * 60 * 1000; // default 30 min
    xhr.send(formData);
  });
}

async function uploadChunked(
  file: File, baseUrl: string, callbacks: UploadCallbacks,
  setUploadId: (id: string) => void,
  waitIfPaused: () => Promise<void>,
  isCancelled: () => boolean,
): Promise<any> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const startTime = Date.now();

  // Init
  const initResp = await fetch(`${baseUrl}/api/upload/init`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, totalChunks }),
  });
  if (!initResp.ok) throw new Error('Failed to init chunked upload');
  const { uploadId } = await initResp.json();
  setUploadId(uploadId);

  // Upload chunks with retry
  for (let i = 0; i < totalChunks; i++) {
    if (isCancelled()) throw new Error('Upload cancelled');
    await waitIfPaused();
    if (isCancelled()) throw new Error('Upload cancelled');

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = await file.slice(start, end).arrayBuffer();

    let retries = 3;
    while (retries > 0) {
      try {
        const resp = await fetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'x-upload-id': uploadId,
            'x-chunk-index': i.toString(),
            'Content-Type': 'application/octet-stream',
          },
          body: chunk,
        });
        if (!resp.ok) throw new Error(`Chunk ${i} failed: ${resp.status}`);
        break;
      } catch (e) {
        retries--;
        if (retries === 0) { callbacks.onError?.(e as Error); throw e; }
        await new Promise(r => setTimeout(r, 1000 * (4 - retries))); // backoff
      }
    }

    if (callbacks.onProgress) {
      const loaded = end;
      const elapsed = (Date.now() - startTime) / 1000;
      const speed = elapsed > 0 ? loaded / elapsed : 0;
      const eta = speed > 0 ? (file.size - loaded) / speed : 0;
      callbacks.onProgress({
        loaded, total: file.size, percentage: (loaded / file.size) * 100,
        speed, eta, route: 'chunked', chunksCompleted: i + 1, chunksTotal: totalChunks,
      });
    }
  }

  // Complete
  const completeResp = await fetch(`${baseUrl}/api/upload/complete`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  });
  if (!completeResp.ok) throw new Error('Failed to complete upload');
  const result = await completeResp.json();
  callbacks.onComplete?.(result);
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatSpeed(bytesPerSecond: number): string {
  return formatBytes(bytesPerSecond) + '/s';
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
