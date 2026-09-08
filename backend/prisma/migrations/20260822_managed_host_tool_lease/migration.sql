-- Extend the applied HostAgentRun scope contract for the managed host-tool
-- transient-service lease.  Keep the legacy .scope shape byte-compatible;
-- managed .service rows are a disjoint provider/evidence-bound authority.
BEGIN;

ALTER TABLE "HostAgentRun"
  DROP CONSTRAINT "HostAgentRun_scope_identity_check";

ALTER TABLE "HostAgentRun"
  ADD CONSTRAINT "HostAgentRun_scope_identity_check"
  CHECK (
    COALESCE((
      -- Original generic host-agent scope contract.
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
    OR
    COALESCE((
      -- Managed Codex/Claude transient-service reservation identity.
      "attempt" > 0
      AND "scopeUnit" ~ '^bridgesllm-host-tool-(codex|claude-code)-[0-9a-f]{32}[.]service$'
      AND "scopeTag" ~ '^[0-9a-f]{64}$'
      AND "bootId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND "controlGroup" = '/system.slice/' || "scopeUnit"
      AND "gatePath" = '/run/bridgesllm/managed-host-tools/gate-'
        || regexp_replace(
          "scopeUnit",
          '^bridgesllm-host-tool-(codex|claude-code)-([0-9a-f]{32})[.]service$',
          '\2'
        )
        || '.sock'
      AND (
        ("provider" = 'CODEX' AND "scopeUnit" ~ '^bridgesllm-host-tool-codex-')
        OR
        ("provider" = 'CLAUDE_CODE' AND "scopeUnit" ~ '^bridgesllm-host-tool-claude-code-')
      )
      AND jsonb_typeof("evidence") = 'object'
      AND jsonb_typeof("evidence" -> 'managedHostToolReservation') = 'object'
      AND "evidence" -> 'managedHostToolReservation' ->> 'contract'
        = 'bridgesllm-managed-host-tool-reservation-v1'
      AND "evidence" -> 'managedHostToolReservation' ->> 'toolId'
        = CASE "provider" WHEN 'CODEX' THEN 'codex' ELSE 'claude-code' END
      AND "evidence" -> 'managedHostToolReservation' ->> 'attemptToken'
        = regexp_replace(
          "scopeUnit",
          '^bridgesllm-host-tool-(codex|claude-code)-([0-9a-f]{32})[.]service$',
          '\2'
        )
      AND "evidence" -> 'managedHostToolReservation' ->> 'runtimeGeneration'
        ~ '^bundle-[0-9a-f]{64}$'
      AND jsonb_typeof("evidence" -> 'managedHostToolReservation' -> 'systemdVersion') = 'number'
      AND ("evidence" -> 'managedHostToolReservation' ->> 'systemdVersion')::numeric >= 249
      AND (
        (
          "status" = 'PREPARED'
          AND "scopeInvocationId" IS NULL
          AND "launcherPid" IS NULL
          AND "dispatchActivatedAt" IS NULL
          AND NOT ("evidence" ? 'managedHostToolLease')
        )
        OR
        (
          "status" IN ('SPAWNED', 'DISPATCHED', 'QUARANTINED', 'COMPLETED', 'ABORTED', 'ERROR', 'RECOVERED')
          AND jsonb_typeof("evidence" -> 'managedHostToolLease') = 'object'
          AND "scopeInvocationId" ~ '^[0-9a-f]{32}$'
          AND "launcherPid" > 1
          AND "evidence" -> 'managedHostToolLease' ->> 'leaseProtocol'
            = 'bridgesllm-managed-host-tool-lease-v1'
          AND "evidence" -> 'managedHostToolLease' ->> 'contract'
            = 'bridgesllm-managed-host-tool-evidence-v1'
          AND "evidence" -> 'managedHostToolLease' ->> 'toolId'
            = CASE "provider" WHEN 'CODEX' THEN 'codex' ELSE 'claude-code' END
          AND "evidence" -> 'managedHostToolLease' ->> 'attemptToken'
            = "evidence" -> 'managedHostToolReservation' ->> 'attemptToken'
          AND "evidence" -> 'managedHostToolLease' ->> 'leaseTag' = "scopeTag"
          AND "evidence" -> 'managedHostToolLease' ->> 'unit' = "scopeUnit"
          AND "evidence" -> 'managedHostToolLease' ->> 'description'
            = 'BridgesLLM managed host tool='
              || CASE "provider" WHEN 'CODEX' THEN 'codex' ELSE 'claude-code' END
          AND "evidence" -> 'managedHostToolLease' ->> 'bootId' = "bootId"
          AND "evidence" -> 'managedHostToolLease' ->> 'controlGroup' = "controlGroup"
          AND "evidence" -> 'managedHostToolLease' ->> 'gatePath' = "gatePath"
          AND "evidence" -> 'managedHostToolLease' ->> 'invocationId' = "scopeInvocationId"
          AND jsonb_typeof("evidence" -> 'managedHostToolLease' -> 'mainPid') = 'number'
          AND ("evidence" -> 'managedHostToolLease' ->> 'mainPid')::numeric = "launcherPid"
          AND jsonb_typeof("evidence" -> 'managedHostToolLease' -> 'guardianPid') = 'number'
          AND ("evidence" -> 'managedHostToolLease' ->> 'guardianPid')::numeric = "launcherPid"
          AND "evidence" -> 'managedHostToolLease' ->> 'runtimeGenerationSha256'
            = substring("evidence" -> 'managedHostToolReservation' ->> 'runtimeGeneration' from 8)
          AND "evidence" -> 'managedHostToolLease' ->> 'fdName'
            = 'bridgesllm-generation-lease-v1-'
              || CASE "provider" WHEN 'CODEX' THEN 'codex' ELSE 'claude-code' END
              || '-' || ("evidence" -> 'managedHostToolLease' ->> 'lockDevice')
              || '-' || ("evidence" -> 'managedHostToolLease' ->> 'lockInode')
          AND "evidence" -> 'managedHostToolLease' ->> 'receiptSha256' ~ '^[0-9a-f]{64}$'
          AND "evidence" -> 'managedHostToolLease' ->> 'catalogSha256' ~ '^[0-9a-f]{64}$'
          AND "evidence" -> 'managedHostToolLease' ->> 'targetSetSha256' ~ '^[0-9a-f]{64}$'
          AND "evidence" -> 'managedHostToolLease' ->> 'executableSha256' ~ '^[0-9a-f]{64}$'
          AND (
            ("provider" = 'CODEX' AND "evidence" -> 'managedHostToolLease' ->> 'executablePath' = '/usr/bin/codex')
            OR
            ("provider" = 'CLAUDE_CODE' AND "evidence" -> 'managedHostToolLease' ->> 'executablePath' = '/usr/bin/claude')
          )
          AND (
            ("status" = 'SPAWNED' AND "dispatchActivatedAt" IS NULL)
            OR
            ("status" = 'DISPATCHED' AND "dispatchActivatedAt" IS NOT NULL)
            OR
            "status" IN ('QUARANTINED', 'COMPLETED', 'ABORTED', 'ERROR', 'RECOVERED')
          )
        )
        OR
        (
          "status" IN ('QUARANTINED', 'COMPLETED', 'ABORTED', 'ERROR', 'RECOVERED')
          AND "scopeInvocationId" IS NULL
          AND "launcherPid" IS NULL
          AND "dispatchActivatedAt" IS NULL
          AND NOT ("evidence" ? 'managedHostToolLease')
        )
      )
    ), FALSE)
  ) NOT VALID;

ALTER TABLE "HostAgentRun"
  VALIDATE CONSTRAINT "HostAgentRun_scope_identity_check";

-- Exercise both disjoint shapes without leaving fixture authority behind.
DO $managed_host_tool_scope_constraint$
DECLARE
  managed_id TEXT := '__bridgesllm_managed_host_tool_constraint_fixture__';
  managed_unit TEXT := 'bridgesllm-host-tool-codex-0123456789abcdef0123456789abcdef.service';
  managed_tag TEXT := repeat('ab', 32);
  invocation_id TEXT := 'fedcba9876543210fedcba9876543210';
  runtime_sha TEXT := repeat('1', 64);
BEGIN
  INSERT INTO "HostAgentRun" (
    "id", "actorUserId", "actorAuthorizationVersion", "provider", "sessionId",
    "portalInstanceId", "status", "attempt", "scopeUnit", "scopeTag", "bootId",
    "controlGroup", "gatePath", "evidence"
  ) VALUES (
    managed_id, '__migration_fixture_actor__', 1, 'CODEX',
    '__managed_migration_fixture_session__', '__migration_fixture_portal__',
    'PREPARED', 1, managed_unit, managed_tag,
    '01234567-89ab-4cde-8fab-0123456789ab', '/system.slice/' || managed_unit,
    '/run/bridgesllm/managed-host-tools/gate-0123456789abcdef0123456789abcdef.sock',
    jsonb_build_object(
      'managedHostToolReservation', jsonb_build_object(
        'contract', 'bridgesllm-managed-host-tool-reservation-v1',
        'toolId', 'codex',
        'attemptToken', '0123456789abcdef0123456789abcdef',
        'runtimeGeneration', 'bundle-' || runtime_sha,
        'systemdVersion', 249
      )
    )
  );

  UPDATE "HostAgentRun"
  SET
    "status" = 'SPAWNED',
    "scopeInvocationId" = invocation_id,
    "launcherPid" = 4242,
    "evidence" = "evidence" || jsonb_build_object(
      'managedHostToolLease', jsonb_build_object(
        'contract', 'bridgesllm-managed-host-tool-evidence-v1',
        'toolId', 'codex',
        'attemptToken', '0123456789abcdef0123456789abcdef',
        'bootId', '01234567-89ab-4cde-8fab-0123456789ab',
        'lockDevice', '1',
        'lockInode', '2',
        'fdName', 'bridgesllm-generation-lease-v1-codex-1-2',
        'runtimeGenerationSha256', runtime_sha,
        'catalogSha256', repeat('2', 64),
        'targetSetSha256', repeat('3', 64),
        'receiptSha256', repeat('4', 64),
        'executablePath', '/usr/bin/codex',
        'executableSha256', repeat('5', 64),
        'guardianPid', 4242,
        'guardianStartTime', '100',
        'leaseProtocol', 'bridgesllm-managed-host-tool-lease-v1',
        'leaseTag', managed_tag,
        'unit', managed_unit,
        'description', 'BridgesLLM managed host tool=codex',
        'invocationId', invocation_id,
        'controlGroup', '/system.slice/' || managed_unit,
        'gatePath', '/run/bridgesllm/managed-host-tools/gate-0123456789abcdef0123456789abcdef.sock',
        'systemdVersion', 249,
        'mainPid', 4242
      )
    )
  WHERE "id" = managed_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Managed HostAgentRun constraint fixture could not transition to SPAWNED';
  END IF;

  DELETE FROM "HostAgentRun" WHERE "id" = managed_id;
END
$managed_host_tool_scope_constraint$;

COMMIT;
