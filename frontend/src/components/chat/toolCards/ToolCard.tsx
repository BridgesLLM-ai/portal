import React, { useId, useMemo } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, ChevronRight, Circle, CircleDot, Loader2 } from 'lucide-react';
import ToolGlyph from '../ToolGlyph';
import { getToolPresentation } from '../../../utils/toolPresentation';
import { buildToolCardModel, fallbackToolCardModel } from './toolCardRegistry';
import { useToolActivityDisclosure } from '../toolActivity/toolActivityDisclosure';
import type {
  ToolCardChip,
  ToolCardDiffLineKind,
  ToolCardInput,
  ToolCardKind,
  ToolCardModel,
  ToolCardSection,
  ToolCardStepStatus,
  ToolCardTone,
} from './toolCardModel';

/**
 * Agent Chat tool card. Renders a ToolCardModel with text nodes only: no raw
 * HTML, no markdown, links only for http(s) URLs the registry approved.
 */

// Representative tool names so card families reuse the existing palette and glyphs.
const PRESENTATION_NAME: Readonly<Record<ToolCardKind, string | null>> = {
  shell: 'exec',
  code: 'exec',
  process: 'process',
  read: 'read',
  write: 'write',
  edit: 'edit',
  patch: 'apply_patch',
  search: 'search',
  web: 'web_fetch',
  browser: 'browser',
  progress: 'progress_card',
  goal: 'create_goal',
  session: 'sessions_spawn',
  media: 'image_generate',
  question: 'ask_user',
  parallel: 'parallel',
  generic: null,
};

const TONE_CLASS: Readonly<Record<ToolCardTone, string>> = {
  neutral: 'border-white/[0.08] bg-white/[0.04] text-slate-400',
  info: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
  good: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
  warn: 'border-amber-400/25 bg-amber-400/10 text-amber-200',
  bad: 'border-red-400/25 bg-red-500/10 text-red-200',
};

const DIFF_CLASS: Readonly<Record<ToolCardDiffLineKind, string>> = {
  add: 'text-emerald-300',
  del: 'text-rose-300',
  ctx: 'text-slate-400',
  meta: 'text-sky-300/80',
};

