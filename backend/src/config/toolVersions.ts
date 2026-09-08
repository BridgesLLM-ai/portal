export const PORTAL_TOOL_VERSIONS = Object.freeze({
  openClaw: '2026.9.1',
  codexCli: '0.153.2',
  claudeCode: '2.1.260',
  clawhub: '0.23.3',
  antigravity: '1.1.17',
  grokBuild: '1.0.5',
  ollama: '0.32.15',
  hermes: '0.20.4',
  openCode: '1.18.19',
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
