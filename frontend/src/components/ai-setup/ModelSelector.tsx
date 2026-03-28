import { CheckCircle2 } from 'lucide-react';
import type { ModelTier } from './providerConfig';

export interface SelectableModel {
  id: string;
  name: string;
  tier?: ModelTier;
  description?: string;
}

interface ModelSelectorProps {
  models: SelectableModel[];
  selectedModel: string | null;
  onSelect: (modelId: string) => void;
  showSetDefault?: boolean;
  setDefault?: boolean;
  onSetDefaultChange?: (checked: boolean) => void;
}

const tierLabel: Record<ModelTier, string> = {
  frontier: 'Most Capable',
  balanced: 'Balanced',
  fast: 'Fastest',
};

const tierClass: Record<ModelTier, string> = {
  frontier: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200',
  balanced: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  fast: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
};

export default function ModelSelector({
  models,
  selectedModel,
  onSelect,
  showSetDefault = false,
  setDefault = false,
  onSetDefaultChange,
}: ModelSelectorProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {models.map((model) => {
          const active = selectedModel === model.id;
          return (
            <button
              type="button"
              key={model.id}
              onClick={() => onSelect(model.id)}
              className={`w-full rounded-2xl border p-4 text-left transition ${
                active
                  ? 'border-emerald-500/60 bg-emerald-500/10 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]'
                  : 'border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className={`h-4 w-4 rounded-full border ${active ? 'border-emerald-400 bg-emerald-400/20' : 'border-slate-600 bg-transparent'}`}>
                      {active ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : null}
                    </div>
                    <span className="font-medium text-white">{model.name}</span>
                    {model.tier ? (
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tierClass[model.tier]}`}>
                        {tierLabel[model.tier]}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-sm text-slate-400">{model.description || model.id}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {showSetDefault ? (
        <label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={setDefault}
            onChange={(event) => onSetDefaultChange?.(event.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-500"
          />
          Set this as the default AI model
        </label>
      ) : null}
    </div>
  );
}