function presentationNameFor(model: ToolCardModel): string {
  if (model.brand === 'bridgesllm') return 'bridgesllm_skill';
  // Keep a known native tool's own glyph; card families are a fallback only.
  return getToolPresentation(model.rawName).key !== 'generic' ? model.rawName : PRESENTATION_NAME[model.kind] ?? model.canonicalName;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function Chip({ chip }: { chip: ToolCardChip }) {
  return (
    <span className={`inline-flex max-w-[160px] shrink-0 items-center truncate rounded-full border px-1.5 py-px text-[10px] leading-4 ${TONE_CLASS[chip.tone]}`}>
      {chip.label}
    </span>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">{children}</div>;
}

function TruncatedNote() {
  return <div className="mt-1 text-[10px] italic text-slate-500">Truncated for display</div>;
}

function StepIcon({ status }: { status: ToolCardStepStatus }) {
  if (status === 'completed') return <CheckCircle2 size={11} className="mt-px shrink-0 text-emerald-300" aria-label="Completed" />;
  if (status === 'in_progress') return <CircleDot size={11} className="mt-px shrink-0 text-sky-300" aria-label="In progress" />;
  return <Circle size={11} className={`mt-px shrink-0 ${status === 'pending' ? 'text-slate-400' : 'text-slate-600'}`} aria-label={status === 'pending' ? 'Pending' : 'Status unknown'} />;
}

function diffPrefix(kind: ToolCardDiffLineKind, text: string): string {
  if (kind === 'add' && !text.startsWith('+')) return '+ ';
  if (kind === 'del' && !text.startsWith('-')) return '- ';
  return '';
}

function SectionView({ section, depth }: { section: ToolCardSection; depth: number }) {
  switch (section.type) {
    case 'code':
      return (
        <div>
          <SectionLabel>{section.label}</SectionLabel>
          <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.04] bg-black/30 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-slate-300">
            {section.text}
          </pre>
          {section.truncated ? <TruncatedNote /> : null}
        </div>
      );
    case 'text':
      return (
        <div>
          <SectionLabel>{section.label}</SectionLabel>
          <p className="max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words leading-relaxed text-slate-300">{section.text}</p>
          {section.truncated ? <TruncatedNote /> : null}
        </div>
      );
    case 'fields':
      return (
        <div>
          {section.label ? <SectionLabel>{section.label}</SectionLabel> : null}
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1">
            {section.rows.map((row, index) => (
              <React.Fragment key={`${row.label}-${index}`}>
                <dt className="max-w-[140px] truncate text-slate-500" title={row.label}>{row.label}</dt>
                <dd className={`min-w-0 ${row.mono ? 'break-all font-mono' : 'break-words'} ${row.redacted ? 'italic text-slate-500' : 'text-slate-300'}`}>
                  {row.value}
                </dd>
              </React.Fragment>
            ))}
          </dl>
          {section.truncated ? <TruncatedNote /> : null}
        </div>
      );
    case 'diff':
      return (
        <div>
          <SectionLabel>{section.label}</SectionLabel>
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.04] bg-black/30 px-2.5 py-2 font-mono text-[11px] leading-relaxed">
            {section.lines.map((line, index) => (
              <span key={index} className={DIFF_CLASS[line.kind]}>
                {diffPrefix(line.kind, line.text)}
                {line.text}
                {'\n'}
              </span>
            ))}
          </pre>
          {section.truncated ? <TruncatedNote /> : null}
        </div>
      );
    case 'steps':
      return (
        <div>
          <SectionLabel>{section.label}</SectionLabel>
          <ol className="space-y-1">
            {section.steps.map((step, index) => (
              <li key={index} className="flex items-start gap-1.5">
                <StepIcon status={step.status} />
                <span className={`min-w-0 break-words ${step.status === 'completed' ? 'text-slate-400' : 'text-slate-200'}`}>{step.text}</span>
              </li>
            ))}
          </ol>
          {section.truncated ? <TruncatedNote /> : null}
        </div>
      );
    case 'links':
      return (
        <div>
          <SectionLabel>{section.label}</SectionLabel>
          <ul className="space-y-1.5">
            {section.items.map((item, index) => (
              <li key={index} className="min-w-0">
                {item.href ? (
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="break-all text-sky-300 hover:text-sky-200 hover:underline"
                  >
                    {item.title}
                  </a>
                ) : (
                  <span className="break-all text-slate-300">{item.title}</span>
                )}
                {item.host && item.host !== item.title ? <span className="ml-1.5 text-[10px] text-slate-500">{item.host}</span> : null}
                {item.snippet ? <div className="mt-0.5 break-words text-[10px] leading-snug text-slate-500">{item.snippet}</div> : null}
              </li>
            ))}
          </ul>
          {section.truncated ? <TruncatedNote /> : null}
        </div>
      );
    case 'refs':
      return (
        <div>
          <SectionLabel>{section.label}</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {section.items.map((item, index) => (
              <span
                key={`${item.namespace ?? ''}-${item.name}-${index}`}
                className="inline-flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-px font-mono text-[10px] text-slate-300"
                title={item.namespace ? `${item.namespace} · ${item.name}` : item.name}
              >
                <ToolGlyph toolName={item.name} size={9} className="text-slate-400" />
                {item.name}
                {item.count > 1 ? <span className="text-slate-500">×{item.count}</span> : null}
              </span>
            ))}
          </div>
          {section.truncated ? <TruncatedNote /> : null}
        </div>
      );
    case 'nested':
      return (
        <div>
          <SectionLabel>{section.label}</SectionLabel>
          <div className="space-y-1 border-l border-white/[0.06] pl-2">
            {section.cards.map((card) => (
              <ToolCardView key={card.id} model={card} depth={depth + 1} />
            ))}
          </div>
          {section.truncated ? <TruncatedNote /> : null}
        </div>
      );
    default:
      return null;
  }
}

