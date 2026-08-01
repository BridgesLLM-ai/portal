import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Timer, Plus, Play, Trash2, Edit2, Clock,
  Calendar, RefreshCw, X, AlertCircle,
  CheckCircle, XCircle, Loader2, History, Zap, Bot
} from 'lucide-react';
import { automationsAPI, gatewayAPI } from '../api/endpoints';
import ViewportModal from '../components/ViewportModal';

/* ─── Types ─────────────────────────────────────────────── */

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  agentId?: string;
  sessionTarget?: string;
  schedule: {
    kind: string;
    expr: string;
    tz?: string;
  };
  payload?: {
    kind?: string;
    model?: string;
    message?: string;
    thinking?: string;
  };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastDurationMs?: number;
    consecutiveErrors?: number;
  };
  createdAtMs?: number;
  updatedAtMs?: number;
}

interface CronRun {
  runId?: string;
  startedAtMs: number;
  completedAtMs?: number;
  status: string;
  durationMs?: number;
  output?: string;
  error?: string;
}

interface ValidationErrors {
  name?: string;
  schedule?: string;
  task?: string;
  agent?: string;
  model?: string;
}

/* ─── Helpers ───────────────────────────────────────────── */

function extractApiError(error: unknown, fallback: string): string {
  const maybe = error as any;
  return maybe?.response?.data?.error || maybe?.response?.data?.message || maybe?.message || fallback;
}

function normalizeJobsResponse(payload: any): CronJob[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.jobs)) return payload.jobs;
  if (Array.isArray(payload?.data?.jobs)) return payload.data.jobs;
  return [];
}

function humanSchedule(schedule?: { kind?: string; expr?: string; tz?: string }): string {
  const expr = schedule?.expr;
  if (!expr) return 'Schedule unavailable';
  
  // Common interval patterns
  if (expr === '*/5 * * * *') return 'Every 5 minutes';
  if (expr === '*/10 * * * *') return 'Every 10 minutes';
  if (expr === '*/15 * * * *') return 'Every 15 minutes';
  if (expr === '*/30 * * * *') return 'Every 30 minutes';
  if (expr === '0 * * * *') return 'Every hour';
  if (expr === '0 */2 * * *') return 'Every 2 hours';
  if (expr === '0 */6 * * *') return 'Every 6 hours';
  if (expr === '0 */12 * * *') return 'Every 12 hours';
  
  // Daily patterns
  const dailyMatch = expr.match(/^(\d+) (\d+) \* \* \*$/);
  if (dailyMatch) {
    const [, minute, hour] = dailyMatch;
    const time = formatTime(parseInt(hour, 10), parseInt(minute, 10));
    return `Daily at ${time}`;
  }
  
  // Weekly patterns
  const weeklyMatch = expr.match(/^(\d+) (\d+) \* \* (\d)$/);
  if (weeklyMatch) {
    const [, minute, hour, dow] = weeklyMatch;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const time = formatTime(parseInt(hour, 10), parseInt(minute, 10));
    return `${days[parseInt(dow, 10)]}s at ${time}`;
  }
  
  // Default: show raw expression
  return expr;
}

function formatTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  const m = minute.toString().padStart(2, '0');
  return `${h}:${m} ${ampm}`;
}

function relativeTime(ms: number): string {
  const now = Date.now();
  const diff = now - ms;
  
  if (diff < 0) {
    // Future
    const absDiff = Math.abs(diff);
    if (absDiff < 60000) return 'in < 1 min';
    if (absDiff < 3600000) return `in ${Math.round(absDiff / 60000)} min`;
    if (absDiff < 86400000) return `in ${Math.round(absDiff / 3600000)} hours`;
    return `in ${Math.round(absDiff / 86400000)} days`;
  }
  
  // Past
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} hours ago`;
  return `${Math.round(diff / 86400000)} days ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const SUPPORTED_TIME_ZONES: string[] = (() => {
  try {
    const values = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    if (Array.isArray(values) && values.length > 0) return values;
  } catch {
    // Fall back to a compact, globally useful list on older browsers.
  }
  return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo'];
})();

function isEditableAgentAutomation(job: CronJob): boolean {
  return job.payload?.kind === 'agentTurn' && job.sessionTarget !== 'main';
}

