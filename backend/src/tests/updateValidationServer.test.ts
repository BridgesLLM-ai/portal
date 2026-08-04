import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type HttpResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
};

function requestRaw(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

function requestJson(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end();
  });
}

describe('transient Portal update-validation server', () => {
  const originalEnvironment = { ...process.env };
  const originalSigtermListeners = process.listeners('SIGTERM');
  const originalSigintListeners = process.listeners('SIGINT');

  afterAll(() => {
    process.env = originalEnvironment;
    for (const listener of process.listeners('SIGTERM')) {
      if (!originalSigtermListeners.includes(listener)) process.removeListener('SIGTERM', listener);
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!originalSigintListeners.includes(listener)) process.removeListener('SIGINT', listener);
    }
  });

  test('serves authenticated readiness while every startup mutation lane stays dormant', async () => {
    jest.resetModules();
    process.env = {
      ...originalEnvironment,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://portal:portal@127.0.0.1:5432/portal',
      HOST: '127.0.0.1',
      PORT: '0',
      CORS_ORIGIN: 'https://portal.example.invalid',
      JWT_SECRET: 'update-validation-test-jwt-secret-that-is-long-and-not-production',
      JWT_REFRESH_SECRET: 'update-validation-test-refresh-secret-that-is-long-and-not-production',
      PORTAL_UPDATE_PROBE_TOKEN: 'test-update-probe-token',
      PORTAL_UPDATE_VALIDATION_MODE: '1',
    };

    const migrationRoot = path.resolve(__dirname, '../../prisma/migrations');
    const expectedMigrationRows: Array<{
      migration_name: string;
      checksum: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }> = fs.readdirSync(migrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        migration_name: entry.name,
        checksum: crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(migrationRoot, entry.name, 'migration.sql')))
          .digest('hex'),
        finished_at: new Date('2026-07-26T00:00:00.000Z'),
        rolled_back_at: null,
      }))
      .sort((left, right) => left.migration_name.localeCompare(right.migration_name));
    let migrationRows = expectedMigrationRows;
    let databaseAvailable = true;
    let schemaAvailable = true;
    const queryRaw = jest.fn((query: TemplateStringsArray) => {
      if (!databaseAvailable) return Promise.reject(new Error('database unavailable'));
      const sql = Array.from(query).join('');
      if (sql.includes('FROM "_prisma_migrations"')) return Promise.resolve(migrationRows);
      if (sql.includes('CROSS JOIN "ProjectChatTurn"')) {
        if (
          !sql.includes('nativeOllama."grantTemplateHash"')
          || !sql.includes('CROSS JOIN "NativeOllamaBackendBinding" AS nativeOllama')
        ) {
          return Promise.reject(new Error('native Ollama schema proof is missing'));
        }
        return schemaAvailable
          ? Promise.resolve([])
          : Promise.reject(new Error('schema is stale'));
      }
      return Promise.reject(new Error(`Unexpected validation query: ${sql.slice(0, 80)}`));
    });
    const disconnect = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../config/database', () => ({
      prisma: {
        $queryRaw: queryRaw,
        $disconnect: disconnect,
      },
    }));

    const startStartupStatusServer = jest.fn().mockResolvedValue(undefined);
    const stopStartupStatusServer = jest.fn().mockResolvedValue(undefined);
    const setStartupPhase = jest.fn();
    jest.doMock('../services/startupStatusServer', () => ({
      startStartupStatusServer,
      stopStartupStatusServer,
      setStartupPhase,
    }));

    const express = jest.requireActual<typeof import('express')>('express');
    const route = () => express.Router();
    const pass = (_req: unknown, _res: unknown, next: () => void) => next();
    const startup = {
      initializeAppsStorage: jest.fn(),
      initializeProjectStorage: jest.fn(),
      recoverInterruptedCurrentProjectCreations: jest.fn(),
      initializeFileStorage: jest.fn(),
      initializeImageAssetStorage: jest.fn(),
      initializeAgentJobsStorage: jest.fn(),
      initializeHostAgentRunStorage: jest.fn(),
      initializeChunkedUploadRuntime: jest.fn(),
      beginLegacyOpenClawProjectMigration: jest.fn(),
      encryptStoredSecretsAtBoot: jest.fn(),
      initializeMailboxReconciliationRuntime: jest.fn(),
      getMailboxReconciliationReadiness: jest.fn(),
      initializeAgentJobsRuntime: jest.fn(),
      initializeHostAgentRunRuntime: jest.fn(),
      initializeAppProcessRuntime: jest.fn(),
      initializeLegacyProjectContinuityAdoption: jest.fn(),
      initializeBackupConfiguration: jest.fn(),
      loadBlockedIPs: jest.fn(),
      startLogWatcher: jest.fn(),
      startStatusWatcher: jest.fn(),
      initPersistentGatewayWs: jest.fn(),
      initializeCronJobs: jest.fn(),
      startTelemetryService: jest.fn(),
      startAudioProxy: jest.fn(),
      attachPortalWebSocket: jest.fn(),
      attachAgentBrowserWebSocket: jest.fn(),
      reconcilePortalManagedSkill: jest.fn(),
      reconcilePortalVisibleBrowserDefaults: jest.fn(),
      reconcileRemoteDesktopLauncherAssets: jest.fn(),
      provisionAgentZeroDesktopLauncherSecret: jest.fn(),
      retireInternalProjectIdentityDebris: jest.fn(),
    };

    const mockDefaultRoute = (
      modulePath: string,
      extra: Record<string, unknown> = {},
    ) => {
      jest.doMock(modulePath, () => ({
        __esModule: true,
        default: route(),
        ...extra,
      }));
    };

    mockDefaultRoute('../routes/auth');
    mockDefaultRoute('../routes/files', {
      initializeFileStorage: startup.initializeFileStorage,
    });
    mockDefaultRoute('../routes/apps', {
      initializeAppsStorage: startup.initializeAppsStorage,
      shareRouter: route(),
    });
    mockDefaultRoute('../routes/activity');
    mockDefaultRoute('../routes/chunked-upload', {
      initializeChunkedUploadRuntime: startup.initializeChunkedUploadRuntime,
      shutdownChunkedUploadRuntime: jest.fn(),
    });
    mockDefaultRoute('../routes/projects', {
      initializeProjectStorage: startup.initializeProjectStorage,
      recoverInterruptedCurrentProjectCreations: startup.recoverInterruptedCurrentProjectCreations,
    });
    for (const modulePath of [
      '../routes/ai',
      '../routes/terminal',
      '../routes/alerts',
      '../routes/system-stats',
      '../routes/system-maintenance',
      '../routes/system-readiness',
      '../routes/backups',
      '../routes/users',
      '../routes/admin',
      '../routes/system-control',
      '../routes/settings-public',
      '../routes/agent-jobs',
      '../routes/agent-tools',
      '../routes/agent-runtime',
      '../routes/ollama',
      '../routes/system-remediation',
      '../routes/mail',
      '../routes/automations',
      '../routes/skills',
    ]) {
      mockDefaultRoute(modulePath);
    }
    mockDefaultRoute('../routes/gateway', {
      attachPortalWebSocket: startup.attachPortalWebSocket,
    });
    mockDefaultRoute('../routes/agentBrowser', {
      attachAgentBrowserWebSocket: startup.attachAgentBrowserWebSocket,
    });
    mockDefaultRoute('../routes/remote-desktop', {
      reconcilePortalManagedSkill: startup.reconcilePortalManagedSkill,
      reconcilePortalVisibleBrowserDefaults: startup.reconcilePortalVisibleBrowserDefaults,
      reconcileRemoteDesktopLauncherAssets: startup.reconcileRemoteDesktopLauncherAssets,
    });
    mockDefaultRoute('../routes/setup-v3', {
      requireSetupPending: pass,
      requireSetupToken: pass,
    });
    jest.doMock('../routes/ai-setup', () => ({
      __esModule: true,
      createAiSetupRouter: () => route(),
    }));
    jest.doMock('../routes/exec', () => ({
      setupTerminalNamespace: jest.fn(),
    }));
    jest.doMock('../middleware/pathSandbox', () => ({
      projectPathSandbox: pass,
      aiPathSandbox: pass,
    }));

    jest.doMock('../services/imageAssets', () => ({
      ASSETS_ROOT: '/tmp/update-validation-assets-not-used',
      initializeImageAssetStorage: startup.initializeImageAssetStorage,
      isSafeMutableImageAssetPath: jest.fn(() => false),
    }));
    jest.doMock('../services/agentJobs', () => ({
      initializeAgentJobsRuntime: startup.initializeAgentJobsRuntime,
      initializeAgentJobsStorage: startup.initializeAgentJobsStorage,
      onAgentJobOutput: jest.fn(),
      onAgentJobStatus: jest.fn(),
      readTranscript: jest.fn(),
      shutdownAgentJobsRuntime: jest.fn(),
    }));
    jest.doMock('../services/hostAgentRunJournal', () => ({
      initializeHostAgentRunRuntime: startup.initializeHostAgentRunRuntime,
      initializeHostAgentRunStorage: startup.initializeHostAgentRunStorage,
      shutdownHostAgentRunRuntime: jest.fn(),
    }));
    jest.doMock('../services/app-process.service', () => ({
      getAppTarget: jest.fn(),
      initializeAppProcessRuntime: startup.initializeAppProcessRuntime,
      shutdownAll: jest.fn(),
    }));
    jest.doMock('../services/legacyProjectContinuityAdoption', () => ({
      initializeLegacyProjectContinuityAdoption: startup.initializeLegacyProjectContinuityAdoption,
    }));
    jest.doMock('../services/storedSecretBackfill', () => ({
      encryptStoredSecretsAtBoot: startup.encryptStoredSecretsAtBoot,
    }));
    jest.doMock('../services/mailboxReconciliation', () => ({
      getMailboxReconciliationReadiness: startup.getMailboxReconciliationReadiness,
      initializeMailboxReconciliationRuntime: startup.initializeMailboxReconciliationRuntime,
      shutdownMailboxReconciliationRuntime: jest.fn(),
    }));
    jest.doMock('../services/backup.service', () => ({
      initializeBackupConfiguration: startup.initializeBackupConfiguration,
    }));
    jest.doMock('../services/legacyOpenClawProjectRetirement', () => ({
      beginLegacyOpenClawProjectMigration: startup.beginLegacyOpenClawProjectMigration,
      legacyOpenClawProjectMigrationRetryDelayMs: jest.fn(),
      LegacyOpenClawProjectRetirementError: class extends Error {},
      shouldRetryLegacyOpenClawProjectMigration: jest.fn(() => false),
    }));
    jest.doMock('../services/agentZeroDesktopLaunch', () => ({
      provisionAgentZeroDesktopLauncherSecret: startup.provisionAgentZeroDesktopLauncherSecret,
    }));
    jest.doMock('../services/projectIdentity', () => ({
      retireInternalProjectIdentityDebris: startup.retireInternalProjectIdentityDebris,
    }));
    jest.doMock('../utils/auth-tracking', () => ({
      blockedIPs: new Set<string>(),
      extractIP: jest.fn(() => '127.0.0.1'),
      loadBlockedIPs: startup.loadBlockedIPs,
    }));
    jest.doMock('../utils/logWatcher', () => ({
      startLogWatcher: startup.startLogWatcher,
      stopLogWatcher: jest.fn(),
      onAlert: jest.fn(),
    }));
    jest.doMock('../utils/openclawStatusWatcher', () => ({
      startStatusWatcher: startup.startStatusWatcher,
      stopStatusWatcher: jest.fn(),
      onAgentStatus: jest.fn(),
    }));
    jest.doMock('../agents/providers/PersistentGatewayWs', () => ({
      initPersistentGatewayWs: startup.initPersistentGatewayWs,
      shutdownPersistentGatewayWs: jest.fn(),
    }));
    jest.doMock('../cron-jobs', () => ({
      initializeCronJobs: startup.initializeCronJobs,
      shutdownCronJobs: jest.fn(),
    }));
    jest.doMock('../services/telemetryService', () => ({
      startTelemetryService: startup.startTelemetryService,
      stopTelemetryService: jest.fn(),
    }));
    jest.doMock('../services/audioProxy', () => ({
      startAudioProxy: startup.startAudioProxy,
      stopAudioProxy: jest.fn(),
    }));

    // Loading the metrics router starts a database cleanup timer at module
    // scope. Validation mode must avoid evaluating the module altogether.
    const metricsModuleLoaded = jest.fn();
    jest.doMock('../routes/metrics', () => {
      metricsModuleLoaded();
      throw new Error('metrics module must stay unloaded during update validation');
    });

    const server = await import('../server');
    expect(server.PORTAL_UPDATE_VALIDATION_MODE).toBe(true);
    expect(server.isUpdateValidationLoopbackHost('127.0.0.1')).toBe(true);
    expect(server.isUpdateValidationLoopbackHost('::1')).toBe(true);
    expect(server.isUpdateValidationLoopbackHost('localhost')).toBe(false);
    expect(server.isUpdateValidationLoopbackHost('0.0.0.0')).toBe(false);

    await server.startServer();
    const address = server.httpServer.address();
    expect(address).not.toBeNull();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const health = await requestJson(port, '/health');
    expect(health.status).toBe(200);
    expect(health.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(health.body).toMatchObject({
      status: 'ok',
      database: 'ready',
      updateValidation: true,
      migrationCount: expectedMigrationRows.length,
      migrationHead: expectedMigrationRows[expectedMigrationRows.length - 1].migration_name,
    });
    expect(typeof health.body.version).toBe('string');

    const readiness = await requestJson(port, '/health/update-ready', {
      headers: { 'x-portal-update-probe': 'test-update-probe-token' },
    });
    expect(readiness.status).toBe(200);
    expect(readiness.body).toMatchObject({
      status: 'ready',
      database: 'ready',
      updateValidation: true,
      version: health.body.version,
      migrationCount: health.body.migrationCount,
      migrationHead: health.body.migrationHead,
    });

    const unauthorizedReadiness = await requestJson(port, '/health/update-ready');
    expect(unauthorizedReadiness.status).toBe(401);
    expect(unauthorizedReadiness.headers['cache-control']).toBe('private, no-store, max-age=0');
    expect(unauthorizedReadiness.body).toEqual({ status: 'unauthorized' });

    const blockedApi = await requestJson(port, '/api/settings/public');
    expect(blockedApi.status).toBe(503);
    expect(blockedApi.body).toEqual({
      status: 'unavailable',
      code: 'UPDATE_VALIDATION_HEALTH_ONLY',
    });

    const blockedHealthMutation = await requestJson(port, '/health', { method: 'POST' });
    expect(blockedHealthMutation.status).toBe(503);
    expect(blockedHealthMutation.body).toEqual({
      status: 'unavailable',
      code: 'UPDATE_VALIDATION_HEALTH_ONLY',
    });

    const blockedPreflight = await requestJson(port, '/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.invalid',
        'access-control-request-method': 'POST',
      },
    });
    expect(blockedPreflight.status).toBe(503);
    expect(blockedPreflight.body.code).toBe('UPDATE_VALIDATION_HEALTH_ONLY');

    const blockedSocketIo = await requestRaw(port, '/socket.io/?EIO=4&transport=polling');
    expect(blockedSocketIo.status).toBeGreaterThanOrEqual(400);
    expect(blockedSocketIo.status).toBeLessThan(500);

    migrationRows = expectedMigrationRows.slice(0, -1);
    const missingMigration = await requestJson(port, '/health');
    expect(missingMigration.status).toBe(503);
    expect(missingMigration.body.database).toBe('unavailable');

    migrationRows = [
      ...expectedMigrationRows,
      {
        migration_name: '20260724_failed_candidate',
        checksum: '1'.repeat(64),
        finished_at: null,
        rolled_back_at: null,
      },
    ];
    const failedMigration = await requestJson(port, '/health');
    expect(failedMigration.status).toBe(503);
    expect(failedMigration.body.database).toBe('unavailable');

    migrationRows = expectedMigrationRows.map((migration, index) => (
      index === expectedMigrationRows.length - 1
        ? { ...migration, checksum: '0'.repeat(64) }
        : migration
    ));
    const changedMigration = await requestJson(port, '/health');
    expect(changedMigration.status).toBe(503);
    expect(changedMigration.body.database).toBe('unavailable');

    migrationRows = [...expectedMigrationRows];
    [migrationRows[0], migrationRows[1]] = [
      migrationRows[1],
      migrationRows[0],
    ];
    const reorderedMigrations = await requestJson(port, '/health');
    expect(reorderedMigrations.status).toBe(503);
    expect(reorderedMigrations.body.database).toBe('unavailable');

    migrationRows = expectedMigrationRows;
    schemaAvailable = false;
    const staleSchema = await requestJson(port, '/health');
    expect(staleSchema.status).toBe(503);
    expect(staleSchema.body.database).toBe('unavailable');

    schemaAvailable = true;
    databaseAvailable = false;
    const failedHealth = await requestJson(port, '/health');
    expect(failedHealth.status).toBe(503);
    expect(failedHealth.body).toMatchObject({
      status: 'unavailable',
      database: 'unavailable',
      updateValidation: true,
      version: health.body.version,
    });

    expect(metricsModuleLoaded).not.toHaveBeenCalled();
    for (const spy of Object.values(startup)) expect(spy).not.toHaveBeenCalled();
    expect(startStartupStatusServer).toHaveBeenCalledWith(0, '127.0.0.1');
    expect(stopStartupStatusServer).toHaveBeenCalledTimes(1);
    expect(setStartupPhase.mock.calls.map(([phase]) => phase)).toEqual([
      'database-connection',
      'finalizing',
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(13);

    server.httpServer.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }, 30_000);

  test('boots with the real production module graph without importing the mutating metrics timer', async () => {
    const childScript = String.raw`
      const crypto = require('crypto');
      const fs = require('fs');
      const http = require('http');
      const path = require('path');
      const Module = require('module');

      const migrationRoot = path.resolve('prisma/migrations');
      const migrationRows = fs.readdirSync(migrationRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          migration_name: entry.name,
          checksum: crypto.createHash('sha256')
            .update(fs.readFileSync(path.join(migrationRoot, entry.name, 'migration.sql')))
            .digest('hex'),
          finished_at: new Date('2026-07-26T00:00:00.000Z'),
          rolled_back_at: null,
        }))
        .sort((left, right) => left.migration_name.localeCompare(right.migration_name));

      let queryCount = 0;
      const prisma = new Proxy({
        $queryRaw(query) {
          queryCount += 1;
          const sql = Array.from(query).join('');
          if (sql.includes('FROM "_prisma_migrations"')) return Promise.resolve(migrationRows);
          if (sql.includes('CROSS JOIN "ProjectChatTurn"')) {
            if (
              !sql.includes('nativeOllama."grantTemplateHash"')
              || !sql.includes('CROSS JOIN "NativeOllamaBackendBinding" AS nativeOllama')
            ) {
              return Promise.reject(new Error('native Ollama schema proof is missing'));
            }
            return Promise.resolve([]);
          }
          return Promise.reject(new Error('unexpected database query during validation'));
        },
        $disconnect() {
          return Promise.resolve();
        },
      }, {
        get(target, property) {
          if (property in target) return target[property];
          return new Proxy(function unexpectedPrismaAccess() {}, {
            apply() {
              throw new Error('unexpected Prisma operation during validation: ' + String(property));
            },
            get() {
              return new Proxy(function unexpectedNestedPrismaAccess() {}, {
                apply() {
                  throw new Error('unexpected nested Prisma operation during validation: ' + String(property));
                },
              });
            },
          });
        },
      });

      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (
          request === './config/database'
          || request === '../config/database'
          || request.endsWith('/config/database')
        ) {
          return { prisma, default: prisma };
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      function request(port, requestPath) {
        return new Promise((resolve, reject) => {
          const req = http.get({
            host: '127.0.0.1',
            port,
            path: requestPath,
            headers: requestPath === '/health/update-ready'
              ? { 'x-portal-update-probe': 'compiled-child-probe-token' }
              : undefined,
          }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString('utf8'),
            }));
          });
          req.once('error', reject);
        });
      }

      (async () => {
        const server = require('./src/server.ts');
        await server.startServer();
        const address = server.httpServer.address();
        if (!address || typeof address !== 'object') throw new Error('validation listener did not bind');
        const readiness = await request(address.port, '/health/update-ready');
        if (readiness.status !== 200) throw new Error('validation readiness did not return 200');
        const body = JSON.parse(readiness.body);
        if (
          body.status !== 'ready'
          || body.database !== 'ready'
          || body.updateValidation !== true
          || body.migrationCount !== migrationRows.length
        ) {
          throw new Error('validation readiness contract mismatch');
        }
        const api = await request(address.port, '/api/settings/public');
        if (api.status !== 503) throw new Error('non-health route escaped validation gate');
        if (
          Object.keys(require.cache).some((filename) =>
            filename.endsWith(path.join('src', 'routes', 'metrics.ts')))
        ) {
          throw new Error('metrics module loaded during validation');
        }
        if (queryCount !== 4) throw new Error('unexpected validation database work');
        server.httpServer.closeAllConnections?.();
        await new Promise((resolve, reject) => {
          server.httpServer.close((error) => error ? reject(error) : resolve());
        });
        process.stdout.write('real-module-validation-ok\n');
      })().then(() => process.exit(0)).catch((error) => {
        process.stderr.write(String(error && error.stack || error) + '\n');
        process.exit(1);
      });
    `;

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', childScript],
      {
        cwd: path.resolve(__dirname, '../..'),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          NODE_NO_WARNINGS: '1',
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://portal:portal@127.0.0.1:5432/portal',
          HOST: '127.0.0.1',
          PORT: '0',
          CORS_ORIGIN: 'https://portal.example.invalid',
          JWT_SECRET: 'compiled-child-validation-jwt-secret-that-is-not-production',
          JWT_REFRESH_SECRET: 'compiled-child-validation-refresh-secret-that-is-not-production',
          PORTAL_UPDATE_PROBE_TOKEN: 'compiled-child-probe-token',
          PORTAL_UPDATE_VALIDATION_MODE: '1',
        },
      },
    );
    expect(stderr).toBe('');
    expect(stdout).toContain('real-module-validation-ok');
  }, 30_000);
});
