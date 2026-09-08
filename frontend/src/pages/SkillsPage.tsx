import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Puzzle, Search, RefreshCw, CheckCircle, AlertCircle, XCircle,
  ChevronDown, ChevronUp, Loader2, Package, Folder, Box, Plug, Store, Wrench, TrendingUp, Clock, Star
} from 'lucide-react';
import { skillsAPI } from '../api/endpoints';

/* ─── Types ─────────────────────────────────────────────── */

interface SkillMissing {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: string[];
}

interface Skill {
  name: string;
  description?: string;
  emoji?: string;
  eligible: boolean;
  disabled: boolean;
  source: string;
  bundled?: boolean;
  managed?: boolean;
  missing?: SkillMissing;
}

interface MarketplaceResult {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  downloads?: number;
  score?: number;
  slug?: string;
  updatedAt?: string;
}

interface MarketplaceUnavailable {
  reason: string;
  remediation: string;
}

interface PluginEntry {
  id?: string;
  name?: string;
  version?: string;
  source?: string;
  description?: string;
  origin?: string;
  enabled?: boolean;
  status?: string;
}

type FilterTab = 'all' | 'eligible' | 'installed' | 'missing';
type MarketSort = 'trending' | 'newest' | 'downloads';

/* ─── Animation Variants ────────────────────────────────── */

const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
const cardVariant = {
  hidden: { opacity: 0, y: 16, scale: 0.97 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 220, damping: 22 } },
};

/* ─── Helpers ───────────────────────────────────────────── */

