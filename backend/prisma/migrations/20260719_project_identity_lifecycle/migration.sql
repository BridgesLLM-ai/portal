ALTER TABLE "ProjectIdentity"
  ADD COLUMN "lifecycleStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "deletionStartedAt" TIMESTAMP(3);

CREATE INDEX "ProjectIdentity_lifecycleStatus_idx"
  ON "ProjectIdentity"("lifecycleStatus");
