import crypto from 'crypto';
import net from 'net';

// Protocol v2 is the only supported wire format; there is no v1 downgrade path.
const CHALLENGE_DOMAIN = 'bridgesllm-ollama-tailnet/challenge/v2';
const REQUEST_AAD_DOMAIN = 'bridgesllm-ollama-tailnet/request/aad/v2';
const REQUEST_HMAC_DOMAIN = 'bridgesllm-ollama-tailnet/request/hmac/v2';
const RESPONSE_AAD_DOMAIN = 'bridgesllm-ollama-tailnet/response/aad/v2';
const RESPONSE_HMAC_DOMAIN = 'bridgesllm-ollama-tailnet/response/hmac/v2';
const HKDF_SALT_DOMAIN = 'bridgesllm-ollama-tailnet/hkdf-salt/v2';
const HKDF_INFO_DOMAIN = 'bridgesllm-ollama-tailnet/hkdf-info/v2';

export const OLLAMA_TAILNET_PROTOCOL_VERSION = 2 as const;
export const OLLAMA_TAILNET_HELPER_PORT = 11434 as const;
export const OLLAMA_TAILNET_NONCE_BYTES = 32;
export const OLLAMA_TAILNET_GCM_TAG_BYTES = 16;
export const OLLAMA_TAILNET_MIN_SECRET_BYTES = 32;
export const OLLAMA_TAILNET_MAX_SECRET_BYTES = 4096;
export const OLLAMA_TAILNET_MAX_PAST_SKEW_MS = 60_000;
export const OLLAMA_TAILNET_MAX_FUTURE_SKEW_MS = 5_000;

const SHA256_BYTES = 32;
const SHA256_HEX_LENGTH = SHA256_BYTES * 2;
const BASE64URL_SHA256_LENGTH = 43;

