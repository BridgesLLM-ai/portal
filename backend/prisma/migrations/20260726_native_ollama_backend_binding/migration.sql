-- Additive, rollback-safe storage for native Ollama HTTP over persistent
-- Tailscale Serve TCP. The legacy "OllamaBackendBinding" table and its enum,
-- constraints, indexes, and rows are intentionally untouched.

CREATE TYPE "NativeOllamaBackendBindingState" AS ENUM (
  'ACTIVE',
  'DISCONNECTED',
  'REMOVED'
);

CREATE TABLE "NativeOllamaBackendBinding" (
  "id" TEXT NOT NULL,
  "purposeId" TEXT NOT NULL DEFAULT 'PRIMARY',
  "generation" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "state" "NativeOllamaBackendBindingState" NOT NULL DEFAULT 'ACTIVE',
  "tailnetName" TEXT NOT NULL,
  "stableNodeId" TEXT NOT NULL,
  "nodePublicKey" TEXT NOT NULL,
  "observedAddress" TEXT NOT NULL,
  "addressFamily" "OllamaBackendAddressFamily" NOT NULL,
  "servePort" INTEGER NOT NULL DEFAULT 11435,
  "bindingFingerprint" TEXT NOT NULL,
  "selectedModel" TEXT,
  "selectedModelDigest" TEXT,
  "localEnabledBeforeActivation" BOOLEAN NOT NULL,
  "localEnabledSettingExisted" BOOLEAN NOT NULL,
  "grantPeerAttestationFingerprint" TEXT NOT NULL,
  "grantTemplateHash" TEXT NOT NULL,
  "grantAcknowledgedAt" TIMESTAMP(3) NOT NULL,
  "grantAcknowledgedBy" TEXT NOT NULL,
  "legacyHelperRetirementAcknowledgedAt" TIMESTAMP(3),
  "legacyHelperRetirementAcknowledgedBy" TEXT,
  "legacyHelperRetirementEvidence" TEXT,
  "configuredByUserId" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  "activatedAt" TIMESTAMP(3) NOT NULL,
  "disconnectedAt" TIMESTAMP(3),
  "removedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NativeOllamaBackendBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NativeOllamaBackendBinding_primary_purpose_check"
    CHECK ("purposeId" = 'PRIMARY'),
  CONSTRAINT "NativeOllamaBackendBinding_positive_generation_check"
    CHECK ("generation" > 0),
  CONSTRAINT "NativeOllamaBackendBinding_positive_version_check"
    CHECK ("version" > 0),
  CONSTRAINT "NativeOllamaBackendBinding_fixed_serve_port_check"
    CHECK ("servePort" = 11435),
  CONSTRAINT "NativeOllamaBackendBinding_nonempty_identity_check"
    CHECK (
      length(btrim("tailnetName")) > 0
      AND octet_length("tailnetName") <= 253
      AND length(btrim("stableNodeId")) > 0
      AND octet_length("stableNodeId") <= 128
      AND length(btrim("nodePublicKey")) > 0
      AND length(btrim("observedAddress")) > 0
      AND length(btrim("bindingFingerprint")) > 0
      AND length(btrim("grantAcknowledgedBy")) > 0
      AND octet_length("grantAcknowledgedBy") <= 512
      AND (
        "configuredByUserId" IS NULL
        OR (
          length(btrim("configuredByUserId")) > 0
          AND octet_length("configuredByUserId") <= 512
        )
      )
    ),
  CONSTRAINT "NativeOllamaBackendBinding_identity_grammar_check"
    CHECK (
      "stableNodeId" ~ '^[A-Za-z0-9_-]{6,128}$'
      AND "nodePublicKey" ~ '^nodekey:[a-f0-9]{64}$'
      AND "nodePublicKey" <> ('nodekey:' || repeat('0', 64))
      AND (
        "tailnetName" ~ '^[A-Za-z0-9]$'
        OR "tailnetName" ~ '^[A-Za-z0-9][A-Za-z0-9._@+-]{0,251}[A-Za-z0-9]$'
      )
    ),
  CONSTRAINT "NativeOllamaBackendBinding_tailnet_address_check"
    CHECK (
      btrim("observedAddress") = "observedAddress"
      AND position('/' IN "observedAddress") = 0
      AND position('%' IN "observedAddress") = 0
      AND (
        (
          "addressFamily" = 'IPV4'::"OllamaBackendAddressFamily"
          AND family("observedAddress"::inet) = 4
          AND "observedAddress"::inet << '100.64.0.0/10'::inet
        )
        OR (
          "addressFamily" = 'IPV6'::"OllamaBackendAddressFamily"
          AND family("observedAddress"::inet) = 6
          AND position('.' IN "observedAddress") = 0
          AND "observedAddress"::inet << 'fd7a:115c:a1e0::/48'::inet
        )
      )
    ),
  CONSTRAINT "NativeOllamaBackendBinding_fingerprint_check"
    CHECK (
      "bindingFingerprint"
        ~ '^native-ollama-binding:v1:sha256:[a-f0-9]{64}$'
    ),
  CONSTRAINT "NativeOllamaBackendBinding_model_digest_pair_check"
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
  CONSTRAINT "NativeOllamaBackendBinding_grant_activation_order_check"
    CHECK (
      "grantAcknowledgedAt" <= "activatedAt"
    ),
  CONSTRAINT "NativeOllamaBackendBinding_grant_snapshot_check"
    CHECK (
      "grantPeerAttestationFingerprint" ~ '^[a-f0-9]{64}$'
      AND "grantTemplateHash" ~ '^sha256:[a-f0-9]{64}$'
    ),
  CONSTRAINT "NativeOllamaBackendBinding_legacy_retirement_check"
    CHECK (
      (
        "legacyHelperRetirementAcknowledgedAt" IS NULL
        AND "legacyHelperRetirementAcknowledgedBy" IS NULL
        AND "legacyHelperRetirementEvidence" IS NULL
      )
      OR (
        "legacyHelperRetirementAcknowledgedAt" IS NOT NULL
        AND "legacyHelperRetirementAcknowledgedAt" >= "activatedAt"
        AND "legacyHelperRetirementAcknowledgedBy" IS NOT NULL
        AND length(btrim("legacyHelperRetirementAcknowledgedBy")) > 0
        AND octet_length("legacyHelperRetirementAcknowledgedBy") <= 512
        AND "legacyHelperRetirementEvidence" IS NOT NULL
        AND "legacyHelperRetirementEvidence"
          ~ '^legacy-helper-retirement:v1:sha256:[a-f0-9]{64}$'
      )
    ),
  CONSTRAINT "NativeOllamaBackendBinding_state_timestamps_check"
    CHECK (
      (
        "state" = 'ACTIVE'::"NativeOllamaBackendBindingState"
        AND "disconnectedAt" IS NULL
        AND "removedAt" IS NULL
      )
      OR (
        "state" = 'DISCONNECTED'::"NativeOllamaBackendBindingState"
        AND "disconnectedAt" IS NOT NULL
        AND "disconnectedAt" >= "activatedAt"
        AND "removedAt" IS NULL
      )
      OR (
        "state" = 'REMOVED'::"NativeOllamaBackendBindingState"
        AND "removedAt" IS NOT NULL
        AND "removedAt" >= "activatedAt"
        AND (
          "disconnectedAt" IS NULL
          OR "removedAt" >= "disconnectedAt"
        )
      )
    )
);

