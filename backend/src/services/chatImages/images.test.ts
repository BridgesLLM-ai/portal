import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { normalizeColorRaster } from './imageRasterWorker';
import { prepareColorRaster, validateRasterJpeg } from './imageRaster';
import { assertOpenClawImageInput } from './chatImageModelPolicy';
import { parseChatImageReferences, prepareChatImages, type ChatImageDependencies } from './directChatImages';
jest.mock('../../config/database', () => ({ prisma: {} }));
jest.mock('../../utils/openclawGatewayRpc', () => ({ getSessionInfo: jest.fn(), listGatewayModels: jest.fn() }));
jest.mock('../openclawConfigManager', () => ({ readOpenClawConfig: jest.fn() }));

const id = '11111111-1111-4111-8111-111111111111';
const revision = '2026-10-20T12:00:00.000Z';
const reference = { fileId: id, revision };
const marker = `[portal-chat-image:${JSON.stringify(reference)}]`;
const sender = { userId: 'actor', label: 'Actor', role: 'OWNER', authorizationVersion: 3 };
const png = () => sharp({ create: { width: 12, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();

describe('public color photo preparation', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('decodes real %s, preserves color and emits a metadata-free baseline JPEG', async format => {
    const input = await sharp(await png())[format]().toBuffer();
    const result = await normalizeColorRaster(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bytes = Buffer.from(result.data, 'base64');
    expect(validateRasterJpeg(bytes, result.width, result.height)).toBe(true);
    expect(validateRasterJpeg(bytes, 999, result.height)).toBe(false);
    const meta = await sharp(bytes).metadata();
    expect(meta.exif).toBeUndefined(); expect(meta.icc).toBeUndefined();
    const pixel = await sharp(bytes).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(230); expect(pixel[1]).toBeLessThan(25);
  });
  it('applies EXIF rotation before stripping metadata', async () => {
    const original = await sharp(await png()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await normalizeColorRaster(original);
    expect(result).toMatchObject({ ok: true, width: 8, height: 12 });
    if (result.ok) expect((await sharp(Buffer.from(result.data, 'base64')).metadata()).orientation).toBeUndefined();
  });
  it('bounds output dimensions', async () => {
    const original = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#00ff00' } }).png().toBuffer();
    expect(await normalizeColorRaster(original)).toMatchObject({ ok: true, width: 1024, height: 512 });
  });
  it('rejects documents disguised as photos, corrupt data and oversized input', async () => {
    for (const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('%PDF-1.7')]) {
      expect(await normalizeColorRaster(input)).toMatchObject({ ok: false, code: 'CHAT_IMAGE_UNSUPPORTED' });
    }
    expect(await normalizeColorRaster((await png()).subarray(0, 25))).toMatchObject({ ok: false });
    expect(await normalizeColorRaster(Buffer.alloc(10 * 1024 * 1024 + 1))).toMatchObject({ ok: false, code: 'CHAT_IMAGE_LIMIT' });
    expect(await normalizeColorRaster(await sharp({ create: { width: 16001, height: 1, channels: 3, background: 'red' } }).png().toBuffer()))
      .toMatchObject({ ok: false, code: 'CHAT_IMAGE_LIMIT' });
    expect(await normalizeColorRaster(await sharp({ create: { width: 7000, height: 7000, channels: 3, background: 'red' } }).png().toBuffer()))
      .toMatchObject({ ok: false });
  });
  it('rejects APNG and animated WebP containers', async () => {
    const original = await png();
    const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8); chunk.write('acTL', 4);
    expect(await normalizeColorRaster(Buffer.concat([original.subarray(0, 8), chunk, original.subarray(8)]))).toMatchObject({ ok: false, code: 'CHAT_IMAGE_UNSUPPORTED' });
    const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16); webp[20] = 2;
    expect(await normalizeColorRaster(webp)).toMatchObject({ ok: false, code: 'CHAT_IMAGE_UNSUPPORTED' });
  });
  it('fails closed without a compiled isolated worker', async () => {
    await expect(prepareColorRaster(null, await png())).rejects.toMatchObject({ code: 'CHAT_IMAGE_SANDBOX_UNAVAILABLE' });
  });
});

describe('fresh Files photo authorization', () => {
  let root: string, original: Buffer, file: any, actor: any, dependencies: ChatImageDependencies;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-chat-photo-'));
    fs.mkdirSync(path.join(root, 'user-actor/uploads'), { recursive: true });
    original = await png(); fs.writeFileSync(path.join(root, 'user-actor/uploads/photo'), original);
    file = { id, userId: 'actor', path: 'photo', size: BigInt(original.length), updatedAt: new Date(revision) };
    actor = { isActive: true, accountStatus: 'ACTIVE', role: 'OWNER', authorizationVersion: 3 };
    dependencies = { filesRoot: root, db: { file: { findFirst: jest.fn(async () => file) }, user: { findUnique: jest.fn(async () => actor) } } as any,
      scan: jest.fn(async () => ({ clean: true, scannerAvailable: true })),
      prepare: async bytes => { const result = await normalizeColorRaster(bytes); if (!result.ok) throw new Error(result.code); return result; } };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepare = (deps: ChatImageDependencies, assertModel = async () => 'generic/vision') => prepareChatImages({ message: `${marker}\nWhat is shown?`, sender, assertModel }, deps);
  it('returns real JPEG bytes, removes path-free reference markers and supplies a dispatch recheck', async () => {
    const result = await prepare(dependencies);
    expect(result?.message).toBe('What is shown?');
    expect(result?.images).toHaveLength(1);
    expect(Buffer.from(result!.images[0].content, 'base64').subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    await expect(result!.revalidate()).resolves.toBeUndefined();
    expect(dependencies.db.file.findFirst).toHaveBeenCalledWith({ where: { id, userId: 'actor' } });
  });
  it.each(['foreign', 'stale', 'revoked', 'role', 'generation', 'traversal', 'symlink', 'hardlink'])('denies %s without sending image bytes', async kind => {
    const filename = path.join(root, 'user-actor/uploads/photo');
    if (kind === 'foreign') file.userId = 'someone-else';
    if (kind === 'stale') file.updatedAt = new Date('2026-01-01');
    if (kind === 'revoked') actor.isActive = false;
    if (kind === 'role') actor.role = 'USER';
    if (kind === 'generation') actor.authorizationVersion++;
    if (kind === 'traversal') file.path = '../../other';
    if (kind === 'symlink') { fs.renameSync(filename, filename + '-real'); fs.symlinkSync(filename + '-real', filename); }
    if (kind === 'hardlink') fs.linkSync(filename, filename + '-link');
    await expect(prepare(dependencies)).rejects.toBeDefined();
    expect(dependencies.scan).not.toHaveBeenCalled();
  });
  it('accepts the Files tool-mirror twin as the only extra link', async () => {
    const mirrorRoot = path.join(root, 'mirror');
    fs.mkdirSync(path.join(mirrorRoot, 'user-actor/uploads'), { recursive: true });
    fs.linkSync(path.join(root, 'user-actor/uploads/photo'), path.join(mirrorRoot, 'user-actor/uploads/photo'));
    const result = await prepare({ ...dependencies, mirrorRoot });
    expect(result?.images).toHaveLength(1);
    await expect(result!.revalidate()).resolves.toBeUndefined();
  });
  it.each(['twin plus foreign link', 'mirror copy is a different file', 'mirror entry is a symlink'])('denies %s', async kind => {
    const filename = path.join(root, 'user-actor/uploads/photo');
    const mirrorRoot = path.join(root, 'mirror'), twin = path.join(mirrorRoot, 'user-actor/uploads/photo');
    fs.mkdirSync(path.dirname(twin), { recursive: true });
    if (kind === 'twin plus foreign link') { fs.linkSync(filename, twin); fs.linkSync(filename, path.join(root, 'elsewhere')); }
    if (kind === 'mirror copy is a different file') { fs.copyFileSync(filename, twin); fs.linkSync(filename, path.join(root, 'elsewhere')); }
    if (kind === 'mirror entry is a symlink') { fs.linkSync(filename, path.join(root, 'elsewhere')); fs.symlinkSync(path.join(root, 'elsewhere'), twin); }
    await expect(prepare({ ...dependencies, mirrorRoot })).rejects.toBeDefined();
    expect(dependencies.scan).not.toHaveBeenCalled();
  });
  it('denies scanner unavailability and malware', async () => {
    for (const scan of [{ clean: false, scannerAvailable: false }, { clean: false, scannerAvailable: true }]) {
      dependencies.scan = jest.fn(async () => scan);
      await expect(prepare(dependencies)).rejects.toMatchObject({ code: 'IMAGE_SCAN_REQUIRED' });
    }
  });
  it('detects bytes changed during scanning and revocation after decode', async () => {
    dependencies.scan = jest.fn(async () => { fs.writeFileSync(path.join(root, 'user-actor/uploads/photo'), Buffer.alloc(original.length)); return { clean: true, scannerAvailable: true }; });
    await expect(prepare(dependencies)).rejects.toMatchObject({ code: 'IMAGE_CHANGED' });
    fs.writeFileSync(path.join(root, 'user-actor/uploads/photo'), original);
    dependencies.scan = jest.fn(async () => ({ clean: true, scannerAvailable: true }));
    dependencies.prepare = async bytes => { actor.isActive = false; return normalizeColorRaster(bytes) as any; };
    await expect(prepare(dependencies)).rejects.toMatchObject({ code: 'IMAGE_ACTOR_DENIED' });
  });
  it('denies changed model and file identity at the final dispatch fence', async () => {
    let model = 'generic/vision'; const result = await prepare(dependencies, async () => model);
    model = 'generic/text'; await expect(result!.revalidate()).rejects.toMatchObject({ code: 'IMAGE_MODEL_CHANGED' });
    model = 'generic/vision'; fs.writeFileSync(path.join(root, 'user-actor/uploads/photo'), Buffer.alloc(original.length));
    await expect(result!.revalidate()).rejects.toMatchObject({ code: 'IMAGE_CHANGED' });
  });
  it('rejects malformed, forged and excessive references', () => {
    for (const input of ['[portal-chat-image:bad]', marker + marker, `${marker}\n${marker}`, `${marker}\n`.repeat(5), marker.replace('revision', 'path')]) {
      expect(() => parseChatImageReferences(input)).toThrow();
    }
  });
});

describe('runtime-owned model image modality', () => {
  const dependencies = (input: any) => ({ session: async () => ({ ok: true, data: { model: 'generic/vision' } }),
    catalog: async () => ({ ok: true, models: [{ id: 'vision', provider: 'generic', input }] }), config: () => ({ agents: { defaults: { model: 'generic/vision' } } }) } as any);
  it('accepts runtime image input, not a name heuristic', async () => {
    await expect(assertOpenClawImageInput('agent:main:portal-owner-main', dependencies(['text', 'image']))).resolves.toBe('generic/vision');
    await expect(assertOpenClawImageInput('agent:main:portal-owner-main', dependencies(['text']))).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNSUPPORTED' });
    await expect(assertOpenClawImageInput('agent:main:portal-owner-main', dependencies(undefined))).rejects.toBeDefined();
  });
  it('refuses unknown or text-only fallback candidates', async () => {
    const deps = dependencies(['text', 'image']); deps.config = () => ({ agents: { defaults: { model: { primary: 'generic/vision', fallbacks: ['generic/text'] } } } });
    await expect(assertOpenClawImageInput('agent:main:portal-owner-main', deps)).rejects.toBeDefined();
  });
});
