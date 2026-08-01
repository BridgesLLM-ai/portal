import net from 'net';
import {
  OLLAMA_TAILNET_HELPER_PORT,
  OllamaTailnetProtocol,
  type EncryptedOllamaTailnetRequest,
  type OllamaTailnetBindingInput,
  type UnsignedOllamaTailnetHello,
} from '../services/ollamaTailnetProtocol';
import {
  requestOllamaOverTailnet,
  type OllamaTailnetConnectOptions,
} from '../services/ollamaTailnetTransport';

const NOW = 1_800_000_000_000;
const SECRET = Buffer.alloc(32, 0x41);

function binding(): OllamaTailnetBindingInput {
  return {
    generation: 9,
    stableNodeId: 'node_stable_transport_01',
    nodePublicKey: `nodekey:${'a'.repeat(64)}`,
    tailnetName: 'example.ts.net',
    address: '100.100.101.102',
    helperPort: OLLAMA_TAILNET_HELPER_PORT,
    helperId: 'helper_transport_012345',
    secret: SECRET,
  };
}

class TestSocketReader {
  readonly #chunks: Buffer[] = [];
  #bufferedBytes = 0;
  #ended = false;
  #failure: Error | null = null;
  #waiter: (() => void) | null = null;

  constructor(socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.#chunks.push(Buffer.from(chunk));
      this.#bufferedBytes += chunk.byteLength;
      this.#wake();
    });
    socket.on('end', () => {
      this.#ended = true;
      this.#wake();
    });
    socket.on('error', (error) => {
      this.#failure = error;
      this.#wake();
    });
  }

  async readExact(byteLength: number): Promise<Buffer> {
    while (this.#bufferedBytes < byteLength) {
      if (this.#failure) throw this.#failure;
      if (this.#ended) throw new Error('Unexpected EOF');
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
    const output = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const chunk = this.#chunks[0];
      const remaining = byteLength - offset;
      if (chunk.byteLength <= remaining) {
        chunk.copy(output, offset);
        offset += chunk.byteLength;
        this.#chunks.shift();
      } else {
        chunk.copy(output, offset, 0, remaining);
        this.#chunks[0] = chunk.subarray(remaining);
        offset += remaining;
      }
    }
    this.#bufferedBytes -= byteLength;
    return output;
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }
}

function envelopeFrame(envelope: object): Buffer {
  const envelopeBytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(envelopeBytes.byteLength, 0);
  return Buffer.concat([header, envelopeBytes]);
}

function messageFrame(envelope: object, body: Buffer): Buffer {
  const envelopeBytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(envelopeBytes.byteLength, 0);
  header.writeUInt32BE(body.byteLength, 4);
  return Buffer.concat([header, envelopeBytes, body]);
}

async function readEnvelope<T>(reader: TestSocketReader): Promise<T> {
  const header = await reader.readExact(4);
  const length = header.readUInt32BE(0);
  return JSON.parse(
    (await reader.readExact(length)).toString('utf8'),
  ) as T;
}

async function readMessage<T>(
  reader: TestSocketReader,
): Promise<{ envelope: T; body: Buffer }> {
  const header = await reader.readExact(8);
  const envelopeLength = header.readUInt32BE(0);
  const bodyLength = header.readUInt32BE(4);
  return {
    envelope: JSON.parse(
      (await reader.readExact(envelopeLength)).toString('utf8'),
    ) as T,
    body: await reader.readExact(bodyLength),
  };
}

describe('legacy Tailnet transport compatibility client', () => {
  let server: net.Server | null = null;

  afterEach(async () => {
    if (!server) return;
    const current = server;
    server = null;
    await new Promise<void>((resolve) => current.close(() => resolve()));
  });

  test('interoperates with an already-running protocol-v2 helper without its installer artifact', async () => {
    let observedPlaintext = '';
    let handlerError: unknown;
    let finishHandler!: () => void;
    const handlerDone = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });
    server = net.createServer({ allowHalfOpen: true }, (socket) => {
      void (async () => {
        const helper = new OllamaTailnetProtocol(binding(), {
          role: 'helper',
          now: () => NOW,
        });
        let requestWireBody: Buffer | null = null;
        let responseWireBody: Buffer | null = null;
        try {
          const reader = new TestSocketReader(socket);
          const hello = await readEnvelope<UnsignedOllamaTailnetHello>(reader);
          const challenge = helper.createChallenge(hello);
          socket.write(envelopeFrame(challenge));

          const request = await readMessage<EncryptedOllamaTailnetRequest>(
            reader,
          );
          requestWireBody = request.body;
          const verified = helper.verifyRequest(
            request.envelope,
            request.body,
          );
          try {
            observedPlaintext = verified.body.toString('utf8');
            const response = helper.createResponse({
              request: verified.request,
              status: 200,
              body: Buffer.from('{"models":[]}', 'utf8'),
            });
            responseWireBody = response.wireBody;
            socket.end(messageFrame(response.envelope, response.wireBody));
          } finally {
            verified.body.fill(0);
          }
        } catch (error) {
          handlerError = error;
          socket.destroy();
        } finally {
          requestWireBody?.fill(0);
          responseWireBody?.fill(0);
          helper.dispose();
          finishHandler();
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server address');
    }
    const observedConnect: OllamaTailnetConnectOptions[] = [];

    const response = await requestOllamaOverTailnet(
      binding(),
      {
        path: '/api/tags',
        method: 'GET',
        body: Buffer.alloc(0),
      },
      {
        timeoutMs: 5_000,
        dependencies: {
          now: () => NOW,
          connect: (options) => {
            observedConnect.push(options);
            return net.createConnection({
              host: '127.0.0.1',
              port: address.port,
              family: 4,
            });
          },
        },
      },
    );
    await handlerDone;

    expect(handlerError).toBeUndefined();
    expect(observedPlaintext).toBe('');
    expect(observedConnect).toEqual([{
      host: '100.100.101.102',
      port: 11434,
      family: 4,
      autoSelectFamily: false,
    }]);
    expect(response).toMatchObject({
      protocolVersion: 2,
      status: 200,
      streaming: false,
    });
    expect(response.body.toString('utf8')).toBe('{"models":[]}');
    response.body.fill(0);
  });

  test.each([
    {
      label: 'unknown path',
      request: {
        path: '/api/unknown',
        method: 'GET',
        body: Buffer.alloc(0),
      },
    },
    {
      label: 'wrong method',
      request: {
        path: '/api/tags',
        method: 'POST',
        body: Buffer.alloc(0),
      },
    },
    {
      label: 'body on zero-body route',
      request: {
        path: '/api/tags',
        method: 'GET',
        body: Buffer.from('{}'),
      },
    },
  ])('rejects $label before dialing a peer', async ({ request }) => {
    const connect = jest.fn();
    await expect(requestOllamaOverTailnet(
      binding(),
      request,
      { dependencies: { connect } },
    )).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
    expect(connect).not.toHaveBeenCalled();
  });

  test('rejects an already-aborted request before dialing a peer', async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = jest.fn();
    await expect(requestOllamaOverTailnet(
      binding(),
      {
        path: '/api/tags',
        method: 'GET',
        body: Buffer.alloc(0),
      },
      {
        signal: controller.signal,
        dependencies: { connect },
      },
    )).rejects.toMatchObject({ code: 'ABORTED' });
    expect(connect).not.toHaveBeenCalled();
  });
});
