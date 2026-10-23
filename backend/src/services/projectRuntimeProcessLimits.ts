/**
 * Linux RLIMIT_NPROC counts tasks across the real UID, not the container.
 * Project binds require the shared workspace UID. The cgroup PID controller
 * remains the per-runtime boundary (256, including threads and docker-init).
 * Keep a finite supplementary shared-UID ceiling rather than treating 256 as
 * a container-local rlimit or removing the limit. 4096 gives 16 PID budgets of
 * headroom; it is not a concurrency grant. At this aggregate ceiling fail closed.
 */
export const PROJECT_RUNTIME_PIDS_LIMIT = 256;
export const PROJECT_RUNTIME_SHARED_NPROC_LIMIT = 4096;
export const PROJECT_RUNTIME_LEGACY_NPROC_LIMIT = 256;
