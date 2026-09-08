import { workspaceNavigationInternals, type WorkspaceNavigationBinding } from './workspaceNavigation';
export interface ProjectWorkNavigationTarget {
  projectIdentityId: string; projectGeneration: number;
  originProvider?: string; originSessionKey?: string; cardId?: string;
}
const valid = (value: unknown): value is ProjectWorkNavigationTarget => {
  if (!value || typeof value !== 'object') return false;
  const target = value as ProjectWorkNavigationTarget;
  return typeof target.projectIdentityId === 'string' && target.projectIdentityId.length <= 128
    && target.projectIdentityId.length > 0 && Number.isSafeInteger(target.projectGeneration) && target.projectGeneration > 0
    && (target.cardId === undefined || (typeof target.cardId === 'string' && /^[a-f0-9-]{36}$/i.test(target.cardId)))
    && (target.originProvider === undefined || (typeof target.originProvider === 'string' && /^[A-Z_]{1,40}$/.test(target.originProvider)))
    && (target.originSessionKey === undefined || (typeof target.originSessionKey === 'string' && target.originSessionKey.length > 0 && target.originSessionKey.length <= 512));
};
export function projectWorkLink(target: ProjectWorkNavigationTarget, binding: WorkspaceNavigationBinding): string {
  if (!valid(target)) throw new Error('Invalid project work link.');
  return workspaceNavigationInternals.buildWorkspaceNavigationUrl('/agent-chats', 'project-work', target, binding);
}
export function parseProjectWorkLink(search: string, binding?: WorkspaceNavigationBinding | null): ProjectWorkNavigationTarget | null {
  const target = workspaceNavigationInternals.resolveWorkspaceNavigationTarget('project-work', search, binding);
  return valid(target) ? target : null;
}
