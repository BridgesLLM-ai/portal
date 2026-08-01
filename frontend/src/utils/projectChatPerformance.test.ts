import { describe, expect, it } from 'vitest';
import {
  PROJECT_CHAT_BACKGROUND_RENDER_MS,
  PROJECT_CHAT_FOREGROUND_RENDER_MS,
  PROJECT_CHAT_MAX_RETRY_AFTER_MS,
  getProjectChatRenderDelay,
  getProjectReplayPollDelay,
  normalizeProjectChatVisibility,
} from './projectChatPerformance';

describe('Project Chat low-spec scheduling', () => {
  it('coalesces live renders more aggressively while the page is hidden', () => {
    expect(getProjectChatRenderDelay('visible')).toBe(PROJECT_CHAT_FOREGROUND_RENDER_MS);
    expect(getProjectChatRenderDelay('hidden')).toBe(PROJECT_CHAT_BACKGROUND_RENDER_MS);
    expect(PROJECT_CHAT_BACKGROUND_RENDER_MS).toBeGreaterThan(PROJECT_CHAT_FOREGROUND_RENDER_MS);
  });

  it('treats unknown visibility values as visible and responsive', () => {
    expect(normalizeProjectChatVisibility(undefined)).toBe('visible');
    expect(getProjectChatRenderDelay('prerender')).toBe(PROJECT_CHAT_FOREGROUND_RENDER_MS);
  });

  it('backs off caught-up durable replay in hidden tabs without stopping it', () => {
    expect(getProjectReplayPollDelay({ visibility: 'visible', replayCaughtUp: true, active: true })).toBe(750);
    expect(getProjectReplayPollDelay({ visibility: 'hidden', replayCaughtUp: true, active: true })).toBe(5_000);
  });

  it('continues paging backlog and prioritizes terminal events', () => {
    expect(getProjectReplayPollDelay({ visibility: 'visible', replayCaughtUp: false, active: true })).toBe(25);
    expect(getProjectReplayPollDelay({ visibility: 'hidden', replayCaughtUp: false, active: true })).toBe(1_000);
    expect(getProjectReplayPollDelay({ visibility: 'visible', replayCaughtUp: false, active: true, deferredTerminal: true })).toBe(100);
  });

  it('uses bounded retry backoff rather than abandoning durable replay', () => {
    expect(getProjectReplayPollDelay({ visibility: 'visible', failed: true })).toBe(2_000);
    expect(getProjectReplayPollDelay({ visibility: 'hidden', failed: true })).toBe(10_000);
  });

  it('honors bounded Retry-After values without allowing a rapid 429 loop', () => {
    expect(getProjectReplayPollDelay({
      visibility: 'visible',
      failed: true,
      retryAfter: '37',
    })).toBe(37_000);
    expect(getProjectReplayPollDelay({
      visibility: 'visible',
      failed: true,
      retryAfter: 'Wed, 21 Oct 2026 07:28:30 GMT',
      nowMs: Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'),
    })).toBe(30_000);
    expect(getProjectReplayPollDelay({
      visibility: 'visible',
      failed: true,
      retryAfter: '600',
    })).toBe(PROJECT_CHAT_MAX_RETRY_AFTER_MS);
    expect(getProjectReplayPollDelay({
      visibility: 'visible',
      failed: true,
      retryAfter: 'not-a-date',
    })).toBe(2_000);
  });
});
