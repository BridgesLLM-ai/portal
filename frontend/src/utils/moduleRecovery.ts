import { lazy as reactLazy, type ComponentType } from 'react';

/** The Portal version this bundle was built from (vite.config.ts `define`). */
declare const __PORTAL_BUILD_VERSION__: string | undefined;
export const PORTAL_MODULE_UPDATE_EVENT = 'portal:module-update-required';
const HEALTH_TIMEOUT_MS = 5_000;
let versionProbe: Promise<boolean> | null = null;

export function isModuleLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|unable to preload css|loading chunk \d+ failed/i.test(message);
}

function buildVersion(): string | null {
  return typeof __PORTAL_BUILD_VERSION__ === 'string' && __PORTAL_BUILD_VERSION__ ? __PORTAL_BUILD_VERSION__ : null;
}

/**
 * True only when the server's /health names a different Portal release than
 * this bundle. A degraded server still reports its release; an unreachable or
 * malformed health reply proves nothing and returns false.
 */
async function deploymentChanged(): Promise<boolean> {
  if (!versionProbe) {
    versionProbe = (async () => {
      const built = buildVersion();
      if (!built) return false;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      try {
        const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) return false;
        const health = await response.json();
        return (health?.status === 'ok' || health?.status === 'degraded')
          && typeof health.version === 'string'
          && /^\d+\.\d+\.\d+$/.test(health.version)
          && health.version !== built;
      } catch {
        return false;
      } finally {
        window.clearTimeout(timeout);
      }
    })().finally(() => { versionProbe = null; });
  }
  return versionProbe;
}

/**
 * React.lazy for views that may be requested after a Portal update. When the
 * old bundle's chunk is gone because the server now runs a newer release, the
 * open tab keeps everything mounted (drafts included) and asks the user to
 * reload; it never reloads by itself. A missing chunk in the current build, a
 * programming error or an unreachable health check still throws to the error
 * boundary.
 */
export function lazyWithRecovery<T extends ComponentType<any>>(loader: () => Promise<{ default: T }>) {
  return reactLazy<T>(async () => {
    try {
      return await loader();
    } catch (error) {
      if (isModuleLoadFailure(error) && await deploymentChanged()) {
        window.dispatchEvent(new Event(PORTAL_MODULE_UPDATE_EVENT));
        // Stay suspended: Suspense keeps the mounted tree, an error boundary would not.
        return new Promise<{ default: T }>(() => {});
      }
      throw error;
    }
  });
}
