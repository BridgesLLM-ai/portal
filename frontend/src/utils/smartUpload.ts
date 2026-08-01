import {
  bindWorkspaceAuthorizationToXhr,
  captureWorkspaceAuthorizationRequestContext,
  workspaceAuthorizedFetch,
  type WorkspaceAuthorizationRequestContext,
} from './workspaceAuthorizedFetch';
import { StaleWorkspaceAuthorizationResponseError } from './workspaceAuthorization';

// Dynamic upload limits — fetched from backend based on proxy detection
export const CONSERVATIVE_SINGLE_UPLOAD_LIMIT = 90 * 1024 * 1024;
export const PORTAL_UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;
export const PORTAL_MAX_CHUNKED_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024;

let SINGLE_UPLOAD_LIMIT = CONSERVATIVE_SINGLE_UPLOAD_LIMIT;
let CHUNK_SIZE = PORTAL_UPLOAD_CHUNK_SIZE;
let MAX_CHUNKED_UPLOAD_SIZE = PORTAL_MAX_CHUNKED_UPLOAD_SIZE;
const BASE_URL = typeof window !== 'undefined' ? window.location.origin : '';

// Fetch actual upload config from server
let uploadConfigLoaded = false;
async function loadUploadConfig() {
  if (uploadConfigLoaded) return;
  try {
    const resp = await workspaceAuthorizedFetch(`${BASE_URL}/api/files/upload-config`, {
      credentials: 'include',
      headers: {},
    });
    if (resp.ok) {
      const config = await resp.json();
      if (!Number.isSafeInteger(config.singleUploadLimit) || config.singleUploadLimit <= 0) return;
      if (!Number.isSafeInteger(config.chunkSize) || config.chunkSize <= 0) return;
      if (!Number.isSafeInteger(config.maxChunkedUploadSize) || config.maxChunkedUploadSize <= 0) return;
      SINGLE_UPLOAD_LIMIT = config.singleUploadLimit;
      CHUNK_SIZE = config.chunkSize;
      MAX_CHUNKED_UPLOAD_SIZE = config.maxChunkedUploadSize;
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

export function chooseUploadRoute(
  fileSize: number,
  singleUploadLimit = SINGLE_UPLOAD_LIMIT,
  maxChunkedUploadSize = MAX_CHUNKED_UPLOAD_SIZE,
): 'direct' | 'chunked' {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new Error('Invalid file size');
  if (fileSize > maxChunkedUploadSize) {
    throw new Error(`File exceeds the ${formatBytes(maxChunkedUploadSize)} upload limit`);
  }
  return fileSize <= singleUploadLimit ? 'direct' : 'chunked';
}

export function directUploadErrorMessage(responseText: string, status: number): string {
  const fallback = status > 0 ? `Upload failed (${status})` : 'Upload failed';
  try {
    const payload = JSON.parse(responseText || '{}');
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
  } catch {
    // The upload route normally returns JSON, but a proxy may return an HTML/plain-text error.
  }
  return fallback;
}

export function smartUpload(file: File, callbacks: UploadCallbacks = {}): { promise: Promise<any>; controller: UploadController } {
  const authorizationContext = captureWorkspaceAuthorizationRequestContext();
  let paused = false;
  let cancelled = false;
  let currentXHR: XMLHttpRequest | null = null;
  let pauseResolve: (() => void) | null = null;
  let uploadId: string | null = null;
  let errorReported = false;

  const reportError = (error: Error) => {
    if (errorReported) return;
    errorReported = true;
    callbacks.onError?.(error);
  };
  const managedCallbacks: UploadCallbacks = { ...callbacks, onError: reportError };

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
        workspaceAuthorizedFetch(`${BASE_URL}/api/upload/${uploadId}`, {
          method: 'DELETE',
          credentials: 'include',
        }, authorizationContext).catch(() => {});
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
    if (cancelled) throw new Error('Upload cancelled');
    const route = chooseUploadRoute(file.size);
    if (route === 'direct') {
      callbacks.onRouteChange?.('direct');
      return uploadViaXHR(
        file,
        BASE_URL,
        'direct',
        managedCallbacks,
        ctrl => currentXHR = ctrl,
        authorizationContext,
      );
    }

    if (cancelled) throw new Error('Upload cancelled');

    // Large file: chunked upload (each chunk within limit)
    callbacks.onRouteChange?.('chunked');
    return await uploadChunked(
      file,
      BASE_URL,
      managedCallbacks,
      (id) => { uploadId = id; },
      waitIfPaused,
      () => cancelled,
      authorizationContext,
    );
  })().catch((error) => {
    const normalized = error instanceof Error ? error : new Error(String(error || 'Upload failed'));
    reportError(normalized);
    throw normalized;
  });

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
  authorizationContext: WorkspaceAuthorizationRequestContext | null,
  timeoutMs?: number
): Promise<any> {
  const formData = new FormData();
  formData.append('file', file);
  const xhr = new XMLHttpRequest();
  let authorizationBinding: ReturnType<typeof bindWorkspaceAuthorizationToXhr> | null = null;
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
      try {
        authorizationBinding?.validateResponse();
      } catch (error) {
        authorizationBinding?.dispose();
        reject(error);
        return;
      }
      authorizationBinding?.dispose();
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
        const error = new Error(directUploadErrorMessage(xhr.responseText, xhr.status));
        callbacks.onError?.(error);
        reject(error);
      }
    });

    xhr.addEventListener('error', () => {
      authorizationBinding?.dispose();
      const e = new Error('Network error');
      callbacks.onError?.(e);
      reject(e);
    });
    xhr.addEventListener('abort', () => {
      authorizationBinding?.dispose();
      const error = new Error('Upload cancelled');
      callbacks.onError?.(error);
      reject(error);
    });
    xhr.addEventListener('timeout', () => {
      authorizationBinding?.dispose();
      const e = new Error('Upload timeout');
      callbacks.onError?.(e);
      reject(e);
    });

    xhr.open('POST', `${baseUrl}/api/files`);
    authorizationBinding = bindWorkspaceAuthorizationToXhr(xhr, authorizationContext);
    xhr.timeout = timeoutMs || 30 * 60 * 1000; // default 30 min
    xhr.send(formData);
  });
}

