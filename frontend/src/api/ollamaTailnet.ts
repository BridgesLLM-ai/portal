import { z } from 'zod';
import client from './client';

const isoTimestamp = z.string().datetime({ offset: true });
const positiveInteger = z.number().int().positive();
const boundedText = (maximum = 1_024) => z.string().trim().min(1).max(maximum);
const safeCommand = boundedText(4_096)
  .refine((value) => !/[\r\n\u0000-\u001f\u007f]/u.test(value));
const modelName = boundedText(200)
  .refine((value) => /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value));
const digest = z.string()
  .trim()
  .regex(/^(?:sha256:)?[a-f0-9]{64}$/u);
const peerAttestationFingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const grantTemplateHash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const legacyHelperRetirementEvidence = z.string().regex(
  /^legacy-helper-retirement:v1:sha256:[a-f0-9]{64}$/u,
);
const stableNodeId = z.string().regex(/^[A-Za-z0-9_-]{6,128}$/u);
const nodePublicKey = z.string().regex(/^nodekey:[a-f0-9]{64}$/u);

const bindingSnapshotSchema = z.object({
  id: boundedText(128),
  purposeId: z.literal('PRIMARY'),
  generation: positiveInteger,
  version: positiveInteger,
  state: z.enum(['ACTIVE', 'DISCONNECTED', 'REMOVED']),
  tailnetName: boundedText(253),
  stableNodeId,
  nodePublicKey,
  address: boundedText(128),
  addressFamily: z.enum(['IPV4', 'IPV6']),
  servePort: z.literal(11435),
  bindingFingerprint: boundedText(512),
  selectedModel: modelName.nullable(),
  selectedModelDigest: digest.nullable(),
  displayName: boundedText(256).nullable(),
  observedAt: isoTimestamp,
  verifiedAt: isoTimestamp.nullable(),
  activatedAt: isoTimestamp.nullable(),
  grantAcknowledgedAt: isoTimestamp.nullable(),
  grantSnapshotState: z.enum([
    'CURRENT',
    'CHANGED',
    'UNAVAILABLE',
  ]).nullable().default(null),
  legacyHelperRetirementAcknowledgedAt:
    isoTimestamp.nullable().default(null),
  legacyHelperRetirementEvidence:
    legacyHelperRetirementEvidence.nullable().default(null),
  updatedAt: isoTimestamp,
  removedAt: isoTimestamp.nullable(),
});

const bindingViewSchema = z.object({
  purposeId: z.literal('PRIMARY'),
  authority: bindingSnapshotSchema.nullable(),
});

const peerSchema = z.object({
  tailnetName: boundedText(253),
  stableNodeId,
  nodePublicKey,
  address: boundedText(128),
  addressFamily: z.enum(['IPV4', 'IPV6']),
  displayName: boundedText(256).nullable().optional(),
  operatingSystem: boundedText(64).nullable().optional(),
  observedAt: isoTimestamp,
  fingerprint: peerAttestationFingerprint,
  grantTemplate: boundedText(16_384).nullable(),
  grantTemplateHash: grantTemplateHash.nullable(),
  online: z.boolean().optional(),
}).superRefine((peer, context) => {
  if ((peer.grantTemplate === null) !== (peer.grantTemplateHash === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Grant template and hash must be present together.',
    });
  }
});

const inventorySchema = z.object({
  tailnetName: boundedText(253),
  observedAt: isoTimestamp,
  peers: z.array(peerSchema).max(1_000),
});

const tailscaleSchema = z.union([
  z.object({
    available: z.literal(true),
    inventory: inventorySchema,
    error: z.null(),
  }),
  z.object({
    available: z.literal(false),
    inventory: z.null(),
    error: z.object({
      code: boundedText(128),
      message: boundedText(1_024),
    }),
  }),
]);

const setupSchema = z.object({
  servePort: z.literal(11435),
  windowsBundle: z.literal('/api/ollama/tailnet/setup-bundle.zip'),
  serveCommand: safeCommand,
  removeCommand: safeCommand,
  legacyHelperRetireCommand: z.literal(
    'Start-Here.cmd --retire-legacy-helper',
  ),
  grantTemplate: boundedText(16_384),
  grantWarning: boundedText(2_048),
});

