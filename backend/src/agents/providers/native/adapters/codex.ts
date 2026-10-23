import fs from 'fs';
import path from 'path';
import {
  validateNativeHostModel,
  validateNativeHostPrompt,
  validateNativeHostSessionId,
  type NativeCliProviderAdapter,
  type NativeCliTurnContext,
} from '../types';
import { firstAbsolutePathDir, looksLikePermissionFailure } from '../approvalScope';
import { buildNativeCliEnvironment } from '../NativeCliEnvironment';
import {
  CODEX_PROJECT_RUNTIME,
  buildCodexProjectInvocation,
} from '../projectSandbox/CodexProjectSandbox';
import { CHAT_BRIDGE_SERVER_NAME, type ChatBridgeTurn } from '../../../chatBridge/contract';
import type { NativeSessionData } from '../../NativeSessionStore';
import { assertImageInputModality, ChatImageError } from '../../../../services/chatImages/chatImageModelPolicy';

const CODEX_REASONING_EFFORT = 'medium';
const CODEX_REASONING_SUMMARY = 'auto';
const CODEX_MODELS_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const CODEX_CONFIG_MAX_BYTES = 1024 * 1024;
const CODEX_FILE_CHANGES_MAX = 200;
const CODEX_PLAN_STEPS_MAX = 100;
const CODEX_TOOL_TEXT_MAX = 16 * 1024;
/** Absolute ASCII paths whose JSON string form is also a valid TOML basic string. */
const CODEX_TOML_SAFE_PATH = /^\/[A-Za-z0-9._/@+-]{1,4095}$/;
const CODEX_MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function codexHome(): string {
  return String(process.env.CODEX_HOME || '').trim() || path.join(process.env.HOME || '/root', '.codex');
}

function readBoundedFile(file: string, maxBytes: number): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Top-level `model = "..."` from the host Codex config (read-only, never mutated). */
function configuredCodexModel(): string | null {
  const raw = readBoundedFile(path.join(codexHome(), 'config.toml'), CODEX_CONFIG_MAX_BYTES);
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*model\s*=\s*"([^"\\]{1,255})"\s*(?:#.*)?$/.exec(line);
    if (match) return validateNativeHostModel(match[1]);
  }
  return null;
}

/**
 * Codex's own model metadata (`models_cache.json`, written by the CLI from
 * its authenticated catalog) declares each model's `input_modalities`.
 */
async function assertCodexImageModel(session: NativeSessionData): Promise<string> {
  const raw = readBoundedFile(path.join(codexHome(), 'models_cache.json'), CODEX_MODELS_CACHE_MAX_BYTES);
  let models: Array<Record<string, unknown>> = [];
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    models = Array.isArray(parsed?.models) ? parsed.models.filter((entry: unknown) => entry && typeof entry === 'object') : [];
  } catch {
    models = [];
  }
  if (models.length === 0) throw new ChatImageError('IMAGE_MODEL_UNAVAILABLE', 503);
  const model = validateNativeHostModel(session.model) || configuredCodexModel();
  if (model) {
    const entry = models.find((candidate) => candidate.slug === model);
    if (!entry) throw new ChatImageError('IMAGE_MODEL_UNAVAILABLE', 503);
    assertImageInputModality(entry.input_modalities);
    return model;
  }
  // No explicit model anywhere: Codex picks from its listed catalog, so every
  // listed model must accept images.
  const listed = models.filter((candidate) => candidate.visibility === 'list');
  if (listed.length === 0) throw new ChatImageError('IMAGE_MODEL_UNAVAILABLE', 503);
  for (const entry of listed) assertImageInputModality(entry.input_modalities);
  return 'codex-default';
}

function codexBridgeConfig(bridge: ChatBridgeTurn): string[] {
  const { command, args, env, toolTimeoutMs } = bridge.launch;
  if (!CODEX_TOML_SAFE_PATH.test(command) || args.length !== 1 || !CODEX_TOML_SAFE_PATH.test(args[0])) {
    throw new Error('Codex chat bridge launch is invalid');
  }
  const envNames = Object.keys(env).sort();
  if (envNames.length === 0 || envNames.some((name) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(name))) {
    throw new Error('Codex chat bridge environment is invalid');
  }
  const key = `mcp_servers.${CHAT_BRIDGE_SERVER_NAME}`;
  // Command and script path only; the token reaches the MCP child through the
  // named environment variables Codex forwards, never argv.
  return [
    '-c', `${key}.command=${JSON.stringify(command)}`,
    '-c', `${key}.args=[${args.map((entry) => JSON.stringify(entry)).join(',')}]`,
    '-c', `${key}.env_vars=[${envNames.map((name) => JSON.stringify(name)).join(',')}]`,
    '-c', `${key}.tool_timeout_sec=${Math.max(1, Math.ceil(toolTimeoutMs / 1000))}`,
    // Probed 0.159.0: without this, exec fails "MCP tool call requires approval".
    '-c', `${key}.default_tools_approval_mode="approve"`,
    '-c', `${key}.enabled=true`,
  ];
}

