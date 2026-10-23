/**
 * Portal Chat Bridge MCP server (stdio).
 *
 * The harness launches this file as an MCP server for one Agent Chat turn.
 * It holds no authority of its own: every tool call is forwarded to the
 * Portal backend over a root-only Unix socket with the per-turn token the
 * Portal placed in this process's environment. Node built-ins only.
 */
import http from 'http';
import { CHAT_BRIDGE_ENV, CHAT_BRIDGE_SERVER_NAME, CHAT_BRIDGE_TOOL_TIMEOUT_MS } from './contract';

type JsonRpcId = string | number;

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_VERSION = '1.0.0';

const WIDGET_CDN_HINT = 'cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com, esm.sh and Google/Bunny fonts';

export const CHAT_BRIDGE_TOOLS = [
  {
    name: 'ask_user',
    title: 'Ask the user',
    description: 'Ask the person in this Portal chat one to four questions and wait for the answer. '
      + 'Use it when you need a decision, missing information or confirmation before continuing; '
      + 'do not use it for rhetorical questions or to end your turn. Offer two to six short options when the choices are known. '
      + 'The person can always type a different answer unless allowOther is false. Returns what they answered.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The complete question.' },
              header: { type: 'string', description: 'Very short label, at most 12 characters.' },
              options: {
                type: 'array',
                maxItems: 8,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow more than one option.' },
              allowOther: { type: 'boolean', description: 'Allow a typed answer. Defaults to true.' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'show_widget',
    title: 'Show an interactive widget',
    description: 'Render an interactive HTML widget (chart, table, diagram, calculator, small app) inline in the Portal chat. '
      + 'Pass a self-contained HTML fragment with inline <style> and <script>; scripts and styles may load pinned libraries from '
      + `${WIDGET_CDN_HINT}. It runs in an isolated sandbox with no network or Portal access, so embed all data. `
      + 'Use it when a visual or interactive view is clearer than text. Keep your reply short and do not repeat the HTML.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title shown above the widget.' },
        widget_code: { type: 'string', description: 'Self-contained HTML fragment (not a full document).' },
      },
      required: ['title', 'widget_code'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_goal',
    title: 'Read the conversation goal',
    description: 'Read the goal the person set for this Portal conversation, if any: objective, status and the last note.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'update_goal',
    title: 'Settle the conversation goal',
    description: 'Only when this conversation has an active Portal goal: mark it "complete" once it is fully achieved, '
      + 'or "blocked" when you cannot continue without the person. Include a one-line note.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['complete', 'blocked'] },
        note: { type: 'string', description: 'One line: what was achieved, or what is needed.' },
      },
      required: ['status'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: JsonRpcId, result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function fail(id: JsonRpcId, code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function errorResult(text: string) {
  return { content: [{ type: 'text', text }], isError: true };
}

const inFlight = new Map<string, http.ClientRequest>();

function callPortal(id: JsonRpcId, name: string, args: unknown): Promise<unknown> {
  const socketPath = process.env[CHAT_BRIDGE_ENV.socket] || '';
  const token = process.env[CHAT_BRIDGE_ENV.token] || '';
  if (!socketPath || !token) {
    return Promise.resolve(errorResult('The Portal chat bridge is not configured for this session.'));
  }
  const body = JSON.stringify({ name, arguments: args ?? {} });
  return new Promise((resolve) => {
    const request = http.request({
      socketPath,
      path: '/v1/tools/call',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: CHAT_BRIDGE_TOOL_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        inFlight.delete(String(id));
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode === 200) {
          try {
            resolve(JSON.parse(text));
            return;
          } catch { /* fall through */ }
        }
        resolve(errorResult(response.statusCode === 401 || response.statusCode === 403
          ? 'The Portal chat bridge is no longer available for this turn.'
          : 'The Portal chat bridge could not complete this request.'));
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => {
      inFlight.delete(String(id));
      resolve(errorResult('The Portal chat bridge is unavailable.'));
    });
    inFlight.set(String(id), request);
    request.end(body);
  });
}

async function handle(message: any): Promise<void> {
  const { id, method, params } = message || {};
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CHAT_BRIDGE_SERVER_NAME, title: 'BridgesLLM Portal chat', version: SERVER_VERSION },
        instructions: 'Portal chat tools: ask_user to ask the person a question and wait for the answer; '
          + 'show_widget to render an interactive HTML widget inline in the chat; get_goal/update_goal for a goal '
          + 'the person set on this conversation.',
      });
      return;
    }
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: CHAT_BRIDGE_TOOLS });
      return;
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    case 'tools/call': {
      const name = typeof params?.name === 'string' ? params.name : '';
      if (!CHAT_BRIDGE_TOOLS.some((tool) => tool.name === name)) {
        reply(id, errorResult(`Unknown tool: ${name || '(none)'}`));
        return;
      }
      reply(id, await callPortal(id, name, params?.arguments));
      return;
    }
    case 'notifications/cancelled': {
      const target = params?.requestId;
      const request = target === undefined ? null : inFlight.get(String(target));
      if (request) request.destroy(new Error('cancelled'));
      return;
    }
    default:
      if (isRequest) fail(id, -32601, `Method not found: ${String(method)}`);
  }
}

function main(): void {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) {
      buffer = '';
      return;
    }
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      void handle(message).catch(() => undefined);
    }
  });
  process.stdin.on('end', () => {
    for (const request of inFlight.values()) request.destroy();
    process.exit(0);
  });
}

if (require.main === module) main();
