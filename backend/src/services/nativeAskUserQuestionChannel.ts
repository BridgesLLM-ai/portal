import {
  answerPendingUserInput,
  dismissPendingUserInput,
  readPendingUserInput,
} from '../agents/providers/PersistentGatewayWs';
import {
  commitAskUserQuestionAnswer,
  commitAskUserQuestionCancellation,
  listPendingAskUserQuestions,
  prepareAskUserQuestionAnswer,
  reconcilePendingAskUserQuestions,
  registerAskUserQuestion,
  releaseAskUserQuestionDelivery,
  reserveAskUserQuestionDelivery,
  type AskUserQuestionPublicRecord,
  type AskUserQuestionRecord,
} from './askUserQuestionBroker';
import {
  attestAskUserQuestionRuntimeRequest,
  discoverAskUserQuestionRunsForActor,
  reattestAskUserQuestionRunForActor,
} from './askUserQuestionSessionOwner';

export interface NativeAskUserQuestionChannelDependencies {
  discoverRuns: typeof discoverAskUserQuestionRunsForActor;
  readPending: typeof readPendingUserInput;
  attestRuntimeRequest: typeof attestAskUserQuestionRuntimeRequest;
  register: typeof registerAskUserQuestion;
  reconcile: typeof reconcilePendingAskUserQuestions;
  list: typeof listPendingAskUserQuestions;
  reattestRecord: typeof reattestAskUserQuestionRunForActor;
  prepareAnswer: typeof prepareAskUserQuestionAnswer;
  reserveDelivery: typeof reserveAskUserQuestionDelivery;
  answerRuntime: typeof answerPendingUserInput;
  dismissRuntime: typeof dismissPendingUserInput;
  commitAnswer: typeof commitAskUserQuestionAnswer;
  commitCancellation: typeof commitAskUserQuestionCancellation;
  releaseDelivery: typeof releaseAskUserQuestionDelivery;
}

const defaultDependencies: NativeAskUserQuestionChannelDependencies = {
  discoverRuns: discoverAskUserQuestionRunsForActor,
  readPending: readPendingUserInput,
  attestRuntimeRequest: attestAskUserQuestionRuntimeRequest,
  register: registerAskUserQuestion,
  reconcile: reconcilePendingAskUserQuestions,
  list: listPendingAskUserQuestions,
  reattestRecord: reattestAskUserQuestionRunForActor,
  prepareAnswer: prepareAskUserQuestionAnswer,
  reserveDelivery: reserveAskUserQuestionDelivery,
  answerRuntime: answerPendingUserInput,
  dismissRuntime: dismissPendingUserInput,
  commitAnswer: commitAskUserQuestionAnswer,
  commitCancellation: commitAskUserQuestionCancellation,
  releaseDelivery: releaseAskUserQuestionDelivery,
};

export async function syncNativeAskUserQuestionsForActor(
  input: {
    actorUserId: string;
    actorAuthorizationVersion: number;
    sessionKey?: string;
  },
  dependencies: NativeAskUserQuestionChannelDependencies = defaultDependencies,
): Promise<AskUserQuestionPublicRecord[]> {
  const candidates = await dependencies.discoverRuns({
    actorUserId: input.actorUserId,
    actorAuthorizationVersion: input.actorAuthorizationVersion,
    sessionKey: input.sessionKey,
  });
  const activeCalls: Array<{ sessionKey: string; runId: string; toolCallId: string }> = [];
  const runtimeRequests = await Promise.all(candidates.map(async (candidate) => {
    const snapshot = await dependencies.readPending(candidate.sessionKey, candidate.runId);
    if (!snapshot.pending) return null;
    const proof = await dependencies.attestRuntimeRequest(candidate, snapshot.requestId);
    return { snapshot, proof };
  }));
  for (const runtimeRequest of runtimeRequests) {
    if (!runtimeRequest) continue;
    const { snapshot, proof } = runtimeRequest;
    dependencies.register({
      sessionKey: proof.sessionKey,
      runId: proof.runId,
      toolCallId: proof.toolCallId,
      ownerUserId: proof.ownerUserId,
      surface: proof.surface,
      authorityId: proof.authorityId,
      actorAuthorizationVersion: proof.actorAuthorizationVersion,
      projectIdentityId: proof.projectIdentityId,
      questions: snapshot.questions,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    });
    activeCalls.push({
      sessionKey: proof.sessionKey,
      runId: proof.runId,
      toolCallId: proof.toolCallId,
    });
  }
  dependencies.reconcile({
    actorUserId: input.actorUserId,
    sessionKey: input.sessionKey,
    activeCalls,
  });
  return dependencies.list({
    actorUserId: input.actorUserId,
    sessionKey: input.sessionKey,
  });
}

export async function deliverNativeAskUserQuestionAnswer(
  input: {
    id: string;
    actorUserId: string;
    answers: Record<string, unknown>;
  },
  dependencies: NativeAskUserQuestionChannelDependencies = defaultDependencies,
): Promise<{ record: AskUserQuestionRecord; idempotentReplay: boolean }> {
  await dependencies.reattestRecord(input.id, input.actorUserId);
  const prepared = dependencies.prepareAnswer(input);
  const reservation = dependencies.reserveDelivery(input.id, input.actorUserId);
  try {
    const delivery = await dependencies.answerRuntime(
      prepared.sessionKey,
      prepared.runId,
      prepared.toolCallId,
      prepared.text,
    );
    const record = dependencies.commitAnswer(prepared, reservation);
    return { record, idempotentReplay: delivery.idempotentReplay };
  } finally {
    dependencies.releaseDelivery(reservation);
  }
}

export async function deliverNativeAskUserQuestionDismissal(
  input: { id: string; actorUserId: string },
  dependencies: NativeAskUserQuestionChannelDependencies = defaultDependencies,
): Promise<{ record: AskUserQuestionRecord; idempotentReplay: boolean }> {
  const record = await dependencies.reattestRecord(input.id, input.actorUserId);
  const reservation = dependencies.reserveDelivery(input.id, input.actorUserId);
  try {
    const delivery = await dependencies.dismissRuntime(
      record.sessionKey,
      record.runId,
      record.toolCallId,
    );
    const committed = dependencies.commitCancellation(reservation);
    return { record: committed, idempotentReplay: delivery.idempotentReplay };
  } finally {
    dependencies.releaseDelivery(reservation);
  }
}

// Provider-neutral names for current callers. Keep the native-prefixed exports
// as compatibility aliases for the existing restart/ownership test fixtures.
export type AskUserQuestionChannelDependencies = NativeAskUserQuestionChannelDependencies;
export const syncAskUserQuestionsForActor = syncNativeAskUserQuestionsForActor;
export const deliverAskUserQuestionAnswer = deliverNativeAskUserQuestionAnswer;
export const deliverAskUserQuestionDismissal = deliverNativeAskUserQuestionDismissal;