export const OLLAMA_TAILNET_PATH_POLICY = Object.freeze({
  '/api/tags': Object.freeze({
    method: 'GET',
    maxRequestBytes: 0,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
  '/api/ps': Object.freeze({
    method: 'GET',
    maxRequestBytes: 0,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
  '/api/show': Object.freeze({
    method: 'POST',
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
  '/api/chat': Object.freeze({
    method: 'POST',
    maxRequestBytes: 16 * 1024 * 1024,
    maxResponseBytes: 64 * 1024 * 1024,
  }),
  '/api/generate': Object.freeze({
    method: 'POST',
    maxRequestBytes: 16 * 1024 * 1024,
    maxResponseBytes: 64 * 1024 * 1024,
  }),
  '/api/pull': Object.freeze({
    method: 'POST',
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
  }),
  '/api/version': Object.freeze({
    method: 'GET',
    maxRequestBytes: 0,
    maxResponseBytes: 64 * 1024,
  }),
} as const);

export type OllamaTailnetPath = keyof typeof OLLAMA_TAILNET_PATH_POLICY;
export type OllamaTailnetMethod =
  typeof OLLAMA_TAILNET_PATH_POLICY[OllamaTailnetPath]['method'];
export type OllamaTailnetProtocolRole = 'portal' | 'helper';

export type OllamaTailnetProtocolErrorCode =
  | 'BINDING_INVALID'
  | 'SECRET_INVALID'
  | 'DISPOSED'
  | 'ROLE_MISMATCH'
  | 'SESSION_STATE_INVALID'
  | 'SESSION_MISMATCH'
  | 'PATH_NOT_ALLOWED'
  | 'METHOD_NOT_ALLOWED'
  | 'BODY_INVALID'
  | 'BODY_TOO_LARGE'
  | 'WIRE_BODY_INVALID'
  | 'WIRE_BODY_TOO_LARGE'
  | 'WIRE_BODY_HASH_MISMATCH'
  | 'ENVELOPE_MALFORMED'
  | 'BINDING_MISMATCH'
  | 'TIMESTAMP_INVALID'
  | 'TIMESTAMP_STALE'
  | 'TIMESTAMP_FUTURE'
  | 'NONCE_INVALID'
  | 'SIGNATURE_INVALID'
  | 'DECRYPTION_FAILED'
  | 'STATUS_INVALID'
  | 'RANDOM_SOURCE_INVALID'
  | 'CRYPTO_FAILURE'
  | 'VERIFIED_REQUEST_REQUIRED';

const ERROR_MESSAGES: Readonly<Record<OllamaTailnetProtocolErrorCode, string>> = Object.freeze({
  BINDING_INVALID: 'The Tailnet helper binding is invalid.',
  SECRET_INVALID: 'The Tailnet helper secret is invalid.',
  DISPOSED: 'The Tailnet helper protocol instance has been disposed.',
  ROLE_MISMATCH: 'The operation is not valid for this Tailnet protocol role.',
  SESSION_STATE_INVALID: 'The Tailnet protocol session is not in the required state.',
  SESSION_MISMATCH: 'The message does not match this Tailnet protocol session.',
  PATH_NOT_ALLOWED: 'The Ollama helper path is not allowlisted.',
  METHOD_NOT_ALLOWED: 'The Ollama helper method is not allowed for this path.',
  BODY_INVALID: 'The Ollama helper body is invalid.',
  BODY_TOO_LARGE: 'The Ollama helper body exceeds the route-specific limit.',
  WIRE_BODY_INVALID: 'The encrypted Ollama helper body is invalid.',
  WIRE_BODY_TOO_LARGE: 'The encrypted Ollama helper body exceeds the route-specific limit.',
  WIRE_BODY_HASH_MISMATCH: 'The encrypted Ollama helper body does not match its digest.',
  ENVELOPE_MALFORMED: 'The Tailnet protocol envelope is malformed.',
  BINDING_MISMATCH: 'The message does not match the durable helper binding.',
  TIMESTAMP_INVALID: 'The Tailnet protocol timestamp is invalid.',
  TIMESTAMP_STALE: 'The Tailnet protocol timestamp is stale.',
  TIMESTAMP_FUTURE: 'The Tailnet protocol timestamp is too far in the future.',
  NONCE_INVALID: 'The cryptographic nonce is malformed.',
  SIGNATURE_INVALID: 'The Tailnet protocol message could not be authenticated.',
  DECRYPTION_FAILED: 'The encrypted Ollama helper body could not be authenticated.',
  STATUS_INVALID: 'The Ollama helper response status is invalid.',
  RANDOM_SOURCE_INVALID: 'The cryptographic random source is unavailable.',
  CRYPTO_FAILURE: 'The Tailnet protocol cryptographic operation failed.',
  VERIFIED_REQUEST_REQUIRED: 'A response requires a request verified by this protocol instance.',
});

export class OllamaTailnetProtocolError extends Error {
  readonly code: OllamaTailnetProtocolErrorCode;

  constructor(code: OllamaTailnetProtocolErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OllamaTailnetProtocolError';
    this.code = code;
  }

  toJSON(): Readonly<{
    name: 'OllamaTailnetProtocolError';
    code: OllamaTailnetProtocolErrorCode;
    message: string;
  }> {
    return Object.freeze({
      name: 'OllamaTailnetProtocolError' as const,
      code: this.code,
      message: this.message,
    });
  }
}

export interface OllamaTailnetBindingInput {
  readonly generation: number;
  readonly stableNodeId: string;
  readonly nodePublicKey: string;
  readonly tailnetName: string;
  readonly address: string;
  readonly helperPort: number;
  readonly helperId: string;
  readonly secret: Uint8Array;
}

export interface OllamaTailnetBinding {
  readonly generation: number;
  readonly stableNodeId: string;
  readonly nodePublicKey: string;
  readonly tailnetName: string;
  readonly address: string;
  readonly addressFamily: 4 | 6;
  readonly helperPort: typeof OLLAMA_TAILNET_HELPER_PORT;
  readonly helperId: string;
}

interface BindingEnvelope {
  readonly protocolVersion: typeof OLLAMA_TAILNET_PROTOCOL_VERSION;
  readonly generation: number;
  readonly stableNodeId: string;
  readonly nodePublicKey: string;
  readonly tailnetName: string;
  readonly address: string;
  readonly helperPort: typeof OLLAMA_TAILNET_HELPER_PORT;
  readonly helperId: string;
}

export interface UnsignedOllamaTailnetHello extends BindingEnvelope {
  readonly portalSessionNonce: string;
}

export interface SignedOllamaTailnetChallenge extends BindingEnvelope {
  readonly portalSessionNonce: string;
  readonly helperSessionNonce: string;
  readonly timestampMs: number;
  readonly hmac: string;
}

export interface EncryptedOllamaTailnetRequest extends BindingEnvelope {
  readonly portalSessionNonce: string;
  readonly helperSessionNonce: string;
  readonly method: string;
  readonly path: string;
  readonly requestNonce: string;
  readonly timestampMs: number;
  readonly wireBodySha256: string;
  readonly signature: string;
}

export interface EncryptedOllamaTailnetResponse extends BindingEnvelope {
  readonly portalSessionNonce: string;
  readonly helperSessionNonce: string;
  readonly requestMethod: string;
  readonly requestPath: string;
  readonly requestTimestampMs: number;
  readonly requestNonce: string;
  readonly requestWireBodySha256: string;
  readonly status: number;
  readonly timestampMs: number;
  readonly wireBodySha256: string;
  readonly signature: string;
}

const VERIFIED_REQUEST_BRAND: unique symbol = Symbol('verifiedOllamaTailnetRequest');

export interface VerifiedOllamaTailnetRequest {
  readonly [VERIFIED_REQUEST_BRAND]: true;
}

export interface EncryptedOllamaTailnetRequestMessage {
  readonly envelope: EncryptedOllamaTailnetRequest;
  readonly wireBody: Buffer;
}

export interface EncryptedOllamaTailnetResponseMessage {
  readonly envelope: EncryptedOllamaTailnetResponse;
  readonly wireBody: Buffer;
}

export interface DecryptedOllamaTailnetRequest {
  readonly request: VerifiedOllamaTailnetRequest;
  readonly body: Buffer;
}

export interface OllamaTailnetProtocolOptions {
  readonly role: OllamaTailnetProtocolRole;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

type ProtocolPhase =
  | 'new'
  | 'hello-issued'
  | 'challenge-issued'
  | 'challenge-verified'
  | 'request-created'
  | 'request-verified'
  | 'response-created'
  | 'response-verified'
  | 'failed';

type CanonicalField = readonly [name: string, value: string | number];

interface ValidatedBindingInput {
  readonly binding: OllamaTailnetBinding;
  readonly secret: Buffer;
}

interface Session {
  readonly portalSessionNonce: string;
  readonly helperSessionNonce: string;
}

interface VerifiedRequestMetadata {
  readonly envelope: EncryptedOllamaTailnetRequest;
  readonly operation: ReturnType<typeof requireOperation>;
  readonly body: Buffer;
}

const HELLO_KEYS = Object.freeze([
  'address',
  'generation',
  'helperId',
  'helperPort',
  'nodePublicKey',
  'portalSessionNonce',
  'protocolVersion',
  'stableNodeId',
  'tailnetName',
] as const);

const CHALLENGE_KEYS = Object.freeze([
  'address',
  'generation',
  'helperId',
  'helperPort',
  'helperSessionNonce',
  'hmac',
  'nodePublicKey',
  'portalSessionNonce',
  'protocolVersion',
  'stableNodeId',
  'tailnetName',
  'timestampMs',
] as const);

const REQUEST_KEYS = Object.freeze([
  'address',
  'generation',
  'helperId',
  'helperPort',
  'helperSessionNonce',
  'method',
  'nodePublicKey',
  'path',
  'portalSessionNonce',
  'protocolVersion',
  'requestNonce',
  'signature',
  'stableNodeId',
  'tailnetName',
  'timestampMs',
  'wireBodySha256',
] as const);

const RESPONSE_KEYS = Object.freeze([
  'address',
  'generation',
  'helperId',
  'helperPort',
  'helperSessionNonce',
  'nodePublicKey',
  'portalSessionNonce',
  'protocolVersion',
  'requestMethod',
  'requestNonce',
  'requestPath',
  'requestTimestampMs',
  'requestWireBodySha256',
  'signature',
  'stableNodeId',
  'status',
  'tailnetName',
  'timestampMs',
  'wireBodySha256',
] as const);

function fail(code: OllamaTailnetProtocolErrorCode): never {
  throw new OllamaTailnetProtocolError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecord(value)) return fail('ENVELOPE_MALFORMED');
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return fail('ENVELOPE_MALFORMED');
  }
  return value;
}

function requireExactAscii(value: unknown, pattern: RegExp, maxBytes: number): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || !pattern.test(value)
  ) {
    return fail('BINDING_INVALID');
  }
  return value;
}

function parseTailscaleAddress(address: unknown): Readonly<{ address: string; family: 4 | 6 }> {
  if (
    typeof address !== 'string'
    || address.length < 1
    || address.length > 64
    || address.trim() !== address
  ) {
    return fail('BINDING_INVALID');
  }

  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map((part) => Number(part));
    if (
      octets.length !== 4
      || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
      || octets[0] !== 100
      || octets[1] < 64
      || octets[1] > 127
    ) {
      return fail('BINDING_INVALID');
    }
    return Object.freeze({ address, family: 4 as const });
  }

  if (family !== 6 || address.includes('.') || address.includes('%')) {
    return fail('BINDING_INVALID');
  }
  const halves = address.split('::');
  if (halves.length > 2) return fail('BINDING_INVALID');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (
    left.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))
    || right.some((part) => !/^[0-9a-f]{1,4}$/iu.test(part))
  ) {
    return fail('BINDING_INVALID');
  }
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0)
    || (halves.length === 2 && missing < 1)
  ) {
    return fail('BINDING_INVALID');
  }
  const hextets = [
    ...left,
    ...Array<string>(missing).fill('0'),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  if (
    hextets.length !== 8
    || hextets[0] !== 0xfd7a
    || hextets[1] !== 0x115c
    || hextets[2] !== 0xa1e0
  ) {
    return fail('BINDING_INVALID');
  }
  return Object.freeze({ address, family: 6 as const });
}

