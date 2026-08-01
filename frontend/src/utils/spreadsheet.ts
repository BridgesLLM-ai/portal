import readExcelFile, { type SheetData } from 'read-excel-file/browser';

export const MAX_SPREADSHEET_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SPREADSHEET_ARCHIVE_BYTES = 96 * 1024 * 1024;
export const MAX_SPREADSHEET_ENTRY_BYTES = 48 * 1024 * 1024;
export const MAX_SPREADSHEET_ENTRIES = 5_000;
export const MAX_SPREADSHEET_ROWS = 5_000;
export const MAX_SPREADSHEET_COLUMNS = 256;

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_MAX_COMMENT_BYTES = 65_535;

export type SpreadsheetArchiveStats = {
  entries: number;
  compressedBytes: number;
  uncompressedBytes: number;
};

export type ParsedSpreadsheetSheet = {
  name: string;
  data: SheetData;
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
};

export type ParsedSpreadsheetWorkbook = {
  sheets: ParsedSpreadsheetSheet[];
  archive: SpreadsheetArchiveStats;
};

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - ZIP_MAX_COMMENT_BYTES);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('This file is not a valid .xlsx archive.');
}

/**
 * Bounds the compressed workbook before XML parsing. This rejects ZIP64,
 * encrypted entries, malformed central directories, and decompression bombs.
 */
export function inspectSpreadsheetArchive(buffer: ArrayBuffer): SpreadsheetArchiveStats {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_SPREADSHEET_FILE_BYTES) {
    throw new Error(`Spreadsheet preview is limited to ${MAX_SPREADSHEET_FILE_BYTES / 1024 / 1024}MB files.`);
  }

  const view = new DataView(buffer);
  const eocdOffset = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) {
    throw new Error('Multi-volume spreadsheet archives are not supported.');
  }
  if (entries === 0 || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('This spreadsheet archive uses an unsupported ZIP layout.');
  }
  if (entries > MAX_SPREADSHEET_ENTRIES) {
    throw new Error(`Spreadsheet archive contains too many files (${entries.toLocaleString()}).`);
  }
  if (centralOffset + centralSize > eocdOffset || centralOffset < 0) {
    throw new Error('Spreadsheet archive has an invalid central directory.');
  }

  let offset = centralOffset;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocdOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_ENTRY) {
      throw new Error('Spreadsheet archive has a malformed directory entry.');
    }
    const flags = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);

    if ((flags & 0x1) !== 0) throw new Error('Encrypted spreadsheet archives cannot be previewed.');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error('ZIP64 spreadsheet entries cannot be previewed.');
    }
    if (uncompressed > MAX_SPREADSHEET_ENTRY_BYTES) {
      throw new Error('Spreadsheet contains an individual entry that is too large to preview safely.');
    }

    compressedBytes += compressed;
    uncompressedBytes += uncompressed;
    if (uncompressedBytes > MAX_SPREADSHEET_ARCHIVE_BYTES) {
      throw new Error('Spreadsheet expands beyond the safe preview limit.');
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  if (offset !== centralOffset + centralSize) {
    throw new Error('Spreadsheet archive directory length is inconsistent.');
  }
  if (compressedBytes > 0 && uncompressedBytes / compressedBytes > 500) {
    throw new Error('Spreadsheet compression ratio exceeds the safe preview limit.');
  }

  return { entries, compressedBytes, uncompressedBytes };
}

export async function parseSpreadsheetWorkbook(input: Blob | ArrayBuffer): Promise<ParsedSpreadsheetWorkbook> {
  const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const archive = inspectSpreadsheetArchive(buffer);
  const sheets = await readExcelFile(buffer);

  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('Spreadsheet contains no readable sheets.');
  }

  return {
    archive,
    sheets: sheets.map(({ sheet, data }, index) => {
      const totalRows = data.length;
      const totalColumns = data.reduce((max, row) => Math.max(max, row.length), 0);
      const bounded = data
        .slice(0, MAX_SPREADSHEET_ROWS)
        .map((row) => row.slice(0, MAX_SPREADSHEET_COLUMNS));
      return {
        name: String(sheet || `Sheet ${index + 1}`).slice(0, 200),
        data: bounded,
        totalRows,
        totalColumns,
        truncated: totalRows > bounded.length || totalColumns > MAX_SPREADSHEET_COLUMNS,
      };
    }),
  };
}

export function formatSpreadsheetCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}