/** Presentational card for a prepared model. Exported for nested rendering and tests. */
export function ToolCardView({ model, depth = 0 }: { model: ToolCardModel; depth?: number }) {
  // Inside a chat transcript, a top-level card remembers the reader's choice by
  // tool-call ID so it survives regrouping, streaming and history reloads.
  const [expanded, setExpanded] = useToolActivityDisclosure(depth === 0 ? `tool:${model.id}` : null, false);
  const bodyId = useId();
  const presentation = getToolPresentation(presentationNameFor(model));
  const glyphName = presentationNameFor(model);
  const headerChips = model.chips.filter((chip) => chip.tone !== 'neutral').slice(0, 2);
  const nested = depth > 0;

  const header = (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      aria-expanded={expanded}
      aria-controls={bodyId}
      title={model.rawName}
      className={`inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border text-[11px] text-slate-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-light)] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${nested ? 'px-2.5 py-1' : 'px-3.5 py-1.5'} ${presentation.surfaceClass} ${model.status === 'error' ? 'ring-1 ring-red-500/30' : ''}`}
    >
      <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${presentation.iconBadgeClass}`}>
        <ToolGlyph toolName={glyphName} size={model.brand === 'bridgesllm' ? 16 : 11} className={presentation.iconClass} />
      </span>
      <span className="min-w-0 truncate text-slate-200">{model.title}</span>
      {model.status === 'running' ? (
        <Loader2 size={10} className={`shrink-0 motion-safe:animate-spin ${presentation.iconClass}`} aria-label="Running" />
      ) : null}
      {model.status === 'error' ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-red-300">
          <AlertTriangle size={10} aria-hidden="true" />
          Failed
        </span>
      ) : null}
      <span className="hidden sm:contents">{headerChips.map((chip, index) => <Chip key={`${chip.label}-${index}`} chip={chip} />)}</span>
      {model.durationMs !== null ? <span className="hidden shrink-0 text-slate-500 sm:inline">· {formatDuration(model.durationMs)}</span> : null}
      <ChevronRight size={10} aria-hidden="true" className={`shrink-0 text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
    </button>
  );

  const body = (
    <div
      id={bodyId}
      className="mt-1.5 w-full space-y-2.5 rounded-xl border border-white/[0.06] bg-[var(--color-surface-raised)] px-3 py-2.5 text-left text-[11px] text-slate-300"
    >
      {model.subtitle ? <div className="truncate font-mono text-[10px] text-slate-500" title={model.subtitle}>{model.subtitle}</div> : null}
      {model.chips.length ? (
        <div className="flex flex-wrap gap-1">
          {model.chips.map((chip, index) => <Chip key={`${chip.label}-${index}`} chip={chip} />)}
        </div>
      ) : null}
      {model.sections.map((section, index) => (
        <SectionView key={`${section.type}-${index}`} section={section} depth={depth} />
      ))}
      <div className="truncate border-t border-white/[0.04] pt-1.5 font-mono text-[10px] text-slate-500" title={model.rawName}>
        {model.displayName}
        {model.namespace ? ` · ${model.namespace}` : ''}
        {' · '}
        {model.rawName}
      </div>
    </div>
  );

  if (nested) {
    return (
      <div data-tool-card-kind={model.kind} className="flex flex-col items-start">
        {header}
        {expanded ? body : null}
      </div>
    );
  }

  return (
    <motion.div
      data-tool-call-block
      data-tool-call-id={model.id}
      data-tool-card-kind={model.kind}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      className="flex justify-center px-4 py-1"
    >
      <div className="flex w-full max-w-[80rem] min-w-0 flex-col items-center">
        {header}
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="w-full overflow-hidden"
            >
              {body}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/** Minimal name-only pill; must not depend on anything that could have thrown. */
function ToolCardFallback({ tool }: { tool: Partial<ToolCardInput> }) {
  const model = fallbackToolCardModel(tool);
  return (
    <div data-tool-call-block data-tool-call-id={model.id} data-tool-card-kind="fallback" className="flex justify-center px-4 py-1">
      <span
        title={model.rawName}
        className="inline-flex max-w-md items-center gap-2 truncate rounded-full border border-white/[0.08] bg-white/[0.04] px-3.5 py-1.5 text-[11px] text-slate-300"
      >
        {model.displayName}
        {model.rawName !== model.displayName ? <span className="truncate font-mono text-[10px] text-slate-500">{model.rawName}</span> : null}
      </span>
    </div>
  );
}

interface BoundaryProps {
  tool: Partial<ToolCardInput>;
  children: ReactNode;
}

/** A card that fails to render degrades to the name-only pill; the transcript survives. */
export class ToolCardBoundary extends React.Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.warn('[tool-card] render failed; showing fallback', error, info.componentStack);
    }
  }

  render() {
    return this.state.failed ? <ToolCardFallback tool={this.props.tool} /> : this.props.children;
  }
}

/** Agent Chat entry point: one ToolCall in, one guarded card out. */
export const ToolCard = React.memo(function ToolCard({ tool }: { tool: ToolCardInput }) {
  const { id, name, status, arguments: args, result, startedAt, endedAt } = tool;
  const model = useMemo(
    () => buildToolCardModel({ id, name, status, arguments: args, result, startedAt, endedAt }),
    [id, name, status, args, result, startedAt, endedAt],
  );
  return (
    // A new status gives a failed card a fresh chance to render.
    <ToolCardBoundary key={`${id}:${status}`} tool={tool}>
      <ToolCardView model={model} />
    </ToolCardBoundary>
  );
});

export default ToolCard;
