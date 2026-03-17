import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Store in portal projects dir — persistent rw volume mount
const DEVICE_KEYS_PATH = path.join(process.env.PORTAL_ROOT || '/portal', 'projects/.openclaw-portal-device.json');

export interface DeviceKeys {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

export interface BuildSignedDeviceParams {
  keys: DeviceKeys;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  token: string;
  nonce?: string;
}

export interface SignedDevicePayload {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce?: string;
}

interface Ed25519Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d?: string;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isValidDeviceKeys(value: any): value is DeviceKeys {
  return Boolean(
    value
      && typeof value.deviceId === 'string'
      && typeof value.publicKey === 'string'
      && typeof value.privateKey === 'string'
      && value.deviceId.length > 0
      && value.publicKey.length > 0
      && value.privateKey.length > 0,
  );
}

function toBase64Url(input: Buffer): string {
  return input.toString('base64url');
}

function fromBase64Url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function buildDeviceIdFromPublicKey(publicKeyB64Url: string): string {
  const pub = fromBase64Url(publicKeyB64Url);
  return crypto.createHash('sha256').update(pub).digest('hex');
}

function generateDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  const publicJwk = publicKey.export({ format: 'jwk' }) as Ed25519Jwk;
  const privateJwk = privateKey.export({ format: 'jwk' }) as Ed25519Jwk;

  if (!publicJwk.x || !privateJwk.d) {
    throw new Error('Failed to export Ed25519 keys as JWK');
  }

  const keys: DeviceKeys = {
    deviceId: buildDeviceIdFromPublicKey(publicJwk.x),
    publicKey: publicJwk.x,
    privateKey: privateJwk.d,
  };

  ensureParentDir(DEVICE_KEYS_PATH);
  fs.writeFileSync(DEVICE_KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

export function getOrCreateDeviceKeys(): DeviceKeys {
  try {
    if (fs.existsSync(DEVICE_KEYS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DEVICE_KEYS_PATH, 'utf8'));
      if (isValidDeviceKeys(parsed)) {
        return parsed;
      }
      console.warn('[Gateway RPC] Device key file invalid, regenerating keys');
    }
  } catch (error: any) {
    console.warn(`[Gateway RPC] Failed to read device key file, regenerating keys: ${error?.message || error}`);
  }

  const keys = generateDeviceKeys();
  console.log(`[Gateway RPC] Generated portal device identity: ${keys.deviceId}`);
  return keys;
}

export function buildSignedDevice(params: BuildSignedDeviceParams): SignedDevicePayload {
  const { keys, clientId, clientMode, role, scopes, token, nonce } = params;
  const signedAt = Date.now();

  // Must match gateway's buildDeviceAuthPayload format exactly
  const version = nonce ? 'v2' : 'v1';
  const parts = [
    version,
    keys.deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAt),
    token,
  ];
  if (version === 'v2') parts.push(nonce ?? '');
  const payload = parts.join('|');

  const privateKey = crypto.createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: keys.publicKey,
      d: keys.privateKey,
    },
    format: 'jwk',
  });

  const signature = crypto.sign(null, Buffer.from(payload), privateKey);

  return {
    id: keys.deviceId,
    publicKey: keys.publicKey,
    signature: toBase64Url(signature),
    signedAt,
    ...(nonce ? { nonce } : {}),
  };
}
