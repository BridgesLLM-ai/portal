import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type {
  AgentExecutionContext,
  AgentMessage,
  AgentProviderName,
  AgentSessionConfig,
  AgentSessionId,
  AgentSessionSummary,
} from '../AgentProvider.interface';
import {
  assertExecutionContextBinding,
  executionContextsMatch,
} from '../executionScope';

export interface NativeSessionData {
  sessionId: AgentSessionId;
  provider: AgentProviderName;
  userId: string;
  createdAt: string;
  lastActivityAt: string;
  cwd: string;
  model?: string;
  messages: AgentMessage[];
  /** Missing only on sessions created before Portal 4.0; bind once on reuse. */
  executionContext?: AgentExecutionContext;
  metadata?: Record<string, unknown>;
  /** Durable transcript statistics. The messages array is only a bounded
   * runtime-context tail once the append-only history sidecar exists. */
  historyMessageCount?: number;
  /** Exact committed sidecar size. A mismatch means an append/reset reached
   * the transcript but metadata persistence was interrupted and must recover. */
  historyByteLength?: number;
  historyFirstUserMessage?: string;
  historyLastUserMessage?: string;
  historyLastAssistantMessage?: string;
}

export interface NativeProjectSessionQuery {
  projectIdentityId: string;
  canonicalRoot: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
}

const BASE_DIR = process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR
  ? path.resolve(process.env.PORTAL_NATIVE_AGENT_SESSIONS_DIR)
  : path.join(process.env.HOME || '/root', '.openclaw', 'portal-native-agent-sessions');

const NATIVE_CONTEXT_MESSAGE_LIMIT = 200;
const HISTORY_READ_CHUNK_BYTES = 64 * 1024;
const MAX_HISTORY_LINE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_PAGE_READ_BYTES = 32 * 1024 * 1024;
const HISTORY_MESSAGE_BATCH_TYPE = 'native-session-message-batch-v1';
const MAX_HISTORY_BATCH_MESSAGES = 2;
let atomicWriteCounter = 0;
const NATIVE_SESSION_PROVIDER_NAMES = new Set<AgentProviderName>([
  'CLAUDE_CODE',
  'CODEX',
  'GROK',
  'AGENT_ZERO',
  'GEMINI',
  'OLLAMA',
]);

export interface NativeSessionHistoryPage {
  /**
   * At most the requested limit, except that an atomic user/assistant turn is
   * never split: a limit of one may therefore return the intact two messages.
   */
  messages: AgentMessage[];
  hasMore: boolean;
  beforeOffset: number | null;
  fileIdentity: string;
}

function providerDir(provider: AgentProviderName): string {
  const normalized = String(provider || '').trim().toUpperCase() as AgentProviderName;
  if (!NATIVE_SESSION_PROVIDER_NAMES.has(normalized)) {
    throw new Error('Native agent provider identity is invalid');
  }
  const directory = path.resolve(BASE_DIR, normalized.toLowerCase());
  if (path.dirname(directory) !== path.resolve(BASE_DIR)) {
    throw new Error('Native agent provider path is invalid');
  }
  return directory;
}

function safeSessionId(sessionId: string): string {
  const normalized = String(sessionId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized)) {
    throw new Error('Native agent session identity is invalid');
  }
  return normalized;
}

function sessionPath(provider: AgentProviderName, sessionId: string): string {
  return path.join(providerDir(provider), `${safeSessionId(sessionId)}.json`);
}

function sessionHistoryPath(provider: AgentProviderName, sessionId: string): string {
  return path.join(providerDir(provider), `${safeSessionId(sessionId)}.history.jsonl`);
}