function validateBindingInput(input: OllamaTailnetBindingInput): ValidatedBindingInput {
  if (!isPlainRecord(input)) return fail('BINDING_INVALID');
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
    return fail('BINDING_INVALID');
  }
  const stableNodeId = requireExactAscii(
    input.stableNodeId,
    /^[A-Za-z0-9_-]{6,128}$/u,
    128,
  );
  const nodePublicKey = requireExactAscii(
    input.nodePublicKey,
    /^nodekey:[a-f0-9]{64}$/u,
    72,
  );
  if (nodePublicKey === `nodekey:${'0'.repeat(64)}`) return fail('BINDING_INVALID');
  const tailnetName = requireExactAscii(
    input.tailnetName,
    /^[A-Za-z0-9](?:[A-Za-z0-9._@+-]{0,251}[A-Za-z0-9])?$/u,
    253,
  );
  const parsedAddress = parseTailscaleAddress(input.address);
  if (input.helperPort !== OLLAMA_TAILNET_HELPER_PORT) return fail('BINDING_INVALID');
  const helperId = requireExactAscii(
    input.helperId,
    /^[A-Za-z0-9_-]{16,128}$/u,
    128,
  );
  if (
    !(input.secret instanceof Uint8Array)
    || input.secret.byteLength < OLLAMA_TAILNET_MIN_SECRET_BYTES
    || input.secret.byteLength > OLLAMA_TAILNET_MAX_SECRET_BYTES
  ) {
    return fail('SECRET_INVALID');
  }
  return {
    binding: Object.freeze({
      generation: input.generation,
      stableNodeId,
      nodePublicKey,
      tailnetName,
      address: parsedAddress.address,
      addressFamily: parsedAddress.family,
      helperPort: OLLAMA_TAILNET_HELPER_PORT,
      helperId,
    }),
    secret: Buffer.from(input.secret),
  };
}

/**
 * Validates a complete durable binding without retaining or returning its
 * caller-supplied secret.
 */
export function validateOllamaTailnetBinding(
  input: OllamaTailnetBindingInput,
): OllamaTailnetBinding {
  const validated = validateBindingInput(input);
  validated.secret.fill(0);
  return validated.binding;
}

function encodeCanonicalFields(fields: readonly CanonicalField[]): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, rawValue] of fields) {
    const nameBytes = Buffer.from(name, 'utf8');
    const valueBytes = Buffer.from(String(rawValue), 'utf8');
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(nameBytes.length, 0);
    lengths.writeUInt32BE(valueBytes.length, 4);
    chunks.push(lengths, nameBytes, valueBytes);
  }
  return Buffer.concat(chunks);
}

function bindingFields(binding: OllamaTailnetBinding): readonly CanonicalField[] {
  return [
    ['protocolVersion', OLLAMA_TAILNET_PROTOCOL_VERSION],
    ['generation', binding.generation],
    ['stableNodeId', binding.stableNodeId],
    ['nodePublicKey', binding.nodePublicKey],
    ['tailnetName', binding.tailnetName],
    ['address', binding.address],
    ['helperPort', binding.helperPort],
    ['helperId', binding.helperId],
  ];
}

function sessionFields(
  binding: OllamaTailnetBinding,
  session: Session,
): readonly CanonicalField[] {
  return [
    ...bindingFields(binding),
    ['portalSessionNonce', session.portalSessionNonce],
    ['helperSessionNonce', session.helperSessionNonce],
  ];
}

function challengeFields(
  binding: OllamaTailnetBinding,
  session: Session,
  timestampMs: number,
): readonly CanonicalField[] {
  return [
    ...sessionFields(binding, session),
    ['timestampMs', timestampMs],
  ];
}

function requestAadFields(
  binding: OllamaTailnetBinding,
  request: Pick<
    EncryptedOllamaTailnetRequest,
    | 'portalSessionNonce'
    | 'helperSessionNonce'
    | 'method'
    | 'path'
    | 'requestNonce'
    | 'timestampMs'
  >,
): readonly CanonicalField[] {
  return [
    ...sessionFields(binding, request),
    ['method', request.method],
    ['path', request.path],
    ['requestNonce', request.requestNonce],
    ['timestampMs', request.timestampMs],
  ];
}

