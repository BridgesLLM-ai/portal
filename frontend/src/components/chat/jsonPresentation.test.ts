import { describe, expect, it } from 'vitest';
import { inspectJson, jsonFenceBody, JSON_TREE_LIMITS } from './jsonPresentation';

describe('bounded lossless JSON presentation', () => {
  it('preserves equivalent duplicate keys, exact strings and huge numeric lexemes in order', () => {
    const result = inspectJson('{"a":900719925474099312345,"\\u0061":1e9999,"escape":"\\u0041\\n"}');
    expect(result.tree?.kind).toBe('object');
    if (result.tree?.kind !== 'object') throw new Error('Missing tree');
    expect(result.tree.entries.map(({ rawKey, duplicate, occurrence, value }) => ({ rawKey, duplicate, occurrence, value }))).toEqual([
      { rawKey: '"a"', duplicate: true, occurrence: 1, value: { kind: 'value', raw: '900719925474099312345' } },
      { rawKey: '"\\u0061"', duplicate: true, occurrence: 2, value: { kind: 'value', raw: '1e9999' } },
      { rawKey: '"escape"', duplicate: false, occurrence: 1, value: { kind: 'value', raw: '"\\u0041\\n"' } },
    ]);
  });
  it.each(['{"x":}', '[1,]', '{"a":1,}', '01', 'NaN', 'Infinity', 'true false', '"\\x00"', '"unescaped\nline"', '{"x":1}\u00a0', '[', ''])('rejects unsupported or incomplete JSON %j', (raw) => {
    expect(inspectJson(raw).tree).toBeNull();
  });
  it.each(['null', 'true', '-0', '1.20e-003', '"\\\\\\\""', '{"__proto__":1,"constructor":2}', '[]', '{}'])('accepts valid JSON without object prototype mutation %j', (raw) => {
    expect(inspectJson(raw).tree).not.toBeNull();
  });
  it('bounds input length, nodes and nesting independently', () => {
    for (const raw of [' '.repeat(JSON_TREE_LIMITS.characters) + '{}', '[' + '0,'.repeat(512) + '0]', '['.repeat(18) + '0' + ']'.repeat(18)]) {
      expect(inspectJson(raw)).toMatchObject({ tree: null, reason: expect.stringContaining('limit') });
    }
  });
  it('extracts the exact fence body including CRLF, escapes and trailing whitespace', () => {
    const raw = ' {"a":12345678901234567890,"a":"\\n"}  \r\n';
    expect(jsonFenceBody('```json\r\n' + raw + '```')).toBe(raw);
    expect(jsonFenceBody('~~~~json\n{}\n~~~~')).toBe('{}\n');
    expect(jsonFenceBody('```json\n{"a":', true)).toBe('{"a":');
    expect(jsonFenceBody('```json\n{"a":')).toBeNull();
    expect(jsonFenceBody('```json\n{}\n```\nmore prose')).toBeNull();
  });
});
