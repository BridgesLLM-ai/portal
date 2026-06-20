import {
  requestNativeCliApproval,
  resolveNativeCliApproval,
  listPendingNativeCliApprovals,
} from '../agents/nativeCliApprovals';
import type { ExecApprovalRequest } from '../agents/providers/PersistentGatewayWs';

describe('nativeCliApprovals pending snapshot', () => {
  it('exposes in-flight approvals so they can be replayed to (re)connecting clients', async () => {
    let captured: ExecApprovalRequest | null = null;
    const decisionPromise = requestNativeCliApproval({
      providerName: 'CLAUDE_CODE',
      sessionId: 'agent:test:snapshot-1',
      command: 'Bash: ls /tmp',
      onRequest: (approval) => { captured = approval; },
    });

    expect(captured).not.toBeNull();
    const approval = captured!;

    // The snapshot must include the still-pending approval...
    const pending = listPendingNativeCliApprovals();
    expect(pending.map((a) => a.id)).toContain(approval.id);

    // ...and must drop it once resolved.
    const result = resolveNativeCliApproval(approval.id, 'allow-once');
    expect(result.ok).toBe(true);
    await expect(decisionPromise).resolves.toBe('allow-once');
    expect(listPendingNativeCliApprovals().map((a) => a.id)).not.toContain(approval.id);
  });

  it('filters expired approvals out of the snapshot', async () => {
    let captured: ExecApprovalRequest | null = null;
    const decisionPromise = requestNativeCliApproval({
      providerName: 'CLAUDE_CODE',
      sessionId: 'agent:test:snapshot-expiry',
      command: 'Bash: echo hi',
      onRequest: (approval) => { captured = approval; },
    });
    const approval = captured!;

    // Visible now, hidden once we look past its expiry.
    expect(listPendingNativeCliApprovals().map((a) => a.id)).toContain(approval.id);
    const pastExpiry = approval.expiresAtMs + 1;
    expect(listPendingNativeCliApprovals(pastExpiry).map((a) => a.id)).not.toContain(approval.id);

    // Clean up the pending timer.
    resolveNativeCliApproval(approval.id, 'deny');
    await expect(decisionPromise).resolves.toBe('deny');
  });
});
