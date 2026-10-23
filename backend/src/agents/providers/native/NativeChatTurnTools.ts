import crypto from 'crypto';
import type { AgentProviderName, SenderIdentity } from '../../AgentProvider.interface';
import {
  NativeToolCallRecorder,
  openChatBridgeTurn,
  type ChatBridgeToolName,
  type ChatBridgeTurn,
  type NativePersistedToolCall,
} from '../../chatBridge';

/**
 * Per-turn Portal chat tooling shared by every native Agent Chat harness.
 *
 * One instance owns one logical turn: it opens the Portal Chat Bridge
 * capability (or runs without it, exactly as before), rewrites the tool events
 * the harness reports so the Portal sees canonical `ask_user` / `show_widget`
 * cards, binds widget results to the harness's own tool-call id, records every
 * tool event for the persisted assistant message, and revokes the capability
 * exactly once when the turn settles.
 */

export const WIDGET_UNBOUND_RESULT = 'The widget could not be shown: it was not created by this chat turn.';
const WIDGET_SHOWN_CONTENT = 'Widget shown in the chat';

export interface NativeChatTurnToolsInput {
  provider: AgentProviderName;
  portalSessionId: string;
  runId: string;
  sender?: SenderIdentity;
  /** False keeps today's behaviour: no bridge, but tool events are still recorded. */
  bridge: boolean;
  /** Scope every emitted tool-call id to this run (harnesses that reuse ids per turn). */
  scopeToolCallIds?: boolean;
}

/** Optional harness-reported identity that is not carried in the event itself. */
export interface NativeToolIdentityHint {
  /** MCP server name when the harness reports it separately (Codex, some ACP agents). */
  server?: string | null;
  /** Bare MCP tool name reported next to the server. */
  tool?: string | null;
}

type ToolEvent = Record<string, unknown>;

function isToolEvent(event: ToolEvent): boolean {
  return event.type === 'tool_start' || event.type === 'tool_update' || event.type === 'tool_end';
}

function widgetTitle(reference: string): string | null {
  try {
    const parsed = JSON.parse(reference);
    return typeof parsed?.title === 'string' ? parsed.title : null;
  } catch {
    return null;
  }
}

function argumentTitle(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const title = (args as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 160) : null;
}

export class NativeChatTurnTools {
  private readonly recorder = new NativeToolCallRecorder();
  private readonly canonicalById = new Map<string, ChatBridgeToolName>();
  private revoked = false;

  private constructor(readonly bridge: ChatBridgeTurn | null, private readonly idScope: string | null = null) {}

  /** A turn without the bridge (Project scope, unsupported harness, bridge unavailable). */
  static withoutBridge(idScope: string | null = null): NativeChatTurnTools {
    return new NativeChatTurnTools(null, idScope);
  }

  /** Short, stable, charset-safe tag for one run's tool-call ids. */
  static runScope(runId: string): string {
    return crypto.createHash('sha256').update(String(runId), 'utf8').digest('hex').slice(0, 12);
  }

  /**
   * Open the bridge for a HOST_OPERATOR turn. Any failure to open (no compiled
   * server, listener unavailable, incomplete sender evidence, a duplicate run)
   * degrades to a turn without the bridge — never to a failed turn.
   */
  static async open(input: NativeChatTurnToolsInput): Promise<NativeChatTurnTools> {
    const idScope = input.scopeToolCallIds ? NativeChatTurnTools.runScope(input.runId) : null;
    if (!input.bridge) return NativeChatTurnTools.withoutBridge(idScope);
    const userId = typeof input.sender?.userId === 'string' ? input.sender.userId.trim() : '';
    const authorizationVersion = Number(input.sender?.authorizationVersion);
    if (!userId || !Number.isSafeInteger(authorizationVersion) || authorizationVersion < 1) {
      return NativeChatTurnTools.withoutBridge(idScope);
    }
    let bridge: ChatBridgeTurn | null = null;
    try {
      bridge = await openChatBridgeTurn({
        provider: input.provider,
        portalSessionId: input.portalSessionId,
        runId: input.runId,
        userId,
        authorizationVersion,
      });
    } catch {
      bridge = null;
    }
    return new NativeChatTurnTools(bridge, idScope);
  }

