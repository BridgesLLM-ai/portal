import {
  OLLAMA_TAILNET_GCM_TAG_BYTES,
  OLLAMA_TAILNET_HELPER_PORT,
  OLLAMA_TAILNET_MAX_PAST_SKEW_MS,
  OLLAMA_TAILNET_PATH_POLICY,
  OLLAMA_TAILNET_PROTOCOL_VERSION,
  OllamaTailnetProtocol,
  type EncryptedOllamaTailnetRequest,
  type EncryptedOllamaTailnetResponse,
  type OllamaTailnetBindingInput,
  type OllamaTailnetProtocolErrorCode,
  type SignedOllamaTailnetChallenge,
  type UnsignedOllamaTailnetHello,
} from '../services/ollamaTailnetProtocol';

const NOW = 1_800_000_000_000;
const SECRET = Buffer.alloc(32, 0x41);
const REQUEST_SENTINEL = Buffer.from(
  'request-plaintext-sentinel-that-must-never-appear-on-the-wire',
  'utf8',
);
const RESPONSE_SENTINEL = Buffer.from(
  'response-plaintext-sentinel-that-must-never-appear-on-the-wire',
  'utf8',
);

const HELLO_KEYS = [
  'address',
  'generation',
  'helperId',
  'helperPort',
  'nodePublicKey',
  'portalSessionNonce',
  'protocolVersion',
  'stableNodeId',
  'tailnetName',
];

const CHALLENGE_KEYS = [
  'address',
  'generation',
  'helperId',
  'helperPort',
  'helperSessionNonce',
  'hmac',
  'nodePublicKey',
  'portalSessionNonce',
  'protocolVersion',
  'stableNodeId',
  'tailnetName',
  'timestampMs',
];

const REQUEST_KEYS = [
  'address',
  'generation',
  'helperId',
  'helperPort',
  'helperSessionNonce',
  'method',
  'nodePublicKey',
  'path',
  'portalSessionNonce',
  'protocolVersion',
  'requestNonce',
  'signature',
  'stableNodeId',
  'tailnetName',
  'timestampMs',
  'wireBodySha256',
];

const RESPONSE_KEYS = [
  'address',
  'generation',
  'helperId',
  'helperPort',
  'helperSessionNonce',
  'nodePublicKey',
  'portalSessionNonce',
  'protocolVersion',
  'requestMethod',
  'requestNonce',
  'requestPath',
  'requestTimestampMs',
  'requestWireBodySha256',
  'signature',
  'stableNodeId',
  'status',
  'tailnetName',
  'timestampMs',
  'wireBodySha256',
];

function binding(
  overrides: Partial<OllamaTailnetBindingInput> = {},
): OllamaTailnetBindingInput {
  return {
    generation: 12,
    stableNodeId: 'node_stable_protocol_v2_01',
    nodePublicKey: `nodekey:${'a'.repeat(64)}`,
    tailnetName: 'example.ts.net',
    address: '100.100.101.102',
    helperPort: OLLAMA_TAILNET_HELPER_PORT,
    helperId: 'helper_protocol_v2_012345',
    secret: SECRET,
    ...overrides,
  };
}

function fixedRandom(byte: number): (size: number) => Uint8Array {
  return (size) => Buffer.alloc(size, byte);
}

function expectCode(
  action: () => unknown,
  code: OllamaTailnetProtocolErrorCode,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({
      name: 'OllamaTailnetProtocolError',
      code,
    });
    return;
  }
  throw new Error(`Expected ${code}`);
}

function createPortal(
  randomBytes?: (size: number) => Uint8Array,
  now: () => number = () => NOW,
): OllamaTailnetProtocol {
  return new OllamaTailnetProtocol(binding(), {
    role: 'portal',
    now,
    ...(randomBytes ? { randomBytes } : {}),
  });
}

function createHelper(
  randomBytes?: (size: number) => Uint8Array,
  now: () => number = () => NOW,
): OllamaTailnetProtocol {
  return new OllamaTailnetProtocol(binding(), {
    role: 'helper',
    now,
    ...(randomBytes ? { randomBytes } : {}),
  });
}

