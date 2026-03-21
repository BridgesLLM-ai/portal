import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import {
  ChevronRight,
  Clock,
  Download,
  Loader2,
  MessageSquare,
  Octagon,
  PlayCircle,
  RefreshCw,
  Send,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { agentJobsAPI, AgentJob, TranscriptEntry } from '../api/agentJobs';
import { agentRuntimeAPI, AgentRuntimeStatus } from '../api/agentRuntime';

/* ─── Transcript Cache ──────────────────────────────────────────────────── */

const MAX_CACHE_SIZE = 20;

class TranscriptCache {
  private cache = new Map<string, TranscriptEntry[]>();
  private accessOrder: string[] = [];

  get(jobId: string): TranscriptEntry[] | undefined {
    return this.cache.get(jobId);
  }

  set(jobId: string, entries: TranscriptEntry[]): void {
    // Update access order
    const idx = this.accessOrder.indexOf(jobId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(jobId);

    // Evict oldest if over limit
    while (this.accessOrder.length > MAX_CACHE_SIZE) {
      const evict = this.accessOrder.shift();
      if (evict) this.cache.delete(evict);
    }

    this.cache.set(jobId, entries);
  }

  append(jobId: string, entry: TranscriptEntry): void {
    const existing = this.cache.get(jobId) || [];
    this.set(jobId, [...existing, entry]);
  }

  clear(jobId: string): void {
    this.cache.delete(jobId);
    const idx = this.accessOrder.indexOf(jobId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
  }
}

/* ─── Constants ─────────────────────────────────────────────────────────── */

const ADAPTER_DEFAULTS: Record<string, string> = {
  codex: 'codex exec "Say hello briefly and exit."',
  'claude-code': 'claude -p "Say hello briefly and exit."',
  openclaw: 'openclaw gateway status',
  'agent-zero': 'docker ps --filter name=agent-zero --format "table {{.Status}}\t{{.Ports}}"',
  gemini: 'gemini --version',
  shell: 'echo "hello"',
};

const ADAPTER_MODEL_FLAGS: Record<string, string> = {
  codex: '--model',
  'claude-code': '--model',
  openclaw: '--model',
  gemini: '--model',
};

const MODEL_STORAGE_PREFIX = 'agentChats.lastModel.';

const TOOL_META: Record<string, { emoji: string; label: string; color: string; accent: string }> = {
  codex: { emoji: '\u26a1', label: 'Codex', color: 'text-amber-400', accent: 'border-l-amber-400' },
  'claude-code': { emoji: '\ud83e\udde0', label: 'Claude Code', color: 'text-violet-400', accent: 'border-l-violet-400' },
  openclaw: { emoji: '\ud83e\udd9e', label: 'OpenClaw', color: 'text-emerald-400', accent: 'border-l-emerald-400' },
  'agent-zero': { emoji: '\ud83e\udd16', label: 'Agent Zero', color: 'text-orange-400', accent: 'border-l-orange-400' },
  gemini: { emoji: '\u2728', label: 'Gemini', color: 'text-cyan-400', accent: 'border-l-cyan-400' },
  shell: { emoji: '\ud83d\udda5\ufe0f', label: 'Shell', color: 'text-slate-400', accent: 'border-l-slate-400' },
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, now - then);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toolMeta(toolId: string) {
  return TOOL_META[toolId] || { emoji: '\ud83d\udd27', label: toolId, color: 'text-slate-400', accent: 'border-l-slate-500' };
}


function sanitizeTerminalText(raw: string): string {
  if (!raw) return '';

  // Strip ANSI escape sequences
  let text = raw.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');

  // Strip OSC sequences (e.g. title updates)
  text = text.replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, '');

  // Remove other control chars except newlines/tabs
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  // Apply backspaces (\b) by removing previous char
  while (/[^\n]\b/.test(text)) {
    text = text.replace(/[^\n]\b/g, '');
  }
  text = text.replace(/\b/g, '');

  // Normalize CRLF and bare CR
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return text;
}

/* ─── Typing indicator (3-dot iMessage pulse) ───────────────────────────── */

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-1 pt-2">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block w-[6px] h-[6px] rounded-full bg-violet-400/70"
          style={{
            animation: 'agent-typing-bounce 1.4s ease-in-out infinite',
            animationDelay: `${i * 0.16}s`,
          }}
        />
      ))}
    </div>
  );
}

