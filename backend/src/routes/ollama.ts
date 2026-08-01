import { Router, Request, Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import fs from 'fs';
import { isIP } from 'net';
import os from 'os';
import path from 'path';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin, requireOwner } from '../middleware/requireAdmin';
import {
  TailnetServerNetworkError,
  connectServerWithAuthKey,
  installTailscaleOnServer,
  readTailnetServerNetworkStatus,
  startServerLoginFlow,
} from '../services/tailnetServerNetwork';
import {
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_RECOMMENDATION_CATALOG,
  getOllamaRecommendationsByRam,
  isValidOllamaModelName,
  readAvailableMemoryBytes,
} from '../utils/ollamaRecommendations';
import {
  OllamaPullBusyError,
  ollamaPullManager,
  type OllamaPullExpectedAuthority,
  type OllamaPullSnapshot,
} from '../services/ollamaPullManager';
import {
  OllamaBackendAuthorityError,
  requestResolvedOllama,
  requestResolvedOllamaJson,
  resolveOllamaBackendAuthority,
  type ResolvedOllamaBackendAuthority,
} from '../services/ollamaBackendAuthority';
import { readLegacyOllamaBindingPresence } from '../services/legacyOllamaBindingRead';
import {
  TailscalePeerAttestationError,
  listCurrentAttestedTailscalePeers,
  type TailscalePeerAttestation,
  type TailscalePeerInventory,
} from '../services/tailscalePeerAttestor';
import { canonicalizeLocalOllamaEndpoint } from '../utils/localOllamaEndpoint';
import {
  OllamaAuthorityBarrierBusyError,
  withOllamaAuthorityMutationFence,
} from '../services/ollamaAuthorityBarrier';
import {
  NativeOllamaBackendError,
  connectNativeOllamaBackend,
  diagnoseNativeOllamaBackend,
  exactNativeOllamaGrantForPeer,
  renderNativeOllamaGrantTemplate,
  listNativeOllamaInstalledModels,
  reverifyNativeOllamaBackend,
  selectNativeOllamaBackendModel,
  testNativeOllamaBackendModel,
  type PublicNativeOllamaInstalledModel,
  type PublicNativeOllamaPeer,
} from '../services/nativeOllamaBackend';
import {
  NATIVE_OLLAMA_SERVE_PORT,
  NativeOllamaBindingError,
  acknowledgeNativeOllamaLegacyHelperRetirement,
  readNativeOllamaBinding,
  removeNativeOllamaBinding,
  type PublicNativeOllamaBindingSnapshot,
} from '../services/nativeOllamaBinding';

const router = Router();
router.use(authenticateToken);

const MAX_OLLAMA_MODELS = 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SETUP_BUNDLE_PATH = '/api/ollama/tailnet/setup-bundle.zip';
const SERVE_COMMAND =
  'tailscale serve --bg --tcp=11435 tcp://127.0.0.1:11434';
const REMOVE_SERVE_COMMAND = 'tailscale serve --tcp=11435 off';
const LEGACY_HELPER_RETIRE_COMMAND =
  'Start-Here.cmd --retire-legacy-helper';

type OllamaModel = {
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  digest?: string;
  details?: Record<string, unknown>;
};

type ActiveOllamaInventory = {
  source: 'local' | 'tailnet';
  models: OllamaModel[];
  authority: {
    kind: 'LOCAL' | 'TAILNET';
    generation: number | null;
    version: number | null;
    fingerprint: string;
  };
  selectedModel: string | null;
};

type DisplayPeer = Pick<
  TailscalePeerAttestation | PublicNativeOllamaPeer,
  'tailnetName' | 'stableNodeId' | 'nodePublicKey' | 'displayName'
>;

type GrantSnapshotState = 'CURRENT' | 'CHANGED' | 'UNAVAILABLE';

const SETUP_BUNDLE_FILES = Object.freeze({
  'Start-Here.cmd': path.resolve(
    __dirname,
    '../../../installer/Start-Here.cmd',
  ),
  'Setup-OllamaTailnet.ps1': path.resolve(
    __dirname,
    '../../../installer/Setup-OllamaTailnet.ps1',
  ),
  'README.txt': path.resolve(
    __dirname,
    '../../../installer/ollama-tailnet-README.txt',
  ),
});

class OllamaRouteInputError extends Error {
  readonly code = 'REQUEST_INVALID';
  readonly httpStatus = 400;

