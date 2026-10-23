// Search only static navigation/help text; never settings values or credentials.
import { isElevatedRole } from './authz';
import {
  SETTINGS_TABS, ADMIN_TABS, settingsTabIdsForRole, adminTabIdsForRole,
  type PortalSurfaceRole, type SettingsTabId, type AdminTabId, type SurfaceCatalogEntry,
} from '../pages/settingsAdminContract';

export type SettingsSearchSurface = 'settings' | 'admin';
export interface SettingsSearchEntry {
  id: string;
  kind: 'page' | 'topic';
  surface: SettingsSearchSurface;
  label: string;
  location: string;
  summary: string;
  keywords: readonly string[];
  to: string;
}
export const SETTINGS_SEARCH_RESULT_LIMIT = 8;
export function settingsTabPath(tab: SettingsTabId): string { return `/settings?tab=${tab}`; }
export function adminTabPath(tab: AdminTabId): string { return tab === 'users' ? '/admin' : `/admin?tab=${tab}`; }

/** Index only pages and controls available to the current public role. */
export function buildSettingsSearchIndex(role: PortalSurfaceRole): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];
  const addSurface = (surface: SettingsSearchSurface, id: string, page: SurfaceCatalogEntry, to: string) => {
    const location = surface === 'settings' ? 'Settings' : 'Admin';
    entries.push(Object.freeze({ id, kind: 'page', surface, label: page.label, location, summary: page.summary, keywords: page.keywords, to }));
    for (const topic of page.topics) {
      if (topic.audience === 'owner' && role !== 'OWNER') continue;
      if (topic.audience === 'non-owner' && role === 'OWNER') continue;
      if (topic.audience === 'non-elevated' && isElevatedRole(role)) continue;
      entries.push(Object.freeze({ id: `${id}-${topic.id}`, kind: 'topic', surface, label: topic.label,
        location: `${location} › ${page.label}`, summary: topic.summary, keywords: topic.keywords, to }));
    }
  };
  for (const tab of settingsTabIdsForRole(role)) addSurface('settings', `settings-${tab}`, SETTINGS_TABS[tab], settingsTabPath(tab));
  if (isElevatedRole(role)) {
    for (const tab of adminTabIdsForRole(role)) addSurface('admin', `admin-${tab}`, ADMIN_TABS[tab], adminTabPath(tab));
  }
  return entries;
}

// ── Matching ──────────────────────────────────────────────────────────
// Every meaningful query word must start a word in the entry (or match a
// joined phrase such as "signin"); filler words only add weight. A word that
// matches nothing anywhere may match with one typo, so "mial" still finds
// mail. Labels outrank aliases, which outrank location and help text.

export interface SearchableText {
  label: string;
  keywords?: readonly string[];
  location?: string;
  summary?: string;
}

export interface ParsedSearchQuery {
  phrase: string;
  compact: string;
  required: readonly string[];
  soft: readonly string[];
}

interface PreparedField {
  weight: number;
  words: readonly string[];
  fuzzy: boolean;
}

interface PreparedText {
  label: string;
  labelCompact: string;
  keywordPhrases: readonly string[];
  fields: readonly PreparedField[];
}

const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'by', 'with', 'from', 'my', 'me', 'i',
  'how', 'do', 'does', 'where', 'is', 'are', 'can', 'what', 'which', 'find', 'open', 'go', 'show', 'see', 'view',
  'set', 'change', 'edit', 'manage', 'configure', 'update', 'enable', 'disable', 'turn', 'off',
  'page', 'tab', 'section', 'setting', 'settings',
]);

