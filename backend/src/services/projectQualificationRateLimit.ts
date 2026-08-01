import crypto from 'crypto';

export const PROJECT_QUALIFICATION_WINDOW_MS = 15 * 60_000;
const PROJECT_QUALIFICATION_RESET_SKEW_MS = 1_000;
const MAX_PROJECT_QUALIFICATION_KEY_PART_LENGTH = 256;

export type ProjectQualificationRateLimitProvider =
  | 'OPENCLAW'
  | 'CODEX'
  | 'CLAUDE_CODE'
  | 'AGENT_ZERO'
  | 'GEMINI'
  | 'OLLAMA';

export interface ProjectQualificationRateLimitIdentity {
  actorUserId: string;
  workspaceOwnerId: string;
  projectIdentityId: string;
}

function requireRateLimitKeyPart(label: string, value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized
    || normalized.length > MAX_PROJECT_QUALIFICATION_KEY_PART_LENGTH
    || normalized.includes('\0')
  ) {
    throw new Error(`Project qualification ${label} is invalid`);
  }
  return normalized;
}

/**
 * Build the limiter key from immutable, server-attested identity only. Project
 * display names are deliberately absent: a rename must retain the same budget,
 * while a distinct Project generation reusing that name gets its own budget.
 */
export function projectQualificationRateLimitKey(input: {
  provider: ProjectQualificationRateLimitProvider;
  identity: ProjectQualificationRateLimitIdentity;
}): string {
  const provider = requireRateLimitKeyPart('provider', input.provider);
  const actorUserId = requireRateLimitKeyPart('actor', input.identity.actorUserId);
  const workspaceOwnerId = requireRateLimitKeyPart(
    'workspace owner',
    input.identity.workspaceOwnerId,
  );
  const projectIdentityId = requireRateLimitKeyPart(
    'Project identity',
    input.identity.projectIdentityId,
  );
  return crypto.createHash('sha256')
    .update(JSON.stringify([
      provider,
      actorUserId,
      workspaceOwnerId,
      projectIdentityId,
    ]))
    .digest('hex');
}

/**
 * Return a bounded client retry deadline. express-rate-limit normally supplies
 * a Date, but missing, malformed, stale, or surprisingly distant state falls
 * back to one exact local window instead of producing an invalid/permanent
 * client lockout.
 */
export function projectQualificationRetryAt(
  resetTime: unknown,
  now = Date.now(),
): string {
  if (!Number.isFinite(now)) {
    throw new Error('Project qualification retry clock is invalid');
  }
  const candidate = resetTime instanceof Date ? resetTime.getTime() : Number.NaN;
  const resetAt = Number.isFinite(candidate)
    && candidate >= now
    && candidate <= now + PROJECT_QUALIFICATION_WINDOW_MS + PROJECT_QUALIFICATION_RESET_SKEW_MS
    ? candidate
    : now + PROJECT_QUALIFICATION_WINDOW_MS;
  return new Date(resetAt).toISOString();
}
