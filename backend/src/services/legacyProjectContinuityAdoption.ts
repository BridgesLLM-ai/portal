import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import {
  attestProjectRoot,
  ensureProjectIdentity,
  isInternalProjectDirectoryName,
  type AttestedProjectRoot,
  type ProjectIdentityDatabase,
  type ProjectIdentityRecord,
} from './projectIdentity';

const MAX_CONTINUITY_PROJECTS = 2_048;
const MAX_CONTINUITY_APPS = 100_000;

type ContinuityApp = Readonly<{
  id: string;
  userId: string;
  projectIdentityId: string | null;
  name: string;
  zipPath: string;
  deployType: string;
  processStatus: string;
}>;

interface ContinuityStore extends ProjectIdentityDatabase {
  user: {
    findMany(args: unknown): Promise<Array<{ id: string }>>;
  };
  app: {
    findMany(args: unknown): Promise<ContinuityApp[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

interface ContinuityDatabase extends ContinuityStore {
  $transaction<T>(
    callback: (transaction: ContinuityStore) => Promise<T>,
    options?: { isolationLevel?: 'Serializable'; maxWait?: number; timeout?: number },
  ): Promise<T>;
}

type ContinuityProject = Readonly<{
  workspaceOwnerId: string;
  projectName: string;
  projectRoot: string;
  identity: ProjectIdentityRecord;
}>;

type AppBackfillCandidate = Readonly<{
  app: ContinuityApp;
  project: ContinuityProject;
  deploymentIdentity: AttestedProjectRoot;
}>;

export class LegacyProjectContinuityAdoptionError extends Error {
  readonly code = 'LEGACY_PROJECT_CONTINUITY_INTEGRITY';

  constructor(message: string) {
    super(message);
    this.name = 'LegacyProjectContinuityAdoptionError';
  }
}

function continuityFailure(message: string): never {
  throw new LegacyProjectContinuityAdoptionError(message);
}

function continuityRoots(options: {
  projectsRoot?: string;
  deployRoot?: string;
  legacyDeployRoot?: string;
}): {
  projectsRoot: string;
  configuredDeploymentRoots: readonly Readonly<{
    root: string;
    required: boolean;
  }>[];
} {
  const portalRoot = path.resolve(
    process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal',
  );
  const currentDeployRoot = path.resolve(
    options.deployRoot || process.env.APPS_ROOT || '/var/www/bridgesllm-apps',
  );
  const legacyDeployRoot = path.resolve(
    options.legacyDeployRoot
      || process.env.LEGACY_APP_FILES_DIR
      || '/var/www/bridgesllm-apps',
  );
  const configuredDeploymentRoots = [
    Object.freeze({ root: currentDeployRoot, required: true }),
    ...(legacyDeployRoot === currentDeployRoot
      ? []
      : [Object.freeze({ root: legacyDeployRoot, required: false })]),
  ];
  return {
    projectsRoot: path.resolve(
      options.projectsRoot || process.env.PORTAL_PROJECTS_ROOT || path.join(portalRoot, 'projects'),
    ),
    configuredDeploymentRoots: Object.freeze(configuredDeploymentRoots),
  };
}

function sameDirectoryIdentity(left: AttestedProjectRoot, right: AttestedProjectRoot): boolean {
  return left.canonicalRoot === right.canonicalRoot
    && left.rootDevice === right.rootDevice
    && left.rootInode === right.rootInode
    && left.rootBirthtimeNs === right.rootBirthtimeNs;
}

function attestExactDirectory(directory: string, label: string): AttestedProjectRoot {
  const normalized = path.resolve(directory);
  if (normalized !== directory || directory.includes('\0')) {
    continuityFailure(`${label} was not a normalized absolute directory.`);
  }
  let identity: AttestedProjectRoot;
  try {
    identity = attestProjectRoot(directory);
  } catch {
    continuityFailure(`${label} was not an attested real directory.`);
  }
  if (identity!.canonicalRoot !== directory) {
    continuityFailure(`${label} resolved through a symbolic link.`);
  }
  return identity!;
}

function projectKey(workspaceOwnerId: string, projectName: string): string {
  return `${workspaceOwnerId}\0${projectName}`;
}

function attestConfiguredDeploymentRoots(
  configured: readonly Readonly<{ root: string; required: boolean }>[],
): readonly AttestedProjectRoot[] {
  const attested: AttestedProjectRoot[] = [];
  for (const entry of configured) {
    try {
      fs.lstatSync(entry.root);
    } catch (error: any) {
      if (!entry.required && error?.code === 'ENOENT') continue;
      continuityFailure('A configured managed App deployment root was unavailable.');
    }
    attested.push(attestExactDirectory(entry.root, 'A managed App deployment root'));
  }
  return Object.freeze(attested);
}

function exactProjectAppPaths(
  project: ContinuityProject,
  deploymentRoots: readonly AttestedProjectRoot[],
): ReadonlySet<string> {
  return new Set(deploymentRoots.map(({ canonicalRoot }) => (
    path.join(canonicalRoot, `${project.workspaceOwnerId}-${project.projectName}`)
  )));
}

function appDeploymentAttestation(
  app: ContinuityApp,
  project: ContinuityProject,
  deploymentRoots: readonly AttestedProjectRoot[],
): AttestedProjectRoot | null {
  if (
    !app.zipPath
    || !path.isAbsolute(app.zipPath)
    || path.resolve(app.zipPath) !== app.zipPath
    || !exactProjectAppPaths(project, deploymentRoots).has(app.zipPath)
  ) return null;
  try {
    return attestExactDirectory(app.zipPath, 'A legacy App deployment');
  } catch (error: unknown) {
    if (error instanceof LegacyProjectContinuityAdoptionError) return null;
    throw error;
  }
}

async function enumerateProjects(input: {
  database: ContinuityDatabase;
  projectsRoot: string;
  ensureIdentity: typeof ensureProjectIdentity;
}): Promise<{
  projects: ContinuityProject[];
  enrolled: number;
  ignoredInternalDirectories: number;
  preservedUnownedDirectories: number;
}> {
  const projectsRootIdentity = attestExactDirectory(input.projectsRoot, 'The Projects root');
  const users = await input.database.user.findMany({ select: { id: true } });
  const userIds = new Set(users.map(({ id }) => id));
  const projects: ContinuityProject[] = [];
  let enrolled = 0;
  let ignoredInternalDirectories = 0;
  let preservedUnownedDirectories = 0;

  const ownerEntries = fs.readdirSync(input.projectsRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const ownerEntry of ownerEntries) {
    if (isInternalProjectDirectoryName(ownerEntry.name)) {
      ignoredInternalDirectories += 1;
      continue;
    }
    if (!userIds.has(ownerEntry.name)) {
      preservedUnownedDirectories += 1;
      continue;
    }
    if (ownerEntry.isSymbolicLink() || !ownerEntry.isDirectory()) {
      continuityFailure('A known Project owner path was not a real directory.');
    }
    const ownerRoot = path.join(input.projectsRoot, ownerEntry.name);
    const ownerIdentity = attestExactDirectory(ownerRoot, 'A Project owner directory');
    const projectEntries = fs.readdirSync(ownerRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const projectEntry of projectEntries) {
      if (isInternalProjectDirectoryName(projectEntry.name)) {
        ignoredInternalDirectories += 1;
        continue;
      }
      if (projectEntry.isSymbolicLink() || !projectEntry.isDirectory()) continue;
      if (projects.length >= MAX_CONTINUITY_PROJECTS) {
        continuityFailure('The Project continuity inventory exceeded its safety limit.');
      }
      const projectRoot = path.join(ownerRoot, projectEntry.name);
      attestExactDirectory(projectRoot, 'A legacy Project root');
      const existing = await input.database.projectIdentity.findUnique({
        where: {
          workspaceOwnerId_projectName: {
            workspaceOwnerId: ownerEntry.name,
            projectName: projectEntry.name,
          },
        },
      });
      const identity = await input.ensureIdentity({
        workspaceOwnerId: ownerEntry.name,
        projectName: projectEntry.name,
        projectRoot,
      }, input.database);
      // Startup continuity may enroll the existing inode, but it may never
      // assert that a pre-4.0 root is CURRENT. CURRENT bypasses preserved
      // name/path-keyed OpenClaw evidence and is reserved for a separately
      // proven explicit migration or a Portal-4-born root.
      if (!existing && identity.legacyOpenClawMigrationStatus !== 'NONE') {
        continuityFailure('A legacy Project was enrolled with unsafe CURRENT provenance.');
      }
      if (!existing) enrolled += 1;
      projects.push(Object.freeze({
        workspaceOwnerId: ownerEntry.name,
        projectName: projectEntry.name,
        projectRoot,
        identity,
      }));
    }
    if (!sameDirectoryIdentity(ownerIdentity, attestExactDirectory(ownerRoot, 'A Project owner directory'))) {
      continuityFailure('A Project owner directory changed during continuity enrollment.');
    }
  }
  if (!sameDirectoryIdentity(
    projectsRootIdentity,
    attestExactDirectory(input.projectsRoot, 'The Projects root'),
  )) {
    continuityFailure('The Projects root changed during continuity enrollment.');
  }
  return {
    projects,
    enrolled,
    ignoredInternalDirectories,
    preservedUnownedDirectories,
  };
}

async function planAppBackfill(input: {
  database: ContinuityDatabase;
  projects: readonly ContinuityProject[];
  deploymentRoots: readonly AttestedProjectRoot[];
}): Promise<{
  candidates: AppBackfillCandidate[];
  alreadyAssociated: number;
  leftStandalone: number;
}> {
  const apps = await input.database.app.findMany({
    orderBy: { id: 'asc' },
    take: MAX_CONTINUITY_APPS + 1,
    select: {
      id: true,
      userId: true,
      projectIdentityId: true,
      name: true,
      zipPath: true,
      deployType: true,
      processStatus: true,
    },
  });
  if (apps.length > MAX_CONTINUITY_APPS) {
    continuityFailure('The App continuity inventory exceeded its safety limit.');
  }
  const projectsByName = new Map(
    input.projects.map((project) => [
      projectKey(project.workspaceOwnerId, project.projectName),
      project,
    ]),
  );
  const exactClaimCounts = new Map<string, number>();
  const candidates: AppBackfillCandidate[] = [];
  let alreadyAssociated = 0;
  let leftStandalone = 0;

  for (const app of apps) {
    const project = projectsByName.get(projectKey(app.userId, app.name));
    if (!project) {
      leftStandalone += 1;
      continue;
    }
    const deploymentIdentity = appDeploymentAttestation(app, project, input.deploymentRoots);
    if (!deploymentIdentity) {
      if (app.projectIdentityId === project.identity.id) {
        continuityFailure('A Project-linked App no longer matched its exact deployment path.');
      }
      leftStandalone += 1;
      continue;
    }
    const claimCount = (exactClaimCounts.get(project.identity.id) || 0) + 1;
    exactClaimCounts.set(project.identity.id, claimCount);
    if (claimCount > 1) {
      continuityFailure('More than one App claimed the same attested Project deployment.');
    }
    if (app.projectIdentityId === project.identity.id) {
      alreadyAssociated += 1;
      continue;
    }
    if (app.projectIdentityId !== null) {
      continuityFailure('An App claimed a different immutable Project identity.');
    }
    candidates.push(Object.freeze({ app, project, deploymentIdentity }));
  }
  return { candidates, alreadyAssociated, leftStandalone };
}

async function commitAppBackfill(input: {
  database: ContinuityDatabase;
  candidates: readonly AppBackfillCandidate[];
}): Promise<number> {
  if (input.candidates.length === 0) return 0;
  return input.database.$transaction(async (transaction) => {
    let updated = 0;
    for (const candidate of input.candidates) {
      const before = attestExactDirectory(candidate.app.zipPath, 'A legacy App deployment');
      if (!sameDirectoryIdentity(before, candidate.deploymentIdentity)) {
        continuityFailure('An App deployment changed before continuity association.');
      }
      const result = await transaction.app.updateMany({
        where: {
          id: candidate.app.id,
          userId: candidate.app.userId,
          name: candidate.app.name,
          zipPath: candidate.app.zipPath,
          projectIdentityId: null,
        },
        data: { projectIdentityId: candidate.project.identity.id },
      });
      if (result.count !== 1) {
        continuityFailure('An App changed before continuity association could commit.');
      }
      const after = attestExactDirectory(candidate.app.zipPath, 'A legacy App deployment');
      if (!sameDirectoryIdentity(after, candidate.deploymentIdentity)) {
        continuityFailure('An App deployment changed during continuity association.');
      }
      updated += 1;
    }
    return updated;
  }, { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 });
}

/**
 * Preserve Portal 3.x filesystem/App continuity before any 4.0 runtime starts.
 *
 * This deliberately does not invoke the explicit snapshot/promotion path and
 * never marks an old root CURRENT. It enrolls each exact existing Project inode as NONE, then
 * backfills only an attested App path that already has the same owner/name and
 * one of the product's exact managed deployment shapes. Standalone Apps remain
 * nullable by design. The legacy Project Chat/evidence gate remains intact.
 */
export async function initializeLegacyProjectContinuityAdoption(options: {
  projectsRoot?: string;
  deployRoot?: string;
  legacyDeployRoot?: string;
  database?: ContinuityDatabase;
  ensureIdentity?: typeof ensureProjectIdentity;
} = {}): Promise<{
  projectsFound: number;
  identitiesEnrolled: number;
  appsBackfilled: number;
  appsAlreadyAssociated: number;
  appsLeftStandalone: number;
  ignoredInternalDirectories: number;
  preservedUnownedDirectories: number;
}> {
  const database = options.database || (prisma as unknown as ContinuityDatabase);
  const roots = continuityRoots(options);
  const deploymentRoots = attestConfiguredDeploymentRoots(roots.configuredDeploymentRoots);
  const inventory = await enumerateProjects({
    database,
    projectsRoot: roots.projectsRoot,
    ensureIdentity: options.ensureIdentity || ensureProjectIdentity,
  });
  const appPlan = await planAppBackfill({
    database,
    projects: inventory.projects,
    deploymentRoots,
  });
  const appsBackfilled = await commitAppBackfill({
    database,
    candidates: appPlan.candidates,
  });
  return Object.freeze({
    projectsFound: inventory.projects.length,
    identitiesEnrolled: inventory.enrolled,
    appsBackfilled,
    appsAlreadyAssociated: appPlan.alreadyAssociated,
    appsLeftStandalone: appPlan.leftStandalone,
    ignoredInternalDirectories: inventory.ignoredInternalDirectories,
    preservedUnownedDirectories: inventory.preservedUnownedDirectories,
  });
}

export const __legacyProjectContinuityAdoptionTest = Object.freeze({
  MAX_CONTINUITY_PROJECTS,
  MAX_CONTINUITY_APPS,
});
