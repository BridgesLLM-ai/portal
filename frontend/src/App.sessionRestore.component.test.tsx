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
  percent: 99,
  label: 'Verifying the updated Portal',
  detail: 'Final exact-version Portal verification is still running.',
  startedAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:10:00.000Z',
  finishedAt: null,
  events: [],
  logAvailable: true,
  isCurrent: true,
  admissionBlocked: true,
};

describe('session restore curtain during a Portal update', () => {
  it('keeps the last-confirmed semantic checkpoint visible without presenting an ordinal as measured progress', () => {
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
    expect(screen.getByText('Verifying the updated Portal')).toBeInTheDocument();
    expect(screen.getByText('Final exact-version Portal verification is still running.')).toBeInTheDocument();
    const progressbar = screen.getByRole('progressbar', { name: 'Portal update progress' });
    expect(progressbar).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByText('99%')).not.toBeInTheDocument();
    expect(progressbar).toHaveAttribute(
      'aria-valuetext',
      'Verifying the updated Portal. Portal is restarting and will reconnect automatically.',
    );
    expect(screen.getByText('Reconnecting automatically…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeEnabled();
  });

  it('reports an indeterminate wait before the first durable checkpoint exists', () => {
    render(
      <SessionRestoreFallback
        onRetry={vi.fn()}
        onSignOut={vi.fn()}
        updateRecovery={{
          operationId: CHECKPOINT.operationId,
          checkpoint: null,
          attemptCount: 0,
          isRetrying: false,
          retryNow: vi.fn().mockResolvedValue(false),
        }}
      />,
    );

    expect(screen.getByText('Waiting for the first durable progress checkpoint…')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Portal update progress' })).not.toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
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