function normalizeRun(raw: any): CronRun {
  const startedAtMs = Number(raw?.startedAtMs || raw?.runAtMs || raw?.ts || raw?.startedAt || raw?.startAt || Date.now());
  const completedAtMs = raw?.completedAtMs ? Number(raw.completedAtMs) : (raw?.completedAt ? Number(raw.completedAt) : undefined);
  return {
    runId: raw?.runId || raw?.sessionId || raw?.id,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
    completedAtMs: completedAtMs && Number.isFinite(completedAtMs) ? completedAtMs : undefined,
    status: String(raw?.status || raw?.state || 'unknown').toLowerCase(),
    durationMs: Number.isFinite(Number(raw?.durationMs)) ? Number(raw.durationMs) : undefined,
    output: typeof raw?.output === 'string'
      ? raw.output
      : (typeof raw?.summary === 'string'
          ? raw.summary
          : (typeof raw?.result === 'string' ? raw.result : undefined)),
    error: typeof raw?.error === 'string' ? raw.error : (typeof raw?.errorMessage === 'string' ? raw.errorMessage : undefined),
  };
}

/* ─── Animation Variants ────────────────────────────────── */

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const cardVariant = {
  hidden: { opacity: 0, y: 20, scale: 0.95 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 200, damping: 20 } },
};
const modalVariant = {
  hidden: { opacity: 0, scale: 0.95 },
  show: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 30 } },
};
/* ─── Job Card Component ────────────────────────────────── */

interface JobCardProps {
  job: CronJob;
  activeMutation: AutomationCardMutation | null;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onEdit: (job: CronJob) => void;
  onDelete: (id: string) => void;
  onRunNow: (id: string) => Promise<void>;
  onViewRuns: (job: CronJob) => void;
}

type AutomationCardMutation = {
  kind: 'run' | 'toggle';
  jobId: string;
};

