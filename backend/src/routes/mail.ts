/**
 * Mail Routes — Email inbox and management for portal
 * 
 * All routes require authentication. Per-user mail accounts are supported.
 * Admins can switch between personal, support, and noreply accounts.
 * Rate limited on send operations.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
  processAutoForward,
} from '../services/mailService';
import { getUserUploadDir } from './files';

const router = Router();

const STALWART_SUPPORT_USER = process.env.STALWART_SUPPORT_USER || 'support';
const STALWART_SUPPORT_PASS = process.env.STALWART_SUPPORT_PASS || '';
const STALWART_NOREPLY_USER = process.env.STALWART_NOREPLY_USER || 'noreply';
const STALWART_NOREPLY_PASS = process.env.STALWART_NOREPLY_PASS || '';
const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'localhost';

// Multer for file attachment uploads (max 25MB per file, max 10 files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

// All mail routes require interactive portal access
router.use(authenticateToken, requireApproved);

// ── Account Resolution ────────────────────────────────────────

interface ResolvedAccount {
  user: string;
  pass: string;
  email: string;
}

function getRequestedAccountId(req: Request): string | undefined {
  const accountParam = typeof req.query.account === 'string' ? req.query.account : '';
  return accountParam || undefined;
}

function isSharedMailboxAccount(accountId?: string): boolean {
  return accountId === 'support' || accountId === 'noreply';
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
 * - ?account=support or ?account=noreply → admin only
 * - Default: user's personal mailbox
 * - If user has no mailbox, returns 'no_mailbox' string
 */
async function resolveAccount(req: Request): Promise<ResolvedAccount | null | 'no_mailbox'> {
  const accountParam = getRequestedAccountId(req) || '';
  const isAdmin = isElevatedRole(req.user?.role);

  if (accountParam === 'support') {
    return isAdmin ? { user: STALWART_SUPPORT_USER, pass: STALWART_SUPPORT_PASS, email: `support@${MAIL_DOMAIN}` } : null;
  }
  if (accountParam === 'noreply') {
    return isAdmin ? { user: STALWART_NOREPLY_USER, pass: STALWART_NOREPLY_PASS, email: `noreply@${MAIL_DOMAIN}` } : null;
  }

  const creds = await getSelectedPersonalMailboxCredentials(req);
  if (!creds) return 'no_mailbox';

  return { user: creds.username, pass: creds.password, email: `${creds.username}@${MAIL_DOMAIN}` };
}

// ── Rate limiting for send operations ─────────────────────────
const sendTimestamps: number[] = [];
const SEND_RATE_LIMIT = 20;
const SEND_RATE_WINDOW = 60 * 60 * 1000;

function checkSendRateLimit(): boolean {
  const now = Date.now();
  while (sendTimestamps.length && sendTimestamps[0] < now - SEND_RATE_WINDOW) {
    sendTimestamps.shift();
  }
  return sendTimestamps.length < SEND_RATE_LIMIT;
}

