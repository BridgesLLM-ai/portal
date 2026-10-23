// Rows are filtered by the same where-clauses the service sends, so a scope
// mistake shows up as a leaked or missing name rather than a passing mock.
function mockTable(rows: Array<Record<string, any>>) {
  return {
    findMany: jest.fn(async ({ where = {}, select }: any = {}) => rows
      .filter((row) => Object.entries(where).every(([key, condition]: [string, any]) => {
        if (condition && typeof condition === 'object') {
          if (Array.isArray(condition.in)) return condition.in.includes(row[key]);
          if (Array.isArray(condition.notIn)) return !condition.notIn.includes(row[key]);
          throw new Error(`Unsupported condition on ${key}`);
        }
        return row[key] === condition;
      }))
      .map((row) => (select
        ? Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key]]))
        : { ...row }))),
  };
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const SHARED_ADMIN = '22222222-2222-4222-8222-222222222222';
const SANDBOXED_ADMIN = '33333333-3333-4333-8333-333333333333';

const P_WEBSITE = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_REPORT = 'aaaaaaaa-0000-4000-8000-000000000002';
const P_STAGING = 'aaaaaaaa-0000-4000-8000-000000000003';
const P_DELETING = 'aaaaaaaa-0000-4000-8000-000000000004';
const P_PRIVATE = 'bbbbbbbb-0000-4000-8000-000000000005';

function mockDatabase() {
  return {
    projectIdentity: mockTable([
      { id: P_WEBSITE, workspaceOwnerId: OWNER, projectName: 'Website redesign', lifecycleStatus: 'ACTIVE' },
      { id: P_REPORT, workspaceOwnerId: OWNER, projectName: 'Quarterly report', lifecycleStatus: 'ACTIVE' },
      { id: P_STAGING, workspaceOwnerId: OWNER, projectName: 'Hidden staging', lifecycleStatus: 'CREATING' },
      { id: P_DELETING, workspaceOwnerId: OWNER, projectName: 'Old intake', lifecycleStatus: 'DELETING' },
      { id: P_PRIVATE, workspaceOwnerId: SANDBOXED_ADMIN, projectName: 'Private research', lifecycleStatus: 'ACTIVE' },
    ]),
    projectChatProviderBinding: mockTable([
      { userId: OWNER, projectId: P_WEBSITE },
      { userId: SHARED_ADMIN, projectId: P_WEBSITE },
      { userId: SANDBOXED_ADMIN, projectId: P_PRIVATE },
    ]),
    projectChatSession: mockTable([{ userId: OWNER, projectId: P_REPORT }]),
    projectChatState: mockTable([{ actorUserId: SHARED_ADMIN, projectIdentityId: P_REPORT }]),
  };
}

// Directory inventory per workspace, as the Projects page would list it.
const DIRECTORIES: Record<string, string[]> = {
  [OWNER]: ['Website redesign', 'Quarterly report', 'Hidden staging', 'Old intake'],
  [SANDBOXED_ADMIN]: ['Private research'],
};
const listProjectDirectoryNames = jest.fn(async (owner: string) => new Set(DIRECTORIES[owner] || []));

const mockPrisma: any = { user: { findFirst: jest.fn() }, ...mockDatabase() };
jest.mock('../config/database', () => ({ prisma: mockPrisma }));

import fs from 'fs';
import os from 'os';
import path from 'path';
import { deriveOpenClawProjectAgentId } from './openclawProjectSandbox';
import {
  describeProjectAgentsForSelector,
  isGeneratedProjectAgentId,
  labelSelectorProjectAgents,
  listProjectDirectoryNames as listRealProjectDirectoryNames,
} from './projectAgentDirectory';
import type { JwtPayload } from '../utils/jwt';

