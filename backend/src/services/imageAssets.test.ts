import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import {
  ImageMediaToolchainUnavailableError,
  UnsafeImageUploadError,
  classifyImageUploadFailure,
  processImageToTarget,
  type ImageMediaCommandRunner,
} from './imageAssets';

describe('shared image asset processing', () => {
  let fixtureDir = '';

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-image-assets-'));
  });

  afterEach(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('reports a repairable dependency failure without replacing the current GIF', async () => {
    const inputPath = path.join(fixtureDir, 'upload.gif');
    const targetNoExt = path.join(fixtureDir, 'avatar');
    const targetPath = `${targetNoExt}.gif`;
    fs.writeFileSync(inputPath, 'untrusted-upload');
    fs.writeFileSync(targetPath, 'current-avatar');
    const missingRunner: ImageMediaCommandRunner = async () => {
      throw Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
    };

    await expect(processImageToTarget(
      inputPath,
      'image/gif',
      targetNoExt,
      undefined,
      undefined,
      { commandRunner: missingRunner },
    )).rejects.toBeInstanceOf(ImageMediaToolchainUnavailableError);

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('current-avatar');
    expect(fs.existsSync(`${targetPath}.tmp.gif`)).toBe(false);
    expect(classifyImageUploadFailure(new ImageMediaToolchainUnavailableError())).toMatchObject({
      statusCode: 503,
      code: 'IMAGE_MEDIA_TOOLCHAIN_UNAVAILABLE',
      retryable: true,
      repairToolId: 'ffmpeg',
      repairUrl: '/agent-tools?tool=ffmpeg',
    });
  });

  test('keeps corrupt and oversized GIF data distinct from a missing toolchain', async () => {
    const inputPath = path.join(fixtureDir, 'upload.gif');
    const targetNoExt = path.join(fixtureDir, 'avatar');
    fs.writeFileSync(inputPath, 'not-a-gif');
    const corruptRunner: ImageMediaCommandRunner = async () => {
      throw Object.assign(new Error('invalid data found'), { code: 1 });
    };

    await expect(processImageToTarget(
      inputPath,
      'image/gif',
      targetNoExt,
      undefined,
      undefined,
      { commandRunner: corruptRunner },
    )).rejects.toThrow('corrupt or could not be inspected safely');

    const oversizedRunner: ImageMediaCommandRunner = async () => ({ stdout: '5000,5000\n' });
    await expect(processImageToTarget(
      inputPath,
      'image/gif',
      targetNoExt,
      undefined,
      undefined,
      { commandRunner: oversizedRunner },
    )).rejects.toThrow('dimensions are invalid or too large');
    expect(classifyImageUploadFailure(
      new UnsafeImageUploadError('The uploaded GIF is invalid.'),
    )).toEqual({
      statusCode: 400,
      error: 'The uploaded GIF is invalid.',
      code: 'INVALID_IMAGE_UPLOAD',
      retryable: false,
    });
    expect(fs.existsSync(`${targetNoExt}.gif`)).toBe(false);
  });

  test('atomically promotes a successfully processed GIF and leaves no work file', async () => {
    const inputPath = path.join(fixtureDir, 'upload.gif');
    const targetNoExt = path.join(fixtureDir, 'avatar');
    const targetPath = `${targetNoExt}.gif`;
    fs.writeFileSync(inputPath, 'source-gif');
    const runner: ImageMediaCommandRunner = async (executable, args) => {
      if (executable === 'ffprobe') return { stdout: '320,240\n' };
      expect(executable).toBe('ffmpeg');
      fs.writeFileSync(args[args.length - 1], 'processed-gif');
      return { stdout: '' };
    };

    await expect(processImageToTarget(
      inputPath,
      'image/gif',
      targetNoExt,
      undefined,
      undefined,
      { commandRunner: runner },
    )).resolves.toMatchObject({ outputPath: targetPath, ext: '.gif', isGif: true });

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('processed-gif');
    expect(fs.existsSync(`${targetPath}.tmp.gif`)).toBe(false);
  });

  test('keeps static PNG processing independent of the GIF media command runner', async () => {
    const inputPath = path.join(fixtureDir, 'upload.png');
    const targetNoExt = path.join(fixtureDir, 'avatar');
    await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: { r: 20, g: 40, b: 60, alpha: 1 },
      },
    }).png().toFile(inputPath);
    const commandRunner = jest.fn(async () => ({ stdout: '' }));

    await expect(processImageToTarget(
      inputPath,
      'image/png',
      targetNoExt,
      undefined,
      { staticSize: 8 },
      { commandRunner },
    )).resolves.toMatchObject({ ext: '.png', isGif: false });

    expect(commandRunner).not.toHaveBeenCalled();
    await expect(sharp(`${targetNoExt}.png`).metadata()).resolves.toMatchObject({
      width: 8,
      height: 8,
      format: 'png',
    });
  });
});