  constructor() {
    super('The native Remote GPU request is invalid.');
    this.name = 'OllamaRouteInputError';
  }
}

export function normalizeOllamaEndpoint(input?: string | null): string {
  return canonicalizeLocalOllamaEndpoint(input);
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
}

function bodyRecord(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value <= 0
  ) {
    throw new OllamaRouteInputError();
  }
  return value;
}

function nullablePositiveInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value);
}

function exactNullableCas(
  body: Record<string, unknown>,
  generationKey: string,
  versionKey: string,
): { generation: number | null; version: number | null } {
  const generation = nullablePositiveInteger(body[generationKey]);
  const version = nullablePositiveInteger(body[versionKey]);
  if ((generation === null) !== (version === null)) {
    throw new OllamaRouteInputError();
  }
  return { generation, version };
}

function exactCas(body: Record<string, unknown>): {
  generation: number;
  expectedVersion: number;
} {
  return {
    generation: positiveInteger(body.generation),
    expectedVersion: positiveInteger(body.expectedVersion),
  };
}

function exactStableNodeId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9_-]{6,128}$/u.test(value)
  ) {
    throw new OllamaRouteInputError();
  }
  return value;
}

function exactPeerAttestationFingerprint(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value)
  ) {
    throw new OllamaRouteInputError();
  }
  return value;
}

function exactGrantTemplateHash(value: unknown): `sha256:${string}` {
  if (
    typeof value !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(value)
  ) {
    throw new OllamaRouteInputError();
  }
  return value as `sha256:${string}`;
}

function exactModelName(value: unknown): string {
  if (!isValidOllamaModelName(value)) throw new OllamaRouteInputError();
  return value;
}

function exactDigest(value: unknown): `sha256:${string}` {
  if (
    typeof value !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(value)
  ) {
    throw new OllamaRouteInputError();
  }
  return value as `sha256:${string}`;
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function safelyMatchedDisplayName(
  binding: PublicNativeOllamaBindingSnapshot,
  peers: readonly DisplayPeer[],
): string | null {
  const matches = peers.filter((peer) => (
    peer.tailnetName === binding.tailnetName
    && peer.stableNodeId === binding.stableNodeId
    && peer.nodePublicKey === binding.nodePublicKey
  ));
  return matches.length === 1 ? matches[0].displayName ?? null : null;
}

function publicNativeBinding(
  binding: PublicNativeOllamaBindingSnapshot,
  peers: readonly DisplayPeer[] = [],
  grantSnapshotState: GrantSnapshotState | null = null,
) {
  return {
    id: binding.id,
    purposeId: binding.purposeId,
    generation: binding.generation,
    version: binding.version,
    state: binding.state,
    tailnetName: binding.tailnetName,
    stableNodeId: binding.stableNodeId,
    nodePublicKey: binding.nodePublicKey,
    address: binding.observedAddress,
    addressFamily: binding.addressFamily,
    servePort: binding.servePort,
    bindingFingerprint: binding.bindingFingerprint,
    selectedModel: binding.selectedModel,
    selectedModelDigest: binding.selectedModelDigest,
    displayName: safelyMatchedDisplayName(binding, peers),
    observedAt: isoDate(binding.observedAt),
    verifiedAt: isoDate(binding.verifiedAt),
    activatedAt: isoDate(binding.activatedAt),
    grantAcknowledgedAt: isoDate(binding.grantAcknowledgedAt),
    grantSnapshotState,
    legacyHelperRetirementAcknowledgedAt: isoDate(
      binding.legacyHelperRetirementAcknowledgedAt,
    ),
    legacyHelperRetirementEvidence:
      binding.legacyHelperRetirementEvidence,
    updatedAt: isoDate(binding.updatedAt),
    removedAt: isoDate(binding.removedAt),
  };
}

function currentGrantSnapshotState(
  binding: PublicNativeOllamaBindingSnapshot,
  peers: readonly TailscalePeerAttestation[],
  portalAddress: string | null,
): GrantSnapshotState {
  if (portalAddress === null) return 'UNAVAILABLE';
  const stableMatches = peers.filter((peer) => (
    peer.tailnetName === binding.tailnetName
    && peer.stableNodeId === binding.stableNodeId
  ));
  const exactMatches = stableMatches.filter(
    (peer) => peer.nodePublicKey === binding.nodePublicKey,
  );
  if (exactMatches.length !== 1) {
    return stableMatches.length > 0 ? 'CHANGED' : 'UNAVAILABLE';
  }
  const [peer] = exactMatches;
  const grant = exactNativeOllamaGrantForPeer(
    portalAddress,
    peer.address,
  );
  if (!grant) return 'UNAVAILABLE';
  return (
    peer.fingerprint === binding.grantPeerAttestationFingerprint
    && grant.templateHash === binding.grantTemplateHash
  )
    ? 'CURRENT'
    : 'CHANGED';
}

function publicAuthority(resolved: ResolvedOllamaBackendAuthority) {
  const { authority } = resolved;
  return {
    kind: authority.kind,
    generation: authority.generation,
    version: authority.version,
    fingerprint: authority.bindingFingerprint,
  };
}

function publicAuthorityFromBinding(
  binding: PublicNativeOllamaBindingSnapshot,
) {
  return {
    kind: 'TAILNET' as const,
    generation: binding.generation,
    version: binding.version,
    fingerprint: binding.bindingFingerprint,
  };
}

function normalizeLocalModelRows(input: unknown): OllamaModel[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_OLLAMA_MODELS).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name : '';
    if (!isValidOllamaModelName(name)) return [];
    const size = row.size;
    const modifiedAt = row.modified_at;
    const digest = row.digest;
    const details = row.details;
    return [{
      name,
      ...(typeof size === 'number' && Number.isFinite(size) && size >= 0
        ? { sizeBytes: size }
        : {}),
      ...(typeof modifiedAt === 'string'
        ? { modifiedAt: modifiedAt.slice(0, 120) }
        : {}),
      ...(typeof digest === 'string'
        ? { digest: digest.slice(0, 256) }
        : {}),
      ...(details && typeof details === 'object' && !Array.isArray(details)
        ? { details: details as Record<string, unknown> }
        : {}),
    }];
  });
}

