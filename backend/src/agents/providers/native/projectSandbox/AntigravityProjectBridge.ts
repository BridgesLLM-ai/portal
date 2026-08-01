/**
 * The Antigravity CLI currently prints only the final prose response. Its
 * native, structured tool lifecycle is written to a per-conversation JSONL
 * transcript. This bridge runs inside the already-confined Project container,
 * tails that transcript, and emits a small provider-neutral JSONL protocol.
 *
 * Keep this source self-contained: it is copied into the runtime's private
 * tmpfs and hash-attested before every invocation.
 */
export function renderAntigravityProjectBridge(overrides: {
  agyPath?: string;
  projectPath?: string;
  brainPath?: string;
  pollIntervalMs?: number;
} = {}): string {
  const absolutePath = (value: string | undefined, fallback: string, label: string) => {
    const normalized = String(value || fallback);
    if (!normalized.startsWith('/') || /[\u0000\r\n]/.test(normalized)) {
      throw new Error(`Antigravity Project bridge ${label} is invalid`);
    }
    return normalized;
  };
  const agyPath = absolutePath(overrides.agyPath, '/usr/local/bin/agy', 'binary path');
  const projectPath = absolutePath(overrides.projectPath, '/workspace/project', 'Project path');
  const brainPath = absolutePath(
    overrides.brainPath,
    '/home/project-agent/.gemini/antigravity-cli/brain',
    'transcript path',
  );
  const pollIntervalMs = overrides.pollIntervalMs ?? 150;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5_000) {
    throw new Error('Antigravity Project bridge poll interval is invalid');
  }
  return String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROTOCOL = 1;
const AGY = ${JSON.stringify(agyPath)};
const PROJECT = ${JSON.stringify(projectPath)};
const BRAIN = ${JSON.stringify(brainPath)};
const POLL_INTERVAL_MS = ${pollIntervalMs};
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emit(type, detail) {
  process.stdout.write(JSON.stringify({ portalNativeEvent: PROTOCOL, type, ...detail }) + '\n');
}

function fail(message) {
  emit('error', { content: String(message || 'Antigravity bridge failed').slice(0, 4096) });
  process.exit(125);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--message-base64', '--model', '--conversation', '--qualification'].includes(key) || value == null) fail('Invalid bridge arguments');
    result[key.slice(2)] = value;
  }
  if (!result['message-base64']) fail('Missing Antigravity prompt');
  return result;
}

function bounded(value, bytes) {
  const text = typeof value === 'string' ? value : JSON.stringify(value == null ? '' : value);
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= bytes) return text;
  const suffix = Buffer.from('\n[truncated]', 'utf8');
  return Buffer.concat([encoded.subarray(0, Math.max(0, bytes - suffix.length)), suffix]).toString('utf8');
}

function boundedObject(value, bytes) {
  const candidate = value && typeof value === 'object' ? value : {};
  const encoded = Buffer.from(JSON.stringify(candidate), 'utf8');
  if (encoded.length <= bytes) return candidate;
  return { truncated: true, preview: bounded(encoded.toString('utf8'), Math.max(256, bytes - 64)) };
}

const options = parseArgs(process.argv.slice(2));
let message = '';
try { message = Buffer.from(options['message-base64'], 'base64url').toString('utf8'); } catch { fail('Invalid Antigravity prompt encoding'); }
if (!message || Buffer.byteLength(message, 'utf8') > 1024 * 1024 || message.includes('\0')) fail('Invalid Antigravity prompt');
const requestedConversation = options.conversation || '';
if (requestedConversation && !UUID.test(requestedConversation)) fail('Invalid Antigravity conversation identity');
const model = String(options.model || '').trim();
if (model && (!/^[a-zA-Z0-9._:/-]{1,128}$/.test(model) || model.includes('..'))) fail('Invalid Antigravity model');
const qualification = String(options.qualification || '') === '1';
if (options.qualification && !qualification) fail('Invalid Antigravity qualification mode');

const startedAt = Date.now();
let activeConversation = requestedConversation || '';
let emittedConversation = false;
const pendingTools = [];
const settledTools = new Set();
const transcriptOffsets = new Map();
const transcriptRemainders = new Map();

function transcriptPath(conversation) {
  if (!UUID.test(conversation)) return '';
  return path.join(BRAIN, conversation, '.system_generated', 'logs', 'transcript.jsonl');
}

function captureTranscriptBaselines() {
  let entries = [];
  try { entries = fs.readdirSync(BRAIN, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const conversation = entry.name.toLowerCase();
    const file = transcriptPath(conversation);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_TRANSCRIPT_BYTES) {
        transcriptOffsets.set(conversation, stat.size);
      }
    } catch {}
  }
}

