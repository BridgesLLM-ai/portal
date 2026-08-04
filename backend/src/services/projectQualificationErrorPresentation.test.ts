import { CodexProjectEgressRuntimeError } from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import { NativeCliProjectEgressRuntimeError } from '../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime';
import { OpenClawProjectSandboxError } from './openclawProjectSandbox';
import { ProjectEgressAttestationError } from './projectEgressPlane';
import { presentProjectQualificationError } from './projectQualificationErrorPresentation';
import { OpenClawProjectQualificationError } from './openclawProjectQualification';

describe('project qualification error presentation', () => {
  test.each([
    new ProjectEgressAttestationError('STALE_NETWORK_IDENTITY', 'secret Docker detail'),
    new OpenClawProjectSandboxError('OPENCLAW_SECRET_CAUSE', 'secret OpenClaw detail'),
    new CodexProjectEgressRuntimeError('CODEX_SECRET_CAUSE', 'secret Codex detail'),
    new NativeCliProjectEgressRuntimeError('NATIVE_SECRET_CAUSE', 'secret native detail'),
  ])('presents runtime policy failures as host maintenance faults without leaking internals', (error) => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const presented = presentProjectQualificationError(error, 'OPENCLAW');

    expect(presented).toEqual({
      status: 503,
      body: {
        error: expect.stringContaining('server maintenance fault'),
        code: 'PROJECT_RUNTIME_POLICY_FAILED',
        retryable: false,
        recovery: 'HOST_MAINTENANCE',
      },
    });
    expect(JSON.stringify(presented)).not.toContain(error.code);
    expect(JSON.stringify(presented)).not.toContain(error.message);
    expect(presented?.body.error).toContain('not an account permission problem');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(error.code),
      error.message,
    );
    log.mockRestore();
  });

  test('makes a confined model-probe permission failure non-retryable host maintenance', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new OpenClawProjectQualificationError(
      'MODEL_PROBE_PERMISSION',
      'secret confined provider permission detail',
    );

    expect(presentProjectQualificationError(error, 'OPENCLAW')).toEqual({
      status: 503,
      body: {
        error: expect.stringContaining('server maintenance fault'),
        code: 'PROJECT_RUNTIME_POLICY_FAILED',
        retryable: false,
        recovery: 'HOST_MAINTENANCE',
      },
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('MODEL_PROBE_PERMISSION'),
      error.message,
    );
    log.mockRestore();
  });

  test('reports a bounded redacted gateway config diagnostic only when the caller is an operator', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'gateway-secret-that-must-not-leak';
    const error = new OpenClawProjectSandboxError(
      'CONFIG_PATCH_FAILED',
      'OpenClaw Project config could not be patched',
      {
        errorCode: 'INVALID_REQUEST',
        errorMessage: `config.patch rejected agents.list; password=${secret}`,
      },
    );

    const userPresentation = presentProjectQualificationError(error, 'OPENCLAW');
    expect(userPresentation?.body).not.toHaveProperty('operatorDiagnostic');

    const operatorPresentation = presentProjectQualificationError(error, 'OPENCLAW', {
      includeOperatorDiagnostic: true,
    });
    expect(operatorPresentation?.body.operatorDiagnostic).toEqual({
      source: 'OPENCLAW_GATEWAY',
      operation: 'config.patch',
      errorCode: 'INVALID_REQUEST',
      errorMessage: 'config.patch rejected agents.list; password=[redacted]',
    });
    expect(JSON.stringify(operatorPresentation)).not.toContain(secret);
    log.mockRestore();
  });
});
