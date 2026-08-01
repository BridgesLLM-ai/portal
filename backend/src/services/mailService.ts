/**
 * Mail Service — JMAP client for Stalwart Mail Server
 * 
 * Provides inbox read, send, and management for portal email.
 * All JMAP calls go to the local Stalwart instance.
 * 
 * All public functions accept (user, pass) parameters for per-user account support.
 * When called without user/pass from notificationService, they use the noreply account.
 * 
 * Security: 
 * - HTML is sanitized before serving to frontend
 * - Attachments are scanned for dangerous types
 * - Rate limiting on send operations
 */

import * as fs from 'fs';
import * as path from 'path';
import { scanBuffer } from './virusScan';
import { assertPortalFeatureAvailable } from '../utils/portalFeatureCapabilities';

// These are functions (not module-level consts) so they read process.env at call time.
// The wizard writes env vars AFTER this module loads — caching them at import time
// would leave stale empty strings and cause JMAP 401 errors.
function getStalwartUrl() { return process.env.STALWART_URL || 'http://127.0.0.1:8580'; }
function getStalwartSupportUser() { return process.env.STALWART_SUPPORT_USER || 'support'; }
function getStalwartSupportPass() { return process.env.STALWART_SUPPORT_PASS || ''; }
function getStalwartNoreplyUser() { return process.env.STALWART_NOREPLY_USER || 'noreply'; }
function getStalwartNoreplyPass() { return process.env.STALWART_NOREPLY_PASS || ''; }
function getMailDomain() { return process.env.MAIL_DOMAIN || 'localhost'; }

// Signature storage path
const SIGNATURE_FILE = path.join(process.cwd(), 'data', 'mail-signature.txt');
const JMAP_REQUEST_TIMEOUT_MS = 20_000;
const JMAP_UPLOAD_TIMEOUT_MS = 60_000;
const MAX_JMAP_JSON_BYTES = 10 * 1024 * 1024;
const MAX_JMAP_ERROR_BYTES = 16 * 1024;
export const MAX_MAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Dangerous attachment types that should be blocked/flagged
const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.msi', '.msp',
  '.dll', '.reg', '.inf', '.hta', '.cpl', '.lnk',
]);

const DANGEROUS_MIME_TYPES = new Set([
  'application/x-msdownload', 'application/x-msdos-program',
  'application/x-executable', 'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
]);

interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  accountId: string;
}

async function readBoundedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch {}
    throw new Error(`Mail server response exceeds the ${maxBytes}-byte limit`);
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Mail server response exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readBoundedText(response: Response, maxBytes = MAX_JMAP_ERROR_BYTES): Promise<string> {
  return (await readBoundedBuffer(response, maxBytes)).toString('utf8');
}

async function readBoundedJson(response: Response, maxBytes = MAX_JMAP_JSON_BYTES): Promise<any> {
  const text = await readBoundedText(response, maxBytes);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Mail server returned malformed JSON');
  }
}

function fetchMail(url: string, init: RequestInit = {}, timeoutMs = JMAP_REQUEST_TIMEOUT_MS): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function normalizeAttachmentName(name: string | null | undefined): string {
  const normalized = path.basename(String(name || 'attachment'))
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .trim()
    .slice(0, 180);
  return normalized || 'attachment';
}

