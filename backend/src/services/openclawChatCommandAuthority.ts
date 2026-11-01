import { isElevatedRole } from '../utils/authz';

// OpenClaw runs slash commands, directives and configured /<alias> model
// shorthands found in chat text with the authority of the connection that sent
// it. The Portal's chat transports connect as operator.admin, which OpenClaw
// treats as the owner: `/model <x> -g` (also inline, or as a configured alias)
// writes the host-wide default model, and /restart, /update, /config and other
// owner commands become reachable. That authority stays with the accounts that
// already hold host model/configuration authority in the Portal: Owner and
// Admin, the roles Model Providers admits (requireAdmin). Every other sender's
// text carries OpenClaw's own `suppressCommandInterpretation`: OpenClaw then
// denies command authorization for that message and interprets no command,
// directive, alias or skill reference in it, and the model receives the text
// unchanged. OpenClaw 2026.9.1 (the Portal's floor) through 2026.10.9 accept
// the flag from admin-scoped clients only, which the Portal's transports are;
// 2026.9.1 sets the same CommandAuthorized:false and command/directive gates
// but does not consult the flag in command-auth itself. A missing or
// unknown role is treated as an ordinary user (fail closed).

/** True when this Portal role may use OpenClaw chat commands and directives. */
export function openClawChatCommandsAllowed(role: unknown): boolean {
  return typeof role === 'string' && isElevatedRole(role);
}

/** chat.send parameters for a message whose sender may not use chat commands. */
export const OPENCLAW_PLAIN_TEXT_CHAT_PARAMS = Object.freeze({ suppressCommandInterpretation: true as const });

/** The chat.send parameters that carry this sender's command authority. */
export function openClawChatCommandParams(allowChatCommands: boolean): { suppressCommandInterpretation?: true } {
  return allowChatCommands ? {} : { ...OPENCLAW_PLAIN_TEXT_CHAT_PARAMS };
}
