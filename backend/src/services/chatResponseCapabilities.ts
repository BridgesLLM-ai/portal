import type { AgentProviderName } from '../agents/AgentProvider.interface';
import { getHarnessDefinition } from '../agents/harnessCatalog';
import { chatBridgeMcpServerPath } from '../agents/chatBridge';
import { getOpenClawCapabilities, supportsOpenClawInlineWidgets, type OpenClawCapabilities } from './openClawCompatibility';

export const RESPONSE_FORMATS = ['auto', 'mermaid', 'widget', 'code', 'file'] as const;
export type ChatResponseFormat = typeof RESPONSE_FORMATS[number];

export function parseChatResponseFormat(value: unknown): ChatResponseFormat {
  if (value === undefined) return 'auto';
  if (typeof value === 'string' && (RESPONSE_FORMATS as readonly string[]).includes(value)) return value as ChatResponseFormat;
  throw new Error('Unknown response format. Refresh the chat and select a response tool.');
}

/**
 * Harnesses whose Portal provider delivers a next-response preference at its
 * own prompt seam, leaving the persisted user message exactly as authored.
 * OpenClaw stores the transmitted text upstream and uses request-bound
 * display attestation instead (portalResponseContext).
 */
const PREFERENCE_HARNESSES: ReadonlySet<string> = new Set([
  'OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'GEMINI', 'GROK', 'HERMES', 'OPENCODE', 'OLLAMA',
]);

/**
 * Harnesses that receive the Portal Chat Bridge (ask_user, show_widget, goals)
 * on Agent Chat turns. The bridge is what gives these harnesses Portal
 * questions, so the catalog's supportsAskUser is the same fact.
 */
export function harnessReceivesChatBridge(provider: string): boolean {
  const definition = getHarnessDefinition(provider);
  return Boolean(definition && definition.transport !== 'gateway' && definition.capabilities.supportsAskUser);
}

export interface ResponseCapabilityContext {
  openClaw?: OpenClawCapabilities;
  /** OpenClaw only: this session is a direct (non-Project) Agent Chat lane. */
  openClawWidgetLane?: boolean;
  /** Bridge harnesses only: the compiled Portal bridge server is installed. */
  bridgeServerReady?: boolean;
}

function widgetUnavailableReason(provider: string, context: ResponseCapabilityContext): string | null {
  if (provider === 'OPENCLAW') {
    const caps = context.openClaw ?? getOpenClawCapabilities();
    if (!caps.version) return 'OpenClaw is not connected. Reconnect before requesting a widget.';
    if (!supportsOpenClawInlineWidgets(caps)) {
      return caps.disabledReasons.inlineWidgets || 'This OpenClaw Gateway does not provide the Portal widget contract.';
    }
    if (context.openClawWidgetLane === false) return 'Widgets are available in direct Agent Chat conversations only.';
    return null;
  }
  if (!harnessReceivesChatBridge(provider)) return 'This harness has no Portal widget tool. Code Preview works here.';
  const ready = context.bridgeServerReady ?? chatBridgeMcpServerPath() !== null;
  return ready ? null : 'The Portal chat bridge is not installed on this server. Update Portal to restore widgets.';
}

/**
 * Transport qualification for the next turn, not a promise that an agent's
 * tool policy or a model will call a tool. Called only from actor-authorized
 * Agent Chat routes; it grants no tool and no Project capability.
 */
export function chatResponseCapabilities(provider: AgentProviderName | string, context: ResponseCapabilityContext = {}) {
  const preferences = PREFERENCE_HARNESSES.has(provider);
  const preferenceReason = preferences ? null : 'This harness does not accept response preferences yet.';
  const widgetReason = preferenceReason ?? widgetUnavailableReason(provider, context);
  const bridge = provider !== 'OPENCLAW' && harnessReceivesChatBridge(provider);
  return {
    schema: 'portal-response-tools-v1' as const,
    provider,
    formats: [
      { id: 'auto', label: 'Automatic', available: true, description: 'Let the agent choose the response format.', reason: null },
      { id: 'mermaid', label: 'Diagram', available: preferences, description: 'Flows and relationships, drawn directly in chat.', reason: preferenceReason },
      { id: 'widget', label: 'Interactive widget', available: !widgetReason,
        description: !bridge
          ? 'Explore an interactive result without leaving the chat.'
          : provider === 'OLLAMA'
            ? 'An interactive result in the chat, using the Portal widget tool. The model must support tools.'
            : 'Explore an interactive result in the chat, using the Portal widget tool for this turn.',
        reason: widgetReason },
      { id: 'code', label: 'Code Preview', available: preferences, description: 'A live preview alongside the code.', reason: preferenceReason },
      { id: 'file', label: 'Downloadable file', available: preferences, description: 'A file you can save and use.', reason: preferenceReason },
    ],
    widget: { transportReady: !widgetReason, reason: widgetReason, toolPolicy: 'checked-by-runtime' as const, newTurnOnly: true },
  };
}

