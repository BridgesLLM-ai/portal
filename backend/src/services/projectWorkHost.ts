import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import path from 'path';
import type { ProjectWorkCard, ProjectIdentity } from '@prisma/client';
import type { AgentProvider, AgentExecutionContext, AgentSendResult } from '../agents/AgentProvider.interface';
import { AgentAbortError } from '../agents/AgentProvider.interface';
import { prisma } from '../config/database';
import { assertProjectIdentityRoot } from './projectIdentity';
import { streamEventBus } from './StreamEventBus';
import { readRuntimeTurnEvents } from './RuntimeTurnEventHistory';
import type { RuntimeTurnEvent } from './RuntimeTurnEvents';
import { loadNativeSessionMetadata } from '../agents/providers/NativeSessionStore';

const instance = randomUUID();
export const ACTIVE_WORK_STATUSES = ['STARTING', 'RUNNING', 'UNCERTAIN'];
export type BoundProjectWork = ProjectWorkCard & { projectIdentity: ProjectIdentity };
const workScope = new AsyncLocalStorage<BoundProjectWork>();
export const currentProjectWork = () => workScope.getStore();
export function withProjectWorkHost<T>(card: BoundProjectWork, fn: () => T): T { return workScope.run(card, fn); }
const workError = (message: string, status = 409) => Object.assign(new Error(message), { status, code: 'PROJECT_WORK_CHANGED' });

export async function attestProjectWork(card: BoundProjectWork): Promise<ProjectIdentity> {
  const project = await prisma.projectIdentity.findFirst({ where: {
    id: card.projectIdentityId, workspaceOwnerId: card.actorUserId,
    generation: card.projectGeneration, lifecycleStatus: 'ACTIVE',
  } });
  if (!project || project.projectName !== card.projectName) throw workError('This project changed. Select it again for new work.');
  assertProjectIdentityRoot(project, project.canonicalRoot);
  return project;
}

export function projectWorkPrompt(card: BoundProjectWork): string {
  // This is targeting context, explicitly NOT a privilege boundary. Native
  // workers also launch at this attested cwd; OpenClaw receives it explicitly.
  return `PORTAL PROJECT WORK\nProject: ${JSON.stringify(card.projectName)}\nProject ID: ${card.projectIdentityId}\nWorking directory: ${JSON.stringify(card.projectIdentity.canonicalRoot)}\n\nWork only on this selected project for this request. Use that absolute directory as the working directory for commands and file operations; verify it before editing. Do not guess a sibling project or fall back to your usual workspace. If the project is missing or the request requires changing another project or server configuration, ask the user first. Read any project instructions in this directory. This is owner/admin Agent Chat work, not an isolated Project Chat sandbox. Do not deploy or publish unless the user explicitly requests it.\n\nREQUEST\n${card.prompt}`;
}

export async function claimProjectWork(card: BoundProjectWork): Promise<boolean> {
  await attestProjectWork(card);
  const other = await prisma.projectChatTurn.findFirst({ where: { projectIdentityId: card.projectIdentityId,
    status: { in: ['RUNNING', 'ABORTING'] } }, select: { id: true } });
  if (other) throw workError('Isolated Project Chat is working on this project. Let it finish before starting another change.');
  try {
    const claimed = await prisma.projectWorkCard.updateMany({ where: { id: card.id, actorUserId: card.actorUserId, status: 'DRAFT' },
      data: { status: 'STARTING', portalInstanceId: instance, startedAt: new Date() } });
    return claimed.count === 1;
  } catch (error: any) {
    if (error.code === 'P2002') throw workError('Another work card is active in this project. Let it finish or stop it first.');
    throw error;
  }
}