function nativeModels(
  models: readonly PublicNativeOllamaInstalledModel[],
): OllamaModel[] {
  return models.slice(0, MAX_OLLAMA_MODELS).map((model) => ({
    name: model.name,
    digest: model.digest,
    ...(model.sizeBytes === null ? {} : { sizeBytes: model.sizeBytes }),
    ...(model.modifiedAt === null ? {} : { modifiedAt: model.modifiedAt }),
  }));
}

async function readActiveInventory(): Promise<ActiveOllamaInventory> {
  const resolved = await resolveOllamaBackendAuthority();
  if (
    resolved.authority.kind === 'TAILNET'
    && resolved.bindingView.authority
  ) {
    const inventory = await listNativeOllamaInstalledModels({
      generation: resolved.authority.generation,
      expectedVersion: resolved.authority.version,
    });
    return {
      source: 'tailnet',
      models: nativeModels(inventory.models),
      authority: publicAuthorityFromBinding(inventory.binding),
      selectedModel: inventory.binding.selectedModel,
    };
  }

  const { value } = await requestResolvedOllamaJson<{
    models?: unknown;
  }>(resolved, {
    path: '/api/tags',
    method: 'GET',
    timeoutMs: 5_000,
    maxResponseBytes: 2 * 1024 * 1024,
  });
  return {
    source: resolved.authority.kind === 'TAILNET' ? 'tailnet' : 'local',
    models: normalizeLocalModelRows(value?.models),
    authority: publicAuthority(resolved),
    selectedModel: resolved.authority.selectedModel,
  };
}

function sendOperationError(
  res: Response,
  error: unknown,
  fallbackCode = 'OLLAMA_OPERATION_FAILED',
  fallbackMessage = 'The Ollama operation failed.',
): void {
  noStore(res);
  if (
    error instanceof NativeOllamaBackendError
    || error instanceof OllamaBackendAuthorityError
  ) {
    res.status(error.statusCode).json({
      code: error.code,
      error: error.message,
    });
    return;
  }
  if (
    error instanceof NativeOllamaBindingError
    || error instanceof OllamaAuthorityBarrierBusyError
    || error instanceof OllamaRouteInputError
  ) {
    res.status(error.httpStatus).json({
      code: error.code,
      error: error.message,
    });
    return;
  }
  if (error instanceof TailscalePeerAttestationError) {
    res.status(503).json({
      code: error.code,
      error: error.message,
    });
    return;
  }
  res.status(500).json({
    code: fallbackCode,
    error: fallbackMessage,
  });
}

