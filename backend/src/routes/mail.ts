/**
 * Mail Routes — Email inbox and management for portal
 * 
 * All routes require authentication. Per-user mail accounts are supported.
 * Admins can switch between personal, support, and noreply accounts.
 * Rate limited on send operations.
 */

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { getUserMailAccounts, getUserMailCredentials } from '../services/userMailService';
import { prisma } from '../config/database';
import sanitizeHtmlLib from 'sanitize-html';
import { isElevatedRole } from '../utils/authz';
import { scanBuffer } from '../services/virusScan';
import {
  getMailboxes,
  listEmails,
  getEmail,
  downloadAttachment,
  uploadBlob,
  sendEmail,
  trashEmail,
  moveEmail,
  toggleFlag,
  markRead,
  bulkMarkRead,
  bulkTrash,
  bulkMove,
  forwardEmail,
  getSignature,
  saveSignature,
  getUnreadCount,
  syncAutoForwardRule,
  MAX_MAIL_ATTACHMENT_BYTES,
  normalizeAttachmentName,
  normalizeContentType,
} from '../services/mailService';
import { ensureToolMirror, getUserUploadDir, removeToolMirror } from './files';
import { comparePassword } from '../utils/password';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';
import {
  normalizeMailListRequest,
  normalizeMailSearchQuery,
  validateMailSignaturePayload,
} from '../services/mailRequestPolicy';
import { config } from '../config/env';
import {
  issueMailAttachmentCapabilityToken,
  verifyMailAttachmentCapabilityToken,
} from '../services/mailAttachmentCapability';
import { portalFeatureUnavailableResponse } from '../utils/portalFeatureCapabilities';

const router = Router();

const credentialRevealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip || 'unknown',
  message: { error: 'Too many credential reveal attempts. Try again later.' },
});

// Setup can provision mail after this router is imported. Read mutable mail
// configuration at request time so the first post-install test does not use
// the empty values captured during process startup.
function getStalwartSupportUser() { return process.env.STALWART_SUPPORT_USER || 'support'; }
function getStalwartSupportPass() { return process.env.STALWART_SUPPORT_PASS || ''; }
function getStalwartNoreplyUser() { return process.env.STALWART_NOREPLY_USER || 'noreply'; }
function getStalwartNoreplyPass() { return process.env.STALWART_NOREPLY_PASS || ''; }
function getExtraSharedMailAccountId() { return process.env.EXTRA_SHARED_MAIL_ACCOUNT_ID || ''; }
function getExtraSharedMailLabel() { return process.env.EXTRA_SHARED_MAIL_LABEL || 'Shared Mailbox'; }
function getExtraSharedMailAuthPath() { return process.env.EXTRA_SHARED_MAIL_AUTH_PATH || ''; }
function getMailDomain() { return process.env.MAIL_DOMAIN || 'localhost'; }

const MAIL_UPLOAD_DIR = path.join(os.tmpdir(), 'bridgesllm-mail-attachments');

function initializeMailUploadStorage(): string {
  return ensureRuntimeDirectory(MAIL_UPLOAD_DIR, { mode: 0o700, enforceMode: true });
}

