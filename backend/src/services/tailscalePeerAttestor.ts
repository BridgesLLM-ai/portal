import { execFile, type ExecFileOptionsWithStringEncoding } from 'child_process';
import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { isIP } from 'net';
import { promisify } from 'util';

export const TAILSCALE_STATUS_TIMEOUT_MS = 5_000 as const;
export const TAILSCALE_STATUS_MAX_BUFFER_BYTES = 1024 * 1024;
export const TAILSCALE_STATUS_MAX_PEERS = 1_024;

export const TAILSCALE_BINARY_ALLOWLIST = Object.freeze([
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
] as const);

const TAILSCALE_STATUS_ARGS = Object.freeze(['status', '--json'] as const);
const TAILSCALE_STATUS_MAX_NODE_ADDRESSES = 8;
const TAILSCALE_STATUS_MAX_TOP_LEVEL_FIELDS = 64;
const TAILSCALE_STATUS_MAX_TAILNET_FIELDS = 16;
const TAILSCALE_STATUS_MAX_NODE_FIELDS = 96;
const MAX_TAILNET_NAME_BYTES = 253;
const MAX_STABLE_NODE_ID_BYTES = 128;
const MAX_ADDRESS_BYTES = 64;
const MAX_EXPIRY_BYTES = 64;
const MAX_DISPLAY_NAME_BYTES = 128;
const MAX_DNS_NAME_BYTES = 253;
const MAX_DNS_LABEL_BYTES = 63;
const MAX_OPERATING_SYSTEM_BYTES = 64;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const ZERO_KEY_EXPIRY = '0001-01-01T00:00:00Z';
const ATTESTATION_FINGERPRINT_DOMAIN = 'bridgesllm/tailscale-peer-attestation/v1';

const SAFE_TAILSCALE_ENV = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
} satisfies NodeJS.ProcessEnv);

export type TailscaleAddressFamily = 'IPV4' | 'IPV6';

export type TailscalePeerAttestationErrorCode =
  | 'REQUEST_INVALID'
  | 'TAILSCALE_NOT_INSTALLED'
  | 'STATUS_COMMAND_TIMEOUT'
  | 'STATUS_COMMAND_FAILED'
  | 'STATUS_TOO_LARGE'
  | 'STATUS_MALFORMED'
  | 'BACKEND_NOT_RUNNING'
  | 'TAILNET_MISMATCH'
  | 'SELF_IDENTITY_INVALID'
  | 'PEER_IDENTITY_INVALID'
  | 'PEER_ADDRESS_INVALID'
  | 'PEER_ADDRESS_AMBIGUOUS'
  | 'PEER_COLLISION'
  | 'CLOCK_INVALID';

const ERROR_MESSAGES: Readonly<Record<TailscalePeerAttestationErrorCode, string>> = Object.freeze({
  REQUEST_INVALID: 'The Tailscale attestation request is invalid.',
  TAILSCALE_NOT_INSTALLED: 'Tailscale is not installed on the Portal server. Install Tailscale on the server, sign it into the same tailnet as your GPU machine, then retry.',
  STATUS_COMMAND_TIMEOUT: 'The bounded Tailscale status probe timed out.',
  STATUS_COMMAND_FAILED: 'The bounded Tailscale status probe failed.',
  STATUS_TOO_LARGE: 'The Tailscale status response exceeded its fixed limit.',
  STATUS_MALFORMED: 'The Tailscale status response is malformed.',
  BACKEND_NOT_RUNNING: 'The Portal server\'s Tailscale backend is not running or not signed in. On the server, start Tailscale ("tailscale up") and sign it into the same tailnet as your GPU machine, then retry.',
  TAILNET_MISMATCH: 'The Portal server and selected GPU machine are signed into different tailnets. Sign both machines into the same tailnet, refresh the peer inventory, and try again.',
  SELF_IDENTITY_INVALID: 'The local Tailscale node identity is not attestable.',
  PEER_IDENTITY_INVALID: 'A Tailscale peer identity is malformed.',
  PEER_ADDRESS_INVALID: 'A Tailscale peer reported an invalid address.',
  PEER_ADDRESS_AMBIGUOUS: 'A Tailscale peer reported ambiguous addresses.',
  PEER_COLLISION: 'The Tailscale status contains an identity collision.',
  CLOCK_INVALID: 'The Tailscale attestation clock is invalid.',
});

