import fs from 'fs';
import { prisma } from '../config/database';
import type { JwtPayload } from '../utils/jwt';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';
import { resolveContainedPath } from './containedPath';
import { deriveOpenClawProjectAgentId } from './openclawProjectSandbox';
import { isInternalProjectDirectoryName } from './projectIdentity';
import { resolveProjectStoragePaths } from './projectStoragePaths';

/**
 * Readable names for generated Project Chat agents in the Agent Chat selector.
 *
 * A generated agent id is `p4oc-` plus a one-way hash of (actor, Project
 * identity), so a name can never be read back out of the id. Ids are derived
 * forward instead, and only for the Projects the caller's Projects page lists
 * (the same workspace scope and the same directory inventory) and the actors
 * those Projects have recorded. An agent whose Project is gone, still being
 * removed after its directory went, or outside that scope stays selectable
 * without a name; nothing about a Project the caller cannot open is returned.
 */

/** Same prefix rule the automation and host-model boundaries apply to Project agents. */
const PROJECT_AGENT_ID_PREFIX = /^p4oc-/i;

/**
 * Creation states that never name an agent: the Projects list hides CREATING,
 * and CREATION_CLEANUP is a failed creation being discarded, which never
 * became a Project anyone could chat in.
 */
const UNLISTED_PROJECT_LIFECYCLE_STATES = ['CREATING', 'CREATION_CLEANUP'];

/**
 * Directory names GET /api/projects would list for this workspace: real
 * directories in the workspace's projects root, never the dot-prefixed internal
 * namespace. Read-only, unlike that route: no directory creation, chmod,
 * identity adoption or lifecycle recovery. A workspace root that does not exist
 * yet lists nothing; a root the route would refuse (a link, or an owner id it
 * rejects) throws, which leaves every agent unnamed.
 */
export async function listProjectDirectoryNames(
  workspaceOwnerId: string,
  options: { projectsDir?: string } = {},
): Promise<Set<string>> {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceOwnerId)) throw new Error('Invalid project owner');
  const projectsDir = options.projectsDir || resolveProjectStoragePaths().projectsDir;
  const workspaceRoot = resolveContainedPath(projectsDir, workspaceOwnerId, { kind: 'directory' });
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(workspaceRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
  return new Set(entries
    .filter((entry) => entry.isDirectory() && !isInternalProjectDirectoryName(entry.name))
    .map((entry) => entry.name));
}

export interface SelectorProjectAgent {
  /** The authorized Project name, or null when the Project is gone or outside the caller's workspace. */
  projectName: string | null;
  /** True when this agent runs the caller's own chats in that Project. */
  ownChat: boolean;
}

type ProjectAgentDirectoryDatabase = Pick<
  typeof prisma,
  'projectIdentity' | 'projectChatProviderBinding' | 'projectChatSession' | 'projectChatState'
>;

interface ProjectAgentDirectoryDependencies {
  database?: ProjectAgentDirectoryDatabase;
  listProjectDirectoryNames?: (workspaceOwnerId: string) => Promise<ReadonlySet<string>>;
}

export function isGeneratedProjectAgentId(agentId: unknown): agentId is string {
  return typeof agentId === 'string' && PROJECT_AGENT_ID_PREFIX.test(agentId);
}

const UNNAMED_PROJECT_AGENT: Readonly<SelectorProjectAgent> = Object.freeze({ projectName: null, ownChat: false });

export async function describeProjectAgentsForSelector(input: {
  agentIds: readonly string[];
  actorUserId: string;
  workspaceOwnerId: string;
}, dependencies: ProjectAgentDirectoryDependencies = {}): Promise<Map<string, SelectorProjectAgent>> {
  const database = dependencies.database || prisma;
  const described = new Map<string, SelectorProjectAgent>();
  for (const agentId of input.agentIds) {
    if (isGeneratedProjectAgentId(agentId)) described.set(agentId, { ...UNNAMED_PROJECT_AGENT });
  }
  if (described.size === 0) return described;

  // The Projects list starts from the directory inventory, so a Project row
  // without a listed directory (removal pending, or residue) is not named.
  const listedNames = [...await (dependencies.listProjectDirectoryNames || listProjectDirectoryNames)(
    input.workspaceOwnerId,
  )];
  if (listedNames.length === 0) return described;
  const projects = await database.projectIdentity.findMany({
    where: {
      workspaceOwnerId: input.workspaceOwnerId,
      projectName: { in: listedNames },
      lifecycleStatus: { notIn: UNLISTED_PROJECT_LIFECYCLE_STATES },
    },
    select: { id: true, projectName: true },
  });
  if (projects.length === 0) return described;

  const projectIds = projects.map((project) => project.id);
  // Turns always belong to a chat state, so these three cover every actor a
  // Project has recorded without scanning message history.
  const [bindings, sessions, states] = await Promise.all([
    database.projectChatProviderBinding.findMany({
      where: { projectId: { in: projectIds } },
      select: { userId: true },
    }),
    database.projectChatSession.findMany({
      where: { projectId: { in: projectIds } },
      select: { userId: true },
    }),
    database.projectChatState.findMany({
      where: { projectIdentityId: { in: projectIds } },
      select: { actorUserId: true },
    }),
  ]);
  const actorIds = new Set([
    input.actorUserId,
    input.workspaceOwnerId,
    ...bindings.map((binding) => binding.userId),
    ...sessions.map((session) => session.userId),
    ...states.map((state) => state.actorUserId),
  ]);

  for (const project of projects) {
    for (const actorId of actorIds) {
      let agentId: string;
      try {
        agentId = deriveOpenClawProjectAgentId({ userId: actorId, projectId: project.id });
      } catch {
        continue;
      }
      if (!described.has(agentId)) continue;
      described.set(agentId, {
        projectName: project.projectName,
        ownChat: actorId === input.actorUserId,
      });
    }
  }
  return described;
}

/**
 * Adds `projectAgent` to each generated Project agent row. A failed lookup
 * degrades to unnamed rows so the selector itself never fails on it.
 */
export async function labelSelectorProjectAgents<T extends { id: string }>(
  agents: readonly T[],
  caller: JwtPayload,
  dependencies: ProjectAgentDirectoryDependencies & {
    resolveWorkspaceOwnerId?: (user: JwtPayload) => Promise<string>;
  } = {},
): Promise<Array<T | (T & { projectAgent: SelectorProjectAgent })>> {
  const agentIds = agents.map((agent) => agent.id).filter(isGeneratedProjectAgentId);
  if (agentIds.length === 0) return [...agents];
  let described = new Map<string, SelectorProjectAgent>();
  try {
    const workspaceOwnerId = await (dependencies.resolveWorkspaceOwnerId || getWorkspaceOwnerId)(caller);
    described = await describeProjectAgentsForSelector({
      agentIds,
      actorUserId: caller.userId,
      workspaceOwnerId,
    }, dependencies);
  } catch (error: any) {
    console.warn('[gateway] Project agent names are unavailable:', error?.message || String(error));
  }
  return agents.map((agent) => (isGeneratedProjectAgentId(agent.id)
    ? { ...agent, projectAgent: described.get(agent.id) || { ...UNNAMED_PROJECT_AGENT } }
    : agent));
}
