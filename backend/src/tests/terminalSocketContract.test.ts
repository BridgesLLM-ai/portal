import { MAX_TERMINAL_INPUT_BYTES, normalizeTerminalDimensions } from '../routes/exec';

describe('terminal socket bounds', () => {
  test('uses safe defaults for absent or malformed initial dimensions', () => {
    expect(normalizeTerminalDimensions(undefined, undefined)).toEqual({ cols: 80, rows: 24 });
    expect(normalizeTerminalDimensions('huge', Number.NaN)).toEqual({ cols: 80, rows: 24 });
  });

  test('clamps initial and reconnect dimensions to the PTY contract', () => {
    expect(normalizeTerminalDimensions('999999', 999999)).toEqual({ cols: 500, rows: 200 });
    expect(normalizeTerminalDimensions(-2, 0)).toEqual({ cols: 1, rows: 1 });
    expect(normalizeTerminalDimensions(120.9, '40.8')).toEqual({ cols: 120, rows: 40 });
  });

  test('keeps raw input bounded independently of Socket.IO defaults', () => {
    expect(MAX_TERMINAL_INPUT_BYTES).toBe(256 * 1024);
  });
});
