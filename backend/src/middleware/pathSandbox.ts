/**
 * Path Sandbox Middleware
 * 
 * Prevents project agents and API consumers from accessing files outside
 * their designated directory under the configured PORTAL_PROJECTS_ROOT.
 * 
 * Protects against: directory traversal, symlink escapes, absolute paths,
 * access to system directories, and access to portal source code.
 */

import { Request, Response, NextFunction } from 'express';
import path from 'path';
import { prisma } from '../config/database';
import { isPathContained, resolveContainedPath } from '../services/containedPath';
import { getWorkspaceOwnerId } from '../utils/workspaceScope';

export interface ProjectPathSandboxOptions {
  projectsBase?: string;
}

export function resolveProjectsBase(options: ProjectPathSandboxOptions = {}): string {
  return path.resolve(
    options.projectsBase
      || process.env.PORTAL_PROJECTS_ROOT
      || path.join(process.env.PORTAL_DATA_ROOT || process.env.PORTAL_ROOT || '/portal', 'projects'),
  );
}

const PROJECTS_BASE = resolveProjectsBase();

// Directories that must NEVER be accessible from project contexts
const BLOCKED_PREFIXES = [
  '/root',
  '/etc',
  '/proc',
  '/sys',
  '/var/run',
  '/var/log',
  '/tmp',
  '/home',
  '/portal/files',         // user uploads (separate from projects)
  '/portal/project-zips',  // zip staging
  '/var/www',              // deployed apps
];

// Portal source directories - the primary protection target
const PORTAL_DIRS = [
  process.env.PORTAL_ROOT || '/opt/bridgesllm/portal',
];

// Track repeat offenders for escalation
const violationCounts = new Map<string, { count: number; lastTime: number }>();
const ESCALATION_WINDOW = 15 * 60 * 1000; // 15 minutes
const ESCALATION_THRESHOLD = 3;

/**
 * Validate that a resolved path is within the allowed project sandbox.
 * Returns { allowed: true, resolvedPath } or { allowed: false, reason }.
 */
export function validateProjectPath(
  requestedPath: string,
  userId: string,
  projectName: string,
  options: ProjectPathSandboxOptions = {},
): { allowed: true; resolvedPath: string } | { allowed: false; reason: string; notFound?: boolean } {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
    return { allowed: false, reason: 'Empty path' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)
      || !projectName
      || path.basename(projectName) !== projectName
      || projectName.includes('\\')) {
    return { allowed: false, reason: 'Invalid project identity' };
  }

  let allowedBase: string;
  try {
    const projectsBase = Object.keys(options).length > 0 ? resolveProjectsBase(options) : PROJECTS_BASE;
    const ownerRoot = resolveContainedPath(projectsBase, userId, { mustExist: true, kind: 'directory' });
    allowedBase = resolveContainedPath(ownerRoot, projectName, { mustExist: true, kind: 'directory' });
  } catch (error: any) {
    // A Project that simply is not there is a 404, not an accusation. This is
    // the ordinary state right after a delete or rename — and answering
    // "Access denied: path outside project sandbox" made routine lifecycle
    // transitions look like a security failure, while the sibling `/tree` and
    // Project Chat routes already answered "Project not found".
    const message = String(error?.message || '');
    const missing = /path does not exist/i.test(message) || error?.code === 'ENOENT';
    if (missing) {
      return { allowed: false, reason: 'Project not found', notFound: true };
    }
    return { allowed: false, reason: 'Project sandbox root is missing or unsafe' };
  }

  let relativePath = requestedPath;
  if (path.isAbsolute(requestedPath)) {
    const absolutePath = path.resolve(requestedPath);
    if (!isPathContained(allowedBase, absolutePath) || absolutePath === allowedBase) {
      return { allowed: false, reason: `Absolute path outside project: ${requestedPath}` };
    }
    relativePath = path.relative(allowedBase, absolutePath).split(path.sep).join('/');
  }

  try {
    const resolvedPath = resolveContainedPath(allowedBase, relativePath, { mustExist: false });
    return { allowed: true, resolvedPath };
  } catch (error: any) {
    const detail = String(error?.message || 'invalid path');
    if (/symbolic link/i.test(detail)) {
      return { allowed: false, reason: `Symlink escapes project sandbox: ${requestedPath}` };
    }
    return { allowed: false, reason: `Path escapes project sandbox: ${requestedPath}` };
  }
}

/**
 * Log a sandbox violation to the ActivityLog database.
 */
