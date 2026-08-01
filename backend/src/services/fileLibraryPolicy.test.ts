import {
  FILE_LIBRARY_MAX_BATCH_DELETE,
  FILE_LIBRARY_MAX_SYNC_ENTRIES,
  FILE_LIBRARY_PAGE_SIZE,
  normalizeFileRename,
} from './fileLibraryPolicy';

describe('fileLibraryPolicy', () => {
  test('keeps the requested extension exactly once', () => {
    expect(normalizeFileRename('stored-random.pdf', 'quarterly report.pdf')).toEqual({
      storedPath: 'quarterly report.pdf',
      displayName: 'quarterly report.pdf',
    });
    expect(normalizeFileRename('nested/stored-random.png', 'hero.webp')).toEqual({
      storedPath: 'nested/hero.webp',
      displayName: 'hero.webp',
    });
  });

  test('neutralizes separators and rejects empty or dot names', () => {
    expect(normalizeFileRename('stored.txt', '../private.txt').displayName).toBe('.._private.txt');
    expect(() => normalizeFileRename('stored.txt', '   ')).toThrow(/required/);
    expect(() => normalizeFileRename('stored.txt', '..')).toThrow(/Invalid/);
  });

  test('publishes bounded library limits', () => {
    expect(FILE_LIBRARY_PAGE_SIZE).toBe(100);
    expect(FILE_LIBRARY_MAX_BATCH_DELETE).toBe(100);
    expect(FILE_LIBRARY_MAX_SYNC_ENTRIES).toBe(5_000);
  });
});
