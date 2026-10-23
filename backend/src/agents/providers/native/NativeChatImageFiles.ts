import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { NativeChatImage } from '../../../services/chatImages/directChatImages';
import { IMAGE_RASTER_LIMITS } from '../../../services/chatImages/imageRasterContract';

/**
 * Root-only, per-run photo files for harnesses that take image paths (Codex
 * `-i <file>`). Files exist only while their run is live; the owning provider
 * removes the run directory on every settlement path.
 */

export const NATIVE_CHAT_IMAGE_RUNTIME_ROOT = '/run/bridgesllm/chat-images';
const MAX_IMAGES_PER_RUN = 4;

let runtimeRoot = NATIVE_CHAT_IMAGE_RUNTIME_ROOT;

export function __configureNativeChatImageFilesForTests(root: string | null): void {
  runtimeRoot = root || NATIVE_CHAT_IMAGE_RUNTIME_ROOT;
}

function runDirectory(runId: string): string {
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('Chat image run identity is invalid');
  // The run id is server-owned but free-form; the directory name never is.
  const digest = crypto.createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32);
  return path.join(runtimeRoot, digest);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const current of [path.dirname(directory), directory]) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Chat image runtime path is not a directory');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Chat image runtime path has an unexpected owner');
    }
    if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(current, 0o700);
  }
}

/** Write the run's prepared JPEGs (0600) and return their absolute paths in order. */
export function writeNativeChatImageFiles(runId: string, images: readonly NativeChatImage[]): string[] {
  if (images.length === 0) return [];
  if (images.length > MAX_IMAGES_PER_RUN) throw new Error('Too many chat photos for one run');
  const directory = runDirectory(runId);
  ensurePrivateDirectory(directory);
  return images.map((image, index) => {
    if (image?.type !== 'image' || image.mimeType !== 'image/jpeg' || typeof image.content !== 'string') {
      throw new Error('Chat photo is not a prepared JPEG');
    }
    const bytes = Buffer.from(image.content, 'base64');
    if (bytes.length < 4 || bytes.length > IMAGE_RASTER_LIMITS.outputBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new Error('Chat photo is not a prepared JPEG');
    }
    const file = path.join(directory, `photo-${index + 1}.jpg`);
    try { fs.unlinkSync(file); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    return file;
  });
}

/** Remove the run's photo directory. Safe to call repeatedly and when nothing was written. */
export function removeNativeChatImageFiles(runId: string): void {
  let directory: string;
  try {
    directory = runDirectory(runId);
  } catch {
    return;
  }
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: /run is tmpfs and never outlives a boot.
  }
}
