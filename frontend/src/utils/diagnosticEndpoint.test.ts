import { describe, expect, it } from 'vitest';
import { diagnosticEndpoint } from './diagnosticEndpoint';

describe('diagnosticEndpoint', () => {
  it('preserves the method and relative path while stripping query and fragment data', () => {
    expect(diagnosticEndpoint(
      'post',
      '/projects/alpha/chat/providers/openclaw/qualify?token=secret#private-state',
    )).toBe('POST /projects/alpha/chat/providers/openclaw/qualify');
  });

  it('retains only the pathname from an absolute or protocol-relative URL', () => {
    expect(diagnosticEndpoint(
      'GET',
      'https://user:password@example.invalid/api/files/download?signed=secret',
    )).toBe('GET /api/files/download');
    expect(diagnosticEndpoint(
      'PATCH',
      '//example.invalid/api/projects/alpha#access-token',
    )).toBe('PATCH /api/projects/alpha');
  });

  it('does not decode encoded path characters and rejects an invalid method token', () => {
    expect(diagnosticEndpoint(
      'GET\r\nX-Secret: value',
      '/api/files/a%3Fb%23c?credential=secret',
    )).toBe('GET /api/files/a%3Fb%23c');
  });
});
