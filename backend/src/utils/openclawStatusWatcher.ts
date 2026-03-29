import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, watch, FSWatcher } from 'fs';

const LOG_FILE = path.join(process.env.OPENCLAW_ROOT || '/root/.openclaw', 'logs/openclaw.log');

export interface AgentStatus {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'streaming' | 'done' | 'error';
  session: string;      // e.g. "main"
  tool?: string;        // tool name for tool_start/tool_end
  model?: string;       // model name
  text?: string;        // partial text for streaming
  runId?: string;
  timestamp: string;
}

type StatusCallback = (status: AgentStatus) => void;
const listeners: StatusCallback[] = [];

export function onAgentStatus(cb: StatusCallback) {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function emit(status: AgentStatus) {
  for (const cb of listeners) {
    try { cb(status); } catch {}
  }
}

// Track active runs to know which session they belong to
const activeRuns = new Map<string, { session: string; model?: string }>();

function processLine(line: string) {
  if (!line.trim()) return;

  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }

  const field0 = entry['0'] || '';
  const field1 = String(entry['1'] || '');
  const ts = entry.time || new Date().toISOString();

  // Parse subsystem from field0
  let subsystem = '';
  try {
    const parsed = JSON.parse(field0);
    subsystem = parsed.subsystem || '';
  } catch {
    subsystem = field0;
  }

  // --- agent/embedded events ---
  if (subsystem === 'agent/embedded') {
    // "embedded run start: runId=... sessionId=... provider=anthropic model=claude-sonnet-4-5 thinking=low messageChannel=webchat"
    const runStartMatch = field1.match(/embedded run start: runId=(\S+).*model=(\S+).*messageChannel=(\S+)/);
    if (runStartMatch) {
      const [, runId, model, channel] = runStartMatch;
      // We need to figure out session from context - check if it's webchat (portal) channel
      // The session info is in the lane logs. For now track by runId.
      activeRuns.set(runId, { session: 'main', model });
      if (channel === 'webchat') {
        emit({ type: 'thinking', session: 'main', model, runId, timestamp: ts });
      }
      return;
    }

    // "embedded run tool start: runId=... tool=exec toolCallId=..."
    const toolStartMatch = field1.match(/embedded run tool start: runId=(\S+) tool=(\S+)/);
    if (toolStartMatch) {
      const [, runId, tool] = toolStartMatch;
      const run = activeRuns.get(runId);
      if (run) {
        emit({ type: 'tool_start', session: run.session, tool, runId, timestamp: ts });
      }
      return;
    }

    // "embedded run tool end: runId=... tool=exec toolCallId=..."
    const toolEndMatch = field1.match(/embedded run tool end: runId=(\S+) tool=(\S+)/);
    if (toolEndMatch) {
      const [, runId, tool] = toolEndMatch;
      const run = activeRuns.get(runId);
      if (run) {
        emit({ type: 'tool_end', session: run.session, tool, runId, timestamp: ts });
      }
      return;
    }
  }

  // --- gateway/ws events for session=main ---
  if (subsystem === 'gateway/ws') {
    // "→ event agent ... session=main stream=lifecycle ... phase=start"
    const lifecycleMatch = field1.match(/event agent.*session=main stream=lifecycle.*phase=(\w+)/);
    if (lifecycleMatch) {
      const phase = lifecycleMatch[1];
      if (phase === 'start') {
        emit({ type: 'thinking', session: 'main', timestamp: ts });
      } else if (phase === 'end') {
        emit({ type: 'done', session: 'main', timestamp: ts });
      }
      return;
    }

    // "→ event agent ... session=main stream=assistant aseq=N text=..."
    // We don't need to stream full text from logs - the SSE already handles that
    // But we can detect when assistant starts streaming
    const assistantMatch = field1.match(/event agent.*session=main stream=assistant aseq=1 /);
    if (assistantMatch) {
      emit({ type: 'streaming', session: 'main', timestamp: ts });
    }
  }
}

let watcher: ChildProcess | null = null;
let logFileWaiter: FSWatcher | null = null;
let stopRequested = false;
let missingLogAnnounced = false;

function waitForLogFile() {
  if (logFileWaiter || watcher) return;

  let watchDir = path.dirname(LOG_FILE);
  while (!existsSync(watchDir)) {
    const parent = path.dirname(watchDir);
    if (parent === watchDir) return;
    watchDir = parent;
  }

  if (!missingLogAnnounced) {
    console.log(`ℹ️ OpenClaw status watcher is waiting for ${LOG_FILE} to appear.`);
    missingLogAnnounced = true;
  }

  logFileWaiter = watch(watchDir, () => {
    if (!existsSync(LOG_FILE)) return;
    try { logFileWaiter?.close(); } catch {}
    logFileWaiter = null;
    missingLogAnnounced = false;
    if (!stopRequested) startStatusWatcher();
  });
}

export function startStatusWatcher() {
  stopRequested = false;
  if (!existsSync(LOG_FILE)) {
    waitForLogFile();
    return;
  }

  if (logFileWaiter) {
    try { logFileWaiter.close(); } catch {}
    logFileWaiter = null;
  }
  if (watcher) return;

  console.log(`📊 Starting OpenClaw status watcher on ${LOG_FILE}`);
  watcher = spawn('tail', ['-F', '-n', '0', LOG_FILE], { stdio: ['ignore', 'pipe', 'ignore'] });

  const rl = createInterface({ input: watcher.stdout! });
  rl.on('line', processLine);

  watcher.on('exit', (code) => {
    watcher = null;
    if (stopRequested) return;
    console.log(`Status watcher exited (code ${code}), restarting in 5s...`);
    setTimeout(() => {
      if (!stopRequested) startStatusWatcher();
    }, 5000);
  });
}

export function stopStatusWatcher() {
  stopRequested = true;
  if (logFileWaiter) {
    try { logFileWaiter.close(); } catch {}
    logFileWaiter = null;
  }
  if (watcher) {
    watcher.kill();
    watcher = null;
  }
}
