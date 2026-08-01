import {
  PROJECT_RUNTIME_CLEANUP_PROVIDERS,
  type ProjectEgressCleanupAdapter,
  type ProjectRuntimeCleanupProvider,
  type ProjectRuntimeCleanupScope,
  type ProjectRuntimeResource,
  type ProjectRuntimeResourceKind,
} from './projectRuntimeCleanup';
import {
  discoverProjectEgressPlaneResources,
  teardownExactProjectEgressPlane,
  teardownProjectEgressPlaneResources,
  type ProjectEgressCommandExecutor,
  type ProjectEgressDiscoveredResource,
  type ProjectEgressIdentity,
} from './projectEgressPlane';

export interface ProjectEgressCleanupAdapterOptions {
  executor?: ProjectEgressCommandExecutor;
}

function expectedIdentities(scope: ProjectRuntimeCleanupScope): ProjectEgressIdentity[] {
  return scope.knownActorIds.flatMap((actorId) => PROJECT_RUNTIME_CLEANUP_PROVIDERS.map((provider) => ({
    actorId,
    projectId: scope.projectIdentity.id,
    provider,
  })));
}

function cleanupProvider(value: string | null): ProjectRuntimeCleanupProvider | null {
  if (value === null) return null;
  if (!PROJECT_RUNTIME_CLEANUP_PROVIDERS.includes(value as ProjectRuntimeCleanupProvider)) {
    throw new Error('Project egress discovery returned an unsupported provider identity');
  }
  return value as ProjectRuntimeCleanupProvider;
}

function cleanupKind(resource: ProjectEgressDiscoveredResource): ProjectRuntimeResourceKind {
  switch (resource.kind) {
    case 'PROXY_CONTAINER': return 'EGRESS_PROXY_CONTAINER';
    case 'INTERNAL_NETWORK': return 'EGRESS_INTERNAL_NETWORK';
    case 'PUBLIC_NETWORK': return 'EGRESS_PUBLIC_NETWORK';
    case 'FIREWALL_CHAIN': return 'EGRESS_FIREWALL_CHAIN';
  }
}

function cleanupResource(resource: ProjectEgressDiscoveredResource): ProjectRuntimeResource {
  return Object.freeze({
    id: [
      'project-egress',
      resource.identityFingerprint,
      resource.kind,
      resource.family || 0,
      resource.name,
    ].join(':'),
    kind: cleanupKind(resource),
    projectIdentityId: resource.projectId,
    actorUserId: resource.actorId,
    // Portal-owned Git/build/app planes are project-global cleanup resources,
    // not provider runtimes. They deliberately remain discoverable by the same
    // immutable project labels while avoiding a fake provider assignment.
    provider: resource.consumerKind ? null : cleanupProvider(resource.provider),
  });
}

function resourceKey(resource: ProjectRuntimeResource): string {
  return `${resource.kind}\u0000${resource.id}`;
}

/**
 * Concrete cleanup adapter for the shared Project egress plane. It discovers
 * by immutable project labels/comments (not only known DB bindings), while the
 * expected actor/provider cross-product detects deterministic-name collisions
 * whose labels were stripped.
 */
export function createProjectEgressCleanupAdapter(
  options: ProjectEgressCleanupAdapterOptions = {},
): ProjectEgressCleanupAdapter {
  const discover = async (
    scope: ProjectRuntimeCleanupScope,
    requireNoRuntimeMembers = false,
  ): Promise<readonly ProjectRuntimeResource[]> => {
    const resources = await discoverProjectEgressPlaneResources(
      scope.projectIdentity.id,
      {
        expectedIdentities: expectedIdentities(scope),
        requireNoRuntimeMembers,
      },
      options.executor,
    );
    return Object.freeze(resources.map(cleanupResource));
  };

  return {
    enumerate: (scope) => discover(scope),

    async cleanup(scope, enumeratedResources) {
      const fresh = await discover(scope, true);
      const enumeratedKeys = new Set(enumeratedResources.map(resourceKey));
      if (fresh.some((resource) => !enumeratedKeys.has(resourceKey(resource)))) {
        throw new Error('Project egress resources appeared after cleanup enumeration');
      }
      await teardownProjectEgressPlaneResources(
        scope.projectIdentity.id,
        { expectedIdentities: expectedIdentities(scope) },
        options.executor,
      );
    },

    verifyClean: (scope) => discover(scope, true),
  };
}

/**
 * Authorization transitions retire provider planes while preserving unrelated
 * Portal Git/build/app workloads for the same immutable project. The global
 * authorization barrier has already drained one-shot Portal workloads; a
 * long-lived hosted app is not an authenticated provider runtime and must not
 * be destroyed merely because an account role changed.
 */
export function createProjectAuthorizationEgressCleanupAdapter(
  options: ProjectEgressCleanupAdapterOptions = {},
): ProjectEgressCleanupAdapter {
  const discoverProviders = async (
    scope: ProjectRuntimeCleanupScope,
  ): Promise<readonly ProjectRuntimeResource[]> => {
    const resources = await discoverProjectEgressPlaneResources(
      scope.projectIdentity.id,
      { expectedIdentities: expectedIdentities(scope) },
      options.executor,
    );
    return Object.freeze(resources
      .filter((resource) => resource.consumerKind === null)
      .map(cleanupResource));
  };

  return {
    enumerate: discoverProviders,

    async cleanup(scope, enumeratedResources) {
      const fresh = await discoverProviders(scope);
      const enumeratedKeys = new Set(enumeratedResources.map(resourceKey));
      if (fresh.some((resource) => !enumeratedKeys.has(resourceKey(resource)))) {
        throw new Error('Project provider egress resources appeared after authorization enumeration');
      }
      const identities = new Map<string, ProjectEgressIdentity>();
      for (const resource of fresh) {
        if (!resource.actorUserId || !resource.provider) {
          throw new Error('Project provider egress resource lost its actor/provider identity');
        }
        const identity = {
          actorId: resource.actorUserId,
          projectId: scope.projectIdentity.id,
          provider: resource.provider,
        };
        identities.set(`${identity.actorId}\0${identity.provider}`, identity);
      }
      for (const identity of [...identities.values()].sort((left, right) => (
        `${left.actorId}\0${left.provider}`.localeCompare(`${right.actorId}\0${right.provider}`)
      ))) {
        await teardownExactProjectEgressPlane(identity, options.executor);
      }
    },

    verifyClean: discoverProviders,
  };
}