function sendServerNetworkError(res: Response, error: unknown): void {
  noStore(res);
  if (error instanceof TailnetServerNetworkError) {
    res.status(error.statusCode).json({
      code: error.code,
      error: error.message,
    });
    return;
  }
  res.status(500).json({
    code: 'SERVER_NETWORK_FAILED',
    error: 'The server network operation failed.',
  });
}

router.get('/models', requireOwner, async (_req: Request, res: Response) => {
  noStore(res);
  try {
    const inventory = await readActiveInventory();
    res.json({
      source: inventory.source,
      models: inventory.models,
      authority: inventory.authority,
    });
  } catch (error) {
    sendOperationError(
      res,
      error,
      'OLLAMA_MODELS_FAILED',
      'Failed to list Ollama models.',
    );
  }
});

router.get('/catalog', requireOwner, async (_req: Request, res: Response) => {
  noStore(res);
  const inventory = await readActiveInventory().catch(() => null);
  const installed = new Set(
    inventory?.models.map((model) => model.name) ?? [],
  );
  res.json({
    models: OLLAMA_RECOMMENDATION_CATALOG.map((model) => ({
      ...model,
      recommended: true,
      installed: installed.has(model.name),
      active: inventory?.selectedModel === model.name,
    })),
    warning:
      'Remote hardware fit is curated guidance only. Portal cannot verify the GPU VRAM or runtime headroom, and Tailscale connectivity does not prove a model will fit.',
  });
});

router.get('/status', requireOwner, async (_req: Request, res: Response) => {
  noStore(res);
  try {
    const resolved = await resolveOllamaBackendAuthority();
    const source = resolved.authority.kind === 'TAILNET'
      ? 'tailnet'
      : 'local';
    const response = await requestResolvedOllama(resolved, {
      path: '/api/tags',
      method: 'GET',
      timeoutMs: 3_000,
      maxResponseBytes: 2 * 1024 * 1024,
    });
    const status = response.statusCode;
    response.body.fill(0);
    res.json({
      running: true,
      activeSource: source,
      activeEndpoint: null,
      checks: [{
        source,
        endpoint: null,
        reachable: true,
        status,
      }],
      authority: publicAuthority(resolved),
      remoteConfigurationSupported: false,
      nativeTailnetSupported: true,
    });
  } catch (error) {
    if (error instanceof OllamaBackendAuthorityError) {
      res.status(error.statusCode).json({
        running: false,
        code: error.code,
        error: error.message,
      });
      return;
    }
    res.status(500).json({
      running: false,
      code: 'OLLAMA_STATUS_FAILED',
      error: 'Failed to read Ollama status.',
    });
  }
});

router.post(
  '/test-connection',
  requireAdmin,
  async (_req: Request, res: Response) => {
    noStore(res);
    res.status(410).json({
      reachable: false,
      code: 'REMOTE_OLLAMA_URLS_DISABLED',
      error:
        'Raw remote Ollama URLs are disabled. Use the identity-bound Tailnet connection workflow.',
    });
  },
);

// Server-side Tailnet membership remains the guided path for installing
// Tailscale on the Portal and signing it into the operator's Tailnet.
router.get(
  '/tailnet/server-network',
  requireOwner,
  async (_req: Request, res: Response) => {
    noStore(res);
    try {
      res.json(await readTailnetServerNetworkStatus());
    } catch (error) {
      sendServerNetworkError(res, error);
    }
  },
);

router.post(
  '/tailnet/server-network/install',
  requireOwner,
  async (_req: Request, res: Response) => {
    noStore(res);
    try {
      res.json(await installTailscaleOnServer());
    } catch (error) {
      sendServerNetworkError(res, error);
    }
  },
);

router.post(
  '/tailnet/server-network/connect',
  requireOwner,
  async (req: Request, res: Response) => {
    noStore(res);
    const body = bodyRecord(req);
    try {
      const status = typeof body.authKey === 'string' && body.authKey.trim()
        ? await connectServerWithAuthKey({
          authKey: body.authKey,
          hostname: body.hostname,
        })
        : await startServerLoginFlow({ hostname: body.hostname });
      res.json(status);
    } catch (error) {
      sendServerNetworkError(res, error);
    } finally {
      if (Object.prototype.hasOwnProperty.call(body, 'authKey')) {
        body.authKey = '';
      }
    }
  },
);

