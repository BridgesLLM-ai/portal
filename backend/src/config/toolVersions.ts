export const PORTAL_TOOL_VERSIONS = Object.freeze({
  codexCli: '0.145.0',
  claudeCode: '2.1.220',
  clawhub: '0.23.1',
  antigravity: '1.1.7',
  grokBuild: '0.2.112',
});

export const ANTIGRAVITY_NO_UPDATE_ENV = 'AGY_CLI_DISABLE_AUTO_UPDATE=1';

/**
 * The same guard shaped for `spawn` options rather than a shell prefix. Every
 * managed `agy` launch must carry it. Without it the CLI self-updates, moves
 * off the pinned version declared above, and then fails Portal's own launcher
 * verification — which is how a healthy host came to report a Remote Desktop
 * setup warning it could not act on.
 */
export const ANTIGRAVITY_NO_UPDATE_SPAWN_ENV = Object.freeze({
  AGY_CLI_DISABLE_AUTO_UPDATE: '1',
});
