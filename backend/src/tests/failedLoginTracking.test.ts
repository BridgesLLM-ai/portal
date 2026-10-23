import {
  MAX_TRACKED_FAILED_LOGIN_SOURCES,
  __failedLoginTrackingTest,
  clearFailedAttempts,
  isRateLimited,
  recordFailedAttempt,
} from '../utils/auth-tracking';

const WINDOW_MS = 15 * 60 * 1000;

describe('failed sign-in tracking', () => {
  let now = 1_700_000_000_000;

  beforeEach(() => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    __failedLoginTrackingTest.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    __failedLoginTrackingTest.reset();
  });

  test('blocks at the configured threshold and keeps the sliding 15-minute window', () => {
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(recordFailedAttempt('203.0.113.7', 5)).toEqual({ blocked: false, attempts: attempt });
      now += 60_000;
    }
    expect(recordFailedAttempt('203.0.113.7', 5)).toEqual({ blocked: true, attempts: 5 });
    expect(isRateLimited('203.0.113.7', 5)).toBe(true);
    // Each further failure extends the block, exactly as before.
    now += WINDOW_MS - 1;
    expect(isRateLimited('203.0.113.7', 5)).toBe(true);
    now += 2;
    expect(isRateLimited('203.0.113.7', 5)).toBe(false);
    expect(recordFailedAttempt('203.0.113.7', 5)).toEqual({ blocked: false, attempts: 1 });
  });

  test('a successful sign-in still clears its source', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) recordFailedAttempt('198.51.100.4');
    expect(isRateLimited('198.51.100.4')).toBe(true);
    clearFailedAttempts('198.51.100.4');
    expect(isRateLimited('198.51.100.4')).toBe(false);
  });

  test('expired sources are swept by later activity from other sources', () => {
    for (let index = 0; index < 500; index += 1) recordFailedAttempt(`2001:db8::${index.toString(16)}`);
    expect(__failedLoginTrackingTest.size()).toBe(500);
    now += WINDOW_MS + 1;
    recordFailedAttempt('192.0.2.1');
    expect(__failedLoginTrackingTest.size()).toBe(1);
    now += WINDOW_MS + 1;
    expect(isRateLimited('192.0.2.200')).toBe(false);
    expect(__failedLoginTrackingTest.size()).toBe(0);
  });

  test('a flood of distinct sources stays bounded and never releases a blocked source', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) recordFailedAttempt('203.0.113.99');
    expect(isRateLimited('203.0.113.99')).toBe(true);
    for (let index = 0; index < MAX_TRACKED_FAILED_LOGIN_SOURCES + 2_000; index += 1) {
      recordFailedAttempt(`2001:db8:1::${index.toString(16)}`);
    }
    expect(__failedLoginTrackingTest.size()).toBe(MAX_TRACKED_FAILED_LOGIN_SOURCES);
    expect(isRateLimited('203.0.113.99')).toBe(true);
    // The newest sources are tracked; the oldest unblocked ones made room.
    expect(recordFailedAttempt(`2001:db8:1::${(MAX_TRACKED_FAILED_LOGIN_SOURCES + 1_999).toString(16)}`).attempts).toBe(2);
    expect(recordFailedAttempt('2001:db8:1::0').attempts).toBe(1);
  });
});
