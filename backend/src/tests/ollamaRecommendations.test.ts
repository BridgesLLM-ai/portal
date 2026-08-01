import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_OLLAMA_MODEL,
  getOllamaRecommendationsByRam,
  isValidOllamaModelName,
  readAvailableMemoryBytes,
} from '../utils/ollamaRecommendations';

const GIB = 1024 ** 3;

describe('Ollama recommendations', () => {
  test('uses a current balanced default', () => {
    expect(DEFAULT_OLLAMA_MODEL).toBe('qwen3.5:4b');
  });

  test('keeps an 8GB host inside available-memory headroom', () => {
    const result = getOllamaRecommendationsByRam(8 * GIB, 6 * GIB);
    const names = result.recommendedModels.map((model) => model.name);

    expect(result.ramTier).toBe('8-16GB');
    expect(result.availableRamGb).toBe(6);
    expect(result.reservedHeadroomGb).toBe(2);
    expect(names).toContain('qwen3.5:4b');
    expect(names).not.toContain('qwen3.5:9b');
    expect(names).not.toContain('qwen3.6:27b');
  });

  test('only exposes Qwen 3.6 when workstation headroom is present', () => {
    const tooBusy = getOllamaRecommendationsByRam(32 * GIB, 20 * GIB);
    const ready = getOllamaRecommendationsByRam(32 * GIB, 25 * GIB);

    expect(tooBusy.recommendedModels.map((model) => model.name)).not.toContain('qwen3.6:27b');
    expect(ready.recommendedModels.map((model) => model.name)).toContain('qwen3.6:27b');
  });

  test('returns no unsafe recommendation when current memory is exhausted', () => {
    const result = getOllamaRecommendationsByRam(16 * GIB, 2 * GIB);
    expect(result.recommendedModels).toEqual([]);
    expect(result.warning).toMatch(/No catalog model/i);
  });

  test('reads Linux MemAvailable and clamps it to total memory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ollama-mem-'));
    const meminfo = path.join(tempDir, 'meminfo');
    try {
      fs.writeFileSync(meminfo, 'MemTotal:       99999999 kB\nMemAvailable:    7340032 kB\n');
      expect(readAvailableMemoryBytes(8 * GIB, meminfo)).toBe(7 * GIB);

      fs.writeFileSync(meminfo, 'MemAvailable:   99999999 kB\n');
      expect(readAvailableMemoryBytes(8 * GIB, meminfo)).toBe(8 * GIB);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('uses a conservative non-Linux fallback', () => {
    expect(readAvailableMemoryBytes(10 * GIB, '/definitely/missing/meminfo')).toBe(7 * GIB);
  });

  test.each([
    'qwen3.5:4b',
    'registry.example.com:5000/team/model:latest',
    'deepseek-r1:8b-q4_K_M',
  ])('accepts a valid model name: %s', (model) => {
    expect(isValidOllamaModelName(model)).toBe(true);
  });

  test.each([
    '',
    ' qwen3.5:4b ',
    'qwen3.5:4b; reboot',
    '$(touch /tmp/nope)',
    'qwen\nmodel',
    `m${'x'.repeat(200)}`,
  ])('rejects an invalid model name: %j', (model) => {
    expect(isValidOllamaModelName(model)).toBe(false);
  });
});
