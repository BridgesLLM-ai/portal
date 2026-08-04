import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, HelpCircle, Loader2, X } from 'lucide-react';
import { gatewayAPI } from '../../api/endpoints';
import type { GatewayPendingQuestion } from '../../api/endpoints';
import { isAskUserQuestionNoLongerOpenError } from '../../utils/askUserQuestionError';

export interface AskUserQuestionPrompt {
  id: string;
  question: string;
  header?: string;
  multiSelect: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  options: Array<{ label: string; description?: string }>;
}

export type AskUserQuestionRequest = GatewayPendingQuestion;

/**
 * When an agent run asks for input, the run is paused and
 * this is where the person answers it. Deliberately inline in the transcript
 * rather than a modal: the question belongs to the conversation, and a modal
 * over unrelated work is the thing everyone hates.
 */
export default function AskUserQuestionCard({
  request,
  onSettled,
}: {
  request: AskUserQuestionRequest;
  onSettled: (id: string) => void;
}) {
  // Keep editable state by prompt position, not by model-supplied question
  // text. JavaScript object prototype names (`constructor`, `__proto__`, …)
  // are valid questions and must not become accidental state lookups.
  const [selections, setSelections] = useState<string[][]>([]);
  const [freeText, setFreeText] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertainAnswerFingerprint, setUncertainAnswerFingerprint] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, request.expiresAt - Date.now()));

  useEffect(() => {
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, request.expiresAt - Date.now()));
    }, 1_000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  useEffect(() => {
    if (remainingMs <= 0) onSettled(request.id);
  }, [remainingMs, onSettled, request.id]);

  const toggleOption = useCallback((promptIndex: number, label: string) => {
    setSelections((previous) => {
      const current = previous[promptIndex] || [];
      const next = previous.slice();
      next[promptIndex] = current.includes(label) ? [] : [label];
      return next;
    });
  }, []);

  const questionIds = request.questions.map((prompt) => prompt.id);
  const protocolError = request.questions.length === 0
    ? 'This agent prompt did not include an answerable question.'
    : new Set(questionIds).size !== questionIds.length
      ? 'This agent prompt reused a question identity, so Portal cannot safely answer it.'
      : request.questions.some((prompt) => prompt.multiSelect)
        ? 'This agent prompt requested an unsupported multiple-selection answer. Portal will not guess how to encode it.'
        : null;

  const answers = useMemo(() => {
    const composed = Object.create(null) as Record<string, string>;
    request.questions.forEach((prompt, promptIndex) => {
      const chosen = selections[promptIndex] || [];
      const typed = (freeText[promptIndex] || '').trim();
      const selected = chosen[0] || '';
      const answer = typed || selected;
      if (answer) composed[prompt.id] = answer;
    });
    return composed;
  }, [request.questions, selections, freeText]);

  const canSubmit = !protocolError
    && questionIds.every((id) => Object.prototype.hasOwnProperty.call(answers, id))
    && !submitting;
  const answerFingerprint = JSON.stringify(questionIds.map((id) => [id, answers[id] || '']));

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    if (uncertainAnswerFingerprint && uncertainAnswerFingerprint !== answerFingerprint) {
      setError('The previous answer has an unknown outcome. Retry it unchanged.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const receipt = await gatewayAPI.answerQuestion(request.id, answers);
      if (receipt?.ok !== true || receipt?.id !== request.id || receipt?.state !== 'answered') {
        throw new Error('Portal did not confirm this exact answer.');
      }
      setUncertainAnswerFingerprint(null);
      onSettled(request.id);
    } catch (caught: any) {
      if (isAskUserQuestionNoLongerOpenError(caught)) {
        setUncertainAnswerFingerprint(null);
        onSettled(request.id);
        return;
      }
      // A late answer is the common failure here, and the server says so.
      const deliveryUnconfirmed = !caught?.response;
      if (deliveryUnconfirmed) setUncertainAnswerFingerprint(answerFingerprint);
      setError(
        deliveryUnconfirmed
          ? 'Answer delivery is unconfirmed. Retry the same answer.'
          : caught?.response?.data?.error
            || caught?.message
            || 'That answer could not be delivered.',
      );
      setSubmitting(false);
    }
  }, [answerFingerprint, answers, canSubmit, onSettled, request.id, uncertainAnswerFingerprint]);

  const dismiss = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await gatewayAPI.dismissQuestion(request.id);
      onSettled(request.id);
    } catch (caught: any) {
      if (isAskUserQuestionNoLongerOpenError(caught)) {
        onSettled(request.id);
        return;
      }
      setError(
        caught?.response?.data?.error
        || caught?.message
        || 'That question could not be skipped.',
      );
      setSubmitting(false);
    }
  }, [onSettled, request.id]);

  const secondsLeft = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <section
      aria-label="The agent is waiting on your answer"
      className="my-3 rounded-2xl border border-violet-500/30 bg-violet-500/[0.07] p-4"
    >
      <header className="flex items-center gap-2">
        <HelpCircle size={16} className="text-violet-300" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-white">Waiting on you</h3>
        <span className="ml-auto text-[11px] tabular-nums text-slate-400">
          {minutes}:{String(seconds).padStart(2, '0')} left
        </span>
      </header>

      {protocolError ? (
        <p role="alert" className="mt-3 text-xs text-red-300">{protocolError}</p>
      ) : request.questions.map((prompt, promptIndex) => (
        <div key={`${request.id}:${promptIndex}`} className="mt-4">
          {prompt.header ? (
            <div className="mb-1 inline-flex rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-200">
              {prompt.header}
            </div>
          ) : null}
          <p className="text-sm leading-6 text-slate-100">{prompt.question}</p>
          {prompt.options.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {prompt.options.map((option) => {
                const active = (selections[promptIndex] || []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => toggleOption(promptIndex, option.label)}
                    disabled={submitting || uncertainAnswerFingerprint !== null}
                    title={option.description || undefined}
                    aria-pressed={active}
                    className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition ${
                      active
                        ? 'border-violet-400/60 bg-violet-500/20 text-violet-100'
                        : 'border-slate-700 bg-slate-900/50 text-slate-300 hover:border-slate-500'
                    } disabled:opacity-50`}
                  >
                    {active ? <Check size={12} aria-hidden="true" /> : null}
                    {option.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {(prompt.options.length === 0 || prompt.isOther === true) ? (
            <>
              {prompt.isSecret === true ? (
                <p className="mt-2 text-[11px] text-amber-200/80">
                  Secret answer — hidden while you type. It is sent only to this waiting prompt.
                </p>
              ) : null}
              <input
                type={prompt.isSecret === true ? 'password' : 'text'}
                autoComplete={prompt.isSecret === true ? 'off' : undefined}
                aria-label={`Your answer to: ${prompt.question}`}
                value={freeText[promptIndex] || ''}
                onChange={(changed) => setFreeText((previous) => {
                  const next = previous.slice();
                  next[promptIndex] = changed.target.value;
                  return next;
                })}
                onKeyDown={(pressed) => { if (pressed.key === 'Enter') void submit(); }}
                disabled={submitting || uncertainAnswerFingerprint !== null}
                placeholder={prompt.options.length > 0 ? 'Or type your own answer…' : 'Type your answer…'}
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-violet-500/50 focus:outline-none disabled:opacity-50"
              />
            </>
          ) : null}
        </div>
      ))}

      {error ? <p role="alert" className="mt-3 text-xs text-red-300">{error}</p> : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-violet-500 px-4 text-xs font-semibold text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null}
          Send answer
        </button>
        <button
          type="button"
          onClick={() => void dismiss()}
          disabled={submitting || uncertainAnswerFingerprint !== null}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-slate-700 px-3 text-xs font-medium text-slate-300 hover:bg-slate-900/60 disabled:opacity-50"
        >
          <X size={12} aria-hidden="true" />
          Skip
        </button>
      </div>
    </section>
  );
}
