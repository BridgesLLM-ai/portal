import { execFile } from 'child_process';
import { buildNativeCliEnvironment } from './providers/native/NativeCliEnvironment';
import { isUnqualifiedNativeBinaryProvider } from '../config/unqualifiedNativeBinaryLane';

export interface AntigravityModelDescriptor { id: string; displayName: string; }
let cache: { expiresAt: number; models: AntigravityModelDescriptor[] } | null = null;
let inFlight: Promise<AntigravityModelDescriptor[]> | null = null;
let generation = 0;
export function invalidateAntigravityModelCache(): void { cache = null; inFlight = null; generation++; }

export function parseAntigravityModelList(output: string): AntigravityModelDescriptor[] {
  const models = new Map<string, AntigravityModelDescriptor>();
  for (const line of String(output || '').split(/\r?\n/)) {
    // Current CLI emits the exact runtime id, a tab, and the display label.
    // Never synthesize model ids from human labels or borrow OpenClaw's catalog.
    const match = line.trim().match(/^([a-z0-9][a-z0-9._-]{0,127})\t+([^\t]+)$/);
    if (match) models.set(match[1], { id: match[1], displayName: match[2].trim() });
  }
  return [...models.values()];
}

export function listAntigravityModelsFromCli(): Promise<AntigravityModelDescriptor[]> {
  if (isUnqualifiedNativeBinaryProvider('GEMINI')) return Promise.resolve([]);
  if (cache && cache.expiresAt > Date.now()) return Promise.resolve(cache.models);
  if (inFlight) return inFlight;
  const startedGeneration = generation;
  const pending = new Promise<AntigravityModelDescriptor[]>((resolve) => {
    execFile('agy', ['models'], {
      env: buildNativeCliEnvironment('GEMINI'), timeout: 12_000, maxBuffer: 512 * 1024,
    }, (error, stdout) => {
      const models = error ? [] : parseAntigravityModelList(String(stdout || ''));
      if (startedGeneration === generation) cache = { expiresAt: Date.now() + (models.length ? 60_000 : 3_000), models };
      resolve(models);
    });
  });
  inFlight = pending;
  void pending.finally(() => { if (inFlight === pending) inFlight = null; });
  return pending;
}