function boundedText(value: unknown, maxBytes = CODEX_TOOL_TEXT_MAX): string {
  const text = typeof value === 'string' ? value : '';
  const bytes = Buffer.from(text, 'utf8');
  return bytes.length <= maxBytes ? text : `${bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '')}…`;
}

function codexItemId(item: any): string | undefined {
  return typeof item?.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
}

function codexMcpResultText(item: any): string {
  const content = Array.isArray(item?.result?.content) ? item.result.content : [];
  return boundedText(content
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('\n'));
}

function codexMcpErrorText(item: any): string {
  const error = item?.error;
  if (typeof error === 'string') return boundedText(error);
  if (error && typeof error === 'object' && typeof error.message === 'string') return boundedText(error.message);
  return '';
}

function codexFileChanges(item: any): Array<{ path: string; kind: 'add' | 'delete' | 'update' }> {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes.slice(0, CODEX_FILE_CHANGES_MAX).flatMap((change: any) => {
    const filePath = typeof change?.path === 'string' ? change.path : '';
    if (!filePath) return [];
    const rawKind = typeof change?.kind === 'string' ? change.kind : change?.kind?.type;
    const kind = rawKind === 'add' || rawKind === 'delete' ? rawKind : 'update';
    return [{ path: boundedText(filePath, 4096), kind }];
  });
}

function codexPlan(item: any): Array<{ step: string; status: 'pending' | 'completed' }> {
  const items = Array.isArray(item?.items) ? item.items : [];
  return items.slice(0, CODEX_PLAN_STEPS_MAX).flatMap((entry: any) => {
    const step = typeof entry?.text === 'string' ? boundedText(entry.text.trim(), 2048) : '';
    return step ? [{ step, status: entry?.completed === true ? 'completed' as const : 'pending' as const }] : [];
  });
}

/** Codex keeps one todo_list item per turn; each distinct state becomes one plan card. */
function emitCodexPlanUpdate(ctx: NativeCliTurnContext, item: any): void {
  const itemId = codexItemId(item);
  if (!itemId) return;
  const plan = codexPlan(item);
  const seen = (ctx.state.codexPlanStates ||= {}) as Record<string, { signature: string; count: number }>;
  const signature = JSON.stringify(plan);
  const previous = seen[itemId];
  if (previous?.signature === signature) return;
  const count = (previous?.count || 0) + 1;
  seen[itemId] = { signature, count };
  const toolCallId = `${itemId}:plan:${count}`;
  const completed = plan.filter((entry) => entry.status === 'completed').length;
  ctx.onStatus?.({
    type: 'tool_start',
    content: 'Updated task plan',
    toolName: 'update_plan',
    toolArgs: { plan },
    toolCallId,
  });
  ctx.onStatus?.({
    type: 'tool_end',
    content: `Task plan updated (${completed}/${plan.length})`,
    toolName: 'update_plan',
    toolResult: `${completed}/${plan.length} steps completed`,
    status: 'completed',
    toolCallId,
  });
}

function markCodexApprovalCandidate(ctx: Parameters<NativeCliProviderAdapter['handleStdoutLine']>[1], detail: {
  command?: string;
  text?: string;
  toolName?: string;
}): boolean {
  const text = [detail.command, detail.text].filter(Boolean).join('\n');
  if (!looksLikePermissionFailure(text)) return false;
  ctx.state.codexApprovalCandidate = {
    command: detail.command || detail.text || 'Codex CLI command',
    toolName: detail.toolName || 'shell',
    addDir: firstAbsolutePathDir(text),
  };
  return true;
}

