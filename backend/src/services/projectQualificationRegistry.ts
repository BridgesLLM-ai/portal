/**
 * Provider-neutral Project qualification entrypoint.
 *
 * Existing OpenClaw routes continue to import their compatibility module.
 * New provider routes should use this registry so provider evidence, grants,
 * runtime attestation, and model challenges cannot be mixed accidentally.
 */
export {
  PROJECT_QUALIFICATION_REQUIRED_PROBES,
  QUALIFIABLE_PROJECT_PROVIDERS,
  assertProjectQualificationGrant,
  getProjectQualificationLane,
  getProjectQualificationStatus,
  listProjectQualificationLanes,
  projectQualificationVersionFor,
  qualificationMacDomainFor,
  qualifyProjectProvider,
  removeProjectQualificationEvidence,
  removeProjectQualificationEvidenceForProject,
  requireProjectQualification,
  type ProjectQualificationEnvelope,
  type ProjectQualificationDependencies,
  type ProjectQualificationGrant,
  type ProjectQualificationLaneAdapter,
  type ProjectQualificationPayload,
  type ProjectQualificationProbeBundle,
  type ProjectQualificationProbeId,
  type ProjectQualificationProbeResult,
  type ProjectQualificationStatus,
  type ProjectQualificationRuntimeAttestation,
  type ProjectQualificationSandboxResult,
  type QualifiableProjectProvider,
} from './openclawProjectQualification';
