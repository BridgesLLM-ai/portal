jest.mock('node-pty', () => ({ spawn: jest.fn() }));
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { createAiSetupRouter } from '../routes/ai-setup';
import { requireAdmin } from '../middleware/requireAdmin';
import { ProviderActivationService } from '../services/providerActivation';
import { ProviderSetupWizard } from '../services/providerSetupWizard';
import { __setProviderCredentialLifecycleLedgerPathForTests } from '../services/providerCredentialLifecycleLedger';
const Ajv = require('ajv');
const schemas = require('./fixtures/openclaw-2026.9.3/provider-setup.schemas.json');
const nativeChoices = require('./fixtures/openclaw-2026.9.3/provider-auth-choices.json');
const modelSchemas = require('./fixtures/openclaw-2026.9.3/provider-model-config.schemas.json');
const ajv = new Ajv({ strict: false });
const validators = Object.fromEntries(Object.entries(schemas).map(([key, value]) => [key, ajv.compile(value)]));
const validateModels = ajv.compile(modelSchemas.modelMap);
const validatePrimary = ajv.compile(modelSchemas.model);
const methods: Record<string, string> = {
  'models.probe': 'modelsProbe', 'models.list': 'modelsList', 'models.authStatus': 'modelsAuthStatus', 'config.patch': 'configPatch',
  'openclaw.setup.detect': 'detect', 'openclaw.setup.prepare.start': 'prepare',
  'wizard.next': 'wizardNext', 'wizard.cancel': 'wizardCancel',
};
function clone(value: any) { return JSON.parse(JSON.stringify(value)); }
function merge(base: any, patch: any): any {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const next = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]; else next[key] = merge(next[key], value);
  }
  return next;
}

