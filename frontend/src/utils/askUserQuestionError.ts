export const ASK_USER_NOT_OPEN_CODE = 'ASK_USER_NOT_OPEN';

/**
 * Another tab/device may settle a question after this surface last polled it.
 * That is a normal reconciliation race, not an actionable Portal failure.
 */
export function isAskUserQuestionNoLongerOpenError(error: unknown): boolean {
  const candidate = error as any;
  const status = Number(candidate?.response?.status);
  const code = String(candidate?.response?.data?.code || '').trim();
  const message = String(candidate?.response?.data?.error || '').trim();
  return status === 404 && (
    code === ASK_USER_NOT_OPEN_CODE
    || message === 'That question is no longer open.'
  );
}
