/**
 * Paging for the Projects Git History tab (`log` and `log-enhanced`). The tab
 * pages with `skip`; reading one entry past the page tells it whether older
 * commits exist, so a long or joined history stays reachable.
 */

export const PROJECT_GIT_HISTORY_MAX_LIMIT = 100;
export const PROJECT_GIT_HISTORY_MAX_SKIP = 1_000_000;

export interface ProjectGitHistoryPage {
  limit: number;
  skip: number;
}

/** `null` means an explicit offset that is not a non-negative integer in range. */
export function projectGitHistoryPage(
  body: { limit?: unknown; skip?: unknown },
  defaultLimit: number,
): ProjectGitHistoryPage | null {
  const limit = Math.max(1, Math.min(
    Number.parseInt(String(body.limit || defaultLimit), 10) || defaultLimit,
    PROJECT_GIT_HISTORY_MAX_LIMIT,
  ));
  if (body.skip === undefined || body.skip === null) return { limit, skip: 0 };
  const skip = body.skip;
  if (typeof skip !== 'number' || !Number.isSafeInteger(skip) || skip < 0 || skip > PROJECT_GIT_HISTORY_MAX_SKIP) {
    return null;
  }
  return { limit, skip };
}

export function projectGitHistoryRangeArgs(page: ProjectGitHistoryPage): string[] {
  return [...(page.skip > 0 ? [`--skip=${page.skip}`] : []), `-${page.limit + 1}`];
}

export function projectGitHistoryResult<T>(entries: T[], page: ProjectGitHistoryPage): { commits: T[]; hasMore: boolean } {
  return { commits: entries.slice(0, page.limit), hasMore: entries.length > page.limit };
}

const FIELD = '%x1f';
const RECORD = '%x1e';

/** Unit/record separators, not JSON: a subject or name containing quotes or
 * backslashes (every `Revert "..."` commit) must not be dropped. */
export const PROJECT_GIT_BASIC_LOG_FORMAT = `--format=${['%H', '%h', '%an', '%ae', '%aI', '%ar', '%s', '%D', '%P'].join(FIELD)}${RECORD}`;

export interface ProjectGitBasicCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  relativeDate: string;
  message: string;
  refs: string;
  parent: string;
}

/** One entry per record, malformed records included as `null`, so that paging
 * counts what git returned rather than what parsed. */
export function parseProjectGitBasicLog(raw: string): Array<ProjectGitBasicCommit | null> {
  return raw.split('\x1e').map((record) => record.replace(/^\n/, '')).filter(Boolean).map((record) => {
    const fields = record.split('\x1f');
    if (fields.length !== 9 || !/^[a-f0-9]{40,64}$/.test(fields[0])) return null;
    const [hash, short, author, email, date, relativeDate, message, refs, parent] = fields;
    return { hash, short, author, email, date, relativeDate, message, refs, parent };
  });
}