const tailnetStatusSchema = z.object({
  binding: bindingViewSchema,
  tailscale: tailscaleSchema,
  setup: setupSchema,
  legacyRemoteAuthorityPresent: z.boolean(),
  legacyHelperRetirement: z.object({
    required: z.boolean(),
    acknowledgedAt: isoTimestamp.nullable(),
    evidence: legacyHelperRetirementEvidence.nullable(),
  }),
}).transform((status) => ({
  ...status,
  // SettingsPage's setup-handoff consumer predates the native transport.
  // Keep its non-secret completion signal derived from the only authoritative
  // fact that matters now: whether a native authority exists.
  onboarding: {
    phase: status.binding.authority ? 'COMPLETED' as const : 'REQUESTED' as const,
  },
}));
const connectInputSchema = z.object({
  stableNodeId,
  expectedGeneration: positiveInteger.nullable(),
  expectedVersion: positiveInteger.nullable(),
  expectedPeerAttestationFingerprint: peerAttestationFingerprint,
  expectedGrantTemplateHash: grantTemplateHash,
  grantAcknowledged: z.literal(true),
}).superRefine((input, context) => {
  if (
    (input.expectedGeneration === null)
    !== (input.expectedVersion === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Authority generation and version must be present together.',
    });
  }
});

const bindingResponseSchema = z.object({
  binding: bindingSnapshotSchema,
});

const diagnosticCheckSchema = z.object({
  id: boundedText(128),
  label: boundedText(256),
  state: z.enum(['pass', 'warn', 'fail']),
  detail: boundedText(1_024).nullable().optional(),
});

const verificationEvidenceSchema = z.object({
  ollamaVersion: boundedText(128).nullable().optional(),
  selectedModel: modelName.nullable().optional(),
  selectedModelDigest: digest.nullable().optional(),
  inventoryVerified: z.boolean().optional(),
  modelToolsVerified: z.boolean().optional(),
  inferenceVerified: z.boolean().optional(),
  verifiedAt: isoTimestamp,
  checks: z.array(diagnosticCheckSchema).max(64).optional(),
});

const verificationResponseSchema = z.object({
  binding: bindingSnapshotSchema,
  evidence: verificationEvidenceSchema,
});

const modelSchema = z.object({
  name: modelName,
  digest: digest.nullable().optional(),
  size: z.number().finite().nonnegative().optional(),
  sizeBytes: z.number().finite().nonnegative().optional(),
  modifiedAt: boundedText(256).nullable().optional(),
  details: z.record(z.unknown()).optional(),
});

const inventoryAuthoritySchema = z.object({
  kind: z.enum(['LOCAL', 'TAILNET']),
  generation: z.number().int().nonnegative().nullable(),
  version: z.number().int().nonnegative().nullable(),
  fingerprint: boundedText(512),
});

const modelsResponseSchema = z.object({
  source: z.enum(['local', 'tailnet', 'unavailable']),
  models: z.array(modelSchema).max(1_000),
  authority: inventoryAuthoritySchema,
});

const catalogModelSchema = z.object({
  name: modelName,
  description: boundedText(2_048),
  size: boundedText(64).optional(),
  sizeBytes: z.number().finite().nonnegative().optional(),
  minAvailableRamGb: z.number().finite().nonnegative().optional(),
  contextWindow: boundedText(64).optional(),
  useCase: z.enum(['general', 'coding', 'reasoning']).optional(),
  sourceUrl: z.string().url().startsWith('https://').optional(),
  recommended: z.boolean().optional(),
  installed: z.boolean().optional(),
  active: z.boolean().optional(),
});

const catalogResponseSchema = z.object({
  models: z.array(catalogModelSchema).max(1_000),
  warning: boundedText(2_048).nullable().optional(),
});

const pullErrorSchema = z.union([
  boundedText(1_024),
  z.object({
    code: boundedText(128).optional(),
    message: boundedText(1_024),
    retryable: z.boolean().optional(),
  }).transform((value) => value.message),
]).nullable();

const pullSnapshotSchema = z.object({
  id: boundedText(256),
  operationId: z.string().uuid(),
  model: modelName,
  state: z.enum([
    'running',
    'cancelling',
    'succeeded',
    'failed',
    'cancelled',
    'timed_out',
  ]),
  phase: boundedText(128),
  status: boundedText(512),
  digest: digest.nullable(),
  totalBytes: z.number().finite().nonnegative().nullable(),
  completedBytes: z.number().finite().nonnegative().nullable(),
  percent: z.number().finite().min(0).max(100).nullable(),
  speedBytesPerSecond: z.number().finite().nonnegative().nullable(),
  etaSeconds: z.number().finite().nonnegative().nullable(),
  eventSeq: z.number().int().nonnegative(),
  updatedAt: isoTimestamp,
  canCancel: z.boolean(),
  error: pullErrorSchema,
  authority: inventoryAuthoritySchema,
});

const pullEnvelopeSchema = z.union([
  pullSnapshotSchema,
  z.object({ pull: pullSnapshotSchema }).transform((value) => value.pull),
]);

