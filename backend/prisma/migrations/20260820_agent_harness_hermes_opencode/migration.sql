-- Portal 4.1 adds two independently authenticated host ACP harnesses.
-- DeepSeek Harness remains a non-persisted Developer Preview.
ALTER TYPE "AgentProviderType" ADD VALUE IF NOT EXISTS 'HERMES';
ALTER TYPE "AgentProviderType" ADD VALUE IF NOT EXISTS 'OPENCODE';

-- Hermes and OpenCode are host-only Agent Chat harnesses in 4.1. Their
-- reusable provider credentials and tool permissions are not delegated into
-- Project Chat. Keep this boundary in PostgreSQL as well as the route/runtime
-- allowlists so a stale or compromised application process cannot persist a
-- Project binding for either host harness.
ALTER TABLE "ProjectChatState"
  ADD CONSTRAINT "ProjectChatState_host_harness_project_check"
  CHECK ("selectedProvider"::text NOT IN ('HERMES', 'OPENCODE')) NOT VALID;
ALTER TABLE "ProjectChatState"
  VALIDATE CONSTRAINT "ProjectChatState_host_harness_project_check";

ALTER TABLE "ProjectChatTurn"
  ADD CONSTRAINT "ProjectChatTurn_host_harness_project_check"
  CHECK ("provider"::text NOT IN ('HERMES', 'OPENCODE')) NOT VALID;
ALTER TABLE "ProjectChatTurn"
  VALIDATE CONSTRAINT "ProjectChatTurn_host_harness_project_check";

ALTER TABLE "ProjectChatProviderBinding"
  ADD CONSTRAINT "ProjectChatProviderBinding_host_harness_project_check"
  CHECK ("provider" NOT IN ('HERMES', 'OPENCODE')) NOT VALID;
ALTER TABLE "ProjectChatProviderBinding"
  VALIDATE CONSTRAINT "ProjectChatProviderBinding_host_harness_project_check";

ALTER TABLE "ProjectChatSession"
  ADD CONSTRAINT "ProjectChatSession_host_harness_project_check"
  CHECK ("activeProvider" NOT IN ('HERMES', 'OPENCODE')) NOT VALID;
ALTER TABLE "ProjectChatSession"
  VALIDATE CONSTRAINT "ProjectChatSession_host_harness_project_check";

ALTER TABLE "ProjectChatMessage"
  ADD CONSTRAINT "ProjectChatMessage_host_harness_project_check"
  CHECK ("provider" NOT IN ('HERMES', 'OPENCODE')) NOT VALID;
ALTER TABLE "ProjectChatMessage"
  VALIDATE CONSTRAINT "ProjectChatMessage_host_harness_project_check";
