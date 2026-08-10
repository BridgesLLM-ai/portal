import { beforeEach, describe, expect, it, vi } from 'vitest';
import client from './client';
import { projectRuntimeImageRepairAPI } from './projectRuntimeImageRepair';

vi.mock('./client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('Project runtime image repair API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses fixed same-origin Owner remediation endpoints', async () => {
    vi.mocked(client.get).mockResolvedValue({
      data: {
        state: 'unavailable',
        unavailableReason: 'image-missing',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      },
    });
    vi.mocked(client.post).mockResolvedValue({ data: { ok: true, state: 'running', started: true } });

    await projectRuntimeImageRepairAPI.status();
    await projectRuntimeImageRepairAPI.repair('REPAIR PROJECT RUNTIME IMAGE');

    expect(client.get).toHaveBeenCalledWith(
      '/system/remediation/projectRuntimeImage/status',
      expect.objectContaining({ _silent: true }),
    );
    expect(client.post).toHaveBeenCalledWith(
      '/system/remediation/projectRuntimeImage/auto-setup',
      { confirmation: 'REPAIR PROJECT RUNTIME IMAGE' },
      expect.objectContaining({ timeout: 15_000, _skipNetworkRetry: true }),
    );
  });

  it('preserves the bounded unavailable reason and rejects incompatible combinations', async () => {
    vi.mocked(client.get).mockResolvedValueOnce({
      data: {
        state: 'unavailable',
        unavailableReason: 'image-state-unknown',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      },
    });
    await expect(projectRuntimeImageRepairAPI.status()).resolves.toMatchObject({
      state: 'unavailable',
      unavailableReason: 'image-state-unknown',
    });

    vi.mocked(client.get).mockResolvedValueOnce({
      data: {
        state: 'ready',
        unavailableReason: 'image-missing',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      },
    });
    await expect(projectRuntimeImageRepairAPI.status()).rejects.toThrow(
      /repair status response is malformed/i,
    );
  });

  it.each([
    null,
    { state: 'unavailable' },
    {
      state: 'ready',
      confirmationPhrase: 'WRONG',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    },
    {
      state: 'surprise',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    },
  ])('rejects malformed status payloads without enabling repair (%j)', async (data) => {
    vi.mocked(client.get).mockResolvedValue({ data });
    await expect(projectRuntimeImageRepairAPI.status()).rejects.toThrow(
      /repair status response is malformed/i,
    );
  });

  it.each([
    null,
    { ok: true, state: 'failed', started: false },
    { ok: false, state: 'running', started: true },
    { ok: true, state: 'running', started: 'yes' },
  ])('rejects malformed launch payloads without trusting host state (%j)', async (data) => {
    vi.mocked(client.post).mockResolvedValue({ data });
    await expect(projectRuntimeImageRepairAPI.repair(
      'REPAIR PROJECT RUNTIME IMAGE',
    )).rejects.toThrow(/repair launch response is malformed/i);
  });

  it('accepts a repair that completed before its registration response was reconciled', async () => {
    vi.mocked(client.post).mockResolvedValue({ data: { ok: true, state: 'ready', started: true } });

    await expect(projectRuntimeImageRepairAPI.repair(
      'REPAIR PROJECT RUNTIME IMAGE',
    )).resolves.toEqual({ ok: true, state: 'ready', started: true });
  });
});
