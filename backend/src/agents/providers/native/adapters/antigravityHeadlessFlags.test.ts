import fs from 'fs';
import path from 'path';
import { ANTIGRAVITY_HEADLESS_FLAGS, missingAntigravityHeadlessFlags } from './antigravityHeadlessFlags';

const HELP = [
  'Usage: agy [options] [prompt]',
  '',
  'Options:',
  '  -p, --print <prompt>              Run one prompt and exit',
  '  --output-format <format>          text | json | stream-json',
  '  --print-timeout <duration>        Abort a --print run after this long',
  '  --add-dir <dir>                   Allow another directory',
  '  --conversation=<id>               Continue a conversation',
  '  --model <model>                   Model to use',
  '  [--dangerously-skip-permissions]  Skip permission prompts',
  '  --sandbox                         Run tools in the sandbox',
].join('\n');

describe('Antigravity headless flag scan', () => {
  test('accepts help text that lists every headless flag the adapter uses', () => {
    expect(missingAntigravityHeadlessFlags(HELP)).toEqual([]);
  });

  test('names each flag a newer build stopped listing, without prefix false positives', () => {
    const help = HELP
      .replace('  --sandbox                         Run tools in the sandbox', '  --sandbox-mode <mode>             Pick a sandbox')
      .replace('--print-timeout', '--print-deadline');
    expect(missingAntigravityHeadlessFlags(help)).toEqual(['--print-timeout', '--sandbox']);
    expect(missingAntigravityHeadlessFlags('')).toEqual([...ANTIGRAVITY_HEADLESS_FLAGS]);
  });

  test('covers every flag literal the Antigravity adapter passes', () => {
    const adapter = fs.readFileSync(path.join(__dirname, 'gemini.ts'), 'utf8');
    const literals = [...new Set([...adapter.matchAll(/'(--[a-z][a-z-]*)'/g)].map((match) => match[1]))];
    expect(literals.length).toBeGreaterThan(0);
    for (const flag of literals) expect(ANTIGRAVITY_HEADLESS_FLAGS).toContain(flag);
  });
});
