import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Puzzle, Search, RefreshCw, CheckCircle, AlertCircle, XCircle,
  ChevronDown, ChevronUp, Loader2, Package, Folder, Box, Download, Plug, Store, Wrench, Trash2, TrendingUp, Clock, Star
} from 'lucide-react';
import { skillsAPI } from '../api/endpoints';
import { agentJobsAPI } from '../api/agentJobs';
import TypedConfirmationDialog from '../components/TypedConfirmationDialog';

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

type PendingExtensionMutation = {
  kind: 'skill-install' | 'skill-uninstall' | 'plugin-install';
  target: string;
  confirmationPhrase: string;
};

type ExtensionMutationOwner = Readonly<{
  mutation: Readonly<PendingExtensionMutation>;
  confirmation: string;
}>;

type ExtensionMutationProof = Readonly<{
  mutationKey: string;
  jobId: string;
  completed: boolean;
}>;

type ExtensionNavigationGuard = {
  url: string;
  state: unknown;
  owner: ExtensionMutationOwner;
};

const JOB_STATUS_REQUEST_TIMEOUT_MS = 8_000;
const JOB_POLL_TIMEOUT_MS = 5 * 60_000;
const JOB_POLL_INTERVAL_MS = 2_000;
const INVENTORY_READBACK_TIMEOUT_MS = 15_000;

class ExtensionJobTerminalError extends Error {}

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

function mutationKey(mutation: PendingExtensionMutation): string {
  return `${mutation.kind}:${mutation.target}`;
}

function withoutPackageVersion(value: string): string {
  if (value.startsWith('@')) {
    const slashIndex = value.indexOf('/');
    const versionIndex = value.lastIndexOf('@');
    return slashIndex >= 0 && versionIndex > slashIndex ? value.slice(0, versionIndex) : value;
  }
  const versionIndex = value.lastIndexOf('@');
  return versionIndex > 0 ? value.slice(0, versionIndex) : value;
}

function pluginIdentityCandidates(spec: string): Set<string> {
  const normalized = spec.trim().toLowerCase();
  const withoutScheme = normalized.replace(/^(?:npm|clawhub):/, '');
  return new Set([
    normalized,
    withoutScheme,
    withoutPackageVersion(withoutScheme),
  ].filter(Boolean));
}

function pluginMatchesSpec(plugin: PluginEntry, spec: string): boolean {
  const candidates = pluginIdentityCandidates(spec);
  const exactFields = [plugin.id, plugin.name, plugin.origin, plugin.source]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  if (exactFields.some((value) => candidates.has(value))) return true;

  const source = typeof plugin.source === 'string'
    ? plugin.source.replace(/\\/g, '/').toLowerCase()
    : '';
  return [...candidates].some((candidate) => (
    candidate.includes('/')
    && (source.includes(`/node_modules/${candidate}/`) || source.endsWith(`/node_modules/${candidate}`))
  ));
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(timeoutMessage)), Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

/* ─── Skill Card Component ──────────────────────────────── */

interface SkillCardProps {
  skill: Skill;
  installedNames: Set<string>;
  onUninstall?: (name: string) => void;
  disabled?: boolean;
}