export class TailscalePeerAttestationError extends Error {
  readonly code: TailscalePeerAttestationErrorCode;

  constructor(code: TailscalePeerAttestationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TailscalePeerAttestationError';
    this.code = code;
  }

  toJSON(): Readonly<{
    name: 'TailscalePeerAttestationError';
    code: TailscalePeerAttestationErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: 'TailscalePeerAttestationError' as const,
      code: this.code,
      message: this.message,
    });
  }
}

export interface TailscaleStatusExecOptions {
  readonly encoding: 'utf8';
  readonly timeout: typeof TAILSCALE_STATUS_TIMEOUT_MS;
  readonly maxBuffer: number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly shell: false;
  readonly windowsHide: true;
}

export interface TailscaleStatusExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type TailscaleStatusExecFile = (
  file: string,
  args: readonly string[],
  options: TailscaleStatusExecOptions,
) => Promise<TailscaleStatusExecResult>;

export interface TailscalePeerAttestorDependencies {
  readonly execFileImpl?: TailscaleStatusExecFile;
  readonly now?: () => number;
  readonly tailscaleBinaryPath?: string;
  readonly accessImpl?: (path: string, mode: number) => Promise<void>;
}

export interface TailscalePeerIdentity {
  readonly tailnetName: string;
  readonly stableNodeId: string;
  readonly nodePublicKey: string;
}

export interface TailscalePeerAttestation extends TailscalePeerIdentity {
  readonly address: string;
  readonly addressFamily: TailscaleAddressFamily;
  readonly displayName?: string;
  readonly operatingSystem?: string;
  readonly observedAt: string;
  readonly fingerprint: string;
}

export interface TailscalePeerInventory {
  readonly tailnetName: string;
  readonly observedAt: string;
  readonly peers: readonly TailscalePeerAttestation[];
}

export interface TailscalePeerReattestationRequest extends TailscalePeerIdentity {
  /**
   * The address already committed to the durable binding. It is comparison
   * input only; lookup authority remains the exact Tailnet/stable-ID/key tuple.
   */
  readonly boundAddress: string;
}

export type TailscalePeerBindingChange = 'NODE_PUBLIC_KEY' | 'ADDRESS';

export type TailscalePeerUnavailableReason =
  | 'PEER_NOT_FOUND'
  | 'PEER_OFFLINE'
  | 'PEER_KEY_EXPIRED'
  | 'PEER_NOT_IN_NETWORK_MAP';

export type TailscalePeerReattestationResult =
  | Readonly<{
      state: 'ATTESTED';
      requiresBindingGenerationAdvance: false;
      attestation: TailscalePeerAttestation;
    }>
  | Readonly<{
      state: 'BINDING_GENERATION_ADVANCE_REQUIRED';
      requiresBindingGenerationAdvance: true;
      changes: readonly TailscalePeerBindingChange[];
      candidate: TailscalePeerAttestation;
    }>
  | Readonly<{
      state: 'UNAVAILABLE';
      reason: TailscalePeerUnavailableReason;
      observedAt: string;
    }>;

interface CanonicalAddress {
  readonly address: string;
  readonly family: TailscaleAddressFamily;
}

interface ParsedNode {
  readonly stableNodeId: string;
  readonly nodePublicKey: string;
  readonly allAddresses: readonly CanonicalAddress[];
  readonly selectedAddress: CanonicalAddress;
  readonly online: boolean;
  readonly inNetworkMap: boolean;
  readonly keyExpired: boolean;
  readonly displayName?: string;
  readonly operatingSystem?: string;
  readonly mapKey?: string;
}

interface ParsedStatusSnapshot {
  readonly tailnetName: string;
  readonly observedAt: string;
  readonly peers: readonly ParsedNode[];
}

type UnknownRecord = Record<string, unknown>;