// ── GET /api/mail/accounts ────────────────────────────────────
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const isAdmin = isElevatedRole(req.user?.role);
    const personalAccounts = await getUserMailAccounts(req.user!.userId);

    const accounts: { id: string; label: string; email: string; isPrimary?: boolean }[] = [];

    for (const account of personalAccounts) {
      accounts.push({
        id: account.id,
        label: account.username,
        email: `${account.username}@${MAIL_DOMAIN}`,
        isPrimary: account.isPrimary,
      });
    }
    
    if (isAdmin) {
      accounts.push(
        { id: 'support', label: 'Shared Support', email: `support@${MAIL_DOMAIN}` },
        { id: 'noreply', label: 'Shared No-Reply', email: `noreply@${MAIL_DOMAIN}` },
      );
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
    if (account === 'no_mailbox' || !account) {
      res.json({ unread: 0 });
      return;
    }
    const count = await getUnreadCount(account.user, account.pass);
    res.json({ unread: count });
  } catch (error: any) {
    console.error('[mail] getUnreadCount error:', error.message);
    res.json({ unread: 0 });
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

    const { mailboxId, mailboxRole, position, limit, sort } = req.query;
    const effectiveRole = (mailboxRole as string) || 'inbox';
    const result = await listEmails(account.user, account.pass, {
      mailboxId: mailboxId as string,
      mailboxRole: effectiveRole,
      position: position ? parseInt(position as string) : 0,
      limit: limit ? Math.min(parseInt(limit as string), 100) : 50,
      sort: sort === 'date-asc' ? 'date-asc' : 'date-desc',
    });
    res.json(result);

    // Auto-forward: trigger in background after response (non-blocking)
    if (result.emails?.length && effectiveRole === 'inbox') {
      const creds = await getSelectedPersonalMailboxCredentials(req);
      if (creds) {
        const mailbox = await prisma.mailboxAccount.findFirst({
          where: { id: creds.accountId },
          select: { autoForwardTo: true },
        });
        if (mailbox?.autoForwardTo) {
          processAutoForward(result.emails, mailbox.autoForwardTo, account.user, account.pass).catch(err => {
            console.error('[mail] auto-forward error:', err.message);
          });
        }
      }
    }
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
    res.json(email);
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
    const { name, type } = req.query;
    const result = await downloadAttachment(
      req.params.blobId,
      (name as string) || 'attachment',
      (type as string) || 'application/octet-stream',
      account.user,
      account.pass,
    );
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
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
router.post('/send', upload.array('attachments', 10), async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox configured' });
      return;
    }

    if (!checkSendRateLimit()) {
      res.status(429).json({ error: 'Rate limit exceeded. Max 20 emails per hour.' });
      return;
    }
    
    let to: any[], cc: any[] | undefined, bcc: any[] | undefined;
    let subject: string, textBody: string | undefined, htmlBody: string | undefined;
    let inReplyTo: string[] | undefined, references: string[] | undefined;
    
    if (req.is('multipart/form-data')) {
      const data = JSON.parse(req.body.data || '{}');
      to = data.to;
      cc = data.cc;
      bcc = data.bcc;
      subject = data.subject;
      textBody = data.textBody;
      htmlBody = data.htmlBody;
      inReplyTo = data.inReplyTo;
      references = data.references;
    } else {
      ({ to, cc, bcc, subject, textBody, htmlBody, inReplyTo, references } = req.body);
    }
    
    if (!to || !Array.isArray(to) || !to.length) {
      res.status(400).json({ error: 'Recipients (to) required' });
      return;
    }
    if (!subject) {
      res.status(400).json({ error: 'Subject required' });
      return;
    }
    if (!textBody && !htmlBody) {
      res.status(400).json({ error: 'Email body required' });
      return;
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const allRecipients = [...to, ...(cc || []), ...(bcc || [])];
    for (const r of allRecipients) {
      if (!r.email || !emailRegex.test(r.email)) {
        res.status(400).json({ error: `Invalid email address: ${r.email}` });
        return;
      }
    }
    
    const uploadedAttachments: { blobId: string; type: string; name: string; size: number }[] = [];
    const files = (req.files as Express.Multer.File[]) || [];
    for (const file of files) {
      const uploaded = await uploadBlob(file.buffer, file.mimetype, account.user, account.pass);
      uploadedAttachments.push({
        blobId: uploaded.blobId,
        type: file.mimetype,
        name: file.originalname,
        size: file.size,
      });
    }
    
    sendTimestamps.push(Date.now());
    
    const result = await sendEmail({
      from: account.email,
      to, cc, bcc, subject, textBody, htmlBody, inReplyTo, references,
      attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
    }, account.user, account.pass);
    res.json(result);
  } catch (error: any) {
    console.error('[mail] sendEmail error:', error.message);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// ── POST /api/mail/forward ────────────────────────────────────
router.post('/forward', upload.array('attachments', 10), async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox configured' });
      return;
    }

    if (!checkSendRateLimit()) {
      res.status(429).json({ error: 'Rate limit exceeded. Max 20 emails per hour.' });
      return;
    }
    
    let originalId: string, to: any[], cc: any[] | undefined, bcc: any[] | undefined, body: string;
    
    if (req.is('multipart/form-data')) {
      const data = JSON.parse(req.body.data || '{}');
      originalId = data.originalId;
      to = data.to;
      cc = data.cc;
      bcc = data.bcc;
      body = data.body || '';
    } else {
      ({ originalId, to, cc, bcc, body } = req.body);
      body = body || '';
    }
    
    if (!originalId) {
      res.status(400).json({ error: 'originalId required' });
      return;
    }
    if (!to || !Array.isArray(to) || !to.length) {
      res.status(400).json({ error: 'Recipients (to) required' });
      return;
    }
    
    const additionalAttachments: { blobId: string; type: string; name: string; size: number }[] = [];
    const files = (req.files as Express.Multer.File[]) || [];
    for (const file of files) {
      const uploaded = await uploadBlob(file.buffer, file.mimetype, account.user, account.pass);
      additionalAttachments.push({
        blobId: uploaded.blobId,
        type: file.mimetype,
        name: file.originalname,
        size: file.size,
      });
    }
    
    sendTimestamps.push(Date.now());
    
    const result = await forwardEmail(
      originalId, to, cc, bcc, body,
      account.user, account.pass,
      additionalAttachments.length > 0 ? additionalAttachments : undefined
    );
    res.json(result);
  } catch (error: any) {
    console.error('[mail] forwardEmail error:', error.message);
    res.status(500).json({ error: 'Failed to forward email' });
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
    if (!targetMailboxId) {
      res.status(400).json({ error: 'targetMailboxId required' });
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
    await toggleFlag(req.params.id, !!flagged, account.user, account.pass);
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
    await markRead(req.params.id, read !== false, account.user, account.pass);
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
    if (!emailIds || !Array.isArray(emailIds) || !emailIds.length) {
      res.status(400).json({ error: 'emailIds array required' });
      return;
    }
    await bulkMarkRead(emailIds, read !== false, account.user, account.pass);
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
    if (!emailIds || !Array.isArray(emailIds) || !emailIds.length) {
      res.status(400).json({ error: 'emailIds array required' });
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
    if (!emailIds || !Array.isArray(emailIds) || !emailIds.length) {
      res.status(400).json({ error: 'emailIds array required' });
      return;
    }
    if (!targetMailboxId) {
      res.status(400).json({ error: 'targetMailboxId required' });
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
      const email = `${mailbox?.username || creds.username}@${MAIL_DOMAIN}`;
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

    const { autoForwardTo } = req.body;
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
      if (autoForwardTo.toLowerCase() === `${creds.username}@${MAIL_DOMAIN}`.toLowerCase()) {
        res.status(400).json({ error: 'Cannot forward to your own portal email' });
        return;
      }
    }

    await prisma.mailboxAccount.update({
      where: { id: creds.accountId },
      data: { autoForwardTo: autoForwardTo || null },
    });

    res.json({ success: true, autoForwardTo: autoForwardTo || null });
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

    res.json({
      username: creds.username,
      email: `${creds.username}@${MAIL_DOMAIN}`,
      password: creds.password,
      imap: {
        server: `mail.${MAIL_DOMAIN}`,
        port: 993,
        security: 'SSL/TLS',
      },
      smtp: {
        server: `mail.${MAIL_DOMAIN}`,
        port: 587,
        security: 'STARTTLS',
      },
    });
  } catch (error: any) {
    console.error('[mail] credentials error:', error.message);
    res.status(500).json({ error: 'Failed to get credentials' });
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
const MAX_SAVE_SIZE = 50 * 1024 * 1024; // 50MB

router.post('/attachments/:blobId/save-to-files', async (req: Request, res: Response) => {
  try {
    const account = await resolveAccount(req);
    if (account === 'no_mailbox' || !account) {
      res.status(403).json({ error: 'No mailbox' });
      return;
    }

    const { filename, contentType } = req.body;
    if (!filename || !contentType) {
      res.status(400).json({ error: 'filename and contentType required' });
      return;
    }

    // Download attachment from JMAP
    let result;
    try {
      result = await downloadAttachment(
        req.params.blobId,
        filename,
        contentType,
        account.user,
        account.pass,
      );
    } catch (err: any) {
      if (err.message.includes('blocked')) {
        res.status(400).json({ error: 'This attachment type is blocked for security reasons' });
        return;
      }
      throw err;
    }

    // Enforce max size
    if (result.buffer.length > MAX_SAVE_SIZE) {
      res.status(400).json({ error: 'Attachment too large (max 50MB)' });
      return;
    }

    // Virus scan before saving
    const scanResult = await scanBuffer(result.buffer, filename);
    if (!scanResult.clean) {
      await prisma.activityLog.create({
        data: {
          userId: req.user!.userId,
          action: 'MALWARE_BLOCKED',
          resource: 'mail',
          severity: 'CRITICAL',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          translatedMessage: `🦠 Malware blocked: "${filename}" — ${scanResult.threat}`,
          metadata: { filename, threat: scanResult.threat, contentType },
        },
      }).catch(() => {});
      res.status(400).json({ error: `File rejected: malware detected (${scanResult.threat})` });
      return;
    }

    // Write to user's upload directory
    const userId = req.user!.userId;
    const userDir = getUserUploadDir(userId);
    fs.mkdirSync(userDir, { recursive: true });

    const ext = path.extname(filename) || '';
    const uniqueFilename = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(userDir, uniqueFilename);
    fs.writeFileSync(filePath, result.buffer);

    // Create File record in DB
    const file = await prisma.file.create({
      data: {
        userId,
        path: uniqueFilename,
        originalName: filename,
        size: BigInt(result.buffer.length),
        mimeType: contentType,
      },
    });

    // Log activity
    await prisma.activityLog.create({
      data: {
        userId,
        action: 'FILE_UPLOAD',
        resource: 'file',
        resourceId: file.id,
        severity: 'INFO',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
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