function requestHmacFields(
  binding: OllamaTailnetBinding,
  request: Pick<
    EncryptedOllamaTailnetRequest,
    | 'portalSessionNonce'
    | 'helperSessionNonce'
    | 'method'
    | 'path'
    | 'requestNonce'
    | 'timestampMs'
    | 'wireBodySha256'
  >,
): readonly CanonicalField[] {
  return [
    ...requestAadFields(binding, request),
    ['wireBodySha256', request.wireBodySha256],
  ];
}

function responseAadFields(
  binding: OllamaTailnetBinding,
  response: Pick<
    EncryptedOllamaTailnetResponse,
    | 'portalSessionNonce'
    | 'helperSessionNonce'
    | 'requestMethod'
    | 'requestPath'
    | 'requestTimestampMs'
    | 'requestNonce'
    | 'requestWireBodySha256'
    | 'status'
    | 'timestampMs'
  >,
): readonly CanonicalField[] {
  return [
    ...sessionFields(binding, response),
    ['requestMethod', response.requestMethod],
    ['requestPath', response.requestPath],
    ['requestTimestampMs', response.requestTimestampMs],
    ['requestNonce', response.requestNonce],
    ['requestWireBodySha256', response.requestWireBodySha256],
    ['status', response.status],
    ['timestampMs', response.timestampMs],
  ];
}

function responseHmacFields(
  binding: OllamaTailnetBinding,
  response: Pick<
    EncryptedOllamaTailnetResponse,
    | 'portalSessionNonce'
    | 'helperSessionNonce'
    | 'requestMethod'
    | 'requestPath'
    | 'requestTimestampMs'
    | 'requestNonce'
    | 'requestWireBodySha256'
    | 'status'
    | 'timestampMs'
    | 'wireBodySha256'
  >,
): readonly CanonicalField[] {
  return [
    ...responseAadFields(binding, response),
    ['wireBodySha256', response.wireBodySha256],
  ];
}

function domainEncodedFields(
  domain: string,
  fields: readonly CanonicalField[],
): Buffer {
  return Buffer.concat([
    Buffer.from(domain, 'utf8'),
    Buffer.from([0]),
    encodeCanonicalFields(fields),
  ]);
}

function deriveKey(
  secret: Buffer,
  purpose: string,
  fields: readonly CanonicalField[],
  byteLength: number,
): Buffer {
  const saltInput = domainEncodedFields(HKDF_SALT_DOMAIN, fields);
  const salt = crypto.createHash('sha256').update(saltInput).digest();
  const info = domainEncodedFields(`${HKDF_INFO_DOMAIN}/${purpose}`, fields);
  try {
    return Buffer.from(crypto.hkdfSync('sha256', secret, salt, info, byteLength));
  } catch {
    return fail('CRYPTO_FAILURE');
  } finally {
    saltInput.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}

function computeHmac(
  key: Buffer,
  domain: string,
  fields: readonly CanonicalField[],
): Buffer {
  const encoded = domainEncodedFields(domain, fields);
  try {
    return crypto.createHmac('sha256', key).update(encoded).digest();
  } finally {
    encoded.fill(0);
  }
}

function strictBase64UrlSha256(value: unknown): Buffer | null {
  if (
    typeof value !== 'string'
    || value.length !== BASE64URL_SHA256_LENGTH
    || !/^[A-Za-z0-9_-]{43}$/u.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.byteLength !== SHA256_BYTES
    || decoded.toString('base64url') !== value
  ) {
    decoded.fill(0);
    return null;
  }
  return decoded;
}

function timingSafeMacEqual(provided: unknown, expected: Buffer): boolean {
  const decoded = strictBase64UrlSha256(provided);
  const candidate = decoded ?? Buffer.alloc(SHA256_BYTES);
  try {
    return decoded !== null && crypto.timingSafeEqual(candidate, expected);
  } finally {
    candidate.fill(0);
  }
}

function requireNonce(value: unknown): string {
  const decoded = strictBase64UrlSha256(value);
  if (decoded === null) return fail('NONCE_INVALID');
  decoded.fill(0);
  return value as string;
}

function requireWireBodySha256(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length !== SHA256_HEX_LENGTH
    || !/^[a-f0-9]{64}$/u.test(value)
  ) {
    return fail('ENVELOPE_MALFORMED');
  }
  return value;
}

function wireBodySha256(wireBody: Uint8Array): string {
  return crypto.createHash('sha256').update(wireBody).digest('hex');
}

function timingSafeHexEqual(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  try {
    return crypto.timingSafeEqual(providedBytes, expectedBytes);
  } finally {
    providedBytes.fill(0);
    expectedBytes.fill(0);
  }
}

function requireBody(body: unknown, maxBytes: number): Buffer {
  if (!(body instanceof Uint8Array)) return fail('BODY_INVALID');
  if (body.byteLength > maxBytes) return fail('BODY_TOO_LARGE');
  return Buffer.from(body);
}

function requireWireBody(wireBody: unknown, maxPlaintextBytes: number): Buffer {
  if (!(wireBody instanceof Uint8Array) || wireBody.byteLength < OLLAMA_TAILNET_GCM_TAG_BYTES) {
    return fail('WIRE_BODY_INVALID');
  }
  if (wireBody.byteLength > maxPlaintextBytes + OLLAMA_TAILNET_GCM_TAG_BYTES) {
    return fail('WIRE_BODY_TOO_LARGE');
  }
  return Buffer.from(wireBody);
}

function requireOperation(
  method: unknown,
  path: unknown,
): Readonly<{
  method: OllamaTailnetMethod;
  path: OllamaTailnetPath;
  maxRequestBytes: number;
  maxResponseBytes: number;
}> {
  if (
    typeof path !== 'string'
    || !Object.prototype.hasOwnProperty.call(OLLAMA_TAILNET_PATH_POLICY, path)
  ) {
    return fail('PATH_NOT_ALLOWED');
  }
  const typedPath = path as OllamaTailnetPath;
  const policy = OLLAMA_TAILNET_PATH_POLICY[typedPath];
  if (method !== policy.method) return fail('METHOD_NOT_ALLOWED');
  return Object.freeze({
    method: policy.method,
    path: typedPath,
    maxRequestBytes: policy.maxRequestBytes,
    maxResponseBytes: policy.maxResponseBytes,
  });
}

function requireStatus(status: unknown): number {
  if (!Number.isSafeInteger(status) || (status as number) < 200 || (status as number) > 599) {
    return fail('STATUS_INVALID');
  }
  return status as number;
}

