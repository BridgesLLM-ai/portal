import { describe, expect, it } from 'vitest';
import {
  MAX_SPREADSHEET_ARCHIVE_BYTES,
  formatSpreadsheetCell,
  inspectSpreadsheetArchive,
} from './spreadsheet';

function makeCentralDirectoryArchive(options?: {
  compressed?: number;
  uncompressed?: number;
  flags?: number;
  entries?: number;
}): ArrayBuffer {
  const entryCount = options?.entries ?? 1;
  const entrySize = 46 + 8;
  const centralSize = entrySize * entryCount;
  const buffer = new ArrayBuffer(centralSize + 22);
  const view = new DataView(buffer);

  for (let index = 0; index < entryCount; index += 1) {
    const offset = index * entrySize;
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 8, options?.flags ?? 0, true);
    view.setUint32(offset + 20, options?.compressed ?? 100, true);
    view.setUint32(offset + 24, options?.uncompressed ?? 200, true);
    view.setUint16(offset + 28, 8, true);
  }

  const eocd = centralSize;
  view.setUint32(eocd, 0x06054b50, true);
  view.setUint16(eocd + 8, entryCount, true);
  view.setUint16(eocd + 10, entryCount, true);
  view.setUint32(eocd + 12, centralSize, true);
  view.setUint32(eocd + 16, 0, true);
  return buffer;
}

describe('spreadsheet archive safety', () => {
  it('accepts a bounded single-volume central directory', () => {
    expect(inspectSpreadsheetArchive(makeCentralDirectoryArchive())).toEqual({
      entries: 1,
      compressedBytes: 100,
      uncompressedBytes: 200,
    });
  });

  it('rejects malformed non-ZIP data', () => {
    expect(() => inspectSpreadsheetArchive(new Uint8Array([1, 2, 3]).buffer)).toThrow(/valid \.xlsx/i);
  });

  it('rejects encrypted entries', () => {
    expect(() => inspectSpreadsheetArchive(makeCentralDirectoryArchive({ flags: 1 }))).toThrow(/Encrypted/i);
  });

  it('rejects decompression bombs', () => {
    expect(() => inspectSpreadsheetArchive(makeCentralDirectoryArchive({
      compressed: 1,
      uncompressed: Math.min(MAX_SPREADSHEET_ARCHIVE_BYTES, 40 * 1024 * 1024),
    }))).toThrow(/compression ratio/i);
  });

  it('formats dates and null cells without executing content', () => {
    expect(formatSpreadsheetCell(null)).toBe('');
    expect(formatSpreadsheetCell('<img onerror=alert(1)>')).toBe('<img onerror=alert(1)>');
    expect(formatSpreadsheetCell(new Date('2026-07-18T00:00:00Z'))).not.toBe('');
  });
});