export function normalizeSearchText(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function phraseWords(phrases: readonly string[]): string[] {
  const words = new Set<string>();
  for (const phrase of phrases) {
    const normalized = normalizeSearchText(phrase);
    if (!normalized) continue;
    for (const word of normalized.split(' ')) words.add(word);
    if (normalized.includes(' ')) words.add(normalized.replace(/ /g, ''));
  }
  return [...words];
}

const preparedTexts = new WeakMap<SearchableText, PreparedText>();

function prepare(text: SearchableText): PreparedText {
  const cached = preparedTexts.get(text);
  if (cached) return cached;
  const label = normalizeSearchText(text.label);
  const keywords = text.keywords ?? [];
  const prepared: PreparedText = {
    label,
    labelCompact: label.replace(/ /g, ''),
    keywordPhrases: keywords.map(normalizeSearchText).filter(Boolean),
    fields: [
      { weight: 4, words: phraseWords([text.label]), fuzzy: true },
      { weight: 3, words: phraseWords(keywords), fuzzy: true },
      { weight: 2, words: phraseWords(text.location ? text.location.split('›') : []), fuzzy: true },
      { weight: 1, words: phraseWords(text.summary ? [text.summary] : []), fuzzy: false },
    ],
  };
  preparedTexts.set(text, prepared);
  return prepared;
}

export function parseSearchQuery(query: string): ParsedSearchQuery | null {
  const phrase = normalizeSearchText(query);
  if (!phrase) return null;
  const tokens = [...new Set(phrase.split(' '))];
  const isFiller = (token: string) => FILLER_WORDS.has(token) || (token.length === 1 && !/\d/.test(token));
  const meaningful = tokens.filter((token) => !isFiller(token));
  return meaningful.length > 0
    ? { phrase, compact: phrase.replace(/ /g, ''), required: meaningful, soft: tokens.filter(isFiller) }
    : { phrase, compact: phrase.replace(/ /g, ''), required: tokens, soft: [] };
}

function singularOf(token: string): string | null {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return null;
}

/** True when `a` and `b` differ by at most one insertion, deletion, substitution or adjacent swap. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// One typo against a whole word of four or more letters, or against the start
// of a longer word from five typed letters; the first letter must match.
function typoMatch(token: string, word: string): boolean {
  if (token.length < 4 || word.length < 4 || token[0] !== word[0]) return false;
  if (withinOneEdit(token, word)) return true;
  return token.length >= 5
    && [token.length - 1, token.length, token.length + 1].some((length) => length < word.length && withinOneEdit(token, word.slice(0, length)));
}

function tokenScore(text: PreparedText, token: string, match: 'prefix' | 'typo' | 'exact'): number {
  const singular = singularOf(token);
  let best = 0;
  for (const field of text.fields) {
    if (best >= field.weight + 0.5) break; // fields are in descending weight
    for (const word of field.words) {
      let score = 0;
      if (word === token || word === singular) score = field.weight + 0.5;
      else if (match !== 'exact' && (word.startsWith(token) || (singular !== null && word.startsWith(singular)))) score = field.weight;
      else if (match === 'typo' && field.fuzzy && typoMatch(token, word)) score = field.weight / 2;
      if (score > best) best = score;
    }
  }
  return best;
}

/** Relevance of `text` for the query, or null when a meaningful query word is missing. */
export function scoreSearchText(
  text: SearchableText,
  query: ParsedSearchQuery,
  typoTokens: ReadonlySet<string> = new Set(),
): number | null {
  const prepared = prepare(text);
  let score = 0;
  for (const token of query.required) {
    const best = tokenScore(prepared, token, typoTokens.has(token) ? 'typo' : 'prefix');
    if (best === 0) return null;
    score += best;
  }
  // Filler words count only as whole words ("sign in"), never as prefixes.
  for (const token of query.soft) score += tokenScore(prepared, token, 'exact') / 2;
  if (prepared.label === query.phrase || prepared.labelCompact === query.compact) score += 6;
  else if (prepared.label.startsWith(query.phrase)) score += (3 * query.phrase.length) / prepared.label.length;
  if (prepared.keywordPhrases.some((keyword) => keyword === query.phrase || keyword.replace(/ /g, '') === query.compact)) score += 3;
  else if (prepared.keywordPhrases.some((keyword) => keyword.startsWith(query.phrase))) score += 1;
  return score;
}

export interface RankedSettingsResult {
  entry: SettingsSearchEntry;
  score: number;
}

/** Best matches first; ties keep navigation order, pages before their topics. */
export function searchSettings(
  index: readonly SettingsSearchEntry[],
  query: string,
  limit: number = SETTINGS_SEARCH_RESULT_LIMIT,
): RankedSettingsResult[] {
  const parsed = parseSearchQuery(query);
  if (!parsed) return [];
  // Typo tolerance only for words that match nothing exactly, so "mail" never
  // pulls in "maintenance" while "mial" still finds mail.
  const typoTokens = new Set(parsed.required.filter((token) => index.every((entry) => tokenScore(prepare(entry), token, 'prefix') === 0)));
  const ranked: Array<RankedSettingsResult & { order: number }> = [];
  index.forEach((entry, order) => {
    const score = scoreSearchText(entry, parsed, typoTokens);
    if (score !== null) ranked.push({ entry, score: score + (entry.kind === 'page' ? 0.25 : 0), order });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.slice(0, Math.max(0, limit)).map(({ entry, score }) => ({ entry, score }));
}
