import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import client from '../../api/client';
import ViewportModal from '../ViewportModal';
import ProviderCoverageChips from './ProviderCoverageChips';
import type { ProviderStatus } from './ProviderCard';
import type { ProviderUIConfig } from './providerConfig';
import { deriveProviderCoverage, getSharedLoginNote, type ProviderCoverage } from './providerCoverage';
import {
  describeModelSource,
  describeMutationError,
  parseModelDiscovery,
  readModelMutationOutcome,
  sameModel,
  type DiscoveredModel,
  type ModelDiscovery,
} from './openclawAuthWizardContract';

interface ActivationStatusPayload {
  providers: ProviderStatus[];
  defaultModel: string | null;
  fallbackModels: string[];
  gatewayRunning: boolean;
}

interface ProviderActivationStepProps {
  /** The provider whose login just completed. `null` lists every registered model (default-only mode). */
  provider: ProviderUIConfig | null;
  apiBase: string;
  mode: 'post-login' | 'default';
  onClose: () => void;
  /** Called after the server confirmed a registration or default change. */
  onChanged?: () => Promise<void> | void;
}

type Phase = 'verifying' | 'choose' | 'applying' | 'confirmed';

interface ConfirmedOutcome {
  model: DiscoveredModel;
  registered: boolean;
  defaultModel: string | null;
  defaultChanged: boolean;
}

function readStatusPayload(payload: unknown): ActivationStatusPayload {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  return {
    providers: Array.isArray(record.providers) ? record.providers as ProviderStatus[] : [],
    defaultModel: typeof record.defaultModel === 'string' && record.defaultModel.trim() ? record.defaultModel : null,
    fallbackModels: Array.isArray(record.fallbackModels) ? record.fallbackModels.filter((model): model is string => typeof model === 'string') : [],
    gatewayRunning: record.gatewayRunning === true,
  };
}

/**
 * The step every OpenClaw-capable login lands on: verify the credential with
 * the server, list the models the installed runtime reports (with readiness),
 * register the chosen one, and optionally make it OpenClaw's default. Success
 * is only shown after a refreshed `/status` readback agrees with the request.
 */
