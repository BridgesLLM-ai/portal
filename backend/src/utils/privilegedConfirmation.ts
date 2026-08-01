export const PRIVILEGED_CONFIRMATION = {
  remoteDesktopSetup: 'SET UP REMOTE DESKTOP',
  remoteDesktopRecovery: 'RESTART REMOTE DESKTOP',
  compatibilityHotfix: 'RESTART OPENCLAW',
  grantServerAccess: 'GRANT SERVER ACCESS',
  portalUpdate: 'UPDATE PORTAL',
  ollamaUnload: 'UNLOAD OLLAMA MODELS',
  ollamaRestart: 'RESTART OLLAMA',
} as const;

export function confirmationForUserDeletion(email: string): string {
  return `DELETE ${String(email || '').trim().toLowerCase()}`;
}

export function confirmationForOwnershipTransfer(email: string): string {
  return `TRANSFER TO ${String(email || '').trim().toLowerCase()}`;
}

export function confirmationForMailboxDeletion(username: string): string {
  return `DELETE MAILBOX ${String(username || '').trim()}`;
}

export function confirmationForToolInstall(toolId: string): string {
  return `INSTALL ${String(toolId || '').trim().toUpperCase()}`;
}

export function confirmationForSkillInstall(name: string): string {
  return `INSTALL SKILL ${String(name || '').trim()}`;
}

export function confirmationForSkillUninstall(name: string): string {
  return `UNINSTALL SKILL ${String(name || '').trim()}`;
}

export function confirmationForPluginInstall(spec: string): string {
  return `INSTALL PLUGIN ${String(spec || '').trim()}`;
}

export function isTypedConfirmationMatch(expected: string | null | undefined, received: unknown): boolean {
  if (!expected) return true;
  return typeof received === 'string' && received.trim() === expected;
}