const pullsResponseSchema = z.object({
  pulls: z.array(pullSnapshotSchema).max(100),
});
const pullExpectedAuthoritySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LOCAL'),
    generation: z.null(),
    version: z.null(),
    fingerprint: boundedText(256),
  }),
  z.object({
    kind: z.literal('TAILNET'),
    generation: positiveInteger,
    version: positiveInteger,
    fingerprint: boundedText(256),
  }),
]);
const startPullInputSchema = z.object({
  operationId: z.string().uuid(),
  model: modelName,
  expectedAuthority: pullExpectedAuthoritySchema,
});

const serverNetworkSchema = z.object({
  installed: z.boolean(),
  version: boundedText(128).nullable(),
  daemonActive: z.boolean(),
  backendState: boundedText(128).nullable(),
  running: z.boolean(),
  tailnetName: boundedText(253).nullable(),
  hostName: boundedText(256).nullable(),
  tailnetIp: boundedText(128).nullable(),
  loginUrl: z.string().url().startsWith('https://').nullable(),
});

export type OllamaTailnetBindingSnapshot = z.infer<
  typeof bindingSnapshotSchema
>;
export type OllamaTailnetBindingView = z.infer<typeof bindingViewSchema>;
export type OllamaTailnetPeer = z.infer<typeof peerSchema>;
export type OllamaTailnetStatus = z.infer<typeof tailnetStatusSchema>;
export type OllamaTailnetVerificationEvidence = z.infer<
  typeof verificationEvidenceSchema
>;
export type OllamaTailnetVerificationResponse = z.infer<
  typeof verificationResponseSchema
>;
export type OllamaTailnetModel = z.infer<typeof modelSchema>;
export type OllamaTailnetModelsResponse = z.infer<typeof modelsResponseSchema>;
export type OllamaCatalogModel = z.infer<typeof catalogModelSchema>;
export type OllamaCatalogResponse = z.infer<typeof catalogResponseSchema>;
export type OllamaPullSnapshot = z.infer<typeof pullSnapshotSchema>;
export type OllamaTailnetServerNetwork = z.infer<
  typeof serverNetworkSchema
>;

export type OllamaTailnetCas = Readonly<{
  generation: number | null;
  version: number | null;
}>;

export const OLLAMA_TAILNET_SETUP_BUNDLE =
  '/api/ollama/tailnet/setup-bundle.zip' as const;

export function ollamaTailnetCas(
  snapshot: OllamaTailnetBindingSnapshot | null,
): OllamaTailnetCas {
  return Object.freeze({
    generation: snapshot?.generation ?? null,
    version: snapshot?.version ?? null,
  });
}

