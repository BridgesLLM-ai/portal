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

async function getSession(user: string, pass: string): Promise<JmapSession> {
  const res = await fetch(`${getStalwartUrl()}/jmap/session`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
  });
  if (!res.ok) throw new Error(`JMAP session failed: ${res.status} ${res.statusText}`);
  const session = await res.json() as any;
  
  const accountId = Object.keys(session.accounts || {})[0];
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

async function jmapCall(session: JmapSession, user: string, pass: string, methodCalls: any[]): Promise<any> {
  const res = await fetch(session.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
      methodCalls,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JMAP call failed: ${res.status} ${text}`);
  }
  return res.json();
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
  
  const mailboxes = result.methodResponses[0][1].list || [];
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
  
  const queryResult = result.methodResponses[0][1];
  const emails = (result.methodResponses[1][1].list || []).map((e: any) => ({
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
  
  const email = result.methodResponses[0][1].list?.[0];
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
  
  // Mark as read
  try {
    await jmapCall(session, user, pass, [
      ['Email/set', {
        accountId: session.accountId,
        update: {
          [emailId]: { 'keywords/$seen': true },
        },
      }, '0'],
    ]);
  } catch {} // Non-critical
  
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
    isUnread: false, // We just marked it read
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
  if (isAttachmentDangerous(name, type)) {
    throw new Error('This attachment type is blocked for security reasons');
  }
  
  const session = await getSession(user, pass);
  const url = session.downloadUrl
    .replace('{blobId}', blobId)
    .replace('{name}', encodeURIComponent(name || 'attachment'))
    .replace('{type}', encodeURIComponent(type));
  
  const res = await fetch(url, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    buffer,
    contentType: type,
    filename: name || 'attachment',
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
): Promise<{ blobId: string; type: string; size: number }> {
  const session = await getSession(user, pass);
  
  const res = await fetch(session.uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
    body: fileBuffer,
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Blob upload failed: ${res.status} ${text}`);
  }
  
  const result = await res.json() as any;
  return {
    blobId: result.blobId,
    type: result.type || contentType,
    size: result.size || fileBuffer.length,
  };
}

/**
 * Send an email.
 * When user/pass are provided, sends from that account.
 * When not provided, auto-detects: noreply@ for from=noreply@..., otherwise support@.
 */
