import { describe, expect, it } from 'vitest';
import { buildSettingsSearchIndex, normalizeSearchText, searchSettings, withinOneEdit } from './settingsSearch';
import { settingsTabIdsForRole } from '../pages/settingsAdminContract';

const ownerIndex = buildSettingsSearchIndex('OWNER');

describe('public settings search', () => {
  it.each(['OWNER', 'SUB_ADMIN', 'USER', 'VIEWER', undefined, 'unknown'])('indexes exactly the Settings pages rendered for %s', (role) => {
    const pages = buildSettingsSearchIndex(role).filter(entry => entry.surface === 'settings' && entry.kind === 'page');
    expect(pages.map(entry => entry.to)).toEqual(settingsTabIdsForRole(role).map(tab => `/settings?tab=${tab}`));
  });

  it.each([
    ['hosted content embeds', '/settings?tab=security'],
    ['backup path', '/settings?tab=backups'],
    ['storage limits', '/settings?tab=backups'],
    ['automatic cleanup', '/settings?tab=backups'],
    ['ollama', '/settings?tab=ai-providers'],
    ['remote gpu', '/settings?tab=ai-providers'],
    ['agent zero', '/settings?tab=ai-providers'],
    ['api key', '/settings?tab=ai-providers'],
    ['default harness', '/settings?tab=agents'],
    ['smtp', '/settings?tab=email'],
    ['sound effects', '/settings?tab=profile'],
    ['pending approvals', '/admin?tab=pending'],
  ])('finds retained public control %s', (query, to) => {
    expect(searchSettings(ownerIndex, query)[0]?.entry.to).toBe(to);
  });

  it('does not expose host controls or provider setup to ordinary/unknown roles', () => {
    for (const role of ['USER', 'VIEWER', 'unknown', undefined]) {
      const index = buildSettingsSearchIndex(role);
      expect(index.every(entry => entry.to === '/settings?tab=profile')).toBe(true);
      for (const query of ['ollama', 'transfer ownership', 'remote desktop', 'backup path']) {
        expect(searchSettings(index, query)).toEqual([]);
      }
    }
    const operator = buildSettingsSearchIndex('SUB_ADMIN');
    expect(operator.some(entry => entry.to === '/admin?tab=maintenance')).toBe(true);
    expect(operator.some(entry => entry.to === '/admin?tab=pending')).toBe(false);
    expect(searchSettings(operator, 'transfer ownership')).toEqual([]);
  });

  it('matches all meaningful words, normalizes accents, and permits one typo', () => {
    expect(normalizeSearchText('Thème & Accent')).toBe('theme accent');
    expect(searchSettings(ownerIndex, 'where can I change my accent colour')[0]?.entry.label).toBe('Theme and accent color');
    expect(searchSettings(ownerIndex, 'ollmaa')[0]?.entry.to).toBe('/settings?tab=ai-providers');
    expect(searchSettings(ownerIndex, 'ollama password nonexistent')).toEqual([]);
    expect(withinOneEdit('mial', 'mail')).toBe(true);
  });

  it('limits results and returns none for an empty query', () => {
    expect(searchSettings(ownerIndex, 'backup', 2)).toHaveLength(2);
    expect(searchSettings(ownerIndex, '')).toEqual([]);
  });
});
