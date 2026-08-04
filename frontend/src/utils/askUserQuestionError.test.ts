import { describe, expect, it } from 'vitest';
import { isAskUserQuestionNoLongerOpenError } from './askUserQuestionError';

describe('ask-user settlement error classification', () => {
  it('recognizes the stable cross-tab reconciliation code', () => {
    expect(isAskUserQuestionNoLongerOpenError({
      response: {
        status: 404,
        data: { code: 'ASK_USER_NOT_OPEN', error: 'That question is no longer open.' },
      },
    })).toBe(true);
  });

  it('recognizes the previous server message during a rolling update', () => {
    expect(isAskUserQuestionNoLongerOpenError({
      response: {
        status: 404,
        data: { error: 'That question is no longer open.' },
      },
    })).toBe(true);
  });

  it('does not suppress unrelated 404s or delivery failures', () => {
    expect(isAskUserQuestionNoLongerOpenError({
      response: { status: 404, data: { error: 'Session not found.' } },
    })).toBe(false);
    expect(isAskUserQuestionNoLongerOpenError(new Error('Network Error'))).toBe(false);
  });
});
