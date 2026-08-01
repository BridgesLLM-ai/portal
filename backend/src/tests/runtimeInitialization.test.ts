import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureRuntimeDirectory } from '../utils/runtimeDirectory';

const ENV_KEYS = [
  'PORTAL_ROOT',
  'PORTAL_DATA_ROOT',
  'PORTAL_DEVICE_KEYS_PATH',
  'PORTAL_APPS_ROOT',
  'PORTAL_APP_ZIPS_ROOT',
  'PORTAL_PROJECTS_ROOT',
  'PORTAL_PROJECT_ZIPS_ROOT',
  'PORTAL_UPLOAD_TEMP_ROOT',
  'PORTAL_FILES_ROOT',
  'PORTAL_OPENCLAW_MEDIA_MIRROR_ROOT',
  'PORTAL_UPLOAD_CHUNKS_ROOT',
  'PORTAL_ASSETS_ROOT',
  'PORTAL_AGENT_JOBS_ROOT',
  'APPS_ROOT',
] as const;

describe('runtime storage initialization', () => {
  let tempRoot: string;
  let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-runtime-init-'));
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const previous = previousEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    jest.resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('route and service imports do not create configured host directories', () => {
    const portalRoot = path.join(tempRoot, 'portal-data');
    const deviceKeysPath = path.join(portalRoot, 'projects', '.openclaw-portal-device.json');
    const expectedDirectories = {
      apps: path.join(portalRoot, 'apps'),
      appZips: path.join(portalRoot, 'app-zips'),
      projects: path.join(portalRoot, 'projects'),
      projectZips: path.join(portalRoot, 'project-zips'),
      uploadTemp: path.join(portalRoot, 'upload-temp'),
      files: path.join(tempRoot, 'files'),
      mediaMirror: path.join(tempRoot, 'openclaw-media'),
      chunks: path.join(tempRoot, 'upload-chunks'),
      assets: path.join(tempRoot, 'assets'),
      jobs: path.join(tempRoot, 'agent-jobs'),
      hostedApps: path.join(tempRoot, 'hosted-apps'),
    };

    process.env.PORTAL_ROOT = portalRoot;
    process.env.PORTAL_DATA_ROOT = portalRoot;
    process.env.PORTAL_DEVICE_KEYS_PATH = deviceKeysPath;
    process.env.PORTAL_APPS_ROOT = expectedDirectories.apps;
    process.env.PORTAL_APP_ZIPS_ROOT = expectedDirectories.appZips;
    process.env.PORTAL_PROJECTS_ROOT = expectedDirectories.projects;
    process.env.PORTAL_PROJECT_ZIPS_ROOT = expectedDirectories.projectZips;
    process.env.PORTAL_UPLOAD_TEMP_ROOT = expectedDirectories.uploadTemp;
    process.env.PORTAL_FILES_ROOT = expectedDirectories.files;
    process.env.PORTAL_OPENCLAW_MEDIA_MIRROR_ROOT = expectedDirectories.mediaMirror;
    process.env.PORTAL_UPLOAD_CHUNKS_ROOT = expectedDirectories.chunks;
    process.env.PORTAL_ASSETS_ROOT = expectedDirectories.assets;
    process.env.PORTAL_AGENT_JOBS_ROOT = expectedDirectories.jobs;
    process.env.APPS_ROOT = expectedDirectories.hostedApps;

    jest.resetModules();
    const deviceIdentity = require('../utils/deviceIdentity') as typeof import('../utils/deviceIdentity');
    const imageAssets = require('../services/imageAssets') as typeof import('../services/imageAssets');
    const agentJobs = require('../services/agentJobs') as typeof import('../services/agentJobs');
    const apps = require('../routes/apps') as typeof import('../routes/apps');
    const projects = require('../routes/projects') as typeof import('../routes/projects');
    const files = require('../routes/files') as typeof import('../routes/files');
    const chunkedUpload = require('../routes/chunked-upload') as typeof import('../routes/chunked-upload');

    for (const directory of Object.values(expectedDirectories)) {
      expect(fs.existsSync(directory)).toBe(false);
    }
    expect(fs.existsSync(deviceKeysPath)).toBe(false);

    apps.initializeAppsStorage();
    projects.initializeProjectStorage();
    files.initializeFileStorage();
    imageAssets.initializeImageAssetStorage();
    agentJobs.initializeAgentJobsStorage();
    chunkedUpload.initializeChunkedUploadRuntime();
    ensureRuntimeDirectory(expectedDirectories.hostedApps);
    const keys = deviceIdentity.getOrCreateDeviceKeys();

    expect(keys.deviceId).toMatch(/^[a-f0-9]{64}$/);
    for (const directory of Object.values(expectedDirectories)) {
      expect(fs.realpathSync(directory)).toBe(path.resolve(directory));
    }
    expect(fs.statSync(deviceKeysPath).mode & 0o777).toBe(0o600);
    chunkedUpload.shutdownChunkedUploadRuntime();
  });

  test('rejects symbolic links in a configured runtime root', () => {
    const outside = path.join(tempRoot, 'outside');
    const redirected = path.join(tempRoot, 'redirected');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, redirected);

    expect(() => ensureRuntimeDirectory(path.join(redirected, 'jobs')))
      .toThrow(/unsafe path component/i);
    expect(fs.existsSync(path.join(outside, 'jobs'))).toBe(false);
  });

  test('stores the Portal device identity under the canonical configured Projects root', () => {
    const portalRoot = path.join(tempRoot, 'replaceable-portal-runtime');
    const projectsRoot = path.join(tempRoot, 'durable-projects');
    process.env.PORTAL_ROOT = portalRoot;
    process.env.PORTAL_PROJECTS_ROOT = projectsRoot;
    delete process.env.PORTAL_DEVICE_KEYS_PATH;

    jest.resetModules();
    const { resolveDeviceKeysPath } = require('../utils/deviceIdentity') as typeof import('../utils/deviceIdentity');
    expect(resolveDeviceKeysPath()).toBe(
      path.join(projectsRoot, '.openclaw-portal-device.json'),
    );
  });

  test('device identity refuses a symbolic-link key path', () => {
    const target = path.join(tempRoot, 'target.json');
    const link = path.join(tempRoot, 'device.json');
    fs.writeFileSync(target, 'do-not-overwrite');
    fs.symlinkSync(target, link);

    jest.resetModules();
    const { getOrCreateDeviceKeys } = require('../utils/deviceIdentity') as typeof import('../utils/deviceIdentity');
    expect(() => getOrCreateDeviceKeys({ deviceKeysPath: link })).toThrow(/not a regular file/i);
    expect(fs.readFileSync(target, 'utf8')).toBe('do-not-overwrite');
  });
});
