import { auditAppApiTargetBindings } from './appApiTargetBindingAudit';

describe('App API target binding audit', () => {
  test('blocks an exact legacy name key when the immutable App-id key is missing', () => {
    const result = auditAppApiTargetBindings(
      [{ id: 'app-123', name: 'Legacy Reports' }],
      { APP_API_TARGET_LEGACY_REPORTS: 'http://127.0.0.1:5002' },
    );

    expect(result).toEqual({
      checkedApps: 1,
      blockers: [{
        kind: 'missing-id-binding',
        appId: 'app-123',
        obsoleteNameKey: 'APP_API_TARGET_LEGACY_REPORTS',
        requiredIdKey: 'APP_API_TARGET_APP_123',
      }],
      warnings: [],
    });
  });

  test('warns without blocking when the immutable id key already exists', () => {
    const result = auditAppApiTargetBindings(
      [{ id: 'app-123', name: 'Rate Tool' }],
      {
        APP_API_TARGET_RATE_TOOL: 'http://127.0.0.1:5002',
        APP_API_TARGET_APP_123: 'http://127.0.0.1:5002',
      },
    );

    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([{
      kind: 'obsolete-name-binding',
      appId: 'app-123',
      obsoleteNameKey: 'APP_API_TARGET_RATE_TOOL',
      requiredIdKey: 'APP_API_TARGET_APP_123',
    }]);
  });

  test('does not infer a legacy binding when the name token is another App id', () => {
    const result = auditAppApiTargetBindings(
      [
        { id: 'app-123', name: 'app-456' },
        { id: 'app-456', name: 'second' },
      ],
      { APP_API_TARGET_APP_456: 'http://127.0.0.1:5003' },
    );

    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('does not treat a missing optional id binding as an outage without an exact legacy key', () => {
    const result = auditAppApiTargetBindings(
      [{ id: 'app-123', name: 'Rate Tool' }],
      { APP_API_TARGET_UNRELATED: 'http://127.0.0.1:5999' },
    );

    expect(result).toEqual({ checkedApps: 1, blockers: [], warnings: [] });
  });

  test('blocks malformed immutable id bindings without printing their values', () => {
    const result = auditAppApiTargetBindings(
      [{ id: 'app-123', name: 'Rate Tool' }],
      { APP_API_TARGET_APP_123: 'https://attacker.example/private?secret=value' },
    );

    expect(result.blockers).toEqual([{
      kind: 'invalid-id-binding',
      appId: 'app-123',
      requiredIdKey: 'APP_API_TARGET_APP_123',
    }]);
    expect(JSON.stringify(result)).not.toContain('attacker.example');
    expect(JSON.stringify(result)).not.toContain('secret=value');
  });
});