function publicInventory(
  inventory: TailscalePeerInventory,
  portalAddress: string | null,
) {
  return {
    tailnetName: inventory.tailnetName,
    observedAt: inventory.observedAt,
    peers: inventory.peers.map((peer) => {
      const grant = exactNativeOllamaGrantForPeer(
        portalAddress,
        peer.address,
      );
      return {
        tailnetName: peer.tailnetName,
        stableNodeId: peer.stableNodeId,
        nodePublicKey: peer.nodePublicKey,
        address: peer.address,
        addressFamily: peer.addressFamily,
        displayName: peer.displayName ?? null,
        operatingSystem: peer.operatingSystem ?? null,
        observedAt: peer.observedAt,
        fingerprint: peer.fingerprint,
        grantTemplate: grant?.template ?? null,
        grantTemplateHash: grant?.templateHash ?? null,
        online: true,
      };
    }),
  };
}

router.get(
  '/tailnet/status',
  requireOwner,
  async (_req: Request, res: Response) => {
    noStore(res);
    try {
      const inventoryPromise = listCurrentAttestedTailscalePeers()
        .then((inventory) => ({
          available: true as const,
          inventory,
          error: null,
        }))
        .catch((error: unknown) => ({
          available: false as const,
          inventory: null,
          error: error instanceof TailscalePeerAttestationError
            ? {
              code: error.code,
              message: error.message,
            }
            : {
              code: 'TAILSCALE_UNAVAILABLE',
              message: 'The current Tailnet inventory is unavailable.',
            },
        }));
      const [
        bindingView,
        legacyView,
        tailscale,
        serverNetwork,
      ] = await Promise.all([
        readNativeOllamaBinding(),
        readLegacyOllamaBindingPresence(),
        inventoryPromise,
        readTailnetServerNetworkStatus().catch(() => null),
      ]);
      const inventoryPeers = tailscale.available
        ? tailscale.inventory.peers
        : [];
      const portalAddress = (
        serverNetwork?.running
        && typeof serverNetwork.tailnetIp === 'string'
        && isIP(serverNetwork.tailnetIp) !== 0
      )
        ? serverNetwork.tailnetIp
        : null;
      const authority = bindingView.authority;
      const grantSnapshotState = authority
        ? currentGrantSnapshotState(
          authority,
          inventoryPeers,
          portalAddress,
        )
        : null;
      const legacyRowsPresent = Boolean(
        legacyView.hasAuthority || legacyView.hasCandidate,
      );
      const legacyRetirementAcknowledgedAt =
        authority?.legacyHelperRetirementAcknowledgedAt ?? null;

      res.json({
        binding: {
          purposeId: bindingView.purposeId,
          authority: authority
            ? publicNativeBinding(
              authority,
              inventoryPeers,
              grantSnapshotState,
            )
            : null,
        },
        tailscale: tailscale.available
          ? {
            available: true,
            inventory: publicInventory(tailscale.inventory, portalAddress),
            error: null,
          }
          : tailscale,
        setup: {
          servePort: NATIVE_OLLAMA_SERVE_PORT,
          windowsBundle: SETUP_BUNDLE_PATH,
          serveCommand: SERVE_COMMAND,
          removeCommand: REMOVE_SERVE_COMMAND,
          legacyHelperRetireCommand: LEGACY_HELPER_RETIRE_COMMAND,
          grantTemplate: renderNativeOllamaGrantTemplate(portalAddress),
          grantWarning:
            'This is a narrow Portal-IP to selected GPU-IP rule for tcp:11435. Your acknowledgement records your confirmation; Portal does not verify the policy. Tailscale Grants and ACLs are additive, so any broader existing rules remain effective.',
        },
        legacyRemoteAuthorityPresent: legacyRowsPresent,
        legacyHelperRetirement: {
          required: Boolean(
            legacyRowsPresent
            && authority?.state === 'ACTIVE'
            && legacyRetirementAcknowledgedAt === null
          ),
          acknowledgedAt: isoDate(legacyRetirementAcknowledgedAt),
          evidence: authority?.legacyHelperRetirementEvidence ?? null,
        },
      });
    } catch (error) {
      sendOperationError(
        res,
        error,
        'OLLAMA_TAILNET_STATUS_FAILED',
        'The native Remote GPU status could not be read.',
      );
    }
  },
);