export async function bindProjectWorkHostSession(provider: AgentProvider, context: AgentExecutionContext): Promise<string | null> {
  const card = currentProjectWork();
  if (!card) return null;
  if (context.scope !== 'HOST_OPERATOR' || context.userId !== card.actorUserId || provider.providerName !== card.provider) {
    throw workError('The project worker no longer matches this assignment.');
  }
  const project = await attestProjectWork(card);
  let sessionId = card.sessionId;
  if (!sessionId && card.parentCardId) {
    const parent = await prisma.projectWorkCard.findFirst({ where: { id: card.parentCardId,
      actorUserId: card.actorUserId, projectIdentityId: card.projectIdentityId, projectGeneration: card.projectGeneration,
      provider: card.provider, status: { in: ['COMPLETED', 'ERROR', 'ABORTED', 'INTERRUPTED'] } } });
    sessionId = parent?.sessionId || null;
  }
  if (!sessionId) {
    const agentId = card.originProvider === 'OPENCLAW' ? card.originSessionKey.match(/^agent:([A-Za-z0-9_-]+):/)?.[1] || 'main' : 'main';
    sessionId = await provider.startSession(card.actorUserId, { executionContext: context, model: card.model || undefined,
      metadata: { cwd: project.canonicalRoot, projectWork: true, projectIdentityId: project.id,
        projectGeneration: project.generation, agentId, sessionSlug: `work-${card.id}` } });
  }
  if (provider.providerName !== 'OPENCLAW') {
    const native = loadNativeSessionMetadata(provider.providerName, sessionId);
    if (!native || native.userId !== card.actorUserId || native.executionContext?.scope !== 'HOST_OPERATOR'
      || native.metadata?.projectIdentityId !== project.id || native.metadata?.projectGeneration !== project.generation
      || path.resolve(native.cwd) !== project.canonicalRoot) throw workError('The saved worker is not bound to this project folder.');
  }
  await prisma.projectWorkCard.update({ where: { id: card.id }, data: { sessionId } });
  card.sessionId = sessionId;
  return sessionId;
}

// Project work is a separate authorized run, never relayed under the parent's
// identity. Reuse the canonical event contract, including its visibility policy.
export function projectWorkEvents(events: RuntimeTurnEvent[], session: string, runIds: string[]) {
  let budget = 512_000;
  const accepted: RuntimeTurnEvent[] = [];
  for (const event of events.slice().reverse()) {
    if (event.sessionKey !== session || !event.runId || !runIds.includes(event.runId) || !event.visible) continue;
    const size = JSON.stringify(event).length;
    if (size > budget) break;
    accepted.unshift(event); budget -= size;
    if (accepted.length >= 1000) break;
  }
  return accepted;
}

async function snapshot(card: ProjectWorkCard) {
  if (!card.sessionId) return null;
  // OpenClaw assigns its own run identity after admission. It is journal-owned,
  // never taken from a browser request or inferred from a shared session key.
  const upstream = card.provider === 'OPENCLAW'
    ? await prisma.openClawHostRun.findUnique({ where: { id: card.requestId }, select: { upstreamRunId: true } }) : null;
  const runIds = [card.requestId, `portal-${card.requestId}`, upstream?.upstreamRunId].filter(Boolean) as string[];
  const tracked = streamEventBus.getTrackedStream(card.sessionId);
  const stream = tracked?.runId && runIds.includes(tracked.runId) ? tracked : null;
  const events = projectWorkEvents(readRuntimeTurnEvents(card.sessionId, 4000), card.sessionId, runIds);
  if (!stream && !events.length) return null;
  return { text: stream ? streamEventBus.getLatestText(card.sessionId).slice(0, 100000) : card.response,
    events, activeToolCall: stream?.toolName || null, active: stream?.active === true,
    phase: stream?.phase, statusText: stream?.statusText };
}