function chooseConversation() {
  if (activeConversation) return activeConversation;
  let candidates = [];
  try {
    for (const entry of fs.readdirSync(BRAIN, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const file = transcriptPath(entry.name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAt - 5000) continue;
      candidates.push({ id: entry.name.toLowerCase(), mtime: stat.mtimeMs });
    }
  } catch {}
  candidates.sort((left, right) => right.mtime - left.mtime || left.id.localeCompare(right.id));
  if (candidates.length > 0) activeConversation = candidates[0].id;
  return activeConversation;
}

function emitConversation() {
  const conversation = chooseConversation();
  if (conversation && !emittedConversation) {
    emittedConversation = true;
    emit('session', { conversationId: conversation });
  }
}

function toolId(conversation, step, index) {
  return conversation + ':' + String(step) + ':' + String(index);
}

function processRecord(record, raw) {
  if (!record || typeof record !== 'object') return;
  const conversation = chooseConversation();
  if (!conversation) return;
  emitConversation();
  const step = Number.isInteger(record.step_index) ? record.step_index : -1;
  const source = String(record.source || '').toUpperCase();
  const recordType = String(record.type || '').toUpperCase();
  const status = String(record.status || '').toUpperCase();
  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  if (recordType.includes('PLANNER_RESPONSE')) {
    const thinking = typeof record.thinking === 'string' && record.thinking.trim()
      ? record.thinking
      : typeof record.content === 'string' && record.content.trim() && calls.length > 0
        ? record.content
        : '';
    if (thinking) {
      emit('thinking', { content: bounded(thinking, 64 * 1024) });
    }
    calls.slice(0, 64).forEach((call, index) => {
      const id = toolId(conversation, step, index);
      if (pendingTools.some((entry) => entry.id === id) || settledTools.has(id)) return;
      const name = String(call && call.name || 'antigravity_tool').slice(0, 128);
      const args = call && typeof call.args === 'object' && call.args ? call.args : {};
      pendingTools.push({ id, name });
      emit('tool_start', {
        toolCallId: id,
        toolName: name,
        toolArgs: boundedObject(args, 32 * 1024),
        content: String(
          call && (call.toolSummary || call.toolAction)
          || args.toolSummary
          || args.toolAction
          || call && call.name
          || name,
        ).slice(0, 4096),
      });
    });
    return;
  }
  if (
    source.includes('USER_INPUT')
    || source.includes('CONVERSATION_HISTORY')
    || source.includes('CHECKPOINT')
    || recordType.includes('USER_INPUT')
    || recordType.includes('CONVERSATION_HISTORY')
    || recordType.includes('CHECKPOINT')
  ) return;
  const pending = pendingTools[0];
  if (!pending) return;
  const content = bounded(record.content == null ? raw : record.content, 128 * 1024);
  const terminal = ['DONE', 'COMPLETED', 'SUCCESS', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status);
  if (terminal) {
    pendingTools.shift();
    settledTools.add(pending.id);
    emit('tool_end', {
      toolCallId: pending.id,
      toolName: pending.name,
      toolResult: content,
      isError: ['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status),
      content,
    });
  } else {
    emit('tool_update', {
      toolCallId: pending.id,
      toolName: pending.name,
      content,
      status: status || 'RUNNING',
    });
  }
}

function pumpTranscript() {
  const conversation = chooseConversation();
  if (!conversation) return;
  emitConversation();
  const file = transcriptPath(conversation);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) fail('Antigravity transcript exceeded the safety limit');
  const offset = transcriptOffsets.get(conversation) || 0;
  if (stat.size < offset) fail('Antigravity transcript changed identity during the turn');
  if (stat.size === offset) return;
  const nextBytes = stat.size - offset;
  const chunk = Buffer.alloc(nextBytes);
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const bytesRead = fs.readSync(handle, chunk, 0, nextBytes, offset);
    if (bytesRead !== nextBytes) return;
  } catch { return; }
  finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} }
  transcriptOffsets.set(conversation, stat.size);
  const prior = transcriptRemainders.get(conversation) || Buffer.alloc(0);
  const combined = Buffer.concat([prior, chunk]);
  const lastNewline = combined.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    if (combined.length > 1024 * 1024) fail('Antigravity transcript record exceeded the safety limit');
    transcriptRemainders.set(conversation, combined);
    return;
  }
  transcriptRemainders.set(conversation, combined.subarray(lastNewline + 1));
  const content = combined.subarray(0, lastNewline).toString('utf8');
  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    processRecord(record, raw);
  }
}

captureTranscriptBaselines();

const args = ['--print-timeout', '5m', '--sandbox'];
if (!qualification) args.push('--add-dir', PROJECT, '--mode', 'accept-edits');
if (model) args.push('--model', model);
if (requestedConversation) args.push('--conversation', requestedConversation);
args.push('--print', message);
const child = spawn(AGY, args, { cwd: qualification ? '/tmp' : PROJECT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stdoutBytes = 0;
let stderrBytes = 0;
child.stdout.on('data', (chunk) => {
  stdoutBytes += chunk.length;
  if (stdoutBytes > MAX_STDOUT_BYTES) { try { child.kill('SIGKILL'); } catch {}; fail('Antigravity output exceeded the safety limit'); }
  stdout += chunk.toString('utf8');
});
child.stderr.on('data', (chunk) => {
  stderrBytes += chunk.length;
  if (stderrBytes <= MAX_STDERR_BYTES) process.stderr.write(chunk);
});
const timer = setInterval(pumpTranscript, POLL_INTERVAL_MS);
const forward = (signal) => { try { child.kill(signal); } catch {} };
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));
child.once('error', () => { clearInterval(timer); fail('Antigravity CLI failed to start'); });
child.once('close', (code, signal) => {
  clearInterval(timer);
  pumpTranscript();
  for (const pending of pendingTools.splice(0)) {
    if (settledTools.has(pending.id)) continue;
    emit('tool_end', {
      toolCallId: pending.id,
      toolName: pending.name,
      toolResult: 'Antigravity ended before this tool produced a terminal result.',
      isError: true,
      content: 'Antigravity ended before this tool produced a terminal result.',
    });
  }
  const text = stdout.trim();
  if (text) emit('text', { content: bounded(text, MAX_STDOUT_BYTES) });
  emit('result', { exitCode: code == null ? 1 : code, conversationId: activeConversation || null });
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 1 : code);
});
`;
}

export const ANTIGRAVITY_PROJECT_BRIDGE_PROTOCOL_VERSION = 1;
