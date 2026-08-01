import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface VirusScanResult {
  clean: boolean;
  scannerAvailable: boolean;
  threat?: string;
  error?: 'scanner-unavailable';
}

export function classifyClamdscanFailure(error: any): VirusScanResult {
  const stdout = Buffer.isBuffer(error?.stdout) ? error.stdout.toString('utf8') : String(error?.stdout || '');
  if (Number(error?.code) === 1 && /\bFOUND\s*$/m.test(stdout)) {
    const match = stdout.match(/:\s*(.+?)\s+FOUND\s*$/m);
    return {
      clean: false,
      scannerAvailable: true,
      threat: match?.[1]?.trim() || 'Unknown threat',
    };
  }
  return {
    clean: false,
    scannerAvailable: false,
    threat: 'Malware scanner unavailable',
    error: 'scanner-unavailable',
  };
}

/**
 * Scan a file or buffer for malware using ClamAV daemon (clamdscan).
 * Returns { clean: boolean, threat?: string }
 */
export async function scanFile(filePath: string): Promise<VirusScanResult> {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { clean: false, scannerAvailable: false, threat: 'Upload is not a regular file', error: 'scanner-unavailable' };
    }
    await execFileAsync('clamdscan', ['--fdpass', '--no-summary', '--infected', '--', filePath], {
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    return { clean: true, scannerAvailable: true };
  } catch (error: any) {
    const result = classifyClamdscanFailure(error);
    if (!result.scannerAvailable) {
      console.error('[virusScan] ClamAV scan failed; rejecting user-controlled content:', error?.message || 'unknown error');
    }
    return result;
  }
}

/**
 * Scan a buffer by writing to a temp file, scanning, then cleaning up.
 */
export async function scanBuffer(buffer: Buffer, label: string = 'attachment'): Promise<VirusScanResult> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-clamscan-'));
  const tmpPath = path.join(tempDir, 'content');
  try {
    fs.writeFileSync(tmpPath, buffer, { mode: 0o600, flag: 'wx' });
    const result = await scanFile(tmpPath);
    if (!result.clean) {
      console.warn(`[virusScan] THREAT DETECTED in ${label}: ${result.threat}`);
    }
    return result;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}
