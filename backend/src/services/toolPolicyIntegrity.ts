import os from 'os';

/**
 * The tool policy's newestProven.integrity, read the way toolctl and the release
 * gate read it (COMMON-W7 integrity contract): npm takes the registry SRI string,
 * github-tarball the canonical source-tree digest; tools whose bytes differ per
 * architecture (github-release, vendor, and container-image: the per-architecture
 * image digest the Agent Zero helper pins, never the multi-arch index) record an
 * object keyed by machine. A machine without an entry has not been qualified, so
 * its server keeps "(not yet qualified)".
 */

export type PolicyMachine = 'x86_64' | 'aarch64';
export type ToolPolicyIntegrity = string | Partial<Record<PolicyMachine, string>> | null;

const MACHINES: string[] = ['x86_64', 'aarch64'];
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const FORMS: Record<string, { byMachine: boolean; patterns: RegExp[] }> = {
  npm: { byMachine: false, patterns: [/^sha512-[A-Za-z0-9+/]{86}==$/] },
  'github-tarball': { byMachine: false, patterns: [/^sha256-tree:[0-9a-f]{64}$/] },
  'github-release': { byMachine: true, patterns: [SHA256] },
  'container-image': { byMachine: true, patterns: [SHA256] },
  vendor: { byMachine: true, patterns: [SHA256, /^sha512:[0-9a-f]{128}$/] },
};

/** Node's architecture name as the policy's machine key; null for any other architecture. */
export function policyMachine(arch: string = os.arch()): PolicyMachine | null {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  return null;
}

type IntegrityTool = {
  source: { kind: string };
  newestProven: { status: string; integrity?: unknown };
};

/**
 * True only when the recommended version is qualified and carries a digest in its kind's form that applies to
 * `machine`. A value toolctl would refuse (another form, an unknown or empty machine object) is never "proven".
 */
export function qualifiedOnThisMachine(tool: IntegrityTool, machine: PolicyMachine | null = policyMachine()): boolean {
  const form = FORMS[tool.source?.kind];
  const proven = tool.newestProven;
  if (!form || !proven || proven.status !== 'qualified') return false;
  const inForm = (value: unknown) => typeof value === 'string' && form.patterns.some((pattern) => pattern.test(value));
  const integrity = proven.integrity;
  if (!form.byMachine) return inForm(integrity);
  if (!machine || !integrity || typeof integrity !== 'object' || Array.isArray(integrity)) return false;
  const entries = Object.entries(integrity as Record<string, unknown>);
  if (!entries.length || entries.some(([key, value]) => !MACHINES.includes(key) || !inForm(value))) return false;
  return entries.some(([key]) => key === machine);
}
