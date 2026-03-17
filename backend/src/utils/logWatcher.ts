import path from 'path';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { prisma } from '../config/database';

const LOG_FILE = path.join(process.env.OPENCLAW_ROOT || '/root/.openclaw', 'logs/openclaw.log');
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Track recent alerts for dedup
const recentAlerts = new Map<string, number>(); // hash -> timestamp

// Alert classification rules
interface AlertRule {
  pattern: RegExp;
  severity: 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO';
  component: string;
  extractMessage: (logEntry: any, rawText: string) => string;
}

const ALERT_RULES: AlertRule[] = [
  {
    pattern: /Embedded agent failed before reply/i,
    severity: 'CRITICAL',
    component: 'agent',
    extractMessage: (_e, raw) => raw,
  },
  {
    pattern: /Unknown model:/i,
    severity: 'ERROR',
    component: 'model',
    extractMessage: (_e, raw) => raw,
  },
  {
    pattern: /lane task error/i,
    severity: 'ERROR',
    component: 'agent',
    extractMessage: (e, _raw) => {
      const msg = e?.['1'] || '';
      const error = typeof msg === 'object' ? (msg.error || JSON.stringify(msg)) : msg;
      return `Lane task error: ${error}`;
    },
  },
  {
    pattern: /gateway timeout/i,
    severity: 'CRITICAL',
    component: 'gateway',
    extractMessage: (_e, raw) => raw,
  },
  {
    pattern: /announce queue drain failed/i,
    severity: 'ERROR',
    component: 'gateway',
    extractMessage: (_e, raw) => raw,
  },
  {
    pattern: /cron.*(?:fail|error)/i,
    severity: 'ERROR',
    component: 'cron',
    extractMessage: (_e, raw) => raw,
  },
  {
    pattern: /Slow listener detected/i,
    severity: 'WARNING',
    component: 'discord',
    extractMessage: (e) => {
      const data = e?.['1'] || {};
      return `Slow listener: ${data.listener || 'unknown'} took ${data.duration || '?'}`;
    },
  },
  {
    pattern: /database.*(?:connection|error|fail)/i,
    severity: 'CRITICAL',
    component: 'database',
    extractMessage: (_e, raw) => raw,
  },
  {
    pattern: /\[Agent\].*(?:error|fail|timeout)/i,
    severity: 'ERROR',
    component: 'agent_chat',
    extractMessage: (_e, raw) => raw,
  },
  {
    pattern: /SANDBOX VIOLATION/i,
    severity: 'CRITICAL',
    component: 'security',
    extractMessage: (_e, raw) => `🔒 ${raw}`,
  },
  {
    pattern: /API key.*(?:invalid|expired|missing)/i,
    severity: 'CRITICAL',
    component: 'auth',
    extractMessage: (_e, raw) => raw,
  },
  {
    pattern: /rate.?limit/i,
    severity: 'WARNING',
    component: 'api',
    extractMessage: (_e, raw) => raw,
  },
];

// Ignore patterns (tool errors from normal agent operation)
const IGNORE_PATTERNS = [
  /\[tools\] exec failed/i,
  /\[tools\] edit failed/i,
  /\[tools\] read failed/i,
  /\[tools\] message failed/i,
  /\[tools\] write failed/i,
];

function getDedupKey(component: string, message: string): string {
  // Normalize by stripping IDs, timestamps, etc.
  const normalized = message.replace(/[0-9a-f]{8}-[0-9a-f]{4}/gi, 'ID').replace(/\d{13,}/g, 'TS');
  return `${component}:${normalized}`;
}

function isDuplicate(key: string): boolean {
  const now = Date.now();
  const lastSeen = recentAlerts.get(key);
  if (lastSeen && (now - lastSeen) < DEDUP_WINDOW_MS) {
    return true;
  }
  recentAlerts.set(key, now);
  // Cleanup old entries
  for (const [k, t] of recentAlerts) {
    if (now - t > DEDUP_WINDOW_MS) recentAlerts.delete(k);
  }
  return false;
}

// Callbacks for real-time push
type AlertCallback = (alert: {
  action: string;
  resource: string;
  severity: string;
  translatedMessage: string;
  metadata: any;
}) => void;

const listeners: AlertCallback[] = [];

export function onAlert(cb: AlertCallback) {
  listeners.push(cb);
  return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
}

async function processLogLine(line: string) {
  if (!line.trim()) return;

  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return; // Not JSON, skip
  }

  const logLevel = entry._meta?.logLevelName;
  if (!logLevel || (logLevel !== 'ERROR' && logLevel !== 'WARN')) return;

  const rawText = typeof entry['0'] === 'string' ? entry['0'] : JSON.stringify(entry['0'] || '');

  // Check ignore patterns
  for (const pat of IGNORE_PATTERNS) {
    if (pat.test(rawText)) return;
  }

  // Match against rules
  for (const rule of ALERT_RULES) {
    if (rule.pattern.test(rawText)) {
      const message = rule.extractMessage(entry, rawText);
      const dedupKey = getDedupKey(rule.component, message);
      if (isDuplicate(dedupKey)) return;

      const alertData = {
        action: 'SYSTEM_ALERT',
        resource: rule.component,
        severity: rule.severity,
        translatedMessage: message.slice(0, 500),
        metadata: {
          component: rule.component,
          logLevel,
          subsystem: entry._meta?.name || '',
          timestamp: entry.time || entry._meta?.date || new Date().toISOString(),
        },
      };

      // Persist to DB (no userId = system alert)
      try {
        await prisma.activityLog.create({
          data: {
            ...alertData,
            metadata: alertData.metadata as any,
          },
        });
      } catch (err) {
        console.error('Failed to persist alert:', err);
      }

      // Notify listeners
      for (const cb of listeners) {
        try { cb(alertData); } catch {}
      }

      return; // Only match first rule
    }
  }
}

let watcher: ReturnType<typeof spawn> | null = null;

export function startLogWatcher() {
  if (!existsSync(LOG_FILE)) {
    console.log(`⚠️ Log file not found: ${LOG_FILE}, will retry in 30s`);
    setTimeout(startLogWatcher, 30000);
    return;
  }

  console.log(`📋 Starting log watcher on ${LOG_FILE}`);

  // Use tail -F to follow the log file
  watcher = spawn('tail', ['-F', '-n', '0', LOG_FILE], { stdio: ['ignore', 'pipe', 'ignore'] });

  const rl = createInterface({ input: watcher.stdout! });
  rl.on('line', (line) => processLogLine(line).catch(() => {}));

  watcher.on('exit', (code) => {
    console.log(`Log watcher exited (code ${code}), restarting in 5s...`);
    setTimeout(startLogWatcher, 5000);
  });
}

export function stopLogWatcher() {
  if (watcher) {
    watcher.kill();
    watcher = null;
  }
}

// Also export for manual alert ingestion
export async function ingestAlert(
  severity: 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO',
  component: string,
  message: string,
  extra?: Record<string, any>,
) {
  const dedupKey = getDedupKey(component, message);
  if (isDuplicate(dedupKey)) return null;

  const alertData = {
    action: 'SYSTEM_ALERT',
    resource: component,
    severity,
    translatedMessage: message.slice(0, 500),
    metadata: { component, ...extra, timestamp: new Date().toISOString() },
  };

  const record = await prisma.activityLog.create({
    data: { ...alertData, metadata: alertData.metadata as any },
  });

  for (const cb of listeners) {
    try { cb(alertData); } catch {}
  }

  return record;
}