export default function ProviderActivationStep({ provider, apiBase, mode, onClose, onChanged }: ProviderActivationStepProps) {
  const [phase, setPhase] = useState<Phase>('verifying');
  const [status, setStatus] = useState<ActivationStatusPayload | null>(null);
  const [coverage, setCoverage] = useState<ProviderCoverage | null>(null);
  const [discovery, setDiscovery] = useState<ModelDiscovery | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [setDefault, setSetDefault] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const mutationRef = useRef(false);
  const [pendingWrite, setPendingWrite] = useState(false);
  const [outcome, setOutcome] = useState<ConfirmedOutcome | null>(null);

  const title = provider
    ? (mode === 'post-login' ? `Verify ${provider.name} and choose a model` : `Choose an OpenClaw model for ${provider.name}`)
    : 'Choose OpenClaw\'s default model';

  const verify = useCallback(async () => {
    setPhase('verifying');
    setVerifyError(null);
    setError(null);
    try {
      const statusResponse = await client.get<unknown>(`${apiBase}/status`, { params: { refreshProviderReadiness: '1' } });
      const nextStatus = readStatusPayload(statusResponse.data);
      setStatus(nextStatus);
      const providerStatus = provider ? nextStatus.providers.find((entry) => entry.id === provider.id) : undefined;
      setCoverage(provider ? deriveProviderCoverage(provider, providerStatus) : null);

      const modelsResponse = await client.get<unknown>(`${apiBase}/models`, {
        params: provider ? { provider: provider.id, refresh: '1' } : { refresh: '1' },
      });
      const nextDiscovery = parseModelDiscovery(modelsResponse.data);
      setDiscovery(nextDiscovery);

      const currentDefault = nextDiscovery.models.find((model) => sameModel(model.id, nextStatus.defaultModel));
      setSelectedId(currentDefault && currentDefault.readiness === 'ready' ? currentDefault.id : null);
      setSetDefault(!nextStatus.defaultModel || mode === 'default');
      setPendingWrite(false);
      setPhase('choose');
    } catch (err: unknown) {
      setVerifyError(describeMutationError(err, 'Portal could not verify the provider with the server.'));
      setPhase('choose');
    }
  }, [apiBase, mode, provider]);

  useEffect(() => {
    void verify();
  }, [verify]);

  const selected = useMemo(
    () => discovery?.models.find((model) => model.id === selectedId) || null,
    [discovery, selectedId],
  );
  const readyModels = useMemo(() => discovery?.models.filter((model) => model.readiness === 'ready') || [], [discovery]);

  const apply = async () => {
    if (!selected || mutationRef.current || pendingWrite) return;
    mutationRef.current = true;
    setPhase('applying');
    setError(null);
    let writeStarted = false;
    try {
      const mutate = async (path: string, body: unknown) => {
        writeStarted = true;
        const response = await client.post(`${apiBase}/${path}`, body, { _skipNetworkRetry: true } as any);
        const result = readModelMutationOutcome(response.data, response.status);
        if (!result.applied) {
          setPendingWrite(true);
          throw new Error(result.error || (result.pending
            ? 'OpenClaw is still confirming the change. Re-check its status before trying again.'
            : 'OpenClaw did not confirm this change. Re-check its status before trying again.'));
        }
        writeStarted = false;
      };
      let registered = selected.registered;
      if (!registered && provider) {
        await mutate('register-models', { provider: provider.id, models: [selected.id] });
        const models = parseModelDiscovery((await client.get<unknown>(`${apiBase}/models`, {
          params: { provider: provider.id, refresh: '1' },
        })).data);
        setDiscovery(models);
        registered = models.models.some((model) => sameModel(model.id, selected.id) && model.registered);
        if (!registered) {
          setPendingWrite(true);
          throw new Error('OpenClaw has not confirmed model registration yet. Re-check before continuing.');
        }
      }
      if (setDefault) {
        await mutate('set-default-model', {
          model: selected.id,
          ...(provider ? { provider: provider.id } : {}),
        });
      }
      const refreshed = readStatusPayload((await client.get<unknown>(`${apiBase}/status`)).data);
      setStatus(refreshed);
      if (provider) {
        setCoverage(deriveProviderCoverage(provider, refreshed.providers.find((entry) => entry.id === provider.id)));
      }
      if (setDefault && !sameModel(refreshed.defaultModel, selected.id)) {
        setPendingWrite(true);
        throw new Error(`The refreshed default model is ${refreshed.defaultModel || 'not set'} rather than ${selected.id}. Nothing is confirmed; re-check before trying again.`);
      }
      setOutcome({ model: selected, registered, defaultModel: refreshed.defaultModel, defaultChanged: setDefault });
      setPhase('confirmed');
      await onChanged?.();
    } catch (err: unknown) {
      const response = (err as { response?: { status?: number } })?.response;
      if (writeStarted && (!response || response.status! >= 500)) setPendingWrite(true);
      setError(describeMutationError(err, 'The server did not apply the model change.'));
      setPhase('choose');
    } finally {
      mutationRef.current = false;
    }
  };

  const sharedNote = provider ? getSharedLoginNote(provider.id) : null;
  const busy = phase === 'verifying' || phase === 'applying';

  return (
    <ViewportModal open onDismiss={onClose} dismissible={!busy} className="bg-black/50 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-activation-title"
        aria-busy={busy}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">OpenClaw models</div>
            <h2 id="provider-activation-title" className="mt-1 text-lg font-semibold text-white">{title}</h2>
            <p className="mt-1 text-sm text-slate-400">
              {mode === 'post-login'
                ? 'Portal verifies the login with the server, lists the models OpenClaw reports for it, and applies only what you choose.'
                : 'Pick from the models OpenClaw currently reports. The default changes only after the server confirms it.'}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close model activation" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:cursor-wait disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {phase === 'verifying' ? (
            <div role="status" className="flex items-center gap-3 rounded-xl border border-sky-500/20 bg-sky-500/10 px-4 py-4 text-sm text-sky-100">
              <Loader2 className="h-5 w-5 animate-spin" />
              Verifying the credential with the server and loading OpenClaw's model list…
            </div>
          ) : null}

          {verifyError ? (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Verification did not complete</div>
                <div className="mt-1 text-red-100/80">{verifyError}</div>
                <button type="button" onClick={() => void verify()} disabled={busy} className="mt-2 underline">Re-check</button>
              </div>
            </div>
          ) : null}

          {coverage ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">Server-reported state</div>
              <div className="mt-2">
                <ProviderCoverageChips coverage={coverage} showDetails />
              </div>
              {sharedNote ? <p className="mt-2 text-xs leading-relaxed text-slate-400">{sharedNote}</p> : null}
            </div>
          ) : null}

          {status && phase !== 'verifying' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">Current default model</div>
                <div className="mt-1 text-sm text-slate-200" data-testid="activation-current-default">{status.defaultModel || 'No default model configured yet'}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">Gateway</div>
                <div className="mt-1 text-sm text-slate-200">{status.gatewayRunning ? 'Running' : 'Unavailable'}</div>
              </div>
            </div>
          ) : null}

          {phase === 'confirmed' && outcome ? (
            <div role="status" className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-6 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-300" />
              <h3 className="mt-3 text-lg font-semibold text-white">
                {outcome.defaultChanged ? 'Default model confirmed' : 'Model registered'}
              </h3>
              <p className="mt-2 text-sm text-slate-200" data-testid="activation-confirmed-model">
                {outcome.defaultChanged
                  ? `OpenClaw's default model is now ${outcome.defaultModel}. Confirmed by the refreshed server status.`
                  : `${outcome.model.id} is registered with OpenClaw. The default model is unchanged (${outcome.defaultModel || 'none'}).`}
              </p>
              <button type="button" onClick={onClose} className="mt-5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400">
                Done
              </button>
            </div>
          ) : null}

          {(phase === 'choose' || phase === 'applying') && discovery ? (
            <div className="space-y-4">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-white">Models reported by OpenClaw</h3>
                  <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2 py-0.5 text-[11px] text-slate-300" data-testid="activation-model-source">
                    source: {discovery.source}{discovery.runtime ? ` · runtime: ${discovery.runtime}` : ''}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{describeModelSource(discovery)}</p>
                {discovery.warnings.map((warning) => (
                  <p key={warning} className="mt-1 text-xs text-amber-200">{warning}</p>
                ))}
              </div>

              {discovery.models.length === 0 ? (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="status">
                  OpenClaw reported no models for this provider. Nothing can be registered or made the default until the runtime reports at least one ready model.
                </div>
              ) : null}

              <div className="space-y-2" role="radiogroup" aria-label="OpenClaw models">
                {discovery.models.map((model) => {
                  const active = selectedId === model.id;
                  const selectable = model.readiness === 'ready';
                  return (
                    <button
                      type="button"
                      key={model.id}
                      role="radio"
                      aria-checked={active}
                      disabled={!selectable || phase === 'applying'}
                      onClick={() => setSelectedId(active ? null : model.id)}
                      className={`w-full rounded-2xl border p-4 text-left transition ${
                        active
                          ? 'accent-active'
                          : selectable
                            ? 'border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900'
                            : 'cursor-not-allowed border-slate-800 bg-slate-950/40 opacity-70'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-white">{model.name}</span>
                        <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2 py-0.5 text-[11px] text-slate-300">{model.id}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                          model.readiness === 'ready'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                            : model.readiness === 'unavailable'
                              ? 'border-red-500/30 bg-red-500/10 text-red-200'
                              : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                        }`}>
                          {model.readiness === 'ready' ? 'Ready' : model.readiness === 'unavailable' ? 'Unavailable' : 'Not verified'}
                        </span>
                        {model.registered ? (
                          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-200">Registered</span>
                        ) : null}
                        {sameModel(model.id, status?.defaultModel) ? (
                          <span className="rounded-full border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-0.5 text-[11px] text-fuchsia-200">Current default</span>
                        ) : null}
                      </div>
                      {model.description ? <p className="mt-2 text-sm text-slate-400">{model.description}</p> : null}
                      {model.reason ? <p className="mt-1 text-xs text-slate-500">{model.reason}</p> : null}
                    </button>
                  );
                })}
              </div>

              {readyModels.length > 0 ? (
                <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={setDefault}
                    disabled={phase === 'applying'}
                    onChange={(event) => setSetDefault(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-700 bg-slate-900"
                    style={{ accentColor: 'var(--accent, #6366f1)' }}
                  />
                  Set the selected model as OpenClaw's default model
                </label>
              ) : null}

              {error ? (
                <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => void verify()}
                  disabled={phase === 'applying'}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                  Re-check
                </button>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={phase === 'applying'}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
                  >
                    {mode === 'post-login' ? 'Keep current default' : 'Cancel'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void apply()}
                    disabled={!selected || pendingWrite || phase === 'applying' || (!setDefault && selected.registered)}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    {phase === 'applying' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    {setDefault ? 'Use as default model' : 'Register model'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </ViewportModal>
  );
}