const execFileAsync = promisify(execFile);

const defaultExecFile: TailscaleStatusExecFile = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], {
    encoding: options.encoding,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: { ...options.env },
    shell: options.shell,
    windowsHide: options.windowsHide,
  } satisfies ExecFileOptionsWithStringEncoding);
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
};

function fail(code: TailscalePeerAttestationErrorCode): never {
  throw new TailscalePeerAttestationError(code);
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function boundedRecord(
  value: unknown,
  maxFields: number,
  code: TailscalePeerAttestationErrorCode,
): UnknownRecord {
  if (!isRecord(value) || Object.keys(value).length > maxFields) return fail(code);
  return value;
}

function validTailnetName(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') >= 1
    && Buffer.byteLength(value, 'utf8') <= MAX_TAILNET_NAME_BYTES
    && /^[A-Za-z0-9](?:[A-Za-z0-9._@+-]*[A-Za-z0-9])?$/u.test(value);
}

function requireRequestTailnetName(value: unknown): string {
  if (!validTailnetName(value)) return fail('REQUEST_INVALID');
  return value;
}

function validStableNodeId(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') >= 6
    && Buffer.byteLength(value, 'utf8') <= MAX_STABLE_NODE_ID_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
}

function validNodePublicKey(value: unknown): value is string {
  return typeof value === 'string'
    && /^nodekey:[a-f0-9]{64}$/u.test(value)
    && !/^nodekey:0{64}$/u.test(value);
}

function sanitizedPresentationText(
  value: unknown,
  maxBytes: number,
): string | undefined {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._ -]*[A-Za-z0-9])?$/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function sanitizedDnsLabel(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > MAX_DNS_NAME_BYTES
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?$/u.test(value)
  ) {
    return undefined;
  }
  const label = value.split('.', 1)[0];
  return sanitizedPresentationText(label, MAX_DNS_LABEL_BYTES);
}

function presentationMetadata(record: UnknownRecord): Readonly<{
  displayName?: string;
  operatingSystem?: string;
}> {
  const displayName = sanitizedPresentationText(record.HostName, MAX_DISPLAY_NAME_BYTES)
    || sanitizedDnsLabel(record.DNSName);
  const operatingSystem = sanitizedPresentationText(
    record.OS,
    MAX_OPERATING_SYSTEM_BYTES,
  );
  return Object.freeze({
    ...(displayName === undefined ? {} : { displayName }),
    ...(operatingSystem === undefined ? {} : { operatingSystem }),
  });
}

function stableNodeId(
  record: UnknownRecord,
  code: TailscalePeerAttestationErrorCode,
): string {
  const hasId = hasOwn(record, 'ID');
  const hasStableId = hasOwn(record, 'StableNodeID');
  if (!hasId && !hasStableId) return fail(code);

  const id = hasId ? record.ID : undefined;
  const explicitStableId = hasStableId ? record.StableNodeID : undefined;
  if (hasId && !validStableNodeId(id)) return fail(code);
  if (hasStableId && !validStableNodeId(explicitStableId)) return fail(code);
  if (hasId && hasStableId && id !== explicitStableId) return fail(code);
  return (id ?? explicitStableId) as string;
}

function canonicalIpv6(value: string): string {
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) {
      return fail('PEER_ADDRESS_INVALID');
    }
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return fail('PEER_ADDRESS_INVALID');
  }
}

function parseTailscaleAddress(
  value: unknown,
  invalidCode: TailscalePeerAttestationErrorCode,
): CanonicalAddress {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > MAX_ADDRESS_BYTES
    || value.trim() !== value
    || value.includes('%')
  ) {
    return fail(invalidCode);
  }

  const family = isIP(value);
  if (family === 4) {
    const octets = value.split('.').map((octet) => Number(octet));
    if (octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) {
      return fail(invalidCode);
    }
    return Object.freeze({ address: octets.join('.'), family: 'IPV4' as const });
  }

  if (family === 6) {
    let address: string;
    try {
      address = canonicalIpv6(value);
    } catch {
      return fail(invalidCode);
    }
    if (/^::ffff:/u.test(address) || !address.startsWith('fd7a:115c:a1e0:')) {
      return fail(invalidCode);
    }
    return Object.freeze({ address, family: 'IPV6' as const });
  }

  return fail(invalidCode);
}

