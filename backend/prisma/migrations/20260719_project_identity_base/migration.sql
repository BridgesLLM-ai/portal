-- Project runtimes must bind to a server-owned immutable identity rather than
-- a marker stored inside the writable project directory. Existing projects
-- are enrolled lazily after the Portal verifies their canonical path and
-- inode/device pair.
CREATE TABLE "ProjectIdentity" (
  "id" TEXT NOT NULL,
  "workspaceOwnerId" TEXT NOT NULL,
  "projectName" TEXT NOT NULL,
  "canonicalRoot" TEXT NOT NULL,
  "rootDevice" TEXT NOT NULL,
  "rootInode" TEXT NOT NULL,
  "rootBirthtimeNs" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectIdentity_workspaceOwnerId_projectName_key"
  ON "ProjectIdentity"("workspaceOwnerId", "projectName");
CREATE UNIQUE INDEX "ProjectIdentity_workspaceOwnerId_canonicalRoot_key"
  ON "ProjectIdentity"("workspaceOwnerId", "canonicalRoot");
CREATE INDEX "ProjectIdentity_workspaceOwnerId_idx"
  ON "ProjectIdentity"("workspaceOwnerId");

ALTER TABLE "ProjectIdentity"
  ADD CONSTRAINT "ProjectIdentity_workspaceOwnerId_fkey"
  FOREIGN KEY ("workspaceOwnerId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep the persisted provider catalog additive. GROK_BUILD is deliberately
-- distinct from xAI models reached through the OPENCLAW provider.
ALTER TYPE "AgentProviderType" ADD VALUE IF NOT EXISTS 'GEMINI';
ALTER TYPE "AgentProviderType" ADD VALUE IF NOT EXISTS 'OLLAMA';
ALTER TYPE "AgentProviderType" ADD VALUE IF NOT EXISTS 'GROK_BUILD';
