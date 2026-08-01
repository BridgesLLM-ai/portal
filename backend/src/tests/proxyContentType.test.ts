import { isBinaryProxyContentType } from '../utils/proxyContentType';

describe('isBinaryProxyContentType', () => {
  it.each([
    'image/jpeg',
    'image/jpeg; charset=utf-8',
    'IMAGE/PNG',
    'image/webp',
    'application/pdf',
    'application/octet-stream',
  ])('keeps %s byte-safe', (contentType) => {
    expect(isBinaryProxyContentType(contentType)).toBe(true);
  });

  it.each([
    'application/json',
    'text/plain; charset=utf-8',
    'text/html',
    '',
  ])('allows %s through the text response path', (contentType) => {
    expect(isBinaryProxyContentType(contentType)).toBe(false);
  });
});