describe('actual provider setup HTTP handlers against pinned OpenClaw 2026.9.3 schemas', () => {
  let dir: string, server: any, baseUrl: string;
  let config: any, initial: any, version: number, calls: Array<[string, any]>;
  let models: any[], candidates: any[], authOptions: any[], cliCatalogs: any[];
  let proof: { fingerprint: string; absent: boolean };
  let wizardReply: any, losePatchReply: boolean, readbackUnavailable: boolean, missingWizard: boolean, rejectPatch: boolean;
  let wizard: ProviderSetupWizard, activation: ProviderActivationService, rpc: any;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-handlers-'));
    __setProviderCredentialLifecycleLedgerPathForTests(path.join(dir, 'lifecycle.sqlite3'));
    config = { agents: { entries: { main: { default: true }, other: { model: 'other/keep' } }, defaults: {
      model: { primary: 'other/keep', fallbacks: ['other/backup'] },
      models: { 'other/keep': { alias: 'kept', params: { temperature: 0.4 } },
        'anthropic/claude-sonnet-4-6': { alias: 'Claude', params: { custom: true }, agentRuntime: { id: 'claude-cli' } } },
    } }, auth: { profiles: { 'anthropic:cli': { provider: 'anthropic', mode: 'token' }, 'other:saved': { provider: 'other', mode: 'api_key' } },
      order: { other: ['other:saved'] } }, plugins: { entries: { untouched: { enabled: true } } } };
    initial = clone(config); version = 1; calls = [];
    models = [
      { id: 'claude-sonnet-4-6', provider: 'anthropic', available: true, agentRuntime: { id: 'claude-cli' } },
      { id: 'gpt-6-astra', provider: 'openai', available: true, agentRuntime: { id: 'codex' } },
      { id: 'gpt-no-entitlement', provider: 'openai', available: false },
      { id: 'grok-4.5', provider: 'xai', available: true },
      { id: 'gemini-3.1-pro-preview', provider: 'google', available: true, agentRuntime: { id: 'google-gemini-cli' } },
    ];
    candidates = []; cliCatalogs = [];
    authOptions = [{ id: 'xai-oauth', kind: 'device-code' }, { id: 'openai', kind: 'oauth' },
      { id: 'google-gemini-cli', kind: 'oauth' }, { id: 'github-copilot', kind: 'device-code' }];
    proof = { fingerprint: 'initial-empty-domain', absent: true };
    wizardReply = { done: false, status: 'running', step: { id: 'step-1', type: 'text', sensitive: true, message: 'Authorize', initialValue: 'must-not-leak' } };
    losePatchReply = false; readbackUnavailable = false; missingWizard = false; rejectPatch = false;
    rpc = jest.fn(async (method: string, params: any) => {
      calls.push([method, clone(params)]);
      if (methods[method]) {
        const validate = validators[methods[method]];
        if (!validate(params)) throw new Error('Native schema rejected ' + method + ': ' + JSON.stringify(validate.errors));
      }
      if (method === 'config.get') return readbackUnavailable && version > 1 ? { ok: false } : { ok: true, data: { config: clone(config), hash: String(version), valid: true } };
      if (method === 'models.authStatus') return { ok: true, data: { providers: Object.entries<any>(config.auth.profiles)
        .map(([id, profile]) => ({ provider: profile.provider, profiles: [{ profileId: id, status: 'ok' }] })) } };
      if (method === 'models.probe') return { ok: true, data: { provider: params.provider, status: 'ok' } };
      if (method === 'models.list') return { ok: true, data: { models } };
      if (method === 'openclaw.setup.detect') return { ok: true, data: { candidates, authOptions } };
      if (method === 'config.patch') {
        if (rejectPatch || params.baseHash !== String(version)) return { ok: false, errorCode: 'INVALID_REQUEST' };
        const patch = JSON.parse(params.raw);
        const next = merge(config, patch);
        expect(validateModels(next.agents.defaults.models)).toBe(true);
        expect(validatePrimary(next.agents.defaults.model)).toBe(true);
        config = next; version++;
        return losePatchReply ? { ok: false, errorCode: 'TIMEOUT' } : { ok: true };
      }
      if (method === 'openclaw.setup.prepare.start') return { ok: true, data: { sessionId: params.sessionId, done: false, status: 'running' } };
      if (method === 'wizard.next') return missingWizard ? { ok: false, errorCode: 'INVALID_REQUEST', error: 'wizard not found' } : { ok: true, data: wizardReply };
      if (method === 'wizard.cancel') return { ok: true, data: { status: 'cancelled' } };
      throw new Error('Unexpected native operation: ' + method);
    });
    activation = new ProviderActivationService(rpc, async () => {}, async () => cliCatalogs);
    wizard = new ProviderSetupWizard({ rpc, proof: async () => proof, fence: async () => {}, journalPath: () => path.join(dir, 'wizard.sqlite3') });
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => {
      if (req.headers['x-test-user']) req.user = { userId: req.headers['x-test-user'], role: req.headers['x-test-role'] || 'OWNER' };
      next();
    });
    app.use('/api/ai-setup', requireAdmin, createAiSetupRouter({ activation, wizard }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/ai-setup';
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(resolve));
    __setProviderCredentialLifecycleLedgerPathForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function request(route: string, body?: any, user: string | null = 'owner', role = 'OWNER') {
    const response = await fetch(baseUrl + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user, 'x-test-role': role } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  test('unauthenticated and non-admin requests cannot discover or mutate', async () => {
    expect((await request('/set-default-model', { model: 'openai/gpt-6-astra' }, null)).status).toBe(403);
    expect((await request('/oauth/providers', undefined, 'member', 'USER')).status).toBe(403);
    expect(calls).toEqual([]);
  });
  test('discovery is authenticated, credential-aware and has no config side effects', async () => {
    const result = await request('/models?provider=openai-codex&refresh=1');
    expect(result.body.models.find((m: any) => m.id === 'openai/gpt-6-astra')).toMatchObject({ ready: true, runtime: 'codex' });
    expect(result.body.models.find((m: any) => m.id === 'openai/gpt-no-entitlement').ready).toBe(false);
    expect(config).toEqual(initial);
    expect(calls.every(([method]) => !method.includes('patch'))).toBe(true);
  });
  test.each([
    ['openai-codex', 'openai/gpt-6-astra', 'codex'],
    ['google-gemini-cli', 'google/gemini-3.1-pro-preview', 'google-gemini-cli'],
    ['xai', 'xai/grok-4.5', 'openclaw'],
  ])('registers %s with correct per-model runtime and no default overwrite', async (provider, model, runtime) => {
    const result = await request('/register-models', { provider, models: [model] });
    expect(result.status).toBe(200);
    expect(config.agents.defaults.models[model]).toEqual({ agentRuntime: { id: runtime } });
    expect(config.agents.defaults.model).toEqual(initial.agents.defaults.model);
    expect(config.auth).toEqual(initial.auth);
    expect(config.plugins).toEqual(initial.plugins);
    expect(config.agents.entries).toEqual(initial.agents.entries);
    expect(config.agents.defaults.models['anthropic/claude-sonnet-4-6']).toEqual(initial.agents.defaults.models['anthropic/claude-sonnet-4-6']);
  });
  test('explicit Claude selection retains credential profiles, model settings and fallback order', async () => {
    const result = await request('/set-default-model', { provider: 'anthropic', model: 'anthropic/claude-sonnet-4-6', profileId: 'anthropic:cli' });
    expect(result.status).toBe(200);
    expect(config.agents.defaults.model).toEqual({ primary: 'anthropic/claude-sonnet-4-6@anthropic:cli', fallbacks: ['other/backup'] });
    expect(config.agents.defaults.models).toEqual(initial.agents.defaults.models);
    expect(config.auth).toEqual(initial.auth);
    expect(JSON.parse(calls.find(([m]) => m === 'config.patch')![1].raw)).toEqual({
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-6@anthropic:cli' } } },
    });
  });
  test('ready detector candidate permits existing process-free Claude credential activation without re-login', async () => {
    delete config.agents.defaults.models['anthropic/claude-sonnet-4-6'];
    models[0].available = false; models[0].agentRuntime = { id: 'openclaw' };
    candidates = [{ kind: 'claude-cli', modelRef: 'claude-cli/claude-opus-5' }];
    cliCatalogs = [{ runtime: 'claude-cli', models: ['anthropic/claude-sonnet-4-6'], loginPresent: true }];
    expect((await request('/set-default-model', { provider: 'anthropic', model: 'anthropic/claude-sonnet-4-6' })).status).toBe(200);
    expect(config.agents.defaults.models['anthropic/claude-sonnet-4-6'].agentRuntime.id).toBe('claude-cli');
    expect(calls.some(([m]) => m.includes('prepare'))).toBe(false);
  });
  test('harness-ready native rows without agentRuntime register the CLI runtime, never the host runtime', async () => {
    // TEST baseline on 2026.9.3: an authenticated Claude CLI, no anthropic auth
    // profile, and models.list rows named "(Claude CLI)" that are available:true
    // but carry no agentRuntime because the harness policy is "auto".
    delete config.agents.defaults.models['anthropic/claude-sonnet-4-6'];
    delete config.auth.profiles['anthropic:cli'];
    const baseline = clone(config);
    models[0] = { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Claude CLI)', provider: 'anthropic', available: true };
    models[1] = { id: 'gpt-6-astra', name: 'GPT-6 Astra (Codex)', provider: 'openai', available: true };
    candidates = [{ kind: 'claude-cli', modelRef: 'claude-cli/claude-opus-5' }, { kind: 'codex-cli', modelRef: 'openai/gpt-5.6-sol' }];
    cliCatalogs = [
      { runtime: 'claude-cli', models: ['anthropic/claude-sonnet-4-6'], loginPresent: true },
      { runtime: 'codex', models: ['openai/gpt-6-astra'], loginPresent: true },
    ];
    const discovered = await request('/models?provider=anthropic&refresh=1');
    expect(discovered.body.models.find((m: any) => m.id === 'anthropic/claude-sonnet-4-6'))
      .toMatchObject({ ready: true, readiness: 'ready', runtime: 'claude-cli', registered: false });
    expect(config).toEqual(baseline);

    const registered = await request('/register-models', { provider: 'anthropic', models: ['anthropic/claude-sonnet-4-6'] });
    expect(registered.status).toBe(200);
    expect(registered.body).toMatchObject({ success: true, changed: true, verified: true });
    expect(JSON.parse(calls.find(([m]) => m === 'config.patch')![1].raw)).toEqual({
      agents: { defaults: { models: { 'anthropic/claude-sonnet-4-6': { agentRuntime: { id: 'claude-cli' } } } } },
    });
    expect(config.agents.defaults.model).toEqual(baseline.agents.defaults.model);
    expect(config.auth).toEqual(baseline.auth);
    expect(config.plugins).toEqual(baseline.plugins);

    // Refreshed discovery now reports the registration; the explicit default write
    // carries the bare model reference and never a runtime declaration.
    const refreshed = await request('/models?provider=anthropic&refresh=1');
    expect(refreshed.body.models.find((m: any) => m.id === 'anthropic/claude-sonnet-4-6')).toMatchObject({ registered: true, runtime: 'claude-cli' });
    expect((await request('/set-default-model', { provider: 'anthropic', model: 'anthropic/claude-sonnet-4-6' })).status).toBe(200);
    expect(config.agents.defaults.model).toEqual({ primary: 'anthropic/claude-sonnet-4-6', fallbacks: ['other/backup'] });
    expect(config.agents.defaults.models['anthropic/claude-sonnet-4-6']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    expect(calls.filter(([m]) => m === 'config.patch').map(([, p]) => p.raw).join('\n')).not.toContain('openclaw');

    // The same rule applies to a Codex login through the subscription provider.
    expect((await request('/register-models', { provider: 'openai-codex', models: ['openai/gpt-6-astra'] })).status).toBe(200);
    expect(config.agents.defaults.models['openai/gpt-6-astra']).toEqual({ agentRuntime: { id: 'codex' } });
  });
  test('native explicit runtimes and non-CLI providers keep their native route', async () => {
    // A native row that names its own non-host runtime is authoritative; a row for a
    // provider without an admitted CLI login keeps the host runtime it reported.
    models[0] = { id: 'claude-sonnet-4-6', provider: 'anthropic', available: true, agentRuntime: { id: 'claude-cli' } };
    candidates = [{ kind: 'claude-cli', modelRef: 'claude-cli/claude-opus-5' }];
    cliCatalogs = [{ runtime: 'claude-cli', models: ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-5'], loginPresent: true }];
    const result = await request('/models?refresh=1');
    expect(result.body.models.find((m: any) => m.id === 'anthropic/claude-sonnet-4-6')).toMatchObject({ runtime: 'claude-cli', ready: true });
    expect(result.body.models.find((m: any) => m.id === 'xai/grok-4.5')).toMatchObject({ runtime: 'openclaw', ready: true });
    expect(calls.every(([method]) => !method.includes('patch'))).toBe(true);
  });
  test('an installed CLI without a login cannot activate models', async () => {
    delete config.agents.defaults.models['anthropic/claude-sonnet-4-6'];
    models[0].available = false; delete models[0].agentRuntime;
    candidates = [{ kind: 'claude-cli', modelRef: 'claude-cli/claude-opus-5' }];
    cliCatalogs = [{ runtime: 'claude-cli', models: ['anthropic/claude-sonnet-4-6'], loginPresent: false }];
    expect((await request('/set-default-model', { model: 'anthropic/claude-sonnet-4-6' })).status).toBe(409);
    expect(calls.some(([m]) => m === 'config.patch')).toBe(false);
  });
  test('signed-in CLI only activates supported native models, including default-only selection', async () => {
    delete config.agents.defaults.models['anthropic/claude-sonnet-4-6'];
    models[0].available = false; delete models[0].agentRuntime;
    models.push({ id: 'unknown-cli-model', provider: 'anthropic', available: false });
    candidates = [{ kind: 'claude-cli', modelRef: 'claude-cli/claude-opus-5' }];
    cliCatalogs = [{ runtime: 'claude-cli', models: ['anthropic/claude-sonnet-4-6'], loginPresent: true }];
    expect((await request('/set-default-model', { model: 'anthropic/unknown-cli-model' })).status).toBe(409);
    expect((await request('/set-default-model', { model: 'anthropic/claude-sonnet-4-6' })).status).toBe(200);
    expect(config.agents.defaults.models['anthropic/claude-sonnet-4-6'].agentRuntime.id).toBe('claude-cli');
    expect(config.auth).toEqual(initial.auth);
  });
  test('CLI login never overrides an existing explicit API route or a native auth rejection', async () => {
    models[0].available = false;
    candidates = [{ kind: 'claude-cli', modelRef: 'claude-cli/claude-opus-5' }];
    cliCatalogs = [{ runtime: 'claude-cli', models: ['anthropic/claude-sonnet-4-6'], loginPresent: true }];
    expect((await request('/set-default-model', { model: 'anthropic/claude-sonnet-4-6' })).status).toBe(409);
    config.agents.defaults.models['anthropic/claude-sonnet-4-6'].agentRuntime.id = 'openclaw';
    expect((await request('/set-default-model', { model: 'anthropic/claude-sonnet-4-6' })).status).toBe(409);
  });
  test('rejects unknown/unready models, provider mismatch, cross-provider auth and request code', async () => {
    expect((await request('/set-default-model', { model: 'openai/gpt-no-entitlement' })).status).toBe(409);
    expect((await request('/register-models', { provider: 'xai', models: ['openai/gpt-6-astra'] })).status).toBe(400);
    expect((await request('/set-default-model', { model: 'xai/grok-4.5', profileId: 'anthropic:cli' })).status).toBe(409);
    expect((await request('/register-models', { provider: 'xai', models: ['xai/$(id)'] })).status).toBe(400);
    expect(calls.some(([m]) => m === 'config.patch')).toBe(false);
  });
  test('handles supported string primary and exact fallback replacement', async () => {
    config.agents.defaults.model = 'other/keep';
    expect((await request('/set-fallbacks', { fallbacks: ['xai/grok-4.5', 'openai/gpt-6-astra'] })).status).toBe(200);
    expect(config.agents.defaults.model).toEqual({ primary: 'other/keep', fallbacks: ['xai/grok-4.5', 'openai/gpt-6-astra'] });
    expect(calls.find(([m]) => m === 'config.patch')![1].replacePaths).toEqual(['agents.defaults.model.fallbacks']);
  });
  test('lost config response reconciles native state once; idempotent repeat is not rewritten', async () => {
    losePatchReply = true;
    const body = { provider: 'xai', model: 'xai/grok-4.5' };
    const first = await request('/set-default-model', body);
    expect(first.body).toMatchObject({ success: true, reconciled: true });
    expect((await request('/set-default-model', body)).body.changed).toBe(false);
    expect(calls.filter(([m]) => m === 'config.patch')).toHaveLength(1);
  });
  test('gateway disconnect and concurrent CAS rejection never cause write replay', async () => {
    readbackUnavailable = true;
    expect((await request('/set-default-model', { model: 'xai/grok-4.5' })).status).toBe(202);
    expect(calls.filter(([m]) => m === 'config.patch')).toHaveLength(1);
    readbackUnavailable = false; rejectPatch = true;
    expect((await request('/set-default-model', { model: 'openai/gpt-6-astra' })).status).toBe(409);
  });
  test('catalog keeps historical subscription entries and distinguishes missing native support', async () => {
    const result = await request('/oauth/providers');
    expect(result.body.providers.map((p: any) => p.id)).toEqual(expect.arrayContaining(['openai-codex', 'google-gemini-cli', 'xai', 'qwen-portal', 'github-copilot']));
    expect(result.body.providers.find((p: any) => p.id === 'qwen-portal')).toMatchObject({ supported: false, code: 'NATIVE_PROVIDER_AUTH_UNSUPPORTED' });
    expect((await request('/oauth/start', { provider: 'qwen-portal', operationId: randomUUID() })).status).toBe(409);
  });
  test('auth-only native preparation never selects a model or accepts arbitrary CLI/config fields', async () => {
    const id = randomUUID();
    expect((await request('/oauth/start', { provider: 'xai', operationId: id })).status).toBe(200);
    expect(calls.find(([m]) => m.includes('prepare'))).toEqual(['openclaw.setup.prepare.start', { sessionId: id, authChoice: 'xai-oauth' }]);
    const status = await request('/oauth/status/' + id);
    expect(status.body.step).toMatchObject({ id: 'step-1', sensitive: true });
    expect(JSON.stringify(status.body)).not.toContain('must-not-leak');
    expect(config).toEqual(initial);
  });
  test('uses real pinned provider metadata for ChatGPT/xAI/Copilot and discloses absent Gemini OAuth', async () => {
    authOptions = Object.values<any>(nativeChoices).flatMap(provider => provider.choices)
      .filter(choice => choice.appGuidedAuth).map(choice => ({ id: choice.choiceId, kind: choice.appGuidedAuth }));
    const catalog = await request('/oauth/providers');
    expect(catalog.body.providers.find((p: any) => p.id === 'openai-codex')).toMatchObject({ supported: true, authChoice: 'openai' });
    expect(catalog.body.providers.find((p: any) => p.id === 'google-gemini-cli').supported).toBe(false);
    const id = randomUUID();
    await request('/oauth/start', { provider: 'openai-codex', operationId: id });
    expect(calls.find(([m]) => m.includes('prepare'))![1]).toEqual({ sessionId: id, authChoice: 'openai' });
  });
  test('lost terminal native response recovers actual auth after Gateway restart without re-login', async () => {
    const id = randomUUID();
    await request('/oauth/start', { provider: 'xai', operationId: id });
    proof = { fingerprint: 'committed-before-restart', absent: false }; missingWizard = true;
    expect((await request('/oauth/status/' + id)).body).toMatchObject({ status: 'complete', reconciled: true, activationRequired: true });
    expect(calls.filter(([m]) => m.includes('prepare'))).toHaveLength(1);
  });
  test('existing credentials are preserved and never reauthenticated by start', async () => {
    proof = { fingerprint: 'existing-login', absent: false };
    const result = await request('/oauth/start', { provider: 'openai-codex', operationId: randomUUID() });
    expect(result.body).toMatchObject({ alreadyAuthenticated: true, activationRequired: true });
    expect(calls.some(([m]) => m.includes('prepare'))).toBe(false);
  });
  test('operation ownership, deduplication, validation retry and secret-free journal survive Portal restart', async () => {
    const id = randomUUID();
    await request('/oauth/start', { provider: 'xai', operationId: id });
    expect((await request('/oauth/status/' + id, undefined, 'another-owner')).status).toBe(404);
    await request('/oauth/start', { provider: 'xai', operationId: id });
    expect(calls.filter(([m]) => m.includes('prepare'))).toHaveLength(1);
    wizardReply = { ...wizardReply, error: 'invalid answer' };
    await request('/oauth/answer', { sessionId: id, stepId: 'step-1', value: 'test-only-code' });
    expect(fs.readFileSync(path.join(dir, 'wizard.sqlite3')).includes(Buffer.from('test-only-code'))).toBe(false);
    const restarted = new ProviderSetupWizard({ rpc, proof: async () => proof, journalPath: () => path.join(dir, 'wizard.sqlite3') });
    expect((await restarted.start('xai', id, 'user:owner')).step.id).toBe('step-1');
    expect(calls.filter(([m]) => m.includes('prepare'))).toHaveLength(1);
  });
  test('returns the native browser/device instructions but never a secret input default', async () => {
    const id = randomUUID();
    await request('/oauth/start', { provider: 'xai', operationId: id });
    wizardReply.step = { id: 'device', type: 'note', message: 'Authorize in your browser',
      externalUrl: 'https://accounts.x.ai/device', deviceCode: { code: 'synthetic-device-code' },
      initialValue: 'must-not-leak', config: { private: 'must-not-leak' } };
    const response = await request('/oauth/status/' + id);
    expect(response.body.step.externalUrl).toBe('https://accounts.x.ai/device');
    expect(response.body.step.deviceCode).toEqual({ code: 'synthetic-device-code' });
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
  });
  test('native terminal receipt attests auth, releases lifecycle, preserves default, and replays after restart', async () => {
    const id = randomUUID();
    await request('/oauth/start', { provider: 'xai', operationId: id });
    proof = { fingerprint: 'new-login', absent: false }; wizardReply = { done: true, status: 'done' };
    expect((await request('/oauth/status/' + id)).body).toMatchObject({ status: 'complete', credentialState: 'committed', activationRequired: true });
    const restarted = new ProviderSetupWizard({ rpc, journalPath: () => path.join(dir, 'wizard.sqlite3') });
    expect((await restarted.status(id, 'user:owner')).status).toBe('complete');
    expect(config).toEqual(initial);
  });
  test('Gateway restart never replays an OAuth writer or removes credentials', async () => {
    const id = randomUUID();
    await request('/oauth/start', { provider: 'xai', operationId: id });
    missingWizard = true;
    const result = await request('/oauth/status/' + id);
    expect(result.body).toMatchObject({ status: 'cancelled', reconciled: true, interrupted: true });
    await request('/oauth/start', { provider: 'xai', operationId: id });
    expect(calls.filter(([m]) => m.includes('prepare'))).toHaveLength(1);
    expect(config).toEqual(initial);
  });
  test('native cancellation releases only an unchanged credential domain', async () => {
    const id = randomUUID();
    await request('/oauth/start', { provider: 'xai', operationId: id });
    expect((await request('/oauth/cancel', { sessionId: id })).body.status).toBe('cancelled');
    const second = randomUUID();
    expect((await request('/oauth/start', { provider: 'xai', operationId: second })).status).toBe(200);
    proof = { fingerprint: 'changed-credential', absent: false };
    expect((await request('/oauth/cancel', { sessionId: second })).body.recoveryRequired).toBe(true);
  });
  test('explicit smoke uses the bounded native provider API, never a Portal process', async () => {
    expect((await request('/provider/google-gemini-cli/smoke', {})).body).toMatchObject({ ok: true, source: 'native' });
    expect(calls).toEqual([['models.probe', { provider: 'google-gemini-cli', timeoutMs: 15000 }]]);
  });
  test('lost native transport response holds the operation and recovers without a duplicate start', async () => {
    const id = randomUUID();
    await request('/oauth/start', { provider: 'xai', operationId: id });
    rpc.mockImplementationOnce(async () => ({ ok: false, errorCode: 'TIMEOUT' }));
    expect((await request('/oauth/status/' + id)).body.recoveryRequired).toBe(true);
    expect((await request('/oauth/start', { provider: 'xai', operationId: id })).body.step.id).toBe('step-1');
    expect(calls.filter(([m]) => m.includes('prepare'))).toHaveLength(1);
  });
  test('independent native schemas reject legacy guessed config and arbitrary start options', () => {
    expect(validateModels({ 'openai/gpt-6-astra': { auth: { mode: 'profile', profileId: 'p' } } })).toBe(false);
    expect(validators.modelsList({ all: true })).toBe(false);
    expect(validators.prepare({ sessionId: 's', authChoice: 'xai-oauth', command: 'anything' })).toBe(false);
  });
});
