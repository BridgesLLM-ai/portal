import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock('./client', () => ({ default: clientMocks }));

import { settingsAPI } from './settings';

describe('Settings embed-origin API contract', () => {
  beforeEach(() => {
    Object.values(clientMocks).forEach((mock) => mock.mockReset());
    clientMocks.get.mockResolvedValue({ data: {} });
    clientMocks.post.mockResolvedValue({ data: {} });
    clientMocks.put.mockResolvedValue({ data: {} });
  });

  it('uses the owner-only embed policy route and forwards request cancellation', async () => {
    const controller = new AbortController();

    await settingsAPI.getEmbedOriginPolicy(controller.signal);

    expect(clientMocks.get).toHaveBeenCalledWith(
      '/admin/security/embed-origins',
      { signal: controller.signal },
    );
  });

  it('keeps the revision and exact permission policy together in one PUT', async () => {
    const request = {
      expectedRevision: 'a'.repeat(64),
      entries: [{
        origin: 'https://video.example.com',
        camera: true,
        microphone: false,
      }],
    };

    await settingsAPI.updateEmbedOriginPolicy(request);

    expect(clientMocks.put).toHaveBeenCalledWith('/admin/security/embed-origins', request);
  });
});