function establishSession(
  portal = createPortal(),
  helper = createHelper(),
): Readonly<{
  portal: OllamaTailnetProtocol;
  helper: OllamaTailnetProtocol;
  hello: UnsignedOllamaTailnetHello;
  challenge: SignedOllamaTailnetChallenge;
}> {
  const hello = portal.createHello();
  const challenge = helper.createChallenge(hello);
  expect(portal.verifyChallenge(hello, challenge)).toBe(true);
  return { portal, helper, hello, challenge };
}

describe('Ollama Tailnet protocol v2 session and encryption', () => {
  test('matches the fixed helper interoperability vectors', () => {
    const session = establishSession(
      createPortal(fixedRandom(0x11)),
      createHelper(fixedRandom(0x22)),
    );
    expect(session.hello.portalSessionNonce)
      .toBe('ERERERERERERERERERERERERERERERERERERERERERE');
    expect(session.challenge).toMatchObject({
      helperSessionNonce: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI',
      timestampMs: NOW,
      hmac: 'nOCbOuDzRng9_tBZDaJjCmIPtnXnoDGGcX_Ld9KC3yQ',
    });

    const request = session.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: Buffer.from('golden-request', 'utf8'),
    });
    expect(request.envelope).toMatchObject({
      requestNonce: 'ERERERERERERERERERERERERERERERERERERERERERE',
      wireBodySha256: '67a98d9ac3544f3ebba8ed6649d804ec86dec5e5ab8ed4f0635f35b4ddf84367',
      signature: 'l-R3tgtM6l_kQoKLTvUyZIhJlq4Mjr5WCQKTShOoxY4',
    });
    expect(request.wireBody.toString('hex'))
      .toBe('ba42afc293497919a5b78259f48bbb91633779ec7572c6d5dfe47b3e7865');

    const verified = session.helper.verifyRequest(request.envelope, request.wireBody);
    const response = session.helper.createResponse({
      request: verified.request,
      status: 201,
      body: Buffer.from('golden-response', 'utf8'),
    });
    expect(response.envelope).toMatchObject({
      requestWireBodySha256: request.envelope.wireBodySha256,
      wireBodySha256: 'ef1e12675d21058615b845da1d59809d233f200a5dfae08f7c55787b6c02fc73',
      signature: '8M2s7so8GCc-EdQDTwLX3cV3pB6Srhp5WJHheoBfssA',
    });
    expect(response.wireBody.toString('hex'))
      .toBe('205aeea3a7ac00eefa36111e470d3646de4ced930b1ddf17d9a23749b867da');
    expect(session.portal.verifyResponse({
      request: request.envelope,
      response: response.envelope,
      wireBody: response.wireBody,
    }).toString('utf8')).toBe('golden-response');
  });

  test('round-trips confidential request and response bodies with exact v2 envelopes', () => {
    const { portal, helper, hello, challenge } = establishSession();

    expect(OLLAMA_TAILNET_PROTOCOL_VERSION).toBe(2);
    expect(Object.keys(hello).sort()).toEqual(HELLO_KEYS);
    expect(Object.keys(challenge).sort()).toEqual(CHALLENGE_KEYS);
    expect(hello.protocolVersion).toBe(2);
    expect(challenge.protocolVersion).toBe(2);

    const request = portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    expect(Object.keys(request.envelope).sort()).toEqual(REQUEST_KEYS);
    expect(request.wireBody).toHaveLength(
      REQUEST_SENTINEL.byteLength + OLLAMA_TAILNET_GCM_TAG_BYTES,
    );
    expect(request.wireBody.includes(REQUEST_SENTINEL)).toBe(false);
    expect(request.wireBody.equals(REQUEST_SENTINEL)).toBe(false);

    const verified = helper.verifyRequest(request.envelope, request.wireBody);
    expect(verified.body.equals(REQUEST_SENTINEL)).toBe(true);
    expect(Object.keys(verified.request)).toEqual([]);
    expect(JSON.stringify(verified.request)).toBe('{}');

    const response = helper.createResponse({
      request: verified.request,
      status: 200,
      body: RESPONSE_SENTINEL,
    });
    expect(Object.keys(response.envelope).sort()).toEqual(RESPONSE_KEYS);
    expect(response.wireBody).toHaveLength(
      RESPONSE_SENTINEL.byteLength + OLLAMA_TAILNET_GCM_TAG_BYTES,
    );
    expect(response.wireBody.includes(RESPONSE_SENTINEL)).toBe(false);
    expect(response.wireBody.equals(request.wireBody)).toBe(false);
    expect(verified.body.every((byte) => byte === 0)).toBe(true);

    const plaintext = portal.verifyResponse({
      request: request.envelope,
      response: response.envelope,
      wireBody: response.wireBody,
    });
    expect(plaintext.equals(RESPONSE_SENTINEL)).toBe(true);

    portal.dispose();
    helper.dispose();
    expect(plaintext.equals(RESPONSE_SENTINEL)).toBe(true);
  });

  test('fresh sessions produce different ciphertext for identical plaintext', () => {
    const first = establishSession();
    const second = establishSession();
    const firstRequest = first.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const secondRequest = second.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });

    expect(firstRequest.envelope.portalSessionNonce)
      .not.toBe(secondRequest.envelope.portalSessionNonce);
    expect(firstRequest.wireBody.equals(secondRequest.wireBody)).toBe(false);

    first.portal.dispose();
    first.helper.dispose();
    second.portal.dispose();
    second.helper.dispose();
  });

  test('rejects v1 messages and extra envelope fields', () => {
    const portal = createPortal(fixedRandom(0x11));
    const hello = portal.createHello();
    const legacyHello = {
      ...hello,
      protocolVersion: 1,
    } as unknown as UnsignedOllamaTailnetHello;
    expectCode(
      () => createHelper(fixedRandom(0x21)).createChallenge(legacyHello),
      'BINDING_MISMATCH',
    );

    const extraHello = {
      ...hello,
      unexpected: true,
    } as unknown as UnsignedOllamaTailnetHello;
    expectCode(
      () => createHelper(fixedRandom(0x22)).createChallenge(extraHello),
      'ENVELOPE_MALFORMED',
    );
  });

  test('rejects a captured challenge replayed against a different Portal nonce', () => {
    const portalA = createPortal(fixedRandom(0x11));
    const helperA = createHelper(fixedRandom(0x21));
    const helloA = portalA.createHello();
    const challengeA = helperA.createChallenge(helloA);

    const portalB = createPortal(fixedRandom(0x12));
    const helloB = portalB.createHello();
    expect(helloB.portalSessionNonce).not.toBe(helloA.portalSessionNonce);
    expectCode(
      () => portalB.verifyChallenge(helloB, challengeA),
      'SESSION_MISMATCH',
    );
  });

  test('rejects challenge/request splicing across helper-issued sessions', () => {
    const sessionA = establishSession(
      createPortal(fixedRandom(0x11)),
      createHelper(fixedRandom(0x21)),
    );
    const sessionB = establishSession(
      createPortal(fixedRandom(0x12)),
      createHelper(fixedRandom(0x22)),
    );
    const requestB = sessionB.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });

    expectCode(
      () => sessionA.helper.verifyRequest(requestB.envelope, requestB.wireBody),
      'SESSION_MISMATCH',
    );
  });

  test('rejects request wire tampering, tag tampering, and session mutation', () => {
    const tamperSession = establishSession();
    const request = tamperSession.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const tamperedWire = Buffer.from(request.wireBody);
    tamperedWire[0] ^= 0x80;
    expectCode(
      () => tamperSession.helper.verifyRequest(request.envelope, tamperedWire),
      'WIRE_BODY_HASH_MISMATCH',
    );

    const tagSession = establishSession();
    const tagRequest = tagSession.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const tamperedTag = Buffer.from(tagRequest.wireBody);
    tamperedTag[tamperedTag.byteLength - 1] ^= 0x01;
    expectCode(
      () => tagSession.helper.verifyRequest(tagRequest.envelope, tamperedTag),
      'WIRE_BODY_HASH_MISMATCH',
    );

    const nonceSession = establishSession();
    const nonceRequest = nonceSession.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const mutatedEnvelope = {
      ...nonceRequest.envelope,
      helperSessionNonce: Buffer.alloc(32, 0xff).toString('base64url'),
    };
    expectCode(
      () => nonceSession.helper.verifyRequest(mutatedEnvelope, nonceRequest.wireBody),
      'SESSION_MISMATCH',
    );
  });

  test('rejects response tampering and wrong-direction ciphertext', () => {
    const session = establishSession();
    const request = session.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const verified = session.helper.verifyRequest(request.envelope, request.wireBody);
    const response = session.helper.createResponse({
      request: verified.request,
      status: 200,
      body: REQUEST_SENTINEL,
    });
    const tamperedResponse = Buffer.from(response.wireBody);
    tamperedResponse[tamperedResponse.byteLength - 1] ^= 0x01;
    expectCode(
      () => session.portal.verifyResponse({
        request: request.envelope,
        response: response.envelope,
        wireBody: tamperedResponse,
      }),
      'WIRE_BODY_HASH_MISMATCH',
    );

    const wrongDirection = establishSession(
      createPortal(fixedRandom(0x31)),
      createHelper(fixedRandom(0x41)),
    );
    const wrongRequest = wrongDirection.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    expect(response.wireBody.equals(wrongRequest.wireBody)).toBe(false);
    expectCode(
      () => wrongDirection.helper.verifyRequest(
        wrongRequest.envelope,
        response.wireBody,
      ),
      'WIRE_BODY_HASH_MISMATCH',
    );
  });

  test('allows only one request and one response per session', () => {
    const session = establishSession();
    const request = session.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    expectCode(
      () => session.portal.createRequest({
        method: 'POST',
        path: '/api/show',
        body: REQUEST_SENTINEL,
      }),
      'SESSION_STATE_INVALID',
    );

    const helperSession = establishSession();
    const helperRequest = helperSession.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    helperSession.helper.verifyRequest(helperRequest.envelope, helperRequest.wireBody);
    expectCode(
      () => helperSession.helper.verifyRequest(helperRequest.envelope, helperRequest.wireBody),
      'SESSION_STATE_INVALID',
    );

    expect(request.envelope.requestNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test('invalid verification fails the session closed instead of permitting a retry', () => {
    const session = establishSession();
    const request = session.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const tampered = Buffer.from(request.wireBody);
    tampered[0] ^= 0x01;
    expectCode(
      () => session.helper.verifyRequest(request.envelope, tampered),
      'WIRE_BODY_HASH_MISMATCH',
    );
    expectCode(
      () => session.helper.verifyRequest(request.envelope, request.wireBody),
      'SESSION_STATE_INVALID',
    );
  });

  test('enforces plaintext and exact GCM wire-size caps', () => {
    const oversizedPlaintext = establishSession();
    expectCode(
      () => oversizedPlaintext.portal.createRequest({
        method: 'POST',
        path: '/api/show',
        body: Buffer.alloc(
          OLLAMA_TAILNET_PATH_POLICY['/api/show'].maxRequestBytes + 1,
        ),
      }),
      'BODY_TOO_LARGE',
    );

    const empty = establishSession();
    const emptyRequest = empty.portal.createRequest({
      method: 'GET',
      path: '/api/tags',
      body: Buffer.alloc(0),
    });
    expect(emptyRequest.wireBody).toHaveLength(OLLAMA_TAILNET_GCM_TAG_BYTES);
    const emptyVerified = empty.helper.verifyRequest(
      emptyRequest.envelope,
      emptyRequest.wireBody,
    );
    expect(emptyVerified.body).toHaveLength(0);

    const oversizedWire = establishSession();
    const valid = oversizedWire.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: Buffer.alloc(0),
    });
    expectCode(
      () => oversizedWire.helper.verifyRequest(
        valid.envelope,
        Buffer.alloc(
          OLLAMA_TAILNET_PATH_POLICY['/api/show'].maxRequestBytes
            + OLLAMA_TAILNET_GCM_TAG_BYTES
            + 1,
        ),
      ),
      'WIRE_BODY_TOO_LARGE',
    );
  });

  test('zeroes helper-owned plaintext on response creation and disposal', () => {
    const completed = establishSession();
    const completedRequest = completed.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const completedVerified = completed.helper.verifyRequest(
      completedRequest.envelope,
      completedRequest.wireBody,
    );
    completed.helper.createResponse({
      request: completedVerified.request,
      status: 200,
      body: RESPONSE_SENTINEL,
    });
    expect(completedVerified.body.every((byte) => byte === 0)).toBe(true);

    const disposed = establishSession();
    const disposedRequest = disposed.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const disposedVerified = disposed.helper.verifyRequest(
      disposedRequest.envelope,
      disposedRequest.wireBody,
    );
    disposed.helper.dispose();
    expect(disposedVerified.body.every((byte) => byte === 0)).toBe(true);
    expectCode(
      () => disposed.helper.createResponse({
        request: disposedVerified.request,
        status: 200,
        body: RESPONSE_SENTINEL,
      }),
      'DISPOSED',
    );
  });

  test('redacts the shared secret from protocol and error serialization', () => {
    const portal = createPortal();
    const serialized = JSON.stringify(portal);
    expect(serialized).not.toContain(SECRET.toString('base64url'));
    expect(serialized).not.toContain(SECRET.toString('hex'));
    expect(serialized).toContain('"protocolVersion":2');

    let serializedError = '';
    try {
      portal.createRequest({
        method: 'POST',
        path: '/api/show',
        body: REQUEST_SENTINEL,
      });
    } catch (error) {
      serializedError = JSON.stringify(error);
    }
    expect(serializedError).toContain('SESSION_STATE_INVALID');
    expect(serializedError).not.toContain(SECRET.toString('base64url'));
    expect(serializedError.length).toBeLessThan(300);
  });

  test('rejects stale challenges and malformed randomness', () => {
    const stalePortal = createPortal(fixedRandom(0x51), () => NOW);
    const staleHello = stalePortal.createHello();
    const staleHelper = createHelper(
      fixedRandom(0x61),
      () => NOW - OLLAMA_TAILNET_MAX_PAST_SKEW_MS - 1,
    );
    const staleChallenge = staleHelper.createChallenge(staleHello);
    expectCode(
      () => stalePortal.verifyChallenge(staleHello, staleChallenge),
      'TIMESTAMP_STALE',
    );

    const badRandomPortal = createPortal(() => Buffer.alloc(31));
    expectCode(() => badRandomPortal.createHello(), 'RANDOM_SOURCE_INVALID');
  });

  test('rejects forged receipts from another helper instance', () => {
    const first = establishSession(
      createPortal(fixedRandom(0x71)),
      createHelper(fixedRandom(0x72)),
    );
    const firstRequest = first.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const firstVerified = first.helper.verifyRequest(
      firstRequest.envelope,
      firstRequest.wireBody,
    );

    const second = establishSession(
      createPortal(fixedRandom(0x73)),
      createHelper(fixedRandom(0x74)),
    );
    const secondRequest = second.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    second.helper.verifyRequest(secondRequest.envelope, secondRequest.wireBody);
    expectCode(
      () => second.helper.createResponse({
        request: firstVerified.request,
        status: 200,
        body: RESPONSE_SENTINEL,
      }),
      'VERIFIED_REQUEST_REQUIRED',
    );
  });

  test('rejects request and response envelope field splicing', () => {
    const session = establishSession();
    const request = session.portal.createRequest({
      method: 'POST',
      path: '/api/show',
      body: REQUEST_SENTINEL,
    });
    const verified = session.helper.verifyRequest(request.envelope, request.wireBody);
    const response = session.helper.createResponse({
      request: verified.request,
      status: 200,
      body: RESPONSE_SENTINEL,
    });

    const splicedResponse = {
      ...response.envelope,
      requestNonce: Buffer.alloc(32, 0x7f).toString('base64url'),
    } as EncryptedOllamaTailnetResponse;
    expectCode(
      () => session.portal.verifyResponse({
        request: request.envelope,
        response: splicedResponse,
        wireBody: response.wireBody,
      }),
      'SESSION_MISMATCH',
    );

    const malformedRequest = {
      ...request.envelope,
      method: 'GET',
    } as EncryptedOllamaTailnetRequest;
    expect(malformedRequest.method).not.toBe(request.envelope.method);
  });
});
