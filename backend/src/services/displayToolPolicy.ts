/**
 * Read-only diagnostic: does an agent's own native tool policy hide the tools
 * Agent Chat draws with? It only reads a configuration snapshot and never
 * writes or proposes policy; changing it stays with the owner.
 *
 * Coverage follows the native tool groups: `canvas` also names show_widget,
 * `update_plan` also names progress_card, `group:ui`, `group:agents` and
 * `group:openclaw` include them, and globs match concrete tool names only.
 * Tool profiles are not modelled; a profile that leaves a tool out is not
 * reported here.
 */
export const DISPLAY_TOOLS = ['show_widget', 'progress_card', 'ask_user'] as const;
export type DisplayTool = typeof DISPLAY_TOOLS[number];

const NAMES: Record<DisplayTool, readonly string[]> = {
  show_widget: ['show_widget', 'canvas', 'group:ui', 'group:openclaw'],
  progress_card: ['progress_card', 'update_plan', 'group:agents', 'group:openclaw'],
  ask_user: ['ask_user', 'group:agents', 'group:openclaw'],
};

export type DisplayToolFinding = {
  tool: DisplayTool;
  /** `deny`: a deny entry covers it; `allow`: an explicit allow list leaves it out; `empty-allow`: no tools at all. */
  kind: 'deny' | 'allow' | 'empty-allow';
  /** The setting to change, as a config path. */
  setting: string;
  /** The deny entry that covers the tool. */
  entry?: string;
};

const record = (value: unknown): Record<string, any> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
);
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

export function policyEntryCovers(entry: string, tool: DisplayTool): boolean {
  const normalized = entry.trim().toLowerCase();
  if (normalized.includes('*')) {
    const pattern = new RegExp(`^${normalized.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return pattern.test(tool);
  }
  return NAMES[tool].includes(normalized);
}

/** Every display tool the agent's policy hides, with the first setting that hides it (denies win). */
export function diagnoseDisplayToolPolicy(config: unknown, agentId: string): DisplayToolFinding[] {
  const global = record(record(config)?.tools);
  const agentPath = `agents.entries.${agentId}.tools`;
  const agent = record(record(record(record(config)?.agents)?.entries)?.[agentId]?.tools);
  const scopes = [{ path: 'tools', policy: global }, { path: agentPath, policy: agent }];
  // An agent's own allow list replaces the global one; alsoAllow adds in both scopes.
  const allowScope = Array.isArray(agent?.allow) ? { path: agentPath, policy: agent } : Array.isArray(global?.allow) ? { path: 'tools', policy: global } : null;
  const alsoAllow = [...names(global?.alsoAllow), ...names(agent?.alsoAllow)];

  const findings: DisplayToolFinding[] = [];
  for (const tool of DISPLAY_TOOLS) {
    const finding = denyFinding(tool, scopes) ?? allowFinding(tool, allowScope, alsoAllow);
    if (finding) findings.push(finding);
  }
  return findings;
}

function denyFinding(tool: DisplayTool, scopes: Array<{ path: string; policy: Record<string, any> | null }>): DisplayToolFinding | null {
  for (const { path, policy } of scopes) {
    const entry = names(policy?.deny).find(candidate => policyEntryCovers(candidate, tool));
    if (entry) return { tool, kind: 'deny', setting: `${path}.deny`, entry };
    for (const [provider, providerPolicy] of Object.entries(record(policy?.byProvider) ?? {})) {
      const providerEntry = names(record(providerPolicy)?.deny).find(candidate => policyEntryCovers(candidate, tool));
      if (providerEntry) return { tool, kind: 'deny', setting: `${path}.byProvider.${provider}.deny`, entry: providerEntry };
    }
  }
  return null;
}

function allowFinding(
  tool: DisplayTool,
  scope: { path: string; policy: Record<string, any> | null } | null,
  alsoAllow: string[],
): DisplayToolFinding | null {
  if (!scope) return null;
  const allow = names(scope.policy?.allow);
  if (allow.length === 0) return { tool, kind: 'empty-allow', setting: `${scope.path}.allow` };
  if ([...allow, ...alsoAllow].some(entry => policyEntryCovers(entry, tool))) return null;
  return { tool, kind: 'allow', setting: `${scope.path}.allow` };
}
