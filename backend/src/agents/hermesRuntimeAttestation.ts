import fs from 'fs';
import path from 'path';
import { PORTAL_TOOL_VERSIONS } from '../config/toolVersions';
import { parseHarnessVersion } from './harnessVersionPolicy';

// Written by installer/hermes-runtime.sh (hermes_attestation) next to the
// pinned virtualenv. Questions, widgets and goals reach Hermes through the
// Portal Chat Bridge MCP server, which needs the `mcp` extra; without it Hermes
// silently ignores mcpServers. Keep these names in step with the helper.
export const HERMES_RUNTIME_ATTESTATION_NAME = '.portal-runtime-attestation-v1';
const HERMES_RUNTIME_ATTESTATION_SCHEMA = 'bridgesllm-hermes-runtime-v1';
const MAX_ATTESTATION_BYTES = 4096;

export type HermesRuntimeAttestationState =
  | 'bridge-ready'
  | 'mcp-extra-missing'
  | 'unreadable'
  | 'version-mismatch';

export function hermesRuntimeAttestationPath(
  root = process.env.HERMES_RUNTIME_ROOT || '/usr/local/lib/bridgesllm-runtimes/hermes',
  version: string = PORTAL_TOOL_VERSIONS.hermes,
): string {
  return path.join(root, version, HERMES_RUNTIME_ATTESTATION_NAME);
}

export function parseHermesRuntimeAttestation(
  content: string,
  expectedVersion: string = PORTAL_TOOL_VERSIONS.hermes,
): HermesRuntimeAttestationState {
  const fields = new Map<string, string>();
  for (const line of content.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  if (fields.get('schema') !== HERMES_RUNTIME_ATTESTATION_SCHEMA) return 'unreadable';
  if (fields.get('product_version') !== expectedVersion) return 'version-mismatch';
  const extras = (fields.get('extras') || '').split(',').map((extra) => extra.trim());
  return extras.includes('mcp') ? 'bridge-ready' : 'mcp-extra-missing';
}

export function readHermesRuntimeAttestation(options: {
  attestationPath?: string;
  readFile?: (filePath: string) => string;
  /** The installed Hermes version (floor-pinned); defaults to the tested one. */
  version?: string;
} = {}): HermesRuntimeAttestationState {
  const version = options.version ?? PORTAL_TOOL_VERSIONS.hermes;
  // The version names a directory: only a plain version string may do that.
  if (!parseHarnessVersion(version) || version.startsWith('v')) return 'unreadable';
  const attestationPath = options.attestationPath || hermesRuntimeAttestationPath(undefined, version);
  try {
    const content = options.readFile
      ? options.readFile(attestationPath)
      : fs.readFileSync(attestationPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_ATTESTATION_BYTES) return 'unreadable';
    return parseHermesRuntimeAttestation(content, version);
  } catch {
    return 'unreadable';
  }
}

/**
 * A reduced feature, not an unusable harness: chat still works, but the bridge
 * features stay off until the Hermes runtime is refreshed.
 */
export function hermesBridgeFeatureGap(state: HermesRuntimeAttestationState): string | null {
  if (state === 'bridge-ready') return null;
  const cause = state === 'mcp-extra-missing'
    ? 'The installed Hermes runtime was built without its MCP extra'
    : state === 'version-mismatch'
      ? 'The Hermes runtime attestation is for a different Hermes version'
      : 'Portal could not read the Hermes runtime attestation';
  return `${cause}, so interactive questions, widgets and goals are off for Hermes. Run Update Compatible AI Tools to enable them.`;
}