export function normalizeContentType(type: string | null | undefined): string {
  const normalized = String(type || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

const PORTAL_AUTO_FORWARD_SCRIPT_NAME = 'bridgesllm-auto-forward';
const JMAP_CORE_CAPABILITIES = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'];
const JMAP_MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';
const JMAP_SIEVE_CAPABILITY = 'urn:ietf:params:jmap:sieve';

type JmapPreferredAccount = 'mail' | 'sieve';

interface SieveScriptInfo {
  id: string;
  name: string | null;
  isActive: boolean;
  blobId: string;
}

interface MailboxInfo {
  id: string;
  name: string;
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
  sortOrder: number;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  from: { name: string; email: string }[];
  to: { name: string; email: string }[];
  cc?: { name: string; email: string }[];
  subject: string;
  receivedAt: string;
  size: number;
  preview: string;
  hasAttachment: boolean;
  isUnread: boolean;
  isFlagged: boolean;
}

export interface EmailFull extends EmailSummary {
  htmlBody: { partId: string; type: string }[];
  textBody: { partId: string; type: string }[];
  bodyValues: Record<string, { value: string; isEncodingProblem: boolean }>;
  attachments: {
    partId: string;
    blobId: string;
    name: string | null;
    type: string;
    size: number;
    isDangerous: boolean;
  }[];
  replyTo?: { name: string; email: string }[];
  messageId?: string[];
  inReplyTo?: string[];
  references?: string[];
}

export interface SendEmailParams {
  from?: string; // defaults to noreply@${MAIL_DOMAIN}
  fromName?: string; // display name (defaults to 'BridgesLLM')
  to: { name?: string; email: string }[];
  cc?: { name?: string; email: string }[];
  bcc?: { name?: string; email: string }[];
  replyToAddresses?: { name?: string; email: string }[]; // Reply-To header addresses
  subject: string;
  textBody?: string;
  htmlBody?: string;
  replyTo?: string; // messageId to reply to (threading)
  inReplyTo?: string[];
  references?: string[];
  attachments?: { blobId: string; type: string; name: string; size: number }[];
}

// ── JMAP helpers ──────────────────────────────────────────────

function selectJmapAccountId(session: any, preferred: JmapPreferredAccount): string {
  const preferredCapability = preferred === 'sieve' ? JMAP_SIEVE_CAPABILITY : JMAP_MAIL_CAPABILITY;
  const primary = session.primaryAccounts || {};
  const accounts = session.accounts || {};
  const accountWithCapability = Object.entries(accounts).find(([, account]: any) => {
    return !!account?.accountCapabilities?.[preferredCapability];
  })?.[0];

  return primary[preferredCapability]
    || accountWithCapability
    || primary[JMAP_MAIL_CAPABILITY]
    || Object.keys(accounts)[0]
    || '';
}

async function getSession(user: string, pass: string, preferred: JmapPreferredAccount = 'mail'): Promise<JmapSession> {
  const res = await fetchMail(`${getStalwartUrl()}/jmap/session`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
  });
  if (!res.ok) throw new Error(`JMAP session failed: ${res.status} ${res.statusText}`);
  const session = await readBoundedJson(res) as any;
  
  const accountId = selectJmapAccountId(session, preferred);
  if (!accountId) throw new Error('No JMAP account found');

  // Always use getStalwartUrl() — Stalwart returns its public hostname (mail.bridgesllm.com:8080)
  // in session URLs, but the backend connects via internal loopback (127.0.0.1:8580)
  return {
    apiUrl: `${getStalwartUrl()}/jmap`,
    downloadUrl: `${getStalwartUrl()}/jmap/download/${accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${getStalwartUrl()}/jmap/upload/${accountId}`,
    accountId,
  };
}

async function jmapCall(
  session: JmapSession,
  user: string,
  pass: string,
  methodCalls: any[],
  extraUsing: string[] = [],
): Promise<any> {
  const res = await fetchMail(session.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
    body: JSON.stringify({
      using: [...new Set([...JMAP_CORE_CAPABILITIES, ...extraUsing])],
      methodCalls,
    }),
  });
  if (!res.ok) {
    await readBoundedText(res).catch(() => undefined);
    throw new Error(`JMAP call failed: HTTP ${res.status}`);
  }
  return readBoundedJson(res);
}

function formatJmapMethodError(error: any): string {
  const type = typeof error?.type === 'string' ? error.type : 'unknown';
  const description = typeof error?.description === 'string' && error.description.trim()
    ? `: ${error.description.trim()}`
    : '';
  return `${type}${description}`;
}

function getJmapMethodResponse(result: any, callId: string, methodName: string, action: string): any {
  const responses = Array.isArray(result?.methodResponses) ? result.methodResponses : [];
  const entry = responses.find((response: any[]) => response?.[2] === callId);

  if (!entry) {
    const errorEntry = responses.find((response: any[]) => response?.[0] === 'error');
    if (errorEntry) throw new Error(`JMAP ${action} failed: ${formatJmapMethodError(errorEntry[1])}`);
    throw new Error(`JMAP ${action} returned no ${methodName} response`);
  }

  if (entry[0] === 'error') {
    throw new Error(`JMAP ${action} failed: ${formatJmapMethodError(entry[1])}`);
  }

  if (entry[0] !== methodName) {
    throw new Error(`JMAP ${action} returned unexpected response ${entry[0] || 'unknown'}`);
  }

  return entry[1] || {};
}

type JmapSetOperation = 'create' | 'update' | 'destroy';

function assertJmapSetSucceeded(
  response: any,
  operation: JmapSetOperation,
  requestedIds: string[],
  action: string,
): Record<string, any> {
  const failureKey = operation === 'create'
    ? 'notCreated'
    : operation === 'update'
      ? 'notUpdated'
      : 'notDestroyed';
  const successKey = operation === 'create'
    ? 'created'
    : operation === 'update'
      ? 'updated'
      : 'destroyed';
  const failures = response?.[failureKey];
  if (failures && typeof failures === 'object' && Object.keys(failures).length > 0) {
    const details = JSON.stringify(failures).slice(0, 2_000);
    throw new Error(`JMAP ${action} failed: ${details}`);
  }

  const successes = response?.[successKey];
  if (operation === 'destroy') {
    const destroyed = Array.isArray(successes) ? successes : [];
    const missing = requestedIds.filter((id) => !destroyed.includes(id));
    if (missing.length > 0) {
      throw new Error(`JMAP ${action} did not confirm ${operation} for: ${missing.join(', ')}`);
    }
    return Object.fromEntries(destroyed.map((id: string) => [id, null]));
  }

  if (!successes || typeof successes !== 'object' || Array.isArray(successes)) {
    throw new Error(`JMAP ${action} returned no ${successKey} confirmations`);
  }
  const missing = requestedIds.filter((id) => !Object.prototype.hasOwnProperty.call(successes, id));
  if (missing.length > 0) {
    throw new Error(`JMAP ${action} did not confirm ${operation} for: ${missing.join(', ')}`);
  }
  return successes;
}

