export function buildPasswordResetPath(rawToken: string): string {
  return `/reset-password#token=${encodeURIComponent(rawToken)}`;
}