function bindingEnvelope(binding: OllamaTailnetBinding): BindingEnvelope {
  return {
    protocolVersion: OLLAMA_TAILNET_PROTOCOL_VERSION,
    generation: binding.generation,
    stableNodeId: binding.stableNodeId,
    nodePublicKey: binding.nodePublicKey,
    tailnetName: binding.tailnetName,
    address: binding.address,
    helperPort: binding.helperPort,
    helperId: binding.helperId,
  };
}

function envelopeMatchesBinding(
  envelope: Partial<BindingEnvelope>,
  binding: OllamaTailnetBinding,
): boolean {
  return envelope.protocolVersion === OLLAMA_TAILNET_PROTOCOL_VERSION
    && envelope.generation === binding.generation
    && envelope.stableNodeId === binding.stableNodeId
    && envelope.nodePublicKey === binding.nodePublicKey
    && envelope.tailnetName === binding.tailnetName
    && envelope.address === binding.address
    && envelope.helperPort === binding.helperPort
    && envelope.helperId === binding.helperId;
}

function sessionMatches(
  value: Pick<Session, 'portalSessionNonce' | 'helperSessionNonce'>,
  session: Session,
): boolean {
  return value.portalSessionNonce === session.portalSessionNonce
    && value.helperSessionNonce === session.helperSessionNonce;
}

function requestMatches(
  value: EncryptedOllamaTailnetRequest,
  expected: EncryptedOllamaTailnetRequest,
): boolean {
  return REQUEST_KEYS.every((key) => value[key] === expected[key]);
}

function encryptBody(
  plaintext: Buffer,
  key: Buffer,
  iv: Buffer,
  aadDomain: string,
  aadFields: readonly CanonicalField[],
): Buffer {
  const aad = domainEncodedFields(aadDomain, aadFields);
  let first = Buffer.alloc(0);
  let final = Buffer.alloc(0);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: OLLAMA_TAILNET_GCM_TAG_BYTES,
    });
    cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
    first = cipher.update(plaintext);
    final = cipher.final();
    const tag = cipher.getAuthTag();
    const wireBody = Buffer.concat([first, final, tag]);
    tag.fill(0);
    return wireBody;
  } catch {
    return fail('CRYPTO_FAILURE');
  } finally {
    aad.fill(0);
    first.fill(0);
    final.fill(0);
  }
}

function decryptBody(
  wireBody: Buffer,
  key: Buffer,
  iv: Buffer,
  aadDomain: string,
  aadFields: readonly CanonicalField[],
): Buffer {
  const aad = domainEncodedFields(aadDomain, aadFields);
  const ciphertext = wireBody.subarray(0, -OLLAMA_TAILNET_GCM_TAG_BYTES);
  const tag = wireBody.subarray(-OLLAMA_TAILNET_GCM_TAG_BYTES);
  let first = Buffer.alloc(0);
  let final = Buffer.alloc(0);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: OLLAMA_TAILNET_GCM_TAG_BYTES,
    });
    decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
    decipher.setAuthTag(tag);
    first = decipher.update(ciphertext);
    final = decipher.final();
    return Buffer.concat([first, final]);
  } catch {
    return fail('DECRYPTION_FAILED');
  } finally {
    aad.fill(0);
    first.fill(0);
    final.fill(0);
  }
}

/**
 * Both roles hold the same symmetric secret. The role gate prevents accidental
 * local API misuse; it is not asymmetric proof that only one role can sign.
 */
export class OllamaTailnetProtocol {
  readonly binding: OllamaTailnetBinding;
  readonly role: OllamaTailnetProtocolRole;
  readonly #secret: Buffer;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #verifiedRequests = new WeakMap<object, VerifiedRequestMetadata>();
  readonly #ownedHelperBodies = new Set<Buffer>();
  #phase: ProtocolPhase = 'new';
  #disposed = false;
  #hello: UnsignedOllamaTailnetHello | null = null;
  #session: Session | null = null;
  #createdRequest: EncryptedOllamaTailnetRequest | null = null;
  #activeReceipt: VerifiedOllamaTailnetRequest | null = null;

  constructor(input: OllamaTailnetBindingInput, options: OllamaTailnetProtocolOptions) {
    const validated = validateBindingInput(input);
    this.binding = validated.binding;
    this.#secret = validated.secret;
    if (!options || (options.role !== 'portal' && options.role !== 'helper')) {
      this.#secret.fill(0);
      return fail('ROLE_MISMATCH');
    }
    this.role = options.role;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? crypto.randomBytes;
  }

