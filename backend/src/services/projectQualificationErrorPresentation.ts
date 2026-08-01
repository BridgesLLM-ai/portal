import { ProjectEgressAttestationError } from './projectEgressPlane';
import { OpenClawProjectSandboxError } from './openclawProjectSandbox';
import { OpenClawProjectQualificationError } from './openclawProjectQualification';
import {
  getProjectChatProviderRuntimeDescriptor,
  type QualifiableProjectProvider,
} from './projectChatProviderRegistry';
import { CodexProjectEgressRuntimeError } from '../agents/providers/native/projectSandbox/CodexProjectEgressRuntime';
import { NativeCliProjectEgressRuntimeError } from '../agents/providers/native/projectSandbox/NativeCliProjectEgressRuntime';
import { NativeProviderDiagnosticError } from '../agents/providers/native/NativeProviderDiagnostics';
import { OllamaProjectModelBridgeError } from '../agents/providers/ollama/OllamaProjectModelBridge';

export interface PresentedProjectQualificationError {
  status: number;
  body: {
    error: string;
    code: string;
    retryable?: boolean;
    recovery?: 'HOST_MAINTENANCE';
  };
}

function providerDisplayName(provider: QualifiableProjectProvider | null): string {
  if (!provider) return 'The provider';
  try {
    return getProjectChatProviderRuntimeDescriptor(provider).displayName;
  } catch {
    return 'The provider';
  }
}

function hostSignInGuidance(provider: QualifiableProjectProvider | null): string {
  return `${providerDisplayName(provider)} is not signed in on this server. Complete its CLI login on the host, then select the provider again.`;
}

/**
 * Classify a Project provider qualification failure into an honest,
 * operator-actionable response. Environmental conditions (host sign-in,
 * backend reachability, rate limits) must never collapse into the generic
 * qualification failure: that reads as a Portal defect and hides the fix.
 * Returns null when the error is not a recognized qualification shape.
 */
export function presentProjectQualificationError(
  error: unknown,
  provider: QualifiableProjectProvider | null = null,
): PresentedProjectQualificationError | null {
  if (error instanceof ProjectEgressAttestationError
    || error instanceof CodexProjectEgressRuntimeError
    || error instanceof NativeCliProjectEgressRuntimeError
    || error instanceof OpenClawProjectSandboxError) {
    console.error(`[Project Provider Qualification] Runtime attestation failed (${error.code}):`, error.message);
    return {
      status: 503,
      body: {
        error: 'Portal could not safely converge the provider’s confined project runtime. This is a server maintenance fault, not an account permission problem. Update or repair the Portal host, then retry.',
        code: 'PROJECT_RUNTIME_POLICY_FAILED',
        retryable: false,
        recovery: 'HOST_MAINTENANCE',
      },
    };
  }
  if (error instanceof NativeProviderDiagnosticError) {
    console.error(`[Project Provider Qualification] Provider diagnostic (${error.code}):`, error.message);
    const diagnosticResponses: Record<string, { code: string; error: string }> = {
      AUTH_REQUIRED: {
        code: 'PROJECT_PROVIDER_AUTH_REQUIRED',
        error: hostSignInGuidance(provider),
      },
      MODEL_REJECTED: {
        code: 'PROJECT_PROVIDER_MODEL_REJECTED',
        error: 'The provider rejected the selected model. Choose an available model and retry.',
      },
      RATE_LIMITED: {
        code: 'PROJECT_PROVIDER_RATE_LIMITED',
        error: 'The provider is temporarily rate limited. Wait for its quota window and retry.',
      },
      TIMED_OUT: {
        code: 'PROJECT_PROVIDER_TIMED_OUT',
        error: 'The provider did not respond before the qualification timeout. Retry once it is responsive.',
      },
    };
    const mapped = diagnosticResponses[error.code] || {
      code: 'PROJECT_QUALIFICATION_FAILED',
      error: `${providerDisplayName(provider)} could not complete qualification on this server. Check its host installation and retry.`,
    };
    return { status: 503, body: mapped };
  }
  if (error instanceof OllamaProjectModelBridgeError) {
    console.error(`[Project Provider Qualification] Ollama bridge (${error.code}):`, error.message);
    return {
      status: 503,
      body: {
        error: 'The Ollama bridge or its selected backend is unavailable. Connect a reachable Ollama backend in Settings, then select the provider again.',
        code: 'PROJECT_PROVIDER_BACKEND_UNAVAILABLE',
      },
    };
  }
  if (!(error instanceof OpenClawProjectQualificationError)) return null;
  const unavailable = [
    'EVIDENCE_MISSING',
    'EVIDENCE_EXPIRED',
    'EVIDENCE_CONTEXT_DRIFT',
    'EVIDENCE_MAC',
    'QUALIFICATION_GRANT',
  ].includes(error.code);
  if (!unavailable) {
    // The response stays generic, but a real qualification failure with no
    // server-side record is undiagnosable on a live host.
    console.error(`[Project Provider Qualification] Failed (${error.code}):`, error.message);
  }
  const actionableFailures: Record<string, PresentedProjectQualificationError['body']> = {
    MODEL_PROBE_AUTH: {
      code: 'PROJECT_PROVIDER_AUTH_REQUIRED',
      error: provider && provider !== 'OPENCLAW'
        ? hostSignInGuidance(provider)
        : 'Provider authentication is unavailable. Reconnect it in AI Settings and retry.',
    },
    MODEL_PROBE_MODEL: {
      code: 'PROJECT_PROVIDER_MODEL_REJECTED',
      error: 'The provider rejected the selected model. Choose an available model and retry.',
    },
    MODEL_PROBE_RATE_LIMIT: {
      code: 'PROJECT_PROVIDER_RATE_LIMITED',
      error: 'The provider is temporarily rate limited. Wait for its quota window and retry.',
    },
    MODEL_PROBE_TIMEOUT: {
      code: 'PROJECT_PROVIDER_TIMED_OUT',
      error: 'The provider did not respond before the qualification timeout. Retry once it is responsive.',
    },
    MODEL_PROBE_PERMISSION: {
      code: 'PROJECT_RUNTIME_POLICY_FAILED',
      error: 'The provider could not safely complete the qualification challenge inside the confined project runtime. This is a server maintenance fault, not an account permission problem. Update or repair the Portal host, then retry.',
      retryable: false,
      recovery: 'HOST_MAINTENANCE',
    },
  };
  const actionableFailure = actionableFailures[error.code];
  if (unavailable) {
    return {
      status: 409,
      body: {
        error: 'The selected provider must complete live qualification for this project before Project Chat can run.',
        code: 'PROJECT_QUALIFICATION_REQUIRED',
      },
    };
  }
  return {
    status: 503,
    body: actionableFailure || {
      error: 'Project provider qualification did not complete. The provider remains unavailable.',
      code: 'PROJECT_QUALIFICATION_FAILED',
    },
  };
}
