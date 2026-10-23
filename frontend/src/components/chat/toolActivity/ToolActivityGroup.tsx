import React, { useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react';
import ToolGlyph from '../ToolGlyph';
import { getToolPresentation } from '../../../utils/toolPresentation';
import { selectNewestWindow } from '../../../utils/timelineWindow';
import {
  readToolActivityChoice,
  rememberToolActivityChoice,
  useToolActivityDisclosure,
  useToolActivityScope,
} from './toolActivityDisclosure';
import { summarizeActivityGroup, type ActivityFamily, type ActivityTool } from './toolActivityModel';

export type ToolActivitySurface = 'agent' | 'project';

const SURFACE: Readonly<Record<ToolActivitySurface, {
  row: string;
  header: string;
  badge: string;
  glyph: number;
  brandGlyph: number;
  body: string;
  memberWindow: number;
}>> = {
  agent: {
    row: 'px-4 py-1',
    header: 'gap-2 px-3.5 py-1.5 text-[11px]',
    badge: 'h-5 w-5',
    glyph: 11,
    brandGlyph: 16,
    body: 'mt-1.5 rounded-2xl py-1.5',
    memberWindow: 40,
  },
  project: {
    row: 'px-2 py-0.5',
    header: 'gap-1.5 px-3 py-1 text-[10px]',
    badge: 'h-4 w-4',
    glyph: 10,
    brandGlyph: 14,
    body: 'mt-1 rounded-xl py-1',
    memberWindow: 30,
  },
};

const BRAND_GLYPH_NAME = 'bridgesllm_skill';

function FamilyGlyphs({ families, branded, surface }: {
  families: readonly ActivityFamily[];
  branded: boolean;
  surface: ToolActivitySurface;
}) {
  const style = SURFACE[surface];
  // BridgesLLM skill use leads the stack; otherwise the most used families.
  const shown = families
    .filter((family) => !(branded && family.key === 'bridgesllm'))
    .slice(0, branded ? 2 : 3);
  const glyphs = [
    ...(branded ? [{ key: 'bridgesllm', name: BRAND_GLYPH_NAME, args: undefined as unknown }] : []),
    ...shown.map((family) => ({ key: family.key, name: family.sample.name, args: family.sample.arguments })),
  ];
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {glyphs.map((glyph, index) => {
        const presentation = getToolPresentation(glyph.name, glyph.args);
        return (
          <span key={glyph.key} className={`inline-flex shrink-0 rounded-full bg-slate-950 ${index ? '-ml-1.5' : ''}`}>
            <span className={`inline-flex ${style.badge} items-center justify-center rounded-full border ${presentation.iconBadgeClass}`}>
              <ToolGlyph
                toolName={glyph.name}
                toolArguments={glyph.args}
                size={glyph.key === 'bridgesllm' ? style.brandGlyph : style.glyph}
                className={presentation.iconClass}
              />
            </span>
          </span>
        );
      })}
    </span>
  );
}

function familyText(families: readonly ActivityFamily[]): string {
  return families.slice(0, 3).map((family) => `${family.label} ${family.count}`).join(' · ');
}

/**
 * One compact disclosure for consecutive ordinary tool calls. Collapsed by
 * default; the header carries the exact count, the newest running call and a
 * visible failure count, so a failure never reads as quiet success.
 */
