import {
  PROJECT_RUNTIME_AUTHORIZATION_POLICY,
  PROJECT_RUNTIME_AUTHORIZATION_READY_CODE,
  PROJECT_RUNTIME_AUTHORIZATION_READY_MESSAGE,
} from './projectRuntimeAuthorizationPolicy';

describe('Project runtime authorization policy', () => {
  test('advertises only the durable restart-recoverable transition path', () => {
    expect(PROJECT_RUNTIME_AUTHORIZATION_POLICY).toEqual({
      ready: true,
      code: PROJECT_RUNTIME_AUTHORIZATION_READY_CODE,
      message: PROJECT_RUNTIME_AUTHORIZATION_READY_MESSAGE,
      fixedGenerationProjectExecution: true,
      authorizationScopeChanges: true,
      retryable: false,
    });
    expect(Object.isFrozen(PROJECT_RUNTIME_AUTHORIZATION_POLICY)).toBe(true);
    expect(JSON.stringify(PROJECT_RUNTIME_AUTHORIZATION_POLICY))
      .not.toMatch(/userId|projectId|session|token|secret|path/i);
  });
});
