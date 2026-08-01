export type ProjectChatDocumentVisibility = 'visible' | 'hidden';

export const PROJECT_CHAT_MESSAGE_WINDOW_SIZE = 60;
export const PROJECT_CHAT_TOOL_WINDOW_SIZE = 30;
export const PROJECT_CHAT_FOREGROUND_RENDER_MS = 75;
export const PROJECT_CHAT_BACKGROUND_RENDER_MS = 1_000;
export const PROJECT_CHAT_MAX_RETRY_AFTER_MS = 60_000;

export function normalizeProjectChatVisibility(value: unknown): ProjectChatDocumentVisibility {
  return value === 'hidden' ? 'hidden' : 'visible';
}

export function getProjectChatRenderDelay(visibility: unknown): number {
  return normalizeProjectChatVisibility(visibility) === 'hidden'
    ? PROJECT_CHAT_BACKGROUND_RENDER_MS
    : PROJECT_CHAT_FOREGROUND_RENDER_MS;
}

export function getProjectReplayPollDelay(input: {
  visibility: unknown;
  replayCaughtUp?: boolean;
  active?: boolean;
  deferredTerminal?: boolean;
  failed?: boolean;
  retryAfter?: unknown;
  nowMs?: number;
}): number {
  const hidden = normalizeProjectChatVisibility(input.visibility) === 'hidden';

  if (input.failed) {
    const fallback = hidden ? 10_000 : 2_000;
    const raw = Array.isArray(input.retryAfter) ? input.retryAfter[0] : input.retryAfter;
    const value = typeof raw === 'number' || typeof raw === 'string'
      ? String(raw).trim()
      : '';
    if (!value) return fallback;

    const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
    const retryAfterMs = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(value) - (input.nowMs ?? Date.now());
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return fallback;
    return Math.max(
      fallback,
      Math.min(PROJECT_CHAT_MAX_RETRY_AFTER_MS, Math.ceil(retryAfterMs)),
    );
  }
  if (input.deferredTerminal) return hidden ? 1_000 : 100;
  if (!input.replayCaughtUp) return hidden ? 1_000 : 25;
  if (input.active) return hidden ? 5_000 : 750;
  return hidden ? 10_000 : 750;
}
