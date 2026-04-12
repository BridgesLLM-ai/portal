const RESERVED_SYSTEM_MAILBOX_USERNAMES = new Set(['support', 'noreply']);

export function normalizeMailboxUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isReservedSystemMailboxUsername(username: string): boolean {
  return RESERVED_SYSTEM_MAILBOX_USERNAMES.has(normalizeMailboxUsername(username));
}