const agentFor = (userId: string, projectId: string) => deriveOpenClawProjectAgentId({ userId, projectId });
const ORPHAN = `p4oc-${'0'.repeat(40)}`;
const gatewayAgents = [
  { id: 'main' },
  { id: 'parity', name: 'Parity' },
  { id: agentFor(OWNER, P_WEBSITE) },
  { id: agentFor(SHARED_ADMIN, P_WEBSITE) },
  { id: agentFor(OWNER, P_REPORT) },
  { id: agentFor(SHARED_ADMIN, P_REPORT) },
  { id: agentFor(OWNER, P_STAGING) },
  { id: agentFor(OWNER, P_DELETING) },
  { id: agentFor(SANDBOXED_ADMIN, P_PRIVATE) },
  { id: ORPHAN },
];
const caller = (userId: string, role: string, sandboxEnabled = false): JwtPayload => ({
  userId, role, sandboxEnabled, email: `${userId}@example.invalid`,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findFirst.mockResolvedValue({ id: OWNER });
});

test('classifies only generated Project agent ids', () => {
  expect(isGeneratedProjectAgentId(agentFor(OWNER, P_WEBSITE))).toBe(true);
  expect(isGeneratedProjectAgentId('main')).toBe(false);
  expect(isGeneratedProjectAgentId('parity')).toBe(false);
  expect(isGeneratedProjectAgentId(undefined)).toBe(false);
});

test('names agents from the caller workspace and nothing else', async () => {
  const database = mockDatabase();
  const described = await describeProjectAgentsForSelector({
    agentIds: gatewayAgents.map((agent) => agent.id),
    actorUserId: OWNER,
    workspaceOwnerId: OWNER,
  }, { database: database as any, listProjectDirectoryNames });

  expect(Object.fromEntries(described)).toEqual({
    [agentFor(OWNER, P_WEBSITE)]: { projectName: 'Website redesign', ownChat: true },
    [agentFor(SHARED_ADMIN, P_WEBSITE)]: { projectName: 'Website redesign', ownChat: false },
    [agentFor(OWNER, P_REPORT)]: { projectName: 'Quarterly report', ownChat: true },
    [agentFor(SHARED_ADMIN, P_REPORT)]: { projectName: 'Quarterly report', ownChat: false },
    // Hidden staging rows are not listed by the Projects page, so they are not named here.
    [agentFor(OWNER, P_STAGING)]: { projectName: null, ownChat: false },
    // A removal still pending with its directory present is listed (disabled), so it keeps its name.
    [agentFor(OWNER, P_DELETING)]: { projectName: 'Old intake', ownChat: true },
    // Another workspace's Project and a removed Project stay unnamed.
    [agentFor(SANDBOXED_ADMIN, P_PRIVATE)]: { projectName: null, ownChat: false },
    [ORPHAN]: { projectName: null, ownChat: false },
  });
  expect(JSON.stringify([...described])).not.toContain('Private research');
  expect(database.projectIdentity.findMany).toHaveBeenCalledWith({
    where: {
      workspaceOwnerId: OWNER,
      projectName: { in: DIRECTORIES[OWNER] },
      lifecycleStatus: { notIn: ['CREATING', 'CREATION_CLEANUP'] },
    },
    select: { id: true, projectName: true },
  });
  expect(listProjectDirectoryNames).toHaveBeenCalledWith(OWNER);
});

test('a sandboxed admin sees only its own workspace names', async () => {
  const labelled = await labelSelectorProjectAgents(gatewayAgents, caller(SANDBOXED_ADMIN, 'SUB_ADMIN', true), {
    listProjectDirectoryNames,
  });
  const named = labelled.filter((agent: any) => agent.projectAgent?.projectName);
  expect(named).toEqual([
    { id: agentFor(SANDBOXED_ADMIN, P_PRIVATE), projectAgent: { projectName: 'Private research', ownChat: true } },
  ]);
  const serialized = JSON.stringify(labelled);
  for (const hidden of ['Website redesign', 'Quarterly report', 'Old intake', 'Hidden staging']) {
    expect(serialized).not.toContain(hidden);
  }
  expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
});

