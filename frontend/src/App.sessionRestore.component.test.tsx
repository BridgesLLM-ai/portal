// @vitest-environment jsdom
import './test/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionRestoreFallback } from './App';
import type { PortalSelfUpdateProgress } from './utils/portalUpdateProgress';

const CHECKPOINT: PortalSelfUpdateProgress = {
  schema: 1,
  operationId: '0123456789abcdef0123456789abcdef',
  previousVersion: '4.0.14',
  expectedVersion: '4.0.15',
  status: 'running',
  phase: 'postflight',
  percent: 97,
  label: 'Completing host services and cleanup',
  detail: 'Portal is online while host integration converges.',
  startedAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:10:00.000Z',
  finishedAt: null,
  events: [],
  logAvailable: true,
  isCurrent: true,
  admissionBlocked: true,
};

describe('session restore curtain during a Portal update', () => {
  it('keeps real last-confirmed progress visible while reconnecting automatically', () => {
    render(
      <SessionRestoreFallback
        onRetry={vi.fn()}
        onSignOut={vi.fn()}
        updateRecovery={{
          operationId: CHECKPOINT.operationId,
          checkpoint: CHECKPOINT,
          attemptCount: 2,
          isRetrying: false,
          retryNow: vi.fn().mockResolvedValue(false),
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Portal is restarting' })).toBeInTheDocument();
    expect(screen.getByText('Completing host services and cleanup')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Portal update progress' })).toHaveAttribute('aria-valuenow', '97');
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('reconnect automatically'),
    );
    expect(screen.getByText('Reconnecting automatically…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeEnabled();
  });

  it('retains the ordinary fail-closed alert when no exact updater identity exists', () => {
    render(
      <SessionRestoreFallback
        onRetry={vi.fn()}
        onSignOut={vi.fn()}
        updateRecovery={{
          operationId: null,
          checkpoint: null,
          attemptCount: 0,
          isRetrying: false,
          retryNow: vi.fn().mockResolvedValue(false),
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Session check unavailable');
    expect(screen.getByRole('button', { name: 'Retry session check' })).toBeEnabled();
  });
});
