import path from 'path';
import { spawn, ChildProcess } from 'child_process';

export interface StatusUpdate {
  type: 'status' | 'thinking' | 'tool' | 'tool_end' | 'text' | 'done' | 'error' | 'model_confirmed';
  message: string;
  toolName?: string;
  model?: string;
  timestamp: number;
}

const TOOL_ICONS: Record<string, string> = {
  read: '📖', write: '✍️', edit: '✏️', exec: '🔄',
  web_search: '🔍', web_fetch: '🌐', browser: '🖥️',
  image: '🖼️', tts: '🔊', message: '💬', process: '⚙️',
  canvas: '🎨', nodes: '📱',
};

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: 'Reading files',
  write: 'Writing code',
  edit: 'Editing code',
  exec: 'Executing command',
  web_search: 'Searching the web',
  web_fetch: 'Fetching web content',
  browser: 'Browsing',
  image: 'Analyzing image',
  tts: 'Generating audio',
  message: 'Sending message',
  process: 'Managing process',
  canvas: 'Rendering canvas',
  nodes: 'Accessing nodes',
};

const LOG_PATH = path.join(process.env.OPENCLAW_ROOT || '/root/.openclaw', 'logs/openclaw.log');

/**
 * Tail openclaw.log and emit detailed status updates for a specific session.
 * 
 * Strategy: 
 * 1. Match `lane enqueue` events containing the full session key to detect our session's activity
 * 2. The `embedded run start` event that follows within ~500ms gives us the runId + actual model
 * 3. Track that runId to match `embedded run tool start/end` events
 * 4. Also accept a runId hint from the SSE stream parser (chunk.id matches runId)
 */
export function tailSessionLogs(
  sessionKey: string,
  callback: (update: StatusUpdate) => void,
): (() => void) & { setRunId?: (id: string) => void } {
  // Build the lane key that appears in diagnostic logs
  // sessionKey format: "agent:portal:portal-{userId}-{projectName}"
  const laneKey = `session:${sessionKey}`;
  
  let child: ChildProcess | null = null;
  let stopped = false;
  
  // Track runIds associated with this session
  const activeRunIds = new Set<string>();
  // Timestamp of last lane enqueue for this session - used to correlate with run start
  let lastLaneEnqueueTime = 0;
  // Track active tools for dedup
  let lastToolStatus = '';
  let lastToolTime = 0;

  const cleanup = (() => {
    stopped = true;
    if (child) {
      child.kill('SIGTERM');
      child = null;
    }
  }) as (() => void) & { setRunId?: (id: string) => void };

  // Allow the stream parser to directly tell us the runId
  cleanup.setRunId = (id: string) => {
    if (id) {
      activeRunIds.add(id);
    }
  };

  try {
    child = spawn('tail', ['-f', '-n', '0', LOG_PATH], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let buffer = '';

    child.stdout?.on('data', (data: Buffer) => {
      if (stopped) return;
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const log = JSON.parse(line);
          const msg: string = log['1'] || '';
          const subsystemRaw = log['0'] || '';
          
          let subsystem = '';
          try {
            const parsed = JSON.parse(subsystemRaw);
            subsystem = parsed.subsystem || '';
          } catch {
            subsystem = subsystemRaw;
          }

          // --- diagnostic/lane events: detect our session's activity ---
          if (subsystem === 'diagnostic' && msg.includes(laneKey)) {
            if (msg.includes('lane enqueue')) {
              lastLaneEnqueueTime = Date.now();
            }
          }

          // --- agent/embedded events ---
          if (subsystem === 'agent/embedded') {
            // "embedded run start: runId=xxx sessionId=yyy provider=zzz model=www thinking=... messageChannel=..."
            if (msg.includes('embedded run start:')) {
              const runIdMatch = msg.match(/runId=(\S+)/);
              const modelMatch = msg.match(/model=(\S+)/);
              const providerMatch = msg.match(/provider=(\S+)/);
              
              if (runIdMatch) {
                const runId = runIdMatch[1];
                const now = Date.now();
                
                // Associate this run with our session if:
                // 1. A lane enqueue for our session happened within the last 500ms
                // 2. OR the runId was already set by the stream parser
                if ((now - lastLaneEnqueueTime) < 500 || activeRunIds.has(runId)) {
                  activeRunIds.add(runId);
                  lastLaneEnqueueTime = 0; // consumed
                  
                  const model = modelMatch?.[1] || '';
                  const provider = providerMatch?.[1] || '';
                  const fullModel = provider ? `${provider}/${model}` : model;
                  
                  callback({
                    type: 'model_confirmed',
                    message: `🧠 Thinking (${model})...`,
                    model: fullModel,
                    timestamp: Date.now(),
                  });
                }
              }
            }

            // "embedded run tool start: runId=xxx tool=yyy toolCallId=zzz"
            if (msg.includes('embedded run tool start:')) {
              const runIdMatch = msg.match(/runId=(\S+)/);
              const toolMatch = msg.match(/tool=(\S+)/);
              
              if (runIdMatch && toolMatch) {
                const runId = runIdMatch[1];
                const toolName = toolMatch[1];
                
                if (activeRunIds.has(runId)) {
                  const icon = TOOL_ICONS[toolName] || '🔧';
                  const desc = TOOL_DESCRIPTIONS[toolName] || `Running ${toolName}`;
                  const statusMsg = `${icon} ${desc}`;
                  
                  // Dedup rapid tool events
                  const now = Date.now();
                  if (statusMsg !== lastToolStatus || (now - lastToolTime) > 500) {
                    lastToolStatus = statusMsg;
                    lastToolTime = now;
                    callback({
                      type: 'tool',
                      message: statusMsg,
                      toolName,
                      timestamp: now,
                    });
                  }
                }
              }
            }

            // "embedded run tool end: runId=xxx tool=yyy toolCallId=zzz"
            if (msg.includes('embedded run tool end:')) {
              const runIdMatch = msg.match(/runId=(\S+)/);
              const toolMatch = msg.match(/tool=(\S+)/);
              
              if (runIdMatch && toolMatch) {
                const runId = runIdMatch[1];
                const toolName = toolMatch[1];
                
                if (activeRunIds.has(runId)) {
                  callback({
                    type: 'tool_end',
                    message: `✅ ${TOOL_DESCRIPTIONS[toolName] || toolName} done`,
                    toolName,
                    timestamp: Date.now(),
                  });
                  // After tool end, show thinking again
                  setTimeout(() => {
                    if (!stopped) {
                      callback({
                        type: 'thinking',
                        message: '🧠 Thinking...',
                        timestamp: Date.now(),
                      });
                    }
                  }, 200);
                }
              }
            }
          }
        } catch {
          // Not JSON or parse error, skip
        }
      }
    });

    child.on('error', () => { /* ignore */ });
  } catch {
    // tail command failed, non-fatal
  }

  return cleanup;
}