test('a shared-workspace admin gets the owner workspace names with its own chats marked', async () => {
  const labelled = await labelSelectorProjectAgents(gatewayAgents, caller(SHARED_ADMIN, 'SUB_ADMIN'), {
    listProjectDirectoryNames,
  });
  const byId = new Map(labelled.map((agent: any) => [agent.id, agent.projectAgent]));
  expect(byId.get(agentFor(SHARED_ADMIN, P_WEBSITE))).toEqual({ projectName: 'Website redesign', ownChat: true });
  expect(byId.get(agentFor(OWNER, P_WEBSITE))).toEqual({ projectName: 'Website redesign', ownChat: false });
  expect(byId.get(agentFor(SANDBOXED_ADMIN, P_PRIVATE))).toEqual({ projectName: null, ownChat: false });
  expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(1);
});

test('keeps ids, order and ordinary agents unchanged', async () => {
  const labelled = await labelSelectorProjectAgents(gatewayAgents, caller(OWNER, 'OWNER'), { listProjectDirectoryNames });
  expect(labelled.map((agent) => agent.id)).toEqual(gatewayAgents.map((agent) => agent.id));
  expect(labelled[0]).toBe(gatewayAgents[0]);
  expect(labelled[1]).toEqual({ id: 'parity', name: 'Parity' });
  expect(labelled.slice(2).every((agent: any) => agent.projectAgent)).toBe(true);
});

test('makes no Project queries when no generated agent is listed', async () => {
  const database = mockDatabase();
  const resolveWorkspaceOwnerId = jest.fn();
  const labelled = await labelSelectorProjectAgents([{ id: 'main' }, { id: 'parity' }], caller(OWNER, 'OWNER'), {
    database: database as any,
    resolveWorkspaceOwnerId,
    listProjectDirectoryNames,
  });
  expect(labelled).toEqual([{ id: 'main' }, { id: 'parity' }]);
  expect(resolveWorkspaceOwnerId).not.toHaveBeenCalled();
  expect(listProjectDirectoryNames).not.toHaveBeenCalled();
  expect(database.projectIdentity.findMany).not.toHaveBeenCalled();
});

test('a failed lookup leaves the agents selectable without names', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const database = mockDatabase();
  database.projectIdentity.findMany.mockRejectedValueOnce(new Error('database unavailable'));
  const labelled = await labelSelectorProjectAgents(gatewayAgents, caller(OWNER, 'OWNER'), {
    database: database as any,
    listProjectDirectoryNames,
  });
  expect(labelled.map((agent) => agent.id)).toEqual(gatewayAgents.map((agent) => agent.id));
  expect(labelled.filter((agent: any) => agent.projectAgent).every((agent: any) => (
    agent.projectAgent.projectName === null && agent.projectAgent.ownChat === false
  ))).toBe(true);
  expect(warn).toHaveBeenCalledWith('[gateway] Project agent names are unavailable:', 'database unavailable');
  warn.mockRestore();
});

test('a Project row whose directory the Projects list no longer shows is not named', async () => {
  const database = mockDatabase();
  // "Old intake" is still DELETING and "Quarterly report" is ACTIVE, but both
  // directories are gone, so neither appears on the Projects page.
  const inventory = jest.fn(async () => new Set(['Website redesign', 'Hidden staging']));
  const labelled = await labelSelectorProjectAgents(gatewayAgents, caller(OWNER, 'OWNER'), {
    database: database as any,
    listProjectDirectoryNames: inventory,
  });
  const byId = new Map(labelled.map((agent: any) => [agent.id, agent.projectAgent]));
  expect(byId.get(agentFor(OWNER, P_WEBSITE))).toEqual({ projectName: 'Website redesign', ownChat: true });
  for (const id of [agentFor(OWNER, P_DELETING), agentFor(OWNER, P_REPORT), agentFor(SHARED_ADMIN, P_REPORT)]) {
    expect(byId.get(id)).toEqual({ projectName: null, ownChat: false });
  }
  // The agents stay listed, in order, with their exact ids.
  expect(labelled.map((agent) => agent.id)).toEqual(gatewayAgents.map((agent) => agent.id));
  expect(JSON.stringify(labelled)).not.toMatch(/Old intake|Quarterly report/);
  expect(inventory).toHaveBeenCalledWith(OWNER);
});

