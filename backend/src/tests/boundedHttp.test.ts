import { readBoundedJson, readBoundedResponseBody, ResponseTooLargeError } from '../utils/boundedHttp';

describe('bounded upstream response reader', () => {
  test('reads JSON within the byte limit', async () => {
    const response = new Response(JSON.stringify({ ok: true }));
    await expect(readBoundedJson(response, 1024)).resolves.toEqual({ ok: true });
  });

  test('rejects a declared oversized response', async () => {
    const response = new Response('small', { headers: { 'content-length': '4096' } });
    await expect(readBoundedResponseBody(response, 32)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  test('rejects a chunked response that crosses the runtime limit', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
        controller.enqueue(new Uint8Array(20));
        controller.close();
      },
    }));
    await expect(readBoundedResponseBody(response, 32)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