// Mail uploads land on disk first so a multipart request cannot allocate the
// aggregate attachment set in the Portal heap. The handler applies the 25 MB
// message-wide ceiling before reading and scanning files one at a time.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      try {
        callback(null, initializeMailUploadStorage());
      } catch (error: any) {
        callback(error, MAIL_UPLOAD_DIR);
      }
    },
    filename: (_req, _file, callback) => callback(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}`),
  }),
  limits: {
    fileSize: MAX_MAIL_ATTACHMENT_BYTES,
    files: 5,
    fields: 1,
    fieldSize: 512 * 1024,
  },
});

function getUploadedMailFiles(req: Request): Express.Multer.File[] {
  return (req.files as Express.Multer.File[]) || [];
}

function cleanupUploadedMailFiles(req: Request): void {
  for (const file of getUploadedMailFiles(req)) {
    if (!file.path || path.dirname(file.path) !== MAIL_UPLOAD_DIR) continue;
    try { fs.unlinkSync(file.path); } catch {}
  }
}

function validateUploadSet(files: Express.Multer.File[]): string | null {
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  if (totalBytes > MAX_MAIL_ATTACHMENT_BYTES) {
    return 'Attachments exceed the 25 MB total message limit';
  }
  return null;
}

function parseMailUploads(req: Request, res: Response, next: NextFunction): void {
  upload.array('attachments', 5)(req, res, (error: any) => {
    if (!error) {
      next();
      return;
    }
    cleanupUploadedMailFiles(req);
    if (error instanceof multer.MulterError) {
      res.status(413).json({ error: 'Mail attachments exceed the allowed file, count, or form-size limit' });
      return;
    }
    next(error);
  });
}

const MAX_MAIL_BODY_CHARS = 2 * 1024 * 1024;
const MAX_MAIL_RECIPIENTS = 100;

function parseMultipartData(req: Request): Record<string, any> | null {
  if (!req.is('multipart/form-data')) return req.body || {};
  try {
    const parsed = JSON.parse(typeof req.body?.data === 'string' ? req.body.data : '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validateRecipients(...groups: Array<any[] | undefined>): string | null {
  const recipients = groups.flatMap(group => Array.isArray(group) ? group : []);
  if (!recipients.length) return 'Recipients (to) required';
  if (recipients.length > MAX_MAIL_RECIPIENTS) return `A message can have at most ${MAX_MAIL_RECIPIENTS} recipients`;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const recipient of recipients) {
    if (
      !recipient
      || typeof recipient !== 'object'
      || typeof recipient.email !== 'string'
      || recipient.email.length > 320
      || !emailRegex.test(recipient.email)
      || (recipient.name !== undefined && (typeof recipient.name !== 'string' || recipient.name.length > 200))
    ) {
      return 'One or more recipient addresses are invalid';
    }
  }
  return null;
}

function validateOptionalIdList(value: unknown): value is string[] | undefined {
  return value === undefined || (
    Array.isArray(value)
    && value.length <= 100
    && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 998)
  );
}

function mailClientSettings(username: string) {
  const domain = getMailDomain();
  return {
    username,
    email: `${username}@${domain}`,
    imap: {
      server: `mail.${domain}`,
      port: 993,
      security: 'SSL/TLS',
    },
    smtp: {
      server: `mail.${domain}`,
      port: 587,
      security: 'STARTTLS',
    },
  };
}

function validateRequiredIdList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 200
    && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 512);
}

function attachmentCapabilityFromHeader(req: Request): string {
  return String(req.get('x-mail-attachment-capability') || '').trim();
}

function setAttachmentDownloadHeaders(res: Response, contentType: string, filename: string): void {
  const fallbackName = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 180) || 'attachment';
  const encodedName = encodeURIComponent(filename)
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

async function requireCleanAttachment(
  req: Request,
  res: Response,
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<boolean> {
  const scanResult = await scanBuffer(buffer, filename);
  if (scanResult.clean) return true;

  await prisma.activityLog.create({
    data: {
      userId: req.user!.userId,
      action: scanResult.scannerAvailable ? 'MALWARE_BLOCKED' : 'MAIL_ATTACHMENT_SCAN_UNAVAILABLE',
      resource: 'mail',
      severity: scanResult.scannerAvailable ? 'CRITICAL' : 'WARNING',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      translatedMessage: scanResult.scannerAvailable
        ? `🦠 Malware blocked: "${filename}" — ${scanResult.threat}`
        : `Mail attachment delivery blocked because scanning was unavailable: "${filename}"`,
      metadata: {
        filename,
        threat: scanResult.threat || null,
        contentType,
        scannerAvailable: scanResult.scannerAvailable,
      },
    },
  }).catch(() => undefined);
  res.status(scanResult.scannerAvailable ? 400 : 503).json({
    error: scanResult.scannerAvailable
      ? `Attachment rejected: malware detected (${scanResult.threat || 'threat detected'})`
      : 'Attachment delivery is temporarily unavailable because malware scanning could not complete',
  });
  return false;
}

// All mail routes require interactive portal access
router.use(authenticateToken, requireApproved, (req: Request, res: Response, next: NextFunction) => {
  const unavailable = portalFeatureUnavailableResponse('mail');
  if (unavailable) {
    res.status(409).json(unavailable);
    return;
  }
  const account = req.query.account;
  if (account !== undefined && (typeof account !== 'string' || account.length < 1 || account.length > 512)) {
    res.status(400).json({ error: 'Mail account selector is invalid' });
    return;
  }
  next();
});

router.param('id', (_req: Request, res: Response, next: NextFunction, value: string) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    res.status(400).json({ error: 'Message identifier is invalid' });
    return;
  }
  next();
});

// ── Account Resolution ────────────────────────────────────────

interface ResolvedAccount {
  user: string;
  pass: string;
  email: string;
}

interface SharedMailCredentials {
  user: string;
  pass: string;
  email: string;
}

function getRequestedAccountId(req: Request): string | undefined {
  const accountParam = typeof req.query.account === 'string' ? req.query.account : '';
  return accountParam || undefined;
}

function readExtraSharedMailCredentials(): SharedMailCredentials | null {
  const authPath = getExtraSharedMailAuthPath();
  if (!authPath) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const user = typeof raw.user === 'string' ? raw.user.trim() : '';
    const pass = typeof raw.pass === 'string' ? raw.pass : '';
    const email = typeof raw.email === 'string' && raw.email.trim()
      ? raw.email.trim()
      : `${getExtraSharedMailAccountId() || user}@${getMailDomain()}`;
    if (!user || !pass) return null;
    return { user, pass, email };
  } catch {
    return null;
  }
}

function isSharedMailboxAccount(accountId?: string): boolean {
  const extraSharedAccountId = getExtraSharedMailAccountId();
  return accountId === 'support'
    || accountId === 'noreply'
    || (!!extraSharedAccountId && accountId === extraSharedAccountId);
}

async function getSelectedPersonalMailboxCredentials(req: Request) {
  const accountId = getRequestedAccountId(req);
  if (isSharedMailboxAccount(accountId)) {
    return null;
  }
  return getUserMailCredentials(req.user!.userId, accountId);
}

/**
 * Resolve which Stalwart account to use for a request.
 * - ?account=support, ?account=noreply, or an optional extra shared mailbox → elevated users only
 * - Default: user's personal mailbox
 * - If user has no mailbox, returns 'no_mailbox' string
 */
async function resolveAccount(req: Request): Promise<ResolvedAccount | null | 'no_mailbox'> {
  const accountParam = getRequestedAccountId(req) || '';
  const isAdmin = isElevatedRole(req.user?.role);

  if (accountParam === 'support') {
    return isAdmin ? { user: getStalwartSupportUser(), pass: getStalwartSupportPass(), email: `support@${getMailDomain()}` } : null;
  }
  if (accountParam === 'noreply') {
    return isAdmin ? { user: getStalwartNoreplyUser(), pass: getStalwartNoreplyPass(), email: `noreply@${getMailDomain()}` } : null;
  }
  if (getExtraSharedMailAccountId() && accountParam === getExtraSharedMailAccountId()) {
    const extraSharedMailbox = readExtraSharedMailCredentials();
    return isAdmin && extraSharedMailbox ? extraSharedMailbox : null;
  }

  const creds = await getSelectedPersonalMailboxCredentials(req);
  if (!creds) return 'no_mailbox';

  return { user: creds.username, pass: creds.password, email: `${creds.username}@${getMailDomain()}` };
}

// ── Rate limiting for send operations ─────────────────────────
const sendTimestampsByPrincipal = new Map<string, number[]>();
const SEND_RATE_LIMIT = 20;
const SEND_RATE_WINDOW = 60 * 60 * 1000;

function consumeSendRateLimit(principal: string): boolean {
  const now = Date.now();
  for (const [key, timestamps] of sendTimestampsByPrincipal) {
    while (timestamps.length && timestamps[0] < now - SEND_RATE_WINDOW) timestamps.shift();
    if (!timestamps.length) sendTimestampsByPrincipal.delete(key);
  }
  const timestamps = sendTimestampsByPrincipal.get(principal) || [];
  if (timestamps.length >= SEND_RATE_LIMIT) return false;
  timestamps.push(now);
  sendTimestampsByPrincipal.set(principal, timestamps);
  return true;
}

// ── GET /api/mail/accounts ────────────────────────────────────
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const isAdmin = isElevatedRole(req.user?.role);
    const personalAccounts = await getUserMailAccounts(req.user!.userId);

    const accounts: { id: string; label: string; email: string; isPrimary?: boolean; kind: 'personal' | 'shared' }[] = [];

    for (const account of personalAccounts) {
      accounts.push({
        id: account.id,
        label: account.username,
        email: `${account.username}@${getMailDomain()}`,
        isPrimary: account.isPrimary,
        kind: 'personal',
      });
    }
    
    if (isAdmin) {
      const extraSharedMailbox = readExtraSharedMailCredentials();
      accounts.push(
        { id: 'support', label: 'Shared Support', email: `support@${getMailDomain()}`, kind: 'shared' },
        { id: 'noreply', label: 'Shared No-Reply', email: `noreply@${getMailDomain()}`, kind: 'shared' },
      );
      if (getExtraSharedMailAccountId() && extraSharedMailbox) {
        accounts.push({ id: getExtraSharedMailAccountId(), label: getExtraSharedMailLabel(), email: extraSharedMailbox.email, kind: 'shared' });
      }
    }
    
    res.json({ accounts, hasMailbox: personalAccounts.length > 0 });
  } catch (error: any) {
    console.error('[mail] getAccounts error:', error.message);
    res.status(500).json({ error: 'Failed to get accounts' });
  }
});

// ── GET /api/mail/mailboxes ───────────────────────────────────
router.get('/mailboxes', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox') {
      res.json({ error: 'no_mailbox', message: 'No mailbox is provisioned for this account yet', mailboxes: [] });
      return;
    }
    if (!account) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const mailboxes = await getMailboxes(account.user, account.pass);
    res.json({ mailboxes });
  } catch (error: any) {
    console.error('[mail] getMailboxes error:', error.message);
    res.status(500).json({ error: 'Failed to fetch mailboxes' });
  }
});

// ── GET /api/mail/unread ──────────────────────────────────────
router.get('/unread', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox') {
      res.json({ unread: 0, available: false, reason: 'no_mailbox' });
      return;
    }
    if (!account) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const count = await getUnreadCount(account.user, account.pass);
    res.json({ unread: count, available: true });
  } catch (error: any) {
    console.error('[mail] getUnreadCount error:', error.message);
    res.status(503).json({ error: 'Unread count is temporarily unavailable' });
  }
});

// ── GET /api/mail/messages ────────────────────────────────────
router.get('/messages', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox') {
      res.json({ error: 'no_mailbox', message: 'No mailbox is provisioned for this account yet', emails: [], total: 0, position: 0 });
      return;
    }
    if (!account) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { mailboxId, mailboxRole } = req.query;
    if (
      (mailboxId !== undefined && (typeof mailboxId !== 'string' || mailboxId.length > 512))
      || (mailboxRole !== undefined && (typeof mailboxRole !== 'string' || mailboxRole.length > 100))
    ) {
      res.status(400).json({ error: 'Mailbox selector is invalid' });
      return;
    }
    let pagination;
    let query;
    try {
      pagination = normalizeMailListRequest(req.query as Record<string, unknown>);
      query = normalizeMailSearchQuery(req.query.query);
    } catch (error: any) {
      res.status(400).json({ error: error?.message || 'Mail pagination is invalid' });
      return;
    }
    const effectiveRole = (mailboxRole as string) || 'inbox';
    const result = await listEmails(account.user, account.pass, {
      mailboxId: mailboxId as string,
      mailboxRole: effectiveRole,
      query,
      ...pagination,
    });
    res.json(result);
  } catch (error: any) {
    console.error('[mail] listEmails error:', error.message);
    res.status(500).json({ error: 'Failed to list emails' });
  }
});

// ── GET /api/mail/messages/:id ────────────────────────────────
router.get('/messages/:id', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    const email = await getEmail(req.params.id, account.user, account.pass);
    const attachments = email.attachments.map((attachment) => {
      const filename = normalizeAttachmentName(attachment.name);
      const contentType = normalizeContentType(attachment.type);
      return {
        ...attachment,
        name: filename,
        type: contentType,
        downloadToken: attachment.isDangerous
          ? null
          : issueMailAttachmentCapabilityToken({
              actorId: req.user!.userId,
              accountUser: account.user,
              blobId: attachment.blobId,
              filename,
              contentType,
            }, config.jwtSecret),
      };
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ...email, attachments });
  } catch (error: any) {
    console.error('[mail] getEmail error:', error.message);
    res.status(500).json({ error: 'Failed to fetch email' });
  }
});

// ── GET /api/mail/attachments/:blobId ─────────────────────────
router.get('/attachments/:blobId', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    const verified = verifyMailAttachmentCapabilityToken(
      attachmentCapabilityFromHeader(req),
      {
        actorId: req.user!.userId,
        accountUser: account.user,
        blobId: req.params.blobId,
      },
      config.jwtSecret,
    );
    if (!verified) {
      res.status(403).json({ error: 'Attachment authorization is invalid or expired. Refresh the message and try again.' });
      return;
    }
    const result = await downloadAttachment(
      req.params.blobId,
      verified.filename,
      verified.contentType,
      account.user,
      account.pass,
    );
    if (!(await requireCleanAttachment(req, res, result.buffer, result.filename, result.contentType))) return;
    setAttachmentDownloadHeaders(res, result.contentType, result.filename);
    res.send(result.buffer);
  } catch (error: any) {
    console.error('[mail] downloadAttachment error:', error.message);
    if (error.message.includes('blocked')) {
      res.status(403).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Failed to download attachment' });
    }
  }
});

// ── POST /api/mail/send ───────────────────────────────────────
router.post('/send', parseMailUploads, async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox configured' });
      return;
    }

    const data = parseMultipartData(req);
    if (!data) {
      res.status(400).json({ error: 'Invalid mail request data' });
      return;
    }
    const { to, cc, bcc, subject, textBody, htmlBody, inReplyTo, references } = data;
    const recipientError = validateRecipients(to, cc, bcc);
    if (!Array.isArray(to) || to.length === 0 || recipientError) {
      res.status(400).json({ error: recipientError || 'Recipients (to) required' });
      return;
    }
    if (typeof subject !== 'string' || subject.trim().length === 0 || subject.length > 998) {
      res.status(400).json({ error: 'Subject must be between 1 and 998 characters' });
      return;
    }
    if (
      (textBody !== undefined && typeof textBody !== 'string')
      || (htmlBody !== undefined && typeof htmlBody !== 'string')
      || (typeof textBody === 'string' && textBody.length > MAX_MAIL_BODY_CHARS)
      || (typeof htmlBody === 'string' && htmlBody.length > MAX_MAIL_BODY_CHARS)
    ) {
      res.status(400).json({ error: 'Email body is invalid or exceeds the 2 MB limit' });
      return;
    }
    if (!textBody && !htmlBody) {
      res.status(400).json({ error: 'Email body required' });
      return;
    }
    if (!validateOptionalIdList(inReplyTo) || !validateOptionalIdList(references)) {
      res.status(400).json({ error: 'Mail threading identifiers are invalid' });
      return;
    }
    
    const uploadedAttachments: { blobId: string; type: string; name: string; size: number }[] = [];
    const files = getUploadedMailFiles(req);
    const uploadSetError = validateUploadSet(files);
    if (uploadSetError) {
      res.status(413).json({ error: uploadSetError });
      return;
    }
    if (!consumeSendRateLimit(`${req.user!.userId}:${account.user}`)) {
      res.status(429).json({ error: 'Rate limit exceeded. Max 20 emails per hour.' });
      return;
    }
    for (const file of files) {
      const fileBuffer = await fs.promises.readFile(file.path);
      const uploaded = await uploadBlob(fileBuffer, file.mimetype, account.user, account.pass, file.originalname);
      uploadedAttachments.push({
        blobId: uploaded.blobId,
        type: file.mimetype,
        name: file.originalname,
        size: file.size,
      });
    }
    
    const result = await sendEmail({
      from: account.email,
      to, cc, bcc, subject, textBody, htmlBody, inReplyTo, references,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    }, account.user, account.pass);
    res.json(result);
  } catch (error: any) {
    console.error('[mail] sendEmail error:', error.message);
    res.status(500).json({ error: 'Failed to send email' });
  } finally {
    cleanupUploadedMailFiles(req);
  }
});

// ── POST /api/mail/forward ────────────────────────────────────
router.post('/forward', parseMailUploads, async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox configured' });
      return;
    }

    const data = parseMultipartData(req);
    if (!data) {
      res.status(400).json({ error: 'Invalid mail request data' });
      return;
    }
    const { originalId, to, cc, bcc } = data;
    const body = data.body || '';
    if (typeof originalId !== 'string' || originalId.length === 0 || originalId.length > 512) {
      res.status(400).json({ error: 'originalId is invalid' });
      return;
    }
    const recipientError = validateRecipients(to, cc, bcc);
    if (!Array.isArray(to) || to.length === 0 || recipientError) {
      res.status(400).json({ error: recipientError || 'Recipients (to) required' });
      return;
    }
    if (typeof body !== 'string' || body.length > MAX_MAIL_BODY_CHARS) {
      res.status(400).json({ error: 'Forward body is invalid or exceeds the 2 MB limit' });
      return;
    }
    
    const additionalAttachments: { blobId: string; type: string; name: string; size: number }[] = [];
    const files = getUploadedMailFiles(req);
    const uploadSetError = validateUploadSet(files);
    if (uploadSetError) {
      res.status(413).json({ error: uploadSetError });
      return;
    }
    if (!consumeSendRateLimit(`${req.user!.userId}:${account.user}`)) {
      res.status(429).json({ error: 'Rate limit exceeded. Max 20 emails per hour.' });
      return;
    }
    for (const file of files) {
      const fileBuffer = await fs.promises.readFile(file.path);
      const uploaded = await uploadBlob(fileBuffer, file.mimetype, account.user, account.pass, file.originalname);
      additionalAttachments.push({
        blobId: uploaded.blobId,
        type: file.mimetype,
        name: file.originalname,
        size: file.size,
      });
    }
    
    const result = await forwardEmail(
      originalId, to, cc, bcc, body,
      account.user, account.pass,
      additionalAttachments.length > 0 ? additionalAttachments : undefined
    );
    res.json(result);
  } catch (error: any) {
    console.error('[mail] forwardEmail error:', error.message);
    res.status(500).json({ error: 'Failed to forward email' });
  } finally {
    cleanupUploadedMailFiles(req);
  }
});

// ── POST /api/mail/messages/:id/trash ─────────────────────────
router.post('/messages/:id/trash', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    await trashEmail(req.params.id, account.user, account.pass);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[mail] trashEmail error:', error.message);
    res.status(500).json({ error: 'Failed to trash email' });
  }
});

// ── POST /api/mail/messages/:id/move ──────────────────────────
router.post('/messages/:id/move', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    const { targetMailboxId } = req.body;
    if (typeof targetMailboxId !== 'string' || targetMailboxId.length === 0 || targetMailboxId.length > 512) {
      res.status(400).json({ error: 'targetMailboxId is invalid' });
      return;
    }
    await moveEmail(req.params.id, targetMailboxId, account.user, account.pass);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[mail] moveEmail error:', error.message);
    res.status(500).json({ error: 'Failed to move email' });
  }
});

// ── POST /api/mail/messages/:id/flag ──────────────────────────
router.post('/messages/:id/flag', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    const { flagged } = req.body;
    if (typeof flagged !== 'boolean') {
      res.status(400).json({ error: 'flagged must be a boolean' });
      return;
    }
    await toggleFlag(req.params.id, flagged, account.user, account.pass);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[mail] toggleFlag error:', error.message);
    res.status(500).json({ error: 'Failed to toggle flag' });
  }
});

// ── POST /api/mail/messages/:id/read ──────────────────────────
router.post('/messages/:id/read', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    const { read } = req.body;
    if (typeof read !== 'boolean') {
      res.status(400).json({ error: 'read must be a boolean' });
      return;
    }
    await markRead(req.params.id, read, account.user, account.pass);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[mail] markRead error:', error.message);
    res.status(500).json({ error: 'Failed to update read status' });
  }
});

// ── POST /api/mail/bulk/read ──────────────────────────────────
router.post('/bulk/read', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    const { emailIds, read } = req.body;
    if (!validateRequiredIdList(emailIds)) {
      res.status(400).json({ error: 'emailIds must contain 1–200 valid IDs' });
      return;
    }
    if (typeof read !== 'boolean') {
      res.status(400).json({ error: 'read must be a boolean' });
      return;
    }
    await bulkMarkRead(emailIds, read, account.user, account.pass);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[mail] bulkMarkRead error:', error.message);
    res.status(500).json({ error: 'Failed to bulk update read status' });
  }
});

// ── POST /api/mail/bulk/trash ─────────────────────────────────
router.post('/bulk/trash', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    const { emailIds } = req.body;
    if (!validateRequiredIdList(emailIds)) {
      res.status(400).json({ error: 'emailIds must contain 1–200 valid IDs' });
      return;
    }
    await bulkTrash(emailIds, account.user, account.pass);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[mail] bulkTrash error:', error.message);
    res.status(500).json({ error: 'Failed to bulk trash' });
  }
});

// ── POST /api/mail/bulk/move ──────────────────────────────────
router.post('/bulk/move', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }
    const { emailIds, targetMailboxId } = req.body;
    if (!validateRequiredIdList(emailIds)) {
      res.status(400).json({ error: 'emailIds must contain 1–200 valid IDs' });
      return;
    }
    if (typeof targetMailboxId !== 'string' || targetMailboxId.length === 0 || targetMailboxId.length > 512) {
      res.status(400).json({ error: 'targetMailboxId is invalid' });
      return;
    }
    await bulkMove(emailIds, targetMailboxId, account.user, account.pass);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[mail] bulkMove error:', error.message);
    res.status(500).json({ error: 'Failed to bulk move' });
  }
});

// ── GET /api/mail/signature ───────────────────────────────────
router.get('/signature', async (req: Request, res: Response) => {
  try {
    const accountParam = (req.query.account as string) || '';
    const creds = await getUserMailCredentials(req.user!.userId, accountParam || undefined);
    
    if (!creds) {
      // Fallback to legacy global signature
      const legacySig = getSignature();
      res.json({ signature: legacySig, signatureHtml: '' });
      return;
    }

    const mailbox = await prisma.mailboxAccount.findFirst({
      where: { userId: req.user!.userId, id: creds.accountId },
      select: { signature: true, signatureHtml: true, username: true },
    });

    if (mailbox?.signature || mailbox?.signatureHtml) {
      res.json({ 
        signature: mailbox.signature || '', 
        signatureHtml: mailbox.signatureHtml || '' 
      });
    } else {
      // Auto-generate default signature for first time
      const settings = await prisma.systemSetting.findFirst({ where: { key: 'portalName' } });
      const logoSetting = await prisma.systemSetting.findFirst({ where: { key: 'logoUrl' } });
      const portalName = settings?.value || 'BridgesLLM Portal';
      const logoUrl = logoSetting?.value || '';
      const email = `${mailbox?.username || creds.username}@${getMailDomain()}`;
      const displayName = mailbox?.username || creds.username;

      const defaultText = `${displayName}\n${email}\n${portalName}`;
      const defaultHtml = generateDefaultSignatureHtml(displayName, email, portalName, logoUrl);
      
      res.json({ signature: defaultText, signatureHtml: defaultHtml });
    }
  } catch (error: any) {
    console.error('[mail] getSignature error:', error.message);
    res.status(500).json({ error: 'Failed to get signature' });
  }
});

// ── PUT /api/mail/signature ───────────────────────────────────
router.put('/signature', async (req: Request, res: Response) => {
  try {
    const { signature, signatureHtml } = req.body;
    const signatureError = validateMailSignaturePayload(signature, signatureHtml);
    if (signatureError) {
      res.status(400).json({ error: signatureError });
      return;
    }
    const accountParam = (req.query.account as string) || '';
    const creds = await getUserMailCredentials(req.user!.userId, accountParam || undefined);

    if (creds) {
      // Sanitize HTML signature to prevent XSS in outgoing emails
      const cleanHtml = signatureHtml ? sanitizeHtmlLib(signatureHtml, {
        allowedTags: sanitizeHtmlLib.defaults.allowedTags.concat([
          'img', 'h1', 'h2', 'span', 'div', 'center', 'font', 'u', 'hr', 'br',
          'table', 'thead', 'tbody', 'tr', 'td', 'th',
        ]),
        allowedAttributes: {
          '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'border', 'cellpadding', 'cellspacing'],
          'a': ['href', 'target', 'rel'],
          'img': ['src', 'alt', 'width', 'height'],
          'td': ['colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'style'],
          'font': ['color', 'face', 'size'],
        },
        allowedSchemes: ['http', 'https', 'mailto'],
      }) : null;

      await prisma.mailboxAccount.update({
        where: { id: creds.accountId },
        data: {
          signature: signature || null,
          signatureHtml: cleanHtml,
        },
      });
    } else {
      // Legacy fallback
      saveSignature(signature || '');
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[mail] saveSignature error:', error.message);
    res.status(500).json({ error: 'Failed to save signature' });
  }
});

// ── GET /api/mail/forward-settings ────────────────────────────
router.get('/forward-settings', async (req: Request, res: Response) => {
  try {
    const accountId = getRequestedAccountId(req);
    if (isSharedMailboxAccount(accountId)) {
      res.status(400).json({ error: 'Forward settings are only available for personal mailboxes' });
      return;
    }

    const creds = await getSelectedPersonalMailboxCredentials(req);
    if (!creds) {
      res.json({ autoForwardTo: null });
      return;
    }

    const mailbox = await prisma.mailboxAccount.findFirst({
      where: { id: creds.accountId },
      select: { autoForwardTo: true },
    });

    res.json({ autoForwardTo: mailbox?.autoForwardTo || null });
  } catch (error: any) {
    console.error('[mail] forward-settings get error:', error.message);
    res.status(500).json({ error: 'Failed to get forward settings' });
  }
});

// ── PUT /api/mail/forward-settings ────────────────────────────
router.put('/forward-settings', async (req: Request, res: Response) => {
  try {
    const accountId = getRequestedAccountId(req);
    if (isSharedMailboxAccount(accountId)) {
      res.status(400).json({ error: 'Forward settings are only available for personal mailboxes' });
      return;
    }

    const requestedForwardTo = typeof req.body?.autoForwardTo === 'string' ? req.body.autoForwardTo.trim() : '';
    const autoForwardTo = requestedForwardTo || null;
    const creds = await getSelectedPersonalMailboxCredentials(req);

    if (!creds) {
      res.status(400).json({ error: 'No mailbox configured' });
      return;
    }

    // Validate email format if provided
    if (autoForwardTo) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(autoForwardTo)) {
        res.status(400).json({ error: 'Invalid email address' });
        return;
      }
      // Don't allow forwarding to self (infinite loop)
      if (autoForwardTo.toLowerCase() === `${creds.username}@${getMailDomain()}`.toLowerCase()) {
        res.status(400).json({ error: 'Cannot forward to your own portal email' });
        return;
      }
    }

    const existingMailbox = await prisma.mailboxAccount.findUnique({
      where: { id: creds.accountId },
      select: { autoForwardTo: true },
    });
    await syncAutoForwardRule(autoForwardTo, creds.username, creds.password);

    try {
      await prisma.mailboxAccount.update({
        where: { id: creds.accountId },
        data: { autoForwardTo },
      });
    } catch (dbError) {
      await syncAutoForwardRule(existingMailbox?.autoForwardTo || null, creds.username, creds.password).catch((rollbackError) => {
        console.error('[mail] forward-settings rollback failed:', rollbackError.message);
      });
      throw dbError;
    }

    res.json({ success: true, autoForwardTo, deliveryMode: 'server-side-sieve' });
  } catch (error: any) {
    console.error('[mail] forward-settings put error:', error.message);
    res.status(500).json({ error: 'Failed to update forward settings' });
  }
});

// ── GET /api/mail/credentials ─────────────────────────────────
router.get('/credentials', async (req: Request, res: Response) => {
  try {
    const accountId = getRequestedAccountId(req);
    if (isSharedMailboxAccount(accountId)) {
      res.status(400).json({ error: 'Setup credentials are only available for personal mailboxes' });
      return;
    }

    const creds = await getSelectedPersonalMailboxCredentials(req);
    if (!creds) {
      res.status(404).json({ error: 'No mailbox configured' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.json({ ...mailClientSettings(creds.username), passwordRequired: true });
  } catch (error: any) {
    console.error('[mail] credentials error:', error.message);
    res.status(500).json({ error: 'Failed to get credentials' });
  }
});

// Revealing a reusable IMAP/SMTP password is materially more sensitive than
// opening the mailbox with the current Portal session. Require recent proof of
// the user's Portal password and never return the secret from a passive GET.
router.post('/credentials/reveal', credentialRevealLimiter, async (req: Request, res: Response) => {
  try {
    const accountId = getRequestedAccountId(req);
    if (isSharedMailboxAccount(accountId)) {
      res.status(400).json({ error: 'Setup credentials are only available for personal mailboxes' });
      return;
    }
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    if (!currentPassword || currentPassword.length > 256) {
      res.status(400).json({ error: 'Current Portal password is required' });
      return;
    }

    const [creds, user] = await Promise.all([
      getSelectedPersonalMailboxCredentials(req),
      prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: { passwordHash: true },
      }),
    ]);
    if (!creds) {
      res.status(404).json({ error: 'No mailbox configured' });
      return;
    }
    if (!user || !(await comparePassword(currentPassword, user.passwordHash))) {
      res.status(401).json({ error: 'Current Portal password is incorrect' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.json({ ...mailClientSettings(creds.username), password: creds.password });
  } catch (error: any) {
    console.error('[mail] credentials reveal error:', error.message);
    res.status(500).json({ error: 'Failed to reveal credentials' });
  }
});

// HTML-escape user-controlled strings to prevent XSS in signatures
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Helper function to generate default HTML signature
function generateDefaultSignatureHtml(name: string, email: string, portalName: string, logoUrl: string): string {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePortalName = escapeHtml(portalName);
  const safeLogoUrl = escapeHtml(logoUrl);
  const logoTag = safeLogoUrl 
    ? `<img src="${safeLogoUrl}" alt="${safePortalName}" style="height:40px;width:auto;margin-bottom:8px;" /><br/>`
    : '';
  
  return `<table cellpadding="0" cellspacing="0" border="0" style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#374151;line-height:1.5;">
  <tr>
    <td style="padding-right:16px;border-right:2px solid #8b5cf6;vertical-align:top;">
      ${logoTag}
    </td>
    <td style="padding-left:16px;vertical-align:top;">
      <div style="font-size:15px;font-weight:600;color:#111827;">${safeName}</div>
      <div style="color:#6b7280;font-size:12px;margin-top:2px;">${safePortalName}</div>
      <div style="margin-top:6px;">
        <a href="mailto:${safeEmail}" style="color:#8b5cf6;text-decoration:none;font-size:12px;">${safeEmail}</a>
      </div>
    </td>
  </tr>
