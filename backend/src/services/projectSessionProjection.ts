import {
  PROJECT_METADATA_MAX_BYTES,
  readProjectTextFile,
  writeProjectRuntimeTextFile,
} from './projectSurfacePolicy';

const PROJECT_SESSION_PROJECTION_FILE = '.agent-session.json';
const MAX_PROJECTION_STRING_LENGTH = 512;

export interface ProjectSessionProjection {
  initialized?: boolean;
  model?: string;
  modelConfigured?: boolean;
  lastActivity?: string;
  stableSlug?: string;
}

function boundedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_PROJECTION_STRING_LENGTH
    ? value
    : undefined;
}

function sanitizeProjection(value: unknown): ProjectSessionProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  return {
    ...(typeof candidate.initialized === 'boolean' ? { initialized: candidate.initialized } : {}),
    ...(boundedString(candidate.model) !== undefined ? { model: boundedString(candidate.model) } : {}),
    ...(typeof candidate.modelConfigured === 'boolean'
      ? { modelConfigured: candidate.modelConfigured }
      : {}),
    ...(boundedString(candidate.lastActivity) !== undefined
      ? { lastActivity: boundedString(candidate.lastActivity) }
      : {}),
    ...(boundedString(candidate.stableSlug) !== undefined
      ? { stableSlug: boundedString(candidate.stableSlug) }
      : {}),
  };
}

/**
 * Update the legacy project-side session projection without making it part of
 * runtime authority. The provider can write inside the project tree, so this
 * file is untrusted compatibility output: malformed JSON, a replaced path, or
 * an unwritable projection must never fail an admitted Project Chat operation.
 */
export function writeProjectSessionProjectionBestEffort(
  projectRoot: string,
  patch: ProjectSessionProjection,
  logError: (message: string) => void = (message) => console.warn(message),
): boolean {
  try {
    const raw = readProjectTextFile(
      projectRoot,
      PROJECT_SESSION_PROJECTION_FILE,
      { optional: true, maxBytes: PROJECT_METADATA_MAX_BYTES },
    );
    if (raw) sanitizeProjection(JSON.parse(raw));
  } catch (error: any) {
    // Missing, malformed, oversized, or path-replaced projections are all
    // safely rebuilt. Do not include file contents in logs.
    if (error?.code !== 'ENOENT') {
      logError(`[Project Chat] Ignoring invalid legacy session projection (${String(error?.code || 'INVALID')}).`);
    }
  }

  try {
    writeProjectRuntimeTextFile(
      projectRoot,
      PROJECT_SESSION_PROJECTION_FILE,
      JSON.stringify(sanitizeProjection(patch), null, 2),
      PROJECT_METADATA_MAX_BYTES,
    );
    return true;
  } catch (error: any) {
    logError(`[Project Chat] Legacy session projection was not updated (${String(error?.code || 'WRITE_FAILED')}).`);
    return false;
  }
}

export const __projectSessionProjectionTest = {
  sanitizeProjection,
};