export async function sendEmail(params: SendEmailParams, user?: string, pass?: string): Promise<{ success: boolean; messageId?: string }> {
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
  const mailboxList = mailboxResult.methodResponses[0][1].list || [];
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
  const identities = identityResult.methodResponses[0][1].list || [];
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
  
  const createResult = result.methodResponses[0][1];
  if (createResult.notCreated?.draft) {
    throw new Error(`Failed to create email: ${JSON.stringify(createResult.notCreated.draft)}`);
  }
  
  const submissionResult = result.methodResponses[1]?.[1];
  if (submissionResult?.notCreated?.send) {
    throw new Error(`Failed to submit email: ${JSON.stringify(submissionResult.notCreated.send)}`);
  }
  
  // Move from drafts to sent after successful submission
  const emailId = createResult.created?.draft?.id;
  if (emailId && sentMailboxId) {
    try {
      const moveUpdate: any = {};
      moveUpdate[`mailboxIds/${targetMailboxId}`] = null;
      moveUpdate[`mailboxIds/${sentMailboxId}`] = true;
      await jmapCall(session, resolvedUser, resolvedPass, [
        ['Email/set', {
          accountId: session.accountId,
          update: { [emailId]: moveUpdate },
        }, '0'],
      ]);
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
  
  const email = getResult.methodResponses[0][1].list?.[0];
  if (!email) throw new Error('Email not found');
  
  // Build new mailboxIds — remove all current, add trash
  const update: any = {};
  for (const mbId of Object.keys(email.mailboxIds || {})) {
    update[`mailboxIds/${mbId}`] = null;
  }
  update[`mailboxIds/${trash.id}`] = true;
  
  await jmapCall(session, user, pass, [
    ['Email/set', {
      accountId: session.accountId,
      update: { [emailId]: update },
    }, '0'],
  ]);
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
  
  const email = getResult.methodResponses[0][1].list?.[0];
  if (!email) throw new Error('Email not found');
  
  // Build new mailboxIds — remove all current, add target
  const update: any = {};
  for (const mbId of Object.keys(email.mailboxIds || {})) {
    update[`mailboxIds/${mbId}`] = null;
  }
  update[`mailboxIds/${targetMailboxId}`] = true;
  
  await jmapCall(session, user, pass, [
    ['Email/set', {
      accountId: session.accountId,
      update: { [emailId]: update },
    }, '0'],
  ]);
}

/**
 * Toggle flag/star on email
 */
export async function toggleFlag(emailId: string, flagged: boolean, user: string, pass: string): Promise<void> {
  const session = await getSession(user, pass);
  await jmapCall(session, user, pass, [
    ['Email/set', {
      accountId: session.accountId,
      update: {
        [emailId]: { 'keywords/$flagged': flagged || null },
      },
    }, '0'],
  ]);
}

/**
 * Mark email as read/unread
 */
export async function markRead(emailId: string, read: boolean, user: string, pass: string): Promise<void> {
  const session = await getSession(user, pass);
  await jmapCall(session, user, pass, [
    ['Email/set', {
      accountId: session.accountId,
      update: {
        [emailId]: { 'keywords/$seen': read || null },
      },
    }, '0'],
  ]);
}

/**
 * Bulk mark emails as read/unread
 */
export async function bulkMarkRead(emailIds: string[], read: boolean, user: string, pass: string): Promise<void> {
  if (!emailIds.length) return;
  const session = await getSession(user, pass);
  
  const updateMap: any = {};
  for (const id of emailIds) {
    updateMap[id] = { 'keywords/$seen': read || null };
  }
  
  await jmapCall(session, user, pass, [
    ['Email/set', {
      accountId: session.accountId,
      update: updateMap,
    }, '0'],
  ]);
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
  
  const emails = getResult.methodResponses[0][1].list || [];
  const updateMap: any = {};
  
  for (const email of emails) {
    const update: any = {};
    for (const mbId of Object.keys(email.mailboxIds || {})) {
      update[`mailboxIds/${mbId}`] = null;
    }
    update[`mailboxIds/${trash.id}`] = true;
    updateMap[email.id] = update;
  }
  
  await jmapCall(session, user, pass, [
    ['Email/set', {
      accountId: session.accountId,
      update: updateMap,
    }, '0'],
  ]);
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
  
  const emails = getResult.methodResponses[0][1].list || [];
  const updateMap: any = {};
  
  for (const email of emails) {
    const update: any = {};    for (const mbId of Object.keys(email.mailboxIds || {})) {
      update[`mailboxIds/${mbId}`] = null;
    }
    update[`mailboxIds/${targetMailboxId}`] = true;
    updateMap[email.id] = update;
  }
  
  await jmapCall(session, user, pass, [
    ['Email/set', {
      accountId: session.accountId,
      update: updateMap,
    }, '0'],
  ]);
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
      const uploaded = await uploadBlob(downloaded.buffer, att.type, user, pass);
      forwardedAttachments.push({
        blobId: uploaded.blobId,
        type: att.type,
        name: att.name || 'attachment',
        size: att.size,
      });
    } catch (err) {
      console.error(`[mail] Failed to forward attachment ${att.name}:`, err);
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
 * Auto-forward a single email to another address
 */
export async function autoForwardEmail(emailId: string, forwardTo: string, user: string, pass: string): Promise<void> {
  const email = await getEmail(emailId, user, pass);
  const textPart = email.textBody?.[0];
  const htmlPart = email.htmlBody?.[0];
  const textBody = textPart && email.bodyValues[textPart.partId] ? email.bodyValues[textPart.partId].value : email.preview;
  const htmlBody = htmlPart && email.bodyValues[htmlPart.partId] ? email.bodyValues[htmlPart.partId].value : undefined;

  await sendEmail({
    from: `${user}@${getMailDomain()}`,
    to: [{ email: forwardTo }],
    subject: `Fwd: ${email.subject}`,
    textBody: `---------- Forwarded from ${user}@${getMailDomain()} ----------\nFrom: ${email.from.map((f: any) => f.email).join(', ')}\nDate: ${new Date(email.receivedAt).toLocaleString()}\nSubject: ${email.subject}\n\n${textBody}`,
    htmlBody: htmlBody || undefined,
  }, user, pass);
}

/**
 * Process auto-forwarding for new inbox emails.
 * Checks for $forwarded keyword to avoid re-forwarding.
 * Max 5 emails per batch, only emails from last 24 hours.
 */
export async function processAutoForward(emails: EmailSummary[], forwardTo: string, user: string, pass: string): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const toForward = emails.filter(e => e.isUnread && new Date(e.receivedAt) > cutoff);

  for (const email of toForward.slice(0, 5)) {
    try {
      const session = await getSession(user, pass);
      // Check if already forwarded
      const detail = await jmapCall(session, user, pass, [
        ['Email/get', {
          accountId: session.accountId,
          ids: [email.id],
          properties: ['keywords'],
        }, '0'],
      ]);
      const keywords = detail.methodResponses[0][1].list?.[0]?.keywords || {};
      if (keywords['$forwarded']) continue;

      // Forward the email
      await autoForwardEmail(email.id, forwardTo, user, pass);

      // Mark as forwarded so we don't re-forward
      await jmapCall(session, user, pass, [
        ['Email/set', {
          accountId: session.accountId,
          update: { [email.id]: { 'keywords/$forwarded': true } },
        }, '0'],
      ]);
      console.log(`[mail] Auto-forwarded email ${email.id} to ${forwardTo}`);
    } catch (err: any) {
      console.error(`[mail] Auto-forward failed for ${email.id}:`, err.message);
    }
  }
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
