/**
 * Entries a Project ZIP download leaves out.
 *
 * Paths are relative and `/`-separated, exactly as the inert snapshot copier
 * reports them (`copyProjectDownloadSnapshot`), and are matched by whole path
 * segment at any depth — never by substring. The previous inline matcher
 * compared whole relative paths, so `backend/.env`, `.env.production` and
 * `.ssh/` reached every download mode, while substring checks dropped ordinary
 * source such as `.github/`, `.gitignore`, `src/distance.ts` or `rebuild.sh`.
 *
 * Callers pass the path before an entry is pinned, so a directory and a file
 * of the same name are treated alike; every listed directory name is generated
 * output, Portal-internal state or credential material.
 */

export type ProjectDownloadMode = 'full' | 'clean' | 'stripped';

/** Generated or Portal-internal directories, dropped from every mode. */
const ALWAYS_DIRECTORIES = new Set([
  '.git', 'node_modules', '.venv', '__pycache__', '.pytest_cache', '.cache', '.turbo',
]);
/** Credential directories, dropped from every mode wherever they appear. */
const CREDENTIAL_DIRECTORIES = new Set(['.ssh', '.aws', '.azure', '.gnupg', '.kube']);
/** Generated or Portal-internal files, dropped from every mode. */
const ALWAYS_FILES = new Set(['.portal-project.json', '.deps-installed', '.DS_Store', 'Thumbs.db']);
/** Credential files, dropped from every mode wherever they appear. `.npmrc` may
 * carry registry auth tokens (`//registry/:_authToken=`); `.npmrc.example` stays. */
const CREDENTIAL_FILES = new Set(['.envrc', '.netrc', '.npmrc', '.pgpass', '.git-credentials', '.pypirc']);
const ALWAYS_FILE_PREFIXES = ['.assistant-', '.agent-', '.marcus-'];
const ALWAYS_FILE_SUFFIXES = ['.pyc'];
/** Build output and editor state, also dropped from clean and stripped modes. */
const CLEAN_DIRECTORIES = new Set(['dist', 'build', '.next', '.nuxt', 'coverage', '.vscode', '.idea']);
/** Agent and readme documents at the Project root, dropped from clean and stripped modes. */
const CLEAN_ROOT_FILES = new Set(['Agent.md', 'agent.md', 'README.md', 'readme.md', 'Readme.md']);
/** `.env.example`-style templates document variables and carry no values by convention. */
const ENV_TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template']);

/** `.env` and every `.env.<name>` variant except templates such as `.env.example`. */
export function isEnvironmentSecretFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.env') return true;
  if (!lower.startsWith('.env.')) return false;
  const parts = lower.slice('.env.'.length).split('.');
  return !ENV_TEMPLATE_SUFFIXES.has(parts[parts.length - 1]);
}

function isExcludedName(name: string, clean: boolean): boolean {
  return ALWAYS_DIRECTORIES.has(name)
    || CREDENTIAL_DIRECTORIES.has(name)
    || ALWAYS_FILES.has(name)
    || CREDENTIAL_FILES.has(name)
    || isEnvironmentSecretFileName(name)
    || ALWAYS_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))
    || ALWAYS_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
    || (clean && CLEAN_DIRECTORIES.has(name));
}

export function isProjectDownloadPathExcluded(relativePath: string, mode: ProjectDownloadMode): boolean {
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const clean = mode !== 'full';
  if (clean && segments.length === 1 && CLEAN_ROOT_FILES.has(segments[0])) return true;
  // Portal-owned chat attachments (`.portal/attachments/`); the rest of `.portal` stays.
  if (segments.some((segment, index) => segment === '.portal' && segments[index + 1] === 'attachments')) return true;
  return segments.some((segment) => isExcludedName(segment, clean));
}