function parseNodeAddresses(
  value: unknown,
  invalidCode: TailscalePeerAttestationErrorCode,
  ambiguousCode: TailscalePeerAttestationErrorCode,
): Pick<ParsedNode, 'allAddresses' | 'selectedAddress'> {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > TAILSCALE_STATUS_MAX_NODE_ADDRESSES
  ) {
    return fail(invalidCode);
  }

  const allAddresses = value.map((entry) => parseTailscaleAddress(entry, invalidCode));
  const unique = new Set(allAddresses.map((entry) => `${entry.family}:${entry.address}`));
  if (unique.size !== allAddresses.length) return fail(ambiguousCode);

  const ipv4 = allAddresses.filter((entry) => entry.family === 'IPV4');
  const ipv6 = allAddresses.filter((entry) => entry.family === 'IPV6');
  let selectedAddress: CanonicalAddress;
  if (ipv4.length === 1) {
    selectedAddress = ipv4[0];
  } else if (ipv4.length > 1) {
    return fail(ambiguousCode);
  } else if (ipv6.length === 1) {
    selectedAddress = ipv6[0];
  } else {
    return fail(ambiguousCode);
  }

  return {
    allAddresses: Object.freeze(allAddresses),
    selectedAddress,
  };
}

function parseRfc3339Milliseconds(value: string): number | null {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u,
  );
  if (!match) return null;
  const milliseconds = (match[2] || '').padEnd(3, '0').slice(0, 3);
  const normalized = `${match[1]}.${milliseconds}${match[3]}`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function keyExpired(
  record: UnknownRecord,
  nowMs: number,
  code: TailscalePeerAttestationErrorCode,
): boolean {
  if (hasOwn(record, 'Expired') && typeof record.Expired !== 'boolean') {
    return fail(code);
  }
  if (record.Expired === true) return true;
  if (!hasOwn(record, 'KeyExpiry')) return false;
  const value = record.KeyExpiry;
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 1
    || Buffer.byteLength(value, 'utf8') > MAX_EXPIRY_BYTES
  ) {
    return fail(code);
  }
  if (value === ZERO_KEY_EXPIRY) return false;
  const expiryMs = parseRfc3339Milliseconds(value);
  if (expiryMs === null) return fail(code);
  return expiryMs <= nowMs;
}

function parseNode(
  value: unknown,
  nowMs: number,
  kind: 'self' | 'peer',
  mapKey?: string,
): ParsedNode {
  const identityCode = kind === 'self' ? 'SELF_IDENTITY_INVALID' : 'PEER_IDENTITY_INVALID';
  const invalidAddressCode = kind === 'self' ? 'SELF_IDENTITY_INVALID' : 'PEER_ADDRESS_INVALID';
  const ambiguousAddressCode = kind === 'self' ? 'SELF_IDENTITY_INVALID' : 'PEER_ADDRESS_AMBIGUOUS';
  const record = boundedRecord(value, TAILSCALE_STATUS_MAX_NODE_FIELDS, identityCode);
  const nodePublicKey = record.PublicKey;
  if (!validNodePublicKey(nodePublicKey)) return fail(identityCode);
  if (typeof record.Online !== 'boolean' || typeof record.InNetworkMap !== 'boolean') {
    return fail(identityCode);
  }
  const addresses = parseNodeAddresses(
    record.TailscaleIPs,
    invalidAddressCode,
    ambiguousAddressCode,
  );
  return Object.freeze({
    stableNodeId: stableNodeId(record, identityCode),
    nodePublicKey,
    ...addresses,
    online: record.Online,
    inNetworkMap: record.InNetworkMap,
    keyExpired: keyExpired(record, nowMs, identityCode),
    ...presentationMetadata(record),
    ...(mapKey === undefined ? {} : { mapKey }),
  });
}