async function logViolation(
  userId: string | undefined,
  projectName: string,
  attemptedPath: string,
  reason: string,
  req: Request
): Promise<void> {
  const key = `${userId || 'anon'}:${req.ip}`;
  const now = Date.now();
  const entry = violationCounts.get(key);

  let severity: 'WARNING' | 'ERROR' = 'WARNING';
  if (entry && (now - entry.lastTime) < ESCALATION_WINDOW) {
    entry.count++;
    entry.lastTime = now;
    if (entry.count >= ESCALATION_THRESHOLD) {
      severity = 'ERROR';
    }
  } else {
    violationCounts.set(key, { count: 1, lastTime: now });
  }

  try {
    await prisma.activityLog.create({
      data: {
        userId: userId || null,
        action: 'PATH_SANDBOX_VIOLATION',
        resource: 'project_file',
        resourceId: projectName,
        severity,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: {
          attemptedPath,
          reason,
          method: req.method,
          url: req.originalUrl,
          timestamp: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    console.error('[PathSandbox] Failed to log violation:', err);
  }

  console.warn(`[PathSandbox] ${severity}: User=${userId} Project=${projectName} Path=${attemptedPath} Reason=${reason}`);
}

/**
 * Express middleware that extracts project context from route params
 * and validates any file path parameters against the sandbox.
 * 
 * Expects routes like: /api/projects/:name/files/*
 * File path comes from: req.params[0], req.query.path, req.body.filePath, req.body.path
 */
const COLLECTION_ROUTE_NAMES = new Set(['clone', 'models', 'upload-zip', 'create-from-upload']);

export async function projectPathSandbox(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectName = req.params.name || req.params.projectName;

  // If no project context, skip (non-project routes)
  if (!projectName || COLLECTION_ROUTE_NAMES.has(projectName) || !req.user) {
    next();
    return;
  }

  let userId: string;
  try {
    userId = await getWorkspaceOwnerId(req.user);
  } catch {
    res.status(403).json({ error: 'Unable to resolve project workspace' });
    return;
  }

  // Collect all possible file path sources
  const pathSources: unknown[] = [];
  
  // Route wildcard param (e.g., /files/*)
  if (req.params[0]) pathSources.push(req.params[0]);
  
  // Query params
  if (req.query.path) pathSources.push(req.query.path as string);
  if (req.query.filePath) pathSources.push(req.query.filePath as string);
  
  // Body params (for POST/PUT)
  if (req.body?.filePath) pathSources.push(req.body.filePath);
  if (req.body?.path) pathSources.push(req.body.path);
  if (req.body?.targetPath) pathSources.push(req.body.targetPath);
  if (req.body?.oldPath) pathSources.push(req.body.oldPath);
  if (req.body?.newPath) pathSources.push(req.body.newPath);
  if (req.body?.destinationPath) pathSources.push(req.body.destinationPath);

  // Validate each path source
  for (const filePath of pathSources) {
    if (!filePath) continue;
    if (typeof filePath !== 'string') {
      void logViolation(userId, projectName, '[non-string path]', 'Invalid path type', req);
      res.status(400).json({ error: 'Invalid project path' });
      return;
    }
    
    const result = validateProjectPath(filePath, userId, projectName);
    if (!result.allowed) {
      // A missing Project is not a containment violation. Logging it as one
      // also polluted the security activity log every time someone opened a
      // file in a Project that had just been deleted or renamed.
      if (result.notFound) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      void logViolation(userId, projectName, filePath, result.reason, req);
      res.status(403).json({ 
        error: 'Access denied: path outside project sandbox',
        detail: result.reason,
      });
      return;
    }
  }

  next();
}

/**
 * Middleware for the AI routes that access project files.
 * Validates project + filePath from request body/query.
 */
export async function aiPathSandbox(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectName = req.body?.projectName || req.query?.project as string;
  const filePath = req.body?.filePath || req.query?.path as string;

  if (!projectName || !filePath || !req.user) {
    next();
    return;
  }

  if (typeof projectName !== 'string' || typeof filePath !== 'string') {
    res.status(400).json({ error: 'Invalid project path' });
    return;
  }

  let userId: string;
  try {
    userId = await getWorkspaceOwnerId(req.user);
  } catch {
    res.status(403).json({ error: 'Unable to resolve project workspace' });
    return;
  }

  const result = validateProjectPath(filePath, userId, projectName);
  if (!result.allowed) {
    void logViolation(userId, projectName, filePath, result.reason, req);
    res.status(403).json({
      error: 'Access denied: path outside project sandbox',
      detail: result.reason,
    });
    return;
  }

  next();
}

// Export for testing
export { BLOCKED_PREFIXES, PORTAL_DIRS, PROJECTS_BASE, violationCounts };
