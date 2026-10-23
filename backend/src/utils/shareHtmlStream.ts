import fs from 'fs';
import type { FileHandle } from 'fs/promises';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { Response } from 'express';

const CHUNK_BYTES = 64 * 1024;
const VITE_ENTRIES = ['/src/main.tsx', '/src/main.ts', '/src/main.jsx'];

async function* readChunks(file: FileHandle, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    signal?.throwIfAborted();
    if (!bytesRead) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

/** Scan without materializing the document, including matches crossing chunks. */
export async function appHtmlHasViteEntry(filePath: string, signal?: AbortSignal): Promise<boolean> {
  let tail = '';
  const file = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('App HTML is not a regular file');
    for await (const chunk of readChunks(file, signal)) {
      const text = tail + (chunk as Buffer).toString('latin1');
      if (VITE_ENTRIES.some(entry => text.includes(entry))) return true;
      tail = text.slice(-13);
    }
    return false;
  } finally { await file.close(); }
}

/** Locate the head insertion point with constant state, even after huge comments
 * or inside an opening head tag with long/quoted attributes. Offsets are bytes;
 * the original UTF-8, embedded images and scripts are never decoded/re-encoded. */
async function baseInsertionOffset(input: AsyncIterable<Buffer>): Promise<number> {
  let offset = 0;
  let tokenStart = 0;
  let token = '';
  let mode: 'space' | 'token' | 'comment' | 'tag' = 'space';
  let tagKind = '';
  let quote = 0;
  let commentTail = '';
  const prefixes = ['<!--', '<!doctype', '<html', '<head'];
  for await (const data of input) {
    for (const byte of data as Buffer) {
      const position = offset++;
      if (mode === 'space') {
        if ((position < 3 && byte === [0xef, 0xbb, 0xbf][position])
          || [9, 10, 12, 13, 32].includes(byte)) continue;
        if (byte !== 60) return position;
        tokenStart = position; token = '<'; mode = 'token';
      } else if (mode === 'token') {
        token += String.fromCharCode(byte).toLowerCase();
        if (token === '<!--') { mode = 'comment'; commentTail = ''; continue; }
        const match = /^<(head|html|!doctype)([\t\n\f\r />])$/.exec(token);
        if (match) {
          tagKind = match[1]; mode = 'tag'; quote = 0;
          if (byte === 62) {
            if (tagKind === 'head') return offset;
            mode = 'space';
          }
        } else if (!prefixes.some(prefix => prefix.startsWith(token) || prefix === token)) {
          return tokenStart;
        }
      } else if (mode === 'comment') {
        commentTail = (commentTail + String.fromCharCode(byte)).slice(-3);
        if (commentTail === '-->') mode = 'space';
      } else if (quote) {
        if (byte === quote) quote = 0;
      } else if (byte === 34 || byte === 39) {
        quote = byte;
      } else if (byte === 62) {
        if (tagKind === 'head') return offset;
        mode = 'space';
      }
    }
  }
  return mode === 'token' ? tokenStart : offset;
}

/** Authorized static share response. Backpressure and client disconnects are
 * carried through pipeline; memory is bounded by stream chunks, not HTML size. */
export async function streamShareHtml(filePath: string, baseHref: string, res: Response): Promise<void> {
  const controller = new AbortController();
  const onClose = () => { if (!res.writableFinished) controller.abort(); };
  const file = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  res.once('close', onClose);
  try {
    if (res.destroyed) controller.abort();
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Shared HTML is not a regular file');
    // Positional reads leave the handle open and do not share a stream lifecycle
    // with the response. Breaking a ReadStream iterator destroys that stream.
    const insertion = await baseInsertionOffset(readChunks(file, controller.signal));
    const base = Buffer.from(`<base href="${baseHref}">`);
    let position = 0;
    let inserted = false;
    const transform = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (!inserted && insertion <= position + chunk.length) {
          const at = Math.max(0, insertion - position);
          this.push(chunk.subarray(0, at)); this.push(base); this.push(chunk.subarray(at));
          inserted = true;
        } else this.push(chunk);
        position += chunk.length; callback();
      },
      flush(callback) { if (!inserted) this.push(base); callback(); },
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // No fixed Content-Length: compression/streaming may transform the body.
    await pipeline(file.createReadStream({ start: 0, autoClose: false, highWaterMark: CHUNK_BYTES }),
      transform, res, { signal: controller.signal });
  } finally {
    res.off('close', onClose);
    await file.close();
  }
}
