import path from 'path';

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

export function extractAbsolutePathDirs(text: string): string[] {
  const dirs = new Set<string>();
  const pathPattern = /(^|[\s"'`=:(])((?:\/[^\s"'`$|;&)<>]+)+)/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(text || '')) !== null) {
    const rawPath = String(match[2] || '').replace(/[,.]+$/, '');
    if (!rawPath || rawPath === '/') continue;
    dirs.add(rawPath.includes('.') ? path.dirname(rawPath) : rawPath);
  }
  return Array.from(dirs);
}

export function firstAbsolutePathDir(text: string): string | null {
  return extractAbsolutePathDirs(text)[0] || null;
}

export function looksLikeFilesystemOrToolRequest(text: string): boolean {
  return /\b(write|edit|modify|patch|create|delete|remove|rename|move|copy|run|execute|shell|bash|command|test|build|install|npm|pnpm|yarn|python|node|curl|fetch|read|open|inspect|list|search|grep|find)\b|\/[^\s"'`]+/i.test(text || '');
}

export function looksLikePermissionFailure(text: string): boolean {
  return /\b(permission denied|operation not permitted|read-only|readonly|sandbox|not permitted|not allowed|blocked|unauthorized tool call|tool .*not found|outside (?:the )?workspace|requires approval|approval required|not available to this agent|cannot write|couldn[’']t write|failed to write|access denied)\b/i.test(text || '');
}