function JobCard({ job, activeMutation, onToggle, onEdit, onDelete, onRunNow, onViewRuns }: JobCardProps) {
  const running = activeMutation?.kind === 'run' && activeMutation.jobId === job.id;
  const toggling = activeMutation?.kind === 'toggle' && activeMutation.jobId === job.id;
  const mutationActive = activeMutation !== null;
  
  const handleRunNow = () => {
    void onRunNow(job.id);
  };
  
  const handleToggle = () => {
    void onToggle(job.id, !job.enabled);
  };
  
  const statusIcon = useMemo(() => {
    const status = job.state?.lastRunStatus;
    if (status === 'ok' || status === 'success') return <CheckCircle size={14} className="text-emerald-400" />;
    if (status === 'error' || status === 'failed') return <XCircle size={14} className="text-red-400" />;
    return null;
  }, [job.state?.lastRunStatus]);
  const editable = isEditableAgentAutomation(job);
  
  return (
    <motion.div
      variants={cardVariant}
      className={`relative overflow-hidden rounded-2xl border backdrop-blur-xl p-5 flex flex-col gap-4 hover-lift transition-all duration-200 ${
        job.enabled
          ? 'bg-gradient-to-br from-slate-800/50 to-slate-900/50 border-white/[0.08]'
          : 'bg-gradient-to-br from-slate-900/50 to-slate-950/50 border-white/[0.04] opacity-70'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
            job.enabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-700/50 text-slate-500'
          }`}>
            <Timer size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white truncate">{job.name}</h3>
            <p className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
              <Clock size={12} />
              {humanSchedule(job.schedule)}
            </p>
          </div>
        </div>
        
        {/* Status Badge */}
        <div className={`px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 ${
          job.enabled
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-slate-700/50 text-slate-500'
        }`}>
          {job.enabled ? 'Active' : 'Paused'}
        </div>
      </div>
      
      {/* Info Row */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        {job.agentId && (
          <span className="flex items-center gap-1">
            <Bot size={12} />
            {job.agentId}
          </span>
        )}
        {job.payload?.model && (
          <span className="flex items-center gap-1">
            <Zap size={12} />
            {job.payload.model}
          </span>
        )}
        {job.state?.lastRunAtMs && (
          <span className="flex items-center gap-1">
            {statusIcon}
            Last: {relativeTime(job.state.lastRunAtMs)}
          </span>
        )}
        {job.state?.nextRunAtMs && job.enabled && (
          <span className="flex items-center gap-1">
            <Calendar size={12} />
            Next: {relativeTime(job.state.nextRunAtMs)}
          </span>
        )}
      </div>
      
      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t border-white/[0.06]">
        {/* Toggle Switch */}
        <button
          role="switch"
          aria-checked={job.enabled}
          aria-label={toggling ? `${job.enabled ? 'Disabling' : 'Enabling'} ${job.name}…` : `${job.enabled ? 'Disable' : 'Enable'} ${job.name}`}
          aria-busy={toggling}
          onClick={handleToggle}
          disabled={mutationActive || !editable}
          title={editable ? (job.enabled ? 'Disable' : 'Enable') : 'This job type must be managed in OpenClaw'}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            job.enabled ? 'bg-emerald-500' : 'bg-slate-700'
          } ${toggling ? 'opacity-50' : ''}`}
        >
          <motion.div
            animate={{ x: job.enabled ? 20 : 2 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className="absolute top-1 w-4 h-4 rounded-full bg-white shadow-md"
          />
        </button>
        
        <div className="flex-1" />
        
        {/* Action Buttons */}
        <button
          onClick={() => onViewRuns(job)}
          aria-label={`View runs for ${job.name}`}
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          title="View runs"
        >
          <History size={16} />
        </button>
        
        <button
          onClick={handleRunNow}
          disabled={mutationActive || !editable}
          aria-busy={running}
          aria-label={editable ? (running ? `Running ${job.name}…` : `Run ${job.name} now`) : `${job.name} must be managed in OpenClaw`}
          className="p-2 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
          title="Run now"
        >
          {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
        </button>
        
        <button
          onClick={() => onEdit(job)}
          disabled={mutationActive || !editable}
          aria-label={editable ? `Edit ${job.name}` : `${job.name} must be edited in OpenClaw`}
          className="p-2 rounded-lg text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-400"
          title={editable ? 'Edit' : 'This job type must be edited in OpenClaw'}
        >
          <Edit2 size={16} />
        </button>
        
        <button
          onClick={() => onDelete(job.id)}
          disabled={mutationActive || !editable}
          aria-label={editable ? `Delete ${job.name}` : `${job.name} cannot be deleted from the Portal`}
          className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-400"
          title={editable ? 'Delete' : 'This job type must be managed in OpenClaw'}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </motion.div>
  );
}

/* ─── Create/Edit Modal ─────────────────────────────────── */

interface JobModalProps {
  isOpen: boolean;
  job?: CronJob | null;
  defaultAgent?: string;
  onClose: () => void;
  onSave: (data: any) => Promise<void>;
}

function JobModal({ isOpen, job, defaultAgent = 'main', onClose, onSave }: JobModalProps) {
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [name, setName] = useState('');
  const [scheduleType, setScheduleType] = useState<'interval' | 'hourly' | 'daily' | 'weekly' | 'custom'>('interval');
  const [interval, setInterval] = useState('30m');
  const [time, setTime] = useState('09:00');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [customCron, setCustomCron] = useState('');
  const [agent, setAgent] = useState('main');
  const [model, setModel] = useState('');
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; alias: string | null; displayName: string }>>([]);
  const [message, setMessage] = useState('');
  const [thinking, setThinking] = useState('off');
  const [tz, setTz] = useState(defaultTimeZone);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);

  const handleRequestClose = useCallback(() => {
    if (!savingRef.current) onClose();
  }, [onClose]);
  
  // Reset form when job changes
  useEffect(() => {
    if (job) {
      setName(job.name || '');
      setAgent(job.agentId || 'main');
      setModel(job.payload?.model || '');
      setMessage(job.payload?.message || '');
      setThinking(job.payload?.thinking || 'off');
      setTz(job.schedule.tz || defaultTimeZone());
      
      // Parse schedule
      const expr = job.schedule.expr;
      if (expr.startsWith('*/')) {
        const match = expr.match(/^\*\/(\d+) \* \* \* \*$/);
        if (match) {
          setScheduleType('interval');
          setInterval(`${match[1]}m`);
        }
      } else if (expr === '0 * * * *') {
        setScheduleType('hourly');
      } else if (/^\d+ \d+ \* \* \*$/.test(expr)) {
        setScheduleType('daily');
        const [min, hour] = expr.split(' ');
        setTime(`${hour.padStart(2, '0')}:${min.padStart(2, '0')}`);
      } else if (/^\d+ \d+ \* \* \d$/.test(expr)) {
        setScheduleType('weekly');
        const [min, hour, , , dow] = expr.split(' ');
        setTime(`${hour.padStart(2, '0')}:${min.padStart(2, '0')}`);
        setDayOfWeek(parseInt(dow, 10));
      } else {
        setScheduleType('custom');
        setCustomCron(expr);
      }
    } else {
      setName('');
      setScheduleType('interval');
      setInterval('30m');
      setTime('09:00');
      setDayOfWeek(1);
      setCustomCron('');
      setAgent(defaultAgent || 'main');
      setModel('');
      setMessage('');
      setThinking('off');
      setTz(defaultTimeZone());
    }
    setSubmitError(null);
    setValidationErrors({});
  }, [job, isOpen, defaultAgent]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    gatewayAPI.models('OPENCLAW')
      .then((data) => {
        if (cancelled) return;
        const models = Array.isArray(data?.models) ? data.models : [];
        setAvailableModels(models.map((m: any) => ({ id: m.id, alias: m.alias ?? null, displayName: m.displayName || m.id })));
      })
      .catch(() => {
        if (!cancelled) setAvailableModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    setSubmitError(null);

    const errors: ValidationErrors = {};
    const trimmedName = name.trim();
    const trimmedAgent = agent.trim();
    const trimmedModel = model.trim();
    const trimmedTask = message.trim();
    const trimmedCustomCron = customCron.trim();
    const validCron = /^[a-zA-Z0-9*?,/\-#LW]+(?:\s+[a-zA-Z0-9*?,/\-#LW]+){4}$/;
    if (!trimmedName) errors.name = 'Name is required.';
    if (!trimmedTask) errors.task = 'Task prompt is required.';
    if (!trimmedAgent || !/^[a-zA-Z0-9_-]+$/.test(trimmedAgent)) {
      errors.agent = 'Agent must contain only letters, numbers, "_" or "-".';
    }
    if (trimmedModel && !/^[a-zA-Z0-9._:/-]+$/.test(trimmedModel)) {
      errors.model = 'Model contains invalid characters.';
    }
    if (scheduleType === 'custom') {
      if (!trimmedCustomCron) {
        errors.schedule = 'Custom cron expression is required.';
      } else if (!validCron.test(trimmedCustomCron)) {
        errors.schedule = 'Cron expression must have 5 valid fields.';
      }
    }
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    
    try {
      await onSave({
        name: trimmedName,
        scheduleType,
        interval: scheduleType === 'interval' ? interval : undefined,
        time: ['daily', 'weekly'].includes(scheduleType) ? time : undefined,
        dayOfWeek: scheduleType === 'weekly' ? dayOfWeek : undefined,
        schedule: scheduleType === 'custom' ? trimmedCustomCron : undefined,
        agent: trimmedAgent,
        model: trimmedModel || (job ? null : undefined),
        message: trimmedTask,
        thinking: thinking !== 'off' ? thinking : (job ? null : undefined),
        tz,
      });
      onClose();
    } catch (err) {
      console.error('Failed to save job:', err);
      setSubmitError(err instanceof Error ? err.message : 'Failed to save automation');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  
  if (!isOpen) return null;
  
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  return (
    <ViewportModal
      open={isOpen}
      onDismiss={handleRequestClose}
      dismissible={!saving}
      initialFocusRef={nameInputRef}
      className="bg-black/60 p-4 backdrop-blur-sm"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-editor-title"
        variants={modalVariant}
        initial="hidden"
        animate="show"
        className="flex max-h-[calc(100%_-_2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-slate-900 shadow-2xl"
      >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
            <h2 id="automation-editor-title" className="text-lg font-semibold text-white">
              {job ? 'Edit Automation' : 'New Automation'}
            </h2>
            <button
              aria-label="Close automation editor"
              onClick={handleRequestClose}
              disabled={saving}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              <X size={20} />
            </button>
          </div>
          
          {/* Form */}
          <form id="automation-editor-form" onSubmit={handleSubmit} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
            {/* Name */}
            <div>
              <label htmlFor="automation-name" className="block text-sm font-medium text-slate-300 mb-2">Name</label>
              <input
                ref={nameInputRef}
                id="automation-name"
                aria-label="Automation name"
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setValidationErrors(prev => ({ ...prev, name: undefined })); }}
                placeholder="My automation"
                className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
                required
                maxLength={200}
              />
              {validationErrors.name && <p className="mt-1.5 text-xs text-red-400">{validationErrors.name}</p>}
            </div>
            
            {/* Schedule Type */}
            <fieldset>
              <legend className="block text-sm font-medium text-slate-300 mb-2">Schedule</legend>
              <div className="grid grid-cols-5 gap-2">
                {(['interval', 'hourly', 'daily', 'weekly', 'custom'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={scheduleType === type}
                    onClick={() => setScheduleType(type)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${
                      scheduleType === type
                        ? 'accent-active border'
                        : 'bg-slate-800 text-slate-400 border border-white/[0.08] hover:bg-slate-700'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </fieldset>
            
            {/* Schedule Options */}
            {scheduleType === 'interval' && (
              <div>
                <label htmlFor="automation-interval" className="block text-sm font-medium text-slate-300 mb-2">Run every</label>
                <select
                  id="automation-interval"
                  aria-label="Automation interval"
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white focus:outline-none focus:border-emerald-500/50"
                >
                  <option value="5m">5 minutes</option>
                  <option value="10m">10 minutes</option>
                  <option value="15m">15 minutes</option>
                  <option value="30m">30 minutes</option>
                  <option value="1h">1 hour</option>
                  <option value="2h">2 hours</option>
                  <option value="6h">6 hours</option>
                  <option value="12h">12 hours</option>
                </select>
              </div>
            )}
            
            {['daily', 'weekly'].includes(scheduleType) && (
              <div className="grid grid-cols-2 gap-4">
                {scheduleType === 'weekly' && (
                  <div>
                    <label htmlFor="automation-day" className="block text-sm font-medium text-slate-300 mb-2">Day</label>
                    <select
                      id="automation-day"
                      aria-label="Automation day of week"
                      value={dayOfWeek}
                      onChange={(e) => setDayOfWeek(parseInt(e.target.value, 10))}
                      className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white focus:outline-none focus:border-emerald-500/50"
                    >
                      {days.map((day, i) => (
                        <option key={i} value={i}>{day}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className={scheduleType === 'daily' ? 'col-span-2' : ''}>
                  <label htmlFor="automation-time" className="block text-sm font-medium text-slate-300 mb-2">Time</label>
                  <input
                    id="automation-time"
                    aria-label="Automation time"
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
              </div>
            )}
            
            {scheduleType === 'custom' && (
              <div>
                <label htmlFor="automation-cron" className="block text-sm font-medium text-slate-300 mb-2">Cron Expression</label>
                <input
                  id="automation-cron"
                  aria-label="Custom cron expression"
                  type="text"
                  value={customCron}
                  onChange={(e) => { setCustomCron(e.target.value); setValidationErrors(prev => ({ ...prev, schedule: undefined })); }}
                  placeholder="*/30 * * * *"
                  maxLength={256}
                  className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 font-mono text-sm"
                />
                {validationErrors.schedule && <p className="mt-1.5 text-xs text-red-400">{validationErrors.schedule}</p>}
                <p className="mt-1.5 text-xs text-slate-500">
                  Format: minute hour day month weekday (e.g., "0 9 * * 1-5" = 9 AM weekdays)
                </p>
              </div>
            )}
            
            {/* Timezone */}
            <div>
              <label htmlFor="automation-timezone" className="block text-sm font-medium text-slate-300 mb-2">Timezone</label>
              <select
                id="automation-timezone"
                aria-label="Automation timezone"
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white focus:outline-none focus:border-emerald-500/50"
              >
                {SUPPORTED_TIME_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </div>
            
            {/* Agent & Model */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="automation-agent" className="block text-sm font-medium text-slate-300 mb-2">Agent</label>
                <input
                  id="automation-agent"
                  aria-label="Automation agent"
                  type="text"
                  value={agent}
                  onChange={(e) => { setAgent(e.target.value); setValidationErrors(prev => ({ ...prev, agent: undefined })); }}
                  placeholder="main"
                  maxLength={128}
                  className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
                />
                {validationErrors.agent && <p className="mt-1.5 text-xs text-red-400">{validationErrors.agent}</p>}
              </div>
              <div>
                <label htmlFor="automation-model" className="block text-sm font-medium text-slate-300 mb-2">Model (optional)</label>
                <select
                  id="automation-model"
                  aria-label="Automation model"
                  value={model}
                  onChange={(e) => { setModel(e.target.value); setValidationErrors(prev => ({ ...prev, model: undefined })); }}
                  className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white focus:outline-none focus:border-emerald-500/50"
                >
                  <option value="">Default model</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.alias || m.id}>
                      {m.alias ? `${m.alias} — ${m.displayName}` : m.displayName}
                    </option>
                  ))}
                </select>
                {validationErrors.model && <p className="mt-1.5 text-xs text-red-400">{validationErrors.model}</p>}
              </div>
            </div>
            
            {/* Thinking Level */}
            <div>
              <label htmlFor="automation-thinking" className="block text-sm font-medium text-slate-300 mb-2">Thinking Level</label>
              <select
                id="automation-thinking"
                aria-label="Automation thinking level"
                value={thinking}
                onChange={(e) => setThinking(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white focus:outline-none focus:border-emerald-500/50"
              >
                <option value="off">Off</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
                <option value="adaptive">Adaptive</option>
              </select>
            </div>
            
            {/* Message */}
            <div>
              <label htmlFor="automation-task" className="block text-sm font-medium text-slate-300 mb-2">Prompt / Task</label>
              <textarea
                id="automation-task"
                aria-label="Automation prompt or task"
                value={message}
                onChange={(e) => { setMessage(e.target.value); setValidationErrors(prev => ({ ...prev, task: undefined })); }}
                placeholder="What should the agent do?"
                rows={4}
                maxLength={65536}
                className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 resize-none"
                required
              />
              {validationErrors.task && <p className="mt-1.5 text-xs text-red-400">{validationErrors.task}</p>}
            </div>
            {submitError && (
              <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {submitError}
              </div>
            )}
          </form>
          
          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/[0.08] bg-slate-900/50">
            <button
              type="button"
              onClick={handleRequestClose}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="automation-editor-form"
              disabled={saving || !name || !message}
              aria-busy={saving}
              className="px-5 py-2 rounded-lg bg-emerald-500 text-white font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {saving ? (job ? 'Saving…' : 'Creating…') : (job ? 'Save Changes' : 'Create')}
            </button>
          </div>
      </motion.div>
    </ViewportModal>
  );
}

/* ─── Run History Drawer ────────────────────────────────── */

interface RunHistoryDrawerProps {
  isOpen: boolean;
  job: CronJob | null;
  onClose: () => void;
}

function RunHistoryDrawer({ isOpen, job, onClose }: RunHistoryDrawerProps) {
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequenceRef = useRef(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  
  const loadRuns = useCallback(async () => {
    if (!job) return;
    const sequence = ++requestSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await automationsAPI.runs(job.id, 50);
      if (sequence !== requestSequenceRef.current) return;
      const nextRuns = Array.isArray(data.runs) ? data.runs.map(normalizeRun) : [];
      setRuns(nextRuns);
    } catch (err) {
      if (sequence !== requestSequenceRef.current) return;
      console.error('Failed to load automation runs:', err);
      const message = err instanceof Error ? err.message : 'Failed to load run history';
      setError(message);
      setRuns([]);
    } finally {
      if (sequence === requestSequenceRef.current) setLoading(false);
    }
  }, [job]);

  useEffect(() => {
    if (isOpen && job) {
      void loadRuns();
    }
    return () => { requestSequenceRef.current += 1; };
  }, [isOpen, job, loadRuns]);
  
  return (
    <ViewportModal
      open={isOpen}
      onDismiss={onClose}
      initialFocusRef={closeButtonRef}
      className="bg-black/40 backdrop-blur-sm"
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="automation-run-history-title"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="ml-auto flex h-full w-full max-w-md flex-col border-l border-white/[0.08] bg-slate-900 shadow-2xl"
      >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
              <div>
                <h2 id="automation-run-history-title" className="text-lg font-semibold text-white">Run History</h2>
                <p className="text-sm text-slate-400 truncate mt-0.5">{job?.name}</p>
              </div>
              <button
                ref={closeButtonRef}
                aria-label="Close run history"
                onClick={onClose}
                className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            
            {/* Runs List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="text-slate-400 animate-spin" />
                </div>
              ) : error ? (
                <div className="text-center py-12 px-4">
                  <AlertCircle size={28} className="text-red-400 mx-auto mb-3" />
                  <p className="text-sm text-red-300 mb-3">{error}</p>
                  <button
                    onClick={loadRuns}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 text-red-200 hover:bg-red-500/30 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              ) : runs.length === 0 ? (
                <div className="text-center py-12">
                  <History size={32} className="text-slate-600 mx-auto mb-3" />
                  <p className="text-slate-400">No runs yet</p>
                </div>
              ) : (
                runs.map((run, i) => (
                  <div
                    key={run.runId || i}
                    className="p-4 rounded-xl bg-slate-800/50 border border-white/[0.06]"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {run.status === 'ok' || run.status === 'success' ? (
                          <CheckCircle size={16} className="text-emerald-400" />
                        ) : (
                          <XCircle size={16} className="text-red-400" />
                        )}
                        <span className="text-sm font-medium text-white capitalize">
                          {run.status}
                        </span>
                      </div>
                      <span className="text-xs text-slate-500">
                        {run.durationMs ? formatDuration(run.durationMs) : '—'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      {new Date(run.startedAtMs).toLocaleString()}
                    </p>
                    {run.output && (
                      <pre className="mt-2 text-[11px] text-slate-300 bg-slate-950/40 border border-white/[0.04] rounded-md p-2 max-h-32 overflow-auto whitespace-pre-wrap break-words">
                        {run.output}
                      </pre>
                    )}
                    {run.error && (
                      <p className="mt-2 text-xs text-red-400/80 font-mono whitespace-pre-wrap break-words">
                        {run.error}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
      </motion.div>
    </ViewportModal>
  );
}

/* ─── Empty State ───────────────────────────────────────── */

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-20 text-center"
    >
      <div className="w-20 h-20 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-6">
        <Timer size={40} className="text-emerald-400" />
      </div>
      <h3 className="text-xl font-semibold text-white mb-2">No Automations Yet</h3>
      <p className="text-slate-400 max-w-sm mb-6">
        Schedule recurring tasks for your AI agent. Health checks, reports, reminders, and more.
      </p>
      <button
        onClick={onCreate}
        className="px-5 py-2.5 rounded-xl bg-emerald-500 text-white font-medium hover:bg-emerald-600 transition-colors flex items-center gap-2"
      >
        <Plus size={18} />
        Create Your First Automation
      </button>
    </motion.div>
  );
}

/* ─── Content Props ─────────────────────────────────────── */

interface AutomationsContentProps {
  agentId?: string;
  showHeader?: boolean;
}

/* ─── Embeddable Content Component ──────────────────────── */

export function AutomationsContent({ agentId, showHeader = false }: AutomationsContentProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [historyJob, setHistoryJob] = useState<CronJob | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [cardMutation, setCardMutation] = useState<AutomationCardMutation | null>(null);
  const cardMutationAdmissionRef = useRef<AutomationCardMutation | null>(null);
  const deleteSubmittingRef = useRef(false);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const delayedRefreshTimersRef = useRef<Set<number>>(new Set());

  const fetchJobs = useCallback(async (opts?: { isRefresh?: boolean; force?: boolean }) => {
    const isRefresh = Boolean(opts?.isRefresh);
    const force = Boolean(opts?.force);

    if (!force && inFlightRef.current) return;

    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;

    try {
      if (!isRefresh) setLoading(true);
      else setRefreshing(true);
      const data = await automationsAPI.list(agentId, { signal: controller.signal });
      if (inFlightRef.current !== controller) return;
      setJobs(normalizeJobsResponse(data));
      setError(null);
    } catch (err: any) {
      if (controller.signal.aborted) return;
      console.error('Failed to load automations:', err);
      setError(extractApiError(err, 'Failed to load automations'));
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [agentId]);

  const scheduleRefresh = useCallback((delayMs: number) => {
    const timer = window.setTimeout(() => {
      delayedRefreshTimersRef.current.delete(timer);
      void fetchJobs({ isRefresh: true });
    }, delayMs);
    delayedRefreshTimersRef.current.add(timer);
  }, [fetchJobs]);

  useEffect(() => {
    void fetchJobs({ force: true });
    const delayedTimers = delayedRefreshTimersRef.current;

    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void fetchJobs({ isRefresh: true });
    };

    refreshTimerRef.current = window.setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearInterval(refreshTimerRef.current);
      }
      document.removeEventListener('visibilitychange', tick);
      inFlightRef.current?.abort();
      inFlightRef.current = null;
      for (const timer of delayedTimers) window.clearTimeout(timer);
      delayedTimers.clear();
    };
  }, [fetchJobs]);
  
  const handleCreate = () => {
    if (cardMutationAdmissionRef.current) return;
    setEditingJob(null);
    setModalOpen(true);
  };
  
  const handleEdit = (job: CronJob) => {
    if (cardMutationAdmissionRef.current) return;
    setEditingJob(job);
    setModalOpen(true);
  };
  
  const handleSave = async (data: any) => {
    // Include agentId in the save data if creating new
    setActionError(null);
    const saveData = editingJob ? data : { ...data, agent: data.agent || agentId || 'main' };
    try {
      if (editingJob) {
        await automationsAPI.update(editingJob.id, saveData);
      } else {
        await automationsAPI.create(saveData);
      }
      await fetchJobs({ isRefresh: true });
    } catch (err) {
      const message = extractApiError(err, 'Failed to save automation');
      throw new Error(message);
    }
  };
  
  const handleToggle = async (id: string, enabled: boolean) => {
    if (cardMutationAdmissionRef.current || deleteSubmittingRef.current) return;
    const admission: AutomationCardMutation = { kind: 'toggle', jobId: id };
    cardMutationAdmissionRef.current = admission;
    setCardMutation(admission);
    setActionError(null);
    try {
      await automationsAPI.toggle(id, enabled);
      await fetchJobs({ isRefresh: true });
    } catch (err) {
      const message = extractApiError(err, 'Failed to update automation state');
      setActionError(message);
    } finally {
      if (cardMutationAdmissionRef.current === admission) {
        cardMutationAdmissionRef.current = null;
        setCardMutation(null);
      }
    }
  };
  
  const handleDelete = (id: string) => {
    if (deleteSubmittingRef.current || cardMutationAdmissionRef.current) return;
    setDeleteError(null);
    setDeleteConfirm(id);
  };

  const handleDeleteDismiss = useCallback(() => {
    if (deleteSubmittingRef.current) return;
    setDeleteError(null);
    setDeleteConfirm(null);
  }, []);
  
  const confirmDelete = async (event: React.FormEvent) => {
    event.preventDefault();
    const id = deleteConfirm;
    if (!id || deleteSubmittingRef.current || cardMutationAdmissionRef.current) return;

    deleteSubmittingRef.current = true;
    setDeleteError(null);
    setDeleteSubmitting(true);
    try {
      await automationsAPI.remove(id);
      setJobs((current) => current.filter((job) => job.id !== id));
      setDeleteConfirm(null);
      scheduleRefresh(300);
    } catch (err) {
      setDeleteError(extractApiError(err, 'Failed to delete automation'));
    } finally {
      deleteSubmittingRef.current = false;
      setDeleteSubmitting(false);
    }
  };
  
  const handleRunNow = async (id: string) => {
    if (cardMutationAdmissionRef.current || deleteSubmittingRef.current) return;
    const admission: AutomationCardMutation = { kind: 'run', jobId: id };
    cardMutationAdmissionRef.current = admission;
    setCardMutation(admission);
    setActionError(null);
    try {
      await automationsAPI.runNow(id);
      scheduleRefresh(1500);
    } catch (err) {
      const message = extractApiError(err, 'Failed to run automation');
      setActionError(message);
    } finally {
      if (cardMutationAdmissionRef.current === admission) {
        cardMutationAdmissionRef.current = null;
        setCardMutation(null);
      }
    }
  };
  
  const handleViewRuns = (job: CronJob) => {
    setHistoryJob(job);
  };
  
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[300px]">
        <Loader2 size={32} className="text-slate-400 animate-spin" />
      </div>
    );
  }
  
  return (
    <div className="h-full overflow-y-auto p-6 md:p-8">
      {/* Header - only shown when used standalone or showHeader is true */}
      {showHeader && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Automations</h1>
            <p className="text-slate-400 mt-1">Scheduled tasks and recurring agent jobs</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => fetchJobs({ isRefresh: true })}
              className="p-2.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
              title="Refresh"
            >
              <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={handleCreate}
              disabled={cardMutation !== null}
              className="px-4 py-2.5 rounded-xl bg-emerald-500 text-white font-medium hover:bg-emerald-600 transition-colors flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={18} />
              <span className="hidden sm:inline">New Automation</span>
            </button>
          </div>
        </div>
      )}

      {/* Compact Header when embedded */}
      {!showHeader && (
        <div className="flex items-center justify-end gap-3 mb-6">
          <button
            onClick={() => fetchJobs({ isRefresh: true })}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleCreate}
            disabled={cardMutation !== null}
            className="px-3 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-colors flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={16} />
            New Automation
          </button>
        </div>
      )}
      
      {/* Error State */}
      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3">
          <AlertCircle size={20} className="text-red-400 flex-shrink-0" />
          <p className="text-red-400 flex-1">{error}</p>
          <button
            onClick={() => fetchJobs()}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-red-200 bg-red-500/20 hover:bg-red-500/30 transition-colors"
          >
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <div className="mb-6 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center gap-3">
          <AlertCircle size={18} className="text-amber-400 flex-shrink-0" />
          <p className="text-amber-300 text-sm">{actionError}</p>
        </div>
      )}
      
      {/* Content */}
      {!loading && !error && jobs.length === 0 ? (
        <EmptyState onCreate={handleCreate} />
      ) : (
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              activeMutation={cardMutation}
              onToggle={handleToggle}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onRunNow={handleRunNow}
              onViewRuns={handleViewRuns}
            />
          ))}
        </motion.div>
      )}
      
      {/* Create/Edit Modal */}
      <JobModal
        isOpen={modalOpen}
        job={editingJob}
        defaultAgent={agentId || 'main'}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
      />
      
      {/* Run History Drawer */}
      <RunHistoryDrawer
        isOpen={!!historyJob}
        job={historyJob}
        onClose={() => setHistoryJob(null)}
      />
      
      {/* Delete Confirmation */}
      <ViewportModal
        open={Boolean(deleteConfirm)}
        onDismiss={handleDeleteDismiss}
        dismissible={!deleteSubmitting}
        initialFocusRef={deleteCancelRef}
        className="bg-black/60 p-4 backdrop-blur-sm"
      >
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-automation-title"
          aria-describedby="delete-automation-description"
          onSubmit={confirmDelete}
          className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-slate-900 p-6 shadow-2xl"
        >
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/15">
              <Trash2 size={20} className="text-red-400" />
            </div>
            <h3 id="delete-automation-title" className="text-lg font-semibold text-white">Delete Automation?</h3>
          </div>
          <p id="delete-automation-description" className="mb-6 text-slate-400">
            This action cannot be undone. The automation will be permanently removed.
          </p>
          {deleteError && (
            <div role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {deleteError}
            </div>
          )}
          <div className="flex items-center justify-end gap-3">
            <button
              ref={deleteCancelRef}
              type="button"
              onClick={handleDeleteDismiss}
              disabled={deleteSubmitting}
              className="rounded-lg px-4 py-2 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={deleteSubmitting}
              aria-busy={deleteSubmitting}
              className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleteSubmitting && <Loader2 size={16} className="animate-spin" />}
              {deleteSubmitting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </form>
      </ViewportModal>
    </div>
  );
}

/* ─── Main Page Component (Standalone) ──────────────────── */

export default function AutomationsPage() {
  return <AutomationsContent showHeader={true} />;
}