function validateNoCollisions(self: ParsedNode, peers: readonly ParsedNode[]): void {
  const stableNodeIds = new Set([self.stableNodeId]);
  const nodePublicKeys = new Set([self.nodePublicKey]);
  const addresses = new Set(self.allAddresses.map((entry) => `${entry.family}:${entry.address}`));

  for (const peer of peers) {
    if (stableNodeIds.has(peer.stableNodeId) || nodePublicKeys.has(peer.nodePublicKey)) {
      return fail('PEER_COLLISION');
    }
    stableNodeIds.add(peer.stableNodeId);
    nodePublicKeys.add(peer.nodePublicKey);
    for (const address of peer.allAddresses) {
      const key = `${address.family}:${address.address}`;
      if (addresses.has(key)) return fail('PEER_COLLISION');
      addresses.add(key);
    }
  }
}

function observedMilliseconds(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    return fail('CLOCK_INVALID');
  }
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_DATE_MILLISECONDS
  ) {
    return fail('CLOCK_INVALID');
  }
  return value;
}

function isCommandTimeout(error: unknown): boolean {
  if (!isRecord(error)) return false;
  try {
    return error.killed === true
      || error.code === 'ETIMEDOUT'
      || error.code === 'ERR_CHILD_PROCESS_TIMEOUT';
  } catch {
    return false;
  }
}

function isMaxBufferFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  try {
    return error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  } catch {
    return false;
  }
}

async function readBoundedStatus(
  binaryPath: string,
  execFileImpl: TailscaleStatusExecFile,
): Promise<string> {
  let result: TailscaleStatusExecResult;
  try {
    result = await execFileImpl(
      binaryPath,
      TAILSCALE_STATUS_ARGS,
      Object.freeze({
        encoding: 'utf8' as const,
        timeout: TAILSCALE_STATUS_TIMEOUT_MS,
        maxBuffer: TAILSCALE_STATUS_MAX_BUFFER_BYTES,
        env: SAFE_TAILSCALE_ENV,
        shell: false as const,
        windowsHide: true as const,
      }),
    );
  } catch (error) {
    if (isCommandTimeout(error)) return fail('STATUS_COMMAND_TIMEOUT');
    if (isMaxBufferFailure(error)) return fail('STATUS_TOO_LARGE');
    return fail('STATUS_COMMAND_FAILED');
  }

  if (
    !isRecord(result)
    || typeof result.stdout !== 'string'
    || typeof result.stderr !== 'string'
  ) {
    return fail('STATUS_MALFORMED');
  }
  if (
    Buffer.byteLength(result.stdout, 'utf8') > TAILSCALE_STATUS_MAX_BUFFER_BYTES
    || Buffer.byteLength(result.stderr, 'utf8') > TAILSCALE_STATUS_MAX_BUFFER_BYTES
  ) {
    return fail('STATUS_TOO_LARGE');
  }
  return result.stdout;
}

function isAllowlistedTailscaleBinary(value: unknown): value is typeof TAILSCALE_BINARY_ALLOWLIST[number] {
  return typeof value === 'string'
    && TAILSCALE_BINARY_ALLOWLIST.some((candidate) => candidate === value);
}