async function uploadChunked(
  file: File, baseUrl: string, callbacks: UploadCallbacks,
  setUploadId: (id: string) => void,
  waitIfPaused: () => Promise<void>,
  isCancelled: () => boolean,
  authorizationContext: WorkspaceAuthorizationRequestContext | null,
): Promise<any> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const startTime = Date.now();

  // Init
  const initResp = await workspaceAuthorizedFetch(`${baseUrl}/api/upload/init`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, totalChunks }),
  }, authorizationContext);
  if (!initResp.ok) throw new Error(await readUploadError(initResp, 'Failed to initialize chunked upload'));
  const { uploadId } = await initResp.json();
  setUploadId(uploadId);
  if (isCancelled()) {
    await workspaceAuthorizedFetch(`${baseUrl}/api/upload/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
      credentials: 'include',
    }, authorizationContext).catch(() => undefined);
    throw new Error('Upload cancelled');
  }

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
      if (isCancelled()) throw new Error('Upload cancelled');
      try {
        const resp = await workspaceAuthorizedFetch(`${baseUrl}/api/upload/chunk`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'x-upload-id': uploadId,
            'x-chunk-index': i.toString(),
            'Content-Type': 'application/octet-stream',
          },
          body: chunk,
        }, authorizationContext);
        if (!resp.ok) throw new Error(await readUploadError(resp, `Chunk ${i + 1} failed`));
        break;
      } catch (e) {
        if (isCancelled()) throw new Error('Upload cancelled');
        if (e instanceof StaleWorkspaceAuthorizationResponseError
            || (e as { name?: unknown })?.name === 'AbortError') {
          throw e;
        }
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
  const completeResp = await workspaceAuthorizedFetch(`${baseUrl}/api/upload/complete`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  }, authorizationContext);
  if (!completeResp.ok) throw new Error(await readUploadError(completeResp, 'Failed to complete upload'));
  const result = await completeResp.json();
  callbacks.onComplete?.(result);
  return result;
}

async function readUploadError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.clone().json();
    if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
  } catch {}
  return `${fallback} (${response.status})`;
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
