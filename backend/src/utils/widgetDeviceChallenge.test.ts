import * as crypto from 'crypto';
import { buildSignedDevice, validateGatewayChallenge } from './deviceIdentity';

test('widget challenge requires a bounded nonce and fresh server timestamp', () => {
  const now = Date.now(); const challenge = { nonce: 'synthetic-challenge-nonce', ts: now };
  expect(validateGatewayChallenge(challenge, now)).toEqual(challenge);
  for (const invalid of [{ ...challenge, ts: now - 6 * 60000 }, { ...challenge, ts: now + 6 * 60000 },
    { ...challenge, ts: 1.5 }, { ...challenge, nonce: 'short' }, { ...challenge, nonce: 'x'.repeat(513) },
    { ...challenge, nonce: 'synthetic-nonce\ncontrol' }]) expect(() => validateGatewayChallenge(invalid, now)).toThrow();
});
test('device proof signs the validated native timestamp, nonce, role and exact scopes', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' }); const privateJwk = privateKey.export({ format: 'jwk' });
  const keys = { deviceId: 'synthetic-device', publicKey: publicJwk.x!, privateKey: privateJwk.d! };
  const nonce = 'synthetic-challenge-nonce'; const signedAt = Date.now() - 1000;
  const scopes = ['operator.read'];
  const proof = buildSignedDevice({ keys, clientId: 'webchat', clientMode: 'webchat', role: 'operator', scopes,
    token: 'synthetic-token', nonce, signedAt });
  const payload = ['v2', keys.deviceId, 'webchat', 'webchat', 'operator', scopes.join(','), String(signedAt), 'synthetic-token', nonce].join('|');
  expect(proof.signedAt).toBe(signedAt);
  expect(crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(proof.signature, 'base64url'))).toBe(true);
  expect(() => buildSignedDevice({ keys, clientId: 'webchat', clientMode: 'webchat', role: 'operator', scopes, token: '', signedAt: NaN })).toThrow();
});