  toJSON(): Readonly<{
    kind: 'OllamaTailnetProtocol';
    protocolVersion: typeof OLLAMA_TAILNET_PROTOCOL_VERSION;
    role: OllamaTailnetProtocolRole;
    binding: OllamaTailnetBinding;
  }> {
    return Object.freeze({
      kind: 'OllamaTailnetProtocol' as const,
      protocolVersion: OLLAMA_TAILNET_PROTOCOL_VERSION,
      role: this.role,
      binding: this.binding,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#secret.fill(0);
    for (const body of this.#ownedHelperBodies) body.fill(0);
    this.#ownedHelperBodies.clear();
    this.#disposed = true;
    this.#phase = 'failed';
    this.#hello = null;
    this.#session = null;
    this.#createdRequest = null;
    this.#activeReceipt = null;
  }

  createHello(): UnsignedOllamaTailnetHello {
    this.#assertActive();
    this.#assertRole('portal');
    this.#expectPhase('new');
    try {
      const hello = Object.freeze({
        ...bindingEnvelope(this.binding),
        portalSessionNonce: this.#newNonce(),
      });
      this.#hello = hello;
      this.#phase = 'hello-issued';
      return hello;
    } catch (error) {
      this.#failSession();
      throw error;
    }
  }

  createChallenge(hello: UnsignedOllamaTailnetHello): SignedOllamaTailnetChallenge {
    this.#assertActive();
    this.#assertRole('helper');
    this.#expectPhase('new');
    try {
      const value = requireExactRecord(hello, HELLO_KEYS);
      this.#assertBindingEnvelope(value);
      const portalSessionNonce = requireNonce(value.portalSessionNonce);
      const helperSessionNonce = this.#newNonce();
      const timestampMs = this.#readClock();
      const session = Object.freeze({ portalSessionNonce, helperSessionNonce });
      const key = deriveKey(
        this.#secret,
        'challenge/hmac-sha256-key',
        sessionFields(this.binding, session),
        SHA256_BYTES,
      );
      let expected: Buffer = Buffer.alloc(0);
      try {
        expected = computeHmac(
          key,
          CHALLENGE_DOMAIN,
          challengeFields(this.binding, session, timestampMs),
        );
        const challenge = Object.freeze({
          ...bindingEnvelope(this.binding),
          portalSessionNonce,
          helperSessionNonce,
          timestampMs,
          hmac: expected.toString('base64url'),
        });
        this.#session = session;
        this.#phase = 'challenge-issued';
        return challenge;
      } finally {
        key.fill(0);
        expected.fill(0);
      }
    } catch (error) {
      this.#failSession();
      throw error;
    }
  }

  verifyChallenge(
    hello: UnsignedOllamaTailnetHello,
    challenge: SignedOllamaTailnetChallenge,
  ): true {
    this.#assertActive();
    this.#assertRole('portal');
    this.#expectPhase('hello-issued');
    try {
      const helloValue = requireExactRecord(hello, HELLO_KEYS);
      const challengeValue = requireExactRecord(challenge, CHALLENGE_KEYS);
      this.#assertBindingEnvelope(helloValue);
      this.#assertBindingEnvelope(challengeValue);
      if (!this.#hello || !HELLO_KEYS.every((key) => helloValue[key] === this.#hello?.[key])) {
        return fail('SESSION_MISMATCH');
      }
      const portalSessionNonce = requireNonce(challengeValue.portalSessionNonce);
      const helperSessionNonce = requireNonce(challengeValue.helperSessionNonce);
      if (portalSessionNonce !== this.#hello.portalSessionNonce) {
        return fail('SESSION_MISMATCH');
      }
      const timestampMs = this.#requireFreshTimestamp(challengeValue.timestampMs);
      const session = Object.freeze({ portalSessionNonce, helperSessionNonce });
      const key = deriveKey(
        this.#secret,
        'challenge/hmac-sha256-key',
        sessionFields(this.binding, session),
        SHA256_BYTES,
      );
      let expected: Buffer = Buffer.alloc(0);
      try {
        expected = computeHmac(
          key,
          CHALLENGE_DOMAIN,
          challengeFields(this.binding, session, timestampMs),
        );
        if (!timingSafeMacEqual(challengeValue.hmac, expected)) {
          return fail('SIGNATURE_INVALID');
        }
      } finally {
        key.fill(0);
        expected.fill(0);
      }
      this.#session = session;
      this.#phase = 'challenge-verified';
      return true;
    } catch (error) {
      this.#failSession();
      throw error;
    }
  }

  createRequest(input: Readonly<{
    method: string;
    path: string;
    body: Uint8Array;
  }>): EncryptedOllamaTailnetRequestMessage {
    this.#assertActive();
    this.#assertRole('portal');
    this.#expectPhase('challenge-verified');
    let plaintext: Buffer = Buffer.alloc(0);
    try {
      if (!isPlainRecord(input)) return fail('ENVELOPE_MALFORMED');
      const session = this.#requireSession();
      const operation = requireOperation(input.method, input.path);
      plaintext = requireBody(input.body, operation.maxRequestBytes);
      const requestNonce = this.#newNonce();
      const timestampMs = this.#readClock();
      const requestMetadata = {
        ...session,
        method: operation.method,
        path: operation.path,
        requestNonce,
        timestampMs,
      };
      const trafficFields = [
        ...sessionFields(this.binding, session),
        ['requestNonce', requestNonce],
      ] satisfies readonly CanonicalField[];
      const key = deriveKey(
        this.#secret,
        'request/aes-256-gcm-key',
        trafficFields,
        32,
      );
      const iv = deriveKey(
        this.#secret,
        'request/aes-256-gcm-iv',
        trafficFields,
        12,
      );
      const hmacKey = deriveKey(
        this.#secret,
        'request/hmac-sha256-key',
        trafficFields,
        SHA256_BYTES,
      );
      let signature: Buffer = Buffer.alloc(0);
      try {
        const wireBody = encryptBody(
          plaintext,
          key,
          iv,
          REQUEST_AAD_DOMAIN,
          requestAadFields(this.binding, requestMetadata),
        );
        const envelopeWithoutSignature = {
          ...bindingEnvelope(this.binding),
          ...requestMetadata,
          wireBodySha256: wireBodySha256(wireBody),
        };
        signature = computeHmac(
          hmacKey,
          REQUEST_HMAC_DOMAIN,
          requestHmacFields(this.binding, envelopeWithoutSignature),
        );
        const envelope = Object.freeze({
          ...envelopeWithoutSignature,
          signature: signature.toString('base64url'),
        });
        this.#createdRequest = envelope;
        this.#phase = 'request-created';
        return Object.freeze({ envelope, wireBody });
      } finally {
        key.fill(0);
        iv.fill(0);
        hmacKey.fill(0);
        signature.fill(0);
      }
    } catch (error) {
      this.#failSession();
      throw error;
    } finally {
      plaintext.fill(0);
    }
  }

  verifyRequest(
    envelope: EncryptedOllamaTailnetRequest,
    wireBody: Uint8Array,
  ): DecryptedOllamaTailnetRequest {
    this.#assertActive();
    this.#assertRole('helper');
    this.#expectPhase('challenge-issued');
    let encrypted: Buffer = Buffer.alloc(0);
    try {
      const value = requireExactRecord(envelope, REQUEST_KEYS);
      this.#assertBindingEnvelope(value);
      const session = this.#requireSession();
      const portalSessionNonce = requireNonce(value.portalSessionNonce);
      const helperSessionNonce = requireNonce(value.helperSessionNonce);
      if (!sessionMatches({ portalSessionNonce, helperSessionNonce }, session)) {
        return fail('SESSION_MISMATCH');
      }
      const operation = requireOperation(value.method, value.path);
      const requestNonce = requireNonce(value.requestNonce);
      const timestampMs = this.#requireFreshTimestamp(value.timestampMs);
      const claimedWireHash = requireWireBodySha256(value.wireBodySha256);
      encrypted = requireWireBody(wireBody, operation.maxRequestBytes);
      const actualWireHash = wireBodySha256(encrypted);
      if (!timingSafeHexEqual(claimedWireHash, actualWireHash)) {
        return fail('WIRE_BODY_HASH_MISMATCH');
      }
      const normalized = {
        ...bindingEnvelope(this.binding),
        portalSessionNonce,
        helperSessionNonce,
        method: operation.method,
        path: operation.path,
        requestNonce,
        timestampMs,
        wireBodySha256: claimedWireHash,
        signature: typeof value.signature === 'string' ? value.signature : '',
      };
      const trafficFields = [
        ...sessionFields(this.binding, session),
        ['requestNonce', requestNonce],
      ] satisfies readonly CanonicalField[];
      const hmacKey = deriveKey(
        this.#secret,
        'request/hmac-sha256-key',
        trafficFields,
        SHA256_BYTES,
      );
      let expected: Buffer = Buffer.alloc(0);
      try {
        expected = computeHmac(
          hmacKey,
          REQUEST_HMAC_DOMAIN,
          requestHmacFields(this.binding, normalized),
        );
        if (!timingSafeMacEqual(value.signature, expected)) {
          return fail('SIGNATURE_INVALID');
        }
      } finally {
        hmacKey.fill(0);
        expected.fill(0);
      }
      const key = deriveKey(
        this.#secret,
        'request/aes-256-gcm-key',
        trafficFields,
        32,
      );
      const iv = deriveKey(
        this.#secret,
        'request/aes-256-gcm-iv',
        trafficFields,
        12,
      );
      let body: Buffer;
      try {
        body = decryptBody(
          encrypted,
          key,
          iv,
          REQUEST_AAD_DOMAIN,
          requestAadFields(this.binding, normalized),
        );
      } finally {
        key.fill(0);
        iv.fill(0);
      }
      const receipt = Object.freeze(Object.create(null)) as VerifiedOllamaTailnetRequest;
      const frozenEnvelope = Object.freeze(normalized);
      this.#verifiedRequests.set(receipt, {
        envelope: frozenEnvelope,
        operation,
        body,
      });
      this.#ownedHelperBodies.add(body);
      this.#activeReceipt = receipt;
      this.#phase = 'request-verified';
      return Object.freeze({ request: receipt, body });
    } catch (error) {
      this.#failSession();
      throw error;
    } finally {
      encrypted.fill(0);
    }
  }

  createResponse(input: Readonly<{
    request: VerifiedOllamaTailnetRequest;
    status: number;
    body: Uint8Array;
  }>): EncryptedOllamaTailnetResponseMessage {
    this.#assertActive();
    this.#assertRole('helper');
    this.#expectPhase('request-verified');
    let plaintext: Buffer = Buffer.alloc(0);
    let metadata: VerifiedRequestMetadata | undefined;
    try {
      if (!isPlainRecord(input) || !isPlainRecord(input.request)) {
        return fail('VERIFIED_REQUEST_REQUIRED');
      }
      metadata = this.#verifiedRequests.get(input.request);
      if (!metadata || input.request !== this.#activeReceipt) {
        return fail('VERIFIED_REQUEST_REQUIRED');
      }
      const status = requireStatus(input.status);
      plaintext = requireBody(input.body, metadata.operation.maxResponseBytes);
      const timestampMs = this.#readClock();
      const request = metadata.envelope;
      const responseMetadata = {
        portalSessionNonce: request.portalSessionNonce,
        helperSessionNonce: request.helperSessionNonce,
        requestMethod: request.method,
        requestPath: request.path,
        requestTimestampMs: request.timestampMs,
        requestNonce: request.requestNonce,
        requestWireBodySha256: request.wireBodySha256,
        status,
        timestampMs,
      };
      const session = this.#requireSession();
      const trafficFields = [
        ...sessionFields(this.binding, session),
        ['requestNonce', request.requestNonce],
      ] satisfies readonly CanonicalField[];
      const key = deriveKey(
        this.#secret,
        'response/aes-256-gcm-key',
        trafficFields,
        32,
      );
      const iv = deriveKey(
        this.#secret,
        'response/aes-256-gcm-iv',
        trafficFields,
        12,
      );
      const hmacKey = deriveKey(
        this.#secret,
        'response/hmac-sha256-key',
        trafficFields,
        SHA256_BYTES,
      );
      let signature: Buffer = Buffer.alloc(0);
      try {
        const responseWireBody = encryptBody(
          plaintext,
          key,
          iv,
          RESPONSE_AAD_DOMAIN,
          responseAadFields(this.binding, responseMetadata),
        );
        const envelopeWithoutSignature = {
          ...bindingEnvelope(this.binding),
          ...responseMetadata,
          wireBodySha256: wireBodySha256(responseWireBody),
        };
        signature = computeHmac(
          hmacKey,
          RESPONSE_HMAC_DOMAIN,
          responseHmacFields(this.binding, envelopeWithoutSignature),
        );
        const responseEnvelope = Object.freeze({
          ...envelopeWithoutSignature,
          signature: signature.toString('base64url'),
        });
        this.#phase = 'response-created';
        return Object.freeze({
          envelope: responseEnvelope,
          wireBody: responseWireBody,
        });
      } finally {
        key.fill(0);
        iv.fill(0);
        hmacKey.fill(0);
        signature.fill(0);
      }
    } catch (error) {
      this.#failSession();
      throw error;
    } finally {
      plaintext.fill(0);
      if (metadata) {
        metadata.body.fill(0);
        this.#ownedHelperBodies.delete(metadata.body);
      }
    }
  }

  verifyResponse(input: Readonly<{
    request: EncryptedOllamaTailnetRequest;
    response: EncryptedOllamaTailnetResponse;
    wireBody: Uint8Array;
  }>): Buffer {
    this.#assertActive();
    this.#assertRole('portal');
    this.#expectPhase('request-created');
    let encrypted: Buffer = Buffer.alloc(0);
    try {
      if (!isPlainRecord(input)) return fail('ENVELOPE_MALFORMED');
      const requestValue = requireExactRecord(input.request, REQUEST_KEYS);
      const responseValue = requireExactRecord(input.response, RESPONSE_KEYS);
      this.#assertBindingEnvelope(requestValue);
      this.#assertBindingEnvelope(responseValue);
      if (
        !this.#createdRequest
        || !requestMatches(
          requestValue as unknown as EncryptedOllamaTailnetRequest,
          this.#createdRequest,
        )
      ) {
        return fail('SESSION_MISMATCH');
      }
      const session = this.#requireSession();
      const portalSessionNonce = requireNonce(responseValue.portalSessionNonce);
      const helperSessionNonce = requireNonce(responseValue.helperSessionNonce);
      if (!sessionMatches({ portalSessionNonce, helperSessionNonce }, session)) {
        return fail('SESSION_MISMATCH');
      }
      const request = this.#createdRequest;
      if (
        responseValue.requestMethod !== request.method
        || responseValue.requestPath !== request.path
        || responseValue.requestTimestampMs !== request.timestampMs
        || responseValue.requestNonce !== request.requestNonce
        || responseValue.requestWireBodySha256 !== request.wireBodySha256
      ) {
        return fail('SESSION_MISMATCH');
      }
      const operation = requireOperation(
        responseValue.requestMethod,
        responseValue.requestPath,
      );
      const requestTimestampMs = this.#requireTimestamp(responseValue.requestTimestampMs);
      const requestNonce = requireNonce(responseValue.requestNonce);
      const requestWireBodySha256 = requireWireBodySha256(
        responseValue.requestWireBodySha256,
      );
      const status = requireStatus(responseValue.status);
      const timestampMs = this.#requireFreshTimestamp(responseValue.timestampMs);
      const claimedWireHash = requireWireBodySha256(responseValue.wireBodySha256);
      encrypted = requireWireBody(input.wireBody, operation.maxResponseBytes);
      const actualWireHash = wireBodySha256(encrypted);
      if (!timingSafeHexEqual(claimedWireHash, actualWireHash)) {
        return fail('WIRE_BODY_HASH_MISMATCH');
      }
      const normalized = {
        ...bindingEnvelope(this.binding),
        portalSessionNonce,
        helperSessionNonce,
        requestMethod: operation.method,
        requestPath: operation.path,
        requestTimestampMs,
        requestNonce,
        requestWireBodySha256,
        status,
        timestampMs,
        wireBodySha256: claimedWireHash,
        signature: typeof responseValue.signature === 'string'
          ? responseValue.signature
          : '',
      };
      const trafficFields = [
        ...sessionFields(this.binding, session),
        ['requestNonce', requestNonce],
      ] satisfies readonly CanonicalField[];
      const hmacKey = deriveKey(
        this.#secret,
        'response/hmac-sha256-key',
        trafficFields,
        SHA256_BYTES,
      );
      let expected: Buffer = Buffer.alloc(0);
      try {
        expected = computeHmac(
          hmacKey,
          RESPONSE_HMAC_DOMAIN,
          responseHmacFields(this.binding, normalized),
        );
        if (!timingSafeMacEqual(responseValue.signature, expected)) {
          return fail('SIGNATURE_INVALID');
        }
      } finally {
        hmacKey.fill(0);
        expected.fill(0);
      }
      const key = deriveKey(
        this.#secret,
        'response/aes-256-gcm-key',
        trafficFields,
        32,
      );
      const iv = deriveKey(
        this.#secret,
        'response/aes-256-gcm-iv',
        trafficFields,
        12,
      );
      try {
        const plaintext = decryptBody(
          encrypted,
          key,
          iv,
          RESPONSE_AAD_DOMAIN,
          responseAadFields(this.binding, normalized),
        );
        this.#phase = 'response-verified';
        return plaintext;
      } finally {
        key.fill(0);
        iv.fill(0);
      }
    } catch (error) {
      this.#failSession();
      throw error;
    } finally {
      encrypted.fill(0);
    }
  }

  #assertActive(): void {
    if (this.#disposed) return fail('DISPOSED');
  }

  #assertRole(expected: OllamaTailnetProtocolRole): void {
    if (this.role !== expected) return fail('ROLE_MISMATCH');
  }

