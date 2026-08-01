import fs from 'fs';
import path from 'path';
import {
  ProjectRuntimeCleanupError,
  projectRuntimeLeaseRetryAfterMs,
} from '../services/projectRuntimeCleanup';

/**
 * Deleting a Project is refused while a chat turn still holds a runtime lease.
 * That lease expires on its own, and background recovery then completes the
 * admitted deletion — so reporting it as a permanent failure was wrong twice
 * over: the dialog dead-ended, and the project deleted itself moments later.
 */
describe('project delete under a held runtime lease', () => {
  const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/projects.ts'), 'utf8');
  const deleteRoute = (() => {
    const start = routeSource.indexOf("router.delete('/:name'");
    const end = routeSource.indexOf("router.patch('/:name/rename'", start);
    return routeSource.slice(start, end);
  })();

  test('the delete route treats a held lease as retryable', () => {
    const listStart = deleteRoute.indexOf('const retryable = [');
    expect(listStart).toBeGreaterThan(-1);
    const list = deleteRoute.slice(listStart, deleteRoute.indexOf('].includes(error.code)', listStart));
    expect(list).toContain('TURN_STILL_ACTIVE');
    // Rename already reported this class as retryable; delete must agree.
    expect(deleteRoute).toContain("const stillRunning = error.code === 'TURN_STILL_ACTIVE';");
  });

  test('a held lease answers 503 with a retry hint, not a dead 409', () => {
    expect(deleteRoute).toContain("res.setHeader('Retry-After'");
    expect(deleteRoute).toContain('retryAfterMs: error.retryAfterMs');
    expect(deleteRoute).toContain('res.status(retryable ? 503 : 409)');
  });

  test('the message says what is happening instead of blaming the runtime', () => {
    expect(deleteRoute).toContain('This Project is still finishing a chat turn.');
    // The generic wording stays for the genuinely stuck cases.
    expect(deleteRoute).toContain('Project deletion is paused until its isolated runtime can be proven clean.');
  });

  test('the error can carry the lease deadline', () => {
    const error = new ProjectRuntimeCleanupError('TURN_STILL_ACTIVE', 'held', 'OPENCLAW', 4_000);
    expect(error.retryAfterMs).toBe(4_000);
    // Unrelated failures keep the old shape and stay hint-free.
    expect(new ProjectRuntimeCleanupError('CLEANUP_FAILED', 'boom').retryAfterMs).toBeNull();
  });

  describe('lease retry hint', () => {
    test('reports the time left on the lease', () => {
      const hint = projectRuntimeLeaseRetryAfterMs(new Date(Date.now() + 8_000));
      expect(hint).toBeGreaterThanOrEqual(8_000);
      expect(hint).toBeLessThanOrEqual(10_000);
    });

    test('never asks the client to wait unreasonably long', () => {
      expect(projectRuntimeLeaseRetryAfterMs(new Date(Date.now() + 60 * 60_000))).toBe(120_000);
    });

    test('never returns a non-positive wait for an already-lapsed lease', () => {
      expect(projectRuntimeLeaseRetryAfterMs(new Date(Date.now() - 60_000))).toBe(1_000);
    });

    test('tolerates an unusable date', () => {
      expect(projectRuntimeLeaseRetryAfterMs(new Date(Number.NaN))).toBe(5_000);
    });
  });
});
