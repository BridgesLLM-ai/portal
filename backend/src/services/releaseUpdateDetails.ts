import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

export const RELEASE_CLASS_VALUES = ['hotfix', 'security', 'feature', 'maintenance'] as const;
export type ReleaseClass = typeof RELEASE_CLASS_VALUES[number];

export type VerifiedReleaseDetails = {
  version: string;
  releasedAt: string;
  releaseClass: ReleaseClass;
  highlights: string[];
  provenance: 'signed-release-manifest';
};

export type SignedReleaseEvidence = {
  manifest: string;
  signature: string;
};

const RELEASE_ORIGIN = 'https://bridgesllm.ai';
const RELEASE_PUBLIC_KEY_SHA256 = '72aec2acf2c350dcb4a98104320c3deb522e7fd016c072966327d342897000cc';
const RELEASE_PUBLIC_KEY_PATH = path.resolve(
  __dirname,
  '../../../installer/release-signing-ed25519.pub.pem',
);
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 4096;
const MAX_EVIDENCE_BYTES = 32 * 1024;
const MAX_HIGHLIGHTS = 5;
const MAX_HIGHLIGHT_CHARS = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
}

function parseReleaseDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function decodeHighlights(value: string): string[] | null {
  if (!value || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  if (decoded.toString('base64url') !== value || decoded.byteLength > 4096) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_HIGHLIGHTS) return null;
  const highlights: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string'
      || entry !== entry.trim()
      || Array.from(entry).length < 1
      || Array.from(entry).length > MAX_HIGHLIGHT_CHARS
      || /[\u0000-\u001f\u007f]/.test(entry)) {
      return null;
    }
    highlights.push(entry);
  }
  return new Set(highlights).size === highlights.length ? highlights : null;
}

function parseManifest(raw: Buffer, expectedVersion: string): VerifiedReleaseDetails | null {
  if (raw.byteLength < 1 || raw.byteLength > MAX_MANIFEST_BYTES || raw.includes(0) || raw.includes(13)) {
    return null;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 1 || lines.some((line) => !line)) return null;

  const values = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) return null;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (values.has(key)) return null;
    values.set(key, value);
  }

  const required = new Set([
    'schema',
    'version',
    'artifact',
    'sha256',
    'size',
    'released',
    'release_class',
    'highlights',
  ]);
  if (values.size !== required.size || Array.from(values.keys()).some((key) => !required.has(key))) {
    return null;
  }
  if (values.get('schema') !== '2'
    || values.get('version') !== expectedVersion
    || values.get('artifact') !== 'portal.tar.gz'
    || !/^[0-9a-f]{64}$/.test(values.get('sha256') || '')
    || !/^[1-9][0-9]{0,8}$/.test(values.get('size') || '')
    || Number(values.get('size')) > 536_870_912) {
    return null;
  }

  const releasedAt = parseReleaseDate(values.get('released') || '');
  const releaseClass = values.get('release_class') as ReleaseClass;
  const highlights = decodeHighlights(values.get('highlights') || '');
  if (!releasedAt || !RELEASE_CLASS_VALUES.includes(releaseClass) || !highlights) return null;

  return {
    version: expectedVersion,
    releasedAt,
    releaseClass,
    highlights,
    provenance: 'signed-release-manifest',
  };
}

function trustedReleasePublicKey(): crypto.KeyObject | null {
  try {
    const key = crypto.createPublicKey(fs.readFileSync(RELEASE_PUBLIC_KEY_PATH));
    const fingerprint = crypto.createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    return fingerprint === RELEASE_PUBLIC_KEY_SHA256 ? key : null;
  } catch {
    return null;
  }
}

export function verifySignedReleaseDetails(
  manifest: Buffer,
  signature: Buffer,
  expectedVersion: string,
  trustRoot: { publicKey: crypto.KeyLike; expectedPublicKeySha256: string } | null = null,
): VerifiedReleaseDetails | null {
  if (!isReleaseVersion(expectedVersion)
    || signature.byteLength !== 64
    || signature.byteLength > MAX_SIGNATURE_BYTES) {
    return null;
  }

  let key: crypto.KeyObject | null;
  if (trustRoot) {
    try {
      key = trustRoot.publicKey instanceof crypto.KeyObject
        ? trustRoot.publicKey
        : crypto.createPublicKey(trustRoot.publicKey);
      if (key.type !== 'public') return null;
      const fingerprint = crypto.createHash('sha256')
        .update(key.export({ type: 'spki', format: 'der' }))
        .digest('hex');
      if (fingerprint !== trustRoot.expectedPublicKeySha256) return null;
    } catch {
      return null;
    }
  } else {
    key = trustedReleasePublicKey();
  }
  if (!key || !crypto.verify(null, manifest, key, signature)) return null;
  return parseManifest(manifest, expectedVersion);
}

export function encodeSignedReleaseEvidence(manifest: Buffer, signature: Buffer): string | null {
  if (manifest.byteLength < 1 || manifest.byteLength > MAX_MANIFEST_BYTES || signature.byteLength !== 64) {
    return null;
  }
  const encoded = JSON.stringify({
    manifest: manifest.toString('base64url'),
    signature: signature.toString('base64url'),
  } satisfies SignedReleaseEvidence);
  return Buffer.byteLength(encoded, 'utf8') <= MAX_EVIDENCE_BYTES ? encoded : null;
}

export function verifyStoredReleaseEvidence(
  raw: string | null,
  expectedVersion: string,
  trustRoot: { publicKey: crypto.KeyLike; expectedPublicKeySha256: string } | null = null,
): VerifiedReleaseDetails | null {
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_EVIDENCE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)
    || Object.keys(parsed).length !== 2
    || typeof parsed.manifest !== 'string'
    || typeof parsed.signature !== 'string') {
    return null;
  }
  try {
    const manifest = Buffer.from(parsed.manifest, 'base64url');
    const signature = Buffer.from(parsed.signature, 'base64url');
    if (manifest.toString('base64url') !== parsed.manifest
      || signature.toString('base64url') !== parsed.signature) {
      return null;
    }
    return verifySignedReleaseDetails(manifest, signature, expectedVersion, trustRoot);
  } catch {
    return null;
  }
}

export async function fetchSignedReleaseDetails(version: string): Promise<{
  details: VerifiedReleaseDetails;
  evidence: string;
} | null> {
  if (!isReleaseVersion(version)) return null;
  const baseUrl = `${RELEASE_ORIGIN}/releases/${version}`;
  try {
    const [manifestResponse, signatureResponse] = await Promise.all([
      axios.get<ArrayBuffer>(`${baseUrl}/portal-release.manifest`, {
        responseType: 'arraybuffer',
        timeout: 5000,
        maxContentLength: MAX_MANIFEST_BYTES,
        maxBodyLength: MAX_MANIFEST_BYTES,
        maxRedirects: 0,
      }),
      axios.get<ArrayBuffer>(`${baseUrl}/portal-release.sig`, {
        responseType: 'arraybuffer',
        timeout: 5000,
        maxContentLength: MAX_SIGNATURE_BYTES,
        maxBodyLength: MAX_SIGNATURE_BYTES,
        maxRedirects: 0,
      }),
    ]);
    const manifest = Buffer.from(manifestResponse.data);
    const signature = Buffer.from(signatureResponse.data);
    const details = verifySignedReleaseDetails(manifest, signature, version);
    const evidence = details ? encodeSignedReleaseEvidence(manifest, signature) : null;
    return details && evidence ? { details, evidence } : null;
  } catch {
    return null;
  }
}