export const codexAdapter: NativeCliProviderAdapter = {
  providerName: 'CODEX',
  displayName: 'Codex',
  cliCommand: '/usr/bin/codex',
  messageIdPrefix: 'codex-msg',
  initialStatus: 'Codex is working…',
  spawnErrorPrefix: 'Failed to spawn codex CLI',
  supportsChatBridge: true,
  supportsChatImages: true,
  scopeToolCallIds: true,
  assertChatImageModel: assertCodexImageModel,
  configureSession: (_userId, config) => {
    if (config.executionContext.scope !== 'PROJECT_SANDBOX') return config;
    return {
      ...config,
      metadata: {
        ...(config.metadata || {}),
        cwd: config.executionContext.canonicalRoot,
        projectRuntime: CODEX_PROJECT_RUNTIME,
        sandboxPolicyFingerprint: config.executionContext.policyFingerprint,
      },
    };
  },
  buildInvocation: async (ctx) => {
    const nativeSessionId = typeof ctx.session.metadata?.nativeSessionId === 'string' && ctx.session.metadata.nativeSessionId.trim()
      ? String(ctx.session.metadata.nativeSessionId).trim()
      : null;
    ctx.state.nativeSessionId = nativeSessionId;
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
      return buildCodexProjectInvocation({
        executionContext: ctx.session.executionContext,
        turnId: String(ctx.state.portalRunId || ''),
        nativeSessionId,
        model: ctx.session.model,
        message: ctx.message,
      });
    }
    const hostSessionId = validateNativeHostSessionId(nativeSessionId, false);
    const hostModel = validateNativeHostModel(ctx.session.model);
    const hostPrompt = validateNativeHostPrompt(ctx.message);
    const approvedBypass = ctx.state.codexApprovedExecution === true;
    const args = hostSessionId
      ? ['exec', 'resume', hostSessionId, '--skip-git-repo-check', '--json']
      : ['exec', '--skip-git-repo-check', '--color', 'never', '--json'];
    if (approvedBypass) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (hostSessionId) {
      // `codex exec resume` has no --sandbox option. Pin the typed config
      // override so a resumed ordinary turn cannot inherit a permissive
      // machine-local config.toml.
      args.push('-c', 'sandbox_mode="workspace-write"');
    } else {
      args.push('--sandbox', 'workspace-write');
    }
    if (hostModel) args.push('--model', hostModel);
    // `--image <FILE>...` is variadic: every image flag is followed by
    // another option, never by the `-` stdin prompt marker.
    for (const file of (ctx.chatImages || []).length > 0 ? ctx.materializeChatImageFiles?.() || [] : []) {
      args.push('--image', file);
    }
    if ((ctx.chatImages || []).length > 0 && !args.includes('--image')) {
      throw new Error('Codex photo input could not be prepared');
    }
    // Codex's own plan tool feeds the Portal Work panel (todo_list items).
    args.push('-c', 'tools.update_plan.enabled=true');
    const bridge = ctx.chatBridge || null;
    if (bridge) args.push(...codexBridgeConfig(bridge));
    args.push('-c', `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`);
    args.push('-c', `model_reasoning_summary="${CODEX_REASONING_SUMMARY}"`);
    args.push('-');
    return {
      command: '/usr/bin/codex',
      args,
      stdinText: hostPrompt,
      // Host runs deliver this environment over the activation socket only.
      ...(bridge ? { options: { env: { ...buildNativeCliEnvironment('CODEX'), ...bridge.launch.env } } } : {}),
    };
  },
  handleStdoutLine: (line, ctx) => {
    let parsed: any;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      const plain = ctx.stripAnsi(line.trim());
      if (plain) {
        ctx.setFullText(ctx.fullText ? `${ctx.fullText}
${plain}` : plain);
        ctx.emitChunk(`${plain}
`);
      }
      return;
    }

    const type = parsed?.type;
    if (type === 'thread.started' && typeof parsed?.thread_id === 'string' && parsed.thread_id.trim()) {
      const resolvedThreadId = parsed.thread_id.trim();
      // The Portal session ID is the immutable local identity for every scope.
      // Codex's thread UUID is provider resume metadata, never a Portal rekey.
      ctx.state.nativeSessionId = resolvedThreadId;
      ctx.updateSessionMetadata({ nativeSessionId: resolvedThreadId });
      if (ctx.session.executionContext?.scope !== 'PROJECT_SANDBOX') {
        ctx.onStatus?.({
          type: 'session',
          sessionId: ctx.session.sessionId,
          nativeSessionId: resolvedThreadId,
        });
      }
      return;
    }

    if (type === 'item.completed' && parsed?.item?.type === 'agent_message' && parsed?.item?.text) {
      const text = String(parsed.item.text).trim();
      if (markCodexApprovalCandidate(ctx, { text, toolName: 'shell' })) {
        ctx.state.codexSuppressedApprovalText = text;
        return;
      }
      ctx.setLastAssistantMessage(text);
      if (text) {
        ctx.emitChunk(text);
        ctx.setFullText(text);
      }
      return;
    }

    if ((type === 'item.started' || type === 'item.updated' || type === 'item.completed') && parsed?.item?.type === 'command_execution') {
      const command = typeof parsed.item.command === 'string' ? parsed.item.command : 'shell command';
      const output = typeof parsed.item.aggregated_output === 'string' ? parsed.item.aggregated_output : '';
      const toolCallId = typeof parsed.item.id === 'string' && parsed.item.id.trim()
        ? parsed.item.id.trim()
        : undefined;
      if (type === 'item.started') {
        ctx.onStatus?.({
          type: 'tool_start',
          content: `Codex is running ${command}`,
          toolName: 'shell',
          toolArgs: { command },
          toolCallId,
        });
      } else if (type === 'item.updated') {
        ctx.onStatus?.({
          type: 'tool_update',
          content: output || `Codex is running ${command}`,
          toolName: 'shell',
          toolResult: output,
          toolCallId,
        });
      } else {
        markCodexApprovalCandidate(ctx, { command, text: output, toolName: 'shell' });
        ctx.onStatus?.({
          type: 'tool_end',
          content: output || `Command exited with ${parsed.item.exit_code ?? 0}`,
          toolName: 'shell',
          toolResult: output,
          status: parsed.item.status,
          exitCode: parsed.item.exit_code,
          toolCallId,
        });
      }
      return;
    }

    const lifecycle = type === 'item.started' ? 'start' : type === 'item.updated' ? 'update' : type === 'item.completed' ? 'end' : null;
    const item = parsed?.item;
    if (lifecycle && item?.type === 'mcp_tool_call') {
      const server = typeof item.server === 'string' ? item.server.trim() : '';
      const tool = typeof item.tool === 'string' ? item.tool.trim() : '';
      if (!CODEX_MCP_NAME.test(server) || !CODEX_MCP_NAME.test(tool)) return;
      const toolName = `mcp__${server}__${tool}`;
      const toolCallId = codexItemId(item);
      const toolArgs = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
      if (lifecycle === 'start') {
        ctx.onStatus?.({ type: 'tool_start', content: `Codex is using ${toolName}`, toolName, toolArgs, toolCallId });
      } else if (lifecycle === 'update') {
        ctx.onStatus?.({ type: 'tool_update', content: `Codex is using ${toolName}`, toolName, toolArgs, toolCallId });
      } else {
        const errorText = codexMcpErrorText(item);
        const isError = item.status === 'failed' || Boolean(errorText);
        const resultText = isError ? errorText || 'The MCP tool call failed.' : codexMcpResultText(item);
        ctx.onStatus?.({
          type: 'tool_end',
          content: resultText || (isError ? `${toolName} failed` : `${toolName} completed`),
          toolName,
          toolArgs,
          toolResult: resultText,
          isError,
          status: isError ? 'failed' : 'completed',
          toolCallId,
        });
      }
      return;
    }

    if (lifecycle && item?.type === 'file_change') {
      const changes = codexFileChanges(item);
      const toolCallId = codexItemId(item);
      const summary = changes.map((change) => `${change.kind} ${change.path}`).join('\n');
      if (lifecycle === 'start' || lifecycle === 'update') {
        ctx.onStatus?.({
          type: lifecycle === 'start' ? 'tool_start' : 'tool_update',
          content: 'Codex is editing files',
          toolName: 'file_change',
          toolArgs: { changes },
          toolCallId,
        });
      } else {
        const isError = item.status === 'failed';
        ctx.onStatus?.({
          type: 'tool_end',
          content: summary || (isError ? 'File change failed' : 'Files changed'),
          toolName: 'file_change',
          toolArgs: { changes },
          toolResult: summary,
          isError,
          status: isError ? 'failed' : 'completed',
          toolCallId,
        });
      }
      return;
    }

    if (lifecycle && item?.type === 'web_search') {
      const query = typeof item.query === 'string' && item.query.trim()
        ? item.query.trim()
        : typeof item.action?.query === 'string' ? item.action.query.trim() : '';
      const toolCallId = codexItemId(item);
      if (lifecycle === 'start' || lifecycle === 'update') {
        ctx.onStatus?.({
          type: lifecycle === 'start' ? 'tool_start' : 'tool_update',
          content: query ? `Codex is searching the web for ${query}` : 'Codex is searching the web',
          toolName: 'web_search',
          toolArgs: { query },
          toolCallId,
        });
      } else {
        const results = Array.isArray(item.results) ? item.results.slice(0, 10) : [];
        const resultText = boundedText(results
          .map((result: any) => [result?.title, result?.domain, result?.url, result?.snippet]
            .filter((part) => typeof part === 'string' && part.trim()).join(' — '))
          .filter(Boolean)
          .join('\n'));
        ctx.onStatus?.({
          type: 'tool_end',
          content: resultText || 'Web search completed',
          toolName: 'web_search',
          toolArgs: { query },
          toolResult: resultText,
          status: 'completed',
          toolCallId,
        });
      }
      return;
    }

    if (lifecycle && item?.type === 'todo_list') {
      emitCodexPlanUpdate(ctx, item);
      return;
    }

    if (type === 'item.completed' && parsed?.item?.type === 'reasoning') {
      // Codex reports a reasoning item either as plain `text` or as a
      // `summary` array of `summary_text` entries. Only the first shape was
      // read, so a turn that produced a real summary — the common case once an
      // effort is in play — rendered no thinking at all.
      const summaryText = Array.isArray(parsed.item.summary)
        ? parsed.item.summary
          .map((entry: any) => (typeof entry?.text === 'string' ? entry.text : ''))
          .filter((entry: string) => entry.trim().length > 0)
          .join('\n')
        : '';
      const reasoningText = typeof parsed.item.text === 'string' && parsed.item.text.trim()
        ? parsed.item.text
        : summaryText;
      if (reasoningText.trim()) {
        ctx.onStatus?.({ type: 'thinking', content: String(reasoningText) });
      }
      return;
    }
  },
  finalizeTurn: async (ctx) => {
    const candidate = ctx.state.codexApprovalCandidate;
    if (ctx.session.executionContext?.scope === 'PROJECT_SANDBOX') {
      if (candidate) {
        const denialText = String(
          ctx.state.codexSuppressedApprovalText
          || 'Codex could not complete that operation because the Project Sandbox blocked access outside this project.',
        );
        ctx.emitStatus('Codex Project Sandbox blocked an operation outside the project boundary.', {
          permissionDenials: [candidate],
        });
        ctx.setFullText(denialText);
      }
      return;
    }
    if (!candidate || ctx.state.retryStarted || ctx.state.codexApprovedExecution) return;

    ctx.emitStatus('Codex is waiting for command approval…', { permissionDenials: [candidate] });
    const decision = await ctx.requestApproval({
      command: String(candidate.command || 'Codex CLI command'),
      security: 'native-cli',
      ask: 'Codex CLI needs broader execution scope to continue this turn.',
      resolvedPath: typeof candidate.addDir === 'string' ? candidate.addDir : undefined,
      timeoutMs: 120_000,
    });
    if (decision === 'deny') {
      ctx.emitStatus('Codex permission request was denied.', { permissionDenials: [candidate] });
      ctx.setFullText(String(ctx.state.codexSuppressedApprovalText || 'Codex permission request was denied.'));
      return;
    }

    ctx.state.codexApprovedExecution = true;
    ctx.state.codexApprovalCandidate = null;
    ctx.state.retryRequested = true;
    ctx.emitStatus('Permission approved. Retrying Codex with the approved execution scope…');
  },
  getResultText: (ctx) => ctx.fullText || ctx.lastAssistantMessage,
  getResultMetadata: (ctx) => ({
    provider: 'codex-cli',
    exitCode: ctx.exitCode,
    model: ctx.session.model || null,
    executionScope: ctx.session.executionContext?.scope || null,
    runtime: ctx.session.executionContext?.scope === 'PROJECT_SANDBOX' ? CODEX_PROJECT_RUNTIME : 'codex-cli',
    resolvedSessionId: ctx.session.sessionId,
    nativeSessionId: ctx.state.nativeSessionId || ctx.session.metadata?.nativeSessionId || null,
  }),
  getErrorMessage: (ctx) => {
    if (ctx.session.executionContext?.scope !== 'PROJECT_SANDBOX') {
      return ctx.stderr || `Codex CLI exited with code ${ctx.exitCode}`;
    }
    const detail = String(ctx.stderr || '').toLowerCase();
    if (/auth|oauth|token|login|unauthori[sz]ed/.test(detail)) {
      return 'Codex authentication is unavailable. Reconnect Codex in AI Settings and retry.';
    }
    if (/model|entitlement|not found|unsupported/.test(detail)) {
      return 'Codex rejected the configured Project model. Choose an available Codex model and retry.';
    }
    return 'The confined Codex Project runtime ended before completing the turn.';
  },
};