export async function trackProjectWorkDispatch(
  input: { provider: AgentProvider; sessionId: string; sender?: { userId: string; requestId?: string; authorizationVersion?: number } },
  dispatch: () => Promise<AgentSendResult>,
): Promise<AgentSendResult> {
  const card = currentProjectWork();
  if (!card) return dispatch();
  await attestProjectWork(card);
  if (input.provider.providerName !== card.provider || input.sessionId !== card.sessionId
    || input.sender?.userId !== card.actorUserId || input.sender?.requestId !== card.requestId
    || input.sender.authorizationVersion !== card.actorAuthorizationVersion) throw workError('Project dispatch identity changed.');
  await prisma.projectWorkCard.update({ where: { id: card.id }, data: { status: 'RUNNING' } });
  let saveInFlight = false;
  const saveProgress = async () => {
    if (saveInFlight) return;
    saveInFlight = true;
    try {
      const live = await snapshot(card); if (!live) return;
      await prisma.projectWorkCard.updateMany({ where: { id: card.id, status: 'RUNNING' }, data: { response: live.text, events: live.events as any } }); }
    finally { saveInFlight = false; }
  };
  const timer = setInterval(() => { void saveProgress().catch(() => undefined); }, 2500); timer.unref();
  try {
    const result = await dispatch();
    const live = await snapshot(card);
    await prisma.projectWorkCard.update({ where: { id: card.id }, data: { status: 'COMPLETED',
      response: result.fullText.slice(0, 100000), ...(live ? { events: live.events as any } : {}), completedAt: new Date(), error: null } });
    return result;
  } catch (error: any) {
    const live = await snapshot(card);
    const aborted = error instanceof AgentAbortError;
    const [native, openclaw] = await Promise.all([
      prisma.hostAgentRun.findUnique({ where: { id: card.requestId } }),
      prisma.openClawHostRun.findUnique({ where: { id: card.requestId } }),
    ]);
    const settled = Boolean(native?.settledAt || openclaw?.quiescedAt);
    const neverDispatched = !native && !openclaw && !live?.active;
    const status = settled || neverDispatched ? (aborted ? 'ABORTED' : 'ERROR') : 'UNCERTAIN';
    // Do not erase uncertain ownership. Existing host journals are the authority
    // on whether a failed/aborted provider has really stopped.
    await prisma.projectWorkCard.update({ where: { id: card.id }, data: { status,
      error: status === 'ABORTED' ? null : status === 'ERROR' ? 'The worker could not complete this request. Review its result before continuing.' : 'The worker did not confirm completion. Check its status before starting more work.',
      ...(live ? { response: live.text, events: live.events as any } : {}), completedAt: new Date() } });
    throw error;
  } finally { clearInterval(timer); }
}

export async function failUndispatchedProjectWork(id: string, message: string): Promise<void> {
  await prisma.projectWorkCard.updateMany({ where: { id, status: 'STARTING' },
    data: { status: 'ERROR', error: message.slice(0, 1000), completedAt: new Date() } });
}

export async function readProjectWorkReplay(card: ProjectWorkCard) {
  let status = card.status;
  let replayError = card.error;
  const live = ACTIVE_WORK_STATUSES.includes(status) ? await snapshot(card) : null;
  if ((status === 'UNCERTAIN' || (ACTIVE_WORK_STATUSES.includes(status) && card.portalInstanceId !== instance)) && !live?.active) {
    const [native, openclaw] = await Promise.all([
      prisma.hostAgentRun.findUnique({ where: { id: card.requestId } }),
      prisma.openClawHostRun.findUnique({ where: { id: card.requestId } }),
    ]);
    const settled = native?.settledAt || openclaw?.quiescedAt;
    if (settled || (!native && !openclaw && card.portalInstanceId !== instance)) {
      status = 'INTERRUPTED';
      replayError = 'The previous run ended without a confirmed result. Review its files before continuing.';
      await prisma.projectWorkCard.updateMany({ where: { id: card.id, status: card.status }, data: {
        status, error: replayError, completedAt: new Date(),
      } });
    } else if (card.portalInstanceId !== instance) {
      status = 'UNCERTAIN';
      replayError = 'The previous worker is still being checked. Wait for it to stop before continuing.';
      await prisma.projectWorkCard.updateMany({ where: { id: card.id, status: card.status }, data: { status, error: replayError } });
    }
  }
  return { status: status === 'DRAFT' ? 'not_started' : status.toLowerCase(),
    complete: ['COMPLETED', 'ERROR', 'ABORTED', 'INTERRUPTED'].includes(status),
    active: status === 'RUNNING' || status === 'STARTING', uncertain: status === 'UNCERTAIN',
    text: live?.text || card.response, events: live?.events || card.events || [], error: replayError,
    phase: live?.phase, statusText: live?.statusText, activeToolCall: live?.activeToolCall, runId: card.requestId, sessionKey: card.sessionId, lineCount: 0 };
}