async function resolveTailscaleBinary(
  dependencies: TailscalePeerAttestorDependencies,
): Promise<typeof TAILSCALE_BINARY_ALLOWLIST[number]> {
  if (dependencies.tailscaleBinaryPath !== undefined) {
    if (!isAllowlistedTailscaleBinary(dependencies.tailscaleBinaryPath)) {
      return fail('REQUEST_INVALID');
    }
    return dependencies.tailscaleBinaryPath;
  }

  // Injected command runners are test/harness boundaries. They still receive
  // an absolute allowlisted path, without consulting the harness filesystem.
  if (dependencies.execFileImpl && !dependencies.accessImpl) {
    return TAILSCALE_BINARY_ALLOWLIST[0];
  }

  const accessImpl = dependencies.accessImpl || access;
  for (const candidate of TAILSCALE_BINARY_ALLOWLIST) {
    try {
      await accessImpl(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed absolute location.
    }
  }
  // No allowlisted binary exists at all — an admin-actionable state, distinct
  // from an installed binary whose probe fails.
  return fail('TAILSCALE_NOT_INSTALLED');
}

function parseStatusSnapshot(
  raw: string,
  expectedTailnetName: string | null,
  nowMs: number,
): ParsedStatusSnapshot {
  if (Buffer.byteLength(raw, 'utf8') < 2) return fail('STATUS_MALFORMED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fail('STATUS_MALFORMED');
  }

  const status = boundedRecord(
    parsed,
    TAILSCALE_STATUS_MAX_TOP_LEVEL_FIELDS,
    'STATUS_MALFORMED',
  );
  if (status.BackendState !== 'Running') return fail('BACKEND_NOT_RUNNING');
  if (status.HaveNodeKey !== true) return fail('SELF_IDENTITY_INVALID');

  const currentTailnet = boundedRecord(
    status.CurrentTailnet,
    TAILSCALE_STATUS_MAX_TAILNET_FIELDS,
    'STATUS_MALFORMED',
  );
  if (!validTailnetName(currentTailnet.Name)) return fail('STATUS_MALFORMED');
  const currentTailnetName = currentTailnet.Name;
  if (expectedTailnetName !== null && currentTailnetName !== expectedTailnetName) {
    return fail('TAILNET_MISMATCH');
  }

  const self = parseNode(status.Self, nowMs, 'self');
  if (!self.online || !self.inNetworkMap || self.keyExpired) {
    return fail('SELF_IDENTITY_INVALID');
  }

  const peerMap = boundedRecord(status.Peer, TAILSCALE_STATUS_MAX_PEERS, 'STATUS_MALFORMED');
  const peerEntries = Object.entries(peerMap);
  if (peerEntries.length > TAILSCALE_STATUS_MAX_PEERS) return fail('STATUS_MALFORMED');
  const peers = peerEntries.map(([mapKey, value]) => parseNode(value, nowMs, 'peer', mapKey));

  validateNoCollisions(self, peers);
  for (const peer of peers) {
    if (!validNodePublicKey(peer.mapKey) || peer.mapKey !== peer.nodePublicKey) {
      return fail('PEER_IDENTITY_INVALID');
    }
  }

  return Object.freeze({
    tailnetName: currentTailnetName,
    observedAt: new Date(nowMs).toISOString(),
    peers: Object.freeze(peers),
  });
}

async function loadStatusSnapshot(
  expectedTailnetName: string | null,
  dependencies: TailscalePeerAttestorDependencies,
): Promise<ParsedStatusSnapshot> {
  const binaryPath = await resolveTailscaleBinary(dependencies);
  const raw = await readBoundedStatus(binaryPath, dependencies.execFileImpl || defaultExecFile);
  const nowMs = observedMilliseconds(dependencies.now || Date.now);
  return parseStatusSnapshot(raw, expectedTailnetName, nowMs);
}

function fingerprintAttestation(input: {
  tailnetName: string;
  stableNodeId: string;
  nodePublicKey: string;
  address: string;
  addressFamily: TailscaleAddressFamily;
}): string {
  const digest = createHash('sha256').update(ATTESTATION_FINGERPRINT_DOMAIN).update('\0');
  for (const value of [
    input.tailnetName,
    input.stableNodeId,
    input.nodePublicKey,
    input.address,
    input.addressFamily,
  ]) {
    const bytes = Buffer.from(value, 'utf8');
    digest.update(String(bytes.length)).update(':').update(bytes).update('\0');
  }
  return digest.digest('hex');
}

function attestationFor(
  snapshot: ParsedStatusSnapshot,
  peer: ParsedNode,
): TailscalePeerAttestation {
  const identity = {
    tailnetName: snapshot.tailnetName,
    stableNodeId: peer.stableNodeId,
    nodePublicKey: peer.nodePublicKey,
    address: peer.selectedAddress.address,
    addressFamily: peer.selectedAddress.family,
  };
  return Object.freeze({
    ...identity,
    ...(peer.displayName === undefined ? {} : { displayName: peer.displayName }),
    ...(peer.operatingSystem === undefined
      ? {}
      : { operatingSystem: peer.operatingSystem }),
    observedAt: snapshot.observedAt,
    fingerprint: fingerprintAttestation(identity),
  });
}

function unavailableReason(peer: ParsedNode): TailscalePeerUnavailableReason | null {
  if (!peer.online) return 'PEER_OFFLINE';
  if (peer.keyExpired) return 'PEER_KEY_EXPIRED';
  if (!peer.inNetworkMap) return 'PEER_NOT_IN_NETWORK_MAP';
  return null;
}

function inventoryFor(snapshot: ParsedStatusSnapshot): TailscalePeerInventory {
  const peers = snapshot.peers
    .filter((peer) => unavailableReason(peer) === null)
    .map((peer) => attestationFor(snapshot, peer))
    .sort((left, right) => left.stableNodeId.localeCompare(right.stableNodeId));
  return Object.freeze({
    tailnetName: snapshot.tailnetName,
    observedAt: snapshot.observedAt,
    peers: Object.freeze(peers),
  });
}

/**
 * First-run discovery derives the Tailnet identity from the same bounded,
 * validated status snapshot that supplies the peer attestations. Bound flows
 * must use listAttestedTailscalePeers or reattestTailscalePeer instead.
 */
export async function listCurrentAttestedTailscalePeers(
  dependencies: TailscalePeerAttestorDependencies = {},
): Promise<TailscalePeerInventory> {
  return inventoryFor(await loadStatusSnapshot(null, dependencies));
}

export async function listAttestedTailscalePeers(
  expectedTailnetName: string,
  dependencies: TailscalePeerAttestorDependencies = {},
): Promise<TailscalePeerInventory> {
  const tailnetName = requireRequestTailnetName(expectedTailnetName);
  return inventoryFor(await loadStatusSnapshot(tailnetName, dependencies));
}

/**
 * Re-attests one durable binding by its exact Tailnet/stable-ID/node-key tuple.
 * A Tailscale address is a current routing observation, not device identity:
 * address rotation with the same stable ID and node key remains attested. A
 * changed key is returned only as an explicit replacement candidate.
 */
export async function reattestTailscalePeer(
  request: TailscalePeerReattestationRequest,
  dependencies: TailscalePeerAttestorDependencies = {},
): Promise<TailscalePeerReattestationResult> {
  if (!isRecord(request)) return fail('REQUEST_INVALID');
  const tailnetName = requireRequestTailnetName(request.tailnetName);
  if (!validStableNodeId(request.stableNodeId) || !validNodePublicKey(request.nodePublicKey)) {
    return fail('REQUEST_INVALID');
  }
  const boundAddress = parseTailscaleAddress(request.boundAddress, 'REQUEST_INVALID').address;
  const snapshot = await loadStatusSnapshot(tailnetName, dependencies);
  const peer = snapshot.peers.find((entry) => entry.stableNodeId === request.stableNodeId);
  if (!peer) {
    return Object.freeze({
      state: 'UNAVAILABLE' as const,
      reason: 'PEER_NOT_FOUND' as const,
      observedAt: snapshot.observedAt,
    });
  }

  const reason = unavailableReason(peer);
  if (reason) {
    return Object.freeze({
      state: 'UNAVAILABLE' as const,
      reason,
      observedAt: snapshot.observedAt,
    });
  }

  const candidate = attestationFor(snapshot, peer);
  if (request.nodePublicKey !== candidate.nodePublicKey) {
    return Object.freeze({
      state: 'BINDING_GENERATION_ADVANCE_REQUIRED' as const,
      requiresBindingGenerationAdvance: true as const,
      changes: Object.freeze(['NODE_PUBLIC_KEY'] as const),
      candidate,
    });
  }

  // Parse boundAddress above even though rotation is accepted. This keeps the
  // durable input constrained to a literal Tailscale address and prevents a
  // malformed or arbitrary URL from being laundered through re-attestation.
  void boundAddress;
  return Object.freeze({
    state: 'ATTESTED' as const,
    requiresBindingGenerationAdvance: false as const,
    attestation: candidate,
  });
}