router.post(
  '/tailnet/legacy-helper-retirement',
  requireOwner,
  async (req: Request, res: Response) => {
    noStore(res);
    const body = bodyRecord(req);
    try {
      if (body.cleanupConfirmed !== true) {
        throw new OllamaRouteInputError();
      }
      const cas = exactCas(body);
      const binding = await withOllamaAuthorityMutationFence(async () => {
        const legacy = await readLegacyOllamaBindingPresence();
        if (!legacy.hasAuthority && !legacy.hasCandidate) {
          throw new NativeOllamaBindingError(
            'STATE_CONFLICT',
            'No rollback-safe legacy Remote GPU row requires retirement acknowledgement',
          );
        }
        return acknowledgeNativeOllamaLegacyHelperRetirement({
          ...cas,
          acknowledgedBy: req.user!.userId,
        });
      });
      res.json({ binding: publicNativeBinding(binding) });
    } catch (error) {
      sendOperationError(
        res,
        error,
        'OLLAMA_LEGACY_RETIREMENT_ACKNOWLEDGEMENT_FAILED',
        'Legacy helper retirement could not be recorded.',
      );
    }
  },
);

function setupFileAvailable(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

router.get(
  '/tailnet/setup-bundle.zip',
  requireOwner,
  (_req: Request, res: Response) => {
    noStore(res);
    if (!Object.values(SETUP_BUNDLE_FILES).every(setupFileAvailable)) {
      res.status(500).json({
        code: 'SETUP_BUNDLE_UNAVAILABLE',
        error: 'The Remote GPU setup bundle is temporarily unavailable.',
      });
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="bridgesllm-remote-gpu-setup.zip"',
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 9 } });
    const abortArchive = () => {
      if (!res.writableEnded) archive.abort();
    };
    res.once('close', abortArchive);
    archive.on('error', (error: Error) => {
      console.error('[ollama-tailnet] setup bundle archive error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          code: 'SETUP_BUNDLE_FAILED',
          error: 'The Remote GPU setup bundle could not be built.',
        });
      } else {
        res.destroy(error);
      }
    });
    archive.pipe(res);
    for (const [name, filePath] of Object.entries(SETUP_BUNDLE_FILES)) {
      archive.file(filePath, { name });
    }
    void archive.finalize();
  },
);

function connectionEvidence(
  binding: PublicNativeOllamaBindingSnapshot,
  probe: {
    ollamaVersion: string;
    verifiedAt: string;
  },
) {
  return {
    ollamaVersion: probe.ollamaVersion,
    selectedModel: binding.selectedModel,
    selectedModelDigest: binding.selectedModelDigest,
    inventoryVerified: true,
    verifiedAt: probe.verifiedAt,
    checks: [{
      id: 'identity',
      label: 'Stable Tailnet identity',
      state: 'pass',
      detail: 'The exact stable node ID and node public key matched.',
    }, {
      id: 'ollama',
      label: 'Native Ollama Serve route',
      state: 'pass',
      detail: 'Ollama version and installed-model inventory answered on tcp:11435.',
    }],
  };
}

router.post(
  '/tailnet/connect',
  requireOwner,
  async (req: Request, res: Response) => {
    noStore(res);
    const body = bodyRecord(req);
    try {
      const expected = exactNullableCas(
        body,
        'expectedGeneration',
        'expectedVersion',
      );
      if (body.grantAcknowledged !== true) {
        throw new OllamaRouteInputError();
      }
      const result = await connectNativeOllamaBackend({
        stableNodeId: exactStableNodeId(body.stableNodeId),
        expectedAuthorityGeneration: expected.generation,
        expectedAuthorityVersion: expected.version,
        expectedPeerAttestationFingerprint:
          exactPeerAttestationFingerprint(
            body.expectedPeerAttestationFingerprint,
          ),
        expectedGrantTemplateHash:
          exactGrantTemplateHash(body.expectedGrantTemplateHash),
        grantAcknowledged: true,
        configuredByUserId: req.user!.userId,
      });
      res.status(201).json({
        binding: publicNativeBinding(result.binding, [result.probe.peer]),
        evidence: connectionEvidence(result.binding, result.probe),
      });
    } catch (error) {
      sendOperationError(
        res,
        error,
        'OLLAMA_CONNECT_FAILED',
        'The native Remote GPU could not be connected.',
      );
    }
  },
);