CREATE UNIQUE INDEX "NativeOllamaBackendBinding_purpose_generation_key"
  ON "NativeOllamaBackendBinding"("purposeId", "generation");

-- ACTIVE and DISCONNECTED are both authority-bearing states. A replacement
-- first retires the current row and then inserts the new ACTIVE row inside one
-- Serializable transaction, so a failed insert restores the prior authority.
CREATE UNIQUE INDEX "NativeOllamaBackendBinding_one_authority_purpose_key"
  ON "NativeOllamaBackendBinding"("purposeId")
  WHERE "state" IN (
    'ACTIVE'::"NativeOllamaBackendBindingState",
    'DISCONNECTED'::"NativeOllamaBackendBindingState"
  );

CREATE INDEX "NativeOllamaBackendBinding_purpose_state_idx"
  ON "NativeOllamaBackendBinding"("purposeId", "state");
CREATE INDEX "NativeOllamaBackendBinding_node_state_idx"
  ON "NativeOllamaBackendBinding"("stableNodeId", "state");
CREATE INDEX "NativeOllamaBackendBinding_fingerprint_idx"
  ON "NativeOllamaBackendBinding"("bindingFingerprint");
CREATE INDEX "NativeOllamaBackendBinding_configured_by_idx"
  ON "NativeOllamaBackendBinding"("configuredByUserId");

ALTER TABLE "NativeOllamaBackendBinding"
  ADD CONSTRAINT "NativeOllamaBackendBinding_configuredByUserId_fkey"
  FOREIGN KEY ("configuredByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
