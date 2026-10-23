#!/usr/bin/env node
/** Exact public artifact/source seams only. Does not claim live runtime qualification. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const manifest = JSON.parse(fs.readFileSync(new URL('./openclaw-2026.9.9-portal-contract.json', import.meta.url), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Unsafe source artifact: ${filename}`);
  return fs.readFileSync(filename);
}
function verify(root, mode) {
  const metadata = JSON.parse(read(path.join(root, 'package.json')));
  const build = JSON.parse(read(path.join(root, 'dist/build-info.json')));
  if (metadata.name !== 'openclaw' || metadata.version !== manifest.version || metadata.engines?.node !== manifest.node
    || build.version !== manifest.version || build.commit !== manifest.commit) throw new Error('Exact 9.9 artifact identity mismatch');
  const paths = [];
  for (const target of manifest.targets) {
    const filename = path.join(root, 'dist', target.filename);
    const observed = hash(read(filename));
    const allowed = mode.startsWith('bridged-') ? [target.bridgedSha256]
      : mode === 'targets' ? [target.stockSha256, target.bridgedSha256] : [target.stockSha256];
    if (!allowed.includes(observed)) throw new Error(`Unattested ${target.id} bytes`);
    if ((fs.statSync(filename).mode & 0o777) !== 0o644) throw new Error(`Invalid ${target.id} mode`);
    const backup = `${filename}${target.id === 'activeRuns' ? '.bridgesllm-pending-input-v1.bak' : '.bridgesllm-hard-delete-v1.bak'}`;
    if (fs.existsSync(backup) && hash(read(backup)) !== target.stockSha256) throw new Error(`Unattested ${target.id} rollback backup`);
    const syntax = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8', timeout: 10000 });
    if (syntax.status !== 0) throw new Error(`Invalid ${target.id} syntax`);
    paths.push(filename);
  }
  return paths;
}
export function verifyOpenClaw99Source(root, mode = 'core') { return verify(path.resolve(root), mode); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, input, codex, ...extra] = process.argv.slice(2);
    // The installer passes its pinned commit; a disagreement is never a 9.9 tuple.
    if (process.env.PORTAL_EXPECTED_OPENCLAW_CORE_COMMIT && process.env.PORTAL_EXPECTED_OPENCLAW_CORE_COMMIT !== manifest.commit) {
      throw new Error('installer and stock verifier disagree on the tested OpenClaw commit');
    }
    if (!['core', 'pair', 'commit-targets', 'targets', 'bridged-core', 'bridged-pair', 'bridged-targets'].includes(mode) || !input || extra.length) throw new Error('Invalid verifier arguments');
    const paths = verifyOpenClaw99Source(input, mode);
    if (mode.endsWith('pair')) {
      if (!codex) throw new Error('Codex source artifact required');
      const plugin = JSON.parse(read(path.join(codex, 'package.json')));
      if (plugin.name !== '@openclaw/codex' || plugin.version !== manifest.version || plugin.peerDependencies?.openclaw !== '>=2026.9.9') throw new Error('Exact Codex metadata mismatch');
    }
    if (mode.includes('targets')) process.stdout.write(paths.join('\n') + '\n');
    else process.stderr.write('Verified exact 9.9 public source seams (not runtime qualification)\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
