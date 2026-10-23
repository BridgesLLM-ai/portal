/** Public Files photos: fresh ownership, scan, descriptor identity and model checks on every send. */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { prisma } from '../../config/database';
import type { SenderIdentity } from '../../agents/AgentProvider.interface';
import { openContainedRegularFile } from '../containedPath';
import { scanBuffer } from '../virusScan';
import { prepareColorRaster, rasterRuntimeFromBuild } from './imageRaster';
import { IMAGE_RASTER_LIMITS } from './imageRasterContract';
import { ChatImageError } from './chatImageModelPolicy';
import { OPENCLAW_MEDIA_MIRROR_BASE } from '../openclawMediaMirror';

export type NativeChatImage = { type: 'image'; mimeType: 'image/jpeg'; content: string; fileName: string;
  sizeBytes: number; width: number; height: number };
export const chatImageReferenceSchema = z.object({ fileId: z.string().uuid(), revision: z.string().datetime() }).strict();
export type ChatImageReference = z.infer<typeof chatImageReferenceSchema>;
const MARKER = '[portal-chat-image:';
export function parseChatImageReferences(message: string): ChatImageReference[] {
  const matches = [...message.matchAll(/^\[portal-chat-image:(\{[^\r\n]{1,256}\})\]$/gm)];
  if ((message.split(MARKER).length - 1) !== matches.length) throw new ChatImageError('IMAGE_REFERENCE_INVALID', 400);
  if (matches.length > 4) throw new ChatImageError('IMAGE_COUNT_LIMIT', 400);
  const references = matches.map(match => {
    try { return chatImageReferenceSchema.parse(JSON.parse(match[1])); }
    catch { throw new ChatImageError('IMAGE_REFERENCE_INVALID', 400); }
  });
  if (new Set(references.map(ref => ref.fileId)).size !== references.length) throw new ChatImageError('IMAGE_REFERENCE_INVALID', 400);
  return references;
}
export function stripChatImageReferences(message: string): string {
  return message.replace(/^\[portal-chat-image:\{[^\r\n]{1,256}\}\]\r?\n?/gm, '').trim();
}
export interface ChatImageDependencies {
  db: typeof prisma; scan: typeof scanBuffer; prepare: (bytes: Buffer) => ReturnType<typeof prepareColorRaster>; filesRoot: string;
  /** OpenClaw tool mirror root; its same-inode copy of an upload is the one extra link a Files photo may carry. */
  mirrorRoot?: string;
}
const defaults: ChatImageDependencies = { db: prisma, scan: scanBuffer,
  prepare: bytes => prepareColorRaster(rasterRuntimeFromBuild(), bytes),
  filesRoot: path.resolve(process.env.PORTAL_FILES_ROOT || '/var/portal-files'), mirrorRoot: OPENCLAW_MEDIA_MIRROR_BASE };
const digest = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
// Files keeps one hard link per upload in the OpenClaw tool mirror (routes/files.ts ensureToolMirror).
// Accept that exact twin as the only extra link; any other link still means the file is shared elsewhere.
function isToolMirrorTwin(stat: fs.BigIntStats, userId: string, filePath: string, mirrorRoot?: string): boolean {
  if (!mirrorRoot) return false;
  try {
    const twin = fs.lstatSync(path.join(mirrorRoot, `user-${userId}`, 'uploads', path.basename(filePath)), { bigint: true });
    return twin.isFile() && twin.dev === stat.dev && twin.ino === stat.ino;
  } catch { return false; }
}
const identity = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');

