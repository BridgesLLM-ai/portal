/**
 * Shared numeric identity for every non-Agent-Zero Project workspace runtime.
 *
 * Project lifecycle jobs, Git operations, OpenClaw, and the native CLI
 * providers all read and write the same host bind. Keeping the identity in a
 * dependency-light module prevents those runtimes from silently diverging.
 */
export const PROJECT_RUNTIME_UID = 1000;
export const PROJECT_RUNTIME_GID = 1000;
export const PROJECT_RUNTIME_USER = `${PROJECT_RUNTIME_UID}:${PROJECT_RUNTIME_GID}`;
