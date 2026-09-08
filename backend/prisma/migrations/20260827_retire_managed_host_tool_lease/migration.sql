-- Retire the receipt-bound managed host-tool transient-service lane.
--
-- This migration deliberately does not attempt to inspect, signal, or stop a
-- systemd unit. Any nonterminal managed authority must be reconciled by the
-- application before the schema can be advanced. Terminal rows retain only a
-- compact, nonsecret audit marker and are normalized back to the generic
-- HostAgentRun terminal shape.
BEGIN;

LOCK TABLE "HostAgentRun" IN ACCESS EXCLUSIVE MODE;

DO $retire_managed_host_tool_active_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "HostAgentRun"
    WHERE "status" IN ('PREPARED', 'SPAWNED', 'DISPATCHED', 'QUARANTINED')
      AND (
        COALESCE(
          "scopeUnit" ~ '^bridgesllm-host-tool-(codex|claude-code)-[0-9a-f]{32}[.]service$',
          FALSE
        )
        OR COALESCE("evidence" ? 'managedHostToolReservation', FALSE)
        OR COALESCE("evidence" ? 'managedHostToolLease', FALSE)
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Unresolved managed host-tool runs block schema retirement',
      DETAIL = 'PREPARED, SPAWNED, DISPATCHED, and QUARANTINED managed runs must be reconciled before retrying the migration.',
      HINT = 'Do not rewrite these rows or infer that a systemd service stopped; reconcile the exact runtime authority first.';
  END IF;
END
$retire_managed_host_tool_active_guard$;

UPDATE "HostAgentRun"
SET
  "attempt" = 0,
  "scopeUnit" = NULL,
  "scopeTag" = NULL,
  "bootId" = NULL,
  "controlGroup" = NULL,
  "gatePath" = NULL,
  "scopeInvocationId" = NULL,
  "launcherPid" = NULL,
  "dispatchActivatedAt" = NULL,
  "evidence" = jsonb_build_object(
    'retiredManagedHostToolAudit',
    jsonb_build_object(
      'schema', 'bridgesllm-retired-managed-host-tool-audit-v1',
      'provider', "provider",
      'terminalStatus', "status",
      'attempt', "attempt",
      'reservationObserved', COALESCE("evidence" ? 'managedHostToolReservation', FALSE),
      'leaseObserved', COALESCE("evidence" ? 'managedHostToolLease', FALSE),
      'dispatchActivated', "dispatchActivatedAt" IS NOT NULL
    )
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('COMPLETED', 'ABORTED', 'ERROR', 'RECOVERED')
  AND (
    COALESCE(
      "scopeUnit" ~ '^bridgesllm-host-tool-(codex|claude-code)-[0-9a-f]{32}[.]service$',
      FALSE
    )
    OR COALESCE("evidence" ? 'managedHostToolReservation', FALSE)
    OR COALESCE("evidence" ? 'managedHostToolLease', FALSE)
  );

DO $retire_managed_host_tool_postcondition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "HostAgentRun"
    WHERE COALESCE(
        "scopeUnit" ~ '^bridgesllm-host-tool-(codex|claude-code)-[0-9a-f]{32}[.]service$',
        FALSE
      )
      OR COALESCE("evidence" ? 'managedHostToolReservation', FALSE)
      OR COALESCE("evidence" ? 'managedHostToolLease', FALSE)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Managed host-tool authority remained after terminal-row normalization';
  END IF;
END
$retire_managed_host_tool_postcondition$;

ALTER TABLE "HostAgentRun"
  DROP CONSTRAINT "HostAgentRun_scope_identity_check";

ALTER TABLE "HostAgentRun"
  ADD CONSTRAINT "HostAgentRun_scope_identity_check"
  CHECK (
    COALESCE((
      -- Generic host-agent systemd-scope contract. The explicit managed-key
      -- exclusions preserve the hardened NULL behavior of the applied schema
      -- while removing its transient-service alternative.
      (
        "status" = 'PREPARED'
        AND NOT COALESCE("evidence" ? 'managedHostToolReservation', FALSE)
        AND NOT COALESCE("evidence" ? 'managedHostToolLease', FALSE)
        AND (
          (
            "attempt" = 0
            AND "scopeUnit" IS NULL
            AND "scopeTag" IS NULL
            AND "bootId" IS NULL
            AND "controlGroup" IS NULL
            AND "gatePath" IS NULL
            AND "scopeInvocationId" IS NULL
            AND "launcherPid" IS NULL
          )
          OR
          (
            "attempt" > 0
            AND "scopeUnit" ~ '^bridgesllm-host-agent-[0-9a-f]{32}[.]scope$'
            AND "scopeTag" ~ '^[0-9a-f]{64}$'
            AND "bootId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND "controlGroup" = '/system.slice/' || "scopeUnit"
            AND "gatePath" = '/run/bridgesllm/host-agent-runs/gate-'
              || substring("scopeUnit" from 23 for 32)
              || '.sock'
            AND "scopeInvocationId" IS NULL
            AND ("launcherPid" IS NULL OR "launcherPid" > 1)
          )
        )
        AND "dispatchActivatedAt" IS NULL
      )
      OR
      (
        "status" IN ('SPAWNED', 'DISPATCHED')
        AND NOT COALESCE("evidence" ? 'managedHostToolReservation', FALSE)
        AND NOT COALESCE("evidence" ? 'managedHostToolLease', FALSE)
        AND "attempt" > 0
        AND "scopeUnit" ~ '^bridgesllm-host-agent-[0-9a-f]{32}[.]scope$'
        AND "scopeTag" ~ '^[0-9a-f]{64}$'
        AND "bootId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND "controlGroup" = '/system.slice/' || "scopeUnit"
        AND "gatePath" = '/run/bridgesllm/host-agent-runs/gate-'
          || substring("scopeUnit" from 23 for 32)
          || '.sock'
        AND "scopeInvocationId" ~ '^[0-9a-f]{32}$'
        AND ("launcherPid" IS NULL OR "launcherPid" > 1)
        AND (
          ("status" = 'SPAWNED' AND "dispatchActivatedAt" IS NULL)
          OR
          ("status" = 'DISPATCHED' AND "dispatchActivatedAt" IS NOT NULL)
        )
      )
      OR
      (
        "status" IN ('QUARANTINED', 'COMPLETED', 'ABORTED', 'ERROR', 'RECOVERED')
        AND NOT COALESCE("evidence" ? 'managedHostToolReservation', FALSE)
        AND NOT COALESCE("evidence" ? 'managedHostToolLease', FALSE)
        AND (
          (
            "attempt" = 0
            AND "scopeUnit" IS NULL
            AND "scopeTag" IS NULL
            AND "bootId" IS NULL
            AND "controlGroup" IS NULL
            AND "gatePath" IS NULL
            AND "scopeInvocationId" IS NULL
            AND "launcherPid" IS NULL
          )
          OR
          (
            "attempt" > 0
            AND "scopeUnit" ~ '^bridgesllm-host-agent-[0-9a-f]{32}[.]scope$'
            AND "scopeTag" ~ '^[0-9a-f]{64}$'
            AND "bootId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND "controlGroup" = '/system.slice/' || "scopeUnit"
            AND "gatePath" = '/run/bridgesllm/host-agent-runs/gate-'
              || substring("scopeUnit" from 23 for 32)
              || '.sock'
            AND ("scopeInvocationId" IS NULL OR "scopeInvocationId" ~ '^[0-9a-f]{32}$')
            AND ("launcherPid" IS NULL OR "launcherPid" > 1)
          )
        )
      )
    ), FALSE)
  ) NOT VALID;

ALTER TABLE "HostAgentRun"
  VALIDATE CONSTRAINT "HostAgentRun_scope_identity_check";

COMMIT;
