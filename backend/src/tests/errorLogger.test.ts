const activityCreateMock = jest.fn();

jest.mock('../config/database', () => ({
  prisma: { activityLog: { create: activityCreateMock } },
}));

import { logError, logRequestError } from '../utils/errorLogger';

describe('bounded error logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activityCreateMock.mockResolvedValue({ id: 'activity-1' });
  });

  test('bounds client diagnostics and returns the exact created row id', async () => {
    const id = await logError('m'.repeat(5_000), {
      endpoint: 'e'.repeat(2_000),
      stackTrace: 's'.repeat(70_000),
      componentName: 'c'.repeat(2_000),
      context: 'x'.repeat(2_000),
      userAgent: 'u'.repeat(2_000),
    });

    expect(id).toBe('activity-1');
    const data = activityCreateMock.mock.calls[0][0].data;
    expect(data.metadata.errorMessage).toHaveLength(4_000);
    expect(data.metadata.stackTrace).toHaveLength(64 * 1024);
    expect(data.metadata.endpoint).toHaveLength(1_000);
    expect(data.metadata.componentName).toHaveLength(1_000);
    expect(data.metadata.context).toHaveLength(1_000);
    expect(data.userAgent).toHaveLength(1_000);
  });

  test('does not persist query-string or fragment secrets from request URLs', async () => {
    await logRequestError(new Error('boom'), {
      method: 'GET',
      originalUrl: '/oauth/callback?code=secret#state',
      headers: {},
    });

    const data = activityCreateMock.mock.calls[0][0].data;
    expect(data.metadata.endpoint).toBe('GET /oauth/callback');
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  test('handles circular non-Error values without dropping the activity row', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(logError(circular, {})).resolves.toBe('activity-1');
    expect(activityCreateMock).toHaveBeenCalledTimes(1);
  });
});