/* ─── Thinking state ────────────────────────────────────────────────────── */

function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2.5 px-4 py-3 rounded-2xl rounded-bl-md bg-slate-800/70 border-l-[3px] border-l-violet-500/40">
        <Loader2 size={14} className="animate-spin text-violet-400" />
        <span className="text-sm text-slate-400 italic">Agent is thinking\u2026</span>
      </div>
    </div>
  );
}

/* ─── Status chip ───────────────────────────────────────────────────────── */

function StatusChip({ status }: { status: string }) {
  const config: Record<string, { icon: string; text: string; cls: string }> = {
    running: { icon: '\u27f3', text: 'Running', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' },
    completed: { icon: '\u2713', text: 'Done', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/20' },
    error: { icon: '\u2717', text: 'Error', cls: 'bg-red-500/15 text-red-300 border-red-500/20' },
    killed: { icon: '\u25a0', text: 'Killed', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/20' },
  };
  const c = config[status] || config.completed;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full border ${c.cls}`}>
      <span>{c.icon}</span> {c.text}
    </span>
  );
}

/* ─── Runtime timer ─────────────────────────────────────────────────────── */

function RuntimeTimer({ startedAt, finishedAt, status }: { startedAt?: string | null; finishedAt?: string | null; status: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    if (status !== 'running') {
      const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
      setElapsed(end - start);
      return;
    }
    const tick = () => setElapsed(Date.now() - start);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, finishedAt, status]);

  if (!startedAt) return null;

  return (
    <span className="flex items-center gap-1 text-[11px] text-slate-500 font-mono tabular-nums">
      <Clock size={11} />
      {formatDuration(elapsed)}
    </span>
  );
}

/* ─── Quick-start card ──────────────────────────────────────────────────── */

function QuickStartCard({ emoji, title, desc, onClick }: { emoji: string; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-center gap-3 p-5 rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:bg-violet-500/[0.06] hover:border-violet-500/20 transition-all duration-200 hover:shadow-lg hover:shadow-violet-500/5 cursor-pointer"
    >
      <span className="text-3xl group-hover:scale-110 transition-transform duration-200">{emoji}</span>
      <div className="text-center">
        <div className="text-sm font-semibold text-slate-200 group-hover:text-white transition-colors">{title}</div>
        <div className="text-xs text-slate-500 mt-0.5">{desc}</div>
      </div>
      <ChevronRight size={14} className="text-slate-600 group-hover:text-violet-400 group-hover:translate-x-0.5 transition-all" />
    </button>
  );
}

/* ─── Message bubble ────────────────────────────────────────────────────── */

function MessageBubble({ entry, toolId, isStreaming }: { entry: TranscriptEntry; toolId: string; isStreaming: boolean }) {
  const isUser = entry.type === 'input';
  const isSystem = entry.type === 'system';
  const meta = toolMeta(toolId);
  const [hovered, setHovered] = useState(false);

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="px-3.5 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.05] text-[11px] text-slate-500 italic">
          {entry.text}
        </div>
      </div>
    );
  }

  if (isUser) {
    return (
      <div
        className="flex justify-end"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="max-w-[78%] flex flex-col items-end gap-0.5">
          <div className="px-4 py-2.5 rounded-[20px] rounded-br-md bg-violet-600 text-white text-sm leading-relaxed whitespace-pre-wrap shadow-lg shadow-violet-600/20 selection:bg-violet-300/30">
            {entry.text}
          </div>
          <div className={`flex items-center gap-1.5 text-[10px] text-slate-500/70 pr-1 transition-all duration-200 overflow-hidden ${hovered ? 'opacity-100 max-h-5 mt-0.5' : 'opacity-0 max-h-0'}`}>
            <span className="text-violet-400/60">{'\u2713'}</span>
            {entry.timestamp && (
              <span>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Agent / tool output
  const safeText = sanitizeTerminalText(entry.text);
  const asciiFallback = (entry.text || '')
    .replace(//g, '')
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const displayText = safeText.trim().length > 0 ? safeText : asciiFallback;
  if (!displayText) return null;

  const isCodeLike = entry.stream === 'stderr' || /^[\s$>#]/.test(displayText) || /[{}[\]();]/.test(displayText);

  return (
    <div
      className="flex justify-start"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="max-w-[82%] flex flex-col gap-0.5">
        <div className={`relative px-4 py-3 rounded-[20px] rounded-bl-md border-l-[3px] ${meta.accent} ${isStreaming ? 'bg-slate-800/90 shadow-lg shadow-violet-500/5' : 'bg-slate-800/60'} transition-all duration-200`}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-xs">{meta.emoji}</span>
            <span className={`text-[10px] font-bold uppercase tracking-wider ${meta.color}`}>{meta.label}</span>
            {isStreaming && (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-violet-400/80">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                streaming
              </span>
            )}
          </div>
          <div className={`text-sm leading-relaxed whitespace-pre-wrap text-slate-200 selection:bg-violet-400/20 ${isCodeLike ? 'font-mono text-[13px] text-slate-300' : ''}`}>
            {displayText}
          </div>
          {isStreaming && <TypingIndicator />}
        </div>
        <div className={`flex items-center gap-1.5 text-[10px] text-slate-500/70 pl-4 transition-all duration-200 overflow-hidden ${hovered ? 'opacity-100 max-h-5 mt-0.5' : 'opacity-0 max-h-0'}`}>
          {entry.timestamp && (
            <span>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Export transcript ─────────────────────────────────────────────────── */

function exportTranscript(job: AgentJob, entries: TranscriptEntry[], format: 'md' | 'txt') {
  const lines = entries.map((t) => {
    const role = t.type === 'input' ? 'You' : t.type === 'system' ? 'System' : 'Agent';
    const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '';
    if (format === 'md') return `**${role}** ${time ? `_${time}_` : ''}\n${t.text}\n`;
    return `[${role}] ${time}\n${t.text}\n`;
  });
  const header = format === 'md'
    ? `# ${job.title || job.id}\n\nTool: ${job.toolId} | Status: ${job.status}\n\n---\n\n`
    : `${job.title || job.id}\nTool: ${job.toolId} | Status: ${job.status}\n${'─'.repeat(40)}\n\n`;
  const blob = new Blob([header + lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `agent-chat-${job.id.slice(0, 8)}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/* ════════════════════════════════════════════════════════════════════════ */
/*  MAIN COMPONENT                                                         */
/* ════════════════════════════════════════════════════════════════════════ */

export default function AgentChatsPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [input, setInput] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [toolId, setToolId] = useState('codex');
  const [command, setCommand] = useState(ADAPTER_DEFAULTS.codex);
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState(localStorage.getItem(`${MODEL_STORAGE_PREFIX}codex`) || '');
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus | null>(null);
  const [isStartingJob, setIsStartingJob] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [socketState, setSocketState] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const startJobLock = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptCacheRef = useRef(new TranscriptCache());
  const socketRef = useRef<Socket | null>(null);
  const currentSubscriptionRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef(0);

  const selectedJob = useMemo(() => jobs.find((j) => j.id === selectedJobId) || null, [jobs, selectedJobId]);
  const adapterSupportsModel = !!ADAPTER_MODEL_FLAGS[toolId];
  const isRunning = selectedJob?.status === 'running';

  // Auto-scroll
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript, isThinking]);

  // Load jobs + keep statuses fresh
  useEffect(() => {
    let cancelled = false;

    const loadJobs = async () => {
      try {
        const data = await agentJobsAPI.list();
        if (cancelled) return;
        setJobs(data);
        if (!selectedJobId && data.length > 0) setSelectedJobId(data[0].id);
      } catch {
        // no-op
      }
    };

    loadJobs();
    const interval = setInterval(loadJobs, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedJobId]);

  // Load transcript (with caching)
  useEffect(() => {
    if (!selectedJobId) return;
    setIsThinking(false);

    const cache = transcriptCacheRef.current;
    
    // Show cached version immediately if available
    const cached = cache.get(selectedJobId);
    if (cached) {
      setTranscript(cached);
    }

    // Fetch fresh data in background
    agentJobsAPI.get(selectedJobId)
      .then((job) => {
        const entries = job.transcript || [];
        cache.set(selectedJobId, entries);
        setTranscript(entries);
      })
      .catch(() => {
        if (!cached) setTranscript([]);
      });
  }, [selectedJobId]);

  // Runtime status
  useEffect(() => {
    let cancelled = false;
    const loadRuntime = async () => {
      try {
        const status = await agentRuntimeAPI.status();
        if (!cancelled) setRuntimeStatus(status);
      } catch {
        if (!cancelled) setRuntimeStatus(null);
      }
    };
    loadRuntime();
    const interval = setInterval(loadRuntime, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Auto-start from Agent Tools (deduped)
  // This only fires when navigating FROM another page with startJob in state
  // Clicking sidebar jobs just sets selectedJobId - does NOT trigger this
  useEffect(() => {
    const state = location.state as any;
    const startJobState = state?.startJob;
    
    // Exit early if no start job state
    if (!startJobState?.toolId || !startJobState?.command) return;
    
    // Create a unique signature for this job request
    const sig = JSON.stringify(startJobState);
    
    // Already processed this exact request? Clear state and skip
    if (startJobLock.current === sig) {
      navigate('/agent-chats', { replace: true, state: {} });
      return;
    }
    
    // Lock to prevent re-processing
    startJobLock.current = sig;
    
    let cancelled = false;
    (async () => {
      try {
        const job = await agentJobsAPI.start({
          toolId: startJobState.toolId,
          command: startJobState.command,
          title: startJobState.title || `${startJobState.toolId}: ${startJobState.command}`,
        });
        if (cancelled) return;
        setJobs((prev) => [job, ...prev]);
        setSelectedJobId(job.id);
      } catch { /* no-op */ } finally {
        // Always clear state to prevent re-triggering on re-render
        navigate('/agent-chats', { replace: true, state: {} });
      }
    })();
    return () => { cancelled = true; };
  }, [location.state, navigate]);

  // Persistent WebSocket (connect once, subscribe/unsubscribe to jobs)
  useEffect(() => {
    const wsUrl = import.meta.env.VITE_WS_URL || window.location.origin;
    
    const createSocket = () => {
      setSocketState('connecting');
      
      const socket: Socket = io(`${wsUrl}/ws/agent-jobs`, {
        transports: ['websocket'],
        withCredentials: true,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        reconnectionAttempts: Infinity,
      });

      socket.on('connect', () => {
        setSocketState('connected');
        reconnectAttemptRef.current = 0;
        // Re-subscribe to current job on reconnect
        if (currentSubscriptionRef.current) {
          socket.emit('subscribe', { jobId: currentSubscriptionRef.current });
        }
      });

      socket.on('disconnect', () => {
        setSocketState('connecting');
      });

      socket.on('connect_error', () => {
        reconnectAttemptRef.current++;
        setSocketState('error');
      });

      socket.on('output', ({ jobId, entry }: { jobId: string; entry: TranscriptEntry }) => {
        // Update cache regardless of current selection
        transcriptCacheRef.current.append(jobId, entry);
        
        // Only update UI state if this is the selected job
        if (jobId === currentSubscriptionRef.current) {
          setIsThinking(false);
          setTranscript((prev) => [...prev, entry]);
        }
      });

      socketRef.current = socket;
    };

    createSocket();

    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  // Subscribe/unsubscribe when selected job changes
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    // Unsubscribe from previous job
    if (currentSubscriptionRef.current && currentSubscriptionRef.current !== selectedJobId) {
      socket.emit('unsubscribe', { jobId: currentSubscriptionRef.current });
    }

    // Subscribe to new job
    if (selectedJobId) {
      socket.emit('subscribe', { jobId: selectedJobId });
      currentSubscriptionRef.current = selectedJobId;
    } else {
      currentSubscriptionRef.current = null;
    }
  }, [selectedJobId]);

  // Poll transcript/status when job is running (fallback if websocket drops)
  useEffect(() => {
    if (!selectedJobId || !isRunning) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const job = await agentJobsAPI.get(selectedJobId);
        if (cancelled) return;
        setTranscript(job.transcript || []);
        setJobs((prev) => prev.map((j) => (j.id === selectedJobId ? { ...j, status: job.status, updatedAt: job.updatedAt, finishedAt: job.finishedAt, exitCode: job.exitCode } : j)));
      } catch {
        // no-op
      }
    };

    const interval = setInterval(poll, 2500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedJobId, isRunning]);

  // Sync adapter defaults
  useEffect(() => {
    if (!toolId) return;
    if (ADAPTER_DEFAULTS[toolId]) setCommand(ADAPTER_DEFAULTS[toolId]);
    setModel(localStorage.getItem(`${MODEL_STORAGE_PREFIX}${toolId}`) || '');
  }, [toolId]);

  // Relative time refresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  /* ── Actions ───────────────────────────────────────────────────────── */

  const refreshTranscript = useCallback(async () => {
    if (!selectedJobId || isRefreshing) return;
    setIsRefreshing(true);
    try {
      // Clear cache for this job to force fresh data
      transcriptCacheRef.current.clear(selectedJobId);
      
      // Fetch fresh transcript
      const job = await agentJobsAPI.get(selectedJobId);
      const entries = job.transcript || [];
      transcriptCacheRef.current.set(selectedJobId, entries);
      setTranscript(entries);
      
      // Update job status
      setJobs((prev) => prev.map((j) => 
        j.id === selectedJobId 
          ? { ...j, status: job.status, updatedAt: job.updatedAt, finishedAt: job.finishedAt, exitCode: job.exitCode }
          : j
      ));

      // Reconnect socket if disconnected
      const socket = socketRef.current;
      if (socket && !socket.connected) {
        socket.connect();
      } else if (socket && selectedJobId) {
        // Re-subscribe to ensure we're receiving updates
        socket.emit('subscribe', { jobId: selectedJobId });
      }
    } catch {
      // no-op
    } finally {
      setIsRefreshing(false);
    }
  }, [selectedJobId, isRefreshing]);

  const sendInput = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedJobId || !input.trim()) return;
    setIsThinking(true);
    await agentJobsAPI.input(selectedJobId, `${input}\n`);
    setInput('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput(e as any);
    }
  };

  const buildCommand = () => {
    const trimmed = command.trim();
    if (!adapterSupportsModel || !model.trim()) return trimmed;
    const modelFlag = ADAPTER_MODEL_FLAGS[toolId];
    if (!modelFlag) return trimmed;
    if (new RegExp(`(^|\\s)${modelFlag}\\s+`).test(trimmed)) return trimmed;
    return `${trimmed} ${modelFlag} ${shellQuote(model.trim())}`;
  };

  const startJob = async (e: FormEvent) => {
    e.preventDefault();
    if (isStartingJob) return;
    setIsStartingJob(true);
    try {
      const computedCommand = buildCommand();
      const job = await agentJobsAPI.start({
        toolId,
        command: computedCommand,
        cwd: cwd || undefined,
        title: `${toolId}: ${computedCommand.slice(0, 40)}`,
      });
      if (model.trim()) localStorage.setItem(`${MODEL_STORAGE_PREFIX}${toolId}`, model.trim());
      setShowModal(false);
      setJobs((prev) => [job, ...prev]);
      setSelectedJobId(job.id);
    } finally {
      setIsStartingJob(false);
    }
  };

  const startQuickJob = useCallback(async (tid: string) => {
    try {
      const cmd = ADAPTER_DEFAULTS[tid] || 'echo hello';
      const job = await agentJobsAPI.start({ toolId: tid, command: cmd, title: `${tid}: ${cmd}` });
      setJobs((prev) => [job, ...prev]);
      setSelectedJobId(job.id);
    } catch { /* no-op */ }
  }, []);

  const activeAdapters = runtimeStatus?.adapters?.filter((a: any) => a.id !== 'shell' && a.available).length || 0;

  /* ── Render ────────────────────────────────────────────────────────── */

  return (
    <div className="h-full flex bg-slate-950 text-slate-100">

      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      <aside className="w-80 border-r border-white/[0.06] flex flex-col bg-[#080c21] shrink-0">
        <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-violet-400" />
            <h2 className="font-semibold text-sm tracking-tight">Agent Chats</h2>
          </div>
          <button
            className="px-3 py-1.5 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 font-medium transition-colors duration-150 flex items-center gap-1.5 shadow-md shadow-violet-600/20"
            onClick={() => setShowModal(true)}
          >
            <PlayCircle size={12} /> New Run
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-2 space-y-1">
          {jobs.length === 0 && (
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 text-center mt-2">
              <div className="w-12 h-12 rounded-2xl bg-violet-500/10 flex items-center justify-center mx-auto mb-3">
                <Sparkles size={20} className="text-violet-400" />
              </div>
              <p className="text-sm font-medium text-slate-300">No agent runs yet</p>
              <p className="text-xs text-slate-500 mt-1">Start one to see it here</p>
              <button
                className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors shadow-md shadow-violet-600/20"
                onClick={() => setShowModal(true)}
              >
                Start a run <ChevronRight size={12} />
              </button>
            </div>
          )}
          {jobs.map((job) => {
            const isActive = selectedJobId === job.id;
            const meta = toolMeta(job.toolId);
            const jobRunning = job.status === 'running';
            return (
              <button
                key={job.id}
                onClick={() => setSelectedJobId(job.id)}
                className={`w-full text-left px-3 py-3 rounded-xl transition-all duration-150 group ${
                  isActive
                    ? 'bg-violet-500/10 border-l-[3px] border-l-violet-500 ml-0'
                    : 'border-l-[3px] border-l-transparent hover:bg-white/[0.03]'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <span className="text-base mt-0.5 shrink-0">{meta.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className={`text-sm font-medium truncate ${isActive ? 'text-white' : 'text-slate-300'}`}>
                        {job.title || 'Untitled job'}
                      </div>
                      <span
                        className={`inline-flex h-2 w-2 rounded-full shrink-0 ${
                          jobRunning
                            ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50 animate-pulse'
                            : job.status === 'error' ? 'bg-red-400' : 'bg-slate-600'
                        }`}
                      />
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                      <span className={`font-medium ${meta.color}`}>{meta.label}</span>
                      <span className="text-slate-700">{'\u00b7'}</span>
                      <span>{relativeTime(job.updatedAt || job.createdAt)}</span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── Main Panel ──────────────────────────────────────────────── */}
      <section className="flex-1 flex flex-col min-w-0">

        {/* Header */}
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between gap-3 bg-[#0b1028]/80 backdrop-blur-sm shrink-0">
          {selectedJob ? (
            <>
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-lg">{toolMeta(selectedJob.toolId).emoji}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-200 truncate">
                      {toolMeta(selectedJob.toolId).label}
                    </span>
                    <StatusChip status={selectedJob.status} />
                  </div>
                  <div className="text-[11px] text-slate-500 truncate mt-0.5">
                    {selectedJob.title || selectedJob.id}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span 
                  className={`px-2 py-0.5 rounded-full text-[10px] border flex items-center gap-1 ${
                    socketState === 'connected' 
                      ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' 
                      : socketState === 'connecting' 
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/20' 
                        : 'bg-red-500/10 text-red-300 border-red-500/20'
                  }`}
                  title={socketState === 'error' ? 'Click refresh to reconnect' : undefined}
                >
                  {socketState === 'connecting' && <Loader2 size={10} className="animate-spin" />}
                  {socketState === 'connected' ? 'Live' : socketState === 'connecting' ? 'Reconnecting' : 'Disconnected'}
                </span>
                <RuntimeTimer startedAt={selectedJob.startedAt} finishedAt={selectedJob.finishedAt} status={selectedJob.status} />
                <button
                  onClick={refreshTranscript}
                  disabled={isRefreshing}
                  className={`p-1.5 rounded-lg transition-colors ${isRefreshing ? 'text-violet-400' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.05]'}`}
                  title="Refresh transcript"
                >
                  <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => exportTranscript(selectedJob, transcript, 'md')}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] transition-colors"
                  title="Export transcript (.md)"
                >
                  <Download size={14} />
                </button>
                {isRunning && (
                  <button
                    onClick={() => agentJobsAPI.kill(selectedJob.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium transition-colors shadow-md shadow-red-600/20"
                  >
                    <Octagon size={12} /> Stop
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <MessageSquare size={16} className="text-slate-600" />
              <span className="text-sm text-slate-500">Select or start a run</span>
            </div>
          )}
        </div>

        {/* Chat area */}
        <div className="flex-1 overflow-y-auto">
          {!selectedJob ? (
            /* Onboarding */
            <div className="h-full flex items-center justify-center p-6">
              <div className="max-w-lg w-full text-center">
                <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-violet-500/20 to-violet-600/10 border border-violet-500/10 flex items-center justify-center mx-auto mb-5">
                  <Zap size={28} className="text-violet-400" />
                </div>
                <h2 className="text-xl font-bold text-slate-200 mb-2">Start an agent run</h2>
                <p className="text-sm text-slate-500 mb-8">Choose an agent to get started, or create a custom run.</p>
                <div className="grid grid-cols-3 gap-3">
                  <QuickStartCard emoji={'\ud83e\udd9e'} title="OpenClaw" desc="Gateway status" onClick={() => startQuickJob('openclaw')} />
                  <QuickStartCard emoji={'\ud83e\udde0'} title="Claude Code" desc="Interactive coding" onClick={() => startQuickJob('claude-code')} />
                  <QuickStartCard emoji={'\u26a1'} title="Codex" desc="Code generation" onClick={() => startQuickJob('codex')} />
                </div>
              </div>
            </div>
          ) : (
            /* Transcript */
            <div className="p-4 space-y-3">
              {transcript.length === 0 && !isThinking && (
                <div className="h-full min-h-[200px] grid place-items-center text-center">
                  <div className="max-w-sm rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6">
                    <Loader2 size={20} className="mx-auto text-violet-400/50 mb-2 animate-spin" />
                    <p className="text-sm text-slate-400">Waiting for output{'\u2026'}</p>
                    <p className="text-xs text-slate-600 mt-1">Output will appear here in real time.</p>
                  </div>
                </div>
              )}
              {transcript.map((line, idx) => {
                const isLast = idx === transcript.length - 1;
                const streaming = isRunning && isLast && line.type !== 'input';
                return (
                  <MessageBubble
                    key={`${line.timestamp}-${idx}`}
                    entry={line}
                    toolId={selectedJob.toolId}
                    isStreaming={streaming}
                  />
                );
              })}
              {isThinking && <ThinkingBubble />}
              <div ref={transcriptEndRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="p-3 border-t border-white/[0.06] bg-[#080c21]">
          <form onSubmit={sendInput} className="flex items-end gap-2">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                className={`w-full bg-slate-900/80 border rounded-2xl px-4 py-2.5 text-sm resize-none focus:outline-none transition-colors ${
                  isRunning
                    ? 'border-white/10 focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20 text-slate-200 placeholder:text-slate-500'
                    : 'border-white/[0.06] text-slate-500 placeholder:text-slate-600 cursor-not-allowed'
                }`}
                placeholder={isRunning ? 'Send input to agent\u2026' : 'No running job'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!isRunning}
                rows={1}
                style={{ minHeight: '40px', maxHeight: '120px' }}
              />
              <div className="absolute right-3 bottom-2 text-[10px] text-slate-600 pointer-events-none">
                {isRunning && '\u21b5 Enter \u00b7 \u21e7\u21b5 newline'}
              </div>
            </div>
            <button
              type="submit"
              className={`p-2.5 rounded-xl transition-all duration-150 ${
                isRunning && input.trim()
                  ? 'bg-violet-600 hover:bg-violet-500 text-white shadow-md shadow-violet-600/20'
                  : 'bg-slate-800/50 text-slate-600 cursor-not-allowed'
              }`}
              disabled={!isRunning || !input.trim()}
            >
              <Send size={16} />
            </button>
            {selectedJob && isRunning && (
              <button
                type="button"
                onClick={() => agentJobsAPI.kill(selectedJob.id)}
                className="p-2.5 rounded-xl bg-red-700/80 hover:bg-red-600 text-white transition-colors"
                title="Stop job"
              >
                <Octagon size={16} />
              </button>
            )}
          </form>
        </div>
      </section>

      {/* Start Job Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-40" onClick={() => setShowModal(false)}>
          <form
            onSubmit={startJob}
            className="w-full max-w-lg bg-slate-900 border border-white/10 rounded-2xl p-6 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-lg">Start Agent Run</h3>
              <button type="button" onClick={() => setShowModal(false)} className="p-1 rounded-lg hover:bg-white/[0.05] text-slate-400 hover:text-slate-200 transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 font-medium mb-1 block">Agent</label>
                <select className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500/40" value={toolId} onChange={(e) => setToolId(e.target.value)}>
                  <option value="codex">{'\u26a1'} Codex</option>
                  <option value="claude-code">{'\ud83e\udde0'} Claude Code</option>
                  <option value="openclaw">{'\ud83e\udd9e'} OpenClaw</option>
                  <option value="agent-zero">{'\ud83e\udd16'} Agent Zero</option>
                  <option value="gemini">{'\u2728'} Gemini</option>
                  <option value="shell">{'\ud83d\udda5\ufe0f'} Shell</option>
                </select>
              </div>
              {adapterSupportsModel && (
                <div>
                  <label className="text-xs text-slate-400 font-medium mb-1 block">Model (optional)</label>
                  <input
                    className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500/40"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Remembered per adapter"
                  />
                </div>
              )}
              <div>
                <label className="text-xs text-slate-400 font-medium mb-1 block">Command</label>
                <input className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500/40" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Command" />
              </div>
              <div>
                <label className="text-xs text-slate-400 font-medium mb-1 block">Working Directory (optional)</label>
                <input className="w-full bg-slate-950 border border-white/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500/40" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="px-4 py-2 text-sm rounded-xl border border-white/10 hover:bg-white/[0.05] transition-colors" onClick={() => setShowModal(false)}>Cancel</button>
              <button type="submit" disabled={isStartingJob} className={`px-4 py-2 text-sm rounded-xl font-medium transition-colors ${isStartingJob ? 'bg-violet-800 cursor-not-allowed opacity-70' : 'bg-violet-600 hover:bg-violet-500 shadow-md shadow-violet-600/20'}`}>{isStartingJob ? 'Starting\u2026' : 'Start Run'}</button>
            </div>
          </form>
        </div>
      )}

    </div>
  );
}