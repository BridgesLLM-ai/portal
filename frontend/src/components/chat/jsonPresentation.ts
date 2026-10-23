/** A bounded, lossless presentation parser: object entries and numeric lexemes are never coerced. */
export type JsonTreeNode =
  | { kind: 'object'; entries: { key: string; rawKey: string; occurrence: number; duplicate: boolean; value: JsonTreeNode }[] }
  | { kind: 'array'; items: JsonTreeNode[] }
  | { kind: 'value'; raw: string };

export const JSON_TREE_LIMITS = { characters: 64_000, nodes: 512, depth: 16 } as const;
export type JsonPresentation = { tree: JsonTreeNode; reason?: never } | { tree: null; reason: string };

export function inspectJson(raw: string): JsonPresentation {
  if (raw.length > JSON_TREE_LIMITS.characters) return { tree: null, reason: 'JSON exceeds the tree size limit. Raw text is authoritative.' };
  let at = 0;
  let nodes = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(raw[at] || '\0')) at += 1; };
  const fail = (): never => { throw new Error('JSON is incomplete or unsupported. Showing original raw text.'); };
  const string = () => {
    const start = at;
    if (raw[at++] !== '"') return fail();
    while (at < raw.length) {
      const character = raw[at++];
      if (character === '\\') at += 1;
      else if (character === '"') {
        const token = raw.slice(start, at);
        // Only strings are decoded, to recognize equivalent duplicate keys. Values keep their exact lexemes.
        return { raw: token, decoded: JSON.parse(token) as string };
      }
    }
    return fail();
  };
  const value = (depth: number): JsonTreeNode => {
    if (++nodes > JSON_TREE_LIMITS.nodes || depth > JSON_TREE_LIMITS.depth) throw new Error('JSON exceeds the tree complexity limit. Raw text is authoritative.');
    whitespace();
    if (raw[at] === '{') {
      at += 1; whitespace();
      const entries: Extract<JsonTreeNode, { kind: 'object' }>['entries'] = [];
      const counts = new Map<string, number>();
      if (raw[at] !== '}') while (true) {
        whitespace();
        const key = string(); whitespace();
        if (raw[at++] !== ':') return fail();
        const occurrence = (counts.get(key.decoded) || 0) + 1;
        counts.set(key.decoded, occurrence);
        entries.push({ key: key.decoded, rawKey: key.raw, occurrence, duplicate: false, value: value(depth + 1) });
        whitespace();
        if (raw[at] === '}') break;
        if (raw[at++] !== ',') return fail();
      }
      at += 1;
      for (const entry of entries) entry.duplicate = counts.get(entry.key)! > 1;
      return { kind: 'object', entries };
    }
    if (raw[at] === '[') {
      at += 1; whitespace();
      const items: JsonTreeNode[] = [];
      if (raw[at] !== ']') while (true) {
        items.push(value(depth + 1)); whitespace();
        if (raw[at] === ']') break;
        if (raw[at++] !== ',') return fail();
      }
      at += 1;
      return { kind: 'array', items };
    }
    if (raw[at] === '"') return { kind: 'value', raw: string().raw };
    const token = raw.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) return fail();
    at += token.length;
    return { kind: 'value', raw: token };
  };
  try {
    const tree = value(0); whitespace();
    if (at !== raw.length) return fail();
    return { tree };
  } catch (error) {
    return { tree: null, reason: error instanceof SyntaxError ? 'JSON is incomplete or unsupported. Showing original raw text.' : (error as Error).message };
  }
}

/** Preserve the source body, not Markdown/highlighter's reconstructed children. */
export function jsonFenceBody(source: string, streaming = false): string | null {
  const opening = source.match(/^ {0,3}(`{3,}|~{3,})json[^\S\r\n]*\r?\n/i);
  if (!opening) return null;
  const body = source.slice(opening[0].length);
  const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[^\\S\\r\\n]*(?:\\r?\\n)?$`, 'm');
  const end = closing.exec(body);
  if (end && !body.slice(end.index + end[0].length).trim()) return body.slice(0, end.index);
  return streaming ? body : null;
}