router.post(
  '/tailnet/reverify',
  requireOwner,
  async (req: Request, res: Response) => {
    noStore(res);
    try {
      const cas = exactCas(bodyRecord(req));
      const result = await reverifyNativeOllamaBackend(cas);
      res.json({
        binding: publicNativeBinding(result.binding, [result.probe.peer]),
        evidence: connectionEvidence(result.binding, result.probe),
      });
    } catch (error) {
      sendOperationError(
        res,
        error,
        'OLLAMA_REVERIFY_FAILED',
        'The native Remote GPU could not be reverified.',
      );
    }
  },
);

router.post(
  '/tailnet/verify',
  requireOwner,
  async (req: Request, res: Response) => {
    noStore(res);
    try {
      const diagnostic = await diagnoseNativeOllamaBackend(
        exactCas(bodyRecord(req)),
      );
      res.json({
        binding: publicNativeBinding(
          diagnostic.binding,
          [diagnostic.peer],
        ),
        evidence: {
          selectedModel: diagnostic.binding.selectedModel,
          selectedModelDigest: diagnostic.binding.selectedModelDigest,
          verifiedAt: diagnostic.peer.observedAt,
          checks: [{
            id: 'identity',
            label: 'Stable Tailnet identity',
            state: 'pass',
            detail: 'The exact stable node ID and node public key matched.',
          }, {
            id: 'runtime',
            label: 'Native Ollama Serve route',
            state: 'pass',
            detail:
              `Ollama answered the bounded runtime diagnostic with ${diagnostic.runningModels.length} loaded model(s).`,
          }],
        },
      });
    } catch (error) {
      sendOperationError(
        res,
        error,
        'OLLAMA_VERIFY_FAILED',
        'The native Remote GPU verification failed.',
      );
    }
  },
);

router.delete(
  '/tailnet/authority',
  requireOwner,
  async (req: Request, res: Response) => {
    noStore(res);
    try {
      const cas = exactCas(bodyRecord(req));
      const binding = await withOllamaAuthorityMutationFence(
        () => removeNativeOllamaBinding(cas),
      );
      res.json({ binding: publicNativeBinding(binding) });
    } catch (error) {
      sendOperationError(
        res,
        error,
        'OLLAMA_REMOVE_FAILED',
        'The native Remote GPU authority could not be removed.',
      );
    }
  },
);

router.put(
  '/active-model',
  requireOwner,
  async (req: Request, res: Response) => {
    noStore(res);
    const body = bodyRecord(req);
    try {
      const selection = await selectNativeOllamaBackendModel({
        ...exactCas(body),
        model: exactModelName(body.model),
        expectedDigest: exactDigest(body.expectedDigest),
      });
      res.json({
        binding: publicNativeBinding(selection.binding),
      });
    } catch (error) {
      sendOperationError(
        res,
        error,
        'OLLAMA_MODEL_SELECTION_FAILED',
        'The active Remote GPU model could not be changed.',
      );
    }
  },
);

router.post(
  '/model/test',
  requireOwner,
  async (req: Request, res: Response) => {
    noStore(res);
    try {
      const cas = exactCas(bodyRecord(req));
      const view = await readNativeOllamaBinding();
      if (
        !view.authority
        || view.authority.generation !== cas.generation
        || view.authority.version !== cas.expectedVersion
      ) {
        throw new NativeOllamaBackendError('AUTHORITY_CHANGED', 409);
      }
      const binding = view.authority;
      const test = await testNativeOllamaBackendModel(cas);
      res.json({
        binding: publicNativeBinding(binding),
        evidence: {
          selectedModel: test.model,
          selectedModelDigest: test.digest,
          inferenceVerified: true,
          verifiedAt: new Date().toISOString(),
          checks: [{
            id: 'inference',
            label: 'Bounded one-token inference',
            state: 'pass',
            detail: 'The exact selected model digest completed a one-token test.',
          }],
        },
      });
    } catch (error) {
      sendOperationError(
        res,
        error,
        'OLLAMA_MODEL_TEST_FAILED',
        'The active Remote GPU model test failed.',
      );
    }
  },
);

