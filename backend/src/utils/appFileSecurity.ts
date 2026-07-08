import path from 'path';

const PRIVATE_APP_FILENAMES = new Set([
  'server.js',
  'server.mjs',
  'server.cjs',
  'server.ts',
  'server.py',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'pipfile',
  'pipfile.lock',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'vite.config.cjs',
  'users.json',
  'sessions.json',
  'access.json',
  'state.json',
  'secrets.json',
  'credentials.json',
  'tokens.json',
  'api-keys.json',
  'runtime-cache.json',
  'runtime-state.json',
  'private-token',
  'internal-token',
]);

const PRIVATE_APP_SUFFIXES = [
  '.bak',
  '.db',
  '.key',
  '.log',
  '.map',
  '.pem',
  '.pfx',
  '.pid',
  '.p12',
  '.sqlite',
  '.sqlite3',
  '.ts',
  '.tsx',
];

export function isPathWithin(baseDir: string, candidatePath: string): boolean {
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isBlockedAppStaticPath(requestedPath: string): boolean {
  if (!requestedPath) return false;
  if (requestedPath.includes('\0')) return true;

  const segments = requestedPath.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    if (lower.startsWith('.')) return true;
    if (PRIVATE_APP_FILENAMES.has(lower)) return true;
    if (/(^|[-_.])(secret|secrets|credential|credentials|token|tokens|private)([-_.]|$)/.test(lower)) return true;
    if (/(^|[-_.])(cache|state)([-_.]|$)/.test(lower) && lower.endsWith('.json')) return true;
    if (lower.includes('.bak')) return true;
    return PRIVATE_APP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
  });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}
