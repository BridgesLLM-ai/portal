import crypto from 'crypto';
import { config } from '../config/env';

const ENCRYPTED_PREFIX = 'portal-secret:v1:';
const TOKEN_DIGEST_PREFIX = 'portal-token:v1:';
const IV_BYTES = 12;

function rootSecret(): string {
  const configured = process.env.PORTAL_ENCRYPTION_KEY?.trim();
  return configured || config.jwtSecret;
}

function deriveKey(purpose: string): Buffer {
  return crypto
    .createHmac('sha256', rootSecret())
    .update(`bridgesllm:${purpose}:v1`, 'utf8')
    .digest();
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt an application secret with authenticated encryption. Existing v1
 * ciphertext is returned unchanged so startup backfills are idempotent.
 */
export function encryptPlaintextSecret(value: string): string {
  if (!value) return value;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('stored-secret'), iv);
  cipher.setAAD(Buffer.from(ENCRYPTED_PREFIX, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function encryptSecret(value: string): string {
  return isEncryptedSecret(value) ? value : encryptPlaintextSecret(value);
}

/**
 * Decrypt a stored secret. Plaintext is accepted only for forward-compatible
 * startup backfill of pre-4.0 rows. Malformed/authentication-failed ciphertext
 * throws so callers fail closed instead of passing garbage to another service.
 */
export function decryptSecret(value: string): string {
  if (!value || !isEncryptedSecret(value)) return value;

  const encoded = value.slice(ENCRYPTED_PREFIX.length);
  const parts = encoded.split('.');
  if (parts.length !== 3) throw new Error('Stored secret has an invalid encrypted format');

  const [ivPart, tagPart, ciphertextPart] = parts;
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error('Stored secret has invalid encryption parameters');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('stored-secret'), iv);
    decipher.setAAD(Buffer.from(ENCRYPTED_PREFIX, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Stored secret could not be authenticated with the configured Portal encryption key');
  }
}

/**
 * Deterministic, keyed token digest used for indexed lookup. Unlike bcrypt it
 * avoids table scans; unlike a bare SHA digest it remains resistant to offline
 * guessing when the database is obtained without the Portal application key.
 */
export function digestAuthToken(purpose: string, token: string): string {
  const digest = crypto
    .createHmac('sha256', deriveKey(`token:${purpose}`))
    .update(token, 'utf8')
    .digest('base64url');
  return `${TOKEN_DIGEST_PREFIX}${purpose}:${digest}`;
}
