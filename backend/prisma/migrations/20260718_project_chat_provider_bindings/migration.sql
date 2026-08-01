-- Portal owns the project transcript while each runtime keeps a separate,
-- opaque provider-side session binding. Existing Project Chat rows keep their
-- legacy session IDs and are lazily bound to OpenClaw on first authenticated
-- access, when the canonical project sandbox root can be verified.
ALTER TABLE "ProjectChatMessage"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'OPENCLAW',
  ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'openclaw-dedicated-project-agent',
  ADD COLUMN "model" TEXT,
  ADD COLUMN "providerSessionId" TEXT;

ALTER TABLE "ProjectChatSession"
  ADD COLUMN "activeProvider" TEXT NOT NULL DEFAULT 'OPENCLAW',
  ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'openclaw-dedicated-project-agent';

CREATE TABLE "ProjectChatProviderBinding" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "runtime" TEXT NOT NULL,
  "sessionKey" TEXT,
  "externalSessionId" TEXT,
  "model" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "sandboxRoot" TEXT NOT NULL,
  "policyFingerprint" TEXT NOT NULL,
  "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectChatProviderBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectChatProviderBinding_userId_projectId_provider_key"
  ON "ProjectChatProviderBinding"("userId", "projectId", "provider");
CREATE INDEX "ProjectChatProviderBinding_userId_projectId_idx"
  ON "ProjectChatProviderBinding"("userId", "projectId");
CREATE INDEX "ProjectChatProviderBinding_provider_status_idx"
  ON "ProjectChatProviderBinding"("provider", "status");
CREATE INDEX "ProjectChatMessage_userId_projectId_provider_idx"
  ON "ProjectChatMessage"("userId", "projectId", "provider");

ALTER TABLE "ProjectChatProviderBinding"
  ADD CONSTRAINT "ProjectChatProviderBinding_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
