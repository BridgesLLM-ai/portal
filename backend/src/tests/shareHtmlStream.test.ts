import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { createHash } from 'crypto';
import { appHtmlHasViteEntry, streamShareHtml } from '../utils/shareHtmlStream';

describe('bounded-memory shared HTML', () => {
  let root: string;
  let server: http.Server;
  let origin: string;
  const errors: string[] = [];
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-html-stream-'));
    errors.length = 0;
    const app = express();
    app.get('/page', async (_req, res) => {
      try { await streamShareHtml(path.join(root, 'index.html'), '/share/fixture/', res); }
      catch (error: any) { errors.push(error.code || error.message); if (!res.headersSent && !res.destroyed) res.sendStatus(500); }
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ['HTML5', '<!DOCTYPE html><html><head>', '</head><body>€😀</body></html>'],
    ['mixed case and quoted attributes', '<!doctype html><HTML><HeAd data-value="a>b">', '</HeAd><body>done</body>'],
    ['head crossing a chunk boundary', '<!doctype html><!--' + 'x'.repeat(65509) + '--><head>', '</head>'],
    ['large comment containing fake head', '\ufeff<!doctype html><!--<head>' + 'x'.repeat(2 * 1024 * 1024) + '--><head>', '</head>'],
    ['long quoted head attribute', '<!doctype html><head data-value="' + 'x'.repeat(70000) + '>x">', '</head>'],
  ])('preserves all bytes and inserts exactly once: %s', async (_name, prefix, suffix) => {
    fs.writeFileSync(path.join(root, 'index.html'), prefix + suffix);
    const response = await fetch(origin + '/page');
    expect(response.status).toBe(200);
    const received = Buffer.from(await response.arrayBuffer());
    const expected = Buffer.from(prefix + '<base href="/share/fixture/">' + suffix);
    expect(received.length).toBe(expected.length);
    expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(errors).toEqual([]);
  });

  test('streams a large UTF-8 document without truncation or whole-file reads', async () => {
    const html = '<!doctype html><head></head><body>' + 'é😀'.repeat(2 * 1024 * 1024) + '</body>';
    fs.writeFileSync(path.join(root, 'index.html'), html);
    const readFile = jest.spyOn(fs, 'readFileSync');
    const response = await fetch(origin + '/page');
    const output = await response.text();
    expect(response.status).toBe(200);
    expect(createHash('sha256').update(output).digest('hex')).toBe(createHash('sha256')
      .update(html.replace('<head>', '<head><base href="/share/fixture/">')).digest('hex'));
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockRestore();
    expect(errors).toEqual([]);
  });

  test('preserves the doctype for a document with an implicit head', async () => {
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body>hello</body></html>');
    expect(await (await fetch(origin + '/page')).text()).toBe('<!doctype html><html><base href="/share/fixture/"><body>hello</body></html>');
  });

  test('recognizes a late Vite entry spanning chunks without imposing a file-size cap', async () => {
    const file = path.join(root, 'index.html');
    fs.writeFileSync(file, 'x'.repeat(6 * 1024 * 1024 - 5) + '/src/main.tsx');
    expect(await appHtmlHasViteEntry(file)).toBe(true);
    fs.writeFileSync(file, 'x'.repeat(6 * 1024 * 1024) + 'done');
    expect(await appHtmlHasViteEntry(file)).toBe(false);
  });

  test('does not follow a replaced final symlink', async () => {
    const other = path.join(root, 'other.html'); fs.writeFileSync(other, 'private');
    fs.symlinkSync(other, path.join(root, 'index.html'));
    expect((await fetch(origin + '/page')).status).toBe(500);
    expect(errors).toEqual(['ELOOP']);
  });

  test('cancels when the reader disconnects and can immediately serve a later request', async () => {
    fs.writeFileSync(path.join(root, 'index.html'), '<head></head>' + 'x'.repeat(32 * 1024 * 1024));
    await new Promise<void>((resolve, reject) => {
      const req = http.get(origin + '/page', res => { res.once('data', () => { res.destroy(); resolve(); }); });
      req.on('error', reject);
    });
    const response = await fetch(origin + '/page');
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBe(32 * 1024 * 1024 + '<head><base href="/share/fixture/"></head>'.length);
  });
});
