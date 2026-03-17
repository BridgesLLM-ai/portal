import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

/**
 * Scan a file or buffer for malware using ClamAV daemon (clamdscan).
 * Returns { clean: boolean, threat?: string }
 */
export async function scanFile(filePath: string): Promise<{ clean: boolean; threat?: string }> {
  try {
    await execFileAsync('clamdscan', ['--no-summary', '--infected', filePath], { timeout: 30000 });
    return { clean: true };
  } catch (error: any) {
    // Exit code 1 = virus found, exit code 2 = error
    if (error.code === 1 && error.stdout) {
      const match = error.stdout.match(/:\s*(.+)\s+FOUND/);
      const threat = match?.[1]?.trim() || 'Unknown threat';
      return { clean: false, threat };
    }
    // ClamAV not available — fail open with warning (don't block operations)
    console.warn('[virusScan] ClamAV scan failed, allowing file:', error.message);
    return { clean: true };
  }
}

/**
 * Scan a buffer by writing to a temp file, scanning, then cleaning up.
 */
export async function scanBuffer(buffer: Buffer, label: string = 'attachment'): Promise<{ clean: boolean; threat?: string }> {
  const tmpPath = `/tmp/clamscan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.writeFileSync(tmpPath, buffer);
    const result = await scanFile(tmpPath);
    if (!result.clean) {
      console.warn(`[virusScan] THREAT DETECTED in ${label}: ${result.threat}`);
    }
    return result;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
