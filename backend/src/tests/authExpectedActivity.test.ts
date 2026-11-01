import { errorHandler, AppError } from '../middleware/errorHandler';
import { logRequestError } from '../utils/errorLogger';

jest.mock('../utils/errorLogger', () => ({ logRequestError: jest.fn().mockResolvedValue(undefined) }));

describe('expected refresh activity classification', () => {
  test.each([
    [new AppError(401, 'Refresh token required', true, 'INFO'), 'INFO'],
    [new AppError(401, 'Invalid refresh token'), 'ERROR'],
    [new AppError(403, 'Access denied'), 'ERROR'],
    [new Error('unexpected failure'), 'CRITICAL'],
  ])('retains every event with its appropriate severity', (err, severity) => {
    const res = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn() };
    errorHandler(err as Error, { method: 'POST', originalUrl: '/api/auth/refresh' } as any, res as any, jest.fn());
    expect(logRequestError).toHaveBeenLastCalledWith(err, expect.anything(), { severity });
    expect(res.status).toHaveBeenCalledWith(err instanceof AppError ? err.statusCode : 500);
  });
});