</table>`;
}

// ── POST /api/mail/attachments/:blobId/save-to-files ──────────
const MAX_SAVE_SIZE = MAX_MAIL_ATTACHMENT_BYTES;

interface PersistMailAttachmentInput {
  userId: string;
  filename: string;
  contentType: string;
  buffer: Buffer;
  ipAddress?: string;
  userAgent?: string;
}

interface PersistMailAttachmentDependencies {
  createFile: (data: {
    userId: string;
    path: string;
    originalName: string;
    size: bigint;
    mimeType: string;
  }) => Promise<any>;
  deleteFile: (id: string) => Promise<unknown>;
  logActivity: (data: {
    userId: string;
    action: string;
    resource: string;
    resourceId: string;
    severity: 'INFO';
    ipAddress?: string;
    userAgent?: string;
  }) => Promise<unknown>;
  getUploadDir: (userId: string) => string;
  createToolMirror: (userId: string, sourcePath: string, fileName?: string) => string;
  deleteToolMirror: (userId: string, fileName: string) => void;
}

const defaultPersistMailAttachmentDependencies: PersistMailAttachmentDependencies = {
  createFile: (data) => prisma.file.create({ data }),
  deleteFile: (id) => prisma.file.delete({ where: { id } }),
  logActivity: (data) => prisma.activityLog.create({ data }),
  getUploadDir: getUserUploadDir,
  createToolMirror: ensureToolMirror,
  deleteToolMirror: removeToolMirror,
};

/**
 * Persist a verified mail attachment as one Portal file. Filesystem, database,
 * and OpenClaw media-mirror writes use compensating rollback so a partial
 * failure cannot leave an untracked attachment or a dangling File row.
 */
export async function persistMailAttachmentToFiles(
  input: PersistMailAttachmentInput,
  dependencies: PersistMailAttachmentDependencies = defaultPersistMailAttachmentDependencies,
): Promise<any> {
  const safeName = path.basename(input.filename)
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .trim()
    .slice(0, 255) || 'attachment';
  const rawExtension = path.extname(safeName);
  const extension = /^\.[a-zA-Z0-9]{1,16}$/.test(rawExtension) ? rawExtension : '';
  const storedName = `${crypto.randomUUID()}${extension}`;
  const userDir = dependencies.getUploadDir(input.userId);
  const finalPath = path.join(userDir, storedName);
  const temporaryPath = path.join(userDir, `.${storedName}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let createdFile: any;
  let mirrorCreated = false;
  let finalCreated = false;

  try {
    fs.writeFileSync(temporaryPath, input.buffer, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, finalPath);
    finalCreated = true;

    createdFile = await dependencies.createFile({
      userId: input.userId,
      path: storedName,
      originalName: safeName,
      size: BigInt(input.buffer.length),
      mimeType: input.contentType,
    });

    dependencies.createToolMirror(input.userId, finalPath, storedName);
    mirrorCreated = true;

    await dependencies.logActivity({
      userId: input.userId,
      action: 'FILE_UPLOAD',
      resource: 'file',
      resourceId: createdFile.id,
      severity: 'INFO',
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    }).catch(() => undefined);

    return createdFile;
  } catch (error) {
    if (mirrorCreated) {
      try { dependencies.deleteToolMirror(input.userId, storedName); } catch {}
    }
    if (createdFile?.id) {
      try { await dependencies.deleteFile(createdFile.id); } catch {}
    }
    if (finalCreated) {
      try { fs.unlinkSync(finalPath); } catch {}
    }
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

router.post('/attachments/:blobId/save-to-files', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }

    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (
      typeof req.params.blobId !== 'string'
      || req.params.blobId.length < 1
      || req.params.blobId.length > 2048
    ) {
      res.status(400).json({ error: 'Attachment identifier is invalid' });
      return;
    }
    const verified = verifyMailAttachmentCapabilityToken(token, {
      actorId: req.user!.userId,
      accountUser: account.user,
      blobId: req.params.blobId,
    }, config.jwtSecret);
    if (!verified) {
      res.status(403).json({ error: 'Attachment authorization is invalid or expired. Refresh the message and try again.' });
      return;
    }

    // Download attachment from JMAP
    let result;
    try {
      result = await downloadAttachment(
        req.params.blobId,
        verified.filename,
        verified.contentType,
        account.user,
        account.pass,
      );
    } catch (err: any) {
      if (err.message.includes('blocked')) {
        res.status(403).json({ error: 'This attachment type is blocked for security reasons' });
        return;
      }
      throw err;
    }

    // Enforce max size
    if (result.buffer.length > MAX_SAVE_SIZE) {
      res.status(413).json({ error: 'Attachment is too large to save (25 MB maximum)' });
      return;
    }

    if (!(await requireCleanAttachment(req, res, result.buffer, result.filename, result.contentType))) return;

    const userId = req.user!.userId;
    const file = await persistMailAttachmentToFiles({
      userId,
      filename: result.filename,
      contentType: result.contentType,
      buffer: result.buffer,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      success: true,
      file: {
        id: file.id,
        originalName: file.originalName,
        size: file.size.toString(),
        mimeType: file.mimeType,
        path: file.path,
      },
    });
  } catch (error: any) {
    console.error('[mail] save-to-files error:', error.message);
    res.status(500).json({ error: 'Failed to save attachment to files' });
  }
});

export default router;
