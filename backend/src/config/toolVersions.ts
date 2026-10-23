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

export const ANTIGRAVITY_NO_UPDATE_ENV = 'AGY_CLI_DISABLE_AUTO_UPDATE=true';

/**
 * The same guard shaped for `spawn` options rather than a shell prefix. Every
 * managed `agy` launch must carry it. Without it the CLI self-updates, moves
 * off the pinned version declared above, and then fails Portal's own launcher
 * verification — which is how a healthy host came to report a Remote Desktop
 * setup warning it could not act on.
 */
export const ANTIGRAVITY_NO_UPDATE_SPAWN_ENV = Object.freeze({
  AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
});
