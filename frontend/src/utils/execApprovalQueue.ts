interface ExecApprovalLike {
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
}

function compareApprovals(a: ExecApprovalLike, b: ExecApprovalLike): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id.localeCompare(b.id);
}

export function upsertExecApproval<T extends ExecApprovalLike>(queue: T[], approval: T): T[] {
  const next = [...queue.filter((item) => item.id !== approval.id), approval];
  next.sort(compareApprovals);
  return next;
}

export function removeExecApproval<T extends ExecApprovalLike>(queue: T[], approvalId: string): T[] {
  return queue.filter((item) => item.id !== approvalId);
}

export function pruneExpiredExecApprovals<T extends ExecApprovalLike>(queue: T[], now = Date.now()): T[] {
  return queue.filter((item) => item.expiresAtMs > now);
}

export function mergeExecApprovalQueues<T extends ExecApprovalLike>(...queues: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const queue of queues) {
    for (const approval of queue) {
      const existing = byId.get(approval.id);
      if (!existing || compareApprovals(approval, existing) <= 0) {
        byId.set(approval.id, approval);
      }
    }
  }
  return Array.from(byId.values()).sort(compareApprovals);
}
