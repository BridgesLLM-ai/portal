/**
 * Portal 4.0 cannot destructively retire Portal 3.x OpenClaw Project state
 * until the Gateway exposes an atomic agent/session admission fence and the
 * runtime exposes authoritative transcript/container provenance.
 *
 * Callers deliberately embed a module-local literal-false release gate. Do not
 * replace those gates with an environment variable or operator switch: a stale
 * deployment setting must never opt a customer into destructive migration.
 */
export const LEGACY_OPENCLAW_RETIREMENT_PENDING_MESSAGE =
  'Legacy OpenClaw Project state is preserved because destructive retirement is unavailable in this release.';
