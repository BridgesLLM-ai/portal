import crypto from 'crypto';
import jwt from 'jsonwebtoken';

export const MAIL_ATTACHMENT_CAPABILITY_PURPOSE = 'mail-attachment-access';
const MAIL_ATTACHMENT_CAPABILITY_AUDIENCE = 'portal-mail-attachment';
const MAIL_ATTACHMENT_CAPABILITY_ISSUER = 'bridgesllm-portal';
const MAIL_ATTACHMENT_CAPABILITY_TTL_SECONDS = 10 * 60;

export interface MailAttachmentCapabilityInput {
  actorId: string;
  accountUser: string;
  blobId: string;
  filename: string;
  contentType: string;
}

export interface VerifiedMailAttachmentCapability {
  filename: string;
  contentType: string;
}

function validCapabilityInput(input: MailAttachmentCapabilityInput): boolean {
  return typeof input.actorId === 'string'
    && input.actorId.length > 0
    && input.actorId.length <= 512
    && typeof input.accountUser === 'string'
    && input.accountUser.length > 0
    && input.accountUser.length <= 512
    && typeof input.blobId === 'string'
    && input.blobId.length > 0
    && input.blobId.length <= 2048
    && typeof input.filename === 'string'
    && input.filename.length > 0
    && input.filename.length <= 255
    && typeof input.contentType === 'string'
    && input.contentType.length > 0
    && input.contentType.length <= 255;
}

export function issueMailAttachmentCapabilityToken(
  input: MailAttachmentCapabilityInput,
  secret: string,
): string {
  if (!secret || !validCapabilityInput(input)) {
    throw new Error('Valid attachment metadata and a signing secret are required');
  }

  return jwt.sign(
    {
      purpose: MAIL_ATTACHMENT_CAPABILITY_PURPOSE,
      actorId: input.actorId,
      accountUser: input.accountUser,
      blobId: input.blobId,
      filename: input.filename,
      contentType: input.contentType,
    },
    secret,
    {
      algorithm: 'HS256',
      audience: MAIL_ATTACHMENT_CAPABILITY_AUDIENCE,
      expiresIn: MAIL_ATTACHMENT_CAPABILITY_TTL_SECONDS,
      issuer: MAIL_ATTACHMENT_CAPABILITY_ISSUER,
      jwtid: crypto.randomBytes(16).toString('hex'),
      subject: input.actorId,
    },
  );
}

export function verifyMailAttachmentCapabilityToken(
  token: string,
  expected: Pick<MailAttachmentCapabilityInput, 'actorId' | 'accountUser' | 'blobId'>,
  secret: string,
): VerifiedMailAttachmentCapability | null {
  if (!token || token.length > 8192 || !secret || !validCapabilityInput({
    ...expected,
    filename: 'attachment',
    contentType: 'application/octet-stream',
  })) return null;

  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: MAIL_ATTACHMENT_CAPABILITY_AUDIENCE,
      issuer: MAIL_ATTACHMENT_CAPABILITY_ISSUER,
    });
    if (typeof payload === 'string'
      || payload.purpose !== MAIL_ATTACHMENT_CAPABILITY_PURPOSE
      || payload.sub !== expected.actorId
      || payload.actorId !== expected.actorId
      || payload.accountUser !== expected.accountUser
      || payload.blobId !== expected.blobId
      || typeof payload.filename !== 'string'
      || payload.filename.length < 1
      || payload.filename.length > 255
      || typeof payload.contentType !== 'string'
      || payload.contentType.length < 1
      || payload.contentType.length > 255
      || !Number.isInteger(payload.iat)
      || !Number.isInteger(payload.exp)
      || Number(payload.exp) <= Number(payload.iat)
      || Number(payload.exp) - Number(payload.iat) > MAIL_ATTACHMENT_CAPABILITY_TTL_SECONDS) {
      return null;
    }
    return {
      filename: payload.filename,
      contentType: payload.contentType,
    };
  } catch {
    return null;
  }
}
