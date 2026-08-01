import jwt from 'jsonwebtoken';
import {
  issueMailAttachmentCapabilityToken,
  verifyMailAttachmentCapabilityToken,
} from '../services/mailAttachmentCapability';

describe('mail attachment capability tokens', () => {
  const secret = 'mail-attachment-test-secret-that-is-long-enough';
  const attachment = {
    actorId: 'user-1',
    accountUser: 'alice',
    blobId: 'blob-1',
    filename: 'quarterly report.pdf',
    contentType: 'application/pdf',
  };

  test('binds metadata to the actor, mailbox, and blob for ten minutes', () => {
    const token = issueMailAttachmentCapabilityToken(attachment, secret);
    const decoded = jwt.decode(token) as jwt.JwtPayload;

    expect(decoded.exp! - decoded.iat!).toBe(10 * 60);
    expect(verifyMailAttachmentCapabilityToken(token, attachment, secret)).toEqual({
      filename: attachment.filename,
      contentType: attachment.contentType,
    });
  });

  test('rejects cross-user, cross-mailbox, cross-blob, altered, and oversized tokens', () => {
    const token = issueMailAttachmentCapabilityToken(attachment, secret);
    expect(verifyMailAttachmentCapabilityToken(token, { ...attachment, actorId: 'user-2' }, secret)).toBeNull();
    expect(verifyMailAttachmentCapabilityToken(token, { ...attachment, accountUser: 'support' }, secret)).toBeNull();
    expect(verifyMailAttachmentCapabilityToken(token, { ...attachment, blobId: 'blob-2' }, secret)).toBeNull();
    expect(verifyMailAttachmentCapabilityToken(`${token}x`, attachment, secret)).toBeNull();
    expect(verifyMailAttachmentCapabilityToken('x'.repeat(8193), attachment, secret)).toBeNull();
  });

  test('rejects unsigned and excessive-lifetime tokens', () => {
    const unsigned = jwt.sign({ ...attachment, purpose: 'mail-attachment-access' }, '', { algorithm: 'none' });
    const longLived = jwt.sign(
      { ...attachment, purpose: 'mail-attachment-access' },
      secret,
      {
        algorithm: 'HS256',
        audience: 'portal-mail-attachment',
        issuer: 'bridgesllm-portal',
        subject: attachment.actorId,
        expiresIn: '1h',
      },
    );

    expect(verifyMailAttachmentCapabilityToken(unsigned, attachment, secret)).toBeNull();
    expect(verifyMailAttachmentCapabilityToken(longLived, attachment, secret)).toBeNull();
  });
});
