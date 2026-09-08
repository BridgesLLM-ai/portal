import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('./client', () => ({ default: clientMocks }));

import { adminAPI } from './admin';

describe('legacy OpenClaw agent operator API', () => {
  beforeEach(() => {
    clientMocks.get.mockReset().mockResolvedValue({ data: { agents: [] } });
    clientMocks.post.mockReset().mockResolvedValue({ data: { ok: true } });
  });

  it('uses the Owner inventory endpoint', async () => {
    await adminAPI.listLegacyOpenClawAgents();
    expect(clientMocks.get).toHaveBeenCalledWith('/admin/legacy-openclaw-agents');
  });

  it('encodes the exact agent id and carries fingerprint plus typed confirmation', async () => {
    await adminAPI.detachLegacyOpenClawAgent(
      'portal-1234abcd-project_one',
      'a'.repeat(64),
      'DETACH portal-1234abcd-project_one',
    );
    expect(clientMocks.post).toHaveBeenCalledWith(
      '/admin/legacy-openclaw-agents/portal-1234abcd-project_one/detach',
      {
        expectedFingerprint: 'a'.repeat(64),
        confirmation: 'DETACH portal-1234abcd-project_one',
      },
    );
  });
});