function ensureProviderDir(provider: AgentProviderName): void {
  const directory = providerDir(provider);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function fsyncDirectory(directory: string): void {
  const directoryFd = openSync(directory, 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function fsyncProviderDir(provider: AgentProviderName): void {
  fsyncDirectory(providerDir(provider));
}

function fsyncFile(filePath: string): void {
  const fileFd = openSync(filePath, 'r');
  try {
    fsyncSync(fileFd);
  } finally {
    closeSync(fileFd);
  }
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

type NativeSessionTemporaryArtifactKind = 'metadata' | 'history';

interface NativeSessionTemporaryArtifact {
  filePath: string;
  name: string;
  sessionId: string;
  kind: NativeSessionTemporaryArtifactKind;
}

const ATOMIC_TEMP_SUFFIX_RE = /^\d+-\d+-\d+$/;

function parseNativeSessionTemporaryArtifactName(
  name: string,
): Omit<NativeSessionTemporaryArtifact, 'filePath' | 'name'> | null {
  const historyMatch = name.match(/^(.+)\.history\.jsonl\.tmp-(\d+-\d+-\d+)$/);
  const metadataMatch = historyMatch ? null : name.match(/^(.+)\.json\.tmp-(\d+-\d+-\d+)$/);
  const match = historyMatch || metadataMatch;
  if (!match || !ATOMIC_TEMP_SUFFIX_RE.test(match[2])) return null;
  const sessionId = match[1];
  if (safeSessionId(sessionId) !== sessionId) return null;
  return { sessionId, kind: historyMatch ? 'history' : 'metadata' };
}

function assertSafeNativeSessionTemporaryArtifact(filePath: string): void {
  const stat = lstatSync(filePath);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.uid !== expectedUid
    || (stat.mode & 0o077) !== 0
  ) {
    throw new Error('Native agent session storage contains an unsafe atomic-write artifact');
  }
}

function listNativeSessionTemporaryArtifacts(
  provider: AgentProviderName,
  sessionId?: string,
): NativeSessionTemporaryArtifact[] {
  const directory = providerDir(provider);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const expectedSessionId = sessionId === undefined ? null : safeSessionId(sessionId);
  const artifacts: NativeSessionTemporaryArtifact[] = [];
  for (const name of names) {
    const parsed = parseNativeSessionTemporaryArtifactName(name);
    if (!parsed) {
      if (name.includes('.tmp-')) {
        throw new Error('Native agent session storage contains a malformed atomic-write artifact');
      }
      continue;
    }
    if (expectedSessionId !== null && parsed.sessionId !== expectedSessionId) continue;
    const filePath = path.join(directory, name);
    assertSafeNativeSessionTemporaryArtifact(filePath);
    artifacts.push({ filePath, name, ...parsed });
  }
  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

function boundedSummary(value: unknown, max = 512): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function updateHistorySummary(data: NativeSessionData, message: AgentMessage): void {
  if (message.role === 'user') {
    const summary = boundedSummary(message.content);
    if (summary && !data.historyFirstUserMessage) data.historyFirstUserMessage = summary;
    if (summary) data.historyLastUserMessage = summary;
  } else if (message.role === 'assistant') {
    const summary = boundedSummary(message.content);
    if (summary) data.historyLastAssistantMessage = summary;
  }
}

function initializeHistorySummary(data: NativeSessionData, messages: AgentMessage[]): void {
  data.historyFirstUserMessage = undefined;
  data.historyLastUserMessage = undefined;
  data.historyLastAssistantMessage = undefined;
  data.historyMessageCount = messages.length;
  for (const message of messages) updateHistorySummary(data, message);
}

function encodeHistoryLine(message: AgentMessage): string {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_HISTORY_LINE_BYTES) {
    throw new Error('Native agent history message exceeds the durable transcript safety limit');
  }
  return line;
}

function encodeHistoryRecord(messages: readonly AgentMessage[]): string {
  if (
    messages.length < 1
    || messages.length > MAX_HISTORY_BATCH_MESSAGES
  ) {
    throw new Error('Native agent history batch size is invalid');
  }
  if (messages.length === 1) return encodeHistoryLine(messages[0]);
  const line = `${JSON.stringify({
    type: HISTORY_MESSAGE_BATCH_TYPE,
    messages,
  })}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_HISTORY_LINE_BYTES) {
    throw new Error('Native agent history batch exceeds the durable transcript safety limit');
  }
  return line;
}

function atomicWrite(filePath: string, content: string): void {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${++atomicWriteCounter}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsyncFile(temporary);
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
    fsyncFile(filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
      fsyncDirectory(path.dirname(temporary));
    }
  }
}

function assertHistoryFile(filePath: string): void {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Native agent history storage is unsafe');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Native agent history storage permissions are unsafe');
  }
}

function historyFileIdentity(stat: ReturnType<typeof fstatSync>): string {
  return createHash('sha256')
    .update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, 'utf8')
    .digest('base64url');
}

function readHistoryLinesBeforeOffset(
  filePath: string,
  limit: number,
  requestedEndOffset?: number,
  expectedFileIdentity?: string,
): { lines: string[]; hasMore: boolean; beforeOffset: number | null; fileIdentity: string } {
  if (!existsSync(filePath) || limit <= 0) {
    return { lines: [], hasMore: false, beforeOffset: null, fileIdentity: '' };
  }
  assertHistoryFile(filePath);
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    const fileIdentity = historyFileIdentity(stat);
    if (expectedFileIdentity && expectedFileIdentity !== fileIdentity) {
      throw new Error('Native agent history cursor no longer matches this transcript');
    }
    if (size === 0) {
      return { lines: [], hasMore: false, beforeOffset: null, fileIdentity };
    }
    const endOffset = requestedEndOffset === undefined ? size : requestedEndOffset;
    if (!Number.isSafeInteger(endOffset) || endOffset < 0 || endOffset > size) {
      throw new Error('Native agent history cursor offset is invalid');
    }
    if (endOffset === 0) {
      return { lines: [], hasMore: false, beforeOffset: null, fileIdentity };
    }
    if (endOffset < size) {
      const preceding = Buffer.allocUnsafe(1);
      if (readSync(fd, preceding, 0, 1, endOffset - 1) !== 1 || preceding[0] !== 0x0a) {
        throw new Error('Native agent history cursor is not on a record boundary');
      }
    }

    let position = endOffset;
    let newlineCount = 0;
    let bytesCollected = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlineCount <= limit && bytesCollected < MAX_HISTORY_PAGE_READ_BYTES) {
      const length = Math.min(
        HISTORY_READ_CHUNK_BYTES,
        position,
        MAX_HISTORY_PAGE_READ_BYTES - bytesCollected,
      );
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      const slice = bytesRead === length ? chunk : chunk.subarray(0, bytesRead);
      chunks.unshift(slice);
      bytesCollected += slice.length;
      for (let index = 0; index < slice.length; index += 1) {
        if (slice[index] === 0x0a) newlineCount += 1;
      }
    }

    let raw = Buffer.concat(chunks);
    let baseOffset = position;
    if (position > 0) {
      const firstNewline = raw.indexOf(0x0a);
      if (firstNewline < 0) {
        throw new Error('Native agent history contains an oversized record');
      }
      raw = raw.subarray(firstNewline + 1);
      baseOffset += firstNewline + 1;
    }

    const records: Array<{ start: number; end: number }> = [];
    let recordStart = 0;
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] !== 0x0a) continue;
      if (index > recordStart) records.push({ start: recordStart, end: index });
      recordStart = index + 1;
    }
    // A sidecar append is newline-terminated. Ignore a crash-truncated final
    // fragment instead of treating it as a durable message.
    const selected = records.slice(-limit);
    if (selected.length === 0) {
      throw new Error('Native agent history contains no complete bounded record');
    }
    const lines = selected.map(({ start, end }) => raw.subarray(start, end).toString('utf8'));
    const pageStartOffset = selected.length > 0
      ? baseOffset + selected[0].start
      : endOffset;
    const hasMore = pageStartOffset > 0;
    return {
      lines,
      hasMore,
      beforeOffset: hasMore ? pageStartOffset : null,
      fileIdentity,
    };
  } finally {
    closeSync(fd);
  }
}

function readLastHistoryLines(filePath: string, limit: number): { lines: string[]; hasMore: boolean } {
  if (!existsSync(filePath) || limit <= 0) return { lines: [], hasMore: false };
  const page = readHistoryLinesBeforeOffset(filePath, limit);
  return { lines: page.lines, hasMore: page.hasMore };
}

function parsedHistoryMessages(value: unknown): AgentMessage[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native agent history contains an invalid record');
  }
  const record = value as Record<string, unknown>;
  const candidates = record.type === HISTORY_MESSAGE_BATCH_TYPE
    ? record.messages
    : [record];
  if (
    !Array.isArray(candidates)
    || candidates.length < 1
    || candidates.length > MAX_HISTORY_BATCH_MESSAGES
  ) {
    throw new Error('Native agent history contains an invalid record');
  }
  return candidates.map((candidate) => {
    if (
      !candidate
      || typeof candidate !== 'object'
      || Array.isArray(candidate)
      || typeof (candidate as Record<string, unknown>).id !== 'string'
      || typeof (candidate as Record<string, unknown>).role !== 'string'
    ) {
      throw new Error('Native agent history contains an invalid record');
    }
    return candidate as AgentMessage;
  });
}

function parseHistoryLines(lines: string[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > MAX_HISTORY_LINE_BYTES) {
      throw new Error('Native agent history contains an oversized record');
    }
    messages.push(...parsedHistoryMessages(JSON.parse(line) as unknown));
  }
  return messages;
}

function selectNewestWholeHistoryRecords(
  lines: string[],
  limit: number,
): {
  messages: AgentMessage[];
  selectedRecordCount: number;
  omittedRecordCount: number;
} {
  const parsedByRecord = lines.map((line) => parseHistoryLines([line]));
  const selectedRecords: AgentMessage[][] = [];
  let selectedMessageCount = 0;
  for (let index = parsedByRecord.length - 1; index >= 0; index -= 1) {
    const recordMessages = parsedByRecord[index];
    if (selectedMessageCount + recordMessages.length > limit) break;
    selectedRecords.unshift(recordMessages);
    selectedMessageCount += recordMessages.length;
  }
  // A requested one-message page cannot represent both halves of an atomic
  // turn. Return the intact newest turn (at most one message over the limit)
  // rather than advancing the cursor past and permanently hiding its user half.
  if (selectedRecords.length === 0 && parsedByRecord.length > 0) {
    selectedRecords.push(parsedByRecord[parsedByRecord.length - 1]);
  }
  return {
    messages: selectedRecords.flat(),
    selectedRecordCount: selectedRecords.length,
    omittedRecordCount: parsedByRecord.length - selectedRecords.length,
  };
}

function ensureHistorySidecar(data: NativeSessionData): string {
  ensureProviderDir(data.provider);
  const filePath = sessionHistoryPath(data.provider, data.sessionId);
  if (existsSync(filePath)) {
    assertHistoryFile(filePath);
    return filePath;
  }
  const messages = Array.isArray(data.messages) ? data.messages : [];
  initializeHistorySummary(data, messages);
  atomicWrite(filePath, messages.map(encodeHistoryLine).join(''));
  assertHistoryFile(filePath);
  data.historyByteLength = statSync(filePath).size;
  return filePath;
}

function reconcileHistoryMetadata(data: NativeSessionData, historyFile: string): void {
  assertHistoryFile(historyFile);
  initializeHistorySummary(data, []);
  const fd = openSync(historyFile, 'r+');
  try {
    const stat = fstatSync(fd);
    const chunk = Buffer.allocUnsafe(HISTORY_READ_CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let position = 0;
    while (position < stat.size) {
      const bytesRead = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const combined = pending.length > 0
        ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        if (index > lineStart) {
          const line = combined.subarray(lineStart, index);
          if (line.length > MAX_HISTORY_LINE_BYTES) {
            throw new Error('Native agent history contains an oversized record');
          }
          const messages = parseHistoryLines([line.toString('utf8')]);
          data.historyMessageCount =
            Number(data.historyMessageCount || 0) + messages.length;
          for (const message of messages) updateHistorySummary(data, message);
        }
        lineStart = index + 1;
      }
      pending = Buffer.from(combined.subarray(lineStart));
      if (pending.length > MAX_HISTORY_LINE_BYTES) {
        throw new Error('Native agent history contains an oversized record');
      }
    }
    // A power loss can leave a final non-newline fragment. It was never a
    // complete durable message; truncate it before a later append could fuse a
    // valid JSON record onto the fragment and hide both forever.
    const committedSize = stat.size - pending.length;
    if (pending.length > 0) {
      ftruncateSync(fd, committedSize);
      fsyncSync(fd);
    }
    data.historyByteLength = committedSize;
  } finally {
    closeSync(fd);
  }
}

export function readNativeSessionHistoryPage(
  provider: AgentProviderName,
  sessionId: string,
  limit: number,
  beforeOffset?: number,
  expectedFileIdentity?: string,
): NativeSessionHistoryPage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Native agent history page limit is invalid');
  }

  let historyFile = sessionHistoryPath(provider, sessionId);
  if (!existsSync(historyFile)) {
    const legacy = loadNativeSession(provider, sessionId);
    if (!legacy) {
      return { messages: [], hasMore: false, beforeOffset: null, fileIdentity: '' };
    }
    historyFile = ensureHistorySidecar(legacy);
    saveNativeSession(legacy);
  }

  const page = readHistoryLinesBeforeOffset(
    historyFile,
    limit,
    beforeOffset,
    expectedFileIdentity,
  );
  const selected = selectNewestWholeHistoryRecords(page.lines, limit);
  const endOffset = beforeOffset ?? statSync(historyFile).size;
  const selectedLines = page.lines.slice(-selected.selectedRecordCount);
  const selectedBytes = selectedLines.reduce(
    (total, line) => total + Buffer.byteLength(line, 'utf8') + 1,
    0,
  );
  const boundedBeforeOffset = Math.max(0, endOffset - selectedBytes);
  return {
    messages: selected.messages,
    hasMore: boundedBeforeOffset > 0,
    beforeOffset: boundedBeforeOffset > 0 ? boundedBeforeOffset : null,
    fileIdentity: page.fileIdentity,
  };
}

export function readNativeSessionHistoryTail(
  provider: AgentProviderName,
  sessionId: string,
  limit: number,
): { messages: AgentMessage[]; hasMore: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000) {
    throw new Error('Native agent history limit is invalid');
  }
  const historyFile = sessionHistoryPath(provider, sessionId);
  if (existsSync(historyFile)) {
    assertHistoryFile(historyFile);
    const page = readLastHistoryLines(historyFile, limit);
    const selected = selectNewestWholeHistoryRecords(page.lines, limit);
    return {
      messages: selected.messages,
      hasMore: page.hasMore || selected.omittedRecordCount > 0,
    };
  }
  const legacyFile = sessionPath(provider, sessionId);
  if (!existsSync(legacyFile)) return { messages: [], hasMore: false };
  const legacy = JSON.parse(readFileSync(legacyFile, 'utf8')) as NativeSessionData;
  const messages = Array.isArray(legacy.messages) ? legacy.messages : [];
  ensureHistorySidecar(legacy);
  saveNativeSession(legacy);
  return {
    messages: messages.slice(-limit),
    hasMore: messages.length > limit,
  };
}

export function readAllNativeSessionHistory(
  provider: AgentProviderName,
  sessionId: string,
): AgentMessage[] {
  const historyFile = sessionHistoryPath(provider, sessionId);
  if (!existsSync(historyFile)) {
    const legacy = loadNativeSession(provider, sessionId);
    if (!legacy) return [];
    ensureHistorySidecar(legacy);
    saveNativeSession(legacy);
  }
  const file = sessionHistoryPath(provider, sessionId);
  if (!existsSync(file) || statSync(file).size === 0) return [];
  assertHistoryFile(file);
  return parseHistoryLines(readFileSync(file, 'utf8').split('\n').filter(Boolean));
}

export function createNativeSession(provider: AgentProviderName, userId: string, config: AgentSessionConfig): NativeSessionData {
  assertExecutionContextBinding(config.executionContext, userId);
  ensureProviderDir(provider);
  const now = new Date().toISOString();
  const sessionId = `${provider.toLowerCase()}-${userId}-${Date.now()}`;
  const data: NativeSessionData = {
    sessionId,
    provider,
    userId,
    createdAt: now,
    lastActivityAt: now,
    cwd: String(
      config?.metadata?.cwd
      || process.env.OPENCLAW_WORKSPACE
      || path.join(process.env.HOME || '/root', '.openclaw', 'workspace-main'),
    ),
    model: typeof config?.model === 'string'
      ? config.model
      : typeof config?.metadata?.model === 'string'
        ? String(config?.metadata?.model)
        : undefined,
    executionContext: config.executionContext,
    metadata: config?.metadata,
    messages: [],
    historyMessageCount: 0,
  };
  saveNativeSession(data);
  return data;
}

export function loadNativeSessionMetadata(provider: AgentProviderName, sessionId: string): NativeSessionData | null {
  const file = sessionPath(provider, sessionId);
  if (!existsSync(file)) return null;
  try {
    const session = JSON.parse(readFileSync(file, 'utf8')) as NativeSessionData;
    const embeddedMessages = Array.isArray(session.messages) ? session.messages : [];
    const historyFile = sessionHistoryPath(provider, sessionId);
    if (!existsSync(historyFile) && embeddedMessages.length > 0) {
      initializeHistorySummary(session, embeddedMessages);
      ensureHistorySidecar(session);
      saveNativeSession(session);
    }
    if (existsSync(historyFile)) {
      const historySize = statSync(historyFile).size;
      if (!Number.isSafeInteger(session.historyByteLength) || session.historyByteLength !== historySize) {
        reconcileHistoryMetadata(session, historyFile);
        saveNativeSession(session);
      }
    }
    session.messages = [];
    if (session.executionContext) {
      assertExecutionContextBinding(session.executionContext, session.userId);
      session.executionContext = Object.freeze({ ...session.executionContext }) as AgentExecutionContext;
    }
    return session;
  } catch {
    return null;
  }
}

export function loadNativeSession(provider: AgentProviderName, sessionId: string): NativeSessionData | null {
  const session = loadNativeSessionMetadata(provider, sessionId);
  if (!session) return null;
  const historyFile = sessionHistoryPath(provider, sessionId);
  if (existsSync(historyFile)) {
    const page = readLastHistoryLines(
      historyFile,
      NATIVE_CONTEXT_MESSAGE_LIMIT,
    );
    session.messages = selectNewestWholeHistoryRecords(
      page.lines,
      NATIVE_CONTEXT_MESSAGE_LIMIT,
    ).messages;
  }
  return session;
}

export function saveNativeSession(data: NativeSessionData): void {
  if (data.executionContext) assertExecutionContextBinding(data.executionContext, data.userId);
  ensureProviderDir(data.provider);
  ensureHistorySidecar(data);
  const persisted: NativeSessionData = {
    ...data,
    // The canonical transcript is append-only. Keeping this array empty makes
    // metadata reads and rewrites independent of a multi-day transcript size.
    messages: [],
  };
  atomicWrite(sessionPath(data.provider, data.sessionId), `${JSON.stringify(persisted, null, 2)}\n`);
}

/**
 * One-way migration for pre-4.0 native sessions. Once bound, neither scope nor
 * principal/project identity can be changed.
 */
export function ensureNativeSessionExecutionContext(
  provider: AgentProviderName,
  sessionId: string,
  executionContext: AgentExecutionContext,
): NativeSessionData | null {
  const session = loadNativeSession(provider, sessionId);
  if (!session) return null;
  assertExecutionContextBinding(executionContext, session.userId);
  if (session.executionContext) {
    if (!executionContextsMatch(session.executionContext, executionContext)) {
      throw new Error('Agent session execution context is immutable');
    }
    return session;
  }
  session.executionContext = executionContext;
  session.lastActivityAt = new Date().toISOString();
  saveNativeSession(session);
  return session;
}

export function updateNativeSessionModel(
  provider: AgentProviderName,
  sessionId: string,
  model: string | null,
): NativeSessionData | null {
  const session = loadNativeSession(provider, sessionId);
  if (!session) return null;
  if (model) session.model = model;
  else delete session.model;
  session.lastActivityAt = new Date().toISOString();
  saveNativeSession(session);
  return session;
}

export function updateNativeSessionMetadata(
  provider: AgentProviderName,
  sessionId: string,
  metadata: Record<string, unknown>,
): NativeSessionData | null {
  const session = loadNativeSession(provider, sessionId);
  if (!session) return null;
  session.metadata = {
    ...(session.metadata || {}),
    ...metadata,
  };
  session.lastActivityAt = new Date().toISOString();
  saveNativeSession(session);
  return session;
}

export function rekeyNativeSession(
  provider: AgentProviderName,
  fromSessionId: string,
  toSessionId: string,
): NativeSessionData | null {
  const session = loadNativeSession(provider, fromSessionId);
  if (!session) return null;
  if (fromSessionId === toSessionId) return session;
  safeSessionId(toSessionId);
  // There are no production callers for native-session rekeying. Retaining a
  // two-file rename API creates an unavoidable crash window in which metadata
  // and transcript identify different sessions. Callers must create the final
  // deterministic identity before dispatch instead.
  throw new Error('Native agent session rekeying is retired because it is not crash-safe');
}

export interface NativeSessionBatchAppendDependencies {
  appendHistory?: (filePath: string, record: string) => void;
  fsyncHistory?: (filePath: string) => void;
}

function defaultAppendHistory(filePath: string, record: string): void {
  appendFileSync(filePath, record, { encoding: 'utf8', mode: 0o600 });
}

function truncateUncommittedHistory(filePath: string, committedSize: number): void {
  const fd = openSync(filePath, 'r+');
  try {
    ftruncateSync(fd, committedSize);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends one logical transcript transaction. Multi-message turns are encoded
 * as one newline-committed envelope, so a crash or partial write can expose
 * either the whole turn or no turn, never only its user half.
 */
export function appendNativeMessages(
  data: NativeSessionData,
  messages: readonly AgentMessage[],
  dependencies: NativeSessionBatchAppendDependencies = {},
): NativeSessionData {
  const historyFile = ensureHistorySidecar(data);
  const committedSize = statSync(historyFile).size;
  const record = encodeHistoryRecord(messages);
  try {
    (dependencies.appendHistory ?? defaultAppendHistory)(historyFile, record);
    chmodSync(historyFile, 0o600);
    // A completed newline record must reach stable storage before metadata can
    // publish its byte length/count and before a durable Project handoff can
    // advance beyond this provider turn.
    (dependencies.fsyncHistory ?? fsyncFile)(historyFile);
  } catch (error) {
    // Restore the prior committed boundary when an ordinary write/fsync error
    // is observable. After an actual process/power loss, metadata reconciliation
    // applies the same rule to a non-newline fragment.
    try {
      truncateUncommittedHistory(historyFile, committedSize);
    } catch {
      // Preserve the original storage error. Startup reconciliation will still
      // reject or repair the exact sidecar before it is reused.
    }
    throw error;
  }
  data.messages.push(...messages);
  if (data.messages.length > NATIVE_CONTEXT_MESSAGE_LIMIT) {
    data.messages.splice(0, data.messages.length - NATIVE_CONTEXT_MESSAGE_LIMIT);
  }
  data.historyMessageCount =
    Math.max(0, Number(data.historyMessageCount || 0)) + messages.length;
  data.historyByteLength = statSync(historyFile).size;
  for (const message of messages) updateHistorySummary(data, message);
  data.lastActivityAt = new Date().toISOString();
  saveNativeSession(data);
  return data;
}

export function appendNativeMessage(
  data: NativeSessionData,
  message: AgentMessage,
): NativeSessionData {
  return appendNativeMessages(data, [message]);
}

export function clearNativeSessionHistory(data: NativeSessionData): NativeSessionData {
  ensureProviderDir(data.provider);
  atomicWrite(sessionHistoryPath(data.provider, data.sessionId), '');
  data.messages = [];
  data.historyMessageCount = 0;
  data.historyByteLength = 0;
  data.historyFirstUserMessage = undefined;
  data.historyLastUserMessage = undefined;
  data.historyLastAssistantMessage = undefined;
  data.lastActivityAt = new Date().toISOString();
  saveNativeSession(data);
  return data;
}

export function nativeSessionMessageCount(data: NativeSessionData): number {
  const persisted = Number(data.historyMessageCount);
  return Number.isSafeInteger(persisted) && persisted >= 0 ? persisted : data.messages.length;
}

function summarizeText(text: string, max = 96): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function deriveNativeSessionTitle(data: NativeSessionData): string {
  const explicitTitle = typeof data.metadata?.title === 'string' ? summarizeText(String(data.metadata.title), 72) : '';
  if (explicitTitle) return explicitTitle;

  const firstUserMessage = data.historyFirstUserMessage
    || data.messages.find((msg) => msg.role === 'user' && msg.content.trim())?.content;
  if (firstUserMessage) return summarizeText(firstUserMessage, 72);

  const cwdBase = path.basename(data.cwd || '').trim();
  if (cwdBase && cwdBase !== '/' && cwdBase !== '.') return cwdBase;

  return `${providerLabel(data.provider)} session`;
}

function deriveNativeSessionPreview(data: NativeSessionData): string {
  const lastAssistant = data.historyLastAssistantMessage
    || [...data.messages].reverse().find((msg) => msg.role === 'assistant' && msg.content.trim())?.content;
  if (lastAssistant) return summarizeText(lastAssistant, 120);

  const lastUser = data.historyLastUserMessage
    || [...data.messages].reverse().find((msg) => msg.role === 'user' && msg.content.trim())?.content;
  if (lastUser) return summarizeText(lastUser, 120);

  return '';
}

function providerLabel(provider: AgentProviderName): string {
  switch (provider) {
    case 'CLAUDE_CODE': return 'Claude';
    case 'CODEX': return 'Codex';
    case 'GROK': return 'Grok Build';
    case 'AGENT_ZERO': return 'Agent Zero';
    case 'GEMINI': return 'Antigravity';
    case 'OLLAMA': return 'Ollama';
    default: return 'Agent';
  }
}

export function listNativeSessions(provider: AgentProviderName, userId: string): AgentSessionSummary[] {
  ensureProviderDir(provider);
  return readdirSync(providerDir(provider))
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadNativeSession(provider, name.replace(/\.json$/, '')))
    .filter((data): data is NativeSessionData => Boolean(data && data.userId === userId))
    .map((data) => ({
      sessionId: data.sessionId,
      status: 'active' as const,
      createdAt: data.createdAt,
      lastActivityAt: data.lastActivityAt,
      title: deriveNativeSessionTitle(data),
      preview: deriveNativeSessionPreview(data),
      metadata: {
        provider,
        model: data.model || null,
        cwd: data.cwd,
        executionScope: data.executionContext?.scope || null,
      },
    }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

/**
 * Strict immutable-context scanner used by Project deletion. Unlike the UI
 * summary API, this reads every provider-owned record and rejects malformed,
 * symlinked, or identity-drifted state. A session whose UUID matches the
 * project but whose root identity differs is an integrity failure, never a
 * candidate for best-effort deletion.
 */
export function listNativeProjectSessions(
  provider: AgentProviderName,
  query: NativeProjectSessionQuery,
): NativeSessionData[] {
  ensureProviderDir(provider);
  const directory = providerDir(provider);
  const expectedRoot = path.resolve(query.canonicalRoot);
  const matches: NativeSessionData[] = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  const entryNames = new Set(entries.map((entry) => entry.name));
  const temporaryArtifacts = listNativeSessionTemporaryArtifacts(provider);
  const temporaryBySession = new Map<string, NativeSessionTemporaryArtifact[]>();
  for (const artifact of temporaryArtifacts) {
    const existing = temporaryBySession.get(artifact.sessionId) || [];
    existing.push(artifact);
    temporaryBySession.set(artifact.sessionId, existing);
  }
  for (const entry of entries) {
    if (!entry.name.endsWith('.history.jsonl')) continue;
    const historyFile = path.join(directory, entry.name);
    const stat = lstatSync(historyFile);
    if (!entry.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Native ${provider} session storage contains an unsafe transcript entry`);
    }
    const sessionId = entry.name.slice(0, -'.history.jsonl'.length);
    const hasTemporaryMetadata = (temporaryBySession.get(sessionId) || [])
      .some((artifact) => artifact.kind === 'metadata');
    if (!sessionId || (!entryNames.has(`${sessionId}.json`) && !hasTemporaryMetadata)) {
      throw new Error(`Native ${provider} session storage contains an orphan transcript sidecar`);
    }
  }
  for (const [sessionId, artifacts] of temporaryBySession) {
    const historyArtifacts = artifacts.filter((artifact) => artifact.kind === 'history');
    const hasMetadata = entryNames.has(`${sessionId}.json`)
      || artifacts.some((artifact) => artifact.kind === 'metadata');
    if (!hasMetadata && historyArtifacts.some((artifact) => statSync(artifact.filePath).size > 0)) {
      throw new Error(`Native ${provider} session storage contains an orphan atomic transcript`);
    }
  }

  const sessionIds = new Set<string>();
  for (const entry of entries) {
    if (entry.name.endsWith('.json')) sessionIds.add(entry.name.slice(0, -'.json'.length));
  }
  for (const artifact of temporaryArtifacts) {
    if (artifact.kind === 'metadata') sessionIds.add(artifact.sessionId);
  }

  for (const sessionId of Array.from(sessionIds).sort()) {
    const metadataFiles: string[] = [];
    const canonicalName = `${sessionId}.json`;
    if (entryNames.has(canonicalName)) {
      const entry = entries.find((candidate) => candidate.name === canonicalName)!;
      const file = path.join(directory, canonicalName);
      const stat = lstatSync(file);
      if (!entry.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`Native ${provider} session storage contains an unsafe entry`);
      }
      metadataFiles.push(file);
    }
    metadataFiles.push(
      ...(temporaryBySession.get(sessionId) || [])
        .filter((artifact) => artifact.kind === 'metadata')
        .map((artifact) => artifact.filePath),
    );

    const identities = metadataFiles.map((file) => {
      let session: NativeSessionData;
      try {
        session = JSON.parse(readFileSync(file, 'utf8')) as NativeSessionData;
      } catch {
        throw new Error(`Native ${provider} session storage contains invalid JSON`);
      }
      if (
        !session
        || session.sessionId !== sessionId
        || session.provider !== provider
        || typeof session.userId !== 'string'
        || !session.userId.trim()
      ) {
        throw new Error(`Native ${provider} session storage contains an invalid identity`);
      }
      return session;
    });
    if (identities.length === 0) continue;
    const identityFingerprint = JSON.stringify({
      sessionId: identities[0].sessionId,
      provider: identities[0].provider,
      userId: identities[0].userId,
      executionContext: identities[0].executionContext || null,
    });
    if (identities.some((session) => JSON.stringify({
      sessionId: session.sessionId,
      provider: session.provider,
      userId: session.userId,
      executionContext: session.executionContext || null,
    }) !== identityFingerprint)) {
      throw new Error(`Native ${provider} session storage contains conflicting atomic identities`);
    }

    const session = identities[0];
    if (!session.executionContext || session.executionContext.scope !== 'PROJECT_SANDBOX') continue;
    assertExecutionContextBinding(session.executionContext, session.userId);
    if (session.executionContext.projectId !== query.projectIdentityId) continue;
    if (
      path.resolve(session.executionContext.canonicalRoot) !== expectedRoot
      || session.executionContext.rootDevice !== query.rootDevice
      || session.executionContext.rootInode !== query.rootInode
      || session.executionContext.rootBirthtimeNs !== query.rootBirthtimeNs
    ) {
      throw new Error(`Native ${provider} Project session root identity drifted`);
    }
    matches.push(Object.freeze({
      ...session,
      executionContext: Object.freeze({ ...session.executionContext }),
    }) as NativeSessionData);
  }
  return matches;
}