const PREFERENCE_HINTS: Record<Exclude<ChatResponseFormat, 'auto' | 'widget'>, string> = {
  mermaid: 'The user selected Diagram. Return a valid fenced mermaid diagram; Mermaid is rendered by the chat, not a tool you need to find.',
  code: 'The user selected Code Preview. Return a complete self-contained fenced html or svg block (markdown is also previewable); the chat renders the preview. Do not claim an interactive preview was tested unless it was.',
  file: 'The user selected Downloadable file. Use an available authorized file-delivery tool and verify the link, or return a complete fenced code block, which the chat can download. Never invent a saved file, path or tool.',
};

/**
 * Pinned-widget guidance, sent only with an explicit Widget selection (never
 * per turn) and only while the Portal can follow a pinned widget's newest
 * version (OpenClaw board.get). The bridge show_widget has no pin or name.
 */
const PINNED_WIDGET_HINT = 'For something the user wants to watch, track or time, or to hear about when it is ready, pin it: show_widget with pin=true and a short stable name (a countdown, or a progress bar or status card for the watched thing). Update it by calling show_widget again with the same name and pin=true; the Widgets tab in the side panel shows its newest version. A countdown runs inside the widget from a fixed target time. One-off visuals stay inline (no pin).';

/**
 * The widget hint names only the discovery the harness really has. OpenClaw
 * Tool Search defers show_widget and progress_card behind tool_search and
 * tool_call; bridge harnesses get show_widget and ask_user from the
 * bridgesllm MCP server and have no tool_search.
 */
function widgetPreferenceHint(provider: string, context: ResponseCapabilityContext): string {
  if (provider === 'OPENCLAW') {
    const caps = context.openClaw ?? getOpenClawCapabilities();
    const progressTool = caps.progress ? 'progress_card' : 'your progress tool';
    return [
      'The user selected Interactive widget. Call the actual show_widget tool using its current schema.',
      'Under OpenClaw Tool Search it can be deferred: if it is not in your short tool list, search the tool catalog by name with tool_search, load its schema, and call it through tool_call. Never claim it is missing just because the short list omits it.',
      'If discovery shows it is denied or absent, say so plainly. Do not substitute a code block and claim a widget was delivered.',
      `A widget is not a question or a status report: use ask_user (when available) for questions that wait for an answer and ${progressTool} for task status; never fake either with a widget.`,
      ...(caps.liveWidgets ? [PINNED_WIDGET_HINT] : []),
    ].join(' ');
  }
  return [
    'The user selected Interactive widget. Call the show_widget tool from the Portal chat bridge (the bridgesllm MCP server; your harness may list it with a server prefix, such as mcp__bridgesllm__show_widget) using its current schema.',
    'If your harness defers MCP tools, load it with your harness\'s own tool discovery first. Never claim it is missing just because a short tool list omits it.',
    'If it is denied or absent, say so plainly. Do not substitute a code block and claim a widget was delivered.',
    'A widget is not a question or a status report: use the bridge\'s ask_user for questions that wait for an answer and your own plan or progress tool for task status; never fake either with a widget.',
  ].join(' ');
}

/**
 * The next-response preference as model context. Automatic leaves the message
 * unchanged. An explicit widget request without a ready widget transport is
 * refused before any run starts, instead of silently falling back.
 */
export function portalResponsePreference(
  message: string,
  provider: string,
  format: ChatResponseFormat,
  context: ResponseCapabilityContext = {},
): string {
  if (format === 'auto') return message;
  const caps = chatResponseCapabilities(provider, context);
  const selected = caps.formats.find((candidate) => candidate.id === format);
  if (!selected?.available) throw new Error(selected?.reason || 'This response format is unavailable for this chat.');
  return [
    '[Portal response preference]',
    format === 'widget' ? widgetPreferenceHint(provider, context) : PREFERENCE_HINTS[format],
    'This is a preference for this reply only. It grants no tool or permission; use only your current tools and existing permissions.',
    '[/Portal response preference]',
    '',
    message,
  ].join('\n');
}

/**
 * Provider prompt seam for native harnesses. The route has already refused an
 * unavailable explicit format before the run, so this only adds the hint.
 */
export function withSenderResponsePreference(
  message: string,
  provider: string,
  sender?: { portalResponseFormat?: ChatResponseFormat },
): string {
  const format = sender?.portalResponseFormat ?? 'auto';
  if (format === 'auto') return message;
  try {
    return portalResponsePreference(message, provider, format);
  } catch {
    // Readiness changed after admission (bridge removed mid-turn): send the
    // authored text unchanged rather than claiming an unavailable format.
    return message;
  }
}
