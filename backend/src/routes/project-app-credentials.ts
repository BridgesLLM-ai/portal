/**
 * Named App credentials. Mounted at /api/app-credentials.
 *
 * Portal Owner only: a credential is a login or key that the Owner hands to
 * one hosted App's code. Values are write-only. No response,
 * log line or audit row carries a value, its ciphertext, length or digest;
 * listing returns names and metadata. A change applies on the App's next start
 * or redeploy, and the listing says when the running container predates it.
 *
 * Cookie-authenticated mutations pass the Portal's global same-origin
 * (Origin/Fetch Metadata) gate before reaching this router; bodies are bounded
 * by appCredentialBodyLimit, mounted ahead of the global parsers.
 */
import express, { Router, type NextFunction, type Request as ExpressRequest, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
// These routes use named scalar params, never Express 5 wildcard arrays.
type Request = ExpressRequest<Record<string, string>>;
import { prisma } from '../config/database';
import { authenticateToken } from '../middleware/auth';
import { requireApproved } from '../middleware/requireApproved';
import { requireOwner } from '../middleware/requireAdmin';
import {
  APP_CREDENTIAL_MAX_BYTES,
  APP_CREDENTIAL_MAX_SLOTS,
  APP_CREDENTIALS_CONTAINER_DIRECTORY,
  AppCredentialError,
} from '../services/appCredentials/policy';
import {
  listAppCredentials,
  removeAppCredential,
  setAppCredential,
  type AppCredentialListing,
} from '../services/appCredentials/store';
import { runningAppCredentialState } from '../services/app-process.service';

/** A 64 KiB value can grow up to ~6x as escaped JSON text. */
export const APP_CREDENTIAL_BODY_LIMIT = '400kb';
const parseJsonBody = express.json({ limit: APP_CREDENTIAL_BODY_LIMIT, strict: true });

/**
 * Mount at /api/app-credentials before the Portal's global body parsers.
 * Parser failures are answered here: the global error handler logs error
 * objects, and a JSON syntax error quotes part of the body (a value).
 */
export const appCredentialBodyLimit: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !req.is('application/json')) {
    res.status(415).json({ code: 'APP_CREDENTIAL_INVALID', error: 'Send App credentials as JSON.' });
    return;
  }
  parseJsonBody(req, res, (error?: unknown) => {
    if (!error) { next(); return; }
    if ((error as { type?: unknown })?.type === 'entity.too.large') {
      res.status(413).json({ code: 'APP_CREDENTIAL_TOO_LARGE', error: `A credential value is at most ${APP_CREDENTIAL_MAX_BYTES} bytes.` });
      return;
    }
    res.status(400).json({ code: 'APP_CREDENTIAL_INVALID', error: 'The request body is not valid JSON.' });
  });
};

const router = Router();
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
router.use(authenticateToken, requireApproved, requireOwner);

const readLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || 'anonymous',
  message: { code: 'APP_CREDENTIAL_RATE_LIMITED', error: 'Too many App credential requests. Try again shortly.' },
});

const writeLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || 'anonymous',
  message: { code: 'APP_CREDENTIAL_RATE_LIMITED', error: 'Too many App credential changes. Try again later.' },
});

function sendFailure(res: Response, error: unknown): void {
  if (res.headersSent) return;
  if (error instanceof AppCredentialError) {
    res.status(error.status).json(error.toPublicJSON());
    return;
  }
  // Never log the error object: database errors can echo query arguments.
  console.error('[app-credentials] operation failed:', (error as { name?: string })?.name || 'Error');
  res.status(500).json({ code: 'APP_CREDENTIAL_FAILED', error: 'The App credential operation failed. Nothing was shown or logged.' });
}

async function usernamesFor(ids: Array<string | null>): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!unique.length) return {};
  try {
    const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, username: true } });
    return Object.fromEntries(users.map((user) => [user.id, user.username]));
  } catch {
    return {};
  }
}

async function present(listing: AppCredentialListing) {
  const names = await usernamesFor(listing.slots.map((slot) => slot.updatedByUserId));
  const runtime = runningAppCredentialState(listing.app.id);
  // Slot revisions come from the set counter, so anything written after the
  // container started carries a higher revision than the one it holds.
  const restartRequired = runtime.running && (listing.slots.length !== runtime.slots.length
    || listing.slots.some((slot) => !runtime.slots.includes(slot.slot) || slot.revision > runtime.revision));
  return {
    app: { id: listing.app.id, name: listing.app.name },
    revision: listing.revision,
    slots: listing.slots.map((slot) => ({
      slot: slot.slot,
      revision: slot.revision,
      updatedAt: slot.updatedAt.toISOString(),
      updatedBy: slot.updatedByOperator
        ? { kind: 'operator' as const }
        : { kind: 'user' as const, username: (slot.updatedByUserId && names[slot.updatedByUserId]) || null },
    })),
    limits: { maxSlots: APP_CREDENTIAL_MAX_SLOTS, maxBytes: APP_CREDENTIAL_MAX_BYTES },
    containerDirectory: APP_CREDENTIALS_CONTAINER_DIRECTORY,
    runtime: { running: runtime.running, restartRequired },
  };
}

function handle(work: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    work(req, res).catch((error) => sendFailure(res, error));
  };
}

router.get('/:appId', readLimiter, handle(async (req, res) => {
  if (Object.keys(req.query).length) throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'This request takes no query parameters.', 400);
  res.json(await present(await listAppCredentials(req.params.appId)));
}));

router.put('/:appId/:slot', writeLimiter, handle(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'expectedRevision,value'
    || (body.expectedRevision !== null && !Number.isSafeInteger(body.expectedRevision))) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'Send exactly { value, expectedRevision } (null to add a new credential).', 400);
  }
  const stored = await setAppCredential({
    appId: req.params.appId,
    slot: req.params.slot,
    value: body.value,
    expectedRevision: body.expectedRevision,
    actor: { kind: 'user', userId: req.user!.userId },
  });
  res.json({ stored: { slot: stored.slot, revision: stored.revision, replaced: stored.replaced },
    ...(await present(await listAppCredentials(stored.appId))) });
}));

router.delete('/:appId/:slot', writeLimiter, handle(async (req, res) => {
  const keys = Object.keys(req.query);
  const raw = req.query.expectedRevision;
  if (keys.some((key) => key !== 'expectedRevision') || typeof raw !== 'string' || !/^[1-9][0-9]{0,9}$/.test(raw)) {
    throw new AppCredentialError('APP_CREDENTIAL_INVALID', 'Removing a credential needs its exact expectedRevision.', 400);
  }
  const removed = await removeAppCredential({
    appId: req.params.appId,
    slot: req.params.slot,
    expectedRevision: Number(raw),
    actor: { kind: 'user', userId: req.user!.userId },
  });
  res.json({ removed: { slot: removed.slot }, ...(await present(await listAppCredentials(removed.appId))) });
}));

// Anything thrown inside this router is answered here, never by the global
// handler (which logs whole error objects).
router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  sendFailure(res, error);
});

export default router;
