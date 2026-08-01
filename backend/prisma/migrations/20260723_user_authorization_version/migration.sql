-- A durable authorization generation invalidates browser sessions whenever an
-- Owner changes a user's role, account state, or workspace isolation.
ALTER TABLE "User"
ADD COLUMN "authorizationVersion" INTEGER NOT NULL DEFAULT 1;
