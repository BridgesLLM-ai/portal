export function isTypedConfirmationMatch(expected: string | null | undefined, received: string): boolean {
  if (!expected) return true;
  return received.trim() === expected;
}
