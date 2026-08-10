// @vitest-environment jsdom
import '../test/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PORTAL_UPDATE_CHECKPOINT_SESSION_KEY,
  PORTAL_UPDATE_OPERATION_SESSION_KEY,
  rememberedPortalUpdateCheckpoint,
  rememberedPortalUpdateOperation,
  rememberPortalUpdateCheckpoint,
} from './portalUpdateSession';
import type { PortalSelfUpdateProgress } from './portalUpdateProgress';

const OPERATION_ID = '0123456789abcdef0123456789abcdef';

const CHECKPOINT: PortalSelfUpdateProgress = {
  schema: 1,
  operationId: OPERATION_ID,
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

describe('Portal update browser checkpoint', () => {
  beforeEach(() => sessionStorage.clear());

  it('accepts only an exact lowercase durable operation identity', () => {
    sessionStorage.setItem(PORTAL_UPDATE_OPERATION_SESSION_KEY, OPERATION_ID);
    expect(rememberedPortalUpdateOperation()).toBe(OPERATION_ID);
    sessionStorage.setItem(PORTAL_UPDATE_OPERATION_SESSION_KEY, OPERATION_ID.toUpperCase());
    expect(rememberedPortalUpdateOperation()).toBeNull();
  });

  it('round-trips a strictly parsed checkpoint bound to the same operation', () => {
    rememberPortalUpdateCheckpoint(CHECKPOINT);
    expect(rememberedPortalUpdateCheckpoint(OPERATION_ID)).toEqual(CHECKPOINT);
    expect(rememberedPortalUpdateCheckpoint('fedcba9876543210fedcba9876543210')).toBeNull();

    sessionStorage.setItem(PORTAL_UPDATE_CHECKPOINT_SESSION_KEY, '{"percent":97}');
    expect(rememberedPortalUpdateCheckpoint(OPERATION_ID)).toBeNull();
  });
});
