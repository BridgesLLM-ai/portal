import {
  buildOpenClawPluginPolicy,
  captureOpenClawPluginPolicy,
  parseOpenClawPluginState,
} from '../services/openclawPluginManager';

describe('openclawPluginManager plugin contract', () => {
  test('reads bundled provider capability from plugin inventory', () => {
    expect(parseOpenClawPluginState({
      plugins: [{ id: 'xai', enabled: true, status: 'loaded', providerIds: ['xai'] }],
    }, 'xai')).toEqual({
      discovered: true,
      enabled: true,
      status: 'loaded',
      providerIds: ['xai'],
    });
  });

  test('treats restrictive allowlist inventory as discovered but disabled', () => {
    expect(parseOpenClawPluginState({
      plugins: [{ id: 'xai', enabled: false, status: 'disabled', providerIds: ['xai'] }],
    }, 'xai')).toEqual({
      discovered: true,
      enabled: false,
      status: 'disabled',
      providerIds: ['xai'],
    });
  });

  test('fails closed when a plugin is absent from inventory', () => {
    expect(parseOpenClawPluginState({ plugins: [] }, 'xai')).toEqual({
      discovered: false,
      enabled: false,
      status: null,
      providerIds: [],
    });
  });

  test('adds xai to a restrictive allowlist without dropping existing plugins', () => {
    const config = {
      plugins: {
        allow: ['discord', 'browser', 'codex'],
        entries: { browser: { enabled: true } },
      },
    };

    expect(buildOpenClawPluginPolicy(config, 'xai')).toEqual({
      allow: ['discord', 'browser', 'codex', 'xai'],
      entryEnabled: true,
    });
    expect(config.plugins.allow).toEqual(['discord', 'browser', 'codex']);
    expect(config.plugins.entries).toEqual({ browser: { enabled: true } });
  });

  test('preserves existing plugin configuration while enabling the provider', () => {
    const config = {
      plugins: {
        allow: ['xai'],
        entries: { xai: { enabled: false, config: { webSearch: { mode: 'llm-context' } } } },
      },
    };

    expect(buildOpenClawPluginPolicy(config, 'xai')).toEqual({
      allow: ['xai'],
      entryEnabled: true,
    });
  });

  test('preserves an empty unrestricted allowlist instead of narrowing every plugin to xai', () => {
    expect(buildOpenClawPluginPolicy({ plugins: { allow: [] } }, 'xai')).toEqual({
      allow: [],
      entryEnabled: true,
    });
  });

  test('captures absent versus explicit policy so rollback can restore exactly', () => {
    expect(captureOpenClawPluginPolicy({}, 'xai')).toEqual({
      allowPresent: false,
      allow: undefined,
      entryPresent: false,
      entryEnabledPresent: false,
      entryEnabled: undefined,
    });
    expect(captureOpenClawPluginPolicy({
      plugins: { allow: [], entries: { xai: { enabled: false } } },
    }, 'xai')).toEqual({
      allowPresent: true,
      allow: [],
      entryPresent: true,
      entryEnabledPresent: true,
      entryEnabled: false,
    });
  });

  test('does not override an explicit deny policy', () => {
    expect(() => buildOpenClawPluginPolicy({
      plugins: { deny: ['xai'] },
    }, 'xai')).toThrow('explicitly denied');
  });
});
