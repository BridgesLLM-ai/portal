import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureRuntimeDirectory } from './runtimeDirectory';

export interface DeviceIdentityStorageOptions {
  deviceKeysPath?: string;
  portalRoot?: string;
}

// Store in portal projects dir — persistent rw volume mount.
export function resolveDeviceKeysPath(options: DeviceIdentityStorageOptions = {}): string {
  const portalRoot = path.resolve(
    options.portalRoot || process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal',
  );
  const projectsRoot = options.portalRoot
    ? path.join(portalRoot, 'projects')
    : path.resolve(process.env.PORTAL_PROJECTS_ROOT || path.join(portalRoot, 'projects'));
  return path.resolve(
    options.deviceKeysPath
      || process.env.PORTAL_DEVICE_KEYS_PATH
      || path.join(projectsRoot, '.openclaw-portal-device.json'),
  );
}

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

function generateDeviceKeys(filePath: string): DeviceKeys {
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

  const parent = ensureRuntimeDirectory(path.dirname(filePath), { mode: 0o700 });
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(keys, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
  return keys;
}

export function getOrCreateDeviceKeys(options: DeviceIdentityStorageOptions = {}): DeviceKeys {
  const deviceKeysPath = resolveDeviceKeysPath(options);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(deviceKeysPath);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Gateway device key path is not a regular file');
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(deviceKeysPath, 'utf8'));
      if (isValidDeviceKeys(parsed)) {
        fs.chmodSync(deviceKeysPath, 0o600);
        return parsed;
      }
      console.warn('[Gateway RPC] Device key file invalid, regenerating keys');
    } catch (error: any) {
      console.warn(`[Gateway RPC] Failed to read device key file, regenerating keys: ${error?.message || error}`);
    }
  }

  const keys = generateDeviceKeys(deviceKeysPath);
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