test('an empty directory inventory names nothing and skips the Project queries', async () => {
  const database = mockDatabase();
  const described = await describeProjectAgentsForSelector({
    agentIds: gatewayAgents.map((agent) => agent.id),
    actorUserId: OWNER,
    workspaceOwnerId: OWNER,
  }, { database: database as any, listProjectDirectoryNames: async () => new Set<string>() });
  expect([...described.values()].every((agent) => agent.projectName === null && !agent.ownChat)).toBe(true);
  expect(database.projectIdentity.findMany).not.toHaveBeenCalled();
});

test('reads the Projects list directory inventory without creating or changing anything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-agent-directory-'));
  try {
    const workspace = path.join(root, OWNER);
    fs.mkdirSync(path.join(workspace, 'Website redesign'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.bridgesllm-lifecycle-quarantine'));
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'not a project');
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(workspace, 'Linked project'));
    fs.chmodSync(workspace, 0o755);
    const before = fs.statSync(workspace);

    expect([...await listRealProjectDirectoryNames(OWNER, { projectsDir: root })]).toEqual(['Website redesign']);
    // The Projects route would chmod the workspace root to 0700; this read leaves it alone.
    const after = fs.statSync(workspace);
    expect(after.mode & 0o777).toBe(0o755);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // A workspace without a root yet lists nothing, and no root is created for it.
    expect([...await listRealProjectDirectoryNames(SANDBOXED_ADMIN, { projectsDir: root })]).toEqual([]);
    expect(fs.existsSync(path.join(root, SANDBOXED_ADMIN))).toBe(false);

    // Roots the Projects route refuses fail closed.
    fs.symlinkSync(workspace, path.join(root, SHARED_ADMIN));
    await expect(listRealProjectDirectoryNames(SHARED_ADMIN, { projectsDir: root })).rejects.toThrow();
    await expect(listRealProjectDirectoryNames('../escape', { projectsDir: root })).rejects.toThrow('Invalid project owner');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the gateway lookup checks the real workspace directories by default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-agent-directory-'));
  const previousRoot = process.env.PORTAL_PROJECTS_ROOT;
  process.env.PORTAL_PROJECTS_ROOT = root;
  try {
    // Only "Website redesign" still has a directory; "Old intake" (DELETING)
    // and "Quarterly report" keep their rows after their directories went.
    fs.mkdirSync(path.join(root, OWNER, 'Website redesign'), { recursive: true });
    const labelled = await labelSelectorProjectAgents(gatewayAgents, caller(OWNER, 'OWNER'));
    const byId = new Map(labelled.map((agent: any) => [agent.id, agent.projectAgent]));
    expect(byId.get(agentFor(OWNER, P_WEBSITE))).toEqual({ projectName: 'Website redesign', ownChat: true });
    expect(byId.get(agentFor(SHARED_ADMIN, P_WEBSITE))).toEqual({ projectName: 'Website redesign', ownChat: false });
    for (const id of [agentFor(OWNER, P_DELETING), agentFor(OWNER, P_REPORT), agentFor(SHARED_ADMIN, P_REPORT)]) {
      expect(byId.get(id)).toEqual({ projectName: null, ownChat: false });
    }
    expect(labelled.map((agent) => agent.id)).toEqual(gatewayAgents.map((agent) => agent.id));
    expect(JSON.stringify(labelled)).not.toMatch(/Old intake|Quarterly report/);
  } finally {
    if (previousRoot === undefined) delete process.env.PORTAL_PROJECTS_ROOT;
    else process.env.PORTAL_PROJECTS_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
