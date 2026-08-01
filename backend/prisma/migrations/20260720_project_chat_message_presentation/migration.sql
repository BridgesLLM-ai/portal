ALTER TABLE "ProjectChatMessage"
  ADD COLUMN "turnId" TEXT,
  ADD COLUMN "presentation" JSONB;

CREATE UNIQUE INDEX "ProjectChatMessage_turnId_key"
  ON "ProjectChatMessage"("turnId");
