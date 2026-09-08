-- Per-user Agent Chat harness preference. Runtime eligibility remains a
-- server-owned catalog decision; this column stores only the selected stable
-- harness id. Revision zero denotes the migration default so existing browser
-- selections are not overwritten during upgrade.
ALTER TABLE "User"
  ADD COLUMN "defaultAgentHarness" TEXT NOT NULL DEFAULT 'OPENCLAW',
  ADD COLUMN "defaultAgentHarnessRevision" INTEGER NOT NULL DEFAULT 0;