function getSourceLabel(skill: Skill): { label: string; color: string } {
  if (skill.bundled || skill.source === 'bundled' || skill.source === 'openclaw-bundled') {
    return { label: 'Bundled', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' };
  }
  if (skill.source === 'managed') {
    return { label: 'Managed', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' };
  }
  return { label: 'Workspace', color: 'bg-violet-500/20 text-violet-400 border-violet-500/30' };
}

function getStatusInfo(skill: Skill): { icon: typeof CheckCircle; color: string; label: string } {
  if (skill.disabled) {
    return { icon: XCircle, color: 'text-slate-400', label: 'Disabled' };
  }
  if (!skill.eligible) {
    return { icon: AlertCircle, color: 'text-amber-400', label: 'Missing requirements' };
  }
  return { icon: CheckCircle, color: 'text-emerald-400', label: 'Ready' };
}

function getMissingItems(missing?: SkillMissing): string[] {
  if (!missing) return [];
  const items: string[] = [];
  if (missing.bins?.length) items.push(...missing.bins.map(b => `bin: ${b}`));
  if (missing.anyBins?.length) items.push(`one of: ${missing.anyBins.join(', ')}`);
  if (missing.env?.length) items.push(...missing.env.map(e => `env: ${e}`));
  if (missing.config?.length) items.push(...missing.config.map(c => `config: ${c}`));
  if (missing.os?.length) items.push(...missing.os.map(o => `os: ${o}`));
  return items;
}

function marketplaceUnavailableFromError(error: unknown): MarketplaceUnavailable | null {
  if (!error || typeof error !== 'object' || !('response' in error)) return null;
  const response = (error as { response?: { status?: unknown; data?: unknown } }).response;
  if (response?.status !== 503 || !response.data || typeof response.data !== 'object') return null;
  const payload = response.data as Record<string, unknown>;
  if (
    payload.state !== 'unavailable'
    || typeof payload.reason !== 'string'
    || !payload.reason.trim()
    || typeof payload.remediation !== 'string'
    || !payload.remediation.trim()
  ) return null;
  return {
    reason: payload.reason,
    remediation: payload.remediation,
  };
}

/* ─── Skill Card Component ──────────────────────────────── */

interface SkillCardProps {
  skill: Skill;
}

function SkillCard({ skill }: SkillCardProps) {
  const [expanded, setExpanded] = useState(false);
  const sourceInfo = getSourceLabel(skill);
  const statusInfo = getStatusInfo(skill);
  const StatusIcon = statusInfo.icon;
  const missingItems = getMissingItems(skill.missing);
  const isManaged = skill.managed === true || skill.source === 'managed';

  return (
    <motion.div
      variants={cardVariant}
      layout
      className="bg-white/[0.03] border border-white/[0.06] rounded-2xl p-5 hover:bg-white/[0.05] hover:border-white/[0.1] transition-all duration-200"
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-start gap-4 text-left"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} details for ${skill.name}`}
      >
        <div className="w-12 h-12 rounded-xl bg-white/[0.05] flex items-center justify-center text-2xl flex-shrink-0">
          {skill.emoji || '📦'}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-white font-semibold text-base">{skill.name}</h3>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${sourceInfo.color}`}>
              {sourceInfo.label}
            </span>
          </div>

          <p className="text-slate-400 text-sm mt-1 line-clamp-2">
            {skill.description || 'No description available'}
          </p>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <div className={`flex items-center gap-1 text-xs ${statusInfo.color}`}>
              <StatusIcon size={14} />
              <span>{statusInfo.label}</span>
            </div>

            {missingItems.length > 0 && !expanded && (
              <div className="flex items-center gap-1 flex-wrap">
                {missingItems.slice(0, 2).map((item, i) => (
                  <span key={i} className="text-[10px] px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded-full border border-amber-500/20">
                    needs: {item.split(': ')[1]}
                  </span>
                ))}
                {missingItems.length > 2 && (
                  <span className="text-[10px] text-slate-500">+{missingItems.length - 2} more</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="text-slate-500">
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-4 pt-4 border-t border-white/[0.06]">
              <p className="text-slate-300 text-sm mb-3">
                {skill.description || 'No description available'}
              </p>

              {missingItems.length > 0 && (
                <div className="mt-3">
                  <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                    Missing Requirements
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {missingItems.map((item, i) => (
                      <span key={i} className="text-xs px-2 py-1 bg-amber-500/10 text-amber-400 rounded-lg border border-amber-500/20">
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
                {(skill.source === 'bundled' || skill.source === 'openclaw-bundled') && (
                  <span className="flex items-center gap-1"><Package size={12} /> Bundled with OpenClaw</span>
                )}
                {skill.source === 'managed' && (
                  <span className="flex items-center gap-1"><Box size={12} /> Managed via ClawHub</span>
                )}
                {!skill.bundled && skill.source !== 'bundled' && skill.source !== 'openclaw-bundled' && !isManaged && (
                  <span className="flex items-center gap-1"><Folder size={12} /> Local workspace skill</span>
                )}
              </div>

              {isManaged && (
                <div className="mt-3 border-t border-white/[0.06] pt-3 text-xs text-amber-200">
                  Skill changes are paused until transactional maintenance is available.
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ─── Content Props ─────────────────────────────────────── */

interface SkillsContentProps {
  showHeader?: boolean;
}

/* ─── Embeddable Content Component ──────────────────────── */

export function SkillsContent({ showHeader = false }: SkillsContentProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [marketQuery, setMarketQuery] = useState('');
  const [marketResults, setMarketResults] = useState<MarketplaceResult[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketSort, setMarketSort] = useState<MarketSort>('trending');
  const [marketMode, setMarketMode] = useState<'explore' | 'search'>('explore');
  const [marketUnavailable, setMarketUnavailable] = useState<MarketplaceUnavailable | null>(null);
  const [activityMessage, setActivityMessage] = useState<string | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const mountedRef = useRef(true);
  const listingRequestRef = useRef(0);
  const marketRequestRef = useRef(0);

  const installedNames = useMemo(() => new Set(skills.map(s => s.name)), [skills]);

  const fetchSkills = async (force = false) => {
    const requestId = ++listingRequestRef.current;
    setLoading(true);
    setError(null);
    setWarning(null);
    const [skillResult, pluginResult] = await Promise.allSettled([
      skillsAPI.list(force),
      skillsAPI.listPlugins(force),
    ]);
    if (!mountedRef.current || requestId !== listingRequestRef.current) return;

    const failures: string[] = [];
    if (skillResult.status === 'fulfilled') {
      setSkills(Array.isArray(skillResult.value.skills) ? skillResult.value.skills : []);
    } else {
      failures.push(skillResult.reason?.response?.data?.error || skillResult.reason?.message || 'Skill inventory unavailable');
    }
    if (pluginResult.status === 'fulfilled') {
      setPlugins(Array.isArray(pluginResult.value.plugins) ? pluginResult.value.plugins : []);
    } else {
      failures.push(pluginResult.reason?.response?.data?.error || pluginResult.reason?.message || 'Plugin inventory unavailable');
    }

    if (skillResult.status === 'rejected' && pluginResult.status === 'rejected') setError(failures.join(' · '));
    else if (failures.length) setWarning(failures.join(' · '));
    setLoading(false);
  };

  const loadExplore = useCallback(async (sort: MarketSort = marketSort) => {
    const requestId = ++marketRequestRef.current;
    setMarketLoading(true);
    setMarketMode('explore');
    try {
      const data = await skillsAPI.explore(sort, 25);
      if (mountedRef.current && requestId === marketRequestRef.current) {
        setMarketResults(Array.isArray(data.results) ? data.results : []);
        setMarketUnavailable(null);
        setActivityMessage(null);
        setActivityError(false);
      }
    } catch (err) {
      const unavailable = marketplaceUnavailableFromError(err);
      const message = err instanceof Error ? err.message : 'Failed to load marketplace';
      if (mountedRef.current && requestId === marketRequestRef.current) {
        if (unavailable) {
          setMarketResults([]);
          setMarketUnavailable(unavailable);
          setActivityError(false);
          setActivityMessage(null);
        } else {
          setMarketUnavailable(null);
          setActivityError(true);
          setActivityMessage(message);
        }
      }
    } finally {
      if (mountedRef.current && requestId === marketRequestRef.current) setMarketLoading(false);
    }
  }, [marketSort]);

  const runMarketSearch = async (query = marketQuery) => {
    const trimmed = query.trim();
    if (!trimmed) {
      // Empty search → go back to explore mode
      void loadExplore();
      return;
    }
    const requestId = ++marketRequestRef.current;
    setMarketLoading(true);
    setMarketMode('search');
    try {
      const data = await skillsAPI.search(trimmed);
      if (mountedRef.current && requestId === marketRequestRef.current) {
        setMarketResults(Array.isArray(data.results) ? data.results : []);
        setMarketUnavailable(null);
        setActivityMessage(null);
        setActivityError(false);
      }
    } catch (err) {
      const unavailable = marketplaceUnavailableFromError(err);
      const message = err instanceof Error ? err.message : 'Marketplace search failed';
      if (mountedRef.current && requestId === marketRequestRef.current) {
        if (unavailable) {
          setMarketResults([]);
          setMarketUnavailable(unavailable);
          setActivityError(false);
          setActivityMessage(null);
        } else {
          setMarketUnavailable(null);
          setActivityError(true);
          setActivityMessage(message);
        }
      }
    } finally {
      if (mountedRef.current && requestId === marketRequestRef.current) setMarketLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    fetchSkills();
    loadExplore('trending');
    return () => {
      mountedRef.current = false;
      listingRequestRef.current += 1;
      marketRequestRef.current += 1;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter skills
  const filteredSkills = useMemo(() => {
    let result = skills;

    switch (activeTab) {
      case 'eligible':
        result = result.filter(s => s.eligible && !s.disabled);
        break;
      case 'installed':
        result = result.filter(s => !(s.bundled || s.source === 'bundled' || s.source === 'openclaw-bundled'));
        break;
      case 'missing':
        result = result.filter(s => !s.eligible || s.disabled);
        break;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q)
      );
    }

    return result;
  }, [skills, activeTab, searchQuery]);

  const stats = useMemo(() => ({
    total: skills.length,
    eligible: skills.filter(s => s.eligible && !s.disabled).length,
    bundled: skills.filter(s => s.bundled || s.source === 'bundled' || s.source === 'openclaw-bundled').length,
    managed: skills.filter(s => s.source === 'managed').length,
    plugins: plugins.length,
  }), [skills, plugins]);

  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'eligible', label: 'Eligible' },
    { key: 'installed', label: 'Installed' },
    { key: 'missing', label: 'Missing Requirements' },
  ];

  const sortOptions: { key: MarketSort; label: string; icon: typeof TrendingUp }[] = [
    { key: 'trending', label: 'Trending', icon: TrendingUp },
    { key: 'newest', label: 'Newest', icon: Clock },
    { key: 'downloads', label: 'Popular', icon: Star },
  ];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        {showHeader && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                <Puzzle className="text-emerald-400" size={22} />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Extensions</h1>
                <p className="text-sm text-slate-400">Skills, marketplace availability, and plugin status</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                <input
                  aria-label="Filter installed skills"
                  type="text"
                  placeholder="Filter installed skills..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-64 pl-9 pr-4 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-all"
                />
              </div>
              <button
                aria-label="Refresh installed skills"
                onClick={() => fetchSkills(true)}
                disabled={loading}
                className="p-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.08] transition-all disabled:opacity-50"
              >
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
        )}

        {/* Compact header when embedded */}
        {!showHeader && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
              <input
                type="text"
                placeholder="Filter installed skills..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Filter installed skills"
                className="w-full pl-8 pr-3 py-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 transition-all"
              />
            </div>
            <button
              onClick={() => fetchSkills(true)}
              disabled={loading}
              aria-label="Refresh installed skills"
              className="p-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.08] transition-all disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        )}

        {/* Stats Bar */}
        {!loading && !error && (
          <div className="text-sm text-slate-400">
            <span className="text-white font-medium">{stats.total}</span> skills total
            {' • '}
            <span className="text-emerald-400">{stats.eligible}</span> eligible
            {' • '}
            <span className="text-blue-400">{stats.bundled}</span> bundled
            {stats.managed > 0 && <>{' • '}<span className="text-violet-400">{stats.managed}</span> from marketplace</>}
            {' • '}
            <span className="text-violet-400">{stats.plugins}</span> plugins
          </div>
        )}

        <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <Wrench className="mt-0.5 shrink-0 text-amber-300" size={16} />
          <div>
            <p className="font-medium">Extension changes paused</p>
            <p className="mt-0.5 text-amber-100/80">
              Installed skill and plugin status remain available. Marketplace browsing and search require a ClawHub host package that passes Portal execution admission. Portal will re-enable install, update, and removal after durable, provenance-verified extension transactions are available.
            </p>
          </div>
        </div>

        {warning && (
          <div role="status" className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Some extension sources are unavailable: {warning}
          </div>
        )}

        {activityMessage && (
          <div role={activityError ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${activityError ? 'border-red-500/20 bg-red-500/10 text-red-200' : 'border-white/[0.08] bg-white/[0.04] text-slate-300'}`}>
            {activityMessage}
          </div>
        )}

        {/* Marketplace + Plugin Inventory */}
        <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_0.7fr] gap-4">
          {/* Marketplace Panel */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
                <Store className="text-violet-400" size={20} />
              </div>
              <div>
                <h2 className="text-white font-semibold">Skill Marketplace</h2>
                <p className="text-sm text-slate-400">
                  {marketUnavailable
                    ? 'ClawHub marketplace unavailable'
                    : marketMode === 'search'
                      ? 'Search results from ClawHub'
                      : 'Browse trending skills from ClawHub'}
                </p>
              </div>
            </div>

            {/* Search + Sort */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={15} />
                <input
                  type="text"
                  value={marketQuery}
                  onChange={(e) => setMarketQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') runMarketSearch(); }}
                  placeholder={marketUnavailable ? 'Marketplace unavailable' : 'Search marketplace skills...'}
                  aria-label="Search marketplace skills"
                  disabled={marketLoading || Boolean(marketUnavailable)}
                  className="w-full pl-9 pr-4 py-2 bg-black/20 border border-white/[0.08] rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/40 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              <button
                onClick={() => runMarketSearch()}
                disabled={marketLoading || Boolean(marketUnavailable)}
                aria-label="Search marketplace skills"
                className="px-4 py-2 rounded-xl bg-violet-500/15 text-violet-300 border border-violet-500/20 hover:bg-violet-500/20 disabled:opacity-50"
              >
                {marketLoading ? <Loader2 size={16} className="animate-spin" /> : 'Search'}
              </button>
            </div>

            {/* Sort tabs (only in explore mode) */}
            {marketMode === 'explore' && (
              <div className="flex items-center gap-1">
                {sortOptions.map(opt => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => { setMarketSort(opt.key); loadExplore(opt.key); }}
                      disabled={marketLoading || Boolean(marketUnavailable)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        marketSort === opt.key
                          ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                          : 'text-slate-400 hover:text-white hover:bg-white/[0.05]'
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <Icon size={12} /> {opt.label}
                    </button>
                  );
                })}
                {marketMode === 'explore' && marketQuery && (
                  <button
                    onClick={() => { setMarketQuery(''); loadExplore(); }}
                    className="ml-auto text-xs text-slate-500 hover:text-slate-300"
                  >
                    Clear search
                  </button>
                )}
              </div>
            )}

            {marketMode === 'search' && !marketUnavailable && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">
                  {marketResults.length} result{marketResults.length !== 1 ? 's' : ''} for "{marketQuery}"
                </span>
                <button
                  onClick={() => { setMarketQuery(''); loadExplore(); }}
                  className="text-xs text-violet-400 hover:text-violet-300"
                >
                  ← Back to browse
                </button>
              </div>
            )}

            {/* Results */}
            <div className="space-y-2 max-h-[22rem] overflow-y-auto pr-1">
              {marketUnavailable ? (
                <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-4 text-sm text-red-100">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="mt-0.5 shrink-0 text-red-300" size={17} />
                    <div>
                      <p className="font-medium">ClawHub marketplace unavailable</p>
                      <p className="mt-1 text-red-100/80">{marketUnavailable.reason}</p>
                      <p className="mt-2 text-xs text-red-100/70">{marketUnavailable.remediation}</p>
                      <button
                        type="button"
                        onClick={() => loadExplore(marketSort)}
                        disabled={marketLoading}
                        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-400/15 disabled:opacity-50"
                      >
                        <RefreshCw size={12} className={marketLoading ? 'animate-spin' : ''} />
                        Retry marketplace check
                      </button>
                    </div>
                  </div>
                </div>
              ) : marketResults.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-sm text-slate-500 text-center">
                  {marketLoading ? 'Loading...' : 'No marketplace results.'}
                </div>
              ) : marketResults.map((item) => {
                const target = item.slug || item.name || '';
                const isInstalled = Boolean(
                  (item.slug && installedNames.has(item.slug))
                  || (item.name && installedNames.has(item.name)),
                );
                return (
                  <div key={target} className="rounded-xl border border-white/[0.06] bg-black/10 px-4 py-3 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-white">{item.name || item.slug}</span>
                        {item.version && <span className="text-[10px] px-2 py-0.5 rounded-full border border-violet-500/20 text-violet-300 bg-violet-500/10">v{item.version}</span>}
                        {isInstalled && <span className="text-[10px] px-2 py-0.5 rounded-full border border-emerald-500/20 text-emerald-300 bg-emerald-500/10">installed</span>}
                      </div>
                      <p className="text-sm text-slate-400 mt-1 line-clamp-2">{item.description || 'No description available'}</p>
                      <div className="text-xs text-slate-500 mt-2 flex gap-3 flex-wrap">
                        {item.author && <span>by {item.author}</span>}
                        {typeof item.downloads === 'number' && <span>{item.downloads.toLocaleString()} downloads</span>}
                        {typeof item.score === 'number' && <span>relevance: {item.score.toFixed(2)}</span>}
                      </div>
                    </div>
                    <span
                      aria-label={isInstalled ? `${target} is installed` : `${target} cannot be installed while extension changes are paused`}
                      className={`shrink-0 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                        isInstalled
                          ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400'
                          : 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                      }`}
                    >
                      {isInstalled ? <CheckCircle size={14} /> : <Wrench size={14} />}
                      {isInstalled ? 'Installed' : 'Changes paused'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Plugin Panel */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <Plug className="text-blue-400" size={20} />
              </div>
              <div>
                <h2 className="text-white font-semibold">Plugins</h2>
                <p className="text-sm text-slate-400">Installed OpenClaw plugin inventory</p>
              </div>
            </div>
            <div className="space-y-2 max-h-[22rem] overflow-y-auto pr-1">
              {plugins.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/[0.08] px-4 py-6 text-sm text-slate-500 text-center">
                  No plugins detected.
                </div>
              ) : plugins.map((plugin, index) => (
                <div key={plugin.id || plugin.name || String(index)} className="rounded-xl border border-white/[0.06] bg-black/10 px-4 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-white">{plugin.name || plugin.id || 'Unnamed plugin'}</span>
                    {plugin.version && <span className="text-[10px] px-2 py-0.5 rounded-full border border-blue-500/20 text-blue-300 bg-blue-500/10">{plugin.version}</span>}
                    {plugin.status && (
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        plugin.enabled || plugin.status === 'loaded'
                          ? 'border-emerald-500/20 text-emerald-300 bg-emerald-500/10'
                          : 'border-slate-500/20 text-slate-400 bg-slate-500/10'
                      }`}>
                        {plugin.status}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-400 mt-1">{plugin.description || plugin.source || 'Plugin'}</p>
                  {plugin.origin && <span className="text-xs text-slate-500">{plugin.origin}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-2 border-b border-white/[0.06] pb-1 overflow-x-auto scrollbar-none">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 text-xs sm:text-sm font-medium rounded-t-lg transition-all whitespace-nowrap ${
                activeTab === tab.key
                  ? 'accent-active border-b-2 -mb-[3px]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Skills Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="text-emerald-400 animate-spin" size={32} />
          </div>
        ) : error ? (
          <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-6 text-center">
            <AlertCircle className="text-red-400 mx-auto mb-2" size={32} />
            <p className="text-red-400">{error}</p>
            <button
              onClick={() => fetchSkills(true)}
              className="mt-4 px-4 py-2 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
            >
              Retry
            </button>
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-12 text-center">
            <Puzzle className="text-slate-600 mx-auto mb-3" size={40} />
            <p className="text-slate-400 text-lg">No skills match your search</p>
            <p className="text-slate-500 text-sm mt-1">Try adjusting your filters or search query</p>
          </div>
        ) : (
          <motion.div
            variants={container}
            initial="hidden"
            animate="show"
            className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
          >
            {filteredSkills.map(skill => (
              <SkillCard
                key={skill.name}
                skill={skill}
              />
            ))}
          </motion.div>
        )}
      </div>
    </div>
  );
}

/* ─── Main Page Component (Standalone) ──────────────────── */

export default function SkillsPage() {
  return <SkillsContent showHeader={true} />;
}