export const ollamaTailnetAPI = {
  async status(): Promise<OllamaTailnetStatus> {
    const { data } = await client.get('/ollama/tailnet/status', {
      timeout: 15_000,
    });
    return tailnetStatusSchema.parse(data);
  },

  async serverNetwork(): Promise<OllamaTailnetServerNetwork> {
    const { data } = await client.get('/ollama/tailnet/server-network', {
      timeout: 20_000,
    });
    return serverNetworkSchema.parse(data);
  },

  async installServerTailscale(): Promise<OllamaTailnetServerNetwork> {
    const { data } = await client.post(
      '/ollama/tailnet/server-network/install',
      {},
      {
        timeout: 300_000,
        _skipNetworkRetry: true,
      } as any,
    );
    return serverNetworkSchema.parse(data);
  },

  async connectServerNetwork(
    input: { authKey?: string } = {},
  ): Promise<OllamaTailnetServerNetwork> {
    const { data } = await client.post(
      '/ollama/tailnet/server-network/connect',
      input.authKey ? { authKey: input.authKey } : {},
      {
        timeout: 120_000,
        _skipNetworkRetry: true,
      } as any,
    );
    return serverNetworkSchema.parse(data);
  },

  async connect(input: z.input<typeof connectInputSchema>): Promise<OllamaTailnetBindingSnapshot> {
    const request = connectInputSchema.parse(input);
    const { data } = await client.post('/ollama/tailnet/connect', request, {
      timeout: 60_000,
      _skipNetworkRetry: true,
    } as any);
    return bindingResponseSchema.parse(data).binding;
  },

  async reverifyAuthority(input: {
    generation: number;
    expectedVersion: number;
  }): Promise<OllamaTailnetBindingSnapshot> {
    const { data } = await client.post('/ollama/tailnet/reverify', input, {
      timeout: 60_000,
      _skipNetworkRetry: true,
    } as any);
    return bindingResponseSchema.parse(data).binding;
  },

  async verifyAuthority(input: {
    generation: number;
    expectedVersion: number;
  }): Promise<OllamaTailnetVerificationResponse> {
    const { data } = await client.post('/ollama/tailnet/verify', input, {
      timeout: 60_000,
    });
    return verificationResponseSchema.parse(data);
  },

  async removeAuthority(input: {
    generation: number;
    expectedVersion: number;
  }): Promise<OllamaTailnetBindingSnapshot> {
    const { data } = await client.delete('/ollama/tailnet/authority', {
      data: input,
      timeout: 30_000,
      _skipNetworkRetry: true,
    } as any);
    return bindingResponseSchema.parse(data).binding;
  },

  async models(): Promise<OllamaTailnetModelsResponse> {
    const { data } = await client.get('/ollama/models', {
      timeout: 20_000,
    });
    return modelsResponseSchema.parse(data);
  },

  async catalog(): Promise<OllamaCatalogResponse> {
    const { data } = await client.get('/ollama/catalog', {
      timeout: 20_000,
    });
    return catalogResponseSchema.parse(data);
  },

  async setActiveModel(input: {
    model: string;
    expectedDigest: string;
    generation: number;
    expectedVersion: number;
  }): Promise<OllamaTailnetBindingSnapshot> {
    const { data } = await client.put('/ollama/active-model', input, {
      // Selection includes inventory, inspection, bounded inference, and an
      // exact-digest reread under one three-minute backend deadline. Keep a
      // full minute of client margin for attestation and the final database
      // CAS so the browser cannot report failure while a valid selection is
      // still committing.
      timeout: 240_000,
      _skipNetworkRetry: true,
    } as any);
    return bindingResponseSchema.parse(data).binding;
  },

  async testModel(input: {
    generation: number;
    expectedVersion: number;
  }): Promise<OllamaTailnetVerificationResponse> {
    const { data } = await client.post('/ollama/model/test', input, {
      // Match active-model selection: the backend deliberately allows a cold
      // reasoning model up to two minutes for its bounded one-token proof.
      timeout: 150_000,
      _skipNetworkRetry: true,
    } as any);
    return verificationResponseSchema.parse(data);
  },

  async acknowledgeLegacyHelperRetirement(input: {
    generation: number;
    expectedVersion: number;
    cleanupConfirmed: true;
  }): Promise<OllamaTailnetBindingSnapshot> {
    const { data } = await client.post(
      '/ollama/tailnet/legacy-helper-retirement',
      input,
      {
        timeout: 30_000,
        _skipNetworkRetry: true,
      } as any,
    );
    return bindingResponseSchema.parse(data).binding;
  },

  async startPull(input: z.input<typeof startPullInputSchema>): Promise<OllamaPullSnapshot> {
    const request = startPullInputSchema.parse(input);
    const { data } = await client.post('/ollama/pull', request, {
      timeout: 30_000,
      _skipNetworkRetry: true,
    } as any);
    const pull = pullEnvelopeSchema.parse(data);
    if (pull.operationId !== request.operationId) {
      throw new Error('Ollama pull response did not match the requested operation');
    }
    return pull;
  },

  async pulls(): Promise<readonly OllamaPullSnapshot[]> {
    const { data } = await client.get('/ollama/pulls', {
      timeout: 15_000,
    });
    return pullsResponseSchema.parse(data).pulls;
  },

  async cancelPull(id: string): Promise<OllamaPullSnapshot> {
    const { data } = await client.delete(
      `/ollama/pull/${encodeURIComponent(id)}`,
      {
        timeout: 30_000,
        _skipNetworkRetry: true,
      } as any,
    );
    return pullEnvelopeSchema.parse(data);
  },
};

export function ollamaTailnetErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (!error || typeof error !== 'object') return fallback;
  const record = error as {
    response?: {
      data?: {
        error?: unknown;
        message?: unknown;
      };
    };
    message?: unknown;
  };
  const candidate = record.response?.data?.error
    ?? record.response?.data?.message
    ?? record.message;
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim().slice(0, 1_024)
    : fallback;
}

/**
 * Most rejected 4xx responses are definitive application outcomes when
 * mutation retries are disabled. Intermediary timeout/early/rate-limit
 * statuses (408, 425, 429, 499), network failures, proxy/server 5xx responses,
 * aborted responses, and response-contract parse failures can all occur after
 * the backend committed, so they require authoritative readback.
 */
export function ollamaTailnetHasDefinitiveHttpResponse(
  error: unknown,
): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as {
    response?: { status?: unknown };
  }).response?.status;
  const numericStatus = Number(status);
  return Number.isInteger(numericStatus)
    && numericStatus >= 400
    && numericStatus <= 499
    && ![408, 425, 429, 499].includes(numericStatus);
}
