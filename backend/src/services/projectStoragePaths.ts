import path from 'path';

export interface ProjectStorageOptions {
  projectsDir?: string;
  deployDir?: string;
  zipsDir?: string;
  uploadTempDir?: string;
  portalRoot?: string;
}

/** Neutral storage-path configuration shared by routes and lifecycle guards. */
export function resolveProjectStoragePaths(options: ProjectStorageOptions = {}) {
  const portalRoot = path.resolve(
    options.portalRoot
      || process.env.PORTAL_DATA_ROOT
      || process.env.PORTAL_ROOT
      || '/portal',
  );
  return {
    projectsDir: path.resolve(
      options.projectsDir
        || process.env.PORTAL_PROJECTS_ROOT
        || path.join(portalRoot, 'projects'),
    ),
    deployDir: path.resolve(
      options.deployDir
        || process.env.APPS_ROOT
        || '/var/www/bridgesllm-apps',
    ),
    zipsDir: path.resolve(
      options.zipsDir
        || process.env.PORTAL_PROJECT_ZIPS_ROOT
        || path.join(portalRoot, 'project-zips'),
    ),
    uploadTempDir: path.resolve(
      options.uploadTempDir
        || process.env.PORTAL_UPLOAD_TEMP_ROOT
        || path.join(portalRoot, 'upload-temp'),
    ),
  };
}
