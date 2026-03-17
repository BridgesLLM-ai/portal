/**
 * Path Sandbox Middleware
 * 
 * Prevents project agents and API consumers from accessing files outside
 * their designated project directory (/portal/projects/{userId}/{projectName}/).
 * 
 * Protects against: directory traversal, symlink escapes, absolute paths,
 * access to system directories, and access to portal source code.
 */

import { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { prisma } from '../config/database';

const PROJECTS_BASE = path.join(process.env.PORTAL_ROOT || '/portal', 'projects');

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
  process.env.PORTAL_ROOT || '/root/bridgesllm-product',
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
  projectName: string
): { allowed: true; resolvedPath: string } | { allowed: false; reason: string } {
  
  const allowedBase = path.resolve(path.join(PROJECTS_BASE, userId, projectName));

  // Reject empty paths
  if (!requestedPath || !requestedPath.trim()) {
    return { allowed: false, reason: 'Empty path' };
  }

  // Reject absolute paths that don't start with allowed base
  if (path.isAbsolute(requestedPath) && !requestedPath.startsWith(allowedBase)) {
    return { allowed: false, reason: `Absolute path outside project: ${requestedPath}` };
  }

  // Resolve the path relative to project dir
  const resolved = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(allowedBase, requestedPath);

  // Primary check: must be within project directory
  if (!resolved.startsWith(allowedBase + '/') && resolved !== allowedBase) {
    return { allowed: false, reason: `Path escapes project sandbox: ${resolved}` };
  }

  // Check against blocked system directories
  for (const blocked of BLOCKED_PREFIXES) {
    if (resolved.startsWith(blocked + '/') || resolved === blocked) {
      return { allowed: false, reason: `Access to system directory blocked: ${blocked}` };
    }
  }

  // Check against portal source directories
  for (const portalDir of PORTAL_DIRS) {
    if (resolved.startsWith(portalDir + '/') || resolved === portalDir) {
      return { allowed: false, reason: `Access to portal directory blocked: ${portalDir}` };
    }
  }

  // Symlink check: if the path exists, resolve symlinks and re-validate
  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      if (!realPath.startsWith(allowedBase + '/') && realPath !== allowedBase) {
        return { allowed: false, reason: `Symlink escapes project sandbox: ${resolved} -> ${realPath}` };
      }

      // Check symlink target against blocked dirs
      for (const blocked of BLOCKED_PREFIXES) {
        if (realPath.startsWith(blocked + '/') || realPath === blocked) {
          return { allowed: false, reason: `Symlink points to blocked directory: ${realPath}` };
        }
      }
      for (const portalDir of PORTAL_DIRS) {
        if (realPath.startsWith(portalDir + '/') || realPath === portalDir) {
          return { allowed: false, reason: `Symlink points to portal directory: ${realPath}` };
        }
      }
    }
  } catch {
    // If we can't resolve symlinks (broken link, etc.), allow if path check passed
  }

  // Check for null bytes (path injection)
  if (requestedPath.includes('\0')) {
    return { allowed: false, reason: 'Null byte in path' };
  }

  return { allowed: true, resolvedPath: resolved };
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
export function projectPathSandbox(req: Request, res: Response, next: NextFunction): void {
  const userId = req.user?.userId;
  const projectName = req.params.name || req.params.projectName;

  // If no project context, skip (non-project routes)
  if (!projectName || !userId) {
    next();
    return;
  }

  // Collect all possible file path sources
  const pathSources: string[] = [];
  
  // Route wildcard param (e.g., /files/*)
  if (req.params[0]) pathSources.push(req.params[0]);
  
  // Query params
  if (req.query.path) pathSources.push(req.query.path as string);
  if (req.query.filePath) pathSources.push(req.query.filePath as string);
  
  // Body params (for POST/PUT)
  if (req.body?.filePath) pathSources.push(req.body.filePath);
  if (req.body?.path) pathSources.push(req.body.path);
  if (req.body?.targetPath) pathSources.push(req.body.targetPath);

  // Validate each path source
  for (const filePath of pathSources) {
    if (!filePath) continue;
    
    const result = validateProjectPath(filePath, userId, projectName);
    if (!result.allowed) {
      logViolation(userId, projectName, filePath, result.reason, req);
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
export function aiPathSandbox(req: Request, res: Response, next: NextFunction): void {
  const userId = req.user?.userId;
  const projectName = req.body?.projectName || req.query?.project as string;
  const filePath = req.body?.filePath || req.query?.path as string;

  if (!userId || !projectName || !filePath) {
    next();
    return;
  }

  const result = validateProjectPath(filePath, userId, projectName);
  if (!result.allowed) {
    logViolation(userId, projectName, filePath, result.reason, req);
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