export function deleteNativeSession(provider: AgentProviderName, sessionId: string): void {
  ensureProviderDir(provider);
  const file = sessionPath(provider, sessionId);
  const historyFile = sessionHistoryPath(provider, sessionId);
  const temporaryArtifacts = listNativeSessionTemporaryArtifacts(provider, sessionId);
  // The transcript is retired and durably recorded before its identity. A
  // crash at either boundary therefore leaves either a complete discoverable
  // session or an identity-only record that a later exact delete can retry;
  // it can never create an unscoped transcript sidecar.
  for (const artifact of temporaryArtifacts.filter((candidate) => candidate.kind === 'history')) {
    unlinkSync(artifact.filePath);
    fsyncProviderDir(provider);
  }
  if (pathEntryExists(historyFile)) {
    unlinkSync(historyFile);
    fsyncProviderDir(provider);
  }
  for (const artifact of temporaryArtifacts.filter((candidate) => candidate.kind === 'metadata')) {
    unlinkSync(artifact.filePath);
    fsyncProviderDir(provider);
  }
  if (pathEntryExists(file)) {
    unlinkSync(file);
    fsyncProviderDir(provider);
  }
}

export function nativeSessionArtifactsPresent(provider: AgentProviderName, sessionId: string): boolean {
  return pathEntryExists(sessionPath(provider, sessionId))
    || pathEntryExists(sessionHistoryPath(provider, sessionId))
    || listNativeSessionTemporaryArtifacts(provider, sessionId).length > 0;
}

export function buildTranscriptPrompt(messages: AgentMessage[], nextUserMessage: string): string {
  const history = messages.slice(-20).map((msg) => {
    const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'system' ? 'System' : 'User';
    return `${role}: ${msg.content}`;
  }).join('\n\n');

  return [
    'Continue this conversation faithfully. Use the prior transcript as context.',
    'Do not restate the transcript unless needed. Respond only to the latest user message.',
    history ? `\nTranscript:\n${history}` : '',
    `\nLatest user message:\n${nextUserMessage}`,
  ].filter(Boolean).join('\n');
}