function pullFinished(job: OllamaPullSnapshot): boolean {
  return job.state !== 'running' && job.state !== 'cancelling';
}

function emitPullSnapshot(
  namespace: ReturnType<SocketIOServer['of']> | undefined,
  job: OllamaPullSnapshot,
): void {
  namespace?.to(job.room).emit('output', {
    toolId: 'ollama',
    jobId: job.id,
    room: job.room,
    model: job.model,
    pull: job,
    entry: {
      type: 'output',
      text: `${job.status}\n`,
      stream: job.state === 'failed' || job.state === 'timed_out'
        ? 'stderr'
        : 'stdout',
      timestamp: job.updatedAt,
    },
    done: pullFinished(job),
    state: job.state,
  });
}

router.post('/pull', requireOwner, async (req: Request, res: Response) => {
  noStore(res);
  const modelName = String(req.body?.model || '').trim();
  const operationId = req.body?.operationId;
  const expectedValue = req.body?.expectedAuthority;
  if (
    !isValidOllamaModelName(modelName)
    || typeof operationId !== 'string'
    || !UUID_PATTERN.test(operationId)
    || !expectedValue
    || typeof expectedValue !== 'object'
    || Array.isArray(expectedValue)
  ) {
    res.status(400).json({
      code: 'REQUEST_INVALID',
      error: 'operationId, model, and expectedAuthority must identify this pull and the current Ollama backend',
    });
    return;
  }
  const expectedAuthority: OllamaPullExpectedAuthority = {
    kind: expectedValue.kind,
    generation: expectedValue.generation,
    version: expectedValue.version,
    fingerprint: expectedValue.fingerprint,
  };

  const io = req.app.get('io') as SocketIOServer | undefined;
  const namespace = io?.of('/ws/agent-jobs');
  try {
    const job = await ollamaPullManager.startBound(
      modelName,
      expectedAuthority,
      operationId,
      {
        onProgress: (snapshot) => emitPullSnapshot(namespace, snapshot),
        onDone: (snapshot) => emitPullSnapshot(namespace, snapshot),
      },
    );
    res.status(202).json({
      accepted: true,
      ...job,
      message: `Started pull for ${modelName}`,
    });
  } catch (error) {
    if (error instanceof OllamaPullBusyError) {
      res.status(409).json({
        code: 'OLLAMA_PULL_BUSY',
        error: error.message,
        activePulls: ollamaPullManager.list().filter(
          (job) => job.state === 'running' || job.state === 'cancelling',
        ),
      });
      return;
    }
    if (error instanceof OllamaBackendAuthorityError) {
      res.status(error.statusCode).json(error.toJSON());
      return;
    }
    res.status(500).json({
      code: 'OLLAMA_PULL_FAILED',
      error: 'Failed to start Ollama model pull',
    });
  }
});

router.get('/pulls', requireOwner, (_req: Request, res: Response) => {
  noStore(res);
  res.json({ pulls: ollamaPullManager.list() });
});

router.get('/pull/:jobId', requireOwner, (req: Request, res: Response) => {
  noStore(res);
  const job = ollamaPullManager.get(req.params.jobId);
  if (!job) {
    res.status(404).json({
      code: 'OLLAMA_PULL_NOT_FOUND',
      error: 'Ollama pull not found',
    });
    return;
  }
  res.json(job);
});

router.delete('/pull/:jobId', requireOwner, (req: Request, res: Response) => {
  noStore(res);
  const job = ollamaPullManager.cancel(req.params.jobId);
  if (!job) {
    res.status(404).json({
      code: 'OLLAMA_PULL_NOT_FOUND',
      error: 'Ollama pull not found',
    });
    return;
  }
  res.json(job);
});

router.get('/recommendations', async (_req: Request, res: Response) => {
  try {
    const totalBytes = os.totalmem();
    const availableBytes = readAvailableMemoryBytes(totalBytes);
    const recommendation = getOllamaRecommendationsByRam(
      totalBytes,
      availableBytes,
    );
    res.json({
      ramBytes: totalBytes,
      ramGb: Math.round((totalBytes / (1024 ** 3)) * 10) / 10,
      availableRamBytes: availableBytes,
      defaultModel: DEFAULT_OLLAMA_MODEL,
      ...recommendation,
    });
  } catch (error: any) {
    res.status(500).json({
      error: error?.message || 'Failed to compute recommendations',
    });
  }
});

export default router;
