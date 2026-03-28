import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Timer, Plus, Play, Pause, Trash2, Edit2, Clock, 
  Calendar, RefreshCw, X, ChevronRight, AlertCircle,
  CheckCircle, XCircle, Loader2, History, Zap, Bot
} from 'lucide-react';
import { automationsAPI, gatewayAPI } from '../api/endpoints';

/* ─── Types ─────────────────────────────────────────────── */

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  agentId?: string;
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
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } },
};
const slideInVariant = {
  hidden: { x: '100%' },
  show: { x: 0, transition: { type: 'spring', stiffness: 300, damping: 30 } },
  exit: { x: '100%', transition: { duration: 0.2 } },
};

/* ─── Job Card Component ────────────────────────────────── */

interface JobCardProps {
  job: CronJob;
  deleting?: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (job: CronJob) => void;
  onDelete: (id: string) => void;
  onRunNow: (id: string) => void;
  onViewRuns: (job: CronJob) => void;
}

function JobCard({ job, deleting = false, onToggle, onEdit, onDelete, onRunNow, onViewRuns }: JobCardProps) {
  const [running, setRunning] = useState(false);
  const [toggling, setToggling] = useState(false);
  
  const handleRunNow = async () => {
    setRunning(true);
    try {
      await onRunNow(job.id);
    } finally {
      setRunning(false);
    }
  };
  
  const handleToggle = async () => {
    setToggling(true);
    try {
      await onToggle(job.id, !job.enabled);
    } finally {
      setToggling(false);
    }
  };
  
  const statusIcon = useMemo(() => {
    const status = job.state?.lastRunStatus;
    if (status === 'ok' || status === 'success') return <CheckCircle size={14} className="text-emerald-400" />;
    if (status === 'error' || status === 'failed') return <XCircle size={14} className="text-red-400" />;
    return null;
  }, [job.state?.lastRunStatus]);
  
  return (
    <motion.div
      variants={cardVariant}
      className={`relative overflow-hidden rounded-2xl border backdrop-blur-xl p-5 flex flex-col gap-4 hover-lift transition-all duration-200 ${
        deleting
          ? 'bg-gradient-to-br from-red-900/20 to-slate-950/60 border-red-500/20 opacity-60 pointer-events-none'
          : job.enabled
            ? 'bg-gradient-to-br from-slate-800/50 to-slate-900/50 border-white/[0.08]'
            : 'bg-gradient-to-br from-slate-900/50 to-slate-950/50 border-white/[0.04] opacity-70'
      }`}
    >
      {deleting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/45 backdrop-blur-[1px]">
          <div className="inline-flex items-center gap-2 rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200">
            <Loader2 size={14} className="animate-spin" />
            Deleting…
          </div>
        </div>
      )}

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
          onClick={handleToggle}
          disabled={toggling}
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
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          title="View runs"
        >
          <History size={16} />
        </button>
        
        <button
          onClick={handleRunNow}
          disabled={running}
          className="p-2 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
          title="Run now"
        >
          {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
        </button>
        
        <button
          onClick={() => onEdit(job)}
          className="p-2 rounded-lg text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
          title="Edit"
        >
          <Edit2 size={16} />
        </button>
        
        <button
          onClick={() => onDelete(job.id)}
          className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
          title="Delete"
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
  const [tz, setTz] = useState('America/New_York');
  
  // Reset form when job changes
  useEffect(() => {
    if (job) {
      setName(job.name || '');
      setAgent(job.agentId || 'main');
      setModel(job.payload?.model || '');
      setMessage(job.payload?.message || '');
      setThinking(job.payload?.thinking || 'off');
      setTz(job.schedule.tz || 'America/New_York');
      
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
      setTz('America/New_York');
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
    setSubmitError(null);

    const errors: ValidationErrors = {};
    const trimmedName = name.trim();
    const trimmedAgent = agent.trim();
    const trimmedModel = model.trim();
    const trimmedTask = message.trim();
    const trimmedCustomCron = customCron.trim();
    const validCron = /^(\*|[0-5]?\d)(\/\d+)?\s+(\*|[01]?\d|2[0-3])(\-\d+|\/\d+)?\s+(\*|[1-9]|[12]\d|3[01])(\-\d+|\/\d+)?\s+(\*|[1-9]|1[0-2])(\-\d+|\/\d+)?\s+(\*|[0-6]|\d-\d)(\/\d+)?$/;
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
        model: trimmedModel || undefined,
        message: trimmedTask,
        thinking: thinking !== 'off' ? thinking : undefined,
        tz,
      });
      onClose();
    } catch (err) {
      console.error('Failed to save job:', err);
      setSubmitError(err instanceof Error ? err.message : 'Failed to save automation');
    } finally {
      setSaving(false);
    }
  };
  
  if (!isOpen) return null;
  
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          variants={modalVariant}
          initial="hidden"
          animate="show"
          exit="exit"
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-lg bg-slate-900 border border-white/[0.08] rounded-2xl shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
            <h2 className="text-lg font-semibold text-white">
              {job ? 'Edit Automation' : 'New Automation'}
            </h2>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
            >
              <X size={20} />
            </button>
          </div>
          
          {/* Form */}
          <form onSubmit={handleSubmit} className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setValidationErrors(prev => ({ ...prev, name: undefined })); }}
                placeholder="My automation"
                className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
                required
              />
              {validationErrors.name && <p className="mt-1.5 text-xs text-red-400">{validationErrors.name}</p>}
            </div>
            
            {/* Schedule Type */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Schedule</label>
              <div className="grid grid-cols-5 gap-2">
                {(['interval', 'hourly', 'daily', 'weekly', 'custom'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setScheduleType(type)}
                    className={`px-3 py-2 rounded-lg text-xs font-medium capitalize transition-colors ${
                      scheduleType === type
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'bg-slate-800 text-slate-400 border border-white/[0.08] hover:bg-slate-700'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
            
            {/* Schedule Options */}
            {scheduleType === 'interval' && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Run every</label>
                <select
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
                    <label className="block text-sm font-medium text-slate-300 mb-2">Day</label>
                    <select
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
                  <label className="block text-sm font-medium text-slate-300 mb-2">Time</label>
                  <input
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
                <label className="block text-sm font-medium text-slate-300 mb-2">Cron Expression</label>
                <input
                  type="text"
                  value={customCron}
                  onChange={(e) => { setCustomCron(e.target.value); setValidationErrors(prev => ({ ...prev, schedule: undefined })); }}
                  placeholder="*/30 * * * *"
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
              <label className="block text-sm font-medium text-slate-300 mb-2">Timezone</label>
              <select
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white focus:outline-none focus:border-emerald-500/50"
              >
                <option value="America/New_York">Eastern (New York)</option>
                <option value="America/Chicago">Central (Chicago)</option>
                <option value="America/Denver">Mountain (Denver)</option>
                <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
                <option value="UTC">UTC</option>
                <option value="Europe/London">London</option>
                <option value="Europe/Paris">Paris</option>
                <option value="Asia/Tokyo">Tokyo</option>
              </select>
            </div>
            
            {/* Agent & Model */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Agent</label>
                <input
                  type="text"
                  value={agent}
                  onChange={(e) => { setAgent(e.target.value); setValidationErrors(prev => ({ ...prev, agent: undefined })); }}
                  placeholder="main"
                  className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50"
                />
                {validationErrors.agent && <p className="mt-1.5 text-xs text-red-400">{validationErrors.agent}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Model (optional)</label>
                <select
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
              <label className="block text-sm font-medium text-slate-300 mb-2">Thinking Level</label>
              <select
                value={thinking}
                onChange={(e) => setThinking(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white focus:outline-none focus:border-emerald-500/50"
              >
                <option value="off">Off</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            
            {/* Message */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Prompt / Task</label>
              <textarea
                value={message}
                onChange={(e) => { setMessage(e.target.value); setValidationErrors(prev => ({ ...prev, task: undefined })); }}
                placeholder="What should the agent do?"
                rows={4}
                className="w-full px-4 py-2.5 bg-slate-800 border border-white/[0.08] rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/50 resize-none"
                required
              />
              {validationErrors.task && <p className="mt-1.5 text-xs text-red-400">{validationErrors.task}</p>}
            </div>
            {submitError && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {submitError}
              </div>
            )}
          </form>
          
          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/[0.08] bg-slate-900/50">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving || !name || !message}
              className="px-5 py-2 rounded-lg bg-emerald-500 text-white font-medium hover:bg-emerald-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {saving && <Loader2 size={16} className="animate-spin" />}
              {job ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
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
  
  const loadRuns = useCallback(async () => {
    if (!job) return;
    setLoading(true);
    setError(null);
    try {
      const data = await automationsAPI.runs(job.id, 50);
      const nextRuns = Array.isArray(data.runs) ? data.runs.map(normalizeRun) : [];
      setRuns(nextRuns);
    } catch (err) {
      console.error('Failed to load automation runs:', err);
      const message = err instanceof Error ? err.message : 'Failed to load run history';
      setError(message);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [job]);

  useEffect(() => {
    if (isOpen && job) {
      loadRuns();
    }
  }, [isOpen, job, loadRuns]);
  
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            variants={slideInVariant}
            initial="hidden"
            animate="show"
            exit="exit"
            className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-slate-900 border-l border-white/[0.08] shadow-2xl flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]">
              <div>
                <h2 className="text-lg font-semibold text-white">Run History</h2>
                <p className="text-sm text-slate-400 truncate mt-0.5">{job?.name}</p>
              </div>
              <button
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
        </>
      )}
    </AnimatePresence>
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
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  
  const fetchJobs = useCallback(async (opts?: { isRefresh?: boolean }) => {
    const isRefresh = Boolean(opts?.isRefresh);
    try {
      if (!isRefresh) setLoading(true);
      else setRefreshing(true);
      const data = await automationsAPI.list(agentId);
      setJobs(normalizeJobsResponse(data));
      setError(null);
    } catch (err: any) {
      console.error('Failed to load automations:', err);
      setError(extractApiError(err, 'Failed to load automations'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [agentId]);
  
  useEffect(() => {
    fetchJobs();
    // Refresh every 30 seconds
    const interval = setInterval(() => fetchJobs({ isRefresh: true }), 30000);
    return () => clearInterval(interval);
  }, [fetchJobs]);
  
  const handleCreate = () => {
    setEditingJob(null);
    setModalOpen(true);
  };
  
  const handleEdit = (job: CronJob) => {
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
      setActionError(message);
      throw err;
    }
  };
  
  const handleToggle = async (id: string, enabled: boolean) => {
    setActionError(null);
    try {
      await automationsAPI.toggle(id, enabled);
      await fetchJobs({ isRefresh: true });
    } catch (err) {
      const message = extractApiError(err, 'Failed to update automation state');
      setActionError(message);
    }
  };
  
  const handleDelete = async (id: string) => {
    setDeleteConfirm(id);
  };
  
  const confirmDelete = async () => {
    if (deleteConfirm) {
      const id = deleteConfirm;
      setActionError(null);
      setDeleteSubmitting(true);
      setDeletingJobId(id);
      setDeleteConfirm(null);
      try {
        await automationsAPI.remove(id);
        setJobs((current) => current.filter((job) => job.id !== id));
        setTimeout(() => {
          void fetchJobs({ isRefresh: true });
        }, 300);
      } catch (err) {
        const message = extractApiError(err, 'Failed to delete automation');
        setActionError(message);
        await fetchJobs({ isRefresh: true });
      } finally {
        setDeletingJobId(null);
        setDeleteSubmitting(false);
      }
    }
  };
  
  const handleRunNow = async (id: string) => {
    setActionError(null);
    try {
      await automationsAPI.runNow(id);
      setTimeout(() => fetchJobs({ isRefresh: true }), 1500);
    } catch (err) {
      const message = extractApiError(err, 'Failed to run automation');
      setActionError(message);
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
              className="px-4 py-2.5 rounded-xl bg-emerald-500 text-white font-medium hover:bg-emerald-600 transition-colors flex items-center gap-2"
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
            className="px-3 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-colors flex items-center gap-1.5"
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
              deleting={deletingJobId === job.id}
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
      <AnimatePresence>
        {deleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={() => setDeleteConfirm(null)}
          >
            <motion.div
              variants={modalVariant}
              initial="hidden"
              animate="show"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-slate-900 border border-white/[0.08] rounded-2xl shadow-2xl p-6"
            >
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center">
                  <Trash2 size={20} className="text-red-400" />
                </div>
                <h3 className="text-lg font-semibold text-white">Delete Automation?</h3>
              </div>
              <p className="text-slate-400 mb-6">
                This action cannot be undone. The automation will be permanently removed.
              </p>
              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  disabled={deleteSubmitting}
                  className="px-4 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={deleteSubmitting}
                  className="px-4 py-2 rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2"
                >
                  {deleteSubmitting && <Loader2 size={16} className="animate-spin" />}
                  {deleteSubmitting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── Main Page Component (Standalone) ──────────────────── */

export default function AutomationsPage() {
  return <AutomationsContent showHeader={true} />;
}
