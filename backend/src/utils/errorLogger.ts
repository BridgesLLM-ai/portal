/**
 * Centralized error logging to ActivityLog.
 * All error sources (API, Agent, Git, DB, FS, Auth) funnel through here.
 */
import { prisma } from '../config/database';

export interface ErrorLogContext {
  userId?: string;
  action?: string;          // e.g. MARCUS_ERROR, API_ERROR, GIT_ERROR, AUTH_ERROR, DB_ERROR, FS_ERROR, FRONTEND_ERROR
  resource?: string;        // e.g. 'agent_chat', 'api', 'git', 'auth', 'database', 'filesystem', 'frontend'
  resourceId?: string;      // e.g. project name, file path, endpoint
  endpoint?: string;        // HTTP method + path
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  projectName?: string;
  route?: string;
  title?: string;
  severity?: 'ERROR' | 'CRITICAL';
}

/**
 * Log an error to the ActivityLog table with full metadata.
 * Non-blocking — failures are silently caught to avoid error loops.
 */
export async function logError(
  error: unknown,
  context: ErrorLogContext
): Promise<void> {
  try {
    const err = normalizeError(error);
    const action = context.action || categorizeAction(context);
    const resource = context.resource || categorizeResource(context);
    const severity = context.severity || 'ERROR';

    // Build translated message (human-readable)
    const parts: string[] = [];
    if (context.projectName) parts.push(`[${context.projectName}]`);
    if (context.endpoint) parts.push(`${context.endpoint}`);
    parts.push(err.message);
    const translatedMessage = `❌ ${parts.join(' — ')}`;

    // Build metadata with full error context
    const metadata: Record<string, any> = {
      errorMessage: err.message,
      errorType: 'error',
    };
    if (err.stack) metadata.stackTrace = err.stack;
    if (err.code) metadata.errorCode = err.code;
    if (err.status) metadata.httpStatus = err.status;
    if (context.endpoint) metadata.endpoint = context.endpoint;
    if (context.sessionId) metadata.sessionId = context.sessionId;
    if (context.projectName) metadata.projectName = context.projectName;
    if (context.route) metadata.route = context.route;
    if (context.title) metadata.title = context.title;
    if (context.userAgent) metadata.userAgent = context.userAgent;

    await prisma.activityLog.create({
      data: {
        userId: context.userId || null,
        action,
        resource,
        resourceId: context.resourceId || context.projectName || context.endpoint || null,
        severity,
        translatedMessage,
        ipAddress: context.ipAddress || null,
        userAgent: context.userAgent || null,
        metadata,
      },
    });
  } catch (logErr) {
    // Don't let logging errors cascade — just console it
    console.error('[errorLogger] Failed to log error to activity:', logErr);
  }
}

/**
 * Convenience: log error from an Express request context.
 */
export async function logRequestError(
  error: unknown,
  req: { method?: string; originalUrl?: string; path?: string; ip?: string; headers?: Record<string, any>; user?: { userId?: string }; params?: Record<string, any> },
  extra?: Partial<ErrorLogContext>
): Promise<void> {
  const endpoint = req.method && (req.originalUrl || req.path)
    ? `${req.method} ${req.originalUrl || req.path}`
    : undefined;

  // Try to extract project name from params or URL
  let projectName = extra?.projectName || req.params?.name || req.params?.projectName;
  if (!projectName && req.originalUrl) {
    const match = req.originalUrl.match(/\/projects\/([^/]+)/);
    if (match) projectName = decodeURIComponent(match[1]);
  }

  await logError(error, {
    userId: req.user?.userId,
    endpoint,
    ipAddress: req.ip,
    userAgent: req.headers?.['user-agent'],
    projectName,
    ...extra,
  });
}

// --- Internal helpers ---

interface NormalizedError {
  message: string;
  stack?: string;
  code?: string;
  status?: number;
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      code: (error as any).code,
      status: (error as any).statusCode || (error as any).status,
    };
  }
  if (typeof error === 'string') {
    return { message: error };
  }
  if (error && typeof error === 'object') {
    const e = error as any;
    return {
      message: e.message || e.detail || JSON.stringify(error),
      stack: e.stack,
      code: e.code,
      status: e.statusCode || e.status,
    };
  }
  return { message: String(error) };
}

function categorizeAction(ctx: ErrorLogContext): string {
  if (ctx.resource === 'agent_chat' || ctx.endpoint?.includes('agent_chat')) return 'MARCUS_ERROR';
  if (ctx.resource === 'git' || ctx.endpoint?.includes('git')) return 'GIT_ERROR';
  if (ctx.resource === 'auth' || ctx.endpoint?.includes('auth')) return 'AUTH_ERROR';
  if (ctx.resource === 'database') return 'DB_ERROR';
  if (ctx.resource === 'filesystem') return 'FS_ERROR';
  if (ctx.resource === 'frontend') return 'FRONTEND_ERROR';
  return 'API_ERROR';
}

function categorizeResource(ctx: ErrorLogContext): string {
  if (ctx.endpoint?.includes('agent_chat')) return 'agent_chat';
  if (ctx.endpoint?.includes('git')) return 'git';
  if (ctx.endpoint?.includes('auth')) return 'auth';
  if (ctx.endpoint?.includes('projects')) return 'project';
  if (ctx.endpoint?.includes('files')) return 'file';
  if (ctx.endpoint?.includes('apps')) return 'app';
  return 'api';
}