function requireRequestedEmails(response: any, emailIds: string[], action: string): any[] {
  const list = Array.isArray(response?.list) ? response.list : [];
  const requested = [...new Set(emailIds)];
  const byId = new Map<string, any>();
  for (const email of list) {
    if (typeof email?.id === 'string' && requested.includes(email.id)) byId.set(email.id, email);
  }
  const missing = requested.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const reportedNotFound = Array.isArray(response?.notFound)
      ? response.notFound.filter((id: unknown) => typeof id === 'string')
      : [];
    const details = reportedNotFound.length > 0 ? ` (notFound: ${reportedNotFound.join(', ')})` : '';
    throw new Error(`JMAP ${action} could not load: ${missing.join(', ')}${details}`);
  }
  return requested.map((id) => byId.get(id));
}

async function updateEmails(
  session: JmapSession,
  user: string,
  pass: string,
  update: Record<string, any>,
  action: string,
): Promise<void> {
  const emailIds = Object.keys(update);
  if (emailIds.length === 0) return;
  const result = await jmapCall(session, user, pass, [
    ['Email/set', {
      accountId: session.accountId,
      update,
    }, 'email-update'],
  ]);
  const response = getJmapMethodResponse(result, 'email-update', 'Email/set', action);
  assertJmapSetSucceeded(response, 'update', emailIds, action);
}

function escapeSieveString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

export function buildAutoForwardSieveScript(forwardTo: string): string {
  return [
    '# Managed by BridgesLLM Portal. Changes made outside Portal may be overwritten.',
    'require ["copy"];',
    `redirect :copy "${escapeSieveString(forwardTo)}";`,
    '',
  ].join('\n');
}

async function uploadSieveScript(session: JmapSession, user: string, pass: string, content: string): Promise<string> {
  const res = await fetchMail(session.uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sieve; charset=utf-8',
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
    body: Buffer.from(content, 'utf8'),
  }, JMAP_UPLOAD_TIMEOUT_MS);

  if (!res.ok) {
    await readBoundedText(res).catch(() => undefined);
    throw new Error(`Sieve upload failed: HTTP ${res.status}`);
  }

  const uploaded = await readBoundedJson(res) as any;
  const blobId = typeof uploaded.blobId === 'string' ? uploaded.blobId : '';
  if (!blobId) throw new Error('Sieve upload did not return a blobId');
  return blobId;
}

async function getSieveScripts(session: JmapSession, user: string, pass: string): Promise<SieveScriptInfo[]> {
  const result = await jmapCall(session, user, pass, [
    ['SieveScript/get', {
      accountId: session.accountId,
      properties: ['id', 'name', 'isActive', 'blobId'],
    }, 'sieve-get'],
  ], [JMAP_SIEVE_CAPABILITY, 'urn:ietf:params:jmap:blob']);

  const response = getJmapMethodResponse(result, 'sieve-get', 'SieveScript/get', 'SieveScript/get');
  return (response.list || []).map((script: any) => ({
    id: String(script.id || ''),
    name: typeof script.name === 'string' ? script.name : null,
    isActive: !!script.isActive,
    blobId: String(script.blobId || ''),
  })).filter((script: any) => script.id);
}

function assertSieveSetSucceeded(result: any, action: string): void {
  for (const entry of result.methodResponses || []) {
    if (entry?.[0] === 'error') {
      throw new Error(`Sieve ${action} failed: ${formatJmapMethodError(entry[1])}`);
    }
  }

  const responses = (result.methodResponses || []).filter((entry: any[]) => entry?.[0] === 'SieveScript/set');
  if (!responses.length) throw new Error(`Sieve ${action} returned no SieveScript/set response`);
  for (const entry of responses) {
    const response = entry[1];
    const failed = response.notCreated || response.notUpdated || response.notDestroyed;
    if (failed && Object.keys(failed).length > 0) {
      throw new Error(`Sieve ${action} failed: ${JSON.stringify(failed)}`);
    }
  }
}

export async function syncAutoForwardRule(forwardTo: string | null | undefined, user: string, pass: string): Promise<void> {
  assertPortalFeatureAvailable('mail');

  const target = typeof forwardTo === 'string' ? forwardTo.trim() : '';
  const session = await getSession(user, pass, 'sieve');
  const scripts = await getSieveScripts(session, user, pass);
  const managedScript = scripts.find((script) => script.name === PORTAL_AUTO_FORWARD_SCRIPT_NAME);
  const activeNonPortalScript = scripts.find((script) => script.isActive && script.name !== PORTAL_AUTO_FORWARD_SCRIPT_NAME);

  if (!target) {
    if (!managedScript) return;
    const methodCalls: any[] = [];
    if (managedScript.isActive) {
      methodCalls.push(['SieveScript/set', {
        accountId: session.accountId,
        onSuccessDeactivateScript: true,
      }, 'deactivate']);
    }
    methodCalls.push(['SieveScript/set', {
      accountId: session.accountId,
      destroy: [managedScript.id],
    }, 'destroy']);
    const result = await jmapCall(session, user, pass, methodCalls, [JMAP_SIEVE_CAPABILITY, 'urn:ietf:params:jmap:blob']);
    assertSieveSetSucceeded(result, 'disable');
    return;
  }

  if (activeNonPortalScript) {
    throw new Error(`Mailbox already has an active non-Portal Sieve script (${activeNonPortalScript.name || activeNonPortalScript.id}); refusing to overwrite it`);
  }

  const blobId = await uploadSieveScript(session, user, pass, buildAutoForwardSieveScript(target));
  const scriptSet = managedScript
    ? {
      update: {
        [managedScript.id]: { blobId },
      },
      onSuccessActivateScript: managedScript.id,
    }
    : {
      create: {
        portalAutoForward: {
          name: PORTAL_AUTO_FORWARD_SCRIPT_NAME,
          blobId,
        },
      },
      onSuccessActivateScript: '#portalAutoForward',
    };

  const result = await jmapCall(session, user, pass, [
    ['SieveScript/set', {
      accountId: session.accountId,
      ...scriptSet,
    }, 'sieve-set'],
  ], [JMAP_SIEVE_CAPABILITY, 'urn:ietf:params:jmap:blob']);
  assertSieveSetSucceeded(result, managedScript ? 'update' : 'create');
}

