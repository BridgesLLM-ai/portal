import {
  ADMIN_SETTINGS_SECRET_KEYS,
  isAdminEditableSettingKey,
  parseAdminSettingsPatch,
} from '../config/systemSettingsRegistry';

describe('OWNER system settings registry', () => {
  test('normalizes supported values and the legacy registration alias', () => {
    expect(parseAdminSettingsPatch({
      registrationMode: 'approval',
      'security.maxLoginAttempts': '005',
      'appearance.accentColor': '#AABBCC',
      'remoteDesktop.allowedPathPrefixes': ' /novnc/, /vnc ',
      'ollama.local.tier.smart': 'qwen3.5:9b',
    })).toEqual({
      'security.registrationMode': 'approval',
      'security.maxLoginAttempts': '5',
      'appearance.accentColor': '#aabbcc',
      'remoteDesktop.allowedPathPrefixes': '/novnc,/vnc',
      'ollama.local.tier.smart': 'qwen3.5:9b',
    });
  });

  test('rejects stale placebo keys and internal operational state', () => {
    expect(() => parseAdminSettingsPatch({ 'agents.enabledProviders': '["OPENCLAW"]' })).toThrow('Unknown or non-editable setting');
    expect(() => parseAdminSettingsPatch({ 'runner.CODEX.enabled': 'true' })).toThrow('Unknown or non-editable setting');
    expect(() => parseAdminSettingsPatch({ 'system.installId': 'replacement' })).toThrow('Unknown or non-editable setting');
    expect(() => parseAdminSettingsPatch({ 'ollama.remoteHost': 'http://100.64.0.20:11434' })).toThrow('Unknown or non-editable setting');
    expect(() => parseAdminSettingsPatch({ 'ollama.host': 'http://127.0.0.1:11434' })).toThrow('Unknown or non-editable setting');
    expect(() => parseAdminSettingsPatch({ 'ollama.remote.tier.smart': 'qwen3.5:9b' })).toThrow('Unknown or non-editable setting');
    expect(isAdminEditableSettingKey('ollama.remoteHost')).toBe(false);
    expect(isAdminEditableSettingKey('ollama.host')).toBe(false);
    expect(isAdminEditableSettingKey('ollama.remote.tier.smart')).toBe(false);
  });

  test('rejects malformed booleans, bounds, URLs, paths, colors, and model names', () => {
    expect(() => parseAdminSettingsPatch({ 'system.allowTelemetry': 'yes' })).toThrow();
    expect(() => parseAdminSettingsPatch({ 'security.maxLoginAttempts': '0' })).toThrow();
    expect(() => parseAdminSettingsPatch({ 'remoteDesktop.allowedPathPrefixes': '/../private' })).toThrow();
    expect(() => parseAdminSettingsPatch({ 'remoteDesktop.allowedPathPrefixes': '/' })).toThrow();
    expect(() => parseAdminSettingsPatch({ 'remoteDesktop.allowedPathPrefixes': '/novnc?next=/api' })).toThrow();
    expect(() => parseAdminSettingsPatch({ 'remoteDesktop.allowedPathPrefixes': '/novnc\\escape' })).toThrow();
    expect(() => parseAdminSettingsPatch({ 'appearance.accentColor': '#123' })).toThrow();
    expect(() => parseAdminSettingsPatch({ 'ollama.defaultModel': 'model name' })).toThrow();
  });

  test('accepts only explicit provider avatar and Ollama tier patterns', () => {
    expect(isAdminEditableSettingKey('appearance.agentAvatar.GROK')).toBe(true);
    expect(isAdminEditableSettingKey('appearance.agentAvatar.UNKNOWN')).toBe(false);
    expect(isAdminEditableSettingKey('ollama.local.tier.best')).toBe(true);
    expect(isAdminEditableSettingKey('ollama.local.tier.unbounded')).toBe(false);
    expect(ADMIN_SETTINGS_SECRET_KEYS.has('smtp.password')).toBe(true);
  });

  test('rejects conflicting canonical and legacy registration values', () => {
    expect(() => parseAdminSettingsPatch({
      registrationMode: 'open',
      'security.registrationMode': 'closed',
    })).toThrow('Conflicting values');
  });
});
