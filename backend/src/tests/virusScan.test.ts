import { classifyClamdscanFailure } from '../services/virusScan';

describe('virus scan failure policy', () => {
  test('recognizes ClamAV threat exit code and redacts the source path', () => {
    const result = classifyClamdscanFailure({
      code: 1,
      stdout: '/private/upload/path: Eicar-Signature FOUND\n',
    });
    expect(result).toEqual({ clean: false, scannerAvailable: true, threat: 'Eicar-Signature' });
    expect(JSON.stringify(result)).not.toContain('/private/upload/path');
  });

  test.each([
    { code: 2, message: 'daemon unavailable' },
    { code: 'ENOENT', message: 'clamdscan not found' },
    { code: null, killed: true, message: 'timeout' },
  ])('fails closed when scanning cannot produce a verdict', (error) => {
    expect(classifyClamdscanFailure(error)).toEqual({
      clean: false,
      scannerAvailable: false,
      threat: 'Malware scanner unavailable',
      error: 'scanner-unavailable',
    });
  });
});
