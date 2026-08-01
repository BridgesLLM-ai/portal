import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export const FILE_CAPABILITY_PURPOSE = 'file-direct-content';
const FILE_CAPABILITY_AUDIENCE = 'portal-file-tool';
const FILE_CAPABILITY_ISSUER = 'bridgesllm-portal';

export interface FileCapabilityClaims {
  fileId: string;
  actorUserId: string;
  authorizationVersion: number;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function issueFileCapabilityToken(
  fileId: string,
  actorUserId: string,
  authorizationVersion: number,
  secret: string,
): string {
  if (!validOpaqueId(fileId)
    || !validOpaqueId(actorUserId)
    || !Number.isSafeInteger(authorizationVersion)
    || authorizationVersion < 1
    || !secret) {
    throw new Error('fileId, actorUserId, authorizationVersion, and signing secret are required');
  }
  return jwt.sign(
    { purpose: FILE_CAPABILITY_PURPOSE, actorUserId, authorizationVersion },
    secret,
    {
      algorithm: 'HS256',
      audience: FILE_CAPABILITY_AUDIENCE,
      expiresIn: '10m',
      issuer: FILE_CAPABILITY_ISSUER,
      jwtid: crypto.randomBytes(16).toString('hex'),
      subject: fileId,
    },
  );
}

export function verifyFileCapabilityToken(
  token: string,
  expectedFileId: string,
  secret: string,
): FileCapabilityClaims | null {
  if (!token || token.length > 4096 || !validOpaqueId(expectedFileId) || !secret) return null;
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: FILE_CAPABILITY_AUDIENCE,
      issuer: FILE_CAPABILITY_ISSUER,
    });
    const valid = typeof payload !== 'string'
      && payload.purpose === FILE_CAPABILITY_PURPOSE
      && payload.sub === expectedFileId
      && validOpaqueId(payload.actorUserId)
      && Number.isSafeInteger(payload.authorizationVersion)
      && Number(payload.authorizationVersion) >= 1
      && Number.isInteger(payload.iat)
      && Number.isInteger(payload.exp)
      && Number(payload.exp) > Number(payload.iat)
      && Number(payload.exp) - Number(payload.iat) <= 10 * 60;
    return valid
      ? {
          fileId: expectedFileId,
          actorUserId: String(payload.actorUserId),
          authorizationVersion: Number(payload.authorizationVersion),
        }
      : null;
  } catch {
    return null;
  }
}
