/**
 * Presentation-only grouping of consecutive ordinary tool calls in Agent and
 * Project Chat transcripts. Nothing here changes, drops or re-identifies a
 * ToolCall: units hold the original objects in their original order, and
 * every tool that a user may need to see or act on stays standalone.
 */

import { getToolPresentation, isAskQuestionTool, type ToolVisualKind } from '../../../utils/toolPresentation';
import { selectNewestWindow } from '../../../utils/timelineWindow';
import { buildToolCardModel, parseToolName, resolveToolCardKind } from '../toolCards/toolCardRegistry';

/** The ToolCall fields grouping reads. Extra fields pass through untouched. */
export interface ActivityTool {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  arguments?: unknown;
  result?: string;
  startedAt?: number;
  endedAt?: number;
}

/** Redacted, bounded one-line purpose of a call, e.g. "Run git status". */
export function describeActivityTool(tool: ActivityTool): string {
  return buildToolCardModel({
    id: tool.id,
    name: tool.name,
    status: tool.status,
    arguments: tool.arguments,
    result: tool.result,
    startedAt: tool.startedAt,
    endedAt: tool.endedAt,
  }).title;
}

/** Why a tool renders on its own instead of inside an ordinary activity group. */
export type StandaloneReason =
  | 'widget'
  | 'question'
  | 'approval'
  | 'progress'
  | 'media'
  | 'interactive'
  | 'failure';

export type ActivityEntry<T extends ActivityTool, B> =
  | { kind: 'tool'; tool: T }
  /** Anything rendered between tools: assistant prose, thinking, notices. */
  | { kind: 'boundary'; key: string; value: B; prose: boolean };

export type ActivityUnit<T extends ActivityTool, B> =
  | { kind: 'boundary'; key: string; value: B }
  | { kind: 'tool'; key: string; tool: T; reason: StandaloneReason | null }
  | { kind: 'group'; key: string; tools: T[] };

/** A group needs at least two calls; a lone ordinary call keeps its plain card. */
export const MIN_ACTIVITY_GROUP_SIZE = 2;

// Tools whose purpose is a user decision about the run.
const APPROVAL_TOOL_NAMES = new Set(['exit_plan_mode']);
// Results larger than this are ordinary text output, not presentation payloads.
const INTERACTIVE_RESULT_SCAN_LIMIT = 256 * 1024;

/**
 * Detect results that carry something meant to be presented or acted on
 * (Canvas/widget references, presentation targets, MCP app UI resources).
 * Such outputs are never folded out of sight, whatever tool produced them.
 */
export function carriesInteractiveOutput(result: unknown): boolean {
  if (typeof result !== 'string') return false;
  const text = result.trim();
  if (!text || text.length > INTERACTIVE_RESULT_SCAN_LIMIT) return false;
  if (/\bui:\/\/[^\s"']+/i.test(text)) return true;
  if (!text.startsWith('{')) return false;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.schema === 'string' && /widget|canvas/i.test(record.schema)) return true;
  if (record.kind === 'canvas') return true;
  if (record.presentation && typeof record.presentation === 'object') return true;
  const view = record.view;
  return Boolean(view && typeof view === 'object' && !Array.isArray(view)
    && (typeof (view as Record<string, unknown>).url === 'string' || typeof (view as Record<string, unknown>).id === 'string'));
}

/**
 * The visibility class a tool has on its own, before its position is known.
 * Returns null for ordinary activity that may be grouped.
 */
export function standaloneToolReason(tool: ActivityTool): Exclude<StandaloneReason, 'failure'> | null {
  const name = typeof tool.name === 'string' ? tool.name : '';
  const { canonical } = parseToolName(name);
  // Every widget call is a rich-content boundary in every state, including
  // running, failed, dashboard-only and unsupported outputs.
  if (name === 'show_widget' || canonical === 'show_widget') return 'widget';
  if (isAskQuestionTool(name)) return 'question';
  if (APPROVAL_TOOL_NAMES.has(canonical)) return 'approval';
  if (canonical === 'canvas') return 'interactive';
  const kind = resolveToolCardKind(canonical);
  if (kind === 'question') return 'question';
  if (kind === 'progress' || kind === 'goal') return 'progress';
  if (kind === 'media') return 'media';
  // Known families return data (file text, command output, search hits); only
  // an unrecognized tool's output is inspected for presentation payloads.
  if (kind === 'generic' && carriesInteractiveOutput(tool.result)) return 'interactive';
  return null;
}

function uniqueKey(base: string, used: Map<string, number>): string {
  const seen = used.get(base) || 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}#${seen + 1}`;
}

/**
 * Split an ordered transcript slice into display units.
 *
 * - Boundaries (prose, thinking, notices) are never crossed.
 * - Standalone tools stay at their own position and split groups.
 * - A failure stays standalone until assistant prose follows it, either a
 *   later prose boundary or `proseFollows` (text rendered after the slice).
 * - Two or more consecutive ordinary tools become one group keyed by the
 *   first call's ID, so the key survives streaming growth and history reload.
 */
