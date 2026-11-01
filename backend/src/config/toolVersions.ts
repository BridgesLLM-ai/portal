export const PORTAL_TOOL_VERSIONS = Object.freeze({
  openClaw: '2026.10.6',
  codexCli: '0.163.0',
  claudeCode: '2.1.309',
  clawhub: '0.23.3',
  antigravity: '1.4.3',
  grokBuild: '1.0.62',
  ollama: '0.40.6',
  hermes: '0.22.2',
  openCode: '1.19.4',
});

/**
 * Lowest version each floor-pinned harness runs at: the versions the Portal
 * tested. Newer versions are admitted when their protocol handshake holds
 * (agents/harnessVersionPolicy.ts); older ones are refused.
 */
export const PORTAL_TOOL_FLOORS = Object.freeze({
  antigravity: PORTAL_TOOL_VERSIONS.antigravity,
  grokBuild: PORTAL_TOOL_VERSIONS.grokBuild,
  ollama: PORTAL_TOOL_VERSIONS.ollama,
  hermes: PORTAL_TOOL_VERSIONS.hermes,
  openCode: PORTAL_TOOL_VERSIONS.openCode,
});

/**
 * Proposed recommended versions: the newest upstream releases on 2026-10-30.
 * PROPOSED, NOT PROVEN — no qualification run has passed on them yet, so
 * nothing installs or admits them because they are listed here.
 */
export const PORTAL_TOOL_RECOMMENDED = Object.freeze({
  status: 'proposed' as const,
  versions: Object.freeze({
    openCode: '1.19.5',
    hermes: '0.22.5',
    grokBuild: '1.0.70',
    antigravity: '1.4.12',
    ollama: '0.40.13',
  }),
});
