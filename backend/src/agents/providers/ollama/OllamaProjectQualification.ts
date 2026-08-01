import crypto from 'crypto';
import type { ProjectSandboxExecutionContext } from '../../AgentProvider.interface';
import { assertExecutionContextBinding } from '../../executionScope';
import {
  openOllamaProjectModelBridge,
  type OllamaProjectModelBridgeHandle,
  type OllamaProjectModelBridgeBoundaryProof,
  type OllamaProjectModelBridgeOptions,
} from './OllamaProjectModelBridge';
import {
  OLLAMA_PROJECT_CAPABILITY_PROBE_TOOL,
  proveOllamaProjectModel,
  type OllamaProjectModelProof,
} from './OllamaProjectProvider';
import {
  ollamaProjectModelBindingValue,
  type OllamaProjectModelSelection,
} from '../../../services/ollamaProjectModel';
import {
  OLLAMA_PROJECT_RUNTIME,
  OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
  OLLAMA_PROJECT_TOOL_NAMES,
  OllamaProjectToolRuntime,
  type OllamaProjectRuntimeAccessProof,
  type OllamaProjectRuntimeHandle,
} from './OllamaProjectToolRuntime';

export const OLLAMA_PROJECT_QUALIFICATION_SCHEMA = 'bridgesllm.ollama-project-qualification.v1';
export const OLLAMA_PROJECT_QUALIFICATION_TTL_MS = 5 * 60_000;

export interface OllamaProjectQualificationEvidence {
  schema: typeof OLLAMA_PROJECT_QUALIFICATION_SCHEMA;
  runtime: typeof OLLAMA_PROJECT_RUNTIME;
  runtimePolicyVersion: typeof OLLAMA_PROJECT_RUNTIME_POLICY_VERSION;
  actorUserId: string;
  projectIdentityId: string;
  policyFingerprint: string;
  runtimeFingerprint: string;
  runtimeImage: string;
  containerId: string;
  containerName: string;
  containerStartedAt: string;
  containerNetwork: 'none';
  exactProjectRwBind: true;
  runtimeAccessProof: OllamaProjectRuntimeAccessProof;
  nonRootReadOnlyCapDrop: true;
  modelBridgeLoopbackOnly: true;
  modelBridgeAuthenticated: true;
  modelBridgeBoundaryProof: OllamaProjectModelBridgeBoundaryProof;
  model: string;
  modelDigest: string;
  modelCapabilities: readonly string[];
  backendKind: 'LOCAL' | 'TAILNET';
  backendFingerprint: string;
  backendGeneration: number | null;
  modelToolProbe: true;
  qualifiedAt: string;
  expiresAt: string;
}

type BridgeFactory = typeof openOllamaProjectModelBridge;

export interface OllamaProjectQualificationOptions {
  runtime?: OllamaProjectToolRuntime;
  bridgeFactory?: BridgeFactory;
  bridgeOptions?: OllamaProjectModelBridgeOptions;
  now?: () => number;
  nonceFactory?: () => string;
}

function qualificationSessionId(
  context: ProjectSandboxExecutionContext,
  selection: OllamaProjectModelSelection,
): string {
  return 'qualification-' + crypto.createHash('sha256').update(JSON.stringify({
    actor: context.userId,
    project: context.projectId,
    modelBinding: ollamaProjectModelBindingValue(selection),
    policy: context.policyFingerprint,
  })).digest('hex').slice(0, 32);
}

function evidence(input: {
  context: ProjectSandboxExecutionContext;
  runtime: OllamaProjectRuntimeHandle;
  proof: OllamaProjectModelProof;
  bridgeBoundaryProof: OllamaProjectModelBridgeBoundaryProof;
  now: number;
}): OllamaProjectQualificationEvidence {
  return Object.freeze({
    schema: OLLAMA_PROJECT_QUALIFICATION_SCHEMA,
    runtime: OLLAMA_PROJECT_RUNTIME,
    runtimePolicyVersion: OLLAMA_PROJECT_RUNTIME_POLICY_VERSION,
    actorUserId: input.context.userId,
    projectIdentityId: input.context.projectId,
    policyFingerprint: input.context.policyFingerprint,
    runtimeFingerprint: input.runtime.runtimeFingerprint,
    runtimeImage: input.runtime.runtimeImage,
    containerId: input.runtime.containerId,
    containerName: input.runtime.containerName,
    containerStartedAt: input.runtime.startedAt,
    containerNetwork: 'none' as const,
    exactProjectRwBind: true as const,
    runtimeAccessProof: input.runtime.accessProof,
    nonRootReadOnlyCapDrop: true as const,
    modelBridgeLoopbackOnly: true as const,
    modelBridgeAuthenticated: true as const,
    modelBridgeBoundaryProof: input.bridgeBoundaryProof,
    model: input.proof.model,
    modelDigest: input.proof.digest,
    modelCapabilities: Object.freeze([...input.proof.capabilities]),
    backendKind: input.proof.backendKind,
    backendFingerprint: input.proof.backendFingerprint,
    backendGeneration: input.proof.backendGeneration,
    modelToolProbe: true as const,
    qualifiedAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + OLLAMA_PROJECT_QUALIFICATION_TTL_MS).toISOString(),
  });
}

export async function qualifyOllamaProjectFoundation(input: {
  context: ProjectSandboxExecutionContext;
  modelSelection: OllamaProjectModelSelection;
  options?: OllamaProjectQualificationOptions;
}): Promise<OllamaProjectQualificationEvidence> {
  assertExecutionContextBinding(input.context, input.context.userId, 'PROJECT_SANDBOX');
  if (input.context.runtimePolicyVersion !== OLLAMA_PROJECT_RUNTIME_POLICY_VERSION) {
    throw new Error('Ollama Project qualification received a mismatched runtime policy.');
  }
  const runtime = input.options?.runtime || new OllamaProjectToolRuntime();
  // Admission needs a fresh write/read/unlink proof, not a cached image/mount
  // inspection from an earlier turn.
  const runtimeHandle = await runtime.qualify(input.context);
  const bridgeFactory = input.options?.bridgeFactory || openOllamaProjectModelBridge;
  let bridge: OllamaProjectModelBridgeHandle | null = null;
  try {
    bridge = await bridgeFactory({
      context: input.context,
      sessionId: qualificationSessionId(input.context, input.modelSelection),
      model: input.modelSelection.model,
      modelDigest: input.modelSelection.digest,
      backend: input.modelSelection,
      allowedToolNames: [...OLLAMA_PROJECT_TOOL_NAMES, OLLAMA_PROJECT_CAPABILITY_PROBE_TOOL],
      options: input.options?.bridgeOptions,
    });
    const bridgeBoundaryProof = await bridge.proveBoundary();
    const proof = await proveOllamaProjectModel({
      client: bridge.client,
      model: input.modelSelection.model,
      nonceFactory: input.options?.nonceFactory,
    });
    return evidence({
      context: input.context,
      runtime: runtimeHandle,
      proof,
      bridgeBoundaryProof,
      now: input.options?.now?.() || Date.now(),
    });
  } finally {
    await bridge?.close().catch(() => undefined);
  }
}