// ── Sanitization ──────────────────────────────────────────────

import sanitizeHtmlLib from 'sanitize-html';

function sanitizeHtml(html: string): string {
  return sanitizeHtmlLib(html, {
    allowedTags: sanitizeHtmlLib.defaults.allowedTags.concat([
      'img', 'h1', 'h2', 'span', 'div', 'center', 'font', 'u', 'hr', 'br',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
      'style', // Allow style tags for email rendering (CSS-only, no expressions)
    ]),
    allowedAttributes: {
      ...sanitizeHtmlLib.defaults.allowedAttributes,
      '*': ['style', 'class', 'id', 'dir', 'lang', 'title', 'align', 'valign',
            'bgcolor', 'width', 'height', 'cellpadding', 'cellspacing', 'border',
            'role', 'aria-label', 'aria-hidden'],
      'a': ['href', 'name', 'target', 'rel'],
      'img': ['src', 'alt', 'width', 'height'],
      'td': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
      'th': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'bgcolor', 'style'],
      'font': ['color', 'face', 'size'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    // Block javascript: and data: URLs
    disallowedTagsMode: 'discard',
    // Strip event handlers (on*)
    exclusiveFilter: (frame: any) => {
      // Remove empty style/script
      if (['script'].includes(frame.tag) && !frame.text?.trim()) return true;
      return false;
    },
    // Allow safe CSS in style tags but strip expressions/imports
    transformTags: {
      'style': (tagName: any, attribs: any) => {
        return { tagName, attribs };
      },
    },
  });
}

function isAttachmentDangerous(name: string | null, mimeType: string): boolean {
  if (DANGEROUS_MIME_TYPES.has(mimeType.toLowerCase())) return true;
  if (name) {
    const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    if (DANGEROUS_EXTENSIONS.has(ext)) return true;
    // Double extension trick: file.pdf.exe
    if (/\.\w+\.\w+$/.test(name)) {
      const lastExt = name.toLowerCase().match(/\.\w+$/)?.[0] || '';
      if (DANGEROUS_EXTENSIONS.has(lastExt)) return true;
    }
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Get all mailboxes (folders) for the specified account
 */
export async function getMailboxes(user: string, pass: string): Promise<MailboxInfo[]> {
  const session = await getSession(user, pass);
  const result = await jmapCall(session, user, pass, [
    ['Mailbox/get', { accountId: session.accountId }, '0'],
  ]);

  const mailboxResponse = getJmapMethodResponse(result, '0', 'Mailbox/get', 'load mailboxes');
  const mailboxes = Array.isArray(mailboxResponse.list) ? mailboxResponse.list : [];
  return mailboxes.map((mb: any) => ({
    id: mb.id,
    name: mb.name,
    role: mb.role || null,
    totalEmails: mb.totalEmails || 0,
    unreadEmails: mb.unreadEmails || 0,
    sortOrder: mb.sortOrder || 0,
  }));
}

/**
 * List emails in a mailbox (paginated)
 */
export async function listEmails(user: string, pass: string, options: {
  mailboxId?: string;
  mailboxRole?: string; // 'inbox', 'sent', 'drafts', 'trash', 'junk'
  position?: number;
  limit?: number;
  sort?: 'date-desc' | 'date-asc';
  query?: string;
}): Promise<{ emails: EmailSummary[]; total: number; position: number }> {
  const { position = 0, limit = 50, sort = 'date-desc' } = options;
  
  const session = await getSession(user, pass);
  
  // Resolve mailbox ID from role if needed
  let mailboxId = options.mailboxId;
  if (!mailboxId && options.mailboxRole) {
    const mailboxes = await getMailboxes(user, pass);
    const mb = mailboxes.find(m => m.role === options.mailboxRole);
    if (!mb) throw new Error(`Mailbox with role "${options.mailboxRole}" not found`);
    mailboxId = mb.id;
  }
  
  const filter: any = {};
  if (mailboxId) filter.inMailbox = mailboxId;
  const query = options.query?.trim();
  if (query) filter.text = query;
  
  const result = await jmapCall(session, user, pass, [
    ['Email/query', {
      accountId: session.accountId,
      filter,
      sort: [{ property: 'receivedAt', isAscending: sort === 'date-asc' }],
      position,
      limit,
      calculateTotal: true,
    }, '0'],
    ['Email/get', {
      accountId: session.accountId,
      '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
      properties: [
        'threadId', 'mailboxIds', 'from', 'to', 'cc', 'subject',
        'receivedAt', 'size', 'preview', 'hasAttachment', 'keywords',
      ],
    }, '1'],
  ]);
  
  const queryResult = getJmapMethodResponse(result, '0', 'Email/query', 'query emails');
  const getResult = getJmapMethodResponse(result, '1', 'Email/get', 'load queried emails');
  const emails = (Array.isArray(getResult.list) ? getResult.list : []).map((e: any) => ({
    id: e.id,
    threadId: e.threadId,
    mailboxIds: e.mailboxIds || {},
    from: e.from || [],
    to: e.to || [],
    cc: e.cc || [],
    subject: e.subject || '(no subject)',
    receivedAt: e.receivedAt,
    size: e.size || 0,
    preview: e.preview || '',
    hasAttachment: e.hasAttachment || false,
    isUnread: !(e.keywords?.['$seen']),
    isFlagged: !!(e.keywords?.['$flagged']),
  }));
  
  return {
    emails,
    total: queryResult.total || 0,
    position: queryResult.position || 0,
  };
}

/**
 * Get full email with body and attachments
 */
export async function getEmail(emailId: string, user: string, pass: string): Promise<EmailFull> {
  const session = await getSession(user, pass);
  
  const result = await jmapCall(session, user, pass, [
    ['Email/get', {
      accountId: session.accountId,
      ids: [emailId],
      properties: [
        'threadId', 'mailboxIds', 'from', 'to', 'cc', 'replyTo',
        'subject', 'receivedAt', 'size', 'preview', 'hasAttachment',
        'keywords', 'messageId', 'inReplyTo', 'references',
        'htmlBody', 'textBody', 'bodyValues', 'attachments',
      ],
      fetchAllBodyValues: true,
      maxBodyValueBytes: 1048576, // 1MB max per body part
    }, '0'],
  ]);
  
  const getResult = getJmapMethodResponse(result, '0', 'Email/get', 'load email');
  const email = requireRequestedEmails(getResult, [emailId], 'load email')[0];
  if (!email) throw new Error('Email not found');
  
  // Sanitize HTML body values
  const bodyValues: Record<string, { value: string; isEncodingProblem: boolean }> = {};
  for (const [partId, bv] of Object.entries(email.bodyValues || {})) {
    const val = bv as any;
    const htmlPart = (email.htmlBody || []).find((h: any) => h.partId === partId);
    bodyValues[partId] = {
      value: htmlPart ? sanitizeHtml(val.value || '') : (val.value || ''),
      isEncodingProblem: val.isEncodingProblem || false,
    };
  }
  
  // Process attachments with danger flagging
  const attachments = (email.attachments || []).map((att: any) => ({
    partId: att.partId,
    blobId: att.blobId,
    name: att.name || null,
    type: att.type || 'application/octet-stream',
    size: att.size || 0,
    isDangerous: isAttachmentDangerous(att.name, att.type || ''),
  }));
  
  return {
    id: email.id,
    threadId: email.threadId,
    mailboxIds: email.mailboxIds || {},
    from: email.from || [],
    to: email.to || [],
    cc: email.cc || [],
    replyTo: email.replyTo,
    subject: email.subject || '(no subject)',
    receivedAt: email.receivedAt,
    size: email.size || 0,
    preview: email.preview || '',
    hasAttachment: email.hasAttachment || false,
    isUnread: !email.keywords?.['$seen'],
    isFlagged: !!(email.keywords?.['$flagged']),
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
    htmlBody: email.htmlBody || [],
    textBody: email.textBody || [],
    bodyValues,
    attachments,
  };
}

/**
 * Download an attachment blob
 */
export async function downloadAttachment(blobId: string, name: string, type: string, user: string, pass: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const filename = normalizeAttachmentName(name);
  const contentType = normalizeContentType(type);
  if (isAttachmentDangerous(filename, contentType)) {
    throw new Error('This attachment type is blocked for security reasons');
  }
  
  const session = await getSession(user, pass);
  const url = session.downloadUrl
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', encodeURIComponent(filename))
    .replace('{type}', encodeURIComponent(contentType));
  
  const res = await fetchMail(url, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
  }, JMAP_UPLOAD_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  
  const buffer = await readBoundedBuffer(res, MAX_MAIL_ATTACHMENT_BYTES);
  return {
    buffer,
    contentType,
    filename,
  };
}

/**
 * Upload a blob (attachment) to Stalwart via JMAP upload endpoint
 */
export async function uploadBlob(
  fileBuffer: Buffer,
  contentType: string,
  user: string,
  pass: string,
  filename = 'attachment',
): Promise<{ blobId: string; type: string; size: number }> {
  const safeName = normalizeAttachmentName(filename);
  const safeType = normalizeContentType(contentType);
  if (fileBuffer.length === 0 || fileBuffer.length > MAX_MAIL_ATTACHMENT_BYTES) {
    throw new Error(`Attachment must be between 1 byte and ${MAX_MAIL_ATTACHMENT_BYTES} bytes`);
  }
  if (isAttachmentDangerous(safeName, safeType)) {
    throw new Error('This attachment type is blocked for security reasons');
  }
  const scanResult = await scanBuffer(fileBuffer, safeName);
  if (!scanResult.clean) {
    throw new Error(scanResult.scannerAvailable
      ? `Attachment blocked by malware scanner: ${scanResult.threat || 'threat detected'}`
      : 'Attachment could not be verified because the malware scanner is unavailable');
  }

  const session = await getSession(user, pass);
  
  const res = await fetchMail(session.uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': safeType,
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
    body: fileBuffer,
  }, JMAP_UPLOAD_TIMEOUT_MS);
  
  if (!res.ok) {
    await readBoundedText(res).catch(() => undefined);
    throw new Error(`Blob upload failed: HTTP ${res.status}`);
  }
  
  const result = await readBoundedJson(res) as any;
  return {
    blobId: result.blobId,
    type: normalizeContentType(result.type || safeType),
    size: result.size || fileBuffer.length,
  };
}

/**
 * Send an email.
 * When user/pass are provided, sends from that account.
 * When not provided, auto-detects: noreply@ for from=noreply@..., otherwise support@.
 */
export async function sendEmail(params: SendEmailParams, user?: string, pass?: string): Promise<{ success: boolean; messageId?: string }> {
  // This is the central outbound JMAP boundary. Assert before resolving any
  // stored credentials or opening a Stalwart session.
  assertPortalFeatureAvailable('mail');

  // Resolve which account to use
  let resolvedUser: string;
  let resolvedPass: string;
  let fromEmail: string;

  if (user && pass) {
    // Explicit credentials provided (per-user account)
    resolvedUser = user;
    resolvedPass = pass;
    fromEmail = params.from || `${user}@${getMailDomain()}`;
  } else {
    // Legacy behavior: auto-detect from 'from' field
    const useNoreply = params.from === `noreply@${getMailDomain()}`;
    resolvedUser = useNoreply ? getStalwartNoreplyUser() : getStalwartSupportUser();
    resolvedPass = useNoreply ? getStalwartNoreplyPass() : getStalwartSupportPass();
    fromEmail = useNoreply ? `noreply@${getMailDomain()}` : `support@${getMailDomain()}`;
  }
  
  const session = await getSession(resolvedUser, resolvedPass);
  
  // Stalwart requires mailboxIds — get drafts + sent mailbox for the account
  const mailboxResult = await jmapCall(session, resolvedUser, resolvedPass, [
    ['Mailbox/get', { accountId: session.accountId, properties: ['id', 'role'] }, 'mb'],
  ]);
  const mailboxResponse = getJmapMethodResponse(mailboxResult, 'mb', 'Mailbox/get', 'load sending mailboxes');
  const mailboxList = Array.isArray(mailboxResponse.list) ? mailboxResponse.list : [];
  const draftsBox = mailboxList.find((m: any) => m.role === 'drafts');
  const sentBox = mailboxList.find((m: any) => m.role === 'sent');
  const anyBox = mailboxList[0];
  const targetMailboxId = (draftsBox || anyBox)?.id;
  const sentMailboxId = sentBox?.id;
  if (!targetMailboxId) throw new Error('No mailbox available for sending');
  
  // Build the email body
  const bodyValue: any = {};
  const textBody: any[] = [];
  const htmlBody: any[] = [];
  
  if (params.textBody) {
    bodyValue['text'] = { value: params.textBody, charset: 'utf-8' };
    textBody.push({ partId: 'text', type: 'text/plain' });
  }
  if (params.htmlBody) {
    bodyValue['html'] = { value: params.htmlBody, charset: 'utf-8' };
    htmlBody.push({ partId: 'html', type: 'text/html' });
  }
  if (!params.textBody && !params.htmlBody) {
    throw new Error('Email must have textBody or htmlBody');
  }
  
  const emailCreate: any = {
    mailboxIds: { [targetMailboxId]: true },
    from: [{ name: params.fromName || 'BridgesLLM', email: fromEmail }],
    to: params.to,
    subject: params.subject,
    bodyValues: bodyValue,
  };
  
  if (params.cc) emailCreate.cc = params.cc;
  if (params.bcc) emailCreate.bcc = params.bcc;
  if (params.replyToAddresses) emailCreate.replyTo = params.replyToAddresses;
  if (textBody.length) emailCreate.textBody = textBody;
  if (htmlBody.length) emailCreate.htmlBody = htmlBody;
  if (params.inReplyTo) emailCreate.inReplyTo = params.inReplyTo;
  if (params.references) emailCreate.references = params.references;
  
  // Add attachments if provided
  if (params.attachments && params.attachments.length > 0) {
    emailCreate.attachments = params.attachments.map(att => ({
      blobId: att.blobId,
      type: att.type,
      name: att.name,
      size: att.size,
    }));
  }
  
  // Get the identity ID for this account (not the same as accountId)
  const identityResult = await jmapCall(session, resolvedUser, resolvedPass, [
    ['Identity/get', { accountId: session.accountId }, 'id'],
  ]);
  const identityResponse = getJmapMethodResponse(identityResult, 'id', 'Identity/get', 'load sending identity');
  const identities = Array.isArray(identityResponse.list) ? identityResponse.list : [];
  const identityId = identities[0]?.id;
  if (!identityId) throw new Error('No email identity found for account');
  
  const result = await jmapCall(session, resolvedUser, resolvedPass, [
    ['Email/set', {
      accountId: session.accountId,
      create: { draft: emailCreate },
    }, '0'],
    ['EmailSubmission/set', {
      accountId: session.accountId,
      create: {
        send: {
          emailId: '#draft',
          identityId,
        },
      },
    }, '1'],
  ]);
  
  const createResult = getJmapMethodResponse(result, '0', 'Email/set', 'create outbound email');
  const createdEmails = assertJmapSetSucceeded(createResult, 'create', ['draft'], 'create outbound email');
  const emailId = typeof createdEmails.draft?.id === 'string' ? createdEmails.draft.id : '';
  if (!emailId) throw new Error('JMAP create outbound email returned no email id');

  const submissionResult = getJmapMethodResponse(result, '1', 'EmailSubmission/set', 'submit outbound email');
  const createdSubmissions = assertJmapSetSucceeded(
    submissionResult,
    'create',
    ['send'],
    'submit outbound email',
  );
  if (typeof createdSubmissions.send?.id !== 'string' || !createdSubmissions.send.id) {
    throw new Error('JMAP submit outbound email returned no submission id');
  }

  // Move from drafts to sent after successful submission
  if (emailId && sentMailboxId) {
    try {
      const moveUpdate: any = {};
      moveUpdate[`mailboxIds/${targetMailboxId}`] = null;
      moveUpdate[`mailboxIds/${sentMailboxId}`] = true;
      await updateEmails(
        session,
        resolvedUser,
        resolvedPass,
        { [emailId]: moveUpdate },
        'move submitted email to Sent',
      );
    } catch {
      // Non-critical — email was sent, just couldn't move to Sent folder
    }
  }
  
  return { success: true, messageId: emailId };
}

/**
 * Move email to trash
 */
export async function trashEmail(emailId: string, user: string, pass: string): Promise<void> {
  const session = await getSession(user, pass);
  
  // Get trash mailbox ID
  const mailboxes = await getMailboxes(user, pass);
  const trash = mailboxes.find(m => m.role === 'trash');
  if (!trash) throw new Error('Trash mailbox not found');
  
  // Get current mailboxIds
  const getResult = await jmapCall(session, user, pass, [
    ['Email/get', {
      accountId: session.accountId,
      ids: [emailId],
      properties: ['mailboxIds'],
    }, '0'],
  ]);

  const getResponse = getJmapMethodResponse(getResult, '0', 'Email/get', 'load email before trash');
  const email = requireRequestedEmails(getResponse, [emailId], 'load email before trash')[0];
  
  // Build new mailboxIds — remove all current, add trash
  const update: any = {};
  for (const mbId of Object.keys(email.mailboxIds || {})) {
    update[`mailboxIds/${mbId}`] = null;
  }
  update[`mailboxIds/${trash.id}`] = true;
  
  await updateEmails(session, user, pass, { [emailId]: update }, 'move email to Trash');
}

/**
 * Move email to a specific folder
 */
export async function moveEmail(emailId: string, targetMailboxId: string, user: string, pass: string): Promise<void> {
  const session = await getSession(user, pass);
  
  // Get current mailboxIds
  const getResult = await jmapCall(session, user, pass, [
    ['Email/get', {
      accountId: session.accountId,
      ids: [emailId],
      properties: ['mailboxIds'],
    }, '0'],
  ]);

  const getResponse = getJmapMethodResponse(getResult, '0', 'Email/get', 'load email before move');
  const email = requireRequestedEmails(getResponse, [emailId], 'load email before move')[0];
  
  // Build new mailboxIds — remove all current, add target
  const update: any = {};
  for (const mbId of Object.keys(email.mailboxIds || {})) {
    update[`mailboxIds/${mbId}`] = null;
  }
  update[`mailboxIds/${targetMailboxId}`] = true;
  
  await updateEmails(session, user, pass, { [emailId]: update }, 'move email');
}

/**
 * Toggle flag/star on email
 */
export async function toggleFlag(emailId: string, flagged: boolean, user: string, pass: string): Promise<void> {
  const session = await getSession(user, pass);
  await updateEmails(
    session,
    user,
    pass,
    { [emailId]: { 'keywords/$flagged': flagged || null } },
    flagged ? 'flag email' : 'unflag email',
  );
}

/**
 * Mark email as read/unread
 */
export async function markRead(emailId: string, read: boolean, user: string, pass: string): Promise<void> {
  const session = await getSession(user, pass);
  await updateEmails(
    session,
    user,
    pass,
    { [emailId]: { 'keywords/$seen': read || null } },
    read ? 'mark email read' : 'mark email unread',
  );
}

/**
 * Bulk mark emails as read/unread
 */
export async function bulkMarkRead(emailIds: string[], read: boolean, user: string, pass: string): Promise<void> {
  if (!emailIds.length) return;
  const session = await getSession(user, pass);
  
  const updateMap: any = {};
  for (const id of new Set(emailIds)) {
    updateMap[id] = { 'keywords/$seen': read || null };
  }

  await updateEmails(session, user, pass, updateMap, read ? 'mark emails read' : 'mark emails unread');
}

/**
 * Bulk move emails to trash
 */
export async function bulkTrash(emailIds: string[], user: string, pass: string): Promise<void> {
  if (!emailIds.length) return;
  const session = await getSession(user, pass);
  
  const mailboxes = await getMailboxes(user, pass);
  const trash = mailboxes.find(m => m.role === 'trash');
  if (!trash) throw new Error('Trash mailbox not found');
  
  // Get current mailboxIds for all emails
  const getResult = await jmapCall(session, user, pass, [
    ['Email/get', {
      accountId: session.accountId,
      ids: emailIds,
      properties: ['mailboxIds'],
    }, '0'],
  ]);

  const getResponse = getJmapMethodResponse(getResult, '0', 'Email/get', 'load emails before trash');
  const emails = requireRequestedEmails(getResponse, emailIds, 'load emails before trash');
  const updateMap: any = {};
  
  for (const email of emails) {
    const update: any = {};
    for (const mbId of Object.keys(email.mailboxIds || {})) {
      update[`mailboxIds/${mbId}`] = null;
    }
    update[`mailboxIds/${trash.id}`] = true;
    updateMap[email.id] = update;
  }
  
  await updateEmails(session, user, pass, updateMap, 'move emails to Trash');
}

/**
 * Bulk move emails to a specific folder
 */
export async function bulkMove(emailIds: string[], targetMailboxId: string, user: string, pass: string): Promise<void> {
  if (!emailIds.length) return;
  const session = await getSession(user, pass);
  
  // Get current mailboxIds for all emails
  const getResult = await jmapCall(session, user, pass, [
    ['Email/get', {
      accountId: session.accountId,
      ids: emailIds,
      properties: ['mailboxIds'],
    }, '0'],
  ]);

  const getResponse = getJmapMethodResponse(getResult, '0', 'Email/get', 'load emails before move');
  const emails = requireRequestedEmails(getResponse, emailIds, 'load emails before move');
  const updateMap: any = {};
  
  for (const email of emails) {
    const update: any = {};
    for (const mbId of Object.keys(email.mailboxIds || {})) {
      update[`mailboxIds/${mbId}`] = null;
    }
    update[`mailboxIds/${targetMailboxId}`] = true;
    updateMap[email.id] = update;
  }
  
  await updateEmails(session, user, pass, updateMap, 'move emails');
}

/**
 * Forward an email — fetches original, creates new with Fwd: subject and original attachments
 */
export async function forwardEmail(
  originalId: string,
  to: { name?: string; email: string }[],
  cc: { name?: string; email: string }[] | undefined,
  bcc: { name?: string; email: string }[] | undefined,
  body: string,
  user: string,
  pass: string,
  additionalAttachments?: { blobId: string; type: string; name: string; size: number }[]
): Promise<{ success: boolean; messageId?: string }> {
  const original = await getEmail(originalId, user, pass);
  
  const subject = original.subject.startsWith('Fwd:') ? original.subject : `Fwd: ${original.subject}`;
  
  // Build forwarded body with original quoted
  const textPart = original.textBody?.[0];
  const originalBody = textPart && original.bodyValues[textPart.partId]
    ? original.bodyValues[textPart.partId].value
    : original.preview;
  
  const fullBody = `${body}\n\n---------- Forwarded message ----------\nFrom: ${original.from.map((f: any) => `${f.name} <${f.email}>`).join(', ')}\nDate: ${new Date(original.receivedAt).toLocaleString()}\nSubject: ${original.subject}\nTo: ${original.to.map((t: any) => `${t.name} <${t.email}>`).join(', ')}\n\n${originalBody}`;
  
  // Re-upload original attachments for forwarding
  const forwardedAttachments: { blobId: string; type: string; name: string; size: number }[] = [];
  
  for (const att of original.attachments) {
    if (att.isDangerous) continue;
    try {
      const downloaded = await downloadAttachment(att.blobId, att.name || 'attachment', att.type, user, pass);
      const uploaded = await uploadBlob(downloaded.buffer, att.type, user, pass, att.name || 'attachment');
      forwardedAttachments.push({
        blobId: uploaded.blobId,
        type: uploaded.type,
        name: downloaded.filename,
        size: uploaded.size,
      });
    } catch (err) {
      console.error(`[mail] Failed to forward attachment ${normalizeAttachmentName(att.name)}:`, err);
      throw new Error('Forward failed because an original attachment could not be copied safely');
    }
  }
  
  // Add any additional attachments
  if (additionalAttachments) {
    forwardedAttachments.push(...additionalAttachments);
  }
  
  return sendEmail({
    to,
    cc,
    bcc,
    subject,
    textBody: fullBody,
    attachments: forwardedAttachments.length > 0 ? forwardedAttachments : undefined,
  }, user, pass);
}

/**
 * Get email signature
 */
export function getSignature(): string {
  try {
    if (fs.existsSync(SIGNATURE_FILE)) {
      return fs.readFileSync(SIGNATURE_FILE, 'utf-8');
    }
  } catch {}
  return '';
}

/**
 * Save email signature
 */
export function saveSignature(signature: string): void {
  const dir = path.dirname(SIGNATURE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SIGNATURE_FILE, signature, 'utf-8');
}

/**
 * Send a system alert email (from noreply@)
 */
export async function sendSystemAlert(to: string[], subject: string, htmlBody: string, textBody?: string): Promise<void> {
  await sendEmail({
    from: `noreply@${getMailDomain()}`,
    to: to.map(email => ({ email })),
    subject: `[BridgesLLM] ${subject}`,
    htmlBody,
    textBody: textBody || htmlBody.replace(/<[^>]+>/g, ''),
  });
}

/**
 * Get unread count for badge display (for a specific account)
 */
export async function getUnreadCount(user: string, pass: string): Promise<number> {
  try {
    const mailboxes = await getMailboxes(user, pass);
    const inbox = mailboxes.find(m => m.role === 'inbox');
    return inbox?.unreadEmails || 0;
  } catch {
    return 0;
  }
}
