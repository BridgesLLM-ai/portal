BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "AgentSession"
    GROUP BY "provider", "externalId"
    HAVING COUNT(DISTINCT "userId") > 1
  ) THEN
    RAISE EXCEPTION
      'AgentSession provider/externalId is claimed by more than one user; resolve the ownership conflict before upgrading';
  END IF;
END
$$;

WITH ranked_same_user_sessions AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "provider", "externalId", "userId"
      ORDER BY "lastActivityAt" DESC, "createdAt" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "AgentSession"
)
DELETE FROM "AgentSession"
WHERE "id" IN (
  SELECT "id"
  FROM ranked_same_user_sessions
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX "AgentSession_provider_externalId_key"
ON "AgentSession" ("provider", "externalId");

ALTER TABLE "ProjectChatTurn"
ADD COLUMN "actorAuthorizationVersion" INTEGER;

UPDATE "ProjectChatTurn" AS turn
SET "actorAuthorizationVersion" = COALESCE((
  SELECT "authorizationVersion"
  FROM "User"
  WHERE "User"."id" = turn."actorUserId"
), 1);

ALTER TABLE "ProjectChatTurn"
ALTER COLUMN "actorAuthorizationVersion" SET NOT NULL;

ALTER TABLE "ProjectChatTurn"
ADD CONSTRAINT "ProjectChatTurn_actorAuthorizationVersion_check"
CHECK ("actorAuthorizationVersion" >= 1);

ALTER TABLE "AgentJob"
ADD COLUMN "actorAuthorizationVersion" INTEGER;

UPDATE "AgentJob" AS job
SET "actorAuthorizationVersion" = COALESCE((
  SELECT "authorizationVersion"
  FROM "User"
  WHERE "User"."id" = job."userId"
), 1);

ALTER TABLE "AgentJob"
ALTER COLUMN "actorAuthorizationVersion" SET NOT NULL;

ALTER TABLE "AgentJob"
ADD CONSTRAINT "AgentJob_actorAuthorizationVersion_check"
CHECK ("actorAuthorizationVersion" >= 1);

CREATE TABLE "HostAgentRun" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorAuthorizationVersion" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "portalInstanceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARED',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "scopeUnit" TEXT,
  "scopeTag" TEXT,
  "bootId" TEXT,
  "controlGroup" TEXT,
  "gatePath" TEXT,
  "scopeInvocationId" TEXT,
  "launcherPid" INTEGER,
  "dispatchActivatedAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "terminalReason" TEXT,
  "evidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HostAgentRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HostAgentRun_authorization_generation_check"
    CHECK ("actorAuthorizationVersion" >= 1),
  CONSTRAINT "HostAgentRun_attempt_check"
    CHECK ("attempt" >= 0),
  CONSTRAINT "HostAgentRun_status_check"
    CHECK ("status" IN (
      'PREPARED',
      'SPAWNED',
      'DISPATCHED',
      'QUARANTINED',
      'COMPLETED',
      'ABORTED',
      'ERROR',
      'RECOVERED'
    )),
  CONSTRAINT "HostAgentRun_scope_identity_check"
    CHECK (
      (
        "status" = 'PREPARED'
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
            AND "scopeUnit" IS NOT NULL
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
    ),
  CONSTRAINT "HostAgentRun_settlement_check"
    CHECK (
      (
        "status" IN ('PREPARED', 'SPAWNED', 'DISPATCHED', 'QUARANTINED')
        AND "settledAt" IS NULL
      )
      OR
      (
        "status" IN ('COMPLETED', 'ABORTED', 'ERROR', 'RECOVERED')
        AND "settledAt" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "HostAgentRun_one_unresolved_session"
ON "HostAgentRun" ("sessionId")
WHERE "status" IN ('PREPARED', 'SPAWNED', 'DISPATCHED', 'QUARANTINED');

CREATE UNIQUE INDEX "HostAgentRun_scopeUnit_key"
ON "HostAgentRun" ("scopeUnit");

-- Exercise the exact reservation and spawned constraint shapes during the
-- migration itself. This leaves no fixture data behind, but prevents a path
-- slicing/regex mistake from installing a schema that rejects valid runs.
DO $host_run_scope_constraint$
DECLARE
  fixture_id TEXT := '__bridgesllm_host_run_scope_constraint_fixture__';
  fixture_unit TEXT := 'bridgesllm-host-agent-0123456789abcdef0123456789abcdef.scope';
  fixture_tag TEXT := repeat('ab', 32);
BEGIN
  INSERT INTO "HostAgentRun" (
    "id",
    "actorUserId",
    "actorAuthorizationVersion",
    "provider",
    "sessionId",
    "portalInstanceId",
    "status",
    "attempt",
    "scopeUnit",
    "scopeTag",
    "bootId",
    "controlGroup",
    "gatePath"
  ) VALUES (
    fixture_id,
    '__migration_fixture_actor__',
    1,
    'CODEX',
    '__migration_fixture_session__',
    '__migration_fixture_portal__',
    'PREPARED',
    1,
    fixture_unit,
    fixture_tag,
    '01234567-89ab-4cde-8fab-0123456789ab',
    '/system.slice/' || fixture_unit,
    '/run/bridgesllm/host-agent-runs/gate-0123456789abcdef0123456789abcdef.sock'
  );

  UPDATE "HostAgentRun"
  SET
    "status" = 'SPAWNED',
    "scopeInvocationId" = 'fedcba9876543210fedcba9876543210'
  WHERE "id" = fixture_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'HostAgentRun scope constraint fixture could not transition to SPAWNED';
  END IF;

  DELETE FROM "HostAgentRun" WHERE "id" = fixture_id;
END
$host_run_scope_constraint$;

CREATE INDEX "HostAgentRun_actorUserId_status_idx"
ON "HostAgentRun" ("actorUserId", "status");

CREATE INDEX "HostAgentRun_sessionId_status_idx"
ON "HostAgentRun" ("sessionId", "status");

CREATE INDEX "HostAgentRun_provider_status_idx"
ON "HostAgentRun" ("provider", "status");

CREATE TABLE "OpenClawHostRun" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorAuthorizationVersion" INTEGER NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'OPENCLAW',
  "executionScope" TEXT NOT NULL DEFAULT 'HOST_OPERATOR',
  "sessionKey" TEXT NOT NULL,
  "portalInstanceId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREPARED',
  "upstreamRunId" TEXT,
  "visibleSettledAt" TIMESTAMP(3),
  "quiescedAt" TIMESTAMP(3),
  "terminalReason" TEXT,
  "evidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OpenClawHostRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OpenClawHostRun_authorization_generation_check"
    CHECK ("actorAuthorizationVersion" >= 1),
  CONSTRAINT "OpenClawHostRun_provider_check"
    CHECK ("provider" = 'OPENCLAW'),
  CONSTRAINT "OpenClawHostRun_execution_scope_check"
    CHECK ("executionScope" = 'HOST_OPERATOR'),
  CONSTRAINT "OpenClawHostRun_status_check"
    CHECK ("status" IN (
      'PREPARED',
      'DISPATCHED',
      'VISIBLE_DONE',
      'QUARANTINED',
      'QUIESCED'
    )),
  CONSTRAINT "OpenClawHostRun_dispatch_check"
    CHECK (
      (
        "status" = 'PREPARED'
        AND "upstreamRunId" IS NULL
      )
      OR
      (
        "status" IN ('DISPATCHED', 'VISIBLE_DONE')
        AND "upstreamRunId" IS NOT NULL
      )
      OR
      "status" IN ('QUARANTINED', 'QUIESCED')
    ),
  CONSTRAINT "OpenClawHostRun_visible_settlement_check"
    CHECK (
      ("status" = 'VISIBLE_DONE' AND "visibleSettledAt" IS NOT NULL)
      OR
      "status" <> 'VISIBLE_DONE'
    ),
  CONSTRAINT "OpenClawHostRun_quiescence_check"
    CHECK (
      (
        "status" = 'QUIESCED'
        AND "quiescedAt" IS NOT NULL
        AND "evidence" IS NOT NULL
      )
      OR
      (
        "status" <> 'QUIESCED'
        AND "quiescedAt" IS NULL
      )
    )
);

CREATE INDEX "OpenClawHostRun_actorUserId_status_idx"
ON "OpenClawHostRun" ("actorUserId", "status");

CREATE INDEX "OpenClawHostRun_sessionKey_status_idx"
ON "OpenClawHostRun" ("sessionKey", "status");

CREATE INDEX "OpenClawHostRun_provider_status_idx"
ON "OpenClawHostRun" ("provider", "status");

CREATE TABLE "ProjectAuthorizationTransition" (
  "id" TEXT NOT NULL,
  "singletonKey" TEXT NOT NULL DEFAULT 'GLOBAL',
  "kind" TEXT NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'PREPARED',
  "initiatedByUserId" TEXT NOT NULL,
  "targetUserId" TEXT,
  "sourceOwnerUserId" TEXT,
  "payload" JSONB NOT NULL,
  "result" JSONB,
  "gatewayWasActive" BOOLEAN,
  "gatewayFenceProof" JSONB,
  "hostRuntimeQuiescenceProof" JSONB,
  "leaseOwner" TEXT,
  "leaseTokenHash" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectAuthorizationTransition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectAuthorizationTransition_singleton_check"
    CHECK ("singletonKey" = 'GLOBAL'),
  CONSTRAINT "ProjectAuthorizationTransition_kind_check"
    CHECK ("kind" IN ('USER_AUTHORIZATION_UPDATE', 'CREDENTIAL_RECOVERY', 'OWNERSHIP_TRANSFER')),
  CONSTRAINT "ProjectAuthorizationTransition_phase_check"
    CHECK ("phase" IN (
      'PREPARED',
      'QUIESCING',
      'PROVIDER_FENCED',
      'COMMITTED',
      'COMPLETE'
    )),
  CONSTRAINT "ProjectAuthorizationTransition_lease_pair_check"
    CHECK (
      ("leaseOwner" IS NULL AND "leaseTokenHash" IS NULL AND "leaseExpiresAt" IS NULL)
      OR
      ("leaseOwner" IS NOT NULL AND "leaseTokenHash" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    )
);

CREATE TABLE "ProjectAuthorizationTransitionProject" (
  "transitionId" TEXT NOT NULL,
  "projectIdentityId" TEXT NOT NULL,
  "workspaceOwnerId" TEXT NOT NULL,
  "projectName" TEXT NOT NULL,
  "canonicalRoot" TEXT NOT NULL,
  "rootDevice" TEXT NOT NULL,
  "rootInode" TEXT NOT NULL,
  "rootBirthtimeNs" TEXT NOT NULL,
  "projectGeneration" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "quiescenceEvidence" JSONB,
  "quiescedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectAuthorizationTransitionProject_pkey"
    PRIMARY KEY ("transitionId", "projectIdentityId"),
  CONSTRAINT "ProjectAuthorizationTransitionProject_transitionId_fkey"
    FOREIGN KEY ("transitionId")
    REFERENCES "ProjectAuthorizationTransition"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectAuthorizationTransitionProject_generation_check"
    CHECK ("projectGeneration" >= 1),
  CONSTRAINT "ProjectAuthorizationTransitionProject_status_check"
    CHECK ("status" IN ('PENDING', 'QUIESCED')),
  CONSTRAINT "ProjectAuthorizationTransitionProject_quiescence_check"
    CHECK (
      ("status" = 'PENDING' AND "quiescedAt" IS NULL)
      OR
      ("status" = 'QUIESCED' AND "quiescedAt" IS NOT NULL AND "quiescenceEvidence" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "ProjectAuthorizationTransition_one_unresolved"
ON "ProjectAuthorizationTransition" ("singletonKey")
WHERE "phase" <> 'COMPLETE';

CREATE INDEX "ProjectAuthorizationTransition_phase_createdAt_idx"
ON "ProjectAuthorizationTransition" ("phase", "createdAt");

CREATE INDEX "ProjectAuthorizationTransition_targetUserId_idx"
ON "ProjectAuthorizationTransition" ("targetUserId");

CREATE INDEX "ProjectAuthorizationTransition_sourceOwnerUserId_idx"
ON "ProjectAuthorizationTransition" ("sourceOwnerUserId");

CREATE INDEX "ProjectAuthorizationTransitionProject_projectIdentityId_idx"
ON "ProjectAuthorizationTransitionProject" ("projectIdentityId");

CREATE INDEX "ProjectAuthorizationTransitionProject_transitionId_status_idx"
ON "ProjectAuthorizationTransitionProject" ("transitionId", "status");

COMMIT;
