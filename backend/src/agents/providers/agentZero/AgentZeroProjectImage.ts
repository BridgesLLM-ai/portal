import {
  AGENT_ZERO_IMAGE_DIGESTS,
  normalizeAgentZeroArchitecture,
  type AgentZeroArchitecture,
} from './AgentZeroRuntime';

export const AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ENV = 'AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ID';
export const AGENT_ZERO_PROJECT_IMAGE_RECIPE_LABEL = 'com.bridgesllm.agent-zero-project.recipe-sha256';
export const AGENT_ZERO_PROJECT_IMAGE_SOURCE_COMMIT_LABEL = 'com.bridgesllm.agent-zero-project.source-commit';
export const AGENT_ZERO_PROJECT_IMAGE_UPSTREAM_DIGEST_LABEL = 'com.bridgesllm.agent-zero-project.upstream-digest';
export const AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER_LABEL = 'com.bridgesllm.agent-zero-project.runtime-user';
export const AGENT_ZERO_PROJECT_IMAGE_RUNTIME_USER = '1000:1000';

/**
 * Both immutable v2.5 architecture images were inspected at their registry
 * manifests. Their /git/agent-zero checkout points at the peeled v2.5 commit.
 * The derived image build re-verifies this value before copying any source.
 */
export const AGENT_ZERO_PROJECT_SOURCE_COMMITS: Readonly<Record<AgentZeroArchitecture, string>> = Object.freeze({
  amd64: 'd1d48bc9c0e6e253e87c354ce757c518820c6e25',
  arm64: 'd1d48bc9c0e6e253e87c354ce757c518820c6e25',
});

export const AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS = AGENT_ZERO_IMAGE_DIGESTS;

export function getAgentZeroProjectUpstreamImageRef(architecture: string): string | null {
  const normalized = normalizeAgentZeroArchitecture(architecture);
  if (!normalized) return null;
  return `agent0ai/agent-zero@${AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS[normalized]}`;
}

export function getAgentZeroProjectSourceCommit(architecture: string): string | null {
  const normalized = normalizeAgentZeroArchitecture(architecture);
  return normalized ? AGENT_ZERO_PROJECT_SOURCE_COMMITS[normalized] : null;
}

export function normalizeAgentZeroProjectSandboxImageId(value: unknown): string | null {
  const imageId = String(value || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) return null;
  // Registry manifest digests identify the privileged upstream image, not the
  // installer-built non-root Project image. They are never valid runtime IDs
  // even though both happen to share Docker's sha256:<hex> syntax.
  if (Object.values(AGENT_ZERO_PROJECT_UPSTREAM_IMAGE_DIGESTS)
    .some((digest) => digest === imageId)) return null;
  return imageId;
}

export function getAgentZeroProjectSandboxImageId(
  override?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  return normalizeAgentZeroProjectSandboxImageId(
    override === undefined
      ? environment[AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ENV]
      : override,
  );
}