  get bridgeOpen(): boolean {
    return Boolean(this.bridge) && !this.revoked;
  }

  /** Canonical bridge tool for a harness-reported name, or null. */
  identify(rawName: unknown, hint?: NativeToolIdentityHint): ChatBridgeToolName | null {
    if (!this.bridge) return null;
    if (hint?.server !== undefined && hint.server !== null) {
      return this.bridge.identifyTool(String(hint.tool ?? rawName ?? ''), hint.server)?.name ?? null;
    }
    return typeof rawName === 'string' ? this.bridge.identifyTool(rawName)?.name ?? null : null;
  }

  /** The id the Portal sees for a harness-reported tool-call id. */
  scopeId(rawId: string): string {
    if (!this.idScope || !rawId || rawId.endsWith(`@${this.idScope}`)) return rawId;
    return `${rawId}@${this.idScope}`;
  }

  /**
   * Rewrite one emitted status event for the Portal and record it. Returns the
   * event to publish. Non-tool events pass through untouched (ids scoped).
   */
  project<T extends ToolEvent>(input: T, hint?: NativeToolIdentityHint): T {
    if (!input || typeof input !== 'object') return input;
    const scoped = this.idScope && typeof input.toolCallId === 'string' && input.toolCallId
      ? { ...input, toolCallId: this.scopeId(input.toolCallId) } as T
      : input;
    if (!isToolEvent(scoped)) return scoped;
    // A structured harness result (ACP rawOutput) is used for widget binding
    // only and never published.
    const { rawResult, ...withoutRaw } = scoped as ToolEvent;
    const event = withoutRaw as T;
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
    let canonical = toolCallId ? this.canonicalById.get(toolCallId) ?? null : null;
    if (!canonical) {
      canonical = this.identify(event.toolName, hint);
      if (canonical && toolCallId) this.canonicalById.set(toolCallId, canonical);
    }
    let projected: ToolEvent = event;
    if (canonical) {
      projected = { ...event, toolName: canonical };
      if (canonical === 'show_widget') projected = this.projectWidgetEvent(projected, toolCallId, rawResult);
    }
    this.recorder.observe(projected);
    return projected as T;
  }

  private projectWidgetEvent(event: ToolEvent, toolCallId: string, rawResult?: unknown): ToolEvent {
    // The widget document is stored server-side; its HTML never travels the
    // stream bus or the transcript (same as the OpenClaw show_widget path).
    const { toolArgsDelta: _delta, ...rest } = event;
    const title = argumentTitle(event.toolArgs);
    const base: ToolEvent = { ...rest, ...(event.toolArgs !== undefined ? { toolArgs: title ? { title } : {} } : {}) };
    if (event.type !== 'tool_end') return base;
    const failed = event.isError === true || event.status === 'failed' || event.status === 'error';
    if (failed) {
      // The bridge's own refusal (or the harness's error) is already short text.
      return { ...base, isError: true, status: 'error' };
    }
    const raw = rawResult !== undefined && rawResult !== null
      ? rawResult
      : event.toolResult !== undefined && event.toolResult !== null && event.toolResult !== ''
        ? event.toolResult
        : event.content;
    const reference = this.bridge && toolCallId ? this.bridge.bindWidgetResult(toolCallId, raw) : null;
    if (!reference) {
      return {
        ...base,
        content: WIDGET_UNBOUND_RESULT,
        toolResult: WIDGET_UNBOUND_RESULT,
        isError: true,
        status: 'error',
      };
    }
    const boundTitle = widgetTitle(reference);
    return {
      ...base,
      ...(boundTitle ? { toolArgs: { title: boundTitle } } : {}),
      content: WIDGET_SHOWN_CONTENT,
      toolResult: reference,
      isError: false,
    };
  }

  /** Bounded tool activity for the persisted assistant message. */
  toolCalls(): NativePersistedToolCall[] | undefined {
    return this.recorder.snapshot();
  }

  /** Revoke exactly once; later calls are no-ops. */
  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    try { this.bridge?.revoke(); } catch { /* revocation is best-effort and idempotent */ }
  }
}
