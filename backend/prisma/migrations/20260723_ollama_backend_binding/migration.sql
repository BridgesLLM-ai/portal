-- Portal-owned, identity-bound authority for the one Tailnet Ollama backend.
-- Raw URLs are intentionally absent. Replacements first create a PENDING
-- candidate while the proven authority remains usable. Promotion retires the
-- old authority atomically; stale and removed generations remain as audit
-- rows without a decryptable pairing secret.

CREATE TYPE "OllamaBackendBindingState" AS ENUM (
  'PENDING',
  'ACTIVE',
  'STALE',
  'DISCONNECTED',
  'REMOVED'
);

CREATE TYPE "OllamaBackendAddressFamily" AS ENUM (
  'IPV4',
  'IPV6'
);

CREATE TABLE "OllamaBackendBinding" (
  "id" TEXT NOT NULL,
  "purposeId" TEXT NOT NULL DEFAULT 'PRIMARY',
  "generation" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "state" "OllamaBackendBindingState" NOT NULL DEFAULT 'PENDING',
  "tailnetName" TEXT NOT NULL,
  "stableNodeId" TEXT NOT NULL,
  "nodePublicKey" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "addressFamily" "OllamaBackendAddressFamily" NOT NULL,
  "helperPort" INTEGER NOT NULL DEFAULT 11434,
  "protocolVersion" INTEGER NOT NULL,
  "helperId" TEXT NOT NULL,
  "pairingSecretCiphertext" TEXT,
  "pairingSecretDigest" TEXT NOT NULL,
  "pairingSecretFingerprint" TEXT NOT NULL,
  "bindingFingerprint" TEXT NOT NULL,
  "selectedModel" TEXT,
  "selectedModelDigest" TEXT,
  "attestationProofDigest" TEXT,
  "protocolProofDigest" TEXT,
  "configuredByUserId" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "candidateExpiresAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMP(3),

  CONSTRAINT "OllamaBackendBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OllamaBackendBinding_primary_purpose_check"
    CHECK ("purposeId" = 'PRIMARY'),
  CONSTRAINT "OllamaBackendBinding_positive_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "OllamaBackendBinding_positive_version_check"
    CHECK ("version" > 0),
  CONSTRAINT "OllamaBackendBinding_fixed_helper_port_check"
    CHECK ("helperPort" = 11434),
  CONSTRAINT "OllamaBackendBinding_protocol_version_check"
    CHECK ("protocolVersion" = 2),
  CONSTRAINT "OllamaBackendBinding_nonempty_identity_check"
    CHECK (
      length(btrim("tailnetName")) > 0
      AND length(btrim("stableNodeId")) > 0
      AND length(btrim("nodePublicKey")) > 0
      AND length(btrim("address")) > 0
      AND length(btrim("helperId")) > 0
      AND length(btrim("pairingSecretDigest")) > 0
      AND length(btrim("pairingSecretFingerprint")) > 0
      AND length(btrim("bindingFingerprint")) > 0
    ),
  CONSTRAINT "OllamaBackendBinding_identity_grammar_check"
    CHECK (
      "stableNodeId" ~ '^[A-Za-z0-9_-]{6,128}$'
      AND "nodePublicKey" ~ '^nodekey:[a-f0-9]{64}$'
      AND "nodePublicKey" <> ('nodekey:' || repeat('0', 64))
      AND "helperId" ~ '^[A-Za-z0-9_-]{16,128}$'
      AND (
        "tailnetName" ~ '^[A-Za-z0-9]$'
        OR "tailnetName" ~ '^[A-Za-z0-9][A-Za-z0-9._@+-]{0,251}[A-Za-z0-9]$'
      )
    ),
  CONSTRAINT "OllamaBackendBinding_tailnet_address_check"
    CHECK (
      btrim("address") = "address"
      AND position('/' IN "address") = 0
      AND position('%' IN "address") = 0
      AND (
        (
          "addressFamily" = 'IPV4'::"OllamaBackendAddressFamily"
          AND family("address"::inet) = 4
          AND "address"::inet << '100.64.0.0/10'::inet
        )
        OR (
          "addressFamily" = 'IPV6'::"OllamaBackendAddressFamily"
          AND family("address"::inet) = 6
          AND position('.' IN "address") = 0
          AND "address"::inet << 'fd7a:115c:a1e0::/48'::inet
        )
      )
    ),
  CONSTRAINT "OllamaBackendBinding_model_digest_pair_check"
    CHECK (
      (
        "selectedModel" IS NULL
        AND "selectedModelDigest" IS NULL
      )
      OR (
        "selectedModel" ~ '^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$'
        AND "selectedModelDigest" ~ '^sha256:[a-f0-9]{64}$'
      )
    ),
  CONSTRAINT "OllamaBackendBinding_candidate_expiry_check"
    CHECK (
      (
        "state" = 'PENDING'::"OllamaBackendBindingState"
        AND "candidateExpiresAt" IS NOT NULL
        AND "candidateExpiresAt" > "createdAt"
        AND "candidateExpiresAt" <= "createdAt" + INTERVAL '30 minutes'
      )
      OR (
        "state" <> 'PENDING'::"OllamaBackendBindingState"
        AND "candidateExpiresAt" IS NULL
      )
    ),
  CONSTRAINT "OllamaBackendBinding_removed_timestamp_check"
    CHECK (
      ("state" = 'REMOVED'::"OllamaBackendBindingState")
      = ("removedAt" IS NOT NULL)
    ),
  CONSTRAINT "OllamaBackendBinding_retired_secret_check"
    CHECK (
      (
        "state" IN (
          'PENDING'::"OllamaBackendBindingState",
          'ACTIVE'::"OllamaBackendBindingState",
          'DISCONNECTED'::"OllamaBackendBindingState"
        )
        AND "pairingSecretCiphertext" LIKE 'portal-secret:v1:%'
      )
      OR (
        "state" IN (
          'STALE'::"OllamaBackendBindingState",
          'REMOVED'::"OllamaBackendBindingState"
        )
        AND "pairingSecretCiphertext" IS NULL
      )
    ),
  CONSTRAINT "OllamaBackendBinding_secret_digest_check"
    CHECK (
      "pairingSecretDigest" LIKE 'portal-token:v1:ollama-backend-pairing:%'
      AND "pairingSecretFingerprint"
        LIKE 'portal-token:v1:ollama-backend-pairing-fingerprint:%'
      AND "bindingFingerprint" LIKE 'portal-token:v1:ollama-backend-binding:%'
    ),
  CONSTRAINT "OllamaBackendBinding_pending_proof_check"
    CHECK (
      "state" <> 'PENDING'::"OllamaBackendBindingState"
      OR (
        "attestationProofDigest" IS NULL
        AND "protocolProofDigest" IS NULL
        AND "verifiedAt" IS NULL
        AND "activatedAt" IS NULL
      )
    ),
  CONSTRAINT "OllamaBackendBinding_active_proof_check"
    CHECK (
      "state" NOT IN (
        'ACTIVE'::"OllamaBackendBindingState",
        'DISCONNECTED'::"OllamaBackendBindingState"
      )
      OR (
        "pairingSecretCiphertext" IS NOT NULL
        AND "attestationProofDigest" IS NOT NULL
        AND "protocolProofDigest" IS NOT NULL
        AND "verifiedAt" IS NOT NULL
        AND "activatedAt" IS NOT NULL
        AND "removedAt" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "OllamaBackendBinding_purpose_generation_key"
  ON "OllamaBackendBinding"("purposeId", "generation");

-- One proven authority can coexist with one not-yet-trusted candidate.
-- Promotion retires the authority and activates the candidate inside one
-- Serializable transaction.
CREATE UNIQUE INDEX "OllamaBackendBinding_one_authority_purpose_key"
  ON "OllamaBackendBinding"("purposeId")
  WHERE "state" IN (
    'ACTIVE'::"OllamaBackendBindingState",
    'DISCONNECTED'::"OllamaBackendBindingState"
  );

CREATE UNIQUE INDEX "OllamaBackendBinding_one_pending_candidate_purpose_key"
  ON "OllamaBackendBinding"("purposeId")
  WHERE "state" = 'PENDING'::"OllamaBackendBindingState";

CREATE INDEX "OllamaBackendBinding_purpose_state_idx"
  ON "OllamaBackendBinding"("purposeId", "state");
CREATE INDEX "OllamaBackendBinding_candidate_expiry_idx"
  ON "OllamaBackendBinding"("state", "candidateExpiresAt");
CREATE INDEX "OllamaBackendBinding_node_state_idx"
  ON "OllamaBackendBinding"("stableNodeId", "state");
CREATE INDEX "OllamaBackendBinding_configured_by_idx"
  ON "OllamaBackendBinding"("configuredByUserId");

ALTER TABLE "OllamaBackendBinding"
  ADD CONSTRAINT "OllamaBackendBinding_configuredByUserId_fkey"
  FOREIGN KEY ("configuredByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
