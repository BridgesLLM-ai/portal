import type { NativeChatTurnTools } from '../NativeChatTurnTools';
import type { AcpStdioMcpServer, AcpToolIdentityInput } from './AcpStdioBroker';

/**
 * Portal Chat Bridge wiring shared by the ACP harnesses (Grok Build, Hermes,
 * OpenCode). The bridge is offered as one stdio MCP server in session/new and
 * session/load; its capability token travels in the JSON-RPC `env` field over
 * the agent's stdin pipe, never in argv.
 */

export function acpBridgeMcpServers(tools: NativeChatTurnTools): AcpStdioMcpServer[] {
  const bridge = tools.bridgeOpen ? tools.bridge : null;
  if (!bridge) return [];
  return [{
    name: bridge.launch.serverName,
    command: bridge.launch.command,
    args: [...bridge.launch.args],
    env: Object.entries(bridge.launch.env).map(([name, value]) => ({ name, value })),
  }];
}

function metaString(meta: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Recognise bridge calls from what an ACP agent reports. Hermes titles MCP
 * calls with the prefixed tool name (`mcp__bridgesllm__show_widget`, from its
 * tools/mcp_tool_schema.py); other agents may use the title, kind or `_meta`.
 * Presentation only: widgets and questions are authorised by the bridge
 * registry, not by this name.
 */
export function acpBridgeToolResolver(tools: NativeChatTurnTools): (input: AcpToolIdentityInput) => string | null {
  return (input) => {
    const meta = input.meta || {};
    const nested = meta.claudeCode && typeof meta.claudeCode === 'object' ? meta.claudeCode as Record<string, unknown> : {};
    const candidates = [
      input.title,
      input.kind,
      metaString(meta, 'toolName', 'tool_name', 'name'),
      metaString(nested, 'toolName'),
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate && tools.identify(candidate)) return candidate;
    }
    const server = metaString(meta, 'server', 'mcpServer', 'serverName', 'mcp_server');
    const tool = metaString(meta, 'tool', 'mcpTool', 'toolName', 'tool_name');
    if (server && tool && tools.identify(tool, { server, tool })) return `mcp__${server}__${tool}`;
    return null;
  };
}
