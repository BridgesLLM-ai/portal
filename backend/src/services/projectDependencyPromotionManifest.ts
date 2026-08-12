import crypto from 'crypto';
import path from 'path';

export interface ProjectDependencyPromotionEntryIdentity {
  device: string;
  inode: string;
  kind: 'file' | 'directory';
  mode: number;
  uid: number;
  gid: number;
  birthtimeNs: string;
}

export interface ProjectDependencyPromotionManifestInput {
  schemaVersion: 1;
  operationId: string;
  workspaceOwnerId: string;
  projectName: string;
  projectIdentityId: string;
  projectIdentityGeneration: number;
  projectRootBirthtimeNs: string;
  operationParentCanonicalRoot: string;
  operationParentIdentity: ProjectDependencyPromotionEntryIdentity;
  destinationCanonicalRoot: string;
  destinationIdentity: ProjectDependencyPromotionEntryIdentity;
  stagingCanonicalRoot: string;
  stagingIdentity: ProjectDependencyPromotionEntryIdentity;
  entries: ReadonlyArray<Readonly<{
    artifact: string;
    originalIdentity: Readonly<ProjectDependencyPromotionEntryIdentity> | null;
    stagedIdentity: Readonly<ProjectDependencyPromotionEntryIdentity> | null;
    stagedTreeDigest: string | null;
  }>>;
}

export interface ProjectDependencyPromotionManifest
  extends Readonly<ProjectDependencyPromotionManifestInput> {
  readonly manifestDigest: string;
}

function requireString(value: unknown, label: string, maxLength = 4096): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || value.includes('\0')) {
    throw new Error(`Invalid Project dependency promotion ${label}`);
  }
  return value;
}

function canonicalIdentity(
  input: Readonly<ProjectDependencyPromotionEntryIdentity>,
): ProjectDependencyPromotionEntryIdentity {
  if (
    !input
    || !/^\d+$/.test(input.device)
    || !/^\d+$/.test(input.inode)
    || (input.kind !== 'file' && input.kind !== 'directory')
    || !Number.isInteger(input.mode)
    || input.mode < 0
    || input.mode > 0o777
    || !Number.isInteger(input.uid)
    || input.uid < 0
    || !Number.isInteger(input.gid)
    || input.gid < 0
    || !/^\d+$/.test(input.birthtimeNs)
  ) throw new Error('Invalid Project dependency promotion filesystem identity');
  return {
    device: input.device,
    inode: input.inode,
    kind: input.kind,
    mode: input.mode,
    uid: input.uid,
    gid: input.gid,
    birthtimeNs: input.birthtimeNs,
  };
}

/**
 * The sole canonical digest builder for preparation, admission and recovery.
 * Mutable journal state, phases, timestamps and journal-file inode are absent.
 */
export function buildProjectDependencyPromotionManifest(
  input: ProjectDependencyPromotionManifestInput,
): ProjectDependencyPromotionManifest {
  const destinationCanonicalRoot = requireString(input.destinationCanonicalRoot, 'destination root');
  const stagingCanonicalRoot = requireString(input.stagingCanonicalRoot, 'staging root');
  const operationParentCanonicalRoot = requireString(
    input.operationParentCanonicalRoot,
    'operation parent root',
  );
  if (
    input.schemaVersion !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)
    || path.resolve(destinationCanonicalRoot) !== destinationCanonicalRoot
    || path.resolve(stagingCanonicalRoot) !== stagingCanonicalRoot
    || path.resolve(operationParentCanonicalRoot) !== operationParentCanonicalRoot
    || path.dirname(destinationCanonicalRoot) !== operationParentCanonicalRoot
    || path.dirname(stagingCanonicalRoot) !== operationParentCanonicalRoot
    || !Number.isSafeInteger(input.projectIdentityGeneration)
    || input.projectIdentityGeneration < 1
    || !/^\d+$/.test(input.projectRootBirthtimeNs)
    || input.entries.length < 1
    || input.entries.length > 16
  ) throw new Error('Invalid Project dependency promotion manifest');
  const canonical: ProjectDependencyPromotionManifestInput = {
    schemaVersion: 1,
    operationId: input.operationId.toLowerCase(),
    workspaceOwnerId: requireString(input.workspaceOwnerId, 'workspace owner', 255),
    projectName: requireString(input.projectName, 'Project name', 255),
    projectIdentityId: requireString(input.projectIdentityId, 'Project identity', 255),
    projectIdentityGeneration: input.projectIdentityGeneration,
    projectRootBirthtimeNs: input.projectRootBirthtimeNs,
    operationParentCanonicalRoot,
    operationParentIdentity: canonicalIdentity(input.operationParentIdentity),
    destinationCanonicalRoot,
    destinationIdentity: canonicalIdentity(input.destinationIdentity),
    stagingCanonicalRoot,
    stagingIdentity: canonicalIdentity(input.stagingIdentity),
    entries: input.entries.map((entry) => ({
      artifact: /^[a-zA-Z0-9._-]+$/.test(entry.artifact)
        ? entry.artifact
        : (() => { throw new Error('Invalid Project dependency promotion artifact'); })(),
      originalIdentity: entry.originalIdentity ? canonicalIdentity(entry.originalIdentity) : null,
      stagedIdentity: entry.stagedIdentity ? canonicalIdentity(entry.stagedIdentity) : null,
      stagedTreeDigest: entry.stagedIdentity
        ? (/^[a-f0-9]{64}$/.test(entry.stagedTreeDigest || '')
          ? entry.stagedTreeDigest
          : (() => { throw new Error('Invalid Project dependency promotion staged-tree digest'); })())
        : (entry.stagedTreeDigest === null
          ? null
          : (() => { throw new Error('Unexpected Project dependency promotion staged-tree digest'); })()),
    })),
  };
  if (new Set(canonical.entries.map((entry) => entry.artifact)).size !== canonical.entries.length) {
    throw new Error('Duplicate Project dependency promotion artifact');
  }
  const manifestDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
  return Object.freeze({
    ...canonical,
    destinationIdentity: Object.freeze(canonical.destinationIdentity),
    operationParentIdentity: Object.freeze(canonical.operationParentIdentity),
    stagingIdentity: Object.freeze(canonical.stagingIdentity),
    entries: Object.freeze(canonical.entries.map((entry) => Object.freeze({
      ...entry,
      ...(entry.originalIdentity ? { originalIdentity: Object.freeze(entry.originalIdentity) } : {}),
      ...(entry.stagedIdentity ? { stagedIdentity: Object.freeze(entry.stagedIdentity) } : {}),
    }))),
    manifestDigest,
  });
}