export function buildActivityUnits<T extends ActivityTool, B>(
  entries: readonly ActivityEntry<T, B>[],
  options: { proseFollows?: boolean } = {},
): ActivityUnit<T, B>[] {
  const followedByProse: boolean[] = new Array(entries.length).fill(false);
  let proseSeen = Boolean(options.proseFollows);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === 'boundary') {
      if (entry.prose) proseSeen = true;
    } else {
      followedByProse[index] = proseSeen;
    }
  }

  const units: ActivityUnit<T, B>[] = [];
  const usedKeys = new Map<string, number>();
  let run: T[] = [];
  const flush = () => {
    if (run.length >= MIN_ACTIVITY_GROUP_SIZE) {
      units.push({ kind: 'group', key: uniqueKey(`group:${run[0].id}`, usedKeys), tools: run });
    } else {
      for (const tool of run) {
        units.push({ kind: 'tool', key: uniqueKey(`tool:${tool.id}`, usedKeys), tool, reason: null });
      }
    }
    run = [];
  };

  entries.forEach((entry, index) => {
    if (entry.kind === 'boundary') {
      flush();
      units.push({ kind: 'boundary', key: entry.key, value: entry.value });
      return;
    }
    const tool = entry.tool;
    const reason: StandaloneReason | null = standaloneToolReason(tool)
      ?? (tool.status === 'error' && !followedByProse[index] ? 'failure' : null);
    if (reason) {
      flush();
      units.push({ kind: 'tool', key: uniqueKey(`tool:${tool.id}`, usedKeys), tool, reason });
      return;
    }
    run.push(tool);
  });
  flush();
  return units;
}

/** Number of underlying transcript entries one unit represents. */
export function activityUnitSize(unit: ActivityUnit<ActivityTool, unknown>): number {
  return unit.kind === 'group' ? unit.tools.length : 1;
}

export interface ActivityUnitWindow<U> {
  units: U[];
  hiddenUnits: number;
  hiddenTools: number;
  hiddenBoundaries: number;
}

/**
 * Keep the newest units mounted. Counting units (not tools) keeps a long
 * group whole, so its key, count and expansion stay stable while it grows.
 */
export function selectNewestActivityUnits<T extends ActivityTool, B>(
  units: readonly ActivityUnit<T, B>[],
  limit: number,
  revealedEarlier: number,
): ActivityUnitWindow<ActivityUnit<T, B>> {
  const window = selectNewestWindow(units, limit, revealedEarlier);
  let hiddenTools = 0;
  let hiddenBoundaries = 0;
  for (const unit of units.slice(0, window.hiddenCount)) {
    if (unit.kind === 'boundary') hiddenBoundaries += 1;
    else hiddenTools += activityUnitSize(unit);
  }
  return { units: window.items, hiddenUnits: window.hiddenCount, hiddenTools, hiddenBoundaries };
}

export interface ActivityFamily {
  key: ToolVisualKind;
  label: string;
  count: number;
  /** A member call to draw the family glyph from. */
  sample: ActivityTool;
}

export interface ActivityGroupSummary {
  total: number;
  running: number;
  failed: number;
  completed: number;
  /** Newest call still running, if any. */
  current: ActivityTool | null;
  families: ActivityFamily[];
  branded: boolean;
}

const presentationCache = new WeakMap<object, { key: ToolVisualKind; label: string }>();

function presentationOf(tool: ActivityTool): { key: ToolVisualKind; label: string } {
  const cached = presentationCache.get(tool);
  if (cached) return cached;
  let value: { key: ToolVisualKind; label: string };
  try {
    const presentation = getToolPresentation(tool.name, tool.arguments);
    value = { key: presentation.key, label: presentation.label };
  } catch {
    value = { key: 'generic', label: 'Tool' };
  }
  presentationCache.set(tool, value);
  return value;
}

/** Accurate counts and live state for one group; statuses are read verbatim. */
export function summarizeActivityGroup(tools: readonly ActivityTool[]): ActivityGroupSummary {
  let running = 0;
  let failed = 0;
  let current: ActivityTool | null = null;
  let branded = false;
  const families = new Map<ToolVisualKind, ActivityFamily>();
  for (const tool of tools) {
    if (tool.status === 'running') {
      running += 1;
      current = tool;
    } else if (tool.status === 'error') {
      failed += 1;
    }
    const presentation = presentationOf(tool);
    if (presentation.key === 'bridgesllm') branded = true;
    const family = families.get(presentation.key);
    if (family) family.count += 1;
    else families.set(presentation.key, { key: presentation.key, label: presentation.label, count: 1, sample: tool });
  }
  return {
    total: tools.length,
    running,
    failed,
    completed: tools.length - running - failed,
    current,
    // Stable order: most used first, ties keep first appearance.
    families: [...families.values()].sort((left, right) => right.count - left.count),
    branded,
  };
}