async function readAuthorizedPhoto(reference: ChatImageReference, sender: SenderIdentity, dependencies: ChatImageDependencies) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sender.userId)) throw new ChatImageError('IMAGE_ACTOR_DENIED', 403);
  const actor = await dependencies.db.user.findUnique({ where: { id: sender.userId },
    select: { isActive: true, accountStatus: true, role: true, authorizationVersion: true } });
  if (!actor?.isActive || actor.accountStatus !== 'ACTIVE' || !['OWNER', 'SUB_ADMIN'].includes(actor.role)
    || actor.authorizationVersion !== sender.authorizationVersion) throw new ChatImageError('IMAGE_ACTOR_DENIED', 403);
  const file = await dependencies.db.file.findFirst({ where: { id: reference.fileId, userId: sender.userId } });
  if (!file || file.userId !== sender.userId || file.updatedAt.toISOString() !== reference.revision) throw new ChatImageError('IMAGE_FILE_DENIED', 403);
  let fd: number | undefined;
  try {
    ({ fd } = openContainedRegularFile(path.join(dependencies.filesRoot, `user-${sender.userId}`, 'uploads'), file.path));
    const before = fs.fstatSync(fd, { bigint: true });
    if (before.nlink !== 1n
      && !(before.nlink === 2n && isToolMirrorTwin(before, sender.userId, file.path, dependencies.mirrorRoot))) {
      throw new ChatImageError('IMAGE_FILE_DENIED', 403);
    }
    if (before.size < 1n || before.size > BigInt(IMAGE_RASTER_LIMITS.inputBytes)
      || before.size !== file.size) throw new ChatImageError('IMAGE_SIZE_LIMIT');
    // Bounded read: a concurrently growing file cannot cause an unbounded allocation.
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0, read = 1;
    while (read && length < bytes.length) { read = fs.readSync(fd, bytes, length, bytes.length - length, null); length += read; }
    if (length !== Number(before.size) || identity(before) !== identity(fs.fstatSync(fd, { bigint: true }))) throw new ChatImageError('IMAGE_CHANGED');
    const original = bytes.subarray(0, length);
    return { bytes: original, revision: digest(identity(before) + ':' + digest(original)) };
  } catch (error) {
    if (error instanceof ChatImageError) throw error;
    throw new ChatImageError('IMAGE_FILE_DENIED', 403);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export interface PreparedChatImageInput {
  message: string; images: NativeChatImage[]; model: string;
  /** Runtime owner must await this immediately before the originating socket write. */
  revalidate(): Promise<void>;
}
export async function prepareChatImages(input: { message: string; sender?: SenderIdentity; assertModel(): Promise<string> },
  dependencies = defaults): Promise<PreparedChatImageInput | null> {
  const references = parseChatImageReferences(input.message);
  if (!references.length) return null;
  if (!input.sender) throw new ChatImageError('IMAGE_ACTOR_DENIED', 403);
  const sender = input.sender;
  const model = await input.assertModel();
  const originals: string[] = [];
  const images: NativeChatImage[] = [];
  for (const reference of references) {
    const original = await readAuthorizedPhoto(reference, sender, dependencies);
    originals.push(original.revision);
    const scan = await dependencies.scan(original.bytes, 'chat-photo');
    if (!scan.clean || !scan.scannerAvailable) throw new ChatImageError('IMAGE_SCAN_REQUIRED', 503);
    if ((await readAuthorizedPhoto(reference, sender, dependencies)).revision !== original.revision) throw new ChatImageError('IMAGE_CHANGED');
    const raster = await dependencies.prepare(original.bytes);
    images.push({ type: 'image', mimeType: raster.mimeType, content: raster.data, fileName: `photo-${reference.fileId}.jpg`,
      sizeBytes: Buffer.from(raster.data, 'base64').length, width: raster.width, height: raster.height });
  }
  const revalidate = async () => {
    if (await input.assertModel() !== model) throw new ChatImageError('IMAGE_MODEL_CHANGED');
    for (const [index, reference] of references.entries()) {
      if ((await readAuthorizedPhoto(reference, sender, dependencies)).revision !== originals[index]) throw new ChatImageError('IMAGE_CHANGED');
    }
  };
  await revalidate();
  return { message: stripChatImageReferences(input.message) || 'Describe the attached photo.', images, model, revalidate };
}
