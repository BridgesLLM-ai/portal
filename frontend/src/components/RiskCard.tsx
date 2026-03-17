/**
 * RiskCard — Enhanced three-tier risk card with confidence badges and citations.
 * Backward compatible with old RiskCardData shape.
 */

import { ReactNode } from 'react';

// New enhanced shape
interface EnhancedRiskCardItem {
  heading: string;
  body: string;
  citation: string;
  dataFreshness: string;
  confidenceTier: 'hard_data' | 'institutional' | 'sentiment';
}

interface EnhancedRiskCardData {
  title: string;
  subtitle: string;
  severity?: 'high' | 'medium' | 'low';
  items: EnhancedRiskCardItem[];
  signalSources?: { datMetrics: number; reportDataPoints: number; blipSignals: number };
  confidence: 'high' | 'medium' | 'low';
  lastUpdated: string;
}

// Old shape for backward compat
interface OldRiskCardItem {
  heading: string;
  body: string;
  source: string;
  freshness: string;
}

interface OldRiskCardData {
  title: string;
  subtitle: string;
  items: OldRiskCardItem[];
  blipCount: number;
  lastUpdated: string;
  confidence: 'high' | 'medium' | 'low';
}

type RiskCardData = EnhancedRiskCardData | OldRiskCardData;

function isEnhanced(data: RiskCardData): data is EnhancedRiskCardData {
  return data.items.length > 0 && 'confidenceTier' in data.items[0];
}

interface RiskCardProps {
  data: RiskCardData | null;
  icon: ReactNode;
  borderColor: 'amber' | 'blue';
  staticTitle: string;
  staticSubtitle: string;
  staticItems: (EnhancedRiskCardItem | OldRiskCardItem)[];
}

const TIER_BADGES: Record<string, { label: string; cls: string }> = {
  hard_data: { label: '📊 Hard Data', cls: 'text-emerald-400 bg-emerald-900/20 border-emerald-700/30' },
  institutional: { label: '📄 Institutional', cls: 'text-blue-400 bg-blue-900/20 border-blue-700/30' },
  sentiment: { label: '📰 Sentiment', cls: 'text-yellow-400 bg-yellow-900/20 border-yellow-700/30' },
};

function TierBadge({ tier }: { tier: string }) {
  const cfg = TIER_BADGES[tier];
  if (!cfg) return null;
  return (
    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded border ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: 'high' | 'medium' | 'low' }) {
  const cfg = {
    high: { label: '🟢 High Confidence', cls: 'text-green-400 bg-green-900/20 border-green-700/30' },
    medium: { label: '🟡 Medium', cls: 'text-yellow-400 bg-yellow-900/20 border-yellow-700/30' },
    low: { label: '⚪ Low', cls: 'text-gray-400 bg-gray-800/40 border-gray-700/30' }
  }[confidence];

  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded border ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

export default function RiskCard({ data, icon, borderColor, staticTitle, staticSubtitle, staticItems }: RiskCardProps) {
  const borderClass = borderColor === 'amber' ? 'border-amber-700/40' : 'border-blue-700/40';
  const itemBorderClass = borderColor === 'amber' ? 'border-amber-700/30' : 'border-blue-700/30';
  const headingClass = borderColor === 'amber' ? 'text-amber-400' : 'text-blue-400';
  const iconColorClass = borderColor === 'amber' ? 'text-amber-400' : 'text-blue-400';

  // Fallback to static if no data
  const effectiveData: RiskCardData = data ?? {
    title: staticTitle,
    subtitle: staticSubtitle,
    items: staticItems as EnhancedRiskCardItem[],
    confidence: 'low' as const,
    lastUpdated: new Date().toISOString()
  };

  const enhanced = isEnhanced(effectiveData);
  const signalSources = enhanced ? (effectiveData as EnhancedRiskCardData).signalSources : null;

  return (
    <div className={`bg-[#1a1f3a] rounded-lg p-6 border ${borderClass}`}>
      <div className="flex items-start justify-between gap-4 mb-1">
        <div className="flex items-center gap-2">
          <span className={iconColorClass}>{icon}</span>
          <h2 className="text-xl font-bold text-gray-200">{effectiveData.title}</h2>
        </div>
        <ConfidenceBadge confidence={effectiveData.confidence} />
      </div>
      <p className="text-sm text-gray-400 mb-6">{effectiveData.subtitle}</p>
      <div className="h-px bg-gray-700 mb-6"></div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {effectiveData.items.slice(0, 3).map((item, idx) => {
          const isEnh = 'confidenceTier' in item;
          const tier = isEnh ? (item as EnhancedRiskCardItem).confidenceTier : null;
          const citation = isEnh ? (item as EnhancedRiskCardItem).citation : (item as OldRiskCardItem).source;
          const freshness = isEnh ? (item as EnhancedRiskCardItem).dataFreshness : (item as OldRiskCardItem).freshness;

          return (
            <div key={idx} className={`border ${itemBorderClass} rounded-lg p-4 bg-[#0A0E27]`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className={`text-sm font-semibold ${headingClass} leading-tight`}>{item.heading}</div>
                {tier && <TierBadge tier={tier} />}
              </div>
              <p className="text-xs text-gray-300 leading-relaxed mb-3">{item.body}</p>
              <div className="flex items-center justify-between text-[10px] text-gray-500 border-t border-gray-700/50 pt-2 mt-2">
                <span className="truncate max-w-[60%]" title={citation}>{citation}</span>
                <span>{freshness}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between text-[10px] text-gray-600">
        <span>
          {signalSources ? (
            <>
              {signalSources.datMetrics > 0 && `${signalSources.datMetrics} DAT`}
              {signalSources.datMetrics > 0 && (signalSources.reportDataPoints > 0 || signalSources.blipSignals > 0) && ' · '}
              {signalSources.reportDataPoints > 0 && `${signalSources.reportDataPoints} Institutional`}
              {signalSources.reportDataPoints > 0 && signalSources.blipSignals > 0 && ' · '}
              {signalSources.blipSignals > 0 && `${signalSources.blipSignals} Sentiment`}
              {signalSources.datMetrics === 0 && signalSources.reportDataPoints === 0 && signalSources.blipSignals === 0 && 'Using static baseline'}
            </>
          ) : (
            `Using static baseline`
          )}
        </span>
        <span>Updated {new Date(effectiveData.lastUpdated).toLocaleString()}</span>
      </div>
    </div>
  );
}
