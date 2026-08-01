import jwt from 'jsonwebtoken';
import { issueFileCapabilityToken, verifyFileCapabilityToken } from '../services/fileCapabilityToken';

describe('direct file capability tokens', () => {
  const secret = 'test-secret-that-is-long-enough-for-hmac';

  test('binds a short-lived token to one file and issuing actor without exposing an owner id', () => {
    const token = issueFileCapabilityToken('file-1', 'actor-1', 7, secret);
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.sub).toBe('file-1');
    expect(decoded.actorUserId).toBe('actor-1');
    expect(decoded.authorizationVersion).toBe(7);
    expect(decoded).not.toHaveProperty('ownerId');
    expect(decoded.exp! - decoded.iat!).toBe(10 * 60);
    expect(verifyFileCapabilityToken(token, 'file-1', secret)).toEqual({
      fileId: 'file-1',
      actorUserId: 'actor-1',
      authorizationVersion: 7,
    });
    expect(verifyFileCapabilityToken(token, 'file-2', secret)).toBeNull();
  });

  test('rejects altered, wrong-secret, wrong-algorithm, and oversized tokens', () => {
    const token = issueFileCapabilityToken('file-1', 'actor-1', 1, secret);
    expect(verifyFileCapabilityToken(`${token}x`, 'file-1', secret)).toBeNull();
    expect(verifyFileCapabilityToken(token, 'file-1', 'other-secret')).toBeNull();
    const noneToken = jwt.sign({ purpose: 'file-direct-content', sub: 'file-1' }, '', { algorithm: 'none' });
    expect(verifyFileCapabilityToken(noneToken, 'file-1', secret)).toBeNull();
    const longLived = jwt.sign(
      { purpose: 'file-direct-content', sub: 'file-1', actorUserId: 'actor-1' },
      secret,
      { algorithm: 'HS256', audience: 'portal-file-tool', issuer: 'bridgesllm-portal', expiresIn: '1h' },
    );
    expect(verifyFileCapabilityToken(longLived, 'file-1', secret)).toBeNull();
    expect(verifyFileCapabilityToken('x'.repeat(4097), 'file-1', secret)).toBeNull();
  });

  test('rejects legacy tokens that are not bound to an authorization generation', () => {
    const legacy = jwt.sign(
      { purpose: 'file-direct-content', actorUserId: 'actor-1' },
      secret,
      {
        algorithm: 'HS256',
        audience: 'portal-file-tool',
        issuer: 'bridgesllm-portal',
        subject: 'file-1',
        expiresIn: '10m',
      },
    );
    expect(verifyFileCapabilityToken(legacy, 'file-1', secret)).toBeNull();
  });
});
