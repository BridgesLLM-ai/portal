-- Named App credentials. Additive only: two new tables, both removed with
-- their App. Values are stored as Portal authenticated ciphertext
-- (portal-secret:v1); no plaintext, hash or fingerprint of a value is kept.

-- CreateTable
CREATE TABLE "ProjectAppCredentialSet" (
    "appId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAppCredentialSet_pkey" PRIMARY KEY ("appId")
);

-- CreateTable
CREATE TABLE "ProjectAppCredential" (
    "appId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,
    "updatedByOperator" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProjectAppCredential_pkey" PRIMARY KEY ("appId","slot")
);

-- AddForeignKey
ALTER TABLE "ProjectAppCredentialSet" ADD CONSTRAINT "ProjectAppCredentialSet_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAppCredential" ADD CONSTRAINT "ProjectAppCredential_appId_fkey" FOREIGN KEY ("appId") REFERENCES "ProjectAppCredentialSet"("appId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Shape guards (Prisma's datamodel cannot express these; its drift diff ignores CHECKs).
-- 87500 characters bounds the ciphertext of a 64 KiB value.
ALTER TABLE "ProjectAppCredentialSet" ADD CONSTRAINT "ProjectAppCredentialSet_revision" CHECK ("revision" >= 0);
ALTER TABLE "ProjectAppCredential" ADD CONSTRAINT "ProjectAppCredential_shape" CHECK (
  "slot" ~ '^[a-z][a-z0-9-]{0,62}$'
  AND "revision" > 0
  AND "ciphertext" LIKE 'portal-secret:v1:%'
  AND char_length("ciphertext") <= 87500
  AND (("updatedByOperator" AND "updatedByUserId" IS NULL)
    OR (NOT "updatedByOperator" AND "updatedByUserId" IS NOT NULL))
);
