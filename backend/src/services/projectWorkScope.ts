import { AsyncLocalStorage } from 'async_hooks';

export interface ProjectWorkScope {
  id: string;
  generation: number;
  workspaceOwnerId: string;
  projectName: string;
}

// The existing name-addressed Project API must never follow a card's name to
// another identity. This context also follows the kernel's async dispatch.
const scope = new AsyncLocalStorage<Readonly<ProjectWorkScope>>();
export function withProjectWorkScope<T>(binding: ProjectWorkScope, run: () => T): T {
  return scope.run(Object.freeze({ ...binding }), run);
}
export function assertProjectWorkScope(identity: ProjectWorkScope | null): void {
  const expected = scope.getStore();
  if (!expected) return;
  if (!identity || Object.keys(expected).some((key) => (
    identity[key as keyof ProjectWorkScope] !== expected[key as keyof ProjectWorkScope]
  ))) {
    const error = new Error('This project changed. Select the project again before starting new work.');
    Object.assign(error, { code: 'PROJECT_WORK_SCOPE_CHANGED', status: 409 });
    throw error;
  }
}
