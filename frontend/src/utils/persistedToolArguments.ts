/**
 * Native harness transcripts persist bounded tool arguments. Arguments larger
 * than the bound are saved as `{ __truncated: true, preview }`, where the
 * preview is the start of the original JSON. A reloaded card should still say
 * what ran, so the few top-level string fields cards title themselves with are
 * recovered from that preview. Everything else is dropped rather than shown as
 * unreadable JSON. Any other value passes through unchanged.
 */

const RECOVERABLE_FIELDS = [
  'path', 'file_path', 'filePath', 'notebook_path', 'command', 'cmd', 'url', 'query', 'pattern',
  'title', 'description', 'question', 'skill', 'subagent_type', 'action', 'name',
] as const;

const MAX_PREVIEW_CHARS = 16 * 1024;
const MAX_FIELD_CHARS = 2_000;

function isTruncatedPreview(value: unknown): value is { __truncated: true; preview: string } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).__truncated === true
    && typeof (value as Record<string, unknown>).preview === 'string';
}

function recoverStringField(preview: string, key: string): string | null {
  const marker = `"${key}":`;
  const at = preview.indexOf(marker);
  if (at < 0) return null;
  let index = at + marker.length;
  while (preview[index] === ' ') index += 1;
  if (preview[index] !== '"') return null;
  // Scan to the closing quote, honouring backslash escapes; JSON.parse decodes.
  let end = index + 1;
  while (end < preview.length && end - index <= MAX_FIELD_CHARS) {
    if (preview[end] === '\\') { end += 2; continue; }
    if (preview[end] === '"') break;
    end += 1;
  }
  if (preview[end] !== '"') return null;
  try {
    const decoded: unknown = JSON.parse(preview.slice(index, end + 1));
    return typeof decoded === 'string' && decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

export function recoverPersistedToolArguments(value: unknown): unknown {
  if (!isTruncatedPreview(value)) return value;
  const preview = value.preview.slice(0, MAX_PREVIEW_CHARS);
  const recovered: Record<string, string> = {};
  for (const key of RECOVERABLE_FIELDS) {
    const field = recoverStringField(preview, key);
    if (field !== null) recovered[key] = field;
  }
  return Object.keys(recovered).length > 0 ? recovered : undefined;
}
