/**
 * Named App credentials: limits, names and value rules shared by every entry
 * path (Owner API, root import CLI) and by the runtime projection.
 *
 * A credential is opaque UTF-8 text the App reads from a read-only file at
 * /portal/credentials/<slot> in its own resident container. Nothing here
 * imports the database, so the workload runtime can depend on it.
 */
export const APP_CREDENTIAL_SLOT_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const APP_CREDENTIAL_MAX_BYTES = 64 * 1024;
export const APP_CREDENTIAL_MAX_SLOTS = 16;
export const APP_CREDENTIALS_CONTAINER_DIRECTORY = '/portal/credentials';
export const APP_CREDENTIALS_ENVIRONMENT_KEY = 'PORTAL_CREDENTIALS_DIR';
/** App primary keys are Prisma UUIDs. */
export const APP_CREDENTIAL_APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AppCredentialErrorCode =
  | 'APP_CREDENTIAL_INVALID'
  | 'APP_CREDENTIAL_TOO_LARGE'
  | 'APP_CREDENTIAL_LIMIT'
  | 'APP_CREDENTIAL_APP_NOT_FOUND'
  | 'APP_CREDENTIAL_NOT_FOUND'
  | 'APP_CREDENTIAL_CONFLICT'
  | 'APP_CREDENTIAL_UNREADABLE'
  | 'APP_CREDENTIAL_PROJECTION_UNAVAILABLE';

/** Messages are safe to show: they name slots and limits, never values. */
export class AppCredentialError extends Error {
  constructor(
    readonly code: AppCredentialErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AppCredentialError';
  }

  toPublicJSON(): { code: AppCredentialErrorCode; error: string } {
    return { code: this.code, error: this.message };
  }
}

export function isAppCredentialSlot(value: unknown): value is string {
  return typeof value === 'string' && APP_CREDENTIAL_SLOT_PATTERN.test(value);
}

export function requireAppCredentialSlot(value: unknown): string {
  if (!isAppCredentialSlot(value)) {
    throw new AppCredentialError(
      'APP_CREDENTIAL_INVALID',
      'A credential name starts with a lowercase letter and uses only lowercase letters, digits and hyphens (at most 63 characters).',
      400,
    );
  }
  return value;
}

export function requireAppCredentialAppId(value: unknown): string {
  if (typeof value !== 'string' || !APP_CREDENTIAL_APP_ID_PATTERN.test(value)) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'A Project App ID is required.', 400);
  }
  return value;
}

function sizeError(): AppCredentialError {
  return new AppCredentialError(
    'APP_CREDENTIAL_TOO_LARGE',
    `A credential value is at most ${APP_CREDENTIAL_MAX_BYTES} bytes.`,
    413,
  );
}

/** Validate a value supplied as text (Owner API). */
export function requireAppCredentialValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'Enter a credential value.', 400);
  }
  if (value.length > APP_CREDENTIAL_MAX_BYTES) throw sizeError();
  const bytes = Buffer.from(value, 'utf8');
  // Lone surrogates do not survive UTF-8 encoding; refuse instead of altering.
  if (bytes.toString('utf8') !== value) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'A credential value must be valid UTF-8 text.', 400);
  }
  return decodeAppCredentialBytes(bytes);
}

/** Validate a value supplied as bytes (operator import) and return its text. */
export function decodeAppCredentialBytes(bytes: Buffer): string {
  if (bytes.length === 0) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'A credential value cannot be empty.', 400);
  }
  if (bytes.length > APP_CREDENTIAL_MAX_BYTES) throw sizeError();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'A credential value must be valid UTF-8 text.', 400);
  }
  if (text.includes('\0')) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'A credential value cannot contain NUL characters.', 400);
  }
  return text;
}
