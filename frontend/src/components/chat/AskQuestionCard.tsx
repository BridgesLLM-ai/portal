import React, { createContext, useContext, useMemo, useState } from 'react';
import { HelpCircle, Check } from 'lucide-react';

/**
 * Answer surface for the agent's ask-question tool.
 *
 * The agent pauses on this call, so the card renders inline in the transcript
 * rather than as a modal: a question is a turn in the conversation, not an
 * error dialog. Modals are reserved for destructive confirmation, and popping
 * one over an unrelated section of the Portal is intrusive -- especially on
 * mobile.
 */

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

export interface AskQuestionPayload {
  questions: AskQuestionItem[];
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;
const MAX_LABEL_CHARS = 200;
const MAX_QUESTION_CHARS = 500;

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Parse tool arguments defensively. The payload is model-authored, so every
 * field is treated as untrusted: bounded, string-coerced, and capped in count.
 * A malformed payload yields null and the caller falls back to a plain pill.
 */
export function parseAskQuestionPayload(rawArguments: unknown): AskQuestionPayload | null {
  let parsed: any = rawArguments;
  if (typeof rawArguments === 'string') {
    try {
      parsed = JSON.parse(rawArguments);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : null;
  if (!rawQuestions || rawQuestions.length === 0) return null;

  const questions: AskQuestionItem[] = [];
  for (const raw of rawQuestions.slice(0, MAX_QUESTIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const question = boundedText(raw.question, MAX_QUESTION_CHARS);
    if (!question) continue;
    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    const options: AskQuestionOption[] = [];
    for (const option of rawOptions.slice(0, MAX_OPTIONS)) {
      if (!option || typeof option !== 'object') continue;
      const label = boundedText(option.label, MAX_LABEL_CHARS);
      if (!label) continue;
      const description = boundedText(option.description, MAX_LABEL_CHARS);
      options.push(description ? { label, description } : { label });
    }
    questions.push({
      question,
      header: boundedText(raw.header, 24) || undefined,
      multiSelect: raw.multiSelect === true,
      options,
    });
  }
  if (questions.length === 0) return null;
  return { questions };
}

/** Render the collected answers as the text the agent receives. */
export function formatAskQuestionAnswer(
  payload: AskQuestionPayload,
  selections: Record<number, string[]>,
  freeText: Record<number, string>,
): string {
  const parts: string[] = [];
  payload.questions.forEach((item, index) => {
    const chosen = selections[index] || [];
    const typed = (freeText[index] || '').trim();
    const answer = [...chosen, ...(typed ? [typed] : [])].join(', ');
    if (!answer) return;
    parts.push(`${item.question}\n${answer}`);
  });
  return parts.join('\n\n');
}

/** Claude Code's headless native prompt can settle without a human response. */
export function isUnansweredAskQuestionResult(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^the user did not answer the questions?\.?$/i.test(value.trim());
}

export function AskQuestionCard({
  payload,
  disabled,
  answered,
  onSubmit,
}: {
  payload: AskQuestionPayload;
  disabled?: boolean;
  answered?: string;
  onSubmit: (answerText: string) => void;
}) {
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  const unanswered = isUnansweredAskQuestionResult(answered);

  const canSubmit = useMemo(() => {
    if (disabled || answered) return false;
    return payload.questions.some((_, index) => (
      (selections[index] || []).length > 0 || (freeText[index] || '').trim().length > 0
    ));
  }, [payload.questions, selections, freeText, disabled, answered]);

  const toggle = (index: number, label: string, multiSelect: boolean) => {
    setSelections((previous) => {
      const current = previous[index] || [];
      if (multiSelect) {
        return {
          ...previous,
          [index]: current.includes(label)
            ? current.filter((value) => value !== label)
            : [...current, label],
        };
      }
      return { ...previous, [index]: current.includes(label) ? [] : [label] };
    });
  };

  if (answered) {
    if (unanswered) {
      return (
        <div className="my-2 rounded-2xl border border-amber-400/20 bg-amber-500/[0.06] px-4 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-200/75">
            <HelpCircle size={11} />
            <span>not answered</span>
          </div>
          <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-300/95">
            {answered}
          </div>
        </div>
      );
    }
    return (
      <div className="my-2 rounded-2xl border border-emerald-400/20 bg-emerald-500/[0.06] px-4 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-emerald-200/75">
          <Check size={11} />
          <span>answered</span>
        </div>
        <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-slate-300/95">
          {answered}
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-2xl border border-sky-400/25 bg-sky-500/[0.07] px-4 py-3 shadow-lg shadow-black/10">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-sky-200/80">
        <HelpCircle size={11} />
        <span>waiting on you</span>
      </div>

      {payload.questions.map((item, index) => (
        <div key={`${index}-${item.question}`} className="mb-3 last:mb-0">
          {item.header ? (
            <div className="mb-1 text-[9px] uppercase tracking-wide text-slate-500">
              {item.header}
            </div>
          ) : null}
          <div className="mb-2 text-[12px] leading-relaxed text-slate-200">{item.question}</div>

          <div className="flex flex-col gap-1.5">
            {item.options.map((option) => {
              const active = (selections[index] || []).includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(index, option.label, item.multiSelect === true)}
                  className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                    active
                      ? 'border-sky-400/50 bg-sky-500/15'
                      : 'border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.07]'
                  } ${disabled ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-100">
                    {active ? <Check size={10} className="text-sky-300" /> : null}
                    <span>{option.label}</span>
                  </div>
                  {option.description ? (
                    <div className="mt-0.5 text-[10px] leading-snug text-slate-400">
                      {option.description}
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>

          <input
            type="text"
            aria-label={`Type your own answer to: ${item.question}`}
            disabled={disabled}
            value={freeText[index] || ''}
            onChange={(event) => setFreeText((previous) => ({
              ...previous,
              [index]: event.target.value.slice(0, MAX_QUESTION_CHARS),
            }))}
            placeholder="Or type your own answer…"
            className="mt-2 w-full rounded-xl border border-white/[0.08] bg-black/20 px-3 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600 focus:border-sky-400/40 focus:outline-none"
          />
        </div>
      ))}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => onSubmit(formatAskQuestionAnswer(payload, selections, freeText))}
        className={`mt-1 w-full rounded-xl px-3 py-1.5 text-[11px] font-medium transition-colors ${
          canSubmit
            ? 'bg-sky-500/80 text-white hover:bg-sky-500'
            : 'cursor-not-allowed bg-white/[0.05] text-slate-500'
        }`}
      >
        Send answer
      </button>
    </div>
  );
}

export const __askQuestionCardTest = {
  parseAskQuestionPayload,
  formatAskQuestionAnswer,
  MAX_QUESTIONS,
  MAX_OPTIONS,
};

/**
 * Answer submission is provided by the chat panel and consumed by the tool
 * renderer, which sits several components deeper. A context avoids threading
 * the callback through every intermediate list/window component that has no
 * other reason to know about it.
 */
const AskQuestionAnswerContext = createContext<((answerText: string) => void) | null>(null);

export const AskQuestionAnswerProvider = AskQuestionAnswerContext.Provider;

export function useAskQuestionAnswer(): ((answerText: string) => void) | null {
  return useContext(AskQuestionAnswerContext);
}