  #expectPhase(expected: ProtocolPhase): void {
    if (this.#phase === expected) return;
    this.#failSession();
    return fail('SESSION_STATE_INVALID');
  }

  #failSession(): void {
    this.#phase = 'failed';
    for (const body of this.#ownedHelperBodies) body.fill(0);
    this.#ownedHelperBodies.clear();
  }

  #assertBindingEnvelope(envelope: Partial<BindingEnvelope>): void {
    if (!envelopeMatchesBinding(envelope, this.binding)) return fail('BINDING_MISMATCH');
  }

  #requireSession(): Session {
    if (!this.#session) return fail('SESSION_STATE_INVALID');
    return this.#session;
  }

  #readClock(): number {
    let value: number;
    try {
      value = this.#now();
    } catch {
      return fail('TIMESTAMP_INVALID');
    }
    if (!Number.isSafeInteger(value) || value < 0) return fail('TIMESTAMP_INVALID');
    return value;
  }

  #requireTimestamp(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      return fail('TIMESTAMP_INVALID');
    }
    return value as number;
  }

  #requireFreshTimestamp(value: unknown): number {
    const timestampMs = this.#requireTimestamp(value);
    const nowMs = this.#readClock();
    if (timestampMs < nowMs - OLLAMA_TAILNET_MAX_PAST_SKEW_MS) {
      return fail('TIMESTAMP_STALE');
    }
    if (timestampMs > nowMs + OLLAMA_TAILNET_MAX_FUTURE_SKEW_MS) {
      return fail('TIMESTAMP_FUTURE');
    }
    return timestampMs;
  }

  #newNonce(): string {
    let value: Uint8Array;
    try {
      value = this.#randomBytes(OLLAMA_TAILNET_NONCE_BYTES);
    } catch {
      return fail('RANDOM_SOURCE_INVALID');
    }
    if (!(value instanceof Uint8Array) || value.byteLength !== OLLAMA_TAILNET_NONCE_BYTES) {
      return fail('RANDOM_SOURCE_INVALID');
    }
    const owned = Buffer.from(value);
    try {
      return owned.toString('base64url');
    } finally {
      owned.fill(0);
    }
  }
}