function SkillCard({ skill, installedNames: _installedNames, onUninstall, disabled = false }: SkillCardProps) {
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

              {isManaged && onUninstall && (
                <div className="mt-3 pt-3 border-t border-white/[0.06]">
                  <button
                    onClick={(e) => { e.stopPropagation(); onUninstall(skill.name); }}
                    disabled={disabled}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 transition-all disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 size={12} /> Uninstall
                  </button>
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
  const [pluginSpec, setPluginSpec] = useState('');
  const [activityMessage, setActivityMessage] = useState<string | null>(null);
  const [activityError, setActivityError] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [pendingMutation, setPendingMutation] = useState<PendingExtensionMutation | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationProof, setMutationProof] = useState<ExtensionMutationProof | null>(null);
  const mountedRef = useRef(true);
  const listingRequestRef = useRef(0);
  const marketRequestRef = useRef(0);
  const mutationOwnerRef = useRef<ExtensionMutationOwner | null>(null);
  const mutationProofRef = useRef<ExtensionMutationProof | null>(null);
  const mutationNavigationGuardRef = useRef<ExtensionNavigationGuard | null>(null);

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
        setActivityMessage(null);
        setActivityError(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load marketplace';
      if (mountedRef.current && requestId === marketRequestRef.current) {
        setActivityError(true);
        setActivityMessage(message);
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
        setActivityMessage(null);
        setActivityError(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Marketplace search failed';
      if (mountedRef.current && requestId === marketRequestRef.current) {
        setActivityError(true);
        setActivityMessage(message);
      }
    } finally {
      if (mountedRef.current && requestId === marketRequestRef.current) setMarketLoading(false);
    }
  };

  const installSkill = (name: string) => {
    if (mutationOwnerRef.current) return;
    setMutationError(null);
    mutationProofRef.current = null;
    setMutationProof(null);
    setPendingMutation({
      kind: 'skill-install',
      target: name,
      confirmationPhrase: `INSTALL SKILL ${name}`,
    });
  };

  const uninstallSkill = (name: string) => {
    if (mutationOwnerRef.current) return;
    setMutationError(null);
    mutationProofRef.current = null;
    setMutationProof(null);
    setPendingMutation({
      kind: 'skill-uninstall',
      target: name,
      confirmationPhrase: `UNINSTALL SKILL ${name}`,
    });
  };

  const installPlugin = () => {
    if (mutationOwnerRef.current) return;
    const spec = pluginSpec.trim();
    if (!spec) return;
    setMutationError(null);
    mutationProofRef.current = null;
    setMutationProof(null);
    setPendingMutation({
      kind: 'plugin-install',
      target: spec,
      confirmationPhrase: `INSTALL PLUGIN ${spec}`,
    });
  };

  const waitForMutationJob = async (jobId: string) => {
    const deadline = Date.now() + JOB_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!mountedRef.current) throw new Error('Extension status polling cancelled');
      const remainingMs = deadline - Date.now();
      const requestTimeoutMs = Math.max(1, Math.min(JOB_STATUS_REQUEST_TIMEOUT_MS, remainingMs));
      const job = await withDeadline(
        agentJobsAPI.status(jobId, { timeoutMs: requestTimeoutMs }),
        requestTimeoutMs,
        `Background job ${jobId} did not answer a bounded status request. Retry verification or inspect its retained transcript in Tasks.`,
      );
      if (job.status === 'completed') return;
      if (job.status === 'error' || job.status === 'killed') {
        throw new ExtensionJobTerminalError(`Background extension job ${job.status}. Open Tasks for its retained transcript before retrying.`);
      }
      const delayMs = Math.min(JOB_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
      if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
    throw new Error(`Background job ${jobId} did not finish within five minutes. Retry verification or continue tracking it in Tasks.`);
  };

  const verifyFreshMutationInventory = async (owner: ExtensionMutationOwner, jobId: string) => {
    if (owner.mutation.kind === 'plugin-install') {
      let data: { plugins?: unknown };
      try {
        data = await withDeadline(
          skillsAPI.listPlugins(true),
          INVENTORY_READBACK_TIMEOUT_MS,
          'the inventory request timed out',
        );
      } catch (inventoryError) {
        const reason = inventoryError instanceof Error ? inventoryError.message : 'the inventory request failed';
        throw new Error(`Background job ${jobId} completed, but fresh plugin inventory is unavailable: ${reason}. Retry verification or inspect Tasks before starting another install.`);
      }
      const nextPlugins = Array.isArray(data?.plugins) ? data.plugins as PluginEntry[] : null;
      if (!nextPlugins) {
        throw new Error(`Background job ${jobId} completed, but Portal returned a malformed plugin inventory. Retry verification or inspect Tasks.`);
      }
      if (!nextPlugins.some((plugin) => pluginMatchesSpec(plugin, owner.mutation.target))) {
        throw new Error(`Background job ${jobId} completed, but the fresh plugin inventory does not prove ${owner.mutation.target} is installed. Retry verification or inspect Tasks before starting another install.`);
      }
      if (mutationOwnerRef.current === owner) {
        listingRequestRef.current += 1;
        setPlugins(nextPlugins);
        setLoading(false);
      }
      return;
    }

    let data: { skills?: unknown };
    try {
      data = await withDeadline(
        skillsAPI.list(true),
        INVENTORY_READBACK_TIMEOUT_MS,
        'the inventory request timed out',
      );
    } catch (inventoryError) {
      const reason = inventoryError instanceof Error ? inventoryError.message : 'the inventory request failed';
      throw new Error(`Background job ${jobId} completed, but fresh skill inventory is unavailable: ${reason}. Retry verification or inspect Tasks before starting another mutation.`);
    }
    const nextSkills = Array.isArray(data?.skills) ? data.skills as Skill[] : null;
    if (!nextSkills) {
      throw new Error(`Background job ${jobId} completed, but Portal returned a malformed skill inventory. Retry verification or inspect Tasks.`);
    }
    const targetPresent = nextSkills.some((skill) => skill.name === owner.mutation.target);
    const expectedPresent = owner.mutation.kind === 'skill-install';
    if (targetPresent !== expectedPresent) {
      throw new Error(
        `Background job ${jobId} completed, but the fresh skill inventory does not prove ${owner.mutation.target} was ${expectedPresent ? 'installed' : 'removed'}. Retry verification or inspect Tasks before starting another mutation.`,
      );
    }
    if (mutationOwnerRef.current === owner) {
      listingRequestRef.current += 1;
      setSkills(nextSkills);
      setLoading(false);
    }
  };

  const confirmMutation = async (confirmation: string) => {
    const mutation = pendingMutation;
    if (!mutation || mutationOwnerRef.current) return;
    const owner = Object.freeze({
      mutation: Object.freeze({ ...mutation }),
      confirmation,
    });

    mutationNavigationGuardRef.current = {
      url: window.location.href,
      state: window.history.state,
      owner,
    };
    mutationOwnerRef.current = owner;
    setMutationBusy(true);
    setMutationError(null);
    setActivityMessage(null);
    setActivityError(false);
    try {
      const ownerKey = mutationKey(owner.mutation);
      let proof = mutationProofRef.current?.mutationKey === ownerKey
        ? mutationProofRef.current
        : null;
      if (!proof) {
        const result = owner.mutation.kind === 'skill-install'
          ? await skillsAPI.install(owner.mutation.target, owner.confirmation)
          : owner.mutation.kind === 'skill-uninstall'
            ? await skillsAPI.uninstall(owner.mutation.target, owner.confirmation)
            : await skillsAPI.installPlugin(owner.mutation.target, owner.confirmation);
        const jobId = String(result?.jobId || '');
        if (!jobId) throw new Error('Extension mutation did not return a background job');
        proof = Object.freeze({ mutationKey: ownerKey, jobId, completed: false });
        mutationProofRef.current = proof;
        setMutationProof(proof);
      }
      if (!proof.completed) {
        await waitForMutationJob(proof.jobId);
        proof = Object.freeze({ ...proof, completed: true });
        mutationProofRef.current = proof;
        setMutationProof(proof);
      }
      await verifyFreshMutationInventory(owner, proof.jobId);
      mutationProofRef.current = null;
      setMutationProof(null);
      if (owner.mutation.kind === 'plugin-install') setPluginSpec('');
      if (!mountedRef.current || mutationOwnerRef.current !== owner) return;
      setPendingMutation(null);
      setActivityMessage(`${owner.mutation.kind === 'skill-uninstall' ? 'Removed' : 'Installed'} ${owner.mutation.target}.`);
    } catch (err) {
      if (mountedRef.current && mutationOwnerRef.current === owner) {
        if (err instanceof ExtensionJobTerminalError) {
          mutationProofRef.current = null;
          setMutationProof(null);
        }
        setMutationError(err instanceof Error ? err.message : `Failed to update ${owner.mutation.target}`);
      }
    } finally {
      if (mutationOwnerRef.current === owner) {
        if (mutationNavigationGuardRef.current?.owner === owner) {
          mutationNavigationGuardRef.current = null;
        }
        mutationOwnerRef.current = null;
      }
      if (mountedRef.current) {
        setMutationBusy(false);
      }
    }
  };

  useEffect(() => {
    const blockUnload = (event: BeforeUnloadEvent) => {
      if (!mutationOwnerRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    const blockHistoryBack = (event: PopStateEvent) => {
      const guard = mutationNavigationGuardRef.current;
      if (!guard) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.history.pushState(guard.state, '', guard.url);
    };

    window.addEventListener('beforeunload', blockUnload);
    window.addEventListener('popstate', blockHistoryBack, true);
    return () => {
      window.removeEventListener('beforeunload', blockUnload);
      window.removeEventListener('popstate', blockHistoryBack, true);
    };
  }, []);

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
                <p className="text-sm text-slate-400">Skills, marketplace installs, and plugins</p>
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

        {/* Marketplace + Plugin Install */}
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
                  {marketMode === 'search' ? 'Search results from ClawHub' : 'Browse trending skills from ClawHub'}
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
                  placeholder="Search marketplace skills..."
                  aria-label="Search marketplace skills"
                  className="w-full pl-9 pr-4 py-2 bg-black/20 border border-white/[0.08] rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500/40"
                />
              </div>
              <button
                onClick={() => runMarketSearch()}
                disabled={marketLoading}
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
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        marketSort === opt.key
                          ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                          : 'text-slate-400 hover:text-white hover:bg-white/[0.05]'
                      }`}
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

            {marketMode === 'search' && (
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
              {marketResults.length === 0 ? (
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
                    <button
                      type="button"
                      onClick={() => installSkill(target)}
                      disabled={!target || mutationBusy || isInstalled}
                      className={`shrink-0 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all disabled:opacity-50 ${
                        isInstalled
                          ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400 cursor-default'
                          : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                      }`}
                    >
                      {isInstalled
                          ? <CheckCircle size={14} />
                          : <Download size={14} />
                      }
                      {isInstalled ? 'Installed' : 'Install'}
                    </button>
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
                <p className="text-sm text-slate-400">Install plugin specs: npm, path, clawhub:package</p>
              </div>
            </div>
            <div className="space-y-2">
              <input
                type="text"
                value={pluginSpec}
                onChange={(e) => setPluginSpec(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !mutationBusy) installPlugin(); }}
                disabled={mutationBusy}
                placeholder="clawhub:my-plugin or npm:@scope/plugin"
                aria-label="Plugin package specification"
                className="w-full px-4 py-2 bg-black/20 border border-white/[0.08] rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/40"
              />
              <button
                onClick={installPlugin}
                disabled={mutationBusy || !pluginSpec.trim()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-2 text-sm text-blue-300 hover:bg-blue-500/20 disabled:opacity-50"
              >
                <Wrench size={14} />
                Install Plugin
              </button>
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
                installedNames={installedNames}
                onUninstall={uninstallSkill}
                disabled={mutationBusy}
              />
            ))}
          </motion.div>
        )}
      </div>
      <TypedConfirmationDialog
        open={Boolean(pendingMutation)}
        title={pendingMutation?.kind === 'skill-uninstall' ? 'Remove host extension' : 'Install host extension'}
        description="This changes executable code available to OpenClaw on the server. The operation runs as a serialized background job and keeps its output in Tasks."
        confirmationPhrase={pendingMutation?.confirmationPhrase}
        confirmLabel={mutationProof ? 'Retry verification' : pendingMutation?.kind === 'skill-uninstall' ? 'Remove extension' : 'Install extension'}
        busyLabel={mutationProof?.completed ? 'Verifying inventory…' : mutationProof ? 'Checking background job…' : pendingMutation?.kind === 'skill-uninstall' ? 'Removing extension…' : 'Installing extension…'}
        busy={mutationBusy}
        tone={pendingMutation?.kind === 'skill-uninstall' ? 'danger' : 'warning'}
        details={pendingMutation && (
          <div className="space-y-3">
            <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-300">
              Target: <code className="break-all font-mono text-white">{pendingMutation.target}</code>
            </div>
            {mutationProof ? (
              <div role="status" className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                Background job <code className="break-all font-mono text-white">{mutationProof.jobId}</code> is retained in Tasks. Retrying here verifies that same job and its fresh inventory; it does not start another mutation.
              </div>
            ) : null}
            {mutationError ? (
              <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {mutationError}
              </div>
            ) : null}
          </div>
        )}
        onCancel={() => {
          if (mutationOwnerRef.current) return;
          const proof = mutationProofRef.current;
          if (proof) {
            setActivityError(true);
            setActivityMessage(`Verification for background job ${proof.jobId} was left incomplete. Inspect Tasks before starting another extension mutation.`);
          }
          mutationProofRef.current = null;
          setMutationProof(null);
          setMutationError(null);
          setPendingMutation(null);
        }}
        onConfirm={confirmMutation}
      />
    </div>
  );
}

/* ─── Main Page Component (Standalone) ──────────────────── */

export default function SkillsPage() {
  return <SkillsContent showHeader={true} />;
}
