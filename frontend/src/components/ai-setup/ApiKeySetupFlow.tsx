import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, ShieldCheck, X } from 'lucide-react';
import client from '../../api/client';
import ModelSelector, { SelectableModel } from './ModelSelector';
import type { ProviderUIConfig } from './providerConfig';

interface ApiKeySetupFlowProps {
  provider: ProviderUIConfig;
  apiBase: string;
  onComplete: () => void;
  onCancel: () => void;
}

type FlowStep = 'instructions' | 'validate' | 'model' | 'saving' | 'done';

interface ValidationResponse {
  valid: boolean;
  models?: string[];
  error?: string;
  hint?: string;
}

export default function ApiKeySetupFlow({ provider, apiBase, onComplete, onCancel }: ApiKeySetupFlowProps) {
  const [step, setStep] = useState<FlowStep>('instructions');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [setDefault, setSetDefault] = useState(false);
  const [savingMessage, setSavingMessage] = useState('Saving API key...');
  const [saveError, setSaveError] = useState<string | null>(null);

  // Only auto-select a default model if no default is already configured
  useEffect(() => {
    client.get(`${apiBase}/status`).then(({ data }) => {
      const current = data?.defaultModel || null;
      if (!current) {
        setSelectedModel(provider.defaultModels.find((m) => m.tier === 'balanced')?.id || provider.defaultModels[0]?.id || null);
        setSetDefault(true);
      }
    }).catch(() => {});
  }, [apiBase, provider]);

  const selectableModels = useMemo<SelectableModel[]>(() => {
    if (validation?.models?.length) {
      return validation.models.map((modelId) => {
        const known = provider.defaultModels.find((entry) => entry.id === modelId);
        return {
          id: modelId,
          name: known?.name || modelId.split('/').slice(1).join('/') || modelId,
          tier: known?.tier,
          description: known?.description || modelId,
        };
      });
    }
    return provider.defaultModels;
  }, [provider.defaultModels, validation?.models]);

  const validateKey = async () => {
    setValidating(true);
    setValidation(null);
    setSaveError(null);
    try {
      const { data } = await client.post(`${apiBase}/validate-key`, { provider: provider.id, apiKey });
      setValidation(data);
      if (data.valid) {
        if (!selectedModel && selectableModels[0]?.id) {
          setSelectedModel(selectableModels[0].id);
        }
        setStep('model');
      }
    } catch (error: any) {
      setValidation(error?.response?.data || { valid: false, error: error?.message || 'Failed to validate key' });
    } finally {
      setValidating(false);
    }
  };

  const saveKey = async () => {
    if (!selectedModel) return;
    setStep('saving');
    setSaveError(null);
    try {
      setSavingMessage('Saving API key...');
      await new Promise((resolve) => setTimeout(resolve, 250));
      setSavingMessage('Setting model preference...');
      await new Promise((resolve) => setTimeout(resolve, 250));
      setSavingMessage('Restarting AI engine...');
      await client.post(`${apiBase}/save-key`, {
        provider: provider.id,
        apiKey,
        setDefault,
        model: selectedModel,
      });
      setStep('done');
      onComplete();
    } catch (error: any) {
      setSaveError(error?.response?.data?.error || error?.message || 'Failed to save API key');
      setStep('model');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-5">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">AI Provider Setup</div>
            <h2 className="mt-2 text-2xl font-semibold text-white">{provider.name}</h2>
            <p className="mt-2 text-sm text-slate-400">{provider.description}</p>
          </div>
          <button type="button" onClick={onCancel} className="rounded-xl border border-slate-800 bg-slate-950/70 p-2 text-slate-400 transition hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-6">
          {step === 'instructions' ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                <div className="font-medium text-white">What you will do</div>
                <p className="mt-2">Open {provider.name}, create or copy a valid credential, then paste it here for validation.</p>
              </div>

              <div className="space-y-4">
                {provider.setupInstructions.map((instruction) => (
                  <div key={instruction.stepNumber} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/10 text-sm font-semibold text-emerald-300">
                        {instruction.stepNumber}
                      </div>
                      <div className="flex-1">
                        <div className="font-medium text-white">{instruction.title}</div>
                        <p className="mt-1 text-sm text-slate-400">{instruction.detail}</p>
                        {instruction.substeps?.length ? (
                          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-slate-400">
                            {instruction.substeps.map((substep) => <li key={substep}>{substep}</li>)}
                          </ol>
                        ) : null}
                        {instruction.link ? (
                          <a
                            href={instruction.link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
                          >
                            {instruction.link.label}
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        ) : null}
                        {instruction.note ? (
                          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{instruction.note}</span>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => setStep('validate')}
                  className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400"
                >
                  I have my key ready
                </button>
              </div>
            </div>
          ) : null}

          {step === 'validate' ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-white">Paste your credential</h3>
                <p className="mt-1 text-sm text-slate-400">We validate the key first before saving anything.</p>
              </div>

              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={provider.keyPlaceholder || 'Paste your API key'}
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 pr-12 text-white placeholder-slate-500 outline-none transition focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                />
                <button type="button" onClick={() => setShowKey((current) => !current)} className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 hover:text-white">
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>

              {validation?.valid ? (
                <div className="flex items-start gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">Key valid</div>
                    <div className="mt-1 text-emerald-100/80">{validation.models?.length ? `${validation.models.length} models detected.` : 'Credential accepted.'}</div>
                  </div>
                </div>
              ) : null}

              {validation && !validation.valid ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                  <div className="font-medium">{validation.error || 'Validation failed'}</div>
                  {validation.hint ? <div className="mt-1 text-red-100/80">{validation.hint}</div> : null}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <button type="button" onClick={() => setStep('instructions')} className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-600 hover:bg-slate-800">
                  Back
                </button>
                <button
                  type="button"
                  onClick={validateKey}
                  disabled={!apiKey.trim() || validating}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  {validating ? 'Checking key...' : 'Validate Key'}
                </button>
              </div>
            </div>
          ) : null}

          {step === 'model' ? (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-white">Choose your default model</h3>
                <p className="mt-1 text-sm text-slate-400">Pick the model this provider should use by default after setup.</p>
              </div>

              <ModelSelector
                models={selectableModels}
                selectedModel={selectedModel}
                onSelect={setSelectedModel}
                showSetDefault
                setDefault={setDefault}
                onSetDefaultChange={setSetDefault}
              />

              {saveError ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                  {saveError}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <button type="button" onClick={() => setStep('validate')} className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-300 transition hover:border-slate-600 hover:bg-slate-800">
                  Back
                </button>
                <button
                  type="button"
                  onClick={saveKey}
                  disabled={!selectedModel}
                  className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  Save & Activate
                </button>
              </div>
            </div>
          ) : null}

          {step === 'saving' ? (
            <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-8 text-center">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-emerald-400" />
              <h3 className="mt-4 text-lg font-semibold text-white">Applying provider configuration</h3>
              <p className="mt-2 text-sm text-slate-400">{savingMessage}</p>
            </div>
          ) : null}

          {step === 'done' ? (
            <div className="rounded-3xl border border-emerald-500/20 bg-emerald-500/10 p-8 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-300" />
              <h3 className="mt-4 text-lg font-semibold text-white">{provider.name} is ready</h3>
              <p className="mt-2 text-sm text-slate-300">The credential was saved and the AI engine was refreshed.</p>
              <button type="button" onClick={onCancel} className="mt-5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400">
                Done
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