export function ToolActivityGroup<T extends ActivityTool>({
  groupKey,
  tools,
  surface,
  renderTool,
  describeTool,
}: {
  groupKey: string;
  tools: readonly T[];
  surface: ToolActivitySurface;
  renderTool: (tool: T) => React.ReactNode;
  /** One-line label for the live current call, e.g. "Run git status". */
  describeTool: (tool: T) => string;
}) {
  const style = SURFACE[surface];
  const bodyId = useId();
  const scope = useToolActivityScope();
  const summary = useMemo(() => summarizeActivityGroup(tools), [tools]);
  // A call the reader opened before it joined this group keeps the group open.
  const memberOpened = scope !== null
    && tools.some((tool) => readToolActivityChoice(scope, `tool:${tool.id}`) === true);
  const [expanded, setExpanded] = useToolActivityDisclosure(groupKey, memberOpened);
  useEffect(() => {
    if (scope !== null && memberOpened && readToolActivityChoice(scope, groupKey) === undefined) {
      rememberToolActivityChoice(scope, groupKey, true);
    }
  }, [groupKey, memberOpened, scope]);

  const [revealedEarlier, setRevealedEarlier] = useState(0);
  const members = useMemo(
    () => selectNewestWindow(tools, style.memberWindow, revealedEarlier),
    [revealedEarlier, style.memberWindow, tools],
  );
  const memberKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return members.items.map((tool) => {
      const count = seen.get(tool.id) || 0;
      seen.set(tool.id, count + 1);
      return count ? `${tool.id}#${count + 1}` : tool.id;
    });
  }, [members.items]);

  const running = summary.running > 0;
  const current = summary.current as T | null;
  const currentLabel = running && current ? describeTool(current) : '';
  const state = running ? 'running' : summary.failed > 0 ? 'failed' : 'done';
  const callCount = `${summary.total} tool call${summary.total === 1 ? '' : 's'}`;
  // Keep boundaries between inline fragments explicit for assistive technology.
  const accessibleLabel = running
    ? `Tool activity, running now: ${currentLabel} · ${callCount}${summary.running > 1 ? `, ${summary.running} running` : ''}`
    : `Tool activity: ${callCount} · ${familyText(summary.families)}`;
  const failureLabel = summary.failed > 0 ? `, ${summary.failed} failed` : '';

  return (
    <div
      data-tool-activity-group={groupKey}
      data-tool-activity-state={state}
      data-tool-activity-count={summary.total}
      className={`flex justify-center ${style.row}`}
    >
      <div className="flex w-full min-w-0 max-w-[80rem] flex-col items-center">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={accessibleLabel + failureLabel}
          className={`inline-flex min-w-0 max-w-full items-center rounded-full border border-[var(--accent-border)] bg-[var(--accent-bg-subtle)] text-slate-400 transition-colors hover:border-[var(--accent-border-hover)] hover:bg-[var(--accent-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-light)] ${style.header} ${summary.failed > 0 ? 'ring-1 ring-red-500/30' : ''}`}
        >
          <FamilyGlyphs families={summary.families} branded={summary.branded} surface={surface} />
          <span className="sr-only">{running ? 'Tool activity, running now: ' : 'Tool activity: '}</span>
          {running ? (
            <>
              <span className="min-w-0 truncate text-slate-200" title={currentLabel}>{currentLabel}</span>
              <Loader2 size={10} aria-hidden="true" className="shrink-0 animate-spin text-[var(--accent-light)]" />
              <span className="shrink-0 text-slate-500">
                {`· ${callCount}`}
                {summary.running > 1 ? `, ${summary.running} running` : ''}
              </span>
            </>
          ) : (
            <>
              <span className="shrink-0 text-slate-200">{callCount}</span>
              <span className="hidden min-w-0 truncate text-slate-500 sm:inline">{`· ${familyText(summary.families)}`}</span>
            </>
          )}
          {summary.failed > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-red-300">
              <AlertTriangle size={10} aria-hidden="true" />
              {`${summary.failed} failed`}
            </span>
          ) : null}
          <ChevronRight size={10} aria-hidden="true" className={`shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
        {expanded ? (
          <div
            id={bodyId}
            role="group"
            aria-label={`${callCount}${summary.failed > 0 ? `, ${summary.failed} failed` : ''}`}
            className={`w-fit min-w-[min(100%,18rem)] max-w-full border border-white/[0.06] bg-white/[0.02] px-1 ${style.body}`}
          >
            {members.hiddenCount > 0 ? (
              <div className="flex justify-center px-2 pb-1">
                <button
                  type="button"
                  onClick={() => setRevealedEarlier((value) => value + style.memberWindow)}
                  className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[10px] text-slate-400 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-slate-200"
                >
                  {`Show earlier calls in this group · ${members.hiddenCount} hidden`}
                </button>
              </div>
            ) : null}
            {members.items.map((tool, index) => (
              <React.Fragment key={memberKeys[index]}>{renderTool(tool)}</React.Fragment>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default ToolActivityGroup;
